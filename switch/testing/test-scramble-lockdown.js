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

  return { plugin, db, seq, model: db.getModel(TABLE) };
}

const P = (eosID, name) => ({ eosID, name, steamID: `steam-${eosID}`, teamID: '1' });

console.log('');
console.log('🧪 Scramble Lockdown — real write path');
console.log('');

// ── The regression this file exists for ────────────────────────────
await runTest('rows created by a scramble carry lastActiveTimestamp', async () => {
  const players = [P('eos-a', 'Alpha'), P('eos-b', 'Bravo'), P('eos-c', 'Charlie')];
  const { plugin, model, seq } = await buildPlugin({ players });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  const rows = await model.findAll();
  assert.strictEqual(rows.length, 3, 'a lockdown row should exist per player');
  for (const row of rows) {
    assert.ok(
      row.lastActiveTimestamp instanceof Date,
      `${row.eosID}: lastActiveTimestamp is ${row.lastActiveTimestamp} — cleanup() never prunes NULL, so this row would be immortal, and Switch v5 asserts it is not NULL`
    );
    assert.ok(row.scrambleLockdownExpiry instanceof Date, `${row.eosID}: lockdown expiry not written`);
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
  const { plugin, model, seq } = await buildPlugin({ players });

  // Alpha has been around: a real last-seen time the join/leave handlers own.
  const known = new Date('2026-01-02T03:04:05.000Z');
  await model.create({ eosID: 'eos-a', playerName: 'Alpha', tokenBalance: 2, lastActiveTimestamp: known });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  const alpha = await model.findByPk('eos-a');
  assert.strictEqual(
    new Date(alpha.lastActiveTimestamp).getTime(), known.getTime(),
    'the scramble overwrote a tracked last-seen time — updateOnDuplicate should not list this column'
  );
  assert.ok(alpha.scrambleLockdownExpiry instanceof Date, 'existing row should still get the lockdown');

  const bravo = await model.findByPk('eos-b');
  assert.ok(bravo.lastActiveTimestamp instanceof Date, 'newly created row still needs its stamp');
  await seq.close();
});

// ── Exemptions still work, and still do not write NULL rows ────────
await runTest('queued players are exempt and get no row at all', async () => {
  const players = [P('eos-a', 'Alpha'), P('eos-b', 'Bravo')];
  const { plugin, model, seq } = await buildPlugin({ players, queued: ['eos-b'] });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  assert.strictEqual(await model.count(), 1, 'only the non-queued player should be locked');
  const row = await model.findByPk('eos-a');
  assert.ok(row, 'the non-exempt player should have a row');
  assert.ok(row.lastActiveTimestamp instanceof Date, 'stamp missing on the surviving row');
  await seq.close();
});

// ── The invariant holds for the whole table after a scramble ───────
// The same question drift detection asks on every mount.
await runTest('no NULL lastActiveTimestamp remains after a scramble', async () => {
  const players = Array.from({ length: 25 }, (_, i) => P(`eos-${i}`, `P${i}`));
  const { plugin, model, seq } = await buildPlugin({ players });

  await plugin.onScrambleExecuted({ affectedPlayers: players, failedPlayers: [] });

  const nulls = await model.count({ where: { lastActiveTimestamp: null } });
  assert.strictEqual(nulls, 0, `${nulls} row(s) would fail the v5 data assertion and re-gate Switch on next mount`);
  // 25 players crosses the chunkSize=10 boundary, so this also covers the
  // multi-chunk path rather than only the single-INSERT case.
  assert.strictEqual(await model.count(), 25, 'chunked writes lost rows');
  await seq.close();
});

console.log('');
console.log(`📊 Results: ${passed}/${passed + failed} passed, ${failed} failed`);
console.log('');

cleanAssembly(ASSEMBLY);
if (failed > 0) process.exitCode = 1;
