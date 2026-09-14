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

import { DataTypes } from 'sequelize';

import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';
import { makeMockS3, makeS3Db } from '../../s3/testing/mock-s3.js';
import { summariseCommunityOptions } from '../../s3/utils/community-options.js';
import Logger from '../../core/logger.js';

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

  // ─── The leaderboard threshold is also a deletion predicate ───
  //
  // minRoundsForLeaderboard reads like a display cutoff, and it is also the
  // discriminator in both tiers of the stale-entry delete. Against one shared
  // rating table two servers configured differently prune each other’s players,
  // and which retention clock a row gets depends on which server booted last.
  // The prune declines while they disagree — by logging, not by refusing the
  // mount, because this runs inside mount() and a leaderboard threshold is not
  // worth taking a live game’s Elo tracking down over.

  /**
   * An S³ DB stand-in that answers only what mount() asks of it: the schema
   * literals need getDataTypes(), and isReady() false is the shipped
   * no-database path, so the registry summary is the only thing under test.
   */
  const s3dbWithRegistry = (rows) => ({
    isReady: () => false,
    getDataTypes: () => DataTypes,
    communityOptions: summariseCommunityOptions(
      rows.map(([serverID, alias, values]) => ({
        serverID, alias, communityOptions: JSON.stringify(values)
      }))
    )
  });

  const mountAgainstRegistry = async (rows, minRoundsForLeaderboard) => {
    const server = createMockServer();
    server.plugins = [makeMockS3({ db: s3dbWithRegistry(rows) })];

    let prunes = 0;
    const db = createMockDb();
    db.pruneStaleEntries = async () => { prunes++; return { tier1: 0, tier2: 0 }; };

    const tracker = await mountTracker(
      EloTracker, server, { ...mockOptions, minRoundsForLeaderboard }, mockConnectors,
      (t) => { t.db = db; t.session = createMockSession(); }
    );
    return { tracker, prunes: () => prunes };
  };

  await runTest('Mount: the stale-entry prune declines while minRoundsForLeaderboard diverges', async () => {
    const { tracker, prunes } = await mountAgainstRegistry(
      [[1, 'main', { minRoundsForLeaderboard: 10 }], [2, 'event', { minRoundsForLeaderboard: 25 }]],
      10
    );

    if (prunes() !== 0) {
      throw new Error('rating rows were deleted while two servers disagreed about which retention tier they fall into');
    }
    if (!tracker.ready) {
      throw new Error('the plugin refused to mount — a leaderboard threshold disagreement must not take Elo tracking down');
    }
  });

  await runTest('Mount: the stale-entry prune runs once the servers agree', async () => {
    const { prunes } = await mountAgainstRegistry(
      [[1, 'main', { minRoundsForLeaderboard: 10 }], [2, 'event', { minRoundsForLeaderboard: 10 }]],
      10
    );

    if (prunes() !== 1) {
      throw new Error(`the prune did not run under agreement (${prunes()} calls) — the gate is refusing on something other than the disagreement`);
    }
  });

  // ─── Migrations pending but unconfirmed is not "ready" ───
  //
  // On a genuinely empty first boot with autoMigrate off, verifyAndRunMigrations()
  // returns null while S³ waits on an operator to confirm the token. EloTracker
  // used to read that as "go" and prune anyway, against tables that do not exist
  // yet — an `[DB] Error pruning stale entries: ... Elo_PlayerStats ...` logged at
  // ERROR level at exactly the moment the operator is being asked to confirm. It
  // now asks verifySchemaVersions() and declines to mount until its own namespace
  // is applied, the way db-log does.

  await runTest('Mount: declines to mount while its own migrations are unconfirmed', async () => {
    const db = await makeS3Db({ confirmMigrations: false });
    const seen = [];
    const origVerbose = Logger.verbose;
    Logger.verbose = (...args) => { seen.push(args); };

    try {
      const server = createMockServer();
      server.plugins = [makeMockS3({ db })];

      // No mock db/session injected on purpose: the real EloDatabase is what
      // would hit "no such table" on the prune, so this is the real path.
      const tracker = await mountTracker(EloTracker, server, mockOptions, mockConnectors);

      const messages = seen
        .filter(([tag]) => tag === 'EloTracker')
        .map(([, , msg]) => String(msg));

      if (tracker.ready) {
        throw new Error('mounted as ready while elo-tracker migrations were still unconfirmed');
      }
      if (server.listeners['ROUND_ENDED']) {
        throw new Error('ROUND_ENDED stayed bound — a plugin that is not ready must leave nothing listening');
      }
      if (messages.some((m) => /Error pruning stale entries/.test(m))) {
        throw new Error('pruned against tables that do not exist yet — the exact ERROR line this guard removes');
      }
      if (!messages.some((m) => /Migrations for "elo-tracker" are not applied yet/.test(m))) {
        throw new Error('did not say why it declined to mount — the operator needs the reason and the recovery step');
      }
    } finally {
      Logger.verbose = origVerbose;
      try { await db.unmount(); } catch { /* best effort */ }
    }
  });

  await runTest('Mount: mounts normally once those migrations are confirmed', async () => {
    const db = await makeS3Db({ confirmMigrations: true });
    try {
      const server = createMockServer();
      server.plugins = [makeMockS3({ db })];

      const tracker = await mountTracker(EloTracker, server, mockOptions, mockConnectors, (t) => {
        t.session = createMockSession();
      });

      if (!tracker.ready) throw new Error('did not mount against a confirmed schema — the guard is refusing on something else');
      if (!server.listeners['ROUND_ENDED']) throw new Error('ROUND_ENDED not bound after a clean mount');
    } finally {
      try { await db.unmount(); } catch { /* best effort */ }
    }
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