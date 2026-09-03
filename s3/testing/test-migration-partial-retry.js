/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      MIGRATION ENGINE — PARTIAL-APPLY RETRY                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * runMigrations() runs up() inside a transaction, then verifies the
 * declared `touches` OUTSIDE that transaction, then records the version in
 * a SEPARATE transaction. If up() itself succeeds (commits) but the
 * post-commit verification fails — a mismatched touches declaration, a
 * backfill bug, anything — the DDL/DML is real and permanent, but the
 * version is never recorded. The exact same up() runs again on every
 * future attempt (a process restart, an admin re-running !s3 migrate
 * force), including whichever statements already succeeded the first time.
 *
 * Four of the QueryInterface helpers exposed to migration authors had no
 * defence against that: `addColumn`, `bulkInsert`, `addIndex`, and
 * `removeIndex` re-issued the same raw DDL/DML unconditionally, so a retry
 * crashed on the driver's own "duplicate column" / duplicate-key /
 * duplicate-index-name / "no such index to drop" error — forever, since
 * nothing about that crash is retryable, until someone manually edits the
 * live schema or hand-inserts a SchemaVersion row. `createTable` was never
 * at risk: Sequelize emits `CREATE TABLE IF NOT EXISTS` on both dialects
 * tested. `removeColumn`/`dropTable` were never at risk either — they
 * already check existence first. `changeColumn` turned out not to need a
 * guard at all: confirmed empirically that re-running it with the same
 * target definition is already a safe no-op on both dialects (SQLite's
 * table-rebuild path and MySQL's in-place MODIFY COLUMN alike). This is the
 * same shape of bug as the SA_AssignmentLog dead-indexes fix and the
 * registerMigrations() gap-check ordering bug (see
 * smart-assign/testing/test-sa-assignment-log-indexes.js and the
 * "Re-registering the exact same migration set" case in
 * test-migration-pipeline.js): the framework assumed a retry could re-run
 * a migration from scratch, and that assumption didn't hold everywhere.
 *
 * Confirmed empirically identical on SQLite and MySQL before the fix — the
 * failure is not a MySQL-implicit-DDL-commit quirk, despite that being the
 * first suspect: SQLite does not undo an already-executed ADD COLUMN,
 * CREATE/DROP INDEX, or INSERT just because the transaction wrapping the
 * rest of up() rolls back around a later failure. (`removeIndex` is the one
 * exception: SQLite's own DROP INDEX is naturally idempotent — only MySQL
 * throws on a retry there — but the guard applies uniformly so migration
 * authors don't need to know which dialect needs it.)
 *
 * A migration that commits and verifies cleanly but then fails to record its
 * version (a dropped connection between steps 2 and 3, say) needs the exact
 * same guarantee on the *next* full replay of up() — which is why every fix
 * above is a plain idempotency guard, not something keyed to "verification
 * already failed once." The recovery case in runSuite() below is a replay
 * after correction, not after a successful-but-unrecorded run, but it
 * exercises the identical code path: the guards don't know or care why up()
 * is running a second time.
 *
 * Separately, a migration can fail for a reason no retry will ever fix: the
 * configured DB user lacks a required privilege. describePermissionError()
 * (migration-engine.js) recognizes that shape — MySQL's ER_*ACCESS_DENIED_
 * ERROR family, Postgres's SQLSTATE 42501, SQLite's SQLITE_READONLY/PERM —
 * and appends operator-facing guidance to err.message instead of leaving an
 * admin to interpret a raw driver string. That path is covered in
 * test-migration-permissions.js (which already owns the multi-dialect
 * permission-tier fixtures), not here.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-migration-partial-retry.js
 *
 * Category: 1 (SQLite always; MySQL opportunistic via Docker, same
 * reachability-probe pattern as test-migration-permissions.js and
 * smart-assign/testing/test-sa-assignment-log-indexes.js)
 */

'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sequelize } from 'sequelize';

import DBService from '../utils/db-service.js';

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

/**
 * v1: a clean, always-correct setup migration — creates PRProbe and a
 * "legacy" index that v2 below will remove. Applies and records normally,
 * so by the time v2 runs, idx_pr_probe_legacy already exists from a PRIOR,
 * separately-committed migration rather than from anything v2's own up()
 * just did. That distinction matters: removeIndex on an index created and
 * removed within the SAME up() call can never actually collide on retry —
 * add-then-remove cancels out identically every attempt, by construction.
 * The real risk (and the one removeIndex's guard exists for) is a *later*
 * migration cleaning up something an *earlier* one left behind, which is
 * exactly what this split reproduces.
 */
function setupMigration() {
  return {
    version: 1,
    description: 'create PRProbe with realColumn and a legacy index for v2 to remove',
    touches: {
      creates: ['PRProbe'],
      columns: { PRProbe: ['id', 'realColumn'] }
    },
    up: async (qi) => {
      await qi.createTable('PRProbe', {
        id: { type: qi.DataTypes.STRING, primaryKey: true },
        realColumn: { type: qi.DataTypes.STRING }
      });
      await qi.addIndex('PRProbe', ['id'], { name: 'idx_pr_probe_legacy' });
    }
  };
}

/**
 * v2: adds a column, widens a column, adds a new index, removes the legacy
 * one from v1, and seeds a row — all real, all correct — but declares (by
 * author mistake) a column that up() never adds. Verification fails every
 * time, on purpose: this is what forces runMigrations() into the retry path
 * being tested, without relying on a permission failure or any other
 * hard-to-reproduce trigger.
 */
function buggyMigration() {
  return {
    version: 2,
    description: 'add a column, widen a column, add an index, remove the legacy index, seed a row (fakeColumn is never added — deliberate author bug)',
    touches: {
      columns: { PRProbe: ['id', 'realColumn', 'addedColumn', 'fakeColumn'] },
      rows: { PRProbe: [{ key: 'id', value: 'seed' }] }
    },
    up: async (qi) => {
      await qi.addColumn('PRProbe', 'addedColumn', { type: qi.DataTypes.STRING });
      await qi.changeColumn('PRProbe', 'realColumn', { type: qi.DataTypes.TEXT });
      await qi.addIndex('PRProbe', ['addedColumn'], { name: 'idx_pr_probe_added' });
      await qi.removeIndex('PRProbe', 'idx_pr_probe_legacy');
      await qi.bulkInsert('PRProbe', [{ id: 'seed', realColumn: 'x', addedColumn: 'y' }]);
    }
  };
}

/** Same shape as buggyMigration, with the author's mistake fixed — used by the recovery case. */
function fixedMigration() {
  return {
    version: 2,
    description: 'add a column, widen a column, add an index, remove the legacy index, seed a row (corrected touches)',
    touches: {
      columns: { PRProbe: ['id', 'realColumn', 'addedColumn'] },
      rows: { PRProbe: [{ key: 'id', value: 'seed' }] }
    },
    up: async (qi) => {
      await qi.addColumn('PRProbe', 'addedColumn', { type: qi.DataTypes.STRING });
      await qi.changeColumn('PRProbe', 'realColumn', { type: qi.DataTypes.TEXT });
      await qi.addIndex('PRProbe', ['addedColumn'], { name: 'idx_pr_probe_added' });
      await qi.removeIndex('PRProbe', 'idx_pr_probe_legacy');
      await qi.bulkInsert('PRProbe', [{ id: 'seed', realColumn: 'x', addedColumn: 'y' }]);
    }
  };
}

async function seedRowCount(sequelize) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*) as c FROM ${sequelize.getDialect() === 'mysql' ? '`PRProbe`' : '"PRProbe"'} WHERE id = 'seed'`
  );
  return Number(rows[0].c);
}

/**
 * touches.rows verification resolves the table through the model registry
 * (modelForTable), not a raw table name — so the probe needs a real model,
 * the same way any actual plugin's migration would via its own defineModel()
 * call elsewhere in the plugin.
 */
function defineProbeModel(db) {
  db.defineModel('PRProbe', {
    id: { type: Sequelize.DataTypes.STRING, primaryKey: true },
    realColumn: { type: Sequelize.DataTypes.STRING },
    addedColumn: { type: Sequelize.DataTypes.STRING }
  }, { exportTier: 'ephemeral', timestamps: false });
}

async function runSuite(label, dbFactory, reopenOnSameStorage) {
  const db = await dbFactory();
  const { sequelize } = db;
  defineProbeModel(db);

  try {
    db.migrationEngine.registerMigrations('pr-probe', [setupMigration(), buggyMigration()]);

    let firstErr = null;
    try {
      await db.migrationEngine.runMigrations('pr-probe');
    } catch (err) {
      firstErr = err;
    }

    await test(`[${label}] up() commits real DDL/DML even though verification fails`, async () => {
      assert.ok(firstErr, 'expected the first run to throw on verification failure');
      const tables = await sequelize.getQueryInterface().showAllTables();
      // Compared case-insensitively: MySQL with lower_case_table_names=1 reports
      // `prprobe`, and an exact match here would fail on a server that is fine.
      assert.ok(
        tables.some((t) => String(typeof t === 'string' ? t : t?.tableName).toLowerCase() === 'prprobe'),
        `PRProbe should exist — v1 createTable committed. Found: ${tables.join(', ')}`
      );
      const cols = await sequelize.getQueryInterface().describeTable('PRProbe');
      assert.ok(cols.addedColumn, 'addedColumn should exist — v2 addColumn committed');
      const indexes = await sequelize.getQueryInterface().showIndex('PRProbe');
      assert.ok(indexes.some((i) => i.name === 'idx_pr_probe_added'), 'idx_pr_probe_added should exist — v2 addIndex committed');
      assert.ok(!indexes.some((i) => i.name === 'idx_pr_probe_legacy'), 'idx_pr_probe_legacy should be gone — v2 removeIndex committed');
      assert.equal(await seedRowCount(sequelize), 1, 'the seed row should exist — v2 bulkInsert committed');
    });

    await test(`[${label}] the version is not recorded when verification fails`, async () => {
      const applied = await db.migrationEngine._getAppliedVersion('pr-probe');
      assert.equal(applied, 1, 'v1 should be recorded (it verified cleanly); v2 must stay unrecorded — otherwise the broken state is considered current');
    });

    await test(`[${label}] retrying re-runs addColumn/changeColumn/addIndex/removeIndex without crashing on a raw driver error`, async () => {
      let secondErr = null;
      try {
        await db.migrationEngine.runMigrations('pr-probe');
      } catch (err) {
        secondErr = err;
      }
      assert.ok(secondErr, 'the retry should still fail — fakeColumn genuinely never gets added');
      assert.match(
        secondErr.message, /verification failed/,
        `retry should re-report the real verification failure, not crash on a raw driver error — got: ${secondErr.message}`
      );
      assert.doesNotMatch(secondErr.message, /duplicate column|Duplicate column/i);
      assert.doesNotMatch(secondErr.message, /already exists|Duplicate key name/i);
      assert.doesNotMatch(secondErr.message, /can't drop|check that column\/key exists/i);
    });

    await test(`[${label}] retrying re-runs bulkInsert without duplicating the seed row`, async () => {
      assert.equal(await seedRowCount(sequelize), 1, 'seed row must not be duplicated by the retry');
    });

    await test(`[${label}] retrying re-runs addIndex without duplicating the index`, async () => {
      const indexes = await sequelize.getQueryInterface().showIndex('PRProbe');
      const matches = indexes.filter((i) => i.name === 'idx_pr_probe_added');
      assert.equal(matches.length, 1, 'idx_pr_probe_added must not be duplicated by the retry');
    });

    await test(`[${label}] retrying re-runs removeIndex without crashing on the already-removed legacy index`, async () => {
      const indexes = await sequelize.getQueryInterface().showIndex('PRProbe');
      assert.ok(!indexes.some((i) => i.name === 'idx_pr_probe_legacy'), 'idx_pr_probe_legacy must still be gone after the retry');
    });
  } finally {
    await db.unmount();
  }

  // ── Recovery: the developer fixes the touches declaration and the plugin
  // remounts (a real restart — fresh MigrationEngine, same persisted data).
  // Proves the retry isn't merely non-crashing, but genuinely unstuck.
  if (reopenOnSameStorage) {
    const db2 = await reopenOnSameStorage();
    defineProbeModel(db2);
    try {
      db2.migrationEngine.registerMigrations('pr-probe', [fixedMigration()]);
      const result = await db2.migrationEngine.runMigrations('pr-probe');

      await test(`[${label}] once the migration is corrected, the very next attempt succeeds and is recorded`, async () => {
        assert.equal(result.applied, 1, 'the corrected v2 should apply cleanly');
        const applied = await db2.migrationEngine._getAppliedVersion('pr-probe');
        assert.equal(applied, 2, 'v2 should now be recorded');
        assert.equal(await seedRowCount(db2.sequelize), 1, 'still exactly one seed row, not a duplicate from the earlier partial attempt');
        const indexes = await db2.sequelize.getQueryInterface().showIndex('PRProbe');
        const addedMatches = indexes.filter((i) => i.name === 'idx_pr_probe_added');
        assert.equal(addedMatches.length, 1, 'still exactly one idx_pr_probe_added, not a duplicate from the earlier partial attempt');
        assert.ok(!indexes.some((i) => i.name === 'idx_pr_probe_legacy'), 'idx_pr_probe_legacy should still be gone, not resurrected by the corrected run');
      });
    } finally {
      await db2.unmount();
    }
  }
}

// ── SQLite: file-backed, not :memory: — the recovery case needs a second,
// independent connection to see the first connection's persisted state. ──
{
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-migration-partial-retry-'));
  const dbPath = path.join(tempDir, 'probe.sqlite');

  async function openSqlite() {
    const sequelize = new Sequelize({ dialect: 'sqlite', storage: dbPath, logging: false });
    const db = new DBService({ sequelize, verboseLogger: () => {} });
    await db.mount();
    db.migrationEngine?.confirmToken('__auto__');
    return db;
  }

  try {
    await runSuite('sqlite', openSqlite, openSqlite);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── MySQL: opportunistic, same reasoning as the other real-DB suites. ──
const MYSQL = {
  host: process.env.S3_TEST_MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.S3_TEST_MYSQL_PORT || '3307', 10),
  username: process.env.S3_TEST_MYSQL_ROOT_USER || 'root',
  password: process.env.S3_TEST_MYSQL_ROOT_PASSWORD || 'root',
  database: process.env.S3_TEST_MYSQL_DATABASE || 's3_migration_partial_retry_test'
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
    mysqlReachable = true;
    console.log(`  mysql reachable on ${MYSQL.host}:${MYSQL.port}`);
  } catch {
    mysqlReachable = false;
    console.log(`  ⚠ mysql not reachable on ${MYSQL.host}:${MYSQL.port} — [mysql] cases skipped`);
  } finally {
    try { await probe?.close(); } catch { /* best effort */ }
  }
}

if (mysqlReachable) {
  async function openMysql() {
    const sequelize = new Sequelize({
      dialect: 'mysql',
      host: MYSQL.host,
      port: MYSQL.port,
      username: MYSQL.username,
      password: MYSQL.password,
      database: MYSQL.database,
      logging: false
    });
    const db = new DBService({ sequelize, verboseLogger: () => {} });
    await db.mount();
    db.migrationEngine?.confirmToken('__auto__');
    return db;
  }

  await runSuite('mysql', openMysql, openMysql);
}

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed.`);
if (!process.exitCode) console.log('\nAll migration partial-retry tests passed.');
