/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║            UNIFIED-TEST-RUNNER (SmartAssign) v1.0.0           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Comprehensive test harness for SmartAssign's assignment algorithm.
 * Replays historical match events (JOIN, LEAVE, TEAM_CHANGE) against
 * both a baseline (vanilla Squad) and the SmartAssign plugin, measuring
 * Elo balance, forced moves, reconnect success rates, and clan coherence.
 *
 * Supports three replay scenarios:
 *   - Historical matches (from JSONL event logs with real player data)
 *   - Synthetic matches (pattern-based generation from churn statistics)
 *   - Prolonged peak matches (10-50+ hour simulations at 95-100 population)
 *
 * ─── USAGE ─────────────────────────────────────────────────────
 *
 * node unified-test-runner.js <log.jsonl> [--elo <backup.json>] [--exhaustive] [--repl [match_idx]]
 *
 *   <log.jsonl>           Event log from sa-event-logger.js (historical matches)
 *   --elo <backup.json>   Load real Mu values from EloTracker backup (optional)
 *   --exhaustive          Enable verbose per-join logging for all events
 *   --repl [match_idx]    Start interactive REPL (optional: initialize from match_idx)
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * simulateHistoricalMatch(match, engineConfig, seededRandom, logStream, targetInitialPop)
 *   — Simulates a match against an engine (Baseline or SmartAssign).
 *     Returns metrics: avgGap, avgSumGap, forcedMoves, rejoinRate, clanCoherence, etc.
 *
 * startREPL(eloMap, initialMatch)
 *   — Interactive command-line prompt for manual testing and debugging.
 *
 * ─── DEV-ONLY WARNING ─────────────────────────────────────────────
 *
 * This file is intended for development, testing, and algorithm validation only.
 * It is NOT intended for production deployment. Do not include testing/
 * in production SquadJS installations.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import SmartAssign from '../plugins/smart-assign.js';
import { extractRawPrefix, buildPlayerTagCache } from '../utils/sa-clan-grouper.js';

const MAX_TEAM_SIZE = 50;

// --- Seeded Random ---
class SeededRandom {
  constructor(seed = 12345) {
    this.seed = seed;
  }
  next() {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }
}

// --- Mocks ---
class MockSADatabase {
  constructor() {
    this.reconnectMemory = new Map();
    this.roundStartTime = Date.now();
  }
  async initDB() { return { roundStartTime: this.roundStartTime }; }
  async saveRoundStartTime(ts) { this.roundStartTime = ts; }
  async clearReconnectMemory() { this.reconnectMemory.clear(); }
  async savePlayerDisconnect(steamID, teamID) { this.reconnectMemory.set(steamID, { teamID, time: Date.now() }); }
  async getReconnectTeam(steamID) { return this.reconnectMemory.get(steamID)?.teamID || null; }
  async getAllReconnectMemory() { return new Map(this.reconnectMemory); }
  async cleanupOldData() {}
}

class MockServer {
  constructor() {
    this.players = [];
    this.plugins = [];
    this.matchStartTime = new Date();
    this.listeners = new Map();
    this.currentLayer = { name: 'Unknown', gamemode: 'Unknown' };
    this.virtualTime = 0;
  }
  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }
  removeListener(event, handler) {
    if (!this.listeners.has(event)) return;
    this.listeners.set(event, this.listeners.get(event).filter(h => h !== handler));
  }
  async emit(event, data) {
    if (!this.listeners.has(event)) return;
    for (const handler of this.listeners.get(event)) await handler(data);
  }
  getPlayerBySteamID(steamID) {
    return this.players.find(p => p.steamID === steamID);
  }
  async updatePlayerList() {
    // No-op stub: in production this forces an RCON poll. 
    // In tests, player list is managed directly by the simulation.
  }
}

class EloTracker {
  constructor(server, eloMap) {
    this.server = server;
    this.ready = true;
    this.eloMap = eloMap;
  }
  getMu(player) {
    return this.eloMap.get(player.steamID) || 25.0;
  }
  buildRoundStartData() {
    let t1Mu = 0, t1Count = 0, t2Mu = 0, t2Count = 0;
    for (const p of this.server.players) {
      const mu = this.eloMap.get(p.steamID) || 25.0;
      if (String(p.teamID) === '1') { t1Mu += mu; t1Count++; }
      else if (String(p.teamID) === '2') { t2Mu += mu; t2Count++; }
    }
    return {
      t1: { count: t1Count, avgMu: t1Count ? t1Mu / t1Count : 25.0, sumMu: t1Mu },
      t2: { count: t2Count, avgMu: t2Count ? t2Mu / t2Count : 25.0, sumMu: t2Mu }
    };
  }
}

class MockSASwapExecutor {
  constructor(server) { 
    this.server = server; 
    this.moveCount = 0;
    this.recentMoves = new Map();
  }
  isRecentSmartAssignMove(steamID, newTeamID) { 
    const move = this.recentMoves.get(steamID);
    if (!move) return false;
    if (move.teamID !== Number(newTeamID)) return false;
    return (this.server.virtualTime - move.time) <= 15000;
  }
  async queueMove(steamID, targetTeam) {
    if (targetTeam === null) return;
    const p = this.server.players.find(p => p.steamID === steamID);
    if (!p) return;

    const t1Count = this.server.players.filter(x => String(x.teamID) === '1').length;
    const t2Count = this.server.players.filter(x => String(x.teamID) === '2').length;
    
    // Simulate RCON rejection if target team is physically full
    if (Number(targetTeam) === 1 && t1Count >= MAX_TEAM_SIZE) {
      await this.server.emit('SMART_ASSIGN_MOVE_FAILED', { steamID, reason: 'Team Full' });
      return;
    }
    if (Number(targetTeam) === 2 && t2Count >= MAX_TEAM_SIZE) {
      await this.server.emit('SMART_ASSIGN_MOVE_FAILED', { steamID, reason: 'Team Full' });
      return;
    }

    if (p.teamID !== Number(targetTeam) && p.teamID !== null) this.moveCount++;
    p.teamID = Number(targetTeam);
    this.recentMoves.set(steamID, { teamID: Number(targetTeam), time: this.server.virtualTime });
    
    // Tie into the test runner's virtual timeline to simulate network/engine delay
    if (this.server.timeline) {
      this.server.timeline.push({ 
        type: 'MOVE_SUCCESS', 
        time: this.server.virtualTime + 1000, 
        steamID, 
        teamID: Number(targetTeam) 
      });
      this.server.timeline.sort((a, b) => a.time - b.time || (a.type === 'LEAVE' ? -1 : 1));
    } else {
      await this.server.emit('SMART_ASSIGN_MOVE_SUCCESS', { steamID, teamID: Number(targetTeam) });
    }
  }
  cleanup() {
    this.recentMoves.clear();
  }
}

// MockRandomAssign is intentionally passive because standard Squad servers natively
// place joining players on the team with the lowest population. The test
// runner's "Baseline" represents this exact vanilla behavior without any extra
// plugin intervention. 
class MockRandomAssign {
  constructor(server) {
    this.server = server;
    this.executor = { moveCount: 0, queueMove: async () => {} };
  }
  async mount() {}
  unmount() {}
}

// --- Data Utilities ---

function inferPlayerEvents(match, seededRandom, targetInitialPop) {
  const events = [];
  const duration = match.roundDuration || 3600000;
  
  let initialPopCount = 0;

  // Sort players to put the most active ones in the initial population
  const sortedPlayers = [...match.players].sort((a, b) => b.participationRatio - a.participationRatio);

  for (const p of sortedPlayers) {
    const playTime = duration * p.participationRatio;
    
    let startAtZero = false;
    if (initialPopCount < targetInitialPop) {
      startAtZero = true;
    } else if (p.participationRatio > 0.95 && targetInitialPop > 0) {
      startAtZero = true;
    }

    if (startAtZero) {
      events.push({ type: 'JOIN', time: 0, player: p });
      initialPopCount++;
      
      if (p.participationRatio <= 0.95) {
        if (seededRandom.next() < 0.15 && playTime > 300000) { // Bumped crash rate slightly for more reconnects
          const crashTime = playTime / 2;
          events.push({ type: 'LEAVE', time: crashTime, player: p });
          events.push({ type: 'JOIN', time: crashTime + 180000, player: p });
          events.push({ type: 'LEAVE', time: playTime + 180000, player: p });
        } else {
          events.push({ type: 'LEAVE', time: playTime, player: p });
        }
      }
    } else {
      // Late joiners
      // To simulate a highly populated server, players are queued aggressively
      // They will hit the 100-player queue limit natively handled in the simulation
      const startTime = Math.floor(seededRandom.next() * (duration / 4));
      events.push({ type: 'JOIN', time: startTime, player: p });
      
      if (seededRandom.next() < 0.15 && playTime > 300000) {
        const crashTime = startTime + (playTime / 2);
        events.push({ type: 'LEAVE', time: crashTime, player: p });
        events.push({ type: 'JOIN', time: crashTime + 180000, player: p });
      }
    }
  }

  return events.sort((a, b) => a.time - b.time || (a.type === 'LEAVE' ? -1 : 1));
}

function analyzeChurnStatistics(matches) {
  let totalPlayers = 0;
  let totalDuration = 0;
  const ratios = [];

  for (const m of matches) {
    totalPlayers += m.players.length;
    totalDuration += m.roundDuration || 0;
    for (const p of m.players) ratios.push(p.participationRatio);
  }

  return {
    avgPlayersPerMatch: totalPlayers / matches.length,
    avgDuration: totalDuration / matches.length,
    ratios: ratios.sort((a, b) => a - b)
  };
}

function generateFakeMatch(stats, seededRandom, allBackupMus) {
  const playerCount = Math.floor(stats.avgPlayersPerMatch * (0.8 + seededRandom.next() * 0.4));
  const duration = stats.avgDuration * (0.9 + seededRandom.next() * 0.2);
  const players = [];

  for (let i = 0; i < playerCount; i++) {
    // Pick a participation ratio from the real distribution
    const ratio = stats.ratios[Math.floor(seededRandom.next() * stats.ratios.length)];
    let mu = 25;
    if (allBackupMus && allBackupMus.length > 0) {
      mu = allBackupMus[Math.floor(seededRandom.next() * allBackupMus.length)];
    } else {
      mu = 20 + seededRandom.next() * 10;
    }
    players.push({
      eosID: `FAKE_${i}`,
      name: `FakePlayer_${i}`,
      participationRatio: ratio,
      muBefore: mu
    });
  }

  return {
    layerName: 'Generated Layer',
    gameMode: 'Generated Mode',
    roundDuration: duration,
    players
  };
}

function generateProlongedMatch(seededRandom, allBackupMus, durationHours = 10) {
  return {
    isProlonged: true,
    layerName: `Constant Peak (${durationHours} hours)`,
    gameMode: 'Prolonged Mode',
    roundDuration: durationHours * 3600000,
    players: [], // Generated dynamically
    allBackupMus
  };
}

function generateProlongedTimeline(match, seededRandom) {
  const events = [];
  const duration = match.roundDuration;
  
  let nextPlayerId = 0;
  const getNextPlayer = () => {
    const id = nextPlayerId++;
    let mu = 25;
    if (match.allBackupMus && match.allBackupMus.length > 0) {
      mu = match.allBackupMus[Math.floor(seededRandom.next() * match.allBackupMus.length)];
    } else {
      mu = 20 + seededRandom.next() * 10;
    }
    return { eosID: `PROLONGED_${id}`, name: `PeakPlayer_${id}`, muBefore: mu };
  };

  // Start with 100 players at time 0
  const activePlayers = new Set();
  for (let i = 0; i < 100; i++) {
    const p = getNextPlayer();
    events.push({ type: 'JOIN', time: 0, player: p });
    activePlayers.add(p);
  }

  let currentPop = 100;
  for (let time = 60000; time < duration; time += 60000) {
    // 10% chance per minute for someone to leave normally
    if (seededRandom.next() < 0.1 && activePlayers.size > 0) {
      const p = Array.from(activePlayers)[Math.floor(seededRandom.next() * activePlayers.size)];
      activePlayers.delete(p);
      events.push({ type: 'LEAVE', time, player: p });
      currentPop--;
    }
    
    // 5% chance per minute for someone to crash and rejoin 3 mins later
    if (seededRandom.next() < 0.05 && activePlayers.size > 0) {
      const p = Array.from(activePlayers)[Math.floor(seededRandom.next() * activePlayers.size)];
      activePlayers.delete(p);
      events.push({ type: 'LEAVE', time, player: p });
      currentPop--;
      
      // They try to rejoin 3 mins later
      events.push({ type: 'JOIN', time: time + 180000, player: p });
      // Schedule their final departure 2 hours later so they don't pile up
      events.push({ type: 'LEAVE', time: time + 180000 + 7200000, player: p });
    }
    
    // Aggressively refill the server back to 100 to simulate a full queue
    while (currentPop < 100) {
      const newP = getNextPlayer();
      // Join instantly (1-5 seconds after someone leaves) to steal the slot
      events.push({ type: 'JOIN', time: time + 1000 + Math.floor(seededRandom.next() * 4000), player: newP });
      activePlayers.add(newP);
      currentPop++;
    }
  }

  return events.sort((a, b) => a.time - b.time || (a.type === 'LEAVE' ? -1 : 1));
}

// --- Simulation Logic ---

async function simulateHistoricalMatch(match, engineConfig, seededRandom, logStream = null, targetInitialPop = 80) {
  const localEloMap = new Map();
  const server = new MockServer();
  const mockEloTracker = new EloTracker(server, localEloMap);
  server.plugins.push(mockEloTracker);
  server.currentLayer = { name: match.layerName, gamemode: match.gameMode };

  const plugin = new engineConfig.Class(server, engineConfig.options);
  plugin.db = new MockSADatabase();
  plugin.executor = new MockSASwapExecutor(server);
  
  if (engineConfig.name.includes('SMART ASSIGN')) {
    plugin.logEvent = (type, player, data) => {
      if (type === 'ASSIGNMENT') {
        server.eventLog.push(`[ALGO] ${player.name} -> T${data.targetTeam} (Executed: ${data.executed}): ${data.reason}`);
        if (data.reason === 'Clan Grouping') {
          clanCaused++;
        }
      }
    };
  }

  await plugin.mount();
  server.eventLog = [];

  // Clan coherence tracking initialization
  const playerTagCache = match.isProlonged
    ? new Map()
    : buildPlayerTagCache(match.players, { caseSensitive: false });
  let clanApplicable = 0;
  let clanCoherent = 0;
  let clanCaused = 0;

  const timeline = match.isProlonged
    ? generateProlongedTimeline(match, seededRandom) 
    : inferPlayerEvents(match, seededRandom, targetInitialPop);
  server.timeline = timeline;
  const eloHistory = [];
  let totalUnbalancedTime = 0;
  let totalActiveTime = 0;
  let totalTimeWeightedEloGap = 0;
  let totalTimeWeightedSumGap = 0;
  let lastTimestamp = 0;
  let rejoinOpportunities = 0;
  let rejoinSuccesses = 0;

  if (logStream && engineConfig.name.includes('SMART ASSIGN')) {
    logStream.write(`================================================================================\n`);
    const countStr = match.isProlonged ? 'Dynamic (Peak Capacity)' : match.players.length;
    logStream.write(`MATCH START: ${match.layerName} | Players: ${countStr}\n`);
    logStream.write(`================================================================================\n\n`);
  }
  
  while (timeline.length > 0) {
    const event = timeline.shift();
    
    // Ignore events that happen after the match ends
    if (event.time > (match.roundDuration || 3600000)) continue;

    const timeStep = event.time - lastTimestamp;
    const currentData = mockEloTracker.buildRoundStartData();
    if (Math.abs(currentData.t1.count - currentData.t2.count) > 1) {
      totalUnbalancedTime += timeStep;
    }
    
    if (currentData.t1.count > 0 && currentData.t2.count > 0) {
      totalActiveTime += timeStep;
      totalTimeWeightedEloGap += Math.abs(currentData.t1.avgMu - currentData.t2.avgMu) * timeStep;
      totalTimeWeightedSumGap += Math.abs(currentData.t1.sumMu - currentData.t2.sumMu) * timeStep;
    }

    server.virtualTime = event.time;
    lastTimestamp = event.time;
    const p = event.player;
    const steamID = p ? p.eosID : event.steamID; // Use EOS as Steam for simplicity in test

    if (event.type === 'MOVE_SUCCESS') {
      const playerObj = server.getPlayerBySteamID(event.steamID);
      if (playerObj) {
        playerObj.teamID = event.teamID;
      }
      await server.emit('SMART_ASSIGN_MOVE_SUCCESS', { steamID: event.steamID, teamID: event.teamID });
      
      // Also emit UPDATED_PLAYER_INFORMATION with delay, mimicking engine
      setTimeout(async () => {
        await server.emit('UPDATED_PLAYER_INFORMATION', {});
      }, 0);
    } else if (event.type === 'JOIN') {
      // 100 Player Server Cap Enforced
      if (server.players.length >= 100) {
        // Player sits in queue. Try again in 30 seconds of virtual time.
        event.time += 30000;
        timeline.push(event);
        timeline.sort((a, b) => a.time - b.time || (a.type === 'LEAVE' ? -1 : 1));
        continue;
      }

      const reconnectTeam = await plugin.db.getReconnectTeam(steamID);
      
      // Expected Behavior: The "Natural Team" is calculated exactly as standard Squad does:
      // simply assigning to the team with the lowest population.
      // The player is intentionally NOT forced onto their `reconnectTeam` natively. 
      // This forces SmartAssign to actively execute an RCON move if its Elo or Rejoin 
      // logic demands a different team, accurately increasing the `forcedMoves` metric 
      // and proving its ability to fix native assignments.
      let naturalTeam = null;
      const t1Count = server.players.filter(x => String(x.teamID) === '1').length;
      const t2Count = server.players.filter(x => String(x.teamID) === '2').length;
      
      if (t1Count < MAX_TEAM_SIZE || t2Count < MAX_TEAM_SIZE) {
        naturalTeam = t1Count <= t2Count ? 1 : 2;
      }

       const playerObj = {
         steamID,
         eosID: steamID,
         name: p.name,
         teamID: naturalTeam,
         squadID: null
       };
      
      if (reconnectTeam) rejoinOpportunities++;

      localEloMap.set(steamID, Number(p.muBefore) || 25);
      server.players.push(playerObj);

      const preTickData = mockEloTracker.buildRoundStartData();
      const preTickMoves = plugin.executor.moveCount || 0;
      const initialEventLogCount = server.eventLog.length;

      // Wait for move to settle
      await server.emit('PLAYER_CONNECTED', { player: playerObj });
      
      // Manually trigger the UPDATED_PLAYER_INFORMATION which is what SmartAssign 
      // uses to track current team state in modern SquadJS
      await server.emit('UPDATED_PLAYER_INFORMATION', {});

      if (reconnectTeam && playerObj.teamID === reconnectTeam) {
        rejoinSuccesses++;
      }

      // Clan coherence tracking
      const rawTag = extractRawPrefix(p.name);
      const normTag = rawTag ? rawTag.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : null;
      playerTagCache.set(steamID, normTag);
      
      if (normTag) {
        let t1Clan = 0, t2Clan = 0;
        for (const sp of server.players) {
          if (sp.steamID === steamID) continue;
          const spTag = playerTagCache.get(sp.steamID);
          if (spTag && spTag === normTag) {
            if (String(sp.teamID) === '1') t1Clan++;
            else if (String(sp.teamID) === '2') t2Clan++;
          }
        }
        if ((t1Clan >= 1 && t2Clan === 0) || (t2Clan >= 1 && t1Clan === 0)) {
          clanApplicable++;
          const clanTeam = t1Clan > 0 ? 1 : 2;
          if (String(playerObj.teamID) === String(clanTeam)) clanCoherent++;
        }
      }

      if (logStream && engineConfig.name.includes('SMART ASSIGN')) {
        const postTickMoves = plugin.executor.moveCount;
        const postData = mockEloTracker.buildRoundStartData();
        const postGap = Math.abs(postData.t1.avgMu - postData.t2.avgMu);
        const preGap = Math.abs(preTickData.t1.avgMu - preTickData.t2.avgMu);

        let algoReason = "None (No Plugin Intervention)";
        if (server.eventLog.length > initialEventLogCount) {
          algoReason = server.eventLog[server.eventLog.length - 1];
        }

        const missedReconnect = reconnectTeam && playerObj.teamID !== reconnectTeam;
        const moveExecuted = postTickMoves > preTickMoves;

        if (moveExecuted || missedReconnect) {
          logStream.write(`  [Time: ${server.virtualTime}ms] Event: ${p.name} (Elo: ${Number(p.muBefore || 25).toFixed(1)})\n`);
          if (missedReconnect) {
            logStream.write(`      *** MISSED RECONNECT *** (Expected: T${reconnectTeam}, Actual: T${playerObj.teamID})\n`);
          }
          if (moveExecuted) {
            logStream.write(`      *** MOVE EXECUTED ***\n`);
          }
          logStream.write(`      Native Spawn: Team ${naturalTeam} | Reconnect Memory: ${reconnectTeam ? 'Team '+reconnectTeam : 'None'}\n`);
          logStream.write(`      Logic: ${algoReason}\n`);
          logStream.write(`      State: T1 Pop: ${postData.t1.count} | T2 Pop: ${postData.t2.count} | Avg Gap: ${postGap.toFixed(3)}\n\n`);
        }
      }
    } else if (event.type === 'LEAVE') {
      const idx = server.players.findIndex(x => x.steamID === steamID);
      if (idx !== -1) {
        server.players.splice(idx, 1);
        await server.emit('UPDATED_PLAYER_INFORMATION', {});
      }
    }

    // Record ELO gap after each event
    const data = mockEloTracker.buildRoundStartData();
    eloHistory.push({
      time: server.virtualTime,
      eloGap: Math.abs(data.t1.avgMu - data.t2.avgMu),
      sumMuGap: Math.abs(data.t1.sumMu - data.t2.sumMu),
      pop: data.t1.count + data.t2.count,
      t1Count: data.t1.count,
      t2Count: data.t2.count
    });
  }

  // Snapshot-based averaging (theoretical algorithm testing)
  const activeHistory = eloHistory.filter(h => h.t1Count > 0 && h.t2Count > 0);
  const avgGap = activeHistory.length > 0 
    ? activeHistory.reduce((acc, h) => acc + h.eloGap, 0) / activeHistory.length 
    : 0;
  
  const avgSumGap = activeHistory.length > 0
    ? activeHistory.reduce((acc, h) => acc + h.sumMuGap, 0) / activeHistory.length
    : 0;

  const unbalancedPercent = activeHistory.length > 0
    ? (activeHistory.filter(h => Math.abs(h.t1Count - h.t2Count) > 1).length / activeHistory.length) * 100
    : 0;

  if (logStream && engineConfig.name.includes('SMART ASSIGN')) {
    logStream.write(`================================================================================\n`);
    logStream.write(`MATCH END: ${match.layerName}\n`);
    logStream.write(`Final Avg Gap: ${avgGap.toFixed(3)} | Total Moves: ${plugin.executor.moveCount}\n`);
    logStream.write(`================================================================================\n\n\n`);
  }

  return {
    name: engineConfig.name,
    eloHistory,
    finalGap: eloHistory.length > 0 ? eloHistory[eloHistory.length - 1].eloGap : 0,
    avgGap,
    avgSumGap,
    forcedMoves: plugin.executor.moveCount,
    unbalancedPercent,
    rejoinRate: rejoinOpportunities > 0 ? (rejoinSuccesses / rejoinOpportunities) * 100 : null,
    rejoinOpp: rejoinOpportunities,
    rejoinSucc: rejoinSuccesses,
    clanApplicable,
    clanCoherent,
    clanCaused,
    clanCoherence: clanApplicable > 0 ? clanCoherent / clanApplicable : null
  };
}

// --- REPL ---

function formatPlayerList(players, eloMap) {
  if (players.length === 0) return 'Empty';
  const items = players.map(p => {
    const elo = eloMap.get(p.steamID) || 25;
    return `${p.name}(${elo.toFixed(1)})`;
  });
  
  const lines = [];
  for (let i = 0; i < items.length; i += 4) {
    lines.push(items.slice(i, i + 4).join(', '));
  }
  return lines.map((line, idx) => (idx === 0 ? '' : '               ') + line).join('\n');
}

async function startREPL(eloMap, initialMatch = null) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'sjs-test > '
  });

  console.log('\n--- SmartAssign Interactive REPL (Strict 50v50) ---');
  console.log('Commands: join <name> <elo>, leave <name>, time <ms>, status, help, exit\n');

  const server = new MockServer();
  const mockEloTracker = new EloTracker(server, eloMap);
  server.plugins.push(mockEloTracker);
  const plugin = new SmartAssign(server, { enableSmartAssign: true });
  plugin.db = new MockSADatabase();
  plugin.executor = new MockSASwapExecutor(server);

  server.on('SMART_ASSIGN_MOVE_SUCCESS', (data) => {
    const p = server.getPlayerBySteamID(data.steamID);
    console.log(`[ALGO] Moving ${p?.name || data.steamID} to Team ${data.teamID}...`);
  });

  await plugin.mount();

  if (initialMatch) {
    console.log(`[REPL] Initializing state from: ${initialMatch.layerName} (${initialMatch.players.length} players)`);
    for (const p of initialMatch.players) {
      const steamID = p.eosID;
      const elo = Number(p.muBefore) || 25.0;
      eloMap.set(steamID, elo);

      const t1Count = server.players.filter(x => String(x.teamID) === '1').length;
      const t2Count = server.players.filter(x => String(x.teamID) === '2').length;
      
      let naturalTeam = null;
      if (t1Count < MAX_TEAM_SIZE || t2Count < MAX_TEAM_SIZE) {
        naturalTeam = t1Count <= t2Count ? 1 : 2;
      }

      const playerObj = { steamID, name: p.name, teamID: naturalTeam, squadID: null };
      server.players.push(playerObj);
      await server.emit('PLAYER_CONNECTED', { player: playerObj });
    }
    await server.emit('UPDATED_PLAYER_INFORMATION', {});
    console.log(`[REPL] Population initialized. SmartAssign has processed initial placements.\n`);
  }

  rl.prompt();

  rl.on('line', async (line) => {
    const parts = line.trim().split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case 'exit':
        rl.close();
        break;
      case 'help':
        console.log('Commands: join <name> <elo>, leave <name>, time <ms>, status, help, exit');
        break;
      case 'join': {
        const name = parts[1] || 'Player_' + Math.floor(Math.random() * 1000);
        const elo = parseFloat(parts[2]) || 25.0;
        const steamID = 'STEAM_' + name;

        if (server.players.find(p => p.steamID === steamID)) {
          console.log(`[REPL] Player "${name}" is already in the server.`);
          break;
        }

        // Determine Natural Team (Baseline behavior)
        const t1Count = server.players.filter(x => String(x.teamID) === '1').length;
        const t2Count = server.players.filter(x => String(x.teamID) === '2').length;
        
        let naturalTeam = null;
        if (t1Count < MAX_TEAM_SIZE || t2Count < MAX_TEAM_SIZE) {
          naturalTeam = t1Count <= t2Count ? 1 : 2;
        }

        eloMap.set(steamID, elo);
        const p = { steamID, name, teamID: naturalTeam, squadID: null };
        server.players.push(p);

        console.log(`[REPL] ${name} connecting with ${elo} ELO (Natural Team: ${naturalTeam})...`);
        await server.emit('PLAYER_CONNECTED', { player: p });
        await server.emit('UPDATED_PLAYER_INFORMATION', {});
        break;
      }
      case 'leave': {
        const name = parts[1];
        const idx = server.players.findIndex(x => x.name === name || x.steamID === name);
        if (idx !== -1) {
          const p = server.players.splice(idx, 1)[0];
          console.log(`[REPL] ${p.name} disconnected.`);
          await server.emit('UPDATED_PLAYER_INFORMATION', {});
        } else {
          console.log(`[REPL] Player "${name}" not found.`);
        }
        break;
      }
      case 'time': {
        const inc = parseInt(parts[1]) || 1000;
        server.virtualTime += inc;
        console.log(`[REPL] Virtual Time advanced by ${inc}ms (Total: ${server.virtualTime}ms)`);
        break;
      }
      case 'status': {
        const data = mockEloTracker.buildRoundStartData();
        const t1Players = server.players.filter(p => String(p.teamID) === '1');
        const t2Players = server.players.filter(p => String(p.teamID) === '2');
        const unassigned = server.players.filter(p => String(p.teamID) === '3');

        console.log(`\nStatus (Time: ${server.virtualTime}):`);
        console.log(`Team 1 [${data.t1.count}/${MAX_TEAM_SIZE}]: ${formatPlayerList(t1Players, eloMap)}`);
        console.log(`       Avg Mu: ${data.t1.avgMu.toFixed(2)} | Sum Mu: ${data.t1.sumMu.toFixed(1)}`);
        console.log(`Team 2 [${data.t2.count}/${MAX_TEAM_SIZE}]: ${formatPlayerList(t2Players, eloMap)}`);
        console.log(`       Avg Mu: ${data.t2.avgMu.toFixed(2)} | Sum Mu: ${data.t2.sumMu.toFixed(1)}`);
        if (unassigned.length) console.log(`Unassigned [${unassigned.length}]: ${formatPlayerList(unassigned, eloMap)}`);
        console.log(`-------------------------------------------`);
        console.log(`Avg Gap: ${Math.abs(data.t1.avgMu - data.t2.avgMu).toFixed(2)}`);
        console.log(`Sum Gap: ${Math.abs(data.t1.sumMu - data.t2.sumMu).toFixed(2)}`);
        console.log(`Moves Executed: ${plugin.executor.moveCount}\n`);
        break;
      }
      default:
        console.log(`Unknown command: ${cmd}`);
    }
    rl.prompt();
  }).on('close', () => {
    console.log('Exiting REPL...');
    process.exit(0);
  });
}

// --- Main Runner ---

async function testLoadTempEventsCrashRecovery() {
  // NOTE: This test is skipped because loadTempEvents() is not exposed in the current plugin implementation
  console.log('⊘ loadTempEvents crash recovery test skipped (method not available in plugin).');
}

async function runTests() {
  // await testLoadTempEventsCrashRecovery(); // Skipped

   // Support both positional argument (process.argv[2]) and hardcoded default
   let logPath = path.join(__dirname, 'data', 'elo-match-log.jsonl');
  if (process.argv[2] && !process.argv[2].startsWith('--')) {
    logPath = path.isAbsolute(process.argv[2])
      ? process.argv[2]
      : path.join(process.cwd(), process.argv[2]);
  }
  if (!fs.existsSync(logPath)) {
    console.error(`Log file not found at ${logPath}`);
    process.exit(1);
  }

  const matches = [];
  const fileStream = fs.createReadStream(logPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) matches.push(JSON.parse(line));
  }

   // Load Elo Backup
   const eloBackupPath = path.join(__dirname, 'data', 'elo-backup-2026-04-11T07-04-39-967Z.json');
  const backupData = JSON.parse(fs.readFileSync(eloBackupPath, 'utf8'));
  const backupEloMap = new Map();
  const allBackupMus = [];
  for (const p of backupData.players) {
    if (p.eosID) backupEloMap.set(p.eosID, p.mu);
    if (p.steamID) backupEloMap.set(p.steamID, p.mu);
    allBackupMus.push(p.mu);
  }

  // Attach backup data to matches for historical run
  for (const match of matches) {
    for (const p of match.players) {
      if (backupEloMap.has(p.eosID)) {
        p.muBefore = backupEloMap.get(p.eosID);
      } else if (backupEloMap.has(p.steamID)) {
        p.muBefore = backupEloMap.get(p.steamID);
      }
    }
  }

  const eloMap = new Map(); // Used strictly for REPL
  const seededRandom = new SeededRandom(42);
  const isExhaustive = process.argv.includes('--exhaustive');
  let logStream = null;
  if (isExhaustive) {
    const outPath = path.join(__dirname, 'exhaustive-log.txt');
    logStream = fs.createWriteStream(outPath);
    console.log(`\n[!] Exhaustive mode enabled. Detailed move logs will be written to: ${outPath}\n`);
  }

  // If "--repl" is passed, start interactive mode
  const replIdx = process.argv.indexOf('--repl');
  if (replIdx !== -1) {
    const matchIdx = parseInt(process.argv[replIdx + 1]);
    const initialMatch = (!isNaN(matchIdx) && matches[matchIdx]) ? matches[matchIdx] : null;
    await startREPL(eloMap, initialMatch);
    return;
  }

  const engineConfigs = [
    { name: 'BASELINE (Random)', Class: MockRandomAssign, options: {} },
    { name: 'SMART ASSIGN (Current)', Class: SmartAssign, options: { enableSmartAssign: true } }
  ];

  const startScenarios = [
    { label: 'Start: 0 Pop', pop: 0 },
    { label: 'Start: 80 Pop', pop: 80 },
    { label: 'Start: 95 Pop', pop: 95 }
  ];

  const globalStats = {};
   for (const scenario of startScenarios) {
     globalStats[scenario.label] = {};
      engineConfigs.forEach(c => globalStats[scenario.label][c.name] = { 
        avgGap: 0, sumGap: 0, moves: 0, unbalanced: 0, rejoinOpp: 0, rejoinSucc: 0, clanApplicable: 0, clanCoherent: 0, clanCaused: 0, count: 0 
      });
   }

   function updateStats(scenarioLabel, configName, result) {
     const s = globalStats[scenarioLabel][configName];
     s.avgGap += result.avgGap;
     s.sumGap += result.avgSumGap;
     s.moves += result.forcedMoves;
     s.unbalanced += result.unbalancedPercent;
     s.rejoinOpp += result.rejoinOpp;
     s.rejoinSucc += result.rejoinSucc;
     s.clanApplicable += result.clanApplicable || 0;
     s.clanCoherent += result.clanCoherent || 0;
     s.clanCaused += result.clanCaused || 0;
     s.count++;
   }

    function printSummary(label) {
      console.log(`\n=== AGGREGATE SUMMARY: ${label} ===`);
      for (const scenario of startScenarios) {
        console.log(`\n[ ${scenario.label} ]`);
        console.log(`${"Engine".padEnd(25)} | ${"Avg Gap".padStart(7)} | ${"Sum Gap".padStart(7)} | ${"Unbalanced".padStart(10)} | ${"Rejoin".padStart(6)} | ${"Avg Moves".padStart(9)} | ${"Clan Coh.".padStart(10)} | ${"Clan Caused".padStart(11)}`);
        console.log("-".repeat(114));
        for (const [name, s] of Object.entries(globalStats[scenario.label])) {
          if (s.count === 0) continue;
          const n = s.count;
          const rRateStr = s.rejoinOpp > 0 ? `${((s.rejoinSucc / s.rejoinOpp) * 100).toFixed(1)}% (${s.rejoinSucc}/${s.rejoinOpp})` : '--';
          const avgGapStr = (s.avgGap/n).toFixed(3);
          const sumGapStr = (s.sumGap/n).toFixed(1);
          const unbalStr = `${(s.unbalanced/n).toFixed(1)}%`;
          const movesStr = (s.moves/n).toFixed(1);
          const clanStr = s.clanApplicable > 0 ? `${((s.clanCoherent / s.clanApplicable) * 100).toFixed(1)}% (${s.clanCoherent}/${s.clanApplicable})` : '--';
          const clanCausedStr = s.clanCaused > 0 ? `${s.clanCaused}` : '--';
          console.log(`${name.padEnd(25)} | ${avgGapStr.padStart(7)} | ${sumGapStr.padStart(7)} | ${unbalStr.padStart(10)} | ${rRateStr.padStart(6)} | ${movesStr.padStart(9)} | ${clanStr.padStart(10)} | ${clanCausedStr.padStart(11)}`);
        }
      }
    }

  console.log(`\n🚀 Running simulation on ${matches.length} historical matches...\n`);

  console.log('--- Historical Match Replays ---');
  for (const scenario of startScenarios) {
    console.log(`\nRunning Scenario: ${scenario.label}`);
    for (const [idx, match] of matches.entries()) {
      if (idx > 0 && idx % 50 === 0) console.log(`  ... processed ${idx}/${matches.length} matches ...`);
      
      const printDetails = idx < 1; // only print first match per scenario
      if (printDetails) console.log(`  Match: ${match.layerName} (${match.players.length} players)`);
      
       for (const config of engineConfigs) {
         const result = await simulateHistoricalMatch(match, config, seededRandom, logStream, scenario.pop);
         updateStats(scenario.label, config.name, result);
         if (printDetails) {
           const rRateStr = result.rejoinRate !== null ? `${result.rejoinRate.toFixed(1)}%` : '--';
           const clanStr = result.clanCoherence !== null ? `${(result.clanCoherence * 100).toFixed(1)}% (${result.clanCoherent}/${result.clanApplicable})` : '--';
           console.log(`    ${result.name.padEnd(25)} | Avg Gap: ${result.avgGap.toFixed(3)} | Sum Gap: ${result.avgSumGap.toFixed(1)}`);
           console.log(`    ${"".padEnd(25)} | Unbalanced: ${result.unbalancedPercent.toFixed(1)}% | Rejoin: ${rRateStr} | Moves: ${result.forcedMoves} | Clan: ${clanStr}`);
         }
       }
    }
  }
  printSummary("HISTORICAL MATCHES");

   // Reset stats for synthetic run
   for (const scenario of startScenarios) {
     engineConfigs.forEach(c => globalStats[scenario.label][c.name] = { avgGap: 0, sumGap: 0, moves: 0, unbalanced: 0, rejoinOpp: 0, rejoinSucc: 0, clanApplicable: 0, clanCoherent: 0, count: 0 });
   }

  console.log('\n--- Synthetic Match Generation (Pattern Based) ---');
  const churnStats = analyzeChurnStatistics(matches);
  for (const scenario of startScenarios) {
    console.log(`\nRunning Scenario: ${scenario.label}`);
    for (let i = 0; i < 20; i++) {
      const fakeMatch = generateFakeMatch(churnStats, seededRandom, allBackupMus);
      const printDetails = i < 1;
      if (printDetails) console.log(`  Generated Match #${i+1} (${fakeMatch.players.length} players)`);
      
      for (const config of engineConfigs) {
        const result = await simulateHistoricalMatch(fakeMatch, config, seededRandom, logStream, scenario.pop);
        updateStats(scenario.label, config.name, result);
        if (printDetails) {
          const rRateStr = result.rejoinRate !== null ? `${result.rejoinRate.toFixed(1)}%` : '--';
          console.log(`    ${result.name.padEnd(25)} | Avg Gap: ${result.avgGap.toFixed(3)} | Sum Gap: ${result.avgSumGap.toFixed(1)}`);
          console.log(`    ${"".padEnd(25)} | Unbalanced: ${result.unbalancedPercent.toFixed(1)}% | Rejoin: ${rRateStr} | Moves: ${result.forcedMoves}`);
        }
      }
    }
  }
  printSummary("SYNTHETIC MATCHES");

   // Reset stats for prolonged run
   const peakScenario = "Constant Peak (95+)";
   globalStats[peakScenario] = {};
   engineConfigs.forEach(c => globalStats[peakScenario][c.name] = { avgGap: 0, sumGap: 0, moves: 0, unbalanced: 0, rejoinOpp: 0, rejoinSucc: 0, clanApplicable: 0, clanCoherent: 0, count: 0 });

  console.log('\n--- Prolonged Peak Match Generation (10+ hours, 95-100 Pop) ---');
  for (let i = 0; i < 5; i++) {
    const prolongedMatch = generateProlongedMatch(seededRandom, allBackupMus, 10);
    const printDetails = i < 1;
    if (printDetails) console.log(`  Prolonged Match #${i+1} (Dynamic Population, ${Math.round(prolongedMatch.roundDuration/3600000)} hours)`);
    
    for (const config of engineConfigs) {
      const result = await simulateHistoricalMatch(prolongedMatch, config, seededRandom, logStream, 95);
      updateStats(peakScenario, config.name, result);
      if (printDetails) {
        const rRateStr = result.rejoinRate !== null ? `${result.rejoinRate.toFixed(1)}%` : '--';
        console.log(`    ${result.name.padEnd(25)} | Avg Gap: ${result.avgGap.toFixed(3)} | Sum Gap: ${result.avgSumGap.toFixed(1)}`);
        console.log(`    ${"".padEnd(25)} | Unbalanced: ${result.unbalancedPercent.toFixed(1)}% | Rejoin: ${rRateStr} | Moves: ${result.forcedMoves}`);
      }
    }
  }

   console.log(`\n=== AGGREGATE SUMMARY: PROLONGED MATCHES ===`);
   console.log(`\n[ ${peakScenario} ]`);
   console.log(`${"Engine".padEnd(25)} | ${"Avg Gap".padStart(7)} | ${"Sum Gap".padStart(7)} | ${"Unbalanced".padStart(10)} | ${"Rejoin".padStart(6)} | ${"Avg Moves".padStart(9)} | ${"Clan Coh.".padStart(10)}`);
   console.log("-".repeat(101));
   for (const [name, s] of Object.entries(globalStats[peakScenario])) {
     const n = s.count || 1;
     const rRateStr = s.rejoinOpp > 0 ? `${((s.rejoinSucc / s.rejoinOpp) * 100).toFixed(1)}% (${s.rejoinSucc}/${s.rejoinOpp})` : '--';
     const avgGapStr = (s.avgGap/n).toFixed(3);
     const sumGapStr = (s.sumGap/n).toFixed(1);
     const unbalStr = `${(s.unbalanced/n).toFixed(1)}%`;
     const movesStr = (s.moves/n).toFixed(1);
     const clanStr = s.clanApplicable > 0 ? `${((s.clanCoherent / s.clanApplicable) * 100).toFixed(1)}% (${s.clanCoherent}/${s.clanApplicable})` : '--';
     console.log(`${name.padEnd(25)} | ${avgGapStr.padStart(7)} | ${sumGapStr.padStart(7)} | ${unbalStr.padStart(10)} | ${rRateStr.padStart(6)} | ${movesStr.padStart(9)} | ${clanStr.padStart(10)}`);
   }

   // --- 50-hour Ultra Prolonged Run ---
   const ultraScenario = "Constant Peak (50+ hours)";
   globalStats[ultraScenario] = {};
   engineConfigs.forEach(c => globalStats[ultraScenario][c.name] = { avgGap: 0, sumGap: 0, moves: 0, unbalanced: 0, rejoinOpp: 0, rejoinSucc: 0, clanApplicable: 0, clanCoherent: 0, count: 0 });

  console.log('\n--- Ultra Prolonged Peak Match Generation (50+ hours, 95-100 Pop) ---');
  for (let i = 0; i < 2; i++) { // Run 2 matches of 50 hours each
    const ultraMatch = generateProlongedMatch(seededRandom, allBackupMus, 50);
    const printDetails = i < 1;
    if (printDetails) console.log(`  Ultra Match #${i+1} (Dynamic Population, 50 hours)`);
    
    for (const config of engineConfigs) {
      const result = await simulateHistoricalMatch(ultraMatch, config, seededRandom, logStream, 95);
      updateStats(ultraScenario, config.name, result);
      if (printDetails) {
        const rRateStr = result.rejoinRate !== null ? `${result.rejoinRate.toFixed(1)}%` : '--';
        console.log(`    ${result.name.padEnd(25)} | Avg Gap: ${result.avgGap.toFixed(3)} | Sum Gap: ${result.avgSumGap.toFixed(1)}`);
        console.log(`    ${"".padEnd(25)} | Unbalanced: ${result.unbalancedPercent.toFixed(1)}% | Rejoin: ${rRateStr} | Moves: ${result.forcedMoves}`);
      }
    }
  }

   console.log(`\n=== AGGREGATE SUMMARY: ULTRA PROLONGED MATCHES ===`);
   console.log(`\n[ ${ultraScenario} ]`);
   console.log(`${"Engine".padEnd(25)} | ${"Avg Gap".padStart(7)} | ${"Sum Gap".padStart(7)} | ${"Unbalanced".padStart(10)} | ${"Rejoin".padStart(6)} | ${"Avg Moves".padStart(9)} | ${"Clan Coh.".padStart(10)}`);
   console.log("-".repeat(101));
   for (const [name, s] of Object.entries(globalStats[ultraScenario])) {
     const n = s.count || 1;
     const rRateStr = s.rejoinOpp > 0 ? `${((s.rejoinSucc / s.rejoinOpp) * 100).toFixed(1)}% (${s.rejoinSucc}/${s.rejoinOpp})` : '--';
     const avgGapStr = (s.avgGap/n).toFixed(3);
     const sumGapStr = (s.sumGap/n).toFixed(1);
     const unbalStr = `${(s.unbalanced/n).toFixed(1)}%`;
     const movesStr = (s.moves/n).toFixed(1);
     const clanStr = s.clanApplicable > 0 ? `${((s.clanCoherent / s.clanApplicable) * 100).toFixed(1)}% (${s.clanCoherent}/${s.clanApplicable})` : '--';
     console.log(`${name.padEnd(25)} | ${avgGapStr.padStart(7)} | ${sumGapStr.padStart(7)} | ${unbalStr.padStart(10)} | ${rRateStr.padStart(6)} | ${movesStr.padStart(9)} | ${clanStr.padStart(10)}`);
   }

  console.log('\nSimulation complete. Use --repl for interactive testing.');
  process.exit(0);
}

runTests().catch(console.error);
