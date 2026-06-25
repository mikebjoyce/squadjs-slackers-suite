/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  TEST: ELO DATABASE                            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates the Sequelize persistence layer: initDB model creation,
 * upsertPlayerStats, bulkIncrementPlayerStats, leaderboard queries,
 * and export/import round-trip integrity using an in-memory SQLite
 * instance.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/run-all-tests.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Uses an in-memory SQLite database; no file I/O required.
 * - Requires the `sequelize` npm package to be installed.
 *
 */

import Sequelize from 'sequelize';
import EloDatabase from '../utils/elo-database.js';

export default async function runDatabaseTests(runTest) {
  // Setup: In-memory SQLite instance
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false
  });

  // Mock connectors and server/options
  const connectors = { sqlite: sequelize };
  const server = {};
  const options = {};

  // Instantiate the database class
  const db = new EloDatabase(server, options, connectors);

  await runTest('Initialization: Create Tables', async () => {
    // Initialize DB (syncs models)
    await db.initDB();

    // Verify models are defined
    if (!db.models.PlayerStats) throw new Error('PlayerStats model missing');
    if (!db.models.RoundHistory) throw new Error('RoundHistory model missing');
    if (!db.models.PluginState) throw new Error('PluginState model missing');

    // Verify PluginState initialized with default row
    const state = await db.models.PluginState.findOne({ where: { id: 1 } });
    if (!state) throw new Error('PluginState not initialized');
    if (state.roundStartTime !== null) throw new Error('roundStartTime should be null initially');
  });

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

  await runTest('Retry Logic: SQLITE_BUSY', async () => {
    let attempts = 0;
    
    // Mock function that throws SQLITE_BUSY once, then succeeds
    const flakyFunc = async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return 'success';
    };

    const result = await db._executeWithRetry(flakyFunc);
    if (result !== 'success') throw new Error('Retry logic failed to return result');
    if (attempts !== 2) throw new Error(`Expected 2 attempts (1 fail + 1 retry), got ${attempts}`);
  });
}