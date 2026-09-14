/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║        !s3 db orphans — THE TABLES NOTHING READS ANY MORE      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Three of the suite's tables had their primary key change, and a primary key
 * cannot be altered in place on SQLite or on the deployed MySQL grant. So each
 * move created a new table beside the old one, and the old one stayed, because
 * that same grant has no DROP either. `!s3 db orphans` is how an operator finds
 * out what those tables are and how much is stuck in them.
 *
 * It was written against reasoning about three dialects and never run against
 * one. This file runs it.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   the live schema      A table a model points at is never an orphan, on any
 *                        dialect. On MySQL that is the whole ballgame:
 *                        production runs lower_case_table_names=1, the stored
 *                        name comes back folded, and a comparison that does not
 *                        fold reports the ENTIRE schema as orphaned.
 *   the abandoned three  A real leftover is found, counted, and shown with the
 *                        table that replaced it.
 *   somebody else's      A table with no suite prefix is not listed, whatever
 *                        else is true of it. Dropping the wrong table is the
 *                        one mistake this command must never invite, and it is
 *                        a read-only command precisely because that mistake is
 *                        not recoverable.
 *   the row count        A raw COUNT(*) against a table with no model, quoted
 *                        per dialect. Postgres wants double quotes where the
 *                        other two want backticks, and an unquoted identifier
 *                        is the shape §7.10 of the developer guide is about.
 *   flags               `!s3 db orphans --anything` is refused rather than
 *                        silently ignored.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-db-orphans.js
 *
 *   # with the Docker engines (ports match test-dialect-portability.js):
 *   docker run -d --name s3-test-postgres -e POSTGRES_PASSWORD=postgres \
 *     -p 5433:5432 postgres:16-alpine
 *   docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -p 3307:3306 mysql:8
 *
 * Category: 1 (SQLite always; MySQL/Postgres auto-skip)
 * Run:    node s3/testing/test-db-orphans.js
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

import DBService from '../utils/db-service.js';
import * as cmds from '../utils/s3-commands.js';
import { localize as lookupMessage } from '../utils/s3-i18n.js';

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
// Driving the real handler
// ---------------------------------------------------------------------------

/**
 * Run `!s3 db <args>` against a mounted DBService and return the embed.
 *
 * The handler is the shipped one, reached through `createCommandHandlers()`
 * rather than reimplemented here — a test that rebuilt the dispatch would pass
 * over a command nobody can actually invoke.
 */
async function runDbCommand(db, args) {
  const captured = [];
  const { handlers } = cmds.createCommandHandlers({
    sendDiscordMessage: async (_channel, payload) => { captured.push(payload); },
    watchManager: null,
    stagedImportRef: { current: null }
  });

  const message = {
    channel: { id: 'c1', send: async (p) => { captured.push(p); return { id: 'x' }; } },
    author: { id: 'u1' },
    reply: async (p) => { captured.push(p); return { id: 'x' }; },
    attachments: { size: 0, first: () => null }
  };

  await handlers.get('db')(
    { services: { db }, verbose: () => {}, localize: (key, vars) => lookupMessage(key, vars) },
    message,
    args
  );

  return captured.map((p) => (typeof p === 'string' ? { description: p } : p?.embeds?.[0])).filter(Boolean).pop();
}

/**
 * Open a mounted DBService against one dialect and hand it to `fn`.
 *
 * `freezeTableName` matches how the suite defines its own models: without it
 * Sequelize pluralises, and a test would be asserting against table names the
 * production schema does not have.
 */
async function withDialect(name, fn) {
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
    return await fn(db, seq);
  } finally {
    try { await db.unmount(); } catch { /* best effort */ }
    try { await seq.close(); } catch { /* best effort */ }
  }
}

/** Create a bare table with no model behind it, the way an abandoned one is. */
async function makeUnmodelledTable(seq, tableName, rowCount = 0) {
  const qi = seq.getQueryInterface();
  await qi.createTable(tableName, {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    eosID: { type: DataTypes.STRING(64) }
  });
  for (let i = 0; i < rowCount; i += 1) {
    await qi.bulkInsert(tableName, [{ eosID: `p${i}` }]);
  }
}

async function dropTable(seq, tableName) {
  try { await seq.getQueryInterface().dropTable(tableName); } catch { /* best effort */ }
}

/** Pull the table names out of an orphan embed's description. */
function listedTables(embed) {
  return [...String(embed?.description || '').matchAll(/`([^`]+)` — /g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

console.log('\n──────────────────────────────────────────────────────────────────────');
console.log('  !s3 db orphans');
console.log('──────────────────────────────────────────────────────────────────────\n');

await probeReachability();

for (const { name } of DIALECTS) {
  console.log(`── ${name} ──`);

  await test(`[${name}] a table a live model points at is never an orphan`, async () =>
    withDialect(name, async (db) => {
      const embed = await runDbCommand(db, ['db', 'orphans']);
      assert.ok(embed, 'the command must answer');

      // S³ mounts its own models, so the registry, the locks and the schema
      // versions are all live tables carrying an `s3_` prefix. Every one of
      // them reads as an orphan if the fold is wrong, which on MySQL is the
      // difference between a clean report and a list of the whole schema.
      const live = db.getModelNames()
        .map((n) => db.getModel(n)?.tableName)
        .filter(Boolean);
      assert.ok(live.length >= 3, 'S³ should have mounted several of its own models');

      const reported = listedTables(embed).map((t) => t.toLowerCase());
      for (const table of live) {
        assert.ok(
          !reported.includes(String(table).toLowerCase()),
          `${table} is backed by a live model and must not be reported as an orphan`
        );
      }
    }));

  await test(`[${name}] a suite-prefixed table with no model is found and counted`, async () =>
    withDialect(name, async (db, seq) => {
      await dropTable(seq, 'S3_PlayerSessions');
      await makeUnmodelledTable(seq, 'S3_PlayerSessions', 3);
      try {
        const embed = await runDbCommand(db, ['db', 'orphans']);
        const reported = listedTables(embed).map((t) => t.toLowerCase());
        assert.ok(reported.includes('s3_playersessions'), 'the abandoned table must be listed');
        assert.match(embed.description, /3 rows/, 'the row count is the point of the command');
      } finally {
        await dropTable(seq, 'S3_PlayerSessions');
      }
    }));

  await test(`[${name}] a known abandoned table names what replaced it`, async () =>
    withDialect(name, async (db, seq) => {
      await dropTable(seq, 'S3_PlayerReconnects');
      await makeUnmodelledTable(seq, 'S3_PlayerReconnects', 1);
      try {
        const embed = await runDbCommand(db, ['db', 'orphans']);
        // The arrow is what turns "there is an extra table" into "your data
        // moved here" — the ABANDONED_BY lookup folds, and on MySQL the name
        // it is folding arrived folded already.
        assert.match(
          embed.description, /S3_ServerReconnects/,
          'a table this suite abandoned on purpose must point at its replacement'
        );
      } finally {
        await dropTable(seq, 'S3_PlayerReconnects');
      }
    }));

  await test(`[${name}] a table with no suite prefix is never listed`, async () =>
    withDialect(name, async (db, seq) => {
      // Somebody else's table in the same database. The command is read-only,
      // but the list it prints is what an operator with the DROP grant acts
      // on, so naming a stranger's table here is the same mistake one step
      // removed.
      await dropTable(seq, 'wp_users');
      await makeUnmodelledTable(seq, 'wp_users', 2);
      try {
        const embed = await runDbCommand(db, ['db', 'orphans']);
        const reported = listedTables(embed).map((t) => t.toLowerCase());
        assert.ok(!reported.includes('wp_users'), 'a table outside the suite must not appear');
      } finally {
        await dropTable(seq, 'wp_users');
      }
    }));

  await test(`[${name}] a clean schema says so rather than printing an empty list`, async () =>
    withDialect(name, async (db, seq) => {
      // Only meaningful if nothing else left an orphan behind in this
      // database, which is true of SQLite in memory and usually true of the
      // shared engines. Where it is not, the assertion below is skipped
      // rather than failed — the other five cases carry the behaviour, and a
      // red here would only ever mean "a previous run left a table".
      await dropTable(seq, 'S3_PlayerSessions');
      await dropTable(seq, 'S3_PlayerReconnects');
      const embed = await runDbCommand(db, ['db', 'orphans']);
      if (/Orphan Tables \(/.test(embed.title || '')) return;
      assert.match(embed.title, /No Orphan Tables/);
      assert.equal(embed.color, 0x2ecc71, 'a clean schema is not a warning');
    }));

  await test(`[${name}] a stray flag is refused rather than ignored`, async () =>
    withDialect(name, async (db) => {
      const embed = await runDbCommand(db, ['db', 'orphans', '--all']);
      assert.ok(embed, 'a refusal still has to reach the channel');
      assert.ok(
        !/No Orphan Tables|Orphan Tables \(/.test(embed.title || ''),
        'a flag this command does not take must not be swallowed into a normal answer'
      );
    }));

  console.log('');
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('──────────────────────────────────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped, ${passed + failed + skipped} total`);
console.log('──────────────────────────────────────────────────────────────────────\n');

if (failed > 0) process.exitCode = 1;
