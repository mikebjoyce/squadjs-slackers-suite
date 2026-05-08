/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                   SA-TEAM-EVALUATOR v0.3.0                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Pure functional module for team assignment scoring and evaluation.
 * No side effects, no state ownership. All state is passed as arguments.
 * Provides the core Elo-based Unified Scoring System for competitive balance.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * evaluateTeamAssignment(player, server, context)
 *   — Core algorithm that returns { targetTeam, reason }
 *
 * getMuFast(player, eloTracker, warnFlags)
 *   — Retrieves player Mu rating from cache or API, with fallback
 *
 * ─── CLAN GROUPING ────────────────────────────────────────────────
 *
 * SmartAssign can now group clan members on join to keep them together,
 * provided it doesn't violate hard population caps or size parity.
 * This is step 3.5 in the priority hierarchy:
 *
 *   1. Hard Pop Cap → forced team or both-ok
 *   2. Physical Server Cap → forced team or both-ok
 *   3.0 Reconnect Priority → previous team if cap allows
 *   3.5 Clan Grouping [NEW] → clan team if ALL mates there and cap allows
 *   4. Elo Scoring → best skill-balanced team
 *   5. Population tie-break → smaller team
 *
 * ─── DESIGN NOTES ─────────────────────────────────────────────────
 *
 * All functions are pure (deterministic, no side effects).
 * Caller is responsible for:
 *   - Managing state (pendingAssignments, reconnectMemory, etc.)
 *   - Passing state as arguments
 *   - Handling any warning flags that need tracking (eloNotReadyWarned, etc.)
 *
 * This allows unit testing without a full plugin mount.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Logger from '../../core/logger.js';
import { getClanTeamForPlayer } from './sa-clan-grouper.js';

const MAX_TEAM_SIZE = 50;

/**
 * Evaluates and returns the best team (1 or 2) for a joining player.
 * Uses a Mu-based Unified Scoring System to balance competitive parity,
 * population equity, and player preference (reconnects).
 *
 * @param {object} player - Player object with steamID, name, teamID, eosID, etc.
 * @param {object} server - Server object with .players array
 * @param {object} context - Context object containing:
 *   {
 *     reconnectTeam: number|null,           // 1, 2, or null if no reconnect
 *     pendingAssignments: { 1: number, 2: number },
 *     pendingMu: { 1: number, 2: number },
 *     pendingPlayerMoves: Map<steamID, ...>,
 *     eloTracker: EloTracker | null,
 *     ignoredModes: string[],               // Lowercase gamemode substrings to skip
 *     playerTagCache: Map<eosID, tag|null>, // Clan tag cache (optional)
 *     clanGroupOptions: { minSize, caseSensitive }, // Clan grouping options
 *     warnFlags: { eloNotReadyWarned: boolean, muFastMissWarned: boolean }
 *   }
 * @returns {object} { targetTeam: 1|2|null, reason: string }
 */
export function evaluateTeamAssignment(player, server, context) {
  const {
    reconnectTeam = null,
    pendingAssignments = { 1: 0, 2: 0 },
    pendingMu = { 1: 0, 2: 0 },
    pendingPlayerMoves = new Map(),
    eloTracker = null,
    ignoredModes = [],
    playerTagCache = null,
    clanGroupOptions = { minSize: 2, caseSensitive: false },
    warnFlags = { eloNotReadyWarned: false, muFastMissWarned: false }
  } = context;

  // Check if current layer/gamemode is ignored
  const currentLayerName = server.currentLayer && server.currentLayer.name
    ? String(server.currentLayer.name).toLowerCase()
    : '';
  const currentGamemode = server.currentLayer && server.currentLayer.gamemode
    ? String(server.currentLayer.gamemode).toLowerCase()
    : '';

  const isIgnored = ignoredModes.some(
    m => currentLayerName.includes(m) || currentGamemode.includes(m)
  );

  if (isIgnored) {
    return { targetTeam: null, reason: 'Ignored Gamemode' };
  }

  const hasElo = eloTracker && eloTracker.ready && typeof eloTracker.getMu === 'function';

  if (eloTracker && !eloTracker.ready) {
    if (!warnFlags.eloNotReadyWarned) {
      Logger.verbose('SmartAssign', 1, '[TeamEvaluator] EloTracker present but not ready — falling back to population-only routing.');
      warnFlags.eloNotReadyWarned = true;
    }
  } else if (eloTracker && eloTracker.ready && warnFlags.eloNotReadyWarned) {
    warnFlags.eloNotReadyWarned = false;
  }

  // 1. DATA COLLECTION (Single Pass Optimization)
  let t1Count = pendingAssignments[1] || 0;
  let t2Count = pendingAssignments[2] || 0;
  let t1Power = pendingMu[1] || 0;
  let t2Power = pendingMu[2] || 0;

  const players = server.players;
  const playerCount = players.length;

  for (let i = 0; i < playerCount; i++) {
    const p = players[i];
    if (!p || p.steamID === player.steamID) continue;

    // Ignore players currently pending a move since their future state is already in _pending.
    if (pendingPlayerMoves && pendingPlayerMoves.has(p.steamID)) continue;

    const teamID = String(p.teamID);
    if (teamID === '1') {
      t1Count++;
      if (hasElo) t1Power += getMuFast(p, eloTracker, warnFlags);
    } else if (teamID === '2') {
      t2Count++;
      if (hasElo) t2Power += getMuFast(p, eloTracker, warnFlags);
    }
  }

   // 2. HARD POPULATION CAP
   const totalPop = t1Count + t2Count;
   const isRejoin = reconnectTeam === 1 || reconnectTeam === 2;

   // Gradual Dynamic maxImbalance (tuned winner parameters)
   let maxImbalance;
   if (totalPop >= 96) maxImbalance = 1;
   else if (totalPop >= 90) maxImbalance = 2;
   else if (totalPop >= 82) maxImbalance = 3;
   else maxImbalance = 4;

   let effectiveMaxImbalance = maxImbalance;
   if (isRejoin) effectiveMaxImbalance = Math.min(4, maxImbalance + 1);

  if ((t1Count + 1) - t2Count > effectiveMaxImbalance) return { targetTeam: 2, reason: 'Hard Population Cap' };
  if ((t2Count + 1) - t1Count > effectiveMaxImbalance) return { targetTeam: 1, reason: 'Hard Population Cap' };

  // 2.1 PHYSICAL SERVER CAP (50)
  if (t1Count >= MAX_TEAM_SIZE && t2Count >= MAX_TEAM_SIZE) return { targetTeam: null, reason: 'Server Full' };
  if (t1Count >= MAX_TEAM_SIZE && t2Count < MAX_TEAM_SIZE) return { targetTeam: 2, reason: 'Team 1 Full' };
  if (t2Count >= MAX_TEAM_SIZE && t1Count < MAX_TEAM_SIZE) return { targetTeam: 1, reason: 'Team 2 Full' };

  // 3.0 RECONNECT PRIORITY ROUTING
  if (isRejoin) {
    const rejoinTarget = reconnectTeam;
    const rejoinCount = rejoinTarget === 1 ? t1Count : t2Count;
    const opponentCount = rejoinTarget === 1 ? t2Count : t1Count;
    if ((rejoinCount + 1) - opponentCount <= effectiveMaxImbalance) {
      return { targetTeam: rejoinTarget, reason: 'Reconnect Memory (Priority)' };
    }
  }

   // 3.5 CLAN GROUPING ROUTING
   // If player is in a clan and ALL clan mates are on one team (not split),
   // route the player there provided the population cap still allows it.
   if (playerTagCache) {
     const clanTeam = getClanTeamForPlayer(player, playerTagCache, server.players, clanGroupOptions);
     if (clanTeam) {
       const clanCount = clanTeam === 1 ? t1Count : t2Count;
       const opponentCount = clanTeam === 1 ? t2Count : t1Count;
        // Check that adding this player to the clan team doesn't violate the population cap
        // Grant clan grouping the same extra imbalance allowance as reconnect gets
        const effectiveClanImbalance = Math.min(4, maxImbalance + 1);
       if ((clanCount + 1) - opponentCount <= effectiveClanImbalance) {
        Logger.verbose('SmartAssign', 3, `[Clan Grouping] Routing ${player.name} to Team ${clanTeam} (all clan mates on that team)`);
        return { targetTeam: clanTeam, reason: 'Clan Grouping' };
      } else {
        Logger.verbose('SmartAssign', 3, `[Clan Grouping] Clan team ${clanTeam} would violate pop cap for ${player.name}. Falling through to Elo.`);
      }
    }
  }

  // 3. SKILL & PENALTY EVALUATION
  if (!hasElo) {
    const targetTeam = t1Count <= t2Count ? 1 : 2;
    return { targetTeam, reason: `Population Balance (No Elo) | T1:${t1Count} T2:${t2Count}` };
  }

   const playerMu = getMuFast(player, eloTracker, warnFlags);
   // EMPTY TEAM DEFAULT: When a team has no players, avgT1/avgT2 is set to 25.0 (TrueSkill default Mu)
   // rather than 0. This prevents division-by-zero and represents a "neutral skill baseline".
   // As a side effect, penalty scores will be non-zero even at 0v0 or 2v0 population — this is intentional
   // and correct behavior; the routing decision itself is not affected by the magnitude.
   const avgT1 = t1Count > 0 ? (t1Power / t1Count) : 25.0;
   const avgT2 = t2Count > 0 ? (t2Power / t2Count) : 25.0;

   const newAvgT1 = (t1Power + playerMu) / (t1Count + 1);
   const newAvgT2 = (t2Power + playerMu) / (t2Count + 1);

   // Dynamic scale: normalizes sum gap relative to current server population.
   // Tuned winner uses log scale: slower growth = stronger sum influence at high pop
   const dynamicScale = Math.max(1, Math.log(t1Count + t2Count + 2) * 2.5);

   // SCORING FUNCTION: Computes an imbalance penalty for placing the joining player on the candidate team.
   // Combines two gap metrics with empirically-tuned weights:
   //   - avgGap (weight 1.0x): Per-player skill fairness — difference in average skill between teams after placement
   //   - sumGap (weight 1.5x): Absolute power delta — difference in total skill, normalized by dynamic population scale
   // Lower score = better balance = preferable team. The algorithm always picks the team with the lower score.
   const getScore = (candidateAvg, opponentAvg, candidateSum, opponentSum) => {
     const avgGap = Math.abs(candidateAvg - opponentAvg);
     const sumGap = Math.abs(candidateSum - opponentSum) / dynamicScale;
     return (avgGap * 1.0) + (sumGap * 1.5);
   };

  let scoreT1 = getScore(newAvgT1, avgT2, t1Power + playerMu, t2Power);
  let scoreT2 = getScore(avgT1, newAvgT2, t1Power, t2Power + playerMu);

  // Rejoin bias: if reconnect priority was blocked by hard pop cap, apply a small score reduction
  // toward the player's previous team. Only tips near-ties.
  if (isRejoin) {
    const REJOIN_BIAS = 0.25;
    if (reconnectTeam === 1) scoreT1 = Math.max(0, scoreT1 - REJOIN_BIAS);
    else if (reconnectTeam === 2) scoreT2 = Math.max(0, scoreT2 - REJOIN_BIAS);
  }

   let targetTeam;
   if (scoreT1 < scoreT2) {
     targetTeam = 1;
   } else if (scoreT2 < scoreT1) {
     targetTeam = 2;
   } else {
     // Simple population tie-breaker
     targetTeam = t1Count <= t2Count ? 1 : 2;
   }

   // NOTE: T1/T2 in the reason string are IMBALANCE PENALTY SCORES, not Mu ratings or team skill summaries.
   // Lower score = better balance. The algorithm assigns to the team with the lower score.
   // At very low population these scores can appear large/non-zero even for empty teams
   // because the empty-team average defaults to 25.0 (see avgT1/avgT2 defaults above).
   // This is intentional and correct behavior — the routing decision is not affected by the magnitude.
   const reason = `Skill Balance: T1=${scoreT1.toFixed(3)}, T2=${scoreT2.toFixed(3)} | Pop: ${t1Count}v${t2Count}`;

  return { targetTeam, reason };
}

/**
 * Fast Mu retrieval bypassing heavy try/catch and redundant lookups.
 * Attempts to use EloTracker's internal caches before falling back to the public API.
 *
 * @param {object} player - Player object with steamID, eosID, etc.
 * @param {object} eloTracker - EloTracker plugin instance
 * @param {object} warnFlags - Object with { muFastMissWarned: boolean } to track warnings
 * @returns {number} Mu rating (default 25.0)
 */
export function getMuFast(player, eloTracker = null, warnFlags = {}) {
  if (!eloTracker) return 25.0;

  try {
    // Prioritize internal maps to bypass getter overhead/logic.
    // WARNING: These paths couple directly to EloTracker internals. If those
    // property names change, this silently degrades to the public getMu() fallback.
    if (eloTracker.eloCache && player.eosID) {
      const cached = eloTracker.eloCache.get(player.eosID);
      if (cached) return cached.mu;
      Logger.verbose('SmartAssign', 4, `[getMuFast] eloCache miss for eosID ${player.eosID}, falling through.`);
    }
    if (eloTracker.eloMap && player.steamID) {
      const mu = eloTracker.eloMap.get(player.steamID);
      if (mu !== undefined) return mu;
      Logger.verbose('SmartAssign', 3, `[getMuFast] eloMap miss for steamID ${player.steamID}, falling through.`);
    }

    // Both fast paths missed
    if (!warnFlags.muFastMissWarned) {
      Logger.verbose(
        'SmartAssign',
        2,
        '[getMuFast] Both fast paths missed. EloTracker internals may have changed. Falling back to getMu().'
      );
      warnFlags.muFastMissWarned = true;
    }

    // Fallback to official API
    return eloTracker.getMu(player);
  } catch (e) {
    Logger.verbose('SmartAssign', 2, `[getMuFast] getMu() threw for ${player.steamID}: ${e?.message}. Using default Mu.`);
    return 25.0;
  }
}
