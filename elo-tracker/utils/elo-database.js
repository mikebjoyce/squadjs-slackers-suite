/**
  * ╔═══════════════════════════════════════════════════════════════╗
  * ║                         ELO DATABASE                          ║
  * ╚═══════════════════════════════════════════════════════════════╝
  *
  * ─── PURPOSE ─────────────────────────────────────────────────────
  *
  * S³-delegated persistence layer for the EloTracker plugin.
  * All DB access is routed through S³'s DBService (this._s3db) using
  * defineModel/getModel for model access and withTransactionWithRetry
  * for transaction safety. The standalone Sequelize connector and
  * raw sync() calls have been removed per Stage 8.2 Strategy A.
  *
  * ─── EXPORTS ─────────────────────────────────────────────────────
  *
  * EloDatabase (default)
  *   Class. Key public methods:
  *     initDB()                         — Verify models exist; log row counts.
  *     getModel(name)                   — Accessor for Sequelize model via S³.
  *     getPlayerStats(eosID)            — Single player lookup by eosID.
  *     getPlayerStatsBatch(eosIDs)      — Bulk lookup; returns a Map.
  *     searchPlayer(identifier)         — Fuzzy search by eosID/steamID/name.
  *     upsertPlayerStats(eosID, fields) — Single-record upsert.
  *     bulkIncrementPlayerStats(updates) — Batch increment in one transaction.
  *     insertRoundHistory(data)         — Append a round record.
  *     getLeaderboard(limit, minRounds, offset) — Top players by CSR.
  *     getPlayerRank(consRating, minRounds) — Rank of a given CSR value.
  *     getTotalRankedPlayers(minRounds) — Count of players meeting min rounds.
  *     exportPlayerStats()              — Full table dump as plain objects.
  *     importPlayerStats(records)       — Bulk restore from export.
  *     pruneStaleEntries(minRounds)     — Delete old low-activity records.
  *     insertRoundPlayers(roundHistoryId, endedAt, playerRows) — Append detail rows.
  *
  *   Leaderboard and rank calculation methods internally apply a
  *   "Competitive Skill Rank" (CSR) formula (μ - 3.0σ) instead of raw Mu.
  *
  * ─── DEPENDENCIES ────────────────────────────────────────────────
  *
  * EloCalculator (./elo-calculator.js)
  *   Default mu/sigma constants and SIGMA_MULTIPLIER for CSR.
  *
  * ─── S³ ACCESS ──────────────────────────────────────────────────
  *
  * Consumer receives the S³ DBService instance at construction
  * (not a separate Sequelize connector). All model references go
  * through this._s3db.getModel('Elo_XXX') and transactions through
  * this._s3db.withTransactionWithRetry(fn). Models are defined by
  * elo-tracker.js mount() via s3db.defineModel() before initDB()
  * is called.
  *
  * ─── NOTES ───────────────────────────────────────────────────────
  *
  * - bulkIncrementPlayerStats() INCREMENTS wins, losses, and roundsPlayed.
  *   All other fields are overwritten. Do not pass cumulative totals.
  * - importPlayerStats() chunks at 500 records per transaction to
  *   prevent SQLite write contention.
  * - pruneStaleEntries() removes provisional players unseen for 30 days
  *   and calibrated players unseen for 90 days.
  *
  * ═══════════════════════════════════════════════════════════════
  */

import Sequelize from 'sequelize';
import EloCalculator from './elo-calculator.js';

const { Op } = Sequelize;

function isLockError(err) {
  const message = String(err?.message || '');
  return (
    message.includes('SQLITE_BUSY') ||
    message.includes('database is locked') ||
    message.includes('Lock wait timeout exceeded') ||
    err?.name === 'SequelizeTimeoutError'
  );
}

export default class EloDatabase {
  /**
   * @param {Object} server   - SquadJS server instance (unused but kept for API compat).
   * @param {Object} options  - EloTracker options.
   * @param {Object} s3db     - S³ DBService instance (from this._s3.db).
   */
  constructor(server, options, s3db) {
    this.server = server;
    this.options = options;
    this._s3db = s3db;
    // Expose verbose so that external code can inject a logger if needed.
    this.verbose = (level, message) => {
      /* intended to be overridden by the owning plugin */
    };
  }

  /** --- Model accessor for external consumers (e.g. elo-discord.js) --- */
  getModel(name) {
    if (!this._s3db) return null;
    return this._s3db.getModel(name) || null;
  }

  /** --- Check whether the DB service is ready --- */
  isReady() {
    return !!(this._s3db && this._s3db.isReady && this._s3db.isReady());
  }

  /* ================================================================
   *  INIT — verify tables exist, log row counts
   *  ================================================================ */

  async initDB() {
    if (!this.isReady()) {
      this.verbose(1, '[DB] S³ DBService not ready — skipped initDB.');
      return false;
    }

    try {
      // Verify all 4 models are accessible; log row counts as sanity check
      const modelNames = ['Elo_PluginState', 'Elo_PlayerStats', 'Elo_RoundHistory', 'Elo_RoundPlayers'];
      for (const name of modelNames) {
        const model = this._s3db.getModel(name);
        if (!model) {
          this.verbose(1, `[DB] WARNING: Model ${name} not found on S³ connector. Migrations may not have run.`);
        }
      }

      const playerStatsCount = this._s3db.getModel('Elo_PlayerStats')
        ? await this._s3db.withTransaction(async (t) => {
            return await this._s3db.getModel('Elo_PlayerStats').count({ transaction: t });
          }).catch(() => 0)
        : 0;
      this.verbose(1, `[DB] PlayerStats table initialized: ${playerStatsCount} rows found on startup.`);

      // Ensure PluginState row exists (id=1) for backwards-compatible checks
      const psModel = this._s3db.getModel('Elo_PluginState');
      if (psModel) {
        await this._s3db.withTransaction(async (t) => {
          await psModel.findOrCreate({
            where: { id: 1 },
            defaults: { id: 1 },
            transaction: t
          });
        });
      }

      this.verbose(1, '[DB] Database initialized.');
      return true;
    } catch (error) {
      this.verbose(1, `[DB] Error initializing database: ${error.message}`);
      return false;
    }
  }

  /* ================================================================
   *  HELPERS — internal retry wrapper (delegates to S³)
   *  ================================================================ */

  async _withDb(fn) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(fn);
    } catch (err) {
      if (!isLockError(err)) {
        this.verbose(1, `[DB] Error in _withDb: ${err.message}`);
      }
      return null;
    }
  }

  /* ================================================================
   *  PLAYER STATS — single / batch / search / upsert / increment
   *  ================================================================ */

  async getPlayerStats(eosID) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const record = await this._s3db.getModel('Elo_PlayerStats').findOne({
          where: { eosID },
          transaction: t
        });
        return record ? record.toJSON() : null;
      });
    } catch (error) {
      this.verbose(1, `[DB] Error fetching stats for ${eosID}: ${error.message}`);
      return null;
    }
  }

  async getPlayerStatsBatch(eosIDs) {
    if (!this.isReady()) return new Map();
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const records = await this._s3db.getModel('Elo_PlayerStats').findAll({
          where: { eosID: { [Op.in]: eosIDs } },
          transaction: t
        });
        const map = new Map();
        for (const record of records) {
          map.set(record.eosID, record.toJSON());
        }
        return map;
      });
    } catch (error) {
      this.verbose(1, `[DB] Error fetching batch stats: ${error.message}`);
      return new Map();
    }
  }

  async searchPlayer(identifier) {
    if (!this.isReady() || !identifier) return null;
    const id = identifier.trim();
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        // Op imported from Sequelize

        const exact = await this._s3db.getModel('Elo_PlayerStats').findOne({
          where: { eosID: id },
          transaction: t
        });
        if (exact) return exact.toJSON();

        const escaped = id.replace(/%/g, '\\%').replace(/_/g, '\\_');
        const fuzzy = await this._s3db.getModel('Elo_PlayerStats').findOne({
          where: {
            [Op.or]: [
              { steamID: id },
              { name: { [Op.like]: `%${escaped}%` } }
            ]
          },
          transaction: t
        });
        return fuzzy ? fuzzy.toJSON() : null;
      });
    } catch (error) {
      this.verbose(1, `[DB] Error searching for player ${id}: ${error.message}`);
      return null;
    }
  }

  async upsertPlayerStats(eosID, fields) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const model = this._s3db.getModel('Elo_PlayerStats');
        const existing = await model.findOne({ where: { eosID }, transaction: t });
        if (existing) {
          await existing.update(fields, { transaction: t });
          return existing.toJSON();
        } else {
          const created = await model.create({ eosID, ...fields }, { transaction: t });
          return created.toJSON();
        }
      });
    } catch (error) {
      this.verbose(1, `[DB] Error upserting stats for ${eosID}: ${error.message}`);
      return null;
    }
  }

  async bulkIncrementPlayerStats(updates) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const model = this._s3db.getModel('Elo_PlayerStats');
        const eosIDs = updates.map((u) => u.eosID);
        const existing = await model.findAll({
          where: { eosID: { [Op.in]: eosIDs } },
          transaction: t
        });
        const existingMap = new Map(existing.map((r) => [r.eosID, r]));

        const ops = updates.map(update => {
          const { eosID, ...fields } = update;
          const record = existingMap.get(eosID);
          if (record) {
            // Integrity check: roundsPlayed=0 but mu≠default indicates a column reset
            if (record.roundsPlayed === 0 && record.mu !== EloCalculator.MU_DEFAULT) {
              this.verbose(1, `[DB] WARNING: Integrity anomaly for eosID ${eosID} (name: ${record.name}) — roundsPlayed=0 but mu=${record.mu.toFixed(2)} (non-default). Possible column reset detected.`);
            }
            return record.update({
              mu: fields.mu,
              sigma: fields.sigma,
              wins: record.wins + (fields.wins ?? 0),
              losses: record.losses + (fields.losses ?? 0),
              roundsPlayed: record.roundsPlayed + (fields.roundsPlayed ?? 0),
              lastSeen: fields.lastSeen,
              name: fields.name ?? record.name,
              steamID: fields.steamID ?? record.steamID
            }, { transaction: t });
          } else {
            this.verbose(1, `[DB] WARNING: bulkIncrement — eosID ${eosID} not found in DB (name: ${fields.name}), creating new record with wins=${fields.wins ?? 0} losses=${fields.losses ?? 0} roundsPlayed=${fields.roundsPlayed ?? 0}.`);
            return model.create({ eosID, ...fields }, { transaction: t });
          }
        });

        await Promise.all(ops);
      });
    } catch (error) {
      this.verbose(1, `[DB] Error bulk upserting stats: ${error.message}`);
      return null;
    }
  }

  /* ================================================================
   *  ROUND HISTORY
   *  ================================================================ */

  async insertRoundHistory(data) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const record = await this._s3db.getModel('Elo_RoundHistory').create(data, { transaction: t });
        return record.toJSON();
      });
    } catch (error) {
      this.verbose(1, `[DB] Error inserting round history: ${error.message}`);
      return null;
    }
  }

  /* ================================================================
   *  LEADERBOARD & RANKING
   *  ================================================================ */

  async getLeaderboard(limit = 20, minRounds = 10, offset = 0) {
    if (!this.isReady()) return [];
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const model = this._s3db.getModel('Elo_PlayerStats');
        const records = await model.findAll({
          where: {
            roundsPlayed: { [Op.gte]: minRounds }
          },
          order: [[Sequelize.literal(`(mu - (${EloCalculator.SIGMA_MULTIPLIER} * sigma))`), 'DESC']],
          limit: limit,
          offset: offset,
          transaction: t
        });
        return records.map((r) => r.toJSON());
      });
    } catch (error) {
      this.verbose(1, `[DB] Error fetching leaderboard: ${error.message}`);
      return [];
    }
  }

  async getPlayerRank(consRating, minRounds = 0) {
    if (!this.isReady()) return 0;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const model = this._s3db.getModel('Elo_PlayerStats');
        // Op imported from Sequelize at module level
        const whereClause = minRounds > 0
          ? { roundsPlayed: { [Op.gte]: minRounds } }
          : {};
        whereClause[Op.and] = Sequelize.literal(`(mu - (${EloCalculator.SIGMA_MULTIPLIER} * sigma)) > ${Number(consRating)}`);

        const higherRanked = await model.count({ where: whereClause, transaction: t });
        return higherRanked + 1;
      });
    } catch (error) {
      this.verbose(1, `[DB] Error fetching player rank for consRating ${consRating}: ${error.message}`);
      return 0;
    }
  }

  async getTotalPlayers() {
    if (!this.isReady()) return 0;
    try {
      return await this._s3db.withTransaction(async (t) => {
        return await this._s3db.getModel('Elo_PlayerStats').count({ transaction: t });
      }).catch(() => 0);
    } catch (error) {
      this.verbose(1, `[DB] Error fetching total players: ${error.message}`);
      return 0;
    }
  }

  async getTotalRankedPlayers(minRounds = 10) {
    if (!this.isReady()) return 0;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        return await this._s3db.getModel('Elo_PlayerStats').count({
          where: { roundsPlayed: { [Op.gte]: minRounds } },
          transaction: t
        });
      });
    } catch (error) {
      this.verbose(1, `[DB] Error fetching total ranked players: ${error.message}`);
      return 0;
    }
  }

  /* ================================================================
   *  EXPORT / IMPORT
   *  ================================================================ */

  async exportPlayerStats() {
    if (!this.isReady()) return [];
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const records = await this._s3db.getModel('Elo_PlayerStats').findAll({ transaction: t });
        return records.map((r) => r.toJSON());
      });
    } catch (error) {
      this.verbose(1, `[DB] Error exporting stats: ${error.message}`);
      return [];
    }
  }

  async importPlayerStats(records) {
    if (!this.isReady()) return null;
    const CHUNK_SIZE = 500;
    try {
      this.verbose(1, `[DB] Import started: ${records.length} players to restore.`);

      for (let i = 0; i < records.length; i += CHUNK_SIZE) {
        const chunk = records.slice(i, i + CHUNK_SIZE);
        await this._s3db.withTransactionWithRetry(async (t) => {
          await this._s3db.getModel('Elo_PlayerStats').bulkCreate(chunk, {
            updateOnDuplicate: [
              'steamID', 'discordID', 'name', 'mu', 'sigma',
              'wins', 'losses', 'roundsPlayed', 'lastSeen'
            ],
            transaction: t
          });
        });
      }

      // Log post-import row count and spot-check a sample record
      const postImportCount = await this._s3db.withTransaction(async (t) => {
        return await this._s3db.getModel('Elo_PlayerStats').count({ transaction: t });
      }).catch(() => 0);

      let sampleRecord = null;
      if (records.length > 0) {
        sampleRecord = await this._s3db.withTransaction(async (t) => {
          return await this._s3db.getModel('Elo_PlayerStats').findOne({
            where: { eosID: records[0].eosID },
            transaction: t
          });
        }).catch(() => null);
      }

      if (sampleRecord) {
        this.verbose(1, `[DB] Import complete: ${postImportCount} total rows. Sample check: eosID=${sampleRecord.eosID} wins=${sampleRecord.wins} losses=${sampleRecord.losses} roundsPlayed=${sampleRecord.roundsPlayed}.`);
      } else {
        this.verbose(1, `[DB] Import complete: ${postImportCount} total rows.`);
      }

      return true;
    } catch (error) {
      this.verbose(1, `[DB] Error importing stats: ${error.message}`);
      return null;
    }
  }

  /* ================================================================
   *  MAINTENANCE — prune / bulk insert
   *  ================================================================ */

  async pruneStaleEntries(minRoundsForLeaderboard) {
    if (!this.isReady()) return { tier1: 0, tier2: 0 };
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;

    try {
      const tier1Count = await this._s3db.withTransactionWithRetry(async (t) => {
        return await this._s3db.getModel('Elo_PlayerStats').destroy({
          where: {
            lastSeen: { [Op.lt]: now - thirtyDays },
            roundsPlayed: { [Op.lt]: minRoundsForLeaderboard }
          },
          transaction: t
        });
      });

      const tier2Count = await this._s3db.withTransactionWithRetry(async (t) => {
        return await this._s3db.getModel('Elo_PlayerStats').destroy({
          where: {
            lastSeen: { [Op.lt]: now - ninetyDays },
            roundsPlayed: { [Op.gte]: minRoundsForLeaderboard }
          },
          transaction: t
        });
      });

      this.verbose(1, `[DB] Pruned stale entries — Tier 1 (provisional): ${tier1Count} deleted. Tier 2 (calibrated): ${tier2Count} deleted.`);
      return { tier1: tier1Count, tier2: tier2Count };
    } catch (error) {
      this.verbose(1, `[DB] Error pruning stale entries: ${error.message}`);
      return { tier1: 0, tier2: 0 };
    }
  }

  async insertRoundPlayers(roundHistoryId, endedAt, playerRows) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        if (playerRows && playerRows.length > 0) {
          await this._s3db.getModel('Elo_RoundPlayers').bulkCreate(playerRows, { transaction: t });
        }
        this.verbose(4, `[DB] Inserted ${playerRows ? playerRows.length : 0} player records for round ${roundHistoryId}`);
        return { roundHistoryId, playerCount: playerRows ? playerRows.length : 0 };
      });
    } catch (error) {
      this.verbose(1, `[DB] insertRoundPlayers failed: ${error.message}`);
      return null;
    }
  }
}