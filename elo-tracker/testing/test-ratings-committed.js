/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║        TEST: EloTracker RATINGS-COMMITTED PROMISE HANDOFF      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Pins the per-round Promise handoff EloTracker exposes as
 * awaitRatingsCommitted(). TeamBalancer's Elo-diff micro-scramble trigger
 * schedules its threshold check off this promise instead of a fixed delay,
 * because ROUND_ENDED has no ordering guarantee between the two plugins'
 * listeners — awaiting a real signal instead of guessing a timeout is the
 * whole point.
 *
 * Three properties matter and are each covered below:
 *   1. The promise resolves with the round's own committed snapshot right
 *      after ratings are applied, not after the (later) DB/Discord awaits.
 *   2. NEW_GAME hands out a fresh, still-pending promise for the next round —
 *      it must never resolve early on the strength of the previous round.
 *   3. An early-return path inside onRoundEnded() (too few players, ignored
 *      mode, no eligible participants, ...) still resolves its promise via
 *      the finally block, so a waiting TeamBalancer is never left hanging —
 *      and a NEW_GAME that lands mid-flight must not let the tail end of an
 *      in-progress onRoundEnded() resolve the WRONG (next) round's promise.
 *      That last case is why the resolver is captured into a local variable
 *      at the top of onRoundEnded() instead of being read fresh from
 *      `this._ratingsCommittedResolve` in the finally block.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/run-all-tests.js
 *   node testing/test-ratings-committed.js   (standalone)
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Same assembly/mock pattern as test-elo-tracker.js: elo-tracker.js only
 *   resolves against './s3-plugin-base.js' in the flattened install.cjs
 *   layout, so the plugin is loaded out of a throwaway assembly rather than
 *   straight from ../plugins/.
 * - No live SquadJS server or database — server, rcon, and the DB/session
 *   collaborators are all mocked.
 *
 */

import assert from 'node:assert/strict';

import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';
import { makeMockS3 } from '../../s3/testing/mock-s3.js';

export default async function runRatingsCommittedTests(runTest) {
  const assembly = buildAssembly('.tmp-elo-ratings-committed');
  const EloTracker = await importFromAssembly(assembly, 'elo-tracker.js');

  try {
    await runCases(runTest, EloTracker);
  } finally {
    cleanAssembly(assembly);
  }
}

/** A fresh mock server per test — mirrors test-elo-tracker.js's harness exactly. */
function createMockServer() {
  return {
    players: [],
    listeners: {},
    matchStartTime: new Date(),
    currentLayer: null,
    plugins: [makeMockS3()],
    on(event, fn) {
      this.listeners[event] = fn;
    },
    removeListener(event, fn) {
      if (this.listeners[event] === fn) delete this.listeners[event];
    },
    async emit(event, data) {
      if (this.listeners[event]) await this.listeners[event](data);
    }
  };
}

/**
 * A controllable mock DB: bulkIncrementPlayerStats and insertRoundHistory
 * don't resolve until the test calls release(). This lets a test pause
 * onRoundEnded() AFTER the ratings-committed resolve (which happens
 * synchronously, before any await) but WHILE the round is still "in flight"
 * from a caller's perspective — the exact window a same-tick NEW_GAME could
 * land in against a real server.
 */
function createGatedMockDb() {
  let releaseBulk;
  const bulkGate = new Promise((resolve) => { releaseBulk = resolve; });
  return {
    initDB: async () => true,
    pruneStaleEntries: async () => ({ tier1: 0, tier2: 0 }),
    getPlayerStatsBatch: async (ids) => {
      const map = new Map();
      ids.forEach((id) => map.set(id, { mu: 25.0, sigma: 8.333 }));
      return map;
    },
    bulkIncrementPlayerStats: async () => { await bulkGate; },
    insertRoundHistory: async () => ({ id: 1 }),
    insertRoundPlayers: async () => {},
    release: () => releaseBulk()
  };
}

function createImmediateMockDb() {
  return {
    initDB: async () => true,
    pruneStaleEntries: async () => ({ tier1: 0, tier2: 0 }),
    getPlayerStatsBatch: async (ids) => {
      const map = new Map();
      ids.forEach((id) => map.set(id, { mu: 25.0, sigma: 8.333 }));
      return map;
    },
    bulkIncrementPlayerStats: async () => {},
    insertRoundHistory: async () => ({ id: 1 }),
    insertRoundPlayers: async () => {}
  };
}

function createMockSession(participants) {
  return {
    startRound: () => {},
    updatePlayers: () => {},
    endRound: () => participants,
    roundStartTime: Date.now()
  };
}

/** Two eligible participants, one per team, each fully present. */
function twoParticipants() {
  return [
    { eosID: 'p1', name: 'P1', assignedTeamID: 1, participationRatio: 1.0 },
    { eosID: 'p2', name: 'P2', assignedTeamID: 2, participationRatio: 1.0 }
  ];
}

/** Resolves true/false for whether a promise is still pending, without consuming its value. */
async function isPending(promise) {
  const sentinel = Symbol('pending');
  const result = await Promise.race([promise, Promise.resolve(sentinel)]);
  // Promise.resolve(sentinel) settles on the same microtask tick as an
  // already-resolved `promise` would, so a still-pending promise always loses
  // the race to the sentinel — this is a same-tick check, not a timing guess.
  return result === sentinel;
}

async function runCases(runTest, EloTracker) {
  const mockOptions = {
    minParticipationRatio: 0.1,
    defaultMu: 25.0,
    defaultSigma: 8.333,
    minPlayersForElo: 2,
    discordClient: null
  };
  const mockConnectors = {};

  async function mountTracker(server, inject) {
    const tracker = new EloTracker(server, mockOptions, mockConnectors);
    await tracker.prepareToMount();
    if (inject) inject(tracker);
    await tracker.mount();
    return tracker;
  }

  await runTest('resolves with the round\'s own committed snapshot after a normal round end', async () => {
    const server = createMockServer();
    const tracker = await mountTracker(server, (t) => {
      t.db = createImmediateMockDb();
      t.session = createMockSession(twoParticipants());
    });
    server.players = [{ eosID: 'p1', teamID: 1 }, { eosID: 'p2', teamID: 2 }];
    tracker.eloCache.set('p1', { mu: 25, sigma: 8.333 });
    tracker.eloCache.set('p2', { mu: 25, sigma: 8.333 });

    const committed = tracker.awaitRatingsCommitted();
    await server.emit('ROUND_ENDED', { winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } });

    const { snapshot } = await committed;
    assert.ok(snapshot instanceof Map, 'resolved value should carry a Map snapshot');
    assert.ok(snapshot.has('p1') && snapshot.has('p2'), 'snapshot should contain both round participants');
    // Team 1 won, so p1's mu should have moved up from the 25 default it started at.
    assert.notEqual(snapshot.get('p1').mu, 25, 'winner\'s mu should have changed from the pre-round value');
  });

  await runTest('NEW_GAME hands out a fresh, distinct promise that stays pending', async () => {
    const server = createMockServer();
    const tracker = await mountTracker(server, (t) => {
      t.db = createImmediateMockDb();
      t.session = createMockSession(twoParticipants());
    });
    server.players = [{ eosID: 'p1', teamID: 1 }, { eosID: 'p2', teamID: 2 }];
    tracker.eloCache.set('p1', { mu: 25, sigma: 8.333 });
    tracker.eloCache.set('p2', { mu: 25, sigma: 8.333 });

    const roundOnePromise = tracker.awaitRatingsCommitted();
    await server.emit('ROUND_ENDED', { winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } });
    await roundOnePromise; // settle round 1 before moving on

    await server.emit('NEW_GAME', { layer: { gamemode: 'RAAS', name: 'Fallujah_RAAS_v2' } });
    const roundTwoPromise = tracker.awaitRatingsCommitted();

    assert.notEqual(roundTwoPromise, roundOnePromise, 'NEW_GAME must swap in a new promise object');
    assert.equal(await isPending(roundTwoPromise), true, 'the new round\'s promise must not resolve until its own round ends');
  });

  await runTest('the very first round is skipped below minPlayersForElo, and its promise still resolves — to null (nothing has ever committed)', async () => {
    const server = createMockServer();
    const tracker = await mountTracker(server, (t) => {
      t.db = createImmediateMockDb();
      t.session = createMockSession([]);
    });
    server.players = [{ eosID: 'p1', teamID: 1 }]; // 1 < minPlayersForElo (2)

    const committed = tracker.awaitRatingsCommitted();
    await server.emit('ROUND_ENDED', { winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } });

    const result = await committed;
    assert.equal(result.snapshot, null, 'nothing has ever committed for this tracker, so the finally-block fallback must be null');
  });

  await runTest('a duplicate ROUND_ENDED that hits an early return afterwards does not corrupt the already-resolved promise', async () => {
    // Same scenario the "finally re-resolves with whatever lastRoundSnapshot holds" comment in
    // onRoundEnded() exists for: a second ROUND_ENDED for a round already committed (a re-emitted
    // log line, a reconnect) must not blank out the value a waiting caller already observed.
    const server = createMockServer();
    const tracker = await mountTracker(server, (t) => {
      t.db = createImmediateMockDb();
      t.session = createMockSession(twoParticipants());
    });
    server.players = [{ eosID: 'p1', teamID: 1 }, { eosID: 'p2', teamID: 2 }];
    tracker.eloCache.set('p1', { mu: 25, sigma: 8.333 });
    tracker.eloCache.set('p2', { mu: 25, sigma: 8.333 });

    const committed = tracker.awaitRatingsCommitted();
    await server.emit('ROUND_ENDED', { winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } });
    const first = await committed;
    assert.ok(first.snapshot.has('p1'), 'first call should have committed normally');

    // Duplicate event for the SAME round: drop population below threshold this time (simulates
    // a reconnect momentarily returning a smaller roster) so the second call takes the early
    // return, not the normal path.
    server.players = [{ eosID: 'p1', teamID: 1 }];
    await server.emit('ROUND_ENDED', { winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } });

    // awaitRatingsCommitted() still returns the SAME (already-settled) promise — no NEW_GAME
    // happened between the two ROUND_ENDED calls — so re-reading it must still show round one's
    // value, not have been clobbered by the duplicate's early return.
    const second = await tracker.awaitRatingsCommitted();
    assert.ok(second.snapshot.has('p1'), 'a duplicate early-returning ROUND_ENDED must not erase the prior commit');
    assert.equal(second.snapshot.get('p1').mu, first.snapshot.get('p1').mu, 'the committed value must be unchanged by the duplicate');
  });

  await runTest('a NEW_GAME landing mid-flight does not let the finishing round resolve the NEXT round\'s promise', async () => {
    // The regression the local-capture pattern (const resolveRatingsCommitted = this._ratingsCommittedResolve,
    // taken at the very top of onRoundEnded()) exists to prevent: without it, the finally block
    // would read `this._ratingsCommittedResolve` fresh — which, after an intervening NEW_GAME,
    // points at round 2's resolver — and prematurely resolve round 2's promise with round 2's
    // (null) lastRoundSnapshot before round 2 has actually ended.
    const server = createMockServer();
    const gatedDb = createGatedMockDb();
    const tracker = await mountTracker(server, (t) => {
      t.db = gatedDb;
      t.session = createMockSession(twoParticipants());
    });
    server.players = [{ eosID: 'p1', teamID: 1 }, { eosID: 'p2', teamID: 2 }];
    tracker.eloCache.set('p1', { mu: 25, sigma: 8.333 });
    tracker.eloCache.set('p2', { mu: 25, sigma: 8.333 });

    const roundOnePromise = tracker.awaitRatingsCommitted();

    // Fire round 1's ROUND_ENDED but do not await it yet — it will run synchronously up to the
    // first await (db.bulkIncrementPlayerStats, gated open) and then suspend there, AFTER the
    // ratings-committed resolve has already fired for round 1.
    const roundOneEndedPromise = server.emit('ROUND_ENDED', { winner: { team: 1, tickets: 100 }, loser: { tickets: 0 } });

    // Round 1's own promise should already be resolved at this point — the resolve() call in
    // onRoundEnded() happens before any await, so it fired during the synchronous prefix above.
    assert.equal(await isPending(roundOnePromise), false, 'round 1 should already be resolved before its DB writes finish');

    // NEW_GAME lands while round 1's onRoundEnded() is still suspended on the gated DB call.
    await server.emit('NEW_GAME', { layer: { gamemode: 'RAAS', name: 'Fallujah_RAAS_v2' } });
    const roundTwoPromise = tracker.awaitRatingsCommitted();
    assert.notEqual(roundTwoPromise, roundOnePromise, 'NEW_GAME should have swapped in round 2\'s promise already');

    // Now let round 1's onRoundEnded() finish (release the gate, then await its completion).
    gatedDb.release();
    await roundOneEndedPromise;

    // The bug this test exists to catch: round 1 finishing must NOT resolve round 2's promise.
    assert.equal(await isPending(roundTwoPromise), true, 'round 1 finishing late must not resolve round 2\'s promise');

    // And round 1's own promise still carries round 1's value, unaffected by any of this.
    const roundOneResult = await roundOnePromise;
    assert.ok(roundOneResult.snapshot.has('p1'), 'round 1\'s resolved value should be unaffected by the interleaved NEW_GAME');
  });
}

// Execute if run directly (outside the run-all-tests.js aggregator)
if (process.argv[1] && process.argv[1].endsWith('test-ratings-committed.js')) {
  let passed = 0, failed = 0;
  const runTest = async (name, fn) => {
    process.stdout.write(`  • ${name}... `);
    try {
      await fn();
      console.log('PASS');
      passed++;
    } catch (err) {
      console.log('FAIL');
      console.error(err.stack || err);
      failed++;
    }
  };
  await runRatingsCommittedTests(runTest);
  console.log(`\n${passed}/${passed + failed} passed.`);
  if (failed > 0) process.exitCode = 1;
}
