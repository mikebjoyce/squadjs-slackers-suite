/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                    SA-SWAP-EXECUTOR v0.1.9                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Reliable background queue for executing RCON team switches.
 * Squad's RCON frequently fails to move players if they are still in a loading
 * screen or during transition states like faction voting. This executor continuously
 * retries the move command until the player is successfully placed on their target team.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SASwapExecutor (default)
 *   Key methods:
 *     queueMove(steamID, targetTeamID)  — Adds a player to the swap queue.
 *     isRecentSmartAssignMove()         — Checks if a player recently moved.
 *     processRetries()                  — Loops through pending moves and retries RCON.
 *     cleanup()                         — Stops the background monitoring loop.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */
import Logger from '../../core/logger.js';

export default class SASwapExecutor {
  static RECENT_MOVE_WINDOW_MS = 15000;

  constructor(server, options = {}) {
    this.server = server;
    this.options = Object.assign({
      retryIntervalMs: 150,
      /**
       * DESIGN NOTE: Time-Bounded Retries
       * We rely strictly on maxCompletionTimeMs rather than an arbitrary attempt limit
       * to allow the executor to rapidly poll the engine as fast as the configured
       * retry interval permits within the defined window.
       */
      maxCompletionTimeMs: 3000
    }, options);
    
    this.pendingPlayerMoves = new Map();
    this.recentlyCompletedMoves = new Map();
    this.retryTimer = null;
    this.isProcessing = false;
  }

  isRecentSmartAssignMove(steamID, newTeamID) {
    if (this.pendingPlayerMoves.has(steamID)) {
      const move = this.pendingPlayerMoves.get(steamID);
      if (String(move.targetTeamID) === String(newTeamID)) return true;
    }
    const recent = this.recentlyCompletedMoves.get(steamID);
    if (recent && String(recent.targetTeamID) === String(newTeamID) && Date.now() - recent.time < SASwapExecutor.RECENT_MOVE_WINDOW_MS) {
      return true;
    }
    return false;
  }

  queueMove(steamID, targetTeamID) {
    if (!steamID || !targetTeamID) return;
    if (this.pendingPlayerMoves.has(steamID)) return;

    this.pendingPlayerMoves.set(steamID, {
      targetTeamID,
      attempts: 0,
      startTime: Date.now()
    });

    Logger.verbose('SmartAssign', 4, `[SwapExecutor] Queued smart-assign move for ${steamID} -> ${targetTeamID}`);

    if (!this.retryTimer) {
      this.startMonitoring();
    } else {
      // Trigger an immediate pass for the new player if we are already monitoring
      this.processRetries().catch((err) => {
        Logger.verbose('SmartAssign', 2, `[SwapExecutor] Queued retry error: ${err?.message || 'Unknown'}`);
      });
    }
  }

  startMonitoring() {
    Logger.verbose('SmartAssign', 4, '[SwapExecutor] Starting monitoring loop');

    // Immediate first pass
    this.processRetries().catch((err) => {
      Logger.verbose('SmartAssign', 1, `[SwapExecutor] Error in initial retry loop: ${err?.message || err}`);
    });

    this.retryTimer = setInterval(() => {
      this.processRetries().catch((err) => {
        Logger.verbose('SmartAssign', 1, `[SwapExecutor] Error in retry loop: ${err?.message || err}`);
      });
    }, this.options.retryIntervalMs || 500);
  }

  async processRetries() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const now = Date.now();
      
      // Prune stale entries to prevent memory leaks on long-running servers
      const staleThreshold = now - SASwapExecutor.RECENT_MOVE_WINDOW_MS;
      for (const [sid, entry] of this.recentlyCompletedMoves.entries()) {
        if (entry.time < staleThreshold) this.recentlyCompletedMoves.delete(sid);
      }

      const playersToRemove = [];
      const currentPlayers = this.server.players;

      for (const [steamID, moveData] of this.pendingPlayerMoves.entries()) {
        try {
          if (now - moveData.startTime > this.options.maxCompletionTimeMs) {
            Logger.verbose('SmartAssign', 1, `[SwapExecutor] Move timeout for ${steamID}`);
            this.server.emit('SMART_ASSIGN_MOVE_FAILED', { steamID, reason: 'Timeout' });
            playersToRemove.push(steamID);
            continue;
          }

          const player = currentPlayers.find((p) => p.steamID === steamID);
          if (!player) {
            // Player disconnected before we could assign them
            Logger.verbose('SmartAssign', 2, `[SwapExecutor] Player ${steamID} disconnected before move`);
            this.server.emit('SMART_ASSIGN_MOVE_FAILED', { steamID, reason: 'Disconnected' });
            playersToRemove.push(steamID);
            continue;
          }

          if (String(player.teamID) === String(moveData.targetTeamID)) {
            Logger.verbose('SmartAssign', 4, `[SwapExecutor] Verified ${steamID} is now on team ${moveData.targetTeamID}`);
            this.server.emit('SMART_ASSIGN_MOVE_SUCCESS', { steamID, teamID: moveData.targetTeamID });
            playersToRemove.push(steamID);
            this.recentlyCompletedMoves.set(steamID, { targetTeamID: moveData.targetTeamID, time: now });
            continue;
          }

          moveData.attempts++;
          try {
            if (typeof this.server.rcon?.switchTeam === 'function') {
              await this.server.rcon.switchTeam(steamID, moveData.targetTeamID);
              this.server.emit('SMART_ASSIGN_MOVE_RETRY', { steamID, attempt: moveData.attempts, method: 'switchTeam' });
            } else {
              Logger.verbose('SmartAssign', 1, `[SwapExecutor] RCON commands unavailable for ${steamID}.`);
            }
          } catch (err) {
            Logger.verbose('SmartAssign', 2, `[SwapExecutor] Move attempt ${moveData.attempts} failed for ${steamID}: ${err?.message || err}`);
          }
        } catch (err) {
          Logger.verbose('SmartAssign', 1, `[SwapExecutor] Error processing ${steamID}: ${err?.message || err}`);
          this.server.emit('SMART_ASSIGN_MOVE_FAILED', { steamID, reason: `Error: ${err?.message || err}` });
          playersToRemove.push(steamID);
        }
      }

      for (const sid of playersToRemove) this.pendingPlayerMoves.delete(sid);

      if (this.pendingPlayerMoves.size === 0) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
      }
    } finally {
      this.isProcessing = false;
    }
  }

  cleanup() {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.pendingPlayerMoves.clear();
    this.recentlyCompletedMoves.clear();
  }
}
