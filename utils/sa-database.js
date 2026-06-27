/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                         SA-DATABASE                           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Persistent storage for SmartAssign assignment events. Replaced the
 * previous all-purpose database utility (round state, reconnect memory,
 * full event logging) with a single focused table — SA_AssignmentLog —
 * that records only assignment decisions (MOVE_SUCCESS, MOVE_FAILED,
 * MOVE_RETRY). Generic player lifecycle events (JOIN, LEAVE, TEAM_CHANGE,
 * ROUND_SNAPSHOT) are delegated to S³'s LoggingService.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SADatabase (class)
 *   Constructor accepts (sequelize, enableDatabaseLogging).
 *   Key public methods:
 *     logAssignmentEvent(event)  — Writes one assignment event to DB.
 *
 * ─── DEPRECATED / REMOVED ────────────────────────────────────────
 *
 * The following tables and methods have been removed (Stage 7.4i):
 *   SmartAssignState        — roundStartTime vestigial (S3_GameState is canonical)
 *   SmartAssignReconnectMemory — replaced by S³ PlayersService reconnect
 *   SA_RoundSummary         — replaced by S³ S3_PlayerEvents/S3_GameStateEvents
 *   SA_PlayerEvent          — replaced by S³ S3_PlayerEvents
 *   insertRoundWithEvents() — replaced by logAssignmentEvent()
 *   cleanupOldData()        — no longer needed
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - All writes are gated behind enableDatabaseLogging (passed from
 *   SmartAssign options). When disabled, logAssignmentEvent is a no-op.
 * - Model is lazily synced on first write.
 *
 * ═══════════════════════════════════════════════════════════════
 */
import Sequelize from 'sequelize';
import Logger from '../../core/logger.js';
const { DataTypes } = Sequelize;

export default class SADatabase {
  /**
   * @param {object} sequelize - Sequelize connector instance
   * @param {object} [options]
   * @param {boolean} [options.enableDatabaseLogging=false] - Gate for DB writes
   */
  constructor(sequelize, options = {}) {
    this.sequelize = sequelize;
    this.enableDatabaseLogging = options.enableDatabaseLogging === true;
    this.AssignmentLogModel = null;
    this._syncDone = false;

    // Promise-chain mutex to serialise SQLite writes and prevent lock contention
    this._mutex = Promise.resolve();

    // Enable WAL mode for better concurrent performance
    if (this.sequelize && this.sequelize.getDialect?.() === 'sqlite') {
      this.sequelize.query('PRAGMA journal_mode=WAL;').catch(() => {});
      this.sequelize.query('PRAGMA synchronous=NORMAL;').catch(() => {});
    }
  }

  /* ────────────────────────────────────── RETRY / MUTEX ────────────────────────────────────── */

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

    // Serialize writes via promise-chain mutex for SQLite
    if (this.sequelize && this.sequelize.getDialect?.() === 'sqlite') {
      const resultPromise = this._mutex.then(() => runAttempt());
      this._mutex = resultPromise.catch(() => {});
      return resultPromise;
    }

    return runAttempt();
  }

  /* ────────────────────────────────────── MODEL DEFINITION ────────────────────────────────────── */

  _defineModel() {
    if (this.AssignmentLogModel) return;

    this.AssignmentLogModel = this.sequelize.define(
      'SA_AssignmentLog',
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        matchId: { type: DataTypes.STRING, allowNull: true },
        roundStartTime: { type: DataTypes.BIGINT, allowNull: true },
        ts: { type: DataTypes.BIGINT, allowNull: false },
        eventType: {
          type: DataTypes.STRING,
          allowNull: false,
          validate: {
            isIn: [['MOVE_SUCCESS', 'MOVE_FAILED', 'MOVE_RETRY']]
          }
        },
        eosID: { type: DataTypes.STRING, allowNull: true },
        steamID: { type: DataTypes.STRING, allowNull: true },
        name: { type: DataTypes.STRING, allowNull: true },
        targetTeamID: { type: DataTypes.INTEGER, allowNull: true },
        reason: { type: DataTypes.STRING, allowNull: true },
        attempt: { type: DataTypes.INTEGER, allowNull: true },
        method: { type: DataTypes.STRING, allowNull: true },
        metadata: { type: DataTypes.JSON, allowNull: true }
      },
      {
        tableName: 'SA_AssignmentLog',
        timestamps: false,
        indexes: [
          { name: 'idx_sa_al_matchId', fields: ['matchId'] },
          { name: 'idx_sa_al_eventType', fields: ['eventType'] },
          { name: 'idx_sa_al_ts', fields: ['ts'] }
        ]
      }
    );
  }

  /* ────────────────────────────────────── PUBLIC API ────────────────────────────────────── */

  /**
   * Logs a single assignment event to SA_AssignmentLog.
   * No-op when enableDatabaseLogging is false.
   *
   * @param {object} event
   * @param {string}  event.eventType     - 'MOVE_SUCCESS' | 'MOVE_FAILED' | 'MOVE_RETRY'
   * @param {number}  event.ts            - Unix ms timestamp
   * @param {string}  [event.eosID]
   * @param {string}  [event.steamID]
   * @param {string}  [event.name]
   * @param {number}  [event.targetTeamID]
   * @param {string}  [event.reason]
   * @param {number}  [event.attempt]
   * @param {string}  [event.method]
   * @param {string}  [event.matchId]
   * @param {number}  [event.roundStartTime]
   * @param {object}  [event.metadata]    - Extra context stored as JSON
   */
  async logAssignmentEvent(event) {
    if (!this.enableDatabaseLogging || !this.sequelize) return;

    // Lazy model definition + sync on first write
    if (!this.AssignmentLogModel) {
      this._defineModel();
    }
    if (!this._syncDone) {
      try {
        await this.AssignmentLogModel.sync();
        this._syncDone = true;
      } catch (err) {
        Logger.verbose('SmartAssign', 1, `[DB] Failed to sync SA_AssignmentLog: ${err.message}`);
        return;
      }
    }

    try {
      await this._executeWithRetry(async () => {
        await this.AssignmentLogModel.create({
          matchId: event.matchId || null,
          roundStartTime: event.roundStartTime || null,
          ts: event.ts || Date.now(),
          eventType: event.eventType,
          eosID: event.eosID || null,
          steamID: event.steamID || null,
          name: event.name || null,
          targetTeamID: event.targetTeamID != null ? Number(event.targetTeamID) : null,
          reason: event.reason || null,
          attempt: event.attempt != null ? Number(event.attempt) : null,
          method: event.method || null,
          metadata: event.metadata || null
        });
      });
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[DB] logAssignmentEvent failed: ${err.message}`);
    }
  }
}