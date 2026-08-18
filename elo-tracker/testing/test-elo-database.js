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
import DBService from '../../s3/utils/db-service.js';

const { Op } = Sequelize;

/**
 * Build a lightweight S³ DBService shim around a raw Sequelize instance.
 * This lets EloDatabase methods (getModel, withTransaction, etc.) work
 * without a live S³ plugin.
 *
 * ⚠️ The SQL-building helpers are **delegated to the real DBService**, never
 * re-implemented here. Identifier quoting, collation and `LIKE ... ESCAPE`
 * parsing are properties of the engine, not of the code, so a hand-written
 * stand-in would happily report green on SQL the database rejects. Those
 * methods depend only on `this.sequelize`, so an object with DBService's
 * prototype and that one field runs the production code path verbatim.
 *
 * (This shim previously omitted caseInsensitiveLikeLiteral entirely, so every
 * name search threw a TypeError that searchPlayer swallowed into a null — the
 * two search tests below were failing before this was added.)
 */
function createS3dbShim(sequelize) {
  const real = Object.create(DBService.prototype);
  real.sequelize = sequelize;

  return {
    getModel(name) {
      return sequelize.models[name] || null;
    },
    getDialect: () => real.getDialect(),
    quoteIdentifier: (identifier) => real.quoteIdentifier(identifier),
    escapeValue: (value) => real.escapeValue(value),
    caseInsensitiveLikeOp: () => real.caseInsensitiveLikeOp(),
    caseInsensitiveLikeLiteral: (column, term, opts) =>
      real.caseInsensitiveLikeLiteral(column, term, opts),
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

  // ────────────────────────────────────────────────────────────────
  // Test 5: Ranked search — the "!elo cerv" ambiguity
  //
  // Regression cover for the reported bug: `!elo cerv` returned "Cerveira"
  // (2 rounds) instead of "[NL] Cerv" (267 rounds). searchPlayer() used to
  // be an unordered findOne, so the winner was decided by row order.
  //
  // Rows are inserted with the low-round decoy FIRST, so a regression to
  // unordered findOne fails this test on SQLite rather than passing by luck.
  // ────────────────────────────────────────────────────────────────
  await runTest('Search: Ranked disambiguation and case-insensitivity', async () => {
    const roster = [
      { eosID: 'eos_cerveira', steamID: 'steam_cerveira', name: 'Cerveira', roundsPlayed: 2, wins: 1, losses: 1 },
      { eosID: 'eos_cerv', steamID: '76561198962436118', name: '[NL] Cerv', roundsPlayed: 267, wins: 134, losses: 133 },
      { eosID: 'eos_cervmain', steamID: 'steam_cervmain', name: 'CervTheThird', roundsPlayed: 40, wins: 20, losses: 20 }
    ];
    for (const p of roster) await db.upsertPlayerStats(p.eosID, p);

    // 1. The reported case — most-played prefix match wins over the decoy.
    const cerv = await db.searchPlayer('cerv');
    if (!cerv) throw new Error('Ranked search found nothing for "cerv"');
    if (cerv.eosID !== 'eos_cerv') throw new Error(`Expected [NL] Cerv, got ${cerv.name}`);

    // 2. Clan tags are transparent: "cerv" hits tier 2 on the tag-stripped name.
    if (cerv._matchTier !== 2) throw new Error(`Expected tier 2 (exact minus tag), got ${cerv._matchTier}`);

    // 3. Case-insensitive on every dialect, including the exact-name query.
    const upper = await db.searchPlayer('CERVEIRA');
    if (!upper || upper.eosID !== 'eos_cerveira') throw new Error('Exact name match is case-sensitive');
    if (upper._matchTier !== 1) throw new Error(`Expected tier 1 for exact name, got ${upper._matchTier}`);

    // 4. An exact ID always wins outright, however few rounds it has.
    const byId = await db.searchPlayer('76561198962436118');
    if (!byId || byId.eosID !== 'eos_cerv') throw new Error('SteamID lookup failed');
    if (byId._matchTier !== 0) throw new Error(`Expected tier 0 for ID, got ${byId._matchTier}`);

    // 5. Runners-up are reported, so the asker can tell it was a fuzzy hit.
    const candidates = await db.searchPlayers('cerv');
    if (candidates.length !== 3) throw new Error(`Expected 3 candidates, got ${candidates.length}`);
    const hint = EloDatabase.formatOtherMatches(candidates);
    if (!hint || !hint.includes('Cerveira')) throw new Error('Expected an "Also matched" hint naming Cerveira');

    // 6. …but never on an exact match, where there is nothing to second-guess.
    if (EloDatabase.formatOtherMatches(await db.searchPlayers('CERVEIRA')) !== null) {
      throw new Error('Exact match should not emit an "Also matched" hint');
    }

    // 7. Online players win ties *within* a tier. Cerveira (2 rounds) and
    //    CervTheThird (40 rounds) are both tier 3 prefix matches, so rounds
    //    normally put CervTheThird ahead; marking Cerveira online flips them.
    const offline = await db.searchPlayers('cerv');
    if (offline.findIndex(p => p.eosID === 'eos_cerveira') <
        offline.findIndex(p => p.eosID === 'eos_cervmain')) {
      throw new Error('Baseline wrong: expected the higher-round tier-3 match first');
    }
    const online = await db.searchPlayers('cerv', { onlineIDs: new Set(['eos_cerveira']) });
    if (online.findIndex(p => p.eosID === 'eos_cerveira') >
        online.findIndex(p => p.eosID === 'eos_cervmain')) {
      throw new Error('Online tiebreak not applied within tier');
    }

    // 8. Online must NOT override tier: [NL] Cerv is a tier-2 match and still
    //    outranks an online tier-3 match.
    if (online[0].eosID !== 'eos_cerv') throw new Error('Online bump wrongly crossed tier boundary');

    // 9. The destructive-command gate. "cerv" uniquely strips to [NL] Cerv, so
    //    a reset may proceed; "cerve" is only a prefix guess, so it may not.
    if (!EloDatabase.isUnambiguous(candidates)) throw new Error('Unique tag-stripped match should be resettable');
    if (EloDatabase.isUnambiguous(await db.searchPlayers('cerve'))) throw new Error('Prefix guess must not be resettable');

    // 10. …and a tag-stripped COLLISION must block it, even though one side
    //     ranks higher. This is the case that makes tier alone insufficient:
    //     without the uniqueness rule, "cerv" would silently reset whichever
    //     clan's Cerv had more rounds.
    await db.upsertPlayerStats('eos_uscerv', { steamID: 'steam_uscerv', name: '[US] Cerv', roundsPlayed: 99, wins: 50, losses: 49 });
    const collision = await db.searchPlayers('cerv');
    if (collision.filter(p => p._matchTier === 2).length !== 2) throw new Error('Expected two tier-2 candidates');
    if (EloDatabase.isUnambiguous(collision)) throw new Error('Tag-stripped collision must not be resettable');
    // An exact ID stays resettable regardless of the collision.
    if (!EloDatabase.isUnambiguous(await db.searchPlayers('76561198962436118'))) {
      throw new Error('Exact ID must always be resettable');
    }
    await s3dbShim.getModel('Elo_PlayerStats').destroy({ where: { eosID: 'eos_uscerv' } });
  });

  // ────────────────────────────────────────────────────────────────
  // Test 5b: Whitespace-padded stored names.
  //
  // Squad stores most names with a leading space — 10,604 of 11,787 rows in
  // the production export used to validate this. The exact-name query must
  // compare against TRIM(name) or it matches nothing in production, and every
  // real exact match falls through to the LIMITed fuzzy pass where a common
  // substring can truncate it away.
  //
  // The padded player is given a LOW round count and buried under many
  // higher-round substring matches, so the fuzzy pass alone cannot save it —
  // only the trimmed exact query can.
  // ────────────────────────────────────────────────────────────────
  await runTest('Search: whitespace-padded stored names still match exactly', async () => {
    await db.upsertPlayerStats('eos_padded', { steamID: 'steam_padded', name: ' Ice', roundsPlayed: 3, wins: 1, losses: 2 });
    for (let i = 0; i < 40; i++) {
      await db.upsertPlayerStats(`eos_icefill${i}`, {
        steamID: `steam_icefill${i}`, name: `Icemodai${i}`, roundsPlayed: 100 + i, wins: 50, losses: 50
      });
    }

    const hit = await db.searchPlayer('Ice');
    if (!hit) throw new Error('Padded name not found at all');
    if (hit.eosID !== 'eos_padded') {
      throw new Error(`Expected the padded " Ice" (3 rds), got ${JSON.stringify(hit.name)} (${hit.roundsPlayed} rds)`);
    }
    if (hit._matchTier !== 1) throw new Error(`Expected tier 1 for a padded exact name, got ${hit._matchTier}`);

    // Trailing padding too, and case-insensitively.
    await db.upsertPlayerStats('eos_pad2', { steamID: 'steam_pad2', name: 'Reaper  ', roundsPlayed: 1 });
    const trailing = await db.searchPlayer('reaper');
    if (!trailing || trailing.eosID !== 'eos_pad2') throw new Error('Trailing-padded name not matched');
    if (trailing._matchTier !== 1) throw new Error(`Expected tier 1, got ${trailing._matchTier}`);

    // Cleanup so later assertions are not affected by the filler rows.
    const model = s3dbShim.getModel('Elo_PlayerStats');
    await model.destroy({ where: { eosID: ['eos_padded', 'eos_pad2'] } });
    for (let i = 0; i < 40; i++) await model.destroy({ where: { eosID: `eos_icefill${i}` } });
  });

  // ────────────────────────────────────────────────────────────────
  // Test 6: stripClanTags — pure function, no DB needed.
  // Guards the deliberate narrowness vs ClansService.extractRawPrefix():
  // unbracketed first words must survive, or ordinary two-word names would
  // exact-match a search for their surname.
  // ────────────────────────────────────────────────────────────────
  await runTest('Search: stripClanTags is conservative', async () => {
    const cases = [
      ['[NL] Cerv', 'Cerv'],
      ['(NL) Cerv', 'Cerv'],
      ['=NL= Cerv', 'Cerv'],
      ['Cerv [NL]', 'Cerv'],
      ['John Smith', 'John Smith'],   // no bracket — must not lose "John"
      ['[NL]', '[NL]'],               // tag only — never collapses to empty
      ['Cerv', 'Cerv']
    ];
    for (const [input, expected] of cases) {
      const actual = EloDatabase.stripClanTags(input);
      if (actual !== expected) {
        throw new Error(`stripClanTags(${JSON.stringify(input)}) → ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
      }
    }
  });
}