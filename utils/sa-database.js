/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                         SA-DATABASE                           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * S³-delegated persistence layer for SmartAssign assignment events.
 * All DB access is routed through S³'s DBService (this._s3db) using
 * getModel for model access and withTransactionWithRetry for transaction
 * safety. The standalone Sequelize connector and raw sync() calls have
 * been removed per Stage 8.2 Strategy A.
 *
 * Replaced the previous all-purpose database utility (round state,
 * reconnect memory, full event logging) with a single focused table —
 * SA_AssignmentLog — that records only assignment decisions
 * (MOVE_SUCCESS, MOVE_FAILED, MOVE_RETRY). Generic player lifecycle
 * events (JOIN, LEAVE, TEAM_CHANGE, ROUND_SNAPSHOT) are delegated to
 * S³'s LoggingService.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SADatabase (class)
 *   Constructor accepts (options).
 *   Key public methods:
 *     logAssignmentEvent(event)  — Writes one assignment event to DB.
 *     isReady()                  — Returns true when S³ DBService is mounted.
 *     getModel(name)             — Accessor for Sequelize model via S³.
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
 * The following have been removed (Stage 8.2 Strategy A):
 *   Standalone sequelize connector    — DB access now delegates to S³ DBService
 *   _executeWithRetry()               — S³ DBService provides withTransactionWithRetry
 *   _defineModel() / sync()           — Model defined by smart-assign.js via s3db.defineModel()
 *   WAL pragma setup                  — S³ DBService handles this on mount
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - All writes are gated behind enableDatabaseLogging (passed from
 *   SmartAssign options). When disabled, logAssignmentEvent is a no-op.
 * - Model is defined by smart-assign.js mount() via s3db.defineModel()
 *   before any DB operations are attempted.
 * - The SA_AssignmentLog table is created by MigrationEngine v1 migration,
 *   not by raw sync().
 *
 * ═══════════════════════════════════════════════════════════════
 */
import Logger from '../../core/logger.js';

export default class SADatabase {
  /**
   * @param {object} [options]
   * @param {boolean} [options.enableDatabaseLogging=false] - Gate for DB writes
   */
  constructor(options = {}) {
    this._s3db = null; // Injected after S³ discovery (smart-assign.js mount)
    this.enableDatabaseLogging = options.enableDatabaseLogging === true;
  }

  /* ────────────────────────────────────── DELEGATED ACCESSORS ────────────────────────────────────── */

  /**
   * Check whether the S³ DBService is ready.
   * @returns {boolean}
   */
  isReady() {
    return !!(this._s3db && this._s3db.isReady && this._s3db.isReady());
  }

  /**
   * Access a model defined on S³'s connector.
   * @param {string} name - Model name (e.g. 'SA_AssignmentLog')
   * @returns {import('sequelize').Model|null}
   */
  getModel(name) {
    if (!this._s3db) return null;
    return this._s3db.getModel(name) || null;
  }

  /* ────────────────────────────────────── DELEGATED TRANSACTION WRAPPER ──────────────────────────── */

  /**
   * Internal helper: execute a function inside S³'s withTransactionWithRetry.
   * Returns null if the DB is not ready or the operation fails.
   * @param {Function} fn - Async function receiving (transaction)
   * @returns {Promise<*>}
   */
  async _withDb(fn) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(fn);
    } catch (err) {
      if (!this._isLockError(err)) {
        Logger.verbose('SmartAssign', 1, `[DB] Error in _withDb: ${err.message}`);
      }
      return null;
    }
  }

  /**
   * Detect SQLite locking errors from Sequelize error objects.
   * @param {Error} err
   * @returns {boolean}
   */
  _isLockError(err) {
    const message = String(err?.message || '');
    return (
      message.includes('SQLITE_BUSY') ||
      message.includes('database is locked') ||
      message.includes('Lock wait timeout exceeded') ||
      err?.name === 'SequelizeTimeoutError'
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
    if (!this.enableDatabaseLogging || !this.isReady()) return;

    try {
      await this._withDb(async (t) => {
        const model = this._s3db.getModel('SA_AssignmentLog');
        if (!model) {
          Logger.verbose('SmartAssign', 1, '[DB] SA_AssignmentLog model not found on S³ connector. Skipping write.');
          return;
        }
        await model.create({
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
        }, { transaction: t });
      });
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[DB] logAssignmentEvent failed: ${err.message}`);
    }
  }
}