/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   TEST: SCRAMBLE LOCKDOWN — the real write path               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Every other Switch suite exercises the *effects* of a lockdown row — it
 * blocks a switch, `!switch clear` nulls it — by constructing that row by
 * hand. Nothing ran onScrambleExecuted, which is what actually writes them.
 *
 * That mattered when v2.5.5 changed the write: the lockdown bulkCreate had
 * been omitting lastActiveTimestamp, which made every row it created immortal
 * (cleanup() requires the column to be non-NULL before pruning) and, once
 * Switch v5 declared a notNull post-condition on that column, would have
 * re-gated the plugin on every mount after any scramble.
 *
 * ─── WHY IT LOOKS DIFFERENT TO THE OTHER SWITCH SUITES ───────────
 *
 * The mock harness builds a plugin *stub*. onScrambleExecuted is a class
 * field holding an arrow function, so it exists only on real instances and
 * closes over the instance it was constructed on — it cannot be borrowed onto
 * a stub, and re-implementing it in one would test the copy rather than the
 * code, which is exactly how the v5 defect survived a green suite.
 *
 * So this builds the shipped layout, constructs a real Switch, and replaces
 * only its collaborators. Everything between the event and the INSERT is the
 * production code path against a real database.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-scramble-lockdown.js
 *
 * Category: 1 (SQLite only — no dialect-specific behaviour here)
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

import DBService from '../../s3/utils/db-service.js';
import SwitchDB from '../utils/switch-db.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';

const TABLE = 'SwitchPlugin_PlayerCooldowns';
// The scramble writes two tables since the cooldown split: identity on the
// community-wide row, the lock itself on this server’s row. Both halves are
// asserted, because a scramble that writes one of them is not a partial
// success — it is either a lock nobody has a wallet for or a wallet that
// quietly did not get locked.
const STATE_TABLE = 'SwitchPlugin_PlayerServerState';
const ASSEMBLY = buildAssembly('.tmp-switch-scramble');
const Switch = await importFromAssembly(ASSEMBLY, 'switch.js');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

/**
 * A mounted-enough Switch: real class, real DB, stubbed collaborators.
 *
 * Only the things onScrambleExecuted reaches on its way to the INSERT are
 * provided. Anything it would call that is out of scope (Discord, RCON warns)
 * is a no-op, and the handler already tolerates those failing.
 */
async function buildPlugin({ players, queued = [], minPlayers = 0, joinSeconds = 9999 }) {
  const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const db = new DBService({ sequelize: seq, defaultRetry: { attempts: 1, baseDelayMs: 0, jitterMs: 0 } });
  await db.mount();

  // Real schema, through the plugin's own registration and the real engine.
  await SwitchDB.register({
    _s3db: db,
    s3db: db,
    verbose: () => {},
    defineModel: (n, s, o) => db.defineModel(n, s, o),
    registerExpectedVersion: (n, v, o) => db.registerExpectedVersion(n, v, o),
    registerMigrations: (n, m) => db.migrationEngine.registerMigrations(n, m),
    verifyAndRunMigrations: async () => null,
    _getModel: (n) => db.getModel(n),
    _withDb: async (fn) => fn(),
    reportError: () => {}
  });
  db.migrationEngine.confirmToken('__force__');
  await db.migrationEngine.runMigrations('switch');

  const server = { players, on: () => {}, off: () => {}, removeListener: () => {} };

  const plugin = new Switch(server, {
    scrambleLockdownDurationMinutes: 20,
    scrambleLockdownMinPlayers: minPlayers,
    switchEnabledMinutes: 5,
    maxSwitchTokens: 2
  }, {});

  Object.assign(plugin, {
    verbose: () => {},
    warn: () => {},
    sendDiscordMessage: async () => {},
    _s3: {
      gameState: { isSeedMode: () => false },
      players: { isReady: () => true, getAllPlayers: () => players }
    },
    _s3db: db,
    _getModel: (n) => db.getModel(n),
    _withDb: async (fn) => fn(null),
    _clearAllQueueEntries: () => {},
    _resetPlayerLockouts: async () => true,
    // Every player is long past the switch window unless a test says otherwise,
    // so exemptions do not silently empty the lockdown set.
    getSecondsFromJoin: async () => joinSeconds,
    getSecondsFromMatchStart: () => joinSeconds
  });
  plugin._switchQueue = { t1: queued.map((eosID) => ({ eosID })), t2: [] };

  return { plugin, db, seq, model: db.getModel(TABLE), stateModel: db.getModel(STATE_TABLE) };
}

const P = (eosID, name) => ({ eosID, name, steamID: `steam-${eosID}`, teamID: '1' });

console.log('');
console.log('🧪 Scramble Lockdown — real write path');
console.log('');

// ── The regression this file exists for ────────────────────────────
await runTest('rows created by a scramble carry lastActiveTimestamp', async () => {
  const players = [P('eos-a', 'Alpha'), P('eos-b', 'Bravo'), P('eos-c', 'Charlie')];
  const { plugin, model, stateModel, seq } = await buildPlugin({ players });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  const rows = await model.findAll();
  assert.strictEqual(rows.length, 3, 'a lockdown row should exist per player');
  for (const row of rows) {
    assert.ok(
      row.lastActiveTimestamp instanceof Date,
      `${row.eosID}: lastActiveTimestamp is ${row.lastActiveTimestamp} — cleanup() never prunes NULL, so this row would be immortal, and Switch v5 asserts it is not NULL`
    );
  }

  const state = await stateModel.findAll();
  assert.strictEqual(state.length, 3, 'a per-server state row should exist per player');
  for (const row of state) {
    assert.ok(row.scrambleLockdownExpiry instanceof Date, `${row.eosID}: lockdown expiry not written`);
    assert.strictEqual(row.serverID, 1, `${row.eosID}: locked under the wrong server`);
    assert.ok(row.lastActiveTimestamp instanceof Date, `${row.eosID}: the per-server row needs its own stamp for _pruneServerState()`);
  }
  await seq.close();
});

// ── The value must survive a read, not just an INSERT ──────────────
// A Date written untyped lands on SQLite as an integer epoch and throws on
// every later read. Reading through the model is what catches that.
await runTest('the written timestamp reads back as a usable Date', async () => {
  const players = [P('eos-a', 'Alpha')];
  const { plugin, model, seq } = await buildPlugin({ players });

  const before = Date.now();
  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  const row = await model.findByPk('eos-a');
  const stamped = new Date(row.lastActiveTimestamp).getTime();
  assert.ok(Number.isFinite(stamped), 'timestamp did not survive the round trip');
  assert.ok(stamped >= before - 1000 && stamped <= Date.now() + 1000, `stamped ${stamped} is not around now`);
  await seq.close();
});

// ── updateOnDuplicate must not clobber a tracked value ─────────────
await runTest('an existing row keeps its own lastActiveTimestamp', async () => {
  const players = [P('eos-a', 'Alpha'), P('eos-b', 'Bravo')];
  const { plugin, model, stateModel, seq } = await buildPlugin({ players });

  // Alpha has been around: a real last-seen time the join/leave handlers own.
  const known = new Date('2026-01-02T03:04:05.000Z');
  await model.create({ eosID: 'eos-a', playerName: 'Alpha', tokenBalance: 2, lastActiveTimestamp: known });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  const alpha = await model.findByPk('eos-a');
  assert.strictEqual(
    new Date(alpha.lastActiveTimestamp).getTime(), known.getTime(),
    'the scramble overwrote a tracked last-seen time — updateOnDuplicate should not list this column'
  );
  const alphaState = await stateModel.findOne({ where: { serverID: 1, eosID: 'eos-a' } });
  assert.ok(alphaState?.scrambleLockdownExpiry instanceof Date, 'existing row should still get the lockdown');

  const bravo = await model.findByPk('eos-b');
  assert.ok(bravo.lastActiveTimestamp instanceof Date, 'newly created row still needs its stamp');
  await seq.close();
});

// ── Exemptions still work, and still do not write NULL rows ────────
await runTest('queued players are exempt and get no row at all', async () => {
  const players = [P('eos-a', 'Alpha'), P('eos-b', 'Bravo')];
  const { plugin, model, stateModel, seq } = await buildPlugin({ players, queued: ['eos-b'] });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  assert.strictEqual(await model.count(), 1, 'only the non-queued player should be locked');
  assert.strictEqual(await stateModel.count(), 1, 'the exempt player should have no per-server row either');
  const row = await model.findByPk('eos-a');
  assert.ok(row, 'the non-exempt player should have a row');
  assert.ok(row.lastActiveTimestamp instanceof Date, 'stamp missing on the surviving row');
  await seq.close();
});

// ── The invariant holds for the whole table after a scramble ───────
// The same question drift detection asks on every mount.
await runTest('no NULL lastActiveTimestamp remains after a scramble', async () => {
  const players = Array.from({ length: 25 }, (_, i) => P(`eos-${i}`, `P${i}`));
  const { plugin, model, stateModel, seq } = await buildPlugin({ players });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  const nulls = await model.count({ where: { lastActiveTimestamp: null } });
  assert.strictEqual(nulls, 0, `${nulls} row(s) would fail the v5 data assertion and re-gate Switch on next mount`);
  // 25 players crosses the chunkSize=10 boundary, so this also covers the
  // multi-chunk path rather than only the single-INSERT case.
  assert.strictEqual(await model.count(), 25, 'chunked writes lost rows');
  // Both tables are sliced by the same loop. A slice offset applied to one
  // and not the other is arithmetic that still runs and still says nothing,
  // so the count on the second table is the only thing that would catch it.
  assert.strictEqual(await stateModel.count(), 25, 'chunked writes lost per-server rows');
  await seq.close();
});

// ── A second scramble extends the lock rather than colliding ───────
// Two scrambles in one evening, or a re-scramble after a failed move, hit a
// (serverID, eosID) that already exists. Without the expiry in the new
// table's updateOnDuplicate list that is a duplicate-key error rather than an
// extended lockdown — and the catch around the write reports it as a failed
// scramble, so the lock silently stops being applied from the second one on.
await runTest('a second scramble extends the lock instead of failing on the key', async () => {
  const players = [P('eos-a', 'Alpha'), P('eos-b', 'Bravo')];
  const { plugin, model, stateModel, seq } = await buildPlugin({ players });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });
  const first = await stateModel.findOne({ where: { serverID: 1, eosID: 'eos-a' } });
  assert.ok(first?.scrambleLockdownExpiry instanceof Date, 'the first scramble did not lock');

  // Wind the first expiry back so the second one is unambiguously later.
  const stale = new Date(Date.now() - 60 * 60 * 1000);
  await stateModel.update({ scrambleLockdownExpiry: stale }, { where: { serverID: 1 } });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  assert.strictEqual(await stateModel.count(), 2, 'the second scramble should update rows, not add or lose them');
  const second = await stateModel.findOne({ where: { serverID: 1, eosID: 'eos-a' } });
  assert.ok(
    new Date(second.scrambleLockdownExpiry).getTime() > stale.getTime(),
    'the second scramble did not extend the lockdown — the expiry is missing from updateOnDuplicate'
  );
  assert.strictEqual(await model.count(), 2, 'the identity table should still hold one row per player');
  await seq.close();
});

// ── The pair is written under one transaction ────────────────────
// There is no CLS in this repo, so the handle has to be passed explicitly to
// both writes, and this asserts the handle rather than an effect of it. The
// effect is not observable here: SQLite backs an in-memory database with one
// connection, so a statement issued with no handle still runs inside whatever
// transaction that connection has open and still rolls back with it. On MySQL
// and Postgres the pool hands it a different connection and it commits on its
// own — a lock row that survives the rollback of the wallet it belongs to.
// An assertion that cannot fail on the engine the test runs on is worse than
// no assertion, so this compares the two handles directly.
await runTest('both halves of the lockdown write share one transaction handle', async () => {
  const players = [P('eos-a', 'Alpha'), P('eos-b', 'Bravo')];
  const { plugin, model, stateModel, db, seq } = await buildPlugin({ players });

  plugin._withDb = async (fn) => db.sequelize.transaction(async (t) => fn(t));

  const seen = [];
  const spy = (target, label) => {
    const real = target.bulkCreate.bind(target);
    target.bulkCreate = async (rows, opts = {}) => {
      seen.push({ label, transaction: opts.transaction });
      return real(rows, opts);
    };
  };
  spy(model, 'cooldowns');
  spy(stateModel, 'state');

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  assert.deepEqual(seen.map((s) => s.label), ['cooldowns', 'state'], 'both tables should be written once');
  for (const s of seen) {
    assert.ok(s.transaction, `the ${s.label} write got no transaction handle — S³ runs no CLS, so it executed outside the transaction`);
  }
  assert.strictEqual(seen[0].transaction, seen[1].transaction, 'the two writes ran under different transactions');
  await seq.close();
});

// ── A mid-chunk failure takes the earlier chunks with it ─────────
// The loop commits nothing per chunk, so a failure on chunk two must undo
// chunk one on both tables. Without that, a scramble that dies halfway
// locks the first ten players and nobody else, which is worse than not
// locking anyone: the ten cannot switch and the rest can.
await runTest('a failure part-way through the chunks rolls back the earlier ones', async () => {
  const players = Array.from({ length: 25 }, (_, i) => P(`eos-${i}`, `P${i}`));
  const { plugin, model, stateModel, db, seq } = await buildPlugin({ players });

  plugin._withDb = async (fn) => db.sequelize.transaction(async (t) => fn(t));

  let calls = 0;
  const real = model.bulkCreate.bind(model);
  model.bulkCreate = async (rows, opts) => {
    calls += 1;
    if (calls === 2) throw new Error('engine says no');
    return real(rows, opts);
  };

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  assert.strictEqual(await model.count(), 0, 'the first chunk of identity rows survived a failed scramble');
  assert.strictEqual(await stateModel.count(), 0, 'the first chunk of lock rows survived a failed scramble');
  await seq.close();
});

// ── Elo-diff micro scramble: no lockdown write ─────────────────────
// The lockout guard exists to stop players exploiting a just-corrected
// imbalance after a full reactive scramble. Disproportionate for a micro
// scramble whose entire premise is "no blowout happened, just a small
// post-round gap."
await runTest('an EloDiff scramble writes no lockdown rows at all', async () => {
  const players = [P('eos-a', 'Alpha'), P('eos-b', 'Bravo'), P('eos-c', 'Charlie')];
  const { plugin, model, stateModel, seq } = await buildPlugin({ players });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [], scrambleType: 'EloDiff' });

  assert.strictEqual(await model.count(), 0, 'EloDiff scramble should never write a lockdown row');
  assert.strictEqual(await stateModel.count(), 0, 'EloDiff scramble should never write a per-server row either');
  await seq.close();
});

await runTest('an EloDiff scramble does not arm the post-scramble broadcast flag', async () => {
  // _scrambleHappened drives _startPostScrambleBroadcastTimers() at the next NEW_GAME, which
  // broadcasts "Returning players cannot change teams this round" — actively false when no
  // lockdown row was written, so it must stay false for this scramble type.
  const players = [P('eos-a', 'Alpha')];
  const { plugin, seq } = await buildPlugin({ players });

  assert.strictEqual(plugin._scrambleHappened, false, 'precondition: flag starts false');
  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [], scrambleType: 'EloDiff' });
  assert.strictEqual(plugin._scrambleHappened, false, '_scrambleHappened must not be armed by an EloDiff scramble');
  await seq.close();
});

await runTest('a normal (non-EloDiff) scramble still arms the post-scramble broadcast flag', async () => {
  // The converse of the case above — the reorder that fixed the EloDiff leak must not have
  // broken the flag for the three original scramble triggers, which still want the lockdown
  // broadcast for the whole next round.
  const players = [P('eos-a', 'Alpha')];
  const { plugin, seq } = await buildPlugin({ players });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });
  assert.strictEqual(plugin._scrambleHappened, true, '_scrambleHappened should still be armed for a real lockdown scramble');
  await seq.close();
});

await runTest('an EloDiff scramble still clears the switch queue', async () => {
  const players = [P('eos-a', 'Alpha'), P('eos-b', 'Bravo')];
  const { plugin, seq } = await buildPlugin({ players, queued: ['eos-a'] });

  let clearedReason = null;
  plugin._clearAllQueueEntries = (reason) => { clearedReason = reason; };

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [], scrambleType: 'EloDiff' });
  assert.strictEqual(clearedReason, 'Scramble', 'queue clear must run unconditionally, including for EloDiff');
  await seq.close();
});

await runTest('an EloDiff scramble still remediates failed-to-move players', async () => {
  // Failed-move remediation (+1 token grant) is documented to run unconditionally, independent
  // of the lockdown write this scramble type skips.
  const players = [P('eos-a', 'Alpha'), P('eos-b', 'Bravo')];
  const { plugin, seq } = await buildPlugin({ players });

  let remediatedEosID = null;
  plugin._resetPlayerLockouts = async (eosID) => { remediatedEosID = eosID; return true; };

  await plugin.onScrambleExecuted({
    affectedPlayers: players,
    failedPlayers: [{ eosID: 'eos-b', name: 'Bravo' }],
    scrambleType: 'EloDiff'
  });

  assert.strictEqual(remediatedEosID, 'eos-b', 'failed-move remediation should still fire for an EloDiff scramble');
  await seq.close();
});

await runTest('an EloDiff scramble respects the low-population guard, same as a normal scramble', async () => {
  const players = [P('eos-a', 'Alpha')];
  const { plugin, model, seq } = await buildPlugin({ players, minPlayers: 60 });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [], scrambleType: 'EloDiff' });
  assert.strictEqual(await model.count(), 0, 'below-threshold population should still skip everything');
  assert.strictEqual(plugin._scrambleHappened, false, 'flag should not be armed on the low-pop exit either');
  await seq.close();
});

console.log('');
console.log(`📊 Results: ${passed}/${passed + failed} passed, ${failed} failed`);
console.log('');

cleanAssembly(ASSEMBLY);
if (failed > 0) process.exitCode = 1;
