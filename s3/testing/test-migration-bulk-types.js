/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   MIGRATION BULK OPERATIONS — TYPED VALUES / NULL BACKFILLS   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Regression cover for the Switch v5 backfill defect (2026-08-18), where the
 * migration engine's query-interface wrapper had no bulkUpdate at all and the
 * raw Sequelize call it was replaced with wrote a JS Date to SQLite as an
 * integer epoch. Every later read of those rows died with
 * "date.includes is not a function" — a failure that only SQLite produces,
 * because MySQL and Postgres escape a Date to a datetime literal regardless of
 * whether attribute types were supplied.
 *
 * As with test-dialect-portability.js, every case runs against a REAL engine.
 * A mock models neither SQLite's typeless columns nor `IS NULL` semantics, so
 * a mock would have passed throughout the entire lifetime of this bug.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   1. qi.bulkUpdate  — DATE round-trips as a Date, not an epoch integer.
 *   2. qi.bulkInsert  — same, on the insert path.
 *   3. Op.is null     — a backfill WHERE actually matches NULL rows (the
 *                       `= NULL` trap that silently matches nothing).
 *   4. Idempotence    — re-running a backfill leaves already-stamped rows
 *                       alone, which is what makes `!s3 migrate force` safe on
 *                       a hand-migrated database.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-migration-bulk-types.js
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
import { Sequelize, DataTypes, Op } from 'sequelize';

import DBService from '../utils/db-service.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(72));
  console.log('Migration Bulk Operation Tests  (sqlite / mysql / postgres)');
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

const SKIP = Symbol('skip');

// ---------------------------------------------------------------------------
// Connection config — ports match test-dialect-portability.js
// ---------------------------------------------------------------------------

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

/** Unique-ish suffix so reruns never collide on a shared engine. */
const RUN_ID = `${process.pid}_${Date.now() % 100000}`;

/**
 * Mount a DBService against one dialect, define a Switch-shaped cooldowns
 * table, and run `fn(ctx)` with the migration engine wired up.
 * Returns SKIP when the engine is unreachable, so an absent Docker container
 * reports a skip rather than a false pass.
 */
async function withEngine(dialect, label, fn) {
  if (!reachability.get(dialect)) return SKIP;
  const opts = DIALECTS.find((d) => d.name === dialect).opts;
  const seq = new Sequelize(opts);
  const db = new DBService({
    sequelize: seq,
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();

  const tableName = `T_BulkTypes_${label}_${RUN_ID}`;
  const model = db.defineModel(tableName, {
    eosID: { type: DataTypes.STRING(64), primaryKey: true },
    playerName: { type: DataTypes.STRING(255) },
    lastActiveTimestamp: { type: DataTypes.DATE, allowNull: true }
  }, { tableName, freezeTableName: true, timestamps: false });
  await model.sync({ force: true });

  try {
    return await fn({ db, seq, model, tableName });
  } finally {
    try { await model.drop(); } catch { /* best effort */ }
    try { await db.unmount(); } catch { /* best effort */ }
    try { await seq.close(); } catch { /* best effort */ }
  }
}

/**
 * Run `body(qi)` as a real migration so the wrapper under test is the exact
 * object migrations receive — not a hand-built stand-in.
 */
async function asMigration(db, pluginName, body) {
  db.migrationEngine.registerMigrations(pluginName, [
    {
      version: 1,
      description: 'bulk type regression case',
      // Data-only — the table is created by the fixture, so nothing schema-shaped
      // to declare. The engine rejects a migration with no touches at all.
      touches: {},
      up: body,
      down: async () => {}
    }
  ]);
  db.migrationEngine.confirmToken('__force__');
  return db.migrationEngine.runMigrations(pluginName);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. bulkUpdate — DATE values survive the round trip
// ═══════════════════════════════════════════════════════════════════════════

for (const dialect of ['sqlite', 'mysql', 'postgres']) {
  test(`[${dialect}] qi.bulkUpdate writes a DATE that reads back as a Date`, async () =>
    withEngine(dialect, 'upd', async ({ db, model, tableName }) => {
      await model.bulkCreate([
        { eosID: 'a', playerName: 'A', lastActiveTimestamp: null },
        { eosID: 'b', playerName: 'B', lastActiveTimestamp: null }
      ]);

      const stamp = new Date('2026-08-18T21:36:00Z');
      const result = await asMigration(db, `bulkupd_${dialect}_${RUN_ID}`, async (qi) => {
        await qi.bulkUpdate(tableName, { lastActiveTimestamp: stamp }, {});
      });
      assert.equal(result.applied, 1, 'migration did not apply');

      // The original defect: on SQLite the value landed as an integer epoch and
      // this findAll threw "date.includes is not a function" during parsing.
      const rows = await model.findAll({ order: [['eosID', 'ASC']] });
      for (const row of rows) {
        assert.ok(
          row.lastActiveTimestamp instanceof Date,
          `${row.eosID}: expected a Date, got ${typeof row.lastActiveTimestamp}`
        );
        assert.equal(
          row.lastActiveTimestamp.getTime(),
          stamp.getTime(),
          `${row.eosID}: timestamp value does not round-trip`
        );
      }
    }));
}

test('[sqlite] bulkUpdate stores DATE as TEXT, not an epoch integer', async () =>
  withEngine('sqlite', 'sqltype', async ({ db, model, tableName, seq }) => {
    await model.create({ eosID: 'a', playerName: 'A', lastActiveTimestamp: null });
    await asMigration(db, `sqltype_${RUN_ID}`, async (qi) => {
      await qi.bulkUpdate(tableName, { lastActiveTimestamp: new Date() }, {});
    });

    // typeof() is the direct evidence: SQLite columns are typeless, so a
    // mis-serialized Date is stored as 'integer' and only fails on read.
    const [{ t }] = await seq.query(
      `SELECT typeof(lastActiveTimestamp) AS t FROM ${tableName} WHERE eosID = 'a'`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    assert.equal(t, 'text', `expected TEXT storage, got ${t}`);
  }));

// ═══════════════════════════════════════════════════════════════════════════
// 2. bulkInsert — same typing guarantee on the insert path
// ═══════════════════════════════════════════════════════════════════════════

for (const dialect of ['sqlite', 'mysql', 'postgres']) {
  test(`[${dialect}] qi.bulkInsert writes a DATE that reads back as a Date`, async () =>
    withEngine(dialect, 'ins', async ({ db, model, tableName }) => {
      const stamp = new Date('2026-08-18T21:36:00Z');
      await asMigration(db, `bulkins_${dialect}_${RUN_ID}`, async (qi) => {
        await qi.bulkInsert(tableName, [
          { eosID: 'seed', playerName: 'Seed', lastActiveTimestamp: stamp }
        ]);
      });

      const row = await model.findByPk('seed');
      assert.ok(row, 'seed row was not inserted');
      assert.ok(
        row.lastActiveTimestamp instanceof Date,
        `expected a Date, got ${typeof row.lastActiveTimestamp}`
      );
      assert.equal(row.lastActiveTimestamp.getTime(), stamp.getTime());
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 2b. WHERE values are typed too — the other half of the same trap
// ═══════════════════════════════════════════════════════════════════════════

for (const dialect of ['sqlite', 'mysql', 'postgres']) {
  test(`[${dialect}] qi.bulkUpdate matches a DATE in the WHERE clause`, async () =>
    withEngine(dialect, 'wh', async ({ db, model, tableName }) => {
      // Typing the SET values is not enough: Sequelize types WHERE values from
      // options.model, and without it this UPDATE matches ZERO rows on SQLite
      // while reporting success — a silent no-op migration, which is worse than
      // a loud failure. Verified against the unfixed wrapper before this landed.
      const stamp = new Date('2021-03-04T05:06:07Z');
      await model.bulkCreate([
        { eosID: 'x', playerName: 'X', lastActiveTimestamp: stamp },
        { eosID: 'y', playerName: 'Y', lastActiveTimestamp: null }
      ]);

      await asMigration(db, `where_${dialect}_${RUN_ID}`, async (qi) => {
        await qi.bulkUpdate(tableName, { playerName: 'MATCHED' }, { lastActiveTimestamp: stamp });
      });

      const hit = await model.findByPk('x');
      assert.equal(hit.playerName, 'MATCHED', 'WHERE on a DATE column matched nothing');

      const miss = await model.findByPk('y');
      assert.equal(miss.playerName, 'Y', 'WHERE on a DATE column matched too much');
    }));
}

for (const dialect of ['sqlite', 'mysql', 'postgres']) {
  test(`[${dialect}] qi.bulkDelete matches a DATE in the WHERE clause`, async () =>
    withEngine(dialect, 'del', async ({ db, model, tableName }) => {
      const stamp = new Date('2021-03-04T05:06:07Z');
      await model.bulkCreate([
        { eosID: 'gone', playerName: 'G', lastActiveTimestamp: stamp },
        { eosID: 'kept', playerName: 'K', lastActiveTimestamp: null }
      ]);

      await asMigration(db, `del_${dialect}_${RUN_ID}`, async (qi) => {
        await qi.bulkDelete(tableName, { lastActiveTimestamp: stamp });
      });

      assert.equal(await model.findByPk('gone'), null, 'DELETE on a DATE column removed nothing');
      assert.ok(await model.findByPk('kept'), 'DELETE on a DATE column removed too much');
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Op.is null — a backfill WHERE that actually matches NULL rows
// ═══════════════════════════════════════════════════════════════════════════

for (const dialect of ['sqlite', 'mysql', 'postgres']) {
  test(`[${dialect}] backfill matches NULL rows and leaves stamped rows alone`, async () =>
    withEngine(dialect, 'null', async ({ db, model, tableName }) => {
      // Mirrors Switch migration v5 on a hand-migrated database: the column is
      // already present (DDL applied by hand because the DB user has no ALTER
      // grant), every row is NULL, and one row has since been stamped by live
      // gameplay. Re-running must fill the NULLs without resetting the rest.
      const keep = new Date('2020-01-02T03:04:05Z');
      await model.bulkCreate([
        { eosID: 'n1', playerName: 'N1', lastActiveTimestamp: null },
        { eosID: 'n2', playerName: 'N2', lastActiveTimestamp: null },
        { eosID: 'stamped', playerName: 'S', lastActiveTimestamp: keep }
      ]);

      const backfill = new Date('2026-08-18T21:36:00Z');
      await asMigration(db, `nullfill_${dialect}_${RUN_ID}`, async (qi) => {
        await qi.bulkUpdate(
          tableName,
          { lastActiveTimestamp: backfill },
          { lastActiveTimestamp: { [Op.is]: null } }
        );
      });

      const rows = await model.findAll({ order: [['eosID', 'ASC']] });
      const stillNull = rows.filter((r) => r.lastActiveTimestamp === null);
      assert.equal(
        stillNull.length,
        0,
        `IS NULL matched nothing — rows left unstamped: ${stillNull.map((r) => r.eosID).join(', ')}`
      );

      const stamped = rows.find((r) => r.eosID === 'stamped');
      assert.equal(
        stamped.lastActiveTimestamp.getTime(),
        keep.getTime(),
        'a row that already had a timestamp was overwritten — backfill is not idempotent'
      );
    }));
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await probeReachability();
await run();
