/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          GAME STATE SERVICE TEST                             ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates GameStateService lifecycle: phase transitions, matchId and
 * roundStartTime centralization, stale recovery detection, ENDGAME timer
 * chain cancellation, and mount-time fallback behavior.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-game-state-service.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Uses mock Sequelize and mock Server — no running SquadJS required.
 *
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import GameStateService from '../utils/game-state-service.js';
import PlayersService from '../utils/players-service.js';

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

  // PlayersService bootstraps its sessions/reconnects tables with raw DDL
  // before defining models. Nothing here has a SQL engine behind it, so the
  // statement is accepted and discarded — this mock proves nothing about the
  // SQL itself (see guide §11.4), it only lets mount() complete.
  async query() {
    return [[], {}];
  }

  define(name) {
    const self = this;
    const model = {
      async sync() {},
      async findByPk(id) {
        const row = self._rows.get(id);
        if (!row) return null;
        return { toJSON: () => ({ ...row }) };
      },
      async upsert(payload) {
        self._rows.set(payload.id, { ...payload });
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

await runTest('resolveLayerInfo rejects "Unknown" instead of clobbering a good layer', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  assert.equal(service.isLayerResolved(), false);
  assert.equal(service.getLayerName(), 'Unknown');

  await service.resolveLayerInfo('Gorodok_RAAS_v2', 'test');
  assert.equal(service.isLayerResolved(), true);

  // SquadJS reports "Unknown" during a server restart, in both shapes.
  assert.equal(await service.resolveLayerInfo('Unknown', 'test'), false);
  assert.equal(await service.resolveLayerInfo({ name: 'Unknown', gamemode: 'Unknown' }, 'test'), false);
  assert.equal(service.getLayerName(), 'Gorodok_RAAS_v2');
  assert.equal(service.getGamemode(), 'RAAS');
  assert.equal(service.isLayerResolved(), true);
});

await runTest('mount forces a server-information refresh when currentLayer is empty', async () => {
  const server = new MockServer();
  let refreshCalls = 0;
  // SquadJS only refills currentLayer inside updateServerInformation().
  server.updateServerInformation = async () => {
    refreshCalls += 1;
    server.currentLayer = { name: 'Yehorivka_RAAS_v1', gamemode: 'RAAS' };
  };

  const service = new GameStateService({ server });
  await service.mount();

  assert.equal(refreshCalls, 1);
  assert.equal(service.getLayerName(), 'Yehorivka_RAAS_v1');
  assert.equal(service.isLayerResolved(), true);

  await service.unmount();
});

await runTest('mount does not force a refresh when currentLayer is already usable', async () => {
  const server = new MockServer();
  server.currentLayer = 'Mutaha_RAAS_v3';
  let refreshCalls = 0;
  server.updateServerInformation = async () => { refreshCalls += 1; };

  const service = new GameStateService({ server });
  await service.mount();

  assert.equal(refreshCalls, 0);
  assert.equal(service.getLayerName(), 'Mutaha_RAAS_v3');

  await service.unmount();
});

await runTest('mount falls back to layerHistory, then reports Unknown if nothing resolves', async () => {
  const server = new MockServer();
  server.currentLayer = 'Unknown'; // restart-time placeholder
  server.updateServerInformation = async () => {}; // poll returns nothing usable
  server.layerHistory = [{ layer: { name: 'Narva_Invasion_v1', gamemode: 'Invasion' } }];

  const service = new GameStateService({ server });
  await service.mount();
  assert.equal(service.getLayerName(), 'Narva_Invasion_v1');
  await service.unmount();

  const bare = new MockServer();
  bare.updateServerInformation = async () => {};
  const service2 = new GameStateService({ server: bare });
  await service2.mount();
  assert.equal(service2.isLayerResolved(), false);
  assert.equal(service2.getLayerName(), 'Unknown');
  await service2.unmount();
});

await runTest('refreshLayer survives a hung updateServerInformation', async () => {
  const server = new MockServer();
  // Never settles — the RCON call is gone. mount() must not hang on it.
  server.updateServerInformation = () => new Promise(() => {});

  const service = new GameStateService({ server, layerRefreshTimeoutMs: 50 });
  const startedAt = Date.now();
  await service.mount();

  assert.equal(service.isLayerResolved(), false);
  assert.ok(Date.now() - startedAt < 2000, 'mount blocked on the hung refresh');

  await service.unmount();
});

await runTest('staging shortcut ignores the previous round\'s seed/training layer', async () => {
  const server = new MockServer();
  // stagingDuration deliberately shorter than the 5s seed/training shortcut, so
  // "went LIVE quickly" proves the DEFAULT was used, not the shortcut.
  const service = new GameStateService({ server, stagingDurationMs: 300 });

  // Previous round was Jensen's Range — exactly the prod case where NEW_GAME
  // then arrived with data.layer=null and server.currentLayer=null.
  await service.resolveLayerInfo('JensensRange_USA-PLA', 'test');
  assert.equal(service.isTrainingMode(), true);

  await service.handleNewGame({});
  assert.equal(service.getPhase(), 'STAGING');
  assert.equal(service._roundLayerTrusted, false);

  await new Promise((resolve) => setTimeout(resolve, 450));
  // Default duration elapsed. Under the old behaviour the stale Jensen layer
  // would have bought a 5s timer and we would still be in STAGING.
  assert.equal(service.getPhase(), 'LIVE');
});

await runTest('staging timer re-arms when the real layer resolves mid-STAGING', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server, stagingDurationMs: 60000 });

  await service.handleNewGame({});
  assert.equal(service.getPhase(), 'STAGING');

  // Pretend NEW_GAME was 10s ago, then the layer finally resolves as Seed:
  // 5s shortcut minus 10s elapsed = fire now.
  service.lastNewGameAt = Date.now() - 10000;
  await service.handleServerInfoUpdated({ currentLayer: 'Sumari_Seed_v1' });
  assert.equal(service._roundLayerTrusted, true);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(service.getPhase(), 'LIVE');
});

await runTest('staging timer re-arm does not shorten a normal round', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server, stagingDurationMs: 60000 });

  await service.handleNewGame({});
  service.lastNewGameAt = Date.now() - 10000;
  await service.handleServerInfoUpdated({ currentLayer: 'Gorodok_RAAS_v2' });
  assert.equal(service._roundLayerTrusted, true);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(service.getPhase(), 'STAGING');

  service._clearStagingLiveTimer();
});

await runTest('going LIVE does not clear resolving — only a real tick does', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server, stagingDurationMs: 50 });

  await service.mount();
  await service.handleNewGame({ layer: 'Mutaha_RAAS_v3' });
  assert.equal(service.isResolving(), true);

  await new Promise((resolve) => setTimeout(resolve, 90));
  // The staging timer used to force resolving=false here whether or not teams
  // had settled — on seed rounds that happened 5s in, before any player tick.
  assert.equal(service.getPhase(), 'LIVE');
  assert.equal(service.isResolving(), true);

  // A tick after the phase already advanced still resolves it. Under the old
  // `phase === 'STAGING' && resolving` gate this was unreachable.
  server.players = [
    { eosID: '1', teamID: 1 },
    { eosID: '2', teamID: 2 }
  ];
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.isResolving(), false);

  await service.unmount();
});

await runTest('resolving deadline clears the flag when teams never resolve', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server, stagingDurationMs: 20, resolvingTimeoutMs: 120 });

  await service.mount();
  await service.handleNewGame({ layer: 'Mutaha_RAAS_v3' });
  assert.equal(service.isResolving(), true);

  // No players ever report a team — the deadline is the only way out.
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(service.isResolving(), false);

  await service.unmount();
});

await runTest('resolving deadline is floored against the player refresh cadence', async () => {
  const server = new MockServer();

  // No players service: the configured value stands.
  const bare = new GameStateService({ server, resolvingTimeoutMs: 120000 });
  assert.equal(bare._resolvingBudgetMs(), 120000);

  // Prod cadence (20s): 4 ticks = 80s, under the default — no change.
  const parent = { players: { getEffectiveRefreshIntervalMs: () => 20000 } };
  const typical = new GameStateService({ parent, server, resolvingTimeoutMs: 120000 });
  assert.equal(typical._resolvingBudgetMs(), 120000);

  // Ceiling cadence (60s): 120s would only ever be two ticks — floor it to four.
  const slow = new GameStateService({
    parent: { players: { getEffectiveRefreshIntervalMs: () => 60000 } },
    server,
    resolvingTimeoutMs: 120000
  });
  assert.equal(slow._resolvingBudgetMs(), 240000);

  // A deliberately tiny configured value cannot undercut the cadence either.
  const tiny = new GameStateService({ parent, server, resolvingTimeoutMs: 1000 });
  assert.equal(tiny._resolvingBudgetMs(), 80000);
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
  const parent = { services: {} };
  parent.players = parent.services.players = new PlayersService({ parent, server });
  const service = new GameStateService({ parent, server, stagingDurationMs: 2500 });
  parent.services.gameState = service;

  await parent.services.players.mount();
  await service.mount();
  await service.handleNewGame({ layer: 'Mutaha_RAAS_v3' });

  assert.equal(service.getPhase(), 'STAGING');
  assert.equal(service.isResolving(), true);

  server.players = [
    { eosID: '1', teamID: 1 },
    { eosID: '2', teamID: 2 }
  ];

  await parent.services.players.handleUpdatedPlayerInfo();
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.getPhase(), 'STAGING');
  assert.equal(service.isResolving(), false);

  await service.unmount();
  await parent.services.players.unmount();
});

await runTest('phase transitions STAGING -> LIVE only by staging timer', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server, stagingDurationMs: 20 });

  await service.mount();
  await service.handleNewGame({ layer: 'Mutaha_RAAS_v3' });

  assert.equal(service.getPhase(), 'STAGING');
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(service.getPhase(), 'LIVE');

  await service.unmount();
});

await runTest('phase transitions ROUND_ENDED -> ENDGAME', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  await service.mount();
  await service.handleRoundEnded();
  assert.equal(service.getPhase(), 'ENDGAME');
  assert.equal(service.isEnding(), true);

  await service.unmount();
});

await runTest('persists and recovers phase/resolving/layer state via sequelize connector', async () => {
  const sequelize = new MockSequelize();

  // Create a mock DB service that wraps the sequelize
  const dbService = {
    getConnector: () => sequelize,
    getDataTypes: () => sequelize.constructor.DataTypes,
    executeWithRetry: (fn) => fn(),
    // PlayersService quotes every camelCase identifier in its bootstrap DDL.
    // This mirrors DBService's no-connector ANSI form purely so mount() can
    // build the string — nothing here executes SQL, and a mock must never be
    // treated as evidence about real dialect quoting (see guide §7.10/§11.4).
    quoteIdentifier: (name) => `"${String(name).replace(/"/g, '""')}"`,
    // PlayersService publishes its schema version so `!s3 migrate status`
    // can see it; nothing in these tests inspects the registry.
    registerExpectedVersion: () => {}
  };

  const server1 = new MockServer();
  const parent1 = { services: { db: dbService } };
  parent1.db = parent1.services.db;
  parent1.players = parent1.services.players = new PlayersService({ parent: parent1, server: server1 });
  const service1 = new GameStateService({
    parent: parent1,
    server: server1,
    ignoredGameModes: ['Seed', 'Jensen'],
    stagingDurationMs: 600000
  });
  parent1.services.gameState = service1;

  await parent1.services.players.mount();
  await service1.mount();
  await service1.handleNewGame({ layer: 'JensensRange_Skirmish_v2' });

  server1.players = [
    { eosID: '1', teamID: 1 },
    { eosID: '2', teamID: 2 }
  ];
  await parent1.services.players.handleUpdatedPlayerInfo();
  await service1.handleUpdatedPlayerInfo();

  assert.equal(service1.getPhase(), 'STAGING');
  assert.equal(service1.isResolving(), false);
  assert.equal(service1.isIgnoredMode(), true);
  await service1.unmount();
  await parent1.services.players.unmount();

  const server2 = new MockServer();
  const parent2 = { services: { db: dbService } };
  parent2.db = parent2.services.db;
  const service2 = new GameStateService({
    parent: parent2,
    server: server2,
    ignoredGameModes: ['Seed', 'Jensen'],
    stagingDurationMs: 600000
  });

  await service2.mount();
  // G2: STAGING with resolving=false now transitions to LIVE on recovery
  assert.equal(service2.getPhase(), 'LIVE');
  assert.equal(service2.isResolving(), false);
  assert.equal(service2.getLayerName(), 'JensensRange_Skirmish_v2');
  assert.equal(service2.isIgnoredMode(), true);
  await service2.unmount();
});

await runTest('invalidates recovered state when recovered round age is impossible', async () => {
  const sequelize = new MockSequelize();

  // Create a mock DB service that wraps the sequelize
  const dbService = {
    getConnector: () => sequelize,
    getDataTypes: () => sequelize.constructor.DataTypes,
    executeWithRetry: (fn) => fn(),
    // PlayersService quotes every camelCase identifier in its bootstrap DDL.
    // This mirrors DBService's no-connector ANSI form purely so mount() can
    // build the string — nothing here executes SQL, and a mock must never be
    // treated as evidence about real dialect quoting (see guide §7.10/§11.4).
    quoteIdentifier: (name) => `"${String(name).replace(/"/g, '""')}"`,
    // PlayersService publishes its schema version so `!s3 migrate status`
    // can see it; nothing in these tests inspects the registry.
    registerExpectedVersion: () => {}
  };

  const server1 = new MockServer();
  const parent1 = { services: { db: dbService } };
  parent1.db = parent1.services.db;
  const service1 = new GameStateService({
    parent: parent1,
    server: server1,
    stagingDurationMs: 600000,
    maxRecoveredRoundAgeMs: 7200000
  });

  await service1.mount();
  await service1.handleNewGame({ layer: 'Mutaha_RAAS_v3' });
  await service1.unmount();

  // Directly set stale state in the shared _rows map
  sequelize._rows.set(1, {
    id: 1,
    phase: 'STAGING',
    resolving: true,
    lastPhaseChangeAt: Date.now(),
    lastNewGameAt: Date.now() - 7205000,
    lastRoundEndedAt: null,
    lastLayerName: 'Mutaha_RAAS_v3',
    lastGamemode: 'RAAS'
  });

  const server2 = new MockServer();
  const parent2 = { services: { db: dbService } };
  parent2.db = parent2.services.db;
  const service2 = new GameStateService({
    parent: parent2,
    server: server2,
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

  // Create a mock DB service that wraps the sequelize
  const dbService = {
    getConnector: () => sequelize,
    getDataTypes: () => sequelize.constructor.DataTypes,
    executeWithRetry: (fn) => fn(),
    // PlayersService quotes every camelCase identifier in its bootstrap DDL.
    // This mirrors DBService's no-connector ANSI form purely so mount() can
    // build the string — nothing here executes SQL, and a mock must never be
    // treated as evidence about real dialect quoting (see guide §7.10/§11.4).
    quoteIdentifier: (name) => `"${String(name).replace(/"/g, '""')}"`,
    // PlayersService publishes its schema version so `!s3 migrate status`
    // can see it; nothing in these tests inspects the registry.
    registerExpectedVersion: () => {}
  };

  const server1 = new MockServer();
  const parent1 = { services: { db: dbService } };
  parent1.db = parent1.services.db;
  const service1 = new GameStateService({
    parent: parent1,
    server: server1,
    stagingDurationMs: 1000,
    maxRecoveredRoundAgeMs: 99999999
  });

  await service1.mount();
  await service1.handleNewGame({ layer: 'Mutaha_RAAS_v3' });
  await service1.unmount();

  // Directly set stale state in the shared _rows map
  sequelize._rows.set(1, {
    id: 1,
    phase: 'STAGING',
    resolving: true,
    lastPhaseChangeAt: Date.now(),
    lastNewGameAt: Date.now() - 5000,
    lastRoundEndedAt: null,
    lastLayerName: 'Mutaha_RAAS_v3',
    lastGamemode: 'RAAS'
  });

  const server2 = new MockServer();
  const parent2 = { services: { db: dbService } };
  parent2.db = parent2.services.db;
  const service2 = new GameStateService({
    parent: parent2,
    server: server2,
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

  // Create a mock DB service that wraps the sequelize
  const dbService = {
    getConnector: () => sequelize,
    getDataTypes: () => sequelize.constructor.DataTypes,
    executeWithRetry: (fn) => fn(),
    // PlayersService quotes every camelCase identifier in its bootstrap DDL.
    // This mirrors DBService's no-connector ANSI form purely so mount() can
    // build the string — nothing here executes SQL, and a mock must never be
    // treated as evidence about real dialect quoting (see guide §7.10/§11.4).
    quoteIdentifier: (name) => `"${String(name).replace(/"/g, '""')}"`,
    // PlayersService publishes its schema version so `!s3 migrate status`
    // can see it; nothing in these tests inspects the registry.
    registerExpectedVersion: () => {}
  };

  const server1 = new MockServer();
  const parent1 = { services: { db: dbService } };
  parent1.db = parent1.services.db;
  parent1.players = parent1.services.players = new PlayersService({ parent: parent1, server: server1 });
  const service1 = new GameStateService({
    parent: parent1,
    server: server1,
    stagingDurationMs: 600000,
    maxRecoveredRoundAgeMs: 99999999
  });
  parent1.services.gameState = service1;

  await parent1.services.players.mount();
  await service1.mount();
  await service1.handleNewGame({ layer: 'OldLayer_RAAS_v1' });
  server1.players = [{ eosID: '1', teamID: 1 }];
  await parent1.services.players.handleUpdatedPlayerInfo();
  await service1.handleUpdatedPlayerInfo();
  await service1.unmount();
  await parent1.services.players.unmount();

  const server2 = new MockServer();
  const parent2 = { services: { db: dbService } };
  parent2.db = parent2.services.db;
  const service2 = new GameStateService({
    parent: parent2,
    server: server2,
    stagingDurationMs: 600000,
    maxRecoveredRoundAgeMs: 99999999
  });

  await service2.mount();
  // G2: STAGING with resolving=false transitions to LIVE immediately on recovery
  assert.equal(service2.getPhase(), 'LIVE');

  // UPDATED_LAYER_INFORMATION carries no payload and does NOT repopulate
  // server.currentLayer, so handleLayerInfoUpdated resolves nothing by design —
  // it only runs the recovery-timing check. Driving it must never change the
  // layer, whatever server.currentLayer happens to hold.
  server2.currentLayer = 'DifferentLayer_AAS_v2';
  await service2.handleLayerInfoUpdated();
  assert.equal(service2.getPhase(), 'LIVE');
  assert.equal(service2.getLayerName(), 'OldLayer_RAAS_v1');

  // A literal "Unknown" from the server is rejected — the recovered layer stands.
  await service2.handleServerInfoUpdated({ currentLayer: 'Unknown' });
  assert.equal(service2.getPhase(), 'LIVE');
  assert.equal(service2.getLayerName(), 'OldLayer_RAAS_v1');

  // UPDATED_SERVER_INFORMATION is the sole resolution path: its payload wins.
  await service2.handleServerInfoUpdated({ currentLayer: 'DifferentLayer_AAS_v2' });
  assert.equal(service2.getPhase(), 'LIVE');
  assert.equal(service2.getLayerName(), 'DifferentLayer_AAS_v2');

  await service2.unmount();
});

await runTest('startup churn with null team IDs does not clear resolving early', async () => {
  const server = new MockServer();
  const parent = { services: {} };
  parent.players = parent.services.players = new PlayersService({ parent, server });
  const service = new GameStateService({ parent, server, stagingDurationMs: 2500 });
  parent.services.gameState = service;

  await parent.services.players.mount();
  await service.mount();
  await service.handleNewGame({ layer: 'Mutaha_RAAS_v3' });

  server.players = [
    { eosID: '1', teamID: null },
    { eosID: '2', teamID: 1 }
  ];

  await parent.services.players.handleUpdatedPlayerInfo();
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.isResolving(), true);

  server.players = [
    { eosID: '1', teamID: 1 },
    { eosID: '2', teamID: 2 }
  ];

  await parent.services.players.handleUpdatedPlayerInfo();
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.isResolving(), false);

  await service.unmount();
  await parent.services.players.unmount();
});

await runTest('mount/unmount does not bind server listeners directly', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  await service.mount();

  assert.equal(server.listenerCount('NEW_GAME'), 0);
  assert.equal(server.listenerCount('ROUND_ENDED'), 0);
  assert.equal(server.listenerCount('UPDATED_LAYER_INFORMATION'), 0);
  assert.equal(server.listenerCount('UPDATED_SERVER_INFORMATION'), 0);
  assert.equal(server.listenerCount('UPDATED_PLAYER_INFORMATION'), 0);

  await service.unmount();

  assert.equal(server.listenerCount('NEW_GAME'), 0);
  assert.equal(server.listenerCount('ROUND_ENDED'), 0);
  assert.equal(server.listenerCount('UPDATED_LAYER_INFORMATION'), 0);
  assert.equal(server.listenerCount('UPDATED_SERVER_INFORMATION'), 0);
  assert.equal(server.listenerCount('UPDATED_PLAYER_INFORMATION'), 0);
});

// Mock ServerConfig service for testing
class MockServerConfig {
  constructor(configOverrides = {}) {
    this.getTimeBeforeVote = () => configOverrides.timeBeforeVote ?? 30;
    this.getLayerVoteDuration = () => configOverrides.layerVoteDuration ?? 25;
    this.getTeamVoteDuration = () => configOverrides.teamVoteDuration ?? 25;
  }
}

await runTest('ROUND_ENDED transitions to ENDGAME with scoreboard sub-state', async () => {
  const server = new MockServer();
  const parent = { services: { serverConfig: new MockServerConfig() }, serverConfig: new MockServerConfig() };
  const service = new GameStateService({ parent, server });

  await service.mount();
  await service.handleRoundEnded();

  assert.equal(service.getPhase(), 'ENDGAME');
  assert.equal(service.isEnding(), true);
  assert.equal(service.isEndgameScoreboard(), true);
  assert.equal(service.getEndgameSubState(), 'scoreboard');

  await service.unmount();
});

await runTest('ENDGAME scoreboard transitions to layerVote after TimeBeforeVote', async () => {
  const server = new MockServer();
  const parent = { services: { serverConfig: new MockServerConfig({ timeBeforeVote: 0 }) }, serverConfig: new MockServerConfig({ timeBeforeVote: 0 }) };
  const service = new GameStateService({ parent, server });

  await service.mount();
  await service.handleRoundEnded();
  assert.equal(service.isEndgameScoreboard(), true);

  // Wait for scoreboard timer to elapse (0ms)
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(service.isEndgameLayerVote(), true);

  await service.unmount();
});

async function waitForSubState(service, expectedFnName, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (service[expectedFnName]()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedFnName} (current subState: ${service.getEndgameSubState()})`);
}

await runTest('ENDGAME layerVote transitions to factionVoteTeam1', async () => {
  const server = new MockServer();
  const parent = { services: { serverConfig: new MockServerConfig({ timeBeforeVote: 0, layerVoteDuration: 0 }) }, serverConfig: new MockServerConfig({ timeBeforeVote: 0, layerVoteDuration: 0 }) };
  const service = new GameStateService({ parent, server });

  await service.mount();
  await service.handleRoundEnded();

  // Wait for scoreboard -> layerVote (0ms timer chain)
  await waitForSubState(service, 'isEndgameLayerVote');
  assert.equal(service.isEndgameLayerVote(), true);

  // Wait for layerVote -> factionVoteTeam1 (0ms timer chain)
  await waitForSubState(service, 'isEndgameFactionVoteTeam1');
  assert.equal(service.isEndgameFactionVoteTeam1(), true);

  await service.unmount();
});

await runTest('ENDGAME factionVoteTeam1 transitions to factionVoteTeam2', async () => {
  const server = new MockServer();
  const parent = { services: { serverConfig: new MockServerConfig({ timeBeforeVote: 0, layerVoteDuration: 0, teamVoteDuration: 0 }) }, serverConfig: new MockServerConfig({ timeBeforeVote: 0, layerVoteDuration: 0, teamVoteDuration: 0 }) };
  const service = new GameStateService({ parent, server });

  await service.mount();
  await service.handleRoundEnded();

  // Wait for scoreboard -> layerVote -> factionVoteTeam1 (0ms timer chain)
  await waitForSubState(service, 'isEndgameFactionVoteTeam1');
  assert.equal(service.isEndgameFactionVoteTeam1(), true);

  // Wait for factionVoteTeam1 -> factionVoteTeam2
  await waitForSubState(service, 'isEndgameFactionVoteTeam2');
  assert.equal(service.isEndgameFactionVoteTeam2(), true);

  await service.unmount();
});

await runTest('ENDGAME factionVoteTeam2 transitions to postVoting (waiting for NewGame)', async () => {
  const server = new MockServer();
  const parent = { services: { serverConfig: new MockServerConfig({ timeBeforeVote: 0, layerVoteDuration: 0, teamVoteDuration: 0 }) }, serverConfig: new MockServerConfig({ timeBeforeVote: 0, layerVoteDuration: 0, teamVoteDuration: 0 }) };
  const service = new GameStateService({ parent, server });

  await service.mount();
  await service.handleRoundEnded();

  // Fast-forward through all voting phases (scoreboard -> layerVote -> factionVoteTeam1 -> factionVoteTeam2)
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Is now in ENDGAME with postVoting sub-state (waiting for NEW_GAME)
  assert.equal(service.isEnding(), true);
  assert.equal(service.getEndgameSubState(), 'postVoting');
  assert.equal(service.isEndgamePostVoting(), true);
  assert.equal(service.isEndgameVotingComplete(), true);

  await service.unmount();
});

await runTest('postVoting transitions to STAGING via NEW_GAME and clears sub-state to null', async () => {
  const server = new MockServer();
  const parent = { services: { serverConfig: new MockServerConfig({ timeBeforeVote: 0, layerVoteDuration: 0, teamVoteDuration: 0 }) }, serverConfig: new MockServerConfig({ timeBeforeVote: 0, layerVoteDuration: 0, teamVoteDuration: 0 }) };
  const service = new GameStateService({ parent, server });

  await service.mount();
  await service.handleRoundEnded();

  // Fast-forward through all voting phases into postVoting
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(service.isEndgamePostVoting(), true);

  // NEW_GAME should clear the ENDGAME phase and sub-state
  await service.handleNewGame({ layer: 'Mutaha_RAAS_v3' });
  assert.equal(service.getPhase(), 'STAGING');
  assert.equal(service.getEndgameSubState(), null);
  assert.equal(service.isEndgameVotingComplete(), false);

  await service.unmount();
});

await runTest('NEW_GAME clears ENDGAME timer and sub-state', async () => {
  const server = new MockServer();
  const parent = { services: { serverConfig: new MockServerConfig({ timeBeforeVote: 60 }) }, serverConfig: new MockServerConfig({ timeBeforeVote: 60 }) };
  const service = new GameStateService({ parent, server });

  await service.mount();
  await service.handleRoundEnded();
  assert.equal(service.isEndgameScoreboard(), true);

  // NEW_GAME should clear the timer and reset sub-state
  await service.handleNewGame({ layer: 'Mutaha_RAAS_v3' });
  assert.equal(service.getPhase(), 'STAGING');
  assert.equal(service.getEndgameSubState(), null);

  await service.unmount();
});

await runTest('ENDGAME sub-state query methods return false outside ENDGAME', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  await service.mount();

  assert.equal(service.isEndgameScoreboard(), false);
  assert.equal(service.isEndgameLayerVote(), false);
  assert.equal(service.isEndgameFactionVote(), false);
  assert.equal(service.isEndgameFactionVoteTeam1(), false);
  assert.equal(service.isEndgameFactionVoteTeam2(), false);
  assert.equal(service.isEndgamePostVoting(), false);
  assert.equal(service.isEndgameVotingComplete(), false);
  assert.equal(service.getEndgameSubState(), null);

  await service.unmount();
});

// _normalizeLayerName feeds handleServerInfoUpdated's "has the layer actually
// changed?" guard. It used to strip before lowercasing, and [^a-z0-9] does not
// include A-Z — so every capital was deleted. Gamemode tokens are all-caps,
// which made distinct layers on the same map collide and suppressed real layer
// changes. Found on the live test server, 2026-08-19.
await runTest('_normalizeLayerName keeps capitals, so same-map gamemode switches stay distinct', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  // The collision that mattered: RAAS vs AAS on one map must NOT normalize equal.
  assert.notEqual(
    service._normalizeLayerName('Yehorivka_RAAS_v2'),
    service._normalizeLayerName('Yehorivka_AAS_v2')
  );
  assert.notEqual(
    service._normalizeLayerName('Gorodok_RAAS_v1'),
    service._normalizeLayerName('Gorodok_AAS_v1')
  );

  // Capitals must survive normalization at all.
  assert.equal(service._normalizeLayerName('Fallujah RAAS v2'), 'fallujahraasv2');
  assert.equal(service._normalizeLayerName('Yehorivka_RAAS_v2'), 'yehorivkaraasv2');

  // The guard's actual job: the pretty name and the classname for the SAME
  // layer must still compare equal, or every server-info poll re-resolves.
  assert.equal(
    service._normalizeLayerName('Fallujah RAAS v2'),
    service._normalizeLayerName('Fallujah_RAAS_v2')
  );
  assert.equal(
    service._normalizeLayerName('Al Basrah AAS v1'),
    service._normalizeLayerName('AlBasrah_AAS_v1')
  );

  assert.equal(service._normalizeLayerName(null), '');
  assert.equal(service._normalizeLayerName(''), '');
});

await runTest('handleServerInfoUpdated resolves a same-map gamemode switch', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  await service.resolveLayerInfo({ name: 'Yehorivka RAAS v2', gamemode: 'RAAS' }, 'test');
  assert.equal(service.getGamemode(), 'RAAS');

  // Same map, different gamemode. Before the normalizer fix both sides
  // collapsed to "ehorivkav2" and this returned early, leaving RAAS cached.
  await service.handleServerInfoUpdated({ currentLayer: { name: 'Yehorivka_AAS_v2', gamemode: 'AAS' } });
  assert.equal(service.getGamemode(), 'AAS');
  assert.equal(service.getLayerName(), 'Yehorivka_AAS_v2');
});

if (!process.exitCode) {
  console.log('\nAll game-state-service tests passed.');
}
