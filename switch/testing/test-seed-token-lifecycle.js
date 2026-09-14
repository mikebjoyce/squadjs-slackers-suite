/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   TEST: SEED TOKEN LIFECYCLE — the four historical failures   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * The seed bonus has broken four distinct ways in the past. Each way is a
 * named case below, asserted against a real engine through the shipped
 * handlers, so that a regression fails a test rather than a seed night:
 *
 *   (a) NO TOKENS GIVEN AT ALL.
 *       A player present for the threshold earns nothing.
 *
 *   (b) TOKENS ONLY ON THE FIRST SEED ROUND, NEVER RESETTING.
 *       seedBonusTokensEarned is a PER-ROUND counter. If nothing resets it,
 *       the first round's grant permanently disqualifies the player from
 *       every later one. Note the designed limit this case must not confuse
 *       itself with: the absolute wallet ceiling (maxSwitchTokens +
 *       seedTokenBonusAmount) legitimately stops a player who is still
 *       holding last round's bonus. Re-earning is gated on having SPENT it,
 *       not on the round counter — both halves are asserted.
 *
 *   (c) WARNING SPAM.
 *       The "you earned +1 switch token" message must fire exactly once per
 *       grant. The grant tick runs on S3_PLAYERS_UPDATED, which fires every
 *       few seconds, so anything that re-notifies already-granted players
 *       spams them for the rest of the round.
 *
 *   (d) PLAYERS NEVER CLEARED FROM THE DB.
 *       Rows must drain. The 2026-08-20 production export held 378 rows of
 *       which the tier-1 prune matched zero, because seed state written
 *       during a seed round was never cleared for anyone who had
 *       disconnected — 85 rows, each at least 10.6 hours stale.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-seed-token-lifecycle.js
 *
 * Category: 2 — SQLite always; MySQL when reachable on 127.0.0.1:3307.
 * MySQL cases SKIP rather than pass when the engine is down, and the skip
 * count is printed: a run with skips is not a green run.
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
// The seed clock, the per-round counter and the round attribution live here
// since the split; the wallet stays on the table above. Every case below
// still describes one player, and srv.side() is how it reads the half that
// is this server’s.
const STATE_TABLE = 'SwitchPlugin_PlayerServerState';
const ASSEMBLY = buildAssembly('.tmp-switch-seed-lifecycle');
const Switch = await importFromAssembly(ASSEMBLY, 'switch.js');

const SKIP = Symbol('skip');
const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;

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
const MYSQL_DB = `s3_switch_seed_${RUN_ID}`;
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

// ── A seeding server, in miniature ─────────────────────────────────
//
// A real Switch instance against a real engine, with a mutable game-state stub
// so a test can advance the round or leave seed mode the way the server does.
// Every warn() the plugin issues is captured, which is what makes case (c)
// assertable at all.

async function buildServer({ dialect = 'sqlite', options = {}, players = [] } = {}) {
  const opts = dialect === 'sqlite' ? SQLITE : MYSQL;
  const seq = new Sequelize(opts);
  const db = new DBService({ sequelize: seq, defaultRetry: { attempts: 1, baseDelayMs: 0, jitterMs: 0 } });
  await db.mount();

  const state = { seedMode: true, ending: false, matchId: 'round-1' };
  const roster = [...players];
  const warns = [];

  const server = { players: roster, on: () => {}, off: () => {}, removeListener: () => {} };

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
    warn: (eosID, message) => { warns.push({ eosID, message }); },
    sendDiscordMessage: async () => {},
    reportError: () => {},
    _s3db: db,
    _getModel: (n) => db.getModel(n),
    verifyAndRunMigrations: async () => null,
    _withDb: async (fn) => db.withTransactionWithRetry(fn),
    _s3: {
      gameState: {
        isSeedMode: () => state.seedMode,
        isEnding: () => state.ending,
        getMatchId: () => state.matchId
      },
      players: {
        isReady: () => true,
        getAllPlayers: () => roster,
        getPlayer: (id) => roster.find((p) => p.eosID === id) || null,
        resetJoinTime: async () => true
      }
    },
    getSecondsFromJoin: async () => 9999,
    getSecondsFromMatchStart: () => 9999,
    _matchendWarnDelayMs: 0
  });

  // Same modules, in the same order, as _onS3Ready(). The handlers under test
  // call helpers these attach (_clearJoinWarnTimeout, queue bookkeeping), so a
  // harness that registers only switch-db.js is not running the shipped path.
  SwitchOutput.register(plugin);
  SwitchQueue.register(plugin);
  SwitchCommands.register(plugin);
  SwitchExplain.register(plugin);
  await SwitchDB.register(plugin);
  db.migrationEngine.confirmToken('__force__');
  await db.migrationEngine.runMigrations('switch');

  const model = db.getModel(TABLE);
  const stateModel = db.getModel(STATE_TABLE);

  return {
    plugin, db, seq, model, stateModel, state, roster, warns,
    /** This server's half of a player, which is where the seed clock is. */
    async side(eosID, serverID = 1) {
      return stateModel.findOne({ where: { serverID, eosID } });
    },
    /** Rewinds a player's presence clock so the threshold has "elapsed". */
    async backdatePresence(eosID, minutes) {
      await stateModel.update(
        { seedPresenceStart: new Date(Date.now() - minutes * MINUTE) },
        { where: { serverID: 1, eosID } }
      );
    },
    /** One S3_PLAYERS_UPDATED tick. */
    async tick() {
      await plugin._onSeedPresenceCheck();
    },
    /** The NEW_GAME transition, in the order the server produces it. */
    async newRound(matchId) {
      state.matchId = matchId;
      await plugin._sweepStaleSeedState();
    },
    async close() {
      try { await model?.destroy({ where: {} }); } catch { /* best effort */ }
      try { await stateModel?.destroy({ where: {} }); } catch { /* best effort */ }
      try { await db.getModel('SwitchPlugin_Endmatches')?.destroy({ where: {} }); } catch { /* best effort */ }
      try { await db.unmount(); } catch { /* best effort */ }
      try { await seq.close(); } catch { /* best effort */ }
    }
  };
}

const P = (eosID, name) => ({ eosID, name, steamID: `steam-${eosID}`, teamID: '1' });

/** Sequential on purpose — MySQL cases share one scratch database. */
async function onEachEngine(name, fn) {
  await runTest(`${name} [sqlite]`, () => fn('sqlite'));
  await runTest(`${name} [mysql]`, async () => {
    if (!mysqlReachable) return SKIP;
    return fn('mysql');
  });
}

console.log('');
console.log('🧪 Seed Token Lifecycle — the four historical failure modes');
console.log('');
await probeMysql();

// ═══════════════════════════════════════════════════════════════════
// (a) No tokens being given
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('(a) a player present for the threshold earns a token', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    // First tick bootstraps the row and starts the clock.
    await srv.tick();
    const bootstrapped = await srv.model.findByPk('eos-alice');
    assert.ok(bootstrapped, 'no row was created for a connected player during seed mode');
    assert.strictEqual(bootstrapped.tokenBalance, 2, 'a fresh row should start at the ordinary cap');
    // Both halves have to be created, and by independent decisions: a player
    // who already has a wallet from another server still needs a row here the
    // first time they seed on this one.
    const bootstrappedSide = await srv.side('eos-alice');
    assert.ok(bootstrappedSide, 'no per-server row was created for a connected player during seed mode');
    assert.ok(bootstrappedSide.seedPresenceStart instanceof Date, 'the presence clock never started');
    assert.strictEqual(bootstrappedSide.serverID, 1, 'the presence clock was started under the wrong server');

    // Not yet at the threshold: nothing may be granted.
    await srv.backdatePresence('eos-alice', 19);
    await srv.tick();
    assert.strictEqual(
      (await srv.model.findByPk('eos-alice')).tokenBalance, 2,
      'a token was granted before the 20-minute threshold elapsed'
    );

    // Past the threshold: the grant must land.
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();

    const earned = await srv.model.findByPk('eos-alice');
    assert.strictEqual(earned.tokenBalance, 3, 'no seed token was granted — failure mode (a)');
    const earnedSide = await srv.side('eos-alice');
    assert.strictEqual(earnedSide.seedBonusTokensEarned, 1, 'the per-round counter did not record the grant');
    assert.strictEqual(earnedSide.lastSeedBonusRoundID, 'round-1', 'the grant was not attributed to a round');
  } finally {
    await srv.close();
  }
});

await onEachEngine('(a) a player who joins mid-seed-round still accrues', async (dialect) => {
  const srv = await buildServer({ dialect, players: [] });
  try {
    const bob = P('eos-bob', 'Bob');
    srv.roster.push(bob);
    await srv.plugin.onS3PlayerJoined({ player: bob });

    const row = await srv.model.findByPk('eos-bob');
    assert.ok(row, 'the join handler created no row during seed mode');
    const side = await srv.side('eos-bob');
    assert.ok(side, 'the join handler created no per-server row during seed mode');
    assert.ok(side.seedPresenceStart instanceof Date, 'the joiner\'s presence clock never started');
    assert.strictEqual(side.lastSeedBonusRoundID, 'round-1', 'presence was written without a round to pair it with');

    await srv.backdatePresence('eos-bob', 21);
    await srv.tick();
    assert.strictEqual((await srv.model.findByPk('eos-bob')).tokenBalance, 3, 'a mid-round joiner earned nothing');
  } finally {
    await srv.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// (b) Tokens only on the first seed round
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('(b) a second seed round grants again once the first token is spent', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    // ── Round 1: earn.
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();
    assert.strictEqual((await srv.model.findByPk('eos-alice')).tokenBalance, 3, 'round 1 granted nothing');

    // Spend the bonus, as a player who actually used their switch would.
    await srv.model.update({ tokenBalance: 2 }, { where: { eosID: 'eos-alice' } });

    // ── Round 2.
    await srv.newRound('round-2');

    const swept = await srv.side('eos-alice');
    assert.strictEqual(
      swept.seedBonusTokensEarned, 0,
      'the per-round counter survived the round change — failure mode (b): the player can never earn again'
    );

    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();

    const second = await srv.model.findByPk('eos-alice');
    assert.strictEqual(second.tokenBalance, 3, 'the second seed round granted nothing — failure mode (b)');
    const secondSide = await srv.side('eos-alice');
    assert.strictEqual(secondSide.seedBonusTokensEarned, 1, 'the second round\'s grant was not recorded');
    assert.strictEqual(secondSide.lastSeedBonusRoundID, 'round-2', 'the grant was attributed to the wrong round');
  } finally {
    await srv.close();
  }
});

await onEachEngine('(b) the wallet ceiling, not the round counter, is what still stops an unspent holder', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();
    assert.strictEqual((await srv.model.findByPk('eos-alice')).tokenBalance, 3);

    // No spend this time — they carry all three into the next round.
    await srv.newRound('round-2');
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();

    const after = await srv.model.findByPk('eos-alice');
    assert.strictEqual(
      after.tokenBalance, 3,
      'a player at the absolute wallet ceiling (maxSwitchTokens + seedTokenBonusAmount) earned a fourth token'
    );
    // ...and the moment they spend, they are eligible again within the same round.
    await srv.model.update({ tokenBalance: 2 }, { where: { eosID: 'eos-alice' } });
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();
    assert.strictEqual(
      (await srv.model.findByPk('eos-alice')).tokenBalance, 3,
      'having spent down, the player should be able to re-earn this round'
    );
  } finally {
    await srv.close();
  }
});

await onEachEngine('(b) a disconnect mid-round does not cost the round\'s earned count', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();
    assert.strictEqual((await srv.side('eos-alice')).seedBonusTokensEarned, 1);

    // Leave stops the clock (v2.5.6) but must not touch the earned counter —
    // if it did, the bootstrap branch on rejoin would hand back the allowance.
    await srv.plugin.onS3PlayerLeft({ player: alice });
    const left = await srv.side('eos-alice');
    assert.strictEqual(left.seedPresenceStart, null, 'the presence clock kept running while disconnected');
    assert.strictEqual(left.seedBonusTokensEarned, 1, 'leaving reset the round\'s earned count');

    // Rejoin: clock restarts, allowance stays spent.
    await srv.plugin.onS3PlayerJoined({ player: alice });
    const rejoined = await srv.side('eos-alice');
    assert.ok(rejoined.seedPresenceStart instanceof Date, 'the clock did not restart on rejoin');
    assert.strictEqual(
      rejoined.seedBonusTokensEarned, 1,
      'rejoining reset the per-round allowance — a player could farm tokens by reconnecting'
    );

    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();
    assert.strictEqual(
      (await srv.model.findByPk('eos-alice')).tokenBalance, 3,
      'a reconnect loop earned a second token within one round'
    );
  } finally {
    await srv.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// (b) The endgame consolation — a claim and a credit, on two tables
// ═══════════════════════════════════════════════════════════════════
//
// Before the split this was one UPDATE whose WHERE spanned the wallet and
// the seed trio, and that single statement WAS the compare-and-swap defence
// against a concurrent S3_PLAYERS_UPDATED tick. The columns are on two
// tables now and Sequelize cannot express a portable cross-table conditional
// UPDATE, so the defence is a claim on the per-server row followed by a
// credit to the wallet, both inside one transaction and behind one promise
// chain. These cases pin what that has to preserve.

await onEachEngine('(b) the endgame consolation grants once and closes the round', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);

    await srv.plugin._grantSeedBonusAtEndgame();

    assert.strictEqual(
      (await srv.model.findByPk('eos-alice')).tokenBalance, 3,
      'the consolation grant never reached the wallet — the claim was spent for nothing'
    );
    const side = await srv.side('eos-alice');
    assert.strictEqual(side.seedBonusTokensEarned, 1, 'the claim was not recorded on the per-server row');
    assert.strictEqual(side.seedPresenceStart, null, 'the round was not closed — presence carries into the gap');
    assert.strictEqual(side.lastSeedBonusRoundID, 'round-1', 'the grant was not attributed to a round');

    // Running it again must find nothing: the claim predicate is the whole
    // re-entrancy defence, and ENDGAME can be re-emitted.
    await srv.plugin._grantSeedBonusAtEndgame();
    assert.strictEqual(
      (await srv.model.findByPk('eos-alice')).tokenBalance, 3,
      'a second ENDGAME granted a second token — the claim predicate is not idempotent'
    );
  } finally {
    await srv.close();
  }
});

await onEachEngine('(b) a player at the wallet ceiling keeps their claim', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);
    // Already at maxSwitchTokens + seedTokenBonusAmount.
    await srv.model.update({ tokenBalance: 3 }, { where: { eosID: 'eos-alice' } });

    await srv.plugin._grantSeedBonusAtEndgame();

    assert.strictEqual(
      (await srv.model.findByPk('eos-alice')).tokenBalance, 3,
      'the ceiling was crossed — the credit statement must restate it'
    );
    const side = await srv.side('eos-alice');
    assert.strictEqual(
      side.seedBonusTokensEarned, 0,
      'the claim was spent on a grant that never happened — a player at the ceiling must stay unclaimed so they can earn once they spend'
    );
    assert.strictEqual(
      side.seedPresenceStart, null,
      'the round must still close for everyone connected, granted or not'
    );
  } finally {
    await srv.close();
  }
});

await onEachEngine('(b) the endgame grant and a periodic tick cannot both pay out', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);

    // Both reconcilers, in flight together. This is the race the single
    // atomic UPDATE used to settle by itself. It is settled now by the claim
    // UPDATE restating its own predicate — the second writer claims zero rows
    // and the credit is gated on that count — with _withSeedGrantLock() as a
    // belt on top. The case is written against the outcome rather than the
    // mechanism for that reason: reducing the lock to fn() does not fail it,
    // and a case that only passes because of a redundant guard would report
    // the wrong thing when the guard was removed.
    await Promise.all([
      srv.plugin._grantSeedBonusAtEndgame(),
      srv.tick()
    ]);

    assert.strictEqual(
      (await srv.model.findByPk('eos-alice')).tokenBalance, 3,
      'the endgame grant and the periodic tick both paid out — the grant paths are not serialised'
    );
    assert.strictEqual(
      (await srv.side('eos-alice')).seedBonusTokensEarned, 1,
      'the per-round counter was incremented twice in one round'
    );
  } finally {
    await srv.close();
  }
});

await onEachEngine('(b) the claim and the credit run under one transaction', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);

    // S³ runs no CLS, so a statement with no handle executes outside the
    // transaction on any pooled engine — and the pairing this whole rewrite
    // exists to keep is exactly what that breaks: a claim that commits while
    // its credit rolls back is a seed round spent for nothing. Asserted on
    // the handle rather than on an effect, because SQLite backs an in-memory
    // database with one connection and would roll the stray statement back
    // anyway, hiding the defect the deployed engines would show.
    const seen = [];
    const spy = (target, label, method) => {
      const real = target[method].bind(target);
      target[method] = async (...args) => {
        const opts = args[args.length - 1];
        seen.push({ label, transaction: opts && typeof opts === 'object' ? opts.transaction : undefined });
        return real(...args);
      };
    };
    spy(srv.stateModel, 'claim', 'update');
    spy(srv.model, 'credit', 'update');

    await srv.plugin._grantSeedBonusAtEndgame();

    assert.ok(seen.some((s) => s.label === 'claim'), 'no claim statement ran');
    assert.ok(seen.some((s) => s.label === 'credit'), 'no credit statement ran');
    for (const s of seen) {
      assert.ok(s.transaction, `the ${s.label} statement got no transaction handle`);
    }
    const handles = new Set(seen.map((s) => s.transaction));
    assert.strictEqual(handles.size, 1, `the endgame grant spanned ${handles.size} transactions`);
  } finally {
    await srv.close();
  }
});

await onEachEngine('(b) a failed credit does not spend the claim', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);

    const realUpdate = srv.model.update.bind(srv.model);
    srv.model.update = async () => { throw new Error('engine says no'); };
    try {
      await srv.plugin._grantSeedBonusAtEndgame();
    } finally {
      srv.model.update = realUpdate;
    }

    const side = await srv.side('eos-alice');
    assert.strictEqual(
      side.seedBonusTokensEarned, 0,
      'the claim was committed while the credit failed — the player\u2019s seed round is gone and no token came back for it'
    );
    assert.ok(
      side.seedPresenceStart instanceof Date,
      'the round was closed by a transaction that failed'
    );
    assert.strictEqual(
      (await srv.model.findByPk('eos-alice')).tokenBalance, 2,
      'a token appeared despite the credit failing'
    );
  } finally {
    await srv.close();
  }
});

await onEachEngine('(b) the endgame grant leaves another server\u2019s seed round alone', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);

    // The same player, mid-seed-round on a server that is not ending. Its
    // round is that server’s to close: this process cannot know whether the
    // presence there is stale or live, and closing it costs a real token.
    await srv.stateModel.create({
      serverID: 2, eosID: 'eos-alice',
      seedPresenceStart: new Date(Date.now() - 21 * MINUTE),
      seedBonusTokensEarned: 0,
      lastActiveTimestamp: new Date()
    });

    await srv.plugin._grantSeedBonusAtEndgame();

    const other = await srv.side('eos-alice', 2);
    assert.ok(
      other.seedPresenceStart instanceof Date,
      'this server\u2019s ENDGAME closed another server\u2019s seed round'
    );
    assert.strictEqual(
      other.seedBonusTokensEarned, 0,
      'this server\u2019s ENDGAME claimed another server\u2019s row'
    );
    assert.strictEqual(
      (await srv.model.findByPk('eos-alice')).tokenBalance, 3,
      'the shared wallet should still have been credited exactly once'
    );
  } finally {
    await srv.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// (c) Warning spam
// ═══════════════════════════════════════════════════════════════════

const seedWarns = (srv) => srv.warns.filter((w) => /Seed bonus/i.test(w.message));

await onEachEngine('(c) the grant message fires exactly once, not once per tick', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();
    assert.strictEqual(seedWarns(srv).length, 1, 'the grant did not notify the player exactly once');

    // S3_PLAYERS_UPDATED fires every few seconds for the rest of the round.
    for (let i = 0; i < 25; i++) await srv.tick();

    assert.strictEqual(
      seedWarns(srv).length, 1,
      `the player was warned ${seedWarns(srv).length} times — failure mode (c): 25 further ticks re-notified an already-granted player`
    );
    assert.strictEqual(
      (await srv.model.findByPk('eos-alice')).tokenBalance, 3,
      'repeated ticks granted extra tokens'
    );
  } finally {
    await srv.close();
  }
});

await onEachEngine('(c) the message names the balance the player actually ends up with', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();

    const [warned] = seedWarns(srv);
    const balance = (await srv.model.findByPk('eos-alice')).tokenBalance;
    assert.ok(
      warned.message.includes(`${balance} tokens`),
      `message says "${warned.message}" but the row holds ${balance} — the notification is built from the pre-grant snapshot and must add the grant back`
    );
    assert.ok(warned.message.includes('1/1 bonus tokens'), `bonus counter wrong in: ${warned.message}`);
    assert.strictEqual(warned.eosID, 'eos-alice', 'the message went to the wrong identifier');
  } finally {
    await srv.close();
  }
});

await onEachEngine('(c) only the players granted this tick are notified', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const bob = P('eos-bob', 'Bob');
  const srv = await buildServer({ dialect, players: [alice, bob] });
  try {
    await srv.tick();

    // Alice crosses the threshold first.
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();
    assert.deepStrictEqual(seedWarns(srv).map((w) => w.eosID), ['eos-alice']);

    // Bob crosses on a later tick. Alice must not be warned a second time.
    await srv.backdatePresence('eos-bob', 21);
    await srv.tick();
    assert.deepStrictEqual(
      seedWarns(srv).map((w) => w.eosID), ['eos-alice', 'eos-bob'],
      'the notification set is not the players granted on that tick'
    );
  } finally {
    await srv.close();
  }
});

// ═══════════════════════════════════════════════════════════════════
// (d) Players never cleared from the DB
// ═══════════════════════════════════════════════════════════════════

await onEachEngine('(d) a seeder who leaves is fully drained within the retention window', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    // Earn, then leave — the exact shape of the 85 stranded production rows.
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();
    await srv.plugin.onS3PlayerLeft({ player: alice });
    srv.roster.length = 0;

    // Round turns over without them. This is what nothing used to do.
    await srv.newRound('round-2');

    const swept = await srv.side('eos-alice');
    assert.strictEqual(swept.seedPresenceStart, null, 'seed presence outlived the round — failure mode (d)');
    assert.strictEqual(swept.seedBonusTokensEarned, 0, 'per-round accrual outlived the round — failure mode (d)');

    // They still hold the bonus token, so tier 1 (which requires exactly max)
    // correctly leaves them alone; tier 2 takes them at the retention horizon.
    srv.state.seedMode = false;
    await srv.model.update(
      { lastActiveTimestamp: new Date(Date.now() - 4 * 24 * HOUR) },
      { where: { eosID: 'eos-alice' } }
    );
    await srv.plugin.cleanup();

    assert.strictEqual(
      await srv.model.count(), 0,
      'the row survived past pruneInactivePlayerDays — failure mode (d): the table only ever grows'
    );
    // The per-server row goes in the same transaction. A surviving one is a
    // seed clock belonging to a player who no longer has a wallet, and the
    // next reconciler tick would read it as live state.
    assert.strictEqual(
      await srv.stateModel.count(), 0,
      'the per-server row outlived the wallet it belongs to'
    );
  } finally {
    await srv.close();
  }
});

await onEachEngine('(d) a spent-and-regenerated seeder drains on the 30-minute tier', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    await srv.backdatePresence('eos-alice', 21);
    await srv.tick();

    // Spends down, then disconnects.
    await srv.model.update({ tokenBalance: 1 }, { where: { eosID: 'eos-alice' } });
    await srv.plugin.onS3PlayerLeft({ player: alice });
    srv.roster.length = 0;
    await srv.newRound('round-2');

    // Two hours pass. The leave handler stamps lastActiveTimestamp to NOW, so
    // the backdating has to come after it, not before — a row is only prunable
    // once it has actually been unseen for a while.
    await srv.model.update(
      {
        tokenRegenAnchor: new Date(Date.now() - 2 * HOUR),
        lastActiveTimestamp: new Date(Date.now() - 2 * HOUR)
      },
      { where: { eosID: 'eos-alice' } }
    );

    srv.state.seedMode = false;
    await srv.plugin.cleanup();

    assert.strictEqual(
      await srv.model.count(), 0,
      'a fully regenerated, seed-free, unlocked row was not pruned — this is the case that matched 0 of 378 live rows'
    );
  } finally {
    await srv.close();
  }
});

await onEachEngine('(d) connected players are never pruned out from under themselves', async (dialect) => {
  const alice = P('eos-alice', 'Alice');
  const srv = await buildServer({ dialect, players: [alice] });
  try {
    await srv.tick();
    // Ancient last-active, but still on the roster.
    await srv.model.update(
      { lastActiveTimestamp: new Date(Date.now() - 30 * 24 * HOUR) },
      { where: { eosID: 'eos-alice' } }
    );

    srv.state.seedMode = false;
    await srv.plugin.cleanup();

    assert.strictEqual(
      await srv.model.count(), 1,
      'a connected player\'s row was pruned — the reconciler would immediately recreate it, so this is pure churn'
    );
  } finally {
    await srv.close();
  }
});

await onEachEngine('(d) a whole seed lobby drains after everyone leaves', async (dialect) => {
  const lobby = Array.from({ length: 40 }, (_, i) => P(`eos-${i}`, `Player${i}`));
  const srv = await buildServer({ dialect, players: lobby });
  try {
    await srv.tick();
    // Half of them earn a token; the rest just pass through.
    for (let i = 0; i < 20; i++) await srv.backdatePresence(`eos-${i}`, 21);
    await srv.tick();
    assert.strictEqual(await srv.model.count(), 40, 'the lobby should be fully tracked while connected');

    // Server empties, round turns over, days pass.
    for (const p of lobby) await srv.plugin.onS3PlayerLeft({ player: p });
    srv.roster.length = 0;
    await srv.newRound('round-2');

    const stranded = await srv.stateModel.count({
      where: { seedPresenceStart: { [Sequelize.Op.ne]: null } }
    });
    assert.strictEqual(stranded, 0, `${stranded} rows kept a seed clock after everyone left — failure mode (d)`);

    srv.state.seedMode = false;
    await srv.model.update({ lastActiveTimestamp: new Date(Date.now() - 4 * 24 * HOUR) }, { where: {} });
    await srv.plugin.cleanup();

    assert.strictEqual(await srv.model.count(), 0, 'the table did not drain — failure mode (d)');
    assert.strictEqual(await srv.stateModel.count(), 0, 'the per-server table did not drain — failure mode (d)');
  } finally {
    await srv.close();
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
