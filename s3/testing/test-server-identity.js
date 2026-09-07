/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║        SERVER IDENTITY — WHO THIS PROCESS WRITES AS           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Every server-scoped row the suite writes carries a server id, and once two
 * SquadJS instances share one database that id is the only thing separating
 * their rows. So the id has to be settled before anything writes, it has to
 * come from what the operator declared rather than from what a process
 * observes, and a value that cannot work has to stop the mount instead of
 * being repaired into something plausible.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   resolution order    overrideServerID beats the SquadJS id; an absent or
 *                       empty override falls through rather than winning as a
 *                       null.
 *   the fallback        No id anywhere resolves to 1 — what a single-server
 *                       install has always behaved as — and says so, rather
 *                       than refusing to boot an install that never set one.
 *   refusals            A non-numeric, zero, negative or over-wide id throws,
 *                       naming which of the two sources it came from.
 *   the width budget    An id at the limit still produces a matchId inside the
 *                       20 characters the tightest consumer column holds, and
 *                       one digit more does not. This is the case the whole
 *                       limit exists for: MySQL outside strict mode truncates
 *                       silently, so an over-wide id merges two servers'
 *                       rounds onto one key with nothing raised anywhere.
 *   the exposed value   DBService.getServerID(), S³'s accessor, and
 *                       S3PluginBase's getter all answer with the same id, and
 *                       the plugin base answers null before S³ is discovered.
 *   refusal timing      A bad id is held through prepareToMount() and thrown
 *                       from mount(). Throwing out of prepareToMount() would
 *                       take the SquadJS boot down before any plugin has a
 *                       logger the operator reads.
 *
 * Category: 1 (no external services)
 * Run:    node s3/testing/test-server-identity.js
 */

'use strict';

import assert from 'node:assert/strict';

import { Sequelize } from 'sequelize';

import DBService, { DEFAULT_SERVER_ID, MAX_SERVER_ID_LENGTH } from '../utils/db-service.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from './plugin-assembly.js';

// s3-plugin-base.js imports SquadJS's BasePlugin as a flat sibling, which only
// resolves in the layout install.cjs produces — so the classes under test are
// imported from a real assembly rather than from the source tree. Built once:
// every case here is read-only against it.
const ASSEMBLY = buildAssembly('.tmp-server-identity');
const S3PluginBase = await importFromAssembly(ASSEMBLY, 's3-plugin-base.js');
const SlackersSquadServices = await importFromAssembly(ASSEMBLY, 'slackers-squad-services.js');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(70));
  console.log('Server Identity  (resolution, refusal, exposure)');
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
 * The prefixed round key Phase 1 writes, so the width cases measure the real
 * string rather than a description of it.
 *
 * `suffix` is separate because the budget is sized against the format's cap,
 * not against today's clock: `.slice(-8)` bounds the base-36 second count at
 * eight characters, but the count is six characters now and reaches seven
 * around 2038. Measuring with the live value would make the limit look loose by
 * two characters and would tighten by itself, silently, on a date nobody is
 * watching.
 */
function matchIdFor(serverID, suffix = Math.floor(Date.now() / 1000).toString(36).slice(-8)) {
  return `${serverID}-${suffix}`;
}

const WIDEST_SUFFIX = 'z'.repeat(8);

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

test('the SquadJS server id is used when no override is set', () => {
  const r = DBService.resolveServerID({ overrideServerID: null, server: { id: 7 } });
  assert.equal(r.serverID, 7);
  assert.equal(r.fallback, false);
  assert.match(r.source, /SquadJS/, `the source must name where the id came from, got ${r.source}`);
});

test('overrideServerID beats the SquadJS server id', () => {
  const r = DBService.resolveServerID({ overrideServerID: 3, server: { id: 1 } });
  assert.equal(r.serverID, 3, 'the override exists precisely for two installs that both ship "id": 1');
  assert.equal(r.source, 'overrideServerID');
});

test('an empty-string override falls through instead of winning as a blank', () => {
  // The option's default is null, but an operator who clears it in a JSON
  // config leaves "" behind. Treating that as a supplied value would refuse a
  // mount that is in fact correctly configured.
  const r = DBService.resolveServerID({ overrideServerID: '', server: { id: 4 } });
  assert.equal(r.serverID, 4);
  assert.match(r.source, /SquadJS/);
});

test('a numeric string id is accepted — SquadJS configs are JSON written by hand', () => {
  const r = DBService.resolveServerID({ overrideServerID: null, server: { id: '12' } });
  assert.equal(r.serverID, 12);
  assert.equal(typeof r.serverID, 'number', 'S3_Servers stores the id as an INTEGER primary key');
});

// ---------------------------------------------------------------------------
// The fallback
// ---------------------------------------------------------------------------

test('no id anywhere falls back to the single-server default, flagged', () => {
  const r = DBService.resolveServerID({ overrideServerID: null, server: {} });
  assert.equal(r.serverID, DEFAULT_SERVER_ID);
  assert.equal(r.fallback, true, 'the caller logs on this flag — an unflagged fallback is a silent collision');
  assert.equal(r.source, 'default');
});

test('a null server object falls back rather than throwing', () => {
  const r = DBService.resolveServerID({ overrideServerID: null, server: null });
  assert.equal(r.serverID, DEFAULT_SERVER_ID);
  assert.equal(r.fallback, true);
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('a non-numeric id is refused, naming its source', () => {
  assert.throws(
    () => DBService.resolveServerID({ overrideServerID: 'main', server: { id: 1 } }),
    (err) => {
      assert.match(err.message, /overrideServerID/, `the message must name the option to fix: ${err.message}`);
      assert.match(err.message, /whole number/, err.message);
      return true;
    }
  );
});

test('a fractional id is refused', () => {
  assert.throws(() => DBService.resolveServerID({ server: { id: 1.5 } }), /whole number/);
});

test('zero and negative ids are refused', () => {
  // Zero is not merely unusual: `override || server.id` is the idiom used
  // across the suite, and a falsy id is indistinguishable from an absent one.
  assert.throws(() => DBService.resolveServerID({ server: { id: 0 } }), /whole number/);
  assert.throws(() => DBService.resolveServerID({ server: { id: -2 } }), /whole number/);
});

test('an id wider than the key budget is refused, not truncated', () => {
  const tooWide = '1'.repeat(MAX_SERVER_ID_LENGTH + 1);
  assert.throws(
    () => DBService.resolveServerID({ overrideServerID: tooWide }),
    (err) => {
      assert.match(err.message, new RegExp(String(MAX_SERVER_ID_LENGTH)), err.message);
      assert.match(
        err.message, /truncat/i,
        `the message must say what silently happens otherwise, or the limit reads as arbitrary: ${err.message}`
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// The width budget
// ---------------------------------------------------------------------------

test('an id at the limit still produces a matchId inside STRING(20)', () => {
  const widest = Number('9'.repeat(MAX_SERVER_ID_LENGTH));
  const r = DBService.resolveServerID({ overrideServerID: widest });
  assert.equal(r.serverID, widest, 'the limit must be inclusive — an off-by-one here refuses a legal id');
  assert.ok(
    matchIdFor(r.serverID, WIDEST_SUFFIX).length <= 20,
    `matchId at the widest legal id must fit the column: ${matchIdFor(r.serverID, WIDEST_SUFFIX)}`
  );
  assert.ok(
    matchIdFor(r.serverID).length <= 20,
    'and it must still fit with the suffix today\'s clock actually produces'
  );
});

test('one digit past the limit would have overflowed the column', () => {
  // Proves the limit is the right number rather than merely a number: the
  // first refused id is also the first one that does not fit.
  const overflowing = '9'.repeat(MAX_SERVER_ID_LENGTH + 1);
  assert.ok(
    matchIdFor(overflowing, WIDEST_SUFFIX).length > 20,
    `the first refused id must be the first that overflows, or MAX_SERVER_ID_LENGTH is wrong: ${matchIdFor(overflowing, WIDEST_SUFFIX)}`
  );
});

test('the live matchId suffix has never exceeded the width the budget assumes', () => {
  // The budget is sized against `.slice(-8)`, and that stays the right thing to
  // size against — but if the base-36 second count ever did exceed eight
  // characters the slice would start dropping leading digits, and two rounds
  // 36^8 seconds apart would share a key. Neither half of that is reachable
  // this millennium; this is here so the assumption is written down as a check
  // rather than as a comment.
  const live = Math.floor(Date.now() / 1000).toString(36);
  assert.ok(live.length <= 8, `base-36 epoch seconds must still fit the slice: ${live}`);
});

// ---------------------------------------------------------------------------
// The exposed value
// ---------------------------------------------------------------------------

test('DBService.getServerID() answers with what it was given', () => {
  const db = new DBService({ sequelize: new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false }), server: { id: 1 }, serverID: 9 });
  assert.equal(db.getServerID(), 9, 'S³ resolves the id and passes it down; the service does not re-derive it');
});

test('a directly built DBService falls back through the SquadJS id to the default', () => {
  // Every testing harness constructs DBService without a serverID, so
  // getServerID() has to answer for them rather than returning null.
  const opts = { dialect: 'sqlite', storage: ':memory:', logging: false };
  const fromServer = new DBService({ sequelize: new Sequelize(opts), server: { id: 5 } });
  assert.equal(fromServer.getServerID(), 5);

  const fromDefault = new DBService({ sequelize: new Sequelize(opts), server: {} });
  assert.equal(fromDefault.getServerID(), DEFAULT_SERVER_ID);
});

test('S3PluginBase.serverID is null before S³ is discovered, then mirrors it', () => {
  const plugin = Object.create(S3PluginBase.prototype);
  plugin._s3 = null;
  assert.equal(
    plugin.serverID, null,
    'a default here would let a consumer write rows under an identity S³ never agreed to'
  );

  plugin._s3 = { serverID: 6 };
  assert.equal(plugin.serverID, 6);
});

// ---------------------------------------------------------------------------
// Refusal timing, against the real plugin in its shipped layout
// ---------------------------------------------------------------------------

/** A SquadJS server object with only what S³'s constructor and prepareToMount touch. */
function fakeServer(id) {
  return { id, on: () => {}, removeListener: () => {} };
}

test('S³ resolves the id in prepareToMount and hands it to DBService', async () => {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  try {
    const plugin = new SlackersSquadServices(
      fakeServer(2),
      { database: 'sqlite', discordClient: null, stderrDiagnostics: 'off', overrideServerID: 4 },
      { sqlite: sequelize }
    );

    await plugin.prepareToMount();

    assert.equal(plugin.serverID, 4, 'the override must win, and must be settled before any service is built');
    assert.equal(
      plugin.db.getServerID(), 4,
      'DBService must receive the resolved id — re-deriving it there would let the two disagree'
    );
  } finally {
    await sequelize.close();
  }
});

test('a bad id survives prepareToMount and is thrown by mount', async () => {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  try {
    const plugin = new SlackersSquadServices(
      fakeServer(1),
      { database: 'sqlite', discordClient: null, stderrDiagnostics: 'off', overrideServerID: 'primary' },
      { sqlite: sequelize }
    );

    await assert.doesNotReject(
      () => plugin.prepareToMount(),
      'SquadJS calls prepareToMount on every plugin before mounting any of them; throwing there loses the boot'
    );
    await assert.rejects(
      () => plugin.mount(),
      /overrideServerID/,
      "mount must refuse rather than substitute a plausible id — a wrong id claims another server's rows"
    );
    assert.equal(
      plugin.db.getServerID(), DEFAULT_SERVER_ID,
      'the service is left at the default, but the refusal above means it never writes with it'
    );
  } finally {
    await sequelize.close();
  }
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

try {
  await run();
} finally {
  cleanAssembly(ASSEMBLY);
}
