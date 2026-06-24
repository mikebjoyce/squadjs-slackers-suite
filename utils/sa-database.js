/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                      SA-DATABASE v1.0.0                       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Persistent storage utility for the SmartAssign plugin.
 * Handles reading and writing player reconnect memory and round state data
 * to a Sequelize database (SQLite, MySQL, PostgreSQL, etc.).
 * Includes retry logic for database locks and SQLite-specific mutex serialization
 * to ensure stability in high-concurrency environments.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SADatabase (default)
 *   Key methods:
 *     initDB()                          — Initializes models and syncs.
 *     saveRoundStartTime(timestamp)     — Updates the current round's start time.
 *     clearReconnectMemory()            — Wipes all disconnected player records.
 *     savePlayerDisconnect(steamID, team) — Saves a player's team state.
 *     getReconnectTeam(steamID)         — Retrieves a returning player's team.
 *     getAllReconnectMemory()           — Bulk loads all reconnect records into a Map (for crash recovery).
 *     cleanupOldData()                  — Prunes records older than 12 hours.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */
import Sequelize from 'sequelize';
import Logger from '../../core/logger.js';
const { DataTypes } = Sequelize;

export default class SADatabase {
  constructor(server, options, connectors) {
    this.sequelize = connectors && connectors[options.database];
    this.SmartAssignStateModel = null;
    this.ReconnectMemoryModel = null;
    this._mutex = Promise.resolve();
  }

   async _executeWithRetry(logicFn, attempts = 5) {
     const runAttempt = async () => {
       for (let i = 1; i <= attempts; i++) {
         try {
           return await logicFn();
         } catch (err) {
           const isLocked = err.message && (
             err.message.includes('SQLITE_BUSY') || 
             err.message.includes('database is locked') ||
             err.message.includes('Lock wait timeout exceeded') ||
             err.name === 'SequelizeTimeoutError'
           );
           if (isLocked && i < attempts) {
             const jitter = Math.random() * 500;
             await new Promise(resolve => setTimeout(resolve, 200 + jitter));
           } else {
             throw err;
           }
         }
       }
     };

    // SQLite-only: Use a promise-chain mutex to serialize writes and prevent lock contention.
    // MySQL/PostgreSQL use native connection pooling; Sequelize transactions handle concurrency.
    if (this.sequelize && this.sequelize.getDialect() === 'sqlite') {
      const resultPromise = this._mutex.then(() => runAttempt());
      this._mutex = resultPromise.catch(() => {});
      return resultPromise;
    }

    return runAttempt();
  }

  async initDB() {
    try {
      if (!this.sequelize) {
        Logger.verbose('SmartAssign', 1, '[DB] No sequelize connector available.');
        return { roundStartTime: null };
      }

      this.SmartAssignStateModel = this.sequelize.define(
        'SmartAssignState',
        {
          id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: false, defaultValue: 1 },
          /**
           * DESIGN NOTE: BIGINT and SQLite
           * DataTypes.BIGINT correctly maps to large numbers, but SQLite/Sequelize will return this 
           * value as a STRING rather than a native JavaScript Number. Upstream consumers (like smart-assign.js) 
           * MUST explicitly cast this to Number(persistedStartTime) to avoid silent string-comparison bugs.
           */
          roundStartTime: { type: DataTypes.BIGINT, allowNull: true }
        },
        { timestamps: false, tableName: 'SmartAssignState' }
      );

      this.ReconnectMemoryModel = this.sequelize.define(
        'SmartAssignReconnectMemory',
        {
          steamID: { type: DataTypes.STRING, primaryKey: true },
          teamID: { type: DataTypes.INTEGER, allowNull: false },
          disconnectTime: { type: DataTypes.BIGINT, allowNull: false }
        },
        { timestamps: false, tableName: 'SmartAssignReconnectMemory' }
      );

      // Enforce WAL mode to prevent SQLITE_BUSY deadlocks in high-concurrency environments
      if (this.sequelize.getDialect() === 'sqlite') {
        await this.sequelize.query('PRAGMA journal_mode=WAL;');
        await this.sequelize.query('PRAGMA synchronous=NORMAL;');
      }

      /**
       * DESIGN NOTE: sync({ alter: true })
       * In a shared plugin ecosystem like SquadJS, `alter: true` carries a minor production risk. If a schema 
       * update changes a column type, Sequelize might silently drop and re-add the column depending on the dialect,
       * leading to data loss. Since this plugin's schema is currently stable, it is left as `alter: true` for 
       * zero-config deployment, but it should be noted for future structural updates.
       */
       await this.SmartAssignStateModel.sync({ alter: true });
       await this.ReconnectMemoryModel.sync({ alter: true });

       // Define SARoundSummaryModel for optional database logging (opt-in via enableDatabaseLogging)
        this.SARoundSummaryModel = this.sequelize.define(
          'SA_RoundSummary',
          {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            matchId: { type: DataTypes.STRING(20), allowNull: true },
            startTime: { type: DataTypes.BIGINT, allowNull: false },
            endTime: { type: DataTypes.BIGINT, allowNull: false },
            layerName: { type: DataTypes.STRING(255), allowNull: true },
            gamemode: { type: DataTypes.STRING(100), allowNull: true },
            smartAssignActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false }
          },
          { timestamps: false, tableName: 'SA_RoundSummary' }
        );

       // Define SAPlayerEventModel for optional database logging (opt-in via enableDatabaseLogging)
        this.SAPlayerEventModel = this.sequelize.define(
          'SA_PlayerEvent',
          {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
            roundId: { type: DataTypes.INTEGER, allowNull: false },
            ts: { type: DataTypes.BIGINT, allowNull: false },
            eventType: { type: DataTypes.STRING(50), allowNull: false },
            steamID: { type: DataTypes.STRING(50), allowNull: true },
            name: { type: DataTypes.STRING(255), allowNull: true },
            teamID: { type: DataTypes.INTEGER, allowNull: true },
            squadID: { type: DataTypes.INTEGER, allowNull: true },
            betweenRounds: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            t1: { type: DataTypes.INTEGER, allowNull: true },
            t2: { type: DataTypes.INTEGER, allowNull: true },
            extraData: { type: DataTypes.JSON, allowNull: true }
          },
          { timestamps: false, tableName: 'SA_PlayerEvent', charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' }
        );

       await this.SARoundSummaryModel.sync({ alter: true });
       await this.SAPlayerEventModel.sync({ alter: true });

       return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          const [record] = await this.SmartAssignStateModel.findOrCreate({
            where: { id: 1 },
            defaults: {
              roundStartTime: null
            },
            transaction: t
          });

          return {
            roundStartTime: record.roundStartTime
          };
        });
      });
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[DB] initDB failed: ${err.message}`);
      return { roundStartTime: null };
    }
  }

  async saveRoundStartTime(timestamp) {
    if (!this.SmartAssignStateModel) return null;

    try {
      return await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          await this.SmartAssignStateModel.update(
            { roundStartTime: timestamp },
            { where: { id: 1 }, transaction: t }
          );
          return { roundStartTime: timestamp };
        });
      });
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[DB] saveRoundStartTime failed: ${err.message}`);
      return null;
    }
  }

  // DEPRECATED — Stage 4: replaced by S³ PlayersService reconnect
  async clearReconnectMemory() {
     if (!this.ReconnectMemoryModel) return;
     
     try {
       await this._executeWithRetry(async () => {
         return await this.sequelize.transaction(async (t) => {
           await this.ReconnectMemoryModel.destroy({ truncate: true, transaction: t });
         });
       });
       Logger.verbose('SmartAssign', 2, '[DB] Reconnect memory cleared for new round.');
     } catch (err) {
       Logger.verbose('SmartAssign', 1, `[DB] clearReconnectMemory failed: ${err.message}`);
     }
   }

  // DEPRECATED — Stage 4: replaced by S³ PlayersService reconnect
  async savePlayerDisconnect(steamID, teamID) {
    if (!this.ReconnectMemoryModel || !steamID) return;
    if (teamID !== 1 && teamID !== 2) return;

    try {
      await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          await this.ReconnectMemoryModel.upsert({
            steamID,
            teamID,
            disconnectTime: Date.now()
          }, { transaction: t });
        });
      });
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[DB] savePlayerDisconnect failed: ${err.message}`);
    }
  }

  async getReconnectTeam(steamID) {
    if (!this.ReconnectMemoryModel || !steamID) return null;

    try {
      return await this._executeWithRetry(async () => {
        const record = await this.ReconnectMemoryModel.findByPk(steamID);
        return record ? record.teamID : null;
      });
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[DB] getReconnectTeam failed: ${err.message}`);
      return null;
    }
  }

  // DEPRECATED — Stage 4: replaced by S³ PlayersService reconnect
  async getAllReconnectMemory() {
     if (!this.ReconnectMemoryModel) return new Map();

     try {
       return await this._executeWithRetry(async () => {
         const records = await this.ReconnectMemoryModel.findAll();
         const reconnectMap = new Map();
         for (const record of records) {
           reconnectMap.set(record.steamID, record.teamID);
         }
         return reconnectMap;
       });
     } catch (err) {
       Logger.verbose('SmartAssign', 1, `[DB] getAllReconnectMemory failed: ${err.message}`);
       return new Map();
     }
   }

   async cleanupOldData() {
     if (!this.ReconnectMemoryModel || !this.SmartAssignStateModel) return;

     const twelveHoursAgo = Date.now() - 12 * 60 * 60 * 1000;
     try {
       await this._executeWithRetry(async () => {
         return await this.sequelize.transaction(async (t) => {
           // Prune reconnect memory
           const prunedReconnects = await this.ReconnectMemoryModel.destroy({
             where: {
               disconnectTime: { [Sequelize.Op.lt]: twelveHoursAgo }
             },
             transaction: t
           });

            // Prune round start time if old
            const state = await this.SmartAssignStateModel.findByPk(1, { transaction: t });
            if (state && state.roundStartTime && Number(state.roundStartTime) < twelveHoursAgo) {
              state.roundStartTime = null;
              await state.save({ transaction: t });
              Logger.verbose('SmartAssign', 2, '[DB] Reset stale round start time.');
            }

            if (prunedReconnects > 0) {
              Logger.verbose('SmartAssign', 2, `[DB] Cleanup complete. Pruned ${prunedReconnects} old reconnect records.`);
            }
         });
       });
     } catch (err) {
       Logger.verbose('SmartAssign', 1, `[DB] cleanupOldData failed: ${err.message}`);
     }
   }

   async insertRoundWithEvents(roundLog) {
     if (!this.SARoundSummaryModel || !this.SAPlayerEventModel) {
       Logger.verbose('SmartAssign', 1, '[DB] insertRoundWithEvents called before initDB.');
       return null;
     }

     try {
       return await this._executeWithRetry(async () => {
         return await this.sequelize.transaction(async (t) => {
           // Create round summary record
           const roundRecord = await this.SARoundSummaryModel.create({
             matchId: roundLog.matchId ?? null,
             startTime: roundLog.startTime,
             endTime: roundLog.endTime,
             layerName: roundLog.layerName,
             gamemode: roundLog.gamemode,
             smartAssignActive: roundLog.smartAssignActive
           }, { transaction: t });

           // Bulk create player events
           if (roundLog.events && roundLog.events.length > 0) {
             const eventRecords = roundLog.events.map(event => ({
               roundId: roundRecord.id,
               ts: event.ts,
               eventType: event.eventType,
               steamID: event.steamID || null,
               name: event.name || null,
               teamID: event.teamID || null,
               squadID: event.squadID || null,
               betweenRounds: event.betweenRounds || false,
               t1: event.t1 || null,
               t2: event.t2 || null,
               extraData: JSON.stringify({
                 reason: event.reason,
                 targetTeam: event.targetTeam,
                 oldTeam: event.oldTeam,
                 newTeam: event.newTeam,
                 source: event.source,
                 attempt: event.attempt,
                 method: event.method,
                 players: event.players
               })
             }));

             await this.SAPlayerEventModel.bulkCreate(eventRecords, { transaction: t });
           }

           Logger.verbose('SmartAssign', 4, `[DB] Round logged: ${roundLog.layerName} (${roundLog.gamemode}) with ${roundLog.events ? roundLog.events.length : 0} events`);
           return roundRecord.toJSON();
         });
       });
     } catch (err) {
       Logger.verbose('SmartAssign', 1, `[DB] insertRoundWithEvents failed: ${err.message}`);
       return null;
     }
   }
}
