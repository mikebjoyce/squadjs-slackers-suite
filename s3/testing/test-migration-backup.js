/**
 * S³ MIGRATION BACKUP TEST
 * Tests pre-migration backup: dual SQLite+JSON output, JSON-only fallback,
 * restoreFromFile auto-detection, and which `touches` categories actually
 * cause a backup to be taken.
 *
 * That last group is a regression guard on a live outage. db-log's migration
 * is a pure idempotent createTable, and it declared `touches.creates` for its
 * eight dblog_* tables. The backup scoping treated "creates" as data worth
 * saving, so on a server holding ~900MB of stats it exported all of it into
 * memory during mount and the process was OOM-killed (exit 137) before any SQL
 * ran. A table a migration creates cannot lose data — either it does not exist,
 * or the existence guard means the migration skips it — so `creates` must never
 * pull a table into the backup, while `columns` and `rows` still must.
 *
 * Usage: node SlackersSquadServices/testing/test-migration-backup.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import DBService from '../utils/db-service.js';
import MigrationEngine from '../utils/migration-engine.js';
import { Sequelize, DataTypes } from 'sequelize';

let expF, fromF, gzipF;

async function init() {
  const m = await import('../utils/s3-export-import.js');
  expF = m.exportToFile; fromF = m.restoreFromFile; gzipF = m.gzipFileForAttachment;
}

async function runTest(name, fn) {
  try { await fn(); console.log('\u2705 ' + name); }
  catch (err) { console.error('\u274c ' + name); console.error(err); process.exitCode = 1; }
}

async function createDb() {
  const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, define: { freezeTableName: true } });
  await seq.authenticate();
  const db = new DBService({ sequelize: seq, defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 } });
  await db.mount();
  return db;
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 's3mb-')); }

function jsonBackups(dir) {
  return fs.readdirSync(dir).filter(f => /^s3backup-.*\.json$/.test(f));
}

/**
 * A DBService with a real MigrationEngine writing into `backupDir`, holding one
 * seeded table. In-memory SQLite has no file path, so the engine's SQLite file
 * copy is skipped and the JSON tier is what is under test — the same position a
 * MySQL server is in.
 */
async function dbWithEngine(backupDir, rows = 25) {
  const db = await createDb();
  db._migrationEngine = new MigrationEngine({ dbService: db, verboseLogger: () => {}, backupDir });
  db.defineModel('BigLog', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    payload: { type: DataTypes.STRING }
  }, { tableName: 'big_log', timestamps: false, exportTier: 'logging' });
  const BigLog = db.getModel('BigLog');
  await BigLog.sync();
  await BigLog.bulkCreate(Array.from({ length: rows }, (_, i) => ({ payload: `row-${i}` })));
  return { db, engine: db.migrationEngine, BigLog };
}

async function main() {
  await init();

  await runTest('exportToFile produces backup JSON file', async () => {
    const db = await createDb(); const tmp = tmpDir();
    const r = await expF(db, tmp);
    assert.ok(r);
    assert.ok(r.filename.startsWith('s3backup-') && r.filename.endsWith('.json'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await runTest('exportToFile returns null for non-ready DB', async () => {
    const r = await expF(null, tmpDir());
    assert.equal(r, null);
    // tmpDir() returns dir that won't be cleaned, but no data written
  });

  await runTest('restoreFromFile throws on null filename', async () => {
    try {
      await fromF(null, null, null);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('filename'));
    }
  });

  await runTest('restoreFromFile rejects non-existent file', async () => {
    const tmp = tmpDir();
    try {
      await fromF('nonexistent.json', null, tmp);
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ── Backup scoping: which `touches` categories cost a backup ────────────

  await runTest('a creates-only migration takes no JSON backup', async () => {
    const tmp = tmpDir();
    const { engine } = await dbWithEngine(tmp);
    engine.registerMigrations('creates-only', [{
      version: 1,
      description: 'idempotent create of a table that already exists',
      touches: { creates: ['big_log'] },
      up: async (qi) => {
        if (!(await qi.tableExists('big_log'))) await qi.createTable('big_log', {});
      },
      down: async () => {}
    }]);
    engine.confirmToken('__auto__');
    await engine.runMigrations('creates-only');

    assert.deepEqual(
      jsonBackups(tmp), [],
      'a table the migration only creates must not be exported — this is the OOM'
    );
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await runTest('a column-altering migration still takes a scoped backup', async () => {
    const tmp = tmpDir();
    const { engine } = await dbWithEngine(tmp);
    engine.registerMigrations('cols', [{
      version: 1,
      description: 'alters a column on big_log',
      touches: { columns: { big_log: ['payload'] } },
      up: async () => {},
      down: async () => {}
    }]);
    engine.confirmToken('__auto__');
    await engine.runMigrations('cols');

    const files = jsonBackups(tmp);
    assert.equal(files.length, 1, 'a column change must still be backed up first');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmp, files[0]), 'utf8'));
    assert.equal(parsed.rowCounts.BigLog, 25, 'the scoped backup must contain the table it protects');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await runTest('an empty touches declaration takes no backup', async () => {
    // registerMigrations rejects a migration with no `touches` at all, so
    // `touches: {}` is how an author says "this changes nothing". Nothing to
    // lose means nothing to back up.
    const tmp = tmpDir();
    const { engine } = await dbWithEngine(tmp);
    engine.registerMigrations('untouched', [{
      version: 1,
      description: 'makes no schema changes',
      touches: {},
      up: async () => {},
      down: async () => {}
    }]);
    engine.confirmToken('__auto__');
    await engine.runMigrations('untouched');

    assert.deepEqual(jsonBackups(tmp), []);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await runTest('a migration cannot be registered without touches', async () => {
    const tmp = tmpDir();
    const { engine } = await dbWithEngine(tmp);
    assert.throws(
      () => engine.registerMigrations('no-touches', [{
        version: 1, description: 'x', up: async () => {}, down: async () => {}
      }]),
      /missing a "touches" declaration/,
      'the declaration the backup scope is derived from must stay mandatory'
    );
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // ── Streamed output shape ──────────────────────────────────────────────

  await runTest('the streamed export file is valid JSON with one row per line', async () => {
    const tmp = tmpDir();
    const { db } = await dbWithEngine(tmp);
    const r = await expF(db, tmp, { tier: 'all' });
    assert.ok(r);

    const raw = fs.readFileSync(r.path, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.s3ExportVersion, 1);
    assert.equal(parsed.s3StreamFormat, 1);
    assert.equal(parsed.rowCounts.BigLog, 25);
    assert.equal(parsed.results.BigLog.status, 'ok');
    assert.equal(parsed.tables.BigLog.length, 25);
    assert.equal(parsed.tables.BigLog[0].payload, 'row-0');

    // One row per line is what lets importFromStreamFile read a file far larger
    // than the heap. If pretty-printing ever creeps back in, that breaks.
    const rowLines = raw.split('\n').filter(l => l.startsWith('{"id"'));
    assert.equal(rowLines.length, 25, 'each row must occupy exactly one line');

    assert.ok(!fs.existsSync(`${r.path}.partial`), 'the .partial staging file must be renamed away');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await runTest('gzipFileForAttachment refuses an over-limit file and cleans up', async () => {
    const tmp = tmpDir();
    const { db } = await dbWithEngine(tmp);
    const r = await expF(db, tmp, { tier: 'all' });

    const over = await gzipF(r.path, { limitBytes: 8 });
    assert.equal(over.attachable, false);
    assert.ok(over.reason.includes('attachment limit'));
    assert.ok(!fs.existsSync(`${r.path}.gz`), 'the rejected .gz must not be left behind');

    const under = await gzipF(r.path);
    assert.equal(under.attachable, true);
    assert.equal(under.buffer.length, under.sizeBytes);
    assert.ok(under.filename.endsWith('.json.gz'));
    assert.ok(!fs.existsSync(`${r.path}.gz`), 'the accepted .gz must not be left behind either');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await runTest('a streamed export round-trips into a second database', async () => {
    const tmp = tmpDir();
    const { db } = await dbWithEngine(tmp, 300);
    const r = await expF(db, tmp, { tier: 'all', batchSize: 32 });
    assert.ok(r);

    const { db: db2, BigLog: BigLog2 } = await dbWithEngine(tmpDir(), 0);
    const imported = await fromF(r.filename, db2, tmp);
    assert.equal(imported.imported.BigLog.status, 'ok');
    assert.equal(await BigLog2.count(), 300);
    assert.equal((await BigLog2.findOne({ where: { id: 300 }, raw: true })).payload, 'row-299');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
}

await main();
if (!process.exitCode) console.log('\nAll migration-backup tests passed.');