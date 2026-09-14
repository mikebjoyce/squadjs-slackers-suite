/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   MULTI-PROCESS LOCKING — GENUINE CHILD PROCESSES, ONE DB     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── WHY CHILD PROCESSES ─────────────────────────────────────────
 *
 * Everything else in this suite runs its "two servers" as two objects inside
 * one Node process. That is enough to exercise most of the coordination code,
 * and it is structurally blind to the defect the migration lock actually had:
 * SQLite's guard was a per-process mutex, so two service objects sharing one
 * process were serialised by the very thing that does nothing across processes.
 * A test built that way passes against a database with no cross-process lock
 * at all, which is precisely how the bug survived.
 *
 * So these cases fork real `node` processes against one real SQLite file. The
 * only channel between them is the database, which is the only channel two
 * SquadJS instances have.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   mutual exclusion   Two children migrate the same group at once. Exactly one
 *                      migration body runs.
 *   the loser comes    The loser waits, re-checks under the lock, finds the work
 *   up clean           already done, and returns successfully having applied
 *                      nothing — rather than re-running the winner's migrations.
 *   release            After a child migrates and exits, the next acquire is
 *                      immediate. A leaked lock is invisible to any test that
 *                      only checks mutual exclusion: it looks like success right
 *                      up until something has to take the lock again, and then
 *                      it looks like a ten-minute hang.
 *   drift under a      A process that finds a column missing while another holds
 *   held lock          the migration lock must NOT roll `S3_SchemaVersions` back.
 *                      "Another process is mid-migration" and "the schema has
 *                      drifted" are indistinguishable from outside; only the
 *                      lock separates them, and the version row is community-wide.
 *
 * ─── WHY SQLITE ──────────────────────────────────────────────────
 *
 * SQLite is the dialect where this was broken, and it needs no Docker, so these
 * cases always run rather than skipping the way the MySQL/Postgres suites do.
 * The lock itself has no dialect branch — one `S3_Locks` row on all three
 * engines, with the primary key doing the arbitration — so what holds here holds
 * on MySQL and Postgres by construction rather than by repetition.
 *
 * Category: 1 (no external services)
 * Run:    node s3/testing/test-multi-process-locking.js
 */

'use strict';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Sequelize } from 'sequelize';

import DBService, { LOCK_KINDS } from '../utils/db-service.js';
import MigrationEngine from '../utils/migration-engine.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Two processes writing one SQLite file will collide on a busy moment that has
 * nothing to do with the lock under test. Without this, SQLITE_BUSY surfaces as
 * a hard error and the case measures the driver's default rather than the lock.
 * Both the parent and the generated child connect with it.
 */
const SQLITE_OPTIONS = {
  dialect: 'sqlite',
  logging: false,
  define: { freezeTableName: true },
  retry: { match: [/SQLITE_BUSY/, /database is locked/], max: 25, backoffBase: 50, backoffExponent: 1.2 }
};

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
  console.log('='.repeat(70));
  console.log('Multi-Process Locking  (real child processes, one SQLite file)');
  console.log('='.repeat(70));
  console.log('');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${String(err.message).split('\n').join('\n      ')}`);
      failed++;
    }
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log('─'.repeat(70));

  if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// The child process
// ---------------------------------------------------------------------------

/**
 * The child is generated into the repo, not into the OS temp directory.
 *
 * It imports `sequelize` by bare specifier, and Node resolves that by walking up
 * from the importing file — from a temp directory it walks up to the drive root
 * and finds nothing. Same constraint, and the same solution, as
 * plugin-assembly.js. `.tmp-*` is not gitignored, so the `finally` that removes
 * it is not optional.
 */
const CHILD_SOURCE = `
import fs from 'node:fs';
import { Sequelize } from 'sequelize';
import DBService, { LOCK_KINDS } from '../s3/utils/db-service.js';
import MigrationEngine from '../s3/utils/migration-engine.js';

const [dbPath, mode, markerPath, tagRaw, holdRaw] = process.argv.slice(2);
const tag = tagRaw || 'child';
const holdMs = parseInt(holdRaw || '0', 10);

const mark = (phase) => fs.appendFileSync(markerPath, JSON.stringify({ tag, phase, t: Date.now() }) + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: dbPath,
  logging: false,
  define: { freezeTableName: true },
  retry: { match: [/SQLITE_BUSY/, /database is locked/], max: 25, backoffBase: 50, backoffExponent: 1.2 }
});

const db = new DBService({ sequelize, verboseLogger: () => {} });
await db.mount();
db._migrationEngine = new MigrationEngine({ dbService: db, verboseLogger: () => {}, backupDir: process.cwd() });

const out = { tag, mode, ok: false };

try {
  if (mode === 'migrate') {
    db.migrationEngine.registerMigrations('race-group', [
      {
        version: 1,
        description: 'Create RaceTable, slowly',
        // No JSON backup: the migration creates a table rather than touching
        // existing data, and the export would walk the whole registry each run.
        backup: false,
        touches: { creates: ['RaceTable'], columns: { RaceTable: ['id', 'note'] } },
        up: async (qi) => {
          // The marker file is the only evidence that survives the process. It
          // is append-only, one line per event, so two writers interleave
          // without either losing a record.
          mark('enter');
          await sleep(holdMs);
          await qi.createTable('RaceTable', {
            id: { type: db.getDataTypes().INTEGER, primaryKey: true, autoIncrement: true },
            note: { type: db.getDataTypes().STRING, allowNull: true }
          });
          mark('leave');
        }
      }
    ]);
    db.registerExpectedVersion('race-group', 1);
    db.migrationEngine.confirmToken('__auto__');
    const result = await db.migrationEngine.runMigrations('race-group');
    out.applied = result.applied;
    out.skipped = result.skipped;
    out.ok = true;
  } else if (mode === 'hold') {
    // Take the migration lock and sit on it, so the parent can act as the second
    // process while this one is unambiguously mid-migration.
    const got = await db.acquireAdvisoryLock('s3_migrate_race-group', { kind: LOCK_KINDS.MIGRATION });
    out.acquired = got;
    mark(got ? 'holding' : 'failed');
    await sleep(holdMs);
    await db.releaseAdvisoryLock('s3_migrate_race-group');
    out.ok = got;
  } else {
    throw new Error('unknown mode: ' + mode);
  }
} catch (err) {
  out.error = err.message;
  out.code = err.code;
} finally {
  try { await db.unmount(); } catch { /* best effort */ }
  try { await sequelize.close(); } catch { /* best effort */ }
}

process.stdout.write('__RESULT__' + JSON.stringify(out));
`;

let childDir = null;
let childPath = null;

function setupChild() {
  childDir = path.join(REPO_ROOT, '.tmp-lockrace');
  fs.rmSync(childDir, { recursive: true, force: true });
  fs.mkdirSync(childDir, { recursive: true });
  childPath = path.join(childDir, 'lock-child.js');
  fs.writeFileSync(childPath, CHILD_SOURCE);
}

function teardownChild() {
  if (childDir) fs.rmSync(childDir, { recursive: true, force: true });
}

/** Run one child to completion and return the JSON object it printed. */
async function runChild(args, cwd) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [childPath, ...args], {
    cwd,
    maxBuffer: 10 * 1024 * 1024
  });
  const marker = stdout.lastIndexOf('__RESULT__');
  if (marker < 0) {
    throw new Error(`child produced no result\n  stdout: ${stdout}\n  stderr: ${stderr}`);
  }
  return JSON.parse(stdout.slice(marker + '__RESULT__'.length));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-lockrace-'));
  return {
    dir,
    dbPath: path.join(dir, 'race.sqlite'),
    markerPath: path.join(dir, 'markers.jsonl'),
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  };
}

function readMarkers(markerPath) {
  if (!fs.existsSync(markerPath)) return [];
  return fs.readFileSync(markerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A mounted DBService in THIS process, on the same file the children use. */
async function openParentDb(dbPath) {
  const sequelize = new Sequelize({ ...SQLITE_OPTIONS, storage: dbPath });
  const db = new DBService({ sequelize, verboseLogger: () => {} });
  await db.mount();
  db._migrationEngine = new MigrationEngine({
    dbService: db,
    verboseLogger: () => {},
    backupDir: path.dirname(dbPath)
  });
  return {
    db,
    sequelize,
    close: async () => {
      try { await db.unmount(); } catch { /* best effort */ }
      try { await sequelize.close(); } catch { /* best effort */ }
    }
  };
}

/**
 * Create the core tables before any child starts.
 *
 * Two processes racing to bootstrap `S3_SchemaVersions` and `S3_Locks` is a
 * different race from the one under test, and losing it takes locking out of
 * service entirely — which then reads as a lock failure and would be diagnosed
 * as one. In production those tables exist by the time anything migrates, so
 * the fixture puts them there too.
 */
async function prepareDb(dbPath) {
  const parent = await openParentDb(dbPath);
  await parent.close();
}

async function readVersionRows(sequelize) {
  return sequelize.query(
    "SELECT version, migrationHash FROM S3_SchemaVersions WHERE pluginName = 'race-group'",
    { type: Sequelize.QueryTypes.SELECT }
  );
}

// ---------------------------------------------------------------------------
// 1. Mutual exclusion, and the loser comes up clean
// ---------------------------------------------------------------------------

test('two child processes migrating at once: the body runs exactly once', async () => {
  const ws = makeWorkspace();
  try {
    await prepareDb(ws.dbPath);

    // Both are started before either can finish mounting, which is the shape of
    // the real race: two SquadJS instances restarted together by one supervisor
    // after a suite upgrade.
    const [a, b] = await Promise.all([
      runChild([ws.dbPath, 'migrate', ws.markerPath, 'A', '600'], ws.dir),
      runChild([ws.dbPath, 'migrate', ws.markerPath, 'B', '600'], ws.dir)
    ]);

    assert.ok(a.ok, `child A failed: ${a.error}`);
    assert.ok(b.ok, `child B failed: ${b.error}`);

    const markers = readMarkers(ws.markerPath);
    const enters = markers.filter((m) => m.phase === 'enter');
    assert.equal(
      enters.length, 1,
      `the migration body must run exactly once across both processes — ran ${enters.length} time(s): ` +
      JSON.stringify(markers)
    );

    const applied = [a.applied, b.applied].sort();
    assert.deepEqual(
      applied, [0, 1],
      `exactly one process should report applying — got ${JSON.stringify({ A: a, B: b })}`
    );
  } finally {
    ws.cleanup();
  }
});

test('the loser waits, re-checks under the lock, and comes up clean', async () => {
  const ws = makeWorkspace();
  try {
    await prepareDb(ws.dbPath);

    const [a, b] = await Promise.all([
      runChild([ws.dbPath, 'migrate', ws.markerPath, 'A', '600'], ws.dir),
      runChild([ws.dbPath, 'migrate', ws.markerPath, 'B', '600'], ws.dir)
    ]);

    assert.ok(a.ok && b.ok, `both children must exit cleanly — got ${JSON.stringify({ A: a, B: b })}`);

    // Establish which is which BEFORE reading anything off them. Without this
    // the assertions below are satisfied by both processes applying — the exact
    // failure they exist to catch names itself "the winner" and slips through.
    assert.deepEqual(
      [a.applied, b.applied].sort(), [0, 1],
      `exactly one of the two must have applied — got ${JSON.stringify({ A: a, B: b })}`
    );

    const loser = a.applied === 0 ? a : b;

    assert.ok(
      !loser.error,
      `the loser must return successfully rather than raise a lock error — got ${JSON.stringify(loser)}`
    );
    assert.equal(
      loser.skipped, 0,
      'having re-checked under the lock and found nothing pending, the loser applies nothing and skips ' +
      `nothing — a non-zero count means it re-ran the winner's work: ${JSON.stringify(loser)}`
    );

    // And the database really is at v1 afterwards, read from a third process.
    const parent = await openParentDb(ws.dbPath);
    try {
      const tables = (await parent.sequelize.getQueryInterface().showAllTables())
        .map((t) => String(t?.tableName ?? t).toLowerCase());
      assert.ok(
        tables.includes('racetable'),
        `the migrated table must exist once both processes have settled — found: ${tables.join(', ')}`
      );
      const rows = await readVersionRows(parent.sequelize);
      assert.equal(rows.length, 1, `exactly one version row for the group — got ${JSON.stringify(rows)}`);
      assert.equal(Number(rows[0].version), 1, `recorded version must be 1 — got ${JSON.stringify(rows)}`);
    } finally {
      await parent.close();
    }
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. Release
// ---------------------------------------------------------------------------

test('a lock held by a child that has exited is released, not left behind', async () => {
  const ws = makeWorkspace();
  try {
    await prepareDb(ws.dbPath);

    const a = await runChild([ws.dbPath, 'migrate', ws.markerPath, 'A', '0'], ws.dir);
    assert.ok(a.ok, `child A failed: ${a.error}`);
    assert.equal(a.applied, 1, 'the only process should have applied the migration');

    const parent = await openParentDb(ws.dbPath);
    try {
      // The row IS the lock. If release landed anywhere other than the row
      // acquire wrote, this is where it shows.
      const held = (await parent.db.LocksModel.findAll()).map((r) => r.lockKey);
      assert.deepEqual(held, [], `S3_Locks must be empty once the holder has exited — found ${JSON.stringify(held)}`);

      // Timed, because a leaked lock is not "cannot acquire" — it is "acquire
      // once the TTL runs out", ten minutes later. Success after a ten-minute
      // wait reads as a hang rather than a failure, so the assertion is on the
      // clock and not merely on the boolean.
      const started = Date.now();
      const got = await parent.db.acquireAdvisoryLock('s3_migrate_race-group', { kind: LOCK_KINDS.MIGRATION });
      const elapsed = Date.now() - started;
      assert.ok(got, 'the lock must be available after the previous holder exited');
      assert.ok(
        elapsed < 2000,
        `acquiring must be immediate rather than a wait-out of the TTL — took ${elapsed}ms`
      );
      await parent.db.releaseAdvisoryLock('s3_migrate_race-group');
    } finally {
      await parent.close();
    }
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. Drift found while another process is mid-migration
// ---------------------------------------------------------------------------

/**
 * The dangerous case, and the reason the fixture is built the way it is.
 *
 * B has to reach the drift check with **nothing pending** — the recorded version
 * already at the expected one, and the column genuinely absent. That is the state
 * the race produces: A is partway through the migration that adds the column, B
 * mounts, and B's own version check is satisfied. Built the other way round, with
 * B behind on versions, the check is reached through the one call site that
 * pre-filters drift to applied migrations, and the case passes vacuously without
 * ever exercising the rollback it exists to prevent.
 */
test('drift found while another process holds the migration lock must not roll the version back', async () => {
  const ws = makeWorkspace();
  let child = null;
  try {
    await prepareDb(ws.dbPath);

    // Seed: RaceTable exists WITHOUT `addedLater`, and the version row already
    // claims the migration that adds it has been applied.
    const seed = await openParentDb(ws.dbPath);
    try {
      await seed.sequelize.getQueryInterface().createTable('RaceTable', {
        id: { type: seed.db.getDataTypes().INTEGER, primaryKey: true, autoIncrement: true }
      });
      await seed.sequelize.query(
        'INSERT INTO S3_SchemaVersions (pluginName, version, appliedAt, migrationHash, description) ' +
        "VALUES ('race-group', 2, 0, 'seeded', 'seeded by the test')"
      );
    } finally {
      await seed.close();
    }

    // A: a real second process, holding the group's migration lock.
    child = execFile(process.execPath, [childPath, ws.dbPath, 'hold', ws.markerPath, 'A', '20000'], {
      cwd: ws.dir,
      maxBuffer: 10 * 1024 * 1024
    });
    const childExit = new Promise((resolve) => child.on('exit', resolve));

    // Poll the marker rather than sleeping a guessed interval, so a slow machine
    // does not turn this into a test of process startup time.
    const deadline = Date.now() + 30000;
    while (!readMarkers(ws.markerPath).some((m) => m.phase === 'holding')) {
      if (Date.now() > deadline) throw new Error('the child never acquired the lock');
      await new Promise((r) => setTimeout(r, 100));
    }

    // B: this process, mounting into a schema A has in hand.
    const b = await openParentDb(ws.dbPath);
    try {
      b.db.defineModel(
        'RaceModel',
        {
          id: { type: b.db.getDataTypes().INTEGER, primaryKey: true, autoIncrement: true },
          addedLater: { type: b.db.getDataTypes().STRING, allowNull: true }
        },
        { tableName: 'RaceTable', timestamps: false, exportTier: 'ephemeral' }
      );
      b.db.registerExpectedVersion('race-group', 2, { models: ['RaceModel'] });

      const drift = await b.db.verifyLiveSchema();
      assert.ok(
        drift.some((e) => (e.missing || []).includes('addedLater')),
        'the fixture must actually present the missing column, or the assertion below proves nothing — got ' +
        JSON.stringify(drift)
      );

      const versions = await b.db.verifySchemaVersions();
      assert.deepEqual(
        versions.pending, [],
        'B must reach the drift check with nothing pending — that is the state the race produces, and the ' +
        `other state is filtered out before the rollback is reached: ${JSON.stringify(versions.pending)}`
      );

      await b.db._handleDetectedDrift(drift);

      const rows = await readVersionRows(b.sequelize);
      assert.equal(rows.length, 1, `the version row must survive — got ${JSON.stringify(rows)}`);
      assert.equal(
        Number(rows[0].version), 2,
        'the recorded version must be untouched while another process holds the migration lock — rolling it ' +
        `back here re-runs a migration that process is already running: ${JSON.stringify(rows)}`
      );
      assert.equal(
        rows[0].migrationHash, 'seeded',
        `the row must not have been rewritten as a drift recovery: ${JSON.stringify(rows)}`
      );
    } finally {
      await b.close();
    }

    child.kill();
    await childExit;
    child = null;
  } finally {
    if (child) { try { child.kill(); } catch { /* best effort */ } }
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

setupChild();
try {
  await run();
} finally {
  teardownChild();
}
