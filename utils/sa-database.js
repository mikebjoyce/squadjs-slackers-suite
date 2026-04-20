/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                      SA-DATABASE v0.1.9                       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Persistent storage utility for the SmartAssign plugin.
 * Handles reading and writing player reconnect memory and round state data
 * to an SQLite/Sequelize database. Includes retry logic for SQLite locks
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

    // The strict global mutex was removed to allow concurrent queries (like reads).
    // The retry logic and WAL mode (configured in initDB) handles write conflicts effectively without forcing fully sequential operations.
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

  async clearReconnectMemory() {
    if (!this.ReconnectMemoryModel) return;
    
    try {
      await this._executeWithRetry(async () => {
        return await this.sequelize.transaction(async (t) => {
          await this.ReconnectMemoryModel.destroy({ truncate: true, transaction: t });
        });
      });
      Logger.verbose('SmartAssign', 1, '[DB] Reconnect memory cleared for new round.');
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[DB] clearReconnectMemory failed: ${err.message}`);
    }
  }

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
            Logger.verbose('SmartAssign', 1, '[DB] Reset stale round start time.');
          }

          if (prunedReconnects > 0) {
            Logger.verbose('SmartAssign', 1, `[DB] Cleanup complete. Pruned ${prunedReconnects} old reconnect records.`);
          }
        });
      });
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[DB] cleanupOldData failed: ${err.message}`);
    }
  }
}
