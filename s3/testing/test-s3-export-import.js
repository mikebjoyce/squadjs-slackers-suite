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
// Each stand-in declares its tier AND its server scope the way a real model
// does — via the
// `exportTier` option on defineModel(). filterByTier() reads the declaration
// back out of DBService; it no longer consults a central list, so a model that
// declares nothing lands in the DEFAULT tier rather than being classified by
// name. See defUndeclared() below, which exercises exactly that fallback.
// The scope kinds mirror the real models these stand in for: ratings are
// community-wide, events and sessions belong to one server. Import is scoped by
// default, so a stand-in that declared nothing would be refused rather than
// written — which is the point of the declaration, and no use as a fixture.
function defH(db) { return db.defineModel('Elo_PlayerStats', { eosID: { type: DataTypes.STRING, primaryKey: true }, rating: DataTypes.INTEGER }, { timestamps: false, exportTier: 'historical', scopeKind: 'global' }); }
// NOTE: these must be the real MODEL names, matching the tier sets in
// s3-export-import.js and what dbService.getModelNames() reports in production.
// They previously read 'S3_PlayerEvents' and 'S3_PlayerSessions' — table-name
// spellings that no model actually uses — so this file exercised the tier
// machinery against fictional models and stayed green while the real logging
// tables were absent from every export. See test-export-model-registration.js,
// which mounts the actual services rather than defining stand-ins.
function defL(db) { return db.defineModel('S3PlayerEvents', { id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true }, event: DataTypes.STRING }, { tableName: 'S3_PlayerEvents', timestamps: false, exportTier: 'logging', scopeKind: 'server-column' }); }
function defE(db) { return db.defineModel('S3_PlayerSession', { eosID: { type: DataTypes.STRING, primaryKey: true }, data: DataTypes.STRING }, { timestamps: false, exportTier: 'ephemeral', scopeKind: 'server-column' }); }
async function populate(db) {
  const H = defH(db); await H.sync(); await H.create({ eosID: 'p1', rating: 1500 }); await H.create({ eosID: 'p2', rating: 1600 });
  const L = defL(db); await L.sync(); await L.create({ event: 'join' });
  const E = defE(db); await E.sync(); await E.create({ eosID: 's1', data: 'active' });
  return { H, L, E };
}
function defScoped(db) {
  return db.defineModel('S3PlayerReconnect', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    serverID: { type: DataTypes.INTEGER, allowNull: true },
    note: DataTypes.STRING
  }, { tableName: 'S3_ServerReconnects', timestamps: false, exportTier: 'historical', scopeKind: 'server-column' });
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

  // ── Coverage ──────────────────────────────────────────────────────
  // An export's `results` map has always reported per model, and nothing ever
  // compared it against what the export was asked for. These four cases are the
  // difference between "every line says ok" and "everything asked for is here".

  await runTest('an export that delivered everything is marked complete', async () => {
    const db = await createDb(); await populate(db);
    const exp = await fns.exportToJSON(db, { tier: 'all' });
    assert.equal(exp.complete, true, JSON.stringify(exp.incomplete));
    assert.equal(exp.incomplete, undefined);
  });

  await runTest('a model asked for but never registered makes the export incomplete', async () => {
    const db = await createDb(); await populate(db);
    // This is the silent case: filterByTier() drops an unregistered name, so
    // without the assertion the model appears nowhere at all — not in `tables`,
    // not in `results`, not as an error. The envelope reads as a clean run.
    const exp = await fns.exportToJSON(db, { models: ['Elo_PlayerStats', 'NeverRegistered'] });
    assert.equal(exp.complete, false);
    assert.deepEqual(exp.incomplete.map((g) => g.model), ['NeverRegistered']);
    assert.match(exp.incomplete[0].reason, /registry/);
  });

  await runTest('a table that errored is reported as failed, not as incomplete', async () => {
    // The distinction is load-bearing. A table that errors is already loud — its
    // driver message is in `results` — and it errors for a reason a backup has
    // to survive: a model whose declared column is missing from the live table
    // fails every read until the migration repairs it. Blocking on this would
    // put drift repair permanently out of reach.
    const db = await createDb(); const { H } = await populate(db);
    H.findAll = async () => { throw new Error('table is gone'); };
    const exp = await fns.exportToJSON(db, { models: ['Elo_PlayerStats'] });
    assert.equal(exp.complete, true);
    assert.equal(exp.incomplete, undefined);
    assert.deepEqual(exp.failedTables, [{ model: 'Elo_PlayerStats', reason: 'table is gone' }]);
  });

  await runTest('a table that does not exist yet is not reported as a failure', async () => {
    // The ordinary fresh install: v1 creates the table, v2 changes it, both are
    // pending, and the backup is scoped from the union of what they touch — so
    // the export is asked for a table that will not exist until the run it is
    // protecting.
    const db = await createDb();
    defH(db); // registered, never synced
    const exp = await fns.exportToJSON(db, { models: ['Elo_PlayerStats'] });
    assert.equal(exp.complete, true);
    assert.equal(exp.failedTables, undefined, JSON.stringify(exp.failedTables));
    assert.deepEqual(exp.absentTables, ['Elo_PlayerStats']);
  });

  await runTest('a full-database export names the tables no model covers', async () => {
    const db = await createDb(); await populate(db);
    // Stand in for a plugin that is installed but not mounted: its table is in
    // the database, and no defineModel() in this process knows about it.
    await db.sequelize.query('CREATE TABLE DBLog_PlayerWounds (id INTEGER PRIMARY KEY)');

    const exp = await fns.exportToJSON(db, { tier: 'all' });
    // Still complete — it delivered everything it was asked for. The point is
    // that "complete" and "a backup of the database" are different claims, and
    // only one of them is true here.
    assert.equal(exp.complete, true);
    assert.ok(
      exp.unexportedTables.includes('DBLog_PlayerWounds'),
      `expected the unmounted plugin's table to be named — got ${JSON.stringify(exp.unexportedTables)}`
    );
    assert.ok(exp.warnings.some((w) => w.includes('DBLog_PlayerWounds')));

    // A scoped export makes no such claim, so it says nothing about it.
    const scoped = await fns.exportToJSON(db, { models: ['Elo_PlayerStats'] });
    assert.equal(scoped.unexportedTables, undefined);
  });

  await runTest('exportToFile records coverage in the file, not only the return value', async () => {
    const db = await createDb(); await populate(db); const tmp = tmpDir();
    await db.sequelize.query('CREATE TABLE DBLog_PlayerWounds (id INTEGER PRIMARY KEY)');

    const r = await fns.exportToFile(db, tmp, { tier: 'all' });
    assert.equal(r.complete, true);
    assert.ok(r.unexportedTables.includes('DBLog_PlayerWounds'));

    // The return value is gone once the command finishes; the file is what
    // somebody reads later while deciding whether to trust the backup.
    const onDisk = JSON.parse(fs2.readFileSync(path.join(tmp, r.filename), 'utf8'));
    assert.equal(onDisk.complete, true);
    assert.deepEqual(onDisk.unexportedTables, r.unexportedTables);
    assert.ok(onDisk.warnings.some((w) => w.includes('DBLog_PlayerWounds')));

    const bad = await fns.exportToFile(db, tmp, { models: ['NeverRegistered'] });
    assert.equal(bad.complete, false);
    assert.deepEqual(bad.incomplete.map((g) => g.model), ['NeverRegistered']);
    const badOnDisk = JSON.parse(fs2.readFileSync(path.join(tmp, bad.filename), 'utf8'));
    assert.equal(badOnDisk.complete, false);

    fs2.rmSync(tmp, { recursive: true, force: true });
  });

  // ── S3_Locks: exported, never restored ────────────────────────────────
  //
  // The tier and the restore are two separate decisions. S3Locks is
  // 'ephemeral', so an --all backup contains its rows — a snapshot should say
  // who held the migration lock when it was taken. Writing those rows back is
  // the part that does not follow: every process that held one is gone by
  // restore time, and acquireLock() only steals a row once expiresAt has
  // passed, so a restored migration lock stalls migrations until a deadline
  // set on another day goes by. IMPORT_SKIPPED_MODELS is where that is
  // recorded; these cases pin both halves so neither can drift into the other.

  /** A lock row whose deadline is comfortably in the future, as a live one would be. */
  async function seedLock(db) {
    const now = Date.now();
    await db.LocksModel.create({
      lockKey: 's3:migration',
      kind: 'migration',
      owner: 'host-a:4242',
      acquiredAt: now,
      expiresAt: now + 3600000
    });
  }

  await runTest('an --all export still contains the lock rows', async () => {
    const d1 = await createDb(); await populate(d1); await seedLock(d1);
    const exp = await fns.exportToJSON(d1, { tier: 'all' });
    assert.ok(Object.keys(exp.tables).includes('S3Locks'), 'S3Locks must stay in the --all export');
    assert.equal(exp.tables.S3Locks.length, 1);
  });

  await runTest('importFromJSON skips the lock table rather than resurrecting it', async () => {
    const d1 = await createDb(); await populate(d1); await seedLock(d1);
    const exp = await fns.exportToJSON(d1, { tier: 'all' });

    const d2 = await createDb();
    const H2 = defH(d2); await H2.sync(); const L2 = defL(d2); await L2.sync(); const E2 = defE(d2); await E2.sync();
    const imp = await fns.importFromJSON(d2, exp);

    assert.equal(imp.imported.S3Locks.status, 'skipped', 'a skip is neither ok nor an error');
    assert.equal(imp.imported.S3Locks.rows, 0);
    assert.ok(imp.imported.S3Locks.reason.includes('S3Locks'), 'the reason names the table');
    assert.equal(imp.errors.length, 0, 'a deliberate skip is not a restore failure');

    assert.equal(await d2.LocksModel.count(), 0, 'the restored database must start with no locks held');
    // The rest of the file still landed — the skip is one table, not a bail-out.
    assert.equal((await H2.findAll({ raw: true })).length, 2);
  });

  await runTest('a dry run predicts the skip instead of promising the rows', async () => {
    const d1 = await createDb(); await populate(d1); await seedLock(d1);
    const exp = await fns.exportToJSON(d1, { tier: 'all' });

    const d2 = await createDb();
    const imp = await fns.importFromJSON(d2, exp, { dryRun: true });
    assert.equal(imp.imported.S3Locks.status, 'skipped');
    assert.equal(imp.imported.S3Locks.rows, 0);
    assert.equal(imp.imported.S3Locks.dryRun, true);
  });

  await runTest('the streamed importer skips the lock table too', async () => {
    // The two importers are separate loops over separate parsers, and a restore
    // takes whichever one the file's size chose. A skip on only one of them is
    // a skip that depends on how big the backup happened to be.
    const tmp = tmpDir();
    const d1 = await createDb(); await populate(d1); await seedLock(d1);
    const written = await fns.exportToFile(d1, tmp, { tier: 'all' });

    const d2 = await createDb();
    const H2 = defH(d2); await H2.sync(); const L2 = defL(d2); await L2.sync(); const E2 = defE(d2); await E2.sync();
    const imp = await fns.importFromStreamFile(d2, path.join(tmp, written.filename));

    assert.equal(imp.imported.S3Locks.status, 'skipped');
    assert.equal(imp.imported.S3Locks.rows, 0);
    assert.equal(imp.errors.length, 0, 'a skipped table is not an unknown table');
    assert.equal(await d2.LocksModel.count(), 0);
    assert.equal((await H2.findAll({ raw: true })).length, 2);

    fs2.rmSync(tmp, { recursive: true, force: true });
  });

  // ── Restoring a backup is not the same operation as importing a file ──

  await runTest('a restore writes every server\'s rows, unlike an import', async () => {
    // The defaults are opposite on purpose. `!s3 db import` takes a file an
    // operator chose and narrows to this server; a restore puts back a file
    // this suite wrote, and both backup writers are community-wide. A restore
    // that quietly dropped the siblings would rebuild a database that never
    // existed — and would report a tick per table while doing it.
    const tmp = tmpDir();
    const db = await createDb();
    const S = defScoped(db); await S.sync();

    // Hand-written rather than exported: the legacy pretty-printed shape is
    // the one that reaches importFromJSON(), and the streaming writer no
    // longer produces it.
    const envelope = {
      s3ExportVersion: 1,
      exportedAt: new Date().toISOString(),
      tables: {
        S3PlayerReconnect: [
          { id: 1, serverID: 1, note: 'mine' },
          { id: 2, serverID: 2, note: 'sibling' },
          { id: 3, serverID: null, note: 'legacy' }
        ]
      }
    };
    fs2.writeFileSync(path.join(tmp, 's3backup-restore-test.json'), JSON.stringify(envelope, null, 2));

    const result = await fns.restoreFromFile('s3backup-restore-test.json', db, tmp);
    assert.equal(result.imported.S3PlayerReconnect.status, 'ok');

    const rows = await S.findAll({ raw: true, order: [['id', 'ASC']] });
    assert.equal(rows.length, 3, 'the sibling\'s row is restored, not skipped');
    assert.equal(rows[1].serverID, 2, 'and it is still the sibling\'s row afterwards');
    // The one thing a restore does change: a row naming nobody is adopted.
    assert.equal(rows[2].serverID, db.getServerID());

    fs2.rmSync(tmp, { recursive: true, force: true });
  });

  await runTest('a streamed restore adopts the unattributed rows and leaves the rest', async () => {
    // The streaming path reaches the same rule by a different route: it has
    // no plan and no row policy, because it never holds the file in memory,
    // so adoption happens in makeServerIDStamper() one table at a time. The
    // case above exercises the in-memory path only, and these are the two
    // halves of one promise — a backup taken before the suite was
    // multi-server has to restore whichever writer produced it.
    const tmp = tmpDir();
    const src = await createDb();
    const S1 = defScoped(src); await S1.sync();
    await S1.create({ id: 1, serverID: src.getServerID(), note: 'mine' });
    await S1.create({ id: 2, serverID: 99, note: 'sibling' });
    await S1.create({ id: 3, serverID: null, note: 'legacy' });

    const written = await fns.exportToFile(src, tmp, { tier: 'all' });

    const dest = await createDb();
    const S2 = defScoped(dest); await S2.sync();
    await fns.restoreFromFile(written.filename, dest, tmp);

    const rows = await S2.findAll({ raw: true, order: [['id', 'ASC']] });
    assert.equal(rows.length, 3, 'the sibling\'s row is restored, not filtered out');
    assert.equal(rows[1].serverID, 99, 'and it still belongs to the server that wrote it');
    assert.equal(rows[2].serverID, dest.getServerID(),
      'a row naming no server is adopted by whoever runs the restore');

    fs2.rmSync(tmp, { recursive: true, force: true });
  });

  await runTest('a file-copy restore is refused while a sibling is live', async () => {
    // The one operation in the multi-server plan whose honest answer is
    // "unsafe" rather than "unrouted". Overwriting the database file under a
    // running process corrupts it instead of rolling it back, and the damage
    // surfaces later as unreadable rows rather than as an error here.
    const tmp = tmpDir();
    const db = await createDb();
    fs2.writeFileSync(path.join(tmp, 'squad-server-live.sqlite'), 'not really a database');
    const target = path.join(tmp, 'target.sqlite');
    fs2.writeFileSync(target, 'original');

    db.getServerID = () => 1;
    db.getLiveServers = async () => [{ serverID: 1 }, { serverID: 2 }];

    await assert.rejects(
      () => fns.restoreFromFile('squad-server-live.sqlite', db, tmp, target),
      /Refusing to restore/
    );
    assert.equal(fs2.readFileSync(target, 'utf8'), 'original', 'and it did not copy anyway');

    // A stale sibling is not a live one. The refusal has to lift itself once
    // the other process stops heartbeating, or stopping a server would leave
    // the restore blocked with nothing left to unblock it.
    db.getLiveServers = async () => [{ serverID: 1 }];
    await fns.restoreFromFile('squad-server-live.sqlite', db, tmp, target);
    assert.equal(fs2.readFileSync(target, 'utf8'), 'not really a database');

    fs2.rmSync(tmp, { recursive: true, force: true });
  });
}
await main();
if (!process.exitCode) console.log('\nAll export-import tests passed.');
