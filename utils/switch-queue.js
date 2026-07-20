/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              SWITCH PLUGIN — QUEUE SUBSYSTEM                  ║
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
 * - Queue uses a stability gate: solo switches are only processed
 *   when team counts are stable across two consecutive polls.
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

      const windowMs = plugin.options.switchEnabledMinutes * 60 * 1000;
      const targetTeam = teamID === 1 ? 2 : 1;
      const subQueue = teamID === 1 ? 't1' : 't2';

      if (plugin._findQueueEntry(eosID)) {
        const existing = plugin._findQueueEntry(eosID).entry;
        const remaining = ((await plugin._getRemainingWindowMs(existing.eosID)) / 60000).toFixed(1);
        plugin.warn(eosID,
          `[Switch Queue]\nYou are already in the queue.\n~${remaining}m remaining | Team ${existing.currentTeamID} → Team ${existing.targetTeamID}\nType !switch cancel to leave.`
        );
        return;
      }

      const queuedAt = Date.now();

      const warnInterval = setInterval(async () => {
        const found = plugin._findQueueEntry(eosID);
        if (!found) { clearInterval(warnInterval); return; }

        const entry = found.entry;
        const remaining = ((await plugin._getRemainingWindowMs(entry.eosID)) / 60000).toFixed(1);

        const sameTeam = plugin._switchQueue[entry.currentTeamID === 1 ? 't1' : 't2'];
        const pos = sameTeam.findIndex(e => e.eosID === eosID) + 1;

        plugin.warn(entry.eosID,
          `[Switch Queue]\nPosition ${pos} in the queue.\n~${remaining}m remaining | Team ${entry.currentTeamID} → Team ${entry.targetTeamID}\nType !switch cancel to leave.`
        );
      }, 30_000);

      const enqueuePos = plugin._switchQueue[subQueue].length + 1;

      const entry = { eosID, steamID, playerName, currentTeamID: teamID, targetTeamID: targetTeam, queuedAt, warnInterval };
      plugin._switchQueue[subQueue].push(entry);
      plugin._updateMaxQueueSize();

      plugin.warn(eosID,
        `[Switch Queue]\nAdded to position ${enqueuePos} in the queue.\n~${((await plugin._getRemainingWindowMs(eosID)) / 60000).toFixed(1)}m remaining | Team ${teamID} → Team ${targetTeam}\n${reason}\nType !switch cancel to leave.`
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
        plugin.server.on('S3_PLAYERS_UPDATED', plugin._onPlayerInfoUpdated);
        plugin._periodicProcessingActive = true;
        plugin.verbose(2, '[S3] Started periodic queue processing via S3_PLAYERS_UPDATED events.');
      }

      plugin._requestQueueRefresh();
    };

    plugin._getRemainingWindowMs = async function (eosID) {
      // Compute actual remaining time based on join time and match start time,
      // not on when the player queued. The player's window is the longer of their
      // join-based and match-start-based timers.
      const windowMs = plugin.options.switchEnabledMinutes * 60 * 1000;
      const limitSeconds = plugin.options.switchEnabledMinutes * 60;
      const joinSeconds = await plugin.getSecondsFromJoin(eosID);
      const matchSeconds = plugin.getSecondsFromMatchStart();
      const joinRemainingMs = Math.max(0, (limitSeconds - joinSeconds) * 1000);
      const matchRemainingMs = Math.max(0, (limitSeconds - matchSeconds) * 1000);
      const actualRemainingMs = Math.max(joinRemainingMs, matchRemainingMs);
      // Cap at windowMs — the initial window is the max possible
      return Math.min(actualRemainingMs, windowMs);
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
          plugin._roundStats.queueJoinSwaps.push({
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
        await plugin._taggedSwitchPlayer(eosID, 'Handshake-Swap');
        if (plugin._roundStats) {
          const qDuration = Math.round((Date.now() - entry.queuedAt) / 1000);
          const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
          plugin._roundStats.queueJoinSwaps.push({
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

      // UNIFIED LOCK GATE: If a higher-priority plugin holds a global or per-player lock,
      // defer queue processing. The canAct call on the first queued player acts as a
      // proxy for the global lock check — canAct() checks both global and per-player locks
      // internally. If no queued players, use null to test the global lock alone.
      const queueLockPlayers = plugin._s3?.players;
      if (queueLockPlayers?.isReady?.()) {
        const anyEosID = plugin._getQueueSize() > 0
          ? (plugin._switchQueue.t1[0]?.eosID || plugin._switchQueue.t2[0]?.eosID)
          : null;
        if (!queueLockPlayers.canAct(anyEosID, 'Switch')) {
          plugin.verbose(2, `[Queue] Deferred — higher-priority lock held.`);
          return;
        }
      }

      plugin._queueProcessing = true;
      try {
        if (plugin.s3IsEndgameFactionVote()) {
          if (plugin._getQueueSize() > 0) {
            plugin.verbose(2, `[Queue] Faction vote in progress — skipping queue processing.`);
          }
          return;
        }

        const windowMs = plugin.options.switchEnabledMinutes * 60 * 1000;
        const nowTs = Date.now();

        for (const subQueue of ['t1', 't2']) {
          const arr = plugin._switchQueue[subQueue];
          for (let i = arr.length - 1; i >= 0; i--) {
            const entry = arr[i];
            if (plugin.timeLimitEnabled && (nowTs - entry.queuedAt) >= windowMs) {
              clearInterval(entry.warnInterval);
              arr.splice(i, 1);
              if (plugin._roundStats) {
                const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
                const queueDurationSeconds = Math.round((nowTs - entry.queuedAt) / 1000);
                plugin._roundStats.queueExpiries.push({
                  name: entry.playerName,
                  eosID: entry.eosID,
                  queueDurationSeconds,
                  gamePhase
                });
              }
              plugin.warn(entry.eosID, `[Switch Queue] Removed — join/match window closed.\nYour ${plugin.options.switchEnabledMinutes}m window expired while waiting.\nUse !switch explain for details.`);
              plugin.verbose(2, `[Queue] ${entry.playerName} expired and removed from queue.`);
            }
          }
        }

        let t1 = 0, t2 = 0;
        for (const p of plugin.server.players) {
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

          const live1 = plugin.server.players.find(p => p.eosID === p1.eosID);
          const live2 = plugin.server.players.find(p => p.eosID === p2.eosID);

          if (!live1 || live1.teamID !== p1.currentTeamID) {
            plugin._removePlayerFromQueue(p1.eosID);
            if (plugin._roundStats) {
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              plugin._roundStats.queueRemovals.push({ name: p1.playerName, eosID: p1.eosID, reason: 'team_changed', gamePhase });
            }
            plugin.verbose(1, `[Queue] ${p1.playerName} team changed externally — removed from queue.`);
            continue;
          }
          if (!live2 || live2.teamID !== p2.currentTeamID) {
            plugin._removePlayerFromQueue(p2.eosID);
            if (plugin._roundStats) {
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              plugin._roundStats.queueRemovals.push({ name: p2.playerName, eosID: p2.eosID, reason: 'team_changed', gamePhase });
            }
            plugin.verbose(1, `[Queue] ${p2.playerName} team changed externally — removed from queue.`);
            continue;
          }

          plugin._removePlayerFromQueue(p1.eosID);
          plugin._removePlayerFromQueue(p2.eosID);

          plugin.warn(p1.eosID, '[Switch Queue] Swap partner found — switching now.');
          plugin.warn(p2.eosID, '[Switch Queue] Swap partner found — switching now.');

          await plugin._taggedSwitchPlayer(p1.eosID, 'Player-Queue');
          await plugin._taggedSwitchPlayer(p2.eosID, 'Player-Queue');

          if (!plugin.isLiberalMode()) {
            const now = new Date();
            const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
            if (PlayerCooldowns) {
              for (const p of [p1, p2]) {
                try {
                  await plugin._withDb(async (t) => {
                    await PlayerCooldowns.upsert(
                      { eosID: p.eosID, steamID: p.steamID, playerName: p.playerName, lastSwitchTimestamp: now },
                      { transaction: t }
                    );
                  });
                } catch (dbErr) {
                  plugin.verbose(1, `[Queue] Cooldown write failed for ${p.playerName}: ${dbErr.message}`);
                }
              }
            }
          }

          // Track completed pair trade
          if (plugin._roundStats) {
            const dur1 = Math.round((Date.now() - p1.queuedAt) / 1000);
            const dur2 = Math.round((Date.now() - p2.queuedAt) / 1000);
            const avgDuration = Math.round((dur1 + dur2) / 2);
            const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
            plugin._roundStats.queueTeamTrades.push({
              p1Name: p1.playerName,
              p2Name: p2.playerName,
              p1ToTeam: p1.targetTeamID,
              p2ToTeam: p2.targetTeamID,
              queueDurationSeconds: avgDuration,
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
          const live = plugin.server.players.find(p => p.eosID === entry.eosID);
          if (!live || live.teamID !== entry.currentTeamID) {
            plugin._removePlayerFromQueue(entry.eosID);
            if (plugin._roundStats) {
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              plugin._roundStats.queueRemovals.push({ name: entry.playerName, eosID: entry.eosID, reason: 'team_changed', gamePhase });
            }
            plugin.verbose(1, `[Queue] ${entry.playerName} team changed externally — removed from queue.`);
            continue;
          }

          const effectiveCap = plugin.isLiberalMode() ? plugin.options.liberalSwitchMaxUnbalancedSlots : null;
          const slots = plugin.getSwitchSlotsPerTeam(entry.currentTeamID, effectiveCap);
          if (slots > 0) {
            plugin._removePlayerFromQueue(entry.eosID);

            plugin.warn(entry.eosID, '[Switch Queue] Balance slot opened — switching now.');
            await plugin._taggedSwitchPlayer(entry.eosID, 'Player-Queue');

            if (!plugin.isLiberalMode()) {
              const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
              if (PlayerCooldowns) {
                try {
                  await plugin._withDb(async (t) => {
                    await PlayerCooldowns.upsert(
                      { eosID: entry.eosID, steamID: entry.steamID, playerName: entry.playerName, lastSwitchTimestamp: new Date() },
                      { transaction: t }
                    );
                  });
                } catch (dbErr) {
                  plugin.verbose(1, `[Queue] Cooldown write failed for ${entry.playerName}: ${dbErr.message}`);
                }
              }
            }

            // Track completed solo switch
            if (plugin._roundStats) {
              const qDuration = Math.round((Date.now() - entry.queuedAt) / 1000);
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              plugin._roundStats.queueNormal.push({
                name: entry.playerName,
                eosID: entry.eosID,
                currentTeamID: entry.currentTeamID,
                toTeam: entry.currentTeamID === 1 ? 2 : 1,
                queueDurationSeconds: qDuration,
                gamePhase
              });
              plugin._roundStats.queueDurationsMs.push(qDuration * 1000);
            }

            plugin.verbose(1, `[Queue] Solo switch fired for ${entry.playerName} (T${entry.currentTeamID})`);

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