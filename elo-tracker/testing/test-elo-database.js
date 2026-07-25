/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  TEST: ELO DATABASE                            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates the EloDatabase persistence layer against the current
 * S³ DBService API. Uses an in-memory SQLite instance with a shim
 * that mimics S³'s DBService interface (getModel, withTransaction,
 * withTransactionWithRetry, isReady, getDataTypes).
 *
 * Key test areas:
 *   - CRUD: upsert, search by eosID/steamID/partial name
 *   - Special characters: backslash, %, _ in player names (LIKE escaping)
 *   - Retry logic: SQLITE_BUSY recovery via withTransactionWithRetry
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/run-all-tests.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Uses an in-memory SQLite database; no file I/O required.
 * - Requires the `sequelize` npm package to be installed.
 * - The s3dbShim adapter allows EloDatabase to work without a live
 *   S³ plugin instance.
 *
 */

import Sequelize from 'sequelize';
import EloDatabase from '../utils/elo-database.js';

const { Op } = Sequelize;

/**
 * Build a lightweight S³ DBService shim around a raw Sequelize instance.
 * This lets EloDatabase methods (getModel, withTransaction, etc.) work
 * without a live S³ plugin.
 */
function createS3dbShim(sequelize) {
  return {
    getModel(name) {
      return sequelize.models[name] || null;
    },
    isReady() {
      return true;
    },
    getDataTypes() {
      return Sequelize.DataTypes;
    },
    async withTransaction(fn) {
      return await sequelize.transaction(fn);
    },
    async withTransactionWithRetry(fn, maxRetries = 3) {
      let lastError;
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          return await sequelize.transaction(fn);
        } catch (err) {
          lastError = err;
          const message = String(err?.message || '');
          if (
            message.includes('SQLITE_BUSY') ||
            message.includes('database is locked')
          ) {
            // Wait 100ms before retry
            await new Promise(r => setTimeout(r, 100));
            continue;
          }
          throw err; // Non-lock errors propagate immediately
        }
      }
      throw lastError;
    }
  };
}

/**
 * Define the 4 Elo models on a Sequelize instance, matching the
 * schema from elo-tracker.js _onS3Ready().
 */
function defineEloModels(sequelize) {
  sequelize.define('Elo_PluginState', {
    id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true, autoIncrement: false, defaultValue: 1 }
  }, { timestamps: false, tableName: 'Elo_PluginStates', freezeTableName: true });

  sequelize.define('Elo_PlayerStats', {
    eosID: { type: Sequelize.DataTypes.STRING, primaryKey: true, allowNull: false },
    steamID: { type: Sequelize.DataTypes.STRING, allowNull: true },
    discordID: { type: Sequelize.DataTypes.STRING, allowNull: true },
    name: { type: Sequelize.DataTypes.STRING, allowNull: true },
    mu: { type: Sequelize.DataTypes.FLOAT, defaultValue: 25.0 },
    sigma: { type: Sequelize.DataTypes.FLOAT, defaultValue: 8.333333333333334 },
    wins: { type: Sequelize.DataTypes.INTEGER, defaultValue: 0 },
    losses: { type: Sequelize.DataTypes.INTEGER, defaultValue: 0 },
    roundsPlayed: { type: Sequelize.DataTypes.INTEGER, defaultValue: 0 },
    lastSeen: { type: Sequelize.DataTypes.BIGINT, allowNull: true }
  }, { tableName: 'Elo_PlayerStats', timestamps: false, freezeTableName: true });

  sequelize.define('Elo_RoundHistory', {
    id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    matchId: { type: Sequelize.DataTypes.STRING(20), allowNull: true },
    layerName: { type: Sequelize.DataTypes.STRING, allowNull: true },
    winningTeamID: { type: Sequelize.DataTypes.INTEGER, allowNull: true },
    ticketDiff: { type: Sequelize.DataTypes.INTEGER, allowNull: true },
    roundDuration: { type: Sequelize.DataTypes.INTEGER, allowNull: true },
    endedAt: { type: Sequelize.DataTypes.BIGINT, allowNull: true },
    playerCount: { type: Sequelize.DataTypes.INTEGER, allowNull: true }
  }, { timestamps: false, tableName: 'Elo_RoundHistories', freezeTableName: true });

  sequelize.define('Elo_RoundPlayers', {
    id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    matchId: { type: Sequelize.DataTypes.STRING(20), allowNull: true },
    roundStartTime: { type: Sequelize.DataTypes.BIGINT, allowNull: true },
    roundHistoryId: { type: Sequelize.DataTypes.INTEGER, allowNull: false },
    eosID: { type: Sequelize.DataTypes.STRING, allowNull: false },
    steamID: { type: Sequelize.DataTypes.STRING, allowNull: true },
    name: { type: Sequelize.DataTypes.STRING, allowNull: true },
    teamID: { type: Sequelize.DataTypes.INTEGER, allowNull: false },
    participationRatio: { type: Sequelize.DataTypes.FLOAT, allowNull: false },
    muBefore: { type: Sequelize.DataTypes.FLOAT, allowNull: false },
    sigmaBefore: { type: Sequelize.DataTypes.FLOAT, allowNull: false },
    rawDeltaMu: { type: Sequelize.DataTypes.FLOAT, allowNull: false },
    rawDeltaSigma: { type: Sequelize.DataTypes.FLOAT, allowNull: false },
    scaledDeltaMu: { type: Sequelize.DataTypes.FLOAT, allowNull: false },
    scaledDeltaSigma: { type: Sequelize.DataTypes.FLOAT, allowNull: false },
    muAfter: { type: Sequelize.DataTypes.FLOAT, allowNull: false },
    sigmaAfter: { type: Sequelize.DataTypes.FLOAT, allowNull: false }
  }, { timestamps: false, tableName: 'Elo_RoundPlayers', freezeTableName: true });
}

export default async function runDatabaseTests(runTest) {
  // Setup: In-memory SQLite instance
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false
  });

  // Define models and sync
  defineEloModels(sequelize);
  await sequelize.sync();

  // Create the S³ shim and wire it into EloDatabase
  const s3dbShim = createS3dbShim(sequelize);
  const server = {};
  const options = {};
  const db = new EloDatabase(server, options, null);
  db._s3db = s3dbShim;
  db.verbose = () => {}; // silence logs

  // ────────────────────────────────────────────────────────────────
  // Test 1: Initialization
  // ────────────────────────────────────────────────────────────────
  await runTest('Initialization: Create Tables', async () => {
    await db.initDB();

    // Verify models are accessible via the shim
    const ps = s3dbShim.getModel('Elo_PlayerStats');
    if (!ps) throw new Error('Elo_PlayerStats model missing');

    const rh = s3dbShim.getModel('Elo_RoundHistory');
    if (!rh) throw new Error('Elo_RoundHistory model missing');

    const pst = s3dbShim.getModel('Elo_PluginState');
    if (!pst) throw new Error('Elo_PluginState model missing');

    // Verify PluginState row exists (id=1)
    const state = await pst.findOne({ where: { id: 1 } });
    if (!state) throw new Error('PluginState not initialized');
    if (state.id !== 1) throw new Error('PluginState should have id=1');
  });

  // ────────────────────────────────────────────────────────────────
  // Test 2: CRUD — Save and Search
  // ────────────────────────────────────────────────────────────────
  await runTest('CRUD: Save and Search', async () => {
    const player = {
      eosID: 'eos_123',
      steamID: 'steam_456',
      name: 'Test Player',
      mu: 28.0,
      sigma: 7.5
    };

    // 1. Upsert Player
    await db.upsertPlayerStats(player.eosID, player);

    // 2. Search by EOSID (Exact match)
    const byEos = await db.searchPlayer('eos_123');
    if (!byEos || byEos.name !== player.name) throw new Error('Failed to find by EOSID');

    // 3. Search by SteamID (Exact match via OR condition)
    const bySteam = await db.searchPlayer('steam_456');
    if (!bySteam || bySteam.eosID !== player.eosID) throw new Error('Failed to find by SteamID');

    // 4. Search by Name (Partial match)
    const byName = await db.searchPlayer('Test Play');
    if (!byName || byName.eosID !== player.eosID) throw new Error('Failed to find by partial name');
  });

  // ────────────────────────────────────────────────────────────────
  // Test 3: Special Characters in Player Names (LIKE escaping)
  // ────────────────────────────────────────────────────────────────
  await runTest('Search: Special Characters in Player Names', async () => {
    // Insert players with special characters
    const players = [
      { eosID: 'eos_raccoon', steamID: 'steam_raccoon', name: '/-gMg-\\ Raccoon', mu: 36.6, sigma: 6.3 },
      { eosID: 'eos_backslash', steamID: 'steam_bs', name: 'test\\player', mu: 25.0, sigma: 8.3 },
      { eosID: 'eos_pct', steamID: 'steam_pct', name: 'test\\%player', mu: 25.0, sigma: 8.3 },
      { eosID: 'eos_underscore', steamID: 'steam_us', name: 'normal_player', mu: 25.0, sigma: 8.3 }
    ];

    for (const p of players) {
      await db.upsertPlayerStats(p.eosID, p);
    }

    // 1. Full name with backslash (the exact Raccoon scenario)
    const fullRaccoon = await db.searchPlayer('/-gMg-\\ Raccoon');
    if (!fullRaccoon) throw new Error('Failed to find Raccoon by full name with backslash');
    if (fullRaccoon.eosID !== 'eos_raccoon') throw new Error('Found wrong player for Raccoon full name');

    // 2. Partial name (no backslash) — should still match
    const partialRaccoon = await db.searchPlayer('Raccoon');
    if (!partialRaccoon) throw new Error('Failed to find Raccoon by partial name');
    if (partialRaccoon.eosID !== 'eos_raccoon') throw new Error('Found wrong player for Raccoon partial');

    // 3. Backslash in middle of name
    const bsPlayer = await db.searchPlayer('test\\player');
    if (!bsPlayer) throw new Error('Failed to find player with backslash in name');
    if (bsPlayer.eosID !== 'eos_backslash') throw new Error('Found wrong player for backslash search');

    // 4. Literal % in name (should not be treated as LIKE wildcard)
    const pctPlayer = await db.searchPlayer('test\\%player');
    if (!pctPlayer) throw new Error('Failed to find player with literal % in name');
    if (pctPlayer.eosID !== 'eos_pct') throw new Error('Found wrong player for percent search');

    // 5. Underscore in name (should not be treated as single-char wildcard)
    const usPlayer = await db.searchPlayer('normal_');
    if (!usPlayer) throw new Error('Failed to find player with underscore in name');
    if (usPlayer.eosID !== 'eos_underscore') throw new Error('Found wrong player for underscore search');

    // 6. Ghost player — should return null
    const ghost = await db.searchPlayer('GhostPlayer');
    if (ghost !== null) throw new Error('Expected null for non-existent player');
  });

  // ────────────────────────────────────────────────────────────────
  // Test 4: Retry Logic — SQLITE_BUSY
  // ────────────────────────────────────────────────────────────────
  await runTest('Retry Logic: SQLITE_BUSY', async () => {
    let attempts = 0;

    // A function that fails once with SQLITE_BUSY, then succeeds
    const flakyFn = async (t) => {
      attempts++;
      if (attempts === 1) {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return 'success';
    };

    const result = await s3dbShim.withTransactionWithRetry(flakyFn);
    if (result !== 'success') throw new Error('Retry logic failed to return result');
    if (attempts !== 2) throw new Error(`Expected 2 attempts (1 fail + 1 retry), got ${attempts}`);
  });
}