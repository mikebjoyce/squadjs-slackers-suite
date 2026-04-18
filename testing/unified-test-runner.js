import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import SmartAssign from '../plugins/smart-assign.js';

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
  async cleanupOldData() {}
}

class MockServer {
  constructor() {
    this.players = [];
    this.plugins = [];
    this.matchStartTime = new Date();
    this.listeners = new Map();
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
}

class EloTracker {
  constructor(server, eloMap) {
    this.server = server;
    this.ready = true;
    this.eloMap = eloMap;
  }
  buildRoundStartData() {
    let t1Mu = 0, t1Count = 0, t2Mu = 0, t2Count = 0;
    for (const p of this.server.players) {
      const mu = this.eloMap.get(p.steamID) || 25.0;
      if (p.teamID === 1) { t1Mu += mu; t1Count++; }
      else if (p.teamID === 2) { t2Mu += mu; t2Count++; }
    }
    return {
      t1: { count: t1Count, avgMu: t1Count ? t1Mu / t1Count : 25.0, sumMu: t1Mu },
      t2: { count: t2Count, avgMu: t2Count ? t2Mu / t2Count : 25.0, sumMu: t2Mu }
    };
  }
}

class MockSASwapExecutor {
  constructor(server) { this.server = server; }
  isRecentSmartAssignMove(steamID, newTeamID) { return true; }
  queueMove(steamID, targetTeam) {
    const p = this.server.players.find(p => p.steamID === steamID);
    if (p) p.teamID = targetTeam;
  }
  cleanup() {}
}

// --- Specialized Assigner for Baseline Comparison ---
class BaselineAssign extends SmartAssign {
  evaluateTeamAssignment(player, reconnectTeam = null) {
    let t1Count = 0, t2Count = 0;
    for (const p of this.server.players) {
      if (p.steamID === player.steamID) continue;
      if (String(p.teamID) === '1') t1Count++;
      else if (String(p.teamID) === '2') t2Count++;
    }
    return { targetTeam: t1Count <= t2Count ? 1 : 2, reason: 'Naive Population Balance' };
  }
}

// --- Legacy Assigner (v0.1.0 logic) ---
class LegacyAssign extends SmartAssign {
  evaluateTeamAssignment(player, reconnectTeam = null) {
    const eloTracker = this.server.plugins.find((p) => p.constructor.name === 'EloTracker');
    let t1Count = 0, t2Count = 0, t1Mu = 0, t2Mu = 0;
    for (const p of this.server.players) {
      if (p.steamID === player.steamID) continue;
      if (String(p.teamID) === '1') { t1Count++; t1Mu += eloTracker.eloMap.get(p.steamID) || 25.0; }
      else if (String(p.teamID) === '2') { t2Count++; t2Mu += eloTracker.eloMap.get(p.steamID) || 25.0; }
    }
    const playerMu = eloTracker.eloMap.get(player.steamID) || 25.0;
    const avg1 = t1Count > 0 ? t1Mu / t1Count : 25.0;
    const avg2 = t2Count > 0 ? t2Mu / t2Count : 25.0;
    const score1 = Math.abs(((t1Mu + playerMu) / (t1Count + 1)) - avg2);
    const score2 = Math.abs(avg1 - ((t2Mu + playerMu) / (t2Count + 1)));
    return { targetTeam: score1 <= score2 ? 1 : 2, reason: 'Legacy Skill Balance' };
  }
}

// --- Simulation Logic ---
async function simulateScenario(server, mockEloTracker, match, eosToSteam, seededRandom, plugin, scenarioType = 'LIFECYCLE', detailedLogging = false) {
  server.matchStartTime = new Date();
  await server.emit('NEW_GAME');
  server.players = [];
  server.eventLog = [];
  await plugin.db.clearReconnectMemory();

  const shuffledPlayers = [...match.players].sort(() => seededRandom.next() - 0.5);
  const pendingJoins = [];
  
  for (const originalPlayer of shuffledPlayers) {
    const steamID = eosToSteam.get(originalPlayer.eosID) || originalPlayer.eosID;
    pendingJoins.push({
      steamID: steamID,
      name: originalPlayer.name,
      teamID: 3,
      squadID: null,
      mu: originalPlayer.muBefore || 25
    });
    if (originalPlayer.muBefore) mockEloTracker.eloMap.set(steamID, originalPlayer.muBefore);
  }

  const disconnectedPlayers = [];
  let rejoinAttempts = 0;
  let rejoinSuccesses = 0;
  const eloHistory = [];
  const moveLog = [];

  const recordElo = (moveInfo = null) => {
    const data = mockEloTracker.buildRoundStartData();
    const eloGap = Math.abs(data.t1.avgMu - data.t2.avgMu);
    const sumGap = Math.abs(data.t1.sumMu - data.t2.sumMu);
    eloHistory.push({ eloGap, sumGap });
    if (detailedLogging && moveInfo) {
      moveLog.push({
        step: moveLog.length,
        action: moveInfo.action,
        player: moveInfo.player,
        team: moveInfo.team,
        eloGap: eloGap.toFixed(3),
        sumGap: sumGap.toFixed(1),
        t1Count: data.t1.count,
        t2Count: data.t2.count
      });
    }
  };

  if (scenarioType === 'LIFECYCLE') {
    const initialSeed = pendingJoins.splice(0, 80);
    for (const newPlayer of initialSeed) {
      server.players.push(newPlayer);
      await server.emit('PLAYER_CONNECTED', { player: newPlayer });
      recordElo({ action: 'SEED', player: newPlayer.name, team: newPlayer.teamID });
    }

    for (let step = 0; step < 200; step++) {
      const currentPop = server.players.length;
      let action = 'JOIN';
      if (currentPop >= 100) action = 'LEAVE';
      else {
        const r = seededRandom.next();
        if (r < 0.15 && currentPop > 20) action = 'LEAVE';
        else if (r < 0.30 && disconnectedPlayers.length > 0) action = 'REJOIN';
        else if (pendingJoins.length > 0) action = 'JOIN';
        else action = 'LEAVE';
      }

      if (action === 'LEAVE') {
        if (server.players.length === 0) continue;
        const leaveIdx = Math.floor(seededRandom.next() * server.players.length);
        const leaver = server.players.splice(leaveIdx, 1)[0];
        disconnectedPlayers.push(leaver);
        await server.emit('UPDATED_PLAYER_INFORMATION', {});
        await plugin.db.savePlayerDisconnect(leaver.steamID, leaver.teamID);
        recordElo({ action: 'LEAVE', player: leaver.name, team: leaver.teamID });
      } 
      else if (action === 'REJOIN') {
        const rejoinIdx = Math.floor(seededRandom.next() * disconnectedPlayers.length);
        const rejoinder = disconnectedPlayers.splice(rejoinIdx, 1)[0];
        const prevTeam = rejoinder.teamID;
        rejoinder.teamID = 3;
        server.players.push(rejoinder);
        await server.emit('PLAYER_CONNECTED', { player: rejoinder });
        rejoinAttempts++;
        if (String(rejoinder.teamID) === String(prevTeam)) rejoinSuccesses++;
        recordElo({ action: 'REJOIN', player: rejoinder.name, team: rejoinder.teamID });
      } 
      else if (action === 'JOIN') {
        const newPlayer = pendingJoins.shift();
        server.players.push(newPlayer);
        await server.emit('PLAYER_CONNECTED', { player: newPlayer });
        recordElo({ action: 'JOIN', player: newPlayer.name, team: newPlayer.teamID });
      }
    }
  } else if (scenarioType === 'REALWORLD_CHURN') {
    const initialFill = pendingJoins.splice(0, 98);
    for (const newPlayer of initialFill) {
      server.players.push(newPlayer);
      await server.emit('PLAYER_CONNECTED', { player: newPlayer });
      recordElo({ action: 'FILL', player: newPlayer.name, team: newPlayer.teamID });
    }

    // High Population Prolonged Churn (1,000 iterations)
    for (let step = 0; step < 1000; step++) {
      const currentPop = server.players.length;
      const r = seededRandom.next();
      let action;

      // Periodic Match Transition: 25+ people leave at step 500
      if (step === 500) {
        const leaveCount = 25 + Math.floor(seededRandom.next() * 10);
        for (let i = 0; i < leaveCount; i++) {
          if (server.players.length === 0) break;
          const leaveIdx = Math.floor(seededRandom.next() * server.players.length);
          const leaver = server.players.splice(leaveIdx, 1)[0];
          disconnectedPlayers.push(leaver);
          await server.emit('UPDATED_PLAYER_INFORMATION', {});
          await plugin.db.savePlayerDisconnect(leaver.steamID, leaver.teamID);
          recordElo({ action: 'MASS_LEAVE', player: leaver.name, team: leaver.teamID });
        }
        continue;
      }

      if (currentPop >= 100) action = 'LEAVE';
      else if (currentPop < 85) action = 'JOIN';
      else {
        if (r < 0.4) action = 'LEAVE';
        else if (r < 0.7 && disconnectedPlayers.length > 0) action = 'REJOIN';
        else if (pendingJoins.length > 0) action = 'JOIN';
        else action = 'LEAVE';
      }

      if (action === 'LEAVE') {
        const leaveIdx = Math.floor(seededRandom.next() * server.players.length);
        const leaver = server.players.splice(leaveIdx, 1)[0];
        disconnectedPlayers.push(leaver);
        await server.emit('UPDATED_PLAYER_INFORMATION', {});
        await plugin.db.savePlayerDisconnect(leaver.steamID, leaver.teamID);
        recordElo({ action: 'LEAVE', player: leaver.name, team: leaver.teamID });
      } 
      else if (action === 'REJOIN') {
        const rejoinIdx = Math.floor(seededRandom.next() * disconnectedPlayers.length);
        const rejoinder = disconnectedPlayers.splice(rejoinIdx, 1)[0];
        const prevTeam = rejoinder.teamID;
        rejoinder.teamID = 3;
        server.players.push(rejoinder);
        await server.emit('PLAYER_CONNECTED', { player: rejoinder });
        rejoinAttempts++;
        if (String(rejoinder.teamID) === String(prevTeam)) rejoinSuccesses++;
        recordElo({ action: 'REJOIN', player: rejoinder.name, team: rejoinder.teamID });
      } 
      else if (action === 'JOIN' && pendingJoins.length > 0) {
        const newPlayer = pendingJoins.shift();
        server.players.push(newPlayer);
        await server.emit('PLAYER_CONNECTED', { player: newPlayer });
        recordElo({ action: 'JOIN', player: newPlayer.name, team: newPlayer.teamID });
      }
    }
  }

  // Final Stabilization
  for (let i = 0; i < 10; i++) {
    const t1 = server.players.filter((p) => p.teamID === 1).length;
    const t2 = server.players.filter((p) => p.teamID === 2).length;
    if (Math.abs(t1 - t2) <= 1) break;
    if (pendingJoins.length > 0) {
      const newPlayer = pendingJoins.shift();
      server.players.push(newPlayer);
      await server.emit('PLAYER_CONNECTED', { player: newPlayer });
    } else if (disconnectedPlayers.length > 0) {
      const rejoinder = disconnectedPlayers.shift();
      rejoinder.teamID = 3;
      server.players.push(rejoinder);
      await server.emit('PLAYER_CONNECTED', { player: rejoinder });
    } else break;
  }

  const { t1, t2 } = mockEloTracker.buildRoundStartData();
  
  return { 
    popDiff: Math.abs(server.players.filter(p => p.teamID === 1).length - server.players.filter(p => p.teamID === 2).length), 
    eloDiff: Math.abs(t1.avgMu - t2.avgMu), 
    sumDiff: Math.abs(t1.sumMu - t2.sumMu),
    rejoinRate: rejoinAttempts > 0 ? rejoinSuccesses / rejoinAttempts : 1,
    eloHistory,
    moveLog,
    t1End: server.players.filter(p => p.teamID === 1).length,
    t2End: server.players.filter(p => p.teamID === 2).length,
    t1Elo: t1.avgMu,
    t2Elo: t2.avgMu,
    t1Sum: t1.sumMu,
    t2Sum: t2.sumMu,
    eventLog: server.eventLog,
    runId: match.layerName || 'Unknown'
  };
}

// --- Main Runner ---
async function runUnifiedTests() {
  console.log('🚀 Starting Expanded Unified SmartAssign Test Suite (Deep-Dive Edition)...\n');

  const rebuiltPath = path.join(__dirname, 'tools', 'rebuilt.json');
  const matchesPath = path.join(__dirname, 'tools', 'mergedFinal.jsonl');
  
  const rebuiltData = JSON.parse(fs.readFileSync(rebuiltPath, 'utf8'));
  const eloMap = new Map();
  const eosToSteam = new Map();
  for (const p of rebuiltData.players) {
    if (p.steamID) {
      eloMap.set(p.steamID, p.mu);
      eosToSteam.set(p.eosID, p.steamID);
    }
  }

  const matches = [];
  const fileStream = fs.createReadStream(matchesPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const match = JSON.parse(line);
    if (match.players.length >= 150) matches.push(match);
    if (matches.length >= 150) break; 
  }

  const engineConfigs = [
    { name: 'NAIVE BASELINE', Class: BaselineAssign, options: {} },
    { name: 'LEGACY (v0.1.0)', Class: LegacyAssign, options: {} },
    { name: 'SMART ASSIGN (Current)', Class: SmartAssign, options: { imbalanceSoftPenalty: 0.01 } }
  ];

  const scenarios = ['LIFECYCLE', 'REALWORLD_CHURN'];

  for (const scenario of scenarios) {
    console.log(`\n\n╔═══════════════════════════════════════════════════════════════╗`);
    console.log(`║ SCENARIO: ${scenario.padEnd(52)}║`);
    console.log(`╚═══════════════════════════════════════════════════════════════╝`);

    const allResults = {};

    for (const engine of engineConfigs) {
      process.stdout.write(`Testing ${engine.name.padEnd(25)} `);
      const results = [];
      
      for (let i = 0; i < matches.length; i++) {
        const server = new MockServer();
        const mockEloTracker = new EloTracker(server, eloMap);
        server.plugins.push(mockEloTracker);
        const plugin = new engine.Class(server, engine.options);
        plugin.db = new MockSADatabase();
        plugin.executor = new MockSASwapExecutor(server);
        
        // Capture logs for improved version only (to save memory)
        if (engine.name.includes('SMART ASSIGN')) {
          plugin.logEvent = (type, player, data) => {
            if (type === 'ASSIGNMENT') server.eventLog.push(`[ALGO] ${player.name} -> T${data.targetTeam}: ${data.reason}`);
          };
        }

        await plugin.mount();
        const seededRandom = new SeededRandom(1337 + i); 
        // We only enable detailedLogging for the very first match of the Current version to generate the deep-dive
        const isDeepDiveMatch = i === 0 && engine.name.includes('SMART ASSIGN');
        results.push(await simulateScenario(server, mockEloTracker, matches[i], eosToSteam, seededRandom, plugin, scenario, isDeepDiveMatch));
        if ((i+1) % 10 === 0) process.stdout.write('■');
      }
      allResults[engine.name] = results;
      console.log(' DONE');
    }

    // --- Metrics Comparison ---
    console.log(`\n--- Comparison Summary (${scenario}) ---`);
    console.log(`Name                      | Elo Diff | Sum Diff | Pop Parity | Rejoin Rate`);
    console.log(`--------------------------|----------|----------|------------|------------`);
    
    for (const name of Object.keys(allResults)) {
      const res = allResults[name];
      const avgElo = (res.reduce((s, r) => s + r.eloDiff, 0) / res.length).toFixed(3);
      const avgSum = (res.reduce((s, r) => s + r.sumDiff, 0) / res.length).toFixed(1);
      const popP = (res.filter(r => r.popDiff <= 1).length / res.length * 100).toFixed(1);
      const rejoin = (res.reduce((s, r) => s + r.rejoinRate, 0) / res.length * 100).toFixed(2);
      
      console.log(`${name.padEnd(26)}| ${avgElo.padEnd(9)}| ${avgSum.padEnd(9)}| ${popP.padEnd(11)}%| ${rejoin}%`);
    }

    // --- Drift Analysis ---
    console.log(`\n--- Average Elo Drift Over Time (${scenario}) ---`);
    const driftLength = allResults['SMART ASSIGN (Current)'][0].eloHistory.length;
    const avgDriftElo = [];
    const avgDriftSum = [];
    
    // We sample up to 15 points across the timeline for readability
    const samplingPoints = 15;
    for (let i = 0; i < samplingPoints; i++) {
      const t = Math.min(driftLength - 1, Math.floor(i * (driftLength / (samplingPoints - 1))));
      const validRuns = allResults['SMART ASSIGN (Current)'].filter(r => r.eloHistory[t]);
      if (validRuns.length === 0) continue;
      
      const avgEloAtT = validRuns.reduce((s, r) => s + r.eloHistory[t].eloGap, 0) / validRuns.length;
      const avgSumAtT = validRuns.reduce((s, r) => s + r.sumGapAtT || r.eloHistory[t].sumGap, 0) / validRuns.length;
      avgDriftElo.push(avgEloAtT.toFixed(3));
      avgDriftSum.push(avgSumAtT.toFixed(1));
    }
    console.log(`Avg Elo Gap Drift: [${avgDriftElo.join(' -> ')}]`);
    console.log(`Avg Sum Gap Drift: [${avgDriftSum.join(' -> ')}]`);

    // --- Deep-Dive Move-by-Move Report (First Match) ---
    if (scenario === 'REALWORLD_CHURN') {
      const deepDiveMatch = allResults['SMART ASSIGN (Current)'][0];
      console.log(`\n📊 DEEP-DIVE: Move-by-Move Delta Log (Match: ${deepDiveMatch.runId})`);
      console.log(`Step | Action       | Team | Elo Gap | Sum Gap | Pop (T1/T2)`);
      console.log(`-----|--------------|------|---------|---------|------------`);
      // Sample 30 moves across the 1000+ iteration timeline including the transition
      const diveSamples = deepDiveMatch.moveLog.filter((m, i) => i % 40 === 0 || (i >= 495 && i <= 515));
      diveSamples.forEach(m => {
        console.log(`${String(m.step).padEnd(4)} | ${m.action.padEnd(12)} | T${m.team}  | ${m.eloGap}   | ${m.sumGap.padEnd(7)} | ${m.t1Count}/${m.t2Count}`);
      });
    }

    // --- Worst-Case Analysis (Current Smart Assign) ---
    if (scenario === 'REALWORLD_CHURN') {
      console.log(`\n⚠️ TOP 5 WORST-CASE SCENARIOS (Current Smart Assign) ⚠️`);
      const worst = [...allResults['SMART ASSIGN (Current)']].sort((a, b) => b.eloDiff - a.eloDiff).slice(0, 5);
      worst.forEach((r, idx) => {
        console.log(`\n#${idx + 1} Match: ${r.runId} | Elo Diff: ${r.eloDiff.toFixed(3)} | Sum Diff: ${r.sumDiff.toFixed(1)}`);
        console.log(`    T1: ${r.t1End}p (${r.t1Elo.toFixed(2)} avg) | T2: ${r.t2End}p (${r.t2Elo.toFixed(2)} avg)`);
        console.log(`    Recent Algo Decisions:`);
        r.eventLog.slice(-5).forEach(e => console.log(`      ${e}`));
      });
    }
  }
}

runUnifiedTests().catch(err => console.error(err));
