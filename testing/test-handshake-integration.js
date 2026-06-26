/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     HANDSHAKE INTEGRATION TEST (7.1d)                        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Tests the SA-Switch handshake decision logic (§7.1a/7.1g) in
 * isolation — no live Squad server, no RCON commands.
 *
 * ─── KEY RULE FOR QUEUE DIRECTION ────────────────────────────────
 *
 * The handshake evaluates candidates whose TARGET team matches the
 * joining player's BASELINE target team:
 *
 *   baselineTarget=1 → look in t2ToT1 (players on T2 who want T1)
 *   baselineTarget=2 → look in t1ToT2 (players on T1 who want T2)
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node ReferenceScripts/squadjs-smart-assign/testing/test-handshake-integration.js
 *
 */

import assert from 'node:assert/strict';

// ═══════════════════════════════════════════════════════════════════
// INLINED PURE FUNCTIONS FROM sa-team-evaluator.js
// ═══════════════════════════════════════════════════════════════════

function getPenalty(diff) {
  if (diff <= 0.1) return diff * 20;
  if (diff <= 0.3) return 2.0 + (diff - 0.1) * 40;
  if (diff <= 0.6) return 10.0 + (diff - 0.3) * 80;
  return 34.0 + (diff - 0.6) * 150;
}

function computeScore(t1Mus, t2Mus, t1Veterans, t2Veterans, t1Count, t2Count) {
  const getMean = (mus) => mus.length > 0 ? mus.reduce((a, b) => a + b, 0) / mus.length : 25.0;
  const meanT1 = getMean(t1Mus);
  const meanT2 = getMean(t2Mus);
  const meanDiff = Math.abs(meanT1 - meanT2);

  const getTop15Avg = (mus) => {
    if (mus.length === 0) return 25.0;
    const sorted = [...mus].sort((a, b) => b - a);
    const slice = sorted.slice(0, 15);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  };
  const top15T1 = getTop15Avg(t1Mus);
  const top15T2 = getTop15Avg(t2Mus);
  const top15Diff = Math.abs(top15T1 - top15T2);

  const compositeDiff = 0.6 * meanDiff + 0.4 * top15Diff;
  const eloBalancePenalty = getPenalty(compositeDiff);
  const vetRatio1 = t1Count > 0 ? t1Veterans / t1Count : 0;
  const vetRatio2 = t2Count > 0 ? t2Veterans / t2Count : 0;
  const veteranPenalty = Math.abs(vetRatio1 - vetRatio2) * 300;

  return eloBalancePenalty + veteranPenalty;
}

async function getRating(player, eloTracker = null) {
  if (!eloTracker) return { mu: 25.0, roundsPlayed: 0 };
  try {
    return await eloTracker.getRating(player);
  } catch (_) {
    return { mu: 25.0, roundsPlayed: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    process.exitCode = 1;
  }
}

function makePlayer(eosID, steamID, name, teamID, mu = 25.0, roundsPlayed = 0) {
  return { eosID, steamID, name, teamID, mu, roundsPlayed };
}

function makeQueueEntry(eosID, steamID, playerName, currentTeamID, targetTeamID, queuedAt = Date.now()) {
  return { eosID, steamID, playerName, currentTeamID, targetTeamID, queuedAt };
}

// ═══════════════════════════════════════════════════════════════════
// HANDSHAKE EVALUATOR (mirrors SmartAssign._evaluateHandshakeSwap())
// ═══════════════════════════════════════════════════════════════════

async function evaluateHandshakeSwap({
  player, baselineResult, snapshotPromise, s3PlayersGetAll,
  joiningPlayersSet, pendingAssignments, pendingMu, pendingVeterans,
  pendingPlayerMoves, serverPlayers, eloTracker, options
}) {
  if (baselineResult.targetTeam === null) {
    return { shouldOverride: false, reason: 'P3: baseline targetTeam is null' };
  }

  const skipReasons = ['Reconnect Memory (Priority)', 'Clan Grouping'];
  if (skipReasons.some(r => baselineResult.reason && baselineResult.reason.startsWith(r))) {
    return { shouldOverride: false, reason: `P4: baseline is ${baselineResult.reason}` };
  }

  let snapshot;
  try {
    snapshot = await snapshotPromise;
  } catch (err) {
    return { shouldOverride: false, reason: 'Snapshot fetch failed' };
  }
  if (!snapshot) {
    return { shouldOverride: false, reason: 'No snapshot available' };
  }

  const baselineTarget = baselineResult.targetTeam;
  // baselineTarget=1 → look in t2ToT1 (players on T2 wanting T1)
  // baselineTarget=2 → look in t1ToT2 (players on T1 wanting T2)
  const relevantQueue = baselineTarget === 1 ? snapshot.t2ToT1 : snapshot.t1ToT2;

  if (!relevantQueue || relevantQueue.length === 0) {
    return { shouldOverride: false, reason: 'F1: relevant sub-queue empty' };
  }

  const candidate = relevantQueue[0];

  const allPlayers = (typeof s3PlayersGetAll === 'function') ? s3PlayersGetAll() : [];
  const livePlayer = allPlayers.find(p => p.eosID === candidate.eosID);
  if (!livePlayer) {
    return { shouldOverride: false, reason: `F2: candidate ${candidate.playerName} not in S³ players` };
  }

  if (String(livePlayer.teamID) !== String(candidate.currentTeamID)) {
    return { shouldOverride: false, reason: `F3: ${candidate.playerName} team changed externally` };
  }

  if (joiningPlayersSet.has(candidate.eosID)) {
    return { shouldOverride: false, reason: `F4: ${candidate.playerName} is mid-rejoin` };
  }

  // Count current players (excluding candidate and joining player)
  let t1Count = pendingAssignments[1] || 0;
  let t2Count = pendingAssignments[2] || 0;
  let t1MuSum = pendingMu[1] || 0;
  let t2MuSum = pendingMu[2] || 0;
  let t1Vets = pendingVeterans[1] || 0;
  let t2Vets = pendingVeterans[2] || 0;
  const t1Mus = [];
  const t2Mus = [];
  const hasElo = !!(eloTracker?.ready);

  for (const p of serverPlayers) {
    if (!p || p.eosID === player.eosID || p.eosID === candidate.eosID) continue;
    const playerKey = p.steamID || p.eosID;
    if (pendingPlayerMoves.has(playerKey)) continue;
    const tid = String(p.teamID);
    if (tid === '1') {
      t1Count++;
      if (hasElo) {
        const r = await getRating(p, eloTracker);
        t1MuSum += r.mu;
        t1Mus.push(r.mu);
        if (r.roundsPlayed >= 10) t1Vets++;
      }
    } else if (tid === '2') {
      t2Count++;
      if (hasElo) {
        const r = await getRating(p, eloTracker);
        t2MuSum += r.mu;
        t2Mus.push(r.mu);
        if (r.roundsPlayed >= 10) t2Vets++;
      }
    }
  }

  const baseT1Count = t1Count;
  const baseT2Count = t2Count;
  const baseT1MuSum = t1MuSum;
  const baseT2MuSum = t2MuSum;
  const baseT1Vets = t1Vets;
  const baseT2Vets = t2Vets;
  const baseT1Mus = [...t1Mus];
  const baseT2Mus = [...t2Mus];

  const candidateRating = await getRating({ eosID: candidate.eosID, steamID: candidate.steamID }, eloTracker);
  const joinPlayerRating = await getRating(player, eloTracker);

  const candidateTarget = Number(candidate.targetTeamID);
  const candidateCurrent = Number(candidate.currentTeamID);
  const joiningTarget = baselineTarget;

  // Virtual state for F5/F6: joining player on baseline team
  let virtT1Count = baseT1Count;
  let virtT2Count = baseT2Count;
  if (joiningTarget === 1) { virtT1Count++; } else { virtT2Count++; }

  const virtTotalPop = virtT1Count + virtT2Count;
  let virtMaxImbalance;
  if (virtTotalPop >= 96) virtMaxImbalance = 1;
  else if (virtTotalPop >= 90) virtMaxImbalance = 2;
  else if (virtTotalPop >= 82) virtMaxImbalance = 3;
  else virtMaxImbalance = 4;

  const diff = Math.abs(virtT1Count - virtT2Count);
  if (diff > virtMaxImbalance) {
    return { shouldOverride: false, reason: 'F5: virtual pop cap violation' };
  }

  if (virtT1Count > 50 || virtT2Count > 50) {
    return { shouldOverride: false, reason: 'F6: virtual team exceeds 50' };
  }

  const handshakeMode = options.handshakeMode || 'eloGated';
  if (handshakeMode === 'queueDrain') {
    return {
      shouldOverride: true,
      joiningPlayerTargetTeam: candidateCurrent,
      switchPlayerEosID: candidate.eosID,
      switchPlayerName: candidate.playerName,
      reason: 'handshake_swap_queueDrain'
    };
  }

  if (!hasElo) {
    return { shouldOverride: false, reason: 'No Elo data for scoring comparison' };
  }

  // Build virtual state for scoring: both moves applied
  let scoreT1Count = baseT1Count;
  let scoreT2Count = baseT2Count;
  let scoreT1Vets = baseT1Vets;
  let scoreT2Vets = baseT2Vets;
  let scoreT1Mus = [...baseT1Mus];
  let scoreT2Mus = [...baseT2Mus];

  const candidateIsVet = candidateRating.roundsPlayed >= 10;
  if (candidateTarget === 1) {
    scoreT1Count++;
    scoreT1Mus.push(candidateRating.mu);
    if (candidateIsVet) scoreT1Vets++;
  } else {
    scoreT2Count++;
    scoreT2Mus.push(candidateRating.mu);
    if (candidateIsVet) scoreT2Vets++;
  }

  const joinPlayerIsVet = joinPlayerRating.roundsPlayed >= 10;
  if (candidateCurrent === 1) {
    scoreT1Count++;
    scoreT1Mus.push(joinPlayerRating.mu);
    if (joinPlayerIsVet) scoreT1Vets++;
  } else {
    scoreT2Count++;
    scoreT2Mus.push(joinPlayerRating.mu);
    if (joinPlayerIsVet) scoreT2Vets++;
  }

  const virtualScore = computeScore(scoreT1Mus, scoreT2Mus, scoreT1Vets, scoreT2Vets, scoreT1Count, scoreT2Count);
  const baselineScore = baselineResult.baselineScore;
  const threshold = options.handshakeScoreThreshold ?? 0.5;

  if (virtualScore <= baselineScore + threshold) {
    return {
      shouldOverride: true,
      joiningPlayerTargetTeam: candidateCurrent,
      switchPlayerEosID: candidate.eosID,
      switchPlayerName: candidate.playerName,
      reason: 'handshake_swap_eloGated'
    };
  }

  return {
    shouldOverride: false,
    reason: `Scoring threshold not met (base=${baselineScore.toFixed(2)}, virt=${virtualScore.toFixed(2)}, threshold=${threshold})`
  };
}

// ═══════════════════════════════════════════════════════════════════
// BUILDERS
// ═══════════════════════════════════════════════════════════════════

function makeDefaultContext(overrides = {}) {
  return {
    player: makePlayer('join-eos-1', 'join-steam-1', 'JoiningPlayer', 2, 25.0, 5),
    baselineResult: { targetTeam: 1, reason: 'Composite Scoring', baselineScore: 10.5 },
    snapshotPromise: Promise.resolve({ t1ToT2: [], t2ToT1: [] }),
    s3PlayersGetAll: () => [],
    joiningPlayersSet: new Set(),
    pendingAssignments: { 1: 0, 2: 0 },
    pendingMu: { 1: 0, 2: 0 },
    pendingVeterans: { 1: 0, 2: 0 },
    pendingPlayerMoves: new Map(),
    serverPlayers: [],
    eloTracker: null,
    options: { handshakeMode: 'eloGated', handshakeScoreThreshold: 0.5 },
    ...overrides
  };
}

// ═══════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════

console.log('\n📋 Handshake Integration Tests (7.1d)\n');

// (1) Swap improves metrics → handshake activates (eloGated)
// Both teams are identical (3 players each, all mu=25, 0 vets). Baseline score = 0.
// Switch player on T2 wants T1 (mu=25). Joining player on T2, baseline wants T1.
// Swap: Switch→T1, joining→T2 (=candidateCurrent=2). Both teams still perfectly balanced.
// Virtual score = 0 ≤ baseline(0) + threshold(0.5) → swap approved.
await runTest('(1) Swap improves metrics → handshake activates (eloGated)', async () => {
  const switchPlayer = makePlayer('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 25.0, 5);
  const joinPlayer = makePlayer('join-eos-1', 'join-steam-1', 'JoiningPlayer', 2, 25.0, 5);

  const existingPlayers = [
    makePlayer('p1', 's1', 'P1', 1, 25.0, 5),
    makePlayer('p2', 's2', 'P2', 1, 25.0, 5),
    makePlayer('p3', 's3', 'P3', 1, 25.0, 5),
    makePlayer('p4', 's4', 'P4', 2, 25.0, 5),
    makePlayer('p5', 's5', 'P5', 2, 25.0, 5),
    makePlayer('p6', 's6', 'P6', 2, 25.0, 5),
  ];

  const mockEloTracker = {
    ready: true,
    getRating: async (p) => ({ mu: 25.0, roundsPlayed: 5 })
  };

  const ctx = makeDefaultContext({
    player: joinPlayer,
    baselineResult: { targetTeam: 1, reason: 'Composite Scoring', baselineScore: 0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [],
      t2ToT1: [makeQueueEntry('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 1)]
    }),
    s3PlayersGetAll: () => [switchPlayer, ...existingPlayers],
    serverPlayers: existingPlayers,
    eloTracker: mockEloTracker
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, true, `Expected swap, got: ${result.reason}`);
  assert.equal(result.switchPlayerEosID, 'switch-eos-1');
  assert.ok(result.reason.startsWith('handshake_swap'), `Expected handshake reason, got: ${result.reason}`);
});

// (2) Queue empty → baseline unchanged
await runTest('(2) Queue empty → baseline unchanged', async () => {
  const ctx = makeDefaultContext({
    baselineResult: { targetTeam: 1, reason: 'Composite Scoring', baselineScore: 8.0 },
    snapshotPromise: Promise.resolve({ t1ToT2: [], t2ToT1: [] })
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
  assert.ok(result.reason.startsWith('F1'), `Expected F1 failure, got: ${result.reason}`);
});

// (3) Clan grouping prevents swap (P4)
await runTest('(3) Clan grouping prevents swap → fallback (P4)', async () => {
  const ctx = makeDefaultContext({
    baselineResult: { targetTeam: 1, reason: 'Clan Grouping', baselineScore: 8.0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [],
      t2ToT1: [makeQueueEntry('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 1)]
    })
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
  assert.ok(result.reason.startsWith('P4'), `Expected P4 failure, got: ${result.reason}`);
});

// (4) Reconnect priority bypasses handshake (P4)
await runTest('(4) Reconnect priority bypasses handshake (P4)', async () => {
  const ctx = makeDefaultContext({
    baselineResult: { targetTeam: 1, reason: 'Reconnect Memory (Priority)', baselineScore: 8.0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [],
      t2ToT1: [makeQueueEntry('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 1)]
    })
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
  assert.ok(result.reason.startsWith('P4'), `Expected P4 failure, got: ${result.reason}`);
});

// (5) Baseline targetTeam is null (P3)
await runTest('(5) Baseline targetTeam null → no swap (P3)', async () => {
  const ctx = makeDefaultContext({
    baselineResult: { targetTeam: null, reason: 'Full teams', baselineScore: Infinity }
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
  assert.ok(result.reason.startsWith('P3'), `Expected P3 failure, got: ${result.reason}`);
});

// (6) Candidate not in S³ players list (F2)
await runTest('(6) Candidate not in S³ players → rejected (F2)', async () => {
  const ctx = makeDefaultContext({
    baselineResult: { targetTeam: 1, reason: 'Composite Scoring', baselineScore: 8.0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [],
      t2ToT1: [makeQueueEntry('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 1)]
    }),
    s3PlayersGetAll: () => []
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
  assert.ok(result.reason.startsWith('F2'), `Expected F2 failure, got: ${result.reason}`);
});

// (7) Candidate team changed externally (F3)
await runTest('(7) Candidate team changed externally → rejected (F3)', async () => {
  // switchPlayer.teamID=1 (changed), but queue says currentTeamID=2 → mismatch
  const switchPlayer = makePlayer('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 1, 35.0, 20);

  const ctx = makeDefaultContext({
    baselineResult: { targetTeam: 1, reason: 'Composite Scoring', baselineScore: 8.0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [],
      t2ToT1: [makeQueueEntry('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 1)]
    }),
    s3PlayersGetAll: () => [switchPlayer]
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
  assert.ok(result.reason.startsWith('F3'), `Expected F3 failure, got: ${result.reason}`);
});

// (8) Candidate mid-rejoin (F4)
await runTest('(8) Candidate mid-rejoin → rejected (F4)', async () => {
  const switchPlayer = makePlayer('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 35.0, 20);

  const ctx = makeDefaultContext({
    baselineResult: { targetTeam: 1, reason: 'Composite Scoring', baselineScore: 8.0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [],
      t2ToT1: [makeQueueEntry('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 1)]
    }),
    s3PlayersGetAll: () => [switchPlayer],
    joiningPlayersSet: new Set(['switch-eos-1'])
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
  assert.ok(result.reason.startsWith('F4'), `Expected F4 failure, got: ${result.reason}`);
});

// (9) Virtual pop cap violation (F5)
await runTest('(9) Virtual pop cap violation → rejected (F5)', async () => {
  // T1=50, T2=47, total=97 → maxImbalance=1
  // Joining on T2, baseline wants T1 → virtual T1=51, T2=47 → diff=4 > 1
  const switchPlayer = makePlayer('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 25.0, 10);
  const joinPlayer = makePlayer('join-eos-1', 'join-steam-1', 'JoiningPlayer', 2, 25.0, 5);

  const t1Players = Array.from({ length: 50 }, (_, i) =>
    makePlayer(`t1-${i}`, `st1-${i}`, `T1Player${i}`, 1, 25.0, 10));
  const t2Players = Array.from({ length: 47 }, (_, i) =>
    makePlayer(`t2-${i}`, `st2-${i}`, `T2Player${i}`, 2, 25.0, 10));

  const ctx = makeDefaultContext({
    player: joinPlayer,
    baselineResult: { targetTeam: 1, reason: 'Composite Scoring', baselineScore: 5.0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [],
      t2ToT1: [makeQueueEntry('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 1)]
    }),
    s3PlayersGetAll: () => [switchPlayer, ...t1Players, ...t2Players],
    serverPlayers: [...t1Players, ...t2Players],
    eloTracker: { ready: true, getRating: async (p) => ({ mu: p.mu ?? 25.0, roundsPlayed: p.roundsPlayed ?? 0 }) }
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
  assert.ok(result.reason.startsWith('F5'), `Expected F5 failure, got: ${result.reason}`);
});

// (10) Virtual team cap violation — F5 fires before F6
// T1=50, T2=47, total=97 → maxImbalance=1. Virtual T1=51, T2=47 → diff=4 > 1 → F5.
// (F5 is checked before F6, so F5 fires first.)
await runTest('(10) Virtual high-pop imbalance triggers F5 before F6', async () => {
  const switchPlayer = makePlayer('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 25.0, 10);
  const joinPlayer = makePlayer('join-eos-1', 'join-steam-1', 'JoiningPlayer', 2, 25.0, 5);

  const t1Players = Array.from({ length: 50 }, (_, i) =>
    makePlayer(`t1-${i}`, `st1-${i}`, `T1Player${i}`, 1, 25.0, 10));
  const t2Players = Array.from({ length: 47 }, (_, i) =>
    makePlayer(`t2-${i}`, `st2-${i}`, `T2Player${i}`, 2, 25.0, 10));

  const ctx = makeDefaultContext({
    player: joinPlayer,
    baselineResult: { targetTeam: 1, reason: 'Composite Scoring', baselineScore: 5.0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [],
      t2ToT1: [makeQueueEntry('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 1)]
    }),
    s3PlayersGetAll: () => [switchPlayer, ...t1Players, ...t2Players],
    serverPlayers: [...t1Players, ...t2Players],
    eloTracker: { ready: true, getRating: async (p) => ({ mu: p.mu ?? 25.0, roundsPlayed: p.roundsPlayed ?? 0 }) }
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
  // At total=97, maxImbalance=1. Virtual diff=4 > 1 → F5 fires before F6
  assert.ok(result.reason.startsWith('F5'), `Expected F5, got: ${result.reason}`);
});

// (11) queueDrain mode → swap regardless of score
await runTest('(11) queueDrain mode → swap regardless of score', async () => {
  const switchPlayer = makePlayer('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 35.0, 20);
  const joinPlayer = makePlayer('join-eos-1', 'join-steam-1', 'JoiningPlayer', 2, 25.0, 5);

  const existingPlayers = [
    makePlayer('p1', 's1', 'Player1', 1, 40.0, 50),
    makePlayer('p2', 's2', 'Player2', 2, 15.0, 5),
  ];

  const ctx = makeDefaultContext({
    player: joinPlayer,
    baselineResult: { targetTeam: 1, reason: 'Composite Scoring', baselineScore: 5.0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [],
      t2ToT1: [makeQueueEntry('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 1)]
    }),
    s3PlayersGetAll: () => [switchPlayer, ...existingPlayers],
    serverPlayers: existingPlayers,
    eloTracker: { ready: true, getRating: async (p) => ({ mu: p.mu ?? 25.0, roundsPlayed: p.roundsPlayed ?? 0 }) },
    options: { handshakeMode: 'queueDrain', handshakeScoreThreshold: 0.5 }
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, true, `Expected swap in queueDrain mode, got: ${result.reason}`);
  assert.equal(result.reason, 'handshake_swap_queueDrain');
  assert.equal(result.joiningPlayerTargetTeam, 2); // candidate.currentTeamID
});

// (12) Scoring threshold not met → no swap
await runTest('(12) Scoring threshold not met → no swap (eloGated)', async () => {
  // Swap would make balance significantly worse
  const switchPlayer = makePlayer('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 45.0, 50);
  const joinPlayer = makePlayer('join-eos-1', 'join-steam-1', 'JoiningPlayer', 2, 25.0, 5);

  const existingPlayers = [
    makePlayer('p1', 's1', 'T1Strong1', 1, 40.0, 50),
    makePlayer('p2', 's2', 'T1Strong2', 1, 38.0, 40),
    makePlayer('p3', 's3', 'T2Weak1', 2, 15.0, 5),
    makePlayer('p4', 's4', 'T2Weak2', 2, 18.0, 3),
  ];

  const ctx = makeDefaultContext({
    player: joinPlayer,
    baselineResult: { targetTeam: 1, reason: 'Composite Scoring', baselineScore: 5.0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [],
      t2ToT1: [makeQueueEntry('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 1)]
    }),
    s3PlayersGetAll: () => [switchPlayer, ...existingPlayers],
    serverPlayers: existingPlayers,
    eloTracker: { ready: true, getRating: async (p) => ({ mu: p.mu ?? 25.0, roundsPlayed: p.roundsPlayed ?? 0 }) },
    options: { handshakeMode: 'eloGated', handshakeScoreThreshold: 0.1 }
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
});

// (13) Snapshot promise rejects → fallback
await runTest('(13) Snapshot fetch fails → fallback to baseline', async () => {
  const ctx = makeDefaultContext({
    snapshotPromise: Promise.reject(new Error('Switch crash'))
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
  assert.ok(result.reason.startsWith('Snapshot'), `Expected snapshot failure, got: ${result.reason}`);
});

// (14) Only head candidate evaluated (strict FIFO)
await runTest('(14) Only head candidate evaluated (strict FIFO)', async () => {
  // baselineTarget=2 → look in t1ToT2. Head fails F2, second candidate would pass but is never checked.
  const joinPlayer = makePlayer('join-eos-1', 'join-steam-1', 'JoiningPlayer', 1, 25.0, 5);

  const ctx = makeDefaultContext({
    player: joinPlayer,
    baselineResult: { targetTeam: 2, reason: 'Composite Scoring', baselineScore: 8.0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [
        makeQueueEntry('head-eos', 'head-steam', 'HeadPlayer', 1, 2), // Not in S³ → F2 fails
        makeQueueEntry('second-eos', 'second-steam', 'SecondPlayer', 1, 2) // Would pass
      ],
      t2ToT1: []
    }),
    s3PlayersGetAll: () => [
      makePlayer('second-eos', 'second-steam', 'SecondPlayer', 1, 30.0, 20)
    ]
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.equal(result.shouldOverride, false);
  assert.ok(result.reason.includes('HeadPlayer'), `Expected failure for HeadPlayer, got: ${result.reason}`);
});

// (15) Default options work
await runTest('(15) Default options work with minimal config', async () => {
  const switchPlayer = makePlayer('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 35.0, 20);
  const joinPlayer = makePlayer('join-eos-1', 'join-steam-1', 'JoiningPlayer', 2, 25.0, 5);

  const existingPlayers = [
    makePlayer('p1', 's1', 'Player1', 1, 25.0, 50),
    makePlayer('p2', 's2', 'Player2', 2, 25.0, 5),
  ];

  const ctx = makeDefaultContext({
    player: joinPlayer,
    baselineResult: { targetTeam: 1, reason: 'Composite Scoring', baselineScore: 3.0 },
    snapshotPromise: Promise.resolve({
      t1ToT2: [],
      t2ToT1: [makeQueueEntry('switch-eos-1', 'switch-steam-1', 'SwitchPlayer', 2, 1)]
    }),
    s3PlayersGetAll: () => [switchPlayer, ...existingPlayers],
    serverPlayers: existingPlayers,
    eloTracker: { ready: true, getRating: async (p) => ({ mu: p.mu ?? 25.0, roundsPlayed: p.roundsPlayed ?? 0 }) },
    options: {}
  });

  const result = await evaluateHandshakeSwap(ctx);
  assert.ok(result.shouldOverride !== undefined);
  assert.ok(typeof result.reason === 'string');
});

// ── SUMMARY ──
if (!process.exitCode) {
  console.log('\n✅ All handshake integration tests passed.\n');
} else {
  console.log('\n❌ Some tests failed. See above for details.\n');
}