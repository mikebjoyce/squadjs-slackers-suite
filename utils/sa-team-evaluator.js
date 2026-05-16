/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                   SA-TEAM-EVALUATOR v2.0.0                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Pure functional module for team assignment scoring and evaluation.
 * No side effects, no state ownership. All state is passed as arguments.
 * Provides a 3-metric Composite Scoring System aligned with TeamBalancer's
 * algorithm for competitive balance:
 *   - Mean ELO difference
 *   - Top-15 ELO difference (high-skill parity)
 *   - Veteran parity (experience distribution)
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * evaluateTeamAssignment(player, server, context) [async]
 *   — Core algorithm that returns { targetTeam, reason }
 *
 * getRating(player, eloTracker) [async]
 *   — Retrieves player { mu, roundsPlayed } with fallback to defaults
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
 *   3.5 Clan Grouping → clan team if ALL mates there and cap allows
 *   4. Composite Skill Balance → best 3-metric score
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
const REGULAR_MIN_ROUNDS = 10;  // Veteran threshold

/**
 * Evaluates and returns the best team (1 or 2) for a joining player.
 * Uses a 3-metric Composite Scoring System to balance skill, veterancy,
 * and population equity.
 *
 * @param {object} player - Player object with steamID, name, teamID, eosID, etc.
 * @param {object} server - Server object with .players array
 * @param {object} context - Context object containing:
 *   {
 *     reconnectTeam: number|null,           // 1, 2, or null if no reconnect
 *     pendingAssignments: { 1: number, 2: number },
 *     pendingMu: { 1: number, 2: number },
 *     pendingVeterans: { 1: number, 2: number }, // NEW: veteran count per team
 *     pendingPlayerMoves: Map<steamID, ...>,
 *     eloTracker: EloTracker | null,
 *     ignoredModes: string[],               // Lowercase gamemode substrings to skip
 *     playerTagCache: Map<eosID, tag|null>, // Clan tag cache (optional)
 *     clanGroupOptions: { minSize, caseSensitive }, // Clan grouping options
 *     warnFlags: { eloNotReadyWarned: boolean }
 *   }
 * @returns {Promise<object>} { targetTeam: 1|2|null, reason: string }
 */
export async function evaluateTeamAssignment(player, server, context) {
   const {
     reconnectTeam = null,
     pendingAssignments = { 1: 0, 2: 0 },
     pendingMu = { 1: 0, 2: 0 },
     pendingVeterans = { 1: 0, 2: 0 },
     pendingPlayerMoves = new Map(),
     eloTracker = null,
     ignoredModes = [],
     playerTagCache = null,
     clanGroupOptions = { minSize: 2, caseSensitive: false },
     warnFlags = { eloNotReadyWarned: false }
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

  const hasElo = eloTracker && eloTracker.ready && typeof eloTracker.getRating === 'function';

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
  let t1Veterans = pendingVeterans[1] || 0;
  let t2Veterans = pendingVeterans[2] || 0;

  // Arrays to store individual Mu values for top-15 calculation
  let t1Mus = [];
  let t2Mus = [];

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
       if (hasElo) {
         const rating = await getRating(p, eloTracker);
         t1Power += rating.mu;
         t1Mus.push(rating.mu);
         if (rating.roundsPlayed >= REGULAR_MIN_ROUNDS) {
           t1Veterans++;
         }
       }
     } else if (teamID === '2') {
       t2Count++;
       if (hasElo) {
         const rating = await getRating(p, eloTracker);
         t2Power += rating.mu;
         t2Mus.push(rating.mu);
         if (rating.roundsPlayed >= REGULAR_MIN_ROUNDS) {
           t2Veterans++;
         }
       }
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
    let debugClanTeam = null;
    if (playerTagCache) {
      const clanTeam = getClanTeamForPlayer(player, playerTagCache, server.players, clanGroupOptions);
      debugClanTeam = clanTeam; // Track for debugging
      if (clanTeam) {
        const clanCount = clanTeam === 1 ? t1Count : t2Count;
        const opponentCount = clanTeam === 1 ? t2Count : t1Count;
         // Check that adding this player to the clan team doesn't violate the population cap
         // Grant clan grouping the same extra imbalance allowance as reconnect gets
         const effectiveClanImbalance = Math.min(4, maxImbalance + 1);
        if ((clanCount + 1) - opponentCount <= effectiveClanImbalance) {
         Logger.verbose('SmartAssign', 3, `[Clan Grouping] Routing ${player.name} to Team ${clanTeam} (all clan mates on that team)`);
         return { targetTeam: clanTeam, reason: 'Clan Grouping', debugInfo: { playerTag: playerTagCache.get(player.eosID), clanTeam } };
       } else {
         debugClanTeam = 'blocked';
         Logger.verbose('SmartAssign', 3, `[Clan Grouping] Clan team ${clanTeam} would violate pop cap for ${player.name}. Falling through to composite skill balance.`);
       }
     }
   }

  // 3. SKILL & COMPOSITE BALANCE EVALUATION
  if (!hasElo) {
    const targetTeam = t1Count <= t2Count ? 1 : 2;
    return { targetTeam, reason: `Population Balance (No Elo) | T1:${t1Count} T2:${t2Count}` };
  }

    const playerRating = await getRating(player, eloTracker);
    const playerMu = playerRating.mu;
    const playerIsVeteran = playerRating.roundsPlayed >= REGULAR_MIN_ROUNDS;

    // Default: When a team has no players, avgT1/avgT2 is set to 25.0 (TrueSkill default Mu)
    // rather than 0. This prevents division-by-zero and represents a "neutral skill baseline".
    const avgT1 = t1Count > 0 ? (t1Power / t1Count) : 25.0;
    const avgT2 = t2Count > 0 ? (t2Power / t2Count) : 25.0;

    const newAvgT1 = (t1Power + playerMu) / (t1Count + 1);
    const newAvgT2 = (t2Power + playerMu) / (t2Count + 1);

    // Build Mu arrays for both teams AFTER adding player
    const candidateMusT1 = [...t1Mus, playerMu];
    const candidateMusT2 = [...t2Mus, playerMu];

    // SCORING FUNCTION: 3-metric composite system aligned with TeamBalancer
    // Metrics:
    //   1. meanDiff (weight 0.6x): Average Mu difference between teams
    //   2. top15Diff (weight 0.4x): Top-15 average Mu difference
    //   3. veteranPenalty (fixed 300x): Ratio imbalance of experienced players
    const getScore = (candidateMus, opponentMus, candidateVets, opponentVets, candidateCount, opponentCount) => {
      // Metric 1: Mean ELO difference
      const getMean = (mus) => mus.length > 0 ? mus.reduce((a, b) => a + b, 0) / mus.length : 25.0;
      const meanT1 = getMean(candidateMus);
      const meanT2 = getMean(opponentMus);
      const meanDiff = Math.abs(meanT1 - meanT2);

      // Metric 2: Top-15 ELO difference (or all if fewer than 15 per side)
      const getTop15Avg = (mus) => {
        if (mus.length === 0) return 25.0;
        const sorted = [...mus].sort((a, b) => b - a);
        const slice = sorted.slice(0, 15);
        return slice.reduce((a, b) => a + b, 0) / slice.length;
      };
      const top15T1 = getTop15Avg(candidateMus);
      const top15T2 = getTop15Avg(opponentMus);
      const top15Diff = Math.abs(top15T1 - top15T2);

      // Composite ELO penalty (matches TeamBalancer exactly)
      const compositeDiff = 0.6 * meanDiff + 0.4 * top15Diff;
      const eloBalancePenalty = getPenalty(compositeDiff);

      // Metric 3: Veteran parity penalty
      const vet1Ratio = candidateCount > 0 ? candidateVets / candidateCount : 0;
      const vet2Ratio = opponentCount > 0 ? opponentVets / opponentCount : 0;
      const veteranPenalty = Math.abs(vet1Ratio - vet2Ratio) * 300;

      return eloBalancePenalty + veteranPenalty;
    };

    // Non-linear penalty curve (matches TeamBalancer)
    const getPenalty = (diff) => {
      if (diff <= 0.1) return diff * 20;
      if (diff <= 0.3) return 2.0 + (diff - 0.1) * 40;
      if (diff <= 0.6) return 10.0 + (diff - 0.3) * 80;
      return 34.0 + (diff - 0.6) * 150;
    };

    // Calculate scores for both placements
    const scoreT1 = getScore(candidateMusT1, t2Mus, t1Veterans + (playerIsVeteran ? 1 : 0), t2Veterans, t1Count + 1, t2Count);
    const scoreT2 = getScore(t1Mus, candidateMusT2, t1Veterans, t2Veterans + (playerIsVeteran ? 1 : 0), t1Count, t2Count + 1);

    // Rejoin bias: if reconnect priority was blocked by hard pop cap, apply a small score reduction
    // toward the player's previous team. Only tips near-ties.
    let scoreT1Biased = scoreT1;
    let scoreT2Biased = scoreT2;
    if (isRejoin) {
      const REJOIN_BIAS = 0.25;
      if (reconnectTeam === 1) scoreT1Biased = Math.max(0, scoreT1 - REJOIN_BIAS);
      else if (reconnectTeam === 2) scoreT2Biased = Math.max(0, scoreT2 - REJOIN_BIAS);
    }

    let targetTeam;
    if (scoreT1Biased < scoreT2Biased) {
      targetTeam = 1;
    } else if (scoreT2Biased < scoreT1Biased) {
      targetTeam = 2;
    } else {
      // Simple population tie-breaker
      targetTeam = t1Count <= t2Count ? 1 : 2;
    }

    // Build detailed reason string with 3 metrics
    const meanT1 = getMean(candidateMusT1);
    const meanT2 = getMean(t2Mus);
    const top15T1 = getTop15Avg(candidateMusT1);
    const top15T2 = getTop15Avg(t2Mus);
    const vet1Ratio = (t1Count + 1) > 0 ? (t1Veterans + (playerIsVeteran && targetTeam === 1 ? 1 : 0)) / (t1Count + 1) : 0;
    const vet2Ratio = (t2Count) > 0 ? (t2Veterans + (playerIsVeteran && targetTeam === 2 ? 1 : 0)) / (t2Count) : 0;

    const reason = `Composite: Mean=${meanDiff.toFixed(2)} Top15=${top15Diff.toFixed(2)} VetRatio=${Math.abs(vet1Ratio - vet2Ratio).toFixed(3)} | Scores: T1=${scoreT1Biased.toFixed(2)} T2=${scoreT2Biased.toFixed(2)} | Pop: ${t1Count}v${t2Count}`;

    // Helper functions for reason string
    function getMean(mus) {
      return mus.length > 0 ? mus.reduce((a, b) => a + b, 0) / mus.length : 25.0;
    }
    function getTop15Avg(mus) {
      if (mus.length === 0) return 25.0;
      const sorted = [...mus].sort((a, b) => b - a);
      const slice = sorted.slice(0, 15);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    }
    const meanDiff = Math.abs(getMean(candidateMusT1) - getMean(t2Mus));
    const top15Diff = Math.abs(getTop15Avg(candidateMusT1) - getTop15Avg(t2Mus));

    // Always include debug info about clan status for logging
    const playerTag = playerTagCache ? playerTagCache.get(player.eosID) : null;
    const debugInfo = { playerTag, clanTeam: debugClanTeam };

    return { targetTeam, reason, debugInfo };
}

/**
 * Retrieves player rating (mu and roundsPlayed) from EloTracker with fallback defaults.
 * Delegates to EloTracker's async getRating() which handles cache-first + DB lookup.
 *
 * @param {object} player - Player object with steamID, eosID, etc.
 * @param {object} eloTracker - EloTracker plugin instance
 * @returns {Promise<object>} { mu, roundsPlayed } — both with defaults if not found
 */
export async function getRating(player, eloTracker = null) {
  if (!eloTracker) return { mu: 25.0, roundsPlayed: 0 };

  try {
    return await eloTracker.getRating(player);
  } catch (e) {
    Logger.verbose('SmartAssign', 2, `[getRating] eloTracker.getRating() threw for ${player.steamID}: ${e?.message}. Using defaults.`);
    return { mu: 25.0, roundsPlayed: 0 };
  }
}
