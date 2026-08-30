/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   DRIFT RECOVERY — every database state, on every engine      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Drift recovery rolls a plugin's recorded version backwards so that
 * re-running its migrations restores schema that went missing. Two live
 * defects came out of one incident on a production-shaped database:
 *
 *   1. It rolled back exactly one version. SwitchPlugin_PlayerCooldowns had
 *      lost five columns owned by switch v3 and one owned by v5; rolling back
 *      to v4 made only v5 pending, so the repair restored v5's column, drift
 *      re-fired on v3's five, and the version was rolled back to v4 again.
 *      `!s3 migrate force` could never converge and the loop ran every mount.
 *
 *   2. Recovery re-applies an already-applied migration, which is only safe
 *      when up() is idempotent. switch v3 ends in an unconditional truncate of
 *      the cooldown table, so the "repair" would have destroyed every player's
 *      token balance, seed-bonus progress and scramble lockdown.
 *
 * Fixing those meant drift could also be checked while migrations are pending,
 * which is what removes the second `migrate force` an operator previously
 * needed. That is only safe if "applied then lost" can be told apart from
 * "not applied yet" — both read as a missing column. Get that wrong and every
 * routine version upgrade raises a false drift alarm and rolls versions
 * backwards, which is far worse than the bug being fixed.
 *
 * So this file walks the states a real server can actually be in — brand new,
 * legitimately behind, up to date and drifted, behind AND drifted, several
 * plugins at once — against every engine the suite supports. Identifier case
 * folding differs across those engines (MySQL's lower_case_table_names, SQLite's
 * ASCII folding), which is exactly the class of difference a fixture would hide.
 *
 * Category: 1 (real engines; MySQL/Postgres cases skip if unreachable)
 *
 * Usage: node SlackersSquadServices/testing/test-drift-recovery-matrix.js
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

import DBService from '../utils/db-service.js';

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
  console.log('Drift Recovery Matrix  (every DB state, every engine)');
  console.log('='.repeat(72));
  console.log('');

  await probeReachability();

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
// Connection config — ports match test-migration-conformance.js
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
// Fixture: one plugin, four migrations, one column added per version
// ---------------------------------------------------------------------------

const PLUGIN = 'drift-matrix-fixture';
const TABLE = 'DriftMatrix_Rows';

const OTHER_PLUGIN = 'drift-matrix-bystander';
const OTHER_TABLE = 'DriftMatrix_Bystander';

async function openDb(dialect) {
  const base = DIALECTS.find((d) => d.name === dialect).opts;
  let opts = base;

  let dbName = null;
  if (dialect !== 'sqlite') {
    dbName = `s3_drift_${RUN_ID}_${Math.floor(Math.random() * 100000)}`;
    const adminSeq = new Sequelize(base);
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
  return { db, seq, dbName, base };
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
 * The fixture model declares every column all four migrations will add, which
 * is what a deployed plugin's model looks like: the model is always "ahead" of
 * a database that has not finished migrating. timestamps:false so Sequelize's
 * createdAt/updatedAt do not register as drift of their own.
 */
function defineModel(db, expectedVersion) {
  const DataTypes = db.getDataTypes();
  db.defineModel(TABLE, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    base: { type: DataTypes.STRING, allowNull: true },
    early: { type: DataTypes.STRING, allowNull: true },
    mid: { type: DataTypes.STRING, allowNull: true },
    late: { type: DataTypes.STRING, allowNull: true }
  }, { timestamps: false });
  db.registerExpectedVersion(PLUGIN, expectedVersion, { models: [TABLE] });
}

/** v1 creates the table with `id` and `base`; v2..v4 each add one column. */
function migrationsUpTo(version) {
  const addColumn = (v, column) => ({
    version: v,
    description: `add ${column}`,
    touches: { columns: { [TABLE]: [column] } },
    up: async (qi) => {
      const existing = await qi.describeTable(TABLE);
      if (!existing[column]) {
        await qi.addColumn(TABLE, column, { type: qi.DataTypes.STRING, allowNull: true });
      }
    },
    down: async () => {}
  });

  const all = [
    {
      version: 1,
      description: 'create the table',
      touches: { creates: [TABLE] },
      up: async (qi) => {
        const existing = (await qi.showAllTables()).map((t) => String(typeof t === 'string' ? t : t.tableName).toLowerCase());
        if (!existing.includes(TABLE.toLowerCase())) {
          await qi.createTable(TABLE, {
            id: { type: qi.DataTypes.STRING, primaryKey: true, allowNull: false },
            base: { type: qi.DataTypes.STRING, allowNull: true }
          });
        }
      },
      down: async (qi) => { await qi.dropTable(TABLE); }
    },
    addColumn(2, 'early'),
    addColumn(3, 'mid'),
    addColumn(4, 'late')
  ];

  return all.filter((m) => m.version <= version);
}

/**
 * Bring a database to `appliedVersion`, then declare the plugin as expecting
 * `expectedVersion` — the state a server is in after a suite upgrade adds
 * migrations it has not run yet.
 */
async function seedTo(db, appliedVersion, expectedVersion = appliedVersion) {
  defineModel(db, expectedVersion);
  if (appliedVersion > 0) {
    db.migrationEngine.registerMigrations(PLUGIN, migrationsUpTo(appliedVersion));
    db.migrationEngine.confirmToken('__force__');
    await db.migrationEngine.runMigrations(PLUGIN);
  }
  // Register the rest so the engine knows about migrations that have not run.
  const remaining = migrationsUpTo(expectedVersion).filter((m) => m.version > appliedVersion);
  if (remaining.length > 0) db.migrationEngine.registerMigrations(PLUGIN, remaining);
  // Keep the declared expectation authoritative after the runs above.
  db.registerExpectedVersion(PLUGIN, expectedVersion, { models: [TABLE] });
}

async function recordedVersion(db, plugin = PLUGIN) {
  const row = await db.SchemaVersionsModel.findOne({ where: { pluginName: plugin } });
  return row ? row.version : 0;
}

async function dropColumn(db, column) {
  await db.sequelize.getQueryInterface().removeColumn(TABLE, column);
}

/** Raw drift narrowed the way the startup check narrows it. */
async function realDrift(db) {
  return db.filterDriftToApplied(await db.verifyLiveSchema());
}

function missingColumnsFor(drift, plugin = PLUGIN) {
  const columns = [];
  for (const entry of drift) {
    if (entry.pluginName !== plugin) continue;
    for (const column of entry.missing || []) columns.push(column);
  }
  return columns.sort();
}

async function onDialect(dialect, fn) {
  if (!reachability.get(dialect)) return SKIP;
  const ctx = await openDb(dialect);
  try {
    return await fn(ctx.db);
  } finally {
    await closeDb(ctx);
  }
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

for (const dialect of ['sqlite', 'mysql', 'postgres']) {
  // ---- state: brand-new install, nothing applied ----
  // Every column of every table is "missing" because the table does not exist.
  // Treating that as drift would roll a fresh server's versions to 0 and post a
  // drift alarm on first boot, before it has ever migrated.
  test(`${dialect}: a brand-new database reports no drift`, () =>
    onDialect(dialect, async (db) => {
      defineModel(db, 4);
      db.migrationEngine.registerMigrations(PLUGIN, migrationsUpTo(4));

      const raw = await db.verifyLiveSchema();
      assert.ok(raw.length > 0, 'the raw check should see the un-created table');
      assert.deepEqual(await realDrift(db), [],
        'nothing has ever been applied, so nothing can have drifted');
    }));

  // ---- state: legitimately behind ----
  // The routine upgrade case: new migrations exist, their columns are correctly
  // absent. A false alarm here would fire on every release.
  test(`${dialect}: a database behind on migrations reports no drift`, () =>
    onDialect(dialect, async (db) => {
      await seedTo(db, 2, 4);
      assert.equal(await recordedVersion(db), 2);

      const raw = await db.verifyLiveSchema();
      assert.ok(
        raw.some((e) => (e.missing || []).includes('mid')),
        'the raw check should see the un-applied columns'
      );
      assert.deepEqual(await realDrift(db), [],
        'columns owned by migrations that have not run are not drift');
    }));

  // ---- state: up to date, then a column is lost ----
  test(`${dialect}: a fully-migrated database reports a lost column as drift`, () =>
    onDialect(dialect, async (db) => {
      await seedTo(db, 4);
      await dropColumn(db, 'early');

      assert.deepEqual(missingColumnsFor(await realDrift(db)), ['early']);
      assert.equal(db._rollbackTargetForDrift(PLUGIN, await realDrift(db)), 1,
        'v2 owns `early`, so recovery must roll back below v2');
    }));

  // ---- state: behind AND drifted, the two-pass case ----
  // This is the shape the live incident had. The repair target must be driven
  // by the LOST column, while the merely-pending column is left alone.
  test(`${dialect}: a database both behind and drifted separates the two`, () =>
    onDialect(dialect, async (db) => {
      await seedTo(db, 3, 4);
      await dropColumn(db, 'early');

      const drift = await realDrift(db);
      assert.deepEqual(missingColumnsFor(drift), ['early'],
        '`late` belongs to un-applied v4 and must not be reported as drift');

      assert.equal(db._rollbackTargetForDrift(PLUGIN, drift), 1,
        'the target comes from v2 (which owns the lost column), not from v4');
    }));

  // ---- and that state repairs in a single run ----
  test(`${dialect}: behind-and-drifted repairs in one migration run`, () =>
    onDialect(dialect, async (db) => {
      await seedTo(db, 3, 4);
      await dropColumn(db, 'early');

      await db._handleDetectedDrift(await realDrift(db));
      assert.equal(await recordedVersion(db), 1, 'recovery should roll back below v2');

      db.migrationEngine.confirmToken('__force__');
      await db.migrationEngine.runMigrations(PLUGIN);

      assert.equal(await recordedVersion(db), 4, 'one run should carry it all the way to expected');
      assert.deepEqual(await realDrift(db), [], 'and leave no drift behind');
    }));

  // ---- state: a column no migration declares ----
  // Columns created inline by createTable are covered by touches.creates, not
  // touches.columns, so nothing attributes them to a version. Losing one must
  // still be treated as drift rather than silently ignored.
  test(`${dialect}: losing an undeclared column is still drift`, () =>
    onDialect(dialect, async (db) => {
      await seedTo(db, 4);
      await dropColumn(db, 'base');

      assert.deepEqual(missingColumnsFor(await realDrift(db)), ['base'],
        'an unattributable column must fail safe as drift');
    }));

  // ---- state: several plugins, only one drifted ----
  // Recovery rewrites the pending list. If it replaced it, a plugin with an
  // ordinary pending migration would silently drop out of the prompt and never
  // be migrated.
  test(`${dialect}: recovery keeps other plugins' pending migrations`, () =>
    onDialect(dialect, async (db) => {
      await seedTo(db, 4);
      await dropColumn(db, 'early');

      db._pendingMigrations = [
        { pluginName: OTHER_PLUGIN, currentVersion: 0, expectedVersion: 1, behind: 1 }
      ];
      await db._handleDetectedDrift(await realDrift(db));

      const names = db._pendingMigrations.map((p) => p.pluginName).sort();
      assert.deepEqual(names, [OTHER_PLUGIN, PLUGIN].sort(),
        'the bystander plugin must survive the drift rewrite');
      const own = db._pendingMigrations.find((p) => p.pluginName === PLUGIN);
      assert.equal(own.currentVersion, 1);
      assert.equal(own.expectedVersion, 4);
      assert.equal(own.behind, 3, 'the prompt should show the full range to re-apply');
    }));

  // ---- state: a plugin present in the registry but never installed ----
  test(`${dialect}: a never-installed plugin is never rolled back`, () =>
    onDialect(dialect, async (db) => {
      const DataTypes = db.getDataTypes();
      db.defineModel(OTHER_TABLE, {
        id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
        never: { type: DataTypes.STRING, allowNull: true }
      }, { timestamps: false });
      db.registerExpectedVersion(OTHER_PLUGIN, 1, { models: [OTHER_TABLE] });

      await seedTo(db, 4);
      await dropColumn(db, 'early');

      const drift = await realDrift(db);
      assert.ok(
        drift.every((e) => e.pluginName !== OTHER_PLUGIN),
        'a plugin with no recorded version must not appear in drift'
      );
      assert.equal(await recordedVersion(db, OTHER_PLUGIN), 0);
    }));

  // ---- repeated recovery converges instead of looping ----
  // The original defect was not that a single pass failed, but that passes
  // repeated forever. Two consecutive cycles must reach a clean state.
  test(`${dialect}: repeated recovery cycles converge`, () =>
    onDialect(dialect, async (db) => {
      await seedTo(db, 4);

      for (let cycle = 0; cycle < 2; cycle++) {
        await dropColumn(db, 'early');
        const drift = await realDrift(db);
        assert.deepEqual(missingColumnsFor(drift), ['early'], `cycle ${cycle}: drift should be seen`);

        await db._handleDetectedDrift(drift);
        db.migrationEngine.confirmToken('__force__');
        await db.migrationEngine.runMigrations(PLUGIN);

        assert.equal(await recordedVersion(db), 4, `cycle ${cycle}: should end fully migrated`);
        assert.deepEqual(await realDrift(db), [], `cycle ${cycle}: should end clean`);
      }
    }));
}

await run();
