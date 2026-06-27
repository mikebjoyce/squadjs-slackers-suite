/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          CRASH-RECOVERY TEST SUITE                           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates every crash-recovery path in GameStateService:
 *   STAGING (resolving=true)    → recover + restart timer
 *   STAGING (resolving=false)   → G2 skip timer → LIVE
 *   LIVE                         → stays LIVE, backfill roundStartTime
 *   ENDGAME (stale >5 min)      → G1 stale guard → LIVE
 *   ENDGAME (recent <5 min)     → stays ENDGAME (null subState, by design)
 *   Fast restart (layer match)  → stays in recovered phase
 *   Fast restart (layer change) → transition to LIVE
 *   Seed/Training recovery      → exempt from age/overdue checks
 *   mount() backfill            → roundStartTime populated mid-round
 *   G3 timer callback           → _recoveredStateActive cleared
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-crash-recovery.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Uses mock Sequelize and mock Server — no running SquadJS required.
 * - Simulates crashes by directly manipulating DB rows in the shared
 *   _rows map, then creating a fresh GameStateService that recovers.
 *
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import GameStateService from '../utils/game-state-service.js';

// ── Mock Server ──────────────────────────────────────────────────

class MockServer extends EventEmitter {
  constructor() {
    super();
    this.players = [];
    this.currentLayer = null;
    this.matchStartTime = null;
  }
}

// ── Mock Sequelize ───────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Create a minimal mock DB service wrapping a MockSequelize instance.
 */
function makeMockDbService(sequelize) {
  return {
    getConnector: () => sequelize,
    getDataTypes: () => sequelize.constructor.DataTypes,
    executeWithRetry: (fn) => fn()
  };
}

/**
 * Convenience: create a GameStateService with a mock DB and server,
 * without needing to wire parent/services manually for tests that
 * don't need PlayersService.
 */
function createRecoveryService({ sequelize, server, stagingDurationMs, maxRecoveredRoundAgeMs } = {}) {
  const dbService = makeMockDbService(sequelize);
  const parent = { db: dbService };
  const opts = {
    parent,
    server,
    stagingDurationMs: stagingDurationMs ?? 600000,
    maxRecoveredRoundAgeMs: maxRecoveredRoundAgeMs ?? 7200000
  };
  if (typeof stagingDurationMs === 'number') opts.stagingDurationMs = stagingDurationMs;
  if (typeof maxRecoveredRoundAgeMs === 'number') opts.maxRecoveredRoundAgeMs = maxRecoveredRoundAgeMs;
  return new GameStateService(opts);
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

// ── Tests ─────────────────────────────────────────────────────────

// ── Test 1: Crash during STAGING (resolving=true) ────────────────
await runTest('crash STAGING resolving=true — recover, restart timer, timer fires → LIVE', async () => {
  const sequelize = new MockSequelize();

  // Crash ~15ms ago — recent enough that the staging overdue check doesn't fire
  const crashTime = Date.now() - 15;
  sequelize._rows.set(1, {
    id: 1,
    phase: 'STAGING',
    resolving: true,
    lastPhaseChangeAt: crashTime,
    lastNewGameAt: crashTime,
    lastRoundEndedAt: null,
    lastLayerName: 'Mutaha_RAAS_v3',
    lastGamemode: 'RAAS',
    roundStartTime: crashTime,
    matchId: Math.floor(crashTime / 1000).toString(36).slice(-8)
  });

  const server = new MockServer();
  server.matchStartTime = new Date(crashTime);
  const service = createRecoveryService({ sequelize, server, stagingDurationMs: 50, maxRecoveredRoundAgeMs: 99999999 });

  await service.mount();
  assert.equal(service.getPhase(), 'STAGING');
  assert.equal(service.isResolving(), true);

  // Wait for the short staging timer to fire (50ms remaining)
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(service.getPhase(), 'LIVE');

  await service.unmount();
});

// ── Test 2: Crash during STAGING (resolving=false) → G2 → LIVE ──
await runTest('crash STAGING resolving=false — G2 skip timer, transition directly to LIVE', async () => {
  const sequelize = new MockSequelize();

  const crashTime = Date.now() - 10000;
  sequelize._rows.set(1, {
    id: 1,
    phase: 'STAGING',
    resolving: false,
    lastPhaseChangeAt: crashTime,
    lastNewGameAt: crashTime,
    lastRoundEndedAt: null,
    lastLayerName: 'Mutaha_RAAS_v3',
    lastGamemode: 'RAAS',
    roundStartTime: crashTime,
    matchId: Math.floor(crashTime / 1000).toString(36).slice(-8)
  });

  const server = new MockServer();
  server.matchStartTime = new Date(crashTime);
  const service = createRecoveryService({ sequelize, server });

  await service.mount();
  // G2 should have transitioned to LIVE immediately — no staging timer
  assert.equal(service.getPhase(), 'LIVE');
  assert.equal(service.isResolving(), false);

  await service.unmount();
});

// ── Test 3: Crash during LIVE ────────────────────────────────────
await runTest('crash LIVE — stays LIVE, mount backfills roundStartTime if null', async () => {
  const sequelize = new MockSequelize();

  const crashTime = Date.now() - 30000;
  const roundStart = crashTime - 120000; // round started 2 min before crash
  sequelize._rows.set(1, {
    id: 1,
    phase: 'LIVE',
    resolving: false,
    lastPhaseChangeAt: crashTime,
    lastNewGameAt: crashTime,
    lastRoundEndedAt: null,
    lastLayerName: 'Mutaha_RAAS_v3',
    lastGamemode: 'RAAS',
    roundStartTime: roundStart,
    matchId: Math.floor(roundStart / 1000).toString(36).slice(-8)
  });

  const server = new MockServer();
  server.matchStartTime = new Date(roundStart);
  const service = createRecoveryService({ sequelize, server });

  await service.mount();
  assert.equal(service.getPhase(), 'LIVE');
  assert.equal(service.isResolving(), false);
  // roundStartTime should be preserved from DB
  assert.equal(service.getRoundStartTime(), roundStart);

  await service.unmount();
});

// ── Test 4: Crash during ENDGAME — stale (>5 min) → G1 → LIVE ───
await runTest('crash ENDGAME stale >5min — G1 stale guard transitions to LIVE', async () => {
  const sequelize = new MockSequelize();

  const roundEnded = Date.now() - 310000; // ~5 min 10 sec ago — stale
  const newGameTime = roundEnded - 1800000; // round started 30 min ago
  sequelize._rows.set(1, {
    id: 1,
    phase: 'ENDGAME',
    resolving: false,
    lastPhaseChangeAt: roundEnded,
    lastNewGameAt: newGameTime,
    lastRoundEndedAt: roundEnded,
    lastLayerName: 'Mutaha_RAAS_v3',
    lastGamemode: 'RAAS',
    roundStartTime: newGameTime,
    matchId: Math.floor(newGameTime / 1000).toString(36).slice(-8)
  });

  const server = new MockServer();
  server.matchStartTime = new Date(newGameTime);
  const service = createRecoveryService({ sequelize, server });

  await service.mount();
  // G1 stale guard should fire — transition to LIVE
  assert.equal(service.getPhase(), 'LIVE');
  assert.equal(service.getEndgameSubState(), null);

  await service.unmount();
});

// ── Test 5: Crash during ENDGAME — recent (<5 min) ───────────────
await runTest('crash ENDGAME recent <5min — stays ENDGAME, null subState (by design)', async () => {
  const sequelize = new MockSequelize();

  const roundEnded = Date.now() - 30000; // 30 seconds ago — recent
  const newGameTime = roundEnded - 1800000;
  sequelize._rows.set(1, {
    id: 1,
    phase: 'ENDGAME',
    resolving: false,
    lastPhaseChangeAt: roundEnded,
    lastNewGameAt: newGameTime,
    lastRoundEndedAt: roundEnded,
    lastLayerName: 'Mutaha_RAAS_v3',
    lastGamemode: 'RAAS',
    roundStartTime: newGameTime,
    matchId: Math.floor(newGameTime / 1000).toString(36).slice(-8)
  });

  const server = new MockServer();
  server.matchStartTime = new Date(newGameTime);
  const service = createRecoveryService({ sequelize, server });

  await service.mount();
  // Stays in ENDGAME — sub-state is null (not persisted), no timer
  assert.equal(service.getPhase(), 'ENDGAME');
  assert.equal(service.getEndgameSubState(), null);
  // isEndgameFactionVote returns false (safe)
  assert.equal(service.isEndgameFactionVote(), false);

  await service.unmount();
});

// ── Test 6: Crash during ENDGAME — game server advanced (matchStartTime divergence) ──
await runTest('crash ENDGAME but server advanced — matchStartTime divergence → LIVE', async () => {
  const sequelize = new MockSequelize();

  const roundEnded = Date.now() - 120000; // 2 min ago (under stale threshold)
  const newGameTime = roundEnded - 300000;
  sequelize._rows.set(1, {
    id: 1,
    phase: 'ENDGAME',
    resolving: false,
    lastPhaseChangeAt: roundEnded,
    lastNewGameAt: newGameTime,
    lastRoundEndedAt: roundEnded,
    lastLayerName: 'Mutaha_RAAS_v3',
    lastGamemode: 'RAAS',
    roundStartTime: newGameTime,
    matchId: Math.floor(newGameTime / 1000).toString(36).slice(-8)
  });

  const server = new MockServer();
  // matchStartTime diverges — server has advanced to a new round
  server.matchStartTime = new Date(roundEnded + 10000);

  const service = createRecoveryService({ sequelize, server });

  await service.mount();
  // matchStartTime divergence (>5000ms) should trigger transition to LIVE
  assert.equal(service.getPhase(), 'LIVE');

  await service.unmount();
});

// ── Test 7: Fast restart — game server unchanged ─────────────────
await runTest('fast restart — matchStartTime matches, layer matches — stays in phase', async () => {
  const sequelize = new MockSequelize();

  const now = Date.now();
  const roundStart = now - 60000; // round started 1 minute ago
  sequelize._rows.set(1, {
    id: 1,
    phase: 'LIVE',
    resolving: false,
    lastPhaseChangeAt: now - 30000,
    lastNewGameAt: roundStart,
    lastRoundEndedAt: null,
    lastLayerName: 'Mutaha_RAAS_v3',
    lastGamemode: 'RAAS',
    roundStartTime: roundStart,
    matchId: Math.floor(roundStart / 1000).toString(36).slice(-8)
  });

  const server = new MockServer();
  server.matchStartTime = new Date(roundStart); // matches
  server.currentLayer = 'Mutaha_RAAS_v3'; // matches
  const service = createRecoveryService({ sequelize, server });

  await service.mount();
  // Should stay in LIVE — no divergence detected
  assert.equal(service.getPhase(), 'LIVE');

  // After handleServerInfoUpdated with matching layer, _recoveredStateActive clears
  assert.equal(service._recoveredStateActive, true); // still active before validation
  await service.handleServerInfoUpdated({ currentLayer: 'Mutaha_RAAS_v3' });
  assert.equal(service._recoveredStateActive, false); // cleared by matching layer

  await service.unmount();
});

// ── Test 8: Fast restart — layer changed ─────────────────────────
await runTest('fast restart — layer divergence → transition to LIVE', async () => {
  const sequelize = new MockSequelize();

  const now = Date.now();
  const roundStart = now - 60000;
  sequelize._rows.set(1, {
    id: 1,
    phase: 'STAGING',
    resolving: true,
    lastPhaseChangeAt: now - 30000,
    lastNewGameAt: roundStart,
    lastRoundEndedAt: null,
    lastLayerName: 'OldLayer_RAAS_v1',
    lastGamemode: 'RAAS',
    roundStartTime: roundStart,
    matchId: Math.floor(roundStart / 1000).toString(36).slice(-8)
  });

  const server = new MockServer();
  server.matchStartTime = new Date(roundStart);
  // Do NOT set server.currentLayer before mount — mount would resolveLayerInfo it and
  // overwrite the recovered lastKnownGoodLayer, preventing divergence detection.
  const service = createRecoveryService({ sequelize, server });

  await service.mount();
  // Still in STAGING on mount — recovery restored the old layer
  assert.equal(service.getPhase(), 'STAGING');

  // handleServerInfoUpdated with a different layer triggers _validateRecoveredState
  await service.handleServerInfoUpdated({ currentLayer: 'NewLayer_AAS_v2' });
  // Layer divergence should trigger transition to LIVE
  assert.equal(service.getPhase(), 'LIVE');

  await service.unmount();
});

// ── Test 9: mount() backfills roundStartTime when LIVE with null ──
await runTest('mount backfills roundStartTime when LIVE with null', async () => {
  const sequelize = new MockSequelize();

  // No DB row — cold start
  const server = new MockServer();
  const service = createRecoveryService({ sequelize, server });

  const mountTime = Date.now();
  await service.mount();
  // Cold start: phase=LIVE, roundStartTime=null → mount backfills
  assert.equal(service.getPhase(), 'LIVE');
  const backfilled = service.getRoundStartTime();
  assert.ok(backfilled !== null);
  assert.ok(backfilled >= mountTime);
  assert.ok(backfilled <= Date.now());

  // matchId should also be set (base-36 encoded, length varies by timestamp)
  const matchId = service.getMatchId();
  assert.ok(matchId);
  assert.equal(typeof matchId, 'string');
  assert.ok(matchId.length >= 1);

  await service.unmount();
});

// ── Test 10: _recoveredStateActive cleared by STAGING→LIVE timer ──
await runTest('G3 — _recoveredStateActive cleared by STAGING→LIVE timer callback', async () => {
  const sequelize = new MockSequelize();

  // Crash ~15ms ago — recent enough that the staging overdue check doesn't fire
  const crashTime = Date.now() - 15;
  sequelize._rows.set(1, {
    id: 1,
    phase: 'STAGING',
    resolving: true,
    lastPhaseChangeAt: crashTime,
    lastNewGameAt: crashTime,
    lastRoundEndedAt: null,
    lastLayerName: 'Mutaha_RAAS_v3',
    lastGamemode: 'RAAS',
    roundStartTime: crashTime,
    matchId: Math.floor(crashTime / 1000).toString(36).slice(-8)
  });

  const server = new MockServer();
  server.matchStartTime = new Date(crashTime);
  const service = createRecoveryService({ sequelize, server, stagingDurationMs: 50, maxRecoveredRoundAgeMs: 99999999 });

  await service.mount();
  assert.equal(service.getPhase(), 'STAGING');
  assert.equal(service._recoveredStateActive, true);

  // Wait for timer to fire — G3 should clear _recoveredStateActive
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(service.getPhase(), 'LIVE');
  assert.equal(service._recoveredStateActive, false);

  // _validateRecoveredState on next tick is a no-op (already false)
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.getPhase(), 'LIVE');

  await service.unmount();
});

// ── Test 11: Seed/Training exempt from recovery age/overdue checks ──
await runTest('7.5b — Seed layer exempt from recovery round-too-old and staging-overdue', async () => {
  const sequelize = new MockSequelize();

  // A Seed layer with a very old lastNewGameAt — would normally trigger _isRecoveredRoundTooOld
  const oldTime = Date.now() - 36000000; // 10 hours ago (well over max 2h)
  sequelize._rows.set(1, {
    id: 1,
    phase: 'STAGING',
    resolving: true,
    lastPhaseChangeAt: oldTime,
    lastNewGameAt: oldTime,
    lastRoundEndedAt: null,
    lastLayerName: 'JensensRange_Seed_v1',
    lastGamemode: 'Seed',
    roundStartTime: oldTime,
    matchId: Math.floor(oldTime / 1000).toString(36).slice(-8)
  });

  const server = new MockServer();
  server.matchStartTime = new Date(oldTime);
  const service = createRecoveryService({ sequelize, server });

  await service.mount();
  // Should NOT be transitioned to LIVE — Seed exemption keeps it in STAGING
  assert.equal(service.getPhase(), 'STAGING');
  assert.equal(service.isSeedMode(), true);

  await service.unmount();
});

// ── Summary ───────────────────────────────────────────────────────
if (!process.exitCode) {
  console.log('\nAll crash-recovery tests passed.');
}