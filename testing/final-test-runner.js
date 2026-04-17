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

// --- Configurable Assigner for testing ---
class ConfigurableAssign extends SmartAssign {
  constructor(server, options, connectors, testConfig) {
    super(server, options, connectors);
    this.testConfig = testConfig;
  }

  evaluateTeamAssignment(player, reconnectTeam = null) {
    const eloTracker = this.server.plugins.find((p) => p.constructor.name === 'EloTracker');
    const hasElo = eloTracker && eloTracker.ready;

    let t1Count = 0, t2Count = 0, t1Power = 0, t2Power = 0;
    const totalPop = this.server.players.filter(p => p.steamID !== player.steamID).length;
    let EXPONENT = this.testConfig.exponent || 1.1;

    for (const p of this.server.players) {
      if (p.steamID === player.steamID) continue; 
      if (String(p.teamID) === '1') t1Count++;
      else if (String(p.teamID) === '2') t2Count++;

      if (hasElo && (String(p.teamID) === '1' || String(p.teamID) === '2')) {
        const mu = eloTracker.eloMap.get(p.steamID) || 25.0;
        const pwr = Math.pow(mu, EXPONENT);
        if (String(p.teamID) === '1') t1Power += pwr;
        else t2Power += pwr;
      }
    }

    const maxImbalance = (pop) => pop >= 94 ? 1 : (pop >= 88 ? 2 : (pop >= 80 ? 3 : 4));
    const currentMaxImbalance = maxImbalance(totalPop);

    if (t1Count - t2Count >= currentMaxImbalance) return 2;
    if (t2Count - t1Count >= currentMaxImbalance) return 1;

    let playerMu = eloTracker?.eloMap.get(player.steamID) || 25.0;
    const playerPower = Math.pow(playerMu, EXPONENT);

    if (!hasElo) return t1Count <= t2Count ? 1 : 2;

    const avgT1 = t1Count > 0 ? t1Power / t1Count : 25.0;
    const avgT2 = t2Count > 0 ? t2Power / t2Count : 25.0;
    const newAvgT1 = (t1Power + playerPower) / (t1Count + 1);
    const newAvgT2 = (t2Power + playerPower) / (t2Count + 1);

    let scoreT1 = Math.pow(newAvgT1 - avgT2, 2);
    let scoreT2 = Math.pow(avgT1 - newAvgT2, 2);

    let softPenalty = this.testConfig.softPenalty;
    scoreT1 += (t1Count > t2Count) ? (t1Count - t2Count) * softPenalty : 0;
    scoreT2 += (t2Count > t1Count) ? (t2Count - t1Count) * softPenalty : 0;

    const targetTeam = scoreT1 < scoreT2 ? 1 : 2;
    const wouldViolate = targetTeam === 1 ? t1Count + 1 - t2Count > currentMaxImbalance : t2Count + 1 - t1Count > currentMaxImbalance;
    return wouldViolate ? (t1Count < t2Count ? 1 : 2) : targetTeam;
  }
}

// --- Simulation Logic ---
async function simulateMatch(server, mockEloTracker, match, eosToSteam, seededRandom, plugin) {
  server.matchStartTime = new Date();
  await server.emit('NEW_GAME');
  server.players = [];

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

  // 1. Initial 80 players join
  const initialSeed = pendingJoins.splice(0, 80);
  for (const newPlayer of initialSeed) {
    server.players.push(newPlayer);
    await server.emit('PLAYER_CONNECTED', { player: newPlayer });
  }

  const disconnectedPlayers = [];
  for (let step = 0; step < 100; step++) {
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
    } 
    else if (action === 'REJOIN') {
      const rejoinIdx = Math.floor(seededRandom.next() * disconnectedPlayers.length);
      const rejoinder = disconnectedPlayers.splice(rejoinIdx, 1)[0];
      rejoinder.teamID = 3;
      server.players.push(rejoinder);
      await server.emit('PLAYER_CONNECTED', { player: rejoinder });
    } 
    else if (action === 'JOIN') {
      const newPlayer = pendingJoins.shift();
      server.players.push(newPlayer);
      await server.emit('PLAYER_CONNECTED', { player: newPlayer });
    }
  }

  // Stabilization
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
    sumDiff: Math.abs(t1.sumMu - t2.sumMu)
  };
}

// --- Main Runner ---
async function runFinalTests() {
  console.log('🚀 Starting Final SmartAssign Optimization Suite (Deterministic)...\n');

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
    if (match.players.length >= 130) matches.push(match);
    if (matches.length >= 150) break; // More breadth
  }

  const testConfigs = [
    { 
      name: 'Exp 1.05, Soft 0.03', 
      config: { exponent: 1.05, softPenalty: 0.03 } 
    },
    { 
      name: 'Exp 1.05, Soft 0.05', 
      config: { exponent: 1.05, softPenalty: 0.05 } 
    },
    { 
      name: 'Exp 1.05, Soft 0.1', 
      config: { exponent: 1.05, softPenalty: 0.1 } 
    }
  ];

  for (const test of testConfigs) {
    console.log(`Testing: ${test.name}...`);
    let totalEloDiff = 0, totalSumDiff = 0, perfectPop = 0;
    
    for (let i = 0; i < matches.length; i++) {
      const server = new MockServer();
      const mockEloTracker = new EloTracker(server, eloMap);
      server.plugins.push(mockEloTracker);
      const plugin = new ConfigurableAssign(server, { database: 'sqlite' }, {}, test.config);
      plugin.db = new MockSADatabase();
      plugin.executor = new MockSASwapExecutor(server);
      await plugin.mount();

      const seededRandom = new SeededRandom(42 + i); // Deterministic per match
      const result = await simulateMatch(server, mockEloTracker, matches[i], eosToSteam, seededRandom, plugin);
      
      totalEloDiff += result.eloDiff;
      totalSumDiff += result.sumDiff;
      if (result.popDiff <= 1) perfectPop++;
      
      if ((i+1) % 25 === 0) process.stdout.write('■');
    }
    
    console.log(`\n  Avg Elo Diff: ${(totalEloDiff / matches.length).toFixed(3)} Mu`);
    console.log(`  Avg Sum Diff: ${(totalSumDiff / matches.length).toFixed(1)} Mu`);
    console.log(`  Pop Parity: ${(perfectPop / matches.length * 100).toFixed(1)}%\n`);
  }
}

runFinalTests().catch(err => console.error(err));
