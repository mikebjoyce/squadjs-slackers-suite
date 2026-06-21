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

  assert.equal(server.take('S3_PLAYER_JOINED').length, 2);

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

if (!process.exitCode) {
  console.log('\nAll players-service tests passed.');
}
