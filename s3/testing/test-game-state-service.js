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

await runTest('staging duration comes from the gamemode, not from a config option', async () => {
  const server = new MockServer();
  // No stagingDurationMs — exactly how the S³ plugin constructs it. Staging
  // length is a property of the gamemode, so there is no option to pass.
  const service = new GameStateService({ server });

  await service.resolveLayerInfo('Gorodok_RAAS_v2', 'test');
  service._roundLayerTrusted = true;
  assert.equal(
    service._stagingDurationForRound(),
    250000,
    'RAAS is 10s pre-match + 4min staging, measured from NEW_GAME'
  );

  // Invasion's match-start countdown is a full minute rather than 10s, so it
  // must NOT inherit the RAAS figure — that is two minutes of a round S³ would
  // otherwise have called LIVE early.
  await service.resolveLayerInfo('Fallujah_Invasion_v1', 'test');
  assert.equal(service.getGamemode(), 'Invasion');
  assert.equal(service._stagingDurationForRound(), 300000);

  // An unmeasured mode falls back rather than being guessed at in the table.
  await service.resolveLayerInfo('Sumari_Skirmish_v1', 'test');
  assert.equal(service.getGamemode(), 'Skirmish');
  assert.equal(service._stagingDurationForRound(), 250000);

  // An unresolved layer never reads the table: that is the stale-layer bug.
  service._roundLayerTrusted = false;
  assert.equal(service._stagingDurationForRound(), 250000);
});

await runTest('an explicit stagingDurationMs overrides the gamemode table', async () => {
  const server = new MockServer();
  // The test-only injection point. Production passes nothing, so the table
  // always wins there and no config key can set a wrong value.
  const service = new GameStateService({ server, stagingDurationMs: 40 });

  await service.resolveLayerInfo('Gorodok_RAAS_v2', 'test');
  service._roundLayerTrusted = true;
  assert.equal(service._stagingDurationForRound(), 40);
});

await runTest('the staging timer does not hold the process open', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  await service.handleNewGame({ layer: 'Gorodok_RAAS_v2' });
  assert.equal(service.getPhase(), 'STAGING');
  assert.ok(service._stagingLiveTimer, 'timer should be armed');
  // Without unref, every test that mounts and walks away would sit here for
  // the full four minutes.
  assert.equal(service._stagingLiveTimer.hasRef(), false);

  service._clearStagingLiveTimer();
});

await runTest('the staging timer handle is released once it fires', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server, stagingDurationMs: 30 });

  await service.mount();
  await service.handleNewGame({ layer: 'Mutaha_RAAS_v3' });
  assert.ok(service._stagingLiveTimer, 'timer should be armed while STAGING');

  await new Promise((resolve) => setTimeout(resolve, 80));

  // `!s3 gamestate` reads this field to answer "Staging Timer: Pending". A
  // fired timeout handle stays truthy, so leaving it set made the command
  // report a pending staging timer for the whole LIVE round.
  assert.equal(service.getPhase(), 'LIVE');
  assert.equal(service._stagingLiveTimer, null);

  await service.unmount();
});

await runTest('the staging timer handle is released even when the phase moved on', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server, stagingDurationMs: 30 });

  await service.mount();
  await service.handleNewGame({ layer: 'Mutaha_RAAS_v3' });

  // The callback's early return (phase is no longer STAGING) is the other exit
  // and has to release the handle too.
  service.phase = 'LIVE';
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(service._stagingLiveTimer, null);

  await service.unmount();
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

await runTest('phase-change notification still fires when _persistState throws (DB outage)', async () => {
  // Regression test: an uncaught throw from _persistState() used to propagate
  // out of the phase-transition handler (e.g. handleRoundEnded), which meant
  // the awaited call never reached its onGamePhaseChange() notification.
  // Downstream consumers (Switch's seed-token grant on ENDGAME, SmartAssign's
  // roster snapshot on S3_ROUND_LIVE) depend on that notification firing
  // regardless of whether the persistence write itself succeeded.
  const sequelize = new MockSequelize();
  // The outage must hit only the runtime _persistState() write path, not
  // mount()'s one-time GameStateModel.sync() — so let the first call through
  // (table creation) and start throwing from the second call onward (the
  // persist that follows handleRoundEnded()'s in-memory phase transition).
  let callCount = 0;
  const dbService = {
    getConnector: () => sequelize,
    getDataTypes: () => sequelize.constructor.DataTypes,
    executeWithRetry: (fn) => {
      callCount++;
      if (callCount > 1) throw new Error('SequelizeConnectionAcquireTimeoutError: Operation timeout');
      return fn();
    },
    quoteIdentifier: (name) => `"${String(name).replace(/"/g, '""')}"`,
    registerExpectedVersion: () => {}
  };

  const server = new MockServer();
  const parent = { services: { db: dbService } };
  parent.db = parent.services.db;
  const service = new GameStateService({ parent, server, stagingDurationMs: 600000 });
  parent.services.gameState = service;

  await service.mount();

  const seenPhases = [];
  service.onGamePhaseChange((prevPhase) => seenPhases.push(service.getPhase()));

  await service.handleRoundEnded();

  assert.equal(service.getPhase(), 'ENDGAME', 'in-memory phase must still transition despite the DB throw');
  assert.deepEqual(seenPhases, ['ENDGAME'], 'notification must fire even though _persistState() failed');

  await service.unmount();
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

// Durations below are in SECONDS — _getLayerVoteDuration() multiplies by 1000.
// The stage a test wants to *observe* must therefore be given a window wider
// than waitForSubState()'s 10ms poll. Setting every duration to 0 (as these two
// tests used to) let the machine run the whole chain to completion inside the
// first tick, so the poller only ever saw the state after the one it wanted and
// timed out — the state machine was right and the test was wrong.
const OBSERVABLE = 0.3; // 300ms

async function waitForSubState(service, expectedFnName, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (service[expectedFnName]()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expectedFnName} (current subState: ${service.getEndgameSubState()})`);
}

await runTest('ENDGAME layerVote transitions to factionVoteTeam1', async () => {
  const server = new MockServer();
  // layerVote is the stage under observation, so it gets the wide window.
  const cfg = { timeBeforeVote: 0, layerVoteDuration: OBSERVABLE };
  const parent = { services: { serverConfig: new MockServerConfig(cfg) }, serverConfig: new MockServerConfig(cfg) };
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
  // Both faction-vote stages are under observation here and they share one
  // duration, so teamVoteDuration gets the wide window.
  const cfg = { timeBeforeVote: 0, layerVoteDuration: 0, teamVoteDuration: OBSERVABLE };
  const parent = { services: { serverConfig: new MockServerConfig(cfg) }, serverConfig: new MockServerConfig(cfg) };
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

// ─── LAYER NAME CANONICALISATION ────────────────────────────────────
//
// SquadJS delivers one layer under two conventions and S³ canonicalises onto
// the classname. The variants asserted below are not invented: they are the
// layerName values found across the twelve production scramble reports in
// docs/dataDump/scramblereports/, which contain the SAME map written both ways
// ("FoolsRoad_RAAS_v1" and "Fool's Road RAAS v1"). Fixtures would not have
// produced the apostrophe.

await runTest('resolveLayerInfo canonicalises a Layer object onto its classname', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  // The shape squad-server/layers/layer.js actually produces: both names, on
  // one object. Canonicalisation is therefore a field read, not a guess — the
  // classname never has to be reverse-engineered from the pretty name.
  await service.resolveLayerInfo(
    { name: 'Sumari Bala Seed v1', classname: 'Sumari_Seed_v1', gamemode: 'Seed' },
    'test'
  );

  assert.equal(service.getLayerName(), 'Sumari_Seed_v1');
  assert.equal(service.getLayerDisplayName(), 'Sumari Bala Seed v1');
  assert.equal(service.getGamemode(), 'Seed');
});

await runTest('a classname-only string resolves without inventing a pretty name', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  await service.resolveLayerInfo('Kohat_RAAS_v1', 'test');
  assert.equal(service.getLayerName(), 'Kohat_RAAS_v1');
  // No prettier spelling has been seen, so display falls back to the canonical
  // name rather than guessing one.
  assert.equal(service.getLayerDisplayName(), 'Kohat_RAAS_v1');
});

await runTest('a learned alias canonicalises a bare pretty string', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  // Seeing the object once teaches the pairing...
  await service.resolveLayerInfo(
    { name: 'Sumari Bala Seed v1', classname: 'Sumari_Seed_v1', gamemode: 'Seed' },
    'test'
  );
  // ...so a later caller passing only the pretty string still lands on the
  // classname. Without this, a plain-string path would re-introduce the second
  // convention that the whole change exists to remove.
  await service.resolveLayerInfo('Sumari Bala Seed v1', 'test');
  assert.equal(service.getLayerName(), 'Sumari_Seed_v1');
  assert.equal(service.getLayerDisplayName(), 'Sumari Bala Seed v1');
});

await runTest('NEW_GAME then a server-info poll is ONE layer change, not two', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  const seen = [];
  service.onLayerGameModeChange((payload) => seen.push(payload));

  // This is the observed production sequence: NEW_GAME carries the pretty name,
  // and ~16s later UPDATED_SERVER_INFORMATION carries the classname for the
  // very same layer. Before canonicalisation the normalized fingerprints
  // disagreed ("sumaribalaseedv1" vs "sumariseedv1"), the change guard let it
  // through, and every subscriber was told the layer had changed when it had
  // not — twice per round, forever.
  await service.resolveLayerInfo(
    { name: 'Sumari Bala Seed v1', classname: 'Sumari_Seed_v1', gamemode: 'Seed' },
    'handleNewGame'
  );
  await service.handleServerInfoUpdated({ currentLayer: 'Sumari_Seed_v1' });

  assert.equal(seen.length, 1, `expected one layer-change notification, got ${seen.length}`);
  assert.equal(seen[0].layerName, 'Sumari_Seed_v1');
  assert.equal(seen[0].layerDisplayName, 'Sumari Bala Seed v1');
  assert.equal(service.getLayerName(), 'Sumari_Seed_v1');
});

await runTest('_layerNamesMatch bridges both real-world convention gaps', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  // Punctuation-only, including the apostrophe pair seen in production.
  assert.ok(service._layerNamesMatch("Fool's Road RAAS v1", 'FoolsRoad_RAAS_v1'));
  assert.ok(service._layerNamesMatch('Black Coast RAAS v2', 'BlackCoast_RAAS_v2'));
  assert.ok(service._layerNamesMatch('Skorpo RAAS v1', 'Skorpo_RAAS_v1'));
  assert.ok(service._layerNamesMatch('Al Basrah AAS v1', 'AlBasrah_AAS_v1'));

  // A word the classname drops — the case plain normalization cannot reach.
  assert.ok(service._layerNamesMatch('Sumari Bala Seed v1', 'Sumari_Seed_v1'));
  assert.ok(service._layerNamesMatch('Tallil Outskirts Invasion v1', 'Tallil_Invasion_v1'));
  assert.ok(service._layerNamesMatch('Sumari_Seed_v1', 'Sumari Bala Seed v1'), 'must be symmetric');
});

await runTest('_layerNamesMatch keeps genuinely different layers apart', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  // The regression this tolerance must never re-introduce: RAAS and AAS on one
  // map read as "no change", so a real switch is ignored for the whole round.
  assert.equal(service._layerNamesMatch('Yehorivka_RAAS_v2', 'Yehorivka_AAS_v2'), false);
  assert.equal(service._layerNamesMatch('Yehorivka RAAS v2', 'Yehorivka_AAS_v2'), false);

  // Versions.
  assert.equal(service._layerNamesMatch('Kohat_RAAS_v1', 'Kohat_RAAS_v2'), false);
  // Why "v1" is kept as one token instead of splitting on the letter/digit
  // boundary: [.., v, 1] would be a strict subset of [.., v, 1, 0].
  assert.equal(service._layerNamesMatch('Kohat_RAAS_v1', 'Kohat_RAAS_v10'), false);

  // Different maps, same mode and version.
  assert.equal(service._layerNamesMatch('Narva_RAAS_v1', 'Yehorivka_RAAS_v1'), false);

  // Word tolerance applies ONLY to the map name in front of the gamemode
  // token; everything from the gamemode onward must match exactly.
  assert.equal(service._layerNamesMatch('Narva_Invasion_v1', 'Narva_Invasion_v1_Alt'), false);

  // No gamemode token at all means no tolerance beyond punctuation.
  assert.equal(service._layerNamesMatch('JensensRange_USA-PLA', 'JensensRange_USA-RUS'), false);
  assert.ok(service._layerNamesMatch('JensensRange_USA-PLA', 'Jensens Range USA PLA'));

  assert.equal(service._layerNamesMatch(null, 'Kohat_RAAS_v1'), false);
  assert.equal(service._layerNamesMatch('Kohat_RAAS_v1', ''), false);
});

await runTest('a multi-word ignoredGameModes needle survives canonicalisation', async () => {
  const server = new MockServer();
  // Single-word needles ('Seed', 'Jensen') match under either convention, which
  // is why the defaults were never at risk. A configured map name with a space
  // in it only ever matched the pretty spelling.
  const service = new GameStateService({ server, ignoredGameModes: ['Al Basrah'] });

  await service.resolveLayerInfo(
    { name: 'Al Basrah AAS v1', classname: 'AlBasrah_AAS_v1', gamemode: 'AAS' },
    'test'
  );

  assert.equal(service.getLayerName(), 'AlBasrah_AAS_v1');
  assert.ok(service.isIgnoredMode(), 'the operator\'s needle stopped matching after canonicalisation');
});

await runTest('recovery survives a persisted name in the other convention', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  // The highest-risk part of canonicalising: a row written before the change
  // holds the pretty name, the live server reports the classname. A strict
  // comparison calls that a layer divergence, invalidates a perfectly good
  // recovered round and drops it to LIVE — on every single restart.
  service.phase = 'LIVE';
  service.lastNewGameAt = Date.now() - 60_000;
  service._recoveredStateActive = true;
  service.lastKnownGoodLayer = { name: 'Sumari Bala Seed v1', gamemode: 'Seed' };
  service.layerNameCached = 'Sumari Bala Seed v1';
  service.gameModeCached = 'Seed';

  await service._validateRecoveredState('test', { serverLayerName: 'Sumari_Seed_v1' });

  assert.equal(service.phase, 'LIVE');
  assert.equal(service.getLayerName(), 'Sumari Bala Seed v1', 'agreement must not clear the caches');
  // Agreement is what CONFIRMS the recovered state, so the flag clears here.
  assert.equal(service._recoveredStateActive, false);
});

await runTest('recovery still invalidates on a real layer divergence', async () => {
  const server = new MockServer();
  const service = new GameStateService({ server });

  service.phase = 'LIVE';
  service.lastNewGameAt = Date.now() - 60_000;
  service._recoveredStateActive = true;
  service.lastKnownGoodLayer = { name: 'Sumari_Seed_v1', gamemode: 'Seed' };
  service.layerNameCached = 'Sumari_Seed_v1';
  service.gameModeCached = 'Seed';

  await service._validateRecoveredState('test', { serverLayerName: 'Yehorivka_RAAS_v1' });

  assert.equal(service.layerNameCached, null, 'a divergent layer must clear the stale caches');
  assert.equal(service._recoveredStateActive, false);
});

if (!process.exitCode) {
  console.log('\nAll game-state-service tests passed.');
}
