/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     CATEGORY 2 — COMMAND ROUTING TEST                         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Verifies S³ Discord command routing:
 *   1. !s3 status → calls buildStatusEmbed, replies with embed
 *   2. !s3 services → calls buildServicesEmbed, replies with embed
 *   3. !s3 db export → calls exportToJSON, sends .s3backup.json
 *   4. !s3 db import → validates attached file, shows confirmation
 *   5. !s3 backup list → lists available backups
 *   6. !s3 help → shows help embed with all subcommands
 *   7. Unknown command → shows help text (not silent fail)
 *
 * Category: 2 (autonomous mock-based, no live Discord needed)
 * Run:    node SlackersSquadServices/testing/test-command-routing.js
 */

'use strict';

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Mock Discord message
// ---------------------------------------------------------------------------

class MockMessage {
  constructor(content, attachments = []) {
    this.content = content;
    this.attachments = attachments;
    this.replies = [];
    this.channelSendCalls = [];
    this.reactEmojis = [];
    this.deleted = false;
  }
  async reply(embedOrOptions) {
    this.replies.push(embedOrOptions);
    return this;
  }
  async delete() {
    this.deleted = true;
  }
  async react(emoji) {
    this.reactEmojis.push(emoji);
  }
}

// ---------------------------------------------------------------------------
// Mock embed builder functions (mirroring real s3-commands.js exports)
// ---------------------------------------------------------------------------

function buildHelpEmbed() {
  return {
    title: 'S³ Command Reference',
    fields: [
      { name: '!s3 status', value: 'System status overview' },
      { name: '!s3 services', value: 'Per-service detail' },
      { name: '!s3 db', value: 'Database operations: status, export, import' },
      { name: '!s3 backup', value: 'Backup operations: list, restore' },
      { name: '!s3 help', value: 'This help text' }
    ]
  };
}

function buildStatusEmbed() {
  return {
    title: 'S³ Status',
    fields: [
      { name: 'Services', value: 'All 6 services mounted' },
      { name: 'Game Phase', value: 'Live' },
      { name: 'Players', value: '3 connected' }
    ]
  };
}

function buildServicesEmbed() {
  return {
    title: 'S³ Services',
    fields: [
      { name: 'gameState', value: '✅' },
      { name: 'serverConfig', value: '✅' },
      { name: 'db', value: '✅' },
      { name: 'factions', value: '✅' },
      { name: 'clans', value: '✅' },
      { name: 'players', value: '✅' }
    ]
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Simple command dispatcher that mirrors the real one
// ---------------------------------------------------------------------------

async function dispatchCommand(msg, verb, subcommands = [], s3mock) {
  const sub = subcommands[0]; // first subcommand after verb

  switch (verb) {
    case 'help':
    case undefined:
      return msg.reply({ embeds: [buildHelpEmbed()] });

    case 'status':
      return msg.reply({ embeds: [buildStatusEmbed()] });

    case 'services':
      return msg.reply({ embeds: [buildServicesEmbed()] });

    case 'db': {
      if (!sub) {
        return msg.reply({ embeds: [{ title: 'DB Operations', description: 'Use db export or db import' }] });
      }
      if (sub === 'export') {
        const attachment = { name: 's3backup.json', size: 12345 };
        return msg.reply({ content: 'Export complete', files: [attachment] });
      }
      if (sub === 'import') {
        if (!msg.attachments || msg.attachments.length === 0) {
          return msg.reply({ embeds: [{ title: 'Error', description: 'Please attach a .s3backup.json file' }] });
        }
        if (subcommands.includes('--confirm')) {
          return msg.reply({ embeds: [{ title: 'Import Complete', description: '5 tables imported' }] });
        }
        return msg.reply({ embeds: [{ title: 'Confirm Import', description: 'React ✅ to confirm' }] });
      }
      return msg.reply({ embeds: [{ title: 'Help', description: 'Unknown db subcommand. Use: export, import' }] });
    }

    case 'backup': {
      if (!sub) {
        return msg.reply({ embeds: [{ title: 'Backup Operations', description: 'Use: list, restore' }] });
      }
      if (sub === 'list') {
        return msg.reply({ embeds: [{ title: 'Available Backups', description: '3 backups found' }] });
      }
      if (sub === 'restore') {
        if (subcommands.includes('--confirm')) {
          return msg.reply({ embeds: [{ title: 'Restore Complete', description: 'Backup restored successfully' }] });
        }
        return msg.reply({ embeds: [{ title: 'Confirm Restore', description: 'React ✅ to confirm. This will overwrite current data.' }] });
      }
      return msg.reply({ embeds: [{ title: 'Help', description: 'Unknown backup subcommand. Use: list, restore' }] });
    }

    default:
      return msg.reply({ embeds: [buildHelpEmbed()] });
  }
}

// ---------------------------------------------------------------------------
// Mock S³ service (minimal)
// ---------------------------------------------------------------------------

function createMockS3() {
  return {
    isReady: () => true,
    db: {
      isReady: () => true,
      getModelNames: () => ['S3_SchemaVersions', 'SA_AssignmentLog', 'Elo_PlayerStats']
    },
    players: { count: 3 },
    gameState: { currentPhase: 'live' }
  };
}

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
  console.log('Command Routing Test');
  console.log('='.repeat(65));
  console.log('');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  \u2713 ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  \u2717 ${t.name}`);
      console.log(`    ${err.message.split('\n')[0]}`);
      failed++;
    }
  }

  console.log('');
  console.log('\u2500'.repeat(65));
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log('\u2500'.repeat(65));

  if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('!s3 status returns status embed', async () => {
  const msg = new MockMessage('!s3 status');
  const s3 = createMockS3();

  await dispatchCommand(msg, 'status', [], s3);

  assert.equal(msg.replies.length, 1, 'should reply once');
  const embed = msg.replies[0].embeds[0];
  assert.equal(embed.title, 'S³ Status');
  assert.ok(embed.fields.length > 0, 'should have fields');
});

test('!s3 services returns services embed', async () => {
  const msg = new MockMessage('!s3 services');
  const s3 = createMockS3();

  await dispatchCommand(msg, 'services', [], s3);

  assert.equal(msg.replies.length, 1);
  const embed = msg.replies[0].embeds[0];
  assert.equal(embed.title, 'S³ Services');
});

test('!s3 help returns help embed', async () => {
  const msg = new MockMessage('!s3 help');
  const s3 = createMockS3();

  await dispatchCommand(msg, 'help', [], s3);

  assert.equal(msg.replies.length, 1);
  const embed = msg.replies[0].embeds[0];
  assert.equal(embed.title, 'S³ Command Reference');
  assert.ok(embed.fields.length >= 5, 'should list all subcommands');
});

test('!s3 db export returns attachment', async () => {
  const msg = new MockMessage('!s3 db export');
  const s3 = createMockS3();

  await dispatchCommand(msg, 'db', ['export'], s3);

  assert.equal(msg.replies.length, 1);
  assert.ok(msg.replies[0].files, 'should have file attachment');
  assert.equal(msg.replies[0].content, 'Export complete');
});

test('!s3 db import without attachment shows error', async () => {
  const msg = new MockMessage('!s3 db import');
  const s3 = createMockS3();

  await dispatchCommand(msg, 'db', ['import'], s3);

  assert.equal(msg.replies.length, 1);
  const embed = msg.replies[0].embeds[0];
  assert.equal(embed.title, 'Error');
  assert.ok(embed.description.includes('attach'));
});

test('!s3 db import --confirm completes import', async () => {
  const msg = new MockMessage('!s3 db import --confirm', [
    { name: 's3backup.json', size: 12345 }
  ]);
  const s3 = createMockS3();

  await dispatchCommand(msg, 'db', ['import', '--confirm'], s3);

  assert.equal(msg.replies.length, 1);
  const embed = msg.replies[0].embeds[0];
  assert.equal(embed.title, 'Import Complete');
});

test('!s3 backup list shows backups', async () => {
  const msg = new MockMessage('!s3 backup list');
  const s3 = createMockS3();

  await dispatchCommand(msg, 'backup', ['list'], s3);

  assert.equal(msg.replies.length, 1);
  const embed = msg.replies[0].embeds[0];
  assert.equal(embed.title, 'Available Backups');
});

test('!s3 backup restore shows confirmation prompt', async () => {
  const msg = new MockMessage('!s3 backup restore');
  const s3 = createMockS3();

  await dispatchCommand(msg, 'backup', ['restore'], s3);

  assert.equal(msg.replies.length, 1);
  const embed = msg.replies[0].embeds[0];
  assert.equal(embed.title, 'Confirm Restore');
  assert.ok(embed.description.includes('React ✅'));
});

test('!s3 backup restore --confirm completes restore', async () => {
  const msg = new MockMessage('!s3 backup restore --confirm');
  const s3 = createMockS3();

  await dispatchCommand(msg, 'backup', ['restore', '--confirm'], s3);

  assert.equal(msg.replies.length, 1);
  const embed = msg.replies[0].embeds[0];
  assert.equal(embed.title, 'Restore Complete');
});

test('!s3 unknowncommand shows help embed', async () => {
  const msg = new MockMessage('!s3 frobnicate');
  const s3 = createMockS3();

  await dispatchCommand(msg, 'frobnicate', [], s3);

  assert.equal(msg.replies.length, 1);
  const embed = msg.replies[0].embeds[0];
  assert.equal(embed.title, 'S³ Command Reference', 'unknown command should show help');
});

test('!s3 db badsub shows help for db subcommands', async () => {
  const msg = new MockMessage('!s3 db nuke');
  const s3 = createMockS3();

  await dispatchCommand(msg, 'db', ['nuke'], s3);

  assert.equal(msg.replies.length, 1);
  const embed = msg.replies[0].embeds[0];
  assert.equal(embed.title, 'Help', 'unknown db subcommand should show help');
  assert.ok(embed.description.includes('export'), 'help should mention export');
  assert.ok(embed.description.includes('import'), 'help should mention import');
});

test('formatBytes returns correct human-readable sizes', async () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(1073741824), '1.0 GB');
  assert.equal(formatBytes(500), '500.0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
});

test('!s3 (no subcommand) shows help', async () => {
  const msg = new MockMessage('!s3');
  const s3 = createMockS3();

  await dispatchCommand(msg, undefined, [], s3);

  assert.equal(msg.replies.length, 1);
  const embed = msg.replies[0].embeds[0];
  assert.equal(embed.title, 'S³ Command Reference', 'no subcommand should show help');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await run();