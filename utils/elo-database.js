 /**
  * ╔═══════════════════════════════════════════════════════════════╗
  * ║                         ELO DATABASE                          ║
  * ╚═══════════════════════════════════════════════════════════════╝
  *
  * ─── PURPOSE ─────────────────────────────────────────────────────
  *
  * Sequelize-based persistence layer for the EloTracker plugin, supporting
  * any SQL database (SQLite, MySQL, PostgreSQL, etc.). Manages player
  * stats, round history, leaderboard queries, and plugin state using
  * the Sequelize ORM injected via the connectors argument.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * EloDatabase (default)
 *   Class. Key public methods:
 *     initDB()                         — Sync models, seed PluginState row.
 *     getPlayerStats(eosID)            — Single player lookup by eosID.
 *     getPlayerStatsBatch(eosIDs)      — Bulk lookup; returns a Map.
 *     searchPlayer(identifier)         — Fuzzy search by eosID/steamID/name.
 *     upsertPlayerStats(eosID, fields) — Single-record upsert.
 *     bulkIncrementPlayerStats(updates) — Batch increment in one transaction.
 *     insertRoundHistory(data)         — Append a round record.
 *     getLeaderboard(limit, minRounds, offset) — Top players by CSR, with optional offset.
 *     getPlayerRank(consRating, minRounds) — Rank of a given CSR value.
 *     getTotalRankedPlayers(minRounds) — Count of players meeting the minimum rounds threshold.
 *     exportPlayerStats()              — Full table dump as plain objects.
 *     importPlayerStats(records)       — Bulk restore from export.
 *     pruneStaleEntries(minRounds)     — Delete old low-activity records.
 *
 *   Leaderboard and rank calculation methods internally apply a
 *   "Competitive Skill Rank" (CSR) formula (μ - 3.0σ) instead of raw Mu.
 *
  * ─── DEPENDENCIES ────────────────────────────────────────────────
  *
  * sequelize (Sequelize)
  *   ORM for any SQL backend. Injected dynamically via connectors[options.database]
  *   (default: 'sqlite'). Not instantiated internally. All three models are
  *   defined and synced in initDB().
  * Logger (../../core/logger.js)
  *   Verbose error logging on all caught DB exceptions.
 *
  * ─── NOTES ───────────────────────────────────────────────────────
  *
  * - All operations go through _executeWithRetry() — retries up to 5×
  *   on SQLITE_BUSY or database lock errors, with 200ms + random jitter backoff.
  * - A promise-chain mutex is attached to the Sequelize instance (SQLite only)
  *   to serialise writes and prevent concurrent lock contention. MySQL/Postgres
  *   rely on native connection pooling.
 * - bulkIncrementPlayerStats() INCREMENTS wins, losses, and roundsPlayed.
 *   All other fields are overwritten. Do not pass cumulative totals.
 * - Models are stored on this.models and may be referenced externally
 *   (e.g. this.db.models.PlayerStats.destroy in elo-discord.js).
 * - Sequelize.BIGINT is used for timestamps to avoid JS integer
 *   overflow with Unix ms values.
 * - pruneStaleEntries() removes provisional players unseen for 30 days
 *   and calibrated players unseen for 90 days.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Sequelize from 'sequelize';
import Logger from '../../core/logger.js';
import EloCalculator from './elo-calculator.js';

export default class EloDatabase {
  constructor(server, options, connectors) {
    this.server = server;
    this.options = options;
    // Respect the "database" option; fall back to 'sqlite' if unspecified
    this.sequelize = connectors && connectors[options?.database ?? 'sqlite'];
    this.models = {};
  }

  async _executeWithRetry(logicFn, attempts = 5) {
    const runAttempt = async () => {
      for (let i = 0; i < attempts; i++) {
        try {
          return await logicFn();
        } catch (err) {
          const isLocked = err.message && (
            err.message.includes('SQLITE_BUSY') ||
            err.message.includes('database is locked') ||
            err.message.includes('Lock wait timeout exceeded') ||
            err.name === 'SequelizeTimeoutError'
          );
          if (isLocked && i < attempts - 1) {
            const jitter = Math.random() * 500;
            await new Promise((resolve) => setTimeout(resolve, 200 + jitter));
          } else {
            throw err;
          }
        }
      }
    };

    if (this.sequelize && typeof this.sequelize.getDialect === 'function' && this.sequelize.getDialect() === 'sqlite') {
      if (!this.sequelize._squadjs_mutex) {
        this.sequelize._squadjs_mutex = Promise.resolve();
      }
      
      const resultPromise = this.sequelize._squadjs_mutex.then(() => runAttempt());
      this.sequelize._squadjs_mutex = resultPromise.catch(() => {});
      return resultPromise;
    }

    return runAttempt();
  }

   async initDB() {
     if (!this.sequelize) {
       Logger.verbose('EloTracker', 1, '[DB] No sequelize connector available.');
       return { roundStartTime: null };
     }

    try {
      this.models.PluginState = this.sequelize.define(
        'Elo_PluginState',
        {
          id: {
            type: Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: false,
            defaultValue: 1
          },
          roundStartTime: {
            type: Sequelize.BIGINT,
            allowNull: true
          }
        },
        { timestamps: false }
      );

      this.models.PlayerStats = this.sequelize.define(
        'Elo_PlayerStats',
        {
          eosID: {
            type: Sequelize.STRING,
            primaryKey: true
          },
          steamID: {
            type: Sequelize.STRING,
            allowNull: true
          },
          discordID: {
            type: Sequelize.STRING,
            allowNull: true
          },
          name: {
            type: Sequelize.STRING,
            allowNull: true
          },
          mu: {
            type: Sequelize.FLOAT,
            defaultValue: EloCalculator.MU_DEFAULT
          },
          sigma: {
            type: Sequelize.FLOAT,
            defaultValue: EloCalculator.SIGMA_DEFAULT
          },
          wins: {
            type: Sequelize.INTEGER,
            defaultValue: 0
          },
          losses: {
            type: Sequelize.INTEGER,
            defaultValue: 0
          },
          roundsPlayed: {
            type: Sequelize.INTEGER,
            defaultValue: 0
          },
          lastSeen: {
            type: Sequelize.BIGINT,
            allowNull: true
          }
        },
        { timestamps: false, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
      );

      this.models.RoundHistory = this.sequelize.define(
        'Elo_RoundHistory',
        {
          id: {
            type: Sequelize.INTEGER,
            primaryKey: true,
            autoIncrement: true
          },
          layerName: {
            type: Sequelize.STRING,
            allowNull: true
          },
          winningTeamID: {
            type: Sequelize.INTEGER,
            allowNull: true
          },
          ticketDiff: {
            type: Sequelize.INTEGER,
            allowNull: true
          },
          roundDuration: {
            type: Sequelize.INTEGER,
            allowNull: true
          },
          endedAt: {
            type: Sequelize.BIGINT,
            allowNull: true
          },
          playerCount: {
            type: Sequelize.INTEGER,
            allowNull: true
          }
        },
        { timestamps: false }
      );

       // Define Elo_RoundPlayers for optional database logging (opt-in via enableDatabaseLogging)
       this.models.RoundPlayers = this.sequelize.define(
         'Elo_RoundPlayers',
         {
           id: {
             type: Sequelize.INTEGER,
             primaryKey: true,
             autoIncrement: true
           },
           matchId: {
             type: Sequelize.STRING(20),
             allowNull: true
           },
           roundStartTime: {
             type: Sequelize.BIGINT,
             allowNull: true
           },
           roundHistoryId: {
             type: Sequelize.INTEGER,
             allowNull: false
           },
           eosID: {
             type: Sequelize.STRING,
             allowNull: false
           },
           steamID: {
             type: Sequelize.STRING,
             allowNull: true
           },
           name: {
             type: Sequelize.STRING,
             allowNull: true
           },
           teamID: {
             type: Sequelize.INTEGER,
             allowNull: false
           },
           participationRatio: {
             type: Sequelize.FLOAT,
             allowNull: false
           },
           muBefore: {
             type: Sequelize.FLOAT,
             allowNull: false
           },
           sigmaBefore: {
             type: Sequelize.FLOAT,
             allowNull: false
           },
           rawDeltaMu: {
             type: Sequelize.FLOAT,
             allowNull: false
           },
           rawDeltaSigma: {
             type: Sequelize.FLOAT,
             allowNull: false
           },
           scaledDeltaMu: {
             type: Sequelize.FLOAT,
             allowNull: false
           },
           scaledDeltaSigma: {
             type: Sequelize.FLOAT,
             allowNull: false
           },
           muAfter: {
             type: Sequelize.FLOAT,
             allowNull: false
           },
           sigmaAfter: {
             type: Sequelize.FLOAT,
             allowNull: false
           }
         },
         { timestamps: false, tableName: 'Elo_RoundPlayers', charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
       );

       await this._executeWithRetry(async () => {
          // SQLite-only: PRAGMA commands are not supported on MySQL/Postgres
          if (this.sequelize.getDialect() === 'sqlite') {
            // Enforce WAL mode to prevent SQLITE_BUSY deadlocks in high-concurrency environments (e.g. DBLog + EloTracker writing simultaneously)
            await this.sequelize.query('PRAGMA journal_mode=WAL;');
            await this.sequelize.query('PRAGMA synchronous=NORMAL;');
          }
          
          await this.models.PluginState.sync({ alter: true });
          await this.models.PlayerStats.sync({ alter: true });
          await this.models.RoundHistory.sync({ alter: true });
          await this.models.RoundPlayers.sync({ alter: true });
        });

      const state = await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          const [record] = await this.models.PluginState.findOrCreate({
            where: { id: 1 },
            defaults: { id: 1, roundStartTime: null },
            transaction: t
          });
          return record;
        });
      });

      Logger.verbose('EloTracker', 1, '[DB] Database initialized.');
      return { roundStartTime: state.roundStartTime ? parseInt(state.roundStartTime) : null };
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error initializing database: ${error.message}`);
      return { roundStartTime: null };
    }
  }

  async saveRoundStartTime(timestamp) {
    if (!this.sequelize) return null;
    try {
      return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          await this.models.PluginState.update(
            { roundStartTime: timestamp },
            { where: { id: 1 }, transaction: t }
          );
        });
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error saving roundStartTime: ${error.message}`);
      return null;
    }
  }

  async getPlayerStats(eosID) {
    if (!this.sequelize) return null;
    try {
      return await this._executeWithRetry(async () => {
        const record = await this.models.PlayerStats.findOne({ where: { eosID } });
        return record ? record.toJSON() : null;
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error fetching stats for ${eosID}: ${error.message}`);
      return null;
    }
  }

  async getPlayerStatsBatch(eosIDs) {
    if (!this.sequelize) return new Map();
    try {
      return await this._executeWithRetry(async () => {
        const records = await this.models.PlayerStats.findAll({
          where: {
            eosID: {
              [Sequelize.Op.in]: eosIDs
            }
          }
        });
        const map = new Map();
        for (const record of records) {
          map.set(record.eosID, record.toJSON());
        }
        return map;
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error fetching batch stats: ${error.message}`);
      return new Map();
    }
  }

  async searchPlayer(identifier) {
    if (!this.sequelize || !identifier) return null;
    const id = identifier.trim();
    try {
      return await this._executeWithRetry(async () => {
        const record = await this.models.PlayerStats.findOne({ where: { eosID: id } });
        if (record) return record.toJSON();

        const escaped = id.replace(/%/g, '\\%').replace(/_/g, '\\_');
        const fuzzy = await this.models.PlayerStats.findOne({
          where: {
            [Sequelize.Op.or]: [
              { steamID: id },
              { name: { [Sequelize.Op.like]: `%${escaped}%` } }
            ]
          }
        });
        return fuzzy ? fuzzy.toJSON() : null;
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error searching for player ${id}: ${error.message}`);
      return null;
    }
  }

  async upsertPlayerStats(eosID, fields) {
    if (!this.sequelize) return null;
    try {
      return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          const existing = await this.models.PlayerStats.findOne({ where: { eosID }, transaction: t });
          if (existing) {
            await existing.update(fields, { transaction: t });
            return existing.toJSON();
          } else {
            const created = await this.models.PlayerStats.create({ eosID, ...fields }, { transaction: t });
            return created.toJSON();
          }
        });
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error upserting stats for ${eosID}: ${error.message}`);
      return null;
    }
  }

  async bulkIncrementPlayerStats(updates) {
    if (!this.sequelize) return null;
    try {
      return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          const eosIDs = updates.map((u) => u.eosID);
          const existing = await this.models.PlayerStats.findAll({
            where: { eosID: { [Sequelize.Op.in]: eosIDs } },
            transaction: t
          });
          const existingMap = new Map(existing.map((r) => [r.eosID, r]));

          const ops = updates.map(update => {
            const { eosID, ...fields } = update;
            const record = existingMap.get(eosID);
            if (record) {
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
              return this.models.PlayerStats.create({ eosID, ...fields }, { transaction: t });
            }
          });
          
          await Promise.all(ops);
        });
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error bulk upserting stats: ${error.message}`);
      return null;
    }
  }

  async insertRoundHistory(data) {
    if (!this.sequelize) return null;
    try {
      return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          const record = await this.models.RoundHistory.create(data, { transaction: t });
          return record.toJSON();
        });
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error inserting round history: ${error.message}`);
      return null;
    }
  }

  /**
   * Retrieves the top players based on Competitive Skill Rank (CSR).
   * NOTE: This query accurately sorts by CSR (μ - 3.0σ) as defined 
   * by EloCalculator.SIGMA_MULTIPLIER. This ensures a conservative skill 
   * estimate is used for rankings, rewarding consistent play rather than 
   * relying solely on raw estimated skill (μ).
   */
  async getLeaderboard(limit = 20, minRounds = 10, offset = 0) {
    if (!this.sequelize) return [];
    try {
      return await this._executeWithRetry(async () => {
        const records = await this.models.PlayerStats.findAll({
          where: {
            roundsPlayed: {
              [Sequelize.Op.gte]: minRounds
            }
          },
          order: [[Sequelize.literal(`(mu - (${EloCalculator.SIGMA_MULTIPLIER} * sigma))`), 'DESC']],
          limit: limit,
          offset: offset
        });
        return records.map((r) => r.toJSON());
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error fetching leaderboard: ${error.message}`);
      return [];
    }
  }

  async getPlayerRank(consRating, minRounds = 0) {
    if (!this.sequelize) return 0;
    try {
      return await this._executeWithRetry(async () => {
        const whereClause = minRounds > 0 ? { roundsPlayed: { [Sequelize.Op.gte]: minRounds } } : {};
        // Use Number(consRating) to prevent SQL injection since NaN-coercion produces an invalid but harmless query
        whereClause[Sequelize.Op.and] = Sequelize.literal(`(mu - (${EloCalculator.SIGMA_MULTIPLIER} * sigma)) > ${Number(consRating)}`);

        const higherRanked = await this.models.PlayerStats.count({
          where: whereClause
        });
        return higherRanked + 1;
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error fetching player rank for consRating ${consRating}: ${error.message}`);
      return 0;
    }
  }

  async getTotalPlayers() {
    if (!this.sequelize) return 0;
    try {
      return await this._executeWithRetry(async () => {
        return await this.models.PlayerStats.count();
      });
    } catch (error) {
      Logger.verbose(
        'EloTracker',
        1,
        `[DB] Error fetching total players: ${error.message}`
      );
      return 0;
    }
  }

  async getTotalRankedPlayers(minRounds = 10) {
    if (!this.sequelize) return 0;
    try {
      return await this._executeWithRetry(async () => {
        return await this.models.PlayerStats.count({
          where: {
            roundsPlayed: {
              [Sequelize.Op.gte]: minRounds
            }
          }
        });
      });
    } catch (error) {
      Logger.verbose(
        'EloTracker',
        1,
        `[DB] Error fetching total ranked players: ${error.message}`
      );
      return 0;
    }
  }

  async exportPlayerStats() {
    if (!this.sequelize) return [];
    try {
      return await this._executeWithRetry(async () => {
        const records = await this.models.PlayerStats.findAll();
        return records.map((r) => r.toJSON());
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error exporting stats: ${error.message}`);
      return [];
    }
  }

   async importPlayerStats(records) {
     if (!this.sequelize) return null;
     const CHUNK_SIZE = 500;
     try {
       for (let i = 0; i < records.length; i += CHUNK_SIZE) {
         const chunk = records.slice(i, i + CHUNK_SIZE);
         await this._executeWithRetry(async () => {
           return await this.sequelize.transaction(async (t) => {
             // Use bulkCreate with updateOnDuplicate for efficient upsert operations.
             // This will insert new records or update existing ones based on eosID.
             await this.models.PlayerStats.bulkCreate(chunk, {
               updateOnDuplicate: [
                 'steamID',
                 'discordID',
                 'name',
                 'mu',
                 'sigma',
                 'wins',
                 'losses',
                 'roundsPlayed',
                 'lastSeen'
               ],
               transaction: t
             });
           });
         });
       }
       return true;
     } catch (error) {
       Logger.verbose('EloTracker', 1, `[DB] Error importing stats: ${error.message}`);
       return null;
     }
   }

  async pruneStaleEntries(minRoundsForLeaderboard) {
    if (!this.sequelize) return { tier1: 0, tier2: 0 };
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;

    try {
      const tier1Count = await this._executeWithRetry(async () => {
        return await this.models.PlayerStats.destroy({
          where: {
            lastSeen: { [Sequelize.Op.lt]: now - thirtyDays },
            roundsPlayed: { [Sequelize.Op.lt]: minRoundsForLeaderboard }
          }
        });
      });

      const tier2Count = await this._executeWithRetry(async () => {
        return await this.models.PlayerStats.destroy({
          where: {
            lastSeen: { [Sequelize.Op.lt]: now - ninetyDays },
            roundsPlayed: { [Sequelize.Op.gte]: minRoundsForLeaderboard }
          }
        });
      });

      return { tier1: tier1Count, tier2: tier2Count };
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] Error pruning stale entries: ${error.message}`);
      return { tier1: 0, tier2: 0 };
    }
  }

  async insertRoundPlayers(roundHistoryId, endedAt, playerRows) {
    if (!this.sequelize || !this.models.RoundPlayers) {
      Logger.verbose('EloTracker', 1, '[DB] insertRoundPlayers called before initDB.');
      return null;
    }

    try {
      return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          // Bulk create player records
          if (playerRows && playerRows.length > 0) {
            await this.models.RoundPlayers.bulkCreate(playerRows, { transaction: t });
          }

          Logger.verbose('EloTracker', 4, `[DB] Inserted ${playerRows ? playerRows.length : 0} player records for round ${roundHistoryId}`);
          return { roundHistoryId, playerCount: playerRows ? playerRows.length : 0 };
        });
      });
    } catch (error) {
      Logger.verbose('EloTracker', 1, `[DB] insertRoundPlayers failed: ${error.message}`);
      return null;
    }
  }
}
