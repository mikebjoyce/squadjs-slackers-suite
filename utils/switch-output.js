/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              SWITCH PLUGIN — OUTPUT LAYER                     ║
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
        queueTeamTrades: [],    // { p1Name, p2Name, queueDurationSeconds, gamePhase }
        queueNormal: [],        // { name, eosID, queueDurationSeconds, gamePhase }
        queueJoinSwaps: [],     // { name, eosID, type ('swap'|'consume'), queueDurationSeconds, gamePhase }
        queueExpiries: [],      // { name, eosID, queueDurationSeconds, gamePhase }
        queueDisconnects: [],   // { name, eosID }
        queueCancels: [],       // { name, eosID }
        queueRemovals: [],      // { name, eosID, reason, gamePhase } — removed due to team change / other
        maxQueueSize: 0,        // peak _getQueueSize() during the round
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
     */
    plugin._startBroadcastTimers = function () {
      if (!plugin.options.broadcastSwitchWindowMessages) return;
      if (!plugin.timeLimitEnabled) return;

      plugin._clearBroadcastTimers();

      const windowMs = plugin.options.switchEnabledMinutes * 60 * 1000;
      const delayMs = plugin.options.switchWindowBroadcastDelaySeconds * 1000;
      const intervalMs = plugin.options.switchWindowBroadcastIntervalMinutes * 60 * 1000;

      // First broadcast after delay
      plugin._broadcastTimers.firstBroadcast = setTimeout(() => {
        const remainingMin = Math.floor((windowMs - delayMs) / 60000);
        plugin.broadcast(`[Switch] Team switching is open. Use '!switch help' for details. Window: ~${remainingMin}m.`);
      }, delayMs);

      // Periodic reminders
      if (intervalMs > 0) {
        plugin._broadcastTimers.reminderInterval = setInterval(() => {
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
    };

    /**
     * Start periodic liberal-mode (Seed/Jensen) broadcast timer.
     * Runs every 5 minutes while the round is active.
     * Called from onNewGame() when isLiberalMode() is true.
     */
    plugin._startLiberalBroadcastTimers = function () {
      if (!plugin.options.broadcastSwitchWindowMessages) return;

      plugin._clearBroadcastTimers();

      // Hardcoded 5-minute interval as requested
      plugin._broadcastTimers.reminderInterval = setInterval(() => {
        plugin.broadcast(`[Switch] No cooldown restrictions on this game mode. Use '!switch' to change teams anytime.`);
      }, 5 * 60 * 1000);
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

    plugin._buildRoundSummaryEmbed = function () {
      const s = plugin._roundStats;
      if (!s) return null;

      const totalSuccess = s.instantSwitches.length + s.queueNormal.length +
        s.queueTeamTrades.length + s.queueJoinSwaps.length;
      const totalFailed = s.queueExpiries.length;

      // Average queue wait (only queue-based successes, not instant)
      const queueDurations = s.queueDurationsMs || [];
      const avgQueueSec = queueDurations.length > 0
        ? Math.round(queueDurations.reduce((a, b) => a + b, 0) / queueDurations.length / 1000)
        : 0;
      const avgMin = Math.floor(avgQueueSec / 60);
      const avgSec = avgQueueSec % 60;
      const avgStr = avgMin > 0 ? `${avgMin}m ${avgSec}s` : `${avgSec}s`;

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
      const successRate = totalRequests > 0 ? Math.round((totalSuccess / totalRequests) * 100) : 0;
      const denyRate = totalRequests > 0 ? Math.round((totalDenied / totalRequests) * 100) : 0;
      const failRate = totalRequests > 0 ? Math.round((totalFailed / totalRequests) * 100) : 0;

      // Denial reason breakdown
      const denialReasons = {};
      for (const d of s.deniedSwitches) {
        denialReasons[d.reason] = (denialReasons[d.reason] || 0) + 1;
      }
      const denialBreakdown = Object.entries(denialReasons)
        .map(([reason, count]) => `${count} ${reason}`)
        .join(', ');

      const statsLines = [];
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
      if (queueDurations.length > 0) statsLines.push(`**Avg Queue Wait:** ${avgStr}`);
      statsLines.push(`**To T1:** ${toT1}`);
      statsLines.push(`**To T2:** ${toT2}`);

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
          const m = Math.floor(p.queueDurationSeconds / 60);
          const sec = p.queueDurationSeconds % 60;
          const dur = m > 0 ? `${m}m ${sec}s` : `${sec}s`;
          return `${p.p1Name} ↔ ${p.p2Name} ${plugin._formatGamePhase(p.gamePhase)} (T1↔T2, ${dur})`;
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
        const names = s.queueDisconnects.slice(0, 20).map(p => p.name);
        if (s.queueDisconnects.length > 20) names.push(`+ ${s.queueDisconnects.length - 20} more...`);
        activityLines.push(`**DC'd in Queue (${s.queueDisconnects.length})**\n${names.join('\n')}`);
      }

      if (s.queueCancels.length) {
        const names = s.queueCancels.slice(0, 20).map(p => p.name);
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
          `${s.queueJoinSwaps.length} join-swaps, ${s.deniedSwitches.length} denied (unique players), ` +
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

          const cooldownDurationMs = plugin.options.switchCooldownMinutes > 0 ? plugin.options.switchCooldownMinutes * 60 * 1000 : plugin.options.switchCooldownHours * 60 * 60 * 1000;
          const cooldownCutoff = new Date(Date.now() - cooldownDurationMs);

          activeLocks = await PlayerCooldowns.count({
            where: {
              [Op.or]: [
                { scrambleLockdownExpiry: { [Op.gt]: new Date() } },
                { lastSwitchTimestamp: { [Op.gt]: cooldownCutoff } }
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
     * Builds a diagnostics embed for the !switch diag Discord command.
     * Uses the circle emoji status scheme (🟢 ok / 🔴 broken / 🟠 degraded / ⚫ off)
     * established in S³ for consistent cross-plugin UX.
     */
    plugin._buildSwitchDiagEmbed = async function () {
      const VERSION = '2.0.0';

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

      // ── Queue status ──
      const t1Count = plugin._switchQueue?.t1?.length ?? 0;
      const t2Count = plugin._switchQueue?.t2?.length ?? 0;
      const totalQueued = t1Count + t2Count;

      // Compute oldest wait time across both queues
      let oldestWait = null;
      for (const entry of [...(plugin._switchQueue?.t1 ?? []), ...(plugin._switchQueue?.t2 ?? [])]) {
        if (oldestWait === null || entry.queuedAt < oldestWait) oldestWait = entry.queuedAt;
      }
      const waitStr = oldestWait !== null ? `${Math.round((Date.now() - oldestWait) / 1000)}s` : '\u2014';

      const queueLines = [
        `${totalQueued > 0 ? '🟢' : '⚫'} Players in Queue    ${totalQueued > 0 ? `${totalQueued} (t1: ${t1Count}, t2: ${t2Count})` : 'Empty'}`,
        `   Oldest wait: ${waitStr}`
      ].join('\n');

      // ── Cooldown statistics ──
      const now = new Date();
      const cooldownDurationMs = plugin.options.switchCooldownMinutes > 0
        ? plugin.options.switchCooldownMinutes * 60 * 1000
        : plugin.options.switchCooldownHours * 60 * 60 * 1000;
      const cooldownCutoff = new Date(now.getTime() - cooldownDurationMs);

      let standardCooldowns = 0;
      let scrambleLocks = 0;
      let playerList = 'None';

      try {
        const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
        if (PlayerCooldowns) {
          standardCooldowns = await PlayerCooldowns.count({
            where: { lastSwitchTimestamp: { [Op.gt]: cooldownCutoff } }
          });
          scrambleLocks = await PlayerCooldowns.count({
            where: { scrambleLockdownExpiry: { [Op.gt]: now } }
          });

          const lockedPlayers = await PlayerCooldowns.findAll({
            where: {
              [Op.or]: [
                { scrambleLockdownExpiry: { [Op.gt]: now } },
                { lastSwitchTimestamp: { [Op.gt]: cooldownCutoff } }
              ]
            },
            order: [['scrambleLockdownExpiry', 'DESC'], ['lastSwitchTimestamp', 'DESC']],
            limit: 5
          });

          if (lockedPlayers.length > 0) {
            playerList = lockedPlayers.map(p => {
              const parts = [];
              if (p.scrambleLockdownExpiry && p.scrambleLockdownExpiry > now) {
                parts.push(`🌪️ <t:${Math.floor(p.scrambleLockdownExpiry.getTime() / 1000)}:R>`);
              }
              if (p.lastSwitchTimestamp && new Date(p.lastSwitchTimestamp.getTime() + cooldownDurationMs) > now) {
                const expiry = new Date(p.lastSwitchTimestamp.getTime() + cooldownDurationMs);
                parts.push(`⏳ <t:${Math.floor(expiry.getTime() / 1000)}:R>`);
              }
              return `**${p.playerName || p.steamID}**: ${parts.join(' ')}`;
            }).join('\n');
          }
        }
      } catch (err) {
        // cooldown stats silently degrade — shown as 0/None
      }

      const cooldownDurationLabel = plugin.options.switchCooldownMinutes > 0
        ? `${plugin.options.switchCooldownMinutes} min`
        : `${plugin.options.switchCooldownHours}h`;

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
          { name: 'Queue Status', value: queueLines, inline: false },
          { name: 'Cooldown Statistics', value: `Standard Cooldowns:  ${standardCooldowns}\t Duration:  ${cooldownDurationLabel}\nScramble Locks:  ${scrambleLocks}`, inline: false },
          { name: 'Active Locks', value: playerList, inline: false }
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
        toT1: plugin._parseStatsNum(/\*\*To T1:\*\*\s*(\d+)/, value),
        toT2: plugin._parseStatsNum(/\*\*To T2:\*\*\s*(\d+)/, value)
      };
    };
  }
};

export default SwitchOutput;
