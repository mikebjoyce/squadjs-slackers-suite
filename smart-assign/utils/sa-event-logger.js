/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                      SA-EVENT-LOGGER                          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Handles JSONL + DB logging for SmartAssign assignment decisions only.
 * Generic player lifecycle events (JOIN, LEAVE, TEAM_CHANGE,
 * ROUND_SNAPSHOT) are delegated to S³'s LoggingService — this logger
 * silently drops any non-assignment event types.
 *
 * Each assignment event produces one self-contained JSONL line with
 * inline round context (matchId, roundStartTime, layerName, gamemode)
 * so the file is independently joinable with S³ tables without needing
 * a round-wrapper record.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SAEventLogger (class)
 *   Constructor accepts (options, db).
 *     logEvent(eventType, player, extraData, betweenRounds, serverPlayers)
 *       — Writes one JSONL line + optional DB row per assignment event.
 *     flushAssignmentLog()
 *       — Flushes pending writes; no-op in this design (events written immediately).
 *     cleanup()
 *       — Cleans up any pending state on plugin unmount.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Logger (../../core/logger.js)
 *   SquadJS verbose logging for error/warning output.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - enableEventLogging toggles JSONL output (default: true).
 * - enableDatabaseLogging toggles DB writes; passed through to
 *   SADatabase so writes are only gated once.
 * - The logPath file accumulates per-event JSONL lines over time.
 *   Each line is a self-contained object with round context.
 * - Assignment events (MOVE_SUCCESS, MOVE_FAILED, MOVE_RETRY) are
 *   written to JSONL + DB. Non-assignment events (JOIN, LEAVE,
 *   TEAM_CHANGE, ROUND_SNAPSHOT) are handled by S³'s LoggingService.
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { promises as fsPromises } from 'fs';
import Logger from '../../core/logger.js';

const ASSIGNMENT_EVENT_TYPES = new Set(['MOVE_SUCCESS', 'MOVE_FAILED', 'MOVE_RETRY']);

export default class SAEventLogger {
  constructor(options = {}, db = null) {
    this.logPath = options.logPath || './smart-assign-log.jsonl';
    this.enableEventLogging = options.enableEventLogging !== false;
    this.db = db;
    this.enableDatabaseLogging = options.enableDatabaseLogging === true;

    // Guard: DB must also have logging enabled to receive events
    if (this.db && !this.enableDatabaseLogging) {
      this.db = null;  // Don't gate with the DB if logging is disabled
    }

    this._eventCount = 0;
  }

  /**
   * Logs a single event. Silently drops non-assignment event types
   * (JOIN, LEAVE, TEAM_CHANGE, ROUND_SNAPSHOT) which are now handled
   * by S³'s LoggingService. Assignment events (MOVE_SUCCESS, MOVE_FAILED,
   * MOVE_RETRY) are written to JSONL + DB.
   *
   * @param {string} eventType - 'MOVE_SUCCESS' | 'MOVE_FAILED' | 'MOVE_RETRY'
   * @param {object} player - Player object with steamID, eosID, name, teamID, squadID
   * @param {object} extraData - Event-specific metadata (reason, attempt, method, targetTeamID,
   *                             matchId, roundStartTime, layerName, gamemode, etc.)
   * @param {boolean} betweenRounds - Ignored (kept for interface compatibility)
   * @param {array} serverPlayers - Current server player list (ignored; S³ owns pop counts)
   */
  logEvent(eventType, player, extraData = {}, betweenRounds = false, serverPlayers = []) {
    // Silently drop non-assignment event types
    if (!ASSIGNMENT_EVENT_TYPES.has(eventType)) {
      return;
    }

    // Build the event object — self-contained with round context
    const event = {
      ts: Date.now(),
      eventType,
      eosID: player?.eosID || null,
      steamID: player?.steamID || null,
      name: player?.name || null,
      targetTeamID: extraData.teamID != null ? Number(extraData.teamID) : null,
      reason: extraData.reason || null,
      attempt: extraData.attempt != null ? Number(extraData.attempt) : null,
      method: extraData.method || null,
      matchId: extraData.matchId || null,
      roundStartTime: extraData.roundStartTime || null,
      layerName: extraData.layerName || null,
      gamemode: extraData.gamemode || null,
      metadata: {}
    };

    // Collect remaining extraData fields into metadata for query flexibility
    const reservedKeys = new Set(['teamID', 'reason', 'attempt', 'method', 'matchId', 'roundStartTime', 'layerName', 'gamemode']);
    for (const [key, value] of Object.entries(extraData)) {
      if (!reservedKeys.has(key) && value !== undefined) {
        event.metadata[key] = value;
      }
    }
    if (Object.keys(event.metadata).length === 0) {
      delete event.metadata;
    }

    // ── JSONL write (fire-and-forget) ──
    if (this.enableEventLogging) {
      this._writeJsonl(event).catch((err) =>
        Logger.verbose('SmartAssign', 1, `[EventLogger] JSONL write error: ${err.message}`)
      );
    }

    // ── DB write (fire-and-forget) ──
    if (this.enableDatabaseLogging && this.db?.logAssignmentEvent) {
      this.db.logAssignmentEvent(event).catch((err) =>
        Logger.verbose('SmartAssign', 1, `[EventLogger] DB write error: ${err.message}`)
      );
    }

    this._eventCount++;
  }

  /**
   * Appends one JSONL line to the log file.
   * Uses a write queue to prevent interleaved writes from concurrent calls.
   */
  async _writeJsonl(event) {
    if (!this._writeQueue) {
      this._writeQueue = Promise.resolve();
    }
    const line = JSON.stringify(event) + '\n';
    this._writeQueue = this._writeQueue.then(() =>
      fsPromises.appendFile(this.logPath, line, 'utf8')
    );
    return this._writeQueue;
  }

  /**
   * Flush any pending writes. No-op in this design since each event
   * is written immediately, but retained for interface compatibility
   * at mount/unmount/round-end boundaries.
   */
  async flushAssignmentLog() {
    if (this._writeQueue) {
      await this._writeQueue;
      Logger.verbose('SmartAssign', 3, `[EventLogger] Flushed ${this._eventCount} assignment events.`);
    }
  }

  /**
   * Cleanup on plugin unmount. Flushes pending writes.
   */
  async cleanup() {
    await this.flushAssignmentLog();
    this._eventCount = 0;
  }
}