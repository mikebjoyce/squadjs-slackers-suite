/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   TEST: LEGACY-MODE COOLDOWN DISPLAY — what the admin is told ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * `!switch check <player>` renders its cooldown line one of two ways,
 * gated on showTokenMessaging (maxSwitchTokens > 1). The token wording
 * has always read the token bucket. The legacy wording — the branch a
 * server running maxSwitchTokens <= 1 gets — used to derive cooldown
 * from lastSwitchTimestamp, a column no write site has populated since
 * switch migration v3. It is therefore null on every row, so the reply
 * said "Cooldown: No" for every player on every server in that mode,
 * including players _checkSwitchEligibility() was actively refusing.
 *
 * Enforcement is token-based at every value of maxSwitchTokens
 * (switch.js:1256-1274). These cases pin the display to the same
 * source, so the two cannot disagree again.
 *
 * ─── WHY THIS FILE RUNS THE REAL PATH ────────────────────────────
 *
 * test-token-messaging.js already had a case named "Check command:
 * legacy mode" and it passed throughout. It passed because it built a
 * lastSwitchTimestamp itself and re-implemented the branch inline —
 * it asserted against its own simulation, never against the shipped
 * code, so production could read a permanently-null column and the
 * test could not tell. Everything here goes through
 * plugin.onChatMessage() against a real engine: the command dispatch,
 * the admin gate, checkPlayer()'s read, _regenTokens(), and the
 * localized string the admin actually receives.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-legacy-cooldown-display.js
 *
 * Category: 2 — SQLite always; MySQL when reachable on 127.0.0.1:3307.
 * MySQL cases SKIP rather than silently pass when the engine is down;
 * a non-zero skip count is not a green run.
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
const ASSEMBLY = buildAssembly('.tmp-switch-legacy-cooldown');
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

const SQLITE = { dialect: 'sqlite', storage: ':memory:', logging: false };

const RUN_ID = `${process.pid}_${Date.now() % 100000}`;
const MYSQL_DB = `s3_switch_cooldown_${RUN_ID}`;
let MYSQL = null;
let mysqlReachable = false;

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
// Same approach and reasoning as test-admin-mutations.js: the handlers are
// class fields holding arrow functions, so they exist only on real instances.
// Only the collaborators are stubbed; every statement between onChatMessage()
// and the rendered string is production code.

// Seconds default to 0 — inside the switch window — so the token check in
// _checkSwitchEligibility() is actually reachable. At 9999 it returns
// `time_window` before ever reading the bucket, and case 4 would be asserting
// against a refusal that has nothing to do with cooldown.
async function buildPlugin({
  dialect = 'sqlite',
  options = {},
  secondsFromJoin = 0,
  secondsFromMatchStart = 0
} = {}) {
  const opts = dialect === 'sqlite' ? SQLITE : MYSQL;
  const seq = new Sequelize(opts);
  const db = new DBService({ sequelize: seq, defaultRetry: { attempts: 1, baseDelayMs: 0, jitterMs: 0 } });
  await db.mount();

  const server = { players: [], on: () => {}, off: () => {}, removeListener: () => {} };

  const plugin = new Switch(server, {
    maxSwitchTokens: 1,
    switchCooldownHours: 1,
    switchCooldownMinutes: 0,
    switchEnabledMinutes: 5,
    seedTokenBonusAmount: 0,
    seedTokenBonusMinutes: 0,
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
    verifyAndRunMigrations: async () => null,
    _withDb: async (fn) => db.withTransactionWithRetry(fn),
    _s3: {
      gameState: {
        isSeedMode: () => false,
        getMatchId: () => 'round-current'
      },
      players: {
        isReady: () => true,
        getAllPlayers: () => [],
        getPlayer: () => null,
        resetJoinTime: async () => true
      }
    },
    getSecondsFromJoin: async () => secondsFromJoin,
    getSecondsFromMatchStart: () => secondsFromMatchStart,
    _matchendWarnDelayMs: 0
  });

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
    stateModel: db.getModel(STATE_TABLE)
  };
}

async function teardown({ db, seq, model, stateModel }) {
  try { await model?.destroy({ where: {} }); } catch { /* best effort */ }
  try { await stateModel?.destroy({ where: {} }); } catch { /* best effort */ }
  try { await db.unmount(); } catch { /* best effort */ }
  try { await seq.close(); } catch { /* best effort */ }
}

async function onEachEngine(name, fn) {
  await runTest(`${name} [sqlite]`, () => fn('sqlite'));
  await runTest(`${name} [mysql]`, async () => {
    if (!mysqlReachable) return SKIP;
    return fn('mysql');
  });
}

/** Captures what the admin is told, so a wrong answer cannot pass as silence. */
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

const HOUR = 3600 * 1000;

/**
 * A player row as the live schema holds one from v3 onward:
 * lastSwitchTimestamp null, state carried by tokenBalance/tokenRegenAnchor.
 * Spelled explicitly rather than defaulted — a fixture that quietly supplied
 * a lastSwitchTimestamp would make the legacy branch look like it worked.
 */
const player = (over = {}) => ({
  eosID: 'eos-target',
  playerName: 'TargetPlayer',
  lastSwitchTimestamp: null,
  tokenBalance: 1,
  tokenRegenAnchor: null,
  lastActiveTimestamp: new Date(),
  ...over
});

console.log('');
console.log('🧪 Switch Legacy-Mode Cooldown Display — real engines');
console.log('');
await probeMysql();

// ═══════════════════════════════════════════════════════════════════
// 1. The regression: a drained player in legacy mode
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('legacy mode reports a drained player as ON cooldown', async (dialect) => {
  const ctx = await buildPlugin({ dialect, options: { maxSwitchTokens: 1 } });
  const warns = withWarnCapture(ctx.plugin);
  try {
    // Spent their only token ten minutes ago; the cooldown is an hour, so the
    // bucket has not refilled and _checkSwitchEligibility() would refuse them.
    await ctx.model.create(player({
      tokenBalance: 0,
      tokenRegenAnchor: new Date(Date.now() - 10 * 60 * 1000)
    }));

    await ctx.plugin.onChatMessage(chat('!switch check TargetPlayer'));

    const reply = warns.join(' ');
    assert.ok(reply.length > 0, 'the admin got no reply at all');
    // The regression this file exists for: this was "Cooldown: No".
    assert.match(
      reply,
      /Cooldown:\s*Yes/,
      `a player with an empty token bucket was reported as clear: ${JSON.stringify(warns)}`
    );
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('legacy mode reports a player with a token as NOT on cooldown', async (dialect) => {
  const ctx = await buildPlugin({ dialect, options: { maxSwitchTokens: 1 } });
  const warns = withWarnCapture(ctx.plugin);
  try {
    await ctx.model.create(player({ tokenBalance: 1, tokenRegenAnchor: null }));

    await ctx.plugin.onChatMessage(chat('!switch check TargetPlayer'));

    const reply = warns.join(' ');
    assert.match(
      reply,
      /Cooldown:\s*No/,
      `a player holding a token was reported as on cooldown: ${JSON.stringify(warns)}`
    );
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 2. Regeneration is honoured, not just the stored balance
// ═══════════════════════════════════════════════════════════════════
//
// The stored row still says zero; the anchor is old enough that _regenTokens()
// refills it in memory. Enforcement would let this player switch, so the
// display has to agree. A fix that read tokenBalance straight off the row
// without regenerating would pass case 1 and fail here.

await onEachEngine('legacy mode reports a regenerated player as clear', async (dialect) => {
  const ctx = await buildPlugin({ dialect, options: { maxSwitchTokens: 1, switchCooldownHours: 1 } });
  const warns = withWarnCapture(ctx.plugin);
  try {
    await ctx.model.create(player({
      tokenBalance: 0,
      tokenRegenAnchor: new Date(Date.now() - 2 * HOUR)
    }));

    await ctx.plugin.onChatMessage(chat('!switch check TargetPlayer'));

    assert.match(
      warns.join(' '),
      /Cooldown:\s*No/,
      `a fully regenerated player was still reported as on cooldown: ${JSON.stringify(warns)}`
    );
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 3. A stale lastSwitchTimestamp cannot steer the answer
// ═══════════════════════════════════════════════════════════════════
//
// Rows predating migration v3 can still carry a value in the abandoned column.
// It must not contribute: the bucket is the only source. Both directions are
// checked, because reading the dead column would produce the right answer by
// coincidence in one of them.

await onEachEngine('a stale lastSwitchTimestamp does not fake a cooldown', async (dialect) => {
  const ctx = await buildPlugin({ dialect, options: { maxSwitchTokens: 1, switchCooldownHours: 1 } });
  const warns = withWarnCapture(ctx.plugin);
  try {
    await ctx.model.create(player({
      // Recent enough that the abandoned rule would call this a live cooldown.
      lastSwitchTimestamp: new Date(Date.now() - 5 * 60 * 1000),
      tokenBalance: 1,
      tokenRegenAnchor: null
    }));

    await ctx.plugin.onChatMessage(chat('!switch check TargetPlayer'));

    assert.match(
      warns.join(' '),
      /Cooldown:\s*No/,
      `the abandoned column overrode a full token bucket: ${JSON.stringify(warns)}`
    );
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('a stale lastSwitchTimestamp does not hide a real cooldown', async (dialect) => {
  const ctx = await buildPlugin({ dialect, options: { maxSwitchTokens: 1, switchCooldownHours: 1 } });
  const warns = withWarnCapture(ctx.plugin);
  try {
    await ctx.model.create(player({
      // Long expired under the abandoned rule; the bucket says otherwise.
      lastSwitchTimestamp: new Date(Date.now() - 10 * HOUR),
      tokenBalance: 0,
      tokenRegenAnchor: new Date(Date.now() - 60 * 1000)
    }));

    await ctx.plugin.onChatMessage(chat('!switch check TargetPlayer'));

    assert.match(
      warns.join(' '),
      /Cooldown:\s*Yes/,
      `the abandoned column masked an empty token bucket: ${JSON.stringify(warns)}`
    );
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 4. The display agrees with what enforcement would actually do
// ═══════════════════════════════════════════════════════════════════
//
// The point of the fix, asserted directly rather than inferred from wording:
// _checkSwitchEligibility() is the rule, and the admin reply must describe it.

await onEachEngine('the legacy reply agrees with _checkSwitchEligibility', async (dialect) => {
  const ctx = await buildPlugin({ dialect, options: { maxSwitchTokens: 1, switchCooldownHours: 1 } });
  const warns = withWarnCapture(ctx.plugin);
  try {
    await ctx.model.create(player({
      tokenBalance: 0,
      tokenRegenAnchor: new Date(Date.now() - 10 * 60 * 1000)
    }));

    // Reads the same row from the same engine — no fixture is handed to it.
    const eligibility = await ctx.plugin._checkSwitchEligibility({ eosID: 'eos-target', teamID: 1 });
    assert.strictEqual(eligibility.eligible, false, 'fixture no longer produces a refusal — rewrite it');
    assert.strictEqual(eligibility.reason, 'cooldown', `expected a cooldown refusal, got ${eligibility.reason}`);

    await ctx.plugin.onChatMessage(chat('!switch check TargetPlayer'));

    assert.match(
      warns.join(' '),
      /Cooldown:\s*Yes/,
      `enforcement refuses this player but the admin reply says they are clear: ${JSON.stringify(warns)}`
    );
  } finally {
    await teardown(ctx);
  }
});

// ═══════════════════════════════════════════════════════════════════
// 5. Token mode is unchanged
// ═══════════════════════════════════════════════════════════════════
//
// The fix hoisted the bucket read out of the token branch. These pin that the
// branch it came from still renders the same way.

await onEachEngine('token mode still renders a balance, not Yes/No', async (dialect) => {
  const ctx = await buildPlugin({ dialect, options: { maxSwitchTokens: 2 } });
  const warns = withWarnCapture(ctx.plugin);
  try {
    await ctx.model.create(player({ tokenBalance: 1, tokenRegenAnchor: null }));

    await ctx.plugin.onChatMessage(chat('!switch check TargetPlayer'));

    const reply = warns.join(' ');
    assert.match(reply, /Tokens:\s*1\/2/, `token mode lost its balance rendering: ${JSON.stringify(warns)}`);
    assert.doesNotMatch(reply, /Cooldown:\s*(Yes|No)/, 'token mode fell through to the legacy wording');
  } finally {
    await teardown(ctx);
  }
});

await onEachEngine('token mode still renders the empty-bucket countdown', async (dialect) => {
  const ctx = await buildPlugin({ dialect, options: { maxSwitchTokens: 2, switchCooldownHours: 1 } });
  const warns = withWarnCapture(ctx.plugin);
  try {
    await ctx.model.create(player({
      tokenBalance: 0,
      tokenRegenAnchor: new Date(Date.now() - 10 * 60 * 1000)
    }));

    await ctx.plugin.onChatMessage(chat('!switch check TargetPlayer'));

    assert.match(
      warns.join(' '),
      /Tokens:\s*0\/2, next in \d+m/,
      `token mode lost its countdown: ${JSON.stringify(warns)}`
    );
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
process.exit(failed > 0 ? 1 : 0);
