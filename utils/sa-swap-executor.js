import Logger from '../../core/logger.js';

export default class SASwapExecutor {
  constructor(server, options = {}) {
    this.server = server;
    this.options = options;
    
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
    if (recent && String(recent.targetTeamID) === String(newTeamID) && Date.now() - recent.time < 15000) {
      return true;
    }
    return false;
  }

  queueMove(steamID, targetTeamID) {
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
      this.processRetries().catch(() => {});
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
      const playersToRemove = [];
      const currentPlayers = this.server.players;

      for (const [steamID, moveData] of this.pendingPlayerMoves.entries()) {
        try {
          if (now - moveData.startTime > (this.options.maxCompletionTimeMs || 3000)) {
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
            playersToRemove.push(steamID);
            this.recentlyCompletedMoves.set(steamID, { targetTeamID: moveData.targetTeamID, time: now });
            continue;
          }

          moveData.attempts++;
          const maxRconAttempts = this.options.maxAttempts || 6;

          if (moveData.attempts <= maxRconAttempts) {
            try {
              // Force switch to target team
              await this.server.rcon.switchTeam(steamID, moveData.targetTeamID);
            } catch (err) {
              Logger.verbose('SmartAssign', 2, `[SwapExecutor] Move attempt ${moveData.attempts} failed for ${steamID}: ${err?.message || err}`);
            }
          } else {
            Logger.verbose('SmartAssign', 1, `[SwapExecutor] Max attempts reached for ${steamID}`);
            this.server.emit('SMART_ASSIGN_MOVE_FAILED', { steamID, reason: 'Max attempts reached' });
            playersToRemove.push(steamID);
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
