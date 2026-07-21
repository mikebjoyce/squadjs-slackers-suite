/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     CATEGORY 2 — PLAYER SESSION PERSISTENCE TEST              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Verifies S3_PlayerSessions lifecycle:
 *   1. Player join → session row created with joinTime
 *   2. Player disconnect → session updated with disconnectTime
 *   3. Player reconnect → getJoinTime() returns original join time
 *   4. Session expiry after 30 min inactivity
 *   5. Periodic activity update refreshes lastActivity timestamp
 *   6. Multiple players maintain independent sessions
 *
 * Category: 2 (autonomous mock-based, in-memory SQLite)
 * Run:    node SlackersSquadServices/testing/test-player-session-persistence.js
 */

'use strict';

import assert from 'node:assert/strict';
import { Sequelize, DataTypes } from 'sequelize';

// ---------------------------------------------------------------------------
// Minimal session model matching S3_PlayerSessions schema
// ---------------------------------------------------------------------------

const SESSION_SCHEMA = {
  eosID: { type: DataTypes.STRING, primaryKey: true },
  steamID: { type: DataTypes.STRING, allowNull: true },
  playerName: { type: DataTypes.STRING, allowNull: true },
  teamID: { type: DataTypes.INTEGER, allowNull: true },
  sessionStart: { type: DataTypes.DATE, allowNull: false },
  lastActivity: { type: DataTypes.DATE, allowNull: false },
  disconnectTime: { type: DataTypes.DATE, allowNull: true },
  reconnectCount: { type: DataTypes.INTEGER, defaultValue: 0 }
};

const SESSION_OPTIONS = { tableName: 'S3_PlayerSessions', timestamps: false };

// ---------------------------------------------------------------------------
// SessionManager — mirrors PlayersService session logic
// ---------------------------------------------------------------------------

class SessionManager {
  constructor(sequelize, expiryMs = 30 * 60 * 1000) {
    this.model = sequelize.define('S3_PlayerSessions', SESSION_SCHEMA, SESSION_OPTIONS);
    this.expiryMs = expiryMs;
    this._cache = new Map(); // eosID -> cached sessionStart
  }

  async init() {
    await this.model.sync();
  }

  // Called on player join
  async onPlayerConnected(eosID, playerName, teamID, steamID) {
    const existing = await this.model.findByPk(eosID);
    if (existing) {
      // Reconnect — preserve original sessionStart
      const reconnectCount = (existing.reconnectCount || 0) + 1;
      await existing.update({
        playerName,
        teamID,
        lastActivity: new Date(),
        disconnectTime: null,
        reconnectCount
      });
      this._cache.set(eosID, existing.sessionStart);
      return { sessionStart: existing.sessionStart, isReconnect: true };
    } else {
      // Fresh join
      const now = new Date();
      const session = await this.model.create({
        eosID,
        steamID: steamID || null,
        playerName,
        teamID,
        sessionStart: now,
        lastActivity: now,
        disconnectTime: null,
        reconnectCount: 0
      });
      this._cache.set(eosID, session.sessionStart);
      return { sessionStart: session.sessionStart, isReconnect: false };
    }
  }

  // Called on player disconnect
  async onPlayerDisconnected(eosID) {
    const existing = await this.model.findByPk(eosID);
    if (existing) {
      await existing.update({ disconnectTime: new Date() });
    }
  }

  // Called by activity update timer
  async updateActivity(eosID) {
    const existing = await this.model.findByPk(eosID);
    if (existing) {
      await existing.update({ lastActivity: new Date() });
    }
  }

  // The getJoinTime() API — returns original join time even after reconnect
  async getJoinTime(eosID) {
    // Check cache first
    if (this._cache.has(eosID)) {
      return this._cache.get(eosID);
    }
    // Fall back to DB
    const session = await this.model.findByPk(eosID);
    if (session) {
      this._cache.set(eosID, session.sessionStart);
      return session.sessionStart;
    }
    return null;
  }

  // Prune expired sessions (lastActivity older than expiry)
  async pruneExpired() {
    const cutoff = new Date(Date.now() - this.expiryMs);
    // Find expired eosIDs before deleting (so we can clear cache)
    const expiredSessions = await this.model.findAll({
      where: { lastActivity: { [Sequelize.Op.lt]: cutoff } },
      attributes: ['eosID']
    });
    const deleted = await this.model.destroy({
      where: { lastActivity: { [Sequelize.Op.lt]: cutoff } }
    });
    // Clear cache entries that were pruned (by eosID, not sessionStart)
    const expiredIDs = new Set(expiredSessions.map(r => r.eosID));
    for (const eosID of this._cache.keys()) {
      if (expiredIDs.has(eosID)) {
        this._cache.delete(eosID);
      }
    }
    return deleted;
  }

  // Count active sessions
  async countActive() {
    return await this.model.count();
  }
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
  console.log('Player Session Persistence Test');
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
// Utils
// ---------------------------------------------------------------------------

async function createSequelize() {
  const seq = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
    define: { freezeTableName: true }
  });
  await seq.authenticate();
  return seq;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('Player join creates session row with joinTime', async () => {
  const seq = await createSequelize();
  const sm = new SessionManager(seq);
  await sm.init();

  const result = await sm.onPlayerConnected('EOS:p001', 'Alpha', 1, 'STEAM_1:0:12345');
  assert.equal(result.isReconnect, false);
  assert.ok(result.sessionStart instanceof Date, 'sessionStart should be a Date');
  assert.ok(result.sessionStart.getTime() > 0, 'sessionStart should be a valid timestamp');

  // Verify row exists in DB
  const row = await sm.model.findByPk('EOS:p001');
  assert.ok(row, 'session row should exist');
  assert.equal(row.eosID, 'EOS:p001');
  assert.equal(row.playerName, 'Alpha');
  assert.equal(row.teamID, 1);
  assert.equal(row.steamID, 'STEAM_1:0:12345');
  assert.equal(row.reconnectCount, 0);
  assert.equal(row.disconnectTime, null);
});

test('Player disconnect updates disconnectTime', async () => {
  const seq = await createSequelize();
  const sm = new SessionManager(seq);
  await sm.init();

  await sm.onPlayerConnected('EOS:p002', 'Bravo', 2);
  const before = await sm.getJoinTime('EOS:p002');
  assert.ok(before instanceof Date);

  await sm.onPlayerDisconnected('EOS:p002');
  const row = await sm.model.findByPk('EOS:p002');
  assert.ok(row.disconnectTime instanceof Date, 'disconnectTime should be set');
  assert.ok(row.disconnectTime.getTime() >= row.sessionStart.getTime(),
    'disconnectTime should be >= sessionStart');
});

test('Player reconnect returns original joinTime', async () => {
  const seq = await createSequelize();
  const sm = new SessionManager(seq);
  await sm.init();

  // Join
  const joinResult = await sm.onPlayerConnected('EOS:p003', 'Charlie', 1);
  const originalJoinTime = joinResult.sessionStart;

  // Disconnect — wait a tiny bit so timestamps differ
  await new Promise(r => setTimeout(r, 10));
  await sm.onPlayerDisconnected('EOS:p003');

  // Reconnect
  const reconnectResult = await sm.onPlayerConnected('EOS:p003', 'Charlie', 2, 'STEAM_1:1:67890');
  assert.equal(reconnectResult.isReconnect, true);

  // getJoinTime() should return the ORIGINAL join time
  const retrievedJoinTime = await sm.getJoinTime('EOS:p003');
  assert.equal(retrievedJoinTime.getTime(), originalJoinTime.getTime(),
    'reconnect should preserve original joinTime');

  // Verify reconnect fields
  const row = await sm.model.findByPk('EOS:p003');
  assert.equal(row.reconnectCount, 1, 'reconnectCount should be incremented');
  assert.equal(row.teamID, 2, 'teamID should be updated');
  assert.equal(row.playerName, 'Charlie');
  assert.equal(row.disconnectTime, null, 'disconnectTime should be cleared on reconnect');
});

test('getJoinTime() returns null for unknown player', async () => {
  const seq = await createSequelize();
  const sm = new SessionManager(seq);
  await sm.init();

  const joinTime = await sm.getJoinTime('EOS:unknown');
  assert.equal(joinTime, null, 'unknown player should return null');
});

test('Session expires after inactivity period', async () => {
  const seq = await createSequelize();
  const shortExpiryMs = 50; // very short expiry for testing
  const sm = new SessionManager(seq, shortExpiryMs);
  await sm.init();

  await sm.onPlayerConnected('EOS:p004', 'Delta', 1);

  // Initially active
  let count = await sm.countActive();
  assert.equal(count, 1, 'session should be active initially');

  // Wait for expiry + prune
  await new Promise(r => setTimeout(r, shortExpiryMs + 50));
  const deleted = await sm.pruneExpired();
  assert.equal(deleted, 1, 'should prune 1 expired session');

  count = await sm.countActive();
  assert.equal(count, 0, 'no active sessions after expiry');

  // getJoinTime() should return null since row was pruned
  const cachedTime = await sm.getJoinTime('EOS:p004');
  assert.equal(cachedTime, null, 'getJoinTime should return null for expired/pruned session');
});

test('Activity update refreshes lastActivity timestamp', async () => {
  const seq = await createSequelize();
  const sm = new SessionManager(seq);
  await sm.init();

  await sm.onPlayerConnected('EOS:p005', 'Echo', 1);

  // Get initial lastActivity
  let row = await sm.model.findByPk('EOS:p005');
  const initialActivity = row.lastActivity.getTime();

  // Wait a moment then update
  await new Promise(r => setTimeout(r, 10));
  await sm.updateActivity('EOS:p005');

  // Verify lastActivity is newer
  row = await sm.model.findByPk('EOS:p005');
  assert.ok(row.lastActivity.getTime() > initialActivity, 'lastActivity should be updated');
});

test('Multiple players have independent sessions', async () => {
  const seq = await createSequelize();
  const sm = new SessionManager(seq);
  await sm.init();

  const players = ['EOS:p100', 'EOS:p101', 'EOS:p102', 'EOS:p103'];
  const joinTimes = [];

  for (const eosID of players) {
    const result = await sm.onPlayerConnected(eosID, `Player${eosID}`, 1);
    joinTimes.push(result.sessionStart.getTime());
  }

  // Each should have independent start times
  const uniqueTimes = new Set(joinTimes);
  assert.equal(uniqueTimes.size, players.length, 'each player should have a unique joinTime');

  // Disconnect one player independently
  await sm.onPlayerDisconnected('EOS:p101');
  let row = await sm.model.findByPk('EOS:p101');
  assert.ok(row.disconnectTime instanceof Date, 'disconnected player should have disconnectTime');

  row = await sm.model.findByPk('EOS:p100');
  assert.equal(row.disconnectTime, null, 'non-disconnected player should not have disconnectTime');
});

test('Session row persists across simulated SquadJS restart', async () => {
  // Simulate restart by creating a new Sequelize instance on the same DB
  // Since we use :memory:, we simulate with a fresh SessionManager on same seq
  const seq = await createSequelize();
  const sm = new SessionManager(seq);
  await sm.init();

  // Create session
  await sm.onPlayerConnected('EOS:p006', 'Foxtrot', 2);

  // "Restart" — create new session manager with same model
  // In real code, the model would be re-defined from the DB schema
  // For this test, we verify the cache is populated correctly
  const originalJoinTime = await sm.getJoinTime('EOS:p006');

  // Clear cache (simulates restart cache loss)
  sm._cache.clear();

  // getJoinTime should re-fetch from DB
  const refetchedJoinTime = await sm.getJoinTime('EOS:p006');
  assert.equal(refetchedJoinTime.getTime(), originalJoinTime.getTime(),
    'joinTime should survive cache loss via DB re-fetch');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await run();