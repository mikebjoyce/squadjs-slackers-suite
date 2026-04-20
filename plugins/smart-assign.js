/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  SMART ASSIGN PLUGIN v0.2.0                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Handles custom Elo-based player auto-assignment and records player
 * lifecycle events. Overrides Squad's native team assignment to provide
 * competitive parity via Average-Elo balancing, reconnect memory,
 * and strict population equity rules. Bypasses "Seed" layers natively.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SmartAssign (default)
 *   Extends BasePlugin. Key methods:
 *     mount()                          — Initialises DB and lifecycle listeners.
 *     unmount()                        — Removes listeners and cleans up executor.
 *     evaluateTeamAssignment(player)    — Core algorithm for team placement.
 *     logEvent(type, player, data)      — Records lifecycle events to JSONL.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * SADatabase (../utils/sa-database.js)
 *   Persistent SQLite storage for reconnect memory and round state.
 * SASwapExecutor (../utils/sa-swap-executor.js)
 *   Manages the RCON move queue with retry logic for loading players.
 * EloTracker (Sibling Plugin)
 *   Provides live TrueSkill Mu ratings for skill-based balancing.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Algorithm uses a Mu-based Unified Scoring System:
 *     1. Hard Pop Cap: Prevents imbalance beyond dynamic thresholds.
 *     2. Mu Balancing: Weights the average skill gap (3.0x) against a dynamically scaled sum gap (1.5x) to handle diverse pop states.
 *     3. Reconnect Bias: Applies a minor score reduction (0.25) toward previous team if returning.
 *     4. Reconnect Bonus: Grants an *additional* +2 player imbalance allowance on top of the base.
 * - Strict 1-player max imbalance enforced at high population (94+).
 * - Bypasses auto-assignment completely during specified ignored modes (Seed/Jensen).
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

const MAX_TEAM_SIZE = 50;
import { promises as fsPromises } from 'fs';
import Logger from '../../core/logger.js';
import BasePlugin from './base-plugin.js';
import SADatabase from '../utils/sa-database.js';
import SASwapExecutor from '../utils/sa-swap-executor.js';

export default class SmartAssign extends BasePlugin {
  static version = '0.2.0';

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
        description: 'Whether to actually move players. If false, plugin runs in passive data-collection mode.',
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
      retryIntervalMs: 150,
      maxCompletionTimeMs: 3000
    });

    this.knownPlayers = new Map();
    this._joiningPlayers = new Set();
    this._pendingAssignments = { 1: 0, 2: 0 };
    this._pendingMu = { 1: 0, 2: 0 };
    this._pendingPlayerMoves = new Map();
    this.currentRoundEvents = [];
    this.currentRoundStartTime = null;
    this.ready = false;
    this.initialSyncComplete = false;
    this._logWriteQueue = Promise.resolve();

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
      await this.loadTempEvents();
    } else {
      // New round or no data
      Logger.verbose('SmartAssign', 1, 'New round or no persisted state. Starting fresh.');

      // Finalize any leftover temp logs from a previous crashed session
      await this.finalizeRoundLog();

      await this.db.clearReconnectMemory();
      const now = serverRoundStart || Date.now();
      await this.db.saveRoundStartTime(now);
      this.currentRoundStartTime = now;
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

    await this.db.clearReconnectMemory();
    const now = this.server.matchStartTime ? this.server.matchStartTime.getTime() : Date.now();
    await this.db.saveRoundStartTime(now);
    this.currentRoundStartTime = now;

    // Clear known players so anyone connecting gets processed normally
    this.knownPlayers.clear();
    this._joiningPlayers.clear();
    this._pendingAssignments[1] = 0;
    this._pendingAssignments[2] = 0;
    this._pendingMu[1] = 0;
    this._pendingMu[2] = 0;
    this._pendingPlayerMoves.clear();
  }

  async onRoundEnded(info) {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 1, 'ROUND_ENDED detected. Finalizing round log.');
    await this.finalizeRoundLog();
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
    this.logEvent('MOVE_FAILED', p, { reason });
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
      this.logEvent('MOVE_SUCCESS', p, { teamID });
    }
  }

  async onMoveRetry(data) {
    if (!this.ready) return;
    const { steamID, attempt, method } = data;
    const p = this.server.players.find((x) => x.steamID === steamID);
    if (p) {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Retrying move for ${p.name} (${steamID}) | Attempt: ${attempt} | Method: ${method}`);
      this.logEvent('MOVE_RETRY', p, { attempt, method });
    }
  }

  async onPlayerConnected(info) {
    if (!this.ready) return;
    const p = info.player;
    if (!p || !p.steamID) return;

    // Fast trigger
    if (!this.knownPlayers.has(p.steamID)) {
      await this.handlePlayerJoin(p);
    }
  }

  async onUpdatedPlayerInfo(info) {
    if (!this.ready) return;

    if (!this.initialSyncComplete) {
      // SAFE-SYNC HANDSHAKE:
      // On the first update tick after plugin mount, knownPlayers is populated 
      // from the current server state without triggering any moves or assignments.
      for (const p of this.server.players) {
        if (p.steamID) {
          this.knownPlayers.set(p.steamID, {
            steamID: p.steamID,
            name: p.name,
            teamID: p.teamID,
            squadID: p.squadID
          });
        }
      }
      this.initialSyncComplete = true;
      Logger.verbose('SmartAssign', 1, `Safe-Sync handshake complete. Known players: ${this.knownPlayers.size}. Monitoring for changes.`);
      return;
    }

    /**
     * DESIGN NOTE: Omission of PLAYER_DISCONNECTED listener
     * In modern versions of Squad/SquadJS, the PLAYER_DISCONNECTED log parsing is entirely broken 
     * and fails to fire reliably. To prevent memory leaks and ensure disconnects are always caught, 
     * leaves are inferred strictly by delta-diffing the UPDATED_PLAYER_INFORMATION array.
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

      if (!this.knownPlayers.has(p.steamID)) {
        batchPromises.push(this.handlePlayerJoin(p));
      } else {
        const kp = this.knownPlayers.get(p.steamID);
        if (String(kp.teamID) !== String(p.teamID)) {
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
        if (String(kp.squadID) !== String(p.squadID)) {
          kp.squadID = p.squadID;
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

      Logger.verbose('SmartAssign', 2, `[JOIN] Player connected: ${player.name} (${player.steamID})`);
      this.logEvent('JOIN', player);

      // Check if the current layer/gamemode is ignored
      const currentLayerName = this.server.currentLayer ? this.server.currentLayer.name.toLowerCase() : '';
      const currentGamemode = this.server.currentLayer ? this.server.currentLayer.gamemode.toLowerCase() : '';

      const isIgnored = this._ignoredModes.some(m => currentLayerName.includes(m) || currentGamemode.includes(m));

      if (isIgnored) {
        Logger.verbose('SmartAssign', 2, `[SmartAssign] Ignored game mode detected. Skipping Elo-based assignment for ${player.name}.`);
        return;
      }

      // Evaluate ideal team assignment
      const reconnectTeam = await this.db.getReconnectTeam(player.steamID);

      // 2. STALE-STATE BATCHING PROTECTION
      // JS single-threaded guarantee: once getReconnectTeam() resolves, execution
      // runs synchronously through evaluate + increment before yielding again.
      // Concurrent joins are safe because no await exists between evaluate and increment.
      const { targetTeam, reason } = this.evaluateTeamAssignment(player, reconnectTeam);

      if (reconnectTeam && reconnectTeam === targetTeam) {
        Logger.verbose('SmartAssign', 2, `[SmartAssign] Applied reconnect memory for ${player.name} -> Team ${targetTeam} (${reason})`);
      } else if (reconnectTeam && reconnectTeam !== targetTeam) {
        Logger.verbose('SmartAssign', 2, `[SmartAssign] Ignored reconnect memory for ${player.name} (Previous: Team ${reconnectTeam}) -> Team ${targetTeam} (${reason})`);
      } else {
        Logger.verbose('SmartAssign', 2, `[SmartAssign] Evaluated fresh join for ${player.name} -> Team ${targetTeam} (${reason})`);
      }

      const willExecuteMove = targetTeam !== null && String(player.teamID) !== String(targetTeam) && this.options.enableSmartAssign !== false;

      // Record the assignment in log with executed flag for passive mode distinction
      this.logEvent('ASSIGNMENT', player, {
        targetTeam,
        reason,
        reconnectTeam,
        executed: willExecuteMove
      });

      // If the player is currently on the wrong team, queue a team change
      if (targetTeam !== null && String(player.teamID) !== String(targetTeam)) {
        if (this.options.enableSmartAssign !== false) {
          this._pendingAssignments[targetTeam]++;
          const pendingPlayerMu = this._getMuFast(player);
          this._pendingMu[targetTeam] += pendingPlayerMu;
          
          // NOTE: pendingPlayerMu is captured here and subtracted onMoveSuccess. If the player's 
          // Elo changes during the brief execution window, _pendingMu may drift slightly.
          // This is a known, low-impact approximation that resets naturally on NEW_GAME.
          this._pendingPlayerMoves.set(player.steamID, { targetTeam, mu: pendingPlayerMu });

          this.executor.queueMove(player.steamID, targetTeam);
        } else {
          Logger.verbose('SmartAssign', 2, `[SmartAssign] Passive mode: skipping move for ${player.name} to Team ${targetTeam}`);
        }
      }
    } finally {
      this._joiningPlayers.delete(player.steamID);
    }
  }

  async handlePlayerLeave(player) {
    Logger.verbose('SmartAssign', 2, `[LEAVE] Player disconnected: ${player.name} (${player.steamID}) from Team ${player.teamID}`);
    this.logEvent('LEAVE', player);
    
    // Save to reconnect memory if they were on a valid team
    const tid = Number(player.teamID);
    if (tid === 1 || tid === 2) {
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
    this.logEvent('TEAM_CHANGE', player, { oldTeam, newTeam, source });
  }

  /**
   * Evaluates and returns the best team (1 or 2) for a joining player.
   * Uses a Mu-based Unified Scoring System to balance competitive parity,
   * population equity, and player preference (reconnects).
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

    // Dynamic scale: normalises sum gap relative to current server population so the
    // term carries consistent weight whether the server has 20 or 100 players.
    const dynamicScale = Math.max(1, (t1Count + t2Count + 1) * 2.5);

    const getScore = (newAvg1, avg2, newSum1, sum2) => {
      const avgGap = Math.abs(newAvg1 - avg2);
      const sumGap = Math.abs(newSum1 - sum2) / dynamicScale;
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
      // Fallback to official API
      return et.getMu(p);
    } catch (e) {
      Logger.verbose('SmartAssign', 2, `[_getMuFast] getMu() threw for ${p.steamID}: ${e?.message}. Using default Mu.`);
      return 25.0;
    }
  }

  logEvent(eventType, player, extraData = {}) {
    if (!this.options.logPath || this.options.enableEventLogging === false) return;

    const event = {
      timestamp: Date.now(),
      eventType,
      steamID: player.steamID,
      name: player.name,
      teamID: player.teamID,
      squadID: player.squadID,
      ...extraData
    };

    // Incremental sequential write to temp file for stability/crash recovery
    const tempPath = this.options.logPath + '.temp';
    
    // Chain promises to prevent overlapping fs.appendFile which could cause interleaved JSON lines
    this._logWriteQueue = this._logWriteQueue.then(() => {
      return fsPromises.appendFile(tempPath, JSON.stringify(event) + '\n', 'utf8')
        .catch((err) => Logger.verbose('SmartAssign', 1, `Failed to write temp log: ${err.message}`));
    });
  }

  async finalizeRoundLog() {
    // Flush any in-flight writes before reading the temp file
    await this._logWriteQueue;

    // Always load from temp file to get the full round history
    await this.loadTempEvents();
    
    if (this.currentRoundEvents.length === 0) {
      Logger.verbose('SmartAssign', 2, `Skipping log finalization: 0 events to write.`);
      return;
    }

    Logger.verbose('SmartAssign', 1, `Finalizing round log with ${this.currentRoundEvents.length} events.`);

    const roundLog = {
      startTime: this.currentRoundStartTime || Date.now(),
      endTime: Date.now(),
      layerName: this.server.currentLayer ? this.server.currentLayer.name : 'Unknown',
      gamemode: this.server.currentLayer ? this.server.currentLayer.gamemode : 'Unknown',
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
