/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      TB — ELO-DIFF MICRO SCRAMBLE TRIGGER                     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Covers the fourth scramble trigger — a small, budget-capped correction
 * fired from the mu gap between teams in the round that just ended, distinct
 * from the three ticket-margin-driven triggers plugin-logic-test-runner.js
 * already covers:
 *
 *   - _evaluateEloDiffTrigger()        threshold logic, defaultMu fallback,
 *                                       the "lost the race" no-announce guard
 *   - initiateScramble/executeScramble scrambleType plumbing: _pendingScrambleType
 *                                       set on every arming path but not on the
 *                                       pending/in-progress guard rejection,
 *                                       captured+cleared at the top of
 *                                       executeScramble, EloDiff-vs-generic
 *                                       message/event/resetStreak branching
 *   - _runEloDiffMicroScrambleSearch() escalating budget, early stop at the
 *                                       parity target, best-plan fallback,
 *                                       the population-percentage budget cap,
 *                                       the empty-eloMap guard
 *   - _computePostSwapMuDiff()         pure post-swap mu-gap arithmetic
 *   - onScrambleCommand() "elo" flag   admin manual-trigger composability (now/dry/scheduled/
 *                                       matchend), scrambleType threading into initiateScramble
 *                                       and into the matchend arm object, and the same
 *                                       requireScrambleConfirmation gate a normal scramble uses
 *   - onRoundEnded() matchend-fire     branches on armedBy.scrambleType: micro-scramble broadcast
 *                                       text, roundReport.scrambleCondition/scrambleType, and the
 *                                       scrambleType passed to the deferred initiateScramble() call
 *
 * ─── DETERMINISM ─────────────────────────────────────────────────
 *
 * scrambleTeamsPreservingSquads() is a randomised, unseeded search (see
 * test-tb-elo-scramble.js) — unsuitable for pinning an exact budget-escalation
 * sequence. _runEloDiffMicroScrambleSearch() calls it through the plugin's own
 * `Scrambler` import, so this file imports the SAME module instance out of the
 * assembly (utils/tb-scrambler.js resolves to one file on disk; Node's module
 * cache hands back the identical object either way it's reached) and replaces
 * scrambleTeamsPreservingSquads with a stub for the duration of each test,
 * restoring the original afterward. That turns "escalate the budget until
 * parity" into a deterministic, inspectable sequence of stub calls.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-elo-diff-scramble.js
 *
 */

import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';
import { makeMockS3, makeS3Db } from '../../s3/testing/mock-s3.js';
import Logger from '../../core/logger.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const assembly = buildAssembly('.tmp-tb-elo-diff-scramble');
const TeamBalancer = await importFromAssembly(assembly, 'team-balancer.js');
const scramblerModule = await import(pathToFileURL(path.join(assembly, 'utils', 'tb-scrambler.js')).href);
const Scrambler = scramblerModule.default;
const realScrambleTeamsPreservingSquads = Scrambler.scrambleTeamsPreservingSquads;

Logger.verbose = (module, level, message) => {
  if (level === 1) console.error(`[${module}] ERROR: ${message}`);
};

let testCount = 0;
let passCount = 0;
function assert(condition, message) {
  testCount++;
  if (condition) {
    passCount++;
    console.log(`  ✅ PASS: ${message}`);
  } else {
    console.log(`  ❌ FAIL: ${message}`);
  }
}

function makePlayer(eosID, teamID) {
  return {
    eosID,
    steamID: `steam_${eosID}`,
    name: eosID,
    teamID,
    squadID: null,
    roles: ['Rifleman']
  };
}

// executeScramble() looks up an EloTracker plugin by constructor.name — not present in
// plugin-logic-test-runner.js's harness, but required here since scrambleType === 'EloDiff'
// always needs a non-empty eloMap to reach _runEloDiffMicroScrambleSearch's Scrambler call at
// all (its own guard returns [] on a missing/empty map before the search loop runs).
class EloTracker {
  constructor() { this.lastRoundSnapshot = null; }
  async getRatingsByEosIDs(eosIDs) {
    const map = new Map();
    for (const eosID of eosIDs) map.set(eosID, { mu: 25 });
    return map;
  }
}

/** Builds a fresh mounted TeamBalancer instance, isolated per test. */
async function buildPlugin(optionOverrides = {}) {
  const capturedBroadcasts = [];
  const emitted = [];
  const mockServer = {
    rcon: {
      broadcast: async (msg) => { capturedBroadcasts.push(msg); },
      execute: async () => {},
      warn: async () => {},
      switchTeam: async (rconIdentifier, teamID) => {
        const player = mockServer.players.find(
          (p) => p.steamID === rconIdentifier || p.name === rconIdentifier || p.eosID === rconIdentifier
        );
        if (player) player.teamID = Number(teamID);
      }
    },
    players: [],
    squads: [],
    currentLayer: null,
    plugins: [makeMockS3({ db: await makeS3Db() }), new EloTracker()],
    removeListener: () => {},
    on: () => {},
    listenerCount: () => 0,
    emit: (eventName, payload) => { emitted.push({ eventName, payload }); },
    updatePlayerList: async () => {}
  };

  const mockDbState = {
    winStreakTeam: null,
    winStreakCount: 0,
    consecutiveWinsTeam: null,
    consecutiveWinsCount: 0,
    lastSyncTimestamp: Date.now(),
    lastScrambleTime: null
  };
  const mockModel = {
    sync: async () => {},
    findOrCreate: async () => {
      const instance = {
        ...mockDbState,
        save: async function () { Object.assign(mockDbState, this); }
      };
      return [instance, true];
    },
    findByPk: async () => ({
      ...mockDbState,
      save: async function () { Object.assign(mockDbState, this); }
    })
  };
  const mockConnectors = {
    sqlite: {
      define: () => mockModel,
      transaction: async (fn) => fn({ commit: async () => {}, rollback: async () => {}, LOCK: { UPDATE: 'UPDATE' } }),
      query: async () => []
    }
  };

  const options = {
    database: 'sqlite',
    enableWinStreakTracking: true,
    maxWinStreak: 2,
    maxConsecutiveWinsWithoutThreshold: 3,
    enableSingleRoundScramble: false,
    singleRoundScrambleThreshold: 500,
    minTicketsToCountAsDominantWin: 300,
    invasionAttackTeamThreshold: 300,
    invasionDefenceTeamThreshold: 650,
    scrambleAnnouncementDelay: 10,
    scramblePercentage: 0.5,
    showWinStreakMessages: true,
    debugLogs: false,
    devMode: true,
    useGenericTeamNamesInBroadcasts: true,
    changeTeamRetryInterval: 150,
    maxScrambleCompletionTime: 5000,
    warnOnSwap: false,
    discordClient: null,
    discordAdminChannelID: null,
    discordReportChannelID: null,
    discordAdminRoleIDs: [],
    eloDiffScrambleThreshold: 1.2,
    microScrambleParityTarget: 0.05,
    microScrambleMaxMovePercent: 0.2,
    useEloForBalance: false,
    // Section 1-5 don't touch onScrambleCommand at all, and most of Section 6/7 wants to
    // isolate the "elo" flag's own plumbing from the (separately tested) confirmation gate.
    requireScrambleConfirmation: false,
    ...optionOverrides
  };

  const tb = new TeamBalancer(mockServer, options, mockConnectors);
  tb.RconMessages = {
    prefix: '[TB]',
    executeScrambleMessage: 'Scrambling teams!',
    executeDryRunMessage: 'Dry run scramble!',
    scrambleCompleteMessage: 'Scramble complete.',
    microScrambleCompleteMessage: 'Micro Elo-diff scramble complete.',
    scrambleFailedMessage: 'Scramble failed.',
    microScrambleFailedMessage: 'Micro Elo-diff scramble found no change needed.',
    manualScrambleAnnouncement: 'Manual scramble in {delay}s',
    immediateManualScramble: 'Scrambling now!',
    manualMicroScrambleAnnouncement: 'Manual micro scramble in {delay}s',
    immediateManualMicroScramble: 'Scrambling micro now!',
    scrambleAnnouncement: 'Scramble in {delay}s after {count} dominant wins',
    microScrambleAnnouncement: 'Micro Elo-diff scramble in {delay}s (margin {margin})',
    singleRoundScramble: 'Single round scramble triggered.',
    consecutiveWinsScramble: '{team} has won {count} consecutive rounds | Scrambling in {delay}s...',
    system: { trackingEnabled: 'Tracking enabled', trackingDisabled: 'Tracking disabled' },
    dominant: { stomped: 'Stomp', steamrolled: 'Steamrolled', invasionAttackStomp: 'Atk Stomp', invasionDefendStomp: 'Def Stomp' },
    nonDominant: { streakBroken: 'Streak Broken', invasionAttackWin: 'Atk Win', invasionDefendWin: 'Def Win', narrowVictory: 'Narrow', marginalVictory: 'Marginal', tacticalAdvantage: 'Tactical', operationalSuperiority: 'Operational' }
  };
  tb.formatMessage = (msg, params) => {
    if (!msg) return '';
    return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), msg);
  };

  await tb.prepareToMount();
  await tb.mount();

  const mockS3 = mockServer.plugins[0];
  mockS3.emitLayerGameModeChange('Fallujah_RAAS_v2', 'RAAS');

  return { tb, mockServer, mockS3, capturedBroadcasts, emitted };
}

/** Swaps in a stub for the plugin's Scrambler for the duration of `fn`, then restores it. */
async function withScramblerStub(stubFn, fn) {
  Scrambler.scrambleTeamsPreservingSquads = stubFn;
  try {
    await fn();
  } finally {
    Scrambler.scrambleTeamsPreservingSquads = realScrambleTeamsPreservingSquads;
  }
}

async function runTests() {
  console.log('\n🚀 Starting Elo-Diff Micro Scramble Tests...');

  // ── _evaluateEloDiffTrigger(): threshold logic ──────────────────────────
  console.log('\n[Section 1: _evaluateEloDiffTrigger threshold logic]');
  {
    const { tb } = await buildPlugin();
    const snapshot = new Map([
      ['t1_a', { mu: 30 }], ['t1_b', { mu: 30 }],
      ['t2_a', { mu: 20 }], ['t2_b', { mu: 20 }]
    ]); // diff = 10, well above threshold 1.2
    let armedWith = null;
    tb.initiateScramble = async (...args) => { armedWith = args; return true; };
    tb.server.rcon.broadcast = async (msg) => { tb._testLastBroadcast = msg; };

    await tb._evaluateEloDiffTrigger({
      team1EosIDs: ['t1_a', 't1_b'],
      team2EosIDs: ['t2_a', 't2_b'],
      ticketMargin: 42,
      snapshot
    });
    assert(armedWith !== null, 'a 10μ gap (>= 1.2 threshold) arms initiateScramble.');
    assert(armedWith && armedWith[5] === 'EloDiff', 'initiateScramble is called with scrambleType "EloDiff".');
    assert(!!tb._testLastBroadcast && tb._testLastBroadcast.includes('Micro Elo-diff'), 'an armed trigger broadcasts the micro-scramble announcement.');
  }

  {
    const { tb } = await buildPlugin();
    const snapshot = new Map([
      ['t1_a', { mu: 25.5 }], ['t2_a', { mu: 25.0 }]
    ]); // diff = 0.5, below threshold 1.2
    let armed = false;
    tb.initiateScramble = async () => { armed = true; return true; };

    await tb._evaluateEloDiffTrigger({
      team1EosIDs: ['t1_a'],
      team2EosIDs: ['t2_a'],
      ticketMargin: 10,
      snapshot
    });
    assert(!armed, 'a 0.5μ gap (< 1.2 threshold) does not arm a scramble.');
  }

  {
    const { tb } = await buildPlugin({ eloDiffScrambleThreshold: 2 });
    let armed = false;
    tb.initiateScramble = async () => { armed = true; return true; };
    // Exactly at threshold: the check is `diff < threshold`, so equal should fire.
    const snapshot = new Map([['t1_a', { mu: 27 }], ['t2_a', { mu: 25 }]]); // diff = 2
    await tb._evaluateEloDiffTrigger({ team1EosIDs: ['t1_a'], team2EosIDs: ['t2_a'], ticketMargin: 5, snapshot });
    assert(armed, 'a gap exactly equal to the threshold arms the scramble (boundary is inclusive).');
  }

  {
    const { tb } = await buildPlugin();
    // Empty snapshot: every player falls back to defaultMu 25.0 on both sides, so diff is 0
    // regardless of roster size — this must not throw and must not arm.
    let armed = false;
    tb.initiateScramble = async () => { armed = true; return true; };
    await tb._evaluateEloDiffTrigger({
      team1EosIDs: ['unknown_a', 'unknown_b'],
      team2EosIDs: ['unknown_c'],
      ticketMargin: 10,
      snapshot: new Map()
    });
    assert(!armed, 'players missing from the snapshot fall back to defaultMu on both sides, producing zero diff and no arm.');
  }

  {
    const { tb } = await buildPlugin();
    // One side entirely unrated (defaultMu 25.0), the other well above it — the fallback
    // must still participate in the comparison rather than being skipped.
    let armed = false;
    tb.initiateScramble = async () => { armed = true; return true; };
    const snapshot = new Map([['t1_a', { mu: 40 }]]); // t2 has nobody in the snapshot -> defaultMu 25.0
    await tb._evaluateEloDiffTrigger({
      team1EosIDs: ['t1_a'],
      team2EosIDs: ['unrated_player'],
      ticketMargin: 10,
      snapshot
    });
    assert(armed, 'an unrated team compares against defaultMu 25.0, not against a skipped/zero contribution (15μ gap arms).');
  }

  {
    const { tb } = await buildPlugin();
    // initiateScramble() legitimately loses the race (another trigger already has a scramble
    // pending/in-progress) -> must not broadcast a phantom announcement.
    let broadcastCalled = false;
    tb.initiateScramble = async () => false;
    tb.server.rcon.broadcast = async () => { broadcastCalled = true; };
    const snapshot = new Map([['t1_a', { mu: 40 }], ['t2_a', { mu: 20 }]]);
    await tb._evaluateEloDiffTrigger({ team1EosIDs: ['t1_a'], team2EosIDs: ['t2_a'], ticketMargin: 10, snapshot });
    assert(!broadcastCalled, 'initiateScramble() returning false (lost the race) suppresses the announcement broadcast.');
  }

  // ── initiateScramble(): _pendingScrambleType plumbing ───────────────────
  console.log('\n[Section 2: initiateScramble _pendingScrambleType plumbing]');
  {
    const { tb } = await buildPlugin();
    let capturedType = 'unset';
    tb.executeScramble = async () => { capturedType = tb._pendingScrambleType; return true; };
    await tb.initiateScramble(true, false, null, null, null, 'EloDiff');
    assert(capturedType === 'EloDiff', 'isSimulated=true path sets _pendingScrambleType before calling executeScramble.');
  }
  {
    const { tb } = await buildPlugin();
    let capturedType = 'unset';
    tb.executeScramble = async () => { capturedType = tb._pendingScrambleType; return true; };
    await tb.initiateScramble(false, true, null, null, null, 'EloDiff');
    assert(capturedType === 'EloDiff', 'immediate=true (non-simulated) path sets _pendingScrambleType before calling executeScramble.');
  }
  {
    const { tb } = await buildPlugin();
    let capturedType = 'unset';
    tb.executeScramble = async () => { capturedType = tb._pendingScrambleType; return true; };
    tb.options.scrambleAnnouncementDelay = 0.02;
    await tb.initiateScramble(false, false, null, null, null, 'EloDiff');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(capturedType === 'EloDiff', 'the delayed-countdown path also carries _pendingScrambleType through to executeScramble.');
  }
  {
    const { tb } = await buildPlugin();
    tb._scramblePending = true; // force the guard-rejection branch
    const before = tb._pendingScrambleType;
    const result = await tb.initiateScramble(false, false, null, null, null, 'EloDiff');
    assert(result === false, 'initiateScramble returns false when a scramble is already pending.');
    assert(tb._pendingScrambleType === before, 'the guard-rejection path never touches _pendingScrambleType.');
  }
  {
    const { tb } = await buildPlugin();
    // executeScramble() itself must capture-then-clear, independent of how it got there.
    tb._pendingScrambleType = 'EloDiff';
    let sawDuringRun = 'unset';
    const originalTransform = tb.transformSquadJSData.bind(tb);
    tb.transformSquadJSData = (...args) => {
      sawDuringRun = tb._pendingScrambleType;
      return originalTransform(...args);
    };
    tb.server.players = [];
    tb.server.squads = [];
    tb._s3.state.players = [];
    tb._s3.state.squads = [];
    await tb.executeScramble(true); // simulated, empty roster -> no-op plan, fast
    assert(sawDuringRun === null, '_pendingScrambleType is already cleared by the time the rest of executeScramble runs.');
    assert(tb._pendingScrambleType === null, '_pendingScrambleType stays cleared after executeScramble finishes.');
  }

  // ── executeScramble(): EloDiff-specific branching ────────────────────────
  console.log('\n[Section 3: executeScramble EloDiff branching]');

  function seedRoster({ tb, mockS3 }, { t1Count, t2Count }) {
    const players = [
      ...Array.from({ length: t1Count }, (_, i) => makePlayer(`t1_${i}`, 1)),
      ...Array.from({ length: t2Count }, (_, i) => makePlayer(`t2_${i}`, 2))
    ];
    tb.server.players = players;
    mockS3.state.players = players;
    mockS3.state.squads = [];
    return players;
  }

  await withScramblerStub(
    async () => [{ eosID: 't1_0', targetTeamID: '2' }],
    async () => {
      const { tb, mockS3, emitted } = await buildPlugin();
      seedRoster({ tb, mockS3 }, { t1Count: 5, t2Count: 5 });
      tb._pendingScrambleType = 'EloDiff';
      await tb.executeScramble(false);

      const scrambleEvent = emitted.find((e) => e.eventName === 'TEAM_BALANCER_SCRAMBLE_EXECUTED');
      assert(!!scrambleEvent, 'a completed EloDiff scramble emits TEAM_BALANCER_SCRAMBLE_EXECUTED.');
      assert(scrambleEvent && scrambleEvent.payload.scrambleType === 'EloDiff', 'the emitted payload carries scrambleType "EloDiff".');
    }
  );

  await withScramblerStub(
    async () => [{ eosID: 't1_0', targetTeamID: '2' }],
    async () => {
      const { tb, mockS3, capturedBroadcasts } = await buildPlugin();
      seedRoster({ tb, mockS3 }, { t1Count: 5, t2Count: 5 });
      tb._pendingScrambleType = 'EloDiff';
      capturedBroadcasts.length = 0;
      await tb.executeScramble(false);

      const completeMsg = capturedBroadcasts.find((m) => m.includes('complete'));
      assert(!!completeMsg && completeMsg.includes('Micro Elo-diff'), 'an EloDiff scramble broadcasts microScrambleCompleteMessage, not the generic one.');
    }
  );

  await withScramblerStub(
    async () => [{ eosID: 't1_0', targetTeamID: '2' }],
    async () => {
      const { tb, mockS3 } = await buildPlugin();
      seedRoster({ tb, mockS3 }, { t1Count: 5, t2Count: 5 });
      tb.winStreakCount = 1;
      tb.winStreakTeam = 1;
      tb._pendingScrambleType = 'EloDiff';
      await tb.executeScramble(false);
      assert(tb.winStreakCount === 1, 'an EloDiff scramble does NOT reset the win-streak counter (policy: small correction, streak signal stays live).');
    }
  );

  await withScramblerStub(
    async () => [{ eosID: 't1_0', targetTeamID: '2' }],
    async () => {
      // Control case: a normal (non-EloDiff) scramble DOES reset the streak, confirming the
      // branch above is actually discriminating on scrambleType and not just always skipping.
      const { tb, mockS3 } = await buildPlugin();
      seedRoster({ tb, mockS3 }, { t1Count: 5, t2Count: 5 });
      tb.winStreakCount = 1;
      tb.winStreakTeam = 1;
      tb._pendingScrambleType = null;
      await tb.executeScramble(false);
      assert(tb.winStreakCount === 0, 'a normal scramble still resets the win-streak counter to 0.');
    }
  );

  await withScramblerStub(
    (function () {
      // Both the generic path and _runEloDiffMicroScrambleSearch() ultimately call this same
      // Scrambler function — the discriminator isn't whether it's called, it's WITH WHAT. The
      // 40-55-person forced-churn hack (skipped for EloDiff, see the comment at its call site in
      // team-balancer.js) would show up here as minPlayersToMove/maxPlayersToMove of 40/55; the
      // micro-scramble search's own budget escalation starts at 2/2 instead.
      const calls = [];
      const stub = async ({ minPlayersToMove, maxPlayersToMove }) => {
        calls.push({ minPlayersToMove, maxPlayersToMove });
        return [];
      };
      stub.__calls = calls;
      return stub;
    })(),
    async () => {
      const { tb, mockS3, capturedBroadcasts } = await buildPlugin({ eloDiffScrambleThreshold: 100 }); // never fires via the trigger path
      seedRoster({ tb, mockS3 }, { t1Count: 5, t2Count: 5 });
      tb._pendingScrambleType = 'EloDiff';
      await tb.executeScramble(false);
      const firstCall = Scrambler.scrambleTeamsPreservingSquads.__calls[0];
      assert(
        !!firstCall && firstCall.minPlayersToMove === 2 && firstCall.maxPlayersToMove === 2,
        `scrambleType EloDiff drives the search's own escalating budget (min=max=2 at the first step), not the 40/55 forced-churn hack (got ${JSON.stringify(firstCall)}).`
      );
      // Every budget step returned an empty plan, so executeScramble takes the empty-plan
      // failure branch. It must use microScrambleFailedMessage, not the generic
      // scrambleFailedMessage — reusing the generic text would broadcast "Scramble failed!"
      // for what is actually just "no small correction was needed."
      assert(
        capturedBroadcasts.some((m) => m.includes('Micro Elo-diff scramble found no change needed')),
        `an EloDiff scramble with no budget-sized plan broadcasts microScrambleFailedMessage, not the generic one (got ${JSON.stringify(capturedBroadcasts)}).`
      );
      assert(
        !capturedBroadcasts.some((m) => m === '[TB] Scramble failed.'),
        'an EloDiff scramble with no budget-sized plan must not broadcast the generic scrambleFailedMessage.'
      );
    }
  );

  // ── _computePostSwapMuDiff(): pure logic ─────────────────────────────────
  console.log('\n[Section 4: _computePostSwapMuDiff]');
  {
    const { tb } = await buildPlugin();
    const transformedPlayers = [
      { eosID: 'a', teamID: '1' }, { eosID: 'b', teamID: '1' },
      { eosID: 'c', teamID: '2' }, { eosID: 'd', teamID: '2' }
    ];
    const eloMap = new Map([
      ['a', { mu: 30 }], ['b', { mu: 30 }],
      ['c', { mu: 20 }], ['d', { mu: 20 }]
    ]);
    const diffBefore = tb._computePostSwapMuDiff(transformedPlayers, [], eloMap);
    assert(diffBefore === 10, `with no swap applied, diff reflects current teams as-is (got ${diffBefore}).`);

    const diffAfterSwap = tb._computePostSwapMuDiff(transformedPlayers, [{ eosID: 'a', targetTeamID: '2' }], eloMap);
    // team1 = [b:30] -> 30, team2 = [c:20, d:20, a:30] -> 23.33
    assert(Math.abs(diffAfterSwap - Math.abs(30 - (20 + 20 + 30) / 3)) < 1e-9, 'a single swap in the plan moves that player to the target team before averaging.');
  }
  {
    const { tb } = await buildPlugin();
    // Missing ratings fall back to defaultMu 25.0, same as the forced-churn hack.
    const transformedPlayers = [{ eosID: 'a', teamID: '1' }, { eosID: 'b', teamID: '2' }];
    const diff = tb._computePostSwapMuDiff(transformedPlayers, [], new Map());
    assert(diff === 0, `two players both missing from eloMap both fall back to defaultMu 25.0, so diff is 0 (got ${diff}).`);
  }
  {
    const { tb } = await buildPlugin();
    // A team with zero players after the swap falls back to defaultMu for its average, rather
    // than dividing by zero.
    const transformedPlayers = [{ eosID: 'a', teamID: '1' }];
    const diff = tb._computePostSwapMuDiff(transformedPlayers, [{ eosID: 'a', targetTeamID: '2' }], new Map([['a', { mu: 40 }]]));
    // team1 has nobody -> defaultMu 25.0; team2 = [a:40] -> 40. diff = 15.
    assert(diff === 15, `an emptied team falls back to defaultMu 25.0 rather than NaN/dividing by zero (got ${diff}).`);
  }

  // ── _runEloDiffMicroScrambleSearch(): escalating budget ──────────────────
  console.log('\n[Section 5: _runEloDiffMicroScrambleSearch escalating budget]');

  {
    const { tb } = await buildPlugin();
    const result = await tb._runEloDiffMicroScrambleSearch({
      transformedSquads: [],
      transformedPlayers: [],
      eloMap: null,
      clanGroups: null
    });
    assert(Array.isArray(result) && result.length === 0, 'a missing eloMap returns an empty plan without calling the Scrambler at all.');
  }
  {
    const { tb } = await buildPlugin();
    const result = await tb._runEloDiffMicroScrambleSearch({
      transformedSquads: [],
      transformedPlayers: [],
      eloMap: new Map(), // present but empty
      clanGroups: null
    });
    assert(Array.isArray(result) && result.length === 0, 'an empty (size 0) eloMap also returns an empty plan.');
  }

  await withScramblerStub(
    (function () {
      const calls = [];
      const stub = async ({ minPlayersToMove, maxPlayersToMove }) => {
        calls.push({ minPlayersToMove, maxPlayersToMove });
        // Diff improves with budget until it hits the parity target at budget 6.
        const diffByBudget = { 2: 5, 4: 2, 6: 0.01 };
        return [{ eosID: `mock_${minPlayersToMove}`, targetTeamID: '2', __diff: diffByBudget[minPlayersToMove] }];
      };
      stub.__calls = calls;
      return stub;
    })(),
    async () => {
      const { tb } = await buildPlugin({ microScrambleParityTarget: 0.05, microScrambleMaxMovePercent: 1 });
      // Stub _computePostSwapMuDiff to read the diff the Scrambler stub tagged onto the plan,
      // rather than reimplementing mu arithmetic here — isolates this test to the search loop.
      tb._computePostSwapMuDiff = (transformedPlayers, plan) => plan[0].__diff;
      const transformedPlayers = Array.from({ length: 10 }, (_, i) => ({ eosID: `p${i}`, teamID: i < 5 ? '1' : '2' }));
      const plan = await tb._runEloDiffMicroScrambleSearch({
        transformedSquads: [],
        transformedPlayers,
        eloMap: new Map([['p0', { mu: 30 }]]),
        clanGroups: null
      });
      assert(plan[0].eosID === 'mock_6', `the search stops at the first budget that reaches the parity target (0.01 <= 0.05), budget 6 (got ${plan[0]?.eosID}).`);
    }
  );

  await withScramblerStub(
    async ({ minPlayersToMove }) => [{ eosID: `mock_${minPlayersToMove}`, targetTeamID: '2' }],
    async () => {
      const { tb } = await buildPlugin({ microScrambleParityTarget: 0.0001, microScrambleMaxMovePercent: 0.4 });
      const transformedPlayers = Array.from({ length: 10 }, (_, i) => ({ eosID: `p${i}`, teamID: i < 5 ? '1' : '2' }));
      // Diff never improves -> parity target (near-impossible to hit) is never reached, and the
      // search must exhaust its full budget range: ceil(0.4 * 10) = 4, so budgets 2 and 4.
      const diffs = { mock_2: 3, mock_4: 3 };
      tb._computePostSwapMuDiff = (transformedPlayers2, plan) => diffs[plan[0].eosID];
      const plan = await tb._runEloDiffMicroScrambleSearch({
        transformedSquads: [],
        transformedPlayers,
        eloMap: new Map([['p0', { mu: 30 }]]),
        clanGroups: null
      });
      assert(!!plan && plan.length > 0, 'when parity is never reached, the search still returns a best-effort plan rather than nothing.');
      assert(plan[0].eosID === 'mock_2', 'with an unreachable target and tied diffs, the first (lowest-budget) plan wins the "< bestDiff" comparison (strict-less-than keeps the earliest tie).');
    }
  );

  await withScramblerStub(
    (function () {
      const calls = [];
      const stub = async ({ minPlayersToMove, maxPlayersToMove }) => {
        calls.push(minPlayersToMove);
        return [{ eosID: `mock_${minPlayersToMove}`, targetTeamID: '2' }];
      };
      stub.__calls = calls;
      return stub;
    })(),
    async () => {
      const { tb } = await buildPlugin({ microScrambleParityTarget: 0.0001, microScrambleMaxMovePercent: 0.25 });
      tb._computePostSwapMuDiff = () => 999; // never satisfies parity -> exhausts the whole range
      const transformedPlayers = Array.from({ length: 20 }, (_, i) => ({ eosID: `p${i}`, teamID: i < 10 ? '1' : '2' }));
      await tb._runEloDiffMicroScrambleSearch({
        transformedSquads: [],
        transformedPlayers,
        eloMap: new Map([['p0', { mu: 30 }]]),
        clanGroups: null
      });
      // maxBudget = ceil(0.25 * 20) = 5; the loop steps by 2 from 2, so only budget 2 and 4 run (6 > 5).
      assert(
        JSON.stringify(Scrambler.scrambleTeamsPreservingSquads.__calls) === JSON.stringify([2, 4]),
        `the budget escalation is capped by microScrambleMaxMovePercent * population, not run indefinitely (calls: ${JSON.stringify(Scrambler.scrambleTeamsPreservingSquads.__calls)}).`
      );
    }
  );

  await withScramblerStub(
    async () => [], // Scrambler finds no legal plan at any budget (e.g. clan-cohesion blocks every candidate)
    async () => {
      const { tb } = await buildPlugin();
      const transformedPlayers = Array.from({ length: 10 }, (_, i) => ({ eosID: `p${i}`, teamID: i < 5 ? '1' : '2' }));
      const plan = await tb._runEloDiffMicroScrambleSearch({
        transformedSquads: [],
        transformedPlayers,
        eloMap: new Map([['p0', { mu: 30 }]]),
        clanGroups: null
      });
      assert(Array.isArray(plan) && plan.length === 0, 'if every budget step returns an empty plan, the search itself returns an empty plan (not null/undefined).');
    }
  );

  await withScramblerStub(
    // Squad atomicity (SQUAD_FIT_GRACE, pullEntireSquads) means the scrambler can hand back
    // more players than the requested budget — simulate that by always returning a plan far
    // larger than maxBudget, even though it reaches parity.
    async ({ minPlayersToMove }) => Array.from({ length: 20 }, (_, i) => ({ eosID: `over_${minPlayersToMove}_${i}`, targetTeamID: '2' })),
    async () => {
      const { tb } = await buildPlugin({ microScrambleParityTarget: 0.05, microScrambleMaxMovePercent: 0.25 });
      tb._computePostSwapMuDiff = () => 0.01; // would satisfy parity if the size check didn't reject it first
      const transformedPlayers = Array.from({ length: 20 }, (_, i) => ({ eosID: `p${i}`, teamID: i < 10 ? '1' : '2' }));
      const plan = await tb._runEloDiffMicroScrambleSearch({
        transformedSquads: [],
        transformedPlayers,
        eloMap: new Map([['p0', { mu: 30 }]]),
        clanGroups: null
      });
      // maxBudget = ceil(0.25 * 20) = 5; every returned plan is 20 players, so every step is
      // discarded regardless of its (fabricated) parity-satisfying diff.
      assert(Array.isArray(plan) && plan.length === 0, `a plan that overshoots the microScrambleMaxMovePercent safety ceiling is discarded outright, even when it would otherwise reach parity (got plan of size ${plan.length}).`);
    }
  );

  await withScramblerStub(
    (function () {
      const stub = async ({ minPlayersToMove }) => {
        // Budget 2 overshoots the ceiling (squad atomicity); budget 4 fits and reaches parity.
        if (minPlayersToMove === 2) {
          return Array.from({ length: 20 }, (_, i) => ({ eosID: `over_${i}`, targetTeamID: '2' }));
        }
        return [{ eosID: `mock_${minPlayersToMove}`, targetTeamID: '2' }];
      };
      return stub;
    })(),
    async () => {
      const { tb } = await buildPlugin({ microScrambleParityTarget: 0.05, microScrambleMaxMovePercent: 0.25 });
      tb._computePostSwapMuDiff = () => 0.01;
      const transformedPlayers = Array.from({ length: 20 }, (_, i) => ({ eosID: `p${i}`, teamID: i < 10 ? '1' : '2' }));
      const plan = await tb._runEloDiffMicroScrambleSearch({
        transformedSquads: [],
        transformedPlayers,
        eloMap: new Map([['p0', { mu: 30 }]]),
        clanGroups: null
      });
      assert(plan.length === 1 && plan[0].eosID === 'mock_4', `an oversized plan at one budget step doesn't poison later steps — the search keeps escalating and accepts the next step's properly-sized plan (got ${JSON.stringify(plan)}).`);
    }
  );

  // ── onScrambleCommand(): "elo" flag composability ────────────────────────
  console.log('\n[Section 6: onScrambleCommand "elo" flag]');

  function makeAdmin() {
    return { steamID: 'admin_steam', name: 'AdminName', eosID: 'admin_eos' };
  }

  {
    const { tb } = await buildPlugin();
    const admin = makeAdmin();
    let capturedArgs = null;
    tb.initiateScramble = async (...args) => { capturedArgs = args; return true; };
    await tb.onScrambleCommand({ message: 'elo now', player: admin, steamID: admin.steamID });
    assert(capturedArgs !== null && capturedArgs[5] === 'EloDiff', `"!scramble elo now" calls initiateScramble with scrambleType "EloDiff" (got ${JSON.stringify(capturedArgs)}).`);
    assert(capturedArgs[1] === true, '"!scramble elo now" still passes immediate=true, same as a normal "now" scramble.');
  }
  {
    const { tb } = await buildPlugin();
    const admin = makeAdmin();
    let capturedArgs = null;
    tb.initiateScramble = async (...args) => { capturedArgs = args; return true; };
    await tb.onScrambleCommand({ message: 'now', player: admin, steamID: admin.steamID });
    assert(capturedArgs !== null && (capturedArgs[5] === null || capturedArgs[5] === undefined), `"!scramble now" without "elo" calls initiateScramble with no scrambleType (got ${JSON.stringify(capturedArgs)}).`);
  }
  {
    const { tb, capturedBroadcasts } = await buildPlugin();
    const admin = makeAdmin();
    tb.initiateScramble = async () => true;
    await tb.onScrambleCommand({ message: 'elo now', player: admin, steamID: admin.steamID });
    assert(capturedBroadcasts.some((m) => m.includes('Scrambling micro now!')), '"!scramble elo now" broadcasts immediateManualMicroScramble, not the generic immediate-manual message.');
  }
  {
    const { tb, capturedBroadcasts } = await buildPlugin();
    const admin = makeAdmin();
    tb.initiateScramble = async () => true;
    await tb.onScrambleCommand({ message: 'elo', player: admin, steamID: admin.steamID });
    assert(capturedBroadcasts.some((m) => m.includes('Manual micro scramble in')), '"!scramble elo" (scheduled) broadcasts manualMicroScrambleAnnouncement, not the generic scheduled-manual message.');
  }
  {
    const { tb, capturedBroadcasts } = await buildPlugin();
    const admin = makeAdmin();
    let capturedArgs = null;
    tb.initiateScramble = async (...args) => { capturedArgs = args; return true; };
    await tb.onScrambleCommand({ message: 'elo dry', player: admin, steamID: admin.steamID });
    assert(capturedArgs !== null && capturedArgs[0] === true && capturedArgs[5] === 'EloDiff', '"!scramble elo dry" is simulated and still carries scrambleType "EloDiff".');
    assert(capturedBroadcasts.length === 0, 'a dry run stays silent to players regardless of the "elo" flag.');
  }
  {
    const { tb } = await buildPlugin();
    const admin = makeAdmin();
    const armResponse = await tb.onScrambleCommand({ message: 'elo matchend', player: admin, steamID: admin.steamID });
    assert(tb._scrambleOnRoundEnd === true, '"!scramble elo matchend" arms a deferred scramble.');
    assert(tb._scrambleOnRoundEndBy?.scrambleType === 'EloDiff', 'the matchend arm carries scrambleType "EloDiff".');
    assert(typeof armResponse === 'string' && /!scramble cancel/i.test(armResponse), 'arming a matchend scramble (which bypasses the confirmation gate entirely) tells the admin how to cancel it instead.');
    const alreadyArmedResponse = await tb.onScrambleCommand({ message: 'elo matchend', player: admin, steamID: admin.steamID });
    assert(typeof alreadyArmedResponse === 'string' && /!scramble cancel/i.test(alreadyArmedResponse), 'the "already scheduled" response for a second matchend attempt also mentions how to cancel it.');
  }
  {
    const { tb } = await buildPlugin();
    const admin = makeAdmin();
    await tb.onScrambleCommand({ message: 'matchend', player: admin, steamID: admin.steamID });
    assert(tb._scrambleOnRoundEndBy?.scrambleType === null, '"!scramble matchend" without "elo" arms with scrambleType null.');
  }
  {
    const { tb } = await buildPlugin();
    const admin = makeAdmin();
    const response = await tb.onScrambleCommand({ message: 'bogus', player: admin, steamID: admin.steamID });
    assert(typeof response === 'string' && response.includes('elo'), '"elo" is advertised as a valid argument in the unknown-argument usage message.');
  }
  {
    // requireScrambleConfirmation applies uniformly: "elo" composes with the SAME gate a normal
    // scramble uses, rather than bypassing it (confirmed design decision — no elo-specific carve-out).
    const { tb } = await buildPlugin({ requireScrambleConfirmation: true });
    const admin = makeAdmin();
    let capturedArgs = null;
    tb.initiateScramble = async (...args) => { capturedArgs = args; return true; };
    const gatedResponse = await tb.onScrambleCommand({ message: 'elo now', player: admin, steamID: admin.steamID });
    assert(capturedArgs === null, '"!scramble elo now" is gated behind confirmation, same as a normal scramble, when requireScrambleConfirmation is true.');
    assert(typeof gatedResponse === 'string' && /confirm/i.test(gatedResponse), 'the gated response asks the admin to confirm.');
    assert(gatedResponse.includes('micro'), 'the gated response for "elo now" names the scramble kind ("micro"), not just "confirm".');
    assert(gatedResponse.includes('immediately'), 'the gated response for "now" states the scramble fires immediately, with no countdown.');
    await tb.onScrambleCommand({ message: 'confirm', player: admin, steamID: admin.steamID });
    assert(capturedArgs !== null && capturedArgs[5] === 'EloDiff', '"!scramble confirm" replays the stored args and still carries scrambleType "EloDiff" through to initiateScramble.');
  }
  {
    // A plain scheduled (no "now", no "elo") scramble states the actual countdown length and the
    // "full" kind, so the admin knows exactly what firing "!scramble confirm" will do.
    const { tb } = await buildPlugin({ requireScrambleConfirmation: true });
    const admin = makeAdmin();
    const gatedResponse = await tb.onScrambleCommand({ message: '', player: admin, steamID: admin.steamID });
    assert(gatedResponse.includes('full'), 'the gated response for a plain scramble names the scramble kind ("full").');
    assert(gatedResponse.includes(`${tb.options.scrambleAnnouncementDelay}s`), 'the gated response for a scheduled scramble states the actual countdown length rather than just "scheduled".');
  }
  {
    // Regression: onScrambleCommand() declared `player` via `const` AFTER the isConfirm
    // block that referenced it, so "!scramble confirm" with no pending confirmation threw a
    // TDZ ReferenceError ("Cannot access 'player' before initialization") instead of replying.
    // Not elo-specific — this is the RCON confirm path generally — but this file already has
    // the onScrambleCommand() scaffolding, so it lives here.
    const { tb } = await buildPlugin();
    const admin = makeAdmin();
    const response = await tb.onScrambleCommand({ message: 'confirm', player: admin, steamID: admin.steamID });
    assert(typeof response === 'string' && /no pending/i.test(response), `"!scramble confirm" with no pending confirmation replies instead of throwing (got ${JSON.stringify(response)}).`);
  }
  {
    // Same TDZ regression, on the "confirmation expired" branch.
    const { tb } = await buildPlugin({ requireScrambleConfirmation: true, scrambleConfirmationTimeout: 60 });
    const admin = makeAdmin();
    await tb.onScrambleCommand({ message: 'now', player: admin, steamID: admin.steamID });
    tb.scrambleConfirmation.timestamp = Date.now() - 61_000;
    const response = await tb.onScrambleCommand({ message: 'confirm', player: admin, steamID: admin.steamID });
    assert(typeof response === 'string' && /expired/i.test(response), `"!scramble confirm" past the timeout replies instead of throwing (got ${JSON.stringify(response)}).`);
  }

  // ── onRoundEnded(): matchend-fire honors armedBy.scrambleType ────────────
  console.log('\n[Section 7: onRoundEnded matchend-fire scrambleType branching]');

  function readLastReport(reportLogPath) {
    const lines = fs.readFileSync(reportLogPath, 'utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  }

  {
    const reportLogPath = path.join(os.tmpdir(), `tb-elo-matchend-report-${process.pid}-${Date.now()}.jsonl`);
    const { tb, capturedBroadcasts } = await buildPlugin({ reportLogPath });
    let capturedArgs = null;
    tb.initiateScramble = async (...args) => { capturedArgs = args; return true; };
    await tb._setScrambleArm({ name: 'AdminName', eosID: 'admin_eos', scrambleType: 'EloDiff' });
    try {
      await tb.onRoundEnded({ winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } });
      assert(capturedBroadcasts.some((m) => m.includes('Manual micro scramble in')), 'a matchend-armed EloDiff scramble broadcasts manualMicroScrambleAnnouncement on fire.');
      assert(capturedArgs !== null && capturedArgs[5] === 'EloDiff', 'the deferred initiateScramble() call carries scrambleType "EloDiff".');
      const report = readLastReport(reportLogPath);
      assert(report.scrambled === true, 'the fired round is marked scrambled in the logged report.');
      assert(report.scrambleCondition === 'Match End (Manual Micro)', `the logged report records "Match End (Manual Micro)" (got "${report.scrambleCondition}").`);
      assert(report.scrambleType === 'EloDiff', `the logged report carries scrambleType "EloDiff" (got ${JSON.stringify(report.scrambleType)}).`);
    } finally {
      fs.rmSync(reportLogPath, { force: true });
    }
  }
  {
    // Control case: an arm with no scrambleType (a plain "!scramble matchend") still fires the
    // original full-scramble path, proving the branch above discriminates rather than always
    // taking the micro path.
    const reportLogPath = path.join(os.tmpdir(), `tb-full-matchend-report-${process.pid}-${Date.now()}.jsonl`);
    const { tb, capturedBroadcasts } = await buildPlugin({ reportLogPath });
    let capturedArgs = null;
    tb.initiateScramble = async (...args) => { capturedArgs = args; return true; };
    await tb._setScrambleArm({ name: 'AdminName', eosID: 'admin_eos', scrambleType: null });
    try {
      await tb.onRoundEnded({ winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } });
      assert(!capturedBroadcasts.some((m) => m.includes('Manual micro scramble in')), 'a matchend-armed plain scramble does not broadcast the micro-scramble text.');
      assert(capturedArgs !== null && (capturedArgs[5] === null || capturedArgs[5] === undefined), 'the deferred initiateScramble() call carries no scrambleType for a plain matchend arm.');
      const report = readLastReport(reportLogPath);
      assert(report.scrambleCondition === 'Match End (Manual)', `the logged report records "Match End (Manual)" for a plain arm (got "${report.scrambleCondition}").`);
    } finally {
      fs.rmSync(reportLogPath, { force: true });
    }
  }

  // ── Final Report ──────────────────────────────────────────────────────
  console.log(`\n🏁 All Elo-diff micro scramble tests completed. Result: ${passCount}/${testCount} passed.`);
  if (passCount !== testCount) {
    console.error('⚠️ Some tests failed. Please review the output.');
    process.exitCode = 1;
  }
  if (testCount === 0) {
    console.error('⚠️ No assertions ran at all.');
    process.exitCode = 1;
  }
}

try {
  await runTests();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  cleanAssembly(assembly);
}
