import Sequelize from 'sequelize';
import Logger from '../../core/logger.js';
const { DataTypes } = Sequelize;

export default class SADatabase {
  constructor(server, options, connectors) {
    this.sequelize = connectors && connectors.sqlite;
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

    if (this.sequelize && typeof this.sequelize.getDialect === 'function' && this.sequelize.getDialect() === 'sqlite') {
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
      await this.sequelize.query('PRAGMA journal_mode=WAL;');
      await this.sequelize.query('PRAGMA synchronous=NORMAL;');
      
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
          const record = await this.SmartAssignStateModel.findByPk(1, { transaction: t });
          if (!record) return null;
          
          record.roundStartTime = timestamp;
          await record.save({ transaction: t });
          return record;
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
          await this.ReconnectMemoryModel.destroy({ where: {}, truncate: true, transaction: t });
        });
      });
      Logger.verbose('SmartAssign', 1, '[DB] Reconnect memory cleared for new round.');
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[DB] clearReconnectMemory failed: ${err.message}`);
    }
  }

  async savePlayerDisconnect(steamID, teamID) {
    if (!this.ReconnectMemoryModel || !steamID || !teamID) return;

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
}
