/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   TEST: ADMIN MUTATIONS & LIVE STATE — the real write paths   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * v2.5.6 reworked every admin path that touches SwitchPlugin_PlayerCooldowns.
 * The defects it fixes all survived a green suite for the same reason: the
 * existing Switch tests model the database in JavaScript (see mock-harness.js
 * and test-admin-clear.js, which *simulates* a clear by hand-writing the row
 * it expects the clear to produce). A JavaScript object cannot reject a
 * TRUNCATE for want of a DROP grant, and it does not implement three-valued
 * logic, so both of the bugs that actually hurt were invisible.
 *
 * Everything here therefore runs the shipped code against a real engine.
 *
 * ─── WHAT IT PINS ────────────────────────────────────────────────
 *
 *   1. adminWipeAll() is DML. On live MySQL the old `destroy({truncate:true})`
 *      raised "DROP command denied", _withDb() swallowed it, and `!switch
 *      clearall` replied nothing at all. Covered twice: once for the DELETE
 *      itself, once through a MySQL user holding only SELECT/INSERT/UPDATE/
 *      DELETE — the shape of the live account.
 *   2. Admin failures PROPAGATE. The helpers no longer run inside _withDb().
 *   3. No path confiscates seed tokens. A player above the ordinary cap is
 *      topped up with Math.max, never assigned maxSwitchTokens.
 *   4. NULL tokenBalance still gets its lock cleared (`< 2` is UNKNOWN against
 *      NULL on every engine, so the NULL arm has to be spelled out).
 *   5. normalizeRegeneratedTokens() writes back completed regeneration, which
 *      is what makes the tier-1 prune reachable at all — it matched 0 of 378
 *      real production rows before this.
 *   6. _sweepStaleSeedState() clears last round's seed presence at NEW_GAME,
 *      including rows whose lastSeedBonusRoundID is NULL.
 *   7. getLiveRestrictionState() reports as blocked only players who are
 *      actually blocked, and counts seed accrual only for connected players.
 *      The Discord panel previously listed five players at "2/2 tokens (full)"
 *      under "Restricted Players" and claimed 75 were accruing seed time when
 *      the last seed round had ended ten hours earlier.
 *   8. The match-end queue dedups on enqueue and is consumed unconditionally,
 *      so a failed switch no longer re-fires every round end forever.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-admin-mutations.js
 *
 * Category: 2 — SQLite always; MySQL when reachable on 127.0.0.1:3307
 * (same engine and port as s3/testing/test-dialect-portability.js). MySQL
 * cases SKIP rather than silently pass when the engine is down; the skip
 * count is printed and a non-zero skip count is not a green run.
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';

import DBService from '../../s3/utils/db-service.js';
import SwitchDB from '../utils/switch-db.js';
import SwitchOutput from '../utils/switch-output.js';
import SwitchQueue from '../utils/switch-queue.js';
import SwitchCommands from '../utils/switch-commands.js';
import SwitchExplain from '../utils/switch-explain.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';

const TABLE = 'SwitchPlugin_PlayerCooldowns';
const STATE_TABLE = 'SwitchPlugin_PlayerServerState';
const ENDMATCHES = 'SwitchPlugin_Endmatches';
const ASSEMBLY = buildAssembly('.tmp-switch-admin-mutations');
const Switch = await importFromAssembly(ASSEMBLY, 'switch.js');

const SKIP = Symbol('skip');

let passed = 0;
let failed = 0;
let skipped = 0;

async function runTest(name, fn) {
  try {
    const result = await fn();
    if (result === SKIP) {
      console.log(`  ⚠ ${name} — SKIPPED (engine unreachable)`);
      skipped++;
      return;
    }
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    if (process.env.SWITCH_TEST_STACK) console.error(err.stack);
    failed++;
  }
}

// ── Engines ────────────────────────────────────────────────────────

const MYSQL_ROOT = {
  dialect: 'mysql',
  host: process.env.S3_TEST_MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.S3_TEST_MYSQL_PORT || '3307', 10),
  username: process.env.S3_TEST_MYSQL_ROOT_USER || 'root',
  password: process.env.S3_TEST_MYSQL_ROOT_PASSWORD || 'root',
  database: process.env.S3_TEST_MYSQL_DATABASE || 'mysql',
  logging: false,
  dialectOptions: { connectTimeout: 4000 }
};

const MYSQL_NODDL_USER = process.env.S3_TEST_MYSQL_NODDL_USER || 's3_noddl';
const MYSQL_NODDL_PASS = process.env.S3_TEST_MYSQL_NODDL_PASSWORD || 'noddl';

const SQLITE = { dialect: 'sqlite', storage: ':memory:', logging: false };

const RUN_ID = `${process.pid}_${Date.now() % 100000}`;

let mysqlReachable = false;

// One scratch database for the whole file, not one per case. Migrations record
// their version in SchemaVersions, so a case that dropped its tables would
// leave the next case with a version row claiming v5 and no tables to match it.
// Cases share the schema and clear rows between themselves instead.
const MYSQL_DB = `s3_switch_admin_${RUN_ID}`;
let MYSQL = null;

async function probeMysql() {
  let admin;
  try {
    admin = new Sequelize(MYSQL_ROOT);
    await admin.authenticate();
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_DB}\`;`);
    MYSQL = { ...MYSQL_ROOT, database: MYSQL_DB };
    mysqlReachable = true;
    console.log(`  mysql reachable on ${MYSQL_ROOT.host}:${MYSQL_ROOT.port} (scratch db ${MYSQL_DB})`);
  } catch (err) {
    mysqlReachable = false;
    console.log(`  ⚠ mysql not reachable on ${MYSQL_ROOT.host}:${MYSQL_ROOT.port} — those cases will skip (${err.message})`);
  } finally {
    try { await admin?.close(); } catch { /* best effort */ }
  }
  console.log('');
}

async function dropMysqlScratch() {
  if (!mysqlReachable) return;
  let admin;
  try {
    admin = new Sequelize(MYSQL_ROOT);
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\`;`);
  } catch { /* best effort */ } finally {
    try { await admin?.close(); } catch { /* best effort */ }
  }
}

// ── A mounted-enough Switch, against a real engine ─────────────────
//
// Same approach as test-scramble-lockdown.js and for the same reason: the
// handlers under test are class fields holding arrow functions, so they exist
// only on real instances and cannot be borrowed onto a stub. Only the
// collaborators are replaced; every statement between the call and the row is
// production code.

async function buildPlugin({
  dialect = 'sqlite',
  sequelizeOpts = null,
  options = {},
  connected = [],
  currentMatchId = 'round-current',
  seedMode = false
} = {}) {
  const opts = sequelizeOpts || (dialect === 'sqlite' ? SQLITE : MYSQL);
  const seq = new Sequelize(opts);
  const db = new DBService({ sequelize: seq, defaultRetry: { attempts: 1, baseDelayMs: 0, jitterMs: 0 } });
  await db.mount();

  const server = { players: connected, on: () => {}, off: () => {}, removeListener: () => {} };

  const plugin = new Switch(server, {
    maxSwitchTokens: 2,
    switchCooldownHours: 1.75,
    seedTokenBonusAmount: 1,
    seedTokenBonusMinutes: 20,
    seedTokenBonusMinPlayers: 0,
    pruneInactivePlayerDays: 3,
    ...options
  }, {});

  Object.assign(plugin, {
    verbose: () => {},
    warn: () => {},
    sendDiscordMessage: async () => {},
    reportError: () => {},
    _s3db: db,
    _getModel: (n) => db.getModel(n),
    // Migrations are driven directly below, so the plugin's own gate is stubbed.
    verifyAndRunMigrations: async () => null,
    // NOTE: the real _withDb swallows errors and returns null. The admin
    // helpers deliberately do NOT go through it — see adminTx in switch-db.js
    // — so this propagating stub cannot hide a regression in the paths this
    // file exists to pin.
    _withDb: async (fn) => db.withTransactionWithRetry(fn),
    _s3: {
      gameState: {
        isSeedMode: () => seedMode,
        getMatchId: () => currentMatchId
      },
      players: {
        isReady: () => true,
        getAllPlayers: () => connected,
        getPlayer: (id) => connected.find((p) => p.eosID === id) || null,
        resetJoinTime: async () => true
      }
    },
    getSecondsFromJoin: async () => 9999,
    getSecondsFromMatchStart: () => 9999,
    // Skip the 15s round-end player warning; see MATCHEND_WARN_DELAY_MS.
    _matchendWarnDelayMs: 0
  });

  // Register against the real instance, in the same order as _onS3Ready(), so
  // every plugin.* helper closes over the real options and services rather
  // than a stub's — and so the handlers can reach the helpers the other
  // modules attach.
  SwitchOutput.register(plugin);
  SwitchQueue.register(plugin);
  SwitchCommands.register(plugin);
  SwitchExplain.register(plugin);
  await SwitchDB.register(plugin);
  db.migrationEngine.confirmToken('__force__');
  await db.migrationEngine.runMigrations('switch');

  return {
    plugin, db, seq,
    model: db.getModel(TABLE),
    stateModel: db.getModel(STATE_TABLE),
    endmatches: db.getModel(ENDMATCHES)
  };
}

// Rows, not tables: the MySQL scratch database is shared across cases and its
// schema must outlive any one of them.
async function teardown({ db, seq, model, stateModel, endmatches }) {
  try { await model?.destroy({ where: {} }); } catch { /* best effort */ }
  try { await stateModel?.destroy({ where: {} }); } catch { /* best effort */ }
  try { await endmatches?.destroy({ where: {} }); } catch { /* best effort */ }
  try { await db.unmount(); } catch { /* best effort */ }
  try { await seq.close(); } catch { /* best effort */ }
}

/**
 * Runs `fn` on both engines, skipping MySQL when it is not up.
 *
 * Strictly sequential — every MySQL case shares one database, so overlapping
 * them would have cases clearing each other's rows.
 */
async function onEachEngine(name, fn) {
  await runTest(`${name} [sqlite]`, () => fn('sqlite'));
  await runTest(`${name} [mysql]`, async () => {
    if (!mysqlReachable) return SKIP;
    return fn('mysql');
  });
}

const HOUR = 3600 * 1000;
const row = (over = {}) => ({
  eosID: 'eos-x',
  playerName: 'X',
  tokenBalance: 2,
  seedBonusTokensEarned: 0,
  lastActiveTimestamp: new Date(),
  ...over
});

// The four columns the split moved to SwitchPlugin_PlayerServerState.
const MOVED = [
  'scrambleLockdownExpiry', 'seedPresenceStart', 'lastSeedBonusRoundID', 'seedBonusTokensEarned'
];

/**
 * Seed a player from one literal, into whichever tables it belongs in.
 *
 * The cases here describe players, not rows, and they described them in one
 * object before the split. Keeping that shape and splitting it here means a
 * case still reads as "this player has three tokens and a live lock" rather
 * than as two inserts an editor has to keep in step — and it is the fixture,
 * not the subject: the production paths write the two tables themselves and
 * are asserted doing it.
 *
 * Server 1 throughout, which is what DBService resolves to with no `server.id`
 * configured. A case that needs another server writes it directly.
 */
async function plant(ctx, defs) {
  const list = Array.isArray(defs) ? defs : [defs];
  const wallets = [];
  const sides = [];
  for (const def of list) {
    const wallet = { ...def };
    const side = {
      serverID: 1,
      eosID: def.eosID,
      lastActiveTimestamp: def.lastActiveTimestamp ?? new Date()
    };
    for (const col of MOVED) {
      if (col in wallet) { side[col] = wallet[col]; delete wallet[col]; }
    }
    wallets.push(wallet);
    sides.push(side);
  }
  await ctx.model.bulkCreate(wallets);
  await ctx.stateModel.bulkCreate(sides);
}

console.log('');
console.log('🧪 Switch Admin Mutations & Live State — real engines');
console.log('');
await probeMysql();

// ═══════════════════════════════════════════════════════════════════
// 1. adminWipeAll — plain DML, and it reports what it did
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('wipe deletes every row and returns the count', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    await plant(ctx, [
      row({ eosID: 'a' }), row({ eosID: 'b' }), row({ eosID: 'c', tokenBalance: 3 })
    ]);
    // Both counts, because a wipe that empties the wallets and leaves the
    // per-server rows behind leaves locks and seed clocks with nothing to
    // belong to — and the next read resurrects them against a player the
    // plugin now treats as brand new.
    const { deleted, stateDeleted } = await ctx.plugin.adminWipeAll();
    assert.strictEqual(deleted, 3, 'wipe should report the rows it deleted');
    assert.strictEqual(stateDeleted, 3, 'wipe should report the per-server rows it deleted');
    assert.strictEqual(await ctx.model.count(), 0, 'table should be empty after a wipe');
    assert.strictEqual(await ctx.stateModel.count(), 0, 'per-server table should be empty after a wipe');
  } finally {
    await teardown(ctx);
  }
});

// The regression itself. A DML-only account is what the live server runs as.
await runTest('wipe succeeds as a MySQL user with no DDL grants [mysql]', async () => {
  if (!mysqlReachable) return SKIP;

  const dbName = `s3_switch_wipe_${RUN_ID}`;
  const admin = new Sequelize(MYSQL_ROOT);

  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
    await admin.query(`CREATE DATABASE \`${dbName}\`;`);
    await admin.query(`CREATE USER IF NOT EXISTS '${MYSQL_NODDL_USER}'@'%' IDENTIFIED BY '${MYSQL_NODDL_PASS}';`);
    // Exactly the live grant set: DML only. No DROP, so TRUNCATE is refused.
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${dbName}\`.* TO '${MYSQL_NODDL_USER}'@'%';`);
    await admin.query('FLUSH PRIVILEGES;');

    // Schema is created by the admin — mirroring the live server, where the
    // DBA applies migrations by hand and the plugin's account never has DDL.
    const bootstrap = await buildPlugin({
      dialect: 'mysql',
      sequelizeOpts: { ...MYSQL_ROOT, database: dbName }
    });
    await plant(bootstrap, [row({ eosID: 'a' }), row({ eosID: 'b' })]);
    // Leave the tables in place for the restricted user.
    try { await bootstrap.db.unmount(); } catch { /* best effort */ }
    try { await bootstrap.seq.close(); } catch { /* best effort */ }

    const restricted = await buildPlugin({
      dialect: 'mysql',
      sequelizeOpts: {
        ...MYSQL_ROOT,
        database: dbName,
        username: MYSQL_NODDL_USER,
        password: MYSQL_NODDL_PASS
      }
    });

    try {
      // Pre-flight: prove this account really cannot TRUNCATE, so that a pass
      // below means the fix works rather than that the grant never bit.
      let truncateRejected = false;
      try {
        await restricted.seq.query(`TRUNCATE TABLE \`${TABLE}\`;`);
      } catch (err) {
        truncateRejected = /denied|privilege/i.test(err.message);
      }
      assert.ok(
        truncateRejected,
        'the restricted user was able to TRUNCATE — the grant setup is wrong and this test proves nothing'
      );

      const { deleted, stateDeleted } = await restricted.plugin.adminWipeAll();
      assert.strictEqual(deleted, 2, 'DML-only wipe should have deleted both rows');
      assert.strictEqual(stateDeleted, 2, 'DML-only wipe should have deleted both per-server rows');
      assert.strictEqual(await restricted.model.count(), 0, 'rows survived the wipe');
      assert.strictEqual(await restricted.stateModel.count(), 0, 'per-server rows survived the wipe');
    } finally {
      try { await restricted.db.unmount(); } catch { /* best effort */ }
      try { await restricted.seq.close(); } catch { /* best effort */ }
    }
  } finally {
    try { await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`); } catch { /* best effort */ }
    try { await admin.close(); } catch { /* best effort */ }
  }
});

await onEachEngine('a failing admin mutation throws instead of returning quietly', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    await ctx.model.create(row({ eosID: 'a' }));
    // Break the connection underneath the helper. The live failure was a
    // permission rejection, which the no-DDL case above covers directly; what
    // matters here is only that a rejected statement reaches the caller
    // instead of being swallowed into a resolved promise.
    await teardown(ctx);

    await assert.rejects(
      () => ctx.plugin.adminWipeAll(),
      'adminWipeAll resolved despite the statement failing — this is the exact swallow that made the live clearall silent'
    );
    await assert.rejects(
      () => ctx.plugin.adminClearAllRestrictions(),
      'adminClearAllRestrictions resolved despite the statement failing'
    );
    await assert.rejects(
      () => ctx.plugin.adminClearPlayer('a'),
      'adminClearPlayer resolved despite the statement failing'
    );
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. No path confiscates seed tokens
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('clearall tops players up without capping seed holders', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    await plant(ctx, [
      row({ eosID: 'broke', tokenBalance: 0, tokenRegenAnchor: new Date() }),
      row({ eosID: 'partial', tokenBalance: 1, tokenRegenAnchor: new Date() }),
      row({ eosID: 'full', tokenBalance: 2 }),
      row({ eosID: 'seeder', tokenBalance: 3, seedBonusTokensEarned: 1 })
    ]);

    const result = await ctx.plugin.adminClearAllRestrictions();
    assert.strictEqual(result.toppedUp, 2, 'only the two below-cap rows should be topped up');

    assert.strictEqual((await ctx.model.findByPk('broke')).tokenBalance, 2);
    assert.strictEqual((await ctx.model.findByPk('partial')).tokenBalance, 2);
    assert.strictEqual((await ctx.model.findByPk('full')).tokenBalance, 2);

    const seeder = await ctx.model.findByPk('seeder');
    assert.strictEqual(
      seeder.tokenBalance, 3,
      'clearall confiscated an earned seed token — top-up must be Math.max(current, max), not an assignment'
    );
    const seederSide = await ctx.stateModel.findOne({ where: { serverID: 1, eosID: 'seeder' } });
    assert.strictEqual(seederSide.seedBonusTokensEarned, 1, 'seed accrual bookkeeping should be untouched');

    // The top-up crosses every server, the lock clear does not, and the
    // return value has to say which server the second number is about.
    assert.strictEqual(result.serverID, 1, 'clearall should name the server whose locks it lifted');

    assert.strictEqual(await ctx.model.count(), 4, 'clearall must not delete rows — that is what wipe is for');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('clear on one player never lowers a seed-boosted balance', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    await plant(ctx, row({
      eosID: 'seeder',
      tokenBalance: 3,
      seedBonusTokensEarned: 1,
      seedPresenceStart: new Date(),
      lastSeedBonusRoundID: 'round-current',
      scrambleLockdownExpiry: new Date(Date.now() + HOUR)
    }));

    const summary = await ctx.plugin.adminClearPlayer('seeder');
    assert.strictEqual(summary.tokensBefore, 3);
    assert.strictEqual(summary.tokensAfter, 3, 'clear knocked a seed holder back down to the cap');
    assert.strictEqual(summary.lockCleared, true);

    const after = await ctx.model.findByPk('seeder');
    assert.strictEqual(after.tokenBalance, 3);
    assert.strictEqual(after.tokenRegenAnchor, null, 'no regen cycle runs at or above the cap');
    assert.ok(after.lastActiveTimestamp instanceof Date, 'clear must keep the retention clock non-NULL');

    const side = await ctx.stateModel.findOne({ where: { serverID: 1, eosID: 'seeder' } });
    assert.strictEqual(side.scrambleLockdownExpiry, null, 'the scramble lock should be gone');
    assert.strictEqual(side.seedBonusTokensEarned, 1, 'in-progress seed accrual should survive a clear');
    assert.ok(side.seedPresenceStart instanceof Date, 'clear should not cancel a live seed session');
    assert.strictEqual(summary.serverID, 1, 'clear should name the server whose lock it lifted');

    // checkPlayer() is what every reply renders from, and it has to hand back
    // one player rather than a wallet and a lock the caller has to join. The
    // list of which fields were the local half is part of that contract: the
    // replies use it to say what they changed and where.
    const merged = await ctx.plugin.checkPlayer('seeder');
    assert.strictEqual(merged.tokenBalance, 3, 'checkPlayer lost the community-wide balance');
    assert.strictEqual(merged.seedBonusTokensEarned, 1, 'checkPlayer lost the per-server seed count');
    assert.strictEqual(merged._serverID, 1, 'checkPlayer should say which server it merged');
    assert.deepStrictEqual(
      merged._serverScoped,
      ['scrambleLockdownExpiry', 'seedPresenceStart', 'lastSeedBonusRoundID', 'seedBonusTokensEarned'],
      'checkPlayer must name the server-scoped half, or a reply cannot say which is which'
    );
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('clear tops a drained player up to the cap', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    await ctx.model.create(row({ eosID: 'broke', tokenBalance: 0, tokenRegenAnchor: new Date() }));
    const summary = await ctx.plugin.adminClearPlayer('broke');
    assert.strictEqual(summary.tokensBefore, 0);
    assert.strictEqual(summary.tokensAfter, 2);
    assert.strictEqual((await ctx.model.findByPk('broke')).tokenBalance, 2);
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('clear on an absent row is a no-op, not a crash', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    const summary = await ctx.plugin.adminClearPlayer('never-seen');
    assert.strictEqual(summary, null, 'an absent row already reads as unrestricted');
    assert.strictEqual(await ctx.model.count(), 0, 'clear must not conjure a row');
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. clearall's two arms must cover every row between them
// ═══════════════════════════════════════════════════════════════════
//
// clearall is deliberately two UPDATEs — one for rows below the cap, one for
// rows at or above it — so that seed holders keep their surplus. The hazard in
// splitting a predicate is a row that falls between the halves and silently
// keeps its lock. This asserts the union directly.

await onEachEngine('clearall leaves no row locked, at any balance', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  const lock = () => new Date(Date.now() + HOUR);
  try {
    await plant(ctx, [
      row({ eosID: 'b0', tokenBalance: 0, scrambleLockdownExpiry: lock() }),
      row({ eosID: 'b1', tokenBalance: 1, scrambleLockdownExpiry: lock() }),
      row({ eosID: 'b2', tokenBalance: 2, scrambleLockdownExpiry: lock() }),
      row({ eosID: 'b3', tokenBalance: 3, seedBonusTokensEarned: 1, scrambleLockdownExpiry: lock() }),
      row({ eosID: 'b9', tokenBalance: 9, scrambleLockdownExpiry: lock() })
    ]);
    // Another server holds a lock on b0 as well. It must survive: this admin
    // was asked about their own server, and clearing everybody's locks
    // everywhere is a decision nobody typed.
    await ctx.stateModel.create({ serverID: 2, eosID: 'b0', scrambleLockdownExpiry: lock(), lastActiveTimestamp: new Date() });

    const result = await ctx.plugin.adminClearAllRestrictions();

    const stillLocked = await ctx.stateModel.count({
      where: { serverID: 1, scrambleLockdownExpiry: { [Sequelize.Op.ne]: null } }
    });
    assert.strictEqual(
      stillLocked, 0,
      `${stillLocked} row(s) on this server kept their lock through a clearall`
    );
    assert.strictEqual(
      await ctx.stateModel.count({ where: { serverID: 2, scrambleLockdownExpiry: { [Sequelize.Op.ne]: null } } }), 1,
      'clearall lifted another server\u2019s lock — the lock statement is not scoped'
    );
    assert.strictEqual(result.toppedUp, 2, 'b0 and b1 are the only rows below the cap');
    assert.strictEqual(
      result.locksCleared, 5,
      'every lock on this server is cleared now that the statement no longer partitions on the balance'
    );

    // And the surplus survived the sweep.
    assert.strictEqual((await ctx.model.findByPk('b3')).tokenBalance, 3);
    assert.strictEqual((await ctx.model.findByPk('b9')).tokenBalance, 9);
  } finally {
    await teardown(ctx);
  }
});

// The NULL arm of that predicate cannot be reached through a correctly
// migrated schema: tokenBalance is declared NOT NULL DEFAULT 2, and both
// engines reject the write (SQLite "Validation error", MySQL "Column
// 'tokenBalance' cannot be null"). It is defended anyway because the live
// MySQL schema is applied by hand — that account has no DDL grants — so the
// deployed column definition is not guaranteed to match the model. This
// reproduces that divergence and is MySQL-only: SQLite cannot ALTER a column's
// nullability, and pretending otherwise would be a test that proves nothing.
await runTest("clearall lifts the lock on a NULL-balance row (hand-applied schema) [mysql]", async () => {
  if (!mysqlReachable) return SKIP;

  const ctx = await buildPlugin({ dialect: 'mysql' });
  try {
    await ctx.seq.query(`ALTER TABLE \`${TABLE}\` MODIFY \`tokenBalance\` INT NULL;`);
    await ctx.seq.query(
      `INSERT INTO \`${TABLE}\` (\`eosID\`, \`playerName\`, \`tokenBalance\`, \`lastActiveTimestamp\`)
       VALUES ('weird', 'Weird', NULL, NOW());`
    );
    await ctx.stateModel.create({ serverID: 1, eosID: 'weird', scrambleLockdownExpiry: new Date(Date.now() + HOUR), lastActiveTimestamp: new Date() });

    // Pre-flight: `tokenBalance < 2` really is UNKNOWN here, so a pass below
    // means the NULL arm did the work rather than the < arm having matched.
    const [[probe]] = await ctx.seq.query(
      `SELECT COUNT(*) AS n FROM \`${TABLE}\` WHERE \`tokenBalance\` < 2 OR \`tokenBalance\` >= 2;`
    );
    assert.strictEqual(
      Number(probe.n), 0,
      'the NULL row matched a comparison arm — three-valued logic is not behaving as assumed'
    );

    await ctx.plugin.adminClearAllRestrictions();

    const [[after]] = await ctx.seq.query(
      `SELECT \`tokenBalance\` FROM \`${TABLE}\` WHERE \`eosID\` = 'weird';`
    );
    assert.strictEqual(
      Number(after.tokenBalance), 2,
      'the NULL row was not topped up — without the explicit NULL arm it matches neither UPDATE'
    );

    // The lock is a separate statement on a separate table since the split,
    // and it no longer partitions on the balance at all — which is what
    // retires this row as a silent-failure case rather than only defending
    // it. Asserted anyway, because "cannot fail any more" is a claim that
    // has to be checked rather than assumed.
    const side = await ctx.stateModel.findOne({ where: { serverID: 1, eosID: 'weird' } });
    assert.strictEqual(side.scrambleLockdownExpiry, null, 'the lock survived clearall');
  } finally {
    // Restore the declared shape for the cases that follow on this database.
    try { await ctx.seq.query(`DELETE FROM \`${TABLE}\`;`); } catch { /* best effort */ }
    try { await ctx.seq.query(`ALTER TABLE \`${TABLE}\` MODIFY \`tokenBalance\` INT NOT NULL DEFAULT 2;`); } catch { /* best effort */ }
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4. normalizeRegeneratedTokens — makes the tier-1 prune reachable
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('completed regeneration is written back to the row', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  const interval = 1.75 * HOUR;
  try {
    await ctx.model.bulkCreate([
      // One full interval elapsed: 1 → 2, anchor cleared.
      row({ eosID: 'one-short', tokenBalance: 1, tokenRegenAnchor: new Date(Date.now() - interval - 60000) }),
      // Two intervals elapsed from empty: 0 → 2.
      row({ eosID: 'empty', tokenBalance: 0, tokenRegenAnchor: new Date(Date.now() - 2 * interval - 60000) }),
      // Mid-cycle: must not be touched, or the player gets a free token.
      row({ eosID: 'midway', tokenBalance: 1, tokenRegenAnchor: new Date(Date.now() - interval / 2) }),
      // Only one of two intervals elapsed: partial regen is _regenTokens' job.
      row({ eosID: 'partial', tokenBalance: 0, tokenRegenAnchor: new Date(Date.now() - interval - 60000) }),
      // Seed surplus: normalization must never pull a row DOWN to the cap.
      row({ eosID: 'seeder', tokenBalance: 3, seedBonusTokensEarned: 1 })
    ]);

    const normalized = await ctx.plugin.normalizeRegeneratedTokens();

    assert.strictEqual((await ctx.model.findByPk('one-short')).tokenBalance, 2);
    assert.strictEqual((await ctx.model.findByPk('one-short')).tokenRegenAnchor, null,
      'a full row has no regen cycle running, so the anchor must be cleared');
    assert.strictEqual((await ctx.model.findByPk('empty')).tokenBalance, 2);

    const midway = await ctx.model.findByPk('midway');
    assert.strictEqual(midway.tokenBalance, 1, 'a mid-cycle row was granted a token it had not earned');
    assert.ok(midway.tokenRegenAnchor instanceof Date, 'a mid-cycle anchor must survive');

    assert.strictEqual((await ctx.model.findByPk('partial')).tokenBalance, 0,
      'one elapsed interval does not fill a two-token deficit — that is _regenTokens on read');

    assert.strictEqual((await ctx.model.findByPk('seeder')).tokenBalance, 3,
      'normalization lowered a seed holder to the cap');

    assert.ok(normalized >= 2, `expected at least the two completed rows to normalize, got ${normalized}`);
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4b. The null-anchor lockout — raising maxSwitchTokens used to strand
//     a player at zero tokens with no way back.
//
// Every path that writes a NULL anchor pairs it with an AT-cap balance,
// which is safe. Raise maxSwitchTokens and those rows become BELOW-cap
// with a NULL anchor, and _regenTokens() then measures elapsed time
// against a null anchor it reads as `now` — zero, on every read, forever.
// _spendToken()'s anchor stamp is gated on `balance === maxTokens - 1`,
// which a spend from the old cap does not satisfy, so nothing rescues it.
// The row drains to 0 and the player can never switch again;
// normalizeRegeneratedTokens() cannot see it either, because Op.lt
// against NULL is UNKNOWN.
//
// Reproduced live on a two-server rig 2026-09-08: a row left at
// {1, NULL} by the round-end writeback under maxSwitchTokens=1 became
// {0, NULL} after a single !switch once the cap was restored to 2.
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('a below-cap row with no anchor starts its clock instead of stalling', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    // The state a cap increase leaves behind: written at cap 1, read at cap 2.
    const stranded = { tokenBalance: 1, tokenRegenAnchor: null };
    ctx.plugin._regenTokens(stranded);

    assert.ok(stranded.tokenRegenAnchor instanceof Date,
      'a below-cap row with a null anchor got no regen clock — it can never regenerate');
    assert.strictEqual(stranded.tokenBalance, 1,
      'starting the clock must not grant a token; the player waits a full interval');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('spending from a stranded row leaves a usable anchor', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  const interval = 1.75 * HOUR;
  try {
    const stranded = { tokenBalance: 1, tokenRegenAnchor: null };
    ctx.plugin._spendToken(stranded);

    assert.strictEqual(stranded.tokenBalance, 0, 'the spend did not decrement');
    assert.ok(stranded.tokenRegenAnchor instanceof Date,
      'spending from below cap left a null anchor — this is the lockout: 0 tokens and no clock');

    // The whole point: it must actually come back.
    const later = {
      tokenBalance: stranded.tokenBalance,
      tokenRegenAnchor: new Date(stranded.tokenRegenAnchor.getTime() - interval - 60000)
    };
    ctx.plugin._regenTokens(later);
    assert.strictEqual(later.tokenBalance, 1,
      'a full interval elapsed and the row did not regenerate');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('the sweep repairs stranded rows already on disk without granting tokens', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  const interval = 1.75 * HOUR;
  try {
    await ctx.model.bulkCreate([
      // Drained and clockless: cannot spend, so _regenTokens() alone can never
      // persist a fix for it. This is the row that needs the DB repair.
      row({ eosID: 'locked-out', tokenBalance: 0, tokenRegenAnchor: null }),
      // Below cap, clockless, still has a token left.
      row({ eosID: 'stalled', tokenBalance: 1, tokenRegenAnchor: null }),
      // At cap with a null anchor — the ordinary resting state. Must NOT be touched.
      row({ eosID: 'resting', tokenBalance: 2, tokenRegenAnchor: null }),
      // Above cap on seed surplus, null anchor. Must NOT be touched.
      row({ eosID: 'seeder', tokenBalance: 3, tokenRegenAnchor: null, seedBonusTokensEarned: 1 }),
      // Mid-cycle with a real anchor — the repair must not reset its progress.
      row({ eosID: 'midway', tokenBalance: 1, tokenRegenAnchor: new Date(Date.now() - interval / 2) })
    ]);

    await ctx.plugin.normalizeRegeneratedTokens();

    for (const id of ['locked-out', 'stalled']) {
      const after = await ctx.model.findByPk(id);
      assert.ok(after.tokenRegenAnchor instanceof Date,
        `${id} was left without a regen clock and stays stranded`);
    }
    assert.strictEqual((await ctx.model.findByPk('locked-out')).tokenBalance, 0,
      'the repair granted a token it had not earned — that is the exploit tier 1 guards against');
    assert.strictEqual((await ctx.model.findByPk('stalled')).tokenBalance, 1,
      'the repair granted a token it had not earned');

    assert.strictEqual((await ctx.model.findByPk('resting')).tokenRegenAnchor, null,
      'an at-cap row was given a pointless regen clock');
    assert.strictEqual((await ctx.model.findByPk('seeder')).tokenBalance, 3,
      'the repair pulled a seed holder down to the cap');
    assert.strictEqual((await ctx.model.findByPk('seeder')).tokenRegenAnchor, null,
      'an above-cap row was given a regen clock');

    const midway = await ctx.model.findByPk('midway');
    assert.strictEqual(midway.tokenBalance, 1, 'a mid-cycle row was granted a token');
    assert.ok(Math.abs(midway.tokenRegenAnchor.getTime() - (Date.now() - interval / 2)) < 60000,
      'the repair reset a mid-cycle anchor and threw away partial progress');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('normalized rows become eligible for the tier-1 prune', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  const interval = 1.75 * HOUR;
  try {
    // The live shape: a player who spent a token, left, and fully regenerated.
    // Before v2.5.6 the balance stayed at 1 on disk, so the tier-1 predicate
    // (balance == max AND no seed state AND no lock) never matched — it hit
    // 0 of 378 real production rows.
    await ctx.model.create(row({
      eosID: 'ghost',
      tokenBalance: 1,
      tokenRegenAnchor: new Date(Date.now() - interval - 60000),
      lastActiveTimestamp: new Date(Date.now() - 2 * HOUR)
    }));

    await ctx.plugin.normalizeRegeneratedTokens();
    const after = await ctx.model.findByPk('ghost');
    assert.strictEqual(after.tokenBalance, 2, 'not normalized, so tier-1 still cannot see it');

    await ctx.plugin.cleanup();
    assert.strictEqual(
      await ctx.model.count(), 0,
      'a full, unlocked, seed-free row older than 30 minutes carries no information and should be pruned'
    );
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('the prune declines while the community disagrees about the retention window', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    // Prunable on tier 1: full, unlocked, seed-free, and unseen for a month.
    await ctx.model.create(row({
      eosID: 'ghost',
      lastActiveTimestamp: new Date(Date.now() - 30 * 24 * HOUR)
    }));

    // Two registered servers, two retention windows, one shared table. There is
    // no value here that is obviously right to resolve to — a retention window
    // is policy, not a safety limit — so without the gate whichever process ran
    // cleanup() last would decide how long everybody's rows live.
    await ctx.db.ServersModel.bulkCreate([
      { serverID: 1, alias: 'main', communityOptions: JSON.stringify({ pruneInactivePlayerDays: 3 }) },
      { serverID: 2, alias: 'event', communityOptions: JSON.stringify({ pruneInactivePlayerDays: 30 }) }
    ]);
    await ctx.db.getCommunityOptionSummary();

    await ctx.plugin.cleanup();
    assert.strictEqual(
      await ctx.model.count(), 1,
      'the prune deleted a row the whole community shares while the community disagreed about how long it lives'
    );

    // The neighbour is reconfigured to agree, and the same row goes.
    await ctx.db.ServersModel.update(
      { communityOptions: JSON.stringify({ pruneInactivePlayerDays: 3 }) },
      { where: { serverID: 2 } }
    );
    await ctx.db.getCommunityOptionSummary();

    await ctx.plugin.cleanup();
    assert.strictEqual(
      await ctx.model.count(), 0,
      'the servers agree and the prune still declined — the gate is refusing on something other than the disagreement'
    );
  } finally {
    // The MySQL scratch database is shared across cases, so the registry rows
    // have to go with the cooldown rows or the next case inherits a community.
    try { await ctx.db.ServersModel.destroy({ where: {} }); } catch { /* best effort */ }
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 5. _sweepStaleSeedState — the "Seed Accruing: 75" ghosts
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('a new round clears last round\'s seed presence', async (dialect) => {
  const ctx = await buildPlugin({ dialect, currentMatchId: 'round-current' });
  try {
    await plant(ctx, [
      // Ten hours stale, from a round that ended long ago — 85 rows on live
      // looked exactly like this and were all being counted as "accruing".
      row({
        eosID: 'stale',
        seedPresenceStart: new Date(Date.now() - 10 * HOUR),
        seedBonusTokensEarned: 1,
        lastSeedBonusRoundID: 'round-old'
      }),
      // Never completed a seed round: lastSeedBonusRoundID is NULL, and
      // `!= 'round-current'` is UNKNOWN against NULL on every engine, so this
      // row only gets swept if the NULL arm is spelled out.
      row({
        eosID: 'null-round',
        seedPresenceStart: new Date(Date.now() - 8 * HOUR),
        seedBonusTokensEarned: 0,
        lastSeedBonusRoundID: null
      }),
      // This round's accrual: must survive.
      row({
        eosID: 'live',
        seedPresenceStart: new Date(Date.now() - 5 * 60000),
        seedBonusTokensEarned: 1,
        lastSeedBonusRoundID: 'round-current'
      })
    ]);

    // A second server is mid-seed-round with the same stale-looking row. The
    // sweep runs on every process, so an unscoped one would have each server
    // wiping its neighbours' accrual at its own NEW_GAME — and the neighbour
    // would only find out when nobody got a token.
    await ctx.stateModel.create({
      serverID: 2, eosID: 'stale',
      seedPresenceStart: new Date(Date.now() - 10 * HOUR),
      seedBonusTokensEarned: 1,
      lastSeedBonusRoundID: 'round-old',
      lastActiveTimestamp: new Date()
    });

    await ctx.plugin._sweepStaleSeedState();

    const side = async (eosID, serverID = 1) => ctx.stateModel.findOne({ where: { serverID, eosID } });

    const stale = await side('stale');
    assert.strictEqual(stale.seedPresenceStart, null, 'stale presence survived the round change');
    assert.strictEqual(stale.seedBonusTokensEarned, 0, 'stale per-round accrual survived the round change');

    const otherServer = await side('stale', 2);
    assert.ok(
      otherServer.seedPresenceStart instanceof Date,
      'the sweep reached another server\u2019s row — it must be scoped to this server'
    );

    const nullRound = await side('null-round');
    assert.strictEqual(
      nullRound.seedPresenceStart, null,
      'the NULL lastSeedBonusRoundID arm was not spelled out — != NULL is UNKNOWN, so this row was skipped'
    );

    const live = await side('live');
    assert.ok(live.seedPresenceStart instanceof Date, 'the sweep ate the current round\'s accrual');
    assert.strictEqual(live.seedBonusTokensEarned, 1, 'the sweep reset the current round\'s earned count');

    // The sweep never spends or grants.
    for (const id of ['stale', 'null-round', 'live']) {
      assert.strictEqual((await ctx.model.findByPk(id)).tokenBalance, 2, `${id}: sweep must not touch balances`);
    }
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 6. getLiveRestrictionState — what the Discord panel actually shows
// ═══════════════════════════════════════════════════════════════════

const CONNECTED = [
  { eosID: 'online-seeder', steamID: 'steam-1', name: 'OnlineSeeder', teamID: '1' },
  { eosID: 'online-full', steamID: 'steam-2', name: 'OnlineFull', teamID: '2' }
];

await onEachEngine('a player at full tokens is not reported as blocked', async (dialect) => {
  const ctx = await buildPlugin({ dialect, connected: CONNECTED });
  try {
    await plant(ctx, [
      row({ eosID: 'online-full', tokenBalance: 2 }),
      row({ eosID: 'seeder', tokenBalance: 3, seedBonusTokensEarned: 1 }),
      // Genuinely blocked: no tokens and nothing regenerating yet.
      row({ eosID: 'drained', tokenBalance: 0, tokenRegenAnchor: new Date() }),
      // Genuinely blocked: scramble lock still in force.
      row({ eosID: 'locked', tokenBalance: 2, scrambleLockdownExpiry: new Date(Date.now() + HOUR) })
    ]);
    // Locked on another server only. The panel reports this server, so this
    // player is not restricted here and must not appear.
    await ctx.stateModel.create({
      serverID: 2, eosID: 'online-full',
      scrambleLockdownExpiry: new Date(Date.now() + HOUR),
      lastActiveTimestamp: new Date()
    });

    const state = await ctx.plugin.getLiveRestrictionState();

    const blockedIDs = state.blocked.map((b) => b.eosID).sort();
    assert.deepStrictEqual(
      blockedIDs, ['drained', 'locked'],
      `blocked list is wrong: got ${JSON.stringify(blockedIDs)} — the old panel listed players at "2/2 tokens (full)" under "Restricted Players"`
    );
    assert.strictEqual(state.outOfTokens, 1, 'exactly one player has no tokens');
    assert.strictEqual(state.scrambleLocked, 1, 'exactly one player is scramble-locked');
    assert.strictEqual(state.total, 4, 'total should count tracked rows');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('an expired scramble lock does not count as blocked', async (dialect) => {
  const ctx = await buildPlugin({ dialect, connected: CONNECTED });
  try {
    // 74 of 378 live rows carried a lockdown expiry; every one had expired.
    await plant(ctx, row({ eosID: 'past', scrambleLockdownExpiry: new Date(Date.now() - HOUR) }));
    const state = await ctx.plugin.getLiveRestrictionState();
    assert.strictEqual(state.scrambleLocked, 0, 'an expired lock is not a lock');
    assert.strictEqual(state.blocked.length, 0, 'an expired lock should not block anyone');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('seed accrual is only counted for connected players', async (dialect) => {
  const ctx = await buildPlugin({ dialect, connected: CONNECTED });
  try {
    await plant(ctx, [
      row({ eosID: 'online-seeder', seedPresenceStart: new Date(Date.now() - 5 * 60000) }),
      // Disconnected ten hours ago with presence still set. Eighty-five rows
      // on live looked like this and the panel reported all of them.
      row({ eosID: 'ghost-1', seedPresenceStart: new Date(Date.now() - 10 * HOUR) }),
      row({ eosID: 'ghost-2', seedPresenceStart: new Date(Date.now() - 43 * HOUR) })
    ]);

    const state = await ctx.plugin.getLiveRestrictionState();
    assert.strictEqual(
      state.seedAccruing, 1,
      `seedAccruing counted ${state.seedAccruing} — offline rows with a stale seedPresenceStart are ghosts, not seeders`
    );
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('lazy regeneration is applied for display without writing', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    // On disk this player has 0. In truth two intervals have elapsed, so the
    // panel must show them as unblocked — reading the raw column is what made
    // getDiagnosticInfo() report a false activeLocks count.
    await ctx.model.create(row({
      eosID: 'regenerated',
      tokenBalance: 0,
      tokenRegenAnchor: new Date(Date.now() - 2 * 1.75 * HOUR - 60000)
    }));

    const state = await ctx.plugin.getLiveRestrictionState();
    assert.strictEqual(state.blocked.length, 0, 'a fully regenerated player is not blocked');
    assert.strictEqual(state.outOfTokens, 0, 'regeneration was not applied before counting');

    // ...and the read must not have persisted anything.
    assert.strictEqual(
      (await ctx.model.findByPk('regenerated')).tokenBalance, 0,
      'getLiveRestrictionState wrote to the database — it is a display read'
    );
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 6b. _checkSwitchEligibility — the shipped gate, on a real engine
// ═══════════════════════════════════════════════════════════════════
//
// test-eligibility-check.js drives mock-harness.js’s hand-copy of this gate,
// which reads the lock off the wallet row. The shipped gate reads it off the
// per-server row, so that file passed the split without noticing it and
// would keep passing if this stopped working entirely. These run the real
// method against SQLite and MySQL.

await onEachEngine('a lock on this server denies the switch', async (dialect) => {
  const ctx = await buildPlugin({ dialect, connected: CONNECTED });
  try {
    await plant(ctx, row({ eosID: 'locked', tokenBalance: 2, scrambleLockdownExpiry: new Date(Date.now() + HOUR) }));

    const result = await ctx.plugin._checkSwitchEligibility({ eosID: 'locked' });
    assert.strictEqual(result.eligible, false, 'a scramble-locked player was allowed to switch');
    assert.strictEqual(
      result.reason, 'scramble_lock',
      `denied for ${result.reason} rather than the lock — the gate is not reading the per-server row`
    );
    assert.ok(result.remaining > 0, 'the deny message has no time left to quote');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('a lock on another server does not deny the switch here', async (dialect) => {
  const ctx = await buildPlugin({ dialect, connected: CONNECTED });
  try {
    // The whole point of the split. Before it, one scramble locked the
    // player out of every server sharing the database.
    //
    // The wallet is created directly and no row is laid down for server 1:
    // this is a player whose whole history is on the other server, which is
    // what makes the case deterministic. Given a row on both, an unscoped
    // read could return either one and whether the scoping bug shows up
    // would come down to which row the engine happened to hand back.
    await ctx.model.create({
      eosID: 'elsewhere', playerName: 'Elsewhere', tokenBalance: 2,
      tokenRegenAnchor: null, lastActiveTimestamp: new Date()
    });
    await ctx.stateModel.create({
      serverID: 2, eosID: 'elsewhere',
      scrambleLockdownExpiry: new Date(Date.now() + HOUR),
      lastActiveTimestamp: new Date()
    });

    const result = await ctx.plugin._checkSwitchEligibility({ eosID: 'elsewhere' });
    // Not asserting eligible: the fixture’s join/match clocks put this
    // player outside the switch window, which is a different refusal and
    // not the one under test.
    assert.notStrictEqual(
      result.reason, 'scramble_lock',
      'another server\u2019s scramble locked this player out here',
    );
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('an expired lock on this server does not deny the switch', async (dialect) => {
  const ctx = await buildPlugin({ dialect, connected: CONNECTED });
  try {
    await plant(ctx, row({ eosID: 'past', tokenBalance: 2, scrambleLockdownExpiry: new Date(Date.now() - HOUR) }));
    const result = await ctx.plugin._checkSwitchEligibility({ eosID: 'past' });
    assert.notStrictEqual(result.reason, 'scramble_lock', 'an expired lock is not a lock');
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 7. Match-end queue
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('the same player cannot be queued for match end twice', async (dialect) => {
  const ctx = await buildPlugin({ dialect, connected: CONNECTED });
  try {
    const p = CONNECTED[0];
    assert.strictEqual(await ctx.plugin.addPlayerToMatchendSwitches(p), true, 'first enqueue should insert');
    assert.strictEqual(await ctx.plugin.addPlayerToMatchendSwitches(p), false, 'second enqueue should be refused');
    assert.strictEqual(
      await ctx.endmatches.count(), 1,
      'two rows means two switches at round end, which puts the player back where they started'
    );
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('a queued match-end switch records the server that queued it', async (dialect) => {
  const ctx = await buildPlugin({ dialect, connected: CONNECTED });
  try {
    const mine = ctx.plugin._serverID();
    assert.strictEqual(await ctx.plugin.addPlayerToMatchendSwitches(CONNECTED[0]), true);

    const [row] = await ctx.endmatches.findAll();
    assert.ok(row, 'nothing was queued, so the stamp was never exercised');
    assert.strictEqual(
      row.serverID, mine,
      `the queued switch is stamped ${row.serverID} rather than ${mine}`
    );
  } finally {
    await teardown(ctx);
  }
});

/*
 * Why this one is worth a case of its own rather than being folded into the
 * dedupe test above.
 *
 * This table is not a log. It is a work queue, and the boot path used to
 * drain it with a findAll() carrying no where clause at all — every row it
 * found was a switch it performed. With two servers sharing the database,
 * a restart on one drained the other's queue and moved players who were not
 * even connected to it. Populating the column was the half that had to land
 * first, because the read cannot filter on something that is not there; the
 * filter itself is the case below.
 */

// Every case in this file sets _matchendWarnDelayMs so it does not sit through
// the warning. Production does not set it, so production takes the OTHER arm —
// `Switch.MATCHEND_WARN_DELAY_MS` — which no case above ever evaluates. If that
// reference were wrong it would throw inside doSwitchMatchend's try, be logged,
// and silently cancel every queued end-of-round switch.
await runTest('the production warn-delay branch resolves', async () => {
  assert.strictEqual(
    typeof Switch.MATCHEND_WARN_DELAY_MS, 'number',
    'MATCHEND_WARN_DELAY_MS is not readable off the class — the fallback arm would throw at every round end'
  );
  assert.strictEqual(Switch.MATCHEND_WARN_DELAY_MS, 15000, 'the shipped grace period changed unintentionally');

  // The exact expression doSwitchMatchend evaluates when the seam is unset.
  const unset = undefined;
  const chosen = Number.isFinite(unset) ? unset : Switch.MATCHEND_WARN_DELAY_MS;
  assert.strictEqual(chosen, 15000, 'the unset path does not fall back to the class default');
});

await onEachEngine('the match-end drain leaves the other server\u2019s queue alone', async (dialect) => {
  const ctx = await buildPlugin({ dialect, connected: CONNECTED });
  try {
    const mine = ctx.plugin._serverID();
    await ctx.endmatches.bulkCreate([
      { serverID: mine, name: 'OnlineFull', steamID: 'steam-2', eosID: 'online-full' },
      // Queued on the neighbour. Its eosID is one of this server's connected
      // players on purpose: eosIDs are community-wide, so an unscoped drain
      // resolves this row against the local roster and moves a player who
      // never asked for it here.
      { serverID: mine + 1, name: 'OnlineSeeder', steamID: 'steam-1', eosID: 'online-seeder' }
    ]);

    const switched = [];
    ctx.plugin._taggedSwitchPlayer = async (eosID) => { switched.push(eosID); return true; };
    await ctx.plugin.doSwitchMatchend();

    assert.deepStrictEqual(
      switched, ['online-full'],
      `the drain switched ${JSON.stringify(switched)} \u2014 a request queued on another server was performed here`
    );

    const left = await ctx.endmatches.findAll();
    assert.strictEqual(
      left.length, 1,
      'the neighbour\u2019s queued switch was deleted by this server, so it will never happen at all'
    );
    assert.strictEqual(left[0].serverID, mine + 1, 'the wrong row survived the drain');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('a failed match-end switch still consumes its request', async (dialect) => {
  const ctx = await buildPlugin({ dialect, connected: CONNECTED });
  try {
    // Stamped, because the drain filters on it now. A row with a NULL
    // serverID is not a fixture shortcut any more — it is a row from before
    // the column existed, and the migration's backfill is what claims those.
    const mine = ctx.plugin._serverID();
    await ctx.endmatches.bulkCreate([
      { serverID: mine, name: 'OnlineFull', steamID: 'steam-2', eosID: 'online-full' },
      // No eosID and not on the roster: unresolvable, the shape a stale row
      // left by a restart takes.
      { serverID: mine, name: 'Gone', steamID: 'steam-gone', eosID: null }
    ]);

    let calls = 0;
    ctx.plugin._taggedSwitchPlayer = async () => {
      calls++;
      throw new Error('RCON unavailable');
    };
    await ctx.plugin.doSwitchMatchend();

    assert.strictEqual(calls, 1, 'only the resolvable request should have reached RCON');
    assert.strictEqual(
      await ctx.endmatches.count(), 0,
      'the request survived a failed switch — it would re-fire at every future round end, forever'
    );
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 8. The in-game command wiring itself
// ═══════════════════════════════════════════════════════════════════
//
// Everything above calls the admin helpers directly. That leaves the chat
// dispatch — prefix parsing, the admin gate, argument handling, and the
// confirm gate on `wipe` — as the one surface where a change could compile,
// pass every case in this file, and still do the wrong thing in game. These
// cases drive plugin.onChatMessage the way SquadJS does.

/** Captures what the player is told, so a silent success can't pass as one. */
function withWarnCapture(plugin) {
  const warns = [];
  plugin.warn = (id, msg) => { warns.push(msg); };
  return warns;
}

const chat = (text, { admin = true } = {}) => ({
  player: { eosID: 'admin-1', steamID: '76500000000000001', name: 'AdminOne', teamID: 1 },
  message: text,
  chat: admin ? 'ChatAdmin' : 'ChatAll'
});

await onEachEngine('wipe without the confirm word deletes nothing', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  const warns = withWarnCapture(ctx.plugin);
  try {
    await ctx.model.bulkCreate([row({ eosID: 'a' }), row({ eosID: 'b' })]);

    await ctx.plugin.onChatMessage(chat('!switch wipe'));

    assert.strictEqual(await ctx.model.count(), 2, 'a bare !switch wipe destroyed rows — the confirm gate is not wired in');
    assert.ok(warns.length === 1, `expected exactly one explanatory reply, got ${warns.length}`);
    assert.match(warns[0], /confirm/i, 'the refusal must tell the admin how to actually proceed');
    assert.match(warns[0], /clearall/i, 'the refusal should point at the non-destructive alternative');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('wipe confirm goes through and reports the count', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  const warns = withWarnCapture(ctx.plugin);
  try {
    await ctx.model.bulkCreate([row({ eosID: 'a' }), row({ eosID: 'b' }), row({ eosID: 'c' })]);

    await ctx.plugin.onChatMessage(chat('!switch wipe confirm'));

    assert.strictEqual(await ctx.model.count(), 0, 'confirmed wipe left rows behind');
    assert.match(warns.join(' '), /Wiped 3/, `the admin was not told what happened: ${JSON.stringify(warns)}`);
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('a non-admin cannot wipe, even with confirm', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  withWarnCapture(ctx.plugin);
  try {
    await ctx.model.create(row({ eosID: 'a' }));
    await ctx.plugin.onChatMessage(chat('!switch wipe confirm', { admin: false }));
    assert.strictEqual(await ctx.model.count(), 1, 'the admin gate did not hold');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('clearall through chat reports its counts and deletes nothing', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  const warns = withWarnCapture(ctx.plugin);
  try {
    await plant(ctx, [
      row({ eosID: 'drained', tokenBalance: 0 }),
      row({ eosID: 'locked', scrambleLockdownExpiry: new Date(Date.now() + HOUR) }),
      row({ eosID: 'seeder', tokenBalance: 3, seedBonusTokensEarned: 1 })
    ]);

    await ctx.plugin.onChatMessage(chat('!switch clearall'));

    assert.strictEqual(await ctx.model.count(), 3, 'clearall deleted rows through the chat path');
    assert.strictEqual((await ctx.model.findByPk('seeder')).tokenBalance, 3, 'the chat path confiscated a seed token');
    assert.strictEqual((await ctx.model.findByPk('drained')).tokenBalance, 2, 'the drained player was not topped up');
    // The silence this replaces is the whole reason for v2.5.6: on live MySQL
    // clearall failed and said nothing, so admins believed it had worked.
    assert.match(warns.join(' '), /cleared/i, `clearall reported nothing: ${JSON.stringify(warns)}`);
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('a failing clearall tells the admin instead of going quiet', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  const warns = withWarnCapture(ctx.plugin);
  try {
    ctx.plugin.adminClearAllRestrictions = async () => { throw new Error('Database is not ready.'); };
    await ctx.plugin.onChatMessage(chat('!switch clearall'));
    assert.match(warns.join(' '), /failed/i, `a thrown admin mutation produced no reply: ${JSON.stringify(warns)}`);
    assert.match(warns.join(' '), /not ready/i, 'the reply dropped the reason');
  } finally {
    await teardown(ctx);
  }
});

// ── Report ────────────────────────────────────────────────────────

console.log('');
console.log(`📊 Results: ${passed}/${passed + failed} passed, ${failed} failed, ${skipped} skipped`);
if (skipped > 0) {
  console.log('   ⚠ Skips are NOT passes. Bring MySQL up on 127.0.0.1:3307 before trusting a green run.');
}
console.log('');

await dropMysqlScratch();
cleanAssembly(ASSEMBLY);

if (failed > 0) process.exitCode = 1;
