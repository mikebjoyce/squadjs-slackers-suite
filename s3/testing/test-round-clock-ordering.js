/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     ROUND CLOCK ORDERING — WHAT A CONSUMER READS AT NEW_GAME   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * `roundStartTime` and `matchId` are pulled, not pushed: consumers call
 * `gs.getRoundStartTime()` and `gs.getMatchId()`, and several of them do it
 * from their own NEW_GAME handler. `EventEmitter.emit()` runs listeners
 * synchronously only until each one hits its first `await`, so the moment
 * anything in S³'s NEW_GAME listener awaits before the clock is stamped,
 * control returns to emit() and every later listener reads the round that just
 * ended. Nothing throws and nothing logs.
 *
 * That shipped. A registry heartbeat (four DB round trips) was added ahead of
 * the gameState call, and EloTracker spent every round computing its duration
 * from the previous round's start — durations inflated by a whole round, and
 * every rating delta halved, because participationRatio divides by that
 * duration. The Discord embeds looked plausible the entire time.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   consumer after S³     A consumer registered after S³ reads this round's
 *                         start and matchId even when S³ awaits slow DB work
 *                         before delegating to gameState. This is the case
 *                         that regressed.
 *   consumer before S³    Same, with the consumer registered FIRST. Reordering
 *                         statements inside S³'s handler does not fix this one
 *                         — only binding NEW_GAME with prependListener does,
 *                         which is what keeps mount order from mattering.
 *   the stamp is the      The stamped time is when NEW_GAME arrived, not when
 *   event, not the        the heartbeat finished. handleNewGame() consuming
 *   handler               the stamp rather than re-taking Date.now() is the
 *                         difference between a round start and a round start
 *                         plus however long the DB took.
 *   cold call             handleNewGame() called with no prepended stamp still
 *                         stamps, so direct callers (tests, dev harness) are
 *                         unaffected.
 *   phase bookkeeping     The stamp does not skip the STAGING transition or
 *                         the layer invalidation that follows it.
 *
 * Category: 1 (no external services)
 * Run:    node s3/testing/test-round-clock-ordering.js
 */

'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import GameStateService from '../utils/game-state-service.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from './plugin-assembly.js';

// slackers-squad-services.js imports SquadJS's BasePlugin as a flat sibling,
// which only resolves in the layout install.cjs produces. The listener body
// under test is the real one — a hand-written stand-in would be a copy of the
// statement order this test exists to pin.
const ASSEMBLY = buildAssembly('.tmp-round-clock-ordering');
const SlackersSquadServices = await importFromAssembly(ASSEMBLY, 'slackers-squad-services.js');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(70));
  console.log('Round Clock Ordering  (what a consumer reads at NEW_GAME)');
  console.log('='.repeat(70));
  console.log('');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${String(err.message).split('\n').join('\n      ')}`);
      failed++;
    }
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log('─'.repeat(70));

  if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class MockServer extends EventEmitter {
  constructor() {
    super();
    this.players = [];
    this.currentLayer = 'Narva_RAAS_v1';
  }
}

const PREVIOUS_ROUND_START = Date.now() - 40 * 60 * 1000;
const PREVIOUS_MATCH_ID = 'previous-round';

/**
 * Yields several times and takes measurable wall-clock time, the way the four
 * DB round trips in heartbeatServer() do. The delay is what makes "stamped at
 * the event" and "stamped after the heartbeat" distinguishable — with pure
 * setImmediate yielding, both land in the same millisecond and the case that
 * pins the difference passes either way.
 */
async function slowHeartbeat(counter) {
  counter.startedAt = Date.now();
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  counter.finishedAt = Date.now();
}

/**
 * A gameState mid-round, with a previous round on its clock — so a stale read
 * is a wrong value rather than a null, exactly as it is live.
 */
async function liveGameState(server) {
  const gs = new GameStateService({ server });
  await gs.mount();
  gs.roundStartTime = PREVIOUS_ROUND_START;
  gs.matchId = PREVIOUS_MATCH_ID;
  return gs;
}

/**
 * S³'s real NEW_GAME listener over a stub service set: a heartbeat that yields,
 * and the gameState under test.
 *
 * Bound by calling the real _bindServerEvents(), not by registering the handler
 * here — the binding IS half of what is under test. A fixture that prepends by
 * hand would keep passing after someone changed the source back to `on()`.
 */
function bindS3(server, gs, counter) {
  const s3 = {
    server,
    _lastRegistryHeartbeatAt: 0,
    verbose() {},
    services: {
      db: { heartbeatServer: () => slowHeartbeat(counter) },
      gameState: gs,
      factions: null
    },
    listeners: {}
  };

  const noop = () => {};
  s3.listeners.handleNewGame = (data) => SlackersSquadServices.prototype.handleNewGame.call(s3, data);
  s3.listeners.handleRoundEnded = noop;
  s3.listeners.handleLayerInfoUpdated = noop;
  s3.listeners.handleServerInfoUpdated = noop;
  s3.listeners.handleUpdatedPlayerInfo = noop;
  s3.listeners.handlePlayerConnected = noop;

  SlackersSquadServices.prototype._bindServerEvents.call(s3);
  return s3;
}

/** Records what a consumer plugin's own NEW_GAME handler would read. */
function bindConsumer(server, gs, seen) {
  server.on('NEW_GAME', () => {
    seen.roundStartTime = gs.getRoundStartTime();
    seen.matchId = gs.getMatchId();
    seen.readAt = Date.now();
  });
}

/** Lets the async half of the listener finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

test('a consumer registered after S³ reads this round, not the last one', async () => {
  const server = new MockServer();
  const gs = await liveGameState(server);
  const counter = {};
  const seen = {};

  bindS3(server, gs, counter);
  bindConsumer(server, gs, seen);

  server.emit('NEW_GAME', { layer: 'Logar_RAAS_v1' });
  await settle();

  assert.notEqual(
    seen.roundStartTime, PREVIOUS_ROUND_START,
    'the consumer read the previous round start — S³ awaited something before stamping the clock'
  );
  assert.notEqual(seen.matchId, PREVIOUS_MATCH_ID, 'the consumer read the previous round key');
  assert.equal(seen.roundStartTime, gs.getRoundStartTime(), 'the consumer and gameState must agree');
  assert.equal(seen.matchId, gs.getMatchId(), 'the consumer and gameState must agree on the round key');

  await gs.unmount();
});

test('a consumer registered BEFORE S³ reads this round too', async () => {
  const server = new MockServer();
  const gs = await liveGameState(server);
  const counter = {};
  const seen = {};

  // Mount order puts S³ first today because consumers wait on _awaitS3Ready().
  // This case is what makes that stop being load-bearing.
  bindConsumer(server, gs, seen);
  bindS3(server, gs, counter);

  server.emit('NEW_GAME', { layer: 'Logar_RAAS_v1' });
  await settle();

  assert.notEqual(
    seen.roundStartTime, PREVIOUS_ROUND_START,
    'S³ must run first regardless of registration order — bind NEW_GAME with prependListener'
  );
  assert.equal(seen.roundStartTime, gs.getRoundStartTime(), 'the consumer and gameState must agree');

  await gs.unmount();
});

test('the stamp is when NEW_GAME arrived, not when the heartbeat finished', async () => {
  const server = new MockServer();
  const gs = await liveGameState(server);
  const counter = {};
  const seen = {};

  bindS3(server, gs, counter);
  bindConsumer(server, gs, seen);

  const emittedAt = Date.now();
  server.emit('NEW_GAME', { layer: 'Logar_RAAS_v1' });
  await settle();

  assert.ok(
    Number.isFinite(counter.finishedAt),
    'the fixture heartbeat did not run — this case would pass for the wrong reason'
  );
  assert.ok(
    gs.getRoundStartTime() >= emittedAt,
    'the round cannot have started before the event that announced it'
  );
  // Measured against when the heartbeat STARTED, not when it finished. A
  // handler that stamps after the heartbeat sets the clock in the same
  // millisecond the heartbeat records as its end, so "before the end" is a
  // comparison that passes either way — "before the beginning" is the one that
  // separates them.
  assert.ok(
    gs.getRoundStartTime() <= counter.startedAt,
    'the clock was stamped after the heartbeat ran — the round start must be the event, not the handler'
  );
  assert.ok(
    counter.finishedAt - counter.startedAt >= 10,
    'the fixture heartbeat returned too fast to distinguish the two — the case would pass either way'
  );
  assert.equal(
    gs.lastNewGameAt, gs.getRoundStartTime(),
    'the phase transition must be timed from the stamp, or the staging window starts late'
  );

  await gs.unmount();
});

test('handleNewGame() called cold still stamps', async () => {
  const server = new MockServer();
  const gs = await liveGameState(server);

  // No prepended stamp: the dev harness and every existing test call it this way.
  await gs.handleNewGame({ layer: 'Logar_RAAS_v1' });

  assert.notEqual(gs.getRoundStartTime(), PREVIOUS_ROUND_START, 'a cold call must stamp the clock itself');
  assert.notEqual(gs.getMatchId(), PREVIOUS_MATCH_ID, 'a cold call must mint a round key');

  await gs.unmount();
});

test('stamping does not skip the STAGING transition or layer invalidation', async () => {
  const server = new MockServer();
  const gs = await liveGameState(server);
  const counter = {};

  // A resolved layer from the round that just ended, so invalidation is visible.
  await gs.resolveLayerInfo('BlackCoast_RAAS_v2', 'test');
  assert.equal(gs.isLayerResolved(), true);

  bindS3(server, gs, counter);

  server.emit('NEW_GAME', { layer: 'Logar_RAAS_v1' });

  // Synchronously after emit: the stamp has landed, the async remainder has not.
  assert.notEqual(gs.getRoundStartTime(), PREVIOUS_ROUND_START, 'the stamp must land before anything awaits');

  await settle();

  assert.equal(gs.phase, 'STAGING', 'the async remainder must still run the phase transition');
  assert.equal(gs.resolving, true, 'a new round starts unresolved');
  assert.equal(gs.getLayerName(), 'Logar_RAAS_v1', 'the new round\'s layer must replace the old one');

  await gs.unmount();
});

test('a second stamp before the handler runs keeps the first', async () => {
  const server = new MockServer();
  const gs = await liveGameState(server);

  const first = gs.stampNewGame({ layer: 'Logar_RAAS_v1' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = gs.stampNewGame({ layer: 'Logar_RAAS_v1' });

  assert.equal(second, first, 'a duplicate stamp must not move the round start');

  await gs.handleNewGame({ layer: 'Logar_RAAS_v1' });
  assert.equal(gs.getRoundStartTime(), first, 'the handler must consume the stamp, not replace it');

  await gs.unmount();
});

test('an abandoned stamp does not latch and cost the next round its clock', async () => {
  const server = new MockServer();
  const gs = await liveGameState(server);

  // A stamp whose handler never arrived: S³ threw between the two calls, or the
  // service was swapped out. Aged past the TTL by hand rather than by waiting.
  gs.stampNewGame({ layer: 'Logar_RAAS_v1' });
  const abandoned = gs.getRoundStartTime();
  gs._pendingNewGameStampAt = Date.now() - (GameStateService.PENDING_STAMP_TTL_MS + 1000);

  // Far enough apart that a re-stamp reads a different millisecond — otherwise
  // "it re-stamped" and "it returned the old value" are the same number.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const next = gs.stampNewGame({ layer: 'Skorpo_Invasion_v1' });

  assert.notEqual(
    next, abandoned,
    'the next round deferred to a stamp nobody consumed — the latch is the same bug with a rarer trigger'
  );

  await gs.unmount();
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  await run();
} finally {
  cleanAssembly(ASSEMBLY);
}
