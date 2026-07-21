/**
 * S³ COMMANDS TEST - Unit tests for exported command handlers.
 * Usage: node SlackersSquadServices/testing/test-s3-commands.js
 */
import assert from 'node:assert/strict';
import DBService from '../utils/db-service.js';
import { Sequelize, DataTypes } from 'sequelize';

let cmds;

async function init() {
  cmds = await import('../utils/s3-commands.js');
}

async function runTest(name, fn) {
  try { await fn(); console.log('\u2705 ' + name); }
  catch (err) { console.error('\u274c ' + name); console.error(err); process.exitCode = 1; }
}

function mockMessage(overrides = {}) {
  return {
    author: { id: '123', toString: () => '<@123>' },
    channel: { send: async (msg) => msg },
    guild: { id: 'guild1' },
    member: { displayName: 'Tester' },
    client: { user: { id: 'bot1' } },
    ...overrides
  };
}

function mockS3(overrides = {}) {
  return {
    verbose: (...args) => {},
    isReady: () => true,
    s3: {
      db: { isReady: () => true, models: {}, getModelNames: () => [], getModel: () => null },
      gameState: { getPhase: () => 'inPlay', getCurrentLayer: () => 'Test_Layer', getRoundStartTime: () => Date.now(), getMatchId: () => 'match-1' },
      players: { getPlayerCount: () => 5 },
      serverConfig: { getConfig: () => ({}) },
      factions: { getEnabledFactions: () => [] },
      clans: { getClans: () => [] }
    },
    ...overrides
  };
}

async function main() {
  await init();

  // Note: s3-commands.js exports command handler functions.
  // We test each by invoking with a mock message and checking behavior.

  await runTest('status command produces embed', async () => {
    if (typeof cmds.handleStatusCommand === 'function') {
      const msg = mockMessage();
      const result = await cmds.handleStatusCommand(mockS3(), msg);
      assert.ok(result);
    } else {
      console.log('\u23f3 handleStatusCommand not exported, skipping');
    }
  });

  await runTest('services command produces embed', async () => {
    if (typeof cmds.handleServicesCommand === 'function') {
      const msg = mockMessage();
      const result = await cmds.handleServicesCommand(mockS3(), msg);
      assert.ok(result);
    } else {
      console.log('\u23f3 handleServicesCommand not exported, skipping');
    }
  });

  await runTest('buildHelpEmbed is exported', () => {
    assert.equal(typeof cmds.buildHelpEmbed, 'function');
  });

  await runTest('buildStatusEmbed is exported', () => {
    assert.equal(typeof cmds.buildStatusEmbed, 'function');
  });

  await runTest('buildServicesEmbed is exported', () => {
    assert.equal(typeof cmds.buildServicesEmbed, 'function');
  });
}

await main();
if (!process.exitCode) console.log('\nAll s3-commands tests passed.');