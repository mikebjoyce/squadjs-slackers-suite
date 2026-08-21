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
// Each stand-in declares its tier the way a real model does — via the
// `exportTier` option on defineModel(). filterByTier() reads the declaration
// back out of DBService; it no longer consults a central list, so a model that
// declares nothing lands in the DEFAULT tier rather than being classified by
// name. See defUndeclared() below, which exercises exactly that fallback.
function defH(db) { return db.defineModel('Elo_PlayerStats', { eosID: { type: DataTypes.STRING, primaryKey: true }, rating: DataTypes.INTEGER }, { timestamps: false, exportTier: 'historical' }); }
// NOTE: these must be the real MODEL names, matching the tier sets in
// s3-export-import.js and what dbService.getModelNames() reports in production.
// They previously read 'S3_PlayerEvents' and 'S3_PlayerSessions' — table-name
// spellings that no model actually uses — so this file exercised the tier
// machinery against fictional models and stayed green while the real logging
// tables were absent from every export. See test-export-model-registration.js,
// which mounts the actual services rather than defining stand-ins.
function defL(db) { return db.defineModel('S3PlayerEvents', { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true }, event: DataTypes.STRING }, { tableName: 'S3_PlayerEvents', timestamps: false, exportTier: 'logging' }); }
function defE(db) { return db.defineModel('S3_PlayerSession', { eosID: { type: DataTypes.STRING, primaryKey: true }, data: DataTypes.STRING }, { timestamps: false, exportTier: 'ephemeral' }); }
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
    assert.ok(names.includes('Elo_PlayerStats')); assert.ok(!names.includes('S3PlayerEvents')); assert.ok(!names.includes('S3_PlayerSession'));
  });
  await runTest('tier=logs includes logging', async () => {
    const db = await createDb(); await populate(db);
    const r = await fns.exportToJSON(db, { tier: 'logs' });
    const names = Object.keys(r.tables);
    assert.ok(names.includes('S3PlayerEvents')); assert.ok(!names.includes('S3_PlayerSession'));
  });
  await runTest('tier=all includes all', async () => {
    const db = await createDb(); await populate(db);
    const r = await fns.exportToJSON(db, { tier: 'all' });
    const names = Object.keys(r.tables);
    assert.ok(names.includes('Elo_PlayerStats')); assert.ok(names.includes('S3PlayerEvents')); assert.ok(names.includes('S3_PlayerSession'));
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
  await runTest('a pre-change v1 backup (no tier manifest) still imports', async () => {
    // Every backup an operator already holds was written before `tier`/`tiers`
    // existed. Those fields are additive, so the version stays 1 — which means
    // nothing bumps to warn the importer, and tolerating their absence is the
    // only thing keeping older files restorable. Strip them and re-import.
    const d1 = await createDb(); const { H } = await populate(d1);
    await H.create({ eosID: 'p3', rating: 1700 });
    const exp = await fns.exportToJSON(d1, { tier: 'all' });

    delete exp.tier;
    delete exp.tiers;

    const d2 = await createDb();
    const H2 = defH(d2); await H2.sync(); const L2 = defL(d2); await L2.sync(); const E2 = defE(d2); await E2.sync();
    const v = await fns.validateImportStructure(exp, d2.getModelNames());
    assert.equal(v.valid, true, 'a legacy v1 file must still validate');

    const imp = await fns.importFromJSON(d2, exp);
    assert.equal(imp.errors.length, 0);
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
