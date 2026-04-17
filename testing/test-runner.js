import fs from 'fs';
import readline from 'readline';
import Sequelize from 'sequelize';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Note: Using relative path to match the actual location of the plugin in the user's workspace
import SmartAssign from '../plugins/smart-assign.js';

// --- Mocks ---

class MockServer {
  constructor() {
    this.players = [];
    this.plugins = [];
    this.matchStartTime = new Date();
    this.listeners = new Map();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(handler);
  }

  removeListener(event, handler) {
    if (!this.listeners.has(event)) return;
    const arr = this.listeners.get(event);
    this.listeners.set(event, arr.filter(h => h !== handler));
  }

  async emit(event, data) {
    if (!this.listeners.has(event)) return;
    for (const handler of this.listeners.get(event)) {
      await handler(data);
    }
  }
}

class EloTracker {
  constructor(server, eloMap) {
    this.server = server;
    this.ready = true;
    this.eloMap = eloMap;
  }

  buildRoundStartData() {
    let t1Mu = 0, t1Count = 0;
    let t2Mu = 0, t2Count = 0;

    for (const p of this.server.players) {
      const mu = this.eloMap.get(p.steamID) || 25.0; // Default Mu if not found
      if (p.teamID === 1) {
        t1Mu += mu;
        t1Count++;
      } else if (p.teamID === 2) {
        t2Mu += mu;
        t2Count++;
      }
    }

    return {
      t1: { count: t1Count, avgMu: t1Count ? t1Mu / t1Count : 25.0 },
      t2: { count: t2Count, avgMu: t2Count ? t2Mu / t2Count : 25.0 }
    };
  }
}

// Intercept executor inside the plugin
class MockSASwapExecutor {
  constructor(server) {
    this.server = server;
  }

  isRecentSmartAssignMove(steamID, newTeamID) {
    return true; // For testing, assume all moves are smart-assign moves if this is called
  }

  queueMove(steamID, targetTeam) {
    // Instantly apply the team swap for testing
    const p = this.server.players.find(p => p.steamID === steamID);
    if (p) {
      p.teamID = targetTeam;
    }
  }

  cleanup() {}
}

// --- Baseline Assigner ---
class BaselineAssign extends SmartAssign {
  evaluateTeamAssignment(player, reconnectTeam = null) {
    let t1Count = 0;
    let t2Count = 0;
    for (const p of this.server.players) {
      if (p.steamID === player.steamID) continue;
      if (String(p.teamID) === '1') t1Count++;
      else if (String(p.teamID) === '2') t2Count++;
    }

    const totalPop = t1Count + t2Count;
    const highPopThreshold = this.options.highPopThreshold || 96;
    const maxImbalance = totalPop >= highPopThreshold ? 1 : (this.options.maxImbalance || 2);

    if (t1Count - t2Count >= maxImbalance) return 2;
    if (t2Count - t1Count >= maxImbalance) return 1;

    if (reconnectTeam) {
      const wouldViolate = reconnectTeam === 1 
        ? ((t1Count + 1) - t2Count > maxImbalance)
        : ((t2Count + 1) - t1Count > maxImbalance);
        
      if (!wouldViolate) return reconnectTeam;
    }

    if (t1Count < t2Count) return 1;
    if (t2Count < t1Count) return 2;
    return 1;
  }
}

// --- Legacy Assigner (Old logic for comparison) ---
class LegacyAssign extends SmartAssign {
  evaluateTeamAssignment(player, reconnectTeam = null) {
    let t1Count = 0;
    let t2Count = 0;
    for (const p of this.server.players) {
      if (p.steamID === player.steamID) continue;
      if (String(p.teamID) === '1') t1Count++;
      else if (String(p.teamID) === '2') t2Count++;
    }

    const totalPop = t1Count + t2Count;
    const highPopThreshold = this.options.highPopThreshold || 96;
    const maxImbalance = totalPop >= highPopThreshold ? 1 : this.options.maxImbalance || 2;

    if (t1Count - t2Count >= maxImbalance) return 2;
    if (t2Count - t1Count >= maxImbalance) return 1;

    if (reconnectTeam) {
      const wouldViolate =
        reconnectTeam === 1
          ? t1Count + 1 - t2Count > maxImbalance
          : t2Count + 1 - t1Count > maxImbalance;

      if (!wouldViolate) return reconnectTeam;
    }

    const eloTracker = this.server.plugins.find((p) => p.constructor.name === 'EloTracker');
    let targetTeam = t1Count <= t2Count ? 1 : 2;

    if (eloTracker && eloTracker.ready) {
      const data = eloTracker.buildRoundStartData();
      if (data && data.t1 && data.t2) {
        let playerMu = eloTracker.eloMap.get(player.steamID) || 25.0;

        const t1MuSum = data.t1.avgMu * (data.t1.count || t1Count);
        const t2MuSum = data.t2.avgMu * (data.t2.count || t2Count);

        const newT1Avg = (t1MuSum + playerMu) / ((data.t1.count || t1Count) + 1);
        const newT2Avg = (t2MuSum + playerMu) / ((data.t2.count || t2Count) + 1);

        let scoreT1 = Math.abs(newT1Avg - data.t2.avgMu);
        let scoreT2 = Math.abs(data.t1.avgMu - newT2Avg);

        const softPenalty = this.options.imbalanceSoftPenalty || 0;
        if (t1Count < t2Count) scoreT1 -= (t2Count - t1Count) * softPenalty;
        else if (t2Count < t1Count) scoreT2 -= (t1Count - t2Count) * softPenalty;

        if (scoreT1 < scoreT2) targetTeam = 1;
        else if (scoreT2 < scoreT1) targetTeam = 2;
        else targetTeam = t1Count <= t2Count ? 1 : 2;
      }
    }

    const wouldViolate =
      targetTeam === 1 ? t1Count + 1 - t2Count > maxImbalance : t2Count + 1 - t1Count > maxImbalance;

    if (wouldViolate) targetTeam = t1Count < t2Count ? 1 : 2;

    return targetTeam;
  }
}

// --- Improved Assigner (Proposed) ---
class ImprovedAssign extends SmartAssign {
  evaluateTeamAssignment(player, reconnectTeam = null) {
    const t1Count = this.server.players.filter((p) => p.teamID === 1 && p.steamID !== player.steamID).length;
    const t2Count = this.server.players.filter((p) => p.teamID === 2 && p.steamID !== player.steamID).length;
    const totalPop = t1Count + t2Count;

    const highPopThreshold = this.options.highPopThreshold || 96;
    const maxImbalance = totalPop >= highPopThreshold ? 1 : this.options.maxImbalance || 2;

    // 1. Hard population imbalance — highest priority
    if (t1Count - t2Count >= maxImbalance) return 2;
    if (t2Count - t1Count >= maxImbalance) return 1;

    // Compute Elo sums directly from live player list (avoids count mismatch)
    const eloTracker = this.server.plugins.find((p) => p.constructor.name === 'EloTracker');
    let t1MuSum = 0,
      t2MuSum = 0,
      playerMu = 25.0;
    const hasElo = eloTracker && eloTracker.ready;

    if (hasElo) {
      for (const p of this.server.players) {
        if (p.steamID === player.steamID) continue;
        const mu = eloTracker.eloMap?.get(p.steamID) ?? 25.0;
        if (p.teamID === 1) t1MuSum += mu;
        else if (p.teamID === 2) t2MuSum += mu;
      }
      playerMu = eloTracker.eloMap?.get(player.steamID) ?? 25.0;
    }

    // 2. Reconnect preference — check both population AND Elo impact
    if (reconnectTeam) {
      const wouldViolatePop =
        reconnectTeam === 1
          ? t1Count + 1 - t2Count > maxImbalance
          : t2Count + 1 - t1Count > maxImbalance;

      if (!wouldViolatePop) {
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
        // Fall through to Elo routing — reconnect preference is overridden
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
}

// --- Main Test Logic ---

async function simulateMatch(server, mockEloTracker, match, eosToSteam, randomSequence) {
  let randIndex = 0;
  const getRand = () => randomSequence[randIndex++];

  server.matchStartTime = new Date();
  await server.emit('NEW_GAME');
  server.players = [];

  const shuffledPlayers = [...match.players].sort(() => getRand() - 0.5);
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
    if (originalPlayer.muBefore) {
      mockEloTracker.eloMap.set(steamID, originalPlayer.muBefore);
    }
  }

  // 1. Initial 80 players join
  const initialSeed = pendingJoins.splice(0, 80);
  for (const newPlayer of initialSeed) {
    server.players.push(newPlayer);
    await server.emit('PLAYER_CONNECTED', { player: newPlayer });
  }

  const disconnectedPlayers = [];
  const eventLog = [];

  for (let step = 0; step < 100; step++) {
    const currentPop = server.players.length;
    const r = getRand();

    let action = 'JOIN';
    if (currentPop >= 102) {
      action = 'LEAVE';
    } else {
      if (r < 0.15 && currentPop > 20) {
        action = 'LEAVE';
      } else if (r < 0.30 && disconnectedPlayers.length > 0) {
        action = 'REJOIN';
      } else if (pendingJoins.length > 0) {
        action = 'JOIN';
      } else {
        action = 'LEAVE';
      }
    }

    if (action === 'LEAVE') {
      if (server.players.length === 0) continue;
      const leaveIdx = Math.floor(getRand() * server.players.length);
      const leaver = server.players.splice(leaveIdx, 1)[0];
      disconnectedPlayers.push(leaver);
      await server.emit('UPDATED_PLAYER_INFORMATION', {});
      eventLog.push(`[LEAVE] ${leaver.name} left Team ${leaver.teamID}`);
    } 
    else if (action === 'REJOIN') {
      const rejoinIdx = Math.floor(getRand() * disconnectedPlayers.length);
      const rejoinder = disconnectedPlayers.splice(rejoinIdx, 1)[0];
      rejoinder.teamID = 3;
      server.players.push(rejoinder);
      await server.emit('PLAYER_CONNECTED', { player: rejoinder });
      eventLog.push(`[REJOIN] ${rejoinder.name} rejoined -> Assigned to Team ${rejoinder.teamID}`);
    } 
    else if (action === 'JOIN') {
      const newPlayer = pendingJoins.shift();
      server.players.push(newPlayer);
      await server.emit('PLAYER_CONNECTED', { player: newPlayer });
      eventLog.push(`[JOIN] ${newPlayer.name} joined -> Assigned to Team ${newPlayer.teamID}`);
    }
  }

  const t1End = server.players.filter(p => p.teamID === 1).length;
  const t2End = server.players.filter(p => p.teamID === 2).length;
  const diff = Math.abs(t1End - t2End);

  const { t1, t2 } = mockEloTracker.buildRoundStartData();
  const eloDiff = Math.abs(t1.avgMu - t2.avgMu);

  return { popDiff: diff, eloDiff, t1End, t2End, t1Elo: t1.avgMu, t2Elo: t2.avgMu, eventLog };
}

async function runRealisticLifecycleTests(eloPlugin, basePlugin, improvedPlugin, legacyPlugin, eloServer, baseServer, improvedServer, legacyServer, eloMockTracker, baseMockTracker, improvedMockTracker, legacyMockTracker, eosToSteam) {
  const matchesPath = path.join(__dirname, 'tools', 'mergedFinal.jsonl');
  console.log(`Loading Matches from: ${matchesPath}\n`);

  if (!fs.existsSync(matchesPath)) {
    console.error(`❌ Could not find ${matchesPath}`);
    return;
  }

  const fileStream = fs.createReadStream(matchesPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let matchIndex = 1;
  const eloResults = [];
  const baseResults = [];
  const improvedResults = [];
  const legacyResults = [];

  const maxMatches = 100; // Speed up testing

  for await (const line of rl) {
    if (!line.trim()) continue;
    const match = JSON.parse(line);

    if (match.players.length < 130) continue;
    if (matchIndex > maxMatches) break;

    const randomSequence = Array.from({ length: 2000 }, () => Math.random());

    // 1. Run Production Plugin (Now using Sum-Gap)
    const eloRes = await simulateMatch(eloServer, eloMockTracker, match, eosToSteam, randomSequence);
    eloRes.run = matchIndex;
    eloRes.layer = match.layerName;
    eloResults.push(eloRes);

    // 2. Run Baseline (Naive)
    const baseRes = await simulateMatch(baseServer, baseMockTracker, match, eosToSteam, randomSequence);
    baseRes.run = matchIndex;
    baseRes.layer = match.layerName;
    baseResults.push(baseRes);

    // 3. Run New Improved (Sum-Gap Ref Implementation)
    const improvedRes = await simulateMatch(improvedServer, improvedMockTracker, match, eosToSteam, randomSequence);
    improvedRes.run = matchIndex;
    improvedRes.layer = match.layerName;
    improvedResults.push(improvedRes);

    // 4. Run Legacy (Old Average-based)
    const legacyRes = await simulateMatch(legacyServer, legacyMockTracker, match, eosToSteam, randomSequence);
    legacyRes.run = matchIndex;
    legacyRes.layer = match.layerName;
    legacyResults.push(legacyRes);

    if (matchIndex % 10 === 0) process.stdout.write('■');
    matchIndex++;
  }
  process.stdout.write('\n\n');

  // Comparison Metrics
  const eloPerfectPop = eloResults.filter((r) => r.popDiff <= 1).length;
  const basePerfectPop = baseResults.filter((r) => r.popDiff <= 1).length;
  const impPerfectPop = improvedResults.filter((r) => r.popDiff <= 1).length;
  const legacyPerfectPop = legacyResults.filter((r) => r.popDiff <= 1).length;

  const eloAvgDiff = (eloResults.reduce((sum, r) => sum + r.eloDiff, 0) / eloResults.length).toFixed(2);
  const baseAvgDiff = (baseResults.reduce((sum, r) => sum + r.eloDiff, 0) / baseResults.length).toFixed(2);
  const impAvgDiff = (improvedResults.reduce((sum, r) => sum + r.eloDiff, 0) / improvedResults.length).toFixed(2);
  const legacyAvgDiff = (legacyResults.reduce((sum, r) => sum + r.eloDiff, 0) / legacyResults.length).toFixed(2);

  console.log(`🏁 LIFECYCLE TEST COMPARISON SUMMARY 🏁`);
  console.log(`Total Real Matches Tested: ${eloResults.length}\n`);

  console.log(`=== NAIVE BASELINE ASSIGN ===`);
  console.log(`Pop Balance <= 1: ${(basePerfectPop / baseResults.length * 100).toFixed(2)}% (${basePerfectPop}/${baseResults.length})`);
  console.log(`Average Elo Difference: ${baseAvgDiff}\n`);

  console.log(`=== LEGACY SMART ASSIGN (Old Averages) ===`);
  console.log(`Pop Balance <= 1: ${(legacyPerfectPop / legacyResults.length * 100).toFixed(2)}% (${legacyPerfectPop}/${legacyResults.length})`);
  console.log(`Average Elo Difference: ${legacyAvgDiff}\n`);

  console.log(`=== NEW SMART ASSIGN (Sum-Gap / Production) ===`);
  console.log(`Pop Balance <= 1: ${(eloPerfectPop / eloResults.length * 100).toFixed(2)}% (${eloPerfectPop}/${eloResults.length})`);
  console.log(`Average Elo Difference: ${eloAvgDiff}\n`);

  const validImpResults = improvedResults.filter((r) => r.t1End + r.t2End >= 70);
  validImpResults.sort((a, b) => b.eloDiff - a.eloDiff);

  console.log(`⚠️ TOP 10 WORST-CASE SCENARIOS (By Elo Difference in NEW SMART ASSIGN) ⚠️`);
  for (let i = 0; i < 10 && i < validImpResults.length; i++) {
    const impR = validImpResults[i];
    const baseR = baseResults.find((b) => b.run === impR.run);
    const legacyR = legacyResults.find((b) => b.run === impR.run);

    console.log(`\n--- Case #${i + 1} (Match ${impR.run}: ${impR.layer}) ---`);
    console.log(`[NEW   ] Pop: T1: ${impR.t1End} | T2: ${impR.t2End} (Diff: ${impR.popDiff}) -- Elo Diff: ${impR.eloDiff.toFixed(2)}`);
    console.log(`[LEGACY] Pop: T1: ${legacyR.t1End} | T2: ${legacyR.t2End} (Diff: ${legacyR.popDiff}) -- Elo Diff: ${legacyR.eloDiff.toFixed(2)}`);
    console.log(`[BASE  ] Pop: T1: ${baseR.t1End} | T2: ${baseR.t2End} (Diff: ${baseR.popDiff}) -- Elo Diff: ${baseR.eloDiff.toFixed(2)}`);
  }
}

async function runTests() {
  console.log('🚀 Starting SmartAssign Verification Tests...\n');

  const rebuiltPath = path.join(__dirname, 'tools', 'rebuilt.json');
  if (!fs.existsSync(rebuiltPath)) {
    console.error(`❌ Could not find ${rebuiltPath}`);
    return;
  }
  
  const rebuiltData = JSON.parse(fs.readFileSync(rebuiltPath, 'utf8'));
  const eloMap = new Map();
  const eosToSteam = new Map();
  for (const p of rebuiltData.players) {
    if (p.steamID) {
      eloMap.set(p.steamID, p.mu);
      eosToSteam.set(p.eosID, p.steamID);
    }
  }

  const options = { 
    database: 'sqlite', 
    logPath: null, 
    maxImbalance: 2, 
    highPopThreshold: 96,
    imbalanceSoftPenalty: 0.05 
  };

  // 1. Setup Pure Greedy
  const eloServer = new MockServer();
  const eloMockTracker = new EloTracker(eloServer, eloMap);
  eloServer.plugins.push(eloMockTracker);
  const eloPlugin = new SmartAssign(eloServer, { ...options, imbalanceSoftPenalty: 0 }, { sqlite: new Sequelize('sqlite::memory:', { logging: false }) });
  eloPlugin.executor = new MockSASwapExecutor(eloServer);
  await eloPlugin.mount();

  // 2. Setup Baseline
  const baseServer = new MockServer();
  const baseMockTracker = new EloTracker(baseServer, eloMap);
  baseServer.plugins.push(baseMockTracker);
  const basePlugin = new BaselineAssign(baseServer, options, { sqlite: new Sequelize('sqlite::memory:', { logging: false }) });
  basePlugin.executor = new MockSASwapExecutor(baseServer);
  await basePlugin.mount();

  // 3. Setup New Improved
  const improvedServer = new MockServer();
  const improvedMockTracker = new EloTracker(improvedServer, eloMap);
  improvedServer.plugins.push(improvedMockTracker);
  const improvedPlugin = new ImprovedAssign(improvedServer, options, {
    sqlite: new Sequelize('sqlite::memory:', { logging: false })
  });
  improvedPlugin.executor = new MockSASwapExecutor(improvedServer);
  await improvedPlugin.mount();

  // 4. Setup Legacy
  const legacyServer = new MockServer();
  const legacyMockTracker = new EloTracker(legacyServer, eloMap);
  legacyServer.plugins.push(legacyMockTracker);
  const legacyPlugin = new LegacyAssign(legacyServer, options, {
    sqlite: new Sequelize('sqlite::memory:', { logging: false })
  });
  legacyPlugin.executor = new MockSASwapExecutor(legacyServer);
  await legacyPlugin.mount();

  await runRealisticLifecycleTests(
    eloPlugin,
    basePlugin,
    improvedPlugin,
    legacyPlugin,
    eloServer,
    baseServer,
    improvedServer,
    legacyServer,
    eloMockTracker,
    baseMockTracker,
    improvedMockTracker,
    legacyMockTracker,
    eosToSteam
  );

  await eloPlugin.unmount();
  await basePlugin.unmount();
  await improvedPlugin.unmount();
  await legacyPlugin.unmount();
}

runTests().catch(err => console.error(err));
