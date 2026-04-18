/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  SMART ASSIGN PLUGIN v0.1.4                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Handles custom Elo-based player auto-assignment and records player
 * lifecycle events. Overrides Squad's native team assignment to provide
 * competitive parity via Average-Elo balancing, reconnect memory,
 * and strict population equity rules.
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
 * - Algorithm uses a Unified Scoring System:
 *     1. Hard Pop Cap: Highest priority; prevents imbalance beyond dynamic thresholds.
 *     2. Squared Average Elo Gap: Minimizes resulting team average differences.
 *     3. Soft Pop Penalty: penalizes score per player of imbalance.
 *     4. Reconnect Bonus: grants score bonus to a player's old team.
 * - Strict 1-player max imbalance enforced at high population (96+).
 * - Event logs include JOIN, LEAVE, TEAM_CHANGE, and MOVE_FAILED.
 *
 * ─── CONFIGURATION ───────────────────────────────────────────────
 *
 * database: Sequelize connector name (default: 'sqlite').
 * logPath: Path for JSONL event logging (default: './auto-assign-log.jsonl').
 * enableSmartAssign: Toggle auto-assignment logic (default: true).
 * enableEventLogging: Toggle JSONL event logging (default: true).
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { promises as fsPromises } from 'fs';
import Logger from '../../core/logger.js';
import SADatabase from '../utils/sa-database.js';
import SASwapExecutor from '../utils/sa-swap-executor.js';

export default class SmartAssign {
  static version = '0.1.4';

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
      }
    };
  }

  constructor(server, options, connectors) {
    this.server = server;
    this.options = options;
    this.connectors = connectors;

    this.db = new SADatabase(server, options, connectors);
    this.executor = new SASwapExecutor(server, {
      maxAttempts: 6,
      retryIntervalMs: 500,
      maxCompletionTimeMs: 3000
    });

    this.knownPlayers = new Map();
    this.currentRoundEvents = [];
    this.currentRoundStartTime = null;
    this.ready = false;

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
    Logger.verbose('SmartAssign', 1, 'Mounting SmartAssign plugin.');

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
      // It's a resume. Populate known players silently so they don't trigger "JOIN" events
      Logger.verbose(
        'SmartAssign',
        1,
        'Restart detected. Resuming round state and silent-populating known players.'
      );
      this.currentRoundStartTime = Number(persistedStartTime);
      await this.loadTempEvents();

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
    } else {
      // New round or no data
      Logger.verbose('SmartAssign', 1, 'New round or no persisted state. Starting fresh.');

      // Finalize any leftover temp logs from a previous crashed session
      await this.finalizeRoundLog();

      await this.db.clearReconnectMemory();
      const now = serverRoundStart || Date.now();
      await this.db.saveRoundStartTime(now);
      this.currentRoundStartTime = now;

      // If there are players already, treat them as joins to get them assigned (or silent populate if seeded?)
      // Actually, if we just started, let's silent populate anyway so we don't spam 100 auto-assigns
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
    this.server.removeListener('NEW_GAME', this.onNewGame);
    this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
    this.server.removeListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
    this.server.removeListener('SMART_ASSIGN_MOVE_FAILED', this.onMoveFailed);
    this.server.removeListener('SMART_ASSIGN_MOVE_SUCCESS', this.onMoveSuccess);
    this.server.removeListener('SMART_ASSIGN_MOVE_RETRY', this.onMoveRetry);
    this.executor.cleanup();
    Logger.verbose('SmartAssign', 1, 'SmartAssign unmounted.');
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
    const p = this.server.players.find((x) => x.steamID === steamID) || { steamID, name: 'Unknown' };
    Logger.verbose('SmartAssign', 1, `[SmartAssign] Abandoned move for ${p.name} (${steamID}) - ${reason}`);
    this.logEvent('MOVE_FAILED', p, { reason });
  }

  async onMoveSuccess(data) {
    if (!this.ready) return;
    const { steamID, teamID } = data;
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

    const currentPlayers = new Map();
    for (const p of this.server.players) {
      if (p.steamID) currentPlayers.set(p.steamID, p);
    }

    // Check for LEAVES
    for (const [steamID, kp] of this.knownPlayers.entries()) {
      if (!currentPlayers.has(steamID)) {
        await this.handlePlayerLeave(kp);
        this.knownPlayers.delete(steamID);
      }
    }

    // Check for JOINS and TEAM CHANGES
    for (const [steamID, p] of currentPlayers.entries()) {
      if (!this.knownPlayers.has(steamID)) {
        await this.handlePlayerJoin(p);
      } else {
        const kp = this.knownPlayers.get(steamID);
        if (String(kp.teamID) !== String(p.teamID)) {
          let source = 'Manual/Game';
          if (this.executor.isRecentSmartAssignMove(steamID, p.teamID)) {
            source = 'Smart-Assign';
          } else if (this.scrambleEndTime && Date.now() < this.scrambleEndTime) {
            source = 'Team-Balancer';
          }

          await this.handleTeamChange(p, kp.teamID, p.teamID, source);
          kp.teamID = p.teamID;
        }
        if (String(kp.squadID) !== String(p.squadID)) {
          kp.squadID = p.squadID;
        }
      }
    }
  }

  async handlePlayerJoin(player) {
    // Register to known players
    this.knownPlayers.set(player.steamID, {
      steamID: player.steamID,
      name: player.name,
      teamID: player.teamID,
      squadID: player.squadID
    });

    Logger.verbose('SmartAssign', 2, `[JOIN] Player connected: ${player.name} (${player.steamID})`);
    this.logEvent('JOIN', player);

    // SmartAssign Logic
    const reconnectTeam = await this.db.getReconnectTeam(player.steamID);
    const { targetTeam, reason } = this.evaluateTeamAssignment(player, reconnectTeam);

    if (reconnectTeam && reconnectTeam === targetTeam) {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Applied reconnect memory for ${player.name} -> Team ${targetTeam} (${reason})`);
    } else if (reconnectTeam && reconnectTeam !== targetTeam) {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Ignored reconnect memory for ${player.name} (Previous: Team ${reconnectTeam}) -> Team ${targetTeam} (${reason})`);
    } else {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Evaluated fresh join for ${player.name} -> Team ${targetTeam} (${reason})`);
    }

    // Record the assignment in log
    this.logEvent('ASSIGNMENT', player, { targetTeam, reason, reconnectTeam });

    // If squad/engine put them on the wrong team natively (or they are unassigned)
    // we queue a move.
    if (String(player.teamID) !== String(targetTeam)) {
      if (this.options.enableSmartAssign !== false) {
        this.executor.queueMove(player.steamID, targetTeam);
      } else {
        Logger.verbose('SmartAssign', 2, `[SmartAssign] Passive mode: skipping move for ${player.name} to Team ${targetTeam}`);
      }
    }
  }

  async handlePlayerLeave(player) {
    Logger.verbose('SmartAssign', 2, `[LEAVE] Player disconnected: ${player.name} (${player.steamID}) from Team ${player.teamID}`);
    this.logEvent('LEAVE', player);
    
    // Save to reconnect memory if they were on a valid team
    if (player.teamID === 1 || player.teamID === 2) {
      await this.db.savePlayerDisconnect(player.steamID, player.teamID);
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
    const eloTracker = this.server.plugins.find((p) => p.constructor.name === 'EloTracker');
    const hasElo = eloTracker && eloTracker.ready;

    // 1. DATA COLLECTION
    let t1Count = 0;
    let t2Count = 0;
    let t1Power = 0;
    let t2Power = 0;

    const EXPONENT = 1.10;

    for (const p of this.server.players) {
      if (p.steamID === player.steamID) continue;

      const isT1 = String(p.teamID) === '1';
      const isT2 = String(p.teamID) === '2';

      if (isT1) t1Count++;
      else if (isT2) t2Count++;

      if (hasElo && (isT1 || isT2)) {
        let mu = 25.0;
        if (eloTracker.eloCache && p.eosID && eloTracker.eloCache.has(p.eosID))
          mu = eloTracker.eloCache.get(p.eosID).mu;
        else if (eloTracker.eloMap && p.steamID && eloTracker.eloMap.has(p.steamID))
          mu = eloTracker.eloMap.get(p.steamID);

        const pwr = Math.pow(mu, EXPONENT);
        if (isT1) t1Power += pwr;
        else t2Power += pwr;
      }
    }

    // 2. HARD POPULATION CAP
    const totalPop = t1Count + t2Count;
    const highPopThreshold = 96; // Enforce strict 1-player max imbalance at high pop
    const isRejoin = reconnectTeam === 1 || reconnectTeam === 2;

    let baseMaxImbalance;
    if (totalPop >= 95) baseMaxImbalance = 1;
    else if (totalPop >= 85) baseMaxImbalance = 2;
    else if (totalPop >= 70) baseMaxImbalance = 3;
    else baseMaxImbalance = 4;

    let effectiveMaxImbalance = baseMaxImbalance;
    if (isRejoin) {
      if (totalPop >= highPopThreshold) effectiveMaxImbalance = 2;
      else effectiveMaxImbalance = baseMaxImbalance + 2;
    }

    if (t1Count - t2Count >= effectiveMaxImbalance) return { targetTeam: 2, reason: 'Hard Population Cap' };
    if (t2Count - t1Count >= effectiveMaxImbalance) return { targetTeam: 1, reason: 'Hard Population Cap' };

    // 3. RECONNECT PRIORITY (Early Exit for Persistence)
    if (isRejoin) {
      const wouldViolate =
        reconnectTeam === 1
          ? t1Count + 1 - t2Count > effectiveMaxImbalance
          : t2Count + 1 - t1Count > effectiveMaxImbalance;

      if (!wouldViolate) return { targetTeam: reconnectTeam, reason: 'Reconnect Priority' };
    }

    // 4. SKILL & PENALTY EVALUATION
    let playerMu = 25.0;
    if (hasElo) {
      if (eloTracker.eloCache && player.eosID && eloTracker.eloCache.has(player.eosID))
        playerMu = eloTracker.eloCache.get(player.eosID).mu;
      else if (eloTracker.eloMap && player.steamID && eloTracker.eloMap.has(player.steamID))
        playerMu = eloTracker.eloMap.get(player.steamID);
    }
    const playerPower = Math.pow(playerMu, EXPONENT);

    if (!hasElo) {
      return { targetTeam: t1Count <= t2Count ? 1 : 2, reason: 'Population Balance (No Elo)' };
    }

    // Logistic Win-Probability Model (v0.1.4 Hybrid Tuning: Scale 15)
    const avgT1 = t1Count > 0 ? t1Power / t1Count : 25.0;
    const avgT2 = t2Count > 0 ? t2Power / t2Count : 25.0;

    const newAvgT1 = (t1Power + playerPower) / (t1Count + 1);
    const newAvgT2 = (t2Power + playerPower) / (t2Count + 1);

    const logisticScale = 15;
    const getWinProb = (a, b) => 1 / (1 + Math.pow(10, (b - a) / logisticScale));

    const softPenalty = 0.06; // v0.1.4 Optimized linear weight
    const scoreT1 =
      Math.abs(getWinProb(newAvgT1, avgT2) - 0.5) + (t1Count > t2Count ? (t1Count - t2Count) * softPenalty : 0);
    const scoreT2 = Math.abs(getWinProb(avgT1, newAvgT2) - 0.5) + ((t2Count > t1Count) ? (t2Count - t1Count) * softPenalty : 0);

    let targetTeam;
    if (scoreT1 < scoreT2) targetTeam = 1;
    else if (scoreT2 < scoreT1) targetTeam = 2;
    else targetTeam = t1Count <= t2Count ? 1 : 2;

    const reason = `Skill Balance (Scale 15): T1=${scoreT1.toFixed(3)}, T2=${scoreT2.toFixed(3)}`;

    // 5. FINAL SAFETY CHECK
    const wouldViolate = targetTeam === 1 ? t1Count + 1 - t2Count > effectiveMaxImbalance : t2Count + 1 - t1Count > effectiveMaxImbalance;
    if (wouldViolate) return { targetTeam: t1Count < t2Count ? 1 : 2, reason: 'Hard Population Limit Override' };

    return { targetTeam, reason };
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

    this.currentRoundEvents.push(event);

    // Incremental write to temp file for stability/crash recovery
    const tempPath = this.options.logPath + '.temp';
    fsPromises
      .appendFile(tempPath, JSON.stringify(event) + '\n', 'utf8')
      .catch((err) => Logger.verbose('SmartAssign', 1, `Failed to write temp log: ${err.message}`));
  }

  async finalizeRoundLog() {
    if (this.currentRoundEvents.length === 0) {
      // Check if there's a temp file we can recover (e.g. after crash)
      await this.loadTempEvents();
      if (this.currentRoundEvents.length === 0) return;
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
      this.currentRoundEvents = lines.filter((l) => l.trim()).map((l) => JSON.parse(l));
      Logger.verbose(
        'SmartAssign',
        1,
        `Loaded ${this.currentRoundEvents.length} events from temp log.`
      );
    } catch (err) {
      // File might not exist, which is fine
    }
  }
}
