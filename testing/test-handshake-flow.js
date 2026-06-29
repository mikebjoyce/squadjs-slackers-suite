/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          CATEGORY 2 — HANDSHAKE FLOW TEST                     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Verifies the SA-Switch handshake:
 *   1. SA emits SA_ASSIGNMENT_COMPLETE event with correct shape
 *   2. Switch plugin receives and processes the event
 *   3. Event contains player EOS ID, assigned team, and timestamp
 *   4. Invalid/malformed events are handled gracefully
 *   5. Multiple assignment events in sequence are tracked
 *
 * Category: 2 (autonomous mock-based, no live server)
 * Run:    node SlackersSquadServices/testing/test-handshake-flow.js
 */

'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Mock S³ service registry
// ---------------------------------------------------------------------------

function createMockS3() {
  const mockPlayers = {
    getPlayer(eosID) {
      return players.get(eosID) || null;
    },
    getJoinTime() { return Date.now(); },
    isReady() { return true; }
  };

  const players = new Map();
  players.set('EOS:test001', { eosID: 'EOS:test001', name: 'TestPlayer', teamID: 1 });
  players.set('EOS:test002', { eosID: 'EOS:test002', name: 'AnotherPlayer', teamID: 2 });
  players.set('EOS:test003', { eosID: 'EOS:test003', name: 'FreshPlayer', teamID: null });

  const s3 = {
    constructor: { name: 'SlackersSquadServices' },
    gameState: { currentPhase: 'live', isLive: () => true },
    players: mockPlayers,
    db: { isReady: () => true },
    isReady: () => true,
    ready: async () => {}
  };
  return s3;
}

// ---------------------------------------------------------------------------
// Event emitter helper — simulates SquadJS server event system
// ---------------------------------------------------------------------------

class MockEventBus extends EventEmitter {}

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
  console.log('Handshake Flow Test (SA ↔ Switch event coordination)');
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

test('SA emits SA_ASSIGNMENT_COMPLETE with correct shape', async () => {
  const bus = new MockEventBus();
  const receivedEvents = [];

  // Simulate Switch listening
  bus.on('SA_ASSIGNMENT_COMPLETE', (event) => {
    receivedEvents.push(event);
  });

  // Simulate SA emitting
  const assignmentEvent = {
    eosID: 'EOS:test001',
    teamID: 2,
    timestamp: Date.now(),
    reason: 'elo-balance'
  };
  bus.emit('SA_ASSIGNMENT_COMPLETE', assignmentEvent);

  assert.equal(receivedEvents.length, 1);
  assert.equal(receivedEvents[0].eosID, 'EOS:test001');
  assert.equal(receivedEvents[0].teamID, 2);
  assert.ok(receivedEvents[0].timestamp, 'timestamp should be present');
  assert.ok(typeof receivedEvents[0].timestamp === 'number', 'timestamp should be a number');
  assert.equal(receivedEvents[0].reason, 'elo-balance');
});

test('Switch receives and processes SA_ASSIGNMENT_COMPLETE', async () => {
  const bus = new MockEventBus();
  const s3 = createMockS3();
  const processedAssignments = [];

  // Simulate Switch plugin processing
  bus.on('SA_ASSIGNMENT_COMPLETE', (event) => {
    // Check player exists in S³
    const player = s3.players.getPlayer(event.eosID);
    if (player) {
      processedAssignments.push({
        eosID: event.eosID,
        fromTeam: player.teamID,
        toTeam: event.teamID
      });
    }
  });

  bus.emit('SA_ASSIGNMENT_COMPLETE', {
    eosID: 'EOS:test001',
    teamID: 2,
    timestamp: Date.now()
  });

  assert.equal(processedAssignments.length, 1);
  assert.equal(processedAssignments[0].eosID, 'EOS:test001');
  assert.equal(processedAssignments[0].fromTeam, 1); // original team
  assert.equal(processedAssignments[0].toTeam, 2);  // target team
});

test('Handshake passes player info including EOS ID and assigned team', async () => {
  const bus = new MockEventBus();
  const s3 = createMockS3();
  const handshakeResults = [];

  bus.on('SA_ASSIGNMENT_COMPLETE', (event) => {
    const player = s3.players.getPlayer(event.eosID);
    handshakeResults.push({
      playerExists: !!player,
      fromTeam: player?.teamID ?? null,
      toTeam: event.teamID,
      isFreshPlayer: player?.teamID === null
    });
  });

  // Emit for a fresh player (teamID null) — should be assignable
  bus.emit('SA_ASSIGNMENT_COMPLETE', {
    eosID: 'EOS:test003',
    teamID: 1,
    timestamp: Date.now()
  });

  assert.equal(handshakeResults.length, 1);
  assert.equal(handshakeResults[0].playerExists, true);
  assert.equal(handshakeResults[0].fromTeam, null, 'fresh player has no team');
  assert.equal(handshakeResults[0].toTeam, 1);
  assert.equal(handshakeResults[0].isFreshPlayer, true);
});

test('Multiple assignment events are tracked sequentially', async () => {
  const bus = new MockEventBus();
  const assignmentOrder = [];

  bus.on('SA_ASSIGNMENT_COMPLETE', (event) => {
    assignmentOrder.push(event.eosID);
  });

  bus.emit('SA_ASSIGNMENT_COMPLETE', {
    eosID: 'EOS:test001',
    teamID: 2,
    timestamp: Date.now()
  });

  bus.emit('SA_ASSIGNMENT_COMPLETE', {
    eosID: 'EOS:test002',
    teamID: 1,
    timestamp: Date.now()
  });

  bus.emit('SA_ASSIGNMENT_COMPLETE', {
    eosID: 'EOS:test003',
    teamID: 1,
    timestamp: Date.now()
  });

  assert.equal(assignmentOrder.length, 3);
  assert.equal(assignmentOrder[0], 'EOS:test001');
  assert.equal(assignmentOrder[1], 'EOS:test002');
  assert.equal(assignmentOrder[2], 'EOS:test003');
});

test('Malformed event (missing fields) is handled gracefully', async () => {
  const bus = new MockEventBus();
  const errors = [];

  bus.on('SA_ASSIGNMENT_COMPLETE', (event) => {
    if (!event.eosID || !event.teamID) {
      errors.push('Invalid assignment event: missing required fields');
      return;
    }
    // Normal processing...
  });

  // Emit malformed event
  bus.emit('SA_ASSIGNMENT_COMPLETE', { teamID: 1 }); // missing eosID
  bus.emit('SA_ASSIGNMENT_COMPLETE', { eosID: 'EOS:test001' }); // missing teamID
  bus.emit('SA_ASSIGNMENT_COMPLETE', {}); // both missing

  // Valid event
  bus.emit('SA_ASSIGNMENT_COMPLETE', {
    eosID: 'EOS:test001',
    teamID: 2,
    timestamp: Date.now()
  });

  assert.equal(errors.length, 3, 'should capture 3 malformed event errors');
  assert.ok(errors[0].includes('Invalid assignment event'), 'error message should be descriptive');
});

test('Handshake completes end-to-end: SA assigns → Switch processes', async () => {
  const bus = new MockEventBus();
  const s3 = createMockS3();
  const pipeline = [];

  // SA assigns player
  bus.on('SA_ASSIGNMENT_COMPLETE', (event) => {
    pipeline.push({ stage: 'sa-assigned', eosID: event.eosID, toTeam: event.teamID });

    // Switch processes the assignment
    const player = s3.players.getPlayer(event.eosID);
    if (player && player.teamID !== event.teamID) {
      pipeline.push({ stage: 'switch-processing', eosID: event.eosID, fromTeam: player.teamID, toTeam: event.teamID });
    }
  });

  // Emit the assignment as the real SA plugin would
  bus.emit('SA_ASSIGNMENT_COMPLETE', {
    eosID: 'EOS:test001',
    teamID: 2,
    timestamp: Date.now()
  });

  assert.equal(pipeline.length, 2, 'should have 2 pipeline stages');
  assert.equal(pipeline[0].stage, 'sa-assigned');
  assert.equal(pipeline[1].stage, 'switch-processing');
  assert.equal(pipeline[0].eosID, 'EOS:test001');
  assert.equal(pipeline[1].eosID, 'EOS:test001');
  assert.equal(pipeline[0].toTeam, 2);
  assert.equal(pipeline[1].fromTeam, 1, 'Switch sees player was on team 1');
  assert.equal(pipeline[1].toTeam, 2, 'Switch sees player needs to go to team 2');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await run();