/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     SWITCH / KARMA REPORTS — s3-switch-reports.js               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Covers s3/utils/s3-switch-reports.js: the query/aggregation module behind
 * `!s3 switches` and `!s3 karma`.
 *
 * Section 1 is pure-JS (parseRange, looksLikeRangeToken, isUnambiguous) — no
 * DB needed. Section 2 seeds a real DBService (SQLite always; MySQL via
 * S3_TEST_MYSQL_* env vars, self-skipping when unreachable) with the exact
 * schemas logging-service.js and team-balancer.js define in production, and
 * asserts the getter functions read them back correctly on both engines —
 * this is what actually proves the "aggregate in JS, not SQL" design avoids
 * MySQL's ONLY_FULL_GROUP_BY class of bug, not just an assertion that it does.
 *
 * Category: 1 (SQLite always; MySQL self-skips when unreachable)
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

import DBService from '../utils/db-service.js';
import {
  parseRange,
  looksLikeRangeToken,
  isUnambiguous,
  checkLoggingAvailability,
  resolvePlayers,
  getGamesPlayedMap,
  getSwitchesMap,
  getPlayerSwitches,
  getKarmaReport,
  isPeriodToken,
  getSwitchesByPeriodAndPlayer
} from '../utils/s3-switch-reports.js';

// ---------------------------------------------------------------------------
// Harness
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
  console.log('Switch / Karma Reports Tests');
  console.log('='.repeat(72));
  console.log('');

  await probeReachability();

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
// Dialect setup — ports match test-dialect-portability.js
// ---------------------------------------------------------------------------

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

const SQLITE = { dialect: 'sqlite', storage: ':memory:', logging: false };

const DIALECTS = [
  { name: 'sqlite', opts: SQLITE },
  { name: 'mysql', opts: MYSQL }
];

const reachability = new Map([['sqlite', true]]);

async function probeReachability() {
  for (const { name, opts } of [{ name: 'mysql', opts: MYSQL }]) {
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

/** Unique-ish suffix so parallel/rerun cases never collide on a shared MySQL. */
const RUN_ID = `${process.pid}_${Date.now() % 100000}`;

/**
 * Open a mounted DBService against one dialect, define the three tables this
 * module reads (mirroring logging-service.js / team-balancer.js exactly), and
 * hand it to `fn`. Returns SKIP when the engine is unreachable.
 */
async function withDialect(name, fn) {
  if (!reachability.get(name)) return SKIP;
  const opts = DIALECTS.find((d) => d.name === name).opts;
  const seq = new Sequelize(opts);
  const db = new DBService({ sequelize: seq, defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 } });
  await db.mount();

  const suffix = name === 'mysql' ? `_${RUN_ID}` : '';

  const eventsModel = db.defineModel(
    `S3PlayerEvents${suffix}`,
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      matchId: { type: DataTypes.STRING, allowNull: true },
      roundStartTime: { type: DataTypes.BIGINT, allowNull: true },
      ts: { type: DataTypes.BIGINT, allowNull: false },
      eventType: { type: DataTypes.STRING, allowNull: false },
      eosID: { type: DataTypes.STRING, allowNull: true },
      steamID: { type: DataTypes.STRING, allowNull: true },
      name: { type: DataTypes.STRING, allowNull: true },
      teamID: { type: DataTypes.INTEGER, allowNull: true },
      squadID: { type: DataTypes.INTEGER, allowNull: true },
      oldTeamID: { type: DataTypes.INTEGER, allowNull: true },
      newTeamID: { type: DataTypes.INTEGER, allowNull: true },
      source: { type: DataTypes.STRING, allowNull: true },
      betweenRounds: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
      t1: { type: DataTypes.INTEGER, allowNull: true },
      t2: { type: DataTypes.INTEGER, allowNull: true }
    },
    { tableName: `T_PE${suffix}`, timestamps: false, exportTier: 'logging' }
  );
  // Alias so s3-switch-reports.js's hardcoded getModel('S3PlayerEvents') lookup
  // resolves in tests too — model name registered above already differs per
  // dialect run to avoid collisions, so mirror it under the plain name DBService
  // callers expect.
  db.models['S3PlayerEvents'] = eventsModel;

  const snapshotsModel = db.defineModel(
    `S3PlayerSnapshots${suffix}`,
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      matchId: { type: DataTypes.STRING, allowNull: false },
      ts: { type: DataTypes.BIGINT, allowNull: false },
      trigger: { type: DataTypes.STRING, allowNull: false },
      playersJson: { type: DataTypes.TEXT, allowNull: false },
      t1: { type: DataTypes.INTEGER, allowNull: true },
      t2: { type: DataTypes.INTEGER, allowNull: true }
    },
    { tableName: `T_PS${suffix}`, timestamps: false, exportTier: 'logging' }
  );
  db.models['S3PlayerSnapshots'] = snapshotsModel;

  const roundReportModel = db.defineModel(
    `TB_RoundReport${suffix}`,
    {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      matchId: { type: DataTypes.STRING(20), allowNull: true },
      roundStartTime: { type: DataTypes.BIGINT, allowNull: true },
      ts: { type: DataTypes.BIGINT, allowNull: false },
      winningTeamID: { type: DataTypes.INTEGER, allowNull: true },
      scrambled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      scrambleType: { type: DataTypes.STRING(100), allowNull: true },
      gameMode: { type: DataTypes.STRING(100), allowNull: true },
      layerName: { type: DataTypes.STRING(150), allowNull: true }
    },
    { tableName: `T_RR${suffix}`, timestamps: false, exportTier: 'historical' }
  );
  db.models['TB_RoundReport'] = roundReportModel;

  await eventsModel.sync({ force: true });
  await snapshotsModel.sync({ force: true });
  await roundReportModel.sync({ force: true });

  try {
    return await fn(db, { eventsModel, snapshotsModel, roundReportModel });
  } finally {
    try { await db.unmount(); } catch { /* best effort */ }
    try { await seq.close(); } catch { /* best effort */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Pure-JS — parseRange / looksLikeRangeToken / isUnambiguous
// ═══════════════════════════════════════════════════════════════════════════

test('parseRange: no arg defaults to ~30 days back', () => {
  const r = parseRange(null);
  assert.ok(!r.error);
  const days = (r.toTs - r.fromTs) / (24 * 60 * 60 * 1000);
  assert.ok(Math.abs(days - 30) < 0.01, `expected ~30 days, got ${days}`);
});

test('parseRange: "7d" resolves to 7 days back', () => {
  const r = parseRange('7d');
  assert.ok(!r.error);
  const days = (r.toTs - r.fromTs) / (24 * 60 * 60 * 1000);
  assert.ok(Math.abs(days - 7) < 0.01, `expected 7 days, got ${days}`);
});

test('parseRange: "2w" resolves to 14 days back', () => {
  const r = parseRange('2w');
  assert.ok(!r.error);
  const days = (r.toTs - r.fromTs) / (24 * 60 * 60 * 1000);
  assert.ok(Math.abs(days - 14) < 0.01, `expected 14 days, got ${days}`);
});

test('parseRange: "400d" caps at 180 days and flags capped', () => {
  const r = parseRange('400d');
  assert.ok(!r.error);
  const days = (r.toTs - r.fromTs) / (24 * 60 * 60 * 1000);
  assert.ok(Math.abs(days - 180) < 0.01, `expected capped 180 days, got ${days}`);
  assert.equal(r.capped, true);
});

test('parseRange: explicit date range resolves exact UTC bounds', () => {
  const r = parseRange('2026-01-01..2026-01-31');
  assert.ok(!r.error);
  assert.equal(new Date(r.fromTs).toISOString().slice(0, 10), '2026-01-01');
  assert.equal(new Date(r.toTs).toISOString().slice(0, 10), '2026-01-31');
});

test('parseRange: reversed date range is an error', () => {
  const r = parseRange('2026-01-31..2026-01-01');
  assert.ok(r.error);
});

test('parseRange: garbage input is an error', () => {
  const r = parseRange('not-a-range');
  assert.ok(r.error);
});

test('looksLikeRangeToken: recognises day/week and date-range shorthand, rejects names', () => {
  assert.equal(looksLikeRangeToken('30d'), true);
  assert.equal(looksLikeRangeToken('2w'), true);
  assert.equal(looksLikeRangeToken('2026-01-01..2026-01-31'), true);
  assert.equal(looksLikeRangeToken('Fiercer'), false);
  assert.equal(looksLikeRangeToken(''), false);
});

test('isUnambiguous: a single tier-0 candidate is unambiguous', () => {
  assert.equal(isUnambiguous([{ _matchTier: 0 }]), true);
});

test('isUnambiguous: two candidates tied at the best tier are ambiguous', () => {
  assert.equal(isUnambiguous([{ _matchTier: 1 }, { _matchTier: 1 }]), false);
});

test('isUnambiguous: best tier is fuzzy (>1) — always ambiguous even alone', () => {
  assert.equal(isUnambiguous([{ _matchTier: 2 }]), false);
});

test('isUnambiguous: empty candidate list is not unambiguous', () => {
  assert.equal(isUnambiguous([]), false);
});

test('isPeriodToken: recognises daily/weekly/monthly, rejects other words', () => {
  assert.equal(isPeriodToken('daily'), true);
  assert.equal(isPeriodToken('WEEKLY'), true);
  assert.equal(isPeriodToken('monthly'), true);
  assert.equal(isPeriodToken('yearly'), false);
  assert.equal(isPeriodToken(''), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. DB-integration — real SQLite + MySQL
// ═══════════════════════════════════════════════════════════════════════════

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

for (const { name } of DIALECTS) {
  test(`[${name}] checkLoggingAvailability: no rows in range -> noEventsLogged`, async () =>
    withDialect(name, async (db) => {
      const r = await checkLoggingAvailability(db, NOW - DAY, NOW);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'noEventsLogged');
      assert.equal(r.hasRoundOutcomeData, true); // TB_RoundReport model is registered, just empty
    }));

  test(`[${name}] checkLoggingAvailability: any event in range -> ok`, async () =>
    withDialect(name, async (db, { eventsModel }) => {
      await eventsModel.create({ ts: NOW - DAY / 2, eventType: 'JOIN', eosID: 'p1', name: 'One' });
      const r = await checkLoggingAvailability(db, NOW - DAY, NOW);
      assert.equal(r.ok, true);
      assert.equal(r.reason, null);
    }));

  test(`[${name}] resolvePlayers: exact eosID match is tier 0`, async () =>
    withDialect(name, async (db, { eventsModel }) => {
      await eventsModel.create({ ts: NOW, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'Fiercer', source: 'Player-Self' });
      const results = await resolvePlayers(db, 'p1');
      assert.equal(results.length, 1);
      assert.equal(results[0]._matchTier, 0);
      assert.equal(results[0].eosID, 'p1');
    }));

  test(`[${name}] resolvePlayers: exact trimmed name match is tier 1`, async () =>
    withDialect(name, async (db, { eventsModel }) => {
      await eventsModel.create({ ts: NOW, eventType: 'TEAM_CHANGE', eosID: 'p2', name: ' Fiercer', source: 'Player-Self' });
      const results = await resolvePlayers(db, 'Fiercer');
      assert.equal(results.length, 1);
      assert.equal(results[0]._matchTier, 1);
      assert.equal(results[0].eosID, 'p2');
    }));

  test(`[${name}] resolvePlayers: ambiguous substring match returns multiple candidates`, async () =>
    withDialect(name, async (db, { eventsModel }) => {
      await eventsModel.create({ ts: NOW, eventType: 'TEAM_CHANGE', eosID: 'p3', name: 'Fierce Wolf', source: 'Player-Self' });
      await eventsModel.create({ ts: NOW, eventType: 'TEAM_CHANGE', eosID: 'p4', name: 'MrFiercer', source: 'Player-Self' });
      const results = await resolvePlayers(db, 'fierce');
      assert.ok(results.length >= 2, `expected >=2 candidates, got ${results.length}`);
      assert.equal(isUnambiguous(results), false);
    }));

  test(`[${name}] resolvePlayers: no match returns empty array`, async () =>
    withDialect(name, async (db) => {
      const results = await resolvePlayers(db, 'NoSuchPlayerXYZ');
      assert.deepEqual(results, []);
    }));

  test(`[${name}] getGamesPlayedMap: counts a round only when the canonical snapshot includes the player`, async () =>
    withDialect(name, async (db, { snapshotsModel, roundReportModel }) => {
      await roundReportModel.create({ matchId: 'm1', ts: NOW - DAY / 2, winningTeamID: 1 });
      await roundReportModel.create({ matchId: 'm2', ts: NOW - DAY / 3, winningTeamID: 2 });

      // m1: player present at LIVE and ENDGAME — ENDGAME should win as canonical.
      await snapshotsModel.create({ matchId: 'm1', ts: NOW - DAY / 2 - 1000, trigger: 'LIVE', playersJson: JSON.stringify([{ eosID: 'p1', name: 'One', teamID: 1 }]) });
      await snapshotsModel.create({ matchId: 'm1', ts: NOW - DAY / 2, trigger: 'ENDGAME', playersJson: JSON.stringify([{ eosID: 'p1', name: 'One', teamID: 1 }]) });

      // m2: player absent from the only (ENDGAME) snapshot — must not count.
      await snapshotsModel.create({ matchId: 'm2', ts: NOW - DAY / 3, trigger: 'ENDGAME', playersJson: JSON.stringify([{ eosID: 'p9', name: 'Other', teamID: 2 }]) });

      const { perPlayer, roundsInRange } = await getGamesPlayedMap(db, NOW - DAY, NOW);
      assert.equal(roundsInRange, 2);
      assert.equal(perPlayer.get('p1')?.matchIds.size, 1);
      assert.ok(!perPlayer.get('p1')?.matchIds.has('m2'));
      assert.equal(perPlayer.get('p9')?.matchIds.size, 1);
    }));

  test(`[${name}] getSwitchesMap / getPlayerSwitches: buckets known sources, unknown source falls to Other`, async () =>
    withDialect(name, async (db, { eventsModel }) => {
      await eventsModel.bulkCreate([
        { ts: NOW, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', newTeamID: 2, source: 'TeamBalancer:Full' },
        { ts: NOW, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', newTeamID: 1, source: 'TeamBalancer:Micro' },
        { ts: NOW, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', newTeamID: 2, source: 'SomeFuturePlugin' },
        { ts: NOW, eventType: 'JOIN', eosID: 'p1', name: 'One' } // not a TEAM_CHANGE — must be excluded
      ]);

      const map = await getSwitchesMap(db, NOW - DAY, NOW);
      const p1 = map.get('p1');
      assert.equal(p1.total, 3);
      assert.equal(p1.bySource['TeamBalancer:Full'], 1);
      assert.equal(p1.bySource['TeamBalancer:Micro'], 1);
      assert.equal(p1.bySource['Other'], 1);

      const single = await getPlayerSwitches(db, 'p1', NOW - DAY, NOW);
      assert.equal(single.total, 3);
      assert.equal(single.bySource['Other'], 1);
    }));

  test(`[${name}] getKarmaReport: excludes Admin-Force and balancer/SmartAssign, computes win rate, leaves unresolved rounds undecided`, async () =>
    withDialect(name, async (db, { eventsModel, roundReportModel }) => {
      await roundReportModel.create({ matchId: 'm1', ts: NOW - DAY / 4, winningTeamID: 2 });
      // m2 deliberately has no TB_RoundReport row — outcome unknown.

      await eventsModel.bulkCreate([
        // Switched to team 2, team 2 won -> a win.
        { ts: NOW - DAY / 4, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', matchId: 'm1', newTeamID: 2, source: 'Player-Self' },
        // Admin-forced — must be excluded entirely from totals.
        { ts: NOW - DAY / 4, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', matchId: 'm1', newTeamID: 1, source: 'Admin-Force' },
        // Balancer-driven — not the player's own choice, must be excluded entirely.
        { ts: NOW - DAY / 4, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', matchId: 'm1', newTeamID: 1, source: 'TeamBalancer:Micro' },
        // SmartAssign — same reasoning, excluded entirely.
        { ts: NOW - DAY / 4, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', matchId: 'm1', newTeamID: 1, source: 'SmartAssign' },
        // Round outcome unknown -> counted in totalSwitches, not in decided/wins.
        { ts: NOW - DAY / 5, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', matchId: 'm2', newTeamID: 1, source: 'Player-Queue' }
      ]);

      const report = await getKarmaReport(db, 'p1', NOW - DAY, NOW);
      assert.equal(report.available, true);
      assert.equal(report.totalSwitches, 2, 'Admin-Force/TeamBalancer/SmartAssign switches must be excluded');
      assert.equal(report.decided, 1);
      assert.equal(report.wins, 1);
      assert.equal(report.winRate, 1);
      assert.equal(report.bySource['Player-Self'].wins, 1);
      assert.equal(report.bySource['Player-Queue'].decided, 0);
      assert.equal(report.bySource['TeamBalancer:Micro'], undefined, 'balancer switches must not appear in bySource at all');
      assert.equal(report.bySource['SmartAssign'], undefined, 'SmartAssign switches must not appear in bySource at all');
    }));

  test(`[${name}] getKarmaReport: zero qualifying switches reports available with null win rate`, async () =>
    withDialect(name, async (db) => {
      const report = await getKarmaReport(db, 'nobody', NOW - DAY, NOW);
      assert.equal(report.available, true);
      assert.equal(report.totalSwitches, 0);
      assert.equal(report.winRate, null);
    }));

  test(`[${name}] getSwitchesByPeriodAndPlayer: buckets switches, rounds, and games-played per player into the right period`, async () =>
    withDialect(name, async (db, { eventsModel, roundReportModel, snapshotsModel }) => {
      // 10-day range split into 'daily' buckets -> bucket index = floor(offset / 1 day).
      const fromTs = NOW - 10 * DAY;
      const toTs = NOW;

      // Day 0 bucket: one round with both players in the roster, one balancer switch (p1), one self switch (p2).
      await roundReportModel.create({ matchId: 'm1', ts: fromTs + DAY / 2, winningTeamID: 1 });
      await snapshotsModel.create({
        matchId: 'm1', ts: fromTs + DAY / 2, trigger: 'ENDGAME',
        playersJson: JSON.stringify([{ eosID: 'p1', name: 'One', teamID: 1 }, { eosID: 'p2', name: 'Two', teamID: 2 }])
      });
      await eventsModel.bulkCreate([
        { ts: fromTs + DAY / 2, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', matchId: 'm1', source: 'TeamBalancer:Full' },
        { ts: fromTs + DAY / 2, eventType: 'TEAM_CHANGE', eosID: 'p2', name: 'Two', matchId: 'm1', source: 'Player-Self' }
      ]);

      // Day 5 bucket: p1 switches with no round on record — games stays 0 for that bucket.
      await eventsModel.create({ ts: fromTs + 5 * DAY + 100, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', source: 'Player-Queue' });

      const result = await getSwitchesByPeriodAndPlayer(db, fromTs, toTs, 'daily');
      assert.equal(result.ok, true);
      assert.equal(result.periods.length, 10);

      const day0 = result.periods[0];
      assert.equal(day0.rounds, 1);
      const p1Day0 = day0.players.find((p) => p.eosID === 'p1');
      const p2Day0 = day0.players.find((p) => p.eosID === 'p2');
      assert.equal(p1Day0.games, 1);
      assert.equal(p1Day0.total, 1);
      assert.equal(p1Day0.bySource['TeamBalancer:Full'], 1);
      assert.equal(p2Day0.games, 1);
      assert.equal(p2Day0.total, 1);
      assert.equal(p2Day0.bySource['Player-Self'], 1);

      const day5 = result.periods[5];
      assert.equal(day5.rounds, 0);
      const p1Day5 = day5.players.find((p) => p.eosID === 'p1');
      assert.equal(p1Day5.games, 0, 'no round on record this bucket -> games stays 0');
      assert.equal(p1Day5.total, 1);
      assert.equal(p1Day5.bySource['Player-Queue'], 1);

      assert.equal(result.periods[9].players.length, 0, 'a silent period has no player rows at all');
    }));

  test(`[${name}] getSwitchesByPeriodAndPlayer: 'weekly' over a 14-day range produces 2 buckets`, async () =>
    withDialect(name, async (db) => {
      const fromTs = NOW - 14 * DAY;
      const result = await getSwitchesByPeriodAndPlayer(db, fromTs, NOW, 'weekly');
      assert.equal(result.ok, true);
      assert.equal(result.periods.length, 2);
    }));

  // ─── Seed/Jensen exclusion (default ignoredGameModes) ────────────────────

  test(`[${name}] getGamesPlayedMap: excludes rounds matching gameMode or layerName against the ignore list`, async () =>
    withDialect(name, async (db, { snapshotsModel, roundReportModel }) => {
      await roundReportModel.create({ matchId: 'r1', ts: NOW - DAY / 2, winningTeamID: 1, gameMode: 'RAAS' });
      await roundReportModel.create({ matchId: 'r2', ts: NOW - DAY / 3, winningTeamID: 2, gameMode: 'Seed' });
      await roundReportModel.create({ matchId: 'r3', ts: NOW - DAY / 4, winningTeamID: 1, gameMode: 'Invasion', layerName: 'Jensens Range AAS' });

      await snapshotsModel.bulkCreate([
        { matchId: 'r1', ts: NOW - DAY / 2, trigger: 'ENDGAME', playersJson: JSON.stringify([{ eosID: 'p1', name: 'One', teamID: 1 }]) },
        { matchId: 'r2', ts: NOW - DAY / 3, trigger: 'ENDGAME', playersJson: JSON.stringify([{ eosID: 'p1', name: 'One', teamID: 1 }]) },
        { matchId: 'r3', ts: NOW - DAY / 4, trigger: 'ENDGAME', playersJson: JSON.stringify([{ eosID: 'p1', name: 'One', teamID: 1 }]) }
      ]);

      const { perPlayer, roundsInRange } = await getGamesPlayedMap(db, NOW - DAY, NOW);
      assert.equal(roundsInRange, 1, 'Seed (by gameMode) and Jensen (by layerName) rounds must both be excluded');
      assert.deepEqual([...perPlayer.get('p1').matchIds], ['r1']);
    }));

  test(`[${name}] getSwitchesMap / getPlayerSwitches: excludes switches made during Seed rounds; empty ignoredGameModes opts out`, async () =>
    withDialect(name, async (db, { eventsModel, roundReportModel }) => {
      await roundReportModel.bulkCreate([
        { matchId: 'r1', ts: NOW, gameMode: 'RAAS' },
        { matchId: 'r2', ts: NOW, gameMode: 'Seed' }
      ]);
      await eventsModel.bulkCreate([
        { ts: NOW, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', matchId: 'r1', source: 'Player-Self' },
        { ts: NOW, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', matchId: 'r2', source: 'Player-Self' }
      ]);

      const map = await getSwitchesMap(db, NOW - DAY, NOW);
      assert.equal(map.get('p1').total, 1, 'the Seed-round switch must be excluded by default');

      const single = await getPlayerSwitches(db, 'p1', NOW - DAY, NOW);
      assert.equal(single.total, 1);

      const unfiltered = await getPlayerSwitches(db, 'p1', NOW - DAY, NOW, []);
      assert.equal(unfiltered.total, 2, 'passing an empty ignoredGameModes array must opt out of exclusion');
    }));

  test(`[${name}] getKarmaReport: switches made during Seed rounds do not count toward totals or wins`, async () =>
    withDialect(name, async (db, { eventsModel, roundReportModel }) => {
      await roundReportModel.bulkCreate([
        { matchId: 'r1', ts: NOW, winningTeamID: 1, gameMode: 'RAAS' },
        { matchId: 'r2', ts: NOW, winningTeamID: 1, gameMode: 'Seed' }
      ]);
      await eventsModel.bulkCreate([
        { ts: NOW, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', matchId: 'r1', newTeamID: 1, source: 'Player-Self' },
        { ts: NOW, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', matchId: 'r2', newTeamID: 1, source: 'Player-Self' }
      ]);

      const report = await getKarmaReport(db, 'p1', NOW - DAY, NOW);
      assert.equal(report.totalSwitches, 1, 'the Seed-round switch must not count toward karma at all');
      assert.equal(report.wins, 1);
    }));

  test(`[${name}] getSwitchesByPeriodAndPlayer: excludes Seed rounds and their switches from per-player bucket counts`, async () =>
    withDialect(name, async (db, { eventsModel, roundReportModel, snapshotsModel }) => {
      const fromTs = NOW - 3 * DAY;
      const toTs = NOW;

      await roundReportModel.bulkCreate([
        { matchId: 'r1', ts: fromTs + DAY / 2, gameMode: 'RAAS' },
        { matchId: 'r2', ts: fromTs + DAY / 2, gameMode: 'Seed' }
      ]);
      await snapshotsModel.bulkCreate([
        { matchId: 'r1', ts: fromTs + DAY / 2, trigger: 'ENDGAME', playersJson: JSON.stringify([{ eosID: 'p1', name: 'One', teamID: 1 }]) },
        { matchId: 'r2', ts: fromTs + DAY / 2, trigger: 'ENDGAME', playersJson: JSON.stringify([{ eosID: 'p2', name: 'Two', teamID: 1 }]) }
      ]);
      await eventsModel.bulkCreate([
        { ts: fromTs + DAY / 2, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'One', matchId: 'r1', source: 'Player-Self' },
        { ts: fromTs + DAY / 2, eventType: 'TEAM_CHANGE', eosID: 'p2', name: 'Two', matchId: 'r2', source: 'Player-Self' }
      ]);

      const result = await getSwitchesByPeriodAndPlayer(db, fromTs, toTs, 'daily');
      const day0 = result.periods[0];
      assert.equal(day0.rounds, 1, 'the Seed round must not count in rounds');
      assert.equal(day0.players.length, 1, 'p2 only appears via the Seed round/switch and must be excluded entirely, not shown at zero');
      assert.equal(day0.players[0].eosID, 'p1');
      assert.equal(day0.players[0].games, 1);
      assert.equal(day0.players[0].total, 1);
    }));
}

await run();
