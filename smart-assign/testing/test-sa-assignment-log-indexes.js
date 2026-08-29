/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      SA_ASSIGNMENTLOG — INDEX CREATION                        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * SA_AssignmentLog's three indexes (idx_sa_al_matchId, idx_sa_al_eventType,
 * idx_sa_al_ts) were declared in defineModel()'s `indexes` option since the
 * table was introduced, but nothing ever created them: defineModel() only
 * registers the in-memory Sequelize model, and the migration's up() calls
 * qi.createTable() with no indexes and no follow-up step. They were dead
 * metadata on every dialect. This is the regression test for the fix:
 * DBService.ensureIndexes(), called after verifyAndRunMigrations() in
 * smart-assign.js's _onS3Ready(), the same self-healing shape LoggingService
 * already uses for its own tables (see s3/testing/test-db-service.js for
 * ensureIndexes() itself).
 *
 * Unlike test-smart-assign-plugin.js, this suite mounts against a REAL
 * DBService (s3/testing/mock-s3.js's makeS3Db()) rather than `db: null` —
 * schema behaviour needs a real engine to answer "did the index land."
 *
 * ─── THE CASE THAT ACTUALLY MATTERS ───────────────────────────────
 *
 * Every currently-deployed SmartAssign install already has SA_AssignmentLog
 * (the migration created it) with none of its indexes (nothing ever created
 * them) and its migration version already recorded at v1 — so the next
 * mount does NOT re-run up(). A test that only ever mounts against a fresh,
 * empty database never exercises that path: the table and the indexes are
 * created in the same mount, and the fix's actual job — retroactively
 * healing a database that has already been living in the broken state —
 * goes unproven. The third case below builds that exact state (by mounting
 * once with ensureIndexes() stubbed to a no-op, simulating the pre-fix
 * code path) and then proves a normal second mount fixes it.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-sa-assignment-log-indexes.js
 *
 * Category: 1 (SQLite always; MySQL opportunistic, mirrors the other
 * real-DB suites in this repo — see elo-tracker/testing/test-elo-database.js)
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';
import { makeMockServer, makeS3Db } from '../../s3/testing/mock-s3.js';
import DBService from '../../s3/utils/db-service.js';

const EXPECTED_INDEXES = ['idx_sa_al_matchId', 'idx_sa_al_eventType', 'idx_sa_al_ts'];

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

async function runSuite(label, dbFactory, selfHealDbFactory = dbFactory) {
  const assembly = buildAssembly('.tmp-sa-assignment-log-indexes');
  try {
    const SmartAssign = await importFromAssembly(assembly, 'smart-assign.js');
    const db = await dbFactory();

    async function mount(server) {
      const plugin = new SmartAssign(server, { discordClient: null }, {});
      await plugin.prepareToMount();
      await plugin.mount();
      return plugin;
    }

    await test(`[${label}] mounting creates all three SA_AssignmentLog indexes`, async () => {
      const server = makeMockServer({ players: [], s3: { db } });
      const plugin = await mount(server);
      try {
        const names = (await db.getConnector().getQueryInterface().showIndex('SA_AssignmentLog'))
          .map((i) => i.name);
        for (const idx of EXPECTED_INDEXES) {
          assert.ok(names.includes(idx), `${idx} missing after mount`);
        }
      } finally {
        await plugin.unmount();
      }
    });

    await test(`[${label}] a second mount against the same DB is a no-op, not an error`, async () => {
      // Spied, not just end-state: end-state alone can't tell "ensureIndexes()
      // ran again and was idempotent" apart from "ensureIndexes() silently
      // never ran a second time" (e.g. because registerMigrations() threw and
      // was swallowed upstream) — both leave the index list unchanged. Only a
      // call count proves the real code path actually executed twice.
      let calls = 0;
      const originalEnsureIndexes = db.ensureIndexes.bind(db);
      db.ensureIndexes = async (...args) => {
        calls += 1;
        return originalEnsureIndexes(...args);
      };
      try {
        const server = makeMockServer({ players: [], s3: { db } });
        const plugin = await mount(server);
        try {
          assert.equal(calls, 1, 'ensureIndexes() did not run on the second mount');
          const names = (await db.getConnector().getQueryInterface().showIndex('SA_AssignmentLog'))
            .map((i) => i.name);
          for (const idx of EXPECTED_INDEXES) {
            assert.equal(
              names.filter((n) => n === idx).length, 1,
              `${idx} was duplicated on a second mount`
            );
          }
        } finally {
          await plugin.unmount();
        }
      } finally {
        db.ensureIndexes = originalEnsureIndexes;
      }
    });

    await db.unmount();

    // ── The partial state every existing deployment is actually in ──────
    // A genuinely separate, still-empty database: for sqlite dbFactory()
    // already returns a fresh :memory: store, but for mysql the shared
    // dbFactory() above reconnects to the SAME server database tests 1 and 2
    // just populated — reusing it here would make the "no indexes yet"
    // assertion below false by construction, not by anything this test proves.
    const db2 = await selfHealDbFactory();
    try {
      const originalEnsureIndexes = db2.ensureIndexes.bind(db2);

      await test(`[${label}] self-heals a pre-existing table that has no indexes (the deployed-DB case)`, async () => {
        // Phase 1: simulate the pre-fix code — table gets created by the real
        // migration, but ensureIndexes() is stubbed out, so it commits with
        // zero indexes and its version recorded at v1, same as production
        // right now.
        db2.ensureIndexes = async () => {};
        const server1 = makeMockServer({ players: [], s3: { db: db2 } });
        const plugin1 = await mount(server1);
        try {
          const namesBefore = (await db2.getConnector().getQueryInterface().showIndex('SA_AssignmentLog'))
            .map((i) => i.name);
          assert.deepEqual(
            namesBefore.filter((n) => EXPECTED_INDEXES.includes(n)), [],
            'test setup invalid: indexes already present before the stubbed-out mount'
          );
        } finally {
          await plugin1.unmount();
          db2.ensureIndexes = originalEnsureIndexes;
        }

        // Phase 2: a normal mount against that same, already-migrated,
        // still-unindexed database. verifyAndRunMigrations() must skip
        // re-running up() (version is already v1) — ensureIndexes() is the
        // only thing that can fix this, and it isn't gated on migration state.
        const server2 = makeMockServer({ players: [], s3: { db: db2 } });
        const plugin2 = await mount(server2);
        try {
          const names = (await db2.getConnector().getQueryInterface().showIndex('SA_AssignmentLog'))
            .map((i) => i.name);
          for (const idx of EXPECTED_INDEXES) {
            assert.ok(names.includes(idx), `${idx} was not retroactively created on a pre-existing table`);
          }
        } finally {
          await plugin2.unmount();
        }
      });
    } finally {
      await db2.unmount();
    }
  } finally {
    cleanAssembly(assembly);
  }
}

// ── SQLite: always runs ──────────────────────────────────────────
await runSuite('sqlite', () => makeS3Db());

// ── MySQL: opportunistic, same reasoning as the other real-DB suites —
// the live deployment grant is CREATE-only (no ALTER), and this is exactly
// the code path that regressed under it before LoggingService's fix. ──
const MYSQL = {
  host: process.env.S3_TEST_MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.S3_TEST_MYSQL_PORT || '3307', 10),
  username: process.env.S3_TEST_MYSQL_ROOT_USER || 'root',
  password: process.env.S3_TEST_MYSQL_ROOT_PASSWORD || 'root',
  database: process.env.S3_TEST_MYSQL_DATABASE || 'sa_assignment_log_indexes_test',
  // Dedicated to the self-heal test: it needs to observe a table with zero
  // indexes, which requires a database tests 1/2 never touched — reusing
  // MYSQL.database would make that precondition false by construction.
  selfHealDatabase: process.env.S3_TEST_MYSQL_SELFHEAL_DATABASE || 'sa_assignment_log_indexes_selfheal_test'
};

let mysqlReachable = false;
{
  let probe;
  try {
    probe = new Sequelize({
      dialect: 'mysql',
      host: MYSQL.host,
      port: MYSQL.port,
      username: MYSQL.username,
      password: MYSQL.password,
      database: 'mysql',
      logging: false,
      dialectOptions: { connectTimeout: 4000 }
    });
    await probe.authenticate();
    await probe.query(`DROP DATABASE IF EXISTS \`${MYSQL.database}\``);
    await probe.query(`CREATE DATABASE \`${MYSQL.database}\``);
    await probe.query(`DROP DATABASE IF EXISTS \`${MYSQL.selfHealDatabase}\``);
    await probe.query(`CREATE DATABASE \`${MYSQL.selfHealDatabase}\``);
    mysqlReachable = true;
    console.log(`  mysql reachable on ${MYSQL.host}:${MYSQL.port}`);
  } catch {
    mysqlReachable = false;
    console.log(`  ⚠ mysql not reachable on ${MYSQL.host}:${MYSQL.port} — [mysql] cases skipped`);
  } finally {
    try { await probe?.close(); } catch { /* best effort */ }
  }
}

function makeMysqlDbFactory(database) {
  return async () => {
    const sequelize = new Sequelize({
      dialect: 'mysql',
      host: MYSQL.host,
      port: MYSQL.port,
      username: MYSQL.username,
      password: MYSQL.password,
      database,
      logging: false
    });
    const db = new DBService({ sequelize, verboseLogger: () => {} });
    await db.mount();
    db.migrationEngine?.confirmToken('__auto__');
    return db;
  };
}

if (mysqlReachable) {
  await runSuite(
    'mysql',
    makeMysqlDbFactory(MYSQL.database),
    makeMysqlDbFactory(MYSQL.selfHealDatabase)
  );
}

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed.`);
if (!process.exitCode) console.log('\nAll SA_AssignmentLog index tests passed.');
