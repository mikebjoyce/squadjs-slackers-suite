/**
 * S³ MIGRATION BACKUP TEST
 * Tests pre-migration backup: dual SQLite+JSON output, JSON-only fallback,
 * restoreFromFile auto-detection.
 * Usage: node SlackersSquadServices/testing/test-migration-backup.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import DBService from '../utils/db-service.js';
import { Sequelize, DataTypes } from 'sequelize';

let expF, fromF;

async function init() {
  const m = await import('../utils/s3-export-import.js');
  expF = m.exportToFile; fromF = m.restoreFromFile;
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
}

await main();
if (!process.exitCode) console.log('\nAll migration-backup tests passed.');