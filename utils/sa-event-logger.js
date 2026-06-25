/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                      SA-EVENT-LOGGER                          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Handles all JSONL event logging for SmartAssign player lifecycle events.
 * Manages in-memory batching, temp file flushing, and round log
 * finalisation. Separates I/O concerns from core assignment logic.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SAEventLogger (class)
 *   Constructor accepts (options, db).
 *   Key public methods:
 *     logEvent(eventType, player, extraData, betweenRounds, serverPlayers)
 *       — Batches an event into memory with embedded t1/t2 population counts.
 *     finalizeRoundLog(roundStartTime, layerName, gamemode, smartAssignActive, matchId)
 *       — Finalises temp log into a permanent JSONL round record.
 *     loadTempEvents()
 *       — Loads accumulated events from temp file into memory (crash recovery).
 *     cleanup()
 *       — Clears batching timers on plugin unmount.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * fs/promises (Node built-in)
 *   Async file I/O for JSONL read/write operations.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Events are batched in-memory (_eventBatch) and flushed to a temp
 *   file periodically (_startBatchFlushTimer) to minimise disk I/O.
 * - finalizeRoundLog() renames the temp file to the permanent log path
 *   and optionally writes to the database via SADatabase.insertRoundWithEvents().
 * - Separate temp file per round prevents partial writes from corrupting
 *   completed round logs during crashes.
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { promises as fsPromises } from 'fs';
import Logger from '../../core/logger.js';

export default class SAEventLogger {
  constructor(options = {}, db = null) {
    this.logPath = options.logPath || './auto-assign-log.jsonl';
    this.enableEventLogging = options.enableEventLogging !== false;
    this.db = db;
    this.enableDatabaseLogging = options.enableDatabaseLogging === true;

    this._logWriteQueue = Promise.resolve();
    this._eventBatch = [];
    this._batchFlushTimer = null;

    // Initialize the batch flush timer
    this._startBatchFlushTimer();
  }

  _startBatchFlushTimer() {
    if (this._batchFlushTimer) clearInterval(this._batchFlushTimer);
    this._batchFlushTimer = setInterval(() => {
      this._flushTempLog().catch(err =>
        Logger.verbose('SmartAssign', 1, `[EventLogger] Flush error: ${err.message}`)
      );
    }, 15000);
  }

  /**
   * Logs an event with optional global team population snapshots.
   * Batches events in memory to optimize disk I/O.
   *
   * @param {string} eventType - Event type (JOIN, LEAVE, ASSIGNMENT, TEAM_CHANGE, ROUND_SNAPSHOT, etc.)
   * @param {object} player - Player object with steamID, name, teamID, squadID
   * @param {object} extraData - Event-specific metadata
   * @param {boolean} betweenRounds - Whether event occurred during round transition
   * @param {array} serverPlayers - Current server player list (for t1/t2 counts)
   */
  logEvent(eventType, player, extraData = {}, betweenRounds = false, serverPlayers = []) {
    if (!this.enableEventLogging) return;

    // Dynamically inject global team populations into the event
    let t1 = 0;
    let t2 = 0;
    for (const p of serverPlayers) {
      if (String(p.teamID) === '1') t1++;
      else if (String(p.teamID) === '2') t2++;
    }

    const event = {
      ts: Date.now(),
      eventType,
      ...(player ? {
        steamID: player.steamID,
        name: player.name,
        teamID: player.teamID,
        squadID: player.squadID
      } : {}),
      ...extraData,
      betweenRounds,
      t1,
      t2
    };

    // Push to in-memory batch. Flush immediately if threshold is reached.
    this._eventBatch.push(JSON.stringify(event) + '\n');
    if (this._eventBatch.length >= 20) {
      this._flushTempLog().catch(err =>
        Logger.verbose('SmartAssign', 1, `[EventLogger] Flush error: ${err.message}`)
      );
    }
  }

  /**
   * Appends the in-memory batch of formatted events to the temporary .temp file.
   * Chained via a Promise queue to prevent interleaved JSON lines from overlapping fs.appendFile calls.
   */
  async _flushTempLog() {
    if (this._eventBatch.length === 0) return;

    const lines = this._eventBatch.join('');
    this._eventBatch = [];

    const tempPath = this.logPath + '.temp';
    this._logWriteQueue = this._logWriteQueue.then(() => {
      return fsPromises.appendFile(tempPath, lines, 'utf8')
        .catch((err) =>
          Logger.verbose('SmartAssign', 1, `[EventLogger] Failed to write temp log: ${err.message}`)
        );
    });

    return this._logWriteQueue;
  }

   /**
    * Finalizes a round's events from the temp file into the main JSONL log.
    * Loads all accumulated events, wraps them in a round record, and appends to the main log.
    *
    * @param {number} roundStartTime - Unix timestamp when round started
    * @param {string} layerName - Name of the map/layer
    * @param {string} gamemode - Gamemode of the round
    * @param {boolean} smartAssignActive - Whether SmartAssign was actively assigning
    * @param {string} matchId - Pre-computed matchId hash from S³ GameStateService (base-36 encoded timestamp)
    */
   async finalizeRoundLog(roundStartTime, layerName, gamemode, smartAssignActive, matchId = null) {
    if (this._batchFlushTimer) {
      clearInterval(this._batchFlushTimer);
      this._batchFlushTimer = null;
    }

    // Force flush any pending memory events and wait for the write queue to empty.
    await this._flushTempLog();
    await this._logWriteQueue; // drain queue fully

    // Load all events from temp file
    const events = await this.loadTempEvents();

    if (events.length === 0) {
      Logger.verbose('SmartAssign', 3, '[EventLogger] Skipping log finalization: 0 events to write.');
      return;
    }

    Logger.verbose('SmartAssign', 1, `[EventLogger] Finalizing round log with ${events.length} events.`);

    if (matchId === null || matchId === undefined) {
      Logger.verbose('SmartAssign', 2, '[DB] Warning: matchId is null. Cross-plugin joins will not be possible for this round.');
    }

    const roundLog = {
      startTime: roundStartTime || Date.now(),
      endTime: Date.now(),
      matchId: matchId,
      layerName: layerName || 'Unknown',
      gamemode: gamemode || 'Unknown',
      smartAssignActive: smartAssignActive !== false,
      events: events
    };

    try {
      await fsPromises.appendFile(this.logPath, JSON.stringify(roundLog) + '\n', 'utf8');
      const tempPath = this.logPath + '.temp';
      await fsPromises.unlink(tempPath).catch(() => {});
      Logger.verbose('SmartAssign', 2, '[EventLogger] Round log finalized successfully.');

      // Fire-and-forget database insert if enabled
      if (this.enableDatabaseLogging && this.db) {
        this.db.insertRoundWithEvents(roundLog).catch(err =>
          Logger.verbose('SmartAssign', 1, `[EventLogger] Database insert failed: ${err.message}`)
        );
      }
    } catch (err) {
      Logger.verbose('SmartAssign', 1, `[EventLogger] Failed to finalize round log: ${err.message}. Events retained in temp log.`);
    }
  }

  /**
   * Loads all events from the temporary log file into memory.
   * Parses JSONL format and returns as array.
   *
   * @returns {array} Array of parsed event objects
   */
  async loadTempEvents() {
    const tempPath = this.logPath + '.temp';
    try {
      const data = await fsPromises.readFile(tempPath, 'utf8');
      const lines = data.trim().split('\n');
      const events = lines
        .filter((l) => l.trim())
        .reduce((acc, l) => {
          try {
            acc.push(JSON.parse(l));
          } catch {
            Logger.verbose('SmartAssign', 1, '[EventLogger] Skipped malformed temp line.');
          }
          return acc;
        }, []);
      Logger.verbose('SmartAssign', 2, `[EventLogger] Loaded ${events.length} events from temp log.`);
      return events;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        Logger.verbose('SmartAssign', 1, `[EventLogger] Failed to load temp events: ${err.message}`);
      }
      return [];
    }
  }

  /**
   * Cleans up timers and pending I/O on plugin unmount.
   */
  cleanup() {
    if (this._batchFlushTimer) {
      clearInterval(this._batchFlushTimer);
      this._batchFlushTimer = null;
    }
    this._eventBatch = [];
  }
}
