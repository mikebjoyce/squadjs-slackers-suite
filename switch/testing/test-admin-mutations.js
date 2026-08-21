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

  return { plugin, db, seq, model: db.getModel(TABLE), endmatches: db.getModel(ENDMATCHES) };
}

// Rows, not tables: the MySQL scratch database is shared across cases and its
// schema must outlive any one of them.
async function teardown({ db, seq, model, endmatches }) {
  try { await model?.destroy({ where: {} }); } catch { /* best effort */ }
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
    await ctx.model.bulkCreate([
      row({ eosID: 'a' }), row({ eosID: 'b' }), row({ eosID: 'c', tokenBalance: 3 })
    ]);
    const deleted = await ctx.plugin.adminWipeAll();
    assert.strictEqual(deleted, 3, 'wipe should report the rows it deleted');
    assert.strictEqual(await ctx.model.count(), 0, 'table should be empty after a wipe');
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
    await bootstrap.model.bulkCreate([row({ eosID: 'a' }), row({ eosID: 'b' })]);
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

      const deleted = await restricted.plugin.adminWipeAll();
      assert.strictEqual(deleted, 2, 'DML-only wipe should have deleted both rows');
      assert.strictEqual(await restricted.model.count(), 0, 'rows survived the wipe');
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
    await ctx.model.bulkCreate([
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
    assert.strictEqual(seeder.seedBonusTokensEarned, 1, 'seed accrual bookkeeping should be untouched');

    assert.strictEqual(await ctx.model.count(), 4, 'clearall must not delete rows — that is what wipe is for');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('clear on one player never lowers a seed-boosted balance', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    await ctx.model.create(row({
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
    assert.strictEqual(after.scrambleLockdownExpiry, null, 'the scramble lock should be gone');
    assert.strictEqual(after.tokenRegenAnchor, null, 'no regen cycle runs at or above the cap');
    assert.ok(after.lastActiveTimestamp instanceof Date, 'clear must keep the retention clock non-NULL');
    assert.strictEqual(after.seedBonusTokensEarned, 1, 'in-progress seed accrual should survive a clear');
    assert.ok(after.seedPresenceStart instanceof Date, 'clear should not cancel a live seed session');
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
    await ctx.model.bulkCreate([
      row({ eosID: 'b0', tokenBalance: 0, scrambleLockdownExpiry: lock() }),
      row({ eosID: 'b1', tokenBalance: 1, scrambleLockdownExpiry: lock() }),
      row({ eosID: 'b2', tokenBalance: 2, scrambleLockdownExpiry: lock() }),
      row({ eosID: 'b3', tokenBalance: 3, seedBonusTokensEarned: 1, scrambleLockdownExpiry: lock() }),
      row({ eosID: 'b9', tokenBalance: 9, scrambleLockdownExpiry: lock() })
    ]);

    const result = await ctx.plugin.adminClearAllRestrictions();

    const stillLocked = await ctx.model.count({ where: { scrambleLockdownExpiry: { [Sequelize.Op.ne]: null } } });
    assert.strictEqual(
      stillLocked, 0,
      `${stillLocked} row(s) fell between clearall's two arms and kept their lock`
    );
    assert.strictEqual(result.toppedUp, 2, 'b0 and b1 are the only rows below the cap');
    assert.strictEqual(result.locksCleared, 3, 'b2, b3 and b9 keep their balances and lose their locks');

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
      `INSERT INTO \`${TABLE}\` (\`eosID\`, \`playerName\`, \`tokenBalance\`, \`seedBonusTokensEarned\`, \`scrambleLockdownExpiry\`, \`lastActiveTimestamp\`)
       VALUES ('weird', 'Weird', NULL, 0, DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW());`
    );

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
      `SELECT \`tokenBalance\`, \`scrambleLockdownExpiry\` FROM \`${TABLE}\` WHERE \`eosID\` = 'weird';`
    );
    assert.strictEqual(
      after.scrambleLockdownExpiry, null,
      'the lock survived clearall — without the explicit NULL arm this row matches neither UPDATE'
    );
    assert.strictEqual(Number(after.tokenBalance), 2, 'the NULL arm should also top the row up');
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

// ═══════════════════════════════════════════════════════════════════
// 5. _sweepStaleSeedState — the "Seed Accruing: 75" ghosts
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('a new round clears last round\'s seed presence', async (dialect) => {
  const ctx = await buildPlugin({ dialect, currentMatchId: 'round-current' });
  try {
    await ctx.model.bulkCreate([
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

    await ctx.plugin._sweepStaleSeedState();

    const stale = await ctx.model.findByPk('stale');
    assert.strictEqual(stale.seedPresenceStart, null, 'stale presence survived the round change');
    assert.strictEqual(stale.seedBonusTokensEarned, 0, 'stale per-round accrual survived the round change');

    const nullRound = await ctx.model.findByPk('null-round');
    assert.strictEqual(
      nullRound.seedPresenceStart, null,
      'the NULL lastSeedBonusRoundID arm was not spelled out — != NULL is UNKNOWN, so this row was skipped'
    );

    const live = await ctx.model.findByPk('live');
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
    await ctx.model.bulkCreate([
      row({ eosID: 'online-full', tokenBalance: 2 }),
      row({ eosID: 'seeder', tokenBalance: 3, seedBonusTokensEarned: 1 }),
      // Genuinely blocked: no tokens and nothing regenerating yet.
      row({ eosID: 'drained', tokenBalance: 0, tokenRegenAnchor: new Date() }),
      // Genuinely blocked: scramble lock still in force.
      row({ eosID: 'locked', tokenBalance: 2, scrambleLockdownExpiry: new Date(Date.now() + HOUR) })
    ]);

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
    await ctx.model.create(row({ eosID: 'past', scrambleLockdownExpiry: new Date(Date.now() - HOUR) }));
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
    await ctx.model.bulkCreate([
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

await onEachEngine('a failed match-end switch still consumes its request', async (dialect) => {
  const ctx = await buildPlugin({ dialect, connected: CONNECTED });
  try {
    await ctx.endmatches.bulkCreate([
      { name: 'OnlineFull', steamID: 'steam-2', eosID: 'online-full' },
      // No eosID and not on the roster: unresolvable, the shape a stale row
      // left by a restart takes.
      { name: 'Gone', steamID: 'steam-gone', eosID: null }
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
    await ctx.model.bulkCreate([
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
