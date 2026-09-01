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
    assert.ok(tables.includes('TestTable'), 'TestTable should exist in DB');
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
    assert.ok(!tables.includes('TestTable'), 'TestTable must NOT exist after failed migration');
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
  }

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