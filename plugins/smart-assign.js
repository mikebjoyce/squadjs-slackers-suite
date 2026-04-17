/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  SMART ASSIGN PLUGIN v1.0.0                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Handles custom Elo-based player auto-assignment and records player
 * lifecycle events. Tracks joins, leaves, and team changes, managing 
 * reconnect memory and ensuring fair, balanced team assignments upon connection.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { appendFileSync, promises as fsPromises } from 'fs';
import Logger from '../../core/logger.js';
import SADatabase from '../utils/sa-database.js';
import SASwapExecutor from '../utils/sa-swap-executor.js';

export default class SmartAssign {
  static version = '1.0.0';

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
      logPath: {
        required: false,
        description: 'Path to JSONL file for player lifecycle events.',
        default: './auto-assign-log.jsonl',
        type: 'string'
      },
      maxImbalance: {
        required: false,
        description: 'Maximum player imbalance allowed before forcing balance.',
        default: 2,
        type: 'number'
      },
      highPopThreshold: {
        required: false,
        description: 'Total player count at which the plugin enforces strict 1-player max imbalance (overriding Elo/Reconnects).',
        default: 96,
        type: 'number'
      },
      imbalanceSoftPenalty: {
        required: false,
        description: 'Small Elo bonus given to the team with fewer players during evaluation. Prevents creating population gaps for negligible Elo gains.',
        default: 0.15,
        type: 'number'
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
    this.ready = false;

    // State bindings
    this.onNewGame = this.onNewGame.bind(this);
    this.onRoundEnded = this.onRoundEnded.bind(this);
    this.onUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
    this.onPlayerConnected = this.onPlayerConnected.bind(this);
    this.onScrambleExecuted = this.onScrambleExecuted.bind(this);
    this.onMoveFailed = this.onMoveFailed.bind(this);
  }

  async mount() {
    Logger.verbose('SmartAssign', 1, 'Mounting SmartAssign plugin.');

    // Initialize DB
    const { roundStartTime: persistedStartTime } = await this.db.initDB();

    // Check for restart recovery
    let serverRoundStart = this.server.matchStartTime ? this.server.matchStartTime.getTime() : null;
    if (!serverRoundStart && this.server.layerHistory && this.server.layerHistory.length > 0) {
      serverRoundStart = this.server.layerHistory[0].time.getTime();
    }

    const threeHours = 3 * 60 * 60 * 1000;
    if (persistedStartTime && serverRoundStart && Math.abs(persistedStartTime - serverRoundStart) < threeHours) {
      // It's a resume. Populate known players silently so they don't trigger "JOIN" events
      Logger.verbose('SmartAssign', 1, 'Restart detected. Resuming round state and silent-populating known players.');
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
      await this.db.clearReconnectMemory();
      const now = serverRoundStart || Date.now();
      await this.db.saveRoundStartTime(now);
      
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

    this.ready = true;
    Logger.verbose('SmartAssign', 1, 'SmartAssign mounted successfully.');
  }

  async unmount() {
    this.ready = false;
    this.server.removeListener('NEW_GAME', this.onNewGame);
    this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
    this.server.removeListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
    this.server.removeListener('SMART_ASSIGN_MOVE_FAILED', this.onMoveFailed);
    this.executor.cleanup();
    Logger.verbose('SmartAssign', 1, 'SmartAssign unmounted.');
  }

  async onNewGame(info) {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 1, 'NEW_GAME detected. Clearing reconnect memory.');
    await this.db.clearReconnectMemory();
    const now = this.server.matchStartTime ? this.server.matchStartTime.getTime() : Date.now();
    await this.db.saveRoundStartTime(now);
    
    // Clear known players so anyone connecting gets processed normally
    this.knownPlayers.clear();
  }

  async onRoundEnded(info) {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 1, 'ROUND_ENDED detected.');
    // We can clear reconnect memory here or on NEW_GAME. NEW_GAME is safer.
  }

  async onScrambleExecuted() {
    if (!this.ready) return;
    Logger.verbose('SmartAssign', 1, 'TeamBalancer Scramble detected. Marking team changes as Team-Balancer source for the next 20 seconds.');
    this.scrambleEndTime = Date.now() + 20000;
  }

  async onMoveFailed(data) {
    if (!this.ready) return;
    const { steamID, reason } = data;
    const p = this.server.players.find(x => x.steamID === steamID) || { steamID, name: 'Unknown' };
    Logger.verbose('SmartAssign', 1, `[SmartAssign] Abandoned move for ${p.name} (${steamID}) - ${reason}`);
    this.logEvent('MOVE_FAILED', p, { reason });
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
    const targetTeam = this.evaluateTeamAssignment(player, reconnectTeam);

    if (reconnectTeam && reconnectTeam === targetTeam) {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Applied reconnect memory for ${player.name} -> Team ${targetTeam}`);
    } else if (reconnectTeam && reconnectTeam !== targetTeam) {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Ignored reconnect memory for ${player.name} (High Pop Equity Enforced) -> Team ${targetTeam}`);
    } else {
      Logger.verbose('SmartAssign', 2, `[SmartAssign] Evaluated fresh join for ${player.name} -> Team ${targetTeam}`);
    }

    // If squad/engine put them on the wrong team natively (or they are unassigned)
    // we queue a move.
    if (String(player.teamID) !== String(targetTeam)) {
      this.executor.queueMove(player.steamID, targetTeam);
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

  evaluateTeamAssignment(player, reconnectTeam = null) {
    const eloTracker = this.server.plugins.find((p) => p.constructor.name === 'EloTracker');
    const hasElo = eloTracker && eloTracker.ready;

    let t1Count = 0;
    let t2Count = 0;
    let t1MuSum = 0;
    let t2MuSum = 0;

    for (const p of this.server.players) {
      if (p.steamID === player.steamID) continue;

      const isT1 = String(p.teamID) === '1';
      const isT2 = String(p.teamID) === '2';

      if (isT1) t1Count++;
      else if (isT2) t2Count++;

      if (hasElo && (isT1 || isT2)) {
        let mu = 25.0;
        if (eloTracker.eloCache && p.eosID && eloTracker.eloCache.has(p.eosID)) {
          mu = eloTracker.eloCache.get(p.eosID).mu;
        } else if (eloTracker.eloMap && p.steamID && eloTracker.eloMap.has(p.steamID)) {
          mu = eloTracker.eloMap.get(p.steamID);
        }

        if (isT1) t1MuSum += mu;
        else t2MuSum += mu;
      }
    }

    const totalPop = t1Count + t2Count;
    const highPopThreshold = this.options.highPopThreshold || 96;
    const maxImbalance = totalPop >= highPopThreshold ? 1 : this.options.maxImbalance || 2;

    // 1. Hard population imbalance — highest priority
    if (t1Count - t2Count >= maxImbalance) return 2;
    if (t2Count - t1Count >= maxImbalance) return 1;

    let playerMu = 25.0;
    if (hasElo) {
      if (eloTracker.eloCache && player.eosID && eloTracker.eloCache.has(player.eosID)) {
        playerMu = eloTracker.eloCache.get(player.eosID).mu;
      } else if (eloTracker.eloMap && player.steamID && eloTracker.eloMap.has(player.steamID)) {
        playerMu = eloTracker.eloMap.get(player.steamID);
      }
    }

    // 2. Reconnect preference — check both population AND Elo impact
    if (reconnectTeam) {
      const wouldViolatePop =
        reconnectTeam === 1
          ? t1Count + 1 - t2Count > maxImbalance
          : t2Count + 1 - t1Count > maxImbalance;

      if (!wouldViolatePop) {
        if (!hasElo) return reconnectTeam;

        // Only override reconnect if Elo gap is significant AND reconnect worsens it
        const currentEloDiff =
          t1Count > 0 && t2Count > 0 ? Math.abs(t1MuSum / t1Count - t2MuSum / t2Count) : 0;
        const ELO_OVERRIDE_THRESHOLD = 1.5; // mu units

        const sumGap = t1MuSum - t2MuSum;
        const eloPreferredTeam = Math.abs(sumGap + playerMu) < Math.abs(sumGap - playerMu) ? 1 : 2;

        // Honor reconnect unless it's the wrong Elo team AND the gap is already significant
        if (reconnectTeam === eloPreferredTeam || currentEloDiff < ELO_OVERRIDE_THRESHOLD) {
          return reconnectTeam;
        }
        Logger.verbose(
          'SmartAssign',
          2,
          `[SmartAssign] Overriding reconnect for ${player.name} due to significant Elo imbalance.`
        );
      }
    }

    // 3. No Elo data → pure population balance
    if (!hasElo) return t1Count <= t2Count ? 1 : 2;

    // 4. Minimize Elo sum gap
    const sumGap = t1MuSum - t2MuSum;
    const diffIfT1 = Math.abs(sumGap + playerMu);
    const diffIfT2 = Math.abs(sumGap - playerMu);

    let targetTeam;
    if (diffIfT1 < diffIfT2) targetTeam = 1;
    else if (diffIfT2 < diffIfT1) targetTeam = 2;
    else targetTeam = t1Count <= t2Count ? 1 : 2; // Tie → population balance

    // 5. Final pop safety check
    const wouldViolate =
      targetTeam === 1 ? t1Count + 1 - t2Count > maxImbalance : t2Count + 1 - t1Count > maxImbalance;

    if (wouldViolate) targetTeam = t1Count < t2Count ? 1 : 2;

    return targetTeam;
  }

  logEvent(eventType, player, extraData = {}) {
    if (!this.options.logPath) return;

    const record = {
      timestamp: Date.now(),
      eventType,
      steamID: player.steamID,
      name: player.name,
      teamID: player.teamID,
      squadID: player.squadID,
      layerName: this.server.currentLayer ? this.server.currentLayer.name : 'Unknown',
      gamemode: this.server.currentLayer ? this.server.currentLayer.gamemode : 'Unknown',
      ...extraData
    };

    fsPromises.appendFile(this.options.logPath, JSON.stringify(record) + '\n', 'utf8')
      .catch(err => Logger.verbose('SmartAssign', 1, `Failed to write log: ${err.message}`));
  }
}
