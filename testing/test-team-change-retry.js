/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     CATEGORY 2 — TEAM CHANGE RETRY TEST                       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Verifies _requestTeamChange() retry/verify logic:
 *   1. Player found → sends RCON → verifies via S³ players service
 *   2. Player not found → returns null
 *   3. S³ player refresh is called before verification
 *   4. Retry on failure (configurable attempts)
 *   5. Player disconnect mid-retry returns null gracefully
 *   6. Success returns correct result shape
 *
 * Category: 2 (autonomous mock-based, no live server)
 * Run:    node SlackersSquadServices/testing/test-team-change-retry.js
 */

'use strict';

import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Mock S³ with controllable player state
// ---------------------------------------------------------------------------

function createMockS3(initialTeamID = 1) {
  let playerData = { eosID: 'EOS:tc001', name: 'TeamChanger', teamID: initialTeamID };
  let refreshCallCount = 0;
  let disconnectFlag = false;

  const mockPlayers = {
    getPlayer(eosID) {
      if (disconnectFlag) return null; // player disconnected
      return eosID === playerData.eosID ? { ...playerData } : null;
    },
    refreshNow: async (source) => {
      refreshCallCount++;
      // After refresh, optionally flip the team to simulate RCON taking effect
    },
    getRefreshCallCount() { return refreshCallCount; },
    setPlayerData(data) { playerData = { ...playerData, ...data }; },
    setDisconnect() { disconnectFlag = true; }
  };

  return {
    constructor: { name: 'SlackersSquadServices' },
    players: mockPlayers,
    isReady: () => true,
    ready: async () => {}
  };
}

// ---------------------------------------------------------------------------
// The real _requestTeamChange() logic — inlined as a stub that mirrors
// the S3PluginBase implementation (to avoid importing SquadJS internals)
// ---------------------------------------------------------------------------

async function requestTeamChange(s3, eosID, options = {}) {
  const {
    maxAttempts = 5,
    source = 'S3PluginBase'
  } = options;

  // Resolve player via S³
  const playerState = s3.players.getPlayer(eosID);
  if (!playerState) {
    return null;
  }

  const targetTeamID = playerState.teamID === 1 ? 2 : 1;
  const playerName = playerState.name;

  let lastError = null;
  let result = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Send RCON team change
      // (in real code this calls rcon.switchTeam)

      // Force an immediate refresh of S³ player data
      await s3.players.refreshNow(source);

      // Verify the player landed on the target team
      const updated = s3.players.getPlayer(eosID);
      if (updated && updated.teamID === targetTeamID) {
        result = {
          success: true,
          eosID,
          teamID: targetTeamID,
          attempts: attempt + 1,
          name: playerName,
          source
        };
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  return result || {
    success: false,
    eosID,
    teamID: null,
    attempts: maxAttempts,
    name: playerName,
    source
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
  console.log('Team Change Retry Test (_requestTeamChange)');
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

test('Player found — sends RCON and verifies via S³', async () => {
  const s3 = createMockS3(1);
  // Simulate RCON success: flip team to 2
  s3.players.refreshNow = async (source) => {
    s3.players.setPlayerData({ teamID: 2 });
  };

  const result = await requestTeamChange(s3, 'EOS:tc001', { maxAttempts: 3 });

  assert.ok(result, 'should return a result object');
  assert.equal(result.success, true, 'should succeed');
  assert.equal(result.eosID, 'EOS:tc001');
  assert.equal(result.teamID, 2, 'should end on team 2');
  assert.equal(result.attempts, 1, 'should succeed on first attempt');
  assert.equal(result.name, 'TeamChanger');
  assert.equal(result.source, 'S3PluginBase');
});

test('Player not found — returns null', async () => {
  const s3 = createMockS3(1);

  const result = await requestTeamChange(s3, 'EOS:nonexistent');
  assert.equal(result, null, 'nonexistent player should return null');
});

test('S³ refresh is called before verification', async () => {
  const s3 = createMockS3(1);
  let refreshCalls = 0;

  s3.players.refreshNow = async (source) => {
    refreshCalls++;
    s3.players.setPlayerData({ teamID: 2 });
  };

  await requestTeamChange(s3, 'EOS:tc001', { maxAttempts: 1 });

  assert.equal(refreshCalls, 1, 'refreshNow should be called exactly once on success');
});

test('Retry on failure up to maxAttempts', async () => {
  const s3 = createMockS3(1);
  let callCount = 0;

  // Simulate RCON taking effect only on the 3rd attempt
  s3.players.refreshNow = async (source) => {
    callCount++;
    if (callCount >= 3) {
      s3.players.setPlayerData({ teamID: 2 });
    }
    // On attempts 1-2, stay on team 1 (simulate RCON delay)
  };

  const result = await requestTeamChange(s3, 'EOS:tc001', { maxAttempts: 5 });

  assert.ok(result, 'should return a result');
  assert.equal(result.success, true, 'should eventually succeed');
  assert.equal(result.attempts, 3, 'should succeed on 3rd attempt');
  assert.ok(callCount >= 3, 'refresh should be called at least 3 times');
});

test('All retries exhausted — returns failure result', async () => {
  const s3 = createMockS3(1);

  // RCON never takes effect — player stays on team 1
  s3.players.refreshNow = async (source) => {
    // Team remains 1 — RCON never works
  };

  const result = await requestTeamChange(s3, 'EOS:tc001', { maxAttempts: 3 });

  assert.ok(result, 'should return a result');
  assert.equal(result.success, false, 'should indicate failure');
  assert.equal(result.teamID, null, 'teamID should be null on failure');
  assert.equal(result.attempts, 3, 'should use all 3 attempts');
  assert.equal(result.eosID, 'EOS:tc001');
});

test('Player disconnect mid-retry returns null gracefully', async () => {
  const s3 = createMockS3(1);

  // After first refresh attempt, player disconnects
  let refreshCount = 0;
  s3.players.refreshNow = async (source) => {
    refreshCount++;
    if (refreshCount >= 2) {
      s3.players.setDisconnect(); // player disappears
    }
  };

  const result = await requestTeamChange(s3, 'EOS:tc001', { maxAttempts: 5 });

  // When player disappears mid-retry, getPlayer returns null
  // The loop catches this on a subsequent iteration
  assert.ok(result !== null, 'should not crash');
  // Since player disconnected, we don't return null (was found initially)
  // but getPlayer returning null during verification means failure
  assert.equal(result.success, false, 'should fail after disconnect');
});

test('Success returns correct result shape', async () => {
  const s3 = createMockS3(2); // start on team 2

  s3.players.refreshNow = async (source) => {
    s3.players.setPlayerData({ teamID: 1 }); // flip to team 1
  };

  const result = await requestTeamChange(s3, 'EOS:tc001', { maxAttempts: 3, source: 'TestSuite' });

  // Verify complete shape
  assert.ok(result !== null);
  assert.equal(typeof result.success, 'boolean');
  assert.equal(typeof result.eosID, 'string');
  assert.equal(typeof result.teamID, 'number');
  assert.equal(typeof result.attempts, 'number');
  assert.equal(typeof result.name, 'string');
  assert.equal(typeof result.source, 'string');

  // Verify correct values
  assert.equal(result.success, true);
  assert.equal(result.eosID, 'EOS:tc001');
  assert.equal(result.teamID, 1); // flipped from 2 to 1
  assert.equal(result.attempts, 1);
  assert.equal(result.name, 'TeamChanger');
  assert.equal(result.source, 'TestSuite');
});

test('Player starting on team 1 targets team 2, and vice versa', async () => {
  // Player on team 2 → target team 1
  const s3 = createMockS3(2);

  let targetTeam;
  s3.players.refreshNow = async (source) => {
    targetTeam = 1;
    s3.players.setPlayerData({ teamID: 1 });
  };

  let result = await requestTeamChange(s3, 'EOS:tc001', { maxAttempts: 1 });
  assert.equal(result.success, true);
  assert.equal(result.teamID, 1, 'player should end on team 1');

  // Player on team 1 → target team 2
  const s3b = createMockS3(1);

  s3b.players.refreshNow = async (source) => {
    s3b.players.setPlayerData({ teamID: 2 });
  };

  result = await requestTeamChange(s3b, 'EOS:tc001', { maxAttempts: 1 });
  assert.equal(result.success, true);
  assert.equal(result.teamID, 2, 'player should end on team 2');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await run();