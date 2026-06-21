import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import GameStateService from '../utils/game-state-service.js';

class MockServer extends EventEmitter {
  constructor() {
    super();
    this.players = [];
    this.currentLayer = null;
  }
}

class MockSequelize {
  constructor() {
    this.models = {};
    this._rows = new Map();
    this.constructor.DataTypes = {
      INTEGER: 'INTEGER',
      STRING: 'STRING',
      BOOLEAN: 'BOOLEAN',
      BIGINT: 'BIGINT'
    };
  }

  define(name) {
    const rows = this._rows;
    const model = {
      async sync() {},
      async findByPk(id) {
        const row = rows.get(id);
        if (!row) return null;
        return { toJSON: () => ({ ...row }) };
      },
      async upsert(payload) {
        rows.set(payload.id, { ...payload });
      }
    };

    this.models[name] = model;
    return model;
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

await runTest('inferGameMode parity for known modes', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  assert.equal(service.inferGameMode('Narva_RAAS_v2'), 'RAAS');
  assert.equal(service.inferGameMode('Yehorivka_AAS_v1'), 'AAS');
  assert.equal(service.inferGameMode('JensensRange_Seed'), 'Seed');
  assert.equal(service.inferGameMode('SomeUnknownLayer'), 'Unknown');
});

await runTest('resolveLayerInfo handles string and object variants', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  const fromString = await service.resolveLayerInfo('Gorodok_RAAS_v2', 'test');
  assert.equal(fromString, true);
  assert.equal(service.getLayerName(), 'Gorodok_RAAS_v2');
  assert.equal(service.getGamemode(), 'RAAS');

  const fromObject = await service.resolveLayerInfo({ name: 'Fallujah_Invasion_v1', gamemode: 'Invasion' }, 'test');
  assert.equal(fromObject, true);
  assert.equal(service.getLayerName(), 'Fallujah_Invasion_v1');
  assert.equal(service.getGamemode(), 'Invasion');
});

await runTest('isIgnoredMode matches case-insensitive substrings', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server, ignoredGameModes: ['Seed', 'Jensen'] });

  await service.resolveLayerInfo('JensensRange_Skirmish_v2', 'test');
  assert.equal(service.isIgnoredMode(), true);

  await service.resolveLayerInfo('AlBasrah_RAAS_v4', 'test');
  assert.equal(service.isIgnoredMode(), false);
});

await runTest('phase transitions NEW_GAME resolving -> STAGING(resolving=false) when teams resolve', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server, stagingDurationMs: 2500 });

  await service.mount();
  await service.onNewGame({ layer: 'Mutaha_RAAS_v3' });

  assert.equal(service.getPhase(), 'STAGING');
  assert.equal(service.isResolving(), true);

  server.players = [
    { eosID: '1', teamID: 1 },
    { eosID: '2', teamID: 2 }
  ];

  await service.onUpdatedPlayerInfo();
  assert.equal(service.getPhase(), 'STAGING');
  assert.equal(service.isResolving(), false);

  await service.unmount();
});

await runTest('phase transitions STAGING -> LIVE only by staging timer', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server, stagingDurationMs: 20 });

  await service.mount();
  await service.onNewGame({ layer: 'Mutaha_RAAS_v3' });

  assert.equal(service.getPhase(), 'STAGING');
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(service.getPhase(), 'LIVE');

  await service.unmount();
});

await runTest('phase transitions ROUND_ENDED -> ENDGAME', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  await service.mount();
  await service.onRoundEnded();
  assert.equal(service.getPhase(), 'ENDGAME');
  assert.equal(service.isEnding(), true);

  await service.unmount();
});

await runTest('persists and recovers phase/resolving/layer state via sequelize connector', async () => {
  const sequelize = new MockSequelize();

  const server1 = new MockServer();
  const service1 = new GameStateService({
    server: server1,
    sequelize,
    ignoredGameModes: ['Seed', 'Jensen'],
    stagingDurationMs: 600000
  });

  await service1.mount();
  await service1.onNewGame({ layer: 'JensensRange_Skirmish_v2' });

  server1.players = [
    { eosID: '1', teamID: 1 },
    { eosID: '2', teamID: 2 }
  ];
  await service1.onUpdatedPlayerInfo();

  assert.equal(service1.getPhase(), 'STAGING');
  assert.equal(service1.isResolving(), false);
  assert.equal(service1.isIgnoredMode(), true);
  await service1.unmount();

  const server2 = new MockServer();
  const service2 = new GameStateService({
    server: server2,
    sequelize,
    ignoredGameModes: ['Seed', 'Jensen'],
    stagingDurationMs: 600000
  });

  await service2.mount();
  assert.equal(service2.getPhase(), 'STAGING');
  assert.equal(service2.isResolving(), false);
  assert.equal(service2.getLayerName(), 'JensensRange_Skirmish_v2');
  assert.equal(service2.isIgnoredMode(), true);
  await service2.unmount();
});

await runTest('invalidates recovered state when recovered round age is impossible', async () => {
  const sequelize = new MockSequelize();

  const server1 = new MockServer();
  const service1 = new GameStateService({
    server: server1,
    sequelize,
    stagingDurationMs: 600000,
    maxRecoveredRoundAgeMs: 7200000
  });

  await service1.mount();
  await service1.onNewGame({ layer: 'Mutaha_RAAS_v3' });
  await service1.unmount();

  const staleRow = sequelize._rows.get(1);
  staleRow.phase = 'STAGING';
  staleRow.resolving = true;
  staleRow.lastNewGameAt = Date.now() - 7205000;
  sequelize._rows.set(1, staleRow);

  const server2 = new MockServer();
  const service2 = new GameStateService({
    server: server2,
    sequelize,
    stagingDurationMs: 600000,
    maxRecoveredRoundAgeMs: 7200000
  });

  await service2.mount();
  assert.equal(service2.getPhase(), 'LIVE');
  assert.equal(service2.isResolving(), false);
  await service2.unmount();
});

await runTest('invalidates recovered STAGING when it is already overdue', async () => {
  const sequelize = new MockSequelize();

  const server1 = new MockServer();
  const service1 = new GameStateService({
    server: server1,
    sequelize,
    stagingDurationMs: 1000,
    maxRecoveredRoundAgeMs: 99999999
  });

  await service1.mount();
  await service1.onNewGame({ layer: 'Mutaha_RAAS_v3' });
  await service1.unmount();

  const staleRow = sequelize._rows.get(1);
  staleRow.phase = 'STAGING';
  staleRow.resolving = true;
  staleRow.lastNewGameAt = Date.now() - 5000;
  sequelize._rows.set(1, staleRow);

  const server2 = new MockServer();
  const service2 = new GameStateService({
    server: server2,
    sequelize,
    stagingDurationMs: 1000,
    maxRecoveredRoundAgeMs: 99999999
  });

  await service2.mount();
  assert.equal(service2.getPhase(), 'LIVE');
  assert.equal(service2.isResolving(), false);
  await service2.unmount();
});

await runTest('invalidates recovered state on authoritative known-layer divergence', async () => {
  const sequelize = new MockSequelize();

  const server1 = new MockServer();
  const service1 = new GameStateService({
    server: server1,
    sequelize,
    stagingDurationMs: 600000,
    maxRecoveredRoundAgeMs: 99999999
  });

  await service1.mount();
  await service1.onNewGame({ layer: 'OldLayer_RAAS_v1' });
  server1.players = [{ eosID: '1', teamID: 1 }];
  await service1.onUpdatedPlayerInfo();
  await service1.unmount();

  const server2 = new MockServer();
  const service2 = new GameStateService({
    server: server2,
    sequelize,
    stagingDurationMs: 600000,
    maxRecoveredRoundAgeMs: 99999999
  });

  await service2.mount();
  assert.equal(service2.getPhase(), 'STAGING');

  await service2.onServerInfoUpdated({ currentLayer: 'Unknown' });
  assert.equal(service2.getPhase(), 'STAGING');

  await service2.onServerInfoUpdated({ currentLayer: 'DifferentLayer_AAS_v2' });
  assert.equal(service2.getPhase(), 'LIVE');
  assert.equal(service2.getLayerName(), 'DifferentLayer_AAS_v2');

  await service2.unmount();
});

await runTest('startup churn with null team IDs does not clear resolving early', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server, stagingDurationMs: 2500 });

  await service.mount();
  await service.onNewGame({ layer: 'Mutaha_RAAS_v3' });

  server.players = [
    { eosID: '1', teamID: null },
    { eosID: '2', teamID: 1 }
  ];

  await service.onUpdatedPlayerInfo();
  assert.equal(service.isResolving(), true);

  server.players = [
    { eosID: '1', teamID: 1 },
    { eosID: '2', teamID: 2 }
  ];

  await service.onUpdatedPlayerInfo();
  assert.equal(service.isResolving(), false);

  await service.unmount();
});

await runTest('mount/unmount listener symmetry', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  await service.mount();

  assert.equal(server.listenerCount('NEW_GAME'), 1);
  assert.equal(server.listenerCount('ROUND_ENDED'), 1);
  assert.equal(server.listenerCount('UPDATED_LAYER_INFORMATION'), 1);
  assert.equal(server.listenerCount('UPDATED_SERVER_INFORMATION'), 1);
  assert.equal(server.listenerCount('UPDATED_PLAYER_INFORMATION'), 1);

  await service.unmount();

  assert.equal(server.listenerCount('NEW_GAME'), 0);
  assert.equal(server.listenerCount('ROUND_ENDED'), 0);
  assert.equal(server.listenerCount('UPDATED_LAYER_INFORMATION'), 0);
  assert.equal(server.listenerCount('UPDATED_SERVER_INFORMATION'), 0);
  assert.equal(server.listenerCount('UPDATED_PLAYER_INFORMATION'), 0);
});

if (!process.exitCode) {
  console.log('\nAll game-state-service tests passed.');
}
