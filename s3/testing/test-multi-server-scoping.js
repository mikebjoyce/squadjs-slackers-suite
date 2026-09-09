/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   MULTI-SERVER SCOPING — THE THREE TABLES THAT HAD TO MOVE    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Nine tables in this suite took a `serverID` column and kept their names.
 * Three could not: their primary key was the thing that had to change, and a
 * primary key cannot be altered in place on either engine that matters —
 * SQLite has no statement that reaches one, and the deployed MySQL grant has
 * neither ALTER nor DROP. Each of those three is therefore a NEW table beside
 * the old one, with the old one abandoned rather than dropped:
 *
 *   SwitchPlugin_Settings    (key)            → SwitchPlugin_ServerSettings
 *   S3_PlayerReconnects      (eosID)          → S3_ServerReconnects
 *   S3_PlayerSessions        (eosID)          → S3_ServerSessions
 *
 * Everything that only holds when data actually crosses that gap is here.
 * The migration conformance suite already proves the migrations apply from
 * every prior version on every engine; what it does not ask is whether the
 * rows that came out the far side are the rows that went in.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   copy fidelity     Switch v9's INSERT … SELECT, by row count AND by
 *                     content, on all three engines. An admin who has turned
 *                     the time limit off and a live explain message id are the
 *                     two things in that table, and both survive or the
 *                     migration silently costs an operator something.
 *   idempotence       Re-applying v9 copies nothing twice and puts no old
 *                     value back over a newer one.
 *   reserved words    `key` is reserved on MySQL alone. Unquoted, the raw SQL
 *                     in v4 and v9 parses on SQLite and Postgres and fails on
 *                     the one engine in production. Asserted in both
 *                     directions rather than described.
 *   composite keys    Two servers' rows coexist and each server reads its own.
 *                     This is the whole point of the exercise; if it does not
 *                     hold, nothing else here matters.
 *   restore           §4.7.1: a backup taken BEFORE the rename, restored
 *                     AFTER it, lands in the new table under the importing
 *                     server's id — and one taken from a multi-server
 *                     community keeps the ids it carries instead.
 *   reconnect memory  The await/delete defect: getReconnect() must return the
 *                     stored row, not delete it and answer null.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-multi-server-scoping.js
 *
 *   # with the Docker engines (ports match test-dialect-portability.js):
 *   docker run -d --name s3-test-postgres -e POSTGRES_PASSWORD=postgres \
 *     -p 5433:5432 postgres:16-alpine
 *   docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -p 3307:3306 mysql:8
 *
 * SQLite always runs. MySQL and Postgres cases self-skip when unreachable.
 */

import assert from 'node:assert/strict';

import { Sequelize } from 'sequelize';

import DBService from '../utils/db-service.js';
import PlayersService from '../utils/players-service.js';
import SwitchDB from '../../switch/utils/switch-db.js';
import { importFromJSON } from '../utils/s3-export-import.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const tests = [];
const SKIP = Symbol('skip');

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(72));
  console.log('Multi-Server Scoping  (real migrations, real engines)');
  console.log('='.repeat(72));
  console.log('');

  for (const t of tests) {
    try {
      const result = await t.fn();
      if (result === SKIP) {
        console.log(`  ⚠ ${t.name} — SKIPPED (engine unreachable)`);
        skipped++;
      } else {
        console.log(`  ✓ ${t.name}`);
        passed++;
      }
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${String(err.message).split('\n')[0]}`);
      failed++;
    }
  }

  console.log('');
  console.log('─'.repeat(72));
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped, ${tests.length} total`);
  console.log('─'.repeat(72));

  if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Connection config — ports match test-dialect-portability.js
// ---------------------------------------------------------------------------

const RUN_ID = `${process.pid}_${Date.now() % 100000}`;

const MYSQL = {
  dialect: 'mysql',
  host: process.env.S3_TEST_MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.S3_TEST_MYSQL_PORT || '3307', 10),
  username: process.env.S3_TEST_MYSQL_ROOT_USER || 'root',
  password: process.env.S3_TEST_MYSQL_ROOT_PASSWORD || 'root',
  database: process.env.S3_TEST_MYSQL_DATABASE || 'mysql',
  logging: false,
  dialectOptions: { connectTimeout: 4000 }
};

const POSTGRES = {
  dialect: 'postgres',
  host: process.env.S3_TEST_PG_HOST || '127.0.0.1',
  port: parseInt(process.env.S3_TEST_PG_PORT || '5433', 10),
  username: process.env.S3_TEST_PG_ADMIN_USER || 'postgres',
  password: process.env.S3_TEST_PG_ADMIN_PASSWORD || 'postgres',
  database: process.env.S3_TEST_PG_DATABASE || 'postgres',
  logging: false,
  dialectOptions: { connectionTimeoutMillis: 4000 }
};

const SQLITE = { dialect: 'sqlite', storage: ':memory:', logging: false };

const DIALECTS = [
  { name: 'sqlite', opts: SQLITE },
  { name: 'mysql', opts: MYSQL },
  { name: 'postgres', opts: POSTGRES }
];

const reachability = new Map([['sqlite', true]]);

async function probeReachability() {
  for (const [name, opts] of [['mysql', MYSQL], ['postgres', POSTGRES]]) {
    let seq;
    try {
      seq = new Sequelize(opts);
      await seq.authenticate();
      reachability.set(name, true);
      console.log(`  ${name} reachable on ${opts.host}:${opts.port}`);
    } catch {
      reachability.set(name, false);
      console.log(`  ⚠ ${name} not reachable on ${opts.host}:${opts.port} — those cases will skip`);
    } finally {
      try { await seq?.close(); } catch { /* best effort */ }
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The server every case below runs as. Deliberately not 1: the single-server
 *  default is 1, so an id that leaked from a default rather than from the
 *  connector would still look right. */
const THIS_SERVER = 7;
/** The other server in the database. Never mounted — its rows are written by
 *  hand, because what is under test is that this process leaves them alone. */
const OTHER_SERVER = 8;

/**
 * A minimal stand-in for a mounted plugin, exposing only what schema
 * registration touches. Same shape as the conformance harness's, and for the
 * same reason: the models and migrations under test have to be the production
 * ones, not a copy that can drift.
 */
function schemaProbe(db) {
  return {
    _s3db: db,
    s3db: db,
    verbose: () => {},
    defineModel: (name, schema, opts) => db.defineModel(name, schema, opts),
    registerExpectedVersion: (name, version, opts) => db.registerExpectedVersion(name, version, opts),
    registerMigrations: (name, migrations) => db.migrationEngine.registerMigrations(name, migrations),
    verifyAndRunMigrations: async () => null,
    _getModel: (name) => db.getModel(name),
    _withDb: async (fn) => fn(),
    reportError: () => {}
  };
}

async function openDb(dialect, serverID = THIS_SERVER) {
  const base = DIALECTS.find((d) => d.name === dialect).opts;
  let opts = base;

  // MySQL/Postgres share a server across runs, so each case gets its own
  // database rather than colliding on table names.
  let adminSeq = null;
  let dbName = null;
  if (dialect !== 'sqlite') {
    dbName = `s3_scope_${RUN_ID}_${Math.floor(Math.random() * 100000)}`;
    adminSeq = new Sequelize(base);
    await adminSeq.query(`CREATE DATABASE ${dbName}`);
    await adminSeq.close();
    opts = { ...base, database: dbName };
  }

  const seq = new Sequelize(opts);
  const db = new DBService({
    sequelize: seq,
    serverID,
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();
  return { db, seq, dialect, dbName, base };
}

async function closeDb(ctx) {
  try { await ctx.db.unmount(); } catch { /* best effort */ }
  try { await ctx.seq.close(); } catch { /* best effort */ }
  if (ctx.dbName) {
    try {
      const adminSeq = new Sequelize(ctx.base);
      await adminSeq.query(`DROP DATABASE IF EXISTS ${ctx.dbName}`);
      await adminSeq.close();
    } catch { /* best effort */ }
  }
}

/** Register Switch's real models and migrations. Returns them, ascending. */
async function registerSwitch(db) {
  await SwitchDB.register(schemaProbe(db));
  const all = [...(db.migrationEngine._migrations.get('switch') || [])]
    .sort((a, b) => a.version - b.version);
  assert.ok(all.length > 0, 'switch registered no migrations');
  return all;
}

/** Register the reconnect and session schema PlayersService owns. */
async function registerPlayers(db) {
  const probe = {
    reconnectPersistence: true,
    _getDbService: () => db,
    verbose: () => {},
    verboseLogger: () => {}
  };
  await PlayersService.prototype._initReconnectPersistence.call(probe);
  await PlayersService.prototype._initSessionPersistence.call(probe);
  return probe;
}

/**
 * Narrow the engine's registration to a version range, so a server that has
 * been running since before the rename can be stood up and then upgraded.
 * Reaches into _migrations for the reason the conformance harness does:
 * registerMigrations() is append-only by design.
 */
function stageVersions(db, pluginName, migrations) {
  db.migrationEngine._migrations.set(pluginName, [...migrations].sort((a, b) => a.version - b.version));
}

async function applyPending(db, pluginName) {
  db.migrationEngine.confirmToken('__force__');
  return db.migrationEngine.runMigrations(pluginName);
}

/** Roll the recorded version back, so the next run re-applies from there. */
async function setRecordedVersion(db, pluginName, version) {
  await db.SchemaVersionsModel.update({ version }, { where: { pluginName } });
}

/** SELECT through the service's own connection, with every identifier quoted. */
async function select(db, sql, replacements = {}) {
  return db.sequelize.query(sql, {
    replacements,
    type: db.sequelize.constructor.QueryTypes.SELECT
  });
}

async function exec(db, sql, replacements = {}) {
  return db.sequelize.query(sql, { replacements });
}

/** Settings rows as a plain { key: value } map, for content comparison. */
async function readSettings(db, table, serverID = null) {
  const q = (id) => db.quoteIdentifier(id);
  const where = serverID === null ? '' : ` WHERE ${q('serverID')} = :serverID`;
  const columns = serverID === null
    ? `${q('key')}, ${q('value')}`
    : `${q('serverID')}, ${q('key')}, ${q('value')}`;
  const rows = await select(db, `SELECT ${columns} FROM ${q(table)}${where}`, { serverID });
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return { rows, map: out };
}

/**
 * Stand a database up as a pre-rename server: Switch at v8, with the two
 * settings an operator would actually have changed by hand.
 *
 * The values are deliberately not the seeded defaults. A copy that lost the
 * rows would still read as "two rows, right keys" if the destination had been
 * seeded independently — only the values distinguish a copy from a coincidence.
 */
async function stageSwitchBeforeRename(db) {
  const q = (id) => db.quoteIdentifier(id);
  const all = await registerSwitch(db);
  stageVersions(db, 'switch', all.filter((m) => m.version <= 8));
  const staged = await applyPending(db, 'switch');
  assert.equal(staged.applied, 8, `staging to v8 applied ${staged.applied}`);

  await exec(
    db,
    `UPDATE ${q('SwitchPlugin_Settings')} SET ${q('value')} = :value WHERE ${q('key')} = :key`,
    { key: 'timeLimitEnabled', value: 'false' }
  );
  await exec(
    db,
    `UPDATE ${q('SwitchPlugin_Settings')} SET ${q('value')} = :value WHERE ${q('key')} = :key`,
    { key: 'explainMessageId', value: '1399000000000000001' }
  );

  return all;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

for (const { name: dialect } of DIALECTS) {
  test(`[${dialect}] switch v9 copies every setting onto this server, by count and by content`, async () => {
    if (!reachability.get(dialect)) return SKIP;
    const ctx = await openDb(dialect);
    try {
      const all = await stageSwitchBeforeRename(ctx.db);
      const before = await readSettings(ctx.db, 'SwitchPlugin_Settings');

      stageVersions(ctx.db, 'switch', all);
      const upgrade = await applyPending(ctx.db, 'switch');
      // Counted from the registered list rather than written as a literal.
      // "v9 alone" was true when v9 was the last switch migration and stopped
      // being true the moment v10 landed, which failed this test for a reason
      // that had nothing to do with what it checks. What matters is that the
      // whole tail above v8 ran; the copy itself is asserted below.
      const aboveV8 = all.filter((m) => m.version > 8).length;
      assert.equal(upgrade.applied, aboveV8, `upgrade applied ${upgrade.applied}, expected the ${aboveV8} migration(s) above v8`);

      const after = await readSettings(ctx.db, 'SwitchPlugin_ServerSettings', THIS_SERVER);
      assert.equal(after.rows.length, before.rows.length, 'row count differs from the source table');
      assert.deepEqual(after.map, before.map, 'copied values differ from the source table');
      assert.equal(after.map.timeLimitEnabled, 'false', 'the hand-set time limit did not survive');
      assert.equal(after.map.explainMessageId, '1399000000000000001', 'the live explain message id did not survive');
      for (const row of after.rows) {
        assert.equal(Number(row.serverID), THIS_SERVER, `row "${row.key}" landed under server ${row.serverID}`);
      }

      // The old table is abandoned, not emptied. Nothing drops it — the
      // deployed grant cannot — so it must still read exactly as it did.
      const stillThere = await readSettings(ctx.db, 'SwitchPlugin_Settings');
      assert.deepEqual(stillThere.map, before.map, 'the abandoned table was modified');
    } finally {
      await closeDb(ctx);
    }
  });

  test(`[${dialect}] re-applying v9 copies nothing twice and overwrites nothing`, async () => {
    if (!reachability.get(dialect)) return SKIP;
    const ctx = await openDb(dialect);
    try {
      const all = await stageSwitchBeforeRename(ctx.db);
      stageVersions(ctx.db, 'switch', all);
      await applyPending(ctx.db, 'switch');

      // An operator changes a setting on the NEW table after migrating. The
      // re-run must not put the old value back over it — that is what the
      // NOT EXISTS in v9 is for, and a bare INSERT … SELECT would either
      // collide on the primary key or resurrect a stale value.
      const q = (id) => ctx.db.quoteIdentifier(id);
      await exec(
        ctx.db,
        `UPDATE ${q('SwitchPlugin_ServerSettings')} SET ${q('value')} = :value ` +
        `WHERE ${q('serverID')} = :serverID AND ${q('key')} = :key`,
        { serverID: THIS_SERVER, key: 'timeLimitEnabled', value: 'changed-after-migrating' }
      );

      await setRecordedVersion(ctx.db, 'switch', 8);
      const again = await applyPending(ctx.db, 'switch');
      const aboveV8 = all.filter((m) => m.version > 8).length;
      assert.equal(again.applied, aboveV8, `re-run applied ${again.applied}, expected ${aboveV8}`);

      const after = await readSettings(ctx.db, 'SwitchPlugin_ServerSettings', THIS_SERVER);
      assert.equal(after.rows.length, 2, `re-run left ${after.rows.length} rows, expected 2`);
      assert.equal(after.map.timeLimitEnabled, 'changed-after-migrating', 'the re-run put the old value back');
    } finally {
      await closeDb(ctx);
    }
  });

  // The migration that a released migration's edit made necessary, and the
  // shape of bug this case exists to catch generally: an install that already
  // recorded a version never re-runs it, so amending that version's body
  // reaches fresh installs only. v6 creates SwitchPlugin_RoundStats and was
  // amended to create it WITH serverID; every install that took v6 before the
  // amendment has the table without the column, and the model declares it, so
  // every read of the table fails and the next mount reports drift.
  //
  // Staged by taking v6 as it now stands and dropping the column back off,
  // which is what those installs actually have. Faithful and self-maintaining:
  // pinning a copy of the released v6 here would be a second schema to keep in
  // step with the first.
  test(`[${dialect}] a server that took v6 before it carried serverID still gets the column`, async () => {
    if (!reachability.get(dialect)) return SKIP;
    const ctx = await openDb(dialect);
    try {
      const q = (id) => ctx.db.quoteIdentifier(id);
      const all = await registerSwitch(ctx.db);
      stageVersions(ctx.db, 'switch', all.filter((m) => m.version <= 6));
      await applyPending(ctx.db, 'switch');

      await exec(ctx.db, `ALTER TABLE ${q('SwitchPlugin_RoundStats')} DROP COLUMN ${q('serverID')}`);
      const stale = await ctx.db.sequelize.getQueryInterface().describeTable('SwitchPlugin_RoundStats');
      assert.ok(!stale.serverID, 'the staged pre-amendment table still has serverID');

      stageVersions(ctx.db, 'switch', all);
      await applyPending(ctx.db, 'switch');

      const repaired = await ctx.db.sequelize.getQueryInterface().describeTable('SwitchPlugin_RoundStats');
      assert.ok(repaired.serverID, 'serverID never arrived on SwitchPlugin_RoundStats');

      // The column existing is not the whole claim: the model declares it, so
      // a read has to work. This is the assertion that fails first and loudest
      // on a live box — "Unknown column 'serverID' in 'field list'".
      await select(ctx.db, `SELECT ${q('serverID')} FROM ${q('SwitchPlugin_RoundStats')}`);

      // And the repair must own the column at the version that can restore it.
      // Declared on v6, a later loss of serverID sends the repair back to v6,
      // whose createTable is guarded on the table not existing and so restores
      // nothing — a rollback that re-fires on every mount and never converges.
      const owning = all.filter((m) => m.touches?.columns?.SwitchPlugin_RoundStats?.includes('serverID'));
      assert.equal(owning.length, 1, `${owning.length} migrations claim RoundStats.serverID, expected 1`);
      assert.ok(
        owning[0].version > 6,
        `v${owning[0].version} claims RoundStats.serverID; a version that only creates the table cannot restore it`
      );
    } finally {
      await closeDb(ctx);
    }
  });

  test(`[${dialect}] the settings key column is safe quoted, and only quoted`, async () => {
    if (!reachability.get(dialect)) return SKIP;
    const ctx = await openDb(dialect);
    try {
      const all = await stageSwitchBeforeRename(ctx.db);
      stageVersions(ctx.db, 'switch', all);
      await applyPending(ctx.db, 'switch');

      const q = (id) => ctx.db.quoteIdentifier(id);
      const quoted = await select(
        ctx.db,
        `SELECT ${q('key')}, ${q('value')} FROM ${q('SwitchPlugin_ServerSettings')} WHERE ${q('key')} = :key`,
        { key: 'timeLimitEnabled' }
      );
      assert.equal(quoted.length, 1, 'the quoted form did not return the row');

      // The table name stays quoted here so the only variable is the column:
      // Postgres folds an unquoted mixed-case table name and would fail for a
      // reason that has nothing to do with reserved words.
      const unquoted = `SELECT key FROM ${q('SwitchPlugin_ServerSettings')}`;
      if (dialect === 'mysql') {
        await assert.rejects(
          () => select(ctx.db, unquoted),
          'MySQL accepted an unquoted `key` — the reserved-word hazard this suite guards has moved'
        );
      } else {
        // Passes here, which is exactly the problem: a missing quote is
        // invisible on both engines a developer is likely to test against and
        // fatal on the one in production.
        await select(ctx.db, unquoted);
      }
    } finally {
      await closeDb(ctx);
    }
  });

  test(`[${dialect}] a composite key keeps two servers' settings apart`, async () => {
    if (!reachability.get(dialect)) return SKIP;
    const ctx = await openDb(dialect);
    try {
      const all = await stageSwitchBeforeRename(ctx.db);
      stageVersions(ctx.db, 'switch', all);
      await applyPending(ctx.db, 'switch');

      const q = (id) => ctx.db.quoteIdentifier(id);
      await exec(
        ctx.db,
        `INSERT INTO ${q('SwitchPlugin_ServerSettings')} (${q('serverID')}, ${q('key')}, ${q('value')}) ` +
        'VALUES (:serverID, :key, :value)',
        { serverID: OTHER_SERVER, key: 'timeLimitEnabled', value: 'true' }
      );

      // Same key, two rows, two answers. Under the old single-column key the
      // insert above could not even have been stored.
      const model = ctx.db.getModel('SwitchPlugin_Settings');
      const mine = await model.findOne({ where: { serverID: THIS_SERVER, key: 'timeLimitEnabled' } });
      const theirs = await model.findOne({ where: { serverID: OTHER_SERVER, key: 'timeLimitEnabled' } });
      assert.equal(mine?.value, 'false', 'this server read the wrong row');
      assert.equal(theirs?.value, 'true', 'the other server read the wrong row');

      const all9 = await model.findAll({ where: { key: 'timeLimitEnabled' } });
      assert.equal(all9.length, 2, `expected both servers' rows, found ${all9.length}`);
    } finally {
      await closeDb(ctx);
    }
  });

  test(`[${dialect}] a pre-rename backup restores into the new table under this server`, async () => {
    if (!reachability.get(dialect)) return SKIP;
    const ctx = await openDb(dialect);
    try {
      const all = await registerSwitch(ctx.db);
      stageVersions(ctx.db, 'switch', all);
      await applyPending(ctx.db, 'switch');
      await registerPlayers(ctx.db);
      await applyPending(ctx.db, 's3-players');

      // An envelope from before any of this existed: keyed by MODEL name,
      // which is what did not move, and carrying no serverID at all because
      // the tables it came from had no such column.
      const now = Date.now();
      const envelope = {
        s3ExportVersion: 1,
        exportedAt: new Date(now).toISOString(),
        tables: {
          SwitchPlugin_Settings: [
            { key: 'timeLimitEnabled', value: 'false' },
            { key: 'explainMessageId', value: '1399000000000000002' }
          ],
          S3PlayerReconnect: [
            {
              eosID: 'eos-restored-1',
              steamID: '76500000000000001',
              playerName: 'Restored',
              lastTeamID: 2,
              lastSeenAt: now,
              updatedAt: now
            }
          ]
        }
      };

      const result = await importFromJSON(ctx.db, envelope);
      assert.equal(result.imported.SwitchPlugin_Settings.status, 'ok', result.imported.SwitchPlugin_Settings.error);
      assert.equal(result.imported.S3PlayerReconnect.status, 'ok', result.imported.S3PlayerReconnect.error);
      assert.equal(result.imported.SwitchPlugin_Settings.stamped, 2, 'both settings rows should have been adopted');
      assert.equal(result.imported.S3PlayerReconnect.stamped, 1, 'the reconnect row should have been adopted');

      const settings = await readSettings(ctx.db, 'SwitchPlugin_ServerSettings', THIS_SERVER);
      assert.equal(settings.map.timeLimitEnabled, 'false', 'the restored toggle is not in the new table');
      assert.equal(settings.map.explainMessageId, '1399000000000000002', 'the restored message id is not in the new table');

      const reconnect = await ctx.db.getModel('S3PlayerReconnect')
        .findOne({ where: { serverID: THIS_SERVER, eosID: 'eos-restored-1' } });
      assert.ok(reconnect, 'the restored reconnect row is not under this server');
      assert.equal(reconnect.playerName, 'Restored');

      // The abandoned table is not where a restore goes. It still holds what
      // the migrations seeded, and nothing more.
      const q = (id) => ctx.db.quoteIdentifier(id);
      const old = await readSettings(ctx.db, 'SwitchPlugin_Settings');
      assert.equal(old.map.timeLimitEnabled, 'true', 'the import wrote to the abandoned table');
      const oldReconnects = await select(ctx.db, `SELECT ${q('eosID')} FROM ${q('S3_PlayerReconnects')}`);
      assert.equal(oldReconnects.length, 0, 'the import resurrected the abandoned reconnects table');
    } finally {
      await closeDb(ctx);
    }
  });

  test(`[${dialect}] an envelope that names its servers keeps them`, async () => {
    if (!reachability.get(dialect)) return SKIP;
    const ctx = await openDb(dialect);
    try {
      const all = await registerSwitch(ctx.db);
      stageVersions(ctx.db, 'switch', all);
      await applyPending(ctx.db, 'switch');

      // Post-rename, multi-server: every row says where it belongs. Adopting
      // these would fold a community's servers onto whichever one happened to
      // run the restore — and it would succeed quietly, which is worse than
      // the failure the stamping fixes.
      const envelope = {
        s3ExportVersion: 1,
        exportedAt: new Date().toISOString(),
        tables: {
          SwitchPlugin_Settings: [
            { serverID: OTHER_SERVER, key: 'timeLimitEnabled', value: 'other-server-value' }
          ]
        }
      };

      // Default: the row is left where it is and the summary names the server
      // it belongs to. Skipping is the safe half of the same rule — the row
      // is not folded onto this server either way, and an operator who did
      // mean to touch a sibling's settings has to say so.
      const skipped = await importFromJSON(ctx.db, envelope);
      assert.equal(skipped.imported.SwitchPlugin_Settings.status, 'ok', skipped.imported.SwitchPlugin_Settings.error);
      assert.equal(skipped.imported.SwitchPlugin_Settings.rows, 0);
      assert.deepEqual(skipped.imported.SwitchPlugin_Settings.skippedServerIDs, [OTHER_SERVER],
        'a skipped row has to name whose it was, or the operator cannot tell what is missing');
      const untouched = await readSettings(ctx.db, 'SwitchPlugin_ServerSettings', OTHER_SERVER);
      assert.equal(untouched.map.timeLimitEnabled, undefined, 'the default import wrote a sibling row');

      // Widened: the row lands under the server it named, and is still not
      // re-stamped. This is the assertion the case was written for.
      const result = await importFromJSON(ctx.db, envelope, { allServers: true });
      assert.equal(result.imported.SwitchPlugin_Settings.status, 'ok', result.imported.SwitchPlugin_Settings.error);
      assert.equal(result.imported.SwitchPlugin_Settings.stamped, undefined, 'a row that named its server was re-stamped');

      const theirs = await readSettings(ctx.db, 'SwitchPlugin_ServerSettings', OTHER_SERVER);
      assert.equal(theirs.map.timeLimitEnabled, 'other-server-value', 'the row did not land under the server it named');

      const mine = await readSettings(ctx.db, 'SwitchPlugin_ServerSettings', THIS_SERVER);
      assert.equal(mine.map.timeLimitEnabled, 'true', "the import overwrote this server's own row");
    } finally {
      await closeDb(ctx);
    }
  });

  test(`[${dialect}] getReconnect returns the stored row instead of deleting it`, async () => {
    if (!reachability.get(dialect)) return SKIP;
    const ctx = await openDb(dialect);
    try {
      const players = new PlayersService({
        parent: { services: { db: ctx.db } },
        server: { on: () => {}, off: () => {}, removeListener: () => {} }
      });
      await players._initReconnectPersistence();
      await applyPending(ctx.db, 's3-players');

      await players.rememberReconnect('eos-reconnect-1', {
        steamID: '76500000000000002',
        playerName: 'Dropped',
        lastTeamID: 2,
        lastSeenAt: Date.now()
      });

      // The in-memory map would answer this on its own, and did — which is
      // how the defect below survived: the unit suite runs with no model at
      // all, so the database branch was never taken by a test.
      players._reconnectMemory.clear();

      // The defect: `await dbService?.executeWithRetry ? A : B` awaited the
      // FUNCTION REFERENCE, used it as the condition, and assigned the
      // unawaited promise to `row`. A promise is truthy, every field read as
      // undefined, the staleness check said yes — and the branch that follows
      // DELETED the row and returned null. Persisted reconnect memory had
      // therefore never worked with a database attached, and destroyed the
      // row it was asked for.
      const row = await players.getReconnect('eos-reconnect-1');
      assert.ok(row, 'getReconnect returned nothing for a row it had just written');
      assert.equal(row.playerName, 'Dropped');
      assert.equal(Number(row.lastTeamID), 2);

      const survivors = await ctx.db.getModel('S3PlayerReconnect')
        .findAll({ where: { serverID: THIS_SERVER, eosID: 'eos-reconnect-1' } });
      assert.equal(survivors.length, 1, 'the read deleted the row it was asked for');

      // Reading it a second time is the same answer, from the same row.
      players._reconnectMemory.clear();
      const again = await players.getReconnect('eos-reconnect-1');
      assert.ok(again, 'the second read found nothing');
    } finally {
      await closeDb(ctx);
    }
  });

  test(`[${dialect}] reconnect memory is per server, not per player`, async () => {
    if (!reachability.get(dialect)) return SKIP;
    const ctx = await openDb(dialect);
    try {
      const players = new PlayersService({
        parent: { services: { db: ctx.db } },
        server: { on: () => {}, off: () => {}, removeListener: () => {} }
      });
      await players._initReconnectPersistence();
      await applyPending(ctx.db, 's3-players');

      const now = Date.now();
      await players.rememberReconnect('eos-shared', { playerName: 'Here', lastTeamID: 1, lastSeenAt: now });

      // The same player, on the other server, last seen on the other team.
      // Under the old single-column key this row could not exist; under the
      // new one, reading it here would put someone on a team from a server
      // they are not on.
      await ctx.db.getModel('S3PlayerReconnect').create({
        serverID: OTHER_SERVER,
        eosID: 'eos-shared',
        steamID: null,
        playerName: 'Elsewhere',
        lastTeamID: 2,
        lastSeenAt: now,
        updatedAt: now
      });

      players._reconnectMemory.clear();
      const row = await players.getReconnect('eos-shared');
      assert.ok(row, 'getReconnect found neither row');
      assert.equal(row.playerName, 'Here', "this server read the other server's reconnect");
      assert.equal(Number(row.lastTeamID), 1, "this server restored the other server's team");

      // clearReconnects() is scoped too: an unqualified DELETE here would
      // throw away the other server's memory at the moment it is most needed.
      await players.clearReconnects();
      const theirs = await ctx.db.getModel('S3PlayerReconnect')
        .findAll({ where: { serverID: OTHER_SERVER } });
      assert.equal(theirs.length, 1, "clearReconnects() deleted the other server's rows");
    } finally {
      await closeDb(ctx);
    }
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await probeReachability();
await run();
