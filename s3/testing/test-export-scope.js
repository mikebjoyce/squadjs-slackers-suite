/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      EXPORT SCOPING — WHOSE ROWS ARE IN THE FILE               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Once two servers share a database, `!s3 db export` has to answer a question
 * it never had before: whose rows. The answer comes from one declaration —
 * `defineModel(name, schema, { scopeKind })` — turned into a WHERE clause by
 * `DBService.scopePredicateFor()`, and this file is the proof that the
 * declaration and the clause agree on every engine the suite supports.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   the predicate       Each of the three scope kinds resolves to the clause
 *                       it should: the declared column, the primary key, or
 *                       nothing at all. An undeclared model throws rather than
 *                       answering, because a wrong answer here is an export
 *                       that quietly contains somebody else's rows.
 *   the column that     A `server-column` model whose table does not have the
 *   is not there yet    column yet resolves to no predicate. The scope kinds
 *                       are declared ahead of the migrations that add the
 *                       columns, so this state is ordinary, not broken.
 *   server-key          `S3_GameState` and `TeamBalancerState` carry the
 *                       server in the PRIMARY KEY. An attribute check reads
 *                       both as community-wide and exports two servers' live
 *                       round state into a file labelled as one server's.
 *   the cursor clash    The streaming exporter pages with `WHERE pk > :last`.
 *                       For a server-key model that is the SAME column the
 *                       scope predicate names, so the two clauses are combined
 *                       under Op.and — merged into one object, whichever was
 *                       written first silently disappears and the export
 *                       contains every server after all.
 *   the envelope        `serverID`, `scope` and `containedServerIDs` say who
 *                       took the file and what is actually in it, and the last
 *                       of those is read off the rows rather than assumed.
 *   legacy rows         A NULL serverID contributes no entry to
 *                       `containedServerIDs`. It names no server, and the
 *                       import side already has a rule for those rows.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-export-scope.js
 *
 *   # with the Docker engines (ports match test-dialect-portability.js):
 *   docker run -d --name s3-test-postgres -e POSTGRES_PASSWORD=postgres \
 *     -p 5433:5432 postgres:16-alpine
 *   docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -p 3307:3306 mysql:8
 *
 * Category: 1 (SQLite always; MySQL/Postgres auto-skip)
 * Run:    node s3/testing/test-export-scope.js
 */

'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sequelize, DataTypes } from 'sequelize';

import DBService from '../utils/db-service.js';
import { exportToJSON, exportToFile } from '../utils/s3-export-import.js';

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
// Fixture: one model per scope shape, on a real engine
// ---------------------------------------------------------------------------

/**
 * The five shapes the exporter has to tell apart.
 *
 * `Legacy` is the awkward one and the reason it is here: it DECLARES a
 * server-column scope and its table has no such column, which is what every
 * table looks like between the classification landing and the migration that
 * adds the column.
 */
const FIXTURE_MODELS = ['ScopeTestRows', 'ScopeTestLegacy', 'ScopeTestKeyed', 'ScopeTestGlobal', 'ScopeTestUndeclared'];

const FIXTURE_TABLES = ['s3test_rows', 's3test_legacy', 's3test_keyed', 's3test_global', 's3test_undeclared'];

async function defineFixtures(db) {
  const rows = db.defineModel('ScopeTestRows', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    serverID: { type: DataTypes.INTEGER, allowNull: true },
    note: { type: DataTypes.STRING(32) }
  }, { tableName: 's3test_rows', timestamps: false, exportTier: 'historical', scopeKind: 'server-column' });

  const legacy = db.defineModel('ScopeTestLegacy', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    note: { type: DataTypes.STRING(32) }
  }, { tableName: 's3test_legacy', timestamps: false, exportTier: 'historical', scopeKind: 'server-column' });

  const keyed = db.defineModel('ScopeTestKeyed', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    note: { type: DataTypes.STRING(32) }
  }, { tableName: 's3test_keyed', timestamps: false, exportTier: 'historical', scopeKind: 'server-key' });

  const global_ = db.defineModel('ScopeTestGlobal', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    note: { type: DataTypes.STRING(32) }
  }, { tableName: 's3test_global', timestamps: false, exportTier: 'historical', scopeKind: 'global' });

  const undeclared = db.defineModel('ScopeTestUndeclared', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    serverID: { type: DataTypes.INTEGER, allowNull: true },
    note: { type: DataTypes.STRING(32) }
  }, { tableName: 's3test_undeclared', timestamps: false, exportTier: 'historical' });

  for (const model of [rows, legacy, keyed, global_, undeclared]) {
    await model.sync();
  }

  // Three rows for this server, two for the sibling, one carrying no
  // attribution at all — the pre-multi-server shape.
  await rows.bulkCreate([
    { serverID: 1, note: 'mine-a' },
    { serverID: 1, note: 'mine-b' },
    { serverID: 1, note: 'mine-c' },
    { serverID: 2, note: 'theirs-a' },
    { serverID: 2, note: 'theirs-b' },
    { serverID: null, note: 'legacy' }
  ]);
  await legacy.bulkCreate([{ note: 'l1' }, { note: 'l2' }]);
  await keyed.bulkCreate([{ id: 1, note: 'my-state' }, { id: 2, note: 'their-state' }]);
  await global_.bulkCreate([{ note: 'g1' }, { note: 'g2' }, { note: 'g3' }]);
  await undeclared.bulkCreate([{ serverID: 1, note: 'u1' }, { serverID: 2, note: 'u2' }]);
}

/**
 * Open a mounted DBService against one dialect, define the fixtures, and hand
 * both to `fn`. The fixture tables are dropped afterwards whatever happens —
 * MySQL and Postgres here are real shared databases, and a leftover
 * `s3test_*` table is an orphan the next test file will find.
 */
async function withFixtures(name, fn) {
  if (!reachability.get(name)) return SKIP;
  const opts = DIALECTS.find((d) => d.name === name).opts;
  const seq = new Sequelize({ ...opts, define: { freezeTableName: true } });
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
    await defineFixtures(db);
    return await fn(db, seq);
  } finally {
    for (const table of FIXTURE_TABLES) {
      try { await seq.getQueryInterface().dropTable(table); } catch { /* best effort */ }
    }
    try { await db.unmount(); } catch { /* best effort */ }
    try { await seq.close(); } catch { /* best effort */ }
  }
}

/** Run a streaming export into a throwaway directory and parse the result. */
async function streamExport(db, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-export-scope-'));
  try {
    const result = await exportToFile(db, dir, { tier: 'historical', retention: 5, ...options });
    assert.ok(result, 'the streaming export must produce a file');
    const parsed = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    return { result, parsed };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

console.log('\n──────────────────────────────────────────────────────────────────────');
console.log('  Export scoping');
console.log('──────────────────────────────────────────────────────────────────────\n');

await probeReachability();

for (const { name } of DIALECTS) {
  console.log(`── ${name} ──`);

  await test(`[${name}] each scope kind resolves to the clause it declared`, async () =>
    withFixtures(name, async (db) => {
      assert.deepEqual(
        db.scopePredicateFor('ScopeTestRows'), { column: 'serverID', value: 1 },
        'a server-column model narrows on its declared column'
      );
      assert.deepEqual(
        db.scopePredicateFor('ScopeTestKeyed'), { column: 'id', value: 1 },
        'a server-key model narrows on its primary key — the key IS the server id'
      );
      assert.equal(
        db.scopePredicateFor('ScopeTestGlobal'), null,
        'a global model has no per-server subset to narrow to'
      );
      assert.equal(
        db.scopePredicateFor('ScopeTestLegacy'), null,
        'a declared column the table does not have yet is not a predicate'
      );
      assert.throws(
        () => db.scopePredicateFor('ScopeTestUndeclared'),
        /scopeKind/,
        'an undeclared model must stop the caller rather than resolve to a default'
      );
    }));

  await test(`[${name}] another server can be asked about explicitly`, async () =>
    withFixtures(name, async (db) => {
      assert.deepEqual(db.scopePredicateFor('ScopeTestRows', 7), { column: 'serverID', value: 7 });
      assert.deepEqual(db.scopePredicateFor('ScopeTestKeyed', 7), { column: 'id', value: 7 });
    }));

  await test(`[${name}] a scoped export contains only this server's rows`, async () =>
    withFixtures(name, async (db) => {
      const env = await exportToJSON(db, {
        tier: 'historical',
        models: ['ScopeTestRows', 'ScopeTestKeyed', 'ScopeTestGlobal', 'ScopeTestLegacy'],
        allServers: false
      });

      assert.equal(env.rowCounts.ScopeTestRows, 3, 'three rows carry serverID 1');
      assert.equal(env.rowCounts.ScopeTestKeyed, 1, 'one state row is keyed on this server');
      assert.equal(env.tables.ScopeTestKeyed[0].note, 'my-state');
      assert.equal(env.rowCounts.ScopeTestGlobal, 3, 'a global table is community-wide either way');
      assert.equal(env.rowCounts.ScopeTestLegacy, 2, 'no column means no predicate, so no rows are dropped');
    }));

  await test(`[${name}] --all-servers contains every server's rows`, async () =>
    withFixtures(name, async (db) => {
      const env = await exportToJSON(db, {
        tier: 'historical',
        models: ['ScopeTestRows', 'ScopeTestKeyed', 'ScopeTestGlobal'],
        allServers: true
      });

      assert.equal(env.rowCounts.ScopeTestRows, 6, 'every row, including the unattributed one');
      assert.equal(env.rowCounts.ScopeTestKeyed, 2, 'both servers’ live state');
      assert.equal(env.rowCounts.ScopeTestGlobal, 3);
    }));

  await test(`[${name}] the envelope says who took it and what is in it`, async () =>
    withFixtures(name, async (db) => {
      const mine = await exportToJSON(db, { tier: 'historical', models: ['ScopeTestRows'], allServers: false });
      assert.equal(mine.serverID, 1, 'the exporting server is named on the envelope');
      assert.equal(mine.scope, 'server');
      assert.deepEqual(mine.containedServerIDs, [1]);

      const all = await exportToJSON(db, { tier: 'historical', models: ['ScopeTestRows'], allServers: true });
      assert.equal(all.scope, 'community');
      assert.deepEqual(
        all.containedServerIDs, [1, 2],
        'read off the rows, not assumed from the registry — a NULL serverID names no server and adds no entry'
      );
    }));

  await test(`[${name}] a scoped export refuses a model whose scope was never declared`, async () =>
    withFixtures(name, async (db) => {
      const scoped = await exportToJSON(db, { tier: 'historical', models: ['ScopeTestUndeclared'], allServers: false });
      assert.equal(scoped.results.ScopeTestUndeclared.status, 'error');
      assert.match(scoped.results.ScopeTestUndeclared.error, /scopeKind/);
      // `complete` is the narrower signal — a model that left no trace at all —
      // and a table that was tried and refused did leave one. The refusal shows
      // up where a reader six months later will look for it instead.
      assert.ok(
        (scoped.failedTables || []).some((g) => g.model === 'ScopeTestUndeclared'),
        'and the envelope names it as a table the export could not read'
      );

      const all = await exportToJSON(db, { tier: 'historical', models: ['ScopeTestUndeclared'], allServers: true });
      assert.equal(
        all.results.ScopeTestUndeclared.status, 'ok',
        'a community-wide export applies no predicate, so not knowing the classification costs nothing'
      );
      assert.equal(all.rowCounts.ScopeTestUndeclared, 2);
    }));

  await test(`[${name}] the streaming exporter scopes the same way`, async () =>
    withFixtures(name, async (db) => {
      const { result, parsed } = await streamExport(db, {
        models: ['ScopeTestRows', 'ScopeTestKeyed', 'ScopeTestGlobal'],
        allServers: false
      });

      assert.equal(parsed.serverID, 1);
      assert.equal(parsed.scope, 'server');
      assert.deepEqual(parsed.containedServerIDs, [1]);
      assert.equal(parsed.tables.ScopeTestRows.length, 3);
      assert.equal(parsed.tables.ScopeTestKeyed.length, 1);
      assert.equal(parsed.tables.ScopeTestGlobal.length, 3);
      assert.equal(result.scope, 'server', 'the return value says it too, for the command that has no file to read');
      assert.deepEqual(result.containedServerIDs, [1]);
    }));

  await test(`[${name}] paging cannot lose the scope when the cursor is the scope column`, async () =>
    withFixtures(name, async (db) => {
      // batchSize 1 forces the keyset cursor to engage. For the server-key
      // model the cursor and the predicate both name `id`, so a merge that
      // spreads one object over the other drops the predicate and the second
      // server's state lands in a file that says it holds one server's.
      const { parsed } = await streamExport(db, {
        models: ['ScopeTestKeyed', 'ScopeTestRows'],
        allServers: false,
        batchSize: 1
      });

      assert.equal(parsed.tables.ScopeTestKeyed.length, 1, 'exactly this server’s state row');
      assert.equal(parsed.tables.ScopeTestKeyed[0].id, 1);
      assert.equal(parsed.tables.ScopeTestRows.length, 3, 'and paging a server-column table still stops at three');
      assert.deepEqual(parsed.containedServerIDs, [1]);
    }));

  await test(`[${name}] a streamed community export names both servers`, async () =>
    withFixtures(name, async (db) => {
      const { parsed } = await streamExport(db, {
        models: ['ScopeTestRows', 'ScopeTestKeyed'],
        allServers: true,
        batchSize: 2
      });

      assert.equal(parsed.scope, 'community');
      assert.deepEqual(parsed.containedServerIDs, [1, 2]);
      assert.equal(parsed.tables.ScopeTestRows.length, 6);
      assert.equal(parsed.tables.ScopeTestKeyed.length, 2);
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
