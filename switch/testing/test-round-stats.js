/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      SWITCH — ROUND STATS TABLE, PERSISTENCE AND BACKFILL     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * `!switch stats` and the 7-day reliability embed used to be built by
 * fetching the plugin's own round-summary messages back out of Discord and
 * parsing the prose in them. That only ever worked because the prose was
 * English: the scrape matched on the embed title, on field names containing
 * "Stats", and on `**Mode:**`-style labels, so a translated server got a
 * report full of zeros and no error anywhere.
 *
 * SwitchPlugin_RoundStats replaces that with numbers written at round end.
 * This file pins the whole path:
 *
 *   - migration v6 creates the table on every engine the suite supports;
 *   - _computeRoundStatsRow() turns the in-memory round into that row;
 *   - the row is stored even when the summary message is switched off;
 *   - getRoundStatsTotals() sums stored rounds into the shape both embeds
 *     already render, excluding liberal rounds and keeping "no queue at all"
 *     distinct from "a wait of zero";
 *   - the one-shot backfill reads an archived summary back into the same
 *     numbers it was built from, and cannot double-count.
 *
 * Category: 2 (SQLite, MySQL AND Postgres — this creates a table, and the
 * engines are where DDL grants, column types and datetime precision actually
 * bite. MySQL is the one that matters most: its DATETIME drops the fractional
 * seconds SQLite and Postgres both keep, which is the whole reason the
 * backfill dedupes on a second-wide bucket rather than an exact timestamp.
 * Postgres is not a deployment target, but it is the third engine the suite
 * claims to support, so the table has to stand up on it too.
 *
 * MySQL and Postgres cases report as SKIPPED when the engine is not up; read
 * the skip count, because a skip is not a pass.)
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-round-stats.js
 *
 * Engines, if you want the non-SQLite cases to actually run:
 *
 *   docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -p 3307:3306 mysql:8
 *   docker run -d --name s3-test-postgres -e POSTGRES_PASSWORD=postgres \
 *     -p 5433:5432 postgres:16-alpine
 *
 * Do not run this file at the same time as another suite in the monorepo;
 * see switch/testing/run-all-tests.js for why.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sequelize } from 'sequelize';

import DBService from '../../s3/utils/db-service.js';
import SwitchDB from '../utils/switch-db.js';
import SwitchOutput from '../utils/switch-output.js';
import SwitchQueue from '../utils/switch-queue.js';
import SwitchCommands from '../utils/switch-commands.js';
import SwitchExplain from '../utils/switch-explain.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';

const TABLE = 'SwitchPlugin_RoundStats';

/**
 * Is TABLE among the names the engine reports, ignoring identifier case?
 *
 * MySQL with lower_case_table_names=1 — which is what the production server
 * runs — stores the table as `switchplugin_roundstats` and reports that name
 * back from showAllTables(), while every statement naming the table keeps
 * working. An exact match here fails on a server that is perfectly healthy.
 *
 * @param {Array<string|{tableName:string}>} tables - showAllTables() result
 * @returns {boolean}
 */
function hasRoundStatsTable(tables) {
  const target = TABLE.toLowerCase();
  return tables.some((entry) => {
    const actual = typeof entry === 'string' ? entry : entry?.tableName;
    return typeof actual === 'string' && actual.toLowerCase() === target;
  });
}
const ASSEMBLY = buildAssembly('.tmp-switch-round-stats');
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

const POSTGRES_ROOT = {
  dialect: 'postgres',
  host: process.env.S3_TEST_PG_HOST || '127.0.0.1',
  port: parseInt(process.env.S3_TEST_PG_PORT || '5433', 10),
  username: process.env.S3_TEST_PG_ADMIN_USER || 'postgres',
  password: process.env.S3_TEST_PG_ADMIN_PASSWORD || 'postgres',
  database: process.env.S3_TEST_PG_DATABASE || 'postgres',
  logging: false,
  dialectOptions: { connectTimeout: 4000 }
};

const SQLITE = { dialect: 'sqlite', storage: ':memory:', logging: false };

const RUN_ID = `${process.pid}_${Date.now() % 100000}`;

// One scratch database per engine for the whole file. Migrations record their
// version in SchemaVersions, so a case that dropped its tables would leave the
// next case with a version row claiming v6 and no table to match it. Cases
// share the schema and clear rows between themselves instead.
const MYSQL_DB = `s3_switch_roundstats_${RUN_ID}`;
const PG_DB = `s3_switch_roundstats_${RUN_ID}`.toLowerCase();
let MYSQL = null;
let POSTGRES = null;
let mysqlReachable = false;
let postgresReachable = false;

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
}

async function probePostgres() {
  let admin;
  try {
    admin = new Sequelize(POSTGRES_ROOT);
    await admin.authenticate();
    // Postgres has no CREATE DATABASE IF NOT EXISTS. RUN_ID makes the name
    // unique per process, so the only way this collides is a re-run inside
    // the same millisecond by the same pid; treat "already exists" as fine.
    try {
      await admin.query(`CREATE DATABASE "${PG_DB}";`);
    } catch (err) {
      if (!/already exists/i.test(err.message)) throw err;
    }
    POSTGRES = { ...POSTGRES_ROOT, database: PG_DB };
    postgresReachable = true;
    console.log(`  postgres reachable on ${POSTGRES_ROOT.host}:${POSTGRES_ROOT.port} (scratch db ${PG_DB})`);
  } catch (err) {
    postgresReachable = false;
    console.log(`  ⚠ postgres not reachable on ${POSTGRES_ROOT.host}:${POSTGRES_ROOT.port} — those cases will skip (${err.message})`);
  } finally {
    try { await admin?.close(); } catch { /* best effort */ }
  }
}

async function dropScratchDatabases() {
  if (mysqlReachable) {
    let admin;
    try {
      admin = new Sequelize(MYSQL_ROOT);
      await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\`;`);
    } catch { /* best effort */ } finally {
      try { await admin?.close(); } catch { /* best effort */ }
    }
  }
  if (postgresReachable) {
    let admin;
    try {
      admin = new Sequelize(POSTGRES_ROOT);
      // Postgres refuses to drop a database that still has sessions on it.
      // teardown() closes each case's connection, but the pool can lag, so
      // evict anything left rather than leaving scratch databases behind.
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${PG_DB}' AND pid <> pg_backend_pid();`
      );
      await admin.query(`DROP DATABASE IF EXISTS "${PG_DB}";`);
    } catch { /* best effort */ } finally {
      try { await admin?.close(); } catch { /* best effort */ }
    }
  }
}

// ── A mounted-enough Switch, against a real engine ─────────────────
//
// Same approach as test-admin-mutations.js and for the same reason: the
// helpers under test are attached to a real instance by the register() calls,
// closing over the real options. Only the collaborators are replaced.

async function buildPlugin({ dialect = 'sqlite', options = {}, matchId = 'round-current', connection = null } = {}) {
  const seq = new Sequelize(
    connection || (dialect === 'sqlite' ? SQLITE : dialect === 'postgres' ? POSTGRES : MYSQL)
  );
  const db = new DBService({ sequelize: seq, defaultRetry: { attempts: 1, baseDelayMs: 0, jitterMs: 0 } });
  await db.mount();

  const server = { players: [], on: () => {}, off: () => {}, removeListener: () => {} };

  const sent = [];
  const plugin = new Switch(server, {
    maxSwitchTokens: 2,
    switchCooldownHours: 1.75,
    roundEndSummaryEnabled: true,
    ...options
  }, {});

  Object.assign(plugin, {
    verbose: () => {},
    warn: () => {},
    sendDiscordMessage: async (payload) => { sent.push(payload); },
    reportError: () => {},
    _s3db: db,
    _getModel: (n) => db.getModel(n),
    verifyAndRunMigrations: async () => null,
    _withDb: async (fn) => db.withTransactionWithRetry(fn),
    _s3: {
      gameState: {
        isSeedMode: () => false,
        getMatchId: () => matchId,
        getLayerName: () => 'Narva_RAAS_v1',
        getGamemode: () => 'RAAS',
        getPhase: () => 'LIVE'
      },
      players: { isReady: () => true, getAllPlayers: () => [], getPlayer: () => null }
    },
    getSecondsFromJoin: async () => 9999,
    getSecondsFromMatchStart: () => 9999,
    _matchendWarnDelayMs: 0
  });

  SwitchOutput.register(plugin);
  SwitchQueue.register(plugin);
  SwitchCommands.register(plugin);
  SwitchExplain.register(plugin);
  await SwitchDB.register(plugin);
  db.migrationEngine.confirmToken('__force__');
  await db.migrationEngine.runMigrations('switch');

  return { plugin, db, seq, sent, model: db.getModel(TABLE) };
}

// Rows, not tables: the MySQL scratch database is shared across cases and its
// schema must outlive any one of them.
async function teardown({ db, seq, model }) {
  try { await model?.destroy({ where: {} }); } catch { /* best effort */ }
  try { await db.unmount(); } catch { /* best effort */ }
  try { await seq.close(); } catch { /* best effort */ }
}

async function onEachEngine(name, fn) {
  await runTest(`${name} [sqlite]`, () => fn('sqlite'));
  await runTest(`${name} [mysql]`, async () => {
    if (!mysqlReachable) return SKIP;
    return fn('mysql');
  });
  await runTest(`${name} [postgres]`, async () => {
    if (!postgresReachable) return SKIP;
    return fn('postgres');
  });
}

// ── Fixtures ───────────────────────────────────────────────────────

/**
 * A round with something of every kind in it, so no count can pass by being
 * accidentally equal to another.
 *
 * Deliberately asymmetric: one instant switch to T1 and two to T2, a trade
 * that sends one player each way, four distinct denial reasons plus an
 * unrecognised one, and one of every queue outcome.
 */
function busyRound(over = {}) {
  return {
    instantSwitches: [
      { name: 'A', eosID: 'a', fromTeam: 2, toTeam: 1, gamePhase: 'LIVE' },
      { name: 'B', eosID: 'b', fromTeam: 1, toTeam: 2, gamePhase: 'LIVE' },
      { name: 'C', eosID: 'c', fromTeam: 1, toTeam: 2, gamePhase: 'LIVE' }
    ],
    deniedSwitches: [
      { name: 'D', eosID: 'd', reason: 'cooldown', gamePhase: 'LIVE' },
      { name: 'E', eosID: 'e', reason: 'cooldown', gamePhase: 'LIVE' },
      { name: 'F', eosID: 'f', reason: 'time_window', gamePhase: 'LIVE' },
      { name: 'G', eosID: 'g', reason: 'scramble_lock', gamePhase: 'LIVE' },
      { name: 'H', eosID: 'h', reason: 'recent_switch', gamePhase: 'LIVE' },
      { name: 'I', eosID: 'i', reason: 'unexpected error', gamePhase: 'LIVE' }
    ],
    _deniedPlayerSet: new Set(['d', 'e', 'f', 'g', 'h', 'i']),
    queueTeamTrades: [
      {
        p1Name: 'J', p2Name: 'K',
        p1FromTeam: 1, p1ToTeam: 2, p2FromTeam: 2, p2ToTeam: 1,
        p1DurationSeconds: 30, p2DurationSeconds: 45, gamePhase: 'LIVE'
      }
    ],
    queueNormal: [
      { name: 'L', eosID: 'l', currentTeamID: 1, toTeam: 2, queueDurationSeconds: 60, gamePhase: 'LIVE' }
    ],
    queueJoinSwaps: [
      { name: 'M', eosID: 'm', type: 'swap', currentTeamID: 2, toTeam: 1, queueDurationSeconds: 15, gamePhase: 'LIVE' }
    ],
    queueExpiries: [
      { name: 'N', eosID: 'n', queueDurationSeconds: 300, gamePhase: 'LIVE' },
      { name: 'O', eosID: 'o', queueDurationSeconds: 300, gamePhase: 'LIVE' }
    ],
    queueDisconnects: [
      { name: 'P', eosID: 'p', currentTeamID: 1, targetTeamID: 2, queueDurationSeconds: 20, gamePhase: 'LIVE' }
    ],
    queueCancels: [
      { name: 'Q', eosID: 'q', currentTeamID: 1, toTeam: 2, queueDurationSeconds: 10 }
    ],
    queueRemovals: [
      { name: 'R', eosID: 'r', reason: 'team change', gamePhase: 'LIVE' }
    ],
    maxQueueSize: 7,
    queueTimeoutSwitches: [
      { name: 'S', eosID: 's', currentTeamID: 2, toTeam: 1, queueDurationSeconds: 90, gamePhase: 'LIVE' }
    ],
    wasLiberalMode: false,
    // Mean 40000, median 30000 — chosen so the two cannot be confused.
    queueDurationsMs: [10000, 30000, 80000],
    matchId: 'match-1',
    layerName: 'Narva_RAAS_v1',
    gameMode: 'RAAS',
    ...over
  };
}

/** A stored row with every count zeroed, for tests that vary one thing. */
function storedRow(over = {}) {
  return {
    matchId: null,
    layerName: null,
    gameMode: null,
    roundEndedAt: new Date(),
    liberalMode: false,
    incomplete: false,
    source: 'live',
    success: 0, failed: 0, denied: 0, toT1: 0, toT2: 0,
    maxQueueSize: 0,
    instant: 0, queueNormal: 0, queueTeamTrade: 0, queueJoinSwap: 0, queueTimeoutSwitch: 0,
    denialCooldown: 0, denialTimeWindow: 0, denialScrambleLock: 0,
    denialRecentSwitch: 0, denialOther: 0,
    outcomeExpired: 0, outcomeDC: 0, outcomeCancelled: 0, outcomeRemoved: 0,
    meanQueueMs: null,
    medianQueueMs: null,
    ...over
  };
}

const MINUTE = 60 * 1000;

console.log('');
console.log('🧪 Switch Round Stats — table, persistence and backfill');
console.log('');
await probeMysql();
await probePostgres();
console.log('');

// ═══════════════════════════════════════════════════════════════════
// 1. The table itself
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('migration v6 creates the round stats table', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    assert.ok(ctx.model, 'SwitchPlugin_RoundStats should be a registered model');
    const qi = ctx.seq.getQueryInterface();
    const tables = await qi.showAllTables();
    assert.ok(hasRoundStatsTable(tables), `migration should have created ${TABLE} — found: ${tables.join(', ')}`);

    // Every column the row builder writes has to exist, or the first round
    // end of the day fails on a live server rather than in this file.
    const described = await qi.describeTable(TABLE);
    for (const col of Object.keys(storedRow())) {
      assert.ok(described[col], `${col} should exist on ${TABLE}`);
    }
  } finally {
    await teardown(ctx);
  }
});

await runTest('migration v6 runs under a production-shaped MySQL grant (CREATE, no ALTER)', async () => {
  if (!mysqlReachable) return SKIP;

  // The deployed MySQL user can CREATE but cannot ALTER. Sequelize emits
  // ALTER TABLE for addIndex, so a migration that looks harmless in a
  // full-privilege scratch database fails on the live server at the moment
  // the plugin first loads. v6 is written as a bare createTable with no
  // addIndex for exactly that reason — this is the case that holds it to it.
  //
  // s3/testing/test-migration-permissions.js proves the same grant against
  // synthetic migrations. This one runs the real v6 migration, so the
  // guarantee survives a later migration that reaches for an index.
  //
  // Only the v5 -> v6 step is run under the restricted grant, because only
  // that step is what a live server applies. The earlier switch migrations
  // add columns, which genuinely do need ALTER — on the deployed server
  // those were applied by hand long ago, so replaying the whole chain here
  // would fail on history rather than on anything this branch ships.
  const GRANT_DB = `${MYSQL_DB}_grant`;
  const USER = 's3_createonly';
  const PASS = 'createonly';

  let admin;
  try {
    admin = new Sequelize(MYSQL_ROOT);
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${GRANT_DB}\`;`);
    // MySQL 8 removed implicit user creation via GRANT.
    await admin.query(`CREATE USER IF NOT EXISTS '${USER}'@'%' IDENTIFIED BY '${PASS}';`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX ON \`${GRANT_DB}\`.* TO '${USER}'@'%';`);
    await admin.query('FLUSH PRIVILEGES;');

    const restricted = {
      ...MYSQL_ROOT,
      username: USER,
      password: PASS,
      database: GRANT_DB
    };

    // Stand the schema up as root, then wind it back to v5 — the state a
    // deployed server is in the moment before this branch reaches it.
    const seeded = await buildPlugin({ dialect: 'mysql', connection: { ...MYSQL_ROOT, database: GRANT_DB } });
    try {
      await seeded.seq.query(`DROP TABLE \`${TABLE}\`;`);
      await seeded.seq.query("UPDATE `S3_SchemaVersions` SET `version` = 5 WHERE `pluginName` = 'switch';");
      const [[check]] = await seeded.seq.query(
        "SELECT `version` FROM `S3_SchemaVersions` WHERE `pluginName` = 'switch';"
      );
      assert.equal(Number(check.version), 5, 'the fixture must actually be sitting at v5');
    } finally {
      await teardown(seeded);
    }

    const ctx = await buildPlugin({ dialect: 'mysql', connection: restricted });
    try {
      const tables = await ctx.seq.getQueryInterface().showAllTables();
      assert.ok(hasRoundStatsTable(tables), `${TABLE} should have been created without ALTER — found: ${tables.join(', ')}`);

      // And the table has to be usable, not merely present: the grant covers
      // DML, so a round must still store and read back.
      ctx.plugin._roundStats = busyRound();
      await ctx.plugin._persistRoundStats();
      assert.equal(await ctx.model.count(), 1, 'a round should store under the restricted grant');
    } finally {
      await teardown(ctx);
    }

    // Prove the grant is actually restrictive, so a future MySQL default
    // that quietly hands out ALTER cannot turn this case into a no-op.
    const probe = new Sequelize(restricted);
    let alterRefused = false;
    try {
      await probe.query(`ALTER TABLE \`${TABLE}\` ADD COLUMN \`grantProbe\` INTEGER NULL;`);
    } catch (err) {
      alterRefused = /denied|permission/i.test(err.message);
    } finally {
      await probe.close();
    }
    assert.ok(alterRefused, 'the test user must genuinely lack ALTER, or this case proves nothing');
  } finally {
    try { await admin?.query(`DROP DATABASE IF EXISTS \`${GRANT_DB}\`;`); } catch { /* best effort */ }
    try { await admin?.close(); } catch { /* best effort */ }
  }
});

await onEachEngine('a round with no queue entries stores a null wait, not a zero', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    await ctx.plugin.recordRoundStats(storedRow({ success: 1, instant: 1, toT1: 1 }));
    const stored = await ctx.model.findOne();
    assert.strictEqual(stored.meanQueueMs, null, 'mean should stay null when nobody queued');
    assert.strictEqual(stored.medianQueueMs, null, 'median should stay null when nobody queued');
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. _computeRoundStatsRow — the arithmetic the embed used to own
// ═══════════════════════════════════════════════════════════════════

await runTest('the row counts every kind of outcome in a busy round', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    ctx.plugin._roundStats = busyRound();
    const row = ctx.plugin._computeRoundStatsRow();

    // 3 instant + 1 trade + 1 normal + 1 join-swap + 1 timeout = 7
    assert.strictEqual(row.success, 7, 'success should count every successful move type');
    assert.strictEqual(row.failed, 2, 'failed should be the expired queue entries');
    assert.strictEqual(row.denied, 6, 'denied should be every denied player');

    assert.strictEqual(row.instant, 3);
    assert.strictEqual(row.queueTeamTrade, 1);
    assert.strictEqual(row.queueNormal, 1);
    assert.strictEqual(row.queueJoinSwap, 1);
    assert.strictEqual(row.queueTimeoutSwitch, 1);

    // A trade moves two players, so it contributes one to each direction and
    // the direction totals exceed the success count.
    assert.strictEqual(row.toT1, 4, 'A, M, S and the trade\'s p2 all end on T1');
    assert.strictEqual(row.toT2, 4, 'B, C, L and the trade\'s p1 all end on T2');

    assert.strictEqual(row.denialCooldown, 2);
    assert.strictEqual(row.denialTimeWindow, 1);
    assert.strictEqual(row.denialScrambleLock, 1);
    assert.strictEqual(row.denialRecentSwitch, 1, 'recent_switch is a real reason, not an "other"');
    assert.strictEqual(row.denialOther, 1, 'an unrecognised reason must land somewhere');
    const bucketed = row.denialCooldown + row.denialTimeWindow + row.denialScrambleLock +
      row.denialRecentSwitch + row.denialOther;
    assert.strictEqual(bucketed, row.denied, 'the buckets must account for every denial');

    assert.strictEqual(row.outcomeExpired, 2);
    assert.strictEqual(row.outcomeDC, 1);
    assert.strictEqual(row.outcomeCancelled, 1);
    assert.strictEqual(row.outcomeRemoved, 1);
    assert.strictEqual(row.maxQueueSize, 7);

    assert.strictEqual(row.meanQueueMs, 40000, 'mean of 10s, 30s and 80s');
    assert.strictEqual(row.medianQueueMs, 30000, 'median of 10s, 30s and 80s');
    assert.strictEqual(row.source, 'live');
    assert.strictEqual(row.incomplete, false);
  } finally {
    await teardown(ctx);
  }
});

await runTest('a round nobody queued in reports no wait rather than an instant one', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    ctx.plugin._roundStats = busyRound({ queueDurationsMs: [] });
    const row = ctx.plugin._computeRoundStatsRow();
    assert.strictEqual(row.meanQueueMs, null, 'an empty queue is not a wait of zero');
    assert.strictEqual(row.medianQueueMs, null);
  } finally {
    await teardown(ctx);
  }
});

await runTest('the summary embed and the stored row report the same numbers', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    ctx.plugin._roundStats = busyRound();
    const row = ctx.plugin._computeRoundStatsRow();
    const embed = ctx.plugin._buildRoundSummaryEmbed();
    const stats = embed.fields.find((f) => f.name.includes('Stats')).value;

    // The embed is what an operator reads; the row is what the reports sum.
    // If these two ever disagree the operator is being lied to by one of them.
    const requests = row.success + row.failed + row.denied;
    assert.ok(stats.includes(`**Requests:** ${requests} (${row.success} succeeded, ${row.denied} denied, ${row.failed} failed)`),
      `embed should print the row's request counts:\n${stats}`);
    assert.ok(stats.includes(`**Denied:** ${row.denied} players`), `embed should print denied ${row.denied}:\n${stats}`);
    assert.ok(stats.includes(`**Max Queue Size:** ${row.maxQueueSize}`), `embed should print maxQueueSize:\n${stats}`);
    assert.ok(stats.includes(`→ T1: ${row.toT1}`), `embed should print toT1 ${row.toT1}:\n${stats}`);
    assert.ok(stats.includes(`→ T2: ${row.toT2}`), `embed should print toT2 ${row.toT2}:\n${stats}`);
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. Persistence is not the summary message's passenger
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('the round is stored even with the summary message switched off', async (dialect) => {
  const ctx = await buildPlugin({ dialect, options: { roundEndSummaryEnabled: false } });
  try {
    ctx.plugin._roundStats = busyRound();
    await ctx.plugin._persistRoundStats();
    await ctx.plugin._postRoundSummary();

    assert.strictEqual(ctx.sent.length, 0, 'the option should still suppress the message');
    const stored = await ctx.model.findOne();
    assert.ok(stored, 'the round must be stored regardless of the message option');
    assert.strictEqual(stored.success, 7, 'and stored with its real numbers');
  } finally {
    await teardown(ctx);
  }
});

await runTest('a round ending with no database does not throw', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    ctx.plugin._roundStats = busyRound();
    // What a server looks like between a connector failure and a reconnect.
    ctx.plugin._getModel = () => null;
    await ctx.plugin._persistRoundStats();
    assert.strictEqual(await ctx.model.count(), 0, 'nothing should have been written');
  } finally {
    await teardown(ctx);
  }
});

await runTest('the round label survives matchId resolving late', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    // NEW_GAME order on a live server: stats are reset before S³ has settled
    // on the new round, and _onLayerChanged fills the gap a moment later.
    let resolved = null;
    ctx.plugin._s3.gameState.getMatchId = () => resolved;
    ctx.plugin._roundStats = ctx.plugin._initRoundStats();
    ctx.plugin._captureRoundIdentity();
    assert.strictEqual(ctx.plugin._roundStats.matchId, null, 'nothing to capture yet');
    assert.strictEqual(ctx.plugin._roundStats.layerName, 'Narva_RAAS_v1', 'the layer was already known');

    resolved = 'match-late';
    ctx.plugin._captureRoundIdentity();
    assert.strictEqual(ctx.plugin._roundStats.matchId, 'match-late', 'the second pass should fill it in');

    // And a later change must not relabel a round that is already identified.
    resolved = 'match-next';
    ctx.plugin._captureRoundIdentity();
    assert.strictEqual(ctx.plugin._roundStats.matchId, 'match-late', 'the first resolved answer wins');
  } finally {
    await teardown(ctx);
  }
});

await runTest('a round is labelled with the layer it was played on, not the one before it', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    // What a live server actually does at NEW_GAME. S³'s layer does not read
    // as null while the next map loads — it reads as the PREVIOUS round's
    // layer, because server info still describes the map being travelled away
    // from. S³ commits that value as trusted and fires its layer-change
    // subscribers with it, so both capture paths see a wrong answer that looks
    // like a right one. Seen on the test server 2026-09-02: a Gorodok_RAAS_v1
    // round stored as AlBasrah_AAS_v1 / AAS.
    let layer = 'AlBasrah_AAS_v1';
    let mode = 'AAS';
    ctx.plugin._s3.gameState.getLayerName = () => layer;
    ctx.plugin._s3.gameState.getGamemode = () => mode;

    ctx.plugin._roundStats = ctx.plugin._initRoundStats();
    ctx.plugin._captureRoundIdentity();   // onNewGame
    ctx.plugin._captureRoundIdentity();   // _onLayerChanged, still stale
    assert.strictEqual(ctx.plugin._roundStats.layerName, 'AlBasrah_AAS_v1',
      'the premise: the round opens holding the previous layer');

    // The real layer arrives seconds later.
    layer = 'Gorodok_RAAS_v1';
    mode = 'RAAS';
    ctx.plugin._captureRoundIdentity();
    assert.strictEqual(ctx.plugin._roundStats.layerName, 'AlBasrah_AAS_v1',
      'first-wins still holds mid-round — only the round-end pass may overwrite');

    // ROUND_ENDED. The layer has been settled for a whole round by now.
    ctx.plugin._captureRoundIdentity({ settled: true });
    assert.strictEqual(ctx.plugin._roundStats.layerName, 'Gorodok_RAAS_v1',
      'the round must be stored under the layer it was actually played on');
    assert.strictEqual(ctx.plugin._roundStats.gameMode, 'RAAS');
    assert.strictEqual(ctx.plugin._roundStats.matchId, 'round-current',
      'matchId keeps first-wins: it reads as null, never as a stale value');

    await ctx.plugin._persistRoundStats();
    const [row] = await ctx.model.findAll();
    assert.strictEqual(row.layerName, 'Gorodok_RAAS_v1', 'and that is the label that reaches the table');
    assert.strictEqual(row.gameMode, 'RAAS');
  } finally {
    await teardown(ctx);
  }
});

await runTest('the round-end pass does not blank a label S³ can no longer supply', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    ctx.plugin._roundStats = ctx.plugin._initRoundStats();
    ctx.plugin._captureRoundIdentity();

    // S³ going quiet at round end must not cost the round the label it spent
    // the whole round holding — the overwrite only applies to a real answer.
    ctx.plugin._s3.gameState.getLayerName = () => null;
    ctx.plugin._s3.gameState.getGamemode = () => null;
    ctx.plugin._captureRoundIdentity({ settled: true });

    assert.strictEqual(ctx.plugin._roundStats.layerName, 'Narva_RAAS_v1',
      'an overwrite with nothing to write must keep what the round already knew');
    assert.strictEqual(ctx.plugin._roundStats.gameMode, 'RAAS');
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4. getRoundStatsTotals
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('totals sum the window and leave liberal rounds out of the numbers', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    const now = Date.now();
    await ctx.model.bulkCreate([
      storedRow({ roundEndedAt: new Date(now - 10 * MINUTE), success: 5, denied: 2, denialCooldown: 2, instant: 5, toT1: 5, maxQueueSize: 3 }),
      storedRow({ roundEndedAt: new Date(now - 5 * MINUTE), success: 3, denied: 1, denialTimeWindow: 1, instant: 3, toT2: 3, maxQueueSize: 9 }),
      // Liberal: counted as excluded, contributes nothing.
      storedRow({ roundEndedAt: new Date(now - 1 * MINUTE), liberalMode: true, success: 100, denied: 100, maxQueueSize: 99 })
    ]);

    const totals = await ctx.plugin.getRoundStatsTotals(new Date(now - 60 * MINUTE));
    assert.strictEqual(totals.rounds, 3, 'every stored round is counted');
    assert.strictEqual(totals.standardRounds, 2);
    assert.strictEqual(totals.liberalRounds, 1);
    assert.strictEqual(totals.success, 8, 'the liberal round must not add to success');
    assert.strictEqual(totals.denied, 3);
    assert.strictEqual(totals.denialCooldown, 2);
    assert.strictEqual(totals.denialTimeWindow, 1);
    assert.strictEqual(totals.toT1, 5);
    assert.strictEqual(totals.toT2, 3);
    assert.strictEqual(totals.maxQueueSize, 9, 'max is a peak, not a sum, and ignores liberal rounds');
    assert.strictEqual(totals.truncated, false);
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('rounds outside the window are not counted', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    const now = Date.now();
    await ctx.model.bulkCreate([
      storedRow({ roundEndedAt: new Date(now - 2 * MINUTE), success: 4 }),
      storedRow({ roundEndedAt: new Date(now - 200 * MINUTE), success: 99 })
    ]);
    const totals = await ctx.plugin.getRoundStatsTotals(new Date(now - 60 * MINUTE));
    assert.strictEqual(totals.standardRounds, 1, 'only the in-window round');
    assert.strictEqual(totals.success, 4);
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('a mean with no median is reported as missing, an absent mean as nothing', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    const now = Date.now();
    await ctx.model.bulkCreate([
      // Current format: both values present.
      storedRow({ roundEndedAt: new Date(now - 3 * MINUTE), meanQueueMs: 20000, medianQueueMs: 15000 }),
      // Recovered from a pre-median embed: a mean and nothing else.
      storedRow({ roundEndedAt: new Date(now - 2 * MINUTE), source: 'scraped', meanQueueMs: 40000, medianQueueMs: null }),
      // Nobody queued: contributes to neither average.
      storedRow({ roundEndedAt: new Date(now - 1 * MINUTE), meanQueueMs: null, medianQueueMs: null })
    ]);

    // Rows come back newest-first, so compare the set rather than the order —
    // nothing downstream depends on which round contributed which wait.
    const totals = await ctx.plugin.getRoundStatsTotals(new Date(now - 60 * MINUTE));
    assert.deepStrictEqual([...totals.queueDurationsMs].sort((a, b) => a - b), [20000, 40000],
      'only rounds that had a queue');
    assert.deepStrictEqual(totals.medianDurationsMs, [15000], 'only the round that recorded one');
    assert.strictEqual(totals.missingMedian, 1, 'the pre-median round should be reported, not hidden');
    assert.strictEqual(totals.scrapedRounds, 1, 'and recovered rounds should be countable');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('queue entries are totalled across successes and non-successes', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    const now = Date.now();
    await ctx.model.create(storedRow({
      roundEndedAt: new Date(now - MINUTE),
      queueNormal: 1, queueTeamTrade: 2, queueJoinSwap: 3, queueTimeoutSwitch: 4,
      outcomeExpired: 5, outcomeDC: 6, outcomeCancelled: 7, outcomeRemoved: 8
    }));
    const totals = await ctx.plugin.getRoundStatsTotals(new Date(now - 60 * MINUTE));
    assert.strictEqual(totals.totalQueueEntries, 36, 'every entry that ever sat in the queue');
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 5. The backfill
// ═══════════════════════════════════════════════════════════════════

await runTest('an archived summary parses back into the numbers it was built from', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    ctx.plugin._roundStats = busyRound();
    const live = ctx.plugin._computeRoundStatsRow();
    const embed = ctx.plugin._buildRoundSummaryEmbed();

    // This is the whole premise of the backfill: the archive is English, so
    // the parsers can still read it, and what comes back must be the round.
    const recovered = ctx.plugin._roundStatsRowFromEmbed(embed, new Date());
    assert.ok(recovered, 'the summary should be parseable');

    for (const field of ['success', 'failed', 'denied', 'toT1', 'toT2', 'maxQueueSize',
      'instant', 'queueNormal', 'queueTeamTrade', 'queueJoinSwap', 'queueTimeoutSwitch',
      'denialCooldown', 'denialTimeWindow', 'denialScrambleLock', 'denialRecentSwitch', 'denialOther',
      'outcomeExpired', 'outcomeDC', 'outcomeCancelled', 'outcomeRemoved']) {
      assert.strictEqual(recovered[field], live[field], `${field} should survive the round trip`);
    }

    // Durations do not survive intact — the embed prints whole seconds — so
    // they are checked to the second rather than to the millisecond.
    assert.strictEqual(Math.round(recovered.meanQueueMs / 1000), Math.round(live.meanQueueMs / 1000));
    assert.strictEqual(Math.round(recovered.medianQueueMs / 1000), Math.round(live.medianQueueMs / 1000));

    assert.strictEqual(recovered.source, 'scraped', 'a recovered round must be marked as one');
    assert.strictEqual(recovered.incomplete, false, 'a current-format embed is not incomplete');
    assert.strictEqual(recovered.matchId, null, 'the embed never carried a matchId');
  } finally {
    await teardown(ctx);
  }
});

await runTest('a liberal round is recovered as liberal', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    ctx.plugin._roundStats = busyRound({ wasLiberalMode: true });
    const embed = ctx.plugin._buildRoundSummaryEmbed();
    const recovered = ctx.plugin._roundStatsRowFromEmbed(embed, new Date());
    assert.strictEqual(recovered.liberalMode, true, 'liberal rounds must stay excludable after recovery');
  } finally {
    await teardown(ctx);
  }
});

await runTest('an embed with no stats field is dropped, not stored as an empty round', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    const recovered = ctx.plugin._roundStatsRowFromEmbed({ fields: [{ name: 'Something Else', value: 'x' }] }, new Date());
    assert.strictEqual(recovered, null, 'an unreadable embed must not become a round of zeros');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('running the backfill twice does not double-count', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    const at = new Date(Date.now() - 30 * MINUTE);
    const rows = [
      storedRow({ roundEndedAt: at, source: 'scraped', success: 4 }),
      storedRow({ roundEndedAt: new Date(at.getTime() + MINUTE), source: 'scraped', success: 6 })
    ];

    const first = await ctx.plugin.backfillRoundStats(rows);
    assert.deepStrictEqual(first, { inserted: 2, skipped: 0 });

    const second = await ctx.plugin.backfillRoundStats(rows);
    assert.deepStrictEqual(second, { inserted: 0, skipped: 2 }, 'a re-run must recognise what it already stored');
    assert.strictEqual(await ctx.model.count(), 2, 'and must not leave duplicates behind');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('the live cut-off is the oldest live round, ignoring recovered ones', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    const now = Date.now();
    await ctx.model.bulkCreate([
      // Older, but recovered — the backfill's own output must not become its
      // own stop line, or a second run would refuse to extend the history.
      storedRow({ roundEndedAt: new Date(now - 100 * MINUTE), source: 'scraped' }),
      storedRow({ roundEndedAt: new Date(now - 40 * MINUTE), source: 'live' }),
      storedRow({ roundEndedAt: new Date(now - 10 * MINUTE), source: 'live' })
    ]);

    const cutoff = await ctx.plugin.getEarliestLiveRoundStat();
    assert.ok(cutoff, 'there are live rounds, so there is a cut-off');
    const drift = Math.abs(cutoff.getTime() - (now - 40 * MINUTE));
    assert.ok(drift < 2000, `cut-off should be the oldest live round, off by ${drift}ms`);
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('with nothing recorded live there is no cut-off', async (dialect) => {
  const ctx = await buildPlugin({ dialect });
  try {
    await ctx.model.create(storedRow({ source: 'scraped' }));
    assert.strictEqual(await ctx.plugin.getEarliestLiveRoundStat(), null,
      'a first backfill must be free to read the whole archive');
  } finally {
    await teardown(ctx);
  }
});

await runTest('a summary posted while the backfill runs is not read back as history', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    // This gap only exists on an empty table. With no live row to stop at the
    // scrape once had no upper bound at all, so a round ending mid-run posted
    // its summary into the range still being read — and it would land seconds
    // away from the live row for the same round, which is the one distance the
    // second-bucket dedupe cannot close.
    assert.strictEqual(await ctx.plugin.getEarliestLiveRoundStat(), null,
      'the premise is an empty table: no live round, so no cut-off from one');

    ctx.plugin._roundStats = busyRound();
    const embed = ctx.plugin._buildRoundSummaryEmbed();

    const archived = { id: 'old', createdAt: new Date(Date.now() - 60 * MINUTE), embeds: [embed] };
    // Stamped after this run begins, which is what a round ending mid-scrape
    // looks like from inside the fetch loop.
    const concurrent = { id: 'new', createdAt: new Date(Date.now() + 5000), embeds: [embed] };

    const batch = new Map([['old', archived], ['new', concurrent]]);
    batch.last = () => ({ id: 'old' });
    ctx.plugin.channel = { messages: { fetch: async () => batch } };

    const sent = [];
    await ctx.plugin._handleBackfillCommand({ channel: { send: async (p) => { sent.push(p); } } }, []);

    assert.strictEqual(await ctx.model.count(), 1, 'only the archived round should have been stored');
    const [row] = await ctx.model.findAll();
    const drift = Math.abs(new Date(row.roundEndedAt).getTime() - archived.createdAt.getTime());
    assert.ok(drift < 2000, `the stored round should be the archived one, off by ${drift}ms`);
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 5. The log is a second copy of the row
// ═══════════════════════════════════════════════════════════════════

await runTest('every recorded stat emits a machine-readable log line', async () => {
  const ctx = await buildPlugin({ dialect: 'sqlite' });
  try {
    const lines = [];
    ctx.plugin.verbose = (level, msg) => lines.push({ level, msg });
    ctx.plugin._roundStats = ctx.plugin._initRoundStats();

    ctx.plugin._trackRoundStat('queueTeamTrades', {
      p1Name: 'Alice', p2Name: 'Bob', p1FromTeam: 1, p1ToTeam: 2, gamePhase: 'LIVE'
    });
    ctx.plugin._trackDenial('eos-1', 'Carol', 'cooldown');

    assert.equal(ctx.plugin._roundStats.queueTeamTrades.length, 1, 'the trade should still be recorded');
    assert.equal(ctx.plugin._roundStats.deniedSwitches.length, 1, 'the denial should still be recorded');

    const stat = lines.filter((l) => l.msg.startsWith('[RoundStat] '));
    assert.equal(stat.length, 2, 'one line per recorded event, no more and no less');
    for (const l of stat) {
      assert.equal(l.level, 1, 'these must survive a default verbosity, or the round is gone before anyone reads them');
    }

    // The point of the format: a log reader can rebuild the round from it.
    const [tradeLine, denialLine] = stat.map((l) => {
      const m = /^\[RoundStat\] (\w+) (\{.*\})$/.exec(l.msg);
      assert.ok(m, `line should be "[RoundStat] <bucket> <json>", got: ${l.msg}`);
      return { bucket: m[1], entry: JSON.parse(m[2]) };
    });

    assert.equal(tradeLine.bucket, 'queueTeamTrades');
    assert.equal(tradeLine.entry.p1Name, 'Alice');
    assert.equal(denialLine.bucket, 'deniedSwitches');
    assert.deepEqual(
      { name: denialLine.entry.name, reason: denialLine.entry.reason },
      { name: 'Carol', reason: 'cooldown' }
    );
  } finally {
    await teardown(ctx);
  }
});

await runTest('a stat cannot be recorded without being logged', async () => {
  // The parity above only holds while every counter goes through the helper.
  // A bare `_roundStats.<bucket>.push(...)` would record silently, and the
  // queue paths are exactly where that would go unnoticed — they are the ones
  // a maintainer cannot reproduce on a live server to check.
  //
  // queueDurationsMs is the one legitimate exception: bare numbers, already
  // carried on the event line logged next to them.
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROOT = path.join(HERE, '..', '..');
  const SOURCES = [
    'switch/plugins/switch.js',
    'switch/utils/switch-output.js',
    'switch/utils/switch-queue.js',
    'switch/utils/switch-commands.js',
    'switch/utils/switch-explain.js',
    'switch/utils/switch-db.js'
  ];

  const offenders = [];
  for (const rel of SOURCES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    src.forEach((line, i) => {
      const m = /_roundStats\.([a-zA-Z_]+)\.push\(/.exec(line);
      if (m && m[1] !== 'queueDurationsMs') offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }

  assert.deepEqual(offenders, [],
    `these record a round stat without logging it — route them through _trackRoundStat:\n${offenders.join('\n')}`);
});

// ── Summary ────────────────────────────────────────────────────────

await dropScratchDatabases();
cleanAssembly(ASSEMBLY);

console.log('');
console.log('─'.repeat(66));
console.log(`📊 Results: ${passed}/${passed + failed} passed, ${failed} failed, ${skipped} skipped`);
console.log('─'.repeat(66));
console.log('');

if (failed > 0) process.exitCode = 1;
