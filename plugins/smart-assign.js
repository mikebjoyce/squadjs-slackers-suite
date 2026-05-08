/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  SMART ASSIGN PLUGIN v0.3.0                   ║
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
 *   Extends BasePlugin. Key methods:
 *     mount()                          — Initializes DB and lifecycle listeners.
 *     unmount()                        — Removes listeners and cleans up executor.
 *     evaluateTeamAssignment(player)    — Core algorithm for team placement.
 *     logEvent(type, player, data)      — Records lifecycle events to JSONL.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * SADatabase (../utils/sa-database.js)
 *   Sequelize-based persistence layer supporting any SQL database
 *   (SQLite, MySQL, PostgreSQL, etc.) for reconnect memory and round state.
 * SASwapExecutor (../utils/sa-swap-executor.js)
 *   Manages the RCON move queue using "One-Hit & Verify" logic for fast,
 *   bounce-loop-free team switches. Verified swaps typically complete in <2s.
 * EloTracker (Sibling Plugin)
 *   Provides live TrueSkill Mu ratings for skill-based balancing.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Join swaps use Log-Driven triggering: the SteamID arrives from the Log Parser
 *   (~100ms after join), so the RCON command fires before RCON even knows the
 *   player exists. SASwapExecutor's forced post-command poll then verifies the result.
 * - Disconnect detection is delta-diff only (no PLAYER_DISCONNECTED listener) because
 *   that event is unreliable in current Squad/SquadJS. Every forced join refresh also
 *   speeds up disconnect detection for all other players as a side-effect.
 * - Algorithm uses a Mu-based Unified Scoring System:
 *     1. Hard Pop Cap: Prevents imbalance beyond dynamic thresholds.
 *     2. Physical Server Cap: Hard limit (50 players per team).
 *     3. Reconnect Priority: Hot-path reconnect memory lives in-memory (_reconnectMemory Map) for synchronous lookups. If the player has a reconnect record and the pop cap allows it, they're sent to their previous team immediately (before Elo scoring). On disconnect, the Map is updated synchronously and the DB is written async (fire-and-forget) for crash recovery.
 *     4. Clan Grouping: If a player is in a clan and ALL clan mates are on one team, route the player there (provided pop cap allows). Uses lightweight _playerTagCache for fast tag lookups.
 *     5. Elo Balancing: Weights the average skill gap (3.0x) against a dynamically scaled sum gap (1.5x) to handle diverse pop states.
 *     6. Reconnect Bias: If reconnect priority is blocked by the cap, applies a minor score reduction (0.25) toward the previous team to tip near-ties.
 *     7. Reconnect Bonus: Grants an *additional* +2 player imbalance allowance on top of the base for returning players.
 * - Strict 1-player max imbalance enforced at high population (94+).
 * - Bypasses auto-assignment completely during specified ignored modes (Seed/Jensen).
 * - Accuracy: Players with pending moves are excluded from team evaluation to prevent double-counting.
 * - Passive Mode: Set enableSmartAssign: false to observe only real server events (JOIN, LEAVE,
 *   TEAM_CHANGE). The algorithm does not run and no ASSIGNMENT events are logged.
 *
 * ─── CONFIGURATION ───────────────────────────────────────────────
 *
 * database: Sequelize connector name (default: 'sqlite').
 * logPath: Path for JSONL event logging (default: './auto-assign-log.jsonl').
 * enableSmartAssign: Toggle auto-assignment logic (default: true).
 * enableEventLogging: Toggle JSONL event logging (default: true).
 * ignoredGameModes: Array of modes to skip logic on (default: ['Seed', 'Jensen']).
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Logger from '../../core/logger.js';
import BasePlugin from './base-plugin.js';
import SADatabase from '../utils/sa-database.js';
import SASwapExecutor from '../utils/sa-swap-executor.js';
import SAEventLogger from '../utils/sa-event-logger.js';
import { evaluateTeamAssignment, getMu } from '../utils/sa-team-evaluator.js';
import { buildPlayerTagCache, extractRawPrefix } from '../utils/sa-clan-grouper.js';

const MAX_TEAM_SIZE = 50;

export default class SmartAssign extends BasePlugin {
  static version = '0.3.0';

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
      ignoredGameModes: {
        required: false,
        description: 'Substrings for layer/gamemode names where SmartAssign should not alter teams.',
        default: ['Seed', 'Jensen'],
        type: 'array'
      },
      enableClanGrouping: {
        required: false,
        description: 'If true, players in clans will be kept together on the same team if all clan mates are on one team.',
        default: true,
        type: 'boolean'
      },
      clanGroupMinSize: {
        required: false,
        description: 'Minimum number of players to consider a group as a clan (default: 2).',
        default: 2,
        type: 'number'
      },
      clanGroupCaseSensitive: {
        required: false,
        description: 'If false, clan tags are case-insensitive and diacritics/gamer-character lookalikes are normalized (default: false).',
        default: false,
        type: 'boolean'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.db = new SADatabase(server, options, connectors);
    this.executor = new SASwapExecutor(server, {
      retryIntervalMs: 50,
      maxCompletionTimeMs: 3000
    });
    this.eventLogger = new SAEventLogger(options);

    this.knownPlayers = new Map();
    this._joiningPlayers = new Set();
    this._sessionJoinTimes = new Map();
    this._snapshotTaken = false;
     this.phase = 'active'; // 'active' | 'game_end' | 'resolving'
                              // NOTE: 'resolving' is an internal staging sub-state (null-teamID window after NEW_GAME).
                              // It represents early staging before teams stabilize, and is layered atop the reference's
                              // 'active' phase. The two externally-observable phases are 'active' (includes staging + live)
                              // and 'game_end' (maps to 'between_rounds' in the dev reference).
     this.currentLayerName = null;
     this.currentGamemode = null;
     this.previousRoundLayerName = null;  // Captured at ROUND_ENDED for reliable finalization
     this.previousRoundGamemode = null;   // Captured at ROUND_ENDED for reliable finalization
    this._pendingAssignments = { 1: 0, 2: 0 };
    this._pendingMu = { 1: 0, 2: 0 };
    this._pendingPlayerMoves = new Map();
    this.currentRoundStartTime = null;
    this.ready = false;
    this.initialSyncComplete = false;
    this._isFinalizingRound = false;

    // ═══════════════════════════════════════════════════════════════════════════
    // OPTIMIZATION: Debounced Forced RCON Poll
    //
    // Purpose: Prevent burst joins from triggering multiple overlapping updatePlayerList() calls.
    //          Instead, coalesce rapid joins into a single poll with a 250ms debounce window.
    //
    // Impact: When 5–10 players join within 200ms (common post-round rush), we fire one poll
    //         instead of 5–10, while still maintaining the full side-effect benefit (disconnect
    //         detection speedup) and the primary benefit (fresh data for executor verification).
    // ═══════════════════════════════════════════════════════════════════════════
     this._pendingPlayerListUpdate = null;

     // ═══════════════════════════════════════════════════════════════════════════
     // OPTIMIZATION: In-Memory Reconnect Memory Map
     // 
     // Purpose: Replace the synchronous await-on-DB bottleneck for reconnect lookups
     //          with a fast in-memory Map that reads from player history.
     // 
     // Architecture:
     //   - Stored in-memory during the round (_reconnectMemory Map)
     //   - Written to DB asynchronously (fire-and-forget) on disconnect
     //   - Synced back from DB on crash recovery via getAllReconnectMemory()
     //   - Cleared on NEW_GAME alongside DB clear
     // 
     // Impact: The join-swap pipeline no longer awaits a DB read. The only I/O
     //         on join is now evaluateTeamAssignment() + queueMove(), both synchronous.
     // ═══════════════════════════════════════════════════════════════════════════
     this._reconnectMemory = new Map();

       this.eloTracker = null;

       // ═══════════════════════════════════════════════════════════════════════════
       // WARN FLAGS: Persistent object for passing by reference
       //
       // Purpose: Allow evaluateTeamAssignment() and getMu() to mutate warning
       //          flags that persist across calls, so warnings fire only once per session.
       //
       // Why needed: Flags need to be passed by reference into pure functions so
       //           mutations persist in plugin state. This allows warnings to fire
       //           only once per session instead of on every player join.
       // ═══════════════════════════════════════════════════════════════════════════
       this._warnFlags = { eloNotReadyWarned: false };

      // ═══════════════════════════════════════════════════════════════════════════
      // CLAN GROUPING: Player Tag Cache
     //
     // Purpose: Maintain a lightweight per-player tag cache for fast clan lookup.
     //          Built once per round at snapshot time, updated incrementally on joins/leaves.
     //
     // Architecture:
     //   - Stored in-memory during the round (_playerTagCache Map)
     //   - Maps eosID -> normalized clan tag (or null)
     //   - Used at join time to identify clan mates
     //   - Rebuilt at snapshot time alongside team resolution
     //   - Cleared on NEW_GAME alongside other round state
     //
     // Impact: Reduces per-join computation cost by caching tag extraction results.
     // ═══════════════════════════════════════════════════════════════════════════
     this._playerTagCache = new Map();

    // ═══════════════════════════════════════════════════════════════════════════
    // JOIN/LEAVE TIMING CORRECTION
    //
    // Purpose: Track when JOINs occur so that LEAVEs discovered during JOIN-triggered
    //          RCON polls can be backdated to appear before the JOIN in event logs.
    //          This corrects the temporal mismatch where late LEAVE detection makes
    //          a LEAVE appear to occur after a JOIN that happened after the leave.
    // ═══════════════════════════════════════════════════════════════════════════
    this._currentJoinTimestamp = null;  // Timestamp of the most recent join event

     // State bindings
     this.onNewGame = this.onNewGame.bind(this);
     this.onRoundEnded = this.onRoundEnded.bind(this);
     this.onUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
     this.onUpdatedLayerInfo = this.onUpdatedLayerInfo.bind(this);
     this.onPlayerConnected = this.onPlayerConnected.bind(this);
     this.onScrambleExecuted = this.onScrambleExecuted.bind(this);
     this.onMoveFailed = this.onMoveFailed.bind(this);
     this.onMoveSuccess = this.onMoveSuccess.bind(this);
     this.onMoveRetry = this.onMoveRetry.bind(this);
  }

  async mount() {
    await super.mount();
    Logger.verbose('SmartAssign', 1, 'Mounting SmartAssign plugin.');

    this.eloTracker = this.server.plugins.find((p) => p.constructor.name === 'EloTracker') || null;
    if (this.eloTracker && typeof this.eloTracker.getMu !== 'function') {
      Logger.verbose('SmartAssign', 1, '[SmartAssign] Warning: EloTracker found but getMu() is missing. Falling back to population-only/internal-props.');
    }

    this._ignoredModes = (this.options.ignoredGameModes || ['seed', 'jensen']).map(m => String(m).toLowerCase());

    // Initialize DB
    const { roundStartTime: persistedStartTime } = await this.db.initDB();

    // Perform initial DB cleanup and start periodic maintenance
    await this.db.cleanupOldData();
    this.cleanupInterval = setInterval(() => {
      this.db.cleanupOldData();
    }, 6 * 60 * 60 * 1000);

    // Check for restart recovery
    let serverRoundStart = this.server.matchStartTime ? this.server.matchStartTime.getTime() : null;
    if (!serverRoundStart && this.server.layerHistory && this.server.layerHistory.length > 0) {
      serverRoundStart = this.server.layerHistory[0].time.getTime();
    }

    const threeHours = 3 * 60 * 60 * 1000;
    if (
      persistedStartTime &&
      (!serverRoundStart ||
      Math.abs(Number(persistedStartTime) - Number(serverRoundStart)) < threeHours)
    ) {
      // It's a resume.
      Logger.verbose(
        'SmartAssign',
        1,
        'Restart detected. Resuming round state.'
      );
       this.currentRoundStartTime = Number(persistedStartTime);
       this._snapshotTaken = true; // Assume snapshot exists in temp log
       
       // ─ CRASH RECOVERY: Hydrate in-memory reconnect memory from DB
      // On crash recovery, we resume the same round, so the reconnect memory
      // that was persisted to the DB during the crashed session is still valid.
      // Load it into memory to avoid awaiting DB reads during subsequent joins.
      this._reconnectMemory = await this.db.getAllReconnectMemory();
      Logger.verbose('SmartAssign', 1, `Hydrated ${this._reconnectMemory.size} reconnect records on restart.`);
    } else {
      // New round or no data
      Logger.verbose('SmartAssign', 1, 'New round or no persisted state. Starting fresh.');

      // Finalize any leftover temp logs from a previous crashed session
      await this.finalizeRoundLog();

      await this.db.clearReconnectMemory();
      const now = serverRoundStart || Date.now();
      await this.db.saveRoundStartTime(now);
      this.currentRoundStartTime = now;
      this._snapshotTaken = false;
    }

    this.server.on('NEW_GAME', this.onNewGame);
    this.server.on('ROUND_ENDED', this.onRoundEnded);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
    this.server.on('UPDATED_LAYER_INFORMATION', this.onUpdatedLayerInfo);
    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
    this.server.on('SMART_ASSIGN_MOVE_FAILED', this.onMoveFailed);
    this.server.on('SMART_ASSIGN_MOVE_SUCCESS', this.onMoveSuccess);
    this.server.on('SMART_ASSIGN_MOVE_RETRY', this.onMoveRetry);

    this.ready = true;
    Logger.verbose('SmartAssign', 1, 'SmartAssign mounted successfully.');
  }

  async unmount() {
    this.ready = false;
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this._pendingPlayerListUpdate) clearTimeout(this._pendingPlayerListUpdate);
    this.eventLogger.cleanup();
    await this.finalizeRoundLog();
    this.server.removeListener('NEW_GAME', this.onNewGame);
    this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
    this.server.removeListener('UPDATED_LAYER_INFORMATION', this.onUpdatedLayerInfo);
    this.server.removeListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
    this.server.removeListener('SMART_ASSIGN_MOVE_FAILED', this.onMoveFailed);
    this.server.removeListener('SMART_ASSIGN_MOVE_SUCCESS', this.onMoveSuccess);
    this.server.removeListener('SMART_ASSIGN_MOVE_RETRY', this.onMoveRetry);
    this._pendingPlayerMoves.clear();
    this.executor.cleanup();
    Logger.verbose('SmartAssign', 1, 'SmartAssign unmounted.');
     await super.unmount();
   }

   /**
    * PRIVATE: Debounced forced player list update.
    * 
    * Debounces rapid consecutive calls into a single 250ms-delayed updatePlayerList() poll.
    * If another call arrives within the 250ms window, the timer resets (standard debounce).
    * 
    * Scheduled from onPlayerConnected to refresh RCON state after a join event fires,
    * providing fresh data for SASwapExecutor's post-command verification step.
    */
   _schedulePlayerListUpdate() {
     if (this._pendingPlayerListUpdate) {
       clearTimeout(this._pendingPlayerListUpdate);
     }
     Logger.verbose('SmartAssign', 3, '[Debounce] Scheduled/rescheduled player list update for 250ms window.');
     this._pendingPlayerListUpdate = setTimeout(async () => {
       this._pendingPlayerListUpdate = null;
       try {
         await this.server.updatePlayerList();
       } catch (err) {
         Logger.verbose('SmartAssign', 1, `[SmartAssign] Debounced player list update failed: ${err.message}`);
       }
     }, 250);
   }

    // ═══════════════════════════════════════════════════════════════════════════════════
    // EVENT: NEW_GAME (Round Start)
    //
    // Fired when a new map loads and staging begins (NOT after staging completes).
  // Primary responsibilities:
  //   1. Finalize the previous round's log BEFORE updating startTime (Bug 3 fix)
  //   2. Clear all per-round state (known players, pending assignments, etc.)
  //   3. Set phase to 'resolving' to wait for 100% team resolution before snapshot
  //   4. Prepare for snapshot once RCON stabilizes
  // ═══════════════════════════════════════════════════════════════════════════════════
  async onNewGame(info) {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 1, 'NEW_GAME detected. Finalizing previous round log with current startTime.');

    // CRITICAL TIMING: Finalize the previous round's log BEFORE updating currentRoundStartTime.
    // This ensures the finalized JSONL line captures the previous round's correct startTime.
    // After finalization completes, we then update currentRoundStartTime for the new round.
    // (Bug 3 fix: was using server.matchStartTime which predates finalization)
    await this.finalizeRoundLog();

     // Restart the logger's batch flush timer after finalization
     this.eventLogger._startBatchFlushTimer();

    // Clear any pending debounced player list update
    if (this._pendingPlayerListUpdate) {
      clearTimeout(this._pendingPlayerListUpdate);
      this._pendingPlayerListUpdate = null;
    }

    await this.db.clearReconnectMemory();
    const now = Date.now();
    await this.db.saveRoundStartTime(now);
    this.currentRoundStartTime = now;
    this._snapshotTaken = false;

    // Clear known players so anyone connecting gets processed normally.
    // NOTE: _sessionJoinTimes is explicitly NOT cleared here. It is designed 
    // to persist across rounds to accurately track total server session length.
    this.knownPlayers.clear();
    this._joiningPlayers.clear();
    this.initialSyncComplete = false;
    this._pendingAssignments[1] = 0;
    this._pendingAssignments[2] = 0;
    this._pendingMu[1] = 0;
    this._pendingMu[2] = 0;
    this._pendingPlayerMoves.clear();
    
    // Clear in-memory reconnect memory alongside DB clear (synchronized in onNewGame above)
    // This ensures the new round starts fresh with no reconnect history.
    this._reconnectMemory.clear();
    
    // Clear player tag cache so it gets rebuilt at snapshot time
    this._playerTagCache.clear();
    
    // ═════════════════════════════════════════════════════════════════════════════════════
    // RESOLVING PHASE: Set phase to wait for 100% team resolution before enabling assignment.
    //
    // NEW_GAME fires at the START of staging, not after staging ends. At this point, RCON
    // briefly contains players with teamID=null as teams are being re-established (~30 seconds max).
    // 
    // By setting phase = 'resolving', we suppress all assignment decisions until every player
    // has a real team (1 or 2). Once 100% are resolved, we take the snapshot and switch to 'active'.
    // This prevents the null-teamID window from causing population count inaccuracies.
    //
    // The between-rounds phase (game_end) ends here, and we transition to resolving, ensuring
    // the snapshot captures the new round's correct layer name and stable player state.
    // ═════════════════════════════════════════════════════════════════════════════════════
    this.phase = 'resolving';
    Logger.verbose('SmartAssign', 2, '[Phase] NEW_GAME: switched to resolving phase. Waiting for 100% team resolution before snapshot and active phase.');
    
    // Reset layer name cache so snapshot captures the new round's layer
    this.currentLayerName = null;
    this.currentGamemode = null;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // EVENT: ROUND_ENDED (Round Finalization)
  //
  // Fired when the round ends (before map change, before staging phase).
  // Primary responsibilities:
  //   1. Clear snapshot flag to discard any unfired pending snapshot
  //   2. Set phase to 'game_end' to suppress player events during map transition
  // ═══════════════════════════════════════════════════════════════════════════════════
  async onRoundEnded(info) {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 1, 'ROUND_ENDED detected. End-game window started.');
    
    this._snapshotTaken = false;
    
    // ═════════════════════════════════════════════════════════════════════════════════════
    // CAPTURE LAYER IDENTITY FOR FINALIZATION
    //
    // CRITICAL FIX: Save the current round's layer identity NOW, at ROUND_ENDED time,
    // BEFORE NEW_GAME fires and clears the cache. This ensures that when finalizeRoundLog()
    // is called from onNewGame(), we have the ENDING round's layer name, not the NEW round's.
    //
    // Timeline:
    //   1. ROUND_ENDED fires → capture layer identity → store in previousRound* variables
    //   2. NEW_GAME fires → clear currentLayerName cache → call finalizeRoundLog()
    //   3. finalizeRoundLog() uses previousRound* (captured at step 1) for the log
    //   4. UPDATED_LAYER_INFORMATION populates currentLayerName with NEW round's layer
    //
    // This timing fix prevents the race condition where layer data was null/Unknown.
    // ═════════════════════════════════════════════════════════════════════════════════════
    this.previousRoundLayerName = this.currentLayerName;
    this.previousRoundGamemode = this.currentGamemode;
    Logger.verbose('SmartAssign', 2, `[Layer] Captured layer at ROUND_ENDED: ${this.previousRoundLayerName || 'Unknown'} (${this.previousRoundGamemode || 'Unknown'})`);
    
    // ═════════════════════════════════════════════════════════════════════════════════════
    // GAME_END PHASE: Set phase to suppress player assignments.
    //
    // When ROUND_ENDED fires, the round has just ended in-game. However, several things
    // still happen before the next round actually starts (NEW_GAME):
    //   1. Map change and layer loading begins
    //   2. Server enters staging phase (Scoreboard/Voting screens)
    //   3. Map fully loads with new gamemode
    //   4. NEW_GAME finally fires, transitioning to staging (true round start)
    //
    // During this window, players may join/leave while the server finishes loading the
    // new map and layer name changes. Any joins/leaves in this period are part of the
    // previous round's finalization, NOT part of the new round yet. By setting phase
    // to 'game_end' here, we ensure:
    //   - _ensureSnapshot() guards itself and doesn't take a premature snapshot with the new layer name
    //   - Events are marked with betweenRounds=true for proper historical attribution
    // 
    // CRITICAL: We do NOT finalize the round log here. Instead, we let between-rounds events
    // accumulate into currentRoundEvents alongside any remaining round events. The finalization
    // happens in onNewGame() BEFORE updating currentRoundStartTime, ensuring the previous
    // round's JSONL line captures the correct startTime and includes all between-rounds events.
    // ═════════════════════════════════════════════════════════════════════════════════════
    this.phase = 'game_end';
    Logger.verbose('SmartAssign', 2, '[Phase] ROUND_ENDED: switched to game_end phase to suppress assignments during end-game.');
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // EVENT: UPDATED_LAYER_INFORMATION (Layer/Gamemode Sync)
  //
  // Fired independently of UPDATED_PLAYER_INFORMATION when the layer/gamemode data changes.
  // This listener maintains currentLayerName and currentGamemode as the source of truth,
  // separate from player information polling cycles.
  //
  // Primary responsibilities:
  //   1. Track the current layer name as the reliable, independently-updated source
  //   2. Guard against reading stale layer data during game_end phase
  //   3. Ensure snapshot and finalization use the correct cached layer identity
  // ═══════════════════════════════════════════════════════════════════════════════════
   async onUpdatedLayerInfo() {
     if (!this.ready) return;
     const name = this.server.currentLayer?.name || null;
     const mode = this.server.currentLayer?.gamemode || null;
     
     // Cache the layer identity from the RCON polling system (UPDATED_LAYER_INFORMATION).
     // This is preferred over the log-parsed LAYER_CHANGED event because RCON polling is
     // the authoritative source of truth per the dev reference (§2.5, §5).
     // 
     // Only update if we have real data and are NOT in game_end phase.
     // Layer updates ARE intentionally allowed during 'resolving' phase so the new round's
     // layer name can be captured from UPDATED_LAYER_INFORMATION polling.
     // (Stale layer data only occurs during game_end; 'resolving' needs fresh layer identity for snapshot.)
     if (name && this.phase !== 'game_end') {
       this.currentLayerName = name;
       this.currentGamemode = mode;
       Logger.verbose('SmartAssign', 3, `[Layer] Updated layer cache: ${name} (${mode})`);
     }
     
     // ═════════════════════════════════════════════════════════════════════════════════════
     // RESTART RECOVERY BACKFILL: Recover layer name during mid-round restart scenarios
     //
     // When the server restarts mid-round during RCON recovery, this sequence can occur:
     //   1. Server restarts → SquadJS reconnects, plugin mounts
     //   2. server.currentLayer is null during RCON recovery
     //   3. ROUND_ENDED fires while layer data is still unavailable
     //   4. onRoundEnded captures previousRoundLayerName = null (because currentLayerName is null)
     //   5. UPDATED_LAYER_INFORMATION now arrives with real layer data (recovery complete)
     //   6. NEW_GAME fires → finalizeRoundLog() uses previousRoundLayerName (still null) → writes 'Unknown'
     //
     // This backfill catches step 5: if we're in game_end phase (after ROUND_ENDED) and 
     // previousRoundLayerName is still null (layer wasn't available when ROUND_ENDED fired),
     // we now populate it with the freshly-arrived layer data so finalizeRoundLog() gets
     // the correct layer name instead of 'Unknown'.
     // ═════════════════════════════════════════════════════════════════════════════════════
     if (name && this.phase === 'game_end' && !this.previousRoundLayerName) {
       this.previousRoundLayerName = name;
       this.previousRoundGamemode = mode;
       Logger.verbose('SmartAssign', 2, `[Layer] Backfilled previousRoundLayerName during recovery: ${name} (${mode})`);
     }
   }

  async onScrambleExecuted() {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 1, 'TeamBalancer Scramble detected. Marking team changes as Team-Balancer source for the next 20 seconds.');
    this.scrambleEndTime = Date.now() + 20000;
  }

  async onMoveFailed(data) {
    if (!this.ready) return;
    const { steamID, reason } = data;

    if (this._pendingPlayerMoves.has(steamID)) {
      const move = this._pendingPlayerMoves.get(steamID);
      this._pendingAssignments[move.targetTeam] = Math.max(0, this._pendingAssignments[move.targetTeam] - 1);
      this._pendingMu[move.targetTeam] = Math.max(0, this._pendingMu[move.targetTeam] - move.mu);
      this._pendingPlayerMoves.delete(steamID);
    }

    const p = this.server.players.find((x) => x.steamID === steamID) || { steamID, name: 'Unknown' };
    Logger.verbose('SmartAssign', 1, `[SmartAssign] Abandoned move for ${p.name} (${steamID}) - ${reason}`);
    this.logEvent('MOVE_FAILED', p, { reason }, this.phase !== 'active');
  }

  async onMoveSuccess(data) {
    if (!this.ready) return;
    const { steamID, teamID } = data;

    if (this._pendingPlayerMoves.has(steamID)) {
      const move = this._pendingPlayerMoves.get(steamID);
      this._pendingAssignments[move.targetTeam] = Math.max(0, this._pendingAssignments[move.targetTeam] - 1);
      this._pendingMu[move.targetTeam] = Math.max(0, this._pendingMu[move.targetTeam] - move.mu);
      this._pendingPlayerMoves.delete(steamID);
    }

    const p = this.server.players.find((x) => x.steamID === steamID);
    if (p) {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Verified move success for ${p.name} (${steamID}) to Team ${teamID}`);
      this.logEvent('MOVE_SUCCESS', p, { teamID }, this.phase !== 'active');
    }
  }

  async onMoveRetry(data) {
    if (!this.ready) return;
    const { steamID, attempt, method } = data;
    const p = this.server.players.find((x) => x.steamID === steamID);
    if (p) {
      Logger.verbose('SmartAssign', 3, `[SmartAssign] Retrying move for ${p.name} (${steamID}) | Attempt: ${attempt} | Method: ${method}`);
      this.logEvent('MOVE_RETRY', p, { attempt, method }, this.phase !== 'active');
    }
  }

  async onPlayerConnected(info) {
    if (!this.ready) return;
    const p = info.player;
    if (!p || !p.steamID) return;

    /**
     * DESIGN DECISION: Debounced Forced Join Refresh
     *
     * Intentionally NOT awaited. The move is queued immediately below using the
     * SteamID from the Log Parser event (before RCON even knows the player exists).
     * This background poll's real job is to provide fresh data for SASwapExecutor's
     * post-command verification step: after the RCON move command lands, the executor
     * calls updatePlayerList() again to confirm the player is on the correct team.
     *
     * Side-effect: every forced refresh also reveals other players who have left the
     * server since the last 30s poll cycle, effectively speeding up disconnect detection
     * for everyone on the server whenever anyone joins.
     *
     * OPTIMIZATION: The poll is debounced with a 250ms window to coalesce burst joins
     * (5-10 players within 200ms) into a single poll instead of many overlapping calls.
     * This preserves all benefits while reducing RCON load during post-round rushes.
     *
     * JOIN/LEAVE TIMING: Track this join timestamp so that any LEAVEs discovered in the
     * subsequent RCON poll can be backdated to appear before this JOIN in the event log.
     */
    this._currentJoinTimestamp = Date.now();
    this._schedulePlayerListUpdate();

    // Trigger join handling immediately using the log-provided player data.
    // The executor will fire the RCON move before the player is even visible
    // in the ListPlayers array — the debounced poll above will catch up shortly after.
    if (!this.knownPlayers.has(p.steamID)) {
      await this.handlePlayerJoin(p);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════════════
  // EVENT: UPDATED_PLAYER_INFORMATION (Player Data Sync)
  //
  // Fired periodically (roughly every 30s in Squad) as RCON pushes updated player lists.
  // Primary responsibilities:
  //   1. Check resolving phase: wait for 100% team resolution before snapshot
  //   2. Detect and handle player joins/leaves via delta-diff
  //   3. Detect and attribute team changes
  //   4. Early map change detection via snapshot lock
  // ═══════════════════════════════════════════════════════════════════════════════════
   async onUpdatedPlayerInfo(info) {
     if (!this.ready) return;
     
     // ═════════════════════════════════════════════════════════════════════════════════════
     // DEBOUNCE CANCELLATION: Clear pending player list update
     //
     // Design Rationale:
     // onPlayerConnected schedules a debounced updatePlayerList() to coalesce burst joins.
     // However, UPDATED_PLAYER_INFORMATION firing means the natural ~30s RCON polling cycle
     // has already called updatePlayerList() and provided fresh data. The scheduled debounce
     // timer (if still pending) is now redundant and should be cancelled to avoid wasting RCON calls.
     //
     // Safety: This is a no-op optimization:
     //   - If debounce hasn't fired yet: we cancel it (saves a redundant RCON call)
     //   - If debounce already fired: _pendingPlayerListUpdate is null (no-op)
     //   - If debounce fires *after* this check due to timing: it fires the call (natural polling was slow)
     //
     // Independent Path: SASwapExecutor's post-command verification is NOT dependent on this
     // debounce — it calls updatePlayerList() directly in processRetries() within its own
     // state-locked verification loop. This debounce is purely a join-detection optimization.
     // ═════════════════════════════════════════════════════════════════════════════════════
     if (this._pendingPlayerListUpdate) {
       clearTimeout(this._pendingPlayerListUpdate);
       this._pendingPlayerListUpdate = null;
       Logger.verbose('SmartAssign', 3, '[Debounce] Cancelled pending player list update — UPDATED_PLAYER_INFORMATION cycle already refreshed data.');
     }
     
     // ═════════════════════════════════════════════════════════════════════════════════════
     // RESOLVING PHASE: Wait for 100% team resolution before enabling assignment

    //
    // When phase is 'resolving' (set by NEW_GAME), we wait until every player has a real
    // teamID (1 or 2, not null). This prevents the null-teamID window (~30s after NEW_GAME)
    // from causing population count inaccuracies that would result in mis-assignments.
    //
    // Once 100% of players are resolved:
    //   1. Take the snapshot (captures stable player state)
    //   2. Switch phase to 'active' (resume normal assignments)
    //   3. Return to let next tick process any pending joins/leaves
    //
    // If not all resolved yet, suppress all join/leave/team-change processing and return early.
    // ═════════════════════════════════════════════════════════════════════════════════════
    if (this.phase === 'resolving') {
      const players = this.server.players;
      const allResolved = players.length > 0 && players.every(p => p.teamID === 1 || p.teamID === 2);
      if (allResolved) {
        Logger.verbose('SmartAssign', 2, `[Phase] All ${players.length} players resolved. Taking snapshot, switching to active.`);
        this.phase = 'active';
        await this._ensureSnapshot();
      } else {
        const nullCount = players.filter(p => p.teamID !== 1 && p.teamID !== 2).length;
        Logger.verbose('SmartAssign', 4, `[Phase] Resolving: ${nullCount}/${players.length} players still have null teamID. Waiting.`);
        return; // Don't process any join/leave/team-change events yet
      }
      return; // snapshot just fired — let next tick do the change-monitoring
    }

    // Catch early map change (only if snapshot already taken or no pending snapshot)
    await this._ensureSnapshot();

    if (!this.initialSyncComplete) {
      // SAFE-SYNC HANDSHAKE:
      // On the first update tick after plugin mount, knownPlayers is populated 
      // from the current server state without triggering any moves or assignments.
      //
      // CRITICAL: After NEW_GAME fires, the first UPDATED_PLAYER_INFORMATION tick 
      // often contains stale RCON data where many players have teamID=null. 
      // To avoid storing null teamIDs (which cause ghost null→X TEAM_CHANGE events),
      // we defer marking initialSyncComplete until at least one player has a real team.
      // This allows the first tick to populate knownPlayers with all players (including 
      // those with null), but prevents change-monitoring from starting until RCON is stable.
      
      let hasRealTeams = false;
      
      for (const p of this.server.players) {
        if (p.steamID) {
          this.knownPlayers.set(p.steamID, {
            steamID: p.steamID,
            name: p.name,
            teamID: p.teamID,
            squadID: p.squadID
          });
          if (!this._sessionJoinTimes.has(p.steamID)) {
            this._sessionJoinTimes.set(p.steamID, Date.now());
          }
          // Check if this player has a real team (1 or 2, not null)
          if (p.teamID === 1 || p.teamID === 2) {
            hasRealTeams = true;
          }
        }
      }
      
      // Only mark safe-sync complete when we've confirmed RCON has real team data
      if (hasRealTeams) {
        this.initialSyncComplete = true;
        Logger.verbose('SmartAssign', 1, `Safe-Sync handshake complete. Known players: ${this.knownPlayers.size}. Monitoring for changes.`);
      } else {
        Logger.verbose('SmartAssign', 3, `Safe-Sync deferred: RCON data not yet stable (players without real teams). Will retry next tick.`);
      }
      return;
    }

    /**
     * DESIGN NOTE: Omission of PLAYER_DISCONNECTED listener
     * In modern versions of Squad/SquadJS, the PLAYER_DISCONNECTED log parsing is entirely broken 
     * and fails to fire reliably. To prevent memory leaks and ensure disconnects are always caught, 
     * leaves are inferred strictly by delta-diffing the UPDATED_PLAYER_INFORMATION array.
     * 
     * Note: Forced Join Updates (see onPlayerConnected) also have the side-effect of 
     * speeding up disconnect detection by forcing the RCON player list to refresh.
     * 
     * DESIGN NOTE: Squad's Native Team Assignment and Null-TeamID Window
     * While Squad normally assigns players to Team 1 or Team 2 natively upon joining, there IS
     * a brief window (~30 seconds) after NEW_GAME fires where RCON temporarily reports teamID=null
     * for all players as teams are being re-established. This is not an 'unassigned' state but rather
     * a transient RCON synchronization delay. The phase='resolving' state waits for 100% real team
     * resolution before proceeding with the active round. After resolution, all players have either
     * teamID=1 or teamID=2, and only explicit team changes between these two states need to be tracked.
     */

    // Create a quick lookup set for current steamIDs to detect leaves efficiently
    const currentSteamIDs = new Set(this.server.players.map(p => p.steamID).filter(Boolean));
    const batchPromises = [];

    // Check for JOINS and TEAM CHANGES directly against the server array
    for (const p of this.server.players) {
      if (!p.steamID) continue;

      if (!this.knownPlayers.has(p.steamID) && !this._joiningPlayers.has(p.steamID)) {
        batchPromises.push(this.handlePlayerJoin(p));
      } else {
        const kp = this.knownPlayers.get(p.steamID);
        if (String(kp.teamID) !== String(p.teamID)) {
          // NULL-GUARD: Skip firing TEAM_CHANGE events if either old or new teamID is null.
          // kp.teamID === null: Safe-sync captured initial null state; team is now resolving (not a real change).
          // p.teamID === null: Team being cleared at round end (transient state before suppression kicks in).
          // In both cases, silently update tracked state without firing an event.
          if (kp.teamID === null || kp.teamID === undefined || p.teamID === null || p.teamID === undefined) {
            kp.teamID = p.teamID; // Silent state update only
          } else {
            let source = 'Manual/Game';
            
            // Smart-Assign moves take precedence over the Scramble Window to prevent mis-attribution
            // if an auto-assigned reconnect happens to land exactly during a Team-Balancer scramble event.
            if (this.executor.isRecentSmartAssignMove(p.steamID, p.teamID)) {
              source = 'Smart-Assign';
            } else if (this.scrambleEndTime && Date.now() < this.scrambleEndTime) {
              source = 'Team-Balancer';
            }

            const oldTeamID = kp.teamID;
            kp.teamID = p.teamID;
            batchPromises.push(this.handleTeamChange(p, oldTeamID, p.teamID, source));
          }
        }
        if (String(kp.squadID) !== String(p.squadID)) {
          kp.squadID = p.squadID;
        }
        if (kp.name !== p.name) {
          kp.name = p.name;
        }
      }
    }

    // Check for LEAVES
    for (const [steamID, kp] of this.knownPlayers.entries()) {
      if (!currentSteamIDs.has(steamID)) {
        // Delete from map FIRST to prevent re-entrancy loops if UPDATED_PLAYER_INFORMATION
        // fires again while handlePlayerLeave is awaiting the DB write.
        this.knownPlayers.delete(steamID);
        batchPromises.push(this.handlePlayerLeave(kp));
      }
    }

    if (batchPromises.length > 0) {
      await Promise.all(
        batchPromises.map(p => p.catch(err => {
          Logger.verbose('SmartAssign', 1, `[Batch] Handler error: ${err?.message}`);
        }))
      );
    }
  }

  async handlePlayerJoin(player) {
    // 1. DOUBLE-JOIN RACE PROTECTION
    // Since PLAYER_CONNECTED and UPDATED_PLAYER_INFORMATION both trigger joins,
    // a synchronous set check is used before any await as a write-lock.
    if (this._joiningPlayers.has(player.steamID)) return;
    this._joiningPlayers.add(player.steamID);

    try {
      // Register to known players
      this.knownPlayers.set(player.steamID, {
        steamID: player.steamID,
        name: player.name,
        teamID: player.teamID,
        squadID: player.squadID
      });

      if (!this._sessionJoinTimes.has(player.steamID)) {
        this._sessionJoinTimes.set(player.steamID, Date.now());
      }

       // ═══════════════════════════════════════════════════════════════════════════
       // CLAN GROUPING: Incrementally update player tag cache on join
       //
       // The tag cache is built once per round at snapshot time. However, players
       // joining after snapshot also need tags in the cache so clan grouping can work.
       // This incremental update ensures late joiners are clan-groupable.
       //
       // TAG RESOLUTION PRIORITY:
       //   1. Live name (from log parser) — may have tag if resolved early
       //   2. EloTracker DB (historical name) — for returning players with tag from last round
       //   3. null — new player or no tag found (falls back to Elo/pop routing)
       // ═══════════════════════════════════════════════════════════════════════════
       if (this.options.enableClanGrouping && player.eosID) {
         // Try extraction from live name first
         const raw = extractRawPrefix(player.name);
         let tag = raw ? (this.options.clanGroupCaseSensitive ? raw : raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()) : null;
         
         // If no tag found in live name and EloTracker is available, query DB as fallback
         if (!tag && this.eloTracker && this.eloTracker.db) {
           this._queryEloDBForTag(player.eosID)
             .then((dbTag) => {
               if (dbTag) {
                 this._playerTagCache.set(player.eosID, dbTag);
                 Logger.verbose('SmartAssign', 3, `[Clan] Tag resolved from EloTracker DB for ${player.name}: "${dbTag}"`);
               }
             })
             .catch((err) => {
               Logger.verbose('SmartAssign', 3, `[Clan] EloTracker DB fallback failed for ${player.eosID}: ${err?.message}`);
             });
         }
         
         // Set cache immediately with live result (or null if no fallback pending)
         this._playerTagCache.set(player.eosID, tag);
       }

       Logger.verbose('SmartAssign', 3, `[JOIN] Player connected: ${player.name} (${player.steamID})`);
       this.logEvent('JOIN', player, {}, this.phase !== 'active');

       // ═══════════════════════════════════════════════════════════════════════════
       // PHASE CHECK: Skip assignment if not in active phase
       //
       // During game_end (end-of-round) and resolving (NEW_GAME waiting for 100% team resolution)
       // phases, skip all assignment decisions and let Squad's native assignment handle joins.
       // This prevents:
       //   - End-of-round joins being assigned after round is over
       //   - Early-round joins during null-teamID window causing population miscounts
       //
       // Assignment resumes only when phase is 'active'.
       // ═══════════════════════════════════════════════════════════════════════════
       if (this.phase !== 'active') {
         Logger.verbose('SmartAssign', 3, `[Join] Phase is '${this.phase}' — skipping assignment for ${player.name}.`);
         return;
       }

       // Check if the current layer/gamemode is ignored
       const currentLayerName = this.server.currentLayer && this.server.currentLayer.name ? String(this.server.currentLayer.name).toLowerCase() : '';
       const currentGamemode = this.server.currentLayer && this.server.currentLayer.gamemode ? String(this.server.currentLayer.gamemode).toLowerCase() : '';

       const isIgnored = this._ignoredModes.some(m => currentLayerName.includes(m) || currentGamemode.includes(m));

       if (isIgnored) {
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
        // 
        // The joining player's Mu is fetched BEFORE the critical sync section.
        // This ensures that all getMu() calls during evaluation are cache hits (instant).
        // Reconnect lookup and assignment evaluation remain synchronous to prevent
        // concurrent-join race conditions on _pendingAssignments.
        // ═══════════════════════════════════════════════════════════════════════════

        const phaseStartTime = Date.now();
        const timemarks = {};

        // Pre-warm the joining player's Mu into EloTracker cache (cache miss = 1–5ms DB lookup)
        const preWarmStart = Date.now();
        if (this.eloTracker?.ready) {
          await this.eloTracker.getMu(player);
        }
        timemarks.preWarmMs = Date.now() - preWarmStart;

        // Read reconnect memory synchronously from Map
        const reconnectTeamStart = Date.now();
        const reconnectTeam = this._reconnectMemory.get(player.steamID) || null;
        timemarks.reconnectTeamMs = Date.now() - reconnectTeamStart;

        // 2. STALE-STATE BATCHING PROTECTION
        // JS single-threaded guarantee: once reconnect memory lookup resolves (synchronously),
        // execution runs synchronously through evaluate + increment before yielding again.
        // Concurrent joins are safe because no await exists between reconnect lookup and increment.
        const evalStart = Date.now();
        const evalResult = await this.evaluateTeamAssignment(player, reconnectTeam);
       const { targetTeam, reason, debugInfo } = evalResult;
       timemarks.evaluateMs = Date.now() - evalStart;
       timemarks.totalPipelineMs = Date.now() - phaseStartTime;

       // Extract clan debug info
       const playerTag = debugInfo?.playerTag || 'null';
       const clanTeam = debugInfo?.clanTeam || 'none';

        // Log timing details with clan info at verbosity 3 for detailed performance monitoring
        Logger.verbose('SmartAssign', 3, `[TIMING] ${player.name} join pipeline: tag=${playerTag}, clanTeam=${clanTeam} | preWarm=${timemarks.preWarmMs}ms, reconnect=${timemarks.reconnectTeamMs}ms (in-memory), evaluate=${timemarks.evaluateMs}ms, total=${timemarks.totalPipelineMs}ms`);

      if (reconnectTeam && reconnectTeam === targetTeam) {
        Logger.verbose('SmartAssign', 3, `[SmartAssign] Applied reconnect memory for ${player.name} -> Team ${targetTeam} (${reason})`);
      } else if (reconnectTeam && reconnectTeam !== targetTeam) {
        Logger.verbose('SmartAssign', 3, `[SmartAssign] Ignored reconnect memory for ${player.name} (Previous: Team ${reconnectTeam}) -> Team ${targetTeam} (${reason})`);
      } else {
        Logger.verbose('SmartAssign', 3, `[SmartAssign] Evaluated fresh join for ${player.name} -> Team ${targetTeam} (${reason})`);
      }

      // Log assignment decision
      this.logEvent('ASSIGNMENT', player, {
        targetTeam,
        reason,
        reconnectTeam,
        executed: true
      }, this.phase !== 'active');

        // If the player is currently on the wrong team, queue a team change
        if (targetTeam !== null && String(player.teamID) !== String(targetTeam)) {
          this._pendingAssignments[targetTeam]++;
          const pendingPlayerMu = await getMu(player, this.eloTracker);
          this._pendingMu[targetTeam] += pendingPlayerMu;
        
        // NOTE: pendingPlayerMu is captured here and subtracted onMoveSuccess. If the player's 
        // Elo changes during the brief execution window, _pendingMu may drift slightly.
        // This is a known, low-impact approximation that resets naturally on NEW_GAME.
        this._pendingPlayerMoves.set(player.steamID, { targetTeam, mu: pendingPlayerMu });

        /**
         * ARCHITECTURE: Log-Driven Join Swap
         * We queue the move immediately using the SteamID from the Log Parser event,
         * firing the RCON command blind before the player is visible in ListPlayers.
         * SASwapExecutor sends the command once, then force-polls to verify the result.
         * No retry spam, no bounce loops. See sa-swap-executor.js for the full design.
         */
        this.executor.queueMove(player.steamID, targetTeam);
      }
    } finally {
      this._joiningPlayers.delete(player.steamID);
    }
  }

  async handlePlayerLeave(player) {
    // Synchronously delete session data to prevent memory leaks if awaits below throw or stall.
    this._sessionJoinTimes.delete(player.steamID);

    Logger.verbose('SmartAssign', 3, `[LEAVE] Player disconnected: ${player.name} (${player.steamID}) from Team ${player.teamID}`);
    this.logEvent('LEAVE', player, {}, this.phase !== 'active');
    
    // Remove from clan tag cache
    if (player.eosID && this._playerTagCache.has(player.eosID)) {
      this._playerTagCache.delete(player.eosID);
    }
    
     // Save to reconnect memory if they were on a valid team
     const tid = Number(player.teamID);
     if (tid === 1 || tid === 2) {
       // ─ OPTIMIZATION: Write to both in-memory Map and DB
       // In-memory write is immediate (synchronous), providing fast lookups on rejoin.
       // DB write is awaited to ensure ordering: the LEAVE event is logged before this
       // function returns, guaranteeing the database reflects the disconnect before the
       // next UPDATED_PLAYER_INFORMATION cycle. This prevents race conditions where a 
       // rejoining player finds stale/missing reconnect records.
       this._reconnectMemory.set(player.steamID, tid);
       await this.db.savePlayerDisconnect(player.steamID, tid);
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
    this.logEvent('TEAM_CHANGE', player, { oldTeam, newTeam, source }, this.phase !== 'active');
  }

  /**
   * Asynchronously queries the EloTracker database for a player's historical name.
   * Extracts and normalizes the clan tag from the stored name.
   * 
   * Purpose: Provide a fallback tag source for clan grouping when the live name
   *          hasn't resolved yet (late tag arrival). For returning players with
   *          previous round records, their tag-resolved name is already in the DB.
   * 
   * @param {string} eosID - Player's EOS ID
   * @returns {Promise<string|null>} Normalized tag or null if not found/no tag
   */
  async _queryEloDBForTag(eosID) {
    try {
      const playerStats = await this.eloTracker.db.getPlayerStats(eosID);
      
      if (!playerStats || !playerStats.name) {
        Logger.verbose('SmartAssign', 3, `[Clan] No EloTracker record found for eosID ${eosID}`);
        return null;
      }

      const raw = extractRawPrefix(playerStats.name);
      if (!raw) {
        Logger.verbose('SmartAssign', 3, `[Clan] EloTracker record found for eosID ${eosID}, but no tag extractable from name: "${playerStats.name}"`);
        return null;
      }

      // Apply the same normalization as live name path
      const tag = this.options.clanGroupCaseSensitive
        ? raw
        : raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      
      return tag || null;
    } catch (err) {
      Logger.verbose('SmartAssign', 3, `[Clan] EloTracker DB query error for ${eosID}: ${err?.message}`);
      return null;
    }
  }

  /**
   * Delegates to SATeamEvaluator pure function.
   * Wraps the context object and calls the extracted evaluator.
   * 
   * CRITICAL: Passes this._warnFlags by reference so mutations in evaluateTeamAssignment()
   * and getMu() persist across calls. This allows warning flags to fire only once per session,
   * not on every player join.
   */
  evaluateTeamAssignment(player, reconnectTeam = null) {
    return evaluateTeamAssignment(player, this.server, {
      reconnectTeam,
      pendingAssignments: this._pendingAssignments,
      pendingMu: this._pendingMu,
      pendingPlayerMoves: this._pendingPlayerMoves,
      eloTracker: this.eloTracker,
      ignoredModes: this._ignoredModes,
      playerTagCache: this.options.enableClanGrouping ? this._playerTagCache : null,
      clanGroupOptions: {
        minSize: this.options.clanGroupMinSize || 2,
        caseSensitive: this.options.clanGroupCaseSensitive || false
      },
      warnFlags: this._warnFlags
    });
  }

  /**
   * Delegates to SAEventLogger and SATeamEvaluator.
   */
  logEvent(eventType, player, extraData = {}, betweenRounds = false) {
    this.eventLogger.logEvent(eventType, player, extraData, betweenRounds, this.server.players);
  }

    /**
     * Delegates to SAEventLogger with concurrency guard.
     * Prevents concurrent finalization calls from reading/writing the same temp log file.
     * 
     * CRITICAL FIX: Uses previousRoundLayerName/previousRoundGamemode, NOT currentLayerName.
     * These are captured at ROUND_ENDED, ensuring they reflect the ENDING round's layer identity,
     * not the NEW round's (which hasn't arrived via UPDATED_LAYER_INFORMATION yet).
     * 
     * This fixes the race condition where finalizeRoundLog was called with null/Unknown
     * because NEW_GAME cleared the cache before UPDATED_LAYER_INFORMATION populated new data.
     */
    async finalizeRoundLog() {
      if (this._isFinalizingRound) {
        Logger.verbose('SmartAssign', 2, '[Finalize] Concurrent finalization blocked — already in progress.');
        return;
      }
      this._isFinalizingRound = true;
      try {
         await this.eventLogger.finalizeRoundLog(
           this.currentRoundStartTime,
           this.previousRoundLayerName || 'Unknown',
           this.previousRoundGamemode || 'Unknown',
           this.options.enableSmartAssign !== false
         );
      } finally {
        this._isFinalizingRound = false;
      }
    }

   /**
    * ROUND SNAPSHOT: Captures current player state and logs it to the event stream.
    *
    * Purpose: Create a point-in-time record of all active players, their team assignments,
    *          and their session join times at the moment this round snapshot is taken.
    *          This snapshot anchors all subsequent player lifecycle events (joins, leaves,
    *          team changes) for accurate historical reconstruction and testing purposes.
    *
    * Workflow:
    *   1. Check if snapshot already taken (idempotent guard)
    *   2. Capture all connected players with steamIDs
    *   3. Log ROUND_SNAPSHOT event with player state array
    *   4. Cache current layer/gamemode to protect finalization
    *   5. Set _snapshotTaken flag and mark completion in logs
    *
    * Timing:
    *   - Called from onUpdatedPlayerInfo() once 100% team resolution achieved in resolving phase
    *   - Also called opportunistically at each UPDATED_PLAYER_INFORMATION tick
    *     after snapshot is already taken (for early map change detection)
    *   - Guards ensure it's truly idempotent: second call is instant no-op
    *
    * Data Captured:
    *   - name: Player's display name
    *   - steamID: Steam account ID (unique identifier)
    *   - teamID: Current team assignment (1 or 2)
    *   - joinedServerAt: Session join timestamp (from _sessionJoinTimes Map)
    */
   async _ensureSnapshot() {
     // Guard 1: Already taken (idempotent)
     if (this._snapshotTaken) return;

     this._snapshotTaken = true;

     const snapshotPlayers = this.server.players
       .filter(p => p.steamID)
       .map(p => ({
         name: p.name,
         steamID: p.steamID,
         teamID: p.teamID,
         joinedServerAt: this._sessionJoinTimes.get(p.steamID) || Date.now()
       }));

      // Layer identity is now maintained continuously by onUpdatedLayerInfo listener.
      // No need to re-read it here — it's already cached with the correct value
      // from the independent UPDATED_LAYER_INFORMATION polling cycle.

      // ═════════════════════════════════════════════════════════════════════════════════════
      // BUILD CLAN TAG CACHE AT SNAPSHOT TIME
      //
      // Once all players have resolved to real teams, build the lightweight per-player tag cache
      // that will be used for fast clan lookups during the round. This happens exactly once per round.
      // ═════════════════════════════════════════════════════════════════════════════════════
      if (this.options.enableClanGrouping) {
        this._playerTagCache = buildPlayerTagCache(this.server.players, {
          caseSensitive: this.options.clanGroupCaseSensitive || false
        });
        Logger.verbose('SmartAssign', 2, `[Clan] Built player tag cache with ${this._playerTagCache.size} entries at snapshot time.`);
      }

      this.logEvent('ROUND_SNAPSHOT', null, { players: snapshotPlayers }, false);
     Logger.verbose('SmartAssign', 2, `[Snapshot] Round snapshot captured with ${snapshotPlayers.length} players.`);
   }

  }
