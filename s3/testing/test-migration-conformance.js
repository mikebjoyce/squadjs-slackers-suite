/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   MIGRATION CONFORMANCE — REAL MIGRATIONS, REAL DB STATES     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Replays each plugin's ACTUAL registered migrations against real
 * database engines, in the states a live server actually presents.
 *
 * This exists because of the Switch v5 incident (2026-08-18), where a
 * broken migration shipped and neither the mock suite nor the engine
 * tests caught it:
 *
 *   - test-migration-pipeline.js exercises the ENGINE using stub
 *     migrations (`up: async () => {}`). It never executes a line of a
 *     plugin's real migration code, so `qi.bulkUpdate is not a function`
 *     was invisible to it.
 *   - The maintainer's own MySQL server could not have caught it either:
 *     its DB user has no ALTER grant, so schema changes are applied by
 *     hand and `up()` runs against a database where the column already
 *     exists — skipping the very branch that was broken.
 *
 * So the two failure modes are "the migration code is never run" and
 * "it is only ever run in one DB state". This file addresses both: it
 * runs the real `up()` functions, in every state below, per engine.
 *
 * ─── STATES COVERED ──────────────────────────────────────────────
 *
 *   fresh          v0 → latest on an empty database.
 *   upgrade(K)     v0 → K, then K → latest, for every K. Operators
 *                  upgrade from wherever they were, not just the last hop.
 *   hand-migrated  Schema already at latest, version row rolled back to
 *                  K — a DB whose DDL was applied by hand (no ALTER
 *                  grant), or one killed after the ALTER and before the
 *                  version record. Re-applying must succeed, not throw.
 *   re-run         Applying twice is a no-op the second time.
 *   read-back      After every state, every model the plugin registered
 *                  is SELECTed. This is what catches a value written in a
 *                  form the engine cannot read back — the SQLite
 *                  Date-as-integer defect that followed the first fix.
 *
 * ─── ADDING A PLUGIN ─────────────────────────────────────────────
 *
 * Append an adapter to ADAPTERS below. An adapter's only job is to make
 * the plugin register its models and migrations against a DBService —
 * the scenarios are generic and apply automatically, so a new migration
 * version inherits all of the above the day it is written, with no test
 * changes.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-migration-conformance.js
 *
 *   # with the Docker engines (ports match test-dialect-portability.js):
 *   docker run -d --name s3-test-postgres -e POSTGRES_PASSWORD=postgres \
 *     -p 5433:5432 postgres:16-alpine
 *   docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -p 3307:3306 mysql:8
 *
 * Category: 1 (SQLite always; MySQL/Postgres auto-skip)
 */

'use strict';

import assert from 'node:assert/strict';

import { Sequelize } from 'sequelize';

import DBService from '../utils/db-service.js';
import PlayersService from '../utils/players-service.js';
import SwitchDB from '../../switch/utils/switch-db.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from './plugin-assembly.js';

/**
 * The three plugins that register their schema inline are imported from a
 * throwaway flattened assembly, because their entry points import sibling S³
 * files that only resolve in the shipped layout. See plugin-assembly.js.
 */
const ASSEMBLY_DIR = buildAssembly('.tmp-conformance');
const EloTracker = await importFromAssembly(ASSEMBLY_DIR, 'elo-tracker.js');
const SmartAssign = await importFromAssembly(ASSEMBLY_DIR, 'smart-assign.js');
const TeamBalancer = await importFromAssembly(ASSEMBLY_DIR, 'team-balancer.js');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const tests = [];
const SKIP = Symbol('skip');

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(72));
  console.log('Migration Conformance  (real plugin migrations, real engines)');
  console.log('='.repeat(72));
  console.log('');

  for (const t of tests) {
    try {
      const result = await t.fn();
      if (result === SKIP) {
        console.log(`  ⚠ ${t.name} — SKIPPED (engine unreachable)`);
        skipped++;
      } else {
        console.log(`  ✓ ${t.name}`);
        passed++;
      }
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${String(err.message).split('\n')[0]}`);
      failed++;
    }
  }

  console.log('');
  console.log('─'.repeat(72));
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped, ${tests.length} total`);
  console.log('─'.repeat(72));

  if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Connection config — ports match test-dialect-portability.js
// ---------------------------------------------------------------------------

const RUN_ID = `${process.pid}_${Date.now() % 100000}`;

const MYSQL = {
  dialect: 'mysql',
  host: process.env.S3_TEST_MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.S3_TEST_MYSQL_PORT || '3307', 10),
  username: process.env.S3_TEST_MYSQL_ROOT_USER || 'root',
  password: process.env.S3_TEST_MYSQL_ROOT_PASSWORD || 'root',
  database: process.env.S3_TEST_MYSQL_DATABASE || 'mysql',
  logging: false,
  dialectOptions: { connectTimeout: 4000 }
};

const POSTGRES = {
  dialect: 'postgres',
  host: process.env.S3_TEST_PG_HOST || '127.0.0.1',
  port: parseInt(process.env.S3_TEST_PG_PORT || '5433', 10),
  username: process.env.S3_TEST_PG_ADMIN_USER || 'postgres',
  password: process.env.S3_TEST_PG_ADMIN_PASSWORD || 'postgres',
  database: process.env.S3_TEST_PG_DATABASE || 'postgres',
  logging: false,
  dialectOptions: { connectionTimeoutMillis: 4000 }
};

const SQLITE = { dialect: 'sqlite', storage: ':memory:', logging: false };

const DIALECTS = [
  { name: 'sqlite', opts: SQLITE },
  { name: 'mysql', opts: MYSQL },
  { name: 'postgres', opts: POSTGRES }
];

const reachability = new Map([['sqlite', true]]);

async function probeReachability() {
  for (const [name, opts] of [['mysql', MYSQL], ['postgres', POSTGRES]]) {
    let seq;
    try {
      seq = new Sequelize(opts);
      await seq.authenticate();
      reachability.set(name, true);
      console.log(`  ${name} reachable on ${opts.host}:${opts.port}`);
    } catch {
      reachability.set(name, false);
      console.log(`  ⚠ ${name} not reachable on ${opts.host}:${opts.port} — those cases will skip`);
    } finally {
      try { await seq?.close(); } catch { /* best effort */ }
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Plugin adapters
// ---------------------------------------------------------------------------

/**
 * A minimal stand-in for a mounted plugin, exposing only the surface the
 * schema-registration code touches. Delegates to the real DBService so the
 * models and migrations under test are the production ones.
 */
function schemaProbe(db) {
  const probe = {
    _s3db: db,
    s3db: db,
    verbose: () => {},
    defineModel: (name, schema, opts) => db.defineModel(name, schema, opts),
    registerExpectedVersion: (name, version, opts) => db.registerExpectedVersion(name, version, opts),
    registerMigrations: (name, migrations) => db.migrationEngine.registerMigrations(name, migrations),
    // The harness drives migrations explicitly, per scenario.
    verifyAndRunMigrations: async () => null,
    _getModel: (name) => db.getModel(name),
    _withDb: async (fn) => fn(),
    reportError: () => {}
  };
  return probe;
}

/** Sentinel thrown to stop a plugin's mount once registration has happened. */
const STOP_AFTER_REGISTRATION = new Error('__stop_after_registration__');

/** Config defaults straight from the plugin's own optionsSpecification. */
function defaultOptions(PluginClass) {
  const spec = PluginClass.optionsSpecification || {};
  const options = {};
  for (const [key, def] of Object.entries(spec)) {
    options[key] = def?.default;
  }
  return options;
}

/**
 * Drive a plugin's real mount far enough to register its schema, then abort.
 *
 * EloTracker, SmartAssign and TeamBalancer register models and migrations
 * inline in mount()/_onS3Ready(), so unlike Switch there is no isolated
 * registration function to call. Rather than refactor three live plugins to
 * suit a test, the probe runs the real method against a prototype-backed stand-in
 * and throws a sentinel from verifyAndRunMigrations() — the call every one of
 * them makes immediately after registering — which unwinds before any listener,
 * timer, or RCON work can start.
 *
 * If a plugin ever moves registration after that call, this returns zero
 * migrations and registerSchema() fails loudly rather than silently covering
 * nothing.
 */
async function mountUntilRegistered(PluginClass, db, extras = {}) {
  const plugin = Object.create(PluginClass.prototype);

  Object.assign(plugin, {
    _s3db: db,
    _s3: { isReady: () => true, db },
    options: defaultOptions(PluginClass),
    server: { on: () => {}, off: () => {}, removeListener: () => {}, plugins: [] },
    _isMounted: false,
    ready: false,
    verbose: () => {},
    reportError: () => {},
    // Stubbed: version gates and option validation are not what this test covers,
    // and both would need a fuller fake server than registration itself does.
    _checkS3Version: () => {},
    validateOptions: () => {},
    verifyAndRunMigrations: async () => { throw STOP_AFTER_REGISTRATION; },
    // Per-plugin collaborators the registration path happens to touch on its
    // way past. Kept minimal on purpose — anything more elaborate would mean
    // this test is mounting the plugin rather than reading its schema.
    ...extras
  });

  const entry = typeof plugin._onS3Ready === 'function' ? '_onS3Ready' : 'mount';
  try {
    await PluginClass.prototype[entry].call(plugin);
  } catch {
    // Everything after registration is out of scope, and how it stops varies:
    // Elo and TeamBalancer let the sentinel unwind, while SmartAssign wraps its
    // registration in a catch-all and carries on until it trips over a
    // collaborator this probe does not provide. Either way the schema is already
    // registered, and registerSchema() asserts that it is — so a plugin that
    // silently registered nothing fails loudly rather than passing vacuously.
  }
}

const ADAPTERS = [
  {
    pluginName: 'switch',
    label: 'switch',
    async register(db) {
      await SwitchDB.register(schemaProbe(db));
    }
  },
  {
    pluginName: 'elo-tracker',
    label: 'elo-tracker',
    async register(db) {
      await mountUntilRegistered(EloTracker, db);
    }
  },
  {
    pluginName: 'smart-assign',
    label: 'smart-assign',
    async register(db) {
      // SA hands its executor an S³ reference on the way to registration.
      await mountUntilRegistered(SmartAssign, db, { executor: {}, db: { setS3Db: () => {} } });
    }
  },
  {
    pluginName: 'team-balancer',
    label: 'team-balancer',
    async register(db) {
      await mountUntilRegistered(TeamBalancer, db);
    }
  },
  {
    pluginName: 's3-players',
    label: 's3-players',
    async register(db) {
      // PlayersService registers its migrations inside _initReconnectPersistence().
      // Calling the prototype method against a probe reaches the real registration
      // without mounting the service (which would want a server and gameState).
      const probe = {
        reconnectPersistence: true,
        _getDbService: () => db,
        verbose: () => {},
        verboseLogger: () => {}
      };
      await PlayersService.prototype._initReconnectPersistence.call(probe);
    }
  }
];

// ---------------------------------------------------------------------------
// Scenario plumbing
// ---------------------------------------------------------------------------

/** Open and mount a DBService for one dialect, on its own schema. */
async function openDb(dialect) {
  const base = DIALECTS.find((d) => d.name === dialect).opts;
  let opts = base;

  // MySQL/Postgres share a server across runs, so each case gets its own
  // database rather than colliding on table names.
  let adminSeq = null;
  let dbName = null;
  if (dialect !== 'sqlite') {
    dbName = `s3_conf_${RUN_ID}_${Math.floor(Math.random() * 100000)}`;
    adminSeq = new Sequelize(base);
    await adminSeq.query(`CREATE DATABASE ${dbName}`);
    await adminSeq.close();
    opts = { ...base, database: dbName };
  }

  const seq = new Sequelize(opts);
  const db = new DBService({
    sequelize: seq,
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();
  return { db, seq, dialect, dbName, base };
}

async function closeDb(ctx) {
  try { await ctx.db.unmount(); } catch { /* best effort */ }
  try { await ctx.seq.close(); } catch { /* best effort */ }
  if (ctx.dbName) {
    try {
      const adminSeq = new Sequelize(ctx.base);
      await adminSeq.query(`DROP DATABASE IF EXISTS ${ctx.dbName}`);
      await adminSeq.close();
    } catch { /* best effort */ }
  }
}

/**
 * Register a plugin's schema, then narrow the engine's registration to the
 * given version range so a partial upgrade can be replayed.
 *
 * Reaches into engine._migrations because registerMigrations() is append-only
 * and rejects re-registering a version it already holds — deliberate in
 * production, unhelpful when a test needs to stage v1..K and then K+1..latest.
 *
 * @returns {Array} the plugin's full migration list, ascending
 */
async function registerSchema(db, adapter) {
  await adapter.register(db);
  const all = [...(db.migrationEngine._migrations.get(adapter.pluginName) || [])]
    .sort((a, b) => a.version - b.version);
  assert.ok(all.length > 0, `adapter for "${adapter.pluginName}" registered no migrations`);
  return all;
}

function stageVersions(db, pluginName, migrations) {
  db.migrationEngine._migrations.set(pluginName, [...migrations].sort((a, b) => a.version - b.version));
}

async function applyPending(db, pluginName) {
  db.migrationEngine.confirmToken('__force__');
  return db.migrationEngine.runMigrations(pluginName);
}

/** SELECT from every model the plugin registered — the read-back guarantee. */
async function readBackAllModels(db, context) {
  for (const name of db.getModelNames()) {
    const model = db.getModel(name);
    if (!model) continue;
    try {
      await model.findAll({ limit: 5 });
    } catch (err) {
      throw new Error(`${context}: reading ${name} failed after migration — ${err.message}`);
    }
  }
}

async function setRecordedVersion(db, pluginName, version) {
  await db.SchemaVersionsModel.update({ version }, { where: { pluginName } });
}

/**
 * Get hold of a genuine query-interface wrapper — the same object migrations
 * receive — by running a throwaway migration that captures it. createQueryInterface
 * is module-private in migration-engine.js, and reaching for it would test a copy
 * rather than the thing itself.
 */
async function captureQueryInterface(db) {
  let captured = null;
  db.migrationEngine.registerMigrations('__qi_probe__', [
    {
      version: 1,
      description: 'capture the query interface',
      touches: {},
      up: async (qi) => { captured = qi; },
      down: async () => {}
    }
  ]);
  db.migrationEngine.confirmToken('__force__');
  await db.migrationEngine.runMigrations('__qi_probe__');
  assert.ok(captured, 'probe migration did not run');
  return captured;
}

/**
 * Extract every `<param>.member` reference from a migration handler's source,
 * where <param> is whatever that handler named its query-interface argument.
 *
 * Static rather than executed on purpose: a migration's down(), and any branch
 * guarded by a condition the test states do not reach, would otherwise never
 * have their method names checked at all — and a typo there surfaces during a
 * rollback, which is the worst possible moment to discover it.
 */
function referencedMembers(fn) {
  if (typeof fn !== 'function') return [];
  const src = fn.toString();
  const param = /^\s*(?:async\s+)?(?:function\s*)?\(?\s*([A-Za-z_$][\w$]*)/.exec(src)?.[1];
  if (!param || param === ')') return [];

  const members = new Set();
  const pattern = new RegExp(`\\b${param}\\.([A-Za-z_$][\\w$]*)`, 'g');
  let match;
  while ((match = pattern.exec(src)) !== null) members.add(match[1]);
  return [...members];
}

/**
 * Members whose presence in an up() means the migration rewrites values in rows
 * that already exist — the add-a-column-then-backfill shape that produced the
 * v5 incident. Those are the migrations whose success is not provable from the
 * schema alone, so they are the ones required to declare touches.data.
 *
 * bulkInsert is excluded: rows it creates are already covered by touches.rows.
 * bulkDelete is excluded: a deletion leaves no value to assert.
 */
const BACKFILL_MEMBERS = new Set(['bulkUpdate']);

/**
 * Does this migration rewrite existing rows without declaring what the rewrite
 * was supposed to achieve? Returns the offending members, or [] if it is fine.
 *
 * The escape hatch is an explicit empty declaration — `data: { Table: [] }` —
 * which reads as "considered, no invariant to assert" and cannot be arrived at
 * by forgetting.
 *
 * Heuristic, and honest about it: it only sees `qi.*` calls, so a migration that
 * reaches a model through qi.db.getModel() and calls .update() on it is invisible
 * here. It catches the shape that actually shipped broken, not every possible one.
 */
function undeclaredBackfill(migration) {
  const members = referencedMembers(migration.up).filter((m) => BACKFILL_MEMBERS.has(m));
  if (members.length === 0) return [];
  if (migration.touches?.data !== undefined) return [];
  return members;
}

// ═══════════════════════════════════════════════════════════════════════════
// Scenarios — generated per adapter, per dialect
// ═══════════════════════════════════════════════════════════════════════════

// ---- the scan must be capable of failing ----
// A reference scan that matches nothing passes everything, and looks identical
// in the output to one that works. (Confirmed the hard way: a copy of this
// function with `\b` instead of `\\b` inside the template literal silently
// matched zero members.) These cases keep the scan honest.
test('the query-interface scan detects members, including bad ones', async () => {
  const arrow = async (qi) => {
    await qi.addColumn('T', 'c', {});
    await qi.definitelyNotAMethod('T');
  };
  const arrowMembers = referencedMembers(arrow);
  assert.ok(arrowMembers.includes('addColumn'), 'scan missed a real member');
  assert.ok(arrowMembers.includes('definitelyNotAMethod'), 'scan missed a bogus member — it would pass anything');

  // Other shapes a migration handler can legally take.
  const named = async function (queryInterface) { await queryInterface.dropTable('T'); };
  assert.deepEqual(referencedMembers(named), ['dropTable'], 'scan mishandled function-expression form');

  const bare = async (qi) => qi.showAllTables();
  assert.deepEqual(referencedMembers(bare), ['showAllTables'], 'scan mishandled concise-body form');

  // And the scan must agree with reality about what does not exist.
  const ctx = await openDb('sqlite');
  try {
    const qi = await captureQueryInterface(ctx.db);
    assert.ok('addColumn' in qi, 'sanity: addColumn should exist on the wrapper');
    assert.ok(!('definitelyNotAMethod' in qi), 'sanity: bogus member should not exist');
  } finally {
    await closeDb(ctx);
  }
});

// ---- the backfill heuristic must be capable of failing ----
// Same discipline as the scan above: a check that never fires is
// indistinguishable in the output from one that passes honestly.
test('the backfill heuristic flags an undeclared rewrite and accepts a declared one', async () => {
  const backfill = async (qi) => {
    await qi.addColumn('T', 'c', {});
    await qi.bulkUpdate('T', { c: 1 }, {});
  };

  assert.deepEqual(
    undeclaredBackfill({ version: 1, touches: { columns: { T: ['c'] } }, up: backfill }),
    ['bulkUpdate'],
    'heuristic missed a bulkUpdate with no touches.data — it would pass anything'
  );

  assert.deepEqual(
    undeclaredBackfill({
      version: 1,
      touches: { columns: { T: ['c'] }, data: { T: [{ column: 'c', notNull: true }] } },
      up: backfill
    }),
    [],
    'heuristic flagged a migration that does declare touches.data'
  );

  assert.deepEqual(
    undeclaredBackfill({ version: 1, touches: { data: { T: [] } }, up: backfill }),
    [],
    'heuristic ignored the explicit empty opt-out'
  );

  assert.deepEqual(
    undeclaredBackfill({ version: 1, touches: {}, up: async (qi) => { await qi.bulkInsert('T', [{}]); } }),
    [],
    'heuristic fired on bulkInsert, which touches.rows already covers'
  );
});

for (const adapter of ADAPTERS) {
  // ---- rewrites of existing rows declare what they were for ----
  // Source-level, so it costs nothing and covers branches no scenario reaches.
  test(`${adapter.label}: every migration that rewrites existing rows declares touches.data`, async () => {
    const ctx = await openDb('sqlite');
    try {
      const all = await registerSchema(ctx.db, adapter);

      const problems = [];
      for (const migration of all) {
        const members = undeclaredBackfill(migration);
        if (members.length > 0) {
          problems.push(
            `v${migration.version} up() calls qi.${members.join(', qi.')} but declares no touches.data — ` +
            `add { data: { Table: [{ column: 'col', notNull: true }] } }, or { data: { Table: [] } } if there is genuinely no invariant`
          );
        }
      }

      assert.deepEqual(
        problems,
        [],
        `${adapter.pluginName} has backfills whose success nothing verifies:\n  ${problems.join('\n  ')}`
      );
    } finally {
      await closeDb(ctx);
    }
  });

  // ---- every qi.* call resolves, in up() AND down() ----
  // Dialect-independent: the wrapper's surface is the same everywhere, so this
  // runs once on SQLite rather than three times.
  test(`${adapter.label}: every query-interface member used by up()/down() exists`, async () => {
    const ctx = await openDb('sqlite');
    try {
      const all = await registerSchema(ctx.db, adapter);
      const qi = await captureQueryInterface(ctx.db);

      const problems = [];
      for (const migration of all) {
        for (const phase of ['up', 'down']) {
          for (const member of referencedMembers(migration[phase])) {
            if (!(member in qi)) {
              problems.push(`v${migration.version} ${phase}(): qi.${member} does not exist`);
            }
          }
        }
      }

      assert.deepEqual(
        problems,
        [],
        `${adapter.pluginName} calls query-interface members that are not there:\n  ${problems.join('\n  ')}`
      );
    } finally {
      await closeDb(ctx);
    }
  });

  for (const dialect of ['sqlite', 'mysql', 'postgres']) {
    // ---- fresh install ----
    test(`[${dialect}] ${adapter.label}: fresh install applies every migration`, async () => {
      if (!reachability.get(dialect)) return SKIP;
      const ctx = await openDb(dialect);
      try {
        const all = await registerSchema(ctx.db, adapter);
        const result = await applyPending(ctx.db, adapter.pluginName);
        assert.equal(result.applied, all.length, `expected ${all.length} migrations applied`);
        await readBackAllModels(ctx.db, 'fresh install');
      } finally {
        await closeDb(ctx);
      }
    });

    // ---- every upgrade path ----
    test(`[${dialect}] ${adapter.label}: upgrades cleanly from every prior version`, async () => {
      if (!reachability.get(dialect)) return SKIP;
      const probeCtx = await openDb(dialect);
      let all;
      try {
        all = await registerSchema(probeCtx.db, adapter);
      } finally {
        await closeDb(probeCtx);
      }

      for (let k = 1; k < all.length; k++) {
        const ctx = await openDb(dialect);
        try {
          const full = await registerSchema(ctx.db, adapter);
          const older = full.slice(0, k);
          const newer = full.slice(k);

          // Stand the DB up at the older version, as a server that has been
          // running since before the newer migrations shipped.
          stageVersions(ctx.db, adapter.pluginName, older);
          const first = await applyPending(ctx.db, adapter.pluginName);
          assert.equal(first.applied, older.length, `staging to v${older.at(-1).version} applied ${first.applied}`);
          // No read-back here: model definitions always describe the LATEST
          // schema, while a DB staged at an older version legitimately lacks
          // later columns. A real server at that version ran older code whose
          // models matched. Read-back only means something once the upgrade
          // has completed, which is where it is asserted below.

          // Now ship the newer ones on top.
          stageVersions(ctx.db, adapter.pluginName, full);
          const second = await applyPending(ctx.db, adapter.pluginName);
          assert.equal(
            second.applied,
            newer.length,
            `upgrade from v${older.at(-1).version} applied ${second.applied}, expected ${newer.length}`
          );
          await readBackAllModels(ctx.db, `upgraded from v${older.at(-1).version}`);
        } finally {
          await closeDb(ctx);
        }
      }
    });

    // ---- hand-migrated / interrupted ----
    test(`[${dialect}] ${adapter.label}: re-applies onto a hand-migrated database`, async () => {
      if (!reachability.get(dialect)) return SKIP;
      const ctx = await openDb(dialect);
      try {
        const all = await registerSchema(ctx.db, adapter);
        await applyPending(ctx.db, adapter.pluginName);

        // The schema is already current; only the version record says otherwise.
        // This is the maintainer's own server (DDL applied by hand, no ALTER
        // grant) and equally a run killed between the ALTER and the version
        // record. Every migration from K+1 must be safe to execute again.
        for (let k = 0; k < all.length; k++) {
          await setRecordedVersion(ctx.db, adapter.pluginName, k);
          const result = await applyPending(ctx.db, adapter.pluginName);
          assert.equal(
            result.applied,
            all.length - k,
            `re-apply from v${k} applied ${result.applied}, expected ${all.length - k}`
          );
          await readBackAllModels(ctx.db, `re-applied from v${k}`);
        }
      } finally {
        await closeDb(ctx);
      }
    });

    // ---- idempotence ----
    test(`[${dialect}] ${adapter.label}: a second run is a no-op`, async () => {
      if (!reachability.get(dialect)) return SKIP;
      const ctx = await openDb(dialect);
      try {
        const all = await registerSchema(ctx.db, adapter);
        const first = await applyPending(ctx.db, adapter.pluginName);
        assert.equal(first.applied, all.length);

        const second = await applyPending(ctx.db, adapter.pluginName);
        assert.equal(second.applied, 0, `second run applied ${second.applied} migrations, expected 0`);
        await readBackAllModels(ctx.db, 'second run');
      } finally {
        await closeDb(ctx);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await probeReachability();
await run();

// Remove the throwaway assembly. It is not gitignored — deliberately, so that
// one left behind by a hard crash shows up in git status rather than lurking.
cleanAssembly(ASSEMBLY_DIR);
