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
 *
 * S³ (Slacker's Squad Services) is the centralised service container
 * for shared state across Slacker's Squad plugins.  It owns the
 * ground truth for server configuration, game-state lifecycle,
 * player state, faction metadata, clan grouping, database access,
 * and cross-plugin event routing.  Consumer plugins discover S³ at
 * runtime via this.server.plugins and access services through flat
 * getters (e.g. this._s3?.gameState) guarded by isReady() checks.
 *
 * GitHub: https://github.com/mikebjoyce/squadjs-slackers-squad-services
 *
 * Consumed Services:
 *   - gameState: getRoundStartTime(), getMatchId(), getLayerName(),
 *               getGamemode(), isIgnoredMode(), isFactionVoteInProgress(),
 *               getRoundSnapshot() — round lifecycle and game-mode detection.
 *   - players:   getAllPlayers(), getReconnect(), recordMove(),
 *               rememberReconnect(), requestRefresh(),
 *               unregisterRefreshInterest() — player state and move tracking.
 *   - clans:     isEnabled(), extractRawPrefix(), normalizeTag(),
 *               getPlayerTagCache() — clan tag grouping lookups.
 *
 * Internal Callbacks (from SASwapExecutor, Stage 6.1a):
 *   - onFailed:  Invoked on RCON switch timeout, preemption, or disconnect.
 *   - onSuccess: Invoked when RCON switch is verified.
 *   - onRetry:   Invoked on each RCON retry attempt.
 *   These replaced server.emit('SMART_ASSIGN_MOVE_*', ...) with direct callback wiring.
 *
 * Listened Events:
 *   - S3_PLAYER_JOINED: Triggers the full join assignment pipeline.
 *   - S3_PLAYER_LEFT:   Triggers disconnect handling and reconnect memory save.
 *   - S3_ROUND_LIVE:    Fires round snapshot with full player roster.
 *   Team change events (S3_PLAYER_TEAM_CHANGED) are no longer listened to
 *   by SA — they are handled by S³ LoggingService for persistence.
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
 * - S³ (SlackersSquadServices) is a required supporting plugin. If it is
 *   absent at mount time, SmartAssign will fail to mount — there is no
 *   fallback path. See README.md for setup instructions.
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
 * logPath: Path for JSONL event logging (default: './smart-assign-log.jsonl').
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
import { evaluateTeamAssignment, getRating, getPenalty, computeScore } from '../utils/sa-team-evaluator.js';

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
        default: './smart-assign-log.jsonl',
        type: 'string'
      },
      enableDatabaseLogging: {
        required: false,
        description: 'If true, mirrors JSONL event data into database tables for querying (default: false).',
        default: false,
        type: 'boolean'
      },
      handshakeWithSwitch: {
        required: false,
        description: 'Enable handshake with Switch queue (requires Switch plugin v2.0.0+). When enabled, SA may optionally swap a joining player with a Switch-queued player to improve balance satisfaction.',
        default: false,
        type: 'boolean'
      },
      handshakeScoreThreshold: {
        required: false,
        description: 'How much worse the swap score can be vs baseline before rejecting (lower = stricter). Only used in eloGated mode.',
        default: 0.5,
        type: 'number'
      },
      handshakeMode: {
        required: false,
        description: 'Handshake mode: "eloGated" (scoring gates the swap) or "queueDrain" (skip scoring, always swap if hard constraints pass).',
        default: 'eloGated',
        type: 'string'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    const dbConnector = (connectors && connectors[options.database]) || null;
    this.db = new SADatabase(dbConnector, {
      enableDatabaseLogging: this.options.enableDatabaseLogging === true
    });
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
      this._joinMutex = Promise.resolve();  // Serializes concurrent join evaluations

       this.eloTracker = null;

       // Handshake with Switch plugin (7.1c — SA-Switch handshake)
       this._switchPlugin = null;       // Discovered at mount, null if absent/incompatible
       this._handshakeEnabled = false;  // Reflects toggle AND plugin availability

       this._warnFlags = { eloNotReadyWarned: false };

      // State bindings
      this.onNewGame = this.onNewGame.bind(this);
      this.onRoundEnded = this.onRoundEnded.bind(this);
      this.onScrambleExecuted = this.onScrambleExecuted.bind(this);
      this.onMoveFailed = this.onMoveFailed.bind(this);
      this.onMoveSuccess = this.onMoveSuccess.bind(this);
      this.onMoveRetry = this.onMoveRetry.bind(this);
      // Wire executor callbacks (Stage 6.1a) — replaces server.emit() round-trip with direct invocation
      this.executor.callbacks = {
        onFailed: this.onMoveFailed,
        onSuccess: this.onMoveSuccess,
        onRetry: this.onMoveRetry
      };
      this.onS3PlayerJoined = this.onS3PlayerJoined.bind(this);
       this.onS3PlayerLeft = this.onS3PlayerLeft.bind(this);
  }

  /**
   * Simple promise-based mutex. Ensures sequential execution of the
   * evaluateTeamAssignment + pending-increment critical section across
   * concurrent handlePlayerJoin invocations. See §7.1f for the full audit.
   * @returns {Promise<Function>} A release function to call when done.
   */
  async _acquireJoinMutex() {
    let release;
    const newPromise = new Promise(resolve => { release = resolve; });
    const prevPromise = this._joinMutex;
    this._joinMutex = newPromise;
    await prevPromise;
    return release;
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

    // S³ runtime discovery — required, no fallback
    const s3 = this.server.plugins.find((p) => p.constructor.name === 'SlackersSquadServices');
    if (!s3) {
      throw new Error('[S3] SlackersSquadServices is required for SmartAssign to function. Ensure it is in config.json before SmartAssign and restart.');
    }
    this._s3 = s3;
    this.executor._s3 = s3;  // Update executor's reference for canAct guard
    Logger.verbose('SmartAssign', 2, '[S3] Discovered SlackersSquadServices for SmartAssign.');

    // ═══════════════════════════════════════════════════════════════
    // SCHEMA MIGRATION: Register SA v2 to drop 4 orphan tables (7.4j)
    // ═══════════════════════════════════════════════════════════════
    try {
      const s3db = this._s3.db;
      if (s3db?.isReady() && s3db.migrationEngine) {
        s3db.registerExpectedVersion('smart-assign', 2);
        s3db.migrationEngine.registerMigrations('smart-assign', [
          {
            version: 2,
            description: 'Drop 4 orphan tables (SmartAssignReconnectMemory, SmartAssignState, SA_RoundSummary, SA_PlayerEvent) — replaced by S³ LoggingService + SA_AssignmentLog.',
            up: async (qi) => {
              for (const table of ['SmartAssignReconnectMemory', 'SmartAssignState', 'SA_RoundSummary', 'SA_PlayerEvent']) {
                await qi.dropTable(table);
              }
            },
            down: async (qi) => {
              await qi.createTable('SmartAssignState', {
                id: { type: qi.DataTypes.INTEGER, primaryKey: true },
                roundStartTime: { type: qi.DataTypes.BIGINT, allowNull: true }
              });
              await qi.createTable('SmartAssignReconnectMemory', {
                steamID: { type: qi.DataTypes.STRING, primaryKey: true },
                teamID: { type: qi.DataTypes.INTEGER },
                disconnectTime: { type: qi.DataTypes.BIGINT }
              });
              await qi.createTable('SA_RoundSummary', {
                id: { type: qi.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
                matchId: { type: qi.DataTypes.STRING, allowNull: true }
              });
              await qi.createTable('SA_PlayerEvent', {
                id: { type: qi.DataTypes.INTEGER, primaryKey: true, autoIncrement: true }
              });
            }
          }
        ]);
        // Re-verify schema versions now that SA has registered, then run the migration
        const recheck = await s3db.verifySchemaVersions();
        if (!recheck.upToDate) {
          Logger.verbose('SmartAssign', 1, `[7.4j] SA has ${recheck.pending.length} pending migration(s) — applying now.`);
          const result = await s3db.migrationEngine.runMigrations('smart-assign');
          Logger.verbose('SmartAssign', 1, `[7.4j] SA v2 migration complete: applied=${result.applied}, skipped=${result.skipped}.`);

          // Re-verify again after migration to confirm up-to-date status
          const postCheck = await s3db.verifySchemaVersions();
          if (!postCheck.upToDate) {
            Logger.verbose('SmartAssign', 1, `[7.4j] WARNING: ${postCheck.pending.length} migration(s) still pending after run.`);
          } else {
            Logger.verbose('SmartAssign', 2, '[7.4j] SA schema is now up to date (v2).');
          }
        } else {
          Logger.verbose('SmartAssign', 2, '[7.4j] SA schema already up to date.');
        }
      } else {
        Logger.verbose('SmartAssign', 1, '[7.4j] S³ DB or migrationEngine not available — skipping migration registration.');
      }
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[7.4j] Migration registration error: ${err.message}`);
    }

    // Switch plugin discovery for handshake integration (7.1c)
    try {
      const switchPlugin = this.server.plugins.find(p => p.constructor.name === 'Switch');
      if (switchPlugin) {
        let pluginVersion = null;
        try {
          pluginVersion = switchPlugin.constructor.version;
        } catch (_) {
          Logger.verbose('SmartAssign', 1, '[Handshake] Switch plugin found but no static version property (pre-2.0). Handshake unavailable.');
        }
        const versionOk = pluginVersion && parseInt(String(pluginVersion).split('.')[0], 10) >= 2;
        if (typeof switchPlugin.getQueueSnapshot === 'function'
            && typeof switchPlugin.forceQueueSwap === 'function'
            && versionOk) {
          this._switchPlugin = switchPlugin;
          this._handshakeEnabled = this.options.handshakeWithSwitch === true;
          Logger.verbose('SmartAssign', 1, `[Handshake] Switch plugin v${pluginVersion} discovered. Handshake ${this._handshakeEnabled ? 'enabled' : 'disabled (toggle off)'}.`);
        } else {
          Logger.verbose('SmartAssign', 1, `[Handshake] Switch plugin found but incompatible version (${pluginVersion || 'unknown'}). Handshake unavailable.`);
        }
      } else {
        Logger.verbose('SmartAssign', 1, '[Handshake] Switch plugin not found. Handshake unavailable.');
      }
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[Handshake] Error discovering Switch plugin: ${err.message}`);
    }

    // Register refresh interest with S³ PlayersService for fast join detection
    const mountPlayers = this._s3?.players;
    if (mountPlayers?.isReady() && mountPlayers.registerRefreshInterest) {
      mountPlayers.registerRefreshInterest('SmartAssign', { maxStalenessMs: 5000 });
      Logger.verbose('SmartAssign', 2, '[S3] Registered SmartAssign refresh interest (maxStalenessMs=5000).');
    }

    // DB maintenance: SA_AssignmentLog is lazily synced on first write.
    // Restart Recovery — delegated to S³ GameStateService
    const gs = this._s3.gameState;
    const recoveredStart = gs?.getRoundStartTime?.();
    if (recoveredStart) {
      Logger.verbose('SmartAssign', 1, `Restart detected. Resuming round from S³ roundStartTime: ${recoveredStart}`);
    } else {
      // New round or no data
      Logger.verbose('SmartAssign', 1, 'New round or no persisted S³ state. Starting fresh.');

      // Flush any leftover assignments from a previous crashed session
      await this.eventLogger.flushAssignmentLog();
    }

      this.server.on('NEW_GAME', this.onNewGame);
      this.server.on('ROUND_ENDED', this.onRoundEnded);
      this.server.on('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);

      // S³ event subscribers (Stage 4 — active assignment path)
      this.server.on('S3_PLAYER_JOINED', this.onS3PlayerJoined);
      this.server.on('S3_PLAYER_LEFT', this.onS3PlayerLeft);
       this.ready = true;
     Logger.verbose('SmartAssign', 1, 'SmartAssign mounted successfully.');
  }

  async unmount() {
    this.ready = false;
    this.eventLogger.cleanup();
    await this.eventLogger.flushAssignmentLog();
    // Unregister S³ refresh interest
    const unmountPlayers = this._s3?.players;
    if (unmountPlayers?.isReady() && unmountPlayers.unregisterRefreshInterest) {
      unmountPlayers.unregisterRefreshInterest('SmartAssign');
    }
     this.server.removeListener('NEW_GAME', this.onNewGame);
     this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
     this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
     this.server.removeListener('S3_PLAYER_JOINED', this.onS3PlayerJoined);
     this.server.removeListener('S3_PLAYER_LEFT', this.onS3PlayerLeft);
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
      Logger.verbose('SmartAssign', 1, 'NEW_GAME detected. Flushing assignment log.');

    await this.eventLogger.flushAssignmentLog();

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

  async handlePlayerJoin(player, reconnectTeam = null) {
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
       // CLAN GROUPING: Compute tag locally for SA's own evaluation.
       // ═══════════════════════════════════════════════════════════════════════════
       // SA computes its own tag from name extraction + optional Elo DB fallback,
       // then merges it into a read-only copy of S³'s playerTagCache for the evaluator.
       // SA no longer writes to S³'s internal _playerTagCache (self-maintained by S³).
       let joinPlayerTag = null;
       if (this._isClanGroupingEnabled() && player.eosID) {
         const clans = this._s3?.clans;
         if (clans?.isReady()) {
           const raw = clans.extractRawPrefix(player.name);
           joinPlayerTag = raw ? (clans.options.caseSensitive ? raw : clans.normalizeTag(raw)) : null;

           if (!joinPlayerTag && this.eloTracker?.db) {
             const dbTag = await this._queryEloDBForTag(player.eosID);
             if (dbTag) {
               joinPlayerTag = dbTag;
               Logger.verbose('SmartAssign', 3, `[Clan] Tag resolved from EloTracker DB for ${player.name}: "${dbTag}"`);
             }
           }
         }
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

        // reconnectTeam sourced from S3_PLAYER_JOINED data.previousTeamID
        // (passed via handlePlayerJoin flow) — no need to call destructive getReconnect().
        timemarks.reconnectTeamMs = 0;

        // ═══════════════════════════════════════════════════════════════════════════
        // PERFORMANCE: Frontload handshake snapshot fetch (fire-and-forget)
        // Kick off getQueueSnapshot() early so it resolves in parallel with
        // evaluateTeamAssignment(). If it doesn't resolve in time, the handshake
        // evaluation falls back to baseline (no swap).
        // ═══════════════════════════════════════════════════════════════════════════
        let handshakeSnapshotPromise = null;
        if (this._handshakeEnabled && this._switchPlugin) {
          try {
            handshakeSnapshotPromise = this._switchPlugin.getQueueSnapshot();
          } catch (_) {
            handshakeSnapshotPromise = null;
          }
        }

        // ═══════════════════════════════════════════════════════════════════════════
        // MUTEX: Serialize concurrent join evaluations to prevent team overshoot.
        // Join concurrency bug (7.1f): overlapping evaluateTeamAssignment() calls
        // both see stale _pendingAssignments and may route to the same team.
        // The mutex ensures only one evaluation runs at a time, so the next in line
        // sees the updated pending state from the previous evaluation.
        // ═══════════════════════════════════════════════════════════════════════════
        const release = await this._acquireJoinMutex();
        try {
          const evalStart = Date.now();
          const evalResult = await this.evaluateTeamAssignment(player, reconnectTeam, joinPlayerTag);
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

          // ═══════════════════════════════════════════════════════════════════════════
          // HANDSHAKE EVALUATION (7.1c): Check if a swap with Switch queue improves balance
          // ═══════════════════════════════════════════════════════════════════════════
          let finalTargetTeam = targetTeam;
          let handshakeActive = false;
          let handshakeSwitchPlayerEosID = null;

          if (this._handshakeEnabled && this._switchPlugin && targetTeam !== null && handshakeSnapshotPromise) {
            try {
              const hsResult = await this._evaluateHandshakeSwap(player, evalResult, handshakeSnapshotPromise);
              if (hsResult.shouldOverride) {
                finalTargetTeam = hsResult.joiningPlayerTargetTeam;
                handshakeSwitchPlayerEosID = hsResult.switchPlayerEosID;
                handshakeActive = true;
                Logger.verbose('SmartAssign', 2, `[Handshake] Swap approved for ${player.name}: joining → Team ${finalTargetTeam}, switch player ${hsResult.switchPlayerName}. Reason: ${hsResult.reason}`);
              } else {
                Logger.verbose('SmartAssign', 3, `[Handshake] No swap for ${player.name}: ${hsResult.reason}`);
              }
            } catch (hsErr) {
              Logger.verbose('SmartAssign', 2, `[Handshake] Evaluation error for ${player.name}: ${hsErr.message}. Falling back to baseline.`);
            }
          }

          // If the player is currently on the wrong team, queue a team change
          if (finalTargetTeam !== null && String(player.teamID) !== String(finalTargetTeam)) {
            this._pendingAssignments[finalTargetTeam]++;
            const pendingPlayerMu = (await getRating(player, this.eloTracker)).mu;
            this._pendingMu[finalTargetTeam] += pendingPlayerMu;

            const isVeteran = preWarmRating.roundsPlayed >= 10;
            if (isVeteran) {
              this._pendingVeterans[finalTargetTeam]++;
            }

            this._pendingPlayerMoves.set(playerKey, { targetTeam: finalTargetTeam, mu: pendingPlayerMu, isVeteran });

            this.executor.queueMove(playerKey, player.name, player.eosID, finalTargetTeam);

            // S³ attribution: record the move so S³'s S3_PLAYER_TEAM_CHANGED fires with source='SmartAssign'
            const recordPlayers = this._s3?.players;
            if (recordPlayers?.isReady() && recordPlayers.recordMove && playerKey) {
              recordPlayers.recordMove(playerKey, finalTargetTeam, 'SmartAssign');
            }

            // ═══════════════════════════════════════════════════════════════════════════
            // HANDSHAKE EXECUTION: After queueing joining player's move, tell Switch to
            // force-swap the Switch-queued player. Switch's forceQueueSwap() removes the
            // player from its queue and runs the solo-switch pipeline (RCON, cooldown,
            // messaging, attribution). If returns false (player already consumed/cancelled/
            // disconnected), the joining player's move was already queued — no rollback needed.
            // ═══════════════════════════════════════════════════════════════════════════
            if (handshakeActive && handshakeSwitchPlayerEosID && this._switchPlugin) {
              try {
                const swapResult = await this._switchPlugin.forceQueueSwap(handshakeSwitchPlayerEosID);
                if (swapResult) {
                  Logger.verbose('SmartAssign', 2, `[Handshake] Switch player consumed via forceQueueSwap successfully.`);
                } else {
                  Logger.verbose('SmartAssign', 2, `[Handshake] forceQueueSwap returned false (player already gone). Joining player move still queued.`);
                }
              } catch (fqsErr) {
                Logger.verbose('SmartAssign', 2, `[Handshake] forceQueueSwap error: ${fqsErr.message}. Joining player move is unaffected.`);
              }
            }
          }
        } finally {
          release();
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
    const previousTeamID = data?.previousTeamID ?? null;
    Logger.verbose('SmartAssign', 3, `[S3] JOIN: ${player.name || player.eosID} team=${player.teamID}, previousTeamID=${previousTeamID}`);

    await this.handlePlayerJoin(player, previousTeamID);
  }

  async onS3PlayerLeft(data) {
    if (!this.ready) return;
    const player = data?.player;
    if (!player) return;
    Logger.verbose('SmartAssign', 3, `[S3] LEAVE: ${player.name || player.eosID}`);
    await this.handlePlayerLeave(player);
  }

  async handlePlayerLeave(player) {
    this._sessionJoinTimes.delete(player.eosID || player.steamID);

    Logger.verbose('SmartAssign', 3, `[LEAVE] Player disconnected: ${player.name} (${player.steamID}) from Team ${player.teamID}`);

    // Generic LEAVE logging removed (Stage 7.4i) — S³ LoggingService handles
    // via S3_PLAYER_LEFT. SA only logs assignment-specific events.

     // Save to S³ reconnect memory (fire-and-forget) if they were on a valid team
     const tid = Number(player.teamID);
     if (tid === 1 || tid === 2) {
       const reconnectPlayers = this._s3?.players;
       if (reconnectPlayers?.isReady() && reconnectPlayers.rememberReconnect) {
         reconnectPlayers.rememberReconnect(player.eosID, { teamID: tid });
       }
     }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // HANDSHAKE EVALUATION (7.1c)
  // ═══════════════════════════════════════════════════════════════════════════════════

  /**
   * Evaluates whether a swap with a Switch-queued player would produce a better
   * team balance outcome than the baseline assignment. Uses the decision matrix
   * finalized in 7.1g: single-head FIFO candidate, F1-F6 filters, composite-only
   * scoring comparison with threshold.
   *
   * Called inside the mutex, after evaluateTeamAssignment returns. The snapshot
   * promise is fire-and-forget from earlier in the pipeline — by the time this
   * runs, it should already be resolved.
   *
   * @param {object} player - The joining player
   * @param {object} baselineResult - { targetTeam, reason, baselineScore }
   * @param {Promise|null} snapshotPromise - Resolves to Switch's getQueueSnapshot()
   * @returns {Promise<object>} { shouldOverride, joiningPlayerTargetTeam, switchPlayerEosID, switchPlayerName, reason }
   */
  async _evaluateHandshakeSwap(player, baselineResult, snapshotPromise) {
    // Preconditions:
    // P1: handshakeWithSwitch toggle — checked before call via _handshakeEnabled
    // P2: _switchPlugin available — checked before call
    // P3: baseline has a valid target
    if (baselineResult.targetTeam === null) {
      return { shouldOverride: false, reason: 'P3: baseline targetTeam is null' };
    }
    // P4: Don't override reconnect priority or clan grouping
    const skipReasons = ['Reconnect Memory (Priority)', 'Clan Grouping'];
    if (skipReasons.some(r => baselineResult.reason && baselineResult.reason.startsWith(r))) {
      Logger.verbose('SmartAssign', 3, `[Handshake] Skipped for ${player.name}: baseline reason is "${baselineResult.reason}".`);
      return { shouldOverride: false, reason: `P4: baseline is ${baselineResult.reason}` };
    }

    // Get the queue snapshot (should already be resolved from frontloading)
    let snapshot;
    try {
      snapshot = await snapshotPromise;
    } catch (err) {
      Logger.verbose('SmartAssign', 2, `[Handshake] Snapshot fetch failed for ${player.name}: ${err.message}`);
      return { shouldOverride: false, reason: 'Snapshot fetch failed' };
    }
    if (!snapshot) {
      return { shouldOverride: false, reason: 'No snapshot available' };
    }

    // Determine relevant sub-queue
    const baselineTarget = baselineResult.targetTeam;
    // If baseline wants T1, look in t2ToT1 (players on T2 wanting T1)
    // If baseline wants T2, look in t1ToT2 (players on T1 wanting T2)
    const relevantQueue = baselineTarget === 1 ? snapshot.t2ToT1 : snapshot.t1ToT2;

    // F1: Sub-queue must have a head
    if (!relevantQueue || relevantQueue.length === 0) {
      return { shouldOverride: false, reason: 'F1: relevant sub-queue empty' };
    }

    // Single head only — strict FIFO
    const candidate = relevantQueue[0];

    // F2: Candidate must exist in S³ player list
    const allPlayers = this._s3?.players?.getAllPlayers?.() || [];
    const livePlayer = allPlayers.find(p => p.eosID === candidate.eosID);
    if (!livePlayer) {
      return { shouldOverride: false, reason: `F2: candidate ${candidate.playerName} not in S³ players` };
    }

    // F3: Candidate's live teamID must match queued currentTeamID
    if (String(livePlayer.teamID) !== String(candidate.currentTeamID)) {
      return { shouldOverride: false, reason: `F3: ${candidate.playerName} team changed externally (live=${livePlayer.teamID}, queued=${candidate.currentTeamID})` };
    }

    // F4: Candidate must NOT be in _joiningPlayers (mid-rejoin)
    if (this._joiningPlayers.has(candidate.eosID)) {
      return { shouldOverride: false, reason: `F4: ${candidate.playerName} is mid-rejoin` };
    }

    // --- Virtual constraint checks (F5-F6) ---
    // Collect current per-team data from server.players
    const pending = this._pendingAssignments;
    let t1Count = pending[1] || 0;
    let t2Count = pending[2] || 0;
    let t1MuSum = this._pendingMu[1] || 0;
    let t2MuSum = this._pendingMu[2] || 0;
    let t1Vets = this._pendingVeterans[1] || 0;
    let t2Vets = this._pendingVeterans[2] || 0;
    const t1Mus = [];
    const t2Mus = [];
    let hasElo = !!(this.eloTracker?.ready);

    for (const p of this.server.players) {
      if (!p || p.eosID === player.eosID || p.eosID === candidate.eosID) continue;
      if (this._pendingPlayerMoves.has(p.steamID || p.eosID)) continue;
      const tid = String(p.teamID);
      if (tid === '1') {
        t1Count++;
        if (hasElo) {
          const r = await getRating(p, this.eloTracker);
          t1MuSum += r.mu;
          t1Mus.push(r.mu);
          if (r.roundsPlayed >= 10) t1Vets++;
        }
      } else if (tid === '2') {
        t2Count++;
        if (hasElo) {
          const r = await getRating(p, this.eloTracker);
          t2MuSum += r.mu;
          t2Mus.push(r.mu);
          if (r.roundsPlayed >= 10) t2Vets++;
        }
      }
    }

    // Virtual snapshot: Swap candidate → targetTeamID, joining player → candidate's currentTeamID
    const virtualT1Count = t1Count;
    const virtualT2Count = t2Count;
    const candidateTarget = Number(candidate.targetTeamID);
    const candidateCurrent = Number(candidate.currentTeamID);
    const joiningTarget = baselineTarget; // SA wants to send joining player here
    // Virtual: candidate moves FROM candidateCurrent TO candidateTarget
    // Virtual: joining player moves TO candidateCurrent (vacated spot)

    // Build virtual counts
    let virtT1Count, virtT2Count, virtT1MuSum, virtT2MuSum, virtT1Vets, virtT2Vets;
    let virtT1Mus, virtT2Mus;

    // Start with actual counts (excluding candidate and joining player)
    // Then add them in their virtual positions
    let baseT1Count = t1Count;
    let baseT2Count = t2Count;
    let baseT1MuSum = t1MuSum;
    let baseT2MuSum = t2MuSum;
    let baseT1Vets = t1Vets;
    let baseT2Vets = t2Vets;
    let baseT1Mus = [...t1Mus];
    let baseT2Mus = [...t2Mus];

    // Add candidate data (their current team count)
    const candidateRating = await getRating({ eosID: candidate.eosID, steamID: candidate.steamID }, this.eloTracker);
    const candidateIsVet = candidateRating.roundsPlayed >= 10;

    // Add joining player data
    const joinPlayerRating = await getRating(player, this.eloTracker);
    const joinPlayerIsVet = joinPlayerRating.roundsPlayed >= 10;

    // Build virtual: candidate moves to targetTeamID, joining player takes vacated spot
    // Initialize virtual state = base state + joining player on their chosen baseline team
    virtT1Count = baseT1Count;
    virtT2Count = baseT2Count;
    virtT1MuSum = baseT1MuSum;
    virtT2MuSum = baseT2MuSum;
    virtT1Vets = baseT1Vets;
    virtT2Vets = baseT2Vets;
    virtT1Mus = [...baseT1Mus];
    virtT2Mus = [...baseT2Mus];

    // Add joining player to their baseline target team
    if (joiningTarget === 1) {
      virtT1Count++;
      virtT1MuSum += joinPlayerRating.mu;
      virtT1Mus.push(joinPlayerRating.mu);
      if (joinPlayerIsVet) virtT1Vets++;
    } else {
      virtT2Count++;
      virtT2MuSum += joinPlayerRating.mu;
      virtT2Mus.push(joinPlayerRating.mu);
      if (joinPlayerIsVet) virtT2Vets++;
    }

    // F5: Graduated population cap check on virtual state
    const virtTotalPop = virtT1Count + virtT2Count;
    let virtMaxImbalance;
    if (virtTotalPop >= 96) virtMaxImbalance = 1;
    else if (virtTotalPop >= 90) virtMaxImbalance = 2;
    else if (virtTotalPop >= 82) virtMaxImbalance = 3;
    else virtMaxImbalance = 4;

    const diff = Math.abs(virtT1Count - virtT2Count);
    if (diff > virtMaxImbalance) {
      return { shouldOverride: false, reason: `F5: virtual pop cap violation (diff=${diff}, max=${virtMaxImbalance})` };
    }

    // F6: Neither team exceeds physical server cap in virtual snapshot
    const maxTeamSize = this?._s3?.serverConfig?.isReady()
      ? Math.floor(this._s3.serverConfig.getMaxPlayers() / 2)
      : 50;
    if (virtT1Count > maxTeamSize || virtT2Count > maxTeamSize) {
      return { shouldOverride: false, reason: `F6: virtual team exceeds cap (maxTeamSize=${maxTeamSize}, T1=${virtT1Count}, T2=${virtT2Count})` };
    }

    // Mode: queueDrain → skip scoring, always swap
    const handshakeMode = this.options.handshakeMode || 'eloGated';
    if (handshakeMode === 'queueDrain') {
      Logger.verbose('SmartAssign', 2, `[Handshake] queueDrain mode: swap approved for ${candidate.playerName} (hard constraints passed).`);
      return {
        shouldOverride: true,
        joiningPlayerTargetTeam: candidateCurrent,
        switchPlayerEosID: candidate.eosID,
        switchPlayerName: candidate.playerName,
        reason: 'handshake_swap_queueDrain'
      };
    }

    // eloGated mode: compute virtual score
    if (!hasElo) {
      // No Elo data — can't do scoring comparison. queueDrain mode would have caught this.
      // Fall back to baseline.
      return { shouldOverride: false, reason: 'No Elo data for scoring comparison' };
    }

    // Compute scores using exported computeScore
    // Baseline score: the score for the baseline placement
    const baselineScore = baselineResult.baselineScore;

    // Virtual score: compute on the virtual state where:
    // - candidate moved to their targetTeamID
    // - joining player moved to candidateCurrent
    // This means we need the state AFTER both moves
    
    // The virtual state for scoring: we need Mu arrays reflecting both moves.
    // Starting from base state (neither candidate nor joining player):
    // - Move candidate → candidateTarget
    // - Move joining player → candidateCurrent
    
    let scoreT1Mus, scoreT2Mus, scoreT1Vets, scoreT2Vets, scoreT1Count, scoreT2Count;

    // Start fresh: base state (neither player)
    scoreT1Count = baseT1Count;
    scoreT2Count = baseT2Count;
    scoreT1MuSum = baseT1MuSum;
    scoreT2MuSum = baseT2MuSum;
    scoreT1Vets = baseT1Vets;
    scoreT2Vets = baseT2Vets;
    scoreT1Mus = [...baseT1Mus];
    scoreT2Mus = [...baseT2Mus];

    // Add candidate to their TARGET team
    if (candidateTarget === 1) {
      scoreT1Count++;
      scoreT1MuSum += candidateRating.mu;
      scoreT1Mus.push(candidateRating.mu);
      if (candidateIsVet) scoreT1Vets++;
    } else {
      scoreT2Count++;
      scoreT2MuSum += candidateRating.mu;
      scoreT2Mus.push(candidateRating.mu);
      if (candidateIsVet) scoreT2Vets++;
    }

    // Add joining player to candidate's CURRENT team (the vacated spot)
    if (candidateCurrent === 1) {
      scoreT1Count++;
      scoreT1MuSum += joinPlayerRating.mu;
      scoreT1Mus.push(joinPlayerRating.mu);
      if (joinPlayerIsVet) scoreT1Vets++;
    } else {
      scoreT2Count++;
      scoreT2MuSum += joinPlayerRating.mu;
      scoreT2Mus.push(joinPlayerRating.mu);
      if (joinPlayerIsVet) scoreT2Vets++;
    }

    const virtualScore = computeScore(scoreT1Mus, scoreT2Mus, scoreT1Vets, scoreT2Vets, scoreT1Count, scoreT2Count);
    const threshold = this.options.handshakeScoreThreshold || 0.5;

    Logger.verbose('SmartAssign', 2, `[Handshake] ${player.name}: baselineScore=${baselineScore.toFixed(2)}, virtualScore=${virtualScore.toFixed(2)}, threshold=${threshold}`);

    if (virtualScore <= baselineScore + threshold) {
      return {
        shouldOverride: true,
        joiningPlayerTargetTeam: candidateCurrent,
        switchPlayerEosID: candidate.eosID,
        switchPlayerName: candidate.playerName,
        reason: `handshake_swap_eloGated (base=${baselineScore.toFixed(2)}, virt=${virtualScore.toFixed(2)})`
      };
    }

    return { shouldOverride: false, reason: `Scoring threshold not met (base=${baselineScore.toFixed(2)}, virt=${virtualScore.toFixed(2)}, threshold=${threshold})` };
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

  evaluateTeamAssignment(player, reconnectTeam = null, localTag = null) {
    let tagCache = null;
    if (this._isClanGroupingEnabled() && this._s3?.clans) {
      tagCache = this._s3.clans.getPlayerTagCache() || new Map();
      if (localTag && player.eosID) {
        tagCache.set(player.eosID, localTag);
      }
    }
    return evaluateTeamAssignment(player, this.server, {
      reconnectTeam,
      pendingAssignments: this._pendingAssignments,
      pendingMu: this._pendingMu,
      pendingVeterans: this._pendingVeterans,
      pendingPlayerMoves: this._pendingPlayerMoves,
      eloTracker: this.eloTracker,
      ignoredModes: [],
      playerTagCache: tagCache,
      clanGroupOptions: {
        minSize: this._s3?.clans?.options?.minSize || 2,
        caseSensitive: this._s3?.clans?.options?.caseSensitive || false
      },
      warnFlags: this._warnFlags,
      maxTeamSize: this?._s3?.serverConfig?.isReady()
        ? Math.floor(this._s3.serverConfig.getMaxPlayers() / 2)
        : 50
    });
  }

  logEvent(eventType, player, extraData = {}, betweenRounds = false) {
    // Inject round context (matchId, roundStartTime, layerName, gamemode)
    // so each assignment event is self-contained with S³ context.
    const gs = this._s3?.gameState;
    extraData.matchId = extraData.matchId ?? gs?.getMatchId?.() ?? null;
    extraData.roundStartTime = extraData.roundStartTime ?? gs?.getRoundStartTime?.() ?? null;
    extraData.layerName = extraData.layerName ?? gs?.getLayerName?.() ?? null;
    extraData.gamemode = extraData.gamemode ?? gs?.getGamemode?.() ?? null;

    this.eventLogger.logEvent(eventType, player, extraData, betweenRounds, this.server.players);
  }

    async flushAssignmentLog() {
      if (this._isFinalizingRound) {
        Logger.verbose('SmartAssign', 2, '[Flush] Concurrent flush blocked — already in progress.');
        return;
      }
       this._isFinalizingRound = true;
        try {
           // Provide round context to event logger for metadata enrichment
           const roundStartTime = this.previousRoundStartTime ?? this._s3?.gameState?.getRoundStartTime?.() ?? Date.now();
           const matchId = this.previousMatchId ?? this._s3?.gameState?.getMatchId?.() ?? null;
           await this.eventLogger.flushAssignmentLog();
           // Clear captured values after flush
           this.previousRoundStartTime = null;
           this.previousMatchId = null;
           this.previousRoundLayerName = null;
           this.previousRoundGamemode = null;
      } finally {
        this._isFinalizingRound = false;
      }
    }

  }