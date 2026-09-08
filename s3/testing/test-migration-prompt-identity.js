/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   MIGRATION PROMPT / CONFIRM — SERVER IDENTITY IS DISTINCT    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Regression cover for a multi-server incident: two SquadJS processes sharing
 * one database each minted their own confirmation token and posted a migration
 * prompt to the same admin channel. The two embeds were visually identical —
 * they differed only in the token value. The operator typed one token; the
 * process that had minted the *other* one also received the `!s3 confirm`
 * command, rejected it, and posted a red "Invalid or Expired Token" failure
 * embed while the first process ran the migration. One typed command, one
 * real migration, and one failure embed next to it.
 *
 * Two properties under test:
 *
 *   1. The `pending` prompt embed names which server it is from, on its first
 *      line, and that line does not depend on the multi-server footer label
 *      (which suppresses itself while only one server is registered — exactly
 *      the first-shared-boot window where the collision happens).
 *
 *   2. `!s3 confirm <wrong-token>` on a process that is still holding a live
 *      token of its own answers in grey ("Token Not Issued Here"), not red —
 *      it cannot know another server acted, only that it did not mint this
 *      token. A process holding no live token at all still answers red.
 *
 * Category: 2 (requires DB access — in-memory SQLite, no Docker)
 * Run:    node s3/testing/test-migration-prompt-identity.js
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
import { buildMigrationEmbed, formatServerIdentity } from '../utils/s3-migration-discord.js';


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
  console.log('Migration Prompt / Confirm — Server Identity');
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

const plugin = { localize: (key, vars) => lookupMessage(key, vars) };


// ---------------------------------------------------------------------------
// Harness: real DBService + MigrationEngine, one pending migration, run
// `!s3 confirm ...` through the real handler. Adapted from
// test-migrate-flag-safety.js; adds a token-mint hook so the `!accepted`
// branch can be exercised in both of its states.
// ---------------------------------------------------------------------------

// Register the harness at an id that is neither the single-server default (1)
// nor a plausible array index, so the only place `server 4242` can appear in a
// rendered embed is formatServerIdentity() itself. A test that asserts on the
// default id can pass against a renderer that emits no identity at all, because
// something else in the fixture supplies that digit for free.
const HARNESS_SERVER_ID = 4242;

async function runConfirm(argv, { mintToken = null, serverOptions = null } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-ident-test-'));
  const sequelize = new Sequelize({
    dialect: 'sqlite', storage: ':memory:', logging: false, define: { freezeTableName: true }
  });

  const dbService = new DBService({ sequelize, serverID: HARNESS_SERVER_ID, verboseLogger: () => {} });
  await dbService.mount();
  dbService._migrationEngine = new MigrationEngine({
    dbService, verboseLogger: () => {}, backupDir: tempDir
  });

  const engine = dbService.migrationEngine;
  let applied = 0;

  dbService.registerExpectedVersion('ident-test', 1);
  engine.registerMigrations('ident-test', [{
    version: 1,
    description: 'Observable no-op',
    backup: false,
    touches: {},
    up: async () => { applied++; }
  }]);

  // Mint a token the way slackers-squad-services.js does, but without standing
  // up the whole prompt path: the branch under test only reads _confirmToken
  // and _tokenExpiresAt.
  if (mintToken) {
    engine._confirmToken = mintToken;
    engine._tokenExpiresAt = Date.now() + 5 * 60 * 1000;
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

  const cmdPlugin = {
    services: { db: dbService },
    server: serverOptions ? { options: serverOptions } : undefined,
    options: {},
    verbose: () => {},
    localize: (key, vars) => lookupMessage(key, vars)
  };

  await handlers.get(argv[0])(cmdPlugin, message, argv);

  const embeds = captured.map((p) => p?.embeds?.[0]).filter(Boolean);

  try { await sequelize.close(); } catch { /* ignore */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

  return { applied, engine, embeds, serverID: dbService.getServerID() };
}


// ---------------------------------------------------------------------------
// formatServerIdentity
// ---------------------------------------------------------------------------

test('formatServerIdentity: the registry id is always in the string', async () => {
  const db = {
    getServerID: () => 7,
    isReady: () => true,
    getRegisteredServers: async () => []
  };
  const s = await formatServerIdentity(db, null);
  assert.match(s, /server 7/, `id missing from ${JSON.stringify(s)}`);
});

test('formatServerIdentity: a distinct name is used, id still present and the two servers differ', async () => {
  const rows = [
    { serverID: 1, alias: 'slackers-1', serverName: 'NL Slackers Main', suiteVersion: '1' },
    { serverID: 2, alias: 'slackers-2', serverName: 'NL Slackers Event', suiteVersion: '1' }
  ];
  const mk = (id) => ({ getServerID: () => id, isReady: () => true, getRegisteredServers: async () => rows });
  const one = await formatServerIdentity(mk(1), null);
  const two = await formatServerIdentity(mk(2), null);
  assert.match(two, /server 2/, `id missing from ${JSON.stringify(two)}`);
  assert.notEqual(one, two, 'the two servers produced the same identity string');
});

test('formatServerIdentity: falls back to the row alias when names collide and no label is distinct', async () => {
  // Identical serverName on both rows — serverLabels() drops the collision and
  // returns null for each, so the alias is what is left to name the server by.
  const rows = [
    { serverID: 1, alias: 'slackers-1', serverName: 'NL Slackers', suiteVersion: '1' },
    { serverID: 2, alias: 'slackers-2', serverName: 'NL Slackers', suiteVersion: '1' }
  ];
  const db = {
    getServerID: () => 2,
    isReady: () => true,
    getRegisteredServers: async () => rows
  };
  const s = await formatServerIdentity(db, null);
  assert.match(s, /slackers-2/, `alias fallback missing from ${JSON.stringify(s)}`);
  assert.match(s, /server 2/, `id missing from ${JSON.stringify(s)}`);
});

test('formatServerIdentity: host:port is appended when the server carries it', async () => {
  const db = {
    getServerID: () => 3,
    isReady: () => true,
    getRegisteredServers: async () => []
  };
  const s = await formatServerIdentity(db, { options: { host: '127.0.0.1', queryPort: 21114 } });
  assert.match(s, /127\.0\.0\.1:21114/, `host:port missing from ${JSON.stringify(s)}`);
  assert.match(s, /server 3/, `id missing from ${JSON.stringify(s)}`);
});

test('formatServerIdentity: a registry read failure still yields the id', async () => {
  const db = {
    getServerID: () => 9,
    isReady: () => true,
    getRegisteredServers: async () => { throw new Error('registry down'); }
  };
  const s = await formatServerIdentity(db, null);
  assert.match(s, /server 9/, `id missing from ${JSON.stringify(s)}`);
});

test('formatServerIdentity: an unready service is not queried and still yields the id', async () => {
  // The prompt path calls this before the migration gate resolves — the point
  // in the boot where the DB is least settled. isReady() false must skip the
  // lookup outright, not fall into it and rely on the catch.
  let queried = false;
  const db = {
    getServerID: () => 4,
    isReady: () => false,
    getRegisteredServers: async () => { queried = true; return []; }
  };
  const s = await formatServerIdentity(db, { options: { host: '10.0.0.1', queryPort: 27165 } });
  assert.equal(queried, false, 'getRegisteredServers() was called on an unready service');
  assert.match(s, /server 4/, `id missing from ${JSON.stringify(s)}`);
  assert.match(s, /10\.0\.0\.1:27165/, `host:port missing from ${JSON.stringify(s)}`);
});

test('formatServerIdentity: a null db does not throw', async () => {
  const s = await formatServerIdentity(null, null);
  assert.equal(typeof s, 'string', `expected a string, got ${JSON.stringify(s)}`);
  assert.match(s, /server \?/, `expected the unknown-id form, got ${JSON.stringify(s)}`);
});


// ---------------------------------------------------------------------------
// buildMigrationEmbed — the identity line
// ---------------------------------------------------------------------------

const pending = [{ pluginName: 'elo-tracker', currentVersion: 0, expectedVersion: 3, behind: 3 }];

test('buildMigrationEmbed: identity is the first line of a pending prompt', async () => {
  const embed = buildMigrationEmbed(plugin, pending, 'pending', null, 'slackers-2 (server 2)');
  const firstLine = embed.description.split('\n')[0];
  assert.match(firstLine, /slackers-2 \(server 2\)/, `identity not on line 1: ${firstLine}`);
  // The instructions the operator needs are still there.
  assert.match(embed.description, /!s3 confirm <token>/, 'confirm instructions dropped');
});

test('buildMigrationEmbed: no identity arg leaves the prompt byte-for-byte as before', async () => {
  const withNull = buildMigrationEmbed(plugin, pending, 'pending', null, null);
  const without = buildMigrationEmbed(plugin, pending, 'pending', null);
  assert.equal(withNull.description, without.description, 'null identity changed the description');
  assert.doesNotMatch(withNull.description, /Migration prompt from/, 'identity line leaked in with no identity');
});

test('buildMigrationEmbed: identity is not added to non-pending statuses', async () => {
  for (const status of ['running', 'complete', 'failed']) {
    const embed = buildMigrationEmbed(plugin, pending, status, { totalApplied: 1, totalSkipped: 0, error: 'x' }, 'server 2');
    assert.doesNotMatch(embed.description, /Migration prompt from/, `identity line appeared on '${status}'`);
  }
});


// ---------------------------------------------------------------------------
// !s3 confirm — the grey / red split
// ---------------------------------------------------------------------------

test('confirm: a wrong token, while this process holds a live one, answers grey and names the server', async () => {
  const { applied, embeds } = await runConfirm(['confirm', 'deadbeef'], { mintToken: 'a1b2c3d4' });

  assert.equal(applied, 0, 'a wrong token ran a migration');
  const e = embeds.at(-1);
  assert.ok(e, 'no embed was posted');
  assert.equal(e.color, 0x95a5a6, `expected grey, got ${e.color?.toString(16)}`);
  assert.match(e.title, /Token Not Issued Here/, `wrong title: ${e.title}`);
  assert.match(e.description, /server 4242/, `server identity missing: ${e.description}`);
  assert.doesNotMatch(e.description, /Invalid or Expired/i, 'grey path still used the red wording');
});

test('confirm: a wrong token, with no live token on this process, still answers red — and names the server', async () => {
  const { applied, embeds } = await runConfirm(['confirm', 'deadbeef'], { mintToken: null });

  assert.equal(applied, 0, 'a wrong token ran a migration');
  const e = embeds.at(-1);
  assert.ok(e, 'no embed was posted');
  assert.equal(e.color, 0xe74c3c, `expected red, got ${e.color?.toString(16)}`);
  assert.match(e.title, /Invalid or Expired Token/, `wrong title: ${e.title}`);
  assert.match(e.description, /On \*\*server 4242\*\*/, `server prefix missing: ${e.description}`);
});

test('confirm: the minting process still accepts its own token and migrates', async () => {
  const { applied, embeds } = await runConfirm(['confirm', 'a1b2c3d4'], { mintToken: 'a1b2c3d4' });

  assert.equal(applied, 1, 'the correct token did not run the migration');
  const titles = embeds.map((e) => e.title).join(' | ');
  assert.doesNotMatch(titles, /Token Not Issued Here|Invalid or Expired/, `a rejection embed was posted anyway: ${titles}`);
});

test('confirm: an expired token answers red, not grey — expiry nulls the held token', async () => {
  const { embeds } = await runConfirm(['confirm', 'a1b2c3d4'], { mintToken: 'a1b2c3d4' });
  // Re-run with an already-expired mint.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-ident-exp-'));
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false, define: { freezeTableName: true } });
  const dbService = new DBService({ sequelize, serverID: HARNESS_SERVER_ID, verboseLogger: () => {} });
  await dbService.mount();
  dbService._migrationEngine = new MigrationEngine({ dbService, verboseLogger: () => {}, backupDir: tempDir });
  const engine = dbService.migrationEngine;
  dbService.registerExpectedVersion('ident-test', 1);
  engine.registerMigrations('ident-test', [{ version: 1, description: 'x', backup: false, touches: {}, up: async () => {} }]);
  engine._confirmToken = 'a1b2c3d4';
  engine._tokenExpiresAt = Date.now() - 1000; // already expired

  const captured = [];
  const { handlers } = cmds.createCommandHandlers({
    sendDiscordMessage: async (_c, payload) => { captured.push(payload); },
    watchManager: null, stagedImportRef: { current: null }
  });
  const message = {
    channel: { id: 'c1', send: async (p) => { captured.push(p); return { id: 'x' }; } },
    author: { id: 'u1' }, reply: async (p) => { captured.push(p); return { id: 'x' }; },
    attachments: { first: () => null }
  };
  await handlers.get('confirm')({
    services: { db: dbService }, options: {}, verbose: () => {},
    localize: (key, vars) => lookupMessage(key, vars)
  }, message, ['confirm', 'a1b2c3d4']);

  const e = captured.map((p) => p?.embeds?.[0]).filter(Boolean).at(-1);
  try { await sequelize.close(); } catch { /* ignore */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }

  assert.ok(e, 'no embed was posted');
  assert.equal(e.color, 0xe74c3c, `an expired token answered in grey (${e.color?.toString(16)}), not red`);
  assert.match(e.title, /Invalid or Expired Token/, `wrong title: ${e.title}`);
  void embeds;
});


run();
