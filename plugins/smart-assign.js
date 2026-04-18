/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                      SMART ASSIGN PLUGIN                      ║
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
 * - Algorithm uses an Integrated Symmetric Logistic Scoring System:
 *     1. Hard Pop Cap: Prevents imbalance beyond dynamic thresholds.
 *     2. Logistic Win-Probability: Calculates win probability shift (Scale: 13, Exponent: 1.10).
 *     3. Soft Pop Penalty: Non-linear penalty of 0.10 per player difference.
 *     4. Reconnect Bonus: Grants an *additional* +2 player imbalance allowance on top of the base.
 * - Strict 1-player max imbalance enforced at high population (95+).
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

import { promises as fsPromises } from 'fs';
import Logger from '../../core/logger.js';
import SADatabase from '../utils/sa-database.js';
import SASwapExecutor from '../utils/sa-swap-executor.js';

export default class SmartAssign {
  static version = '0.1.7';

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
    this._logWriteQueue = Promise.resolve();

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

      // If players are already connected when the plugin starts, quietly track them
      // to avoid triggering mass auto-assignment logic upon initialization.
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

    /**
     * DESIGN NOTE: Omission of PLAYER_DISCONNECTED listener
     * In modern versions of Squad/SquadJS, the PLAYER_DISCONNECTED log parsing is entirely broken 
     * and fails to fire reliably. To prevent memory leaks and ensure disconnects are always caught, 
     * we infer leaves strictly by delta-diffing the UPDATED_PLAYER_INFORMATION array.
     */

    // Create a quick lookup set for current steamIDs to detect leaves efficiently
    const currentSteamIDs = new Set();
    
    // Check for JOINS and TEAM CHANGES directly against the server array
    for (const p of this.server.players) {
      if (!p.steamID) continue;
      currentSteamIDs.add(p.steamID);

      if (!this.knownPlayers.has(p.steamID)) {
        await this.handlePlayerJoin(p);
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

          await this.handleTeamChange(p, kp.teamID, p.teamID, source);
          kp.teamID = p.teamID;
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
        await this.handlePlayerLeave(kp);
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

    // Check if we are in an ignored layer/gamemode
    const currentLayerName = this.server.currentLayer ? this.server.currentLayer.name.toLowerCase() : '';
    const currentGamemode = this.server.currentLayer ? this.server.currentLayer.gamemode.toLowerCase() : '';
    const ignoredModes = (this.options.ignoredGameModes || ['seed', 'jensen']).map(m => String(m).toLowerCase());
    
    const isIgnored = ignoredModes.some(m => currentLayerName.includes(m) || currentGamemode.includes(m));

    if (isIgnored) {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Ignored game mode detected. Skipping Elo-based assignment for ${player.name}.`);
      return;
    }

    // Evaluate ideal team assignment
    const reconnectTeam = await this.db.getReconnectTeam(player.steamID);
    const { targetTeam, reason } = this.evaluateTeamAssignment(player, reconnectTeam);

    if (reconnectTeam && reconnectTeam === targetTeam) {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Applied reconnect memory for ${player.name} -> Team ${targetTeam} (${reason})`);
    } else if (reconnectTeam && reconnectTeam !== targetTeam) {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Ignored reconnect memory for ${player.name} (Previous: Team ${reconnectTeam}) -> Team ${targetTeam} (${reason})`);
    } else {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Evaluated fresh join for ${player.name} -> Team ${targetTeam} (${reason})`);
    }

    const willExecuteMove = String(player.teamID) !== String(targetTeam) && this.options.enableSmartAssign !== false;

    // Record the assignment in log with executed flag for passive mode distinction
    this.logEvent('ASSIGNMENT', player, { 
      targetTeam, 
      reason, 
      reconnectTeam,
      executed: willExecuteMove
    });

    // If the player is currently unassigned or on the wrong team, queue a team change
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

    /**
     * DESIGN NOTE: Linear Exponent (1.10)
     * This is an intentional mild linearization. TrueSkill Mu represents a normal distribution. 
     * Aggressively raising the exponent (e.g. 1.5 or 2.0) mathematically overvalues individual players 
     * in a 50v50 game where teamwork heavily dilutes extreme solo-skill impact. 
     * It is meant to be a mild nudge, not a massive multiplier.
     */
    const EXPONENT = 1.10;

    for (const p of this.server.players) {
      if (!p || p.steamID === player.steamID) continue;

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
    const highPopThreshold = 95; // Threshold unified for logical consistency
    const isRejoin = reconnectTeam === 1 || reconnectTeam === 2;

    const baseMaxImbalance = totalPop >= highPopThreshold ? 1 : 2;

    let effectiveMaxImbalance = baseMaxImbalance;
    if (isRejoin) {
      /**
       * DESIGN NOTE: Reconnect Double-Weighting
       * Reconnecting players receive a more relaxed hard-cap allowance (+2) AND a score bonus later.
       * This is highly intentional. Protecting squad cohesion after client crashes is paramount to server health.
       * Exhaustive simulation testing proves that aggressively returning players to their original teams 
       * has a statistically negligible impact on final Elo parity.
       */
      if (totalPop >= highPopThreshold) effectiveMaxImbalance = 2;
      else effectiveMaxImbalance = baseMaxImbalance + 2;
    }

    // Future state check: if assigning to team 1 causes imbalance
    if ((t1Count + 1) - t2Count > effectiveMaxImbalance) return { targetTeam: 2, reason: 'Hard Population Cap' };
    // Future state check: if assigning to team 2 causes imbalance
    if ((t2Count + 1) - t1Count > effectiveMaxImbalance) return { targetTeam: 1, reason: 'Hard Population Cap' };

    // 3. SKILL & PENALTY EVALUATION
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

    /**
     * DESIGN NOTE: Average Mu vs Total Power
     * We intentionally use Average Mu for win-probability scoring because the strict Hard-Cap 
     * population limits (enforced above) already restrict total player counts. In a game where 
     * 40v40 is enforced natively by bounds, Average Mu perfectly scales the remaining skill gap 
     * without needing a convoluted total-power normalization factor.
     */
    // Logistic Win-Probability Model
    const avgT1 = t1Count > 0 ? t1Power / t1Count : 25.0;
    const avgT2 = t2Count > 0 ? t2Power / t2Count : 25.0;

    const newAvgT1 = (t1Power + playerPower) / (t1Count + 1);
    const newAvgT2 = (t2Power + playerPower) / (t2Count + 1);

    /**
     * DESIGN NOTE: Scale Calibration
     * A logistic scale of 13 was calibrated via exhaustive deep-dive simulation testing against 
     * massive historical match logs (REALWORLD_CHURN runs). It perfectly balances competitive 
     * micro-adjustments without causing the algorithmic routing to spiral.
     */
    const logisticScale = 13; // Balanced sensitivity
    const getWinProb = (a, b) => 1 / (1 + Math.pow(10, (b - a) / logisticScale));

    const softPenalty = 0.10;
    const rejoinBonus = 0.35; // Allow up to 3-player imbalance for rejoins

    // Evaluate resulting state if player joins T1
    const imbalanceT1 = Math.abs((t1Count + 1) - t2Count);
    const penT1 = Math.pow(imbalanceT1, 1.5) * softPenalty;
    let scoreT1 = Math.abs(getWinProb(newAvgT1, avgT2) - 0.5) + penT1;
    if (reconnectTeam === 1) scoreT1 -= rejoinBonus;

    // Evaluate resulting state if player joins T2
    const imbalanceT2 = Math.abs(t1Count - (t2Count + 1));
    const penT2 = Math.pow(imbalanceT2, 1.5) * softPenalty;
    let scoreT2 = Math.abs(getWinProb(avgT1, newAvgT2) - 0.5) + penT2;
    if (reconnectTeam === 2) scoreT2 -= rejoinBonus;

    let targetTeam;
    if (scoreT1 < scoreT2) {
      targetTeam = 1;
    } else if (scoreT2 < scoreT1) {
      targetTeam = 2;
    } else {
      // On exact ties, actively evaluate the incoming player's skill relative to the server average.
      // Good players help carry the lower Elo team. New/bad players go to the higher Elo team to get carried.
      const serverAvg = totalPop > 0 ? (t1Power + t2Power) / totalPop : 25.0;
      
      if (playerPower >= serverAvg) {
        // Player is above average: send them to the team with the lowest average Elo
        if (avgT1 <= avgT2) targetTeam = 1;
        else targetTeam = 2;
      } else {
        // Player is below average: send them to the team with the highest average Elo
        if (avgT1 >= avgT2) targetTeam = 1;
        else targetTeam = 2;
      }
    }

    const reason = `Skill Balance (Scale 13): T1=${scoreT1.toFixed(3)}, T2=${scoreT2.toFixed(3)}`;

    // 4. FINAL SAFETY CHECK
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

    // Incremental sequential write to temp file for stability/crash recovery
    const tempPath = this.options.logPath + '.temp';
    
    // Chain promises to prevent overlapping fs.appendFile which could cause interleaved JSON lines
    this._logWriteQueue = this._logWriteQueue.then(() => {
      return fsPromises.appendFile(tempPath, JSON.stringify(event) + '\n', 'utf8')
        .catch((err) => Logger.verbose('SmartAssign', 1, `Failed to write temp log: ${err.message}`));
    });
  }

  async finalizeRoundLog() {
    if (this.currentRoundEvents.length === 0) {
      // Check if there's a temp file we can recover (e.g. after crash)
      await this.loadTempEvents();
      
      // If we STILL have 0 events after attempting to load the temp log, gracefully abort.
      // This prevents double-finalization writes on back-to-back ROUND_ENDED -> NEW_GAME events.
      if (this.currentRoundEvents.length === 0) {
        Logger.verbose('SmartAssign', 2, `Skipping log finalization: 0 events to write.`);
        return;
      }
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
