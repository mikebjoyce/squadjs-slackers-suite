/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  SMART ASSIGN PLUGIN v0.2.8                   ║
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
 *   Persistent SQLite storage for reconnect memory and round state.
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
 *     2. Mu Balancing: Weights the average skill gap (3.0x) against a dynamically scaled sum gap (1.5x) to handle diverse pop states.
 *     3. Reconnect Priority: Hot-path reconnect memory lives in-memory (_reconnectMemory Map) for synchronous lookups. If the player has a reconnect record and the pop cap allows it, they're sent to their previous team immediately (before Elo scoring). On disconnect, the Map is updated synchronously and the DB is written async (fire-and-forget) for crash recovery.
 *     4. Reconnect Bias: If reconnect priority is blocked by the cap, applies a minor score reduction (0.25) toward the previous team to tip near-ties.
 *     5. Reconnect Bonus: Grants an *additional* +2 player imbalance allowance on top of the base for returning players.
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

import { promises as fsPromises } from 'fs';
import Logger from '../../core/logger.js';
import BasePlugin from './base-plugin.js';
import SADatabase from '../utils/sa-database.js';
import SASwapExecutor from '../utils/sa-swap-executor.js';

const MAX_TEAM_SIZE = 50;

export default class SmartAssign extends BasePlugin {
  static version = '0.2.2';

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
        description: 'Sequelize/SQLite connector.',
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

    this.knownPlayers = new Map();
    this._joiningPlayers = new Set();
    this._sessionJoinTimes = new Map();
    this._snapshotTaken = false;
    this._betweenRounds = false;
    this.currentLayerName = null;
    this._pendingAssignments = { 1: 0, 2: 0 };
    this._pendingMu = { 1: 0, 2: 0 };
    this._pendingPlayerMoves = new Map();
    this.currentRoundEvents = [];
    this.currentRoundStartTime = null;
    this.ready = false;
    this.initialSyncComplete = false;
    // Promise queue and in-memory batch array to optimise disk I/O when streaming logs
    this._logWriteQueue = Promise.resolve();
    this._eventBatch = [];

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
    this._eloNotReadyWarned = false;

    // State bindings
    this.onNewGame = this.onNewGame.bind(this);
    this.onRoundEnded = this.onRoundEnded.bind(this);
    this.onUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
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

    // Periodically flush the in-memory event batch to the temp file to reduce disk I/O
    this._batchFlushTimer = setInterval(() => {
      this._flushTempLog().catch(err => Logger.verbose('SmartAssign', 1, `Flush error: ${err.message}`));
    }, 15000);

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
      serverRoundStart &&
      Math.abs(Number(persistedStartTime) - Number(serverRoundStart)) < threeHours
    ) {
      // It's a resume.
      Logger.verbose(
        'SmartAssign',
        1,
        'Restart detected. Resuming round state.'
      );
      this.currentRoundStartTime = Number(persistedStartTime);
      this._snapshotTaken = true; // Assume snapshot exists in temp log
      await this.loadTempEvents();
      
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
    if (this._batchFlushTimer) clearInterval(this._batchFlushTimer);
    await this.finalizeRoundLog();
    this.server.removeListener('NEW_GAME', this.onNewGame);
    this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
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

  async onNewGame(info) {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 1, 'NEW_GAME detected. Finalizing previous round log.');

    await this.finalizeRoundLog();

    // Restart the log flush timer if it was stopped by finalizeRoundLog
    if (!this._batchFlushTimer) {
      this._batchFlushTimer = setInterval(() => {
        this._flushTempLog().catch((err) => Logger.verbose('SmartAssign', 1, `Flush error: ${err.message}`));
      }, 15000);
    }

    await this.db.clearReconnectMemory();
    const now = this.server.matchStartTime ? this.server.matchStartTime.getTime() : Date.now();
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
    
    // ═════════════════════════════════════════════════════════════════════════════════════
    // CRITICAL TIMING: Clear the between-rounds flag BEFORE calling _ensureSnapshot().
    // 
    // The between-rounds window spans: ROUND_ENDED → staging phase → NEW_GAME.
    // During this window, the map changes and the layer name updates. If _ensureSnapshot()
    // were called while _betweenRounds is still true, the guard would prevent the snapshot
    // from firing. By clearing the flag here (before _ensureSnapshot()), we ensure the
    // snapshot captures the new round with the correct layer name.
    // ═════════════════════════════════════════════════════════════════════════════════════
    this._betweenRounds = false;

    // NOTE: This call to _ensureSnapshot() is intentional. In SquadJS, the layer name 
    // may be 'Unknown' during NEW_GAME, which causes the snapshot to safely abort 
    // and wait for the first player update. However, if the layer is known, it takes 
    // the snapshot immediately to catch it as early as possible.
    await this._ensureSnapshot();

    this.currentLayerName = null;
  }

  async onRoundEnded(info) {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 1, 'ROUND_ENDED detected. Finalizing round log.');
    await this.finalizeRoundLog();
    this._snapshotTaken = false;
    
    // ═════════════════════════════════════════════════════════════════════════════════════
    // BETWEEN-ROUNDS WINDOW: Set flag to suppress player events.
    //
    // When ROUND_ENDED fires, the round has just ended in-game. However, several things
    // still happen before the next round actually starts (NEW_GAME):
    //   1. Map change and layer loading begins
    //   2. Server enters staging phase (Scoreboard/Voting screens)
    //   3. Map fully loads with new gamemode
    //   4. NEW_GAME finally fires (true round start)
    //
    // During this window, players may join/leave while the server finishes loading the
    // new map and layer name changes. Any joins/leaves in this period are part of the
    // previous round's finalization, NOT part of the new round yet. By setting _betweenRounds
    // to true here, we ensure:
    //   - _ensureSnapshot() guards itself and doesn't take a premature snapshot with the new layer name
    //   - Events are marked with betweenRounds=true for proper historical attribution
    // ═════════════════════════════════════════════════════════════════════════════════════
    this._betweenRounds = true;
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
    this.logEvent('MOVE_FAILED', p, { reason }, this._betweenRounds);
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
      this.logEvent('MOVE_SUCCESS', p, { teamID }, this._betweenRounds);
    }
  }

   async onMoveRetry(data) {
     if (!this.ready) return;
     const { steamID, attempt, method } = data;
     const p = this.server.players.find((x) => x.steamID === steamID);
     if (p) {
       Logger.verbose('SmartAssign', 3, `[SmartAssign] Retrying move for ${p.name} (${steamID}) | Attempt: ${attempt} | Method: ${method}`);
       this.logEvent('MOVE_RETRY', p, { attempt, method }, this._betweenRounds);
     }
   }

  async onPlayerConnected(info) {
    if (!this.ready) return;
    const p = info.player;
    if (!p || !p.steamID) return;

    /**
     * DESIGN DECISION: Forced Join Refresh
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
     */
    const updateStart = Date.now();
    this.server.updatePlayerList().then(() => {
      Logger.verbose('SmartAssign', 4, `[JoinRefresh] Forced RCON poll completed in ${Date.now() - updateStart}ms`);
    }).catch((err) => {
      Logger.verbose('SmartAssign', 1, `[JoinRefresh] Forced update failed on join: ${err.message}`);
    });

    // Trigger join handling immediately using the log-provided player data.
    // The executor will fire the RCON move before the player is even visible
    // in the ListPlayers array — the forced poll above will catch up shortly after.
    if (!this.knownPlayers.has(p.steamID)) {
      await this.handlePlayerJoin(p);
    }
  }

  async onUpdatedPlayerInfo(info) {
    if (!this.ready) return;
    
    // Catch early map change or initial snapshot
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
     * DESIGN NOTE: Squad's Native Team Assignment
     * In Squad, players are immediately assigned to Team 1 or Team 2 by the game natively upon joining.
     * There is no 'unassigned' or 'Team 0' state for teams (unassigned only applies to squads).
     * Therefore, it is only necessary to listen for explicit team changes between 1 and 2, and 
     * polling fallbacks for 'team-less' players are not needed.
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
     await this._ensureSnapshot();

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

        Logger.verbose('SmartAssign', 3, `[JOIN] Player connected: ${player.name} (${player.steamID})`);
        this.logEvent('JOIN', player, {}, this._betweenRounds);

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
       // OPTIMIZATION: Fast In-Memory Reconnect Lookup
       // 
       // After adding in-memory reconnect memory, the getReconnectTeam() call is now
       // just a synchronous Map lookup instead of an async DB read. This removes the
       // last await from the join-swap pipeline.
       // ═══════════════════════════════════════════════════════════════════════════

       const phaseStartTime = Date.now();
       const timemarks = {};

       // Evaluate ideal team assignment — read reconnect memory synchronously from Map
       const reconnectTeamStart = Date.now();
       const reconnectTeam = this._reconnectMemory.get(player.steamID) || null;
       timemarks.reconnectTeamMs = Date.now() - reconnectTeamStart;

       // 2. STALE-STATE BATCHING PROTECTION
       // JS single-threaded guarantee: once reconnect memory lookup resolves (synchronously),
       // execution runs synchronously through evaluate + increment before yielding again.
       // Concurrent joins are safe because no await exists between reconnect lookup and increment.
       const evalStart = Date.now();
       const { targetTeam, reason } = this.evaluateTeamAssignment(player, reconnectTeam);
       timemarks.evaluateMs = Date.now() - evalStart;
       timemarks.totalPipelineMs = Date.now() - phaseStartTime;

       // Log timing details at verbosity 3 for detailed performance monitoring
       Logger.verbose('SmartAssign', 3, `[TIMING] ${player.name} join pipeline: reconnect=${timemarks.reconnectTeamMs}ms (in-memory), evaluate=${timemarks.evaluateMs}ms, total=${timemarks.totalPipelineMs}ms`);

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
      }, this._betweenRounds);

      // If the player is currently on the wrong team, queue a team change
      if (targetTeam !== null && String(player.teamID) !== String(targetTeam)) {
        this._pendingAssignments[targetTeam]++;
        const pendingPlayerMu = this._getMuFast(player);
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

     await this._ensureSnapshot();

     Logger.verbose('SmartAssign', 3, `[LEAVE] Player disconnected: ${player.name} (${player.steamID}) from Team ${player.teamID}`);
     this.logEvent('LEAVE', player, {}, this._betweenRounds);
    
    // Save to reconnect memory if they were on a valid team
    const tid = Number(player.teamID);
    if (tid === 1 || tid === 2) {
      // ─ OPTIMIZATION: Write to both in-memory Map and DB
      // In-memory write is immediate (synchronous), providing fast lookups on rejoin.
      // DB write is fire-and-forget asynchronous so it doesn't block the event pipeline.
      this._reconnectMemory.set(player.steamID, tid);
      await this.db.savePlayerDisconnect(player.steamID, tid);
    }
  }

  async handleTeamChange(player, oldTeam, newTeam, source = 'Manual/Game') {
    await this._ensureSnapshot();

    if (source === 'Smart-Assign') {
      Logger.verbose('SmartAssign', 2, `[TEAM_CHANGE] Player ${player.name} was moved to Team ${newTeam} by SmartAssign`);
    } else if (source === 'Team-Balancer') {
      Logger.verbose('SmartAssign', 2, `[TEAM_CHANGE] Player ${player.name} was scrambled to Team ${newTeam} by Team-Balancer`);
    } else {
      Logger.verbose('SmartAssign', 2, `[TEAM_CHANGE] Player ${player.name} changed from Team ${oldTeam} to Team ${newTeam} (${source})`);
    }
    this.logEvent('TEAM_CHANGE', player, { oldTeam, newTeam, source }, this._betweenRounds);
  }

  /**
   * Evaluates and returns the best team (1 or 2) for a joining player.
   * Uses a Mu-based Unified Scoring System to balance competitive parity,
   * population equity, and player preference (reconnects).
   *
   * CRITICAL: This method MUST remain synchronous. The assignment logic
   * in onUpdatedPlayerInfo relies on the fact that no await exists between
   * evaluation and state increments to prevent race conditions during
   * player join bursts.
   */
  evaluateTeamAssignment(player, reconnectTeam = null) {
    const eloTracker = this.eloTracker;
    const hasElo = eloTracker && eloTracker.ready && typeof eloTracker.getMu === 'function';

    if (eloTracker && !eloTracker.ready) {
      if (!this._eloNotReadyWarned) {
        Logger.verbose('SmartAssign', 1, '[SmartAssign] EloTracker present but not ready — falling back to population-only routing.');
        this._eloNotReadyWarned = true;
      }
    } else if (eloTracker && eloTracker.ready && this._eloNotReadyWarned) {
      // Reset the flag once it becomes ready again
      this._eloNotReadyWarned = false;
    }

    // 1. DATA COLLECTION (Single Pass Optimization)
    let t1Count = this._pendingAssignments[1] || 0;
    let t2Count = this._pendingAssignments[2] || 0;
    let t1Power = this._pendingMu[1] || 0;
    let t2Power = this._pendingMu[2] || 0;

    const players = this.server.players;
    const playerCount = players.length;

    for (let i = 0; i < playerCount; i++) {
      const p = players[i];
      if (!p || p.steamID === player.steamID) continue;

      // Ignore players currently pending a move since their future state is already in _pending.
      // This prevents double-counting and ensures team population/Elo projections are highly accurate.
      if (this._pendingPlayerMoves && this._pendingPlayerMoves.has(p.steamID)) continue;

      const teamID = String(p.teamID);
      if (teamID === '1') {
        t1Count++;
        if (hasElo) t1Power += this._getMuFast(p);
      } else if (teamID === '2') {
        t2Count++;
        if (hasElo) t2Power += this._getMuFast(p);
      }
    }

    // 2. HARD POPULATION CAP
    const totalPop = t1Count + t2Count;
    const isRejoin = reconnectTeam === 1 || reconnectTeam === 2;

    // Gradual Dynamic maxImbalance
    let maxImbalance;
    if (totalPop >= 94) maxImbalance = 1;
    else if (totalPop >= 88) maxImbalance = 2;
    else if (totalPop >= 80) maxImbalance = 3;
    else maxImbalance = 4;

    let effectiveMaxImbalance = maxImbalance;
    if (isRejoin) effectiveMaxImbalance = Math.min(4, maxImbalance + (totalPop >= 90 ? 1 : 2));

    if ((t1Count + 1) - t2Count > effectiveMaxImbalance) return { targetTeam: 2, reason: 'Hard Population Cap' };
    if ((t2Count + 1) - t1Count > effectiveMaxImbalance) return { targetTeam: 1, reason: 'Hard Population Cap' };

    // 2.1 PHYSICAL SERVER CAP (50)
    // If both teams are maxed at 50, a fallback 'targetTeam: null' is returned to prevent the plugin 
    // from attempting to shove a 51st player onto a full team. The executor won't perform 
    // any RCON moves and lets the game handle the player natively.
    if (t1Count >= MAX_TEAM_SIZE && t2Count >= MAX_TEAM_SIZE) return { targetTeam: null, reason: 'Server Full' };
    if (t1Count >= MAX_TEAM_SIZE && t2Count < MAX_TEAM_SIZE) return { targetTeam: 2, reason: 'Team 1 Full' };
    if (t2Count >= MAX_TEAM_SIZE && t1Count < MAX_TEAM_SIZE) return { targetTeam: 1, reason: 'Team 2 Full' };

    // 3.0 RECONNECT PRIORITY ROUTING
    // If the player has reconnect memory and placing them on that team
    // does not violate the hard population cap, honour it immediately.
    // This runs before Elo scoring so the guarantee is strong.
    if (isRejoin) {
      const rejoinTarget = reconnectTeam; // 1 or 2
      const rejoinCount    = rejoinTarget === 1 ? t1Count : t2Count;
      const opponentCount  = rejoinTarget === 1 ? t2Count : t1Count;
      if ((rejoinCount + 1) - opponentCount <= effectiveMaxImbalance) {
        return { targetTeam: rejoinTarget, reason: 'Reconnect Memory (Priority)' };
      }
      // Hard cap would be violated — fall through to Elo scoring.
    }

    // 3. SKILL & PENALTY EVALUATION
    if (!hasElo) {
      const targetTeam = t1Count <= t2Count ? 1 : 2;
      return { targetTeam, reason: `Population Balance (No Elo) | T1:${t1Count} T2:${t2Count}` };
    }

    const playerMu = this._getMuFast(player);
    const avgT1 = t1Count > 0 ? (t1Power / t1Count) : 25.0;
    const avgT2 = t2Count > 0 ? (t2Power / t2Count) : 25.0;

    const newAvgT1 = (t1Power + playerMu) / (t1Count + 1);
    const newAvgT2 = (t2Power + playerMu) / (t2Count + 1);

    // Dynamic scale: normalises sum gap relative to current server population. 
    // As population increases, the importance of the Total-Skill (sum) gap is 
    // intentionally phased out in favor of the Average-Skill gap. 
    // At a full 100-player server, the sum term becomes negligible.
    const dynamicScale = Math.max(1, (t1Count + t2Count + 1) * 2.5);

    const getScore = (candidateAvg, opponentAvg, candidateSum, opponentSum) => {
      const avgGap = Math.abs(candidateAvg - opponentAvg);
      const sumGap = Math.abs(candidateSum - opponentSum) / dynamicScale;
      return (avgGap * 3.0) + (sumGap * 1.5);
    };

    let scoreT1 = getScore(newAvgT1, avgT2, t1Power + playerMu, t2Power);
    let scoreT2 = getScore(avgT1, newAvgT2, t1Power, t2Power + playerMu);

    // Rejoin bias: if reconnect priority was blocked by the hard pop cap and fell
    // through here, apply a small score reduction toward the player's previous team.
    // Not enough to override a meaningful Elo gap; only tips near-ties.
    if (isRejoin) {
      const REJOIN_BIAS = 0.25;
      if (reconnectTeam === 1) scoreT1 = Math.max(0, scoreT1 - REJOIN_BIAS);
      else if (reconnectTeam === 2) scoreT2 = Math.max(0, scoreT2 - REJOIN_BIAS);
    }

    let targetTeam;
    if (scoreT1 < scoreT2) {
      targetTeam = 1;
    } else if (scoreT2 < scoreT1) {
      targetTeam = 2;
    } else {
      // Simple population tie-breaker
      targetTeam = t1Count <= t2Count ? 1 : 2;
    }

    const reason = `Skill Balance: T1=${scoreT1.toFixed(3)}, T2=${scoreT2.toFixed(3)} | Pop: ${t1Count}v${t2Count}`;

    return { targetTeam, reason };
  }

  /**
   * Fast Mu retrieval bypassing heavy try/catch and redundant lookups.
   * @private
   */
  _getMuFast(p) {
    const et = this.eloTracker;
    if (!et) return 25.0;

    try {
      // Prioritize internal maps to bypass getter overhead/logic.
      // WARNING: These paths couple directly to EloTracker internals. If those
      // property names change, this silently degrades to the public getMu() fallback.
      if (et.eloCache && p.eosID) {
        const cached = et.eloCache.get(p.eosID);
        if (cached) return cached.mu;
        Logger.verbose('SmartAssign', 3, `[_getMuFast] eloCache miss for eosID ${p.eosID}, falling through.`);
      }
      if (et.eloMap && p.steamID) {
        const mu = et.eloMap.get(p.steamID);
        if (mu !== undefined) return mu;
        Logger.verbose('SmartAssign', 3, `[_getMuFast] eloMap miss for steamID ${p.steamID}, falling through.`);
      }

      // Both fast paths missed — this could mean internals changed or player is truly unknown to cache
      if (!this._muFastMissWarned) {
        Logger.verbose(
          'SmartAssign',
          2,
          '[_getMuFast] Both fast paths missed. EloTracker internals may have changed. Falling back to getMu().'
        );
        this._muFastMissWarned = true;
      }

      // Fallback to official API
      return et.getMu(p);
    } catch (e) {
      Logger.verbose('SmartAssign', 2, `[_getMuFast] getMu() threw for ${p.steamID}: ${e?.message}. Using default Mu.`);
      return 25.0;
    }
  }

  logEvent(eventType, player, extraData = {}, betweenRounds = false) {
    if (!this.options.logPath || this.options.enableEventLogging === false) return;

    // Dynamically inject the global team populations into every event for richer historical replay
    let t1 = 0;
    let t2 = 0;
    for (const p of this.server.players) {
      if (String(p.teamID) === '1') t1++;
      else if (String(p.teamID) === '2') t2++;
    }

    const event = {
      timestamp: Date.now(),
      eventType,
      ...(player ? {
        steamID: player.steamID,
        name: player.name,
        teamID: player.teamID,
        squadID: player.squadID
      } : {}),
      ...extraData,
      betweenRounds,
      t1,
      t2
    };

    // Push to in-memory batch. Flush immediately if the threshold is reached to prevent memory bloat.
    this._eventBatch.push(JSON.stringify(event) + '\n');
    if (this._eventBatch.length >= 20) {
      this._flushTempLog().catch(err => Logger.verbose('SmartAssign', 1, `Flush error: ${err.message}`));
    }
  }

  /**
   * Appends the in-memory batch of formatted events to the temporary .temp file.
   * Chained via a Promise queue to prevent interleaved JSON lines from overlapping fs.appendFile calls.
   */
  async _flushTempLog() {
    if (this._eventBatch.length === 0) return;
    
    const lines = this._eventBatch.join('');
    this._eventBatch = [];
    
    const tempPath = this.options.logPath + '.temp';
    this._logWriteQueue = this._logWriteQueue.then(() => {
      return fsPromises.appendFile(tempPath, lines, 'utf8')
        .catch((err) => Logger.verbose('SmartAssign', 1, `Failed to write temp log: ${err.message}`));
    });
    
    return this._logWriteQueue;
  }

  async finalizeRoundLog() {
    if (this._batchFlushTimer) {
      clearInterval(this._batchFlushTimer);
      this._batchFlushTimer = null;
    }

    // Force flush any pending memory events and wait for the write queue to empty.
    // _flushTempLog returns the current _logWriteQueue promise.
    await this._flushTempLog();
    await this._logWriteQueue; // drain queue fully

    // Always load from temp file to get the full round history
    await this.loadTempEvents();
    
     if (this.currentRoundEvents.length === 0) {
       Logger.verbose('SmartAssign', 3, `Skipping log finalization: 0 events to write.`);
       return;
     }

    Logger.verbose('SmartAssign', 1, `Finalizing round log with ${this.currentRoundEvents.length} events.`);

    const roundLog = {
      startTime: this.currentRoundStartTime || Date.now(),
      endTime: Date.now(),
      layerName: this.currentLayerName || (this.server.currentLayer ? this.server.currentLayer.name : 'Unknown'),
      gamemode: this.server.currentLayer ? this.server.currentLayer.gamemode : 'Unknown',
      smartAssignActive: this.options.enableSmartAssign !== false,
      events: this.currentRoundEvents
    };

    try {
      await fsPromises.appendFile(this.options.logPath, JSON.stringify(roundLog) + '\n', 'utf8');
      const tempPath = this.options.logPath + '.temp';
      await fsPromises.unlink(tempPath).catch(() => {});
      // Only clear events if write was successful
      this.currentRoundEvents = [];
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `Failed to finalize round log: ${err.message}. Events retained in memory.`);
    }
  }

   /**
    * Captures a `ROUND_SNAPSHOT` event of the entire connected player base at the start of a new round.
    * Acts as a keyframe for historical log replay or data-analysis tools.
    *
    * CRITICAL TIMING: This method must only fire when a new round actually begins (NEW_GAME event).
    * The _betweenRounds guard below prevents premature snapshots during the staging phase
    * (after ROUND_ENDED but before NEW_GAME). During this window, map changes and layer name updates
    * may occur, which would incorrectly capture a snapshot with the new layer name while the previous
    * round is still being finalized. The snapshot must always represent the state at true round start,
    * not at server staging.
    */
    async _ensureSnapshot() {
      // Guard: Do not snapshot during the between-rounds window (after ROUND_ENDED, before NEW_GAME).
      // This prevents capturing false snapshots with new layer names while the previous round finalizes.
      if (this._betweenRounds) return;
      
      if (this._snapshotTaken) return;

      const currentLayerName = this.server.currentLayer ? this.server.currentLayer.name : 'Unknown';
      if (currentLayerName === 'Unknown') return;

      // ═══════════════════════════════════════════════════════════════════════════════════════════
      // CRITICAL TIMING GUARD: Defer snapshot if RCON team data is not yet stable
      //
      // When NEW_GAME fires, the round has just transitioned. However, Squad's RCON ListPlayers
      // output may still reflect the transitional state where all players have teamID=null before
      // the server assigns them to teams for the new round. If we snapshot at this exact moment,
      // we capture ~93 players with null teams, which corrupts the ROUND_SNAPSHOT record.
      //
      // This guard mirrors the safe-sync handshake in onUpdatedPlayerInfo: we defer snapshot
      // completion until at least one real team assignment (1 or 2) is visible in RCON data.
      // The snapshot will then fire on the next UPDATED_PLAYER_INFORMATION tick when RCON has
      // refreshed with real team data (typically 5–30s after round start), ensuring accuracy.
      //
      // ─ Root Cause: Race condition between NEW_GAME event and RCON refresh cycle
      // ─ Impact: Prevents null-team snapshots; sacrifice is minor timing delay (one RCON poll)
      // ═══════════════════════════════════════════════════════════════════════════════════════════
      const hasRealTeams = this.server.players.some(p => p.teamID === 1 || p.teamID === 2);
      if (!hasRealTeams) {
        Logger.verbose('SmartAssign', 3, `Snapshot deferred: RCON team data not yet stable for layer ${currentLayerName}. Will retry on next UPDATED_PLAYER_INFORMATION tick.`);
        return;
      }

     // Lock the snapshot immediately before any await yields to prevent race conditions 
     // from concurrent promise batches hitting this method simultaneously.
     this._snapshotTaken = true;
    
    // Cache the layer name for use in finalizeRoundLog()
    // This ensures we record the correct layer even if it becomes 'Unknown' during round transition
    this.currentLayerName = currentLayerName;

    Logger.verbose('SmartAssign', 1, `Taking early round snapshot for layer: ${currentLayerName}`);

    // If we have events in memory from a previous round that haven't been finalized, finalize them now.
    // This happens if map detected change before onNewGame or onRoundEnded fired.
    if (this.currentRoundEvents.length > 0) {
      await this.finalizeRoundLog();
    }

    const now = Date.now();
    const snapshotPlayers = this.server.players.filter(p => p && p.steamID).map(p => ({
      name: p.name,
      steamID: p.steamID,
      teamID: p.teamID,
      // joinedServerAt intentionally draws from the persistent _sessionJoinTimes Map 
      // rather than the current round time to accurately track cross-round play sessions.
      joinedServerAt: this._sessionJoinTimes.has(p.steamID) ? this._sessionJoinTimes.get(p.steamID) : now
    }));

    this.logEvent('ROUND_SNAPSHOT', null, { players: snapshotPlayers }, this._betweenRounds);
  }

  async loadTempEvents() {
    const tempPath = this.options.logPath + '.temp';
    try {
      const data = await fsPromises.readFile(tempPath, 'utf8');
      const lines = data.trim().split('\n');
      this.currentRoundEvents = lines
        .filter((l) => l.trim())
        .reduce((acc, l) => {
          try {
            acc.push(JSON.parse(l));
          } catch {
            Logger.verbose('SmartAssign', 1, '[Log] Skipped malformed temp line.');
          }
          return acc;
        }, []);
      Logger.verbose(
        'SmartAssign',
        1,
        `Loaded ${this.currentRoundEvents.length} events from temp log.`
      );
    } catch (err) {
      if (err.code !== 'ENOENT') {
        Logger.verbose('SmartAssign', 1, `[Log] Failed to load temp events: ${err.message}`);
      }
    }
  }
}
