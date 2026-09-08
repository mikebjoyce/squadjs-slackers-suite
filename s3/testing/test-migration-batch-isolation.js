/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   CATEGORY 2 — MIGRATION BATCH ISOLATION (force / confirm)     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Both operator-driven migration paths — `!s3 migrate force` and
 * `!s3 confirm <token>` — used to walk the pending list and `break` at the
 * first plugin whose migration threw. That looks like caution and is not.
 * Schema versions are recorded per plugin, each migration takes an advisory
 * lock keyed on its own plugin name, and each runs in its own transaction, so
 * one plugin's failure says nothing about any other. Stopping does not protect
 * the untouched plugins; it just leaves them pending behind a neighbour they
 * have nothing to do with, with the registration order deciding which of them
 * ever gets a turn.
 *
 * That is not a hypothetical ordering puzzle. A database user with CREATE but
 * without ALTER refuses the same column-adding migration on every attempt, for
 * as long as the grant stays that way. Under the old loop, one such plugin
 * blocked every plugin registered after it from ever migrating, and no amount
 * of re-running the command changed that.
 *
 * The property under test: **a plugin that can migrate does, regardless of
 * what a different plugin did.** The ground truth is the recorded schema
 * version, not the reply embed — an embed-shaped assertion would pass against
 * a loop that reported optimistically.
 *
 * The one deliberate exception is also covered: when locking is unavailable at
 * the SERVICE level (S3_Locks could not be created, so acquireAdvisoryLock()
 * fails closed forever), every remaining plugin is certain to fail for that one
 * reason, and the batch stops rather than reporting a single problem N times. A
 * lock merely lost to another live process is not that — it is per-plugin and
 * transient — so it is recorded and the batch carries on.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-migration-batch-isolation.js
 *
 * Category: 2 (requires DB access — in-memory SQLite, no Docker)
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import DBService from '../utils/db-service.js';
import MigrationEngine, { MIGRATION_LOCK_UNAVAILABLE } from '../utils/migration-engine.js';
import { localize as lookupMessage } from '../utils/s3-i18n.js';
import * as cmds from '../utils/s3-commands.js';


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
  console.log('='.repeat(65));
  console.log('Migration Batch Isolation Test');
  console.log('='.repeat(65));
  console.log('');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`    ${err.message.split('\n')[0]}`);
      failed++;
    }
  }

  console.log('');
  console.log('─'.repeat(65));
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log('─'.repeat(65));

  if (failed > 0) process.exitCode = 1;
}


// ---------------------------------------------------------------------------
// A real engine with several pending plugins, some of which cannot migrate
// ---------------------------------------------------------------------------

/**
 * Stand up a DBService + MigrationEngine with one pending migration per named
 * plugin, then run `!s3 <argv...>` through the real command handler.
 *
 * @param {string[]} argv - e.g. ['migrate', 'force'] or ['confirm', 'tok'].
 * @param {Array<{name: string, fail?: 'throw'|'lock'}>} specs - One entry per
 *   plugin, in registration order. `fail: 'throw'` makes its up() reject the
 *   way a refused ALTER does; `fail: 'lock'` makes only that plugin's advisory
 *   lock unobtainable, the way a live competing process does.
 * @param {{lockingBroken?: boolean, mintToken?: string}} [opts] -
 *   `lockingBroken` drops S3_Locks entirely, so locking is unavailable at the
 *   service level and every plugin would fail identically.
 * @returns {Promise<{ran: string[], versions: object, embeds: object[], engine: object}>}
 *   `ran` names the plugins whose up() actually executed; `versions` is the
 *   recorded schema version per plugin, read back after the command.
 */
async function runBatch(argv, specs, opts = {}) {
  const { lockingBroken = false, mintToken = null } = opts;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-batch-test-'));
  const sequelize = new Sequelize({
    dialect: 'sqlite', storage: ':memory:', logging: false, define: { freezeTableName: true }
  });

  const dbService = new DBService({ sequelize, verboseLogger: () => {} });
  await dbService.mount();
  dbService._migrationEngine = new MigrationEngine({
    dbService, verboseLogger: () => {}, backupDir: tempDir
  });

  const engine = dbService.migrationEngine;
  const ran = [];

  for (const spec of specs) {
    dbService.registerExpectedVersion(spec.name, 1);
    engine.registerMigrations(spec.name, [{
      version: 1,
      description: `Observable no-op for ${spec.name}`,
      backup: false,
      touches: {},
      up: async () => {
        ran.push(spec.name);
        if (spec.fail === 'throw') {
          // The shape a refused ALTER arrives in: a plain driver-ish rejection
          // with no code the batch runner could special-case.
          //
          // Deliberately does NOT name the plugin. A driver message that
          // happened to contain "alpha" would satisfy every assertion below
          // about the plugin being *named*, whether or not the renderer
          // labelled anything — mutation-verified: dropping {pluginName} from
          // the failureLine locale key failed nothing until this message
          // stopped carrying the name for free.
          throw new Error("ALTER command denied to user for the target table");
        }
      }
    }]);
  }

  // Only this plugin's lock is unobtainable — locking itself still works, so
  // this is the transient "another process got there first" case.
  const lockLosers = new Set(specs.filter((s) => s.fail === 'lock').map((s) => `s3_migrate_${s.name}`));
  if (lockLosers.size > 0) {
    const realAcquire = dbService.acquireAdvisoryLock.bind(dbService);
    dbService.acquireAdvisoryLock = async (key, options) =>
      (lockLosers.has(key) ? false : realAcquire(key, options));
  }

  // No S3_Locks at all: acquireAdvisoryLock() fails closed for every key, and
  // isLockingAvailable() reports the difference.
  if (lockingBroken) dbService.LocksModel = null;

  if (mintToken) {
    engine._confirmToken = mintToken;
    engine._tokenExpiresAt = Date.now() + 60_000;
  }

  const captured = [];
  const { handlers } = cmds.createCommandHandlers({
    sendDiscordMessage: async (_c, payload) => { captured.push(payload); },
    watchManager: null,
    stagedImportRef: { current: null }
  });

  const message = {
    channel: { id: 'c1', send: async (p) => { captured.push(p); return { id: 'x' }; } },
    author: { id: 'u1' },
    reply: async (p) => { captured.push(p); return { id: 'x' }; },
    attachments: { first: () => null }
  };

  const plugin = {
    services: { db: dbService },
    options: {},
    verbose: () => {},
    localize: (key, vars) => lookupMessage(key, vars)
  };

  await handlers.get(argv[0])(plugin, message, argv);

  // Read the recorded versions back through the engine — this is the ground
  // truth the embed cannot fake.
  const versions = {};
  for (const spec of specs) {
    versions[spec.name] = await engine._getAppliedVersion(spec.name);
  }

  const embeds = captured.map((p) => p?.embeds?.[0]).filter(Boolean);

  try { await sequelize.close(); } catch { /* ignore */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return { ran, versions, embeds, engine };
}

/**
 * Just the failure narrative from the last embed a command posted — everything
 * after the fenced version block.
 *
 * That block lists every PENDING plugin whether or not it failed, so a bare
 * /charlie/ against the whole description matches a plugin the batch never even
 * attempted. Every assertion about what the operator was told a *particular*
 * plugin did has to read below the fence, or it passes for the wrong reason.
 */
function failureDetail(embeds) {
  const description = embeds.at(-1)?.description ?? '';
  return description.split('```').at(-1) ?? '';
}


// ---------------------------------------------------------------------------
// The defect: one plugin's failure took the whole batch down
// ---------------------------------------------------------------------------

test('`migrate force`: a plugin that cannot migrate does not stop the ones that can', async () => {
  const { ran, versions } = await runBatch(['migrate', 'force'], [
    { name: 'alpha', fail: 'throw' },
    { name: 'bravo' },
    { name: 'charlie' }
  ]);

  // Before the fix these two never ran at all — `alpha` threw and the loop
  // broke, and no re-run could ever change that while the grant stayed put.
  assert.deepEqual(ran, ['alpha', 'bravo', 'charlie'], 'the batch stopped early');
  assert.equal(versions.bravo, 1, 'bravo did not migrate');
  assert.equal(versions.charlie, 1, 'charlie did not migrate');

  // And the one that failed is still recorded as not migrated. Isolation must
  // not turn into optimism.
  assert.equal(versions.alpha, 0, 'a failed migration was recorded as applied');
});

test('`migrate force`: the failing plugin is named, and the rest of the batch is accounted for', async () => {
  const { embeds } = await runBatch(['migrate', 'force'], [
    { name: 'alpha', fail: 'throw' },
    { name: 'bravo' },
    { name: 'charlie' }
  ]);

  const desc = failureDetail(embeds);

  // With isolation the batch can fail in more than one place, so "**Error:**
  // <one message>" no longer identifies anything. The plugin name has to be in
  // the text the operator reads.
  assert.match(desc, /alpha/, `the failing plugin was not named: ${desc}`);
  assert.match(desc, /ALTER command denied/, `the driver's reason was dropped: ${desc}`);

  // Partial progress is stated rather than left to be inferred from a red
  // embed that also says two plugins are fine.
  const progress = lookupMessage('slackersSquadServices.migration.partialProgress', {
    succeeded: 2, total: 3
  });
  assert.ok(desc.includes(progress), `expected the partial-progress line, got: ${desc}`);
});

test('`migrate force`: two independent failures are both reported, not just the first', async () => {
  const { ran, versions, embeds } = await runBatch(['migrate', 'force'], [
    { name: 'alpha', fail: 'throw' },
    { name: 'bravo' },
    { name: 'charlie', fail: 'throw' }
  ]);

  assert.deepEqual(ran, ['alpha', 'bravo', 'charlie']);
  assert.equal(versions.bravo, 1, 'the plugin between two failures did not migrate');

  const desc = failureDetail(embeds);
  assert.match(desc, /alpha/, `first failure missing: ${desc}`);
  assert.match(desc, /charlie/, `second failure missing: ${desc}`);
});

test('`migrate force`: the overall verdict is still failure when any plugin failed', async () => {
  const { embeds } = await runBatch(['migrate', 'force'], [
    { name: 'alpha', fail: 'throw' },
    { name: 'bravo' }
  ]);

  // A partly-applied batch has not reached the schema consumers expect. The
  // gate stays shut and the embed stays red; only the *attempting* changed.
  const title = embeds.at(-1)?.title ?? '';
  assert.match(title, /Failed/i, `expected a failure verdict, got: ${title}`);
});

test('`migrate force`: an all-clean batch is unchanged — no failure text, no red', async () => {
  const { ran, versions, embeds } = await runBatch(['migrate', 'force'], [
    { name: 'alpha' },
    { name: 'bravo' }
  ]);

  assert.deepEqual(ran, ['alpha', 'bravo']);
  assert.equal(versions.alpha, 1);
  assert.equal(versions.bravo, 1);

  const title = embeds.at(-1)?.title ?? '';
  assert.match(title, /Complete/i, `expected success, got: ${title}`);

  const progress = lookupMessage('slackersSquadServices.migration.partialProgress', {
    succeeded: 2, total: 2
  });
  assert.ok(!failureDetail(embeds).includes(progress),
    'a fully successful batch described itself as partial');
});


// ---------------------------------------------------------------------------
// The two kinds of lock failure, which look identical from the caller's side
// ---------------------------------------------------------------------------

test('a lock lost to another process is isolated — it is transient and per-plugin', async () => {
  const { ran, versions, embeds } = await runBatch(['migrate', 'force'], [
    { name: 'alpha', fail: 'lock' },
    { name: 'bravo' }
  ]);

  // alpha never reaches up() — it is refused at the lock — but bravo must.
  assert.deepEqual(ran, ['bravo'], 'losing one lock stopped the batch');
  assert.equal(versions.bravo, 1, 'bravo did not migrate');
  assert.equal(versions.alpha, 0);

  const aborted = lookupMessage('slackersSquadServices.migration.batchAborted');
  assert.ok(!failureDetail(embeds).includes(aborted),
    'a transient lock loss was reported as a service-level locking outage');
});

test('locking unavailable at the service level stops the batch instead of repeating itself', async () => {
  const { ran, versions, embeds } = await runBatch(['migrate', 'force'], [
    { name: 'alpha' },
    { name: 'bravo' },
    { name: 'charlie' }
  ], { lockingBroken: true });

  // Nothing can migrate — S3_Locks does not exist, so every acquire fails
  // closed. Continuing would print the same grant problem three times and bury
  // it in its own repetition.
  assert.deepEqual(ran, [], 'a migration ran without a lock');
  assert.equal(versions.alpha, 0);
  assert.equal(versions.bravo, 0);
  assert.equal(versions.charlie, 0);

  const desc = failureDetail(embeds);
  const aborted = lookupMessage('slackersSquadServices.migration.batchAborted');
  assert.ok(desc.includes(aborted), `expected the early-stop note, got: ${desc}`);

  // Exactly one plugin is named, because exactly one was attempted.
  assert.match(desc, /alpha/, `the attempted plugin was not named: ${desc}`);
  assert.ok(!desc.includes('charlie'),
    `a plugin that was never attempted was reported as failed: ${desc}`);
});

test('the lock refusal really is the tagged one, not a message-text match', async () => {
  // The batch runner tells the two lock cases apart by asking the service, not
  // by reading the error string — but it only ever sees this error at all
  // because the engine tags it. If that tag moves, this file's two lock tests
  // would both keep passing for the wrong reason.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-batch-tag-'));
  const sequelize = new Sequelize({
    dialect: 'sqlite', storage: ':memory:', logging: false, define: { freezeTableName: true }
  });
  const dbService = new DBService({ sequelize, verboseLogger: () => {} });
  await dbService.mount();
  dbService._migrationEngine = new MigrationEngine({
    dbService, verboseLogger: () => {}, backupDir: tempDir
  });
  const engine = dbService.migrationEngine;
  dbService.registerExpectedVersion('alpha', 1);
  engine.registerMigrations('alpha', [{
    version: 1, description: 'x', backup: false, touches: {}, up: async () => {}
  }]);
  engine.confirmToken('__force__');
  dbService.LocksModel = null;

  let caught = null;
  try {
    await engine.runMigrations('alpha');
  } catch (err) {
    caught = err;
  }

  try { await sequelize.close(); } catch { /* ignore */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

  assert.ok(caught, 'a migration ran with no lock table');
  assert.equal(caught.code, MIGRATION_LOCK_UNAVAILABLE,
    'the lock refusal is no longer tagged — the batch runner cannot classify it');
});


// ---------------------------------------------------------------------------
// The same property on the other operator path
// ---------------------------------------------------------------------------

test('`!s3 confirm <token>`: isolation applies there too, not only to force', async () => {
  const { ran, versions } = await runBatch(['confirm', 'tok12345'], [
    { name: 'alpha', fail: 'throw' },
    { name: 'bravo' },
    { name: 'charlie' }
  ], { mintToken: 'tok12345' });

  assert.deepEqual(ran, ['alpha', 'bravo', 'charlie'], 'the confirm batch stopped early');
  assert.equal(versions.bravo, 1, 'bravo did not migrate via confirm');
  assert.equal(versions.charlie, 1, 'charlie did not migrate via confirm');
  assert.equal(versions.alpha, 0);
});

test('`!s3 confirm <token>`: the failure detail survives the confirm path', async () => {
  const { embeds } = await runBatch(['confirm', 'tok12345'], [
    { name: 'alpha', fail: 'throw' },
    { name: 'bravo' }
  ], { mintToken: 'tok12345' });

  const desc = failureDetail(embeds);
  assert.match(desc, /alpha/, `the failing plugin was not named: ${desc}`);
  const progress = lookupMessage('slackersSquadServices.migration.partialProgress', {
    succeeded: 1, total: 2
  });
  assert.ok(desc.includes(progress), `expected the partial-progress line, got: ${desc}`);
});


await run();
