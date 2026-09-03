/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              SWITCH PLUGIN — QUEUE SUBSYSTEM                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * The FIFO switch queue — the most complex subsystem of the Switch
 * plugin. Owns the queue data structure, enqueue/dequeue, pair
 * trading, solo slot consumption, re-entrancy guard, stability
 * gating, periodic processing via S³ heartbeat, and conditional
 * S³ refresh-interest registration. Extracted from switch.js during
 * the refactor to keep the main plugin focused on orchestration.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SwitchQueue (default)
 *   Singleton with a single register(plugin) method.
 *   Attaches queue state and all queue methods to the plugin instance.
 *   Also wires S3_PLAYERS_UPDATED listener lifecycle.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * No imports — all dependencies are accessed via plugin.* (the live
 * plugin instance passed to register()).
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Queue gates switches at two independent points:
 *   1. canAct() per-player concurrency gate — checked before every
 *      pair trade and solo switch. If another plugin (e.g. SmartAssign)
 *      holds a player lock, that specific switch is deferred but the
 *      rest of the queue continues processing.
 *   2. Stability gate — solo switches only execute when team counts
 *      are identical across two consecutive polls. This prevents
 *      acting on a momentary blip. Pair trades bypass the stability
 *      gate since they are net-zero on balance.
 * - Refresh interest is registered conditionally when queue goes
 *   0→1 and unregistered when →0, avoiding unnecessary polling.
 * - _queueProcessing flag prevents concurrent _processQueue() calls.
 * - _periodicProcessingActive gates the S3_PLAYERS_UPDATED handler.
 * - Pair trading fires when opposing-team players are both queued.
 * - Solo slot consumption fires when balance opens for one side.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

const SwitchQueue = {
  /**
   * Attaches queue state and methods to the plugin instance.
   * Adds: plugin._switchQueue, plugin._lastTeamSnapshot,
   *       plugin._queueProcessing, plugin._periodicProcessingActive,
   *       and all queue methods listed below.
   * Also wires S3_PLAYERS_UPDATED listener lifecycle.
   *
   * @param {object} plugin — the live Switch plugin instance
   */
  register(plugin) {
    // ── State objects ──────────────────────────────────────────

    plugin._switchQueue = {
      t1: [], // players on T1 wanting T2 — ordered FIFO
      t2: []  // players on T2 wanting T1 — ordered FIFO
    };
    plugin._lastTeamSnapshot = null;      // { t1: number, t2: number } — previous poll's team counts for stability check
    plugin._queueProcessing = false;      // Re-entrancy guard for _processQueue
    plugin._periodicProcessingActive = false;  // true while queue non-empty — triggers _processQueue on each S3_PLAYERS_UPDATED

    // ── Queue Methods ──────────────────────────────────────────

    plugin._requestQueueRefresh = function () {
      const refreshPlayers = plugin._s3.players;
      if (refreshPlayers?.isReady() && refreshPlayers.requestRefresh) {
        refreshPlayers.requestRefresh('Switch', { urgency: 'normal' });
      }
    };

    plugin._enqueuePlayer = async function (player, reason) {
      // v2.0.0: Gate — return early if queue is disabled
      if (!plugin.options.queueEnabled) {
        plugin.verbose(2, `[Queue] Queue disabled — refusing enqueue for ${player.name}.`);
        return;
      }

      const { eosID, steamID, name: playerName, teamID } = player;

      if (!eosID || !teamID) {
        plugin.verbose(1, `[Queue] Cannot enqueue ${playerName}: missing eosID or teamID.`);
        return;
      }

      const targetTeam = teamID === 1 ? 2 : 1;
      const subQueue = teamID === 1 ? 't1' : 't2';

      if (plugin._findQueueEntry(eosID)) {
        const existing = plugin._findQueueEntry(eosID).entry;
        const remaining = (plugin._getRemainingQueueMs(existing.queuedAt) / 60000).toFixed(1);
        plugin.warn(eosID,
          plugin.localize('switch.warn.switchQueueAlreadyQueue', { remaining, currentTeamID: existing.currentTeamID, targetTeamID: existing.targetTeamID })
        );
        return;
      }

      const queuedAt = Date.now();

      const warnInterval = setInterval(() => {
        const found = plugin._findQueueEntry(eosID);
        if (!found) { clearInterval(warnInterval); return; }

        const entry = found.entry;
        const remaining = (plugin._getRemainingQueueMs(entry.queuedAt) / 60000).toFixed(1);

        const sameTeam = plugin._switchQueue[entry.currentTeamID === 1 ? 't1' : 't2'];
        const pos = sameTeam.findIndex(e => e.eosID === eosID) + 1;

        plugin.warn(entry.eosID,
          plugin.localize('switch.warn.switchQueuePositionQueue', { pos, remaining, currentTeamID: entry.currentTeamID, targetTeamID: entry.targetTeamID })
        );
      }, 30_000);

      const enqueuePos = plugin._switchQueue[subQueue].length + 1;

      const entry = { eosID, steamID, playerName, currentTeamID: teamID, targetTeamID: targetTeam, queuedAt, warnInterval };
      plugin._switchQueue[subQueue].push(entry);
      plugin._updateMaxQueueSize();

      plugin.warn(eosID,
        plugin.localize('switch.warn.switchQueueAddedPosition', { enqueuePos, remainingQueueMs: (plugin._getRemainingQueueMs(queuedAt) / 60000).toFixed(1), teamID, targetTeam, reason })
      );
      plugin.verbose(1, `[Queue] ${playerName} (T${teamID} → T${targetTeam}) enqueued at position ${enqueuePos}. Queue size: ${plugin._getQueueSize()}`);

      // Conditional refresh registration: register 5s interest when queue transitions
      // from empty to non-empty, so _processQueue polls frequently while people wait.
      if (plugin._getQueueSize() === 1) {
        if (plugin._s3?.players?.registerRefreshInterest) {
          plugin._s3.players.registerRefreshInterest('Switch', { maxStalenessMs: 5000 });
          plugin.verbose(2, '[S3] Registered Switch refresh interest (maxStalenessMs=5000) — queue became active.');
        }
        // Also listen to S3_PLAYERS_UPDATED for periodic processing heartbeat
        // while the queue is non-empty. This hooks into S3's existing refresh polling
        // rather than creating a separate timer.
        // Guard: only register if not already active to prevent listener accumulation.
        // Without this guard, rapid queue transitions (empty→non-empty→empty→non-empty)
        // would stack multiple S3_PLAYERS_UPDATED listeners, causing the
        // MaxListenersExceededWarning and duplicate _processQueue invocations.
        if (!plugin._periodicProcessingActive) {
          plugin.server.on('S3_PLAYERS_UPDATED', plugin._onPlayerInfoUpdated);
          plugin._periodicProcessingActive = true;
          plugin.verbose(2, '[S3] Started periodic queue processing via S3_PLAYERS_UPDATED events.');
        }
      }

      plugin._requestQueueRefresh();
    };

    plugin._getRemainingQueueMs = function (queuedAt) {
      // Compute remaining queue timeout based on when the player entered the queue,
      // not on join/match time. The queue has its own independent timeout.
      const queueTimeoutMs = plugin.options.queueTimeoutMinutes * 60 * 1000;
      const elapsed = Date.now() - queuedAt;
      return Math.max(0, queueTimeoutMs - elapsed);
    };

    plugin._getQueueSize = function () {
      return plugin._switchQueue.t1.length + plugin._switchQueue.t2.length;
    };

    plugin._clearAllQueueEntries = function (reason) {
      for (const entry of [...plugin._switchQueue.t1, ...plugin._switchQueue.t2]) {
        clearInterval(entry.warnInterval);
      }
      plugin._switchQueue.t1 = [];
      plugin._switchQueue.t2 = [];
      plugin._stopPeriodicProcessing();
      plugin.verbose(2, `[Queue] All entries cleared: ${reason}`);
    };

    plugin.getQueueSnapshot = function () {
      return {
        t1ToT2: plugin._switchQueue.t1.map(e => ({ eosID: e.eosID, steamID: e.steamID, playerName: e.playerName, currentTeamID: e.currentTeamID, targetTeamID: e.targetTeamID, queuedAt: e.queuedAt })),
        t2ToT1: plugin._switchQueue.t2.map(e => ({ eosID: e.eosID, steamID: e.steamID, playerName: e.playerName, currentTeamID: e.currentTeamID, targetTeamID: e.targetTeamID, queuedAt: e.queuedAt }))
      };
    };

    plugin.consumeQueueEntry = function (eosID) {
      const entry = plugin._removePlayerFromQueue(eosID);
      if (entry) {
        plugin.verbose(1, `[Queue] ${entry.playerName} consumed externally via handshake. Queue size: ${plugin._getQueueSize()}`);
        if (plugin._roundStats) {
          const qDuration = Math.round((Date.now() - entry.queuedAt) / 1000);
          const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
          plugin._trackRoundStat('queueJoinSwaps', {
            name: entry.playerName,
            eosID: entry.eosID,
            type: 'consume',
            currentTeamID: entry.currentTeamID,
            toTeam: entry.targetTeamID,
            queueDurationSeconds: qDuration,
            gamePhase
          });
          plugin._roundStats.queueDurationsMs.push(qDuration * 1000);
        }
      }
      return entry || null;
    };

    plugin.forceQueueSwap = async function (eosID) {
      const entry = plugin._removePlayerFromQueue(eosID);
      if (!entry) {
        plugin.verbose(1, `[Queue] forceQueueSwap: ${eosID} not found in queue (already consumed/cancelled/disconnected).`);
        return false;
      }
      plugin.verbose(1, `[Queue] forceQueueSwap: Initiating handshake swap for ${entry.playerName}. Queue size: ${plugin._getQueueSize()}`);

      try {
        plugin.warn(entry.eosID, plugin.localize('switch.warn.switchQueueSwapPartner'));
        await plugin._taggedSwitchPlayer(eosID, 'Handshake-Swap');

        if (!plugin.isLiberalMode()) {
          const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
          if (PlayerCooldowns) {
            try {
              await plugin._withDb(async (t) => {
                // §3.3 of switch-token-system-spec: load → regen → spend → upsert
                let row = await PlayerCooldowns.findByPk(entry.eosID, { transaction: t });
                if (!row) {
                  row = { eosID: entry.eosID, steamID: entry.steamID, playerName: entry.playerName, tokenBalance: plugin.options.maxSwitchTokens, tokenRegenAnchor: null };
                }
                plugin._regenTokens(row);
                plugin._spendToken(row);
                await PlayerCooldowns.upsert(
                  { eosID: entry.eosID, steamID: entry.steamID, playerName: entry.playerName, tokenBalance: row.tokenBalance, tokenRegenAnchor: row.tokenRegenAnchor, lastActiveTimestamp: new Date() },
                  { transaction: t }
                );
              });
            } catch (dbErr) {
              plugin.verbose(1, `[Queue] Token spend failed for ${entry.playerName}: ${dbErr.message}`);
            }
          }
        }

        // Post-switch token notice for handshake swap (gated on showTokenMessaging)
        if (plugin.options.maxSwitchTokens > 1 && !plugin.isLiberalMode()) {
          try {
            const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
            if (PlayerCooldowns) {
              const row = await PlayerCooldowns.findByPk(entry.eosID);
              if (row) {
                const balance = row.tokenBalance != null ? row.tokenBalance : plugin.options.maxSwitchTokens;
                if (balance > 0) {
                  plugin.warn(entry.eosID, plugin.localize('switch.warn.switchSwitchedTokensRemaining', { balance, maxSwitchTokens: plugin.options.maxSwitchTokens }));
                } else {
                  const cooldownDuration = plugin.options.switchCooldownMinutes > 0
                    ? plugin.options.switchCooldownMinutes * 60 * 1000
                    : plugin.options.switchCooldownHours * 60 * 60 * 1000;
                  const anchor = row.tokenRegenAnchor ? new Date(row.tokenRegenAnchor).getTime() : Date.now();
                  const remaining = Math.ceil((cooldownDuration - (Date.now() - anchor)) / 60000);
                  plugin.warn(entry.eosID, plugin.localize('switch.warn.switchSwitchedReOut', { remaining }));
                }
              }
            }
          } catch (e) {
            plugin.verbose(1, `[Queue] Token notice read failed for ${entry.playerName}: ${e.message}`);
          }
        }

        if (plugin._roundStats) {
          const qDuration = Math.round((Date.now() - entry.queuedAt) / 1000);
          const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
          plugin._trackRoundStat('queueJoinSwaps', {
            name: entry.playerName,
            eosID: entry.eosID,
            type: 'swap',
            currentTeamID: entry.currentTeamID,
            toTeam: entry.targetTeamID,
            queueDurationSeconds: qDuration,
            gamePhase
          });
          plugin._roundStats.queueDurationsMs.push(qDuration * 1000);
        }
        plugin.verbose(1, `[Queue] forceQueueSwap: ${entry.playerName} switched successfully via handshake.`);
        return true;
      } catch (err) {
        plugin.verbose(1, `[Queue] forceQueueSwap: Switch failed for ${entry.playerName}: ${err.message}. Player was already removed from queue — cooldown may have been applied.`);
        return false;
      }
    };

    plugin._processQueue = async function () {
      // v2.0.0: Queue-disabled gate
      if (!plugin.options.queueEnabled) return;

      if (plugin._queueProcessing) {
        plugin.verbose(2, `[Queue] Processing already in progress — skipping concurrent invocation.`);
        return;
      }

      // NOTE: The old top-level canAct(null, 'Switch') gate was removed here because it
      // blocked ALL queue operations (expiry, disconnect cleanup, pair evaluation) whenever
      // a higher-priority plugin (e.g. SmartAssign) held a global lock. Queue maintenance
      // must always run — only the actual RCON switch calls need lock checks, which are
      // performed per-player just before _taggedSwitchPlayer() below.
      plugin._queueProcessing = true;
      try {
        if (plugin.s3IsEndgameFactionVote()) {
          if (plugin._getQueueSize() > 0) {
            plugin.verbose(2, `[Queue] Faction vote in progress — skipping queue processing.`);
          }
          return;
        }

        const queueTimeoutMs = plugin.options.queueTimeoutMinutes * 60 * 1000;
        const nowTs = Date.now();

        for (const subQueue of ['t1', 't2']) {
          const arr = plugin._switchQueue[subQueue];
          for (let i = arr.length - 1; i >= 0; i--) {
            const entry = arr[i];
            if (!plugin.options.queueTimeoutSwitchEnabled && plugin.timeLimitEnabled && (nowTs - entry.queuedAt) >= queueTimeoutMs) {
              clearInterval(entry.warnInterval);
              arr.splice(i, 1);
              if (plugin._roundStats) {
                const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
                const queueDurationSeconds = Math.round((nowTs - entry.queuedAt) / 1000);
                plugin._trackRoundStat('queueExpiries', {
                  name: entry.playerName,
                  eosID: entry.eosID,
                  queueDurationSeconds,
                  gamePhase
                });
              }
              plugin.warn(entry.eosID, plugin.localize('switch.warn.switchQueueRemovedQueue', { queueTimeoutMinutes: plugin.options.queueTimeoutMinutes }));
              plugin.verbose(2, `[Queue] ${entry.playerName} expired and removed from queue.`);
            }
          }
        }

        // Use S³'s authoritative player registry for team counts — handles null-teamID
        // projection and deduped state, unlike SquadJS's raw server.players array.
        // _processQueue only runs in response to S3_PLAYERS_UPDATED, which fires AFTER
        // S³ has committed its internal state from the tick, so the registry is current.
        let t1 = 0, t2 = 0;
        const s3AllPlayers = plugin._s3?.players?.isReady() ? plugin._s3.players.getAllPlayers() : null;
        if (!s3AllPlayers) {
          plugin.verbose(2, `[Queue] S³ players not ready — skipping team count.`);
          return;
        }
        for (const p of s3AllPlayers) {
          if (p.teamID === 1) t1++;
          else if (p.teamID === 2) t2++;
        }
        const prevSnapshot = plugin._lastTeamSnapshot;
        const stable = prevSnapshot !== null
          && prevSnapshot.t1 === t1
          && prevSnapshot.t2 === t2;
        plugin._lastTeamSnapshot = { t1, t2 };

        const t1Candidates = [...plugin._switchQueue.t1];
        const t2Candidates = [...plugin._switchQueue.t2];
        const pairCount = Math.min(t1Candidates.length, t2Candidates.length);

        for (let i = 0; i < pairCount; i++) {
          const p1 = t1Candidates[i];
          const p2 = t2Candidates[i];

          // Use S³'s authoritative player registry for live checks — handles null-teamID
          // projection and deduped state. _processQueue only runs in response to
          // S3_PLAYERS_UPDATED, which fires AFTER S³ has committed its internal state
          // from the tick, so the registry is current.
          const s3p1 = plugin._s3?.players?.isReady() ? plugin._s3.players.getPlayer(p1.eosID) : null;
          if (!s3p1) {
            // Player absent from S³ registry — disconnected
            plugin._removePlayerFromQueue(p1.eosID);
            if (plugin._roundStats) {
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              const queueDurationSeconds = Math.round((Date.now() - p1.queuedAt) / 1000);
              plugin._trackRoundStat('queueDisconnects', {
                name: p1.playerName,
                eosID: p1.eosID,
                currentTeamID: p1.currentTeamID,
                targetTeamID: p1.targetTeamID,
                queueDurationSeconds,
                gamePhase
              });
            }
            plugin.verbose(1, `[Queue] ${p1.playerName} disconnected — removed from queue.`);
            continue;
          }
          if (s3p1.teamID !== p1.currentTeamID) {
            plugin._removePlayerFromQueue(p1.eosID);
            if (plugin._roundStats) {
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              plugin._trackRoundStat('queueRemovals', { name: p1.playerName, eosID: p1.eosID, reason: 'team_changed', gamePhase });
            }
            plugin.verbose(1, `[Queue] ${p1.playerName} team changed — removed from queue (now on target team T${s3p1.teamID}).`);
            plugin.warn(p1.eosID, plugin.localize('switch.warn.switchQueueNowTeam', { teamID: s3p1.teamID }));
            continue;
          }
          const s3p2 = plugin._s3?.players?.isReady() ? plugin._s3.players.getPlayer(p2.eosID) : null;
          if (!s3p2) {
            // Player absent from S³ registry — disconnected
            plugin._removePlayerFromQueue(p2.eosID);
            if (plugin._roundStats) {
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              const queueDurationSeconds = Math.round((Date.now() - p2.queuedAt) / 1000);
              plugin._trackRoundStat('queueDisconnects', {
                name: p2.playerName,
                eosID: p2.eosID,
                currentTeamID: p2.currentTeamID,
                targetTeamID: p2.targetTeamID,
                queueDurationSeconds,
                gamePhase
              });
            }
            plugin.verbose(1, `[Queue] ${p2.playerName} disconnected — removed from queue.`);
            continue;
          }
          if (s3p2.teamID !== p2.currentTeamID) {
            plugin._removePlayerFromQueue(p2.eosID);
            if (plugin._roundStats) {
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              plugin._trackRoundStat('queueRemovals', { name: p2.playerName, eosID: p2.eosID, reason: 'team_changed', gamePhase });
            }
            plugin.verbose(1, `[Queue] ${p2.playerName} team changed — removed from queue (now on target team T${s3p2.teamID}).`);
            plugin.warn(p2.eosID, plugin.localize('switch.warn.switchQueueNowTeam', { teamID: s3p2.teamID }));
            continue;
          }

          // Per-player lock gate: only proceed if neither player is locked by a higher-priority
          // plugin (e.g. SmartAssign). Unlike the old top-level canAct(null) check which blocked
          // the entire queue, this only defers the specific pair — other queue operations
          // (expiry, disconnect removal, other pairs) continue unaffected.
          // canAct(eosID, 'Switch') checks both the global lock AND per-player locks.
          if (!plugin._s3?.players?.canAct?.(p1.eosID, 'Switch') ||
              !plugin._s3?.players?.canAct?.(p2.eosID, 'Switch')) {
            plugin.verbose(2, `[Queue] Pair trade deferred for ${p1.playerName}/${p2.playerName} — higher-priority lock held.`);
            continue;
          }

          plugin._removePlayerFromQueue(p1.eosID);
          plugin._removePlayerFromQueue(p2.eosID);

          plugin.warn(p1.eosID, plugin.localize('switch.warn.switchQueueSwapPartner'));
          plugin.warn(p2.eosID, plugin.localize('switch.warn.switchQueueSwapPartner'));

          await plugin._taggedSwitchPlayer(p1.eosID, 'Player-Queue');
          await plugin._taggedSwitchPlayer(p2.eosID, 'Player-Queue');

          if (!plugin.isLiberalMode()) {
            const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
            if (PlayerCooldowns) {
              for (const p of [p1, p2]) {
                try {
                  await plugin._withDb(async (t) => {
                    // §3.3 of switch-token-system-spec: load → regen → spend → upsert
                    let row = await PlayerCooldowns.findByPk(p.eosID, { transaction: t });
                    if (!row) {
                      row = { eosID: p.eosID, steamID: p.steamID, playerName: p.playerName, tokenBalance: plugin.options.maxSwitchTokens, tokenRegenAnchor: null };
                    }
                    plugin._regenTokens(row);
                    plugin._spendToken(row);
                    await PlayerCooldowns.upsert(
                      { eosID: p.eosID, steamID: p.steamID, playerName: p.playerName, tokenBalance: row.tokenBalance, tokenRegenAnchor: row.tokenRegenAnchor, lastActiveTimestamp: new Date() },
                      { transaction: t }
                    );
                  });
                } catch (dbErr) {
                  plugin.verbose(1, `[Queue] Token spend failed for ${p.playerName}: ${dbErr.message}`);
                }
              }
            }
          }

          // Post-switch token notice for pair trade (gated on showTokenMessaging)
          // NOTE: This is a read-after-write — it reads the DB row AFTER the token-spend
          // transaction above has committed. There's a narrow window where another
          // operation could modify the row between write and read, but in practice
          // the player is the only actor on their row at this moment. The consequence
          // of a missed read is one missing notification (the token display is
          // informational, not authoritative).
          if (plugin.options.maxSwitchTokens > 1) {
            const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
            if (PlayerCooldowns && !plugin.isLiberalMode()) {
              for (const p of [p1, p2]) {
                try {
                  const row = await PlayerCooldowns.findByPk(p.eosID);
                  if (row) {
                    const balance = row.tokenBalance != null ? row.tokenBalance : plugin.options.maxSwitchTokens;
                    if (balance > 0) {
                      plugin.warn(p.eosID, plugin.localize('switch.warn.switchSwitchedTokensRemaining', { balance, maxSwitchTokens: plugin.options.maxSwitchTokens }));
                    } else {
                      const cooldownDuration = plugin.options.switchCooldownMinutes > 0
                        ? plugin.options.switchCooldownMinutes * 60 * 1000
                        : plugin.options.switchCooldownHours * 60 * 60 * 1000;
                      const anchor = row.tokenRegenAnchor ? new Date(row.tokenRegenAnchor).getTime() : Date.now();
                      const remaining = Math.ceil((cooldownDuration - (Date.now() - anchor)) / 60000);
                      plugin.warn(p.eosID, plugin.localize('switch.warn.switchSwitchedReOut', { remaining }));
                    }
                  }
                } catch (e) {
                  plugin.verbose(1, `[Queue] Token notice read failed for ${p.playerName}: ${e.message}`);
                }
              }
            }
          }

          // Track completed pair trade
          if (plugin._roundStats) {
            const dur1 = Math.round((Date.now() - p1.queuedAt) / 1000);
            const dur2 = Math.round((Date.now() - p2.queuedAt) / 1000);
            const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
            plugin._trackRoundStat('queueTeamTrades', {
              p1Name: p1.playerName,
              p2Name: p2.playerName,
              p1FromTeam: p1.currentTeamID,
              p1ToTeam: p1.targetTeamID,
              p2FromTeam: p2.currentTeamID,
              p2ToTeam: p2.targetTeamID,
              p1DurationSeconds: dur1,
              p2DurationSeconds: dur2,
              gamePhase
            });
            plugin._roundStats.queueDurationsMs.push(dur1 * 1000, dur2 * 1000);
          }

          plugin.verbose(1, `[Queue] Swapped pair: ${p1.playerName} (T1) <-> ${p2.playerName} (T2)`);
        }

        const t1Queued = plugin._switchQueue.t1.length;
        const t2Queued = plugin._switchQueue.t2.length;

        if (plugin._getQueueSize() > 0) {
          plugin.verbose(2, `[Queue] T1: ${t1Queued} queued | T2: ${t2Queued} queued | Teams: ${t1}v${t2} | Diff: ${t1 - t2}`);
        }

        const firstT1 = plugin._switchQueue.t1[0] || null;
        const firstT2 = plugin._switchQueue.t2[0] || null;

        for (const entry of [firstT1, firstT2].filter(Boolean)) {
          // Use S³'s authoritative player registry — handles null-teamID projection
          // and deduped state. _processQueue only runs in response to S3_PLAYERS_UPDATED,
          // which fires AFTER S³ has committed its internal state from the tick.
          const s3Entry = plugin._s3?.players?.isReady() ? plugin._s3.players.getPlayer(entry.eosID) : null;
          if (!s3Entry) {
            // Player absent from S³ registry — disconnected
            plugin._removePlayerFromQueue(entry.eosID);
            if (plugin._roundStats) {
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              const queueDurationSeconds = Math.round((Date.now() - entry.queuedAt) / 1000);
              plugin._trackRoundStat('queueDisconnects', {
                name: entry.playerName,
                eosID: entry.eosID,
                currentTeamID: entry.currentTeamID,
                targetTeamID: entry.targetTeamID,
                queueDurationSeconds,
                gamePhase
              });
            }
            plugin.verbose(1, `[Queue] ${entry.playerName} disconnected — removed from queue.`);
            continue;
          }
          if (s3Entry.teamID !== entry.currentTeamID) {
            plugin._removePlayerFromQueue(entry.eosID);
            if (plugin._roundStats) {
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              plugin._trackRoundStat('queueRemovals', { name: entry.playerName, eosID: entry.eosID, reason: 'team_changed', gamePhase });
            }
            plugin.verbose(1, `[Queue] ${entry.playerName} team changed — removed from queue (now on target team T${s3Entry.teamID}).`);
            plugin.warn(entry.eosID, plugin.localize('switch.warn.switchQueueNowTeam', { teamID: s3Entry.teamID }));
            continue;
          }

          // v2.2.0: Queue timeout switch — when a player has waited longer than queueTimeoutMinutes,
          // they are force-switched with a relaxed balance gate instead of being removed from the queue.
          // The effectiveCap is bumped by queueTimeoutExtraSlots on top of maxUnbalancedSlots + dynamic extras,
          // and skipHardCap bypasses the 50/50 max-team-size check entirely.
          // Rationale: being 2-3 players over the 50/50 split is preferable to removing the player from
          // the queue after they waited the full timeout duration. Without this, the player would have
          // waited and then been kicked — a poor experience. The extra imbalance is temporary and will
          // self-correct as players join/leave.
          const timedOut = plugin.timeLimitEnabled && plugin.options.queueTimeoutSwitchEnabled && (nowTs - entry.queuedAt) >= queueTimeoutMs;
          let effectiveCap = plugin.isLiberalMode() ? plugin.options.liberalSwitchMaxUnbalancedSlots : null;
          let skipHardCap = false;
          if (timedOut) {
            effectiveCap = plugin.options.maxUnbalancedSlots + plugin.getDynamicExtraSlots() + plugin.options.queueTimeoutExtraSlots;
            skipHardCap = true;
          }
          const slots = plugin.getSwitchSlotsPerTeam(entry.currentTeamID, effectiveCap, skipHardCap);
          if (slots > 0) {
            // Per-player lock gate: only proceed if this specific player is not locked by a
            // higher-priority plugin. The old top-level canAct(null) check blocked the entire
            // queue — this only defers the solo switch for this player while other queue
            // operations continue. canAct(eosID, 'Switch') checks both global and per-player locks.
            if (!plugin._s3?.players?.canAct?.(entry.eosID, 'Switch')) {
              plugin.verbose(2, `[Queue] Solo switch deferred for ${entry.playerName} — higher-priority lock held.`);
              break;
            }

            plugin._removePlayerFromQueue(entry.eosID);

            plugin.warn(entry.eosID, timedOut ? plugin.localize('switch.warn.switchQueueQueueTimeout') : plugin.localize('switch.warn.switchQueueBalanceSlot'));
            await plugin._taggedSwitchPlayer(entry.eosID, 'Player-Queue');

            if (!plugin.isLiberalMode()) {
              const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
              if (PlayerCooldowns) {
                try {
                  await plugin._withDb(async (t) => {
                    // §3.3 of switch-token-system-spec: load → regen → spend → upsert
                    let row = await PlayerCooldowns.findByPk(entry.eosID, { transaction: t });
                    if (!row) {
                      row = { eosID: entry.eosID, steamID: entry.steamID, playerName: entry.playerName, tokenBalance: plugin.options.maxSwitchTokens, tokenRegenAnchor: null };
                    }
                    plugin._regenTokens(row);
                    plugin._spendToken(row);
                    await PlayerCooldowns.upsert(
                      { eosID: entry.eosID, steamID: entry.steamID, playerName: entry.playerName, tokenBalance: row.tokenBalance, tokenRegenAnchor: row.tokenRegenAnchor, lastActiveTimestamp: new Date() },
                      { transaction: t }
                    );
                  });
                } catch (dbErr) {
                  plugin.verbose(1, `[Queue] Token spend failed for ${entry.playerName}: ${dbErr.message}`);
                }
              }
            }

            // Post-switch token notice for solo/timeout switch (gated on showTokenMessaging)
            // NOTE: Read-after-write race — same rationale as the pair trade notice above.
            // Informational only; a missed read is harmless.
            if (plugin.options.maxSwitchTokens > 1 && !plugin.isLiberalMode()) {
              try {
                const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
                if (PlayerCooldowns) {
                  const row = await PlayerCooldowns.findByPk(entry.eosID);
                  if (row) {
                    const balance = row.tokenBalance != null ? row.tokenBalance : plugin.options.maxSwitchTokens;
                    if (balance > 0) {
                      plugin.warn(entry.eosID, plugin.localize('switch.warn.switchSwitchedTokensRemaining', { balance, maxSwitchTokens: plugin.options.maxSwitchTokens }));
                    } else {
                      const cooldownDuration = plugin.options.switchCooldownMinutes > 0
                        ? plugin.options.switchCooldownMinutes * 60 * 1000
                        : plugin.options.switchCooldownHours * 60 * 60 * 1000;
                      const anchor = row.tokenRegenAnchor ? new Date(row.tokenRegenAnchor).getTime() : Date.now();
                      const remaining = Math.ceil((cooldownDuration - (Date.now() - anchor)) / 60000);
                      plugin.warn(entry.eosID, plugin.localize('switch.warn.switchSwitchedReOut', { remaining }));
                    }
                  }
                }
              } catch (e) {
                plugin.verbose(1, `[Queue] Token notice read failed for ${entry.playerName}: ${e.message}`);
              }
            }

            // Track completed solo switch
            if (plugin._roundStats) {
              const qDuration = Math.round((Date.now() - entry.queuedAt) / 1000);
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              if (timedOut) {
            plugin._trackRoundStat('queueTimeoutSwitches', {
              name: entry.playerName,
              eosID: entry.eosID,
              currentTeamID: entry.currentTeamID,
              toTeam: entry.currentTeamID === 1 ? 2 : 1,
              queueDurationSeconds: qDuration,
              gamePhase
            });
          } else {
            plugin._trackRoundStat('queueNormal', {
                name: entry.playerName,
                eosID: entry.eosID,
                currentTeamID: entry.currentTeamID,
                toTeam: entry.currentTeamID === 1 ? 2 : 1,
                queueDurationSeconds: qDuration,
                gamePhase
              });
              plugin._roundStats.queueDurationsMs.push(qDuration * 1000);
            }
            }

            plugin.verbose(1, `[Queue] ${timedOut ? 'Timeout switch' : 'Solo switch'} fired for ${entry.playerName} (T${entry.currentTeamID})`);

            break;
          }
        }

      } catch (err) {
        plugin.verbose(1, `[Queue] Processing error: ${err.stack}`);
      } finally {
        plugin._queueProcessing = false;
      }
    };

    plugin._findQueueEntry = function (eosID) {
      for (const subQueue of ['t1', 't2']) {
        const idx = plugin._switchQueue[subQueue].findIndex(e => e.eosID === eosID);
        if (idx !== -1) {
          return { entry: plugin._switchQueue[subQueue][idx], subQueue, index: idx };
        }
      }
      return null;
    };

    plugin._removePlayerFromQueue = function (eosID) {
      const found = plugin._findQueueEntry(eosID);
      if (!found) return null;
      clearInterval(found.entry.warnInterval);
      plugin._switchQueue[found.subQueue].splice(found.index, 1);
      // Unregister refresh interest when queue becomes empty — no need to poll
      // aggressively if no one is waiting. skip if disableInFlight is true.
      // Also remove the periodic processing listener.
      if (plugin._getQueueSize() === 0) {
        plugin._stopPeriodicProcessing();
        plugin.verbose(2, '[S3] Queue empty — periodic processing stopped.');
      }
      return found.entry;
    };

    /**
     * Periodic queue processing via S³ players-updated heartbeat.
     * Called on each S3_PLAYERS_UPDATED event while the queue is non-empty.
     * Registered when queue transitions 0→1, unregistered when →0.
     */
    plugin._onPlayerInfoUpdated = function () {
      if (!plugin._periodicProcessingActive) return;
      if (plugin._getQueueSize() === 0) return;
      plugin._processQueue().catch(err => {
        plugin.verbose(1, `[Queue] Periodic processing error: ${err.message}`);
      });
    };

    /**
     * Cleanup periodic processing listener, refresh interest, and flag.
     * Called from _removePlayerFromQueue (queue→0) and _onUnmount.
     */
    plugin._stopPeriodicProcessing = function () {
      if (plugin._s3?.players?.unregisterRefreshInterest) {
        plugin._s3.players.unregisterRefreshInterest('Switch');
      }
      plugin.server.removeListener('S3_PLAYERS_UPDATED', plugin._onPlayerInfoUpdated);
      plugin._periodicProcessingActive = false;
    };
  }
};

export default SwitchQueue;