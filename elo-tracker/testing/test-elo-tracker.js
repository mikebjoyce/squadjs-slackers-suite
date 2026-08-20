/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  TEST: ELO TRACKER PLUGIN                      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates the main EloTracker plugin: mount/unmount lifecycle,
 * event listener registration, round outcome processing, and
 * integration with the in-memory session manager and calculator.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/run-all-tests.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Uses mocked server, rcon, and plugin APIs; no live SquadJS required.
 * - elo-tracker.js imports './s3-plugin-base.js', a sibling only in the
 *   FLATTENED layout install.cjs produces; in this source tree that file is
 *   at s3/plugins/. Importing it from ../plugins/ therefore threw
 *   ERR_MODULE_NOT_FOUND, which the runner used to report as "Skipped" — the
 *   suite went green with this file never executing. It now builds the shipped
 *   layout first, via the same helper switch/ uses.
 * - Monorepo-only: reaching into ../../s3/ does not resolve at a deployed
 *   target, where every plugin's files share one flat directory.
 *
 */

import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';
import { makeMockS3 } from '../../s3/testing/mock-s3.js';

export default async function runTrackerTests(runTest) {
  const assembly = buildAssembly('.tmp-elo-tracker');
  const EloTracker = await importFromAssembly(assembly, 'elo-tracker.js');

  try {
    await runTrackerCases(runTest, EloTracker);
  } finally {
    cleanAssembly(assembly);
  }
}

/** Drive a plugin through the real base-class lifecycle, mocks injected between. */
async function mountTracker(EloTracker, server, options, connectors, inject) {
  const tracker = new EloTracker(server, options, connectors);
  // prepareToMount() is where S3PluginBase discovers S³. mount() does NOT call
  // it, so skipping it leaves _s3 undefined and the version gate reports
  // "got unknown" — which is exactly how this file used to fail.
  await tracker.prepareToMount();
  if (inject) inject(tracker);
  await tracker.mount();
  return tracker;
}

async function runTrackerCases(runTest, EloTracker) {
  // A fresh mock server per test. Not an EventEmitter: SquadJS's emit() is
  // synchronous and drops the promise an async listener returns, so awaiting
  // the handler here is the only way a test can assert on what it did.
  const createMockServer = () => ({
    players: [],
    listeners: {},
    matchStartTime: new Date(),
    // Deliberately null — the mid-round-restart state SquadJS never
    // repopulates. Layer facts must come from S³, never from here.
    currentLayer: null,
    plugins: [makeMockS3()],
    on(event, fn) {
      this.listeners[event] = fn;
    },
    removeListener(event, fn) {
      if (this.listeners[event] === fn) {
        delete this.listeners[event];
      }
    },
    async emit(event, data) {
      if (this.listeners[event]) {
        await this.listeners[event](data);
      }
    }
  });

  // Helper to create mock DB
  const createMockDb = () => ({
    initDB: async () => true,
    pruneStaleEntries: async () => ({ tier1: 0, tier2: 0 }),
    getPlayerStatsBatch: async (ids) => {
      const map = new Map();
      // Return default stats for any requested ID
      ids.forEach(id => map.set(id, { mu: 25.0, sigma: 8.333 }));
      return map;
    },
    bulkIncrementPlayerStats: async () => {},
    insertRoundHistory: async () => {},
    calls: { bulkIncrement: 0, insertHistory: 0 }
  });

  // Helper to create mock Session Manager
  const createMockSession = () => ({
    startRound: () => {},
    updatePlayers: () => {},
    endRound: () => [],
    roundStartTime: Date.now()
  });

  const mockOptions = {
    minParticipationRatio: 0.1,
    defaultMu: 25.0,
    defaultSigma: 8.333,
    minPlayersForElo: 5,
    discordClient: null
  };

  const mockConnectors = {};

  await runTest('Mount: Initialization', async () => {
    const server = createMockServer();
    const tracker = await mountTracker(EloTracker, server, mockOptions, mockConnectors, (t) => {
      t.db = createMockDb();
      t.session = createMockSession();
    });

    if (!tracker.ready) throw new Error('Plugin should be ready after mount');
    if (!server.listeners['NEW_GAME']) throw new Error('NEW_GAME listener missing');
    if (!server.listeners['UPDATED_PLAYER_INFORMATION']) throw new Error('UPDATED_PLAYER_INFORMATION listener missing');
    if (!server.listeners['ROUND_ENDED']) throw new Error('ROUND_ENDED listener missing');
  });

  await runTest('Event: UPDATED_PLAYER_INFORMATION (Cache Population)', async () => {
    const server = createMockServer();
    const tracker = await mountTracker(EloTracker, server, mockOptions, mockConnectors, (t) => {
      t.db = createMockDb();
      t.session = createMockSession();
    });

    // Setup player
    const player = { eosID: 'test_eos', name: 'TestPlayer', teamID: 1 };
    server.players = [player];

    // Emit event
    await server.emit('UPDATED_PLAYER_INFORMATION');

    // Verify cache
    if (!tracker.eloCache.has('test_eos')) {
      throw new Error('Player not added to eloCache');
    }
    const cached = tracker.eloCache.get('test_eos');
    if (cached.mu !== 25.0) throw new Error(`Expected mu 25.0, got ${cached.mu}`);
  });

  await runTest('Guard: Min Players Threshold', async () => {
    const server = createMockServer();
    const db = createMockDb();

    // Spy on DB methods
    let bulkCalled = false;
    db.bulkIncrementPlayerStats = async () => { bulkCalled = true; };

    await mountTracker(EloTracker, server, mockOptions, mockConnectors, (t) => {
      t.db = db;
      t.session = createMockSession();
    });

    // 2 players, threshold is 5
    server.players = [
      { eosID: 'p1', teamID: 1 },
      { eosID: 'p2', teamID: 2 }
    ];

    await server.emit('ROUND_ENDED', { winner: 1, tickets: 10 });

    if (bulkCalled) throw new Error('Should not save stats when below player threshold');
  });

  await runTest('Event: ROUND_ENDED (Save Stats)', async () => {
    const server = createMockServer();
    const db = createMockDb();

    // Spy on DB methods
    let bulkCalled = false;
    let historyCalled = false;
    db.bulkIncrementPlayerStats = async () => { bulkCalled = true; };
    db.insertRoundHistory = async () => { historyCalled = true; };

    // Custom session mock to return participants
    const session = createMockSession();
    session.endRound = () => [
      { eosID: 'p1', name: 'P1', assignedTeamID: 1, participationRatio: 1.0 },
      { eosID: 'p2', name: 'P2', assignedTeamID: 2, participationRatio: 1.0 }
    ];

    const tracker = await mountTracker(EloTracker, server, mockOptions, mockConnectors, (t) => {
      t.db = db;
      t.session = session;
    });

    // 6 players, threshold is 5
    server.players = Array(6).fill(0).map((_, i) => ({ eosID: `p${i}`, teamID: i % 2 + 1 }));
    
    // Populate cache for p1 and p2 so calculator works
    tracker.eloCache.set('p1', { mu: 25, sigma: 8.333 });
    tracker.eloCache.set('p2', { mu: 25, sigma: 8.333 });

    await server.emit('ROUND_ENDED', { winner: 1, tickets: 20 });

    if (!bulkCalled) throw new Error('Failed to call bulkIncrementPlayerStats');
    if (!historyCalled) throw new Error('Failed to call insertRoundHistory');
  });

  // The three cases below pin the mount-time refusals. Each is a failure the
  // plugin is supposed to make loudly at startup rather than quietly at the
  // first lookup, so a regression that turns one into a silent no-op is
  // precisely what needs catching.

  await runTest('Guard: refuses to mount against an S³ older than required', async () => {
    const server = createMockServer();
    server.plugins = [makeMockS3({ version: '1.2.3' })];

    let threw = null;
    try {
      await mountTracker(EloTracker, server, mockOptions, mockConnectors, (t) => {
        t.db = createMockDb();
        t.session = createMockSession();
      });
    } catch (err) {
      threw = err;
    }

    if (!threw) throw new Error('Mounted against S³ 1.2.3 — the version gate did not fire');
    if (!/Incompatible S³ version/.test(threw.message)) {
      throw new Error(`Wrong failure: ${threw.message}`);
    }
    // Nothing may be left bound after a refused mount.
    if (server.listeners['ROUND_ENDED']) {
      throw new Error('ROUND_ENDED stayed bound after the version gate refused the mount');
    }
  });

  await runTest('Guard: the live S³ version satisfies the requirement', async () => {
    // The converse of the case above, and the reason mock-s3.js reads the real
    // version instead of hardcoding one: if S³ ever ships a version that no
    // longer satisfies elo-tracker's floor, this fails in the monorepo rather
    // than at a server's next restart.
    const server = createMockServer();
    await mountTracker(EloTracker, server, mockOptions, mockConnectors, (t) => {
      t.db = createMockDb();
      t.session = createMockSession();
    });
  });

  await runTest('Guard: refuses to mount with no S³ present at all', async () => {
    const server = createMockServer();
    server.plugins = [];

    let threw = null;
    try {
      await mountTracker(EloTracker, server, mockOptions, mockConnectors, (t) => {
        t.db = createMockDb();
        t.session = createMockSession();
      });
    } catch (err) {
      threw = err;
    }

    if (!threw) throw new Error('Mounted with no SlackersSquadServices in server.plugins');
    if (!/SlackersSquadServices is required/.test(threw.message)) {
      throw new Error(`Wrong failure: ${threw.message}`);
    }
  });
}