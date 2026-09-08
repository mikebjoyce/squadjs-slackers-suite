/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      SERVER REGISTRY — WHO ELSE IS WRITING TO THIS DATABASE   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Every stock SquadJS config ships `"id": 1`. Two operators who never touched
 * that field do not get an error when they point both installs at one database
 * — they get rounds, ratings and cooldowns interleaved, and find out weeks
 * later. `S3_Servers` is what turns that into something a process can notice at
 * mount, and this file is what pins the noticing.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   the happy paths     A first boot creates the row; a second boot of the same
 *                       server refreshes it and changes nothing else.
 *   the stale case      A different fingerprint over a row nobody has stamped
 *                       for a while is a moved server or a changed port. It
 *                       updates and does not block — refusing here would take a
 *                       live game offline for a config edit.
 *   the fresh case      A different fingerprint over a row stamped seconds ago
 *                       is a second live process. Nothing is written, and the
 *                       verdict carries what an operator needs to act.
 *   the override        forceServerClaim turns a fresh collision back into a
 *                       reclaim, for the port change that happened to land
 *                       inside the freshness window.
 *   the first-boot race Two processes starting together must not both conclude
 *                       they own the id. The primary key decides; the loser
 *                       reads back and compares.
 *   absence vs. change  A null on either side of the fingerprint is unknown,
 *                       not different. Reading it as different would refuse a
 *                       mount over a field nobody set.
 *   the heartbeat       Stamps the row, and stays quiet when it cannot.
 *   the plugin gate     A blocked identity stops the plugins that write
 *                       server-scoped rows, and only those.
 *   aliases             Distinctness rather than uniqueness — two names a
 *                       keystroke apart are what a unique index cannot see —
 *                       and the exemption that lets a row be renamed at all.
 *                       Two shapes are refused outright rather than made
 *                       distinct: one starting with a separator, which
 *                       `--server` reads as a flag, and a bare number,
 *                       which shadows a server id.
 *   labels              The short name a row renders as, worked out by
 *                       comparing the registered names rather than by
 *                       assuming a format — communities pad their names
 *                       differently, and a rule fitted to one of them
 *                       returns the same label for every server of another.
 *                       Lives beside the alias rules because the two decide
 *                       the same question, which server is this, and answer
 *                       it differently: an alias is typed and must be
 *                       distinct, a label is read and may be missing.
 *   label delivery      The label reaching the footer of an embed, at all
 *                       four senders and in the flattened layout the suite
 *                       actually ships in — which is the only layout where
 *                       one module object is shared by every plugin, and
 *                       that sharing is what the delivery rests on.
 *   confirmations       The two-step commands: what an arm says, what a
 *                       token finds, and who answers when no process holds
 *                       one. Every case pairs a multi-server assertion with
 *                       the single-server one that must not have moved.
 *   shared channels     Which OTHER registered servers point one named
 *                       purpose at one Discord channel. The question behind
 *                       every guard that refuses a command whose output
 *                       would be unattributable in a channel two servers
 *                       write into, and the reserved sub-object it rides in
 *                       staying invisible to the option comparison beside it.
 *   resolution          A --server token lands on exactly one row or on none.
 *                       Never on the first of several.
 *   registered vs live  Two different questions with two different answers,
 *                       and the deregistration that keeps them honest.
 *   noticing a change   A process that read the count once at mount stays in
 *                       single-server mode for as long as it runs. The
 *                       heartbeat re-reads it, and the transition is logged.
 *   version lockstep    A live server on another version refuses this mount.
 *                       Stale rows and null versions do not — the first is a
 *                       stopped server, the second an absence of evidence.
 *   identifier case     A boot that meets its own two tables stored under
 *                       folded names, which is every boot but the first on
 *                       production MySQL.
 *
 * Category: 1 (no external services)
 * Run:    node s3/testing/test-server-registry.js
 */

'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Sequelize } from 'sequelize';

import DBService, { SERVER_FRESHNESS_MS, ALIAS_MAX_LENGTH } from '../utils/db-service.js';
import {
  serverLabels,
  serverDisplayName,
  publishServerLabel,
  readServerLabel,
  applyServerLabel
} from '../utils/s3-server-label.js';
import { PendingActions, PENDING } from '../utils/s3-pending-actions.js';
import { readLiveContext, renderLiveContext, CONTEXT } from '../utils/s3-live-context.js';
import { scopeForEloCommand } from '../../elo-tracker/utils/elo-discord.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from './plugin-assembly.js';

// s3-plugin-base.js imports SquadJS's BasePlugin as a flat sibling, which only
// resolves in the layout install.cjs produces.
const ASSEMBLY = buildAssembly('.tmp-server-registry');
const S3PluginBase = await importFromAssembly(ASSEMBLY, 's3-plugin-base.js');
// S³ itself, for the cases that are about the order its mount does things in
// rather than about what DBService returns.
const SlackersSquadServices = await importFromAssembly(ASSEMBLY, 'slackers-squad-services.js');

// The delivery cases run against the assembly rather than this source tree,
// because the thing being tested is that all four senders read the same
// module object — which they only do once install.cjs has flattened every
// plugin's utils into one directory. Loaded here, at the top, so that a
// broken import fails the file rather than one case inside it.
const S3DiscordPluginBase = await importFromAssembly(ASSEMBLY, 's3-discord-plugin-base.js');
const EloTracker = await importFromAssembly(ASSEMBLY, 'elo-tracker.js');
const TeamBalancer = await importFromAssembly(ASSEMBLY, 'team-balancer.js');
const { scopeForTeamBalancerCommand } = await import(
  pathToFileURL(path.join(ASSEMBLY, 'plugins', 'team-balancer.js')).href
);
const shippedLabel = await import(
  pathToFileURL(path.join(ASSEMBLY, 'utils', 's3-server-label.js')).href
);
const shipped = async (fileName) => import(
  pathToFileURL(path.join(ASSEMBLY, 'utils', fileName)).href
);

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
  console.log('Server Registry  (claim, collision, heartbeat)');
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

  if (failed > 0) process.exitCode = 1;
}

/**
 * A file-backed SQLite database, because half of these cases need two
 * DBServices looking at the same rows and `:memory:` gives each connection its
 * own database.
 */
function sharedStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-registry-'));
  tempDirs.push(dir);
  return path.join(dir, 'registry.sqlite');
}

/** One process's view of the shared database, mounted and ready to claim. */
async function processFor(storage, serverID) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  const db = new DBService({
    sequelize,
    serverID,
    verboseLogger: () => {},
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();
  return { db, sequelize };
}

/** A SquadJS server carrying only the three fields the fingerprint reads. */
function fakeServer({ host = '10.0.0.1', queryPort = 27165, rconPort = 21114, serverName = null } = {}) {
  return { options: { host, queryPort, rconPort }, serverName };
}

/** Age a row's heartbeat past the freshness window without waiting for it. */
async function makeStale(db, serverID) {
  const now = await db.dbNow();
  await db.ServersModel.update(
    { lastSeenAt: now - SERVER_FRESHNESS_MS - 1000 },
    { where: { serverID } }
  );
}

// ---------------------------------------------------------------------------
// The happy paths
// ---------------------------------------------------------------------------

test('a first boot creates the row and stamps both timestamps', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 3);
  try {
    const verdict = await db.registerServer({
      server: fakeServer({ serverName: '[NL] Slackers #1' }),
      suiteVersion: '1.7.0'
    });

    assert.equal(verdict.status, 'created');
    assert.equal(verdict.serverID, 3);

    const [row] = await db.getRegisteredServers();
    assert.equal(row.serverID, 3);
    assert.equal(row.host, '10.0.0.1');
    assert.equal(row.queryPort, 27165);
    assert.equal(row.rconPort, 21114);
    assert.equal(row.serverName, '[NL] Slackers #1');
    assert.equal(row.suiteVersion, '1.7.0');
    assert.ok(row.firstSeenAt > 0 && row.lastSeenAt > 0, 'both timestamps must be set on the first write');
    assert.equal(
      row.alias, null,
      'alias is operator-facing and unique; minting one here would let a naming clash abort the registration'
    );
  } finally {
    await sequelize.close();
  }
});

test('the same server re-registering is a refresh, and firstSeenAt survives it', async () => {
  const storage = sharedStorage();
  const first = await processFor(storage, 1);
  let firstSeenAt;
  try {
    await first.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    [{ firstSeenAt }] = await first.db.getRegisteredServers();
  } finally {
    await first.sequelize.close();
  }

  const second = await processFor(storage, 1);
  try {
    const verdict = await second.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    assert.equal(verdict.status, 'refreshed');

    const [row] = await second.db.getRegisteredServers();
    assert.equal(
      Number(row.firstSeenAt), Number(firstSeenAt),
      'firstSeenAt is when this server was first seen, not when it last restarted'
    );
  } finally {
    await second.sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// The stale/fresh split
// ---------------------------------------------------------------------------

test('a changed port over a stale row updates and does not block', async () => {
  const storage = sharedStorage();
  const { db, sequelize } = await processFor(storage, 1);
  try {
    await db.registerServer({ server: fakeServer({ rconPort: 21114 }) });
    await makeStale(db, 1);

    const verdict = await db.registerServer({ server: fakeServer({ rconPort: 21115 }) });

    assert.equal(verdict.status, 'reclaimed', 'a moved server must come up, not be refused');
    assert.equal(verdict.fresh, false);
    assert.deepEqual(verdict.differences, ['rconPort'], 'the verdict names the field so the log can too');

    const [row] = await db.getRegisteredServers();
    assert.equal(row.rconPort, 21115, 'the registry follows the server');
  } finally {
    await sequelize.close();
  }
});

test('a different fingerprint over a fresh row is refused, and writes nothing', async () => {
  const storage = sharedStorage();
  const incumbent = await processFor(storage, 1);
  const intruder = await processFor(storage, 1);
  try {
    await incumbent.db.registerServer({ server: fakeServer({ host: '10.0.0.1' }), suiteVersion: '1.7.0' });

    const verdict = await intruder.db.registerServer({
      server: fakeServer({ host: '10.0.0.2' }),
      suiteVersion: '1.7.0'
    });

    assert.equal(verdict.status, 'collision');
    assert.equal(verdict.fresh, true);
    assert.deepEqual(verdict.differences, ['host']);
    assert.equal(verdict.stored.host, '10.0.0.1');
    assert.equal(verdict.fingerprint.host, '10.0.0.2');
    assert.ok(Number.isFinite(verdict.lastSeenAt), 'the verdict carries how recently the other process was seen');

    const [row] = await intruder.db.getRegisteredServers();
    assert.equal(
      row.host, '10.0.0.1',
      "the incumbent's row must be untouched — overwriting it would make the intruder look like the owner"
    );
  } finally {
    await incumbent.sequelize.close();
    await intruder.sequelize.close();
  }
});

test('forceServerClaim turns a fresh collision into a reclaim', async () => {
  const storage = sharedStorage();
  const { db, sequelize } = await processFor(storage, 1);
  try {
    await db.registerServer({ server: fakeServer({ queryPort: 27165 }) });

    const verdict = await db.registerServer({
      server: fakeServer({ queryPort: 27175 }),
      force: true
    });

    assert.equal(verdict.status, 'reclaimed');
    assert.equal(verdict.fresh, true, 'the row really was fresh — force is what changed the outcome');
    assert.equal(verdict.forced, true, 'the caller has to be able to log that this was an override, not a normal reclaim');

    const [row] = await db.getRegisteredServers();
    assert.equal(row.queryPort, 27175);
  } finally {
    await sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// The first-boot race
// ---------------------------------------------------------------------------

test('two processes claiming one id concurrently: exactly one creates it', async () => {
  // The case a read-then-write gets wrong. Both would see an empty table and
  // both would conclude they own the id; the insert has to come first so the
  // primary key is what decides.
  const storage = sharedStorage();
  const a = await processFor(storage, 1);
  const b = await processFor(storage, 1);
  try {
    const [va, vb] = await Promise.all([
      a.db.registerServer({ server: fakeServer({ host: '10.0.0.1' }) }),
      b.db.registerServer({ server: fakeServer({ host: '10.0.0.2' }) })
    ]);

    const statuses = [va.status, vb.status].sort();
    assert.deepEqual(
      statuses, ['collision', 'created'],
      `exactly one process may create the row and the loser must see the collision, got ${statuses.join(' + ')}`
    );

    const rows = await a.db.getRegisteredServers();
    assert.equal(rows.length, 1, 'one id, one row');
  } finally {
    await a.sequelize.close();
    await b.sequelize.close();
  }
});

test('two processes for the SAME server racing at boot both come up', async () => {
  // A restart that overlaps its own shutdown, or two workers for one server.
  // The fingerprints agree, so nothing is contested and neither is refused.
  const storage = sharedStorage();
  const a = await processFor(storage, 1);
  const b = await processFor(storage, 1);
  try {
    const [va, vb] = await Promise.all([
      a.db.registerServer({ server: fakeServer() }),
      b.db.registerServer({ server: fakeServer() })
    ]);

    const statuses = [va.status, vb.status].sort();
    assert.deepEqual(statuses, ['created', 'refreshed'], `got ${statuses.join(' + ')}`);
  } finally {
    await a.sequelize.close();
    await b.sequelize.close();
  }
});

test('two Squad servers on one host are still distinguished, because their ports cannot collide', async () => {
  // The obvious worry about loopback is two servers on one box, and it is the
  // case that does not arise: two Squad servers on one host cannot both bind
  // 27165/21114, so an operator who left both ids at the stock 1 still gets
  // caught here on the ports even though `host` is identical on both sides.
  const storage = sharedStorage();
  const first = await processFor(storage, 1);
  const second = await processFor(storage, 1);
  try {
    await first.db.registerServer({ server: fakeServer({ host: '127.0.0.1', queryPort: 27165, rconPort: 21114 }) });

    const verdict = await second.db.registerServer({
      server: fakeServer({ host: '127.0.0.1', queryPort: 27175, rconPort: 21124 })
    });

    assert.equal(verdict.status, 'collision');
    assert.deepEqual(verdict.differences, ['queryPort', 'rconPort']);
  } finally {
    await first.sequelize.close();
    await second.sequelize.close();
  }
});

test('two loopback servers on different machines are the one shape the fingerprint cannot see', async () => {
  // KNOWN GAP, pinned deliberately rather than fixed. Everything the
  // fingerprint reads describes how a process reaches *its own* server, and on
  // two machines that each run SquadJS beside their game server the honest
  // answer to all three fields is the same answer: 127.0.0.1, and the stock
  // ports. Two genuinely different servers therefore produce byte-identical
  // fingerprints, `fingerprintDifferences()` returns [], and the second
  // process refreshes the incumbent's row and takes the identity in silence.
  //
  // This is not the same as the case above it, and not fixable by comparing
  // harder: the values genuinely agree. Separating it needs a field that
  // describes the *machine* rather than the route to the server — a hostname
  // column is the obvious candidate — and that is a schema change on
  // S3_Servers, which is a column add, which needs a hand-applied ALTER
  // wherever the deployment's database user holds CREATE but not ALTER.
  //
  // It was left open on the judgement that the exposure does not include the
  // shape production actually runs: a routable host with non-default ports
  // differs on at least one field, and two servers on one box differ on their
  // ports (above). What remains is two machines, each on loopback, each on the
  // stock ports, both left at `id: 1`, against one database.
  //
  // Reverse this test the day the discriminator is added — it asserts today's
  // behaviour, not the desired behaviour, and it is the only test here that does.
  const storage = sharedStorage();
  const desktop = await processFor(storage, 1);
  const laptop = await processFor(storage, 1);
  try {
    const loopback = { host: '127.0.0.1', queryPort: 27165, rconPort: 21114 };
    await desktop.db.registerServer({ server: fakeServer({ ...loopback, serverName: "Slacker's Test Server" }) });

    const verdict = await laptop.db.registerServer({
      server: fakeServer({ ...loopback, serverName: "Slacker's Test Server 2" })
    });

    assert.deepEqual(
      DBService.fingerprintDifferences(
        DBService.serverFingerprint(fakeServer(loopback)),
        DBService.serverFingerprint(fakeServer(loopback))
      ),
      [],
      'the premise of the gap: two different servers, nothing to compare that disagrees'
    );
    assert.equal(
      verdict.status, 'refreshed',
      'today the second machine is admitted; when a machine-level discriminator exists this becomes a collision'
    );

    const rows = await laptop.db.getRegisteredServers();
    assert.equal(rows.length, 1, 'one id, one row — the second server has no row of its own');
    const [row] = rows;
    assert.equal(
      row.serverName, "Slacker's Test Server 2",
      'and the incumbent\'s name is gone: this is the silent identity takeover the fingerprint exists to prevent'
    );
  } finally {
    await desktop.sequelize.close();
    await laptop.sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Absence is not a difference
// ---------------------------------------------------------------------------

test('a null on either side of the fingerprint is unknown, not different', () => {
  const full = { host: '10.0.0.1', queryPort: 27165, rconPort: 21114 };

  assert.deepEqual(DBService.fingerprintDifferences(full, full), []);
  assert.deepEqual(
    DBService.fingerprintDifferences({ host: null, queryPort: null, rconPort: null }, full), [],
    'a row written before the fingerprint columns were populated must not read as a second server'
  );
  assert.deepEqual(
    DBService.fingerprintDifferences(full, { host: '10.0.0.1', queryPort: null, rconPort: 21114 }), [],
    'an unconfigured port on this side is not evidence of anything'
  );
  assert.deepEqual(
    DBService.fingerprintDifferences(full, { ...full, host: '10.0.0.2' }), ['host'],
    'two known, disagreeing values are the whole point'
  );

  // The ports arrive as strings from some configs and as numbers from others.
  assert.deepEqual(
    DBService.fingerprintDifferences(full, { ...full, queryPort: '27165' }), [],
    'a port that differs only in type is the same port'
  );
});

test('serverFingerprint reads the SquadJS options, and serverName is not part of it', () => {
  const fp = DBService.serverFingerprint(fakeServer({ serverName: 'renamed by an admin' }));
  assert.deepEqual(fp, { host: '10.0.0.1', queryPort: 27165, rconPort: 21114 });
  assert.equal(
    'serverName' in fp, false,
    'serverName is set by updateServerInformation, usually after mount, and renaming a server is not a move'
  );

  assert.deepEqual(
    DBService.serverFingerprint({}), { host: null, queryPort: null, rconPort: null },
    'a server with no options yields unknowns rather than throwing'
  );
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test('isServerRowFresh reads a missing heartbeat as stale', () => {
  const now = 1_000_000_000_000;
  assert.equal(DBService.isServerRowFresh({ lastSeenAt: now - 1000 }, now), true);
  assert.equal(DBService.isServerRowFresh({ lastSeenAt: now - SERVER_FRESHNESS_MS - 1 }, now), false);
  assert.equal(
    DBService.isServerRowFresh({ lastSeenAt: null }, now), false,
    'a row nobody ever stamped must not hold an id hostage'
  );
  assert.equal(
    DBService.isServerRowFresh({ lastSeenAt: String(now - 1000) }, now), true,
    'BIGINT reads back as a string on Postgres — see DBService._asEpochMs()'
  );
});

test('the heartbeat stamps the row and stays quiet when it cannot', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    await db.registerServer({ server: fakeServer() });
    await makeStale(db, 1);

    const stamped = await db.heartbeatServer();
    assert.ok(Number.isFinite(stamped), 'a successful heartbeat returns the timestamp it wrote');

    const [row] = await db.getRegisteredServers();
    assert.equal(DBService.isServerRowFresh(row, await db.dbNow()), true);

    // A heartbeat is a diagnostic write. Taking a game server down because one
    // failed would invert the trade the registry exists to make.
    const saved = db.ServersModel;
    db.ServersModel = null;
    assert.equal(await db.heartbeatServer(), null);
    db.ServersModel = saved;
  } finally {
    await sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Degraded registry
// ---------------------------------------------------------------------------

test('an unavailable registry reports itself rather than throwing', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    db.ServersModel = null;
    db._serversInitError = new Error('CREATE command denied');

    const verdict = await db.registerServer({ server: fakeServer() });
    assert.equal(verdict.status, 'unavailable');
    assert.match(verdict.reason, /CREATE command denied/, 'the verdict has to name a cause the operator can act on');

    assert.deepEqual(await db.getRegisteredServers(), []);
  } finally {
    await sequelize.close();
  }
});

test('the unique alias index tolerates many unregistered aliases', async () => {
  // Load-bearing and dialect-specific, so it is measured rather than assumed:
  // registerServer() leaves alias null on every row it creates, and a unique
  // index that counted nulls as equal would let exactly one server register.
  const storage = sharedStorage();
  const a = await processFor(storage, 1);
  const b = await processFor(storage, 2);
  try {
    assert.equal((await a.db.registerServer({ server: fakeServer() })).status, 'created');
    assert.equal((await b.db.registerServer({ server: fakeServer({ queryPort: 27175 }) })).status, 'created');

    const rows = await a.db.getRegisteredServers();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.alias), [null, null]);
  } finally {
    await a.sequelize.close();
    await b.sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Identifier case
//
// Production MySQL runs lower_case_table_names=1, which stores every table
// under a folded name and reports the folded name back, while every statement
// that *names* the table keeps working. So on the live server these two tables
// are `s3_locks` and `s3_servers`, and every boot after the first one meets
// them that way. SQLite matches identifiers case-insensitively for the same
// reason, so a table physically renamed to lowercase reproduces the live
// situation exactly, with no mocking — which is how the migration pipeline's
// own case-folding cases are written.
// ---------------------------------------------------------------------------

/** Store these tables under the names a folding server would store them under. */
async function foldTableNames(storage, names) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  try {
    for (const name of names) {
      // Two hops: SQLite refuses a rename that differs from the current name
      // only by case, because to SQLite it is the same name.
      await sequelize.query(`ALTER TABLE "${name}" RENAME TO "tmpfold_${name}"`);
      await sequelize.query(`ALTER TABLE "tmpfold_${name}" RENAME TO "${name.toLowerCase()}"`);
    }
    const rows = await sequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table'",
      { type: Sequelize.QueryTypes.SELECT }
    );
    return rows.map((r) => r.name);
  } finally {
    await sequelize.close();
  }
}

test('a boot against folded table names creates nothing and re-creates no index', async () => {
  const storage = sharedStorage();
  const first = await processFor(storage, 1);
  await first.sequelize.close();

  const stored = await foldTableNames(storage, ['S3_Locks', 'S3_Servers']);
  assert.ok(
    stored.includes('s3_locks') && stored.includes('s3_servers'),
    'premise broken — the tables were not stored folded, so this case proves nothing'
  );

  const second = await processFor(storage, 1);
  try {
    assert.ok(second.db.LocksModel, `the locks bootstrap failed: ${second.db._locksInitError?.message}`);
    assert.ok(second.db.ServersModel, `the registry bootstrap failed: ${second.db._serversInitError?.message}`);

    // A create guard that read the folded name as absent would leave a second
    // table behind on MySQL; on SQLite it would fail outright. Either way the
    // count is what says the guard held.
    const after = await second.sequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table'",
      { type: Sequelize.QueryTypes.SELECT }
    );
    const s3Tables = after.map((r) => r.name).filter((n) => /^s3_(locks|servers)$/i.test(n));
    assert.deepEqual(
      s3Tables.map((n) => n.toLowerCase()).sort(), ['s3_locks', 's3_servers'],
      `the bootstrap created a second copy under the declared casing: ${s3Tables.join(', ')}`
    );

    // The index guard is the one that reports on itself. Both indexes were
    // created by the first boot and must be recognised as present, not
    // reissued — a reissue fails, and the failure is a level-1 warning about a
    // uniqueness constraint that is in fact in effect.
    const report = second.db._serversIndexReport;
    assert.deepEqual(report.created, [], 'an index was re-created over a folded table name');
    assert.deepEqual(report.failed, [], `an index create failed: ${JSON.stringify(report.failed)}`);
    assert.equal(report.existing.length, 2, `both indexes should be seen as present, saw ${JSON.stringify(report.existing)}`);
  } finally {
    await second.sequelize.close();
  }
});

test('the registry reads and writes normally through a folded table name', async () => {
  const storage = sharedStorage();
  const first = await processFor(storage, 1);
  await first.sequelize.close();
  await foldTableNames(storage, ['S3_Locks', 'S3_Servers']);

  const second = await processFor(storage, 1);
  try {
    const verdict = await second.db.registerServer({
      server: fakeServer({ serverName: '[NL] Slackers #1' }),
      suiteVersion: '1.7.0'
    });
    assert.equal(verdict.status, 'created', `registering against a folded table failed: ${verdict.reason}`);

    const rows = await second.db.getRegisteredServers();
    assert.equal(rows.length, 1, 'the row went somewhere other than the table the reader looks at');
    assert.equal(rows[0].serverID, 1);
  } finally {
    await second.sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// The consumer-plugin gate
// ---------------------------------------------------------------------------

/** An S3PluginBase whose S³ discovery has already happened, with a given verdict. */
function pluginWithS3(blocked, overrides = {}) {
  const plugin = Object.create(S3PluginBase.prototype);
  Object.assign(plugin, {
    _s3: { serverIdentityBlocked: blocked, ready: async () => {}, db: null },
    _s3db: null,
    verbose: () => {},
    _onS3Ready: async () => { plugin.mounted = true; }
  }, overrides);
  // super.mount() is SquadJS's BasePlugin.mount(), which is a no-op.
  Object.getPrototypeOf(S3PluginBase.prototype).mount = async () => {};
  return plugin;
}

test('a blocked identity stops a consumer plugin from mounting', async () => {
  const plugin = pluginWithS3('another process is live under server id 1 with a different host');

  await assert.rejects(
    () => plugin.mount(),
    /another process is live under server id 1/,
    'every row this plugin writes is keyed by the contested id, so mounting means adding to someone else\'s data'
  );
  assert.notEqual(plugin.mounted, true, '_onS3Ready must not run');
});

test('a plugin that writes nothing server-scoped still mounts', async () => {
  const plugin = pluginWithS3('another process is live under server id 1 with a different host');
  Object.defineProperty(plugin, 'requiresServerIdentity', { value: false });

  await plugin.mount();
  assert.equal(plugin.mounted, true, 'a globally-scoped plugin has no rows to confuse, so it keeps running');
});

test('an unblocked identity mounts normally, and the default answer is to require one', async () => {
  const plugin = pluginWithS3(null);
  assert.equal(
    plugin.requiresServerIdentity, true,
    'the safe default is yes — wrong that way refuses a mount, wrong the other way corrupts a sibling'
  );

  await plugin.mount();
  assert.equal(plugin.mounted, true);
});

// ---------------------------------------------------------------------------
// Aliases — uniqueness is not the property that matters; distinctness is
// ---------------------------------------------------------------------------

test('normalizeAlias folds case and strips what a Squad name is mostly made of', () => {
  assert.equal(DBService.normalizeAlias('Main'), 'main', '--server Main must find main');
  assert.equal(DBService.normalizeAlias('  [NL] Slackers!  '), 'nlslackers');
  assert.equal(DBService.normalizeAlias('event-2_b'), 'event-2_b', 'hyphen and underscore survive');
  assert.equal(DBService.normalizeAlias('###'), null, 'nothing survived, so there is no alias to store');
  assert.equal(DBService.normalizeAlias(null), null);
  assert.equal(DBService.normalizeAlias('x'.repeat(80)).length, ALIAS_MAX_LENGTH);
});

test('an alias never begins with a separator, because --server could not reach it', () => {
  // The gate reads the token after `--server`, and one starting with `-` is
  // a flag the admin typed instead of a name. An alias of `-main` refuses
  // with "you did not name a server" and retyping it does not help.
  assert.equal(DBService.normalizeAlias('-main'), 'main');
  assert.equal(DBService.normalizeAlias('-- Slackers --'), 'slackers');
  assert.equal(DBService.normalizeAlias('_event_'), 'event', 'trailing separators go too — `main-` and `main` read the same');
  assert.equal(DBService.normalizeAlias('---'), null, 'nothing but separators is not a name');
});

test('an alias is never a bare number, because that shadows a server id', () => {
  // resolveServerToken() reads a bare number as an id BEFORE it looks at
  // aliases. An alias of "2" on server 3 sends every `--server 2` to server
  // 2 instead — the wrong live game, answered by a reply that looks right.
  assert.equal(DBService.normalizeAlias('2'), null);
  assert.equal(DBService.normalizeAlias('  12  '), null);
  assert.equal(DBService.normalizeAlias('2fort'), '2fort', 'a digit is only a problem when it is the whole name');
  assert.equal(
    DBService.defaultAliasFor({ serverName: '1 Slackers', serverID: 3 }), 'srv3',
    'the first word of a server name is not always a usable alias'
  );
});

test('setServerAlias refuses a numeric alias and says what it would collide with', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    await db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    const outcome = await db.setServerAlias(1, '2');

    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /shadows a server id/);

    const [row] = await db.getRegisteredServers();
    assert.equal(row.alias, null, 'a refused alias must not half-apply');
  } finally {
    await sequelize.close();
  }
});

test('the default alias is the first word of the server name, not srv<id>', () => {
  assert.equal(DBService.defaultAliasFor({ serverName: 'Event Server', serverID: 2 }), 'event');
  assert.equal(
    DBService.defaultAliasFor({ serverName: null, serverID: 2 }), 'srv2',
    'SquadJS fills serverName in later, so a first boot often has nothing to read'
  );
  assert.notEqual(
    DBService.defaultAliasFor({ serverName: 'Main Server', serverID: 1 }),
    DBService.defaultAliasFor({ serverName: 'Event Server', serverID: 2 }),
    'srv1 and srv2 differ by one keystroke in the last position; main and event cannot be confused'
  );
});

test('a mounted server names itself from its server name', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 4);
  try {
    await db.registerServer({ server: fakeServer({ serverName: 'Event Server' }), suiteVersion: '1.7.0' });
    assert.equal(await db.claimDefaultAlias({ serverName: 'Event Server' }), 'event');

    const [row] = await db.getRegisteredServers();
    assert.equal(row.alias, 'event');
  } finally {
    await sequelize.close();
  }
});

test('two servers sharing a first word both get named, and the second is suffixed', async () => {
  const storage = sharedStorage();
  const one = await processFor(storage, 1);
  const two = await processFor(storage, 2);
  try {
    await one.db.registerServer({ server: fakeServer({ serverName: '[NL] Slackers #1' }), suiteVersion: '1.7.0' });
    await two.db.registerServer({ server: fakeServer({ rconPort: 21115, serverName: '[NL] Slackers #2' }), suiteVersion: '1.7.0' });

    // A bracketed clan tag is its own first word, so both servers want "nl".
    // That is the shared-first-word case the suffixed fallback exists for, and
    // it is the common one: a community names its servers after itself.
    assert.equal(await one.db.claimDefaultAlias({ serverName: '[NL] Slackers #1' }), 'nl');
    assert.equal(
      await two.db.claimDefaultAlias({ serverName: '[NL] Slackers #2' }), 'nl-2',
      'an unnamed server cannot be addressed by --server at all, so the fallback has to name it'
    );
  } finally {
    await one.sequelize.close();
    await two.sequelize.close();
  }
});

test('claiming a default alias leaves an existing one alone', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    await db.registerServer({ server: fakeServer({ serverName: 'Main Server' }), suiteVersion: '1.7.0' });
    await db.setServerAlias(1, 'chosen');

    assert.equal(
      await db.claimDefaultAlias({ serverName: 'Main Server' }), 'chosen',
      'an operator picked that name; a restart is not permission to change it'
    );
  } finally {
    await sequelize.close();
  }
});

test('a duplicate alias is refused, and nothing is written', async () => {
  const storage = sharedStorage();
  const one = await processFor(storage, 1);
  const two = await processFor(storage, 2);
  try {
    await one.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await two.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.7.0' });
    await one.db.setServerAlias(1, 'main');

    const outcome = await two.db.setServerAlias(2, 'MAIN');
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /already answers/);

    const rows = await two.db.getRegisteredServers();
    assert.equal(rows.find((r) => r.serverID === 2).alias, null, 'a refused rename must not half-apply');
  } finally {
    await one.sequelize.close();
    await two.sequelize.close();
  }
});

test('an alias one edit from an existing one is refused, though it is unique', async () => {
  const storage = sharedStorage();
  const one = await processFor(storage, 1);
  const two = await processFor(storage, 2);
  try {
    await one.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await two.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.7.0' });
    await one.db.setServerAlias(1, 'srv1');

    const outcome = await two.db.setServerAlias(2, 'srv2');
    assert.equal(
      outcome.ok, false,
      'srv1 and srv2 are unique and a keystroke apart — a unique index cannot see the failure this rule exists for'
    );
    assert.equal(outcome.conflicts.near.length, 1);
    assert.equal(outcome.conflicts.near[0].alias, 'srv1');

    const far = await two.db.setServerAlias(2, 'event');
    assert.equal(far.ok, true, 'a name that cannot be mistyped into the other is allowed');
  } finally {
    await one.sequelize.close();
    await two.sequelize.close();
  }
});

test('the row being renamed is exempt from its own distinctness check', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    await db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await db.setServerAlias(1, 'main');

    const outcome = await db.setServerAlias(1, 'mains');
    assert.equal(
      outcome.ok, true,
      'without the exemption, main -> mains is refused for colliding with main, which is the row being edited'
    );
    assert.equal(outcome.alias, 'mains');

    const conflicts = await db.findAliasConflicts('main', { exceptServerID: 999 });
    assert.equal(conflicts.duplicate, null, 'the old name is free once the rename lands');
  } finally {
    await sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Two named rows, ids 1 and 2 — the shape every label case needs. */
function labelPair(nameOne, nameTwo) {
  const labels = serverLabels([
    { serverID: 1, alias: 'one', serverName: nameOne },
    { serverID: 2, alias: 'two', serverName: nameTwo }
  ]);
  return [labels.get(1), labels.get(2)];
}

test('what every server also says is dropped, wherever in the name it sits', () => {
  // The pitch is a suffix here and the number is in the first segment.
  assert.deepEqual(
    labelPair(
      'Northern Lights #1 | Teamwork Oriented | Beginner Friendly | discord.gg/northernlightsgaming',
      'Northern Lights #2 | Teamwork Oriented | Beginner Friendly | discord.gg/northernlightsgaming'
    ),
    ['Northern Lights #1', 'Northern Lights #2']
  );

  // And here it is not: the community name leads, the number is its own
  // segment, and a rule that kept the first segment and stopped would call both
  // of these "Rangers" — a label that reads like a name and distinguishes
  // nothing, which is worse than showing no name at all.
  assert.deepEqual(
    labelPair('Rangers | #1 | Teamwork', 'Rangers | #2 | Teamwork'),
    ['Rangers #1', 'Rangers #2']
  );
});

test('the separator is whichever one the community used', () => {
  // Nothing about the rule is specific to a pipe. Hyphens padded with spaces
  // are as common in the server browser, and so are double slashes.
  assert.deepEqual(
    labelPair('[TT] Tactical #1 - EU - discord.gg/tt', '[TT] Tactical #2 - EU - discord.gg/tt'),
    ['[TT] Tactical #1', '[TT] Tactical #2']
  );
  assert.deepEqual(
    labelPair('ZTeam #1 // Noob Friendly', 'ZTeam #2 // Noob Friendly'),
    ['ZTeam #1', 'ZTeam #2']
  );

  // A hyphen inside a word is not a separator, and reading it as one would cut
  // "Sun-Tzu" in half. The name has to carry something droppable for this to
  // bite: with nothing dropped the label is the stored string either way, and
  // a rule that split on every hyphen would look correct here while quietly
  // restyling the first name that did lose a segment.
  assert.deepEqual(
    labelPair('Sun-Tzu Tactical #1 | EU', 'Sun-Tzu Tactical #2 | EU'),
    ['Sun-Tzu Tactical #1', 'Sun-Tzu Tactical #2']
  );
});

test('a name with no separator at all is kept whole, cut only to fit', () => {
  assert.deepEqual(
    labelPair('Alpha Server One', 'Alpha Server Two'),
    ['Alpha Server One', 'Alpha Server Two']
  );

  // Cut only at the end, so a difference that sits inside the display width
  // survives it. One that does not is the collision case below.
  const [long] = labelPair(`One ${'A'.repeat(80)}`, `Two ${'A'.repeat(80)}`);
  assert.equal(long.length, 48);
  assert.ok(long.startsWith('One '), 'the front of the name is what identifies it');
  assert.ok(long.endsWith('…'), 'a cut name has to look cut');
});

test('a label nobody could act on is not shown', () => {
  // Identical names, and a difference that fell off the end of the cut. Both
  // leave two rows reading the same, and a label that describes either of two
  // servers is worse than none — the alias printed beside it is unambiguous.
  assert.deepEqual(labelPair('Slackers | EU', 'Slackers | EU'), [null, null]);
  assert.deepEqual(labelPair(`${'A'.repeat(60)}1`, `${'A'.repeat(60)}2`), [null, null]);

  // A row with nothing stored gets nothing, and does not stop the other from
  // being named. With only one name in play there is no evidence about what is
  // padding, so it is shown as written.
  assert.deepEqual(labelPair(null, 'Slackers | EU'), [null, 'Slackers | EU']);
  assert.equal(serverDisplayName({ serverID: 4, alias: 'event', serverName: null }), null);
});

test('one registered server has nothing to be compared against', () => {
  // Dropping a segment here would be the guess about format that this rule
  // exists to avoid, and a lone server is not being confused with anything. It
  // is also the only case where the whole advertisement is shown.
  assert.equal(
    serverDisplayName({ serverID: 1, alias: 'northern', serverName: 'Slackers | EU | discord.gg/x' }),
    'Slackers | EU | discord.gg/x'
  );
});

// ---------------------------------------------------------------------------
// Label delivery
// ---------------------------------------------------------------------------

test('the label goes above the title and leaves the footer alone', () => {
  publishServerLabel('Northern Lights #1');
  try {
    // The author slot renders above the title, which is the whole reason it
    // is used: broadcast reads are identical for their whole height, and a
    // label in the footer is read after the content it qualifies.
    const labelled = applyServerLabel({
      embeds: [{ title: 'Scramble', footer: { text: 'Round 42' } }]
    });
    assert.equal(labelled.embeds[0].author.name, 'Northern Lights #1');

    // Whatever the footer was already saying is still saying it. Version
    // stamps live there — "Switch v2.6.0" — and used to share the line.
    assert.equal(labelled.embeds[0].footer.text, 'Round 42');

    // Most call sites write the array, a minority write the singular.
    const singular = applyServerLabel({ embed: { title: 'Scramble' } });
    assert.equal(singular.embed.author.name, 'Northern Lights #1');
  } finally {
    publishServerLabel(null);
  }
});

test('a title that already names the server suppresses the author line', () => {
  publishServerLabel('Northern Lights #1');
  try {
    // titleWithServer() puts the server at the front of a mutation's title,
    // and that title renders directly under the author line. Both would
    // print the server name twice, stacked.
    const mutation = applyServerLabel({
      embeds: [{ title: 'Northern Lights #1 — Scramble Completed' }]
    });
    assert.equal(mutation.embeds[0].author, undefined);

    // A title that merely starts with the same words is not the same shape —
    // the separator is what makes it a titleWithServer() title.
    const coincidence = applyServerLabel({
      embeds: [{ title: 'Northern Lights #1 Scramble Completed' }]
    });
    assert.equal(coincidence.embeds[0].author.name, 'Northern Lights #1');
  } finally {
    publishServerLabel(null);
  }
});

test('a payload does not collect a second label on the way out', () => {
  publishServerLabel('Northern Lights #1');
  try {
    // Two ways the same payload reaches the decoration twice: a 429 makes the
    // sender re-send the object it already built, and the empty-message guard
    // rebuilds it in the v12 singular shape and sends that.
    const once = applyServerLabel({ embeds: [{ footer: { text: 'Round 42' } }] });
    const twice = applyServerLabel(once);
    assert.equal(twice.embeds[0].author.name, 'Northern Lights #1');
    assert.equal(twice.embeds[0].footer.text, 'Round 42');

    const rewrapped = applyServerLabel({ embed: once.embeds[0] });
    assert.equal(rewrapped.embed.author.name, 'Northern Lights #1');

    // An author the caller set for itself is a loss if it is overwritten, so
    // it is left alone rather than relabelled.
    const owned = applyServerLabel({ embeds: [{ author: { name: 'Elo' } }] });
    assert.equal(owned.embeds[0].author.name, 'Elo');
  } finally {
    publishServerLabel(null);
  }
});

test('the caller keeps the embed it wrote', () => {
  publishServerLabel('Northern Lights #1');
  try {
    // Embed literals are built once and reused — the status embed is rebuilt
    // per send, but a cached one would accumulate a label per attempt.
    const embed = { title: 'Scramble', footer: { text: 'Round 42' } };
    const payload = { embeds: [embed] };
    const labelled = applyServerLabel(payload);

    assert.equal(embed.author, undefined, 'the original is untouched');
    assert.notEqual(labelled.embeds[0], embed);
    assert.notEqual(labelled, payload);
  } finally {
    publishServerLabel(null);
  }
});

test('a single-server install publishes nothing and is handed back its payload', () => {
  publishServerLabel(null);
  assert.equal(readServerLabel(), null);

  // Identity, not a copy: the zero-delta guarantee for the installs that
  // never asked for any of this is held here, in one place, rather than
  // asserted across every embed in the suite.
  const payload = { embeds: [{ title: 'Scramble' }] };
  assert.equal(applyServerLabel(payload), payload);

  // An empty string is the same instruction as null — a locale that renders
  // the label to nothing must stop the labelling, not print an empty line.
  publishServerLabel('   ');
  assert.equal(readServerLabel(), null);
  assert.equal(applyServerLabel(payload), payload);
});

test('every sender labels its embeds, in the layout the suite ships in', async () => {
  const label = await shipped('s3-server-label.js');
  const { sendDiscordMessage } = await shipped('s3-discord.js');
  const { EloDiscord } = await shipped('elo-discord.js');
  const { DiscordHelpers } = await shipped('tb-discord-helpers.js');

  // Constructing the two consumer plugins is the point, not a detour: neither
  // helper can import the label module — in this repository it is not in
  // their utils directory and in the shipped layout it is — so the plugin
  // hands it to them, and a plugin that stopped doing that would leave its
  // embeds unlabelled with nothing else failing.
  const server = { on: () => {}, removeListener: () => {}, players: [], squads: [] };
  const connectors = { discord: { on: () => {} } };
  new EloTracker(server, {}, connectors);
  new TeamBalancer(server, {}, connectors);

  label.publishServerLabel('Northern Lights #1');
  try {
    const captor = () => {
      const channel = { id: '1', name: 'reports', send: (data) => { channel.sent = data; } };
      return channel;
    };

    const s3Channel = captor();
    await sendDiscordMessage(s3Channel, { embeds: [{ title: 'Servers' }] });
    assert.equal(s3Channel.sent.embeds[0].author.name, 'Northern Lights #1');

    const eloChannel = captor();
    await EloDiscord.sendDiscordMessage(eloChannel, { embeds: [{ title: 'Round' }] });
    assert.equal(eloChannel.sent.embeds[0].author.name, 'Northern Lights #1');

    const tbChannel = captor();
    await DiscordHelpers.sendDiscordMessage(tbChannel, { embeds: [{ title: 'Scramble' }] });
    assert.equal(tbChannel.sent.embeds[0].author.name, 'Northern Lights #1');

    // The base class fills a footer in before this runs, so its embeds prove
    // that the label no longer competes for that line.
    const baseChannel = captor();
    await S3DiscordPluginBase.prototype.sendDiscordMessage.call(
      {
        channel: baseChannel,
        verbose: () => {},
        reportError: () => {},
        localize: () => 'Slackers Suite'
      },
      { embed: { title: 'Status' } }
    );
    assert.equal(baseChannel.sent.embeds[0].author.name, 'Northern Lights #1');
    assert.equal(baseChannel.sent.embeds[0].footer.text, 'Slackers Suite');
  } finally {
    label.publishServerLabel(null);
  }
});

test('registerServer takes the config name when RCON has not answered yet', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    // The mount-order case: serverConfig is up, RCON is not, and this is the
    // write that used to leave serverName null for the life of the row.
    await db.registerServer({
      server: fakeServer({ serverName: null }),
      suiteVersion: '1.7.0',
      fallbackServerName: 'Northern Lights #1 | Teamwork Oriented | Beginner Friendly | discord.gg/northernlightsgaming'
    });

    const [row] = await db.getRegisteredServers();
    // Stored whole. Which part of it is worth showing is decided at render
    // time, against whatever else is registered by then.
    assert.equal(row.serverName, 'Northern Lights #1 | Teamwork Oriented | Beginner Friendly | discord.gg/northernlightsgaming');
  } finally {
    await sequelize.close();
  }
});

test('a live RCON name outranks the config file, which can be stale', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    // An admin who renamed the server without editing Server.cfg is the
    // reason for the order: the running server is the one being described.
    await db.registerServer({
      server: fakeServer({ serverName: 'Northern Lights #1 | renamed live' }),
      suiteVersion: '1.7.0',
      fallbackServerName: 'Northern Lights #1 | from disk'
    });

    const [row] = await db.getRegisteredServers();
    assert.match(row.serverName, /renamed live/);
  } finally {
    await sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Resolution — an ambiguous token never picks a winner
// ---------------------------------------------------------------------------

test('a token resolves by alias, case-insensitively, or by bare server id', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 7);
  try {
    await db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await db.setServerAlias(7, 'event');

    assert.equal((await db.resolveServerToken('Event')).row.serverID, 7);
    assert.equal(
      (await db.resolveServerToken('7')).row.serverID, 7,
      'an operator reading a log line has the id in front of them, not the alias'
    );
  } finally {
    await sequelize.close();
  }
});

test('an unknown token refuses and hands back the candidates', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    await db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await db.setServerAlias(1, 'main');

    const resolved = await db.resolveServerToken('mian');
    assert.equal(resolved.notFound, true);
    assert.equal(resolved.candidates.length, 1, 'the reply has to be able to say what does exist');
    assert.equal(resolved.candidates[0].alias, 'main');
  } finally {
    await sequelize.close();
  }
});

test('two rows answering to one alias resolve to neither', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    // The unique index is what stops this reaching the database, so the only way
    // to produce it is a hand-edited table — which is exactly the case the
    // resolver must not paper over by taking the first row.
    db.getRegisteredServers = async () => [
      { serverID: 1, alias: 'main', serverName: 'Main' },
      { serverID: 2, alias: 'main', serverName: 'Also Main' }
    ];

    const resolved = await db.resolveServerToken('main');
    assert.equal(resolved.row, undefined, 'resolving to the first row turns a detectable case into a silent one');
    assert.equal(resolved.ambiguous.length, 2);
  } finally {
    await sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Registered vs. live, and deregistration
// ---------------------------------------------------------------------------

test('the registered count includes a stale server; the live list does not', async () => {
  const storage = sharedStorage();
  const one = await processFor(storage, 1);
  const two = await processFor(storage, 2);
  try {
    await one.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await two.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.7.0' });
    await makeStale(two.db, 2);

    assert.equal(
      await one.db.getRegisteredServerCount(), 2,
      'a restarting server must not drop the community out of multi-server mode'
    );
    const live = await one.db.getLiveServers();
    assert.deepEqual(live.map((r) => r.serverID), [1]);
  } finally {
    await one.sequelize.close();
    await two.sequelize.close();
  }
});

test('forgetting a server that is still heartbeating is refused', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    await db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });

    const outcome = await db.forgetServer(1);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /still running/);
    assert.equal(await db.getRegisteredServerCount(), 1);
  } finally {
    await sequelize.close();
  }
});

test('forgetting a retired server removes the registration and nothing else', async () => {
  const storage = sharedStorage();
  const one = await processFor(storage, 1);
  const two = await processFor(storage, 2);
  try {
    await one.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await two.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.7.0' });
    await two.db.setServerAlias(2, 'event');
    await makeStale(one.db, 2);

    const outcome = await one.db.forgetServer(2);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.row.alias, 'event');
    assert.deepEqual((await one.db.getRegisteredServers()).map((r) => r.serverID), [1]);

    const gone = await one.db.forgetServer(2);
    assert.equal(gone.ok, false, 'a second attempt says so rather than reporting a success it did not perform');
  } finally {
    await one.sequelize.close();
    await two.sequelize.close();
  }
});

test('the registry records this host’s clock skew against the database', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    await db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });

    const [row] = await db.getRegisteredServers();
    assert.equal(
      typeof row.clockSkewMs, 'number',
      'the log line lands on the skewed host; !s3 servers is where all of them can be read at once'
    );
    assert.equal(row.clockSkewMs, db.getClockSkewMs());
  } finally {
    await sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Noticing the count change — the single-server-forever bug
// ---------------------------------------------------------------------------

/** A process whose level-1 log lines are captured rather than discarded. */
async function loggingProcessFor(storage, serverID) {
  const logged = [];
  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  const db = new DBService({
    sequelize,
    serverID,
    verboseLogger: (level, msg) => { if (level === 1) logged.push(msg); },
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();
  return { db, sequelize, logged };
}

test('the first read establishes a baseline and announces nothing', async () => {
  const { db, sequelize, logged } = await loggingProcessFor(sharedStorage(), 1);
  try {
    await db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    logged.length = 0;

    const first = await db.refreshRegisteredServerCount();
    assert.equal(first.count, 1);
    assert.equal(first.previous, null);
    assert.equal(
      first.transition, null,
      'a process booting into an already-multi-server community has not seen anything change'
    );
    assert.deepEqual(logged, []);
  } finally {
    await sequelize.close();
  }
});

test('a process booting into an existing multi-server community announces nothing', async () => {
  const storage = sharedStorage();
  const two = await processFor(storage, 2);
  try {
    await two.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.7.0' });
  } finally {
    await two.sequelize.close();
  }

  const one = await loggingProcessFor(storage, 1);
  try {
    await one.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    one.logged.length = 0;

    const first = await one.db.refreshRegisteredServerCount();
    assert.equal(first.count, 2);
    assert.equal(
      first.transition, null,
      'nothing changed while this process was watching — it arrived to find two, which is not an event'
    );
    assert.deepEqual(one.logged, []);
  } finally {
    await one.sequelize.close();
  }
});

test('a server joining while this one is already running is noticed, and logged at level 1', async () => {
  const storage = sharedStorage();
  const one = await loggingProcessFor(storage, 1);
  const two = await processFor(storage, 2);
  try {
    await one.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await one.db.refreshRegisteredServerCount();
    one.logged.length = 0;

    // The second install boots after this process is already up, which is the
    // case a mount-time read can never see.
    await two.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.7.0' });

    const after = await one.db.refreshRegisteredServerCount();
    assert.equal(after.count, 2);
    assert.equal(after.previous, 1);
    assert.equal(after.transition, 'one-to-many');
    assert.equal(one.logged.length, 1, 'it changes what every admin command in the channel means');
    assert.match(one.logged[0], /--server/);
  } finally {
    await one.sequelize.close();
    await two.sequelize.close();
  }
});

test('a retired server is noticed the same way, in the other direction', async () => {
  const storage = sharedStorage();
  const one = await loggingProcessFor(storage, 1);
  const two = await processFor(storage, 2);
  try {
    await one.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await two.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.7.0' });
    await one.db.refreshRegisteredServerCount();
    one.logged.length = 0;

    await makeStale(one.db, 2);
    await one.db.forgetServer(2);

    const after = await one.db.refreshRegisteredServerCount();
    assert.equal(after.transition, 'many-to-one');
    // forgetServer() logs the removal itself, which is a different fact: that
    // one says a row went, this one says what it now costs to type a command.
    const announced = one.logged.filter((line) => /implicitly/.test(line));
    assert.equal(
      announced.length, 1,
      'someone else running !s3 servers forget silently hands this process implicit targeting back'
    );
  } finally {
    await one.sequelize.close();
    await two.sequelize.close();
  }
});

test('an unchanged count says nothing, however often it is read', async () => {
  const { db, sequelize, logged } = await loggingProcessFor(sharedStorage(), 1);
  try {
    await db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await db.refreshRegisteredServerCount();
    logged.length = 0;

    for (let i = 0; i < 5; i++) {
      const result = await db.refreshRegisteredServerCount();
      assert.equal(result.transition, null);
    }
    assert.deepEqual(logged, [], 'the heartbeat runs every round; a line per round is noise, not a signal');
  } finally {
    await sequelize.close();
  }
});

test('the heartbeat re-reads the count, so a caller cannot stamp without looking', async () => {
  const storage = sharedStorage();
  const one = await loggingProcessFor(storage, 1);
  const two = await processFor(storage, 2);
  try {
    await one.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await one.db.refreshRegisteredServerCount();
    one.logged.length = 0;

    await two.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.7.0' });

    // Nothing here calls refreshRegisteredServerCount(); the heartbeat does.
    const stamped = await one.db.heartbeatServer();
    assert.ok(stamped > 0, 'the heartbeat still does its own job');
    assert.equal(
      one.logged.length, 1,
      'reading the count once at mount is the bug — the two must not be able to come apart'
    );
    assert.match(one.logged[0], /joined this database/);
  } finally {
    await one.sequelize.close();
    await two.sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Version lockstep — the precondition that makes an arbitrary responder safe
// ---------------------------------------------------------------------------

test('one server on its own is always in lockstep with itself', async () => {
  const { db, sequelize } = await processFor(sharedStorage(), 1);
  try {
    await db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });

    const result = await db.checkVersionLockstep('1.7.0');
    assert.equal(result.ok, true);
    assert.equal(result.checked, 0, 'its own row is not another server, whatever version it holds');
  } finally {
    await sequelize.close();
  }
});

test('a live server on a different version fails the check and is named', async () => {
  const storage = sharedStorage();
  const old = await processFor(storage, 2);
  const fresh = await processFor(storage, 1);
  try {
    await old.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.6.0' });
    await old.db.setServerAlias(2, 'event');
    await fresh.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });

    const result = await fresh.db.checkVersionLockstep('1.7.0');
    assert.equal(result.ok, false);
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].serverID, 2);
    assert.equal(
      result.mismatches[0].suiteVersion, '1.6.0',
      'the message has to name both versions, so the row has to come back whole'
    );
    assert.equal(result.mismatches[0].alias, 'event');
  } finally {
    await old.sequelize.close();
    await fresh.sequelize.close();
  }
});

test('a stale row on a different version does not refuse the mount', async () => {
  const storage = sharedStorage();
  const old = await processFor(storage, 2);
  const fresh = await processFor(storage, 1);
  try {
    await old.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.6.0' });
    await fresh.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });
    await makeStale(fresh.db, 2);

    const result = await fresh.db.checkVersionLockstep('1.7.0');
    assert.equal(
      result.ok, true,
      'a stopped server writes nothing, and using the registered count here would refuse every mount ' +
      'after an upgrade until the old rows were forgotten by hand'
    );
  } finally {
    await old.sequelize.close();
    await fresh.sequelize.close();
  }
});

test('a null version on either side is unknown, not different', async () => {
  const storage = sharedStorage();
  const other = await processFor(storage, 2);
  const mine = await processFor(storage, 1);
  try {
    await other.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: null });
    await mine.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });

    assert.equal(
      (await mine.db.checkVersionLockstep('1.7.0')).ok, true,
      'every version of this suite records the field, so a null is a hand-edited row, not an old process'
    );
    assert.equal(
      (await mine.db.checkVersionLockstep(null)).ok, true,
      'refusing when this process cannot state its own version would refuse on an absence of evidence'
    );
  } finally {
    await other.sequelize.close();
    await mine.sequelize.close();
  }
});

test('every disagreeing server is reported, not just the first', async () => {
  const storage = sharedStorage();
  const a = await processFor(storage, 2);
  const b = await processFor(storage, 3);
  const mine = await processFor(storage, 1);
  try {
    await a.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.6.0' });
    await b.db.registerServer({ server: fakeServer({ rconPort: 21116 }), suiteVersion: '1.5.0' });
    await mine.db.registerServer({ server: fakeServer(), suiteVersion: '1.7.0' });

    const result = await mine.db.checkVersionLockstep('1.7.0');
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.mismatches.map((r) => r.serverID).sort(), [2, 3],
      'naming one of two leaves an operator to discover the second after the first is fixed'
    );
  } finally {
    await a.sequelize.close();
    await b.sequelize.close();
    await mine.sequelize.close();
  }
});

test('a mismatch blocks a consumer plugin through the same gate a collision uses', async () => {
  const plugin = pluginWithS3(
    'this install is on 1.7.0 and event on 1.6.0 is live on this database — every process in a ' +
    'community must run the same suite version'
  );

  await assert.rejects(
    () => plugin.mount(),
    /must run the same suite version/,
    'the older process writes against a schema it does not know about; that is not a degraded state to limp along in'
  );
  assert.notEqual(plugin.mounted, true);
});

/** A real S³ instance with its DB service mounted against `storage`. */
async function s3ProcessFor(storage, serverID) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  const plugin = new SlackersSquadServices(
    {
      id: serverID,
      on: () => {},
      removeListener: () => {},
      options: { host: '10.0.0.1', queryPort: 27165, rconPort: 21114 }
    },
    { database: 'sqlite', discordClient: null, stderrDiagnostics: 'off' },
    { sqlite: sequelize }
  );
  await plugin.prepareToMount();
  await plugin.db.mount();
  return { plugin, sequelize };
}

test('S³ turns a mismatch into the same mount refusal a fingerprint collision produces', async () => {
  const storage = sharedStorage();
  const other = await processFor(storage, 2);
  const { plugin, sequelize } = await s3ProcessFor(storage, 1);
  try {
    await other.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '0.0.1-ancient' });
    await other.db.setServerAlias(2, 'event');

    await plugin._claimServerIdentity();

    assert.equal(plugin.versionLockstep.ok, false);
    assert.match(
      plugin.serverIdentityBlocked, /0\.0\.1-ancient/,
      'the refusal has to name both versions, or an operator cannot tell which process is the odd one'
    );
    assert.match(plugin.serverIdentityBlocked, /event/, 'and which server disagrees');
    assert.match(plugin.serverIdentityBlocked, /same suite version/);
  } finally {
    await other.sequelize.close();
    await sequelize.close();
  }
});

test('a fingerprint collision keeps its own reason; the version check does not run', async () => {
  const storage = sharedStorage();
  const squatter = await processFor(storage, 1);
  const { plugin, sequelize } = await s3ProcessFor(storage, 1);
  try {
    // Same id, different port, stamped seconds ago, and on another version —
    // both refusals apply, and only the more specific one should be reported.
    await squatter.db.registerServer({
      server: fakeServer({ rconPort: 29999 }),
      suiteVersion: '0.0.1-ancient'
    });

    await plugin._claimServerIdentity();

    assert.match(plugin.serverIdentityBlocked, /another process is live/);
    assert.equal(
      plugin.versionLockstep, null,
      'a collision is the more specific problem; running the version check too would send the operator after the wrong one'
    );
  } finally {
    await squatter.sequelize.close();
    await sequelize.close();
  }
});

test('matching versions leave the mount alone', async () => {
  const storage = sharedStorage();
  const other = await processFor(storage, 2);
  const { plugin, sequelize } = await s3ProcessFor(storage, 1);
  try {
    await other.db.registerServer({
      server: fakeServer({ rconPort: 21115 }),
      suiteVersion: SlackersSquadServices.version
    });

    await plugin._claimServerIdentity();

    assert.equal(plugin.versionLockstep.ok, true);
    assert.equal(plugin.serverIdentityBlocked, null, 'a matched pair is the ordinary case and must be silent');
  } finally {
    await other.sequelize.close();
    await sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Shared Discord channels
// ---------------------------------------------------------------------------

test('a channel nobody else declares has no sharers, so the guards built on it are inert', async () => {
  const storage = sharedStorage();
  const only = await processFor(storage, 1);
  try {
    await only.db.registerServer({ server: fakeServer(), suiteVersion: '1.0.0' });
    await only.db.recordChannelBinding('switchReporting', '999000111');

    assert.deepEqual(
      await only.db.getChannelSharers('switchReporting', '999000111'), [],
      'a server must not find ITSELF sharing a channel, or every backfill on a single-server install refuses'
    );
  } finally {
    await only.sequelize.close();
  }
});

test('two servers pointing one purpose at one channel find each other', async () => {
  const storage = sharedStorage();
  const first = await processFor(storage, 1);
  const second = await processFor(storage, 2);
  try {
    await first.db.registerServer({ server: fakeServer(), suiteVersion: '1.0.0' });
    await second.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.0.0' });
    await second.db.setServerAlias(2, 'event');

    await first.db.recordChannelBinding('switchReporting', '999000111');
    await second.db.recordChannelBinding('switchReporting', '999000111');

    const sharers = await first.db.getChannelSharers('switchReporting', '999000111');
    assert.deepEqual(sharers, [{ serverID: 2, alias: 'event' }]);

    // A different purpose on the same channel id is a different question.
    assert.deepEqual(await first.db.getChannelSharers('eloReporting', '999000111'), []);
    // And so is the same purpose somewhere else.
    assert.deepEqual(await first.db.getChannelSharers('switchReporting', '222333444'), []);
  } finally {
    await second.sequelize.close();
    await first.sequelize.close();
  }
});

test('a second binding in the same boot does not erase the first', async () => {
  const storage = sharedStorage();
  const first = await processFor(storage, 1);
  const second = await processFor(storage, 2);
  try {
    await first.db.registerServer({ server: fakeServer(), suiteVersion: '1.0.0' });
    await second.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.0.0' });

    // Two plugins in one process, binding two channels one after the other.
    await second.db.recordChannelBinding('switchReporting', '999000111');
    await second.db.recordChannelBinding('eloReporting', '222333444');

    assert.equal((await first.db.getChannelSharers('switchReporting', '999000111')).length, 1,
      'the earlier binding must survive the later one');
    assert.equal((await first.db.getChannelSharers('eloReporting', '222333444')).length, 1);
  } finally {
    await second.sequelize.close();
    await first.sequelize.close();
  }
});

test('unbinding a channel clears the sharer rather than leaving a stale one', async () => {
  const storage = sharedStorage();
  const first = await processFor(storage, 1);
  const second = await processFor(storage, 2);
  try {
    await first.db.registerServer({ server: fakeServer(), suiteVersion: '1.0.0' });
    await second.db.registerServer({ server: fakeServer({ rconPort: 21115 }), suiteVersion: '1.0.0' });

    await second.db.recordChannelBinding('switchReporting', '999000111');
    assert.equal((await first.db.getChannelSharers('switchReporting', '999000111')).length, 1);

    // The neighbour's operator removes channelID from their config.
    await second.db.recordChannelBinding('switchReporting', null);
    assert.deepEqual(await first.db.getChannelSharers('switchReporting', '999000111'), [],
      'a channel nobody points at any more is not shared');
  } finally {
    await second.sequelize.close();
    await first.sequelize.close();
  }
});

test('channel bindings do not disturb the community options recorded beside them', async () => {
  const storage = sharedStorage();
  const only = await processFor(storage, 1);
  try {
    await only.db.registerServer({ server: fakeServer(), suiteVersion: '1.0.0' });
    await only.db.recordCommunityOptions('switch', { maxSwitchTokens: 3 });
    await only.db.recordChannelBinding('switchReporting', '999000111');

    const [row] = await only.db.getRegisteredServers();
    const stored = JSON.parse(row.communityOptions);
    assert.equal(stored.maxSwitchTokens, 3, 'the binding must not overwrite a declared option key');
    assert.equal(stored.channels.switchReporting, '999000111');

    // And the summary that compares servers must not read the reserved
    // sub-object as a disagreement over a community setting.
    const summary = await only.db.getCommunityOptionSummary();
    assert.equal(
      JSON.stringify(summary).includes('999000111'), false,
      'a channel id is not a community option and must not surface as one'
    );
  } finally {
    await only.sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Two-step confirmations
// ---------------------------------------------------------------------------

/**
 * A plugin with the base class's confirmation machinery and nothing else.
 *
 * The registry is faked rather than mounted because every case below turns on
 * one number — how many servers are registered — and standing a second SQLite
 * process up to produce it would test the registry again instead of the thing
 * these cases are about.
 *
 * The label is published through the ASSEMBLY copy of the label module, not
 * this file's import of it. They are two module objects, and the base
 * class under test reads the one beside it.
 */
function confirmable({ servers = 1, label = null, serverID = 1, live = {} } = {}) {
  const plugin = Object.create(S3PluginBase.prototype);
  plugin._pending = new PendingActions();
  plugin._s3db = {
    getKnownServerCount: () => servers,
    getServerID: () => serverID
  };
  plugin._s3 = live;
  plugin.localize = (key, vars = {}) =>
    `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('|')})`;
  shippedLabel.publishServerLabel(label);
  return plugin;
}

/** Services that read as a live round, for the context line. */
function liveServices({ players = 42, startedMinutesAgo = 20, layer = 'Gorodok RAAS v1', seeding = false } = {}) {
  return {
    players: {
      isReady: () => true,
      getAllPlayers: () => Array.from({ length: players }, (_, i) => ({ eosID: String(i) }))
    },
    gameState: {
      isReady: () => true,
      getRoundStartTime: () => Date.now() - startedMinutesAgo * 60000,
      getLayerDisplayName: () => layer,
      isSeedMode: () => seeding
    }
  };
}

test('a token finds its own entry, and the wrong kind is not it', () => {
  const store = new PendingActions();
  const first = store.arm('scramble', ['now']);
  const second = store.arm('scramble', ['elo']);

  assert.notEqual(first.token, second.token, 'two live arms must be distinguishable');

  // Arming again displaces nothing. An admin reading the first token off
  // their screen is holding something that still works.
  assert.deepEqual(store.take(first.token, 'scramble'), { status: PENDING.OK, payload: ['now'] });
  assert.deepEqual(store.take(second.token, 'scramble'), { status: PENDING.OK, payload: ['elo'] });
  assert.equal(store.take(first.token, 'scramble').status, PENDING.UNKNOWN, 'a token is spent once');
});

test('a token armed for one kind does not confirm another', () => {
  const store = new PendingActions();
  const { token } = store.arm('scramble', ['now']);
  assert.equal(store.take(token, 'eloReset').status, PENDING.UNKNOWN);
  assert.equal(store.take(token, 'scramble').status, PENDING.OK, 'and the real one still works');
});

test('nothing armed and armed-then-expired are different answers', () => {
  let clock = 1_000_000;
  const store = new PendingActions({ now: () => clock });

  assert.equal(store.takeNewest('scramble').status, PENDING.NONE);

  const { token } = store.arm('scramble', ['now'], { ttlMs: 60_000 });
  clock += 60_001;
  assert.equal(store.takeNewest('scramble').status, PENDING.EXPIRED);
  assert.equal(store.take(token, 'scramble').status, PENDING.UNKNOWN, 'and the token is gone with it');
});

test('the live context leads with the facts that separate two servers', () => {
  const context = readLiveContext(liveServices({ players: 78, startedMinutesAgo: 22 }));
  assert.equal(context.status, CONTEXT.OK);

  const line = renderLiveContext(context, (key, vars) => `${key}:${JSON.stringify(vars)}`);
  const vars = JSON.parse(line.slice(line.indexOf(':') + 1));
  assert.equal(vars.players, '78');
  assert.equal(line.startsWith('s3LiveContext.line'), true);

  // The layer is stale at NEW_GAME and returns the previous round's, so it is
  // supporting detail and must not be the fact a reader hits first.
  assert.equal(
    Object.keys(vars).indexOf('layer') > Object.keys(vars).indexOf('players'),
    true,
    'player count before layer'
  );
});

test('seeding leads when it applies, because that is the question being asked', () => {
  const context = readLiveContext(liveServices({ players: 6, seeding: true }));
  const line = renderLiveContext(context, (key) => key);
  assert.equal(line, 's3LiveContext.seedingLine');
});

test('no player service is no context, and no context is no confirmation', () => {
  assert.equal(readLiveContext(null).status, CONTEXT.NO_SERVICES);
  assert.equal(readLiveContext({ players: { isReady: () => false } }).status, CONTEXT.NOT_READY);

  const plugin = confirmable({ servers: 2, label: 'main', live: { players: { isReady: () => false } } });
  const arm = plugin.armConfirmation({ kind: 'scramble', payload: ['now'], command: '!scramble confirm' });

  assert.equal(arm.armed, false, 'a prompt that cannot say what it changes is not a confirmation');
  assert.equal(arm.token, null);
  assert.equal(arm.refusal.startsWith('s3Confirm.contextUnavailable'), true);
  assert.equal(plugin.hasConfirmation('scramble'), false, 'and it must not have armed anyway');
});

test('one registered server arms with no token, no lines and no title change', () => {
  const plugin = confirmable({ servers: 1, label: 'main', live: liveServices() });

  const arm = plugin.armConfirmation({ kind: 'scramble', payload: ['now'], command: '!scramble confirm' });
  assert.equal(arm.armed, true);
  assert.equal(arm.token, null, 'a community of one has nothing to disambiguate');
  assert.deepEqual(arm.lines, [], 'so the prompt reads exactly as it did before');

  assert.equal(plugin.serverDescriptor(), null);
  assert.equal(plugin.titleWithServer('Scramble Completed'), 'Scramble Completed');
  assert.equal(plugin.serverFileTag(), '');

  // And the bare confirm still finds it.
  assert.deepEqual(plugin.takeConfirmation('scramble'), { status: PENDING.OK, payload: ['now'] });
});

test('a second server puts the server in the token, the lines and the title', () => {
  const plugin = confirmable({ servers: 2, label: 'Northern Lights #1', live: liveServices() });

  const arm = plugin.armConfirmation({ kind: 'scramble', payload: ['now'], command: '!scramble confirm', ttlMs: 60_000 });
  assert.equal(arm.armed, true);
  assert.match(arm.token, /^[0-9a-f]{4}$/);
  assert.equal(arm.lines.length, 3);
  assert.equal(arm.lines[0].includes('server=Northern Lights #1'), true);
  assert.equal(arm.lines[1].includes(`token=${arm.token}`), true);
  assert.equal(arm.lines[2].includes('seconds=60'), true);

  assert.equal(plugin.titleWithServer('Scramble Completed'), 'Northern Lights #1 — Scramble Completed');
  assert.equal(plugin.serverFileTag(), '-northern-lights-1');
});

test('a labelless second server still names itself, by id', () => {
  const plugin = confirmable({ servers: 2, label: null, serverID: 2, live: liveServices() });
  assert.equal(plugin.serverDescriptor(), '#2');
  assert.equal(plugin.titleWithServer('Elo Reset'), '#2 — Elo Reset');
  assert.equal(plugin.serverFileTag(), '-2');
});

test('a community mutation names its radius rather than one server\'s round', () => {
  // Nothing live at all: a community confirmation must not depend on it,
  // because the round it would describe is not what the command touches.
  const plugin = confirmable({ servers: 3, label: 'main', live: {} });

  const arm = plugin.armConfirmation({
    kind: 'eloReset', payload: true, command: '!elo reset confirm', radius: 'community'
  });

  assert.equal(arm.armed, true, 'an unreadable round is not a reason to refuse a community wipe');
  assert.equal(arm.lines[0].startsWith('s3Confirm.targetCommunity'), true);
  assert.equal(arm.lines[0].includes('count=3'), true);
});

test('the process holding the token replies; the others wait and then lose', async () => {
  const claims = [];
  const db = {
    getKnownServerCount: () => 2,
    getServerID: () => 1,
    claimDiscordMessage: async (key) => {
      claims.push(key);
      return { claimed: claims.filter((k) => k === key).length === 1, outcome: 'won' };
    }
  };

  const holder = confirmable({ servers: 2, label: 'main' });
  holder._s3db = db;
  const other = confirmable({ servers: 2, label: 'event' });
  other._s3db = db;

  assert.equal(await holder.claimConfirmReply('m1', true), true, 'the holder acted, so it must say so');
  assert.equal(claims[0], 'discord:m1', 'and it claims, to keep the others quiet');

  assert.equal(await other.claimConfirmReply('m1', false), false, 'a rejection must not land over a success');
});

test('a token nobody holds is rejected exactly once', async () => {
  let taken = false;
  const db = {
    getKnownServerCount: () => 2,
    getServerID: () => 1,
    claimDiscordMessage: async () => {
      const won = !taken;
      taken = true;
      return { claimed: won, outcome: won ? 'won' : 'lost' };
    }
  };

  const first = confirmable({ servers: 2, label: 'main' });
  first._s3db = db;
  const second = confirmable({ servers: 2, label: 'event' });
  second._s3db = db;

  assert.equal(await first.claimConfirmReply('m2', false), true);
  assert.equal(await second.claimConfirmReply('m2', false), false, 'one reply, not one per server');
});

test('a single-server install never reaches the claim at all', async () => {
  const plugin = confirmable({ servers: 1, label: 'main' });
  plugin._s3db.claimDiscordMessage = async () => { throw new Error('must not be called'); };
  assert.equal(await plugin.claimConfirmReply('m3', false), true);
});

test('a confirm carrying a token is classified as one, and a bare one is not', () => {
  assert.equal(scopeForTeamBalancerCommand('scramble', ['confirm']).scope, 'server-mutating');
  assert.equal(scopeForTeamBalancerCommand('scramble', ['confirm', 'a1b2']).scope, 'token-confirm');

  assert.equal(scopeForEloCommand('reset', ['reset', 'confirm']).scope, 'community-mutating');
  assert.equal(scopeForEloCommand('reset', ['reset', 'confirm', 'a1b2']).scope, 'token-confirm');
  assert.equal(scopeForEloCommand('restore', ['restore', 'confirm', 'a1b2']).scope, 'token-confirm');
  assert.equal(scopeForEloCommand('restore', ['restore']).scope, 'community-mutating');
  assert.equal(scopeForEloCommand('restore', ['restore', 'confirm']).scope, 'community-mutating');

  // A four-character player name is not a token, and only becomes one when
  // an admin also typed the word that means it.
  assert.equal(scopeForEloCommand('reset', ['reset', 'beef']).scope, 'community-mutating');
});

test('the scramble round trip, on a real plugin, with and without a neighbour', async () => {
  const server = { on: () => {}, removeListener: () => {}, players: [], squads: [] };
  const connectors = { discord: { on: () => {} } };
  const tb = new TeamBalancer(server, { requireScrambleConfirmation: true }, connectors);
  // Echoes its variables, because the token an admin would read off the
  // prompt only exists inside them.
  tb.localize = (key, vars = {}) =>
    `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('|')})`;

  // ── One server: the field it has always used, and the bare word ──
  const solo = tb._armScrambleConfirmation(['now']);
  assert.deepEqual(solo.lines, []);
  assert.equal(typeof tb.scrambleConfirmation.timestamp, 'number', 'the slot stays a real, mutable object');
  assert.deepEqual(tb._takeScrambleConfirmation(null, true), { status: 'ok', args: ['now'] });

  // ── Two servers: the Discord confirm needs the token ──
  tb._s3db = { getKnownServerCount: () => 2, getServerID: () => 1 };
  tb._s3 = liveServices();
  shippedLabel.publishServerLabel('event');
  try {
    const armed = tb._armScrambleConfirmation(['elo', 'now']);
    assert.equal(armed.lines.length, 3);
    const token = armed.lines[1].match(/[0-9a-f]{4}/)[0];

    assert.equal(tb._takeScrambleConfirmation('0000', true).status, 'unknown', 'a token nobody minted matches nothing');
    assert.deepEqual(tb._takeScrambleConfirmation(token, true), { status: 'ok', args: ['elo', 'now'] });
    assert.equal(tb.scrambleConfirmation, null, 'and taking it clears the in-game slot too');

    // ── The cross-arm case: armed here, confirmed from Discord ──
    const crossArm = tb._armScrambleConfirmation(['now']);
    const crossToken = crossArm.lines[1].match(/[0-9a-f]{4}/)[0];
    assert.deepEqual(tb._takeScrambleConfirmation(crossToken, true), { status: 'ok', args: ['now'] });
  } finally {
    shippedLabel.publishServerLabel(null);
  }
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  await run();
} finally {
  cleanAssembly(ASSEMBLY);
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
}
