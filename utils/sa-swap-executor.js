/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                    SA-SWAP-EXECUTOR v1.0.0                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Reliable background queue for executing RCON team switches.
 * Uses "One-Hit & Verify" logic to achieve verified swaps in <3s.
 *
 * ─── DESIGN DECISIONS: WHY "ONE-HIT & VERIFY"? ──────────────────
 *
 * 1. THE PROBLEM: Squad's RCON ListPlayers (which feeds server.players)
 *    polls every ~30s. If we wait for it to discover a newly joined
 *    player before moving them, we blow the <5s swap window entirely.
 *
 * 2. THE SOLUTION: Fire Blind. We get the SteamID from the Log Parser
 *    (which fires within ~100ms of join) and send the RCON move command
 *    before the player even appears in ListPlayers.
 *
 * 3. THE BOUNCE LOOP PROBLEM: A naive retry loop would see the stale
 *    player list, think the move failed, and spam RCON continuously —
 *    causing the player to bounce between teams every ~500ms.
 *
 * 4. THE FIX: State Locking ("One-Hit & Verify"). Send the RCON command
 *    ONCE, then set awaitingVerification = true. Force a fresh poll via
 *    updatePlayerList() and check the result. If it succeeded, emit
 *    success. If the player is still on the wrong team, unlock and retry
 *    (rare — means RCON rejected the first command). If the player has
 *    left the server, emit failed and clean up.
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
        commandSent: false,       // Tracks whether an RCON command has been sent (gates PRE-CHECK: prevents re-firing after command sent).
        awaitingVerification: false, // State lock: true while we wait for the post-command updatePlayerList() to resolve.
        startTime: Date.now()
      });

     Logger.verbose('SmartAssign', 4, `[SwapExecutor] Queued move for ${steamID} -> ${targetTeamID}`);

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
      for (const [sid, entry] of this.recentlyCompletedMoves.entries()) {
        if (entry.time < staleThreshold) this.recentlyCompletedMoves.delete(sid);
      }

      for (const [steamID, moveData] of this.pendingPlayerMoves.entries()) {
        try {
          if (now - moveData.startTime > this.options.maxCompletionTimeMs) {
            Logger.verbose('SmartAssign', 1, `[SwapExecutor] Timeout for ${steamID}`);
            this.server.emit('SMART_ASSIGN_MOVE_FAILED', { steamID, reason: 'Timeout' });
            playersToRemove.push(steamID);
            continue;
          }

          // PRE-CHECK: If the player is already on the correct team (e.g., game assigned them
          // correctly before we could act), skip the RCON command entirely.
          const player = this.server.players.find((p) => p.steamID === steamID);
          if (player && String(player.teamID) === String(moveData.targetTeamID) && !moveData.commandSent) {
            Logger.verbose('SmartAssign', 4, `[SwapExecutor] ${steamID} already on target team. No RCON needed.`);
            this.recentlyCompletedMoves.set(steamID, { targetTeamID: moveData.targetTeamID, time: now });
            playersToRemove.push(steamID);
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
             
             const playerAfterUpdate = this.server.players.find((p) => p.steamID === steamID);
             if (playerAfterUpdate && String(playerAfterUpdate.teamID) === String(moveData.targetTeamID)) {
                Logger.verbose('SmartAssign', 4, `[SwapExecutor] Success verified for ${steamID}`);
                this.server.emit('SMART_ASSIGN_MOVE_SUCCESS', { 
                   steamID, 
                   eosID: playerAfterUpdate.eosID, 
                   teamID: moveData.targetTeamID, 
                   name: playerAfterUpdate.name 
                });
                playersToRemove.push(steamID);
                this.recentlyCompletedMoves.set(steamID, { targetTeamID: moveData.targetTeamID, time: now });
                continue;
             } else if (playerAfterUpdate) {
                // Still on wrong team! Unlock for retry.
                // Before retrying, check if preempted by a higher-priority lock (e.g., TB scramble).
                const eosID = playerAfterUpdate.eosID;
                if (eosID && this._s3?.services?.players?.canAct) {
                  if (!this._s3.services.players.canAct(eosID, 'SmartAssign')) {
                    Logger.verbose('SmartAssign', 1, `[SwapExecutor] ${steamID} preempted by higher-priority lock — aborting retry.`);
                    this.server.emit('SMART_ASSIGN_MOVE_FAILED', { steamID, reason: 'PreemptedByLock' });
                    playersToRemove.push(steamID);
                    continue;
                  }
                }
                moveData.awaitingVerification = false; 
             } else {
                this.server.emit('SMART_ASSIGN_MOVE_FAILED', { steamID, reason: 'Disconnected' });
                playersToRemove.push(steamID);
                continue;
             }
          }

          moveData.attempts++;
          moveData.lastCommandTime = now;
          
          if (typeof this.server.rcon?.switchTeam === 'function') {
            const response = await this.server.rcon.switchTeam(steamID, moveData.targetTeamID);
            moveData.commandSent = true;
            moveData.awaitingVerification = true;
            
             // NOTE: This event fires on every command attempt including the first.
             // Event name: SMART_ASSIGN_MOVE_RETRY (legacy label, now aliased as COMMAND_SENT for clarity).
             // For public API consumers: treat this as a "command sent" event, not a retry indicator.
             // The event name will be deprecated in a future version in favor of SMART_ASSIGN_COMMAND_SENT.
             this.server.emit('SMART_ASSIGN_MOVE_RETRY', { 
               steamID, 
               attempt: moveData.attempts, 
               method: 'Await-Verification',
               response: response 
             });
          }
        } catch (err) {
          Logger.verbose('SmartAssign', 1, `[SwapExecutor] Error processing ${steamID}: ${err?.message}`);
        }
      }

      for (const sid of playersToRemove) this.pendingPlayerMoves.delete(sid);
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
