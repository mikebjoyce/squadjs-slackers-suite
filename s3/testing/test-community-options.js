/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   COMMUNITY-AFFECTING OPTIONS — ONE LIST, THREE LEVERS        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Every process in a community runs the same suite version; nothing makes them
 * run the same configuration. Once a table is shared, several ordinary plugin
 * options stop being local policy — `maxSwitchTokens` used to describe one
 * server's token bucket and now describes a bucket every server writes to.
 *
 * The failure this exists to prevent is not corruption. Two differently
 * configured processes disagree, repeatedly and silently, and the sharpest form
 * of it reaches players rather than admins: a lower-capped server resets the
 * regen anchor the higher-capped one was accruing against, so a player who plays
 * both stops regenerating tokens at all, with no admin command involved and
 * nothing in any log.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   resolution        Lowest registered value wins, deterministically, and the
 *                     cooldown pair resolves as a pair rather than key by key —
 *                     per-key minimums invent an interval nobody configured.
 *   abstention        A server that recorded nothing, or recorded half a group,
 *                     contributes no candidate. Defaulting the missing half
 *                     would hand the community a value no admin chose.
 *   the three levers  A must-agree divergence refuses the write; a may-differ
 *                     one is reported and never enforced; a resolved one is
 *                     neither, because there is a correct answer available.
 *   recording         Post-validation, merged across plugins, and self-cleaning
 *                     when a plugin is uninstalled.
 *   the warning       An operator whose configured value has been resolved away
 *                     is told, or they edit a config that no longer does
 *                     anything.
 *
 * Category: 1 (no external services)
 * Run:    node s3/testing/test-community-options.js
 */

'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Sequelize } from 'sequelize';

import DBService, { SERVER_FRESHNESS_MS } from '../utils/db-service.js';
import {
  OPTION_KIND,
  COMMUNITY_OPTION_GROUPS,
  communityOptionKeys,
  parseCommunityOptions,
  summariseCommunityOptions,
  enforcedDisagreement,
  describeDisagreement
} from '../utils/community-options.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from './plugin-assembly.js';

// The refusal and resolution helpers live on S3PluginBase, which imports
// SquadJS's BasePlugin as a flat sibling — only resolvable in the layout
// install.cjs produces.
const ASSEMBLY = buildAssembly('.tmp-community-options');
const S3PluginBase = await importFromAssembly(ASSEMBLY, 's3-plugin-base.js');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const tests = [];
const tempDirs = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(70));
  console.log('Community-Affecting Options  (resolve, refuse, report)');
  console.log('='.repeat(70));
  console.log('');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${String(err.message).split('\n').join('\n      ')}`);
      failed++;
    }
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log('─'.repeat(70));

  cleanAssembly(ASSEMBLY);
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (failed > 0) process.exitCode = 1;
}

/** A registry row as the summariser sees it. */
function row(serverID, alias, values) {
  return { serverID, alias, communityOptions: values === null ? null : JSON.stringify(values) };
}

/** A file-backed SQLite database, so two DBServices can see the same rows. */
function sharedStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-comm-opts-'));
  tempDirs.push(dir);
  return path.join(dir, 'registry.sqlite');
}

/** One process's view of the shared database, with its level-1 log captured. */
async function processFor(storage, serverID) {
  const logged = [];
  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  const db = new DBService({
    sequelize,
    serverID,
    verboseLogger: (level, msg) => { if (level <= 1) logged.push(msg); },
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();
  await db.registerServer({
    server: { options: { host: '10.0.0.1', queryPort: 27165, rconPort: 21100 + serverID }, serverName: null }
  });
  return { db, sequelize, logged };
}

/**
 * A plugin holding only what the two option helpers touch. The helpers are
 * S3PluginBase's own — the point of the case is what the base class does with a
 * DBService, not what a subclass does with the base class.
 */
function pluginOn(db) {
  const plugin = Object.create(S3PluginBase.prototype);
  plugin._s3db = db;
  return plugin;
}

// ---------------------------------------------------------------------------
// The list itself
// ---------------------------------------------------------------------------

test('every group declares a kind the enforcement knows how to apply', () => {
  const kinds = new Set(Object.values(OPTION_KIND));
  for (const group of COMMUNITY_OPTION_GROUPS) {
    assert.ok(kinds.has(group.kind), `${group.name} has an unknown kind: ${group.kind}`);
    assert.ok(group.keys.length > 0, `${group.name} declares no keys`);
    if (group.kind === OPTION_KIND.RESOLVED) {
      assert.equal(
        typeof group.rank, 'function',
        `${group.name} is resolved to one value, so it has to say how two candidates compare`
      );
    }
  }

  const keys = communityOptionKeys();
  assert.equal(new Set(keys).size, keys.length, 'a key in two groups would be resolved and refused at once');
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test('a community of one resolves to its own values and reports nothing', () => {
  const { resolved, disagreements } = summariseCommunityOptions([
    row(1, 'main', { maxSwitchTokens: 5, switchCooldownMinutes: 0, switchCooldownHours: 2 })
  ]);

  assert.equal(resolved.maxSwitchTokens.values.maxSwitchTokens, 5);
  assert.equal(resolved.maxSwitchTokens.contested, false);
  assert.deepEqual(disagreements, [], 'a single server cannot disagree with anyone');
});

test('the lowest registered cap wins, and the divergence is reported', () => {
  const { resolved, disagreements } = summariseCommunityOptions([
    row(1, 'main', { maxSwitchTokens: 5 }),
    row(2, 'event', { maxSwitchTokens: 3 })
  ]);

  assert.equal(
    resolved.maxSwitchTokens.values.maxSwitchTokens, 3,
    'lowest, not first and not this process — it errs toward the stricter server and does not depend on row order'
  );
  assert.equal(resolved.maxSwitchTokens.alias, 'event', 'the winner is named so the warning can say where the value came from');
  assert.equal(disagreements.length, 1);
  assert.equal(disagreements[0].kind, OPTION_KIND.RESOLVED);
});

test('the cooldown pair resolves as a pair, not key by key', () => {
  // main is 105 minutes (0/1.75), event is 30 (30/1). Taking the lowest of each
  // key independently gives minutes 0 / hours 1 — sixty minutes, which is
  // neither server's setting and not the stricter one either.
  const { resolved } = summariseCommunityOptions([
    row(1, 'main', { switchCooldownMinutes: 0, switchCooldownHours: 1.75 }),
    row(2, 'event', { switchCooldownMinutes: 30, switchCooldownHours: 1 })
  ]);

  assert.equal(resolved.switchCooldown.values.switchCooldownMinutes, 30);
  assert.equal(
    resolved.switchCooldown.values.switchCooldownHours, 1,
    'the winner\'s values come across whole, or the resolved pair is one no admin ever configured'
  );
});

test('a tie resolves the same way whatever order the rows arrive in', () => {
  const forwards = summariseCommunityOptions([
    row(1, 'main', { maxSwitchTokens: 3 }),
    row(2, 'event', { maxSwitchTokens: 3 })
  ]);
  const backwards = summariseCommunityOptions([
    row(2, 'event', { maxSwitchTokens: 3 }),
    row(1, 'main', { maxSwitchTokens: 3 })
  ]);

  assert.equal(forwards.resolved.maxSwitchTokens.serverID, 1);
  assert.equal(
    backwards.resolved.maxSwitchTokens.serverID, 1,
    'two servers reading a different answer to the same question is the whole failure this prevents'
  );
});

// ---------------------------------------------------------------------------
// Abstention
// ---------------------------------------------------------------------------

test('a server that has recorded nothing does not drag the community to a default', () => {
  const { resolved, disagreements } = summariseCommunityOptions([
    row(1, 'main', { maxSwitchTokens: 5 }),
    row(2, 'event', null)
  ]);

  assert.equal(
    resolved.maxSwitchTokens.values.maxSwitchTokens, 5,
    'a server not running Switch has no opinion about the cap, and treating silence as 0 would cap the community at nothing'
  );
  assert.equal(resolved.maxSwitchTokens.candidates, 1);
  assert.deepEqual(disagreements, []);
});

test('half a group is no candidate at all', () => {
  const { resolved } = summariseCommunityOptions([
    row(1, 'main', { switchCooldownMinutes: 0, switchCooldownHours: 2 }),
    row(2, 'event', { switchCooldownMinutes: 15 })
  ]);

  assert.equal(
    resolved.switchCooldown.candidates, 1,
    'the half-recorded row would rank against an hours value it never declared, and win on it'
  );
  assert.equal(resolved.switchCooldown.values.switchCooldownHours, 2);
});

test('a malformed blob is data, not a crash', () => {
  assert.equal(parseCommunityOptions('{not json'), null);
  assert.equal(parseCommunityOptions('[1,2,3]'), null, 'an array is not an option map');
  assert.equal(parseCommunityOptions(''), null);

  const { resolved } = summariseCommunityOptions([
    { serverID: 1, alias: 'main', communityOptions: '{not json' },
    row(2, 'event', { maxSwitchTokens: 4 })
  ]);
  assert.equal(resolved.maxSwitchTokens.values.maxSwitchTokens, 4);
});

// ---------------------------------------------------------------------------
// The three levers
// ---------------------------------------------------------------------------

test('a must-agree divergence is enforced and a may-differ one is not', () => {
  const summary = summariseCommunityOptions([
    row(1, 'main', { pruneInactivePlayerDays: 3, minPlayersForElo: 80 }),
    row(2, 'event', { pruneInactivePlayerDays: 7, minPlayersForElo: 40 })
  ]);

  assert.equal(summary.disagreements.length, 2, 'both are reported — the point of may-differ is an argument had on purpose');
  assert.ok(enforcedDisagreement(summary, 'pruneInactivePlayerDays'), 'a deletion predicate against a shared table');
  assert.equal(
    enforcedDisagreement(summary, 'minPlayersForElo'), null,
    'a 40-player server and a 100-player server have honest reason to differ, and each applies its own before anything shared is written'
  );
});

test('a resolved option never becomes a refusal', () => {
  const summary = summariseCommunityOptions([
    row(1, 'main', { maxSwitchTokens: 5 }),
    row(2, 'event', { maxSwitchTokens: 3 })
  ]);

  assert.equal(summary.disagreements.length, 1);
  assert.equal(
    enforcedDisagreement(summary, 'maxSwitchTokens'), null,
    'you cannot decline a player’s switch because two admins disagree about a cap; resolution is the lever here'
  );
});

test('a disagreement names every server and both halves of a pair', () => {
  const summary = summariseCommunityOptions([
    row(1, 'main', { switchCooldownMinutes: 0, switchCooldownHours: 1.75 }),
    row(2, 'event', { switchCooldownMinutes: 30, switchCooldownHours: 1 }),
    row(3, null, { switchCooldownMinutes: 45, switchCooldownHours: 1 })
  ]);
  const text = describeDisagreement(summary.disagreements[0]);

  assert.match(text, /main/);
  assert.match(text, /event/);
  assert.match(text, /server 3/, 'an unnamed server still has to be identifiable, or the operator cannot find it');
  assert.match(text, /switchCooldownMinutes=0/);
  assert.match(text, /switchCooldownHours=1\.75/);
});

test('a one-key group does not repeat its own name once per server', () => {
  const summary = summariseCommunityOptions([
    row(1, 'main', { pruneInactivePlayerDays: 3 }),
    row(2, 'event', { pruneInactivePlayerDays: 7 })
  ]);

  assert.equal(describeDisagreement(summary.disagreements[0]), 'pruneInactivePlayerDays: main=3, event=7');
});

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

test('two plugins recording in one boot do not lose each other’s keys', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    await db.recordCommunityOptions('switch', { maxSwitchTokens: 4, pruneInactivePlayerDays: 3 });
    await db.recordCommunityOptions('elo-tracker', { minRoundsForLeaderboard: 10 });

    const [stored] = await db.getRegisteredServers();
    assert.deepEqual(
      parseCommunityOptions(stored.communityOptions),
      { maxSwitchTokens: 4, pruneInactivePlayerDays: 3, minRoundsForLeaderboard: 10 },
      'the second plugin merges into the first rather than replacing it'
    );
  } finally {
    await sequelize.close();
  }
});

test('a plugin uninstalled since the last boot drops out of the blob', async () => {
  const storage = sharedStorage();
  const first = await processFor(storage, 1);
  try {
    await first.db.recordCommunityOptions('switch', { maxSwitchTokens: 4 });
    await first.db.recordCommunityOptions('elo-tracker', { minRoundsForLeaderboard: 10 });
  } finally {
    await first.sequelize.close();
  }

  const second = await processFor(storage, 1);
  try {
    // Elo is gone from config.json this time round; only Switch records.
    await second.db.recordCommunityOptions('switch', { maxSwitchTokens: 4 });

    const [stored] = await second.db.getRegisteredServers();
    assert.deepEqual(
      parseCommunityOptions(stored.communityOptions), { maxSwitchTokens: 4 },
      'a read-modify-write against the stored blob would keep constraining the community with an option nobody runs any more'
    );
  } finally {
    await second.sequelize.close();
  }
});

test('the summary spans registered rows, stale ones included', async () => {
  const storage = sharedStorage();
  const retired = await processFor(storage, 2);
  const mine = await processFor(storage, 1);
  try {
    await retired.db.recordCommunityOptions('switch', { maxSwitchTokens: 2 });
    await mine.db.recordCommunityOptions('switch', { maxSwitchTokens: 5 });

    const now = await mine.db.dbNow();
    await mine.db.ServersModel.update(
      { lastSeenAt: now - SERVER_FRESHNESS_MS - 1000 },
      { where: { serverID: 2 } }
    );

    const { resolved } = await mine.db.getCommunityOptionSummary();
    assert.equal(
      resolved.maxSwitchTokens.values.maxSwitchTokens, 2,
      'this is the opposite of the version check on purpose — a stopped server still states the community’s policy, and resolving over live rows would make the cap flap every time a neighbour restarted'
    );
  } finally {
    await retired.sequelize.close();
    await mine.sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// The warning
// ---------------------------------------------------------------------------

test('an operator whose configured cap is resolved away is told, and told which value is in force', async () => {
  const storage = sharedStorage();
  const stricter = await processFor(storage, 2);
  const mine = await processFor(storage, 1);
  try {
    await stricter.db.setServerAlias(2, 'event');
    await stricter.db.recordCommunityOptions('switch', { maxSwitchTokens: 3 });

    await mine.db.recordCommunityOptions('switch', { maxSwitchTokens: 5 });

    const override = mine.logged.filter((line) => /resolves to/.test(line));
    assert.equal(override.length, 1, 'exactly one line, at level 1, on the mount of the plugin that owns the option');
    assert.match(override[0], /maxSwitchTokens=5/, 'the value the operator typed');
    assert.match(override[0], /maxSwitchTokens=3/, 'and the value actually in force');
    assert.match(override[0], /event/, 'and where it came from, or they cannot go and change it');
  } finally {
    await stricter.sequelize.close();
    await mine.sequelize.close();
  }
});

test('agreement is silent', async () => {
  const storage = sharedStorage();
  const other = await processFor(storage, 2);
  const mine = await processFor(storage, 1);
  try {
    await other.db.recordCommunityOptions('switch', { maxSwitchTokens: 5 });
    await mine.db.recordCommunityOptions('switch', { maxSwitchTokens: 5 });

    assert.equal(
      mine.logged.filter((line) => /resolves to|divergence/i.test(line)).length, 0,
      'the ordinary case is two servers configured alike, and a warning on it is a warning nobody reads'
    );
  } finally {
    await other.sequelize.close();
    await mine.sequelize.close();
  }
});

test('a must-agree divergence is announced at mount as well as refused at the write', async () => {
  const storage = sharedStorage();
  const other = await processFor(storage, 2);
  const mine = await processFor(storage, 1);
  try {
    await other.db.recordCommunityOptions('switch', { pruneInactivePlayerDays: 7 });
    await mine.db.recordCommunityOptions('switch', { pruneInactivePlayerDays: 3 });

    const warned = mine.logged.filter((line) => /Configuration divergence/.test(line));
    assert.equal(warned.length, 1);
    assert.match(warned[0], /pruneInactivePlayerDays: /);
    assert.match(warned[0], /decline until these agree/, 'the warning has to say what the consequence is, or it reads as noise');
  } finally {
    await other.sequelize.close();
    await mine.sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// The plugin-facing gates
// ---------------------------------------------------------------------------

test('communityOptionRefusal names the option and both values', async () => {
  const storage = sharedStorage();
  const other = await processFor(storage, 2);
  const mine = await processFor(storage, 1);
  try {
    await other.db.setServerAlias(2, 'event');
    await other.db.recordCommunityOptions('elo-tracker', { minRoundsForLeaderboard: 25 });
    await mine.db.recordCommunityOptions('elo-tracker', { minRoundsForLeaderboard: 10 });

    const reason = pluginOn(mine.db).communityOptionRefusal('minRoundsForLeaderboard');
    assert.ok(reason, 'a deletion predicate against the shared rating table, running at every mount');
    assert.match(reason, /minRoundsForLeaderboard: /);
    assert.match(reason, /event=25/);
  } finally {
    await other.sequelize.close();
    await mine.sequelize.close();
  }
});

test('communityOptionRefusal stays null for a may-differ option', async () => {
  const storage = sharedStorage();
  const other = await processFor(storage, 2);
  const mine = await processFor(storage, 1);
  try {
    await other.db.recordCommunityOptions('elo-tracker', { minParticipationRatio: 0.3 });
    await mine.db.recordCommunityOptions('elo-tracker', { minParticipationRatio: 0.15 });

    assert.equal(
      pluginOn(mine.db).communityOptionRefusal('minParticipationRatio'), null,
      'naming the wrong group must not be able to start enforcing agreement on something two admins may differ on'
    );
  } finally {
    await other.sequelize.close();
    await mine.sequelize.close();
  }
});

test('resolvedCommunityOption falls back to the caller’s own option when nothing is in force', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    const plugin = pluginOn(db);
    assert.equal(
      plugin.resolvedCommunityOption('maxSwitchTokens', 'maxSwitchTokens', 7), 7,
      'no resolution means no community value, not zero — a community of one, or a boot before the registry has been read'
    );

    await db.recordCommunityOptions('switch', { maxSwitchTokens: 2 });
    assert.equal(plugin.resolvedCommunityOption('maxSwitchTokens', 'maxSwitchTokens', 7), 2);
  } finally {
    await sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await run();
