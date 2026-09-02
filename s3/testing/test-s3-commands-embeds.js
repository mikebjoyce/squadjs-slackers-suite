/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   S3-COMMANDS EMBED BUILDERS — buildSwitchesEmbed / buildKarmaEmbed ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * test-s3-switch-reports.js proves checkLoggingAvailability()'s
 * roundOutcomeDataLogged field is correct at the data layer (TeamBalancer's
 * own enableDatabaseLogging toggle being off vs. on, independently of S³'s).
 * Nothing exercised the two Discord-facing consumers of that field in
 * s3-commands.js — buildKarmaEmbed()'s hard-block warning and
 * buildSwitchesEmbed()'s formatRoundDataNote() header note — so those
 * branches had zero coverage beyond `node --check`. This file closes that
 * gap the same way test-s3-commands.js covers the rest of s3-commands.js:
 * a real mounted DBService (SQLite, in-memory) plus a minimal plugin stub.
 *
 * Category: 1 (SQLite only — the embed-builder layer is a thin formatting
 * pass over logic test-s3-switch-reports.js already proves on both dialects).
 */

'use strict';

import assert from 'node:assert/strict';
import { localize as lookupMessage } from '../utils/s3-i18n.js';
import { Sequelize, DataTypes } from 'sequelize';

import DBService from '../utils/db-service.js';
import { buildSwitchesEmbed, buildKarmaEmbed, guildAttachmentLimit } from '../utils/s3-commands.js';

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(72));
  console.log('S3-Commands Embed Builder Tests');
  console.log('='.repeat(72));
  console.log('');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${String(err.message).split('\n')[0]}`);
      failed++;
    }
  }

  console.log('');
  console.log('─'.repeat(72));
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log('─'.repeat(72));

  if (failed > 0) process.exitCode = 1;
}

/**
 * Mounts a fresh in-memory SQLite DBService with the S3PlayerEvents and
 * TB_RoundReport schemas mirrored from production (logging-service.js /
 * team-balancer.js), matching the fixture test-s3-switch-reports.js uses.
 */
async function fixture(fn) {
  const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const db = new DBService({ sequelize: seq });
  await db.mount();

  const eventsModel = db.defineModel(
    'S3PlayerEvents',
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
    { tableName: 'T_PE', timestamps: false, exportTier: 'logging' }
  );

  const roundReportModel = db.defineModel(
    'TB_RoundReport',
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
    { tableName: 'T_RR', timestamps: false, exportTier: 'historical' }
  );

  await eventsModel.sync({ force: true });
  await roundReportModel.sync({ force: true });

  try {
    return await fn(db, { eventsModel, roundReportModel });
  } finally {
    try { await db.unmount(); } catch { /* best effort */ }
    try { await seq.close(); } catch { /* best effort */ }
  }
}

function plugin(db) {
  return {
    services: { db },
    options: { ignoredGameModes: [] },
    localize: (key, vars) => lookupMessage(key, vars)
  };
}

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// buildKarmaEmbed — TeamBalancer installed but its own logging is off
// ═══════════════════════════════════════════════════════════════════════════

test('buildKarmaEmbed: TB_RoundReport registered but empty -> gap warning, not a fabricated karma verdict', () =>
  fixture(async (db, { eventsModel }) => {
    await eventsModel.create({
      ts: NOW - DAY / 2, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'Alice', source: 'Player-Self'
    });

    const embed = await buildKarmaEmbed(plugin(db), 'Alice', null);
    assert.equal(embed.title, '🟠 No Round Outcome Data Logged In This Range');
    assert.equal(embed.color, 0xf39c12);
    assert.match(embed.description, /enableDatabaseLogging/);
  }));

test('buildKarmaEmbed: TB_RoundReport has rows -> proceeds to a real karma verdict, no gap warning', () =>
  fixture(async (db, { eventsModel, roundReportModel }) => {
    await eventsModel.create({
      matchId: 'm1', ts: NOW - DAY / 2, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'Alice',
      source: 'Player-Self', oldTeamID: 1, newTeamID: 2
    });
    await roundReportModel.create({ matchId: 'm1', ts: NOW - DAY / 2, winningTeamID: 2 });

    const embed = await buildKarmaEmbed(plugin(db), 'Alice', null);
    assert.notEqual(embed.title, '🟠 No Round Outcome Data Logged In This Range');
    assert.match(embed.title, /Karma — Alice/);
  }));

// ═══════════════════════════════════════════════════════════════════════════
// buildSwitchesEmbed — leaderboard and single-player views inherit the same
// gap warning as a soft note (games-played counts, not a hard block)
// ═══════════════════════════════════════════════════════════════════════════

test('buildSwitchesEmbed leaderboard: TB_RoundReport empty -> formatRoundDataNote warning present', () =>
  fixture(async (db, { eventsModel }) => {
    await eventsModel.create({
      ts: NOW - DAY / 2, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'Alice', source: 'Player-Self'
    });

    const [embed] = await buildSwitchesEmbed(plugin(db), null, null);
    assert.match(embed.description, /No TeamBalancer round data logged in this range/);
    assert.match(embed.description, /enableDatabaseLogging/);
  }));

test('buildSwitchesEmbed leaderboard: TB_RoundReport has rows -> no gap warning', () =>
  fixture(async (db, { eventsModel, roundReportModel }) => {
    await eventsModel.create({
      matchId: 'm1', ts: NOW - DAY / 2, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'Alice', source: 'Player-Self'
    });
    await roundReportModel.create({ matchId: 'm1', ts: NOW - DAY / 2, winningTeamID: 1 });

    const [embed] = await buildSwitchesEmbed(plugin(db), null, null);
    assert.ok(!/No TeamBalancer round data logged in this range/.test(embed.description));
  }));

test('buildSwitchesEmbed single-player: TB_RoundReport empty -> formatRoundDataNote warning present', () =>
  fixture(async (db, { eventsModel }) => {
    await eventsModel.create({
      ts: NOW - DAY / 2, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'Alice', source: 'Player-Self'
    });

    const [embed] = await buildSwitchesEmbed(plugin(db), 'Alice', null);
    assert.match(embed.description, /No TeamBalancer round data logged in this range/);
  }));

// A live `!s3 db export --all` reported "❌ Export Failed — Request entity too
// large" on a 200MB export that had in fact succeeded: the attachment ceiling
// was hardcoded to the boosted 25MB, so an unboosted guild's 10MB limit was
// exceeded and Discord's 413 was surfaced as a failed export. An unknown guild
// must resolve to the smallest limit, never the largest.
test('guildAttachmentLimit never over-estimates an unboosted or unknown guild', () => {
  const MiB = 1024 * 1024;
  assert.equal(guildAttachmentLimit({ premiumTier: 0 }), 10 * MiB);
  assert.equal(guildAttachmentLimit({ premiumTier: 1 }), 10 * MiB);
  assert.equal(guildAttachmentLimit({ premiumTier: 2 }), 50 * MiB);
  assert.equal(guildAttachmentLimit({ premiumTier: 3 }), 100 * MiB);
  assert.equal(guildAttachmentLimit(undefined), 10 * MiB, 'a DM or uncached guild must fall back to the floor');
  assert.equal(guildAttachmentLimit({}), 10 * MiB, 'a guild with no tier must fall back to the floor');
});

await run();
