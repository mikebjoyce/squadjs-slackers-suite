/**
 * S3 EXPORT/IMPORT TEST - Three-tier, round-trip, file export/restore.
 * Usage: node SlackersSquadServices/testing/test-s3-export-import.js
 */
import assert from 'node:assert/strict';
import fs2 from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import DBService from '../utils/db-service.js';
import { Sequelize, DataTypes } from 'sequelize';
let fns = {};
async function init() { const m = await import('../utils/s3-export-import.js'); fns = m; }
async function runTest(name, fn) { try { await fn(); console.log('\u2705 ' + name); } catch (err) { console.error('\u274c ' + name); console.error(err); process.exitCode = 1; } }
async function createDb() {
  const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, define: { freezeTableName: true } });
  await seq.authenticate();
  const db = new DBService({ sequelize: seq, defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 } });
  await db.mount(); return db;
}
function defH(db) { return db.defineModel('Elo_PlayerStats', { eosID: { type: DataTypes.STRING, primaryKey: true }, rating: DataTypes.INTEGER }, { timestamps: false }); }
function defL(db) { return db.defineModel('S3_PlayerEvents', { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true }, event: DataTypes.STRING }, { timestamps: false }); }
function defE(db) { return db.defineModel('S3_PlayerSessions', { eosID: { type: DataTypes.STRING, primaryKey: true }, data: DataTypes.STRING }, { timestamps: false }); }
async function populate(db) {
  const H = defH(db); await H.sync(); await H.create({ eosID: 'p1', rating: 1500 }); await H.create({ eosID: 'p2', rating: 1600 });
  const L = defL(db); await L.sync(); await L.create({ event: 'join' });
  const E = defE(db); await E.sync(); await E.create({ eosID: 's1', data: 'active' });
  return { H, L, E };
}
function tmpDir() { return fs2.mkdtempSync(path.join(os.tmpdir(), 's3t-')); }

async function main() {
  await init();
  await runTest('default includes historical only', async () => {
    const db = await createDb(); await populate(db);
    const r = await fns.exportToJSON(db);
    const names = Object.keys(r.tables);
    assert.ok(names.includes('Elo_PlayerStats')); assert.ok(!names.includes('S3_PlayerEvents')); assert.ok(!names.includes('S3_PlayerSessions'));
  });
  await runTest('tier=logs includes logging', async () => {
    const db = await createDb(); await populate(db);
    const r = await fns.exportToJSON(db, { tier: 'logs' });
    const names = Object.keys(r.tables);
    assert.ok(names.includes('S3_PlayerEvents')); assert.ok(!names.includes('S3_PlayerSessions'));
  });
  await runTest('tier=all includes all', async () => {
    const db = await createDb(); await populate(db);
    const r = await fns.exportToJSON(db, { tier: 'all' });
    const names = Object.keys(r.tables);
    assert.ok(names.includes('Elo_PlayerStats')); assert.ok(names.includes('S3_PlayerEvents')); assert.ok(names.includes('S3_PlayerSessions'));
  });
  await runTest('validateImportStructure accepts valid export', async () => {
    const db = await createDb(); await populate(db);
    const exp = await fns.exportToJSON(db);
    const v = await fns.validateImportStructure(exp, db.getModelNames());
    assert.equal(v.valid, true);
  });
  await runTest('validateImportStructure rejects no version', async () => {
    const v = await fns.validateImportStructure({ tables: {} }, ['Elo_PlayerStats']);
    assert.equal(v.valid, false);
  });
  await runTest('full round-trip preserves data', async () => {
    const d1 = await createDb(); const { H } = await populate(d1);
    await H.create({ eosID: 'p3', rating: 1700 });
    const exp = await fns.exportToJSON(d1, { tier: 'all' });
    const d2 = await createDb();
    const H2 = defH(d2); await H2.sync(); const L2 = defL(d2); await L2.sync(); const E2 = defE(d2); await E2.sync();
    const imp = await fns.importFromJSON(d2, exp);
    assert.equal(typeof imp.imported, 'object'); assert.ok(Object.keys(imp.imported).length > 0); assert.equal(imp.errors.length, 0);
    assert.equal((await H2.findAll({ raw: true })).length, 3);
  });
  await runTest('dryRun does not write', async () => {
    const d1 = await createDb(); await populate(d1);
    const exp = await fns.exportToJSON(d1);
    const d2 = await createDb(); const H2 = defH(d2); await H2.sync();
    await fns.importFromJSON(d2, exp, { dryRun: true });
    assert.equal((await H2.findAll({ raw: true })).length, 0);
  });
  await runTest('per-table try-catch isolates failures', async () => {
    const d1 = await createDb(); await populate(d1);
    const exp = await fns.exportToJSON(d1, { tier: 'all' });
    const d2 = await createDb(); const H2 = defH(d2); await H2.sync();
    await fns.importFromJSON(d2, exp);
    assert.ok((await H2.findAll({ raw: true })).length > 0);
  });
  await runTest('exportToFile writes JSON', async () => {
    const db = await createDb(); await populate(db); const tmp = tmpDir();
    const r = await fns.exportToFile(db, tmp);
    assert.ok(r); assert.ok(r.filename && r.filename.startsWith('s3backup-') && r.filename.endsWith('.json'));
    assert.ok(fs2.existsSync(path.join(tmp, r.filename)));
    fs2.rmSync(tmp, { recursive: true, force: true });
  });
  await runTest('restoreFromFile auto-detects JSON', async () => {
    const db = await createDb(); await populate(db); const tmp = tmpDir();
    const r = await fns.exportToFile(db, tmp);
    const d2 = await createDb(); const H2 = defH(d2); await H2.sync();
    const restore = await fns.restoreFromFile(r.filename, d2, tmp);
    assert.ok(restore); assert.ok((await H2.findAll({ raw: true })).length > 0);
    fs2.rmSync(tmp, { recursive: true, force: true });
  });
  await runTest('import with FK handling works', async () => {
    const d1 = await createDb(); await populate(d1);
    const exp = await fns.exportToJSON(d1);
    const d2 = await createDb(); const H2 = defH(d2); await H2.sync();
    await fns.importFromJSON(d2, exp);
    assert.ok((await H2.findAll({ raw: true })).length > 0);
  });
}
await main();
if (!process.exitCode) console.log('\nAll export-import tests passed.');
