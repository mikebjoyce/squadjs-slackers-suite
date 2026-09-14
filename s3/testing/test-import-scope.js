/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      IMPORT SCOPING — WHOSE ROWS AN IMPORT IS ALLOWED TO TOUCH ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * An import into a shared database can go wrong in ways a successful-looking
 * result never shows. `model.upsert()` matches on the primary key, and for
 * every table keyed on an autoincrement `id` that key says nothing about which
 * server a row belongs to — so an envelope taken from a pre-multi-server
 * database addresses ids that now belong to a sibling, and each one is a
 * silent replacement of a row somebody else is still using.
 *
 * This file pins the rules that stop that, and pins them against real engines
 * because two of them are engine behaviour rather than logic: the overwrite
 * probe is a query, and the foreign-key suppression is a session variable.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   the default        A sibling's rows are skipped, and the skip is reported
 *                      with the server they belong to rather than swallowed.
 *   the legacy rule    A row carrying no server id is ADOPTED by the importing
 *                      server, whatever the flags say. Filtering on "serverID
 *                      matches me" would import zero rows from every
 *                      pre-multi-server backup while reporting success per
 *                      table — and that backup is the most likely thing
 *                      anyone ever restores.
 *   --all-servers      Foreign rows are written back to the server they name.
 *   --remap-server     Foreign rows are claimed for this server instead. Both
 *                      together is a contradiction and is refused.
 *   the overwrite      How many existing rows share a key with the envelope,
 *   count              and which servers those rows currently belong to. This
 *                      is the number the confirmation is really about.
 *   the undeclared     A model whose scope was never declared is refused on a
 *                      scoped import rather than written blind.
 *   the dry run        Predicts the real run exactly, because both read the
 *                      same plan rather than each deciding the rules.
 *   FK suppression     `SET FOREIGN_KEY_CHECKS = 0` and
 *                      `session_replication_role = replica` are SESSION
 *                      variables. Issued through a pool they can miss the
 *                      writes and outlive the import, poisoning ordinary
 *                      gameplay writes for the life of the process. Checked
 *                      with a pool of exactly one connection, which is the
 *                      only way to be sure the one that was changed is the
 *                      one being read back.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-import-scope.js
 *
 *   # with the Docker engines (ports match test-dialect-portability.js):
 *   docker run -d --name s3-test-postgres -e POSTGRES_PASSWORD=postgres \
 *     -p 5433:5432 postgres:16-alpine
 *   docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -p 3307:3306 mysql:8
 *
 * Category: 1 (SQLite always; MySQL/Postgres auto-skip)
 * Run:    node s3/testing/test-import-scope.js
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

import DBService from '../utils/db-service.js';
import { importFromJSON, planImport } from '../utils/s3-export-import.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const SKIP = Symbol('skip');

async function test(name, fn) {
  try {
    const result = await fn();
    if (result === SKIP) {
      skipped += 1;
      console.log(`  ⊘ ${name} — engine unreachable`);
      return;
    }
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE_TABLES = ['s3imp_rows', 's3imp_keyed', 's3imp_global', 's3imp_undeclared'];

async function defineFixtures(db) {
  const rows = db.defineModel('ImpRows', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    serverID: { type: DataTypes.INTEGER, allowNull: true },
    note: { type: DataTypes.STRING(32) }
  }, { tableName: 's3imp_rows', timestamps: false, exportTier: 'historical', scopeKind: 'server-column' });

  const keyed = db.defineModel('ImpKeyed', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    note: { type: DataTypes.STRING(32) }
  }, { tableName: 's3imp_keyed', timestamps: false, exportTier: 'historical', scopeKind: 'server-key' });

  const global_ = db.defineModel('ImpGlobal', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    note: { type: DataTypes.STRING(32) }
  }, { tableName: 's3imp_global', timestamps: false, exportTier: 'historical', scopeKind: 'global' });

  const undeclared = db.defineModel('ImpUndeclared', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    serverID: { type: DataTypes.INTEGER, allowNull: true },
    note: { type: DataTypes.STRING(32) }
  }, { tableName: 's3imp_undeclared', timestamps: false, exportTier: 'historical' });

  for (const model of [rows, keyed, global_, undeclared]) await model.sync();
  return { rows, keyed, global_, undeclared };
}

/**
 * A mounted DBService on one dialect with the fixture tables present.
 *
 * `pool: { max: 1 }` is not tidiness — it is what makes the foreign-key case
 * meaningful. With one connection in the pool, a session variable left behind
 * by the import is guaranteed to be the one the next query reads.
 */
async function withFixtures(name, fn) {
  if (!reachability.get(name)) return SKIP;
  const opts = DIALECTS.find((d) => d.name === name).opts;
  const seq = new Sequelize({ ...opts, define: { freezeTableName: true }, pool: { max: 1, min: 0, idle: 10000 } });
  const db = new DBService({
    sequelize: seq,
    serverID: 1,
    verboseLogger: () => {},
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();
  try {
    for (const table of FIXTURE_TABLES) {
      try { await seq.getQueryInterface().dropTable(table); } catch { /* first run */ }
    }
    const models = await defineFixtures(db);
    return await fn(db, models, seq);
  } finally {
    for (const table of FIXTURE_TABLES) {
      try { await seq.getQueryInterface().dropTable(table); } catch { /* best effort */ }
    }
    try { await db.unmount(); } catch { /* best effort */ }
    try { await seq.close(); } catch { /* best effort */ }
  }
}

/** An envelope in the shape exportToJSON() writes, built by hand. */
function envelope(tables) {
  return { s3ExportVersion: 1, exportedAt: Date.now(), connector: 'test', tables };
}

const MIXED_ROWS = [
  { id: 1, serverID: 1, note: 'mine-a' },
  { id: 2, serverID: 1, note: 'mine-b' },
  { id: 3, serverID: 2, note: 'theirs-a' },
  { id: 4, serverID: 2, note: 'theirs-b' },
  { id: 5, serverID: null, note: 'legacy' }
];

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

console.log('\n──────────────────────────────────────────────────────────────────────');
console.log('  Import scoping');
console.log('──────────────────────────────────────────────────────────────────────\n');

await probeReachability();

for (const { name } of DIALECTS) {
  console.log(`── ${name} ──`);

  await test(`[${name}] the default writes this server's rows and skips a sibling's`, async () =>
    withFixtures(name, async (db, models) => {
      const result = await importFromJSON(db, envelope({ ImpRows: MIXED_ROWS }));

      const stored = await models.rows.findAll({ raw: true, order: [['id', 'ASC']] });
      assert.deepEqual(stored.map((r) => r.id), [1, 2, 5], 'only this server\'s rows and the unattributed one');

      const entry = result.imported.ImpRows;
      assert.equal(entry.status, 'ok');
      assert.equal(entry.rows, 3);
      assert.equal(entry.skippedRows, 2, 'and the skip is reported rather than swallowed');
      assert.deepEqual(entry.skippedServerIDs, [2], 'named by the server they belong to');

      // And again at the top level, which is what the confirmation renders —
      // the per-table list could be right while the summary named nobody.
      assert.deepEqual(result.plan.skippedServerIDs, [2]);
      assert.equal(result.plan.totals.skip, 2);
    }));

  await test(`[${name}] a row carrying no server id is adopted, not skipped`, async () =>
    withFixtures(name, async (db, models) => {
      const result = await importFromJSON(db, envelope({ ImpRows: MIXED_ROWS }));

      const legacy = await models.rows.findOne({ raw: true, where: { id: 5 } });
      assert.ok(legacy, 'the unattributed row must land');
      assert.equal(legacy.serverID, 1, 'stamped with the importing server');
      assert.equal(result.imported.ImpRows.stamped, 1, 'and counted, so the operator sees the adoption');
    }));

  await test(`[${name}] --all-servers writes foreign rows back to the server they name`, async () =>
    withFixtures(name, async (db, models) => {
      const result = await importFromJSON(db, envelope({ ImpRows: MIXED_ROWS }), { allServers: true });

      const stored = await models.rows.findAll({ raw: true, order: [['id', 'ASC']] });
      assert.equal(stored.length, 5, 'every row lands');
      assert.equal(stored.find((r) => r.id === 3).serverID, 2, 'and keeps the server it named');
      assert.equal(result.imported.ImpRows.foreign, 2);
      assert.equal(result.imported.ImpRows.skippedRows, undefined, 'nothing is skipped');
    }));

  await test(`[${name}] --remap-server claims foreign rows for this server`, async () =>
    withFixtures(name, async (db, models) => {
      const result = await importFromJSON(db, envelope({ ImpRows: MIXED_ROWS }), { remapServer: true });

      const stored = await models.rows.findAll({ raw: true });
      assert.equal(stored.length, 5);
      assert.deepEqual(
        [...new Set(stored.map((r) => r.serverID))], [1],
        'every row now belongs to the importing server'
      );
      assert.equal(result.imported.ImpRows.remapped, 2);
    }));

  await test(`[${name}] the two widening flags together are refused`, async () =>
    withFixtures(name, async (db, models) => {
      const result = await importFromJSON(db, envelope({ ImpRows: MIXED_ROWS }), { allServers: true, remapServer: true });

      assert.deepEqual(result.imported, {}, 'nothing is planned');
      assert.equal(result.errors.length, 1);
      assert.equal(await models.rows.count(), 0, 'and nothing is written');
    }));

  await test(`[${name}] a server-key model is narrowed by its primary key`, async () =>
    withFixtures(name, async (db, models) => {
      await importFromJSON(db, envelope({
        ImpKeyed: [{ id: 1, note: 'my-state' }, { id: 2, note: 'their-state' }]
      }));

      const stored = await models.keyed.findAll({ raw: true });
      assert.deepEqual(stored.map((r) => r.id), [1], 'the sibling\'s live state is not restored onto this server');
    }));

  await test(`[${name}] a global table is written whole`, async () =>
    withFixtures(name, async (db, models) => {
      const result = await importFromJSON(db, envelope({
        ImpGlobal: [{ id: 1, note: 'g1' }, { id: 2, note: 'g2' }]
      }));

      assert.equal(await models.global_.count(), 2, 'there is no per-server subset of a community-wide table');
      assert.equal(result.imported.ImpGlobal.skippedRows, undefined);
    }));

  await test(`[${name}] the overwrite count names the servers whose rows are at risk`, async () =>
    withFixtures(name, async (db, models) => {
      // The shape the plan is really about: an envelope from a pre-multi-server
      // database, whose autoincrement ids now belong to whoever happened to get
      // them. Every one of these upserts replaces a row already in use.
      await models.rows.bulkCreate([
        { id: 1, serverID: 2, note: 'theirs' },
        { id: 2, serverID: 2, note: 'theirs' },
        { id: 3, serverID: 1, note: 'mine' }
      ]);

      const plan = await planImport(db, envelope({
        ImpRows: [
          { id: 1, serverID: 1, note: 'incoming' },
          { id: 2, serverID: 1, note: 'incoming' },
          { id: 3, serverID: 1, note: 'incoming' },
          { id: 9, serverID: 1, note: 'new' }
        ]
      }));

      assert.equal(plan.tables.ImpRows.overwrite, 3, 'three keys already exist');
      assert.deepEqual(
        plan.tables.ImpRows.overwriteServerIDs, [1, 2],
        'and two of them are somebody else\'s — a count alone would not have said so'
      );
      assert.deepEqual(plan.overwrittenServerIDs, [1, 2]);
      assert.equal(plan.totals.overwrite, 3);
    }));

  await test(`[${name}] the overwrite probe follows a remap rather than the envelope`, async () =>
    withFixtures(name, async (db, models) => {
      // For a server-key model the remap changes the very column the match is
      // made on, so probing the envelope's own values would count the wrong row.
      await models.keyed.bulkCreate([{ id: 1, note: 'mine' }]);

      const plan = await planImport(db, envelope({ ImpKeyed: [{ id: 2, note: 'theirs' }] }), { remapServer: true });

      assert.equal(plan.tables.ImpKeyed.remap, 1);
      assert.equal(plan.tables.ImpKeyed.overwrite, 1, 'remapped onto id 1, which exists');
    }));

  await test(`[${name}] a model whose scope was never declared is refused, not written blind`, async () =>
    withFixtures(name, async (db, models) => {
      const result = await importFromJSON(db, envelope({
        ImpUndeclared: [{ id: 1, serverID: 1, note: 'x' }]
      }));

      assert.equal(result.imported.ImpUndeclared.status, 'error');
      assert.match(result.imported.ImpUndeclared.error, /scopeKind/);
      assert.equal(await models.undeclared.count(), 0);
    }));

  await test(`[${name}] an envelope key no model answers to is reported loudly`, async () =>
    withFixtures(name, async (db) => {
      const result = await importFromJSON(db, envelope({ NotAModelAnyone_Has: [{ id: 1 }, { id: 2 }] }));

      const entry = result.imported.NotAModelAnyone_Has;
      assert.equal(entry.status, 'error', 'not a warning buried beside a list of ticks');
      assert.match(entry.error, /2 row/, 'and it says how much went unwritten');
    }));

  await test(`[${name}] a dry run predicts the real run exactly`, async () =>
    withFixtures(name, async (db, models) => {
      const env = envelope({ ImpRows: MIXED_ROWS });
      const dry = await importFromJSON(db, env, { dryRun: true });
      assert.equal(await models.rows.count(), 0, 'a dry run writes nothing');

      const real = await importFromJSON(db, env);

      for (const key of ['rows', 'stamped', 'skippedRows']) {
        assert.equal(
          dry.imported.ImpRows[key], real.imported.ImpRows[key],
          `the dry run and the real run disagree about ${key}`
        );
      }
    }));

  await test(`[${name}] foreign-key suppression does not outlive the import`, async () =>
    withFixtures(name, async (db, models, seq) => {
      await importFromJSON(db, envelope({ ImpRows: MIXED_ROWS }));
      assert.equal(await models.rows.count(), 3, 'the import must actually have written');

      // One connection in the pool, so this reads back the same session the
      // import changed. MySQL does not reset session variables when a
      // connection is released, and Postgres does not either — a suppression
      // issued outside the writes' own transaction survives into whatever
      // borrows the connection next.
      if (name === 'mysql') {
        const [rows] = await seq.query('SELECT @@SESSION.foreign_key_checks AS v');
        assert.equal(Number(rows[0].v), 1, 'FOREIGN_KEY_CHECKS was left disabled on a pooled connection');
      } else if (name === 'postgres') {
        // `current_setting()` rather than `SHOW`: Sequelize hands back a bare
        // row array for SHOW and the usual [rows, meta] tuple for a SELECT, and
        // a test that destructures the wrong one fails for a reason that has
        // nothing to do with foreign keys.
        const [rows] = await seq.query("SELECT current_setting('session_replication_role') AS v");
        assert.equal(rows[0].v, 'origin', 'session_replication_role was left as replica');
      }
    }));

  console.log('');
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('──────────────────────────────────────────────────────────────────────');
console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
console.log('──────────────────────────────────────────────────────────────────────\n');

process.exit(failed === 0 ? 0 : 1);
