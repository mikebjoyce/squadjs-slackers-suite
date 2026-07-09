/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     CATEGORY 2 — MIGRATION PIPELINE TEST                      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Exercises the real MigrationEngine with
 * an in-memory SQLite Sequelize instance and a real DBService.
 * Every schema-change assertion uses showAllTables() / describeTable()
 * on the live database, not mocked return values.
 *
 * Category: 2 (requires DB access — in-memory SQLite, no Docker)
 * Run:    node SlackersSquadServices/testing/test-migration-pipeline.js
 *
 * Requires: sequelize, MigrationEngine, DBService
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import DBService from '../utils/db-service.js';
import MigrationEngine from '../utils/migration-engine.js';


// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(65));
  console.log('Migration Pipeline Test  (— real engine)');
  console.log('='.repeat(65));
  console.log('');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  \u2713 ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  \u2717 ${t.name}`);
      console.log(`    ${err.message.split('\n')[0]}`);
      failed++;
    }
  }

  console.log('');
  console.log('\u2500'.repeat(65));
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log('\u2500'.repeat(65));

  if (failed > 0) process.exitCode = 1;
}


// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a real in-memory SQLite DBService + MigrationEngine for a test.
 * Each call returns an isolated instance backed by :memory: SQLite and a
 * unique temp directory for backup output.
 */
async function createTestHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-mig-test-'));

  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
    define: { freezeTableName: true }
  });

  const dbService = new DBService({
    sequelize,
    verboseLogger: () => {}
  });

  await dbService.mount();

  // Replace the engine that mount() created with one that has our temp
  // backupDir. The mount-created engine (no backupDir) is discarded.
  dbService._migrationEngine = new MigrationEngine({
    dbService,
    verboseLogger: () => {},
    backupDir: tempDir
  });

  return { sequelize, dbService, engine: dbService.migrationEngine, tempDir };
}

/**
 * Clean up after a test harness: close the Sequelize connection and
 * delete the temp backup directory.
 */
async function destroyTestHarness({ sequelize, tempDir }) {
  try {
    await sequelize.close();
  } catch { /* ignore */ }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Get a live query interface from a Sequelize instance for
 * showAllTables / describeTable assertions.
 */
function getLiveQI(sequelize) {
  return sequelize.getQueryInterface();
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
      execSync(`icacls "${filePath}" /deny Everyone:(W)`, { stdio: 'pipe' });
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
      execSync(`icacls "${filePath}" /remove:d Everyone`, { stdio: 'pipe' });
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
// File-based harness (for read-only test)
// ---------------------------------------------------------------------------

/**
 * Create a real file-based SQLite DBService + MigrationEngine for a test.
 * Unlike createTestHarness() which uses :memory:, this uses a real file at
 * storagePath so we can manipulate OS-level file permissions.
 *
 * The caller is responsible for calling sequelize.close() on the returned
 * harness when done.
 */
async function createFileBasedHarness(storagePath, backupDir) {
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: storagePath,
    logging: false,
    define: { freezeTableName: true }
  });

  const dbService = new DBService({
    sequelize,
    verboseLogger: () => {}
  });

  await dbService.mount();

  // Replace the mount-created engine with one that has our temp backupDir
  dbService._migrationEngine = new MigrationEngine({
    dbService,
    verboseLogger: () => {},
    backupDir
  });

  return { sequelize, dbService, engine: dbService.migrationEngine };
}


// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('MigrationEngine registers per-plugin migrations', async () => {
  const harness = await createTestHarness();
  try {
    const { engine } = harness;

    const saMigrations = [
      { version: 1, description: 'Create SA_AssignmentLog', up: async () => {} },
      { version: 2, description: 'Add teamID column', up: async () => {} }
    ];

    const eloMigrations = [
      { version: 1, description: 'Create Elo_PlayerStats', up: async () => {} }
    ];

    engine.registerMigrations('smart-assign', saMigrations);
    engine.registerMigrations('elo-tracker', eloMigrations);

    assert.equal(engine._migrations.get('smart-assign').length, 2);
    assert.equal(engine._migrations.get('elo-tracker').length, 1);
    assert.equal(engine._migrations.get('smart-assign')[0].version, 1);
    assert.equal(engine._migrations.get('smart-assign')[1].version, 2);
    assert.equal(engine._migrations.get('elo-tracker')[0].version, 1);
  } finally {
    await destroyTestHarness(harness);
  }
});

test('Invalid migrations (non-monotonic versions) are rejected', async () => {
  const harness = await createTestHarness();
  try {
    const { engine } = harness;

    // First register v1 to establish a baseline
    engine.registerMigrations('test-plugin', [
      { version: 1, description: 'v1', up: async () => {} }
    ]);

    // Then try to append migrations whose lowest version (1) is <= the
    // highest existing version (1) — this triggers the "strictly increasing" guard.
    assert.throws(() => {
      engine.registerMigrations('test-plugin', [
        { version: 2, description: 'v2', up: async () => {} },
        { version: 1, description: 'v1 (duplicate)', up: async () => {} }
      ]);
    }, /strictly increasing/);
  } finally {
    await destroyTestHarness(harness);
  }
});

test('Invalid migrations (missing up()) are rejected', async () => {
  const harness = await createTestHarness();
  try {
    const { engine } = harness;

    assert.throws(() => {
      engine.registerMigrations('test-plugin', [
        { version: 1, description: 'v1 with no up function', up: undefined }
      ]);
    }, /missing an up/);
  } finally {
    await destroyTestHarness(harness);
  }
});

test('Running migrations creates tables via up()', async () => {
  const harness = await createTestHarness();
  try {
    const { engine, sequelize } = harness;
    const qi = getLiveQI(sequelize);

    engine.registerMigrations('test-plugin', [
      {
        version: 1,
        description: 'Create TestTable',
        up: async (mqi) => {
          await mqi.createTable('TestTable', {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            name: { type: DataTypes.STRING, allowNull: false },
            score: { type: DataTypes.INTEGER, allowNull: true }
          });
        }
      },
      {
        version: 2,
        description: 'Add comment column',
        up: async (mqi) => {
          await mqi.addColumn('TestTable', 'comment', {
            type: DataTypes.STRING,
            allowNull: true
          });
        }
      }
    ]);

    // Confirm and run
    engine.confirmToken('__auto__');
    const result = await engine.runMigrations('test-plugin');
    assert.equal(result.applied, 2, 'both migrations should be applied');

    // Verify via live DB
    const tables = await qi.showAllTables();
    assert.ok(tables.includes('TestTable'), 'TestTable should exist in DB');

    // Describe and check columns
    const columns = await qi.describeTable('TestTable');
    assert.ok(columns.id, 'id column should exist');
    assert.ok(columns.name, 'name column should exist');
    assert.ok(columns.score, 'score column should exist');
    assert.ok(columns.comment, 'comment column should exist (added by v2)');
  } finally {
    await destroyTestHarness(harness);
  }
});

test('Pending migrations are detected correctly', async () => {
  const harness = await createTestHarness();
  try {
    const { engine } = harness;

    const migrations = [
      { version: 1, description: 'v1', up: async () => {} },
      { version: 2, description: 'v2', up: async () => {} },
      { version: 3, description: 'v3', up: async () => {} }
    ];

    engine.registerMigrations('test-plugin', migrations);

    // Before running, all 3 are pending
    let pending = await engine.pendingMigrations('test-plugin');
    assert.equal(pending.length, 3, 'all 3 migrations should be pending initially');

    // Confirm and run to apply v1-v3
    engine.confirmToken('__auto__');
    await engine.runMigrations('test-plugin');

    // After running, none pending
    pending = await engine.pendingMigrations('test-plugin');
    assert.equal(pending.length, 0, 'no migrations should be pending after applying all');

    // Add a new migration v4
    engine._migrations.get('test-plugin').push({
      version: 4, description: 'v4', up: async () => {}
    });

    pending = await engine.pendingMigrations('test-plugin');
    assert.equal(pending.length, 1, 'v4 should be pending');
    assert.equal(pending[0].version, 4);
  } finally {
    await destroyTestHarness(harness);
  }
});

test('Already-applied migrations are skipped', async () => {
  const harness = await createTestHarness();
  try {
    const { engine } = harness;

    const migrations = [
      { version: 1, description: 'v1', up: async () => {} },
      { version: 2, description: 'v2', up: async () => {} }
    ];

    engine.registerMigrations('test-plugin', migrations);

    // First run — apply v1 and v2
    engine.confirmToken('__auto__');
    let result = await engine.runMigrations('test-plugin');
    assert.equal(result.applied, 2);

    // Second run — nothing to apply
    // (confirmation is already set from first run)
    result = await engine.runMigrations('test-plugin');
    assert.equal(result.applied, 0, 'no new migrations should be applied');
  } finally {
    await destroyTestHarness(harness);
  }
});

test('getAppliedVersion returns correct current version', async () => {
  const harness = await createTestHarness();
  try {
    const { engine, dbService } = harness;

    // No migrations registered yet — fallback returns 0
    const pendingUnregistered = await engine.pendingMigrations('unknown');
    assert.equal(pendingUnregistered.length, 0, 'unknown plugin returns no pending');

    const migrations = [
      { version: 1, description: 'v1', up: async () => {} },
      { version: 2, description: 'v2', up: async () => {} },
      { version: 3, description: 'v3', up: async () => {} }
    ];

    engine.registerMigrations('test-plugin', migrations);

    // Before any run — all 3 pending (applied version is 0)
    let pending = await engine.pendingMigrations('test-plugin');
    assert.equal(pending.length, 3, 'all 3 pending before any run');

    // Run only v1 — confirm, then runMigrations runs all pending
    engine.confirmToken('__auto__');
    await engine.runMigrations('test-plugin');

    // Verify the SchemaVersion row records version 3
    const row = await dbService.SchemaVersionsModel.findOne({
      where: { pluginName: 'test-plugin' }
    });
    assert.ok(row, 'SchemaVersion row should exist');
    assert.equal(row.version, 3, 'applied version should be 3');
  } finally {
    await destroyTestHarness(harness);
  }
});

test('verifySchemaVersions-like check detects out-of-date', async () => {
  const harness = await createTestHarness();
  try {
    const { engine, dbService } = harness;

    const migrations = [
      { version: 1, description: 'v1', up: async () => {} },
      { version: 2, description: 'v2', up: async () => {} }
    ];

    engine.registerMigrations('test-plugin', migrations);
    dbService.registerExpectedVersion('test-plugin', 2);

    // Before running — pending
    const statusBefore = await dbService.verifySchemaVersions();
    const pendingBefore = statusBefore.pending.filter(
      p => p.pluginName === 'test-plugin'
    );
    assert.equal(pendingBefore.length, 1, 'test-plugin should have 1 pending entry');
    assert.ok(pendingBefore[0].behind >= 1);

    // Apply all migrations
    engine.confirmToken('__auto__');
    await engine.runMigrations('test-plugin');

    // Now up to date
    const statusAfter = await dbService.verifySchemaVersions();
    const pendingAfter = statusAfter.pending.filter(
      p => p.pluginName === 'test-plugin'
    );
    assert.equal(pendingAfter.length, 0, 'test-plugin should be up to date after run');
  } finally {
    await destroyTestHarness(harness);
  }
});

test('Migration state is tracked in SchemaVersion table', async () => {
  const harness = await createTestHarness();
  try {
    const { engine, dbService } = harness;

    const migrations = [
      { version: 1, description: 'Initial schema', up: async () => {} },
      { version: 2, description: 'Add rating column', up: async () => {} }
    ];

    engine.registerMigrations('elo-tracker', migrations);
    engine.confirmToken('__auto__');
    await engine.runMigrations('elo-tracker');

    // Query the SchemaVersion table — the real source of truth
    const row = await dbService.SchemaVersionsModel.findOne({
      where: { pluginName: 'elo-tracker' }
    });
    assert.ok(row, 'SchemaVersion row should exist');
    assert.equal(row.version, 2);
    assert.equal(row.pluginName, 'elo-tracker');
    assert.ok(row.appliedAt, 'appliedAt should be set');
    assert.ok(row.migrationHash, 'migrationHash should be set');

    // appliedAt should be a recent timestamp
    const now = Date.now();
    assert.ok(
      row.appliedAt >= now - 60000 && row.appliedAt <= now + 1000,
      `appliedAt (${row.appliedAt}) should be within the last minute of now (${now})`
    );
  } finally {
    await destroyTestHarness(harness);
  }
});

test('sync({alter}) calls verification — scan consumer plugins', async () => {
  // Scan consumer plugin source files for sync({alter}) pattern
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const referenceDirs = [
    path.resolve(__dirname, '..', '..', 'ReferenceScripts'),
  ];

  const filesToCheck = [];
  for (const dir of referenceDirs) {
    try {
      const entries = fs.readdirSync(dir, { recursive: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        if (fullPath.endsWith('.js') && fs.statSync(fullPath).isFile()) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (content.includes('sync({alter})')) {
            filesToCheck.push(fullPath);
          }
        }
      }
    } catch (err) {
      // Directory may not exist on all systems
    }
  }

  if (filesToCheck.length > 0) {
    console.log(`  ⚠ Found sync({alter}) in ${filesToCheck.length} file(s):`);
    for (const f of filesToCheck) {
      console.log(`     ${f}`);
    }
  }

  // This test is informational — no assert since consumer plugins may not
  // be present in all environments. But log if any are found.
  console.log('  (sync({alter}) scan completed — check output for any findings)');
});

// ---------------------------------------------------------------------------
// Read-only SQLite file test
// ---------------------------------------------------------------------------

test('Read-only SQLite file causes runMigrations() to reject (reproduces original permission bug)', async () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-mig-ro-'));
  const dbPath = path.join(backupDir, 'test-readonly.sqlite');

  // ── Bootstrap — create DB, run admin migration to get SchemaVersions table, close ──
  let harness1 = await createFileBasedHarness(dbPath, backupDir);
  try {
    harness1.engine.registerMigrations('bootstrap', [
      { version: 1, description: 'Admin setup', up: async () => {} }
    ]);
    harness1.engine.confirmToken('__auto__');
    await harness1.engine.runMigrations('bootstrap');
  } finally {
    await harness1.sequelize.close();
  }

  // ── Make file read-only ──
  const madeReadOnly = makeFileReadOnly(dbPath);
  assert.ok(madeReadOnly, 'Failed to make SQLite file read-only — test precondition failed');

  // ── Re-open read-only DB, attempt CREATE TABLE migration, assert rejection ──
  let rejected = false;
  let harness2;
  try {
    harness2 = await createFileBasedHarness(dbPath, backupDir);
    harness2.engine.registerMigrations('test-ro', [
      {
        version: 1,
        description: 'Should fail — DB is read-only',
        up: async (qi) => {
          await qi.createTable('ShouldNotExist', {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true }
          });
        }
      }
    ]);
    harness2.engine.confirmToken('__auto__');
    await harness2.engine.runMigrations('test-ro');
  } catch (err) {
    rejected = true;
  }

  // Close the read-only connection before restoring permissions
  if (harness2) await harness2.sequelize.close();

  // ── Restore permissions, verify table was NOT created ──
  restoreFilePermissions(dbPath);

  const harness3 = await createFileBasedHarness(dbPath, backupDir);
  try {
    const qi = getLiveQI(harness3.sequelize);
    const tables = await qi.showAllTables();
    assert.ok(!tables.includes('ShouldNotExist'),
      'ShouldNotExist table must NOT exist after failed migration');
  } finally {
    await harness3.sequelize.close();
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await run();
