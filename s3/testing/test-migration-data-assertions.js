/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   MIGRATION DATA ASSERTIONS — touches.data, on real engines   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * touches.creates / touches.columns / touches.rows all answer "does this
 * thing exist". None of them answer "did the value actually get written".
 *
 * That distinction is the whole Switch v5 incident. A migration that adds a
 * column and backfills it can have the backfill do nothing — no rows matched,
 * an early return, a guard that skipped the branch — and every existence check
 * still passes, so the engine records the version and reports success.
 *
 * It matters most on exactly the servers least able to notice. A DB user with
 * no ALTER grant has its schema applied by hand, so by the time up() runs the
 * DDL is already satisfied and the data step is the only part the engine
 * actually executes. A silent no-op there is invisible by construction.
 *
 * touches.data closes that: declared post-conditions on column values, checked
 * after the migration commits AND again on every mount.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   validation     the declaration is shape-checked at registration, and a
 *                  typo'd predicate is rejected rather than silently passing
 *   post-commit    a backfill that works records the version; one that
 *                  no-ops throws and records nothing
 *   hand-migrated  column pre-applied, version rolled back, DDL branch
 *                  skipped — the state that hid the original defect
 *   drift          data lost after the fact is found on a later mount, the
 *                  version is rolled back, and the gate re-opens
 *   opt-out        an explicit empty declaration asserts nothing
 *   columns        touches.columns is verified on pre-existing tables, not
 *                  only on tables the same migration creates
 *
 * Every behavioural case runs on all three engines. Unlike the value-typing
 * defects this mechanism guards against, these must behave identically
 * everywhere — a check that only fires on one dialect is worse than none,
 * because it trains operators to distrust it.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-migration-data-assertions.js
 *
 *   # with the Docker engines (ports match test-migration-conformance.js):
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
  console.log('Migration Data Assertions  (touches.data, real engines)');
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
// Scenario plumbing
// ---------------------------------------------------------------------------

const PLUGIN = 'data-assert-fixture';
const TABLE = 'DataAssert_Rows';

async function openDb(dialect) {
  const base = DIALECTS.find((d) => d.name === dialect).opts;
  let opts = base;

  let dbName = null;
  if (dialect !== 'sqlite') {
    dbName = `s3_data_${RUN_ID}_${Math.floor(Math.random() * 100000)}`;
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
 * Define the fixture model and register it for drift detection.
 *
 * `stamped` is DATE and nullable, matching the column this whole mechanism was
 * built for: SQL permits NULL, and it is the migration's job — not the schema's
 * — to guarantee it is populated.
 */
function defineFixtureModel(db) {
  const DataTypes = db.getDataTypes();
  // timestamps: false because the migration below creates the table with
  // exactly these two columns. Sequelize's default createdAt/updatedAt would
  // otherwise show up as genuine column drift and drown out what is being
  // tested — the drift assertions here need to be about `stamped` alone.
  db.defineModel(TABLE, {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    stamped: { type: DataTypes.DATE, allowNull: true }
  }, { timestamps: false });
  db.registerExpectedVersion(PLUGIN, 2, { models: [TABLE] });
}

/** v1: create the table, seeded with rows whose `stamped` is NULL. */
function createMigration(seedCount = 3) {
  return {
    version: 1,
    description: 'create fixture table with unstamped rows',
    touches: { creates: [TABLE] },
    up: async (qi) => {
      await qi.createTable(TABLE, {
        id: { type: qi.DataTypes.STRING, primaryKey: true, allowNull: false },
        stamped: { type: qi.DataTypes.DATE, allowNull: true }
      });
      const rows = [];
      for (let i = 0; i < seedCount; i++) rows.push({ id: `row-${i}`, stamped: null });
      if (rows.length > 0) await qi.bulkInsert(TABLE, rows);
    },
    down: async (qi) => { await qi.dropTable(TABLE); }
  };
}

/**
 * v2: the migration under test.
 *
 * `guarded` reproduces the original defect — the backfill sits inside the
 * add-column branch, so a database that already has the column skips it. The
 * fixture's column is created in v1 rather than added here, which puts every
 * run in that state; what varies is whether the backfill is reachable.
 */
function backfillMigration({ backfill = true, guarded = false, data = undefined, columns = undefined } = {}) {
  return {
    version: 2,
    description: 'stamp every row',
    touches: {
      columns: columns === undefined ? { [TABLE]: ['stamped'] } : columns,
      ...(data === undefined ? {} : { data })
    },
    up: async (qi) => {
      const existing = await qi.describeTable(TABLE);
      const needsColumn = !existing.stamped;
      if (needsColumn) {
        await qi.addColumn(TABLE, 'stamped', { type: qi.DataTypes.DATE, allowNull: true });
      }
      if (!backfill) return;
      if (guarded && !needsColumn) return; // the v5 defect, exactly
      await qi.bulkUpdate(TABLE, { stamped: new Date() }, {});
    },
    down: async () => {}
  };
}

const NOT_NULL = { [TABLE]: [{ column: 'stamped', notNull: true }] };

async function applyAll(db, migrations) {
  db.migrationEngine.registerMigrations(PLUGIN, migrations);
  db.migrationEngine.confirmToken('__force__');
  return db.migrationEngine.runMigrations(PLUGIN);
}

async function recordedVersion(db) {
  const row = await db.SchemaVersionsModel.findOne({ where: { pluginName: PLUGIN } });
  return row ? row.version : 0;
}

async function countNulls(db) {
  const model = db.getModel(TABLE);
  const Op = db.sequelize.constructor.Op;
  return model.count({ where: { stamped: { [Op.is]: null } } });
}

/** Run `fn` against a mounted DBService for `dialect`, or SKIP if unreachable. */
async function onDialect(dialect, fn) {
  if (!reachability.get(dialect)) return SKIP;
  const ctx = await openDb(dialect);
  try {
    defineFixtureModel(ctx.db);
    return await fn(ctx.db, ctx);
  } finally {
    await closeDb(ctx);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Validation — dialect-independent, so SQLite only
// ═══════════════════════════════════════════════════════════════════════════

function registerOnly(db, touches) {
  db.migrationEngine.registerMigrations(`validate_${Math.random().toString(36).slice(2)}`, [
    { version: 1, description: 'validation fixture', touches, up: async () => {}, down: async () => {} }
  ]);
}

test('validation: a well-formed touches.data declaration is accepted', async () => {
  const ctx = await openDb('sqlite');
  try {
    registerOnly(ctx.db, { data: { [TABLE]: [{ column: 'stamped', notNull: true }] } });
    registerOnly(ctx.db, { data: { [TABLE]: [] } }); // explicit opt-out
  } finally {
    await closeDb(ctx);
  }
});

test('validation: an unknown predicate key is rejected, not silently ignored', async () => {
  const ctx = await openDb('sqlite');
  try {
    assert.throws(
      () => registerOnly(ctx.db, { data: { [TABLE]: [{ column: 'stamped', notNul: true }] } }),
      /unknown predicate key\(s\): notNul/,
      'a typo\'d predicate passed registration — the author would believe they were covered'
    );
  } finally {
    await closeDb(ctx);
  }
});

test('validation: an entry that asserts nothing is rejected', async () => {
  const ctx = await openDb('sqlite');
  try {
    assert.throws(
      () => registerOnly(ctx.db, { data: { [TABLE]: [{ column: 'stamped' }] } }),
      /declares no assertion/
    );
    assert.throws(
      () => registerOnly(ctx.db, { data: { [TABLE]: [{ column: 'stamped', notNull: false }] } }),
      /declares no assertion/
    );
  } finally {
    await closeDb(ctx);
  }
});

test('validation: malformed shapes are rejected', async () => {
  const ctx = await openDb('sqlite');
  try {
    assert.throws(() => registerOnly(ctx.db, { data: [] }), /must be a Record/);
    assert.throws(() => registerOnly(ctx.db, { data: { [TABLE]: 'stamped' } }), /must be an array/);
    assert.throws(() => registerOnly(ctx.db, { data: { [TABLE]: [{ notNull: true }] } }), /non-empty "column" string/);
    assert.throws(() => registerOnly(ctx.db, { data: { [TABLE]: [{ column: '', notNull: true }] } }), /non-empty "column" string/);
    assert.throws(() => registerOnly(ctx.db, { data: { [TABLE]: [{ column: 'stamped', notNull: 'yes' }] } }), /must be a boolean/);
  } finally {
    await closeDb(ctx);
  }
});

test('getExpectedData: merges declarations and drops explicit opt-outs', async () => {
  const ctx = await openDb('sqlite');
  try {
    ctx.db.migrationEngine.registerMigrations('agg_a', [
      { version: 1, description: 'a', touches: { data: { T1: [{ column: 'x', notNull: true }] } }, up: async () => {} }
    ]);
    ctx.db.migrationEngine.registerMigrations('agg_b', [
      {
        version: 1,
        description: 'b',
        touches: { data: { T1: [{ column: 'x', notNull: true }, { column: 'y', notNull: true }], T2: [] } },
        up: async () => {}
      }
    ]);

    const expected = ctx.db.migrationEngine.getExpectedData();
    assert.deepEqual(
      expected.get('T1'),
      [{ column: 'x', notNull: true }, { column: 'y', notNull: true }],
      'duplicate column declarations should merge, not accumulate'
    );
    assert.ok(!expected.has('T2'), 'an explicit empty declaration should contribute nothing to check');
  } finally {
    await closeDb(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Behaviour — every dialect
// ═══════════════════════════════════════════════════════════════════════════

for (const dialect of ['sqlite', 'mysql', 'postgres']) {
  // ---- the happy path still works ----
  test(`${dialect}: a backfill that populates the column records the version`, async () =>
    onDialect(dialect, async (db) => {
      const result = await applyAll(db, [createMigration(3), backfillMigration({ data: NOT_NULL })]);

      assert.equal(result.applied, 2, 'both migrations should have applied');
      assert.equal(await recordedVersion(db), 2, 'version should be recorded');
      assert.equal(await countNulls(db), 0, 'every row should be stamped');
      assert.deepEqual(await db.verifyLiveSchema(), [], 'a healthy database should report no drift');
    }));

  // ---- the defect this whole mechanism exists for ----
  test(`${dialect}: a backfill that matches nothing fails and records no version`, async () =>
    onDialect(dialect, async (db) => {
      await assert.rejects(
        applyAll(db, [createMigration(3), backfillMigration({ backfill: false, data: NOT_NULL })]),
        (err) => {
          assert.match(err.message, /3 row\(s\) in "DataAssert_Rows" still have NULL "stamped"/,
            `failure should name the offending count, got: ${err.message}`);
          return true;
        }
      );

      assert.equal(await recordedVersion(db), 1,
        'v2 must NOT be recorded — a version recorded for a migration that did not do its job is the whole bug');
    }));

  // ---- without the declaration, the same failure is silent ----
  // The control case. If this ever starts failing, the assertion above stopped
  // proving anything, because the run was going to fail regardless.
  test(`${dialect}: the same no-op backfill passes silently when nothing is declared`, async () =>
    onDialect(dialect, async (db) => {
      const result = await applyAll(db, [createMigration(3), backfillMigration({ backfill: false })]);

      assert.equal(result.applied, 2);
      assert.equal(await recordedVersion(db), 2, 'undeclared, this is exactly what shipped');
      assert.equal(await countNulls(db), 3, 'the rows really were left unstamped');
    }));

  // ---- the hand-migrated server: the state that hid the original defect ----
  test(`${dialect}: a guarded backfill is caught on a database that already has the column`, async () =>
    onDialect(dialect, async (db) => {
      // v1 creates the table WITH the column, so v2's add-column branch is
      // skipped — the same position a hand-migrated server arrives in.
      await assert.rejects(
        applyAll(db, [createMigration(2), backfillMigration({ guarded: true, data: NOT_NULL })]),
        /2 row\(s\) in "DataAssert_Rows" still have NULL "stamped"/,
        'the guarded backfill skipped its work and the migration still passed'
      );
      assert.equal(await recordedVersion(db), 1);
    }));

  test(`${dialect}: the guard-free backfill repairs the same database`, async () =>
    onDialect(dialect, async (db) => {
      const result = await applyAll(db, [createMigration(2), backfillMigration({ guarded: false, data: NOT_NULL })]);
      assert.equal(result.applied, 2);
      assert.equal(await countNulls(db), 0, 'the fix must repair, not merely stop failing');
    }));

  // ---- an empty table has no invariant to violate ----
  test(`${dialect}: an empty table satisfies a notNull assertion`, async () =>
    onDialect(dialect, async (db) => {
      const result = await applyAll(db, [createMigration(0), backfillMigration({ data: NOT_NULL })]);
      assert.equal(result.applied, 2, 'zero rows means zero offenders, not a failure');
      assert.equal(await recordedVersion(db), 2);
    }));

  // ---- the explicit opt-out asserts nothing ----
  test(`${dialect}: an explicit empty declaration asserts nothing`, async () =>
    onDialect(dialect, async (db) => {
      const result = await applyAll(db, [
        createMigration(3),
        backfillMigration({ backfill: false, data: { [TABLE]: [] } })
      ]);
      assert.equal(result.applied, 2);
      assert.equal(await countNulls(db), 3);
      assert.deepEqual(await db.verifyLiveSchema(), [], 'an opt-out should not surface as drift either');
    }));

  // ---- data lost after the fact is found on a later mount ----
  test(`${dialect}: data lost behind the engine's back is reported as drift`, async () =>
    onDialect(dialect, async (db) => {
      await applyAll(db, [createMigration(3), backfillMigration({ data: NOT_NULL })]);
      assert.deepEqual(await db.verifyLiveSchema(), [], 'sanity: clean before the damage');

      // A restore from an older dump, a connector switch, a hand-run UPDATE —
      // the version tracker still says v2, so nothing would re-run the migration.
      await db.getModel(TABLE).update({ stamped: null }, { where: { id: 'row-1' } });

      const drift = await db.verifyLiveSchema();
      const entry = drift.find((d) => d.dataViolations);
      assert.ok(entry, `drift should report the unpopulated column, got: ${JSON.stringify(drift)}`);
      assert.equal(entry.table, TABLE);
      assert.deepEqual(entry.dataViolations, [{ column: 'stamped', offenders: 1 }],
        'the operator needs the count, not just the fact');
    }));

  // ---- and that drift is recovery-triggering, not informational ----
  test(`${dialect}: data drift rolls the version back so the migration re-runs`, async () =>
    onDialect(dialect, async (db) => {
      await applyAll(db, [createMigration(3), backfillMigration({ data: NOT_NULL })]);
      await db.getModel(TABLE).update({ stamped: null }, { where: { id: 'row-1' } });

      const drift = await db.verifyLiveSchema();
      await db._handleDetectedDrift(drift);

      assert.equal(await recordedVersion(db), 1,
        'the version must be rolled back, or !s3 migrate force would skip the repair');
      assert.ok(db._migrationGate, 'consumer plugins should stay gated until the operator acts');
    }));

  // ---- the column check now covers pre-existing tables ----
  // touches.columns used to be verified only for tables the same migration
  // created, which meant addColumn on an existing table — the case that fails
  // on a DB user without ALTER grants — was never checked at all.
  test(`${dialect}: a declared column missing from a pre-existing table fails the migration`, async () =>
    onDialect(dialect, async (db) => {
      await assert.rejects(
        applyAll(db, [
          createMigration(1),
          {
            version: 2,
            description: 'claims a column it never adds',
            touches: { columns: { [TABLE]: ['neverAdded'] } },
            up: async () => {},
            down: async () => {}
          }
        ]),
        /Column "DataAssert_Rows\.neverAdded" missing after migration/,
        'a column declared but never added went unnoticed'
      );
      assert.equal(await recordedVersion(db), 1);
    }));

  // ---- how far back recovery has to roll ----
  // Live incident: SwitchPlugin_PlayerCooldowns had lost five columns owned by
  // switch v3 and one owned by v5. Recovery rolled back to v4, so only v5 was
  // pending; re-running it restored v5's column, drift re-fired on v3's five,
  // the version was rolled back to v4 again. `!s3 migrate force` could never
  // converge and the loop ran on every mount. `touches` already says which
  // migration owns which column, so recovery must roll back past the earliest
  // one that owns anything missing — not one version.
  test(`${dialect}: recovery rolls back past every migration owning a missing column`, () =>
    onDialect(dialect, async (db) => {
      await applyAll(db, [
        createMigration(),
        backfillMigration({}),
        {
          version: 3,
          description: 'adds a later, unrelated column',
          touches: { columns: { [TABLE]: ['extra'] } },
          up: async (qi) => {
            const existing = await qi.describeTable(TABLE);
            if (!existing.extra) {
              await qi.addColumn(TABLE, 'extra', { type: qi.DataTypes.STRING, allowNull: true });
            }
          },
          down: async () => {}
        }
      ]);
      assert.equal(await recordedVersion(db), 3);
      // The fixture declares 2; this case owns a third migration, and the whole
      // point is that expected-1 (2) and the correct target (1) differ.
      db.registerExpectedVersion(PLUGIN, 3, { models: [TABLE] });

      // Lose a column owned by v2 — not by the newest migration.
      await db.sequelize.getQueryInterface().removeColumn(TABLE, 'stamped');

      const drift = await db.verifyLiveSchema();
      assert.ok(
        drift.some((d) => (d.missing || []).includes('stamped')),
        `expected "stamped" to read as missing, got ${JSON.stringify(drift)}`
      );

      await db._handleDetectedDrift(drift);
      assert.equal(await recordedVersion(db), 1,
        'rolling back one version leaves v2 applied, so nothing ever re-adds its column');
    }));

  // ---- a repair must not re-run one-time destructive steps ----
  // Recovery re-applies an already-applied migration, which is safe only for
  // idempotent work. switch v3 ends in an unconditional truncate of the
  // cooldown table; re-running it would wipe the token balances, seed-bonus
  // progress and scramble lockdowns the repair is meant to preserve. up() has
  // to be able to tell the two situations apart.
  test(`${dialect}: up() can tell a drift repair from a first-time apply`, () =>
    onDialect(dialect, async (db) => {
      const seen = [];
      const probe = {
        version: 2,
        description: 'records how it was invoked',
        touches: { columns: { [TABLE]: ['stamped'] } },
        up: async (qi) => { seen.push(qi.isReapply); },
        down: async () => {}
      };

      await applyAll(db, [createMigration(), probe]);
      assert.deepEqual(seen, [false], 'a first-time apply must not look like a repair');

      db.migrationEngine.markDriftReapply([PLUGIN]);
      await db.SchemaVersionsModel.update({ version: 1 }, { where: { pluginName: PLUGIN } });
      db.migrationEngine.confirmToken('__force__');
      await db.migrationEngine.runMigrations(PLUGIN);
      assert.deepEqual(seen, [false, true], 'the repair pass must be distinguishable from a first apply');

      // The marker is consumed by the run it applies to. If it stuck, every
      // later migration for this plugin would skip its one-time setup forever.
      await db.SchemaVersionsModel.update({ version: 1 }, { where: { pluginName: PLUGIN } });
      db.migrationEngine.confirmToken('__force__');
      await db.migrationEngine.runMigrations(PLUGIN);
      assert.deepEqual(seen, [false, true, false], 'the repair marker must not persist past its run');
    }));
}

await run();
