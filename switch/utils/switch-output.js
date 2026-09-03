/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              SWITCH PLUGIN — OUTPUT LAYER                      ║
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
 * All dependencies are accessed via plugin.* (the live plugin
 * instance passed to register()). As of v2.5.6 this module issues no
 * queries of its own: getDiagnosticInfo() and _buildSwitchDiagEmbed()
 * both read plugin.getLiveRestrictionState() (switch-db.js), which is
 * the single place lazy token regeneration is applied for display.
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
        // Cumulative — feeds meanQueueMs/medianQueueMs. Deliberately not run
        // through _trackRoundStat: it holds bare numbers, and every duration
        // pushed here is already carried as queueDurationSeconds (or
        // p1/p2DurationSeconds) on the event line logged beside it, so a round
        // can still be rebuilt from the log without a line per number.
        queueDurationsMs: [],
        // Round identity, captured during the round and finalised at
        // ROUND_ENDED. It cannot simply be read where the row is written: the
        // row is built in onNewGame, by which point S³ has already advanced
        // to the NEXT round, so asking gameState there would label every row
        // with the round that follows it. All three stay null when nothing
        // ever resolved; the counts are the point and a missing map name does
        // not void them.
        matchId: null,
        layerName: null,
        gameMode: null
      };
    };

    /**
     * Records what round is being played.
     *
     * Called from onNewGame (right after the stats reset), on every layer
     * change, and once more from onRoundEnded with { settled: true }.
     *
     * matchId frequently has not resolved yet at NEW_GAME — the seed sweeps
     * in switch.js guard on exactly that — so it is filled only while still
     * empty and the first resolved answer wins. Layer and gamemode need the
     * opposite rule; see below.
     */
    plugin._captureRoundIdentity = function ({ settled = false } = {}) {
      const st = plugin._roundStats;
      if (!st) return;
      const gs = plugin._s3?.gameState;

      // First-wins is right for matchId: at NEW_GAME it reads as null until
      // it resolves, so the first non-null answer is the correct one.
      if (st.matchId == null) st.matchId = gs?.getMatchId?.() || null;

      // Layer and gamemode cannot use that rule. At NEW_GAME they do not read
      // as null — they read as the PREVIOUS round's layer, because server
      // info still describes the map being travelled away from. S³ commits
      // that value (trusted=true) and fires its layer-change subscribers with
      // it, so both capture paths see a wrong answer that looks like a right
      // one, seconds before the real layer arrives. First-wins would then
      // pin the round to the previous map permanently. Seen live on
      // 2026-09-02: a Gorodok_RAAS_v1 round stored as AlBasrah_AAS_v1 / AAS.
      //
      // The round-end pass is therefore the authoritative one and overwrites:
      // by ROUND_ENDED the layer has been settled for a whole round.
      const layerName = gs?.getLayerName?.() || null;
      const gameMode = gs?.getGamemode?.() || null;
      if (settled) {
        if (layerName) st.layerName = layerName;
        if (gameMode) st.gameMode = gameMode;
        return;
      }
      if (st.layerName == null) st.layerName = layerName;
      if (st.gameMode == null) st.gameMode = gameMode;
    };

    /**
     * Flattens the round's in-memory stats into one persistable row.
     *
     * This is the same arithmetic the round-summary embed prints, lifted out
     * so it can be stored as numbers. Storing it is what lets `!switch stats`
     * and the 7-day report stop re-reading their own Discord prose — a
     * scrape that only ever worked because those embeds were English.
     *
     * Runs regardless of roundEndSummaryEnabled: whether an operator wants a
     * message posted every round is a separate question from whether the
     * numbers survive.
     *
     * @returns {object|null} a SwitchPlugin_RoundStats row, or null with no stats
     */
    plugin._computeRoundStatsRow = function () {
      const s = plugin._roundStats;
      if (!s) return null;

      let toT1 = 0, toT2 = 0;
      const countDest = (list, key) => {
        for (const p of list) { if (p[key] === 1) toT1++; else toT2++; }
      };
      countDest(s.instantSwitches, 'toTeam');
      countDest(s.queueNormal, 'toTeam');
      countDest(s.queueJoinSwaps, 'toTeam');
      countDest(s.queueTimeoutSwitches, 'toTeam');
      countDest(s.queueTeamTrades, 'p1ToTeam');
      countDest(s.queueTeamTrades, 'p2ToTeam');

      // Unrecognised reason strings are bucketed rather than dropped — the
      // onChatMessage catch-all can produce one, and a denial that lands
      // nowhere would make the totals stop adding up.
      const denials = { cooldown: 0, time_window: 0, scramble_lock: 0, recent_switch: 0, other: 0 };
      for (const d of s.deniedSwitches) {
        if (Object.prototype.hasOwnProperty.call(denials, d.reason) && d.reason !== 'other') denials[d.reason]++;
        else denials.other++;
      }

      const durations = s.queueDurationsMs || [];
      // Null, not zero, when nobody queued: a round with no queue must not
      // pull the multi-round average down toward an instant wait.
      const meanQueueMs = durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null;
      const medianQueueMs = durations.length > 0 ? plugin._computeMedian(durations) : null;

      return {
        matchId: s.matchId,
        layerName: s.layerName,
        gameMode: s.gameMode,
        roundEndedAt: new Date(),
        liberalMode: !!s.wasLiberalMode,
        // Live rows are always complete — every field below came from the
        // round itself. Only backfilled rows set this.
        incomplete: false,
        source: 'live',
        success: s.instantSwitches.length + s.queueNormal.length +
          s.queueTeamTrades.length + s.queueJoinSwaps.length + s.queueTimeoutSwitches.length,
        failed: s.queueExpiries.length,
        denied: s.deniedSwitches.length,
        toT1,
        toT2,
        maxQueueSize: s.maxQueueSize || 0,
        instant: s.instantSwitches.length,
        queueNormal: s.queueNormal.length,
        queueTeamTrade: s.queueTeamTrades.length,
        queueJoinSwap: s.queueJoinSwaps.length,
        queueTimeoutSwitch: s.queueTimeoutSwitches.length,
        denialCooldown: denials.cooldown,
        denialTimeWindow: denials.time_window,
        denialScrambleLock: denials.scramble_lock,
        denialRecentSwitch: denials.recent_switch,
        denialOther: denials.other,
        outcomeExpired: s.queueExpiries.length,
        outcomeDC: s.queueDisconnects.length,
        outcomeCancelled: s.queueCancels.length,
        outcomeRemoved: (s.queueRemovals || []).length,
        meanQueueMs,
        medianQueueMs
      };
    };

    /**
     * Record one round-stat event, and log it in a single greppable shape.
     *
     * Every counter in SwitchPlugin_RoundStats is fed from here, so the log
     * and the stored row cannot disagree: there is no way to record an event
     * without emitting its line, because it is the same call.
     *
     * That matters because the queue paths are close to untestable on a live
     * server — a queue only forms when the teams are full and unbalanced,
     * which a maintainer cannot conjure on demand. Reconstructing a round
     * from the log afterwards is the practical substitute, so the line has to
     * be machine-readable, not prose:
     *
     *   [RoundStat] queueTeamTrades {"p1Name":"Alice","p2Name":"Bob",...}
     *
     * Strip the prefix and JSON.parse the rest. Grep with:
     *
     *   grep -o '\[RoundStat\] .*' squadjs.log
     *
     * Logged at verbose level 1 deliberately. These are low-frequency (a busy
     * round is tens of lines, not thousands) and worthless if a server has to
     * be reconfigured before they appear — by then the round is gone.
     *
     * Returns the entry so callers can keep using it.
     */
    plugin._trackRoundStat = function (bucket, entry) {
      const st = plugin._roundStats;
      if (!st || !Array.isArray(st[bucket])) return entry;
      st[bucket].push(entry);
      try {
        plugin.verbose(1, `[RoundStat] ${bucket} ${JSON.stringify(entry)}`);
      } catch {
        // A circular or otherwise unserialisable entry must never take down a
        // switch. Losing the line is survivable; losing the round is not.
        plugin.verbose(1, `[RoundStat] ${bucket} (unserialisable entry)`);
      }
      return entry;
    };

    plugin._updateMaxQueueSize = function () {
      const current = plugin._getQueueSize();
      if (current > plugin._roundStats.maxQueueSize) {
        plugin._roundStats.maxQueueSize = current;
        plugin.verbose(1, `[RoundStat] maxQueueSize ${JSON.stringify({ size: current })}`);
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
      plugin._trackRoundStat('deniedSwitches', { name: playerName, eosID, reason, gamePhase });
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
        plugin.broadcast(plugin.localize('switch.warn.switchTeamSwitchingOpen', { remainingMin }));
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
          plugin.broadcast(plugin.localize('switch.warn.switchMRemainingRequest', { remainingMin }));
        }, intervalMs);
      }

      // Window close broadcast
      plugin._broadcastTimers.closeBroadcast = setTimeout(() => {
        plugin.broadcast(plugin.localize('switch.warn.switchTeamSwitchWindow'));
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
             ? plugin.localize('switch.labels.seedRequiresPlayers', { seedMinPlayers: minPlayers })
             : '';
           plugin.broadcast(plugin.localize('switch.warn.switchSeedModeSwitches', { seedTokenBonusMinutes: plugin.options.seedTokenBonusMinutes, minNote, bonusAmount }));
         } else if (isSeed && !bonusEnabled) {
           plugin.broadcast(plugin.localize('switch.warn.switchSeedModeSwitches2'));
         } else {
           plugin.broadcast(plugin.localize('switch.warn.switchNoCooldownRestrictions'));
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
        plugin.broadcast(plugin.localize('switch.warn.switchScrambleOccurredLast'));
      }, delayMs);

      // Periodic reminders (closed after switchEnabledMinutes — same as normal broadcast window)
      if (intervalMs > 0) {
        plugin._broadcastTimers.reminderInterval = setInterval(() => {
          plugin.broadcast(plugin.localize('switch.warn.switchScrambleLockdownActive'));
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
        plugin.broadcast(plugin.localize('switch.warn.switchWantChangeTeams'));
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
      // Backstop for the round label: at NEW_GAME matchId is routinely still
      // unresolved. This also runs on the direct call from onNewGame, where
      // the layer is NOT yet trustworthy — onRoundEnded is what settles it.
      plugin._captureRoundIdentity();

      const isLiberal = plugin._liberalModes.some(m => {
        const candidate = String(m).toLowerCase();
        return (gameMode || '').toLowerCase().includes(candidate) ||
               (layerName || '').toLowerCase().includes(candidate);
      });

      const isSeed = plugin._s3?.gameState?.isSeedMode?.() || false;

      // v2.5.0: This handler no longer participates in the seed bonus at all.
      //
      // The consolation grant moved to the ENDGAME phase transition (see
      // _grantSeedBonusAtEndgame, subscribed in _onS3Ready). The layer edge was the
      // wrong trigger twice over: it never fired on back-to-back seed rounds, and it
      // ran at the exact moment the S³ roster is mid-refresh, so a connected-only
      // check could silently match nobody with no retry.
      //
      // The non-seed → seed bootstrap (previously _initSeedPresenceForAll) is
      // handled by the self-healing tick in _checkSeedBonusGrants, which creates
      // rows for connected players and resets stale ones on every
      // S3_PLAYERS_UPDATED tick while accrual is active. No event-edge init here.

      plugin._clearBroadcastTimers();

      // Do NOT clear _scrambleHappened here. This runs twice per round start
      // (direct call from onNewGame(), then again from the onLayerGameModeChange
      // subscription once S³ resolves the layer) — clearing it on the first call
      // meant the second call always fell through to the normal/liberal branch
      // and clobbered the pending post-scramble broadcast before its delayed
      // setTimeout fired. It stays true for the whole round; onRoundEnded()
      // is the single place that resets it, once the round is actually over.
      if (plugin._scrambleHappened) {
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
          plugin.warn(eosID, plugin.localize('switch.warn.switchScoreboardTeamChanges'));
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
      return m > 0
        ? plugin.localize('switch.roundSummary.durationMinutesSeconds', { mins: m, secs: s })
        : plugin.localize('switch.roundSummary.durationSeconds', { secs: s });
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

    /**
     * NOT LOCALIZED, deliberately.
     *
     * `!switch stats` fetches these embeds back out of Discord history and
     * parses them: it finds the message by the exact title, finds fields by
     * name (Stats, Switch Methods, Queue Activity) and reads counts out of
     * the **Mode:** / **Denied:** / **Queue Wait:** lines. The embed is a
     * storage format that happens to be readable, so its labels are keys.
     * Translating any of them silently breaks the scrape — including for
     * every round already posted, which stays English whatever the config
     * later says.
     */
    plugin._buildRoundSummaryEmbed = function () {
      const s = plugin._roundStats;
      if (!s) return null;

      // Every count in this embed comes from the row that gets persisted, so
      // the posted message and the stored numbers can never disagree.
      const row = plugin._computeRoundStatsRow();
      const totalSuccess = row.success;
      const totalFailed = row.failed;

      // Average queue wait (only queue-based successes, not instant)
      const queueDurations = s.queueDurationsMs || [];
      const avgQueueSec = Math.round((row.meanQueueMs || 0) / 1000);
      const avgMin = Math.floor(avgQueueSec / 60);
      const avgSec = avgQueueSec % 60;
      const avgStr = avgMin > 0
        ? plugin.localize('switch.roundSummary.durationMinutesSeconds', { mins: avgMin, secs: avgSec })
        : plugin.localize('switch.roundSummary.durationSeconds', { secs: avgSec });

      // Median queue wait
      const medianQueueMs = row.medianQueueMs || 0;
      const medianMin = Math.floor(medianQueueMs / 60000);
      const medianSec = Math.round((medianQueueMs % 60000) / 1000);
      const medianStr = medianMin > 0
        ? plugin.localize('switch.roundSummary.durationMinutesSeconds', { mins: medianMin, secs: medianSec })
        : plugin.localize('switch.roundSummary.durationSeconds', { secs: medianSec });

      // Per-team destination counts (all success types)
      const { toT1, toT2 } = row;

      const fields = [];

      // ── Restart warning ──
      if (plugin._restartedThisRound) {
        fields.push({
          name: plugin.localize('switch.roundSummary.notice'),
          value: plugin.localize('switch.roundSummary.restartedNotice'),
          inline: false
        });
      }

      // ── Field 1: Stats ──
      const totalDenied = row.denied;
      const totalRequests = totalSuccess + totalFailed + totalDenied;
      const attemptedRequests = totalSuccess + totalFailed;
      const successRate = attemptedRequests > 0 ? Math.round((totalSuccess / attemptedRequests) * 100) : 0;
      const failRate = attemptedRequests > 0 ? Math.round((totalFailed / attemptedRequests) * 100) : 0;
      const denyRate = totalRequests > 0 ? Math.round((totalDenied / totalRequests) * 100) : 0;

      // Denial reason breakdown — only render known categories. Unrecognized
      // reason strings (e.g. 'unexpected error' from the onChatMessage catch-all,
      // or any raw SQL/RCON error messages that bypassed sanitization) are
      // bucketed as "other" to prevent ugly text from leaking into the embed.
      // Only the reasons that occurred are named, in the order they first
      // occurred — which the row's fixed columns cannot reproduce, so this
      // one pass stays here. The counts still come from the row.
      const KNOWN_DENIAL_REASONS = ['cooldown', 'time_window', 'scramble_lock', 'recent_switch'];
      const denialReasons = {};
      for (const d of s.deniedSwitches) {
        if (KNOWN_DENIAL_REASONS.includes(d.reason)) denialReasons[d.reason] = (denialReasons[d.reason] || 0) + 1;
      }
      const otherDenialCount = row.denialOther;
      const denialParts = Object.entries(denialReasons)
        .map(([reason, count]) => `${count} ${reason}`);
      if (otherDenialCount > 0) denialParts.push(plugin.localize('switch.roundSummary.otherDenials', { count: otherDenialCount }));
      const denialBreakdown = denialParts.join(', ');

      const statsLines = [];
      statsLines.push(plugin.localize('switch.roundSummary.mode', { mode: s.wasLiberalMode ? plugin.localize('switch.labels.modeLiberal') : plugin.localize('switch.labels.modeStandard') }));
      statsLines.push(plugin.localize('switch.roundSummary.requests', { total: totalRequests, succeeded: totalSuccess, denied: totalDenied, failed: totalFailed }));
      statsLines.push(plugin.localize('switch.roundSummary.successRate', { rate: successRate }));
      if (totalDenied > 0) {
        statsLines.push(totalDenied !== 1 ? plugin.localize('switch.roundSummary.deniedPlayersPlural', { count: totalDenied, breakdown: denialBreakdown }) : plugin.localize('switch.roundSummary.deniedPlayers', { count: totalDenied, breakdown: denialBreakdown }));
        statsLines.push(plugin.localize('switch.roundSummary.denialRate', { rate: denyRate }));
      }
      if (totalFailed > 0) {
        statsLines.push(plugin.localize('switch.roundSummary.failRate', { rate: failRate, expired: totalFailed }));
      }
      statsLines.push(plugin.localize('switch.roundSummary.maxQueueSize', { size: s.maxQueueSize }));
      if (queueDurations.length > 0) statsLines.push(plugin.localize('switch.roundSummary.queueWait', { mean: avgStr, median: medianStr }));
      const totalMoves = toT1 + toT2;
      if (totalMoves > 0) {
        const dirPct1 = ` (${((toT1 / totalMoves) * 100).toFixed(1)}%)`;
        const dirPct2 = ` (${((toT2 / totalMoves) * 100).toFixed(1)}%)`;
        statsLines.push(plugin.localize('switch.roundSummary.direction'));
        statsLines.push(`→ T1: ${toT1}${dirPct1}`);
        statsLines.push(`→ T2: ${toT2}${dirPct2}`);
      }

      fields.push({ name: plugin.localize('switch.roundSummary.statsField'), value: statsLines.join('\n'), inline: false });

      // ── Field 2: Switch Methods (successes only) ──
      const methodLines = [];

      if (s.instantSwitches.length) {
        const names = s.instantSwitches.slice(0, 20).map(p =>
          `${p.name} ${plugin._formatGamePhase(p.gamePhase)} (T${p.fromTeam}→T${p.toTeam})`
        );
        if (s.instantSwitches.length > 20) names.push(plugin.localize('switch.roundSummary.moreEllipsis', { count: s.instantSwitches.length - 20 }));
        methodLines.push(`${plugin.localize('switch.roundSummary.instantSwitchesHeading', { count: s.instantSwitches.length })}\n${names.join('\n')}`);
      }

      if (s.queueNormal.length) {
        const names = s.queueNormal.slice(0, 10).map(p => {
          const m = Math.floor(p.queueDurationSeconds / 60);
          const sec = p.queueDurationSeconds % 60;
          const dur = m > 0 ? `${m}m ${sec}s` : `${sec}s`;
          return `${p.name} ${plugin._formatGamePhase(p.gamePhase)} (T${p.currentTeamID || '?'}→T${p.toTeam}, ${dur})`;
        });
        if (s.queueNormal.length > 10) names.push(plugin.localize('switch.roundSummary.moreEllipsis', { count: s.queueNormal.length - 10 }));
        methodLines.push(`${plugin.localize('switch.roundSummary.queueNormalHeading', { count: s.queueNormal.length })}\n${names.join('\n')}`);
      }

      if (s.queueTeamTrades.length) {
        const names = s.queueTeamTrades.slice(0, 10).map(p => {
          const d1 = plugin._formatDuration(p.p1DurationSeconds);
          const d2 = plugin._formatDuration(p.p2DurationSeconds);
          return `${p.p1Name} ${plugin._formatGamePhase(p.gamePhase)} (T${p.p1FromTeam}→T${p.p1ToTeam}, ${d1}) ↔ ${p.p2Name} (T${p.p2FromTeam}→T${p.p2ToTeam}, ${d2})`;
        });
        if (s.queueTeamTrades.length > 10) names.push(plugin.localize('switch.roundSummary.moreEllipsis', { count: s.queueTeamTrades.length - 10 }));
        methodLines.push(`${plugin.localize('switch.roundSummary.queueTeamTradeHeading', { count: s.queueTeamTrades.length })}\n${names.join('\n')}`);
      }

      if (s.queueJoinSwaps.length) {
        const names = s.queueJoinSwaps.slice(0, 10).map(p => {
          const m = Math.floor(p.queueDurationSeconds / 60);
          const sec = p.queueDurationSeconds % 60;
          const dur = m > 0 ? `${m}m ${sec}s` : `${sec}s`;
          return `${p.name} ${plugin._formatGamePhase(p.gamePhase)} (T${p.currentTeamID || '?'}→T${p.toTeam}, ${dur})`;
        });
        if (s.queueJoinSwaps.length > 10) names.push(plugin.localize('switch.roundSummary.moreEllipsis', { count: s.queueJoinSwaps.length - 10 }));
        methodLines.push(`${plugin.localize('switch.roundSummary.queueJoinSwapHeading', { count: s.queueJoinSwaps.length })}\n${names.join('\n')}`);
      }

      if (s.queueTimeoutSwitches.length) {
        const names = s.queueTimeoutSwitches.slice(0, 10).map(p => {
          const m = Math.floor(p.queueDurationSeconds / 60);
          const sec = p.queueDurationSeconds % 60;
          const dur = m > 0 ? `${m}m ${sec}s` : `${sec}s`;
          return `${p.name} ${plugin._formatGamePhase(p.gamePhase)} (T${p.currentTeamID || '?'}→T${p.toTeam}, ${dur})`;
        });
        if (s.queueTimeoutSwitches.length > 10) names.push(plugin.localize('switch.roundSummary.moreEllipsis', { count: s.queueTimeoutSwitches.length - 10 }));
        methodLines.push(`${plugin.localize('switch.roundSummary.queueTimeoutSwitchHeading', { count: s.queueTimeoutSwitches.length })}\n${names.join('\n')}`);
      }

      if (methodLines.length > 0) {
        fields.push({ name: plugin.localize('switch.roundSummary.switchMethodsField'), value: methodLines.join('\n\n'), inline: false });
      }

      // ── Field 3: Queue Activity (non-success outcomes) ──
      const activityLines = [];

      if (s.queueExpiries.length) {
        const names = s.queueExpiries.slice(0, 20).map(p =>
          plugin.localize('switch.roundSummary.expiredEntry', {
            name: p.name,
            phase: plugin._formatGamePhase(p.gamePhase),
            duration: plugin._formatDuration(p.queueDurationSeconds)
          })
        );
        if (s.queueExpiries.length > 20) names.push(plugin.localize('switch.roundSummary.moreEllipsis', { count: s.queueExpiries.length - 20 }));
        activityLines.push(`${plugin.localize('switch.roundSummary.expiredHeading', { count: s.queueExpiries.length })}\n${names.join('\n')}`);
      }

      if (s.deniedSwitches.length) {
        const names = s.deniedSwitches.slice(0, 10).map(p =>
          `${p.name} ${plugin._formatGamePhase(p.gamePhase)}: ${p.reason}`
        );
        if (s.deniedSwitches.length > 10) names.push(plugin.localize('switch.roundSummary.moreEllipsis', { count: s.deniedSwitches.length - 10 }));
        activityLines.push(`${plugin.localize('switch.roundSummary.deniedHeading', { count: s.deniedSwitches.length })}\n${names.join('\n')}`);
      }

      if (s.queueDisconnects.length) {
        const names = s.queueDisconnects.slice(0, 20).map(p => {
          const dur = p.queueDurationSeconds != null ? plugin._formatDuration(p.queueDurationSeconds) : '?';
          const from = p.currentTeamID ? `T${p.currentTeamID}` : '?';
          const to = p.targetTeamID ? `T${p.targetTeamID}` : '?';
          return `${p.name} (${from}→${to}, ${dur})`;
        });
        if (s.queueDisconnects.length > 20) names.push(plugin.localize('switch.roundSummary.moreEllipsis', { count: s.queueDisconnects.length - 20 }));
        activityLines.push(`${plugin.localize('switch.roundSummary.dcdInQueueHeading', { count: s.queueDisconnects.length })}\n${names.join('\n')}`);
      }

      if (s.queueCancels.length) {
        const names = s.queueCancels.slice(0, 20).map(p => {
          const dur = p.queueDurationSeconds != null ? plugin._formatDuration(p.queueDurationSeconds) : '?';
          const from = p.currentTeamID ? `T${p.currentTeamID}` : '?';
          const to = p.toTeam ? `T${p.toTeam}` : '?';
          return `${p.name} (${from}→${to}, ${dur})`;
        });
        if (s.queueCancels.length > 20) names.push(plugin.localize('switch.roundSummary.moreEllipsis', { count: s.queueCancels.length - 20 }));
        activityLines.push(`${plugin.localize('switch.roundSummary.cancelledHeading', { count: s.queueCancels.length })}\n${names.join('\n')}`);
      }

      if (s.queueRemovals && s.queueRemovals.length) {
        const names = s.queueRemovals.slice(0, 20).map(p =>
          `${p.name} ${plugin._formatGamePhase(p.gamePhase)}: ${p.reason}`
        );
        if (s.queueRemovals.length > 20) names.push(plugin.localize('switch.roundSummary.moreEllipsis', { count: s.queueRemovals.length - 20 }));
        activityLines.push(`${plugin.localize('switch.roundSummary.removedHeading', { count: s.queueRemovals.length })}\n${names.join('\n')}`);
      }

      if (activityLines.length > 0) {
        fields.push({ name: plugin.localize('switch.roundSummary.queueActivityField'), value: activityLines.join('\n\n'), inline: false });
      }

      if (!fields.length) {
        fields.push({ name: plugin.localize('switch.roundSummary.noActivityField'), value: plugin.localize('switch.roundSummary.noActivityValue'), inline: false });
      }

      return {
        title: plugin.localize('switch.roundSummary.title'),
        color: 0x3498DB,
        fields,
        timestamp: new Date(),
        footer: { text: plugin.localize('switch.roundSummary.footer', { version: plugin.constructor.version }) }
      };
    };

    /**
     * Stores the round that just ended.
     *
     * Deliberately NOT gated on roundEndSummaryEnabled. That option decides
     * whether a message gets posted every round, which is a question about
     * channel noise; turning it off must not also throw the numbers away and
     * leave `!switch stats` reporting on a partial history.
     *
     * Never throws. A round ending is not allowed to fail because the DB is
     * down — the worst outcome here is one missing row in a report.
     */
    plugin._persistRoundStats = async function () {
      try {
        if (typeof plugin.recordRoundStats !== 'function') return;
        const row = plugin._computeRoundStatsRow();
        if (!row) return;
        const ok = await plugin.recordRoundStats(row);
        plugin.verbose(2, ok
          ? `[RoundStats] Stored round ${row.matchId || '(no matchId)'}: ${row.success} success, ${row.denied} denied, ${row.failed} expired.`
          : '[RoundStats] Round not stored — DB unavailable.');
      } catch (err) {
        plugin.verbose(1, `[RoundStats] Failed to store round: ${err.message}`);
      }
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

        // v2.5.6: shares getLiveRestrictionState() with the Discord embed.
        // This used to count `tokenBalance < maxTokens` straight off the stored
        // column, with no lazy regeneration and no expiry check on the lock —
        // against the 2026-08-20 production export it would have reported 114
        // "active locks" when the true number was 0. "Active" now means a player
        // who genuinely cannot switch at this instant.
        const state = await plugin.getLiveRestrictionState();
        if (state) {
          totalStoredPlayers = state.total;
          activeLocks = state.blocked.length;
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
      let dbOk = false, dbLabel = plugin.localize('switch.switchDiag.healthUnknown');
      let rconOk = false, rconLabel = plugin.localize('switch.switchDiag.healthNotApplicable');
      let s3Ok = false, s3Label = plugin.localize('switch.switchDiag.healthNotAvailable');
      // Tracked as a flag rather than re-read off s3Label: the label is
      // translated, so comparing it against the English word 'Partial' would
      // pick the wrong emoji in every language but English.
      let s3Partial = false;

      // DB check
      try {
        if (plugin._s3db?.isReady()) {
          await plugin._s3db.sequelize.authenticate();
          dbOk = true;
          dbLabel = plugin.localize('switch.switchDiag.healthConnected');
        } else {
          dbLabel = plugin.localize('switch.switchDiag.healthS3DbNotAvailable');
        }
      } catch (err) {
        dbLabel = plugin.localize('switch.switchDiag.healthError', { message: err.message });
      }

      // RCON latency check
      try {
        const start = Date.now();
        await plugin.server.rcon.execute('ListPlayers');
        rconOk = true;
        rconLabel = plugin.localize('switch.switchDiag.healthLatency', { ms: Date.now() - start });
      } catch (err) {
        rconLabel = plugin.localize('switch.switchDiag.healthError', { message: err.message });
      }

      // S³ integration check (like TB's testS3Integration)
      try {
        if (plugin._s3?.gameState?.isReady?.() && plugin._s3?.players?.isReady?.() && plugin._s3?.players?.canAct) {
          s3Ok = true;
          s3Label = plugin.localize('switch.switchDiag.healthReady');
        } else if (plugin._s3?.gameState?.isReady?.() || plugin._s3?.players?.isReady?.()) {
          s3Partial = true;
          s3Label = plugin.localize('switch.switchDiag.healthPartial');
        }
      } catch (err) {
        s3Label = plugin.localize('switch.switchDiag.healthError', { message: err.message });
      }

      const healthLines = [
        plugin.localize('switch.switchDiag.healthDatabase', { emoji: dbOk ? '🟢' : '🔴', label: dbLabel }),
        plugin.localize('switch.switchDiag.healthRcon', { emoji: rconOk ? '🟢' : '🔴', label: rconLabel }),
        plugin.localize('switch.switchDiag.healthS3Integration', { emoji: s3Ok ? '🟢' : s3Partial ? '🟠' : '🔴', label: s3Label })
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
          configLines.push(plugin.localize('switch.switchDiag.switchingClosed'));
        } else {
          const remainingMin = Math.ceil(remainingMs / 60000);
          configLines.push(plugin.localize('switch.switchDiag.switchingOpen', { remaining: remainingMin }));
        }
      } else if (plugin.timeLimitEnabled) {
        configLines.push(plugin.localize('switch.switchDiag.switchingLimitNotStarted'));
      } else {
        configLines.push(plugin.localize('switch.switchDiag.switchingNoTimeLimit'));
      }
      configLines.push(plugin.localize('switch.switchDiag.mode', { mode: isLiberal ? plugin.localize('switch.labels.modeLiberal') : plugin.localize('switch.labels.modeStandard') }));
      // Scramble lockdown is tracked per-player in the DB (scrambleLockdownExpiry).
      // Show the config duration rather than a transient runtime flag — the flag
      // is consumed by _onLayerChanged() for broadcast routing and is only briefly
      // true between round end and layer resolution.
      const scrambleMinutes = plugin.options.scrambleLockdownDurationMinutes;
      configLines.push(plugin.localize('switch.switchDiag.scrambleLockdown', { minutes: scrambleMinutes }));
      // v2.3.0: Show token bucket config
      const maxTokens = plugin.options.maxSwitchTokens;
      configLines.push(plugin.localize('switch.switchDiag.switchTokens', { max: maxTokens }));
      // Cooldown duration is a static config value — show it here alongside
      // the other durations (Scramble Lockdown, Queue Timeout) for consistency.
      const cooldownDurationLabel = plugin.options.switchCooldownMinutes > 0
        ? plugin.localize('switch.switchDiag.cooldownMinutes', { minutes: plugin.options.switchCooldownMinutes })
        : plugin.localize('switch.switchDiag.cooldownHours', { hours: plugin.options.switchCooldownHours });
      configLines.push(plugin.localize('switch.switchDiag.tokenRefill', { label: cooldownDurationLabel }));
      // "AllowTeamChanges" = RCON AllowTeamChanges setting. When off, players
      // cannot use the in-game scoreboard to swap teams — they must use !switch.
      configLines.push(plugin.localize('switch.switchDiag.allowTeamChanges', { state: plugin._changeTeamDisabled ? plugin.localize('switch.switchDiag.off') : plugin.localize('switch.switchDiag.on') }));
      configLines.push(plugin.localize('switch.switchDiag.queueTimeout', { minutes: plugin.options.queueTimeoutMinutes }));

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
        queueLines.push(plugin.localize('switch.switchDiag.queueEmpty'));
      } else {
        // Use live Date.now() here rather than the shared 'now' snapshot — queue
        // wait times are relative and should be accurate to the moment of display.
        const formatWait = (queuedAt) => {
          const sec = Math.round((Date.now() - queuedAt) / 1000);
          const m = Math.floor(sec / 60);
          const s = sec % 60;
          return m > 0
        ? plugin.localize('switch.roundSummary.durationMinutesSeconds', { mins: m, secs: s })
        : plugin.localize('switch.roundSummary.durationSeconds', { secs: s });
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
          queueLines.push(plugin.localize('switch.switchDiag.andMore', { count: allEntries.length - 10 }));
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

      // v2.5.6: one pass over the table, every number below derived from it.
      // Previously this block issued four separate queries, two of which applied
      // lazy regeneration and two of which did not — which is how the embed came
      // to print "Players Below Cap: 0" directly above five players listed as
      // restricted, each showing "2/2 tokens (full)".
      let state = null;
      try {
        state = await plugin.getLiveRestrictionState();
      } catch (err) {
        // Degrade quietly. A transient DB error should not stop System Health,
        // Config and Queue from rendering.
        plugin.verbose(2, `[Diag] Live restriction state unavailable: ${err.message}`);
      }

      const cooldownLines = [];
      let playerList = plugin.localize('switch.switchDiag.nobodyBlocked');

      if (!state) {
        cooldownLines.push(plugin.localize('switch.switchDiag.unavailableDbNotReady'));
        playerList = plugin.localize('switch.switchDiag.unavailable');
      } else {
        // "Out of Tokens" replaces "Players Below Cap". Below-cap was never a
        // restriction: with maxSwitchTokens at 2, a player holding 1 can still
        // switch. Only an empty wallet actually blocks anyone.
        cooldownLines.push(plugin.localize('switch.switchDiag.outOfTokens', { count: state.outOfTokens }));
        cooldownLines.push(plugin.localize('switch.switchDiag.scrambleLocked', { count: state.scrambleLocked }));
        cooldownLines.push(plugin.localize('switch.switchDiag.holdingTokens', { max: maxTokens, count: state.belowCap }));
        // Qualified as "online" because the count only includes connected
        // players now — an offline row's presence clock accrues nothing, and
        // counting those was reporting 75 seeders on an empty server.
        cooldownLines.push(plugin.localize('switch.switchDiag.seedAccruing', { count: state.seedAccruing, rosterNote: state.rosterReady ? '' : plugin.localize('switch.switchDiag.rosterUnavailable') }));
        // Explicitly labelled as retention, not surveillance. "Tracked Players:
        // 378" read as though the plugin were watching 378 people; it is simply
        // how many rows are inside the pruning window.
        cooldownLines.push(plugin.localize('switch.switchDiag.rowsRetention', { days: plugin.options.pruneInactivePlayerDays, count: state.total }));

        if (state.blocked.length > 0) {
          const shown = state.blocked.slice(0, 5);
          playerList = shown.map(p => {
            const parts = [];
            if (p.lockExpiry) parts.push(`🌪️ <t:${Math.floor(p.lockExpiry.getTime() / 1000)}:R>`);
            if (p.tokenBalance < 1) {
              const anchor = p.tokenRegenAnchor ? new Date(p.tokenRegenAnchor).getTime() : Date.now();
              const nextAt = Math.floor((anchor + cooldownDurationMs) / 1000);
              parts.push(plugin.localize('switch.switchDiag.tokenNext', { max: maxTokens, nextAt }));
            }
            return `${p.online ? '🟢' : '⚫'} **${p.playerName || p.steamID || p.eosID}**: ${parts.join(' ')}`;
          }).join('\n');
          if (state.blocked.length > shown.length) {
            playerList += '\n' + plugin.localize('switch.switchDiag.andMore', { count: state.blocked.length - shown.length });
          }
        }
      }

      // ── Color logic ──
      const allOk = dbOk && rconOk && s3Ok;
      const anyBroken = !dbOk || !rconOk;
      const color = allOk ? 0x2ecc71 : anyBroken ? 0xe74c3c : 0xf39c12;

      // ── Build embed ──
      return {
        title: plugin.localize('switch.switchDiag.switchPluginDiagnosticsV', { VERSION }),
        color,
        fields: [
          { name: plugin.localize('switch.switchDiag.systemHealth'), value: healthLines, inline: false },
          { name: plugin.localize('switch.switchDiag.config'), value: configLines.join('\n'), inline: false },
          { name: plugin.localize('switch.switchDiag.queueTotalqueued', { totalQueued }), value: queueLines.join('\n'), inline: false },
          { name: plugin.localize('switch.switchDiag.tokenLockSummary'), value: cooldownLines.join('\n'), inline: false },
          // Renamed from "Restricted Players (top 5)", which was neither: the
          // sort key was a mostly-expired lockdown timestamp, and the players it
          // listed were not restricted. This field now answers one question —
          // who cannot switch right now — and says so plainly when nobody can.
          {
            name: state && state.blocked.length > 0
              ? plugin.localize('switch.switchDiag.currentlyBlocked', { blockedCount: state.blocked.length })
              : plugin.localize('switch.switchDiag.currentlyBlockedNone'),
            value: playerList,
            inline: false
          }
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
