/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                     SA-SWAP-EXECUTOR                          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Reliable background queue for executing RCON team switches.
 * Uses "One-Hit & Verify" logic to fire the RCON move command
 * immediately on join (before the player appears in ListPlayers),
 * then force-poll to verify the result. Achieves verified swaps
 * in <3s while preventing bounce-loops via state locking.
 *
 * RCON commands use player name as the identifier (per
 * RCON_IDENTIFIER_FINDINGS.md, June 2026) since it is the only
 * universally reliable RCON identifier on this Squad server version.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SASwapExecutor (class)
 *   Constructor accepts (server, config).
 *   Key public methods:
 *     queueMove(playerKey, playerName, eosID, targetTeamID)
 *       — Enqueues a player for team switch via RCON.
 *     cleanup()
 *       — Clears the move queue and resets state on plugin unmount.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Logger (../../core/logger.js)
 *   Verbose logging from SquadJS core.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - "Fire Blind" strategy: the RCON command is sent before the player
 *   is visible in ListPlayers, using data from the Log Parser (~100ms
 *   after join) to hit the <5s swap window.
 * - State locking prevents bounce-loops: awaitingVerification flag
 *   ensures only one RCON command is in-flight per player. If
 *   verification fails, the retry branch triggers a forced S³ player
 *   list refresh (if S³ is available) before re-attempting.
 * - Identifier cascade: name → eosID → steamID. name is used for RCON
 *   commands; eosID/steamID are used for player lookups and move tracking.
 * - queueMove() accepts (playerKey, playerName, eosID, targetTeamID).
 *   playerKey is typically eosID || steamID and is used internally for
 *   move tracking and duplicate detection.
 *
 * ═══════════════════════════════════════════════════════════════
 */
import Logger from '../../core/logger.js';

export default class SASwapExecutor {
  static RECENT_MOVE_WINDOW_MS = 15000;

  constructor(server, options = {}) {
    this.server = server;
    this.options = Object.assign({
      retryIntervalMs: 500,
      /**
       * JOIN SWAP TIMEOUT:
       * 3s is the hard limit for join-swaps to ensure players don't
       * experience a jarring team change after they've already started.
       */
      maxCompletionTimeMs: 3000
    }, options);
    
    this.pendingPlayerMoves = new Map();
    this.recentlyCompletedMoves = new Map();
    this.retryTimer = null;
    this.isProcessing = false;
    this._s3 = options.s3 || null;  // S³ reference for canAct preemption check
  }

  /**
   * Checks if a recent SmartAssign move matches the specified player/team.
   * Uses dual-key (eosID || steamID) lookup to handle EOS-only players.
   * @param {string} playerKey - eosID || steamID
   * @param {string|number} newTeamID - Target team (1 or 2)
   * @returns {boolean}
   */
  isRecentSmartAssignMove(playerKey, newTeamID) {
    if (this.pendingPlayerMoves.has(playerKey)) {
      const move = this.pendingPlayerMoves.get(playerKey);
      if (String(move.targetTeamID) === String(newTeamID)) return true;
    }
    const recent = this.recentlyCompletedMoves.get(playerKey);
    if (recent && String(recent.targetTeamID) === String(newTeamID) && Date.now() - recent.time < SASwapExecutor.RECENT_MOVE_WINDOW_MS) {
      return true;
    }
    return false;
  }

  /**
   * Queue a player move for execution.
   * Uses player.name as the RCON identifier (per RCON_IDENTIFIER_FINDINGS.md).
   * 
   * @param {string} playerKey - eosID || steamID (deduplication key)
   * @param {string} playerName - Player display name (RCON identifier — guaranteed working)
   * @param {string} eosID - Player's EOS ID (for S³ canAct lookups)
   * @param {string|number} targetTeamID - Target team (1 or 2)
   */
  queueMove(playerKey, playerName, eosID, targetTeamID) {
    if (!playerKey || !playerName || !targetTeamID) {
      Logger.verbose('SmartAssign', 4, `[SwapExecutor] queueMove skipped: missing playerKey=${!!playerKey}, playerName=${!!playerName}, targetTeamID=${!!targetTeamID}`);
      return;
    }
    if (this.pendingPlayerMoves.has(playerKey)) return;

    this.pendingPlayerMoves.set(playerKey, {
      playerName,
      eosID,
      targetTeamID,
      attempts: 0,
      commandSent: false,
      awaitingVerification: false,
      startTime: Date.now()
    });

    Logger.verbose('SmartAssign', 4, `[SwapExecutor] Queued move for ${playerName} (${playerKey}) -> ${targetTeamID}`);

    if (!this.retryTimer) {
      this.startMonitoring();
    }
    
    // Fire the first RCON command immediately instead of waiting for the first timer tick.
    // This eliminates the 0-150ms initial delay, reducing the join-swap window significantly.
    this.processRetries().catch((err) => {
      Logger.verbose('SmartAssign', 2, `[SwapExecutor] First-fire error: ${err?.message}`);
    });
  }

  startMonitoring() {
    this.retryTimer = setInterval(() => {
      this.processRetries().catch((err) => {
        Logger.verbose('SmartAssign', 1, `[SwapExecutor] Loop error: ${err?.message}`);
      });
    }, this.options.retryIntervalMs);
  }

  async processRetries() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const now = Date.now();
      const playersToRemove = [];
      
      const staleThreshold = now - SASwapExecutor.RECENT_MOVE_WINDOW_MS;
      for (const [key, entry] of this.recentlyCompletedMoves.entries()) {
        if (entry.time < staleThreshold) this.recentlyCompletedMoves.delete(key);
      }

      for (const [playerKey, moveData] of this.pendingPlayerMoves.entries()) {
        try {
          if (now - moveData.startTime > this.options.maxCompletionTimeMs) {
            Logger.verbose('SmartAssign', 1, `[SwapExecutor] Timeout for ${playerKey}`);
            this.server.emit('SMART_ASSIGN_MOVE_FAILED', { playerKey, playerName: moveData.playerName, reason: 'Timeout' });
            playersToRemove.push(playerKey);
            continue;
          }

          // PRE-CHECK: If the player is already on the correct team (e.g., game assigned them
          // correctly before we could act), skip the RCON command entirely.
          const player = this.server.players.find((p) => (p.eosID || p.steamID) === playerKey);
          if (player && String(player.teamID) === String(moveData.targetTeamID) && !moveData.commandSent) {
            Logger.verbose('SmartAssign', 4, `[SwapExecutor] ${moveData.playerName} already on target team. No RCON needed.`);
            this.recentlyCompletedMoves.set(playerKey, { targetTeamID: moveData.targetTeamID, time: now });
            playersToRemove.push(playerKey);
            continue;
          }

          // VERIFICATION LOGIC:
          // After sending the RCON command, we force a fresh player list poll and check
          // the result. Three outcomes:
          //   a) Correct team  → emit success, remove from queue.
          //   b) Wrong team    → unlock (awaitingVerification = false) so the command retries.
          //   c) Not in list   → player disconnected; emit failed, remove from queue.
          if (moveData.awaitingVerification) {
             await this.server.updatePlayerList();
             
             const playerAfterUpdate = this.server.players.find((p) => (p.eosID || p.steamID) === playerKey);
             if (playerAfterUpdate && String(playerAfterUpdate.teamID) === String(moveData.targetTeamID)) {
                Logger.verbose('SmartAssign', 4, `[SwapExecutor] Success verified for ${moveData.playerName}`);
                this.server.emit('SMART_ASSIGN_MOVE_SUCCESS', { 
                   playerKey,
                   eosID: playerAfterUpdate.eosID, 
                   teamID: moveData.targetTeamID, 
                   name: playerAfterUpdate.name 
                });
                playersToRemove.push(playerKey);
                this.recentlyCompletedMoves.set(playerKey, { targetTeamID: moveData.targetTeamID, time: now });
                continue;
             } else if (playerAfterUpdate) {
                // Still on wrong team! Unlock for retry.
                // Before retrying, check if preempted by a higher-priority lock (e.g., TB scramble).
                const eosID = playerAfterUpdate.eosID;
                if (eosID && this._s3?.services?.players?.canAct) {
                  if (!this._s3.services.players.canAct(eosID, 'SmartAssign')) {
                    Logger.verbose('SmartAssign', 1, `[SwapExecutor] ${moveData.playerName} preempted by higher-priority lock — aborting retry.`);
                    this.server.emit('SMART_ASSIGN_MOVE_FAILED', { playerKey, playerName: moveData.playerName, reason: 'PreemptedByLock' });
                    playersToRemove.push(playerKey);
                    continue;
                  }
                }
                moveData.awaitingVerification = false; 
             } else {
                this.server.emit('SMART_ASSIGN_MOVE_FAILED', { playerKey, playerName: moveData.playerName, reason: 'Disconnected' });
                playersToRemove.push(playerKey);
                continue;
             }
          }

          moveData.attempts++;
          moveData.lastCommandTime = now;

          // RCON IDENTIFIER MIGRATION (v1.0.1):
          // Use player.name for AdminForceTeamChange (confirmed working per RCON_IDENTIFIER_FINDINGS.md).
          // Wrap in quotes for compatibility with names containing spaces.
          if (moveData.playerName) {
            const command = `AdminForceTeamChange "${moveData.playerName}"`;
            const response = await this.server.rcon.execute(command);
            moveData.commandSent = true;
            moveData.awaitingVerification = true;
            
            Logger.verbose('SmartAssign', 3, `[SwapExecutor] RCON sent: ${command} -> ${JSON.stringify(response)}`);
            
            this.server.emit('SMART_ASSIGN_MOVE_RETRY', { 
              playerKey,
              playerName: moveData.playerName,
              attempt: moveData.attempts,
              method: 'Name-based (v1.0.1)',
              response
            });
          } else {
            Logger.verbose('SmartAssign', 2, `[SwapExecutor] No player name available for ${playerKey} — cannot send RCON.`);
          }
        } catch (err) {
          Logger.verbose('SmartAssign', 1, `[SwapExecutor] Error processing ${playerKey}: ${err?.message}`);
        }
      }

      for (const key of playersToRemove) this.pendingPlayerMoves.delete(key);
      if (this.pendingPlayerMoves.size === 0 && this.retryTimer) {
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
