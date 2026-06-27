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
 *
 */

import EloTracker from '../plugins/elo-tracker.js';

export default async function runTrackerTests(runTest) {
  // Helper to create a fresh mock server for each test
  const createMockServer = () => ({
    players: [],
    listeners: {},
    matchStartTime: new Date(),
    currentLayer: { gamemode: 'AAS', name: 'Test_Layer' },
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
    ignoredGameModes: ['Seed'],
    discordClient: null
  };

  const mockConnectors = {};

  await runTest('Mount: Initialization', async () => {
    const server = createMockServer();
    const tracker = new EloTracker(server, mockOptions, mockConnectors);
    
    // Inject mocks
    tracker.db = createMockDb();
    tracker.session = createMockSession();

    await tracker.mount();

    if (!tracker.ready) throw new Error('Plugin should be ready after mount');
    if (!server.listeners['NEW_GAME']) throw new Error('NEW_GAME listener missing');
    if (!server.listeners['UPDATED_PLAYER_INFORMATION']) throw new Error('UPDATED_PLAYER_INFORMATION listener missing');
    if (!server.listeners['ROUND_ENDED']) throw new Error('ROUND_ENDED listener missing');
  });

  await runTest('Event: UPDATED_PLAYER_INFORMATION (Cache Population)', async () => {
    const server = createMockServer();
    const tracker = new EloTracker(server, mockOptions, mockConnectors);
    tracker.db = createMockDb();
    tracker.session = createMockSession();
    await tracker.mount();

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
    const tracker = new EloTracker(server, mockOptions, mockConnectors);
    const db = createMockDb();
    
    // Spy on DB methods
    let bulkCalled = false;
    db.bulkIncrementPlayerStats = async () => { bulkCalled = true; };
    
    tracker.db = db;
    tracker.session = createMockSession();
    await tracker.mount();

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
    const tracker = new EloTracker(server, mockOptions, mockConnectors);
    const db = createMockDb();
    
    // Spy on DB methods
    let bulkCalled = false;
    let historyCalled = false;
    db.bulkIncrementPlayerStats = async () => { bulkCalled = true; };
    db.insertRoundHistory = async () => { historyCalled = true; };

    tracker.db = db;
    
    // Custom session mock to return participants
    const session = createMockSession();
    session.endRound = () => [
      { eosID: 'p1', name: 'P1', assignedTeamID: 1, participationRatio: 1.0 },
      { eosID: 'p2', name: 'P2', assignedTeamID: 2, participationRatio: 1.0 }
    ];
    tracker.session = session;
    
    await tracker.mount();

    // 6 players, threshold is 5
    server.players = Array(6).fill(0).map((_, i) => ({ eosID: `p${i}`, teamID: i % 2 + 1 }));
    
    // Populate cache for p1 and p2 so calculator works
    tracker.eloCache.set('p1', { mu: 25, sigma: 8.333 });
    tracker.eloCache.set('p2', { mu: 25, sigma: 8.333 });

    await server.emit('ROUND_ENDED', { winner: 1, tickets: 20 });

    if (!bulkCalled) throw new Error('Failed to call bulkIncrementPlayerStats');
    if (!historyCalled) throw new Error('Failed to call insertRoundHistory');
  });
}