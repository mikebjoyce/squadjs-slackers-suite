/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     CATEGORY 4 — MULTI-DIALECT PERMISSION TESTS              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Exercises the real MigrationEngine against SQLite, MySQL, and
 * Postgres at permission tiers (admin, readonly, no-ddl, and — MySQL
 * only — create-only: a normal least-privilege grant, CREATE and INDEX
 * but no ALTER/DROP). MySQL/Postgres are Docker-gated — skipped
 * gracefully when unreachable. SQLite coverage always runs.
 *
 * create-only exists because none of the other three tiers reproduces the
 * grant that actually broke LoggingService (2026-08-28): admin has
 * everything, no-ddl has no CREATE at all, and readonly has neither.
 * See s3/S3_DEVELOPER_GUIDE.md §11.4.
 *
 * Category: 4 (requires Docker for MySQL/Postgres — opt-in)
 * Run:    node SlackersSquadServices/testing/test-migration-permissions.js
 *
 * Requires: sequelize, MigrationEngine, DBService
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

import DBService from '../utils/db-service.js';
import MigrationEngine from '../utils/migration-engine.js';


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

/**
 * Does `tables` contain `name`, ignoring identifier case?
 *
 * This file runs its MySQL fixtures against a real server, and a server
 * initialized with lower_case_table_names=1 (production's setting) folds
 * every table name it stores, so an exact-match check here would fail on a
 * healthy migration. See hasTable() in migration-engine.js for the full story.
 */
function hasTable(tables, name) {
  const target = name.toLowerCase();
  return tables.some((entry) => {
    const actual = typeof entry === 'string' ? entry : entry?.tableName;
    return typeof actual === 'string' && actual.toLowerCase() === target;
  });
}

// A skip is neither a pass nor a failure and must be counted separately \u2014
// see docs/core/AI_AGENTS_OVERVIEW.md "A green suite is not dialect coverage".
class SkipTest extends Error {
  constructor(message) {
    super(message);
    this.isSkip = true;
  }
}

async function run() {
  console.log('='.repeat(65));
  console.log('Migration Permission Tests  (multi-dialect)');
  console.log('='.repeat(65));
  console.log('');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  \u2713 ${t.name}`);
      passed++;
    } catch (err) {
      if (err.isSkip) {
        console.log(`  \u2298 ${t.name} (skipped \u2014 ${err.message})`);
        skipped++;
        continue;
      }
      console.log(`  \u2717 ${t.name}`);
      console.log(`    ${err.message.split('\n')[0]}`);
      failed++;
    }
  }

  console.log('');
  console.log('\u2500'.repeat(65));
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped, ${tests.length} total`);
  console.log('\u2500'.repeat(65));

  if (failed > 0) process.exitCode = 1;
}


// ---------------------------------------------------------------------------
// Permission helpers (Windows + Unix)
// ---------------------------------------------------------------------------

/**
 * Make a file read-only at the OS level.
 * On Windows, uses icacls /deny Everyone:(W).
 * On Unix, uses chmod 444.
 * Falls back to chmod if icacls isn't available or fails.
 * @param {string} filePath - Absolute path to the file
 * @returns {boolean} True if the operation appears to have succeeded
 */
function makeFileReadOnly(filePath) {
  if (process.platform === 'win32') {
    try {
      // Grant only read access, remove all other permissions.
      // icacls /deny prevents SQLite from opening the file at all because
      // SQLite opens with GENERIC_READ | GENERIC_WRITE. Instead, we grant
      // only read (R) and remove inheritance so no write access exists.
      execSync(`icacls "${filePath}" /grant:r Everyone:(R)`, { stdio: 'pipe' });
      return true;
    } catch {
      // Fall through to chmod fallback
    }
  }
  try {
    fs.chmodSync(filePath, 0o444);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore write permissions on a file.
 * On Windows, removes icacls deny entries for Everyone.
 * On Unix, uses chmod 644.
 * Best-effort — failures are swallowed.
 * @param {string} filePath - Absolute path to the file
 */
function restoreFilePermissions(filePath) {
  if (process.platform === 'win32') {
    try {
      // Reset to inherited permissions from parent directory
      execSync(`icacls "${filePath}" /reset`, { stdio: 'pipe' });
    } catch {
      // Best-effort
    }
  }
  try {
    fs.chmodSync(filePath, 0o644);
  } catch {
    // Best-effort
  }
}


// ---------------------------------------------------------------------------
// Connection defaults (overridable via env vars)
// ---------------------------------------------------------------------------

const MYSQL_HOST = process.env.S3_TEST_MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = parseInt(process.env.S3_TEST_MYSQL_PORT || '3307', 10);
const MYSQL_ROOT_USER = process.env.S3_TEST_MYSQL_ROOT_USER || 'root';
const MYSQL_ROOT_PASS = process.env.S3_TEST_MYSQL_ROOT_PASSWORD || 'root';
const MYSQL_RO_USER = process.env.S3_TEST_MYSQL_READONLY_USER || 's3_readonly';
const MYSQL_RO_PASS = process.env.S3_TEST_MYSQL_READONLY_PASSWORD || 'readonly';
const MYSQL_NODDL_USER = process.env.S3_TEST_MYSQL_NODDL_USER || 's3_noddl';
const MYSQL_NODDL_PASS = process.env.S3_TEST_MYSQL_NODDL_PASSWORD || 'noddl';
// A normal least-privilege MySQL grant: CREATE/INDEX but no ALTER/DROP.
// This is the profile that broke LoggingService's Model.sync()
// (2026-08-28) — see s3/S3_DEVELOPER_GUIDE.md §11.4.
const MYSQL_CREATEONLY_USER = process.env.S3_TEST_MYSQL_CREATEONLY_USER || 's3_createonly';
const MYSQL_CREATEONLY_PASS = process.env.S3_TEST_MYSQL_CREATEONLY_PASSWORD || 'createonly';

const PG_HOST = process.env.S3_TEST_PG_HOST || '127.0.0.1';
const PG_PORT = parseInt(process.env.S3_TEST_PG_PORT || '5433', 10);
const PG_ADMIN_USER = process.env.S3_TEST_PG_ADMIN_USER || 'postgres';
const PG_ADMIN_PASS = process.env.S3_TEST_PG_ADMIN_PASSWORD || 'postgres';
const PG_RO_USER = process.env.S3_TEST_PG_READONLY_USER || 's3_readonly';
const PG_RO_PASS = process.env.S3_TEST_PG_READONLY_PASSWORD || 'readonly';
const PG_NODDL_USER = process.env.S3_TEST_PG_NODDL_USER || 's3_noddl';
const PG_NODDL_PASS = process.env.S3_TEST_PG_NODDL_PASSWORD || 'noddl';


// ---------------------------------------------------------------------------
// Reachability probes (run once at startup)
// ---------------------------------------------------------------------------

let mysqlReachable = false;
let postgresReachable = false;

async function probeReachability() {
  // ── MySQL ──────────────────────────────────────────────────────
  try {
    const probeSeq = new Sequelize({
      dialect: 'mysql',
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      username: MYSQL_ROOT_USER,
      password: MYSQL_ROOT_PASS,
      logging: false
    });
    await probeSeq.authenticate();
    await probeSeq.close();
    mysqlReachable = true;
    console.log(`  MySQL reachable on ${MYSQL_HOST}:${MYSQL_PORT}`);
  } catch {
    console.log(`  \u26A0 MySQL not reachable on ${MYSQL_HOST}:${MYSQL_PORT} — skipping MySQL tests`);
  }

  // ── Postgres ───────────────────────────────────────────────────
  try {
    const probeSeq = new Sequelize({
      dialect: 'postgres',
      host: PG_HOST,
      port: PG_PORT,
      username: PG_ADMIN_USER,
      password: PG_ADMIN_PASS,
      database: 'postgres',
      logging: false
    });
    await probeSeq.authenticate();
    await probeSeq.close();
    postgresReachable = true;
    console.log(`  Postgres reachable on ${PG_HOST}:${PG_PORT}`);
  } catch {
    console.log(`  \u26A0 Postgres not reachable on ${PG_HOST}:${PG_PORT} — skipping Postgres tests`);
  }

  console.log('');
}


// ---------------------------------------------------------------------------
// Fixture factory — createFixture(dialect, tier)
// ---------------------------------------------------------------------------

/**
 * Create a test fixture for a given dialect and permission tier.
 *
 * @param {'sqlite'|'mysql'|'postgres'} dialect
 * @param {'admin'|'readonly'|'no-ddl'} tier
 * @returns {Promise<{sequelize: Sequelize, dbService: DBService, engine: MigrationEngine, teardown: Function}>}
 */
async function createFixture(dialect, tier) {
  switch (dialect) {
    case 'sqlite':
      return createSqliteFixture(tier);
    case 'mysql':
      return createMysqlFixture(tier);
    case 'postgres':
      return createPostgresFixture(tier);
    default:
      throw new Error(`Unknown dialect: ${dialect}`);
  }
}

// ── SQLite fixtures ──────────────────────────────────────────────

async function createSqliteFixture(tier) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-mig-perm-sqlite-'));
  const dbPath = path.join(tempDir, 'test.sqlite');

  if (tier === 'admin') {
    const sequelize = new Sequelize({
      dialect: 'sqlite',
      storage: dbPath,
      logging: false,
      define: { freezeTableName: true }
    });

    const dbService = new DBService({ sequelize, verboseLogger: () => {} });
    await dbService.mount();

    dbService._migrationEngine = new MigrationEngine({
      dbService,
      verboseLogger: () => {},
      backupDir: tempDir
    });

    return {
      sequelize,
      dbService,
      engine: dbService.migrationEngine,
      teardown: async () => {
        try { await dbService.unmount(); } catch { /* ignore */ }
        try { await sequelize.close(); } catch { /* ignore */ }
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    };
  }

  // readonly tier: bootstrap as admin, close, make read-only, reopen.
  // NOTE: On Windows, SQLite opens files with GENERIC_READ | GENERIC_WRITE,
  // so any OS-level write restriction also prevents opening the file.
  // The SQLite readonly test is skipped on Windows — MySQL/Postgres
  // readonly tests cover the permission-failure scenario.
  if (tier === 'readonly') {
    if (process.platform === 'win32') {
      // Clean up temp dir and throw a skip signal
      fs.rmSync(tempDir, { recursive: true, force: true });
      const skipErr = new Error('SKIP: SQLite readonly test not supported on Windows (SQLite requires GENERIC_WRITE to open files)');
      skipErr.code = 'SKIP_SQLITE_RO_WIN32';
      throw skipErr;
    }

    // admin bootstrap
    const adminSeq = new Sequelize({
      dialect: 'sqlite',
      storage: dbPath,
      logging: false,
      define: { freezeTableName: true }
    });
    const adminDb = new DBService({ sequelize: adminSeq, verboseLogger: () => {} });
    await adminDb.mount();
    adminDb._migrationEngine = new MigrationEngine({
      dbService: adminDb,
      verboseLogger: () => {},
      backupDir: tempDir
    });
    adminDb._migrationEngine.registerMigrations('bootstrap', [
      { version: 1, description: 'Admin setup', up: async () => {} }
    ]);
    adminDb._migrationEngine.confirmToken('__auto__');
    await adminDb._migrationEngine.runMigrations('bootstrap');

    // Switch to DELETE journal mode so no WAL/SHM files are needed.
    // WAL mode requires a writable directory for journal files, which
    // conflicts with making the file read-only.
    await adminSeq.query('PRAGMA journal_mode=DELETE;');
    await adminSeq.close();

    // make the file read-only.
    // SQLite can still open it for reading but cannot write.
    const madeReadOnly = makeFileReadOnly(dbPath);
    if (!madeReadOnly) {
      throw new Error('Failed to make SQLite file read-only — test precondition failed');
    }

    // reopen as read-only
    const roSeq = new Sequelize({
      dialect: 'sqlite',
      storage: dbPath,
      logging: false,
      define: { freezeTableName: true }
    });
    const roDb = new DBService({ sequelize: roSeq, verboseLogger: () => {} });
    await roDb.mount();
    roDb._migrationEngine = new MigrationEngine({
      dbService: roDb,
      verboseLogger: () => {},
      backupDir: tempDir
    });

    return {
      sequelize: roSeq,
      dbService: roDb,
      engine: roDb.migrationEngine,
      teardown: async () => {
        try { await roDb.unmount(); } catch { /* ignore */ }
        try { await roSeq.close(); } catch { /* ignore */ }
        restoreFilePermissions(dbPath);
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    };
  }

  throw new Error(`Unknown SQLite tier: ${tier}`);
}

// ── MySQL fixtures ───────────────────────────────────────────────

async function createMysqlFixture(tier) {
  const dbName = `s3_mig_test_${tier}_${Date.now()}`;

  // Create the test database via admin connection
  const adminSeq = new Sequelize({
    dialect: 'mysql',
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    username: MYSQL_ROOT_USER,
    password: MYSQL_ROOT_PASS,
    logging: false
  });
  await adminSeq.authenticate();
  await adminSeq.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\`;`);
  await adminSeq.close();

  // For restricted tiers, bootstrap SchemaVersions table via admin first.
  // DBService.mount() calls sync() on SchemaVersions, which requires DDL
  // privileges that readonly/no-ddl users don't have.
  if (tier !== 'admin') {
    const bootstrapSeq = new Sequelize({
      dialect: 'mysql',
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      username: MYSQL_ROOT_USER,
      password: MYSQL_ROOT_PASS,
      database: dbName,
      logging: false,
      define: { freezeTableName: true }
    });
    const bootstrapDb = new DBService({ sequelize: bootstrapSeq, verboseLogger: () => {} });
    await bootstrapDb.mount();

    // MySQL 8 removed implicit user creation via GRANT ... TO 'user'@'host'
    // — GRANT now throws "not allowed to create a user with GRANT" if the
    // user doesn't already exist. CREATE USER IF NOT EXISTS makes each
    // tier's user idempotent across runs instead of depending on the
    // container having been seeded by hand out of band.
    await bootstrapSeq.query(
      `CREATE USER IF NOT EXISTS '${MYSQL_RO_USER}'@'%' IDENTIFIED BY '${MYSQL_RO_PASS}';`
    );
    await bootstrapSeq.query(
      `GRANT SELECT ON \`${dbName}\`.* TO '${MYSQL_RO_USER}'@'%';`
    );
    await bootstrapSeq.query(
      `CREATE USER IF NOT EXISTS '${MYSQL_NODDL_USER}'@'%' IDENTIFIED BY '${MYSQL_NODDL_PASS}';`
    );
    await bootstrapSeq.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON \`${dbName}\`.* TO '${MYSQL_NODDL_USER}'@'%';`
    );
    await bootstrapSeq.query(
      `CREATE USER IF NOT EXISTS '${MYSQL_CREATEONLY_USER}'@'%' IDENTIFIED BY '${MYSQL_CREATEONLY_PASS}';`
    );
    await bootstrapSeq.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX ON \`${dbName}\`.* TO '${MYSQL_CREATEONLY_USER}'@'%';`
    );

    await bootstrapDb.unmount();
    await bootstrapSeq.close();
  }

  // Choose credentials based on tier
  let username, password;
  switch (tier) {
    case 'admin':
      username = MYSQL_ROOT_USER;
      password = MYSQL_ROOT_PASS;
      break;
    case 'readonly':
      username = MYSQL_RO_USER;
      password = MYSQL_RO_PASS;
      break;
    case 'no-ddl':
      username = MYSQL_NODDL_USER;
      password = MYSQL_NODDL_PASS;
      break;
    case 'create-only':
      username = MYSQL_CREATEONLY_USER;
      password = MYSQL_CREATEONLY_PASS;
      break;
    default:
      throw new Error(`Unknown MySQL tier: ${tier}`);
  }

  const sequelize = new Sequelize({
    dialect: 'mysql',
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    username,
    password,
    database: dbName,
    logging: false,
    define: { freezeTableName: true }
  });

  const dbService = new DBService({ sequelize, verboseLogger: () => {} });
  await dbService.mount();

  dbService._migrationEngine = new MigrationEngine({
    dbService,
    verboseLogger: () => {},
    backupDir: os.tmpdir()
  });

  return {
    sequelize,
    dbService,
    engine: dbService.migrationEngine,
    teardown: async () => {
      try { await dbService.unmount(); } catch { /* ignore */ }
      try { await sequelize.close(); } catch { /* ignore */ }
      // Drop the test database via admin reconnect
      try {
        const dropSeq = new Sequelize({
          dialect: 'mysql',
          host: MYSQL_HOST,
          port: MYSQL_PORT,
          username: MYSQL_ROOT_USER,
          password: MYSQL_ROOT_PASS,
          logging: false
        });
        await dropSeq.authenticate();
        await dropSeq.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
        await dropSeq.close();
      } catch { /* ignore */ }
    }
  };
}

// ── Postgres fixtures ────────────────────────────────────────────

async function createPostgresFixture(tier) {
  const dbName = `s3_mig_test_${tier}_${Date.now()}`;

  // Create the test database via admin connection
  const adminSeq = new Sequelize({
    dialect: 'postgres',
    host: PG_HOST,
    port: PG_PORT,
    username: PG_ADMIN_USER,
    password: PG_ADMIN_PASS,
    database: 'postgres',
    logging: false
  });
  await adminSeq.authenticate();
  await adminSeq.query(`CREATE DATABASE "${dbName}";`);
  await adminSeq.close();

  // For restricted tiers, bootstrap SchemaVersions table via admin first.
  // DBService.mount() calls sync() on SchemaVersions, which requires DDL
  // privileges that readonly/no-ddl users don't have. Also grant schema
  // permissions to the restricted users on this new database.
  if (tier !== 'admin') {
    const bootstrapSeq = new Sequelize({
      dialect: 'postgres',
      host: PG_HOST,
      port: PG_PORT,
      username: PG_ADMIN_USER,
      password: PG_ADMIN_PASS,
      database: dbName,
      logging: false,
      define: { freezeTableName: true }
    });
    const bootstrapDb = new DBService({ sequelize: bootstrapSeq, verboseLogger: () => {} });
    await bootstrapDb.mount();

    // Postgres has no CREATE ROLE IF NOT EXISTS — guard via pg_roles so this
    // is idempotent across runs, same reasoning as the MySQL fixture above.
    // Note: unlike MySQL, there is no Postgres "create-only" tier — a role
    // that creates a table OWNS it, and ownership grants full ALTER/INDEX
    // rights on that object regardless of what schema-level GRANTs it holds.
    // Confirmed empirically 2026-08-28: a role with only CREATE on the
    // schema could ALTER TABLE ADD COLUMN and CREATE INDEX on a table it
    // had just created, no separate ALTER grant needed. The CREATE-but-not-
    // ALTER asymmetry that broke LoggingService is a MySQL-specific
    // property of its global per-user grant model, not a general SQL one.
    await bootstrapSeq.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PG_RO_USER}') THEN
          CREATE ROLE "${PG_RO_USER}" LOGIN PASSWORD '${PG_RO_PASS}';
        END IF;
      END
      $$;
    `);
    await bootstrapSeq.query(`GRANT USAGE ON SCHEMA public TO "${PG_RO_USER}";`);
    await bootstrapSeq.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${PG_RO_USER}";`);

    await bootstrapSeq.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${PG_NODDL_USER}') THEN
          CREATE ROLE "${PG_NODDL_USER}" LOGIN PASSWORD '${PG_NODDL_PASS}';
        END IF;
      END
      $$;
    `);
    await bootstrapSeq.query(`GRANT USAGE ON SCHEMA public TO "${PG_NODDL_USER}";`);
    await bootstrapSeq.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${PG_NODDL_USER}";`);

    await bootstrapDb.unmount();
    await bootstrapSeq.close();
  }

  // Choose credentials based on tier
  let username, password;
  switch (tier) {
    case 'admin':
      username = PG_ADMIN_USER;
      password = PG_ADMIN_PASS;
      break;
    case 'readonly':
      username = PG_RO_USER;
      password = PG_RO_PASS;
      break;
    case 'no-ddl':
      username = PG_NODDL_USER;
      password = PG_NODDL_PASS;
      break;
    default:
      throw new Error(`Unknown Postgres tier: ${tier}`);
  }

  const sequelize = new Sequelize({
    dialect: 'postgres',
    host: PG_HOST,
    port: PG_PORT,
    username,
    password,
    database: dbName,
    logging: false,
    define: { freezeTableName: true }
  });

  const dbService = new DBService({ sequelize, verboseLogger: () => {} });
  await dbService.mount();

  dbService._migrationEngine = new MigrationEngine({
    dbService,
    verboseLogger: () => {},
    backupDir: os.tmpdir()
  });

  return {
    sequelize,
    dbService,
    engine: dbService.migrationEngine,
    teardown: async () => {
      try { await dbService.unmount(); } catch { /* ignore */ }
      try { await sequelize.close(); } catch { /* ignore */ }
      // Drop the test database via admin reconnect
      try {
        const dropSeq = new Sequelize({
          dialect: 'postgres',
          host: PG_HOST,
          port: PG_PORT,
          username: PG_ADMIN_USER,
          password: PG_ADMIN_PASS,
          database: 'postgres',
          logging: false
        });
        await dropSeq.authenticate();
        await dropSeq.query(`DROP DATABASE IF EXISTS "${dbName}";`);
        await dropSeq.close();
      } catch { /* ignore */ }
    }
  };
}


// ---------------------------------------------------------------------------
// Test helper — run a CREATE TABLE migration and assert outcome
// ---------------------------------------------------------------------------

/**
 * Register and run a single CREATE TABLE migration against a fixture,
 * asserting the expected outcome.
 *
 * @param {Object} harness - From createFixture()
 * @param {boolean} expectSuccess - True if migration should succeed
 */
async function runCreateTableTest(harness, expectSuccess) {
  const { engine, sequelize } = harness;

  engine.registerMigrations('test-perm', [
    {
      version: 1,
      description: 'Create TestTable for permission test',
      touches: {
        creates: ['TestTable'],
        columns: { TestTable: ['id', 'name'] }
      },
      up: async (qi) => {
        await qi.createTable('TestTable', {
          id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          name: { type: DataTypes.STRING, allowNull: false }
        });
      }
    }
  ]);

  engine.confirmToken('__auto__');

  if (expectSuccess) {
    const result = await engine.runMigrations('test-perm');
    assert.equal(result.applied, 1, 'migration should be applied');

    const qi = sequelize.getQueryInterface();
    const tables = await qi.showAllTables();
    assert.ok(hasTable(tables, 'TestTable'), `TestTable should exist in DB — found: ${tables.join(', ')}`);
  } else {
    let rejected = false;
    try {
      await engine.runMigrations('test-perm');
    } catch {
      rejected = true;
    }
    assert.ok(rejected, 'runMigrations() should reject on restricted permissions');

    // Verify table was NOT created
    const qi = sequelize.getQueryInterface();
    const tables = await qi.showAllTables();
    assert.ok(!hasTable(tables, 'TestTable'), `TestTable must NOT exist after failed migration — found: ${tables.join(', ')}`);
  }
}

/**
 * Regression test for the LoggingService index-via-ALTER bug (2026-08-28,
 * see s3/S3_DEVELOPER_GUIDE.md §11.4): Model.sync()/qi.addIndex() emit
 * ALTER TABLE ... ADD INDEX even for an index on a table just created,
 * which the create-only grant rejects. Proves the safe pattern
 * (createTable + a bare CREATE INDEX statement) works under that grant,
 * and that the unsafe pattern (qi.addIndex(), still ALTER-based) does not
 * — the negative case is what makes the positive case meaningful evidence
 * rather than a coincidence of this particular table.
 */
async function runIndexViaAlterTest(harness) {
  const { engine, sequelize, dbService } = harness;
  const qi = sequelize.getQueryInterface();

  engine.registerMigrations('test-index-perm', [
    {
      version: 1,
      description: 'Create IndexTestTable, then index it without ALTER',
      touches: { creates: ['IndexTestTable'], columns: { IndexTestTable: ['id', 'name'] } },
      up: async (qi) => {
        await qi.createTable('IndexTestTable', {
          id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          name: { type: DataTypes.STRING, allowNull: false }
        });
        const q = (id) => dbService.quoteIdentifier(id);
        await sequelize.query(`CREATE INDEX ${q('idx_itt_name')} ON ${q('IndexTestTable')} (${q('name')})`);
      }
    }
  ]);
  engine.confirmToken('__auto__');

  const result = await engine.runMigrations('test-index-perm');
  assert.equal(result.applied, 1, 'createTable + bare CREATE INDEX should succeed under create-only grant');

  const indexesAfterCreate = await qi.showIndex('IndexTestTable');
  assert.ok(
    indexesAfterCreate.some((i) => i.name === 'idx_itt_name'),
    'index should exist after bare CREATE INDEX'
  );

  let alterRejected = false;
  try {
    await qi.addIndex('IndexTestTable', ['id'], { name: 'idx_itt_id_via_alter' });
  } catch {
    alterRejected = true;
  }
  assert.ok(
    alterRejected,
    'qi.addIndex() (ALTER-based) must be rejected under create-only grant, or this fixture no longer matches the live profile'
  );
}

/**
 * Regression test for migration-engine.js's describePermissionError():
 * when a migration fails specifically because the DB user lacks a
 * privilege — not because of a bug in the migration itself — that
 * distinction must be visible in err.message, the one field every caller
 * (Discord's failEmbed, stderr, verboseLogger) actually reads. Without it,
 * an admin sees only the raw driver string ("ALTER command denied...") and
 * has to already know that means "go check GRANTs" rather than "this
 * migration is broken." create-only is the only tier that reproduces the
 * real failure mode cleanly: createTable succeeds (CREATE is granted) so
 * addColumn is reached and fails on ALTER specifically, rather than the
 * whole up() dying on the first statement the way it does under readonly.
 */
async function runPermissionGuidanceTest(harness) {
  const { engine } = harness;

  engine.registerMigrations('test-perm-guidance', [
    {
      version: 1,
      description: 'Create GuidanceTable, then add a column — the column add requires ALTER, which create-only lacks',
      touches: { creates: ['GuidanceTable'], columns: { GuidanceTable: ['id', 'extra'] } },
      up: async (qi) => {
        await qi.createTable('GuidanceTable', {
          id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true }
        });
        await qi.addColumn('GuidanceTable', 'extra', { type: DataTypes.STRING });
      }
    }
  ]);
  engine.confirmToken('__auto__');

  let caughtErr = null;
  try {
    await engine.runMigrations('test-perm-guidance');
  } catch (err) {
    caughtErr = err;
  }
  assert.ok(caughtErr, 'migration should fail — create-only lacks ALTER');
  assert.match(
    caughtErr.message, /database-permissions problem/i,
    `expected permission guidance appended to the error, got: ${caughtErr.message}`
  );
  assert.match(
    caughtErr.message, /ALTER/,
    `expected the specific missing privilege named in the guidance, got: ${caughtErr.message}`
  );
}

/**
 * probeDdlGrants() answers "what can this user actually do?" by trying it,
 * rather than by parsing SHOW GRANTS — grants arrive through roles, wildcards
 * and inheritance, so the text of a grant statement predicts little.
 *
 * These fixtures are the one place in the repo where the true answer is known
 * independently: each tier's GRANT is written out a few hundred lines up. So
 * this compares the probe against that, tier by tier. Anywhere else the probe
 * would only be able to agree with itself.
 *
 * @param {object} harness
 * @param {{create: boolean, index: boolean, alter: boolean, drop: boolean}} expected
 */
async function runDdlGrantProbeTest(harness, expected) {
  const { dbService } = harness;

  const grants = await dbService.probeDdlGrants();
  const seen = `create=${grants.create} index=${grants.index} alter=${grants.alter} drop=${grants.drop}`;

  assert.equal(grants.dialect, 'mysql', 'the probe must report the connected dialect');
  assert.equal(grants.create, expected.create, `CREATE mismatch — probe said ${seen}`);
  assert.equal(grants.index, expected.index, `INDEX mismatch — probe said ${seen}`);
  assert.equal(grants.alter, expected.alter, `ALTER mismatch — probe said ${seen}`);
  assert.equal(grants.drop, expected.drop, `DROP mismatch — probe said ${seen}`);

  // A refusal has to arrive with the driver's reason attached. A bare `false`
  // tells an operator that something is missing without telling them what, and
  // this is the object the pre-flight message is built from.
  for (const key of ['create', 'index', 'alter', 'drop']) {
    if (expected[key]) continue;
    assert.ok(
      typeof grants.errors[key] === 'string' && grants.errors[key].length > 0,
      `a refused ${key} must carry the driver's reason — got ${JSON.stringify(grants.errors)}`
    );
  }

  // Cached for the mount. The probe issues real DDL, so re-probing on every
  // caller would mean creating and dropping a table on a live server whenever
  // anything asked a question about grants.
  const again = await dbService.probeDdlGrants();
  assert.equal(again.probedAt, grants.probedAt, 'repeat calls must return the cached probe, not re-issue DDL');
  const forced = await dbService.probeDdlGrants({ force: true });
  assert.equal(forced.create, expected.create, 'a forced re-probe must reach the same conclusion');
}

/**
 * `!s3 migrate ddl` exists because on the live grant a column-adding migration
 * cannot be applied by the plugin at all — CREATE is granted, ALTER is not. The
 * command renders the statements so an operator can run them as a user that
 * does hold the grant, and then record the version.
 *
 * The only evidence that is worth anything here is execution. Reading the
 * emitted SQL back and asserting it looks right would re-derive the generator's
 * own opinion of what is correct; running it asks the database. So this walks
 * the whole operator path: fail under the real grant, generate, execute, re-run,
 * and confirm the version is recorded and the objects are actually there.
 *
 * The split of who executes what is deliberate. The ADD COLUMN goes to an admin
 * connection, because that is the situation — the operator has escalated. The
 * CREATE INDEX statements go to the RESTRICTED connection, because the generator
 * claims they are bare `CREATE INDEX` rather than the `ALTER TABLE ... ADD
 * INDEX` that Sequelize's own addIndexQuery() emits on MySQL. Running them under
 * the create-only grant is what proves that claim; a regex on the emitted text
 * would only restate it.
 */
async function runHandApplyDdlTest(harness) {
  const { engine, sequelize, dbService } = harness;
  const qi = sequelize.getQueryInterface();

  // The model carries the FINISHED shape — the column v2 adds and the index
  // that goes with it. buildHandApplyDdl() renders from rawAttributes, so this
  // is the same definition the migration itself would have applied.
  dbService.defineModel('HandApplyTable', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false },
    addedByHand: { type: DataTypes.INTEGER, allowNull: true }
  }, {
    tableName: 'HandApplyTable',
    timestamps: false,
    exportTier: 'ephemeral',
    indexes: [{ name: 'idx_hat_added', fields: ['addedByHand'] }]
  });

  engine.registerMigrations('test-handapply', [
    {
      version: 1,
      description: 'Create HandApplyTable',
      backup: false,
      touches: { creates: ['HandApplyTable'], columns: { HandApplyTable: ['id', 'name'] } },
      up: async (q) => {
        await q.createTable('HandApplyTable', {
          id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          name: { type: DataTypes.STRING, allowNull: false }
        });
      }
    },
    {
      version: 2,
      description: 'Add addedByHand and its index',
      backup: false,
      touches: { columns: { HandApplyTable: ['addedByHand'] } },
      // Idempotent, which is the house pattern and is also what makes the
      // hand-apply route work at all: once the operator has run the DDL, this
      // re-runs as a no-op and the version gets recorded.
      up: async (q) => {
        const desc = await q.describeTable('HandApplyTable');
        if (!Object.keys(desc).some((c) => c.toLowerCase() === 'addedbyhand')) {
          await q.addColumn('HandApplyTable', 'addedByHand', { type: DataTypes.INTEGER, allowNull: true });
        }
        await dbService.ensureIndexes('HandApplyTable', [{ name: 'idx_hat_added', fields: ['addedByHand'] }]);
      }
    }
  ]);
  dbService.registerExpectedVersion('test-handapply', 2, { models: ['HandApplyTable'] });

  engine.confirmToken('__auto__');
  let failure = null;
  try {
    await engine.runMigrations('test-handapply');
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, 'v2 must fail under create-only, or this fixture no longer reproduces the live grant');
  assert.match(failure.message, /ALTER/, `expected an ALTER-privilege failure, got: ${failure.message}`);

  const before = await dbService.verifySchemaVersions();
  assert.ok(
    before.pending.some((x) => x.pluginName === 'test-handapply'),
    'test-handapply must still read as pending after the ALTER failure'
  );

  const generated = await engine.buildHandApplyDdl({ pluginName: 'test-handapply' });
  assert.equal(generated.dialect, 'mysql', 'DDL must be rendered for the connected dialect');

  const columnStatements = generated.statements.filter((x) => x.kind === 'column');
  const indexStatements = generated.statements.filter((x) => x.kind === 'index');
  const rendered = JSON.stringify(generated.statements.map((x) => x.sql));

  assert.ok(
    !generated.statements.some((x) => x.kind === 'table'),
    `HandApplyTable already exists, so no CREATE TABLE should be emitted — got ${rendered}`
  );
  assert.equal(columnStatements.length, 1, `expected exactly one ADD COLUMN — got ${rendered}`);
  assert.match(columnStatements[0].sql, /addedByHand/, `the emitted column statement must name the missing column — got ${rendered}`);
  assert.equal(indexStatements.length, 1, `the declared index is missing and must be emitted — got ${rendered}`);

  // The operator escalates for the ALTER...
  const adminSeq = new Sequelize({
    dialect: 'mysql',
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    username: MYSQL_ROOT_USER,
    password: MYSQL_ROOT_PASS,
    database: sequelize.config.database,
    logging: false
  });
  try {
    for (const st of columnStatements) await adminSeq.query(st.sql);
  } finally {
    await adminSeq.close();
  }

  // ...and does not need to for the indexes.
  for (const st of indexStatements) await sequelize.query(st.sql);

  engine.confirmToken('__auto__');
  const rerun = await engine.runMigrations('test-handapply');
  assert.ok(rerun.applied >= 1, `re-running after the hand-apply should record v2 — got ${JSON.stringify(rerun)}`);

  const after = await dbService.verifySchemaVersions();
  assert.ok(
    !after.pending.some((x) => x.pluginName === 'test-handapply'),
    'the version must be recorded once the hand-applied DDL is in place'
  );

  const desc = await qi.describeTable('HandApplyTable');
  assert.ok(
    Object.keys(desc).some((c) => c.toLowerCase() === 'addedbyhand'),
    `the hand-applied column must really exist — got ${Object.keys(desc).join(', ')}`
  );
  const indexes = await qi.showIndex('HandApplyTable');
  assert.ok(
    indexes.some((i) => i.name === 'idx_hat_added'),
    `the hand-applied index must really exist — got ${indexes.map((i) => i.name).join(', ')}`
  );
}

/**
 * A column a migration adds that the CURRENT model no longer declares.
 *
 * This is the gap the other hand-apply tests structurally cannot see: their
 * fixtures put every touched column on the model, so `rawAttributes` always has
 * a type to render. Real chains diverge from their models. Switch v3 adds
 * `seedPresenceStart` to `SwitchPlugin_PlayerCooldowns`, v7 supersedes it with
 * `SwitchPlugin_PlayerServerState`, and no *up* ever drops the column — so a
 * live v9 table carries a column no model declares, whose type exists only
 * inside the migration body.
 *
 * Found on a live create-only MySQL grant 2026-09-07. The generated script
 * applied cleanly, `migrate force` was re-run, and it failed with the identical
 * ALTER denial on a column the script never mentioned. The operator's only
 * signal was a note phrased as a `touches`-authoring suspicion, sitting under a
 * heading that says anything already present is left out — which reads as
 * completeness.
 *
 * So this asserts the generator OWNS UP. It does not assert the column is
 * rendered: it cannot be, without reading the migration body. Rendering it is a
 * separate change, and when that lands this test should flip to asserting the
 * statement rather than the confession.
 */
async function runHandApplyIncompleteTest(harness) {
  const { engine, dbService } = harness;

  // The model is the FINISHED shape and deliberately omits `supersededCol`,
  // exactly as SwitchPlugin_PlayerCooldowns omits seedPresenceStart today.
  dbService.defineModel('HandApplyLegacy', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: false }
  }, {
    tableName: 'HandApplyLegacy',
    timestamps: false,
    exportTier: 'ephemeral'
  });

  engine.registerMigrations('test-handapply-legacy', [
    {
      version: 1,
      description: 'Create HandApplyLegacy',
      backup: false,
      touches: { creates: ['HandApplyLegacy'], columns: { HandApplyLegacy: ['id', 'name'] } },
      up: async (q) => {
        await q.createTable('HandApplyLegacy', {
          id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          name: { type: DataTypes.STRING, allowNull: false }
        });
      }
    },
    {
      version: 2,
      description: 'Add supersededCol — a column the model does not carry',
      backup: false,
      touches: { columns: { HandApplyLegacy: ['supersededCol'] } },
      // Stands in for the denied ALTER. What matters downstream is the state it
      // leaves: the table exists, the column does not, and v2 reads as pending.
      up: async () => {
        throw new Error("ALTER command denied to user 'fixture'@'localhost' for table 'HandApplyLegacy'");
      }
    }
  ]);
  dbService.registerExpectedVersion('test-handapply-legacy', 2, { models: ['HandApplyLegacy'] });

  engine.confirmToken('__auto__');
  let failure = null;
  try {
    await engine.runMigrations('test-handapply-legacy');
  } catch (err) {
    failure = err;
  }
  assert.ok(failure, 'v2 must fail, or this fixture no longer reproduces the denied ALTER');

  const status = await dbService.verifySchemaVersions();
  assert.ok(
    status.pending.some((x) => x.pluginName === 'test-handapply-legacy'),
    'test-handapply-legacy must still read as pending after the failure'
  );

  const generated = await engine.buildHandApplyDdl({ pluginName: 'test-handapply-legacy' });
  const rendered = JSON.stringify(generated.statements.map((x) => x.sql));

  assert.ok(
    !generated.statements.some((x) => /supersededCol/i.test(x.sql)),
    `the column is not on the model, so it cannot be rendered — got ${rendered}`
  );

  assert.ok(
    Array.isArray(generated.incomplete) && generated.incomplete.length > 0,
    'a script that cannot render a needed column must report itself incomplete'
  );
  const gap = generated.incomplete.find((x) => x.column === 'supersededCol');
  assert.ok(
    gap,
    `the gap must name the column an operator has to add by hand — got ${JSON.stringify(generated.incomplete)}`
  );
  assert.equal(gap.table, 'HandApplyLegacy', 'the gap must name the table the column belongs to');
  assert.equal(gap.pluginName, 'test-handapply-legacy', 'the gap must name the plugin whose migration needs it');
  assert.equal(gap.version, 2, 'the gap must name the migration version that will still fail');

  // The note has to predict the consequence, not just describe the symptom —
  // an operator who reads "will still fail" stops and escalates instead of
  // spending a diagnostic cycle rediscovering it.
  const note = generated.notes.find((n) => n.includes('supersededCol'));
  assert.ok(note, `a note must name the unrenderable column — got ${JSON.stringify(generated.notes)}`);
  assert.match(
    note,
    /still fail/i,
    `the note must say the migration still fails after applying the script — got: ${note}`
  );
}

/**
 * The other half of the generator: a table that does not exist yet, so the
 * CREATE TABLE branch renders and runs rather than being skipped as present.
 * SQLite carries this one because it needs no Docker and the branch under test
 * is dialect-independent — what varies by dialect is the rendering, and that
 * comes from Sequelize's own generator either way.
 */
async function runHandApplyDdlCreateTest(harness) {
  const { engine, sequelize, dbService } = harness;
  const qi = sequelize.getQueryInterface();

  dbService.defineModel('HandApplyFresh', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    label: { type: DataTypes.STRING, allowNull: false }
  }, {
    tableName: 'HandApplyFresh',
    timestamps: false,
    exportTier: 'ephemeral',
    indexes: [{ name: 'idx_haf_label', fields: ['label'] }]
  });

  engine.registerMigrations('test-handapply-fresh', [
    {
      version: 1,
      description: 'Create HandApplyFresh and index it',
      backup: false,
      touches: { creates: ['HandApplyFresh'], columns: { HandApplyFresh: ['id', 'label'] } },
      up: async (q) => {
        await q.createTable('HandApplyFresh', {
          id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
          label: { type: DataTypes.STRING, allowNull: false }
        });
        await dbService.ensureIndexes('HandApplyFresh', [{ name: 'idx_haf_label', fields: ['label'] }]);
      }
    }
  ]);
  dbService.registerExpectedVersion('test-handapply-fresh', 1, { models: ['HandApplyFresh'] });

  const generated = await engine.buildHandApplyDdl({ pluginName: 'test-handapply-fresh' });
  const rendered = JSON.stringify(generated.statements.map((x) => x.sql));
  assert.equal(
    generated.statements.filter((x) => x.kind === 'table').length, 1,
    `the absent table must be emitted as CREATE TABLE — got ${rendered}`
  );
  assert.equal(
    generated.statements.filter((x) => x.kind === 'index').length, 1,
    `a new table's declared index is missing by definition and must be emitted — got ${rendered}`
  );

  // Exactly what an operator would paste, in the order it was handed to them.
  for (const st of generated.statements) await sequelize.query(st.sql);

  const tables = await qi.showAllTables();
  assert.ok(hasTable(tables, 'HandApplyFresh'), `emitted CREATE TABLE did not produce the table — found: ${tables.join(', ')}`);
  const indexes = await qi.showIndex('HandApplyFresh');
  assert.ok(
    indexes.some((i) => i.name === 'idx_haf_label'),
    `emitted CREATE INDEX did not produce the index — found: ${indexes.map((i) => i.name).join(', ')}`
  );

  // And the migration still runs clean over the hand-applied objects, which is
  // the step that records the version.
  engine.confirmToken('__auto__');
  await engine.runMigrations('test-handapply-fresh');
  const after = await dbService.verifySchemaVersions();
  assert.ok(
    !after.pending.some((x) => x.pluginName === 'test-handapply-fresh'),
    'the version must be recorded once the hand-applied DDL is in place'
  );
}

/**
 * Same guidance-enrichment contract as runPermissionGuidanceTest, exercised
 * against Postgres's SQLSTATE 42501 shape instead of MySQL's ER_*ACCESS_DENIED
 * family — confirms describePermissionError() doesn't just happen to work on
 * whichever dialect motivated it. readonly is sufficient here (no create-only
 * tier exists for Postgres — see the comment in createPostgresFixture): a bare
 * createTable already fails on "permission denied for schema public".
 */
async function runPostgresPermissionGuidanceTest(harness) {
  const { engine } = harness;

  engine.registerMigrations('test-pg-perm-guidance', [
    {
      version: 1,
      description: 'Create a table under a role with no CREATE on the schema',
      touches: { creates: ['PgGuidanceTable'] },
      up: async (qi) => {
        await qi.createTable('PgGuidanceTable', {
          id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true }
        });
      }
    }
  ]);
  engine.confirmToken('__auto__');

  let caughtErr = null;
  try {
    await engine.runMigrations('test-pg-perm-guidance');
  } catch (err) {
    caughtErr = err;
  }
  assert.ok(caughtErr, 'migration should fail — readonly role has no CREATE on the schema');
  assert.match(
    caughtErr.message, /database-permissions problem/i,
    `expected permission guidance appended to the error, got: ${caughtErr.message}`
  );
}


// ---------------------------------------------------------------------------
// Test registration — per reachable (dialect, tier)
// ---------------------------------------------------------------------------

const DIALECTS = [
  { name: 'sqlite', reachable: true },
  { name: 'mysql', reachable: false },  // set after probe
  { name: 'postgres', reachable: false } // set after probe
];

// 'create-only' is a normal least-privilege MySQL grant (CREATE/INDEX but
// no ALTER/DROP) — see MYSQL_CREATEONLY_USER above.
// SQLite has no real per-user grant model (file permissions are binary:
// read-only or read-write, so "CREATE but not ALTER" can't be expressed).
// Postgres's ownership model means this tier can't be reproduced there
// either — see the comment in createPostgresFixture.
const TIERS = ['admin', 'readonly', 'no-ddl', 'create-only'];

// Register tests after probing reachability
async function registerTests() {
  await probeReachability();

  DIALECTS[1].reachable = mysqlReachable;
  DIALECTS[2].reachable = postgresReachable;

  for (const dialect of DIALECTS) {
    if (!dialect.reachable) continue;

    for (const tier of TIERS) {
      // SQLite only has admin and readonly tiers
      if (dialect.name === 'sqlite' && tier === 'no-ddl') continue;
      if (dialect.name === 'sqlite' && tier === 'create-only') continue;
      if (dialect.name === 'postgres' && tier === 'create-only') continue;

      // A bare CREATE TABLE (no indexes) only needs the CREATE privilege,
      // so create-only is expected to succeed here same as admin — the
      // tier's whole point is that CREATE succeeds while ALTER doesn't,
      // which the dedicated index-via-ALTER test below actually exercises.
      const expectSuccess = tier === 'admin' || tier === 'create-only';
      const outcome = expectSuccess ? 'resolves' : 'rejected';

      test(`${dialect.name} ${tier}: CREATE TABLE ${outcome}`, async () => {
        let harness;
        try {
          harness = await createFixture(dialect.name, tier);
        } catch (err) {
          if (err.code === 'SKIP_SQLITE_RO_WIN32') {
            // (skip is signaled via SkipTest, no direct console.log needed)
            throw new SkipTest(err.message);
          }
          throw err;
        }
        try {
          await runCreateTableTest(harness, expectSuccess);
        } finally {
          await harness.teardown();
        }
      });
    }
  }

  if (mysqlReachable) {
    test('mysql create-only: bare CREATE INDEX succeeds, ALTER-based addIndex is rejected', async () => {
      const harness = await createFixture('mysql', 'create-only');
      try {
        await runIndexViaAlterTest(harness);
      } finally {
        await harness.teardown();
      }
    });

    test('mysql create-only: a missing-ALTER failure carries permission guidance in the error message', async () => {
      const harness = await createFixture('mysql', 'create-only');
      try {
        await runPermissionGuidanceTest(harness);
      } finally {
        await harness.teardown();
      }
    });

    test('mysql create-only: emitted hand-apply DDL executes and unblocks the migration', async () => {
      const harness = await createFixture('mysql', 'create-only');
      try {
        await runHandApplyDdlTest(harness);
      } finally {
        await harness.teardown();
      }
    });

    test('mysql admin: the DDL grant probe reports every privilege', async () => {
      const harness = await createFixture('mysql', 'admin');
      try {
        await runDdlGrantProbeTest(harness, { create: true, index: true, alter: true, drop: true });
      } finally {
        await harness.teardown();
      }
    });

    test('mysql create-only: the DDL grant probe finds CREATE and INDEX but not ALTER or DROP', async () => {
      const harness = await createFixture('mysql', 'create-only');
      try {
        await runDdlGrantProbeTest(harness, { create: true, index: true, alter: false, drop: false });
      } finally {
        await harness.teardown();
      }
    });

    test('mysql no-ddl: the DDL grant probe finds no CREATE at all', async () => {
      const harness = await createFixture('mysql', 'no-ddl');
      try {
        // CREATE fails first, so the probe returns without attempting the rest —
        // there is no table to index, alter or drop. The three false answers are
        // therefore "not established", and the errors object says so by carrying
        // only the create key.
        const grants = await harness.dbService.probeDdlGrants();
        assert.equal(grants.create, false, `no-ddl must not be able to CREATE — got ${JSON.stringify(grants)}`);
        assert.ok(
          typeof grants.errors.create === 'string' && grants.errors.create.length > 0,
          `the CREATE refusal must carry the driver's reason — got ${JSON.stringify(grants.errors)}`
        );
        assert.equal(grants.index, false);
        assert.equal(grants.alter, false);
        assert.equal(grants.drop, false);
      } finally {
        await harness.teardown();
      }
    });
  }

  test('sqlite admin: emitted hand-apply DDL creates the missing table and its index', async () => {
    const harness = await createFixture('sqlite', 'admin');
    try {
      await runHandApplyDdlCreateTest(harness);
    } finally {
      await harness.teardown();
    }
  });

  // SQLite because the branch is dialect-independent: what varies by dialect is
  // the rendering, and the point here is that nothing renders at all.
  test('sqlite admin: hand-apply DDL reports itself incomplete for a column the model no longer carries', async () => {
    const harness = await createFixture('sqlite', 'admin');
    try {
      await runHandApplyIncompleteTest(harness);
    } finally {
      await harness.teardown();
    }
  });

  if (postgresReachable) {
    test('postgres readonly: a missing-CREATE failure carries permission guidance in the error message', async () => {
      const harness = await createFixture('postgres', 'readonly');
      try {
        await runPostgresPermissionGuidanceTest(harness);
      } finally {
        await harness.teardown();
      }
    });
  }
}


// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await registerTests();
await run();