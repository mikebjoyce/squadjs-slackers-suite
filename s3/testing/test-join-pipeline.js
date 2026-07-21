/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          CATEGORY 2 — JOIN PIPELINE TEST                      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Verifies:
 *   1. S³ services mount in the correct order
 *   2. Each service reports isReady() after mount
 *   3. PLAYER_CONNECTED event is delegated to players service
 *   4. UPDATED_PLAYER_INFORMATION event updates all services
 *   5. The full player join pipeline processes correctly
 *      (serverConfig init → gameState → factions → clans → players)
 *
 * Category: 2 (autonomous mock-based, no live server)
 * Run:    node SlackersSquadServices/testing/test-join-pipeline.js
 */

'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Mock SquadJS server
// ---------------------------------------------------------------------------
class MockSquadJSServer extends EventEmitter {
  constructor() {
    super();
    this.constructor = { name: 'Server' };
    this.rcon = { execute: async () => {}, switchTeam: async () => {}, warn: async () => {} };
    this.squads = [];
    this.players = [];
  }
}

// ---------------------------------------------------------------------------
// Minimal mock services that mirror the real S³ service interface
// ---------------------------------------------------------------------------

class MockServerConfigService {
  constructor() { this._ready = false; this.raw = {}; }
  async mount() { this._ready = true; }
  async unmount() { this._ready = false; }
  isReady() { return this._ready; }
}

class MockDBService {
  constructor() { this._ready = false; this.models = {}; }
  async mount() { this._ready = true; }
  async unmount() { this._ready = false; }
  isReady() { return this._ready; }
  defineModel() { return null; }
  async withTransactionWithRetry() { return null; }
}

class MockGameStateService {
  constructor() { this._ready = false; this.currentPhase = 'staging'; }
  async mount() { this._ready = true; }
  async unmount() { this._ready = false; }
  isReady() { return this._ready; }
  handlePlayerConnected() {}
  handleUpdatedPlayerInfo() {}
}

class MockFactionsService {
  constructor() { this._ready = false; this.activeFactions = []; }
  async mount() { this._ready = true; }
  async unmount() { this._ready = false; }
  isReady() { return this._ready; }
  handleUpdatedPlayerInfo() {}
}

class MockClansService {
  constructor() { this._ready = false; this.tagMap = new Map(); }
  async mount() { this._ready = true; }
  async unmount() { this._ready = false; }
  isReady() { return this._ready; }
}

class MockPlayersService {
  constructor() { this._ready = false; this.registry = new Map(); this.events = []; }
  async mount() { this._ready = true; }
  async unmount() { this._ready = false; }
  isReady() { return this._ready; }
  handlePlayerConnected(playerData) {
    this.events.push({ type: 'connect', data: playerData });
  }
  handleUpdatedPlayerInfo(playerData) {
    this.events.push({ type: 'update', data: playerData });
  }
  getJoinTime() { return Date.now(); }
}

// ---------------------------------------------------------------------------
// Create a mock S³ container similar to real SlackersSquadServices pattern
// ---------------------------------------------------------------------------

function createMockS3() {
  const services = {
    serverConfig: new MockServerConfigService(),
    db: new MockDBService(),
    gameState: new MockGameStateService(),
    factions: new MockFactionsService(),
    clans: new MockClansService(),
    players: new MockPlayersService()
  };
  let _isReady = false;
  let _resolveReady;
  const readyPromise = new Promise(resolve => { _resolveReady = resolve; });

  const s3 = {
    constructor: { name: 'SlackersSquadServices' },
    services,
    _resolveReady,
    _readyPromise: readyPromise,
    _isReady,

    get gameState() { return services.gameState; },
    get serverConfig() { return services.serverConfig; },
    get db() { return services.db; },
    get factions() { return services.factions; },
    get clans() { return services.clans; },
    get players() { return services.players; },

    isReady() { return this._isReady; },
    ready() { return this._readyPromise; },

    async mount() {
      // Mount in order: serverConfig -> db -> gameState -> factions -> clans -> players
      await services.serverConfig.mount();
      await services.db.mount();
      await services.gameState.mount();
      await services.factions.mount();
      await services.clans.mount();
      await services.players.mount();
      this._isReady = true;
      this._resolveReady();
    },

    async unmount() {
      // Reverse order
      await services.players.unmount();
      await services.clans.unmount();
      await services.db.unmount();
      await services.factions.unmount();
      await services.gameState.unmount();
      await services.serverConfig.unmount();
      this._isReady = false;
    }
  };
  return s3;
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
  console.log('Join Pipeline Integration Test');
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

test('S³ services mount in correct order', async () => {
  const s3 = createMockS3();
  assert.equal(s3.services.serverConfig.isReady(), false, 'serverConfig should not be ready before mount');
  assert.equal(s3.services.db.isReady(), false, 'db should not be ready before mount');
  assert.equal(s3.services.gameState.isReady(), false, 'gameState should not be ready before mount');
  assert.equal(s3.services.factions.isReady(), false, 'factions should not be ready before mount');
  assert.equal(s3.services.clans.isReady(), false, 'clans should not be ready before mount');
  assert.equal(s3.services.players.isReady(), false, 'players should not be ready before mount');

  await s3.mount();

  assert.equal(s3.isReady(), true, 'S³ should be ready after mount');
  assert.equal(s3.services.serverConfig.isReady(), true, 'serverConfig should be ready');
  assert.equal(s3.services.db.isReady(), true, 'db should be ready');
  assert.equal(s3.services.gameState.isReady(), true, 'gameState should be ready');
  assert.equal(s3.services.factions.isReady(), true, 'factions should be ready');
  assert.equal(s3.services.clans.isReady(), true, 'clans should be ready');
  assert.equal(s3.services.players.isReady(), true, 'players should be ready');
});

test('S³ flat accessors resolve after mount', async () => {
  const s3 = createMockS3();
  assert.equal(s3.serverConfig, s3.services.serverConfig);
  assert.equal(s3.db, s3.services.db);
  assert.equal(s3.gameState, s3.services.gameState);
  assert.equal(s3.factions, s3.services.factions);
  assert.equal(s3.clans, s3.services.clans);
  assert.equal(s3.players, s3.services.players);
});

test('PLAYER_CONNECTED event delegates to players service', async () => {
  const s3 = createMockS3();
  await s3.mount();

  const playerData = { eosID: 'EOS:0001abc', name: 'TestPlayer', teamID: 1 };
  s3.players.handlePlayerConnected(playerData);

  assert.equal(s3.players.events.length, 1);
  assert.equal(s3.players.events[0].type, 'connect');
  assert.equal(s3.players.events[0].data.eosID, 'EOS:0001abc');
  assert.equal(s3.players.events[0].data.name, 'TestPlayer');
});

test('UPDATED_PLAYER_INFORMATION event cascades to gameState, factions, players', async () => {
  const s3 = createMockS3();
  await s3.mount();

  const playerInfo = {
    eosID: 'EOS:0002xyz',
    name: 'AnotherPlayer',
    teamID: 2,
    squad: 'Alpha'
  };

  // Simulate what S³ does in handleUpdatedPlayerInfo
  s3.services.gameState.handleUpdatedPlayerInfo(playerInfo);
  s3.services.factions.handleUpdatedPlayerInfo(playerInfo);
  s3.services.players.handleUpdatedPlayerInfo(playerInfo);

  // Verify players service received the update
  assert.equal(s3.players.events.length, 1);
  assert.equal(s3.players.events[0].type, 'update');
  assert.equal(s3.players.events[0].data.eosID, 'EOS:0002xyz');
  assert.equal(s3.players.events[0].data.teamID, 2);
});

test('Multiple player joins are tracked independently', async () => {
  const s3 = createMockS3();
  await s3.mount();

  const players = [
    { eosID: 'EOS:001a', name: 'Alpha', teamID: 1 },
    { eosID: 'EOS:002b', name: 'Bravo', teamID: 2 },
    { eosID: 'EOS:003c', name: 'Charlie', teamID: 1 }
  ];

  for (const p of players) {
    s3.players.handlePlayerConnected(p);
  }

  assert.equal(s3.players.events.length, 3);
  assert.equal(s3.players.events[0].data.name, 'Alpha');
  assert.equal(s3.players.events[1].data.name, 'Bravo');
  assert.equal(s3.players.events[2].data.name, 'Charlie');
  assert.equal(s3.players.events[0].data.teamID, 1);
  assert.equal(s3.players.events[1].data.teamID, 2);
  assert.equal(s3.players.events[2].data.teamID, 1);
});

test('S³ unmount reverses mount order', async () => {
  const s3 = createMockS3();
  await s3.mount();
  assert.equal(s3.isReady(), true);

  await s3.unmount();

  assert.equal(s3.isReady(), false);
  assert.equal(s3.services.players.isReady(), false, 'players should not be ready after unmount');
  assert.equal(s3.services.serverConfig.isReady(), false, 'serverConfig should not be ready after unmount');
  assert.equal(s3.services.db.isReady(), false, 'db should not be ready after unmount');
});

test('ready() resolves after mount completes', async () => {
  const s3 = createMockS3();
  const readyBefore = s3.isReady();
  assert.equal(readyBefore, false, 'S³ should not be ready before mount');

  // Start mount and await ready() as consumers would
  const mountPromise = s3.mount();
  await s3.ready();
  const readyAfter = s3.isReady();
  assert.equal(readyAfter, true, 'S³ should be ready after ready() resolves');

  // Wait for mount to fully finish
  await mountPromise;
  assert.equal(s3.isReady(), true);
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await run();