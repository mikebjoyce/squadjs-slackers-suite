/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              SWITCH PLUGIN v2.4.0 — OUTPUT LAYER               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * All 'push information to players/Discord' concerns for the Switch
 * plugin: broadcast timers, round summary tracking & Discord embeds,
 * diagnostics embed, join-warn scheduling, and the layer-change
 * subscription handler. Extracted from switch.js during the refactor
 * to keep the main plugin focused on orchestration.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SwitchOutput (default)
 *   Singleton with a single register(plugin) method.
 *   Attaches output/display state and methods to the plugin instance.
 *   Does NOT start timers — the main plugin calls start methods from
 *   lifecycle hooks.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Sequelize (Op) — query operators for getDiagnosticInfo() and
 *   _buildSwitchDiagEmbed().
 * All other dependencies are accessed via plugin.* (the live plugin
 * instance passed to register()).
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Broadcast timers are started by _onLayerChanged() via the
 *   onLayerGameModeChange subscription, which fires after
 *   game-state-service resolves the layer.
 * - Join-warn timeouts are cleared on disconnect via
 *   _clearJoinWarnTimeout().
 * - Round stats are reset in onNewGame() via _initRoundStats().
 * - Diagnostics embed uses the circle emoji status scheme
 *   (🟢 ok / 🔴 broken / 🟠 degraded / ⚫ off) for consistent
 *   cross-plugin UX.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Sequelize from 'sequelize';
const { Op } = Sequelize;

const SwitchOutput = {
  /**
   * Attaches output/display state and methods to the plugin instance.
   * Adds: plugin._broadcastTimers, plugin._joinWarnTimeouts,
   *       plugin._roundStats, plugin._unsubscribeLayerChange,
   *       and all output methods listed below.
   *
   * @param {object} plugin — the live Switch plugin instance
   */
  register(plugin) {
    // ── State objects ──────────────────────────────────────────

    // v2.0.0: Broadcast timer handles (cleared in _onUnmount)
    plugin._broadcastTimers = {
      firstBroadcast: null,
      reminderInterval: null,
      closeBroadcast: null,
      genericInfoTimer: null    // v2.0.0: 25-minute generic info broadcast
    };

    // v2.0.0: Map of join-warn timeouts per eosID (cleared on disconnect/cleanup)
    plugin._joinWarnTimeouts = new Map();

    // Unsubscribe callback for S³ onLayerGameModeChange (registered in _onS3Ready)
    plugin._unsubscribeLayerChange = null;

    // Round stats — initialized by _initRoundStats() called from mount()/onNewGame()
    plugin._roundStats = null;

    // ── Round Stats Helpers ────────────────────────────────────

    plugin._initRoundStats = function () {
      return {
        instantSwitches: [],    // { name, eosID, fromTeam, toTeam, gamePhase }
        deniedSwitches: [],     // { name, eosID, reason, gamePhase } — one per unique player per round
        _deniedPlayerSet: new Set(),  // eosIDs already denied this round (dedup)
        queueTeamTrades: [],    // { p1Name, p2Name, p1FromTeam, p1ToTeam, p2FromTeam, p2ToTeam, p1DurationSeconds, p2DurationSeconds, gamePhase }
        queueNormal: [],        // { name, eosID, queueDurationSeconds, gamePhase }
        queueJoinSwaps: [],     // { name, eosID, type ('swap'|'consume'), queueDurationSeconds, gamePhase }
        queueExpiries: [],      // { name, eosID, queueDurationSeconds, gamePhase }
        queueDisconnects: [],   // { name, eosID, currentTeamID, targetTeamID, queueDurationSeconds, gamePhase }
        queueCancels: [],       // { name, eosID }
        queueRemovals: [],      // { name, eosID, reason, gamePhase } — removed due to team change / other
        maxQueueSize: 0,        // peak _getQueueSize() during the round
        queueTimeoutSwitches: [],  // { name, eosID, currentTeamID, toTeam, queueDurationSeconds, gamePhase }
        wasLiberalMode: false,         // cached at round-end
        queueDurationsMs: [],   // cumulative — used for average wait time
      };
    };

    plugin._updateMaxQueueSize = function () {
      const current = plugin._getQueueSize();
      if (current > plugin._roundStats.maxQueueSize) {
        plugin._roundStats.maxQueueSize = current;
      }
    };

    /**
     * Track a denied switch in round stats (scramble_lock, time_window, cooldown).
     * Guarded — no-op if _roundStats is not initialized.
     */
    plugin._trackDenial = function (eosID, playerName, reason) {
      if (!plugin._roundStats) return;
      // Dedup: only record the first denial per player per round.
      // Spam !switch on cooldown should not inflate the count.
      if (plugin._roundStats._deniedPlayerSet.has(eosID)) return;
      plugin._roundStats._deniedPlayerSet.add(eosID);
      const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
      plugin._roundStats.deniedSwitches.push({ name: playerName, eosID, reason, gamePhase });
    };

    // ── Broadcast Helpers ──────────────────────────────────────

    /**
     * Start broadcast timers for the switch window.
     * Called from onNewGame().
     *
     * NOTE: Guard against unset _gameStartTs. The S³ onLayerGameModeChange
     * subscription (in _onLayerChanged) may fire before SquadJS's onNewGame
     * event sets _gameStartTs, causing Date.now() - undefined = NaN which
     * broadcasts "~NaNm remaining". When _gameStartTs is unset, this method
     * silently returns — _onLayerChanged will re-trigger the correct broadcast
     * path once onNewGame eventually sets _gameStartTs.
     */
    plugin._startBroadcastTimers = function () {
      if (!plugin.options.broadcastSwitchWindowMessages) return;
      if (!plugin.timeLimitEnabled) return;
      if (!Number.isFinite(plugin._gameStartTs)) return;

      plugin._clearBroadcastTimers();

      const windowMs = plugin.options.switchEnabledMinutes * 60 * 1000;
      const delayMs = plugin.options.switchWindowBroadcastDelaySeconds * 1000;
      const intervalMs = plugin.options.switchWindowBroadcastIntervalMinutes * 60 * 1000;

      // First broadcast after delay
      plugin._broadcastTimers.firstBroadcast = setTimeout(() => {
        if (!Number.isFinite(plugin._gameStartTs)) return;
        const remainingMin = Math.floor((windowMs - delayMs) / 60000);
        plugin.broadcast(`[Switch] Team switching is open. Use '!switch help' for details. Window: ~${remainingMin}m.`);
      }, delayMs);

      // Periodic reminders
      if (intervalMs > 0) {
        plugin._broadcastTimers.reminderInterval = setInterval(() => {
          if (!Number.isFinite(plugin._gameStartTs)) return;
          const elapsed = Date.now() - plugin._gameStartTs;
          const remainingMs = windowMs - elapsed;
          if (remainingMs <= 0) {
            plugin._clearBroadcastTimers();
            return;
          }
          const remainingMin = Math.ceil(remainingMs / 60000);
          plugin.broadcast(`[Switch] ~${remainingMin}m remaining to request a team change. Use '!switch check' to see your eligibility.`);
        }, intervalMs);
      }

      // Window close broadcast
      plugin._broadcastTimers.closeBroadcast = setTimeout(() => {
        plugin.broadcast(`[Switch] Team switch window is now closed.`);
        plugin._clearBroadcastTimers();
      }, windowMs);
    };

    plugin._clearBroadcastTimers = function () {
      if (plugin._broadcastTimers.firstBroadcast) {
        clearTimeout(plugin._broadcastTimers.firstBroadcast);
        plugin._broadcastTimers.firstBroadcast = null;
      }
      if (plugin._broadcastTimers.reminderInterval) {
        clearInterval(plugin._broadcastTimers.reminderInterval);
        plugin._broadcastTimers.reminderInterval = null;
      }
      if (plugin._broadcastTimers.closeBroadcast) {
        clearTimeout(plugin._broadcastTimers.closeBroadcast);
        plugin._broadcastTimers.closeBroadcast = null;
      }
      if (plugin._broadcastTimers.genericInfoTimer) {
        clearInterval(plugin._broadcastTimers.genericInfoTimer);
        plugin._broadcastTimers.genericInfoTimer = null;
      }
      // seedBonusTimer was removed as part of the broadcast consolidation —
      // the incentive broadcast was merged into the primary 5-minute message.
    };

    /**
     * Start periodic liberal-mode (Seed/Jensen) broadcast timer.
     * Runs every 5 minutes while the round is active.
     * Called from onNewGame() when isLiberalMode() is true.
     *
     * Seed bonus messaging is gated on isSeedMode() AND the seed bonus being
     * enabled (seedTokenBonusAmount > 0 AND seedTokenBonusMinutes > 0),
     * NOT on maxSwitchTokens > 1 — the two are independent config options.
     * On Jensen/Training (liberal but not seed), the fallback message simply says
     * switches are unrestricted, without mentioning token earning.
     *
     * Previously there was a separate 10-minute "incentive" broadcast for seed
     * bonus reminders. It was removed as redundant — the primary 5-minute broadcast
     * now carries the complete seed bonus message.
     */
    plugin._startLiberalBroadcastTimers = function () {
      if (!plugin.options.broadcastSwitchWindowMessages) return;
      const intervalMs = plugin.options.liberalSwitchBroadcastIntervalMinutes * 60 * 1000;
      if (intervalMs <= 0) return;  // 0 = disabled

      plugin._clearBroadcastTimers();

      // Broadcast: seed mode status or legacy fallback
      // Gated on isSeedMode() (not isLiberalMode()) to avoid showing seed bonus
      // messages during Jensen/Training rounds where the mechanic doesn't apply.
       plugin._broadcastTimers.reminderInterval = setInterval(() => {
         const isSeed = plugin._s3?.gameState?.isSeedMode?.() || false;
         const bonusAmount = plugin.options.seedTokenBonusAmount;
         const bonusEnabled = plugin._isSeedBonusEnabled?.() ?? (bonusAmount > 0);
         const minPlayers = plugin.options.seedTokenBonusMinPlayers ?? 0;
         if (isSeed && bonusEnabled) {
           const minNote = minPlayers > 0
             ? ` (requires ${minPlayers}+ players online)`
             : '';
           plugin.broadcast(`[Switch] Seed mode — switches are free (no token cost). You earn +1 bonus switch token for every ${plugin.options.seedTokenBonusMinutes}m of helping seed${minNote}, up to ${bonusAmount} per round. Use '!switch check' to see your balance.`);
         } else if (isSeed && !bonusEnabled) {
           plugin.broadcast(`[Switch] Seed mode — switches are free (no token cost). Use '!switch' to change teams anytime.`);
         } else {
           plugin.broadcast(`[Switch] No cooldown restrictions on this game mode. Use '!switch' to change teams anytime.`);
         }
       }, intervalMs);

      // NOTE: A separate 10-minute incentive broadcast was removed as redundant.
      // The primary 5-minute broadcast above carries the complete seed bonus message.
    };

    /**
     * Start post-scramble broadcast timers replacing normal switch window broadcasts.
     * Runs for the full duration of the round — no window close message.
     * Called from onNewGame() when plugin._scrambleHappened is true.
     */
    plugin._startPostScrambleBroadcastTimers = function () {
      if (!plugin.options.broadcastSwitchWindowMessages) return;

      plugin._clearBroadcastTimers();

      const delayMs = plugin.options.switchWindowBroadcastDelaySeconds * 1000;
      const intervalMs = plugin.options.switchWindowBroadcastIntervalMinutes * 60 * 1000;
      const windowMs = plugin.options.switchEnabledMinutes * 60 * 1000;

      // First broadcast after delay
      plugin._broadcastTimers.firstBroadcast = setTimeout(() => {
        plugin.broadcast(`[Switch] A scramble occurred last round. Returning players cannot change teams this round. New arrivals can still switch — use '!switch check'.`);
      }, delayMs);

      // Periodic reminders (closed after switchEnabledMinutes — same as normal broadcast window)
      if (intervalMs > 0) {
        plugin._broadcastTimers.reminderInterval = setInterval(() => {
          plugin.broadcast(`[Switch] Scramble lockdown active. Returning players cannot change teams this round. New arrivals can still switch — use '!switch check'.`);
        }, intervalMs);
      }

      // Close broadcasts after the switch window expires — beyond that, new arrivals
      // have no remaining time to use !switch anyway, so no need to keep reminding.
      plugin._broadcastTimers.closeBroadcast = setTimeout(() => {
        plugin._clearBroadcastTimers();
      }, windowMs);
    };

    /**
     * Start the 25-minute generic informative broadcast timer.
     * Runs on all round types (normal, liberal, post-scramble) and coexists
     * with other broadcast timers. Called from onNewGame() on all paths.
     */
    plugin._startGenericInfoTimer = function () {
      // No guard on broadcastSwitchWindowMessages — generic info is independent
      if (plugin._broadcastTimers.genericInfoTimer) return; // already running

      plugin._broadcastTimers.genericInfoTimer = setInterval(() => {
        plugin.broadcast(`[Switch] Want to change teams? Type '!switch' to request a team change. Use '!switch help' to learn more.`);
      }, 25 * 60 * 1000);
    };

    /**
     * Handle authoritative layer/gamemode change events from S³ game-state-service.
     * Called via the onLayerGameModeChange subscription (registered in _onS3Ready).
     * Fires AFTER resolveLayerInfo() commits the new layer — no stale data race.
     *
     * Clears any active broadcast timers, then starts the appropriate ones
     * based on the confirmed layer/gamemode and scramble state.
     */
    plugin._onLayerChanged = function (layerName, gameMode) {
      const isLiberal = plugin._liberalModes.some(m => {
        const candidate = String(m).toLowerCase();
        return (gameMode || '').toLowerCase().includes(candidate) ||
               (layerName || '').toLowerCase().includes(candidate);
      });

      // v2.3.0 Stage 2: Detect seed→non-seed transitions for bonus token grants
      const isSeed = plugin._s3?.gameState?.isSeedMode?.() || false;
      const wasSeed = plugin._wasSeedMode;
      plugin._wasSeedMode = isSeed;

      // v2.4.0: sync accrual state with the new layer. When active, seed presence
      // accrues; when inactive (disabled or below min players), the clock is paused.
      plugin._seedAccrualActive = plugin._isSeedAccrualActive?.() ?? false;

      // If transitioning from seed to non-seed, grant bonus tokens to all
      // players who were present during the seed round (§4.1b).
      if (wasSeed && !isSeed) {
        plugin._grantSeedBonusOnTransition().catch(err => {
          plugin.verbose(1, `[SeedPresence] Error granting seed bonus on transition: ${err.message}`);
        });
      }

      // If transitioning into seed from non-seed and accrual is active, init
      // seedPresenceStart for all currently connected players (§4.2).
      // When accrual is inactive (below min players), init is deferred to the
      // accrual activation path in _onSeedPresenceCheck.
      if (!wasSeed && isSeed && plugin._seedAccrualActive) {
        plugin._initSeedPresenceForAll().catch(err => {
          plugin.verbose(1, `[SeedPresence] Error initing seed presence for all: ${err.message}`);
        });
      }

      plugin._clearBroadcastTimers();

      if (plugin._scrambleHappened) {
        plugin._scrambleHappened = false;
        plugin._startPostScrambleBroadcastTimers();
      } else if (isLiberal) {
        plugin._startLiberalBroadcastTimers();
      } else {
        plugin._startBroadcastTimers();
      }

      plugin._startGenericInfoTimer();
    };

    // ── Join-warn Helpers ──────────────────────────────────────

    /**
     * Schedule a delayed warning for a player when ChangeTeam is disabled.
     * Cleared on disconnect via _clearJoinWarnTimeout().
     */
    plugin._scheduleJoinWarn = function (eosID) {
      if (!plugin._changeTeamDisabled || !plugin.options.warnOnJoinChangeTeamDisabled) return;
      if (plugin._joinWarnTimeouts.has(eosID)) return; // already scheduled

      const timeout = setTimeout(() => {
        plugin._joinWarnTimeouts.delete(eosID);
        // Verify player is still connected
        const stillHere = plugin.server.players.find(p => p.eosID === eosID);
        if (stillHere) {
          plugin.warn(eosID, `[Switch] Scoreboard team changes are disabled on this server. Use '!switch' to change teams. '!switch help' for more info.`);
        }
      }, plugin.constructor.JOIN_WARN_DELAY_MS);

      plugin._joinWarnTimeouts.set(eosID, timeout);
    };

    plugin._clearJoinWarnTimeout = function (eosID) {
      const timeout = plugin._joinWarnTimeouts.get(eosID);
      if (timeout) {
        clearTimeout(timeout);
        plugin._joinWarnTimeouts.delete(eosID);
      }
    };

    // ── Round-end Summary Helpers ──────────────────────────────

    plugin._formatGamePhase = function (phase) {
      return phase ? `(${phase})` : '';
    };

    plugin._formatDuration = function (seconds) {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    };

    /**
     * Compute the median of a numeric array using zero-copy sort.
     * Returns 0 for empty/null input.
     *
     * NOTE: Duplicated in switch-commands.js. If the algorithm changes,
     * update both copies.
     *
     * @param {number[]|null} arr — array of millisecond durations
     * @returns {number} median in milliseconds, or 0
     */
    plugin._computeMedian = function (arr) {
      if (!arr || arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 0) return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      return sorted[mid];
    };

    plugin._buildRoundSummaryEmbed = function () {
      const s = plugin._roundStats;
      if (!s) return null;

      const totalSuccess = s.instantSwitches.length + s.queueNormal.length +
        s.queueTeamTrades.length + s.queueJoinSwaps.length + s.queueTimeoutSwitches.length;
      const totalFailed = s.queueExpiries.length;

      // Average queue wait (only queue-based successes, not instant)
      const queueDurations = s.queueDurationsMs || [];
      const avgQueueSec = queueDurations.length > 0
        ? Math.round(queueDurations.reduce((a, b) => a + b, 0) / queueDurations.length / 1000)
        : 0;
      const avgMin = Math.floor(avgQueueSec / 60);
      const avgSec = avgQueueSec % 60;
      const avgStr = avgMin > 0 ? `${avgMin}m ${avgSec}s` : `${avgSec}s`;

      // Median queue wait
      const medianQueueMs = plugin._computeMedian(queueDurations);
      const medianMin = Math.floor(medianQueueMs / 60000);
      const medianSec = Math.round((medianQueueMs % 60000) / 1000);
      const medianStr = medianMin > 0 ? `${medianMin}m ${medianSec}s` : `${medianSec}s`;

      // Per-team destination counts (all success types)
      let toT1 = 0, toT2 = 0;
      for (const p of s.instantSwitches) {
        if (p.toTeam === 1) toT1++; else toT2++;
      }
      for (const p of s.queueNormal) {
        if (p.toTeam === 1) toT1++; else toT2++;
      }
      for (const p of s.queueJoinSwaps) {
        if (p.toTeam === 1) toT1++; else toT2++;
      }
      for (const p of s.queueTimeoutSwitches) {
        if (p.toTeam === 1) toT1++; else toT2++;
      }
      for (const p of s.queueTeamTrades) {
        if (p.p1ToTeam === 1) toT1++; else toT2++;
        if (p.p2ToTeam === 1) toT1++; else toT2++;
      }

      const fields = [];

      // ── Restart warning ──
      if (plugin._restartedThisRound) {
        fields.push({
          name: '⚠️ Notice',
          value: 'SquadJS was restarted during this round — switch data may be incomplete.',
          inline: false
        });
      }

      // ── Field 1: Stats ──
      const totalDenied = s.deniedSwitches.length;
      const totalRequests = totalSuccess + totalFailed + totalDenied;
      const attemptedRequests = totalSuccess + totalFailed;
      const successRate = attemptedRequests > 0 ? Math.round((totalSuccess / attemptedRequests) * 100) : 0;
      const failRate = attemptedRequests > 0 ? Math.round((totalFailed / attemptedRequests) * 100) : 0;
      const denyRate = totalRequests > 0 ? Math.round((totalDenied / totalRequests) * 100) : 0;

      // Denial reason breakdown — only render known categories. Unrecognized
      // reason strings (e.g. 'unexpected error' from the onChatMessage catch-all,
      // or any raw SQL/RCON error messages that bypassed sanitization) are
      // bucketed as "other" to prevent ugly text from leaking into the embed.
      const KNOWN_DENIAL_REASONS = ['cooldown', 'time_window', 'scramble_lock'];
      const denialReasons = {};
      let otherDenialCount = 0;
      for (const d of s.deniedSwitches) {
        if (KNOWN_DENIAL_REASONS.includes(d.reason)) {
          denialReasons[d.reason] = (denialReasons[d.reason] || 0) + 1;
        } else {
          otherDenialCount++;
        }
      }
      const denialParts = Object.entries(denialReasons)
        .map(([reason, count]) => `${count} ${reason}`);
      if (otherDenialCount > 0) denialParts.push(`${otherDenialCount} other`);
      const denialBreakdown = denialParts.join(', ');

      const statsLines = [];
      statsLines.push(`**Mode:** ${s.wasLiberalMode ? 'Liberal (Seed/Jensen)' : 'Standard'}`);
      statsLines.push(`**Requests:** ${totalRequests} (${totalSuccess} succeeded, ${totalDenied} denied, ${totalFailed} failed)`);
      statsLines.push(`**Success Rate:** ${successRate}%`);
      if (totalDenied > 0) {
        statsLines.push(`**Denied:** ${totalDenied} player${totalDenied !== 1 ? 's' : ''} (${denialBreakdown})`);
        statsLines.push(`**Denial Rate:** ${denyRate}%`);
      }
      if (totalFailed > 0) {
        statsLines.push(`**Fail Rate:** ${failRate}% (${totalFailed} expired)`);
      }
      statsLines.push(`**Max Queue Size:** ${s.maxQueueSize}`);
      if (queueDurations.length > 0) statsLines.push(`**Queue Wait:** mean ${avgStr}, median ${medianStr}`);
      if (totalSuccess > 0) {
        const dirPct1 = ` (${((toT1 / totalSuccess) * 100).toFixed(1)}%)`;
        const dirPct2 = ` (${((toT2 / totalSuccess) * 100).toFixed(1)}%)`;
        statsLines.push(`**Direction:**`);
        statsLines.push(`→ T1: ${toT1}${dirPct1}`);
        statsLines.push(`→ T2: ${toT2}${dirPct2}`);
      }

      fields.push({ name: '📊 Stats', value: statsLines.join('\n'), inline: false });

      // ── Field 2: Switch Methods (successes only) ──
      const methodLines = [];

      if (s.instantSwitches.length) {
        const names = s.instantSwitches.slice(0, 20).map(p =>
          `${p.name} ${plugin._formatGamePhase(p.gamePhase)} (T${p.fromTeam}→T${p.toTeam})`
        );
        if (s.instantSwitches.length > 20) names.push(`+ ${s.instantSwitches.length - 20} more...`);
        methodLines.push(`**Instant Switches (${s.instantSwitches.length})**\n${names.join('\n')}`);
      }

      if (s.queueNormal.length) {
        const names = s.queueNormal.slice(0, 10).map(p => {
          const m = Math.floor(p.queueDurationSeconds / 60);
          const sec = p.queueDurationSeconds % 60;
          const dur = m > 0 ? `${m}m ${sec}s` : `${sec}s`;
          return `${p.name} ${plugin._formatGamePhase(p.gamePhase)} (T${p.currentTeamID || '?'}→T${p.toTeam}, ${dur})`;
        });
        if (s.queueNormal.length > 10) names.push(`+ ${s.queueNormal.length - 10} more...`);
        methodLines.push(`**Queue Normal (${s.queueNormal.length})**\n${names.join('\n')}`);
      }

      if (s.queueTeamTrades.length) {
        const names = s.queueTeamTrades.slice(0, 10).map(p => {
          const d1 = plugin._formatDuration(p.p1DurationSeconds);
          const d2 = plugin._formatDuration(p.p2DurationSeconds);
          return `${p.p1Name} ${plugin._formatGamePhase(p.gamePhase)} (T${p.p1FromTeam}→T${p.p1ToTeam}, ${d1}) ↔ ${p.p2Name} (T${p.p2FromTeam}→T${p.p2ToTeam}, ${d2})`;
        });
        if (s.queueTeamTrades.length > 10) names.push(`+ ${s.queueTeamTrades.length - 10} more...`);
        methodLines.push(`**Queue Team Trade (${s.queueTeamTrades.length})**\n${names.join('\n')}`);
      }

      if (s.queueJoinSwaps.length) {
        const names = s.queueJoinSwaps.slice(0, 10).map(p => {
          const m = Math.floor(p.queueDurationSeconds / 60);
          const sec = p.queueDurationSeconds % 60;
          const dur = m > 0 ? `${m}m ${sec}s` : `${sec}s`;
          return `${p.name} ${plugin._formatGamePhase(p.gamePhase)} (T${p.currentTeamID || '?'}→T${p.toTeam}, ${dur})`;
        });
        if (s.queueJoinSwaps.length > 10) names.push(`+ ${s.queueJoinSwaps.length - 10} more...`);
        methodLines.push(`**Queue Join Swap (${s.queueJoinSwaps.length})**\n${names.join('\n')}`);
      }

      if (s.queueTimeoutSwitches.length) {
        const names = s.queueTimeoutSwitches.slice(0, 10).map(p => {
          const m = Math.floor(p.queueDurationSeconds / 60);
          const sec = p.queueDurationSeconds % 60;
          const dur = m > 0 ? `${m}m ${sec}s` : `${sec}s`;
          return `${p.name} ${plugin._formatGamePhase(p.gamePhase)} (T${p.currentTeamID || '?'}→T${p.toTeam}, ${dur})`;
        });
        if (s.queueTimeoutSwitches.length > 10) names.push(`+ ${s.queueTimeoutSwitches.length - 10} more...`);
        methodLines.push(`**Queue Timeout Switch (${s.queueTimeoutSwitches.length})**\n${names.join('\n')}`);
      }

      if (methodLines.length > 0) {
        fields.push({ name: '🔄 Switch Methods', value: methodLines.join('\n\n'), inline: false });
      }

      // ── Field 3: Queue Activity (non-success outcomes) ──
      const activityLines = [];

      if (s.queueExpiries.length) {
        const names = s.queueExpiries.slice(0, 20).map(p =>
          `${p.name} ${plugin._formatGamePhase(p.gamePhase)} (waited ${plugin._formatDuration(p.queueDurationSeconds)})`
        );
        if (s.queueExpiries.length > 20) names.push(`+ ${s.queueExpiries.length - 20} more...`);
        activityLines.push(`**Expired (${s.queueExpiries.length})**\n${names.join('\n')}`);
      }

      if (s.deniedSwitches.length) {
        const names = s.deniedSwitches.slice(0, 10).map(p =>
          `${p.name} ${plugin._formatGamePhase(p.gamePhase)}: ${p.reason}`
        );
        if (s.deniedSwitches.length > 10) names.push(`+ ${s.deniedSwitches.length - 10} more...`);
        activityLines.push(`**Denied (${s.deniedSwitches.length} unique players)**\n${names.join('\n')}`);
      }

      if (s.queueDisconnects.length) {
        const names = s.queueDisconnects.slice(0, 20).map(p => {
          const dur = p.queueDurationSeconds != null ? plugin._formatDuration(p.queueDurationSeconds) : '?';
          const from = p.currentTeamID ? `T${p.currentTeamID}` : '?';
          const to = p.targetTeamID ? `T${p.targetTeamID}` : '?';
          return `${p.name} (${from}→${to}, ${dur})`;
        });
        if (s.queueDisconnects.length > 20) names.push(`+ ${s.queueDisconnects.length - 20} more...`);
        activityLines.push(`**DC'd in Queue (${s.queueDisconnects.length})**\n${names.join('\n')}`);
      }

      if (s.queueCancels.length) {
        const names = s.queueCancels.slice(0, 20).map(p => {
          const dur = p.queueDurationSeconds != null ? plugin._formatDuration(p.queueDurationSeconds) : '?';
          const from = p.currentTeamID ? `T${p.currentTeamID}` : '?';
          const to = p.toTeam ? `T${p.toTeam}` : '?';
          return `${p.name} (${from}→${to}, ${dur})`;
        });
        if (s.queueCancels.length > 20) names.push(`+ ${s.queueCancels.length - 20} more...`);
        activityLines.push(`**Cancelled (${s.queueCancels.length})**\n${names.join('\n')}`);
      }

      if (s.queueRemovals && s.queueRemovals.length) {
        const names = s.queueRemovals.slice(0, 20).map(p =>
          `${p.name} ${plugin._formatGamePhase(p.gamePhase)}: ${p.reason}`
        );
        if (s.queueRemovals.length > 20) names.push(`+ ${s.queueRemovals.length - 20} more...`);
        activityLines.push(`**Removed (${s.queueRemovals.length})**\n${names.join('\n')}`);
      }

      if (activityLines.length > 0) {
        fields.push({ name: 'ℹ️ Queue Activity', value: activityLines.join('\n\n'), inline: false });
      }

      if (!fields.length) {
        fields.push({ name: 'No Activity', value: 'No switch activity this round.', inline: false });
      }

      return {
        title: 'Switch Round Summary',
        color: 0x3498DB,
        fields,
        timestamp: new Date(),
        footer: { text: `Switch v${plugin.constructor.version}` }
      };
    };

    plugin._postRoundSummary = async function () {
      if (!plugin.options.roundEndSummaryEnabled) return;
      try {
        const embed = plugin._buildRoundSummaryEmbed();
        if (!embed) return;
        await plugin.sendDiscordMessage({ embed });

        const s = plugin._roundStats;
        plugin.verbose(1, `[Summary] Round ended: ` +
          `${s.instantSwitches.length} instant, ${s.queueNormal.length} normal, ${s.queueTeamTrades.length} trades, ` +
          `${s.queueJoinSwaps.length} join-swaps, ${s.queueTimeoutSwitches.length} timeout-switches, ${s.deniedSwitches.length} denied (unique players), ` +
          `${s.queueExpiries.length} expired, ${s.queueDisconnects.length} DC, ${s.queueCancels.length} cancel. ` +
          `Max queue: ${s.maxQueueSize}.`
        );
      } catch (err) {
        plugin.verbose(1, `[Summary] Failed to post round summary: ${err.message}`);
      }
    };

    // ── Diagnostics ────────────────────────────────────────────

    plugin.getDiagnosticInfo = async function () {
      let dbStatus = 'Error';
      let activeLocks = 0;
      let totalStoredPlayers = 0;

      try {
        if (plugin._s3db?.isReady()) {
          await plugin._s3db.sequelize.authenticate();
          dbStatus = 'Connected';
        } else {
          dbStatus = 'S³ DB not available';
        }

        const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
        if (PlayerCooldowns) {
          totalStoredPlayers = await PlayerCooldowns.count();

          const maxTokens = plugin.options.maxSwitchTokens;

          activeLocks = await PlayerCooldowns.count({
            where: {
              [Op.or]: [
                { scrambleLockdownExpiry: { [Op.gt]: new Date() } },
                { tokenBalance: { [Op.lt]: maxTokens } }
              ]
            }
          });
        }
      } catch (e) {
        dbStatus = `Error: ${e.message}`;
      }
      return { dbStatus, activeLocks, totalStoredPlayers };
    };

    /**
     * Builds a diagnostics embed for the !switch status Discord command.
     * Uses the circle emoji status scheme (🟢 ok / 🔴 broken / 🟠 degraded / ⚫ off)
     * established in S³ for consistent cross-plugin UX.
     */
    plugin._buildSwitchDiagEmbed = async function () {
      const VERSION = plugin.constructor.version;

      // ── System health checks ──
      let dbOk = false, dbLabel = 'Unknown';
      let rconOk = false, rconLabel = 'N/A';
      let s3Ok = false, s3Label = 'Not available';

      // DB check
      try {
        if (plugin._s3db?.isReady()) {
          await plugin._s3db.sequelize.authenticate();
          dbOk = true;
          dbLabel = 'Connected';
        } else {
          dbLabel = 'S³ DB not available';
        }
      } catch (err) {
        dbLabel = `Error: ${err.message}`;
      }

      // RCON latency check
      try {
        const start = Date.now();
        await plugin.server.rcon.execute('ListPlayers');
        rconOk = true;
        rconLabel = `${Date.now() - start}ms`;
      } catch (err) {
        rconLabel = `Error: ${err.message}`;
      }

      // S³ integration check (like TB's testS3Integration)
      try {
        if (plugin._s3?.gameState?.isReady?.() && plugin._s3?.players?.isReady?.() && plugin._s3?.players?.canAct) {
          s3Ok = true;
          s3Label = 'Ready';
        } else if (plugin._s3?.gameState?.isReady?.() || plugin._s3?.players?.isReady?.()) {
          s3Label = 'Partial';
        }
      } catch (err) {
        s3Label = `Error: ${err.message}`;
      }

      const healthLines = [
        `${dbOk ? '🟢' : '🔴'} Database        ${dbLabel}`,
        `${rconOk ? '🟢' : '🔴'} RCON            ${rconLabel}`,
        `${s3Ok ? '🟢' : s3Label === 'Partial' ? '🟠' : '🔴'} S³ Integration   ${s3Label}`
      ].join('\n');

      // ── Config snapshot ──
      //
      // isLiberalMode() internally accesses _s3.gameState — guard against _s3
      // being unavailable (e.g. S³ unmounted mid-round). Fall back to false.
      const isLiberal = (plugin._s3 && plugin.isLiberalMode?.()) || false;
      // 'now' is shared between config timing (switch window) and the cooldown
      // cutoff computation below. Use a single snapshot to keep them consistent.
      const now = new Date();
      const configLines = [];

      if (plugin.timeLimitEnabled && plugin._gameStartTs) {
        const elapsed = Date.now() - plugin._gameStartTs;
        const remainingMs = plugin.options.switchEnabledMinutes * 60 * 1000 - elapsed;
        if (remainingMs <= 0) {
          configLines.push(`**Switching:** Closed`);
        } else {
          const remainingMin = Math.ceil(remainingMs / 60000);
          configLines.push(`**Switching:** Open (~${remainingMin}m remaining)`);
        }
      } else if (plugin.timeLimitEnabled) {
        configLines.push(`**Switching:** Limit enabled (not yet started)`);
      } else {
        configLines.push(`**Switching:** No time limit`);
      }
      configLines.push(`**Mode:** ${isLiberal ? 'Liberal (Seed/Jensen)' : 'Standard'}`);
      // Scramble lockdown is tracked per-player in the DB (scrambleLockdownExpiry).
      // Show the config duration rather than a transient runtime flag — the flag
      // is consumed by _onLayerChanged() for broadcast routing and is only briefly
      // true between round end and layer resolution.
      const scrambleMinutes = plugin.options.scrambleLockdownDurationMinutes;
      configLines.push(`**Scramble Lockdown:** ${scrambleMinutes} min per player`);
      // v2.3.0: Show token bucket config
      const maxTokens = plugin.options.maxSwitchTokens;
      configLines.push(`**Switch Tokens:** ${maxTokens}`);
      // Cooldown duration is a static config value — show it here alongside
      // the other durations (Scramble Lockdown, Queue Timeout) for consistency.
      const cooldownDurationLabel = plugin.options.switchCooldownMinutes > 0
        ? `${plugin.options.switchCooldownMinutes} min`
        : `${plugin.options.switchCooldownHours}h`;
      configLines.push(`**Token Refill:** ${cooldownDurationLabel} per token`);
      // "AllowTeamChanges" = RCON AllowTeamChanges setting. When off, players
      // cannot use the in-game scoreboard to swap teams — they must use !switch.
      configLines.push(`**AllowTeamChanges:** ${plugin._changeTeamDisabled ? 'Off' : 'On'}`);
      configLines.push(`**Queue Timeout:** ${plugin.options.queueTimeoutMinutes}m`);

      // ── Queue status ──
      //
      // Discord embed field values are capped at 1024 characters. To stay well
      // under that limit, we merge both sub-queues, sort by oldest-first, and
      // display at most 10 entries with an overflow line for any remainder.
      const t1Count = plugin._switchQueue?.t1?.length ?? 0;
      const t2Count = plugin._switchQueue?.t2?.length ?? 0;
      const totalQueued = t1Count + t2Count;

      const queueLines = [];
      if (totalQueued === 0) {
        queueLines.push('⚫ Empty');
      } else {
        // Use live Date.now() here rather than the shared 'now' snapshot — queue
        // wait times are relative and should be accurate to the moment of display.
        const formatWait = (queuedAt) => {
          const sec = Math.round((Date.now() - queuedAt) / 1000);
          const m = Math.floor(sec / 60);
          const s = sec % 60;
          return m > 0 ? `${m}m ${s}s` : `${s}s`;
        };
        // Merge both sub-queues and sort oldest-first for a unified view.
        const allEntries = [
          ...(plugin._switchQueue?.t1 ?? []).map(e => ({ ...e, _dir: 'T1 → T2' })),
          ...(plugin._switchQueue?.t2 ?? []).map(e => ({ ...e, _dir: 'T2 → T1' }))
        ].sort((a, b) => a.queuedAt - b.queuedAt);

        const display = allEntries.slice(0, 10);
        for (const entry of display) {
          queueLines.push(`${entry._dir}: **${entry.playerName}** (${formatWait(entry.queuedAt)})`);
        }
        if (allEntries.length > 10) {
          queueLines.push(`... and ${allEntries.length - 10} more`);
        }
      }

      // ── Cooldown statistics (token-aware) ──
      //
      // NOTE: This block duplicates much of the query logic in getDiagnosticInfo()
      // (above). The two methods serve different callers (Discord embed vs. general
      // health check) and have slightly different output shapes. If the table schema
      // changes, update both methods.
      // maxTokens is already declared above in the Config section
      const cooldownDurationMs = plugin.options.switchCooldownMinutes > 0
        ? plugin.options.switchCooldownMinutes * 60 * 1000
        : plugin.options.switchCooldownHours * 60 * 60 * 1000;

      let playersBelowCap = 0;
      let scrambleLocks = 0;
      let totalStoredPlayers = 0;
      let playerList = 'None';

      try {
        const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
        if (PlayerCooldowns) {
          playersBelowCap = await PlayerCooldowns.count({
            where: { tokenBalance: { [Op.lt]: maxTokens } }
          });
          scrambleLocks = await PlayerCooldowns.count({
            where: { scrambleLockdownExpiry: { [Op.gt]: now } }
          });
          totalStoredPlayers = await PlayerCooldowns.count();

          const lockedPlayers = await PlayerCooldowns.findAll({
            where: {
              [Op.or]: [
                { scrambleLockdownExpiry: { [Op.gt]: now } },
                { tokenBalance: { [Op.lt]: maxTokens } }
              ]
            },
            order: [['scrambleLockdownExpiry', 'DESC'], ['tokenBalance', 'ASC']],
            limit: 5
          });

          if (lockedPlayers.length > 0) {
            playerList = lockedPlayers.map(p => {
              // Apply lazy regen in-memory so token counts are live (not stale DB values)
              const liveRow = { tokenBalance: p.tokenBalance, tokenRegenAnchor: p.tokenRegenAnchor };
              plugin._regenTokens(liveRow);
              const parts = [];
              if (p.scrambleLockdownExpiry && p.scrambleLockdownExpiry > now) {
                parts.push(`🌪️ <t:${Math.floor(p.scrambleLockdownExpiry.getTime() / 1000)}:R>`);
              }
              if (liveRow.tokenBalance < maxTokens) {
                parts.push(`🎫 ${liveRow.tokenBalance}/${maxTokens} tokens`);
              } else {
                parts.push(`🎫 ${liveRow.tokenBalance}/${maxTokens} tokens (full)`);
              }
              return `**${p.playerName || p.steamID}**: ${parts.join(' ')}`;
            }).join('\n');
          }
        }
      } catch (err) {
        // Cooldown stats silently degrade — shown as 0/"None". Transient DB
        // errors (lock contention, connection blips) should not prevent the
        // rest of the embed from rendering with System Health + Config + Queue.
      }

      // Recompute playersBelowCap with lazy regen for accuracy
      let liveBelowCap = 0;
      try {
        const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
        if (PlayerCooldowns) {
          const allBelowCap = await PlayerCooldowns.findAll({
            where: { tokenBalance: { [Op.lt]: maxTokens } },
            attributes: ['tokenBalance', 'tokenRegenAnchor']
          });
          for (const row of allBelowCap) {
            const liveRow = { tokenBalance: row.tokenBalance, tokenRegenAnchor: row.tokenRegenAnchor };
            plugin._regenTokens(liveRow);
            if (liveRow.tokenBalance < maxTokens) {
              liveBelowCap++;
            }
          }
        }
      } catch (_) {
        liveBelowCap = playersBelowCap; // fallback to stored count on error
      }

      const cooldownLines = [];
      cooldownLines.push(`Players Below Cap:    ${liveBelowCap}`);
      cooldownLines.push(`Scramble Locks:        ${scrambleLocks}`);
      cooldownLines.push(`Tracked Players:       ${totalStoredPlayers}`);

      // ── Color logic ──
      const allOk = dbOk && rconOk && s3Ok;
      const anyBroken = !dbOk || !rconOk;
      const color = allOk ? 0x2ecc71 : anyBroken ? 0xe74c3c : 0xf39c12;

      // ── Build embed ──
      return {
        title: `🩺 Switch Plugin Diagnostics  v${VERSION}`,
        color,
        fields: [
          { name: 'System Health', value: healthLines, inline: false },
          { name: '\u{1F4CB} Config', value: configLines.join('\n'), inline: false },
          { name: `\u{1F465} Queue (${totalQueued})`, value: queueLines.join('\n'), inline: false },
          { name: '\u{1F550} Cooldown Statistics', value: cooldownLines.join('\n'), inline: false },
          { name: '\u{1F512} Restricted Players (top 5)', value: playerList, inline: false }
        ]
      };
    };

    // ── Stats Parsing Helpers ──────────────────────────────────

    plugin._parseStatsNum = function (re, text) {
      const m = text.match(re);
      return m ? parseInt(m[1], 10) : 0;
    };

    plugin._parseRoundStatsField = function (value) {
      // Parse the richer format: "Requests: X (Y succeeded, Z denied, W failed)"
      const requestsMatch = value.match(/\*\*Requests:\*\*\s*(\d+)\s*\((\d+)\s*succeeded,\s*(\d+)\s*denied,\s*(\d+)\s*failed\)/);
      let success = 0, failed = 0, denied = 0;
      if (requestsMatch) {
        // New format — extract from the Requests line
        success = parseInt(requestsMatch[2], 10);
        denied = parseInt(requestsMatch[3], 10);
        failed = parseInt(requestsMatch[4], 10);
      } else {
        // Fallback: old format (pre-dedup, if any older embeds exist)
        success = plugin._parseStatsNum(/\*\*Success:\*\*\s*(\d+)/, value);
        failed = plugin._parseStatsNum(/\*\*Failed \(expired\):\*\*\s*(\d+)/, value);
        denied = plugin._parseStatsNum(/\*\*Denied:\*\*\s*(\d+)/, value);
      }
      return {
        success,
        failed,
        denied,
        // v2.3.0: new format "→ T1: N (X%)" — try first, fall back to old "**To T1:** N"
        toT1: plugin._parseStatsNum(/→ T1:\s*(\d+)/, value) ||
              plugin._parseStatsNum(/\*\*To T1:\*\*\s*(\d+)/, value),
        toT2: plugin._parseStatsNum(/→ T2:\s*(\d+)/, value) ||
              plugin._parseStatsNum(/\*\*To T2:\*\*\s*(\d+)/, value)
      };
    };
  }
};

export default SwitchOutput;
