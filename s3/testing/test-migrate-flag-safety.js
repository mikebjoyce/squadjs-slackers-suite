/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     CATEGORY 2 — DESTRUCTIVE-COMMAND FLAG SAFETY              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Regression cover for a live incident: an admin ran
 *
 *     !s3 migrate force [--dry-run]
 *
 * — the usage line copied out of `!s3 help`, square brackets and all — and the
 * server applied a real schema migration. `args.includes('--dry-run')` is an
 * exact-match test, `[--dry-run]` is not `--dry-run`, so the safety flag read
 * false and the command took its unflagged default, which is to migrate.
 *
 * The property under test is narrow and absolute: **a command that the operator
 * asked to preview must not write.** These tests drive the real `migrate`, `db`
 * and `confirm` handlers over a real MigrationEngine and a real in-memory
 * SQLite DBService, and the ground truth is whether a migration's `up()` ran —
 * not what the reply embed said, since the embed in the incident cheerfully
 * reported success.
 *
 * Category: 2 (requires DB access — in-memory SQLite, no Docker)
 * Run:    node s3/testing/test-migrate-flag-safety.js
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize } from 'sequelize';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import DBService from '../utils/db-service.js';
import MigrationEngine from '../utils/migration-engine.js';
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
  console.log('Destructive-Command Flag Safety Test');
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
// Harness: a real engine with one pending migration whose up() is observable
// ---------------------------------------------------------------------------

/**
 * Stand up a DBService + MigrationEngine with exactly one pending migration for
 * a fake plugin, then run `!s3 <args...>` through the real command handler.
 *
 * `applied` is the count of times the migration's `up()` actually executed. It
 * is the only assertion that matters here: the incident's embed said
 * "✅ S³ Migration Complete", so an embed-shaped assertion would have passed
 * against the broken code.
 */
async function runCommand(argv) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-flag-test-'));
  const sequelize = new Sequelize({
    dialect: 'sqlite', storage: ':memory:', logging: false, define: { freezeTableName: true }
  });

  const dbService = new DBService({ sequelize, verboseLogger: () => {} });
  await dbService.mount();
  dbService._migrationEngine = new MigrationEngine({
    dbService, verboseLogger: () => {}, backupDir: tempDir
  });

  const engine = dbService.migrationEngine;
  let applied = 0;

  dbService.registerExpectedVersion('flag-test', 1);
  engine.registerMigrations('flag-test', [{
    version: 1,
    description: 'Observable no-op',
    backup: false,
    touches: {},
    up: async () => { applied++; }
  }]);

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

  const embeds = captured.map((p) => p?.embeds?.[0]).filter(Boolean);
  const replies = captured.filter((p) => typeof p === 'string');

  try {
    await sequelize.close();
  } catch { /* ignore */ }
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch { /* ignore */ }

  return { applied, engine, embeds, replies, text: JSON.stringify(captured) };
}


// ---------------------------------------------------------------------------
// The incident
// ---------------------------------------------------------------------------

test('the exact incident: `!s3 migrate force [--dry-run]` writes nothing', async () => {
  const { applied, embeds } = await runCommand(['migrate', 'force', '[--dry-run]']);

  // This is the assertion the incident needed. Before the fix it was 1.
  assert.equal(applied, 0, 'a bracketed --dry-run applied a real migration');

  // And it must say so, rather than failing silently the way an unrecognised
  // flag that merely gets ignored would.
  const title = embeds.map((e) => e.title).join(' ');
  assert.match(title, /Unrecognised Argument/, `expected a refusal, got: ${title}`);
});

test('a correctly spelled --dry-run still previews and still writes nothing', async () => {
  const { applied, embeds } = await runCommand(['migrate', 'force', '--dry-run']);
  assert.equal(applied, 0, 'a real dry run applied a migration');
  const title = embeds.map((e) => e.title).join(' ');
  assert.match(title, /Dry Run/i, `expected the dry-run report, got: ${title}`);
});

test('a dry run leaves the engine unarmed', async () => {
  // confirmToken() latches `_confirmed` and short-circuits to true forever
  // after. Arming it from the dry-run path meant a *preview* authorised the
  // next migration by any route — including `!s3 confirm <anything>`, which
  // would then be accepted despite matching no token.
  const { engine } = await runCommand(['migrate', 'force', '--dry-run']);
  assert.equal(engine._confirmed, false, 'a dry run armed the migration engine');
  assert.equal(engine.confirmToken('not-a-real-token'), false,
    'after a dry run, a bogus confirmation token was accepted');
});

test('`!s3 migrate force` with no flags still migrates — the guard is not a blanket block', async () => {
  const { applied } = await runCommand(['migrate', 'force']);
  assert.equal(applied, 1, 'the guard blocked a legitimate forced migration');
});


// ---------------------------------------------------------------------------
// The same class, on the other destructive commands
// ---------------------------------------------------------------------------

test('`!s3 confirm <token>` pasted verbatim is refused, not tried as a token', async () => {
  const { applied, embeds } = await runCommand(['confirm', '<token>']);
  assert.equal(applied, 0);
  const title = embeds.map((e) => e.title).join(' ');
  assert.match(title, /Unrecognised Argument/, `expected a refusal, got: ${title}`);
});

test('`!s3 migrate purge-deprecated [--confirm]` is refused', async () => {
  const { embeds } = await runCommand(['migrate', 'purge-deprecated', '[--confirm]']);
  const title = embeds.map((e) => e.title).join(' ');
  assert.match(title, /Unrecognised Argument/, `expected a refusal, got: ${title}`);
});

test('`!s3 db import [--confirm]` is refused', async () => {
  const { embeds } = await runCommand(['db', 'import', '[--confirm]']);
  const title = embeds.map((e) => e.title).join(' ');
  assert.match(title, /Unrecognised Argument/, `expected a refusal, got: ${title}`);
});

test('the refusal names the offending argument and the flags that would work', async () => {
  const { embeds } = await runCommand(['migrate', 'force', '[--dry-run]']);
  const desc = embeds.map((e) => e.description || '').join('\n');
  assert.match(desc, /\[--dry-run\]/, 'the refusal did not quote the bad argument back');
  assert.match(desc, /`--dry-run`/, 'the refusal did not name the accepted flag');
});

test('a subcommand that takes no flags says so in words, not as an empty list', async () => {
  // `!s3 confirm` accepts nothing, and rendering that as "accepts: —" read as a
  // rendering fault when this was first run live.
  const { embeds } = await runCommand(['confirm', '<token>']);
  const desc = embeds.map((e) => e.description || '').join('\n');
  assert.match(desc, /takes no flags/, `expected the no-flags wording, got: ${desc}`);
  assert.doesNotMatch(desc, /accepts: —/, 'the empty flag list rendered as a dash');
});


// ---------------------------------------------------------------------------
// Positional arguments must survive — this guard sits in front of live commands
// ---------------------------------------------------------------------------

test('a real confirmation token is not mistaken for a stray flag', async () => {
  // Tokens are 8 hex characters, so nothing in this guard should see them.
  const { embeds } = await runCommand(['confirm', '5aa567cd']);
  const title = embeds.map((e) => e.title).join(' ');
  assert.doesNotMatch(title, /Unrecognised Argument/,
    'a well-formed token was rejected as a stray flag');
});

test('`!s3 db export --all` and its siblings pass through', async () => {
  for (const flag of ['--logs', '--all', '--to-file']) {
    const { embeds } = await runCommand(['db', 'export', flag]);
    const title = embeds.map((e) => e.title).join(' ');
    assert.doesNotMatch(title, /Unrecognised Argument/, `${flag} was rejected`);
  }
});


run();
