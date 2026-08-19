/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║        STDERR DIAGNOSTICS — STREAM SEPARATION                 ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Verifies that S³ operational failures reach **fd 2**, so an operator
 * running `node index.js > squadjs.log 2> squadjs.err` finds them in
 * the error file. Requested by an operator who traces incidents from
 * split stream files; before this, SquadJS's Logger put everything on
 * stdout and migration failures were invisible in `2>`.
 *
 * The assertion that matters is stream *separation*, which cannot be
 * checked in-process — monkeypatching process.stderr.write proves the
 * function was called, not that the bytes landed on fd 2. So each case
 * re-invokes this file as a child process with S3_STDERR_CASE set,
 * captures the two pipes separately, and asserts against them.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   1. A failing migration writes an ERROR block to stderr, including
 *      the stack that the Discord embed drops (it carries only
 *      err.message).
 *   2. That block does NOT appear on stdout — no double-logging into
 *      the operator's main log.
 *   3. A successful migration writes nothing to stderr — the error
 *      file stays quiet when nothing is wrong.
 *   4. Schema drift writes a WARN block naming the missing column.
 *   5. The prefix is greppable: `[S3] [ERROR]` / `[S3] [WARN]`.
 *   6. Mode handling: 'off' silences everything; 'auto' mirrors when the
 *      streams are separate and stays quiet when they share one file
 *      (a console window, or `> log 2>&1`); explicit 'mirror' overrides
 *      that detection. The merged case is wired by handing the child the
 *      SAME file descriptor for both streams.
 *   7. Flood control: identical events collapse to one block plus a
 *      suppressed count, distinct events never merge, and a closed
 *      window emits its tally.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-stderr-diagnostics.js
 *
 * Category: 1 (SQLite in-memory only — no Docker, no server)
 */

'use strict';

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Sequelize, DataTypes } from 'sequelize';

import DBService from '../utils/db-service.js';
import {
  stderrError,
  stderrWarn,
  configureStderrDiagnostics,
  flushStderrDiagnostics
} from '../utils/s3-stderr.js';

const __filename = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Child-process fixtures — one per S3_STDERR_CASE value
// ---------------------------------------------------------------------------

/** Mount a DBService on in-memory SQLite with one Switch-shaped table. */
async function fixtureDb() {
  const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const db = new DBService({
    sequelize: seq,
    defaultRetry: { attempts: 1, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();
  return { db, seq };
}

async function runChildCase(caseName) {
  if (caseName === 'unconfigured-default') {
    // No configureStderrDiagnostics() call at all — a server whose S³ config
    // says nothing about this. Must be byte-for-byte the pre-1.3.0 behaviour.
    const { db } = await fixtureDb();
    db.migrationEngine.registerMigrations('defaultcase', [
      {
        version: 1,
        description: 'deliberately failing migration',
        touches: {},
        up: async (qi) => { await qi.thisMethodDoesNotExist('T', {}); },
        down: async () => {}
      }
    ]);
    db.migrationEngine.confirmToken('__force__');
    try {
      await db.migrationEngine.runMigrations('defaultcase');
    } catch { /* expected */ }
    console.log('child-stdout-marker');
    return;
  }

  if (caseName === 'mode-off') {
    configureStderrDiagnostics({ mode: 'off' });
    stderrError('ModeCase', 'this must not appear anywhere', new Error('suppressed'));
    stderrWarn('ModeCase', 'nor this');
    console.log('child-stdout-marker');
    return;
  }

  if (caseName === 'forced-mirror') {
    configureStderrDiagnostics({ mode: 'mirror' });
    stderrError('ForcedCase', 'forced mirror failure', new Error('boom'));
    console.log('child-stdout-marker');
    return;
  }

  if (caseName === 'auto-mode') {
    // 'auto' is opt-in, like every mode other than the 'off' default. Whether
    // it writes depends on where fd 1 and fd 2 point, which the parent controls
    // by how it wires the child's stdio.
    configureStderrDiagnostics({ mode: 'auto' });
    stderrError('AutoCase', 'auto-mode failure', new Error('boom'));
    console.log('child-stdout-marker');
    return;
  }

  if (caseName === 'dedupe-flood') {
    // A DB outage throws the same error on every tick. One block, then a
    // count — not 500 blocks.
    configureStderrDiagnostics({ mode: 'mirror', windowMs: 60000 });
    for (let i = 0; i < 500; i++) {
      stderrError('Flood', 'Error in _withDb: SQLITE_ERROR: no such column: lastActiveTimestamp', new Error('boom'));
    }
    flushStderrDiagnostics();
    console.log('child-stdout-marker');
    return;
  }

  if (caseName === 'dedupe-distinct') {
    // Different failures must not collapse into each other.
    configureStderrDiagnostics({ mode: 'mirror', windowMs: 60000 });
    stderrError('Distinct', 'first kind of failure', new Error('a'));
    stderrError('Distinct', 'second kind of failure', new Error('b'));
    stderrError('Distinct', 'third kind of failure', new Error('c'));
    console.log('child-stdout-marker');
    return;
  }

  if (caseName === 'dedupe-per-player') {
    // The same failure for many players differs only by ID. Those collapse,
    // because per-player floods are the flood this exists to contain.
    configureStderrDiagnostics({ mode: 'mirror', windowMs: 60000 });
    for (let i = 0; i < 50; i++) {
      stderrError('PerPlayer', `write failed for eosID 0002a3f9c${1000 + i}b7e4d5`, new Error('boom'));
    }
    flushStderrDiagnostics();
    console.log('child-stdout-marker');
    return;
  }

  if (caseName === 'dedupe-window-expiry') {
    // Once the window closes the next occurrence writes again, carrying the
    // count of what was suppressed in between.
    configureStderrDiagnostics({ mode: 'mirror', windowMs: 50 });
    stderrError('Window', 'repeating failure', new Error('boom'));
    for (let i = 0; i < 5; i++) {
      stderrError('Window', 'repeating failure', new Error('boom'));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    stderrError('Window', 'repeating failure', new Error('boom'));
    console.log('child-stdout-marker');
    return;
  }

  if (caseName === 'failing-migration') {
    configureStderrDiagnostics({ mode: 'mirror' });
    const { db } = await fixtureDb();
    db.migrationEngine.registerMigrations('stderrcase', [
      {
        version: 1,
        description: 'deliberately failing migration',
        touches: {},
        up: async (qi) => {
          // Mirrors the real incident: a method that does not exist on qi.
          await qi.thisMethodDoesNotExist('T', {});
        },
        down: async () => {}
      }
    ]);
    db.migrationEngine.confirmToken('__force__');
    try {
      await db.migrationEngine.runMigrations('stderrcase');
    } catch {
      // Expected — the engine re-throws after reporting. The caller's own
      // handling is unchanged; we only assert on what reached the streams.
    }
    console.log('child-stdout-marker');
    return;
  }

  if (caseName === 'successful-migration') {
    configureStderrDiagnostics({ mode: 'mirror' });
    const { db } = await fixtureDb();
    db.migrationEngine.registerMigrations('stderrok', [
      {
        version: 1,
        description: 'migration that succeeds',
        touches: { creates: ['T_StderrOk'] },
        up: async (qi) => {
          await qi.createTable('T_StderrOk', {
            id: { type: qi.DataTypes.INTEGER, primaryKey: true }
          });
        },
        down: async (qi) => { await qi.dropTable('T_StderrOk', { forceDrop: true }); }
      }
    ]);
    db.migrationEngine.confirmToken('__force__');
    await db.migrationEngine.runMigrations('stderrok');
    console.log('child-stdout-marker');
    return;
  }

  if (caseName === 'schema-drift') {
    configureStderrDiagnostics({ mode: 'mirror' });
    const { db, seq } = await fixtureDb();
    // Register a model whose table is then altered out from under it, which is
    // exactly the shape of a hand-migrated DB missing a column.
    db.defineModel('T_Drift', {
      id: { type: DataTypes.INTEGER, primaryKey: true },
      lastActiveTimestamp: { type: DataTypes.DATE, allowNull: true }
    }, { tableName: 'T_Drift', freezeTableName: true, timestamps: false });
    db.registerExpectedVersion('driftcase', 1, { models: ['T_Drift'] });

    await seq.query('CREATE TABLE T_Drift (id INTEGER PRIMARY KEY)');
    const drift = await db.verifyLiveSchema();
    await db._handleDetectedDrift(drift);
    console.log('child-stdout-marker');
    return;
  }

  throw new Error(`unknown case "${caseName}"`);
}

const childCase = process.env.S3_STDERR_CASE;
if (childCase) {
  await runChildCase(childCase);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Test harness (parent process)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

/** Run one fixture case in a child process and return its captured streams. */
function capture(caseName) {
  const result = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, S3_STDERR_CASE: caseName },
    encoding: 'utf-8',
    timeout: 30000
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

async function run() {
  console.log('='.repeat(72));
  console.log('Stderr Diagnostics Tests  (stream separation)');
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

// ═══════════════════════════════════════════════════════════════════════════
// 1. Migration failure reaches stderr, with the stack the embed drops
// ═══════════════════════════════════════════════════════════════════════════

test('failing migration writes an ERROR block to stderr', async () => {
  const { stderr } = capture('failing-migration');
  assert.match(stderr, /\[S3\] \[ERROR\] \[MigrationEngine\]/, 'no greppable S3 ERROR prefix on stderr');
  assert.match(stderr, /stderrcase/, 'plugin name missing from the stderr line');
  assert.match(stderr, /thisMethodDoesNotExist is not a function/, 'error message missing from stderr');
});

test('stderr block carries a stack trace, not just the message', async () => {
  const { stderr } = capture('failing-migration');
  // The Discord embed only ever shows err.message. The stack is the reason
  // this channel exists — it is what identifies the offending migration file.
  assert.match(stderr, /\n\s+at /, 'no stack frames in the stderr block');
});

test('the ERROR block does not also go to stdout', async () => {
  const { stdout } = capture('failing-migration');
  assert.ok(stdout.includes('child-stdout-marker'), 'fixture did not run to completion');
  assert.ok(
    !stdout.includes('[S3] [ERROR]'),
    'the stderr block was duplicated onto stdout — the operator would see it twice'
  );
});

test('failure is still re-thrown to the caller', async () => {
  const { status } = capture('failing-migration');
  // The fixture catches and exits 0; a non-zero status would mean the engine
  // stopped re-throwing and something else escaped instead.
  assert.equal(status, 0, 'child exited non-zero — error handling changed shape');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Quiet when nothing is wrong
// ═══════════════════════════════════════════════════════════════════════════

test('successful migration writes nothing to stderr', async () => {
  const { stdout, stderr } = capture('successful-migration');
  assert.ok(stdout.includes('child-stdout-marker'), 'fixture did not run to completion');
  assert.equal(stderr.trim(), '', `error file would have been polluted with:\n${stderr}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Schema drift reaches stderr as a WARN
// ═══════════════════════════════════════════════════════════════════════════

test('schema drift writes a WARN block naming the missing column', async () => {
  const { stderr } = capture('schema-drift');
  assert.match(stderr, /\[S3\] \[WARN\] \[SchemaDrift\]/, 'no greppable S3 WARN prefix on stderr');
  assert.match(stderr, /lastActiveTimestamp/, 'missing column not named in the stderr block');
  assert.match(stderr, /!s3 migrate force/, 'stderr block does not say how to recover');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Mode toggle — 'off' restores pre-1.3.0 behaviour
// ═══════════════════════════════════════════════════════════════════════════

test('the default writes nothing to stderr — upgrading changes no logs', async () => {
  // The guarantee for every operator who did not ask for this: a failing
  // migration still reports exactly where it always did, and the error stream
  // stays untouched. Everything else in this file is opt-in behaviour.
  const { stdout, stderr } = capture('unconfigured-default');
  assert.ok(stdout.includes('child-stdout-marker'), 'fixture did not run to completion');
  assert.equal(stderr.trim(), '', `default mode wrote to stderr:\n${stderr}`);
});

test("mode 'off' writes nothing to stderr", async () => {
  const { stdout, stderr } = capture('mode-off');
  assert.ok(stdout.includes('child-stdout-marker'), 'fixture did not run to completion');
  assert.equal(stderr.trim(), '', `stderr should be empty under mode 'off', got:\n${stderr}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4b. 'auto' mode — mirror when the streams are separate, stay quiet when merged
// ═══════════════════════════════════════════════════════════════════════════

test("'auto' mirrors when stdout and stderr are separate", async () => {
  const { stderr } = capture('auto-mode');
  assert.match(stderr, /\[S3\] \[ERROR\] \[AutoCase\]/, 'auto mode should mirror to a separate stderr');
});

test("'auto' stays quiet when both streams share one destination", async () => {
  // Both descriptors are the SAME open file — the shape of a console window or
  // `node index.js > squadjs.log 2>&1`. A copy there would print every error
  // twice in the one place the operator is reading.
  const merged = path.join(os.tmpdir(), `s3-merged-${process.pid}-${Date.now()}.log`);
  const fd = fs.openSync(merged, 'w');
  try {
    const result = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, S3_STDERR_CASE: 'auto-mode' },
      stdio: ['ignore', fd, fd],
      timeout: 30000
    });
    assert.equal(result.status, 0, 'child did not exit cleanly');
    fs.fsyncSync(fd);
    const contents = fs.readFileSync(merged, 'utf-8');
    assert.ok(contents.includes('child-stdout-marker'), 'fixture did not run to completion');
    assert.ok(
      !contents.includes('[S3] [ERROR]'),
      `auto mode wrote to a merged stream — the operator would see doubles:\n${contents}`
    );
  } finally {
    fs.closeSync(fd);
    fs.rmSync(merged, { force: true });
  }
});

test("explicit 'mirror' still writes even when the streams are merged", async () => {
  // The override exists for operators who know their setup better than the
  // heuristic does; it must not be second-guessed by the detection.
  const merged = path.join(os.tmpdir(), `s3-merged-forced-${process.pid}-${Date.now()}.log`);
  const fd = fs.openSync(merged, 'w');
  try {
    const result = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, S3_STDERR_CASE: 'forced-mirror' },
      stdio: ['ignore', fd, fd],
      timeout: 30000
    });
    assert.equal(result.status, 0, 'child did not exit cleanly');
    fs.fsyncSync(fd);
    const contents = fs.readFileSync(merged, 'utf-8');
    assert.match(contents, /\[S3\] \[ERROR\] \[ForcedCase\]/, "explicit 'mirror' was suppressed");
  } finally {
    fs.closeSync(fd);
    fs.rmSync(merged, { force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4c. Configuration ordering — the channel must be live before plugins fail
// ═══════════════════════════════════════════════════════════════════════════

test('S³ configures the channel in prepareToMount, not only in mount', async () => {
  // Found on a live server, invisible to every other test here. The setting was
  // originally applied at the top of mount(), but SquadJS calls prepareToMount()
  // on ALL plugins before mounting any of them — and S3DiscordPluginBase fetches
  // its Discord channel during prepareToMount. So a channel-fetch failure, one of
  // the sites this module explicitly covers, was reported while the mode was
  // still the 'off' default and never reached the error file.
  //
  // A source-level check because the ordering is the property under test: any
  // in-process harness would have to reproduce SquadJS's lifecycle to observe it,
  // which is what let the bug through in the first place.
  const source = fs.readFileSync(
    path.join(path.dirname(__filename), '..', 'plugins', 'slackers-squad-services.js'),
    'utf-8'
  );

  const prepareIndex = source.indexOf('async prepareToMount()');
  const mountIndex = source.indexOf('async mount()');
  assert.ok(prepareIndex > -1, 'prepareToMount() not found');
  assert.ok(mountIndex > -1, 'mount() not found');

  const prepareBody = source.slice(prepareIndex, mountIndex > prepareIndex ? mountIndex : source.length);
  assert.match(
    prepareBody,
    /_configureStderrDiagnostics\(\)/,
    'prepareToMount() no longer configures the stderr channel — failures during plugin preparation ' +
      '(a bad Discord channelID, for one) will be silently dropped whatever the operator configured'
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Flood control — a per-tick failure must not fill the disk
// ═══════════════════════════════════════════════════════════════════════════

test('500 identical events produce one block plus a suppressed count', async () => {
  const { stderr } = capture('dedupe-flood');
  const blocks = stderr.match(/\[S3\] \[ERROR\]/g) || [];
  // One for the first occurrence, one for the flushed tally.
  assert.equal(blocks.length, 2, `expected 2 stderr blocks, got ${blocks.length}`);
  assert.match(stderr, /suppressed 499 identical event\(s\)/, 'suppressed count missing or wrong');
});

test('distinct failures are not collapsed into one another', async () => {
  const { stderr } = capture('dedupe-distinct');
  const blocks = stderr.match(/\[S3\] \[ERROR\]/g) || [];
  assert.equal(blocks.length, 3, `expected 3 distinct blocks, got ${blocks.length}`);
  assert.match(stderr, /first kind of failure/);
  assert.match(stderr, /second kind of failure/);
  assert.match(stderr, /third kind of failure/);
});

test('the same failure across many players collapses to one entry', async () => {
  const { stderr } = capture('dedupe-per-player');
  const blocks = stderr.match(/\[S3\] \[ERROR\]/g) || [];
  assert.equal(blocks.length, 2, `expected 1 block + 1 tally, got ${blocks.length}`);
  assert.match(stderr, /suppressed 49 identical event\(s\)/, 'per-player events did not group');
});

test('a closed window emits its tally, then the next event writes again', async () => {
  const { stderr } = capture('dedupe-window-expiry');
  const blocks = stderr.match(/\[S3\] \[ERROR\]/g) || [];
  // First occurrence, the tally for what was suppressed, then the occurrence
  // that reopened the window. The tally is its own line so its timestamp
  // marks the end of the window rather than the arrival of a new event.
  assert.equal(blocks.length, 3, `expected 3 blocks across the window boundary, got ${blocks.length}`);
  assert.match(stderr, /suppressed 5 identical event\(s\)/, 'count from the closed window missing');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await run();
