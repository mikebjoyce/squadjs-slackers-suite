/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   DISCORD ROUTING — WHICH SERVER ANSWERS, AND HOW MANY TIMES  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Two Squad servers share one Discord server, so every `!s3`, `!switch`,
 * `!teambalancer`, `!scramble` and `!elo` typed in an admin channel arrives at
 * every process. Without a gate in front of the verb dispatch, every process
 * answers: two identical status embeds, two scrambles of two different games
 * off one word, two imports of one attached file.
 *
 * `s3/utils/s3-discord-routing.js` is that gate, and the properties it has to
 * hold are countable rather than aesthetic:
 *
 *   inertness      One registered server behaves exactly as it did before any
 *                  of this existed — no claim taken, no reply changed, no
 *                  selector required. That is the zero-delta guarantee, and it
 *                  is the property most likely to be broken by accident later.
 *   exactly one    A community command produces one reply, and so does a
 *                  refusal. A refusal arriving once per process is the failure
 *                  mode that makes the gate worse than no gate.
 *   exactly N      A server-scoped read produces one reply per server, each
 *                  accurate about itself. The claim there buys idempotence,
 *                  not exclusivity, which is why the key carries the server id.
 *   fail open      A claim that fails because the database did not answer must
 *                  reply anyway. A duplicate reply is visible and readable; a
 *                  channel that silently produces nothing is not.
 *
 * ─── WHY THE SELECTOR PARSING GETS ITS OWN SECTION ───────────────
 *
 * The stripping is load-bearing rather than tidy. Several verbs treat every
 * remaining token as a player name, and `handleDiscordScrambleCommand()`
 * refuses anything outside a six-word whitelist — so a `--server main` left in
 * the list does not get ignored, it makes the command fail. And the word
 * `server` appears inside `--all-servers` and `--remap-server`, so a parser
 * that matches on the word rather than on the whole flag eats the token after
 * either one.
 *
 * Category: 1 (no external services — SQLite only)
 * Run:    node s3/testing/test-discord-routing.js
 */

'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Sequelize } from 'sequelize';

import DBService, { LOCK_KINDS, LOCK_TTL_MS } from '../utils/db-service.js';
import { localize } from '../utils/s3-i18n.js';
import {
  COMMAND_SCOPE,
  ROUTING,
  REFUSAL,
  parseServerSelector,
  describeCandidates,
  routeDiscordCommand,
  buildRoutingRefusalEmbed
} from '../utils/s3-discord-routing.js';

import { scopeForS3Command } from '../utils/s3-commands.js';
import { scopeForSwitchCommand } from '../../switch/utils/switch-commands.js';
import { scopeForEloCommand } from '../../elo-tracker/utils/elo-discord.js';
import { buildAssembly, cleanAssembly } from './plugin-assembly.js';

// team-balancer.js imports `./s3-plugin-base.js` as a flat sibling, which only
// resolves in the layout install.cjs produces — so its scope table is reached
// through an assembly rather than out of the source tree, the same way every
// other suite that needs a real consumer plugin class reaches one.
const ASSEMBLY = buildAssembly('.tmp-discord-routing');
const { scopeForTeamBalancerCommand } = await import(
  pathToFileURL(path.join(ASSEMBLY, 'plugins', 'team-balancer.js')).href
);


// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

// Each Sequelize instance registers its own unhandledRejection listener, and
// these cases stand up two per multi-server fixture. The default ceiling of
// ten is a leak heuristic for long-lived processes; here it just prints a
// warning in the middle of the results.
process.setMaxListeners(0);

let passed = 0;
let failed = 0;
const tests = [];
const tempDirs = [];
const openConnections = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(70));
  console.log('Discord Routing  (selector, claim election, refusals)');
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

  for (const sequelize of openConnections) {
    try { await sequelize.close(); } catch { /* already closed */ }
  }
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  cleanAssembly(ASSEMBLY);

  console.log('');
  console.log('─'.repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log('─'.repeat(70));

  if (failed > 0) process.exitCode = 1;
}


// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A file-backed SQLite database. `:memory:` gives every connection its own
 * database, and half of what is under test here is two processes disagreeing
 * about one row.
 */
function sharedStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-routing-'));
  tempDirs.push(dir);
  return path.join(dir, 'routing.sqlite');
}

/** One process's view of the shared database, mounted and registered. */
async function processFor(storage, serverID, { register = true, alias = null } = {}) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  openConnections.push(sequelize);

  const db = new DBService({
    sequelize,
    serverID,
    verboseLogger: () => {},
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();

  if (register) {
    await db.registerServer({
      server: { options: { host: `10.0.0.${serverID}`, queryPort: 27165, rconPort: 21114 }, serverName: `Server ${serverID}` },
      suiteVersion: '1.7.0'
    });
    if (alias) await db.setServerAlias(serverID, alias);
  }
  return db;
}

/**
 * Two registered servers on one database, each with its own DBService.
 *
 * The heartbeat at the end is not decoration. `getKnownServerCount()` is what
 * the gate reads first, and it is populated by `heartbeatServer()` — a process
 * that registered while it was alone still believes it is alone until the next
 * beat, which is a real behaviour and not one these cases are testing.
 */
async function twoServers({ aliases = ['main', 'second'] } = {}) {
  const storage = sharedStorage();
  const one = await processFor(storage, 1, { alias: aliases[0] });
  const two = await processFor(storage, 2, { alias: aliases[1] });
  await one.heartbeatServer();
  await two.heartbeatServer();
  return { one, two };
}

/** How many lock rows exist, and under what keys. */
async function lockKeys(db) {
  const rows = await db.LocksModel.findAll({ raw: true });
  return rows.map((r) => r.lockKey).sort();
}

let nextMessageID = 100000000000000000n;
/** A fresh Discord snowflake, so no two cases contend the same claim key. */
function messageID() {
  nextMessageID += 1n;
  return String(nextMessageID);
}


// ---------------------------------------------------------------------------
// The selector grammar
// ---------------------------------------------------------------------------

test('every selector spelling yields the token and leaves nothing behind', () => {
  for (const argv of [
    ['status', '--server', 'main'],
    ['status', '-s', 'main'],
    ['status', '--server=main'],
    ['status', '-s=main'],
    // `--s` is the abbreviation an operator guesses once `--server` is known.
    // It used to fall through as a positional argument, so `check slacker --s 2`
    // looked up a player called `--s`, answered from every server, and reported
    // nothing wrong — the one outcome worse than refusing.
    ['status', '--s', 'main'],
    ['status', '--s=main']
  ]) {
    const parsed = parseServerSelector(argv);
    assert.equal(parsed.token, 'main', `token not read from ${argv.join(' ')}`);
    assert.equal(parsed.present, true);
    assert.equal(parsed.missingValue, false);
    assert.deepEqual(parsed.args, ['status'], `residue left behind by ${argv.join(' ')}`);
  }
});

test('`--s` does not swallow a neighbouring flag that merely starts with it', () => {
  // The whole-flag match is what keeps `--s` from behaving like a prefix. If it
  // ever became one, `--simulate` and `--skip-elo` would both parse as
  // selectors and eat the token after them.
  const parsed = parseServerSelector(['scramble', '--simulate', '--skip-elo', '--s', '2']);
  assert.equal(parsed.token, '2');
  assert.deepEqual(parsed.args, ['scramble', '--simulate', '--skip-elo'],
    'a flag beginning with `--s` was taken for the selector');
});

test('`--all-servers` and `--server` survive each other in one command line', () => {
  // The checklist asks for both in one line specifically, because a prefix
  // match on `--server` eats the word after `--all-servers` and the failure
  // presents as a mysteriously missing export flag rather than as a parse bug.
  const parsed = parseServerSelector(['db', 'export', '--all-servers', '--server', 'main']);
  assert.equal(parsed.token, 'main');
  assert.deepEqual(parsed.args, ['db', 'export', '--all-servers'],
    '`--all-servers` did not survive the selector strip');
});

test('`--remap-server` keeps its own value', () => {
  const parsed = parseServerSelector(['db', 'import', '--remap-server', '2']);
  assert.equal(parsed.present, false, '`--remap-server` was read as a selector');
  assert.equal(parsed.token, null);
  assert.deepEqual(parsed.args, ['db', 'import', '--remap-server', '2']);
});

test('a repeated selector keeps the last one', () => {
  const parsed = parseServerSelector(['status', '--server', 'main', '-s', 'second']);
  assert.equal(parsed.token, 'second');
  assert.deepEqual(parsed.args, ['status']);
});

test('a selector with no value is a missing value, not an unknown server', () => {
  const trailing = parseServerSelector(['status', '--server']);
  assert.equal(trailing.missingValue, true, 'a trailing `--server` read as valued');
  assert.equal(trailing.token, null);

  // `--server --all` is an admin who lost a word. Taking `--all` as the alias
  // refuses with "no such server --all", which sends them looking for the
  // wrong problem — and `--all` is a flag they did type, so it survives.
  const swallowed = parseServerSelector(['db', 'export', '--server', '--all']);
  assert.equal(swallowed.missingValue, true);
  assert.equal(swallowed.token, null, 'a flag was accepted as a server name');
  assert.deepEqual(swallowed.args, ['db', 'export', '--all'],
    'the flag after a value-less selector was eaten');
});

test('everything that is not a selector comes back in order, with its case', () => {
  const parsed = parseServerSelector(['clear', 'Some.Player_Name', '--server', 'MAIN', '5']);
  assert.deepEqual(parsed.args, ['clear', 'Some.Player_Name', '5']);
  assert.equal(parsed.token, 'MAIN', 'the token was case-folded before resolution could see it');
});

test('a candidate listing shows what separates the candidates, not what they share', () => {
  // The listing is what an admin reads when a `--server` token missed. Ninety
  // characters of advertisement per row buries the one thing being asked for,
  // and what counts as advertisement is decided by comparing the candidates
  // rather than by assuming the shape of any one of them.
  const listing = describeCandidates([
    { serverID: 1, alias: 'northern', serverName: 'Northern Lights #1 | Teamwork Oriented | Beginner Friendly | discord.gg/northernlightsgaming' },
    { serverID: 2, alias: 'northern-2', serverName: 'Northern Lights #2 | Teamwork Oriented | Beginner Friendly | discord.gg/northernlightsgaming' }
  ]);

  assert.match(listing, /Northern Lights #1/);
  assert.match(listing, /Northern Lights #2/);
  assert.ok(!listing.includes('discord.gg'), 'a line on both rows separates nothing');
});

test('a candidate whose name says nothing the others do not is listed without one', () => {
  // Two servers advertising the same string. The alias and the id still tell
  // them apart; a name repeated on both rows would only look like it did.
  const listing = describeCandidates([
    { serverID: 1, alias: 'northern', serverName: 'Slackers | EU' },
    { serverID: 2, alias: 'northern-2', serverName: 'Slackers | EU' }
  ]);

  assert.ok(!listing.includes('Slackers'), 'a name on every row is not a label');
  assert.match(listing, /`northern`/);
  assert.match(listing, /`northern-2`/);
});

test('describeCandidates names a server by its alias, falling back to its id', () => {
  const listing = describeCandidates([
    { serverID: 1, alias: 'main', serverName: 'Slackers #1' },
    { serverID: 2, alias: null, serverName: null }
  ]);
  assert.match(listing, /`main` \(id 1\) — Slackers #1/);
  assert.match(listing, /`2` \(id 2\)/);
});


// ---------------------------------------------------------------------------
// Inertness — the zero-delta guarantee
// ---------------------------------------------------------------------------

test('one registered server acts on every scope and takes no claim', async () => {
  const db = await processFor(sharedStorage(), 1);
  await db.heartbeatServer();

  for (const scope of Object.values(COMMAND_SCOPE)) {
    const verdict = await routeDiscordCommand({
      db, scope, args: ['status'], messageID: messageID(), command: '!s3 status'
    });
    assert.equal(verdict.routing, ROUTING.ACT, `${scope} did not act on a single-server install`);
    assert.equal(verdict.multiServer, false);
  }

  assert.deepEqual(await lockKeys(db), [],
    'a single-server install wrote lock rows for commands nobody was racing over');
});

test('a single-server install still strips a selector somebody typed', async () => {
  const db = await processFor(sharedStorage(), 1);
  await db.heartbeatServer();

  const verdict = await routeDiscordCommand({
    db,
    scope: COMMAND_SCOPE.SERVER_MUTATING,
    args: ['clear', 'SomePlayer', '--server', 'main'],
    messageID: messageID()
  });

  // Acting is the point — a lone server must not start refusing commands
  // because an admin typed a selector out of habit — but the strip still has
  // to happen or `clear` searches for a player called `--server`.
  assert.equal(verdict.routing, ROUTING.ACT);
  assert.deepEqual(verdict.args, ['clear', 'SomePlayer']);
});

test('no database at all is the single-server case by construction', async () => {
  const verdict = await routeDiscordCommand({
    db: null, scope: COMMAND_SCOPE.COMMUNITY_MUTATING, args: ['db', 'import'], messageID: messageID()
  });
  assert.equal(verdict.routing, ROUTING.ACT,
    'an install running without a database lost its admin surface');
});


// ---------------------------------------------------------------------------
// An explicit target decides everything
// ---------------------------------------------------------------------------

test('the named server acts and the other drops, with no claim between them', async () => {
  const { one, two } = await twoServers();
  const id = messageID();

  const opts = { scope: COMMAND_SCOPE.SERVER_MUTATING, args: ['off', '--server', 'main'], messageID: id };
  const a = await routeDiscordCommand({ db: one, ...opts });
  const b = await routeDiscordCommand({ db: two, ...opts });

  assert.equal(a.routing, ROUTING.ACT);
  assert.equal(b.routing, ROUTING.DROP);
  assert.deepEqual(a.args, ['off'], 'the selector reached the handler');
  assert.deepEqual(await lockKeys(one), [],
    'a targeted command took a claim it had nothing to race over');
});

test('a bare server id works as a target, because that is what the logs print', async () => {
  const { one, two } = await twoServers();
  const id = messageID();
  const opts = { scope: COMMAND_SCOPE.SERVER_READ, args: ['status', '--server', '2'], messageID: id };

  assert.equal((await routeDiscordCommand({ db: one, ...opts })).routing, ROUTING.DROP);
  assert.equal((await routeDiscordCommand({ db: two, ...opts })).routing, ROUTING.ACT);
});

test('an unknown server refuses once and drops once', async () => {
  const { one, two } = await twoServers();
  const id = messageID();
  const opts = { scope: COMMAND_SCOPE.SERVER_READ, args: ['status', '--server', 'nope'], messageID: id, command: '!switch status' };

  const verdicts = [
    await routeDiscordCommand({ db: one, ...opts }),
    await routeDiscordCommand({ db: two, ...opts })
  ];

  const refusals = verdicts.filter((v) => v.routing === ROUTING.REFUSE);
  assert.equal(refusals.length, 1, `expected exactly one refusal, got ${refusals.length}`);
  assert.equal(refusals[0].refusal, REFUSAL.UNKNOWN_SERVER);
  assert.equal(verdicts.filter((v) => v.routing === ROUTING.DROP).length, 1);
  assert.deepEqual(await lockKeys(one), [`discord:${id}`],
    'the refusal election did not run on the shared key');
});

test('an ambiguous token refuses rather than picking the first row', async () => {
  const { one } = await twoServers();
  // setServerAlias enforces distinctness, so two rows cannot legitimately
  // carry one alias. What is under test is the gate's handling of the
  // resolver's ambiguous verdict, not the resolver's ability to produce one —
  // test-server-registry.js owns that half.
  const rows = await one.getRegisteredServers();
  one.resolveServerToken = async () => ({ ambiguous: rows });

  const verdict = await routeDiscordCommand({
    db: one, scope: COMMAND_SCOPE.SERVER_READ, args: ['status', '--server', 'ma'], messageID: messageID()
  });

  assert.equal(verdict.routing, ROUTING.REFUSE);
  assert.equal(verdict.refusal, REFUSAL.AMBIGUOUS_SERVER);
  assert.equal(verdict.candidates.length, 2, 'the refusal did not carry both candidates');
});

test('a selector with no value refuses before anything is resolved', async () => {
  const { one, two } = await twoServers();
  const id = messageID();
  const opts = { scope: COMMAND_SCOPE.SERVER_READ, args: ['status', '--server'], messageID: id };

  const verdicts = [
    await routeDiscordCommand({ db: one, ...opts }),
    await routeDiscordCommand({ db: two, ...opts })
  ];
  const refusals = verdicts.filter((v) => v.routing === ROUTING.REFUSE);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].refusal, REFUSAL.SELECTOR_MISSING_VALUE);
});


// ---------------------------------------------------------------------------
// No selector — the claim election
// ---------------------------------------------------------------------------

test('a server-scoped read broadcasts: both act, each on its own key', async () => {
  const { one, two } = await twoServers();
  const id = messageID();
  const opts = { scope: COMMAND_SCOPE.SERVER_READ, args: ['status'], messageID: id };

  const a = await routeDiscordCommand({ db: one, ...opts });
  const b = await routeDiscordCommand({ db: two, ...opts });

  assert.equal(a.routing, ROUTING.ACT);
  assert.equal(b.routing, ROUTING.ACT, 'a broadcast read silenced one of the servers');
  assert.deepEqual(await lockKeys(one), [`discord:${id}:1`, `discord:${id}:2`],
    'the scoped keys did not carry the server id');
});

test('the scoped claim buys idempotence: the same server cannot answer twice', async () => {
  const { one } = await twoServers();
  const id = messageID();
  const opts = { db: one, scope: COMMAND_SCOPE.SERVER_READ, args: ['status'], messageID: id };

  assert.equal((await routeDiscordCommand(opts)).routing, ROUTING.ACT);
  assert.equal((await routeDiscordCommand(opts)).routing, ROUTING.DROP,
    'one server answered the same message twice');
});

test('a community read elects exactly one responder', async () => {
  const { one, two } = await twoServers();
  const id = messageID();
  const opts = { scope: COMMAND_SCOPE.COMMUNITY_READ, args: ['leaderboard'], messageID: id };

  const verdicts = [
    await routeDiscordCommand({ db: one, ...opts }),
    await routeDiscordCommand({ db: two, ...opts })
  ];
  assert.equal(verdicts.filter((v) => v.routing === ROUTING.ACT).length, 1);
  assert.equal(verdicts.filter((v) => v.routing === ROUTING.DROP).length, 1);
  assert.deepEqual(await lockKeys(one), [`discord:${id}`],
    'a community read claimed a per-server key and both processes answered');
});

test('a community mutation elects one responder too', async () => {
  const { one, two } = await twoServers();
  const id = messageID();
  const opts = { scope: COMMAND_SCOPE.COMMUNITY_MUTATING, args: ['db', 'import'], messageID: id };

  const verdicts = [
    await routeDiscordCommand({ db: one, ...opts }),
    await routeDiscordCommand({ db: two, ...opts })
  ];
  assert.equal(verdicts.filter((v) => v.routing === ROUTING.ACT).length, 1,
    'two processes imported the same attachment');
});

test('an unrouted server mutation refuses exactly once', async () => {
  const { one, two } = await twoServers();
  const id = messageID();
  const opts = { scope: COMMAND_SCOPE.SERVER_MUTATING, args: ['clear'], messageID: id, command: '!switch clear' };

  const verdicts = [
    await routeDiscordCommand({ db: one, ...opts }),
    await routeDiscordCommand({ db: two, ...opts })
  ];
  const refusals = verdicts.filter((v) => v.routing === ROUTING.REFUSE);
  assert.equal(refusals.length, 1, 'the refusal arrived once per process');
  assert.equal(refusals[0].refusal, REFUSAL.SELECTOR_REQUIRED);
  assert.equal(refusals[0].candidates.length, 2, 'the refusal did not list what to type instead');
});

test('selectorRequired turns a broadcast read into a single refusal', async () => {
  const { one, two } = await twoServers();
  const id = messageID();
  const opts = {
    scope: COMMAND_SCOPE.SERVER_READ, selectorRequired: true,
    args: ['explain'], messageID: id, command: '!switch explain'
  };

  const verdicts = [
    await routeDiscordCommand({ db: one, ...opts }),
    await routeDiscordCommand({ db: two, ...opts })
  ];
  assert.equal(verdicts.filter((v) => v.routing === ROUTING.REFUSE).length, 1);
  assert.equal(verdicts.filter((v) => v.routing === ROUTING.ACT).length, 0,
    'the seven-embed reply was rendered anyway');
});

test('a token confirm reaches every process and takes no claim', async () => {
  const { one, two } = await twoServers();
  const id = messageID();
  const opts = { scope: COMMAND_SCOPE.TOKEN_CONFIRM, args: ['confirm', '5aa567cd'], messageID: id };

  // Only the process that minted the token can act on it, and it is not
  // necessarily the one that would win a claim. Electing here hands the
  // confirm to a process that rejects it while the arming process never sees
  // it — an armed action that can never be confirmed.
  assert.equal((await routeDiscordCommand({ db: one, ...opts })).routing, ROUTING.ACT);
  assert.equal((await routeDiscordCommand({ db: two, ...opts })).routing, ROUTING.ACT);
  assert.deepEqual(await lockKeys(one), []);
});


// ---------------------------------------------------------------------------
// The claim primitive
// ---------------------------------------------------------------------------

test('the first claim wins and the second on the same key is lost', async () => {
  const { one, two } = await twoServers();
  const key = `discord:${messageID()}`;

  assert.deepEqual(await one.claimDiscordMessage(key), { claimed: true, outcome: 'won' });
  const second = await two.claimDiscordMessage(key);
  assert.equal(second.claimed, false);
  assert.equal(second.outcome, 'lost');
});

test('a database error fails OPEN — claimed, and labelled as unavailable', async () => {
  const db = await processFor(sharedStorage(), 1);
  db.LocksModel.create = async () => { throw new Error('connection reset by peer'); };

  const result = await db.claimDiscordMessage(`discord:${messageID()}`);
  assert.equal(result.claimed, true,
    'a connection blip was read as a lost race, which silences every responder at once');
  assert.equal(result.outcome, 'unavailable');
  assert.match(result.error, /connection reset/);
});

test('a missing lock table is unavailable, not lost', async () => {
  const db = await processFor(sharedStorage(), 1);
  db.LocksModel = null;

  const result = await db.claimDiscordMessage(`discord:${messageID()}`);
  assert.equal(result.claimed, true);
  assert.equal(result.outcome, 'unavailable');
});

test('the gate answers anyway when the claim is unavailable', async () => {
  const { one, two } = await twoServers();
  const id = messageID();
  one.LocksModel.create = async () => { throw new Error('connection reset by peer'); };
  two.LocksModel.create = async () => { throw new Error('connection reset by peer'); };

  const opts = { scope: COMMAND_SCOPE.COMMUNITY_READ, args: ['status'], messageID: id };
  const a = await routeDiscordCommand({ db: one, ...opts });
  const b = await routeDiscordCommand({ db: two, ...opts });

  // Two replies, which is the deliberate cost. Silence would look like the
  // bot being down, and nothing in the channel would say otherwise.
  assert.equal(a.routing, ROUTING.ACT);
  assert.equal(b.routing, ROUTING.ACT);
});

test('a claim is never stolen from an expired row', async () => {
  // A message snowflake is never legitimately contended twice, so the only
  // thing an expired claim can mean is that this process is looking at the
  // same message again — the case the row exists to stop.
  const db = await processFor(sharedStorage(), 1);
  const key = `discord:${messageID()}`;

  await db.claimDiscordMessage(key, { ttlMs: -1000 });
  const second = await db.claimDiscordMessage(key);
  assert.equal(second.claimed, false, 'an expired claim row was stolen and the reply duplicated');
  assert.equal(second.outcome, 'lost');
});


// ---------------------------------------------------------------------------
// The reaper
// ---------------------------------------------------------------------------

test('the reaper deletes on each row\'s own expiry, and spares a live migration lock', async () => {
  const db = await processFor(sharedStorage(), 1);

  const expired = `discord:${messageID()}`;
  const live = `discord:${messageID()}`;
  await db.claimDiscordMessage(expired, { ttlMs: -1000 });
  await db.claimDiscordMessage(live, { ttlMs: LOCK_TTL_MS[LOCK_KINDS.CLAIM] });

  // A migration holds its lock for minutes at a time. A reaper written against
  // one global age threshold instead of per-row expiry deletes it mid-run,
  // and a second process then starts migrating the same schema.
  const acquired = await db.acquireAdvisoryLock('migration:test', { kind: LOCK_KINDS.MIGRATION });
  assert.ok(acquired, 'the fixture could not take the migration lock it means to protect');

  const removed = await db.reapExpiredLocks();
  assert.equal(removed, 1, `expected exactly one reap, got ${removed}`);

  const remaining = await lockKeys(db);
  assert.ok(remaining.includes(live), 'a live claim was reaped');
  assert.ok(remaining.includes('migration:test'), 'the reaper deleted a migration lock still in use');
  assert.ok(!remaining.includes(expired), 'the expired claim survived');
});


// ---------------------------------------------------------------------------
// Refusal rendering
// ---------------------------------------------------------------------------

test('every refusal renders through the catalogue, not through a literal', () => {
  const candidates = [{ serverID: 1, alias: 'main', serverName: 'Slackers #1' }];
  for (const refusal of Object.values(REFUSAL)) {
    const embed = buildRoutingRefusalEmbed(
      { refusal, candidates, token: 'nope', command: '!switch explain' },
      (key, vars) => localize(key, vars)
    );
    // localize() returns the key itself when it is missing, which is the
    // shape a rendered refusal takes when the locale block was never added.
    assert.ok(embed.title && !embed.title.startsWith('slackersSquadServices.'),
      `${refusal} has no catalogue title — got "${embed.title}"`);
    assert.ok(embed.description && !embed.description.startsWith('slackersSquadServices.'),
      `${refusal} has no catalogue description`);
    assert.match(embed.description, /main/, `${refusal} did not list the candidates`);
  }
});

test('a refusal quotes the command and the bad token back, bounded', () => {
  const embed = buildRoutingRefusalEmbed(
    { refusal: REFUSAL.UNKNOWN_SERVER, candidates: [], token: 'x'.repeat(200), command: 'y'.repeat(200) },
    (key, vars) => localize(key, vars)
  );
  assert.ok(!embed.description.includes('x'.repeat(41)), 'an unbounded token reached the embed');
});


// ---------------------------------------------------------------------------
// The four scope tables
// ---------------------------------------------------------------------------

/**
 * The consumer surfaces hold literal scope strings rather than COMMAND_SCOPE
 * members, because none of them can import an S³ util — the install flattens
 * `s3/utils/` and `<plugin>/utils/` into one directory, so no specifier
 * resolves both here and at the target. This case is what the constants would
 * have bought: a typo'd scope reads as "not a scope" and every branch below it
 * in the gate silently falls through to acting.
 */
const SCOPE_VALUES = new Set(Object.values(COMMAND_SCOPE));

function assertTable(label, verbs, classify) {
  for (const verb of verbs) {
    const result = classify(verb);
    assert.ok(result && typeof result === 'object', `${label} "${verb}" returned no verdict`);
    assert.ok(SCOPE_VALUES.has(result.scope),
      `${label} "${verb}" returned "${result.scope}", which is not a COMMAND_SCOPE value`);
    assert.equal(typeof result.selectorRequired, 'boolean',
      `${label} "${verb}" did not declare selectorRequired`);
  }
}

test('every scope !s3 can return is a COMMAND_SCOPE value', () => {
  const verbs = [
    ['status'], ['services'], ['gamestate'], ['factions'], ['locks'], ['config'],
    ['switches'], ['karma'], ['diag'], ['players'], ['clans'],
    ['servers'], ['servers', 'alias'], ['servers', 'forget'],
    ['db'], ['db', 'export'], ['db', 'import'], ['db', 'orphans'],
    ['backup'], ['backup', 'list'], ['backup', 'restore'], ['backup', 'create'],
    ['migrate'], ['migrate', 'force'], ['migrate', 'purge-deprecated'], ['migrate', 'adopt-state'],
    ['confirm'], ['help'], ['nonsense'], []
  ];
  assertTable('!s3', verbs, (argv) => scopeForS3Command(argv));
});

test('every scope !switch can return is a COMMAND_SCOPE value', () => {
  const verbs = ['status', 'stats', 'check', 'explain', 'timelimit', 'backfill',
    'clear', 'clearall', 'wipe', 'help', 'nonsense', null, undefined];
  assertTable('!switch', verbs, (sub) => scopeForSwitchCommand(sub));
});

test('every scope !elo can return is a COMMAND_SCOPE value', () => {
  const verbs = ['status', 'roundinfo', 'reset', 'restore', 'backup', 'me',
    'leaderboard', 'clan', 'clans', 'link', 'explain', 'help', 'nonsense', null, undefined];
  assertTable('!elo', verbs, (sub) => scopeForEloCommand(sub));
});

test('every scope !teambalancer and !scramble can return is a COMMAND_SCOPE value', () => {
  const tbVerbs = [['status'], ['export'], ['diag'], ['on'], ['off'], ['clear'], ['help'], ['nonsense'], []];
  assertTable('!teambalancer', tbVerbs, (argv) => scopeForTeamBalancerCommand('teambalancer', argv));

  const scrambleVerbs = [['dry'], ['now'], ['elo'], ['confirm'], ['now', 'elo'], ['elo', 'now'], []];
  assertTable('!scramble', scrambleVerbs, (argv) => scopeForTeamBalancerCommand('scramble', argv));
});

test('!scramble is classified on the whole argument list, not on args[0]', () => {
  // handleDiscordScrambleCommand() tests membership, so `dry now` and
  // `now dry` are the same command. A classifier reading args[0] tags one of
  // them as a mutation and requires a selector for a preview.
  assert.equal(scopeForTeamBalancerCommand('scramble', ['now', 'dry']).scope, COMMAND_SCOPE.SERVER_READ);
  assert.equal(scopeForTeamBalancerCommand('scramble', ['dry', 'now']).scope, COMMAND_SCOPE.SERVER_READ);
  assert.equal(scopeForTeamBalancerCommand('scramble', ['now']).scope, COMMAND_SCOPE.SERVER_MUTATING);
});

test('the widest thing a verb touches is what classifies it', () => {
  // `!switch clear <player>` raises a community-wide token balance and lifts
  // this server's scramble lock in one call. Half of it is local, and that
  // does not make it a server mutation.
  assert.equal(scopeForSwitchCommand('clear').scope, COMMAND_SCOPE.COMMUNITY_MUTATING);
  assert.equal(scopeForSwitchCommand('clearall').scope, COMMAND_SCOPE.COMMUNITY_MUTATING);
  assert.equal(scopeForSwitchCommand('wipe').scope, COMMAND_SCOPE.COMMUNITY_MUTATING);

  // `check` goes the other way: a community balance AND this server's own
  // lock, so one responder would report one server's lock as everyone's.
  assert.equal(scopeForSwitchCommand('check').scope, COMMAND_SCOPE.SERVER_READ);
  assert.equal(scopeForSwitchCommand('check').selectorRequired, false);
});

test('backup routes by the filesystem it reads, not by the database it writes', () => {
  // The effect of a restore is community-wide and the confirmation is what
  // covers that. What the scope tag decides is WHICH PROCESS answers, and a
  // `backups/` directory belongs to a process: a claim election would hand
  // `backup list` to one arbitrary server and print a file list that exists
  // on one host, then hand `restore <filename>` to a server that does not
  // hold that file.
  assert.equal(scopeForS3Command(['backup', 'list']).scope, COMMAND_SCOPE.SERVER_READ);
  assert.equal(scopeForS3Command(['backup', 'list']).selectorRequired, false,
    'a one-embed read broadcasts; seeing every server\'s files at once is the point');

  // Both write a filesystem, and which filesystem is the whole question.
  assert.equal(scopeForS3Command(['backup', 'create']).scope, COMMAND_SCOPE.SERVER_MUTATING);
  assert.equal(scopeForS3Command(['backup', 'restore']).scope, COMMAND_SCOPE.SERVER_MUTATING);

  // A bare `!s3 backup` is a usage reply. Broadcasting it would print the
  // same usage text once per server for a typo.
  assert.equal(scopeForS3Command(['backup']).scope, COMMAND_SCOPE.COMMUNITY_READ);
});

test('the multi-embed reads are the ones that ask for a target', () => {
  assert.equal(scopeForSwitchCommand('explain').selectorRequired, true);
  assert.equal(scopeForTeamBalancerCommand('teambalancer', ['diag']).selectorRequired, true);
  assert.equal(scopeForS3Command(['players']).selectorRequired, true);
  assert.equal(scopeForS3Command(['clans']).selectorRequired, true);
  assert.equal(scopeForS3Command(['status']).selectorRequired, false);
});


run();
