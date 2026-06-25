/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          FACTIONS SERVICE TEST                               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates FactionsService: faction and team name resolution from
 * game layer data, live-phase gating, and layer/faction cache clearing
 * on new game events.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-factions-service.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Uses mock Server and mock GameState — no running SquadJS required.
 *
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import FactionsService from '../utils/factions-service.js';

class MockServer extends EventEmitter {
  constructor() {
    super();
    this.players = [];
  }
}

class MockGameState {
  constructor(phase = 'LIVE') {
    this.phase = phase;
  }

  isLive() {
    return this.phase === 'LIVE';
  }

  setPhase(phase) {
    this.phase = phase;
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

await runTest('extractTeamAbbreviationsFromRoles resolves both teams and supports role fallback variants', async () => {
  const server = new MockServer();
  const gameState = new MockGameState('LIVE');
  const service = new FactionsService({ server, gameState });

  server.players = [
    { teamID: 1, roles: ['BAF_Rifleman'], role: 'IGNORED' },
    { teamID: 2, role: 'MEA_Rifleman' }
  ];

  const result = service.extractTeamAbbreviationsFromRoles();
  assert.equal(result[1], 'BAF');
  assert.equal(result[2], 'MEA');
});

await runTest('getTeamName returns abbreviation when known, otherwise Team <id>', async () => {
  const server = new MockServer();
  const gameState = new MockGameState('LIVE');
  const service = new FactionsService({ server, gameState });

  service.cachedAbbreviations = { 1: 'US', 2: 'RGF' };

  assert.equal(service.getTeamName(1), 'US');
  assert.equal(service.getTeamName(2), 'RGF');
  assert.equal(service.getTeamName(3), 'Team 3');
  assert.equal(service.getTeamName(1, { useGenericNames: true }), 'Team 1');
});

await runTest('getFactionId resolves from cache first, then role prefix fallback scan', async () => {
  const server = new MockServer();
  const gameState = new MockGameState('LIVE');
  const service = new FactionsService({ server, gameState });

  service.cachedAbbreviations = { 1: 'US', 2: 'MEA' };
  assert.equal(service.getFactionId('mea'), 2);
  assert.equal(service.getFactionId(1), 1);
  assert.equal(service.getFactionId(3), null);

  service.cachedAbbreviations = {};
  server.players = [
    { teamID: 2, role: 'MEA_Rifleman' },
    { teamID: 1, role: 'US_Rifleman' }
  ];

  assert.equal(service.getFactionId('us'), 1);
  assert.equal(service.getFactionId('RGF'), null);
});

await runTest('LIVE-gated behavior: no poll while STAGING, polls once LIVE and fills cache', async () => {
  const server = new MockServer();
  const gameState = new MockGameState('STAGING');
  const service = new FactionsService({ server, gameState, pollIntervalMs: 25 });

  server.players = [
    { teamID: 1, role: 'US_Rifleman' },
    { teamID: 2, role: 'MEA_Rifleman' }
  ];

  await service.mount();

  assert.equal(service.getCachedAbbreviations()[1], undefined);
  assert.equal(service.getCachedAbbreviations()[2], undefined);

  gameState.setPhase('LIVE');
  service.handleUpdatedPlayerInfo();

  await new Promise((resolve) => setTimeout(resolve, 10));
  const cache = service.getCachedAbbreviations();
  assert.equal(cache[1], 'US');
  assert.equal(cache[2], 'MEA');

  await service.unmount();
});

await runTest('extractor short-circuits after resolving both teams', async () => {
  const server = new MockServer();
  const gameState = new MockGameState('LIVE');
  const service = new FactionsService({ server, gameState });

  let roleReadCount = 0;
  const players = [
    {
      teamID: 1,
      get role() {
        roleReadCount += 1;
        return 'US_Rifleman';
      }
    },
    {
      teamID: 2,
      get role() {
        roleReadCount += 1;
        return 'MEA_Rifleman';
      }
    },
    {
      teamID: 1,
      get role() {
        roleReadCount += 1;
        return 'CAF_Rifleman';
      }
    }
  ];

  const extracted = service.extractTeamAbbreviationsFromRoles(players);
  assert.equal(extracted[1], 'US');
  assert.equal(extracted[2], 'MEA');
  assert.equal(roleReadCount, 2);
});

await runTest('mount/unmount does not bind server listeners directly (parent plugin handles binding)', async () => {
  const server = new MockServer();
  const gameState = new MockGameState('LIVE');
  const service = new FactionsService({ server, gameState, pollIntervalMs: 25 });

  server.players = [
    { teamID: 1, role: 'US_Rifleman' },
    { teamID: 2, role: 'MEA_Rifleman' }
  ];

  await service.mount();

  // FactionsService does not bind listeners directly; parent plugin handles that
  assert.equal(server.listenerCount('NEW_GAME'), 0);
  assert.equal(server.listenerCount('ROUND_ENDED'), 0);
  assert.equal(server.listenerCount('UPDATED_PLAYER_INFORMATION'), 0);

  // Simulate parent plugin calling the handler methods
  service.handleNewGame();
  assert.equal(Object.keys(service.getCachedAbbreviations()).length, 0);

  await service.unmount();

  // Still no listeners bound directly
  assert.equal(server.listenerCount('NEW_GAME'), 0);
  assert.equal(server.listenerCount('ROUND_ENDED'), 0);
  assert.equal(server.listenerCount('UPDATED_PLAYER_INFORMATION'), 0);
});

if (!process.exitCode) {
  console.log('\nAll factions-service tests passed.');
}
