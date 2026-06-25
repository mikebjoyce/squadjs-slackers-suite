/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  SMART ASSIGN PLUGIN v2.0.0                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Handles custom Elo-based player auto-assignment and records player
 * lifecycle events. Overrides Squad's native team assignment to provide
 * competitive parity via Average-Elo balancing, reconnect memory,
 * and strict population equity rules. Bypasses "Seed" layers natively.
 * Captures Round Snapshots and embedded global populations in events.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SmartAssign (default)
 *   Extends BasePlugin. Key public methods:
 *     mount()                              — Initialises DB, discovers S³, and registers lifecycle listeners.
 *     unmount()                            — Removes all listeners and cleans up executor and timers.
 *     evaluateTeamAssignment(player, reconnectTeam) — Thin wrapper; builds context and delegates to sa-team-evaluator.
 *     handlePlayerJoin(player)             — Full join pipeline: reconnect, clan grouping, Elo eval, RCON move.
 *     handlePlayerLeave(player)            — Disconnect handling and reconnect memory persistence.
 *     handleTeamChange(player, oldTeam, newTeam, source) — Logs team changes with source attribution.
 *     logEvent(eventType, player, extraData, betweenRounds, serverPlayers) — Records lifecycle events to JSONL with embedded team populations.
 *     finalizeRoundLog()                   — Writes buffered events to disk and finalises the round log.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * SADatabase (../utils/sa-database.js)
 *   Sequelize-based persistence layer for reconnect memory and round state.
 * SASwapExecutor (../utils/sa-swap-executor.js)
 *   RCON move queue using "One-Hit & Verify" logic for fast, bounce-loop-free team switches.
 * SAEventLogger (../utils/sa-event-logger.js)
 *   JSONL event logging with in-memory batching and round finalisation.
 * evaluateTeamAssignment / getRating (../utils/sa-team-evaluator.js)
 *   Pure-functional team assignment scoring and Elo lookup.
 * SlackersSquadServices (sibling plugin — required)
 *   Provides gameState, players, and clans services. See S³ INTEGRATION below.
 *
 * ─── S³ INTEGRATION ──────────────────────────────────────────────
 * <!-- <TO REVIEW> S³ integration description — consolidate across plugins later -->
 *
 * SmartAssign requires SlackersSquadServices (S³) for core functionality.
 * The plugin discovers S³ at runtime via plugin registry lookup.
 *
 * Consumed Services:
 *   - gameState: round start time, match ID, layer/gamemode, ignored mode check,
 *     faction vote detection, round snapshot data.
 *   - players: refresh interest registration, reconnect memory, move attribution
 *     (recordMove), player list retrieval.
 *   - clans: clan tag extraction, normalisation, tag cache lookups for clan grouping.
 *
 * Emitted Events:
 *   - SMART_ASSIGN_MOVE_FAILED: fired when an RCON team switch fails or times out.
 *   - SMART_ASSIGN_MOVE_SUCCESS: fired when an RCON team switch is verified complete.
 *   - SMART_ASSIGN_MOVE_RETRY: fired on each retry attempt for a pending move.
 *
 * Listened Events:
 *   - S3_PLAYER_JOINED: triggers the full join assignment pipeline.
 *   - S3_PLAYER_TEAM_CHANGED: logs team changes with source attribution.
 *   - S3_PLAYER_LEFT: triggers disconnect handling and reconnect memory save.
 *   - S3_GAME_STATE_LIVE: fires round snapshot with full player roster.
 *
 * If S³ is not present at mount time, the plugin falls back to direct event
 * listeners (PLAYER_CONNECTED, etc.) and limited functionality.
 * <!-- </TO REVIEW> -->
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Code version at `static version` may lag behind the comment header version;
 *   this header reflects the canonical plugin version.
 * - Join swaps use Log-Driven triggering: the SteamID arrives from the Log Parser
 *   (~100ms after join), so the RCON command fires before RCON even knows the
 *   player exists. SASwapExecutor's forced post-command poll then verifies the result.
 * - Disconnect detection is delta-diff only (no PLAYER_DISCONNECTED listener) because
 *   that event is unreliable in current Squad/SquadJS. Every forced join refresh also
 *   speeds up disconnect detection for all other players as a side-effect.
 * - Algorithm uses a 3-Metric Composite Scoring System aligned with TeamBalancer:
 *     1. Hard Pop Cap: Prevents imbalance beyond dynamic thresholds.
 *     2. Physical Server Cap: Hard limit (50 players per team).
 *     3. Reconnect Priority: Hot-path reconnect memory lives in-memory for
 *        synchronous lookups. If the player has a reconnect record and the pop
 *        cap allows it, they are sent to their previous team immediately (before
 *        Elo scoring). On disconnect, the Map is updated synchronously and the DB
 *        is written async (fire-and-forget) for crash recovery.
 *     3.5. Clan Grouping: If a player is in a clan and ALL clan mates are on one
 *        team, route the player there (provided pop cap allows). Uses lightweight
 *        _playerTagCache for fast tag lookups via S³ ClansService.
 *     4. Elo Balancing: Combines three metrics—Mean ELO difference (0.6x), Top-15
 *        ELO difference (0.4x), and Veteran Parity Penalty (300x)—passed through a
 *        non-linear penalty curve to find the team placement with the lowest
 *        combined score.
 *     5. Reconnect Bias: If reconnect priority is blocked by the cap, applies a
 *        minor score reduction (0.25) toward the previous team to tip near-ties.
 *     6. Reconnect Bonus: Grants an *additional* +1 player imbalance allowance on
 *        top of the base for returning players (clan grouping gets the same).
 * - Strict 1-player max imbalance enforced at high population (96+).
 * - Bypasses auto-assignment completely during specified ignored modes (Seed/Jensen).
 * - Accuracy: Players with pending moves are excluded from team evaluation to
 *   prevent double-counting.
 * - Passive Mode: Set enableSmartAssign: false to observe only real server events
 *   (JOIN, LEAVE, TEAM_CHANGE). The algorithm does not run and no ASSIGNMENT
 *   events are logged.
 * - RCON Identifier Migration: Per RCON_IDENTIFIER_FINDINGS.md (June 2026),
 *   player.name is the only universally reliable RCON identifier. All RCON
 *   commands now use player.name via SASwapExecutor's name-based queueMove().
 *   _pendingPlayerMoves keys use eosID || steamID. Event handlers use playerKey.
 *
 * ─── COMMANDS ────────────────────────────────────────────────────
 *
 * No in-game chat commands.
 *
 * ─── CONFIGURATION ───────────────────────────────────────────────
 *
 * database: Sequelize connector name (default: 'sqlite').
 * logPath: Path for JSONL event logging (default: './auto-assign-log.jsonl').
 * enableSmartAssign: Toggle auto-assignment logic (default: true).
 * enableEventLogging: Toggle JSONL event logging (default: true).
 * ignoredGameModes: Array of modes to skip logic on (default: ['Seed', 'Jensen']).
 * enableClanGrouping: Toggle clan-mate grouping logic (default: true).
 * clanGroupMinSize: Minimum clan size for grouping (default: 2).
 * clanGroupCaseSensitive: Case-sensitive clan tag matching (default: false).
 * enableDatabaseLogging: If true, mirrors JSONL event data into database tables
 *   for querying (default: false).
 *
 * ─── AUTHOR ──────────────────────────────────────────────────────
 *
 * Slacker
 * Discord: real_slacker
 * GitHub:  https://github.com/mikebjoyce/squadjs-smart-assign
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Logger from '../../core/logger.js';
import BasePlugin from './base-plugin.js';
import SADatabase from '../utils/sa-database.js';
import SASwapExecutor from '../utils/sa-swap-executor.js';
import SAEventLogger from '../utils/sa-event-logger.js';
import { evaluateTeamAssignment, getRating } from '../utils/sa-team-evaluator.js';

const MAX_TEAM_SIZE = 50;

export default class SmartAssign extends BasePlugin {
  static version = '1.1.1';

  static get description() {
    return 'Smart team assignment via Elo ratings, reconnect memory, and population balance rules.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      database: {
        required: true,
        connector: 'sequelize',
        description: 'Sequelize connector name (SQLite, MySQL, PostgreSQL, etc.). Defaults to "sqlite".',
        default: 'sqlite'
      },
      enableSmartAssign: {
        required: false,
        description: 'If true, runs the assignment algorithm and moves players. If false, only logs real server events.',
        default: true,
        type: 'boolean'
      },
      enableEventLogging: {
        required: false,
        description: 'Toggle the JSONL event logging output.',
        default: true,
        type: 'boolean'
      },
      logPath: {
        required: false,
        description: 'Path to JSONL file for player lifecycle events.',
        default: './auto-assign-log.jsonl',
        type: 'string'
      },
      enableDatabaseLogging: {
        required: false,
        description: 'If true, mirrors JSONL event data into database tables for querying (default: false).',
        default: false,
        type: 'boolean'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.db = new SADatabase(server, options, connectors);
    this._s3 = null;  // Runtime discovery of SlackersSquadServices
    this.executor = new SASwapExecutor(server, {
      retryIntervalMs: 50,
      maxCompletionTimeMs: 3000,
      s3: this._s3  // S³ reference for canAct preemption check in retry branch
    });
    this.eventLogger = new SAEventLogger(options, this.db);

     this._joiningPlayers = new Set();
     this._sessionJoinTimes = new Map();
     this.previousRoundLayerName = null;  // Captured at ROUND_ENDED for reliable finalization
     this.previousRoundGamemode = null;   // Captured at ROUND_ENDED for reliable finalization
     this._pendingAssignments = { 1: 0, 2: 0 };
     this._pendingMu = { 1: 0, 2: 0 };
     this._pendingVeterans = { 1: 0, 2: 0 };
      this._pendingPlayerMoves = new Map(); // Map<playerKey, { targetTeam, mu, isVeteran }>
      this.ready = false;
     this._isFinalizingRound = false;

       this.eloTracker = null;

       this._warnFlags = { eloNotReadyWarned: false };

      // State bindings
      this.onNewGame = this.onNewGame.bind(this);
      this.onRoundEnded = this.onRoundEnded.bind(this);
      this.onPlayerConnected = this.onPlayerConnected.bind(this);
      this.onScrambleExecuted = this.onScrambleExecuted.bind(this);
      this.onMoveFailed = this.onMoveFailed.bind(this);
      this.onMoveSuccess = this.onMoveSuccess.bind(this);
      this.onMoveRetry = this.onMoveRetry.bind(this);
      this.onS3PlayerJoined = this.onS3PlayerJoined.bind(this);
       this.onS3PlayerTeamChanged = this.onS3PlayerTeamChanged.bind(this);
       this.onS3PlayerLeft = this.onS3PlayerLeft.bind(this);
       this.onS3GameStateLive = this.onS3GameStateLive.bind(this);
  }

  _isClanGroupingEnabled() {
    return !!(this._s3?.clans?.isEnabled?.());
  }

  async mount() {
    await super.mount();
    Logger.verbose('SmartAssign', 1, 'Mounting SmartAssign plugin.');

    this.eloTracker = this.server.plugins.find((p) => p.constructor.name === 'EloTracker') || null;
    if (this.eloTracker && typeof this.eloTracker.getMu !== 'function') {
      Logger.verbose('SmartAssign', 1, '[SmartAssign] Warning: EloTracker found but getMu() is missing. Falling back to population-only/internal-props.');
    }


    // S³ runtime discovery
    const s3 = this.server.plugins.find((p) => p.constructor.name === 'SlackersSquadServices');
    if (s3) {
      this._s3 = s3;
      this.executor._s3 = s3;  // Update executor's reference for canAct guard
      Logger.verbose('SmartAssign', 2, '[S3] Discovered SlackersSquadServices for SmartAssign.');
      const svc = this._s3?.services || {};
      Logger.verbose('SmartAssign', 2, `[S3] Available: gameState=${!!svc.gameState} factions=${!!svc.factions} clans=${!!svc.clans} db=${!!svc.db} players=${!!svc.players}`);

      // Register refresh interest with S³ PlayersService for fast join detection
      if (svc.players?.registerRefreshInterest) {
        svc.players.registerRefreshInterest('SmartAssign', { maxStalenessMs: 5000 });
        Logger.verbose('SmartAssign', 2, '[S3] Registered SmartAssign refresh interest (maxStalenessMs=5000).');
      }
    } else {
      Logger.verbose('SmartAssign', 2, '[S3] SlackersSquadServices not found — using fallback implementations.');
    }

    // Perform initial DB cleanup and start periodic maintenance
    await this.db.cleanupOldData();
    this.cleanupInterval = setInterval(() => {
      this.db.cleanupOldData();
    }, 6 * 60 * 60 * 1000);

    // Restart Recovery — delegated to S³ GameStateService
    const gs = this._s3?.gameState;
    const recoveredStart = gs?.getRoundStartTime?.();
    if (recoveredStart) {
      Logger.verbose('SmartAssign', 1, `Restart detected. Resuming round from S³ roundStartTime: ${recoveredStart}`);
    } else {
      // New round or no data
      Logger.verbose('SmartAssign', 1, 'New round or no persisted S³ state. Starting fresh.');

      // Finalize any leftover temp logs from a previous crashed session
      await this.finalizeRoundLog();
    }

      this.server.on('NEW_GAME', this.onNewGame);
      this.server.on('ROUND_ENDED', this.onRoundEnded);
      this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
      this.server.on('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
      this.server.on('SMART_ASSIGN_MOVE_FAILED', this.onMoveFailed);
      this.server.on('SMART_ASSIGN_MOVE_SUCCESS', this.onMoveSuccess);
      this.server.on('SMART_ASSIGN_MOVE_RETRY', this.onMoveRetry);

      // S³ event subscribers (Stage 4 — active assignment path)
      this.server.on('S3_PLAYER_JOINED', this.onS3PlayerJoined);
      this.server.on('S3_PLAYER_TEAM_CHANGED', this.onS3PlayerTeamChanged);
      this.server.on('S3_PLAYER_LEFT', this.onS3PlayerLeft);
      this.server.on('S3_GAME_STATE_LIVE', this.onS3GameStateLive);

     this.ready = true;
     Logger.verbose('SmartAssign', 1, 'SmartAssign mounted successfully.');
  }

  async unmount() {
    this.ready = false;
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.eventLogger.cleanup();
    await this.finalizeRoundLog();
    // Unregister S³ refresh interest (if S³ was available)
    if (this._s3?.players?.unregisterRefreshInterest) {
      this._s3?.players.unregisterRefreshInterest('SmartAssign');
    }
     this.server.removeListener('NEW_GAME', this.onNewGame);
     this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
     this.server.removeListener('PLAYER_CONNECTED', this.onPlayerConnected);
     this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
     this.server.removeListener('SMART_ASSIGN_MOVE_FAILED', this.onMoveFailed);
     this.server.removeListener('SMART_ASSIGN_MOVE_SUCCESS', this.onMoveSuccess);
     this.server.removeListener('SMART_ASSIGN_MOVE_RETRY', this.onMoveRetry);
     this.server.removeListener('S3_PLAYER_JOINED', this.onS3PlayerJoined);
     this.server.removeListener('S3_PLAYER_TEAM_CHANGED', this.onS3PlayerTeamChanged);
     this.server.removeListener('S3_PLAYER_LEFT', this.onS3PlayerLeft);
     this.server.removeListener('S3_GAME_STATE_LIVE', this.onS3GameStateLive);
    this._pendingPlayerMoves.clear();
    this.executor.cleanup();
    Logger.verbose('SmartAssign', 1, 'SmartAssign unmounted.');
     await super.unmount();
   }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // EVENT: NEW_GAME (Round Start)
  //
  // Fired when a new map loads and staging begins (NOT after staging completes).
  // ═══════════════════════════════════════════════════════════════════════════════════
  async onNewGame(info) {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 1, 'NEW_GAME detected. Finalizing previous round log.');

    await this.finalizeRoundLog();
    this.eventLogger._startBatchFlushTimer();

    this._joiningPlayers.clear();
    this._pendingAssignments[1] = 0;
    this._pendingAssignments[2] = 0;
    this._pendingMu[1] = 0;
    this._pendingMu[2] = 0;
    this._pendingVeterans[1] = 0;
    this._pendingVeterans[2] = 0;
    this._pendingPlayerMoves.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // EVENT: ROUND_ENDED (Round Finalization)
  // ═══════════════════════════════════════════════════════════════════════════════════
  async onRoundEnded(info) {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 1, 'ROUND_ENDED detected.');

    // Capture round metadata from S³ before NEW_GAME resets it
    const gs = this._s3?.gameState;
    if (gs) {
      this.previousRoundLayerName = gs.getLayerName();
      this.previousRoundGamemode = gs.getGamemode();
      this.previousRoundStartTime = gs.getRoundStartTime();
      this.previousMatchId = gs.getMatchId();
    }
    Logger.verbose('SmartAssign', 2, `[Layer] Captured at ROUND_ENDED: ${this.previousRoundLayerName || 'Unknown'} (${this.previousRoundGamemode || 'Unknown'})`);
  }

    async onScrambleExecuted() {
      if (!this.ready) return;
      Logger.verbose('SmartAssign', 1, 'TeamBalancer Scramble detected.');
    }

  // RCON IDENTIFIER MIGRATION: Event handlers now extract playerKey from data and use dual-key lookups
  async onMoveFailed(data) {
    if (!this.ready) return;
    const { playerKey, playerName, reason } = data;
    const pid = playerKey || data.steamID;

    if (pid && this._pendingPlayerMoves.has(pid)) {
      const move = this._pendingPlayerMoves.get(pid);
      this._pendingAssignments[move.targetTeam] = Math.max(0, this._pendingAssignments[move.targetTeam] - 1);
      this._pendingMu[move.targetTeam] = Math.max(0, this._pendingMu[move.targetTeam] - move.mu);
      if (move.isVeteran) {
        this._pendingVeterans[move.targetTeam] = Math.max(0, this._pendingVeterans[move.targetTeam] - 1);
      }
      this._pendingPlayerMoves.delete(pid);
    }

    const p = this.server.players.find((x) => (x.eosID || x.steamID) === pid) || { steamID: pid, name: playerName || 'Unknown' };
    Logger.verbose('SmartAssign', 1, `[SmartAssign] Abandoned move for ${p.name} (${pid}) - ${reason}`);
    this.logEvent('MOVE_FAILED', p, { reason }, false);
  }

  async onMoveSuccess(data) {
    if (!this.ready) return;
    const { playerKey, teamID } = data;
    const pid = playerKey || data.steamID;

    if (pid && this._pendingPlayerMoves.has(pid)) {
      const move = this._pendingPlayerMoves.get(pid);
      this._pendingAssignments[move.targetTeam] = Math.max(0, this._pendingAssignments[move.targetTeam] - 1);
      this._pendingMu[move.targetTeam] = Math.max(0, this._pendingMu[move.targetTeam] - move.mu);
      if (move.isVeteran) {
        this._pendingVeterans[move.targetTeam] = Math.max(0, this._pendingVeterans[move.targetTeam] - 1);
      }
      this._pendingPlayerMoves.delete(pid);
    }

    const p = this.server.players.find((x) => (x.eosID || x.steamID) === pid || x.name === data.name);
    if (p) {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Verified move success for ${p.name} (${pid}) to Team ${teamID}`);
      this.logEvent('MOVE_SUCCESS', p, { teamID }, false);
    }
  }

  async onMoveRetry(data) {
    if (!this.ready) return;
    const { playerKey, playerName, attempt, method } = data;
    const pid = playerKey || data.steamID;
    const p = this.server.players.find((x) => (x.eosID || x.steamID) === pid || x.name === playerName);
    if (p) {
      Logger.verbose('SmartAssign', 3, `[SmartAssign] Retrying move for ${p.name} (${pid}) | Attempt: ${attempt} | Method: ${method}`);
      this.logEvent('MOVE_RETRY', p, { attempt, method }, false);
    }
  }

  async onPlayerConnected(info) {
    if (!this.ready) return;
    const p = info.player;
    // RCON IDENTIFIER MIGRATION: Use playerKey (eosID || steamID) instead of gating on steamID only
    const playerKey = p && (p.eosID || p.steamID);
    if (!p || !playerKey) return;

    // Request a debounced player list refresh from S³ PlayersService.
    if (this._s3?.players?.requestRefresh) {
      this._s3?.players.requestRefresh('SmartAssign', { urgency: 'high' });
    }

    // Trigger join handling immediately using the log-provided player data.
    // The executor will fire the RCON move before the player is even visible
    // in the ListPlayers array — S³'s forced refresh will catch up shortly after.
    await this.handlePlayerJoin(p);
  }

  async handlePlayerJoin(player) {
    const lockKey = player.eosID || player.steamID;
    if (!lockKey) {
      Logger.verbose('SmartAssign', 1, `[SmartAssign] Cannot process join for ${player.name} - missing eosID/steamID.`);
      return;
    }

    // 1. DOUBLE-JOIN RACE PROTECTION
    if (this._joiningPlayers.has(lockKey)) return;
    this._joiningPlayers.add(lockKey);

    try {
      const playerKey = player.eosID || player.steamID;
      if (!this._sessionJoinTimes.has(playerKey)) {
        this._sessionJoinTimes.set(playerKey, Date.now());
      }

       // ═══════════════════════════════════════════════════════════════════════════
       // CLAN GROUPING: Delegate tag maintenance to S³ ClansService.
       // ═══════════════════════════════════════════════════════════════════════════
       if (this._isClanGroupingEnabled() && player.eosID) {
         const clans = this._s3?.clans;
         const raw = clans.extractRawPrefix(player.name);
         let tag = raw ? (clans.options.caseSensitive ? raw : clans.normalizeTag(raw)) : null;

         if (!tag && this.eloTracker && this.eloTracker.db) {
           this._queryEloDBForTag(player.eosID)
             .then((dbTag) => {
               if (dbTag) {
                 clans._playerTagCache.set(player.eosID, dbTag);
                 Logger.verbose('SmartAssign', 3, `[Clan] Tag resolved from EloTracker DB for ${player.name}: "${dbTag}"`);
               }
             })
             .catch((err) => {
               Logger.verbose('SmartAssign', 3, `[Clan] EloTracker DB fallback failed for ${player.eosID}: ${err?.message}`);
             });
         }

         clans._playerTagCache.set(player.eosID, tag);
       }

       Logger.verbose('SmartAssign', 3, `[JOIN] Player connected: ${player.name} (${playerKey})`);

       // ═══════════════════════════════════════════════════════════════════════════
       // PHASE CHECK: Only block during faction voting (engine-level team change lockout).
       // ═══════════════════════════════════════════════════════════════════════════
       if (this._s3?.gameState?.isEndgameFactionVote?.()) {
         Logger.verbose('SmartAssign', 3, `[Join] S³ gameState: faction vote in progress — skipping assignment for ${player.name}.`);
         return;
       }

       // Check if the current layer/gamemode is ignored (via S³ gameState)
        if (this._s3?.gameState?.isIgnoredMode?.()) {
         Logger.verbose('SmartAssign', 3, `[SmartAssign] Ignored game mode detected. Skipping Elo-based assignment for ${player.name}.`);
         return;
       }

      // Passive mode: skip algorithm and ASSIGNMENT logging entirely
      if (this.options.enableSmartAssign === false) {
        Logger.verbose('SmartAssign', 3, `[SmartAssign] Passive mode: algorithm skipped for ${player.name}.`);
        return;
      }

       // ═══════════════════════════════════════════════════════════════════════════
       // OPTIMIZATION: Mu Pre-Warming + Fast In-Memory Reconnect Lookup
       // ═══════════════════════════════════════════════════════════════════════════

        const phaseStartTime = Date.now();
        const timemarks = {};

        const preWarmStart = Date.now();
        let preWarmRating = { mu: 25.0, roundsPlayed: 0 };
        if (this.eloTracker?.ready) {
          preWarmRating = await this.eloTracker.getRating(player);
        }
        timemarks.preWarmMs = Date.now() - preWarmStart;
        timemarks.preWarmMu = preWarmRating.mu;

        const reconnectTeamStart = Date.now();
        const reconnectRecord = await this._s3?.players?.getReconnect(player.eosID);
        const reconnectTeam = reconnectRecord?.teamID || null;
        timemarks.reconnectTeamMs = Date.now() - reconnectTeamStart;

        const evalStart = Date.now();
        const evalResult = await this.evaluateTeamAssignment(player, reconnectTeam);
       const { targetTeam, reason, debugInfo } = evalResult;
       timemarks.evaluateMs = Date.now() - evalStart;
       timemarks.totalPipelineMs = Date.now() - phaseStartTime;

       const playerTag = debugInfo?.playerTag || 'null';
       const clanTeam = debugInfo?.clanTeam || 'none';

        Logger.verbose('SmartAssign', 3, `[TIMING] ${player.name} join pipeline: tag=${playerTag}, clanTeam=${clanTeam}, mu=${timemarks.preWarmMu?.toFixed(2) ?? 'N/A'} | preWarm=${timemarks.preWarmMs}ms, reconnect=${timemarks.reconnectTeamMs}ms (in-memory), evaluate=${timemarks.evaluateMs}ms, total=${timemarks.totalPipelineMs}ms`);

      if (reconnectTeam && reconnectTeam === targetTeam) {
        Logger.verbose('SmartAssign', 3, `[SmartAssign] Applied reconnect memory for ${player.name} -> Team ${targetTeam} (${reason})`);
      } else if (reconnectTeam && reconnectTeam !== targetTeam) {
        Logger.verbose('SmartAssign', 3, `[SmartAssign] Ignored reconnect memory for ${player.name} (Previous: Team ${reconnectTeam}) -> Team ${targetTeam} (${reason})`);
      } else {
        Logger.verbose('SmartAssign', 3, `[SmartAssign] Evaluated fresh join for ${player.name} -> Team ${targetTeam} (${reason})`);
      }

        // If the player is currently on the wrong team, queue a team change
        if (targetTeam !== null && String(player.teamID) !== String(targetTeam)) {
          this._pendingAssignments[targetTeam]++;
          const pendingPlayerMu = (await getRating(player, this.eloTracker)).mu;
          this._pendingMu[targetTeam] += pendingPlayerMu;

        const isVeteran = preWarmRating.roundsPlayed >= 10;
        if (isVeteran) {
          this._pendingVeterans[targetTeam]++;
        }

        this._pendingPlayerMoves.set(playerKey, { targetTeam, mu: pendingPlayerMu, isVeteran });

        this.executor.queueMove(playerKey, player.name, player.eosID, targetTeam);

        // S³ attribution: record the move so S³'s S3_PLAYER_TEAM_CHANGED fires with source='SmartAssign'
        if (this._s3?.players?.recordMove && playerKey) {
          this._s3?.players.recordMove(playerKey, targetTeam, 'SmartAssign');
        }
      }
    } finally {
      this._joiningPlayers.delete(lockKey);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // S³ PLAYER EVENTS
  // ═══════════════════════════════════════════════════════════════════════════════════

  async onS3PlayerJoined(data) {
    if (!this.ready) return;
    const player = data?.player;
    if (!player) return;
    Logger.verbose('SmartAssign', 3, `[S3] JOIN: ${player.name || player.eosID} team=${player.teamID}`);

    await this.handlePlayerJoin(player);
  }

  async onS3PlayerTeamChanged(data) {
    if (!this.ready) return;
    const { player, previousTeamID, teamID, source } = data || {};
    if (!player) return;
    Logger.verbose('SmartAssign', 3, `[S3] TEAM_CHANGE: ${player.name || player.eosID} ${previousTeamID}→${teamID}, source=${source}`);
    await this.handleTeamChange(player, previousTeamID, teamID, source || 'Manual/Game');
  }

  async onS3PlayerLeft(data) {
    if (!this.ready) return;
    const player = data?.player;
    if (!player) return;
    Logger.verbose('SmartAssign', 3, `[S3] LEAVE: ${player.name || player.eosID}`);
    await this.handlePlayerLeave(player);
  }

  async onS3GameStateLive(data) {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 2, `[S3] GAME_STATE_LIVE: ${data.gamemode} / ${data.layerName}`);

    // Fire ROUND_SNAPSHOT log event (replaces _ensureSnapshot in Stage 4)
    const allPlayers = this._s3?.players?.getAllPlayers() || [];
    const snapshotPlayers = allPlayers.map(p => ({
      name: p.name,
      eosID: p.eosID,
      teamID: p.teamID,
      joinedServerAt: this._sessionJoinTimes.get(p.eosID || p.steamID) || Date.now()
    }));

    this.logEvent('ROUND_SNAPSHOT', null, { players: snapshotPlayers }, false);
    Logger.verbose('SmartAssign', 2, `[Snapshot] Round snapshot captured via S3_GAME_STATE_LIVE with ${snapshotPlayers.length} players.`);
  }

  async handlePlayerLeave(player) {
    this._sessionJoinTimes.delete(player.eosID || player.steamID);

    Logger.verbose('SmartAssign', 3, `[LEAVE] Player disconnected: ${player.name} (${player.steamID}) from Team ${player.teamID}`);
    this.logEvent('LEAVE', player, {}, false);

     // Save to S³ reconnect memory (fire-and-forget) if they were on a valid team
     const tid = Number(player.teamID);
     if ((tid === 1 || tid === 2) && this._s3?.players?.rememberReconnect) {
       this._s3?.players.rememberReconnect(player.eosID, { teamID: tid });
     }
  }

  async handleTeamChange(player, oldTeam, newTeam, source = 'Manual/Game') {
    if (source === 'Smart-Assign') {
      Logger.verbose('SmartAssign', 2, `[TEAM_CHANGE] Player ${player.name} was moved to Team ${newTeam} by SmartAssign`);
    } else if (source === 'Team-Balancer') {
      Logger.verbose('SmartAssign', 2, `[TEAM_CHANGE] Player ${player.name} was scrambled to Team ${newTeam} by Team-Balancer`);
    } else {
      Logger.verbose('SmartAssign', 2, `[TEAM_CHANGE] Player ${player.name} changed from Team ${oldTeam} to Team ${newTeam} (${source})`);
    }
  }

  async _queryEloDBForTag(eosID) {
    try {
      const playerStats = await this.eloTracker.db.getPlayerStats(eosID);

      if (!playerStats || !playerStats.name) {
        Logger.verbose('SmartAssign', 3, `[Clan] No EloTracker record found for eosID ${eosID}`);
        return null;
      }

      const raw = this._s3?.clans?.extractRawPrefix(playerStats.name) || null;
      if (!raw) {
        Logger.verbose('SmartAssign', 3, `[Clan] EloTracker record found for eosID ${eosID}, but no tag extractable from name: "${playerStats.name}"`);
        return null;
      }

      const tag = this._s3?.clans?.options?.caseSensitive
        ? raw
        : this._s3?.clans?.normalizeTag(raw);

      return tag || null;
    } catch (err) {
      Logger.verbose('SmartAssign', 3, `[Clan] EloTracker DB query error for ${eosID}: ${err?.message}`);
      return null;
    }
  }

  evaluateTeamAssignment(player, reconnectTeam = null) {
    return evaluateTeamAssignment(player, this.server, {
      reconnectTeam,
      pendingAssignments: this._pendingAssignments,
      pendingMu: this._pendingMu,
      pendingVeterans: this._pendingVeterans,
      pendingPlayerMoves: this._pendingPlayerMoves,
      eloTracker: this.eloTracker,
      ignoredModes: [],
      playerTagCache: this._isClanGroupingEnabled() ? this._s3?.clans.getPlayerTagCache() : null,
      clanGroupOptions: {
        minSize: this._s3?.clans?.options?.minSize || 2,
        caseSensitive: this._s3?.clans?.options?.caseSensitive || false
      },
      warnFlags: this._warnFlags
    });
  }

  logEvent(eventType, player, extraData = {}, betweenRounds = false) {
    this.eventLogger.logEvent(eventType, player, extraData, betweenRounds, this.server.players);
  }

    async finalizeRoundLog() {
      if (this._isFinalizingRound) {
        Logger.verbose('SmartAssign', 2, '[Finalize] Concurrent finalization blocked — already in progress.');
        return;
      }
       this._isFinalizingRound = true;
        try {
           // Use captured values from onRoundEnded (preferred) or fall back to S³ or Date.now()
           const roundStartTime = this.previousRoundStartTime ?? this._s3?.gameState?.getRoundStartTime?.() ?? Date.now();
           const matchId = this.previousMatchId ?? this._s3?.gameState?.getMatchId?.() ?? null;
           await this.eventLogger.finalizeRoundLog(
             roundStartTime,
             this.previousRoundLayerName || 'Unknown',
             this.previousRoundGamemode || 'Unknown',
             this.options.enableSmartAssign !== false,
             matchId
           );
           // Clear captured values after finalization
           this.previousRoundStartTime = null;
           this.previousMatchId = null;
           this.previousRoundLayerName = null;
           this.previousRoundGamemode = null;
      } finally {
        this._isFinalizingRound = false;
      }
    }

  }