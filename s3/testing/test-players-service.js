/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          PLAYERS SERVICE TEST                                ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates PlayersService: player tracking, reconnect detection,
 * global and per-player locking, event emission, and player info
 * updates.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-players-service.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Uses mock Server and mock DBService — no running SquadJS required.
 *
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import PlayersService from '../utils/players-service.js';

class MockServer extends EventEmitter {
  constructor() {
    super();
    this.players = [];
    this.emitted = [];
  }

  emit(event, ...args) {
    this.emitted.push({ event, payload: args[0] });
    return super.emit(event, ...args);
  }

  take(eventName) {
    return this.emitted.filter((e) => e.event === eventName);
  }
}

class MockDBService {
  constructor() {
    this._rows = new Map();
    this._migrations = [];
    this._connector = {
      define: () => {}
    };
    this._model = {
      sequelize: {
        constructor: {
          Op: { lt: Symbol('lt') }
        }
      },
      async upsert(payload) {
        this._rows.set(payload.eosID, { ...payload });
      },
      async findByPk(id) {
        const row = this._rows.get(id);
        if (!row) return null;
        return { ...row };
      },
      async destroy() {
        this._rows.clear();
      }
    };

    this._model._rows = this._rows;
  }

  getConnector() {
    return this._connector;
  }

  registerMigration(id, runFn) {
    this._migrations.push({ id, runFn });
  }

  async runMigrations() {
    for (const migration of this._migrations) {
      await migration.runFn({ sequelize: {}, transaction: null });
    }
  }

  getDataTypes() {
    return {
      STRING: 'STRING',
      INTEGER: 'INTEGER',
      BIGINT: 'BIGINT'
    };
  }

  defineModel() {
    return this._model;
  }

  async executeWithRetry(logicFn) {
    return logicFn();
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

await runTest('mount/unmount listener symmetry', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server });

  await service.mount();
  assert.equal(server.listenerCount('UPDATED_PLAYER_INFORMATION'), 0);

  await service.unmount();
  assert.equal(server.listenerCount('UPDATED_PLAYER_INFORMATION'), 0);
});

await runTest('registry diff emits S3 join/leave events', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server });
  await service.mount();

  server.players = [
    { eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 3 },
    { eosID: 'e2', steamID: 's2', name: 'Bravo', teamID: 2, squadID: 7 }
  ];
  await service.handleUpdatedPlayerInfo();

  assert.equal(server.take('S3_PLAYER_JOINED').length, 0);
  assert.equal(service.getAllPlayers().length, 2);

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 3 }];
  await service.handleUpdatedPlayerInfo();

  assert.equal(server.take('S3_PLAYER_LEFT').length, 1);
  assert.equal(service.getAllPlayers().length, 1);

  server.players = [
    { eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 3 },
    { eosID: 'e3', steamID: 's3', name: 'Charlie', teamID: 2, squadID: 4 }
  ];
  await service.handleUpdatedPlayerInfo();

  // Only e3 is a new player; e1 was already registered during initial sync
  // and has joinEmitted=true, so it should not re-emit S3_PLAYER_JOINED
  assert.equal(server.take('S3_PLAYER_JOINED').length, 1);
  assert.equal(server.take('S3_PLAYER_JOINED')[0].payload.player.eosID, 'e3');

  await service.unmount();
});

await runTest('areTeamsResolved returns true only when all tracked players are on real teams', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server });
  await service.mount();

  assert.equal(service.areTeamsResolved(), false);

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: null, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.areTeamsResolved(), false);

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.areTeamsResolved(), true);

  await service.unmount();
});

// ─────────────────────────────────────────────────────────────────
// Stuck-client quarantine.
//
// One player whose client wedged at `Team ID: N/A` used to pin the
// roster-wide gate false for as long as they stayed connected, which
// froze _squadsCache and _lastStablePlayers and suppressed
// S3_PLAYER_TEAM_CHANGED for EVERYONE. These cases pin the escape.
// ─────────────────────────────────────────────────────────────────

// The roster the stuck-client cases run against: nine resolved players plus
// one wedged. The wedged player has to stay a clear minority, or the systemic
// guard (correctly) declines to quarantine anybody.
function rosterWithOneStuck(stuckTeamID = null) {
  const players = [];
  for (let i = 1; i <= 9; i++) {
    players.push({ eosID: `e${i}`, steamID: `s${i}`, name: `P${i}`, teamID: i % 2 === 0 ? 2 : 1, squadID: 1 });
  }
  players.push({ eosID: 'stuck', steamID: 'sStuck', name: 'Wedged', teamID: stuckTeamID, squadID: null });
  return players;
}

// Age a player's unreal-teamID clock by rewriting it rather than sleeping.
// These cases are all about the grace boundary, and a real sleep sized to a
// short window makes them hostage to machine load — this suite is run
// alongside four others and the sleeping version flaked under that.
const GRACE_MS = 60000;
function ageClock(service, key, ms = GRACE_MS * 2) {
  const entry = service._unresolvedSince.get(key);
  assert.ok(entry, `expected an unresolved-teamID clock for ${key}`);
  entry.since -= ms;
}

await runTest('one stuck player stops blocking the gate once the grace window passes', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server, unresolvedGraceMs: GRACE_MS });
  await service.mount();

  server.players = rosterWithOneStuck();
  await service.handleUpdatedPlayerInfo();

  // Inside the window they still block — a player mid-resolve must not be
  // written off on the first tick that sees them.
  assert.equal(service.areTeamsResolved(), false);
  assert.equal(service.getStuckPlayerKeys().size, 0);

  ageClock(service, 'stuck');
  await service.handleUpdatedPlayerInfo();

  assert.equal(service.getStuckPlayerKeys().has('stuck'), true);
  assert.equal(service.isPlayerStuck('stuck'), true);
  assert.equal(service.areTeamsResolved(), true);

  await service.unmount();
});

await runTest('quarantine unfreezes the squad cache and team-change events for everyone else', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server, unresolvedGraceMs: GRACE_MS });
  await service.mount();

  server.squads = [{ squadID: 1, teamID: 1, squadName: 'Alpha', locked: 'False' }];
  server.players = rosterWithOneStuck();
  await service.handleUpdatedPlayerInfo();

  // Blocked: this is exactly the state the bug left the server in all round.
  assert.equal(service._squadsCache, null);

  ageClock(service, 'stuck');
  await service.handleUpdatedPlayerInfo();
  assert.equal(service._squadsCache?.length, 1);

  // And a genuine swap by an unrelated player now emits instead of being
  // swallowed by the null-teams guard.
  server.take('S3_PLAYER_TEAM_CHANGED');
  const moved = rosterWithOneStuck();
  moved[0].teamID = 2;
  server.players = moved;
  await service.handleUpdatedPlayerInfo();

  const events = server.take('S3_PLAYER_TEAM_CHANGED');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.player.eosID, 'e1');

  await service.unmount();
});

await runTest('a mass null-teamID window is never quarantined', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server, unresolvedGraceMs: GRACE_MS });
  await service.mount();

  server.players = rosterWithOneStuck();
  await service.handleUpdatedPlayerInfo();
  ageClock(service, 'stuck');
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.isPlayerStuck('stuck'), true);

  // Round transition: the whole roster goes null at once. Even with every clock
  // aged well past the grace window, this shape is a transition (or a systemic
  // RCON failure) and must not be read as "teams resolved".
  server.players = rosterWithOneStuck().map((p) => ({ ...p, teamID: null }));
  await service.handleUpdatedPlayerInfo();
  for (const key of service._unresolvedSince.keys()) ageClock(service, key);
  await service.handleUpdatedPlayerInfo();

  assert.equal(service.getStuckPlayerKeys().size, 0);
  assert.equal(service.areTeamsResolved(), false);

  await service.unmount();
});

await runTest('the stuck clock clears when the player unbugs or leaves', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server, unresolvedGraceMs: GRACE_MS });
  await service.mount();

  server.players = rosterWithOneStuck();
  await service.handleUpdatedPlayerInfo();
  ageClock(service, 'stuck');
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.isPlayerStuck('stuck'), true);

  // Unbugged in place — no reconnect needed for S³ to take them back.
  server.players = rosterWithOneStuck(2);
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.isPlayerStuck('stuck'), false);
  assert.equal(service._unresolvedSince.has('stuck'), false);

  // Wedge again, then disconnect: the clock must not survive them, or a
  // reconnecting player would be quarantined on their very first tick.
  server.players = rosterWithOneStuck();
  await service.handleUpdatedPlayerInfo();
  assert.equal(service._unresolvedSince.has('stuck'), true);

  server.players = rosterWithOneStuck().filter((p) => p.eosID !== 'stuck');
  await service.handleUpdatedPlayerInfo();
  assert.equal(service._unresolvedSince.has('stuck'), false);
  assert.equal(service.isPlayerStuck('stuck'), false);

  await service.unmount();
});

await runTest('a remount gives a stuck player their grace window back', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server, unresolvedGraceMs: GRACE_MS });
  await service.mount();

  server.players = rosterWithOneStuck();
  await service.handleUpdatedPlayerInfo();
  ageClock(service, 'stuck');
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.isPlayerStuck('stuck'), true);

  await service.unmount();
  assert.equal(service._unresolvedSince.size, 0);
  assert.equal(service._stuckKeys.size, 0);

  // Remount re-runs initial sync; a leftover clock would quarantine them on
  // the first tick back with no grace at all.
  await service.mount();
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.isPlayerStuck('stuck'), false);

  await service.unmount();
});

await runTest('an unkeyable roster never reports resolved teams', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server, unresolvedGraceMs: 10 });
  await service.mount();

  // Neither identifier — invisible to the registry. Counting these towards the
  // gate would report a fully-resolved lobby S³ is tracking nobody in.
  server.players = [{ eosID: null, steamID: null, name: 'Ghost', teamID: null }];
  await service.handleUpdatedPlayerInfo();
  await service.handleUpdatedPlayerInfo();

  assert.equal(service._squadsCache, null);
  assert.equal(service.areTeamsResolved(), false);

  await service.unmount();
});

await runTest('an empty roster is handled without quarantining anything', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server, unresolvedGraceMs: 10 });
  await service.mount();

  server.players = [];
  await service.handleUpdatedPlayerInfo();

  assert.equal(service.getStuckPlayerKeys().size, 0);
  assert.equal(service.areTeamsResolved(), false);

  await service.unmount();
});

await runTest('areTeamsResolved stays false when nobody has a real team', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server, unresolvedGraceMs: 10 });
  await service.mount();

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: null, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();
  ageClock(service, 'e1');
  await service.handleUpdatedPlayerInfo();

  // Quarantining the entire roster would report resolved teams for a lobby
  // S³ knows nothing about.
  assert.equal(service.areTeamsResolved(), false);

  await service.unmount();
});

await runTest('team changes emit only for real team transitions (null guard)', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server });
  await service.mount();

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: null, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();

  assert.equal(server.take('S3_PLAYER_TEAM_CHANGED').length, 0);

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 2, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();

  assert.equal(server.take('S3_PLAYER_TEAM_CHANGED').length, 1);
  await service.unmount();
});

await runTest('projection returns flipped teams during null-teamID window', async () => {
  const server = new MockServer();
  const service = new PlayersService({
    server,
    verboseLogger: (level, message) => {
      server.emitted.push({ event: 'LOG', payload: { level, message } });
    }
  });
  await service.mount();

  server.players = [
    { eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1 },
    { eosID: 'e2', steamID: 's2', name: 'Bravo', teamID: 2, squadID: 2 }
  ];
  await service.handleUpdatedPlayerInfo();

  server.players = [
    { eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: null, squadID: 1 },
    { eosID: 'e2', steamID: 's2', name: 'Bravo', teamID: null, squadID: 2 }
  ];
  await service.handleUpdatedPlayerInfo();

  const snapshot = service.getAllPlayers();
  const alpha = snapshot.find((player) => player.eosID === 'e1');
  const bravo = snapshot.find((player) => player.eosID === 'e2');

  assert.equal(alpha.teamID, 2);
  assert.equal(bravo.teamID, 1);

  const logs = server.take('LOG');
  assert.ok(logs.some((entry) => entry.payload.message.includes('Projection active')));

  await service.unmount();
});

await runTest('projection keeps new joins and logs mismatches on reconcile', async () => {
  const server = new MockServer();
  const service = new PlayersService({
    server,
    verboseLogger: (level, message) => {
      server.emitted.push({ event: 'LOG', payload: { level, message } });
    }
  });
  await service.mount();

  server.players = [
    { eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1 }
  ];
  await service.handleUpdatedPlayerInfo();

  server.players = [
    { eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: null, squadID: 1 },
    { eosID: 'e3', steamID: 's3', name: 'Charlie', teamID: 1, squadID: 3 }
  ];
  await service.handleUpdatedPlayerInfo();

  let snapshot = service.getAllPlayers();
  const charlie = snapshot.find((player) => player.eosID === 'e3');
  assert.equal(charlie.teamID, 1);

  server.players = [
    { eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1 },
    { eosID: 'e3', steamID: 's3', name: 'Charlie', teamID: 1, squadID: 3 }
  ];
  await service.handleUpdatedPlayerInfo();

  snapshot = service.getAllPlayers();
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot.find((player) => player.eosID === 'e1').teamID, 1);

  const logs = server.take('LOG');
  assert.ok(logs.some((entry) => entry.payload.message.includes('Projection active')));
  assert.ok(logs.some((entry) => entry.payload.message.includes('projected team')));

  await service.unmount();
});

await runTest('recordMove attribution is consumed on matching team change', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server, attributionTtlMs: 90000 });
  await service.mount();

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();

  service.recordMove('e1', 2, 'SmartAssign');
  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 2, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();

  const changes = server.take('S3_PLAYER_TEAM_CHANGED');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].payload.source, 'SmartAssign');

  await service.unmount();
});

await runTest('recordMove attribution expires and falls back to Manual/Game', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server, attributionTtlMs: 10 });
  await service.mount();

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();

  service.recordMove('e1', 2, 'SmartAssign');
  await new Promise((resolve) => setTimeout(resolve, 20));

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 2, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();

  const changes = server.take('S3_PLAYER_TEAM_CHANGED');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].payload.source, 'Manual/Game');

  await service.unmount();
});

await runTest('lock/canAct priority and global preemption behavior', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server });
  await service.mount();

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();

  assert.equal(service.lock('e1', 'Switch', 1000), true);
  assert.equal(service.canAct('e1', 'Switch'), true);
  assert.equal(service.canAct('e1', 'SmartAssign'), true);
  assert.equal(service.lock('e1', 'SmartAssign', 1000), true); // preempt lower
  assert.equal(service.canAct('e1', 'Switch'), false);

  assert.equal(service.lockGlobal('SmartAssign', 1000), true);
  assert.equal(service.canAct('e1', 'Switch'), false);
  assert.equal(service.lockGlobal('TeamBalancer', 1000), true); // preempt lower
  assert.equal(service.isGloballyLockedBy(), 'TeamBalancer');
  assert.equal(service.unlockGlobal('SmartAssign'), false);
  assert.equal(service.unlockGlobal('TeamBalancer'), true);

  await service.unmount();
});

await runTest('lock TTL expiration releases lock', async () => {
  const server = new MockServer();
  const service = new PlayersService({ server });
  await service.mount();

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1 }];
  await service.handleUpdatedPlayerInfo();

  assert.equal(service.lock('e1', 'Switch', 20), true);
  assert.equal(service.isLockedBy('e1'), 'Switch');
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(service.isLockedBy('e1'), null);

  await service.unmount();
});

await runTest('reconnect persistence helpers use db-backed model when provided', async () => {
  const server = new MockServer();
  const db = new MockDBService();
  const service = new PlayersService({ server, dbService: db });
  await service.mount();

  await service.rememberReconnect('e1', {
    steamID: 's1',
    playerName: 'Alpha',
    lastTeamID: 2,
    lastSeenAt: 12345
  });

  const reconnect = await service.getReconnect('e1');
  assert.equal(reconnect.eosID, 'e1');
  assert.equal(reconnect.steamID, 's1');
  assert.equal(reconnect.lastTeamID, 2);

  await service.clearReconnects();
  assert.equal(await service.getReconnect('e1'), null);

  await service.unmount();
});

await runTest('isLeader tracks the live tick, not the tick the player was first seen', async () => {
  // Regression: the update path in _registerPlayer() refreshed name/team/squad
  // but not isLeader, so the flag was frozen at whatever the player had when
  // they were first registered. Anyone who connected (never a leader) and then
  // created a squad stayed isLeader=false forever, which made getSquads() rank
  // them as a grunt and left `!s3 players` with no crown on any SL.
  const server = new MockServer();
  const service = new PlayersService({ server });
  await service.mount();

  server.players = [
    { eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: null, isLeader: false },
    { eosID: 'e2', steamID: 's2', name: 'Bravo', teamID: 1, squadID: null, isLeader: false }
  ];
  server.squads = [];
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.getPlayer('e1').isLeader, false);

  // Alpha creates squad 1; Bravo joins it.
  server.players = [
    { eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1, isLeader: true },
    { eosID: 'e2', steamID: 's2', name: 'Bravo', teamID: 1, squadID: 1, isLeader: false }
  ];
  server.squads = [{ squadID: 1, teamID: 1, squadName: 'INFANTRY', locked: 'False' }];
  await service.handleUpdatedPlayerInfo();

  assert.equal(service.getPlayer('e1').isLeader, true, 'promotion must be picked up');
  // getSquads() sorts leaders first — that ordering is what the embed relies on.
  assert.deepEqual(service.getSquads()[0].players, ['e1', 'e2']);

  // Handover: Bravo takes the squad. A demotion must be picked up too.
  server.players = [
    { eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1, isLeader: false },
    { eosID: 'e2', steamID: 's2', name: 'Bravo', teamID: 1, squadID: 1, isLeader: true }
  ];
  await service.handleUpdatedPlayerInfo();

  assert.equal(service.getPlayer('e1').isLeader, false, 'demotion must be picked up');
  assert.equal(service.getPlayer('e2').isLeader, true);
  assert.deepEqual(service.getSquads()[0].players, ['e2', 'e1']);

  // A source that omits isLeader entirely (the PLAYER_CONNECTED payload shape)
  // is missing data, not a demotion — it must not strip the flag.
  await service.handlePlayerConnected({
    player: { eosID: 'e2', steamID: 's2', name: 'Bravo', teamID: 1, squadID: 1 }
  });
  assert.equal(service.getPlayer('e2').isLeader, true, 'absent isLeader must not demote');

  await service.unmount();
});

await runTest('isLeader accepts the RCON string form', async () => {
  // Squad.locked arrives from the RCON parse as "True"/"False"; normalise the
  // same way for isLeader so a parser change cannot silently drop every crown.
  const server = new MockServer();
  const service = new PlayersService({ server });
  await service.mount();

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1, isLeader: 'True' }];
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.getPlayer('e1').isLeader, true);

  server.players = [{ eosID: 'e1', steamID: 's1', name: 'Alpha', teamID: 1, squadID: 1, isLeader: 'False' }];
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.getPlayer('e1').isLeader, false);

  await service.unmount();
});

if (!process.exitCode) {
  console.log('\nAll players-service tests passed.');
}
