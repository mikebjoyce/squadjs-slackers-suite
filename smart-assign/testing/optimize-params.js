// DEPRECATED — Stage 5: This script imports from sa-clan-grouper.js which was replaced by S³ ClansService.
// sa-clan-grouper.js has been deleted. This test/tool script cannot be migrated to S³ and is retained for reference only.

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              OPTIMIZE-PARAMS (SmartAssign)                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Parameter optimizer for SmartAssign's assignment algorithm.
 * Performs a coarse-then-fine grid search to find the parameter set
 * that minimises mean Mu gap (regret) between teams across all JOIN
 * events in historical match data.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/optimize-params.js <log.jsonl> [--elo <backup.json>] [--min-elo-coverage 0.5] [--top 5] [--pin param=value ...]
 *
 *   <log.jsonl>              Event log from sa-event-logger.js
 *   --elo <file.json>        Load real Mu values from EloTracker backup
 *   --min-elo-coverage <f>   Only rounds with ≥fraction JOINs having real Elo (default: 0.0)
 *   --top <N>                Top N coarse candidates for fine pass (default: 5)
 *   --pin param=value        Pin a parameter (e.g., --pin graceHigh=1 graceLow=2)
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - DEV-ONLY parameter tuning tool. Do NOT deploy to production.
 * - DEPRECATED: imports from sa-clan-grouper.js which was removed in
 *   Stage 5 (replaced by S³ ClansService). Retained for reference only.
 * - Scoring metric: regret = MuGap(chosen team) - MuGap(optimal team)
 *   per JOIN; round_score = mean(regret); total_score = mean(round_score).
 * - Outputs coarse & fine pass results, top 10 parameter sets, baseline
 *   comparison, per-round breakdown, and clan grouping effectiveness metrics.
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { extractRawPrefix } from '../utils/sa-clan-grouper.js';

const MAX_TEAM_SIZE = 50;
const DEFAULT_MU = 25.0;

// ─────────────────────────────────────────────────────────────────────────────
// Parameter space definition
// ─────────────────────────────────────────────────────────────────────────────

const PARAM_SPACE = {
  // Population cap tiers: hard limits on team size difference based on total pop
  // Constraint: tier1 ≤ tier2 ≤ tier3 ≤ tier4
  cap_tier1:      { name: 'Cap[94+]',   coarse: [2],             fine: [2] },
  cap_tier2:      { name: 'Cap[88-93]', coarse: [3],             fine: [3] },
  cap_tier3:      { name: 'Cap[80-87]', coarse: [4],             fine: [4] },
  cap_tier4:      { name: 'Cap[<80]',   coarse: [4],             fine: [4] },

  // Reconnect grace: policy-pinned by tier (high pop vs low pop)
  grace_highPop:  { name: 'Grace_HP',   coarse: [1],             fine: [1] },
  grace_lowPop:   { name: 'Grace_LP',   coarse: [2],             fine: [2] },
  grace_extra:    { name: 'Grace+',     coarse: [1],             fine: [1] },

  // Mu weighting in skill balancing: avg gap vs sum gap
  // Now searching mu_avgWeight across a range of values
  mu_avgWeight:   { name: 'AvgW',       coarse: [0.1, 0.25, 0.5, 1.0, 2.0],     fine: [0.1, 0.15, 0.25, 0.35, 0.5, 0.75, 1.0, 1.5, 2.0] },
  mu_sumWeight:   { name: 'SumW',       coarse: [0.25, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0, 9.5, 10.0, 10.5, 11.0, 11.5, 12.0],     fine: [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.25, 3.5, 3.75, 4.0, 4.25, 4.5, 4.75, 5.0, 5.25, 5.5, 5.75, 6.0, 6.25, 6.5, 6.75, 7.0, 7.25, 7.5, 7.75, 8.0, 8.25, 8.5, 8.75, 9.0, 9.25, 9.5, 9.75, 10.0, 10.25, 10.5, 10.75, 11.0, 11.25, 11.5, 11.75, 12.0] },

   // Sum weight population scaling: how to normalise the sum term as population grows
   // 'none'   = (t1 + t2 + 1) * 2.5 (linear dampening)
   // 'sqrt'   = Math.sqrt(t1 + t2 + 1) * C (slower growth, stronger sum influence at high pop)
   // 'log'    = Math.log(t1 + t2 + 1) * C (even slower, very strong sum influence)
   sumScale:       { name: 'Scale',      coarse: ['none', 'sqrt', 'log'],       fine: ['none', 'sqrt', 'log'] },
};

// ─────────────────────────────────────────────────────────────────────────────
// Sim state and evaluation
// ─────────────────────────────────────────────────────────────────────────────

function createSimState() {
  return {
    players:            new Map(), // steamID -> { steamID, teamID, mu }
    reconnectMemory:    new Map(), // steamID -> teamID (1|2)
    pendingAssignments: { 1: 0, 2: 0 },
    pendingMu:          { 1: 0, 2: 0 },
    pendingPlayerMoves: new Map(), // steamID -> { targetTeam, mu }
    moves:              0,
  };
}

/**
 * Parameterised evaluation function.
 * Mirrors SmartAssign.evaluateTeamAssignment() but tunable.
 */
function evaluate(state, player, reconnectTeam, params, roundTagMap) {
  let t1Count = state.pendingAssignments[1] || 0;
  let t2Count = state.pendingAssignments[2] || 0;
  let t1Power = state.pendingMu[1] || 0;
  let t2Power = state.pendingMu[2] || 0;

  for (const [sid, p] of state.players) {
    if (sid === player.steamID) continue;
    if (state.pendingPlayerMoves.has(sid)) continue;
    const tid = String(p.teamID);
    if (tid === '1') { t1Count++; t1Power += p.mu; }
    else if (tid === '2') { t2Count++; t2Power += p.mu; }
  }

  const totalPop = t1Count + t2Count;
  const isRejoin = reconnectTeam === 1 || reconnectTeam === 2;

  // 1. HARD POPULATION CAP (tunable tiers)
  let maxImbalance;
  if (totalPop >= 96) maxImbalance = params.cap_tier1;
  else if (totalPop >= 90) maxImbalance = params.cap_tier2;
  else if (totalPop >= 82) maxImbalance = params.cap_tier3;
  else maxImbalance = params.cap_tier4;

  let effectiveMaxImbalance = maxImbalance;
  if (isRejoin) {
    effectiveMaxImbalance = Math.min(4, maxImbalance + params.grace_extra);
  }

  if ((t1Count + 1) - t2Count > effectiveMaxImbalance) return { targetTeam: 2, reason: 'Hard Pop Cap' };
  if ((t2Count + 1) - t1Count > effectiveMaxImbalance) return { targetTeam: 1, reason: 'Hard Pop Cap' };
  if (t1Count >= MAX_TEAM_SIZE && t2Count >= MAX_TEAM_SIZE) return { targetTeam: null, reason: 'Server Full' };
  if (t1Count >= MAX_TEAM_SIZE) return { targetTeam: 2, reason: 'Team 1 Full' };
  if (t2Count >= MAX_TEAM_SIZE) return { targetTeam: 1, reason: 'Team 2 Full' };

  // 2. RECONNECT PRIORITY
  if (isRejoin) {
    const rejoinCount = reconnectTeam === 1 ? t1Count : t2Count;
    const opponentCount = reconnectTeam === 1 ? t2Count : t1Count;
    if ((rejoinCount + 1) - opponentCount <= effectiveMaxImbalance) {
      return { targetTeam: reconnectTeam, reason: 'Reconnect Memory (Priority)' };
    }
  }

   // 2.5 CLAN GROUPING
   if (params.enableClanGrouping && roundTagMap) {
     const joinerTag = roundTagMap.get(player.steamID);
     if (joinerTag) {
       let t1Clan = 0, t2Clan = 0;
       for (const [sid, p] of state.players) {
         if (sid === player.steamID) continue;
         if (state.pendingPlayerMoves.has(sid)) continue;
         const pTag = roundTagMap.get(sid);
         if (pTag === joinerTag) {
           if (String(p.teamID) === '1') t1Clan++;
           else if (String(p.teamID) === '2') t2Clan++;
         }
       }
       const minMates = 1;
       // Grant clan grouping the same grace allowance as the plugin (population-based)
       const effectiveClanImbalance = Math.min(4, maxImbalance + (totalPop >= 90 ? 1 : 2));
       if (t1Clan >= minMates && t2Clan === 0) {
         if ((t1Count + 1) - t2Count <= effectiveClanImbalance) return { targetTeam: 1, reason: 'Clan Grouping' };
       } else if (t2Clan >= minMates && t1Clan === 0) {
         if ((t2Count + 1) - t1Count <= effectiveClanImbalance) return { targetTeam: 2, reason: 'Clan Grouping' };
       }
     }
   }

  // 3. SKILL BALANCING (tunable Mu weights and sum scaling)
  const playerMu = player.mu;
  const t1AvgPower = t1Count > 0 ? t1Power / t1Count : DEFAULT_MU;
  const t2AvgPower = t2Count > 0 ? t2Power / t2Count : DEFAULT_MU;

  // Compute dynamic scale based on sumScale parameter
  let dynamicScale = 1;
  const totalCount = t1Count + t2Count;
  if (params.sumScale === 'sqrt') {
    dynamicScale = Math.max(1, Math.sqrt(totalCount + 1) * 2.5);
  } else if (params.sumScale === 'log') {
    dynamicScale = Math.max(1, Math.log(totalCount + 2) * 2.5); // +2 to avoid log(1)=0
  } else {
    // 'none' (default): linear scaling (original formula)
    dynamicScale = Math.max(1, (totalCount + 1) * 2.5);
  }

  const newAvgT1 = (t1Power + playerMu) / (t1Count + 1);
  const newAvgT2 = (t2Power + playerMu) / (t2Count + 1);

  const scoreT1 =
    (Math.abs(newAvgT1 - t2AvgPower) * params.mu_avgWeight) +
    ((Math.abs(t1Power + playerMu - t2Power) / dynamicScale) * params.mu_sumWeight);

  const scoreT2 =
    (Math.abs(newAvgT2 - t1AvgPower) * params.mu_avgWeight) +
    ((Math.abs(t1Power - (t2Power + playerMu)) / dynamicScale) * params.mu_sumWeight);

  const targetTeam = scoreT1 <= scoreT2 ? 1 : 2;
  return { targetTeam, reason: `Skill Balance` };
}

// ─────────────────────────────────────────────────────────────────────────────
// State mutation
// ─────────────────────────────────────────────────────────────────────────────

function applyJoinSA(state, player, targetTeam) {
  state.players.set(player.steamID, { steamID: player.steamID, teamID: player.teamID, mu: player.mu });

  if (targetTeam === null) return;

  if (String(player.teamID) !== String(targetTeam)) {
    const mu = player.mu;
    state.pendingAssignments[targetTeam]++;
    state.pendingMu[targetTeam] += mu;
    state.pendingPlayerMoves.set(player.steamID, { targetTeam, mu });
    state.moves++;
    // Resolve immediately
    state.pendingAssignments[targetTeam]--;
    state.pendingMu[targetTeam] -= mu;
    state.pendingPlayerMoves.delete(player.steamID);
    state.players.get(player.steamID).teamID = targetTeam;
  }
}

const RECONNECT_EXPIRY_MS = 20 * 60 * 1000; // 20 minutes

function applyLeave(state, player, timestamp = null) {
  const existing = state.players.get(player.steamID);
  if (existing) {
    const tid = Number(existing.teamID);
    if (tid === 1 || tid === 2) {
      state.reconnectMemory.set(player.steamID, { teamID: tid, leaveTime: timestamp });
    }
  }
  state.players.delete(player.steamID);
  state.pendingPlayerMoves.delete(player.steamID);
}

function applyTeamChange(state, player) {
  const existing = state.players.get(player.steamID);
  if (existing) existing.teamID = player.newTeam;
  else state.players.set(player.steamID, { steamID: player.steamID, teamID: player.newTeam, mu: DEFAULT_MU });
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the total Mu power of each team in the current sim state.
 * Excludes: the player being evaluated (excludeID), and any pending moves.
 * Includes pending Mu from queued assignments not yet resolved.
 */
function getTeamPower(state, excludeID) {
  let t1 = state.pendingMu[1] || 0;
  let t2 = state.pendingMu[2] || 0;
  for (const [sid, p] of state.players) {
    if (sid === excludeID) continue;
    if (state.pendingPlayerMoves.has(sid)) continue;
    const tid = String(p.teamID);
    if (tid === '1') t1 += p.mu;
    else if (tid === '2') t2 += p.mu;
  }
  return { t1, t2 };
}

/**
 * Regret for a single join decision.
 *
 * Regret = gap(chosenTeam) - gap(optimalTeam)
 * Always >= 0. Zero means the algorithm made the Elo-optimal choice.
 * Non-zero means the algorithm sent the player to the wrong team Elo-wise.
 *
 * Cap-forced joins naturally produce regret=0: when the pop cap leaves only
 * one valid team, both chosen and optimal are the same team.
 */
function joinRegret(t1Power, t2Power, playerMu, chosenTeam) {
  const gapIfT1 = Math.abs((t1Power + playerMu) - t2Power);
  const gapIfT2 = Math.abs(t1Power - (t2Power + playerMu));
  const optimal  = Math.min(gapIfT1, gapIfT2);
  const chosen   = chosenTeam === 1 ? gapIfT1 : (chosenTeam === 2 ? gapIfT2 : optimal);
  return Math.max(0, chosen - optimal);
}

function computeRoundScore(regrets) {
  if (regrets.length === 0) return 0;
  return regrets.reduce((a, b) => a + b, 0) / regrets.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Round scoring (pure kernel, no console output)
//
// Metric: mean regret per JOIN decision.
//   regret = MuGap(chosen team) - MuGap(optimal team)
//
// Only JOIN events produce a regret sample. Snapshot, LEAVE, and TEAM_CHANGE
// events are not SA decisions and are excluded from scoring — this removes
// snapshot noise and any imbalance the algorithm cannot control.
// ─────────────────────────────────────────────────────────────────────────────

function scoreRound(round, params, eloMap) {
    // Skip seed rounds — SA does not assign during seeding
    const gamemode = (round.gamemode || '').toLowerCase();
    if (gamemode.includes('seed')) return { roundScore: 0, eloCoverage: 0, regrets: [], nJoins: 0, clanOpportunities: 0, clanSuccesses: 0 };

    const saState = createSimState();
    const regrets = [];
    let eloJoins = 0;
    let realEloJoins = 0;
    let snapSeen = false;
    let clanOpportunities = 0;
    let clanSuccesses = 0;

    const getMu = (steamID) => eloMap?.get(steamID) ?? DEFAULT_MU;
    const deferredPlayers = new Map();
    const roundTagMap = new Map(); // steamID -> normalized tag

    // Sort events chronologically to correct late-discovered LEAVE timing
    const events = (round.events || []).slice().sort((a, b) => (a.ts ?? a.timestamp) - (b.ts ?? b.timestamp));

    for (const ev of events) {
      const { eventType, steamID, name, teamID, newTeam } = ev;

      // Deferred resolution for null-teamID snapshot players
      if (deferredPlayers.size > 0 && steamID && deferredPlayers.has(steamID)) {
        let resolvedTeam = null;
        if (eventType === 'LEAVE' && (teamID === 1 || teamID === 2)) resolvedTeam = teamID;
        else if (eventType === 'TEAM_CHANGE' && (newTeam === 1 || newTeam === 2)) resolvedTeam = newTeam === 1 ? 2 : 1;
        else if (eventType === 'JOIN') resolvedTeam = teamID === 1 || teamID === 2 ? teamID : null;
        if (resolvedTeam) {
          const deferred = deferredPlayers.get(steamID);
          saState.players.set(steamID, { steamID, teamID: resolvedTeam, mu: deferred.mu });
          deferredPlayers.delete(steamID);
        }
      }

      if (snapSeen && ev.betweenRounds) break;

      if (eventType === 'ROUND_SNAPSHOT') {
        snapSeen = true;
        for (const p of ev.players) {
          const tid = Number(p.teamID);
          if (tid === 1 || tid === 2) {
            saState.players.set(p.steamID, { steamID: p.steamID, teamID: tid, mu: getMu(p.steamID) });
          }
          const rawTag = extractRawPrefix(p.name || '');
          if (rawTag) roundTagMap.set(p.steamID, rawTag.replace(/[^a-zA-Z0-9]/g, '').toUpperCase());
        }
        for (const p of ev.players) {
          const tid = Number(p.teamID);
          if (tid !== 1 && tid !== 2) deferredPlayers.set(p.steamID, { mu: getMu(p.steamID) });
        }
        // No regret at snapshot — not an SA decision

       } else if (eventType === 'JOIN') {
         const player = { steamID, name, teamID, mu: getMu(steamID) };
         eloJoins++;
         if (eloMap && eloMap.has(steamID)) realEloJoins++;

         const rawTag = extractRawPrefix(name || '');
         if (rawTag) roundTagMap.set(steamID, rawTag.replace(/[^a-zA-Z0-9]/g, '').toUpperCase());

         const mem = saState.reconnectMemory.get(steamID) || null;
         const reconnectTeam = (mem && (mem.leaveTime === null || (ev.ts ?? ev.timestamp) - mem.leaveTime <= RECONNECT_EXPIRY_MS))
           ? mem.teamID : null;
         // Ensure clan grouping is always enabled (no longer a tunable parameter)
         const evalParams = { ...params, enableClanGrouping: true };
         const evalResult = evaluate(saState, player, reconnectTeam, evalParams, roundTagMap);
         const { targetTeam: saTarget, reason } = evalResult;

         // Track clan grouping opportunities (count any time clan mates exist on one team, regardless of cap)
         const joinerTag = roundTagMap.get(steamID);
         if (joinerTag) {
           let t1Clan = 0, t2Clan = 0;
           for (const [sid, p] of saState.players) {
             if (sid === steamID) continue;
             const pTag = roundTagMap.get(sid);
             if (pTag === joinerTag) {
               if (String(p.teamID) === '1') t1Clan++;
               else if (String(p.teamID) === '2') t2Clan++;
             }
           }
           const minMates = 1;
           if ((t1Clan >= minMates && t2Clan === 0) || (t2Clan >= minMates && t1Clan === 0)) {
             clanOpportunities++;
             // Count success only if routing actually happened
             if (reason === 'Clan Grouping') {
               clanSuccesses++;
             }
           }
         }

         // Compute regret before applying the join (state must reflect pre-join teams)
         const { t1, t2 } = getTeamPower(saState, steamID);
         regrets.push(joinRegret(t1, t2, player.mu, saTarget));

         applyJoinSA(saState, player, saTarget);

      } else if (eventType === 'LEAVE') {
        applyLeave(saState, { steamID, teamID }, ev.ts ?? ev.timestamp);
      } else if (eventType === 'TEAM_CHANGE') {
        applyTeamChange(saState, { steamID, newTeam });
      }
    }

     const roundScore = computeRoundScore(regrets);
     const eloCoverage = eloJoins > 0 ? realEloJoins / eloJoins : 0;

     return { roundScore, eloCoverage, regrets, nJoins: eloJoins, clanOpportunities, clanSuccesses };
}

/**
 * Score a round based on actual population gaps from the log.
 * Computes mean |t1 - t2| across all events, respecting betweenRounds break.
 * Returns population gap metric (different unit from Mu gap in scoreRound).
 */
function scoreRoundActual(round) {
   const gaps = [];
   let snapshotSeen = false;
   const events = (round.events || []).slice().sort((a, b) => (a.ts ?? a.timestamp) - (b.ts ?? b.timestamp));
   for (const ev of events) {
      if (snapshotSeen && ev.betweenRounds) break;
      if (ev.eventType === 'ROUND_SNAPSHOT') {
         snapshotSeen = true;
      }
      if (!snapshotSeen) continue;
      if (ev.t1 !== undefined && ev.t2 !== undefined) {
         gaps.push(Math.abs(ev.t1 - ev.t2));
      }
   }
   return gaps.length > 0 ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
}

/**
 * Baseline: "no assignment" — players stay on their actual logged team.
 * Regret measures how suboptimal organic (uncontrolled) placement is vs. Elo-optimal.
 */
function scoreRoundNoOp(round, eloMap) {
   const regrets = [];
   const getMu = (steamID) => eloMap?.get(steamID) ?? DEFAULT_MU;
   const saState = createSimState();
   let snapSeen = false;

   const events = (round.events || []).slice().sort((a, b) => (a.ts ?? a.timestamp) - (b.ts ?? b.timestamp));
   const deferredPlayers = new Map();

   for (const ev of events) {
      if (deferredPlayers.size > 0 && ev.steamID && deferredPlayers.has(ev.steamID)) {
         let resolvedTeam = null;
         if (ev.eventType === 'LEAVE' && (ev.teamID === 1 || ev.teamID === 2)) resolvedTeam = ev.teamID;
         else if (ev.eventType === 'TEAM_CHANGE' && (ev.newTeam === 1 || ev.newTeam === 2)) resolvedTeam = ev.newTeam === 1 ? 2 : 1;
         else if (ev.eventType === 'JOIN') resolvedTeam = ev.teamID === 1 || ev.teamID === 2 ? ev.teamID : null;
         if (resolvedTeam) {
            const deferred = deferredPlayers.get(ev.steamID);
            saState.players.set(ev.steamID, { steamID: ev.steamID, teamID: resolvedTeam, mu: deferred.mu });
            deferredPlayers.delete(ev.steamID);
         }
      }

      if (snapSeen && ev.betweenRounds) break;

      if (ev.eventType === 'ROUND_SNAPSHOT') {
         snapSeen = true;
         for (const p of ev.players) {
            const tid = Number(p.teamID);
            if (tid === 1 || tid === 2) {
               saState.players.set(p.steamID, { steamID: p.steamID, teamID: tid, mu: getMu(p.steamID) });
            }
         }
         for (const p of ev.players) {
            const tid = Number(p.teamID);
            if (tid !== 1 && tid !== 2) deferredPlayers.set(p.steamID, { mu: getMu(p.steamID) });
         }

      } else if (ev.eventType === 'JOIN') {
         const loggedTeam = ev.teamID === 1 || ev.teamID === 2 ? ev.teamID : null;
         const mu = getMu(ev.steamID);

         if (loggedTeam !== null) {
            const { t1, t2 } = getTeamPower(saState, ev.steamID);
            regrets.push(joinRegret(t1, t2, mu, loggedTeam));
            saState.players.set(ev.steamID, { steamID: ev.steamID, teamID: loggedTeam, mu });
         }

      } else if (ev.eventType === 'LEAVE') {
         saState.players.delete(ev.steamID);
      } else if (ev.eventType === 'TEAM_CHANGE') {
         const existing = saState.players.get(ev.steamID);
         if (existing) existing.teamID = ev.newTeam;
         else saState.players.set(ev.steamID, { steamID: ev.steamID, teamID: ev.newTeam, mu: DEFAULT_MU });
      }
   }

   return { roundScore: computeRoundScore(regrets), regrets };
}

/**
 * Baseline: population-only balancer — always sends player to the smaller team by headcount.
 * Regret measures how suboptimal headcount-only assignment is vs. Elo-optimal.
 */
function scoreRoundPopOnly(round, eloMap) {
   const regrets = [];
   const getMu = (steamID) => eloMap?.get(steamID) ?? DEFAULT_MU;
   const saState = createSimState();
   let snapSeen = false;

   const events = (round.events || []).slice().sort((a, b) => (a.ts ?? a.timestamp) - (b.ts ?? b.timestamp));
   const deferredPlayers = new Map();

   for (const ev of events) {
      if (deferredPlayers.size > 0 && ev.steamID && deferredPlayers.has(ev.steamID)) {
         let resolvedTeam = null;
         if (ev.eventType === 'LEAVE' && (ev.teamID === 1 || ev.teamID === 2)) resolvedTeam = ev.teamID;
         else if (ev.eventType === 'TEAM_CHANGE' && (ev.newTeam === 1 || ev.newTeam === 2)) resolvedTeam = ev.newTeam === 1 ? 2 : 1;
         else if (ev.eventType === 'JOIN') resolvedTeam = ev.teamID === 1 || ev.teamID === 2 ? ev.teamID : null;
         if (resolvedTeam) {
            const deferred = deferredPlayers.get(ev.steamID);
            saState.players.set(ev.steamID, { steamID: ev.steamID, teamID: resolvedTeam, mu: deferred.mu });
            deferredPlayers.delete(ev.steamID);
         }
      }

      if (snapSeen && ev.betweenRounds) break;

      if (ev.eventType === 'ROUND_SNAPSHOT') {
         snapSeen = true;
         for (const p of ev.players) {
            const tid = Number(p.teamID);
            if (tid === 1 || tid === 2) {
               saState.players.set(p.steamID, { steamID: p.steamID, teamID: tid, mu: getMu(p.steamID) });
            }
         }
         for (const p of ev.players) {
            const tid = Number(p.teamID);
            if (tid !== 1 && tid !== 2) deferredPlayers.set(p.steamID, { mu: getMu(p.steamID) });
         }

      } else if (ev.eventType === 'JOIN') {
         let t1Count = 0, t2Count = 0;
         for (const p of saState.players.values()) {
            if (String(p.teamID) === '1') t1Count++;
            else if (String(p.teamID) === '2') t2Count++;
         }
         if (t1Count >= MAX_TEAM_SIZE) t1Count = MAX_TEAM_SIZE;
         if (t2Count >= MAX_TEAM_SIZE) t2Count = MAX_TEAM_SIZE;

         const targetTeam = t1Count <= t2Count ? 1 : 2;
         const mu = getMu(ev.steamID);

         const { t1, t2 } = getTeamPower(saState, ev.steamID);
         regrets.push(joinRegret(t1, t2, mu, targetTeam));

         saState.players.set(ev.steamID, { steamID: ev.steamID, teamID: targetTeam, mu });

      } else if (ev.eventType === 'LEAVE') {
         saState.players.delete(ev.steamID);
      } else if (ev.eventType === 'TEAM_CHANGE') {
         const existing = saState.players.get(ev.steamID);
         if (existing) existing.teamID = ev.newTeam;
         else saState.players.set(ev.steamID, { steamID: ev.steamID, teamID: ev.newTeam, mu: DEFAULT_MU });
      }
   }

   return { roundScore: computeRoundScore(regrets), regrets };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter combination generation & validation
// ─────────────────────────────────────────────────────────────────────────────

function* generateCombinations(range, pinnedParams = {}) {
  // Cartesian product of all parameter ranges in coarse pass
  // Skip any parameters in pinnedParams
  const keys = Object.keys(range).filter(k => !(k in pinnedParams));
  const ranges = keys.map(k => range[k].coarse);

  function* product(arrays) {
    if (arrays.length === 0) {
      yield [];
    } else {
      for (const item of arrays[0]) {
        for (const rest of product(arrays.slice(1))) {
          yield [item, ...rest];
        }
      }
    }
  }

  for (const combo of product(ranges)) {
    const params = { ...pinnedParams };
    for (let i = 0; i < keys.length; i++) {
      params[keys[i]] = combo[i];
    }

    // Constraint: tier1 ≤ tier2 ≤ tier3 ≤ tier4
    if (params.cap_tier1 <= params.cap_tier2 && 
        params.cap_tier2 <= params.cap_tier3 && 
        params.cap_tier3 <= params.cap_tier4) {
      yield params;
    }
  }
}

function paramsToString(params) {
   return `${params.cap_tier1}/${params.cap_tier2}/${params.cap_tier3}/${params.cap_tier4} | ` +
          `Grace+${params.grace_extra} | ` +
          `${params.mu_avgWeight.toFixed(2)}/${params.mu_sumWeight.toFixed(2)} | ${params.sumScale} | ` +
          `Clan:ON`;
}

// ─────────────────────────────────────────────────────────────────────────────
// File I/O
// ─────────────────────────────────────────────────────────────────────────────

async function loadRounds(filePath) {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  const rounds = [];
  let lineNumber = 0;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lineNumber++;
    try { rounds.push({ lineNum: lineNumber, data: JSON.parse(trimmed) }); } catch { /* skip */ }
  }
  return rounds;
}

async function loadElo(filePath) {
  const raw = await import('fs').then(fs => fs.promises.readFile(filePath, 'utf8'));
  const data = JSON.parse(raw);
  const players = data.players ?? [];
  const map = new Map();
  for (const p of players) {
    if (p.steamID && typeof p.mu === 'number') map.set(p.steamID, p.mu);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main optimizer
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const filePath = args.find(a => !a.startsWith('--'));
  const eloArg = args.indexOf('--elo');
  const coverageArg = args.indexOf('--min-elo-coverage');
  const snapshotCoverageArg = args.indexOf('--min-snapshot-coverage');
  const topArg = args.indexOf('--top');
  const pinArg = args.indexOf('--pin');
  const prevScoreArg = args.indexOf('--prev-score');

  if (!filePath) {
    console.error('Usage: node optimize-params.js <log.jsonl> [--elo <backup.json>] [--min-elo-coverage <frac>] [--min-snapshot-coverage <frac>] [--top <N>] [--pin param=value ...] [--prev-score <number>]');
    process.exit(1);
  }

  const prevScore = prevScoreArg !== -1 ? parseFloat(args[prevScoreArg + 1]) : null;

  // Parse pinned parameters
  const pinnedParams = {};
  if (pinArg !== -1) {
    for (let i = pinArg + 1; i < args.length && !args[i].startsWith('--'); i++) {
      const [key, val] = args[i].split('=');
      // Map friendly names to param keys
      const keyMap = {
        'graceHigh': 'grace_highPop',
        'graceLow': 'grace_lowPop',
        'capT1': 'cap_tier1',
        'capT2': 'cap_tier2',
        'capT3': 'cap_tier3',
        'capT4': 'cap_tier4',
        'avgW': 'mu_avgWeight',
        'sumW': 'mu_sumWeight',
      };
      const paramKey = keyMap[key] || key;
      const paramValue = isNaN(val) ? val : parseFloat(val);
      pinnedParams[paramKey] = paramValue;
    }
  }

  const eloMap = eloArg !== -1 ? await loadElo(args[eloArg + 1]) : null;
  if (eloMap) console.log(`✓ Elo data loaded: ${eloMap.size} players\n`);
  else console.log(`✓ No Elo data — using default mu = ${DEFAULT_MU} for all players\n`);

  const minEloCoverage = coverageArg !== -1 ? parseFloat(args[coverageArg + 1]) : 0.0;
  let minSnapshotCoverage = 0.0;
  if (snapshotCoverageArg !== -1) {
    const nextArg = args[snapshotCoverageArg + 1];
    // If next arg starts with '--' or doesn't exist, use default 0.85; otherwise parse the value
    minSnapshotCoverage = (nextArg && !nextArg.startsWith('--')) ? parseFloat(nextArg) : 0.85;
  }
  const topN = topArg !== -1 ? parseInt(args[topArg + 1], 10) : 5;

  if (Object.keys(pinnedParams).length > 0) {
    console.log(`✓ Policy-pinned parameters: ${JSON.stringify(pinnedParams)}\n`);
  }

  let rounds = await loadRounds(filePath);
  console.log(`✓ Loaded ${rounds.length} rounds\n`);

  rounds = rounds.filter(r => !((r.data.gamemode || '').toLowerCase().includes('seed')));
  console.log(`✓ After seed filter: ${rounds.length} rounds\n`);

  // Filter by Elo coverage
  if (minEloCoverage > 0) {
    const filtered = [];
    for (const r of rounds) {
      let joins = 0, realElo = 0;
      for (const ev of r.data.events || []) {
        if (ev.eventType === 'JOIN') {
          joins++;
          if (eloMap && eloMap.has(ev.steamID)) realElo++;
        }
      }
      const coverage = joins > 0 ? realElo / joins : 0;
      if (coverage >= minEloCoverage) filtered.push(r);
    }
    console.log(`✓ Filtered by Elo coverage ≥${minEloCoverage.toFixed(1)}: ${filtered.length}/${rounds.length} rounds\n`);
    rounds = filtered;
  }

  // Filter by snapshot coverage
  if (minSnapshotCoverage > 0) {
    const before = rounds.length;
    rounds = rounds.filter(r => {
      const events = r.data.events || [];
      const snapshot = events.find(e => e.eventType === 'ROUND_SNAPSHOT');
      if (!snapshot || !snapshot.players || snapshot.players.length === 0) return true; // no snapshot — keep
      const total = snapshot.players.length;
      const valid = snapshot.players.filter(p => Number(p.teamID) === 1 || Number(p.teamID) === 2).length;
      return (valid / total) >= minSnapshotCoverage;
    });
    console.log(`✓ After snapshot coverage filter (≥${(minSnapshotCoverage * 100).toFixed(0)}%): ${rounds.length} rounds (removed ${before - rounds.length})\n`);
  }

  if (rounds.length === 0) {
    console.error('No rounds after filtering.');
    process.exit(1);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // COARSE PASS
  // ─────────────────────────────────────────────────────────────────────────────

  console.log('════════════════════════════════════════════════════════════════════');
  console.log('COARSE PASS: Evaluating parameter combinations');
  console.log('════════════════════════════════════════════════════════════════════\n');

  const coarseResults = [];
  let coarseCount = 0;

  for (const params of generateCombinations(PARAM_SPACE, pinnedParams)) {
    coarseCount++;
    const roundScores = [];

    for (const round of rounds) {
      const { roundScore } = scoreRound(round.data, params, eloMap);
      roundScores.push(roundScore);
    }

    const totalScore = roundScores.length > 0 ? roundScores.reduce((a, b) => a + b, 0) / roundScores.length : 0;

    coarseResults.push({
      params,
      totalScore,
      roundScores,
      paramsStr: paramsToString(params),
    });

    if (coarseCount % 100 === 0) {
      process.stdout.write(`  Evaluated ${coarseCount} combinations...\r`);
    }
  }

  console.log(`\n✓ Coarse pass: ${coarseCount} combinations evaluated\n`);

  // Sort and pick top N
  coarseResults.sort((a, b) => a.totalScore - b.totalScore);
  const topCoarse = coarseResults.slice(0, topN);

  console.log(`TOP ${topN} FROM COARSE PASS:`);
  console.log('─'.repeat(70));
  topCoarse.forEach((r, i) => {
    console.log(`${i + 1}. Score: ${r.totalScore.toFixed(3)}  |  ${r.paramsStr}`);
  });
  console.log();

  // ─────────────────────────────────────────────────────────────────────────────
  // FINE PASS (around top coarse candidates)
  // ─────────────────────────────────────────────────────────────────────────────

  console.log('════════════════════════════════════════════════════════════════════');
  console.log('FINE PASS: Refining top candidates');
  console.log('════════════════════════════════════════════════════════════════════\n');

  const fineResults = new Set();

  for (const coarseCandidate of topCoarse) {
    const baseParams = coarseCandidate.params;

    // Generate fine sweep around each parameter
    // For simplicity, we'll do a local sweep where each parameter can vary by ±1 in its fine range
    const fineParamVariations = [
      { ...baseParams },
    ];

    // Add neighbors: ±1 step in fine range for each parameter
    const paramKeys = Object.keys(baseParams);
    for (const key of paramKeys) {
      const fineRange = PARAM_SPACE[key].fine;
      const currentVal = baseParams[key];
      const currentIdx = fineRange.indexOf(currentVal);

      if (currentIdx > 0) {
        fineParamVariations.push({
          ...baseParams,
          [key]: fineRange[currentIdx - 1],
        });
      }
      if (currentIdx < fineRange.length - 1) {
        fineParamVariations.push({
          ...baseParams,
          [key]: fineRange[currentIdx + 1],
        });
      }
    }

    for (const fineParams of fineParamVariations) {
      // Validate constraint
      if (fineParams.cap_tier1 > fineParams.cap_tier2 ||
          fineParams.cap_tier2 > fineParams.cap_tier3 ||
          fineParams.cap_tier3 > fineParams.cap_tier4) {
        continue;
      }

      const paramsStr = paramsToString(fineParams);
      if (fineResults.has(paramsStr)) continue; // Avoid duplicates

      const roundScores = [];
      for (const round of rounds) {
        const { roundScore } = scoreRound(round.data, fineParams, eloMap);
        roundScores.push(roundScore);
      }

      const totalScore = roundScores.length > 0 ? roundScores.reduce((a, b) => a + b, 0) / roundScores.length : 0;

      fineResults.add(paramsStr);
      coarseResults.push({
        params: fineParams,
        totalScore,
        roundScores,
        paramsStr,
      });
    }
  }

  console.log(`✓ Fine pass: evaluated ${fineResults.size} additional combinations\n`);

  // ─────────────────────────────────────────────────────────────────────────────
  // RESULTS
  // ─────────────────────────────────────────────────────────────────────────────

  // Re-sort all results (coarse + fine combined)
  coarseResults.sort((a, b) => a.totalScore - b.totalScore);

  console.log('════════════════════════════════════════════════════════════════════');
  console.log('TOP 10 PARAMETER SETS');
  console.log('════════════════════════════════════════════════════════════════════\n');
  console.log(' #   Score    Cap Tiers         Grace+   W:Avg   W:Sum   SumScale');
  console.log('─'.repeat(75));

  const winner = coarseResults[0];
  for (let i = 0; i < Math.min(10, coarseResults.length); i++) {
    const r = coarseResults[i];
    const p = r.params;
    const marker = i === 0 ? ' ← WINNER' : '';
    console.log(
      ` ${String(i + 1).padStart(2)}  ${r.totalScore.toFixed(3)}  ` +
      `${p.cap_tier1}/${p.cap_tier2}/${p.cap_tier3}/${p.cap_tier4}`.padEnd(18) +
      `${String(p.grace_extra).padStart(6)}  ` +
      `${p.mu_avgWeight.toFixed(2)}  ${p.mu_sumWeight.toFixed(2)}  ${p.sumScale}${marker}`
    );
  }
  console.log();

   // ─────────────────────────────────────────────────────────────────────────────
   // BASELINE COMPARISON (all in same Mu gap metric for apples-to-apples)
   // ─────────────────────────────────────────────────────────────────────────────

   const noOpRoundScores = [];
   const popOnlyRoundScores = [];
   for (const round of rounds) {
     const { roundScore: noOpScore } = scoreRoundNoOp(round.data, eloMap);
     const { roundScore: popOnlyScore } = scoreRoundPopOnly(round.data, eloMap);
     noOpRoundScores.push(noOpScore);
     popOnlyRoundScores.push(popOnlyScore);
   }
   const noOpScore = noOpRoundScores.length > 0
     ? noOpRoundScores.reduce((a, b) => a + b, 0) / noOpRoundScores.length
     : 0;
   const popOnlyScore = popOnlyRoundScores.length > 0
     ? popOnlyRoundScores.reduce((a, b) => a + b, 0) / popOnlyRoundScores.length
     : 0;

   // Also keep pop gap for reference (different units)
   const actualRoundScores = [];
   for (const round of rounds) {
     actualRoundScores.push(scoreRoundActual(round.data));
   }
   const actualScore = actualRoundScores.length > 0
     ? actualRoundScores.reduce((a, b) => a + b, 0) / actualRoundScores.length
     : 0;

  console.log('════════════════════════════════════════════════════════════════════');
  console.log('BASELINE COMPARISON (mean regret per JOIN — lower is better)');
  console.log('Regret = MuGap(chosen team) - MuGap(optimal team). Zero = perfect decisions.');
  console.log('════════════════════════════════════════════════════════════════════\n');
  console.log(`No assignment (as-played):    ${noOpScore.toFixed(3)}`);
  console.log(`Pop-only balance:             ${popOnlyScore.toFixed(3)}`);
  console.log(`SmartAssign WINNER:           ${winner.totalScore.toFixed(3)}`);
  if (prevScore !== null) {
    console.log(`Previous best:                ${prevScore.toFixed(3)}`);
  }
  console.log(`\nHeadcount balance (pop imbalance, different units):     ${actualScore.toFixed(3)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────────────
  // PER-ROUND BREAKDOWN (regret per join decision)
  // ─────────────────────────────────────────────────────────────────────────────

  console.log('════════════════════════════════════════════════════════════════════');
  console.log('PER-ROUND BREAKDOWN (mean regret per JOIN decision)');
  console.log('Regret=0 means every join was Elo-optimal. PopGap=headcount gap (different units).');
  console.log('════════════════════════════════════════════════════════════════════\n');
  console.log(' #   Layer                              PopGap   SA Regret  NoOp Regret  nJoins  Rejoin%  ClanCoh%');
  console.log('─'.repeat(105));

  let totalRejoinAttempts = 0;
  let totalRejoinSuccesses = 0;
    const perRoundRejoinRates = [];
    let totalClanOpportunities = 0;
    let totalClanSuccesses = 0;

    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      const layer = (r.data.layerName || 'Unknown').slice(0, 35).padEnd(35);
      const actualSc = actualRoundScores[i].toFixed(2);
      const saRegret = winner.roundScores[i].toFixed(3);
      const noOpRegret = noOpRoundScores[i].toFixed(3);
      const nJoins = (r.data.events || []).filter(e => e.eventType === 'JOIN').length;
      
      // Calculate rejoin rate for this round: count JOIN events with reconnectTeam
      let roundRejoinAttempts = 0;
      let roundRejoinSuccesses = 0;
      let roundClanOpportunities = 0;
      let roundClanSuccesses = 0;
      const saState = createSimState();
      const deferredPlayers = new Map(); // steamID -> { mu } — null-teamID snapshot players pending team resolution
      let snapSeen = false;
      const roundTagMap = new Map(); // steamID -> normalized tag
      const events = (r.data.events || []).slice().sort((a, b) => (a.ts ?? a.timestamp) - (b.ts ?? b.timestamp));
    
    for (const ev of events) {
      // Attempt deferred resolution for null-teamID snapshot players (no console output in rejoin calculation)
      if (deferredPlayers.size > 0 && ev.steamID && deferredPlayers.has(ev.steamID)) {
        let resolvedTeam = null;
        if (ev.eventType === 'LEAVE' && (ev.teamID === 1 || ev.teamID === 2)) {
          resolvedTeam = ev.teamID;
        } else if (ev.eventType === 'TEAM_CHANGE' && (ev.newTeam === 1 || ev.newTeam === 2)) {
          resolvedTeam = ev.newTeam === 1 ? 2 : 1;
        } else if (ev.eventType === 'JOIN') {
          resolvedTeam = ev.teamID === 1 || ev.teamID === 2 ? ev.teamID : null;
        }
        if (resolvedTeam) {
          const deferred = deferredPlayers.get(ev.steamID);
          saState.players.set(ev.steamID, {
            steamID: ev.steamID,
            teamID: resolvedTeam,
            mu: deferred.mu
          });
          deferredPlayers.delete(ev.steamID);
        }
      }

      if (snapSeen && ev.betweenRounds) break;
      if (ev.eventType === 'ROUND_SNAPSHOT') {
        snapSeen = true;
        for (const p of ev.players) {
          const tid = Number(p.teamID);
          if (tid === 1 || tid === 2) {
            saState.players.set(p.steamID, { steamID: p.steamID, teamID: tid, mu: DEFAULT_MU });
          }
          const rawTag = extractRawPrefix(p.name || '');
          if (rawTag) roundTagMap.set(p.steamID, rawTag.replace(/[^a-zA-Z0-9]/g, '').toUpperCase());
        }
        // Collect null-teamID snapshot players for deferred resolution
        for (const p of ev.players) {
          const tid = Number(p.teamID);
          if (tid !== 1 && tid !== 2) {
            deferredPlayers.set(p.steamID, { mu: DEFAULT_MU });
          }
        }
      } else if (ev.eventType === 'JOIN') {
        const rawTag = extractRawPrefix(ev.name || '');
        if (rawTag) roundTagMap.set(ev.steamID, rawTag.replace(/[^a-zA-Z0-9]/g, '').toUpperCase());

        const mem = saState.reconnectMemory.get(ev.steamID) || null;
        const reconnectTeam = (mem && (mem.leaveTime === null || (ev.ts ?? ev.timestamp) - mem.leaveTime <= RECONNECT_EXPIRY_MS))
          ? mem.teamID : null;
        
        // Track clan grouping opportunities (regardless of winner params, for baseline comparison)
        if (roundTagMap) {
          const joinerTag = roundTagMap.get(ev.steamID);
          if (joinerTag) {
            let t1Clan = 0, t2Clan = 0;
            for (const [sid, p] of saState.players) {
              if (sid === ev.steamID) continue;
              const pTag = roundTagMap.get(sid);
              if (pTag === joinerTag) {
                if (String(p.teamID) === '1') t1Clan++;
                else if (String(p.teamID) === '2') t2Clan++;
              }
            }
            const minMates = 1;
            if ((t1Clan >= minMates && t2Clan === 0) || (t2Clan >= minMates && t1Clan === 0)) {
              roundClanOpportunities++;
              // Only count success if winner has clan grouping enabled
              if (winner.params.enableClanGrouping) {
                const clanTeam = t1Clan > 0 ? 1 : 2;
                let t1Count = saState.pendingAssignments[1] || 0, t2Count = saState.pendingAssignments[2] || 0;
                for (const p of saState.players.values()) {
                  if (String(p.teamID) === '1') t1Count++;
                  else if (String(p.teamID) === '2') t2Count++;
                }
                const totalPop = t1Count + t2Count;
                let maxImbalance;
                if (totalPop >= 96) maxImbalance = winner.params.cap_tier1;
                else if (totalPop >= 90) maxImbalance = winner.params.cap_tier2;
                else if (totalPop >= 82) maxImbalance = winner.params.cap_tier3;
                else maxImbalance = winner.params.cap_tier4;
                // Use population-based grace for clan grouping (same as evaluate() function)
                const effectiveMaxImbalance = Math.min(4, maxImbalance + (totalPop >= 90 ? 1 : 2));
                const currentTeamCount = clanTeam === 1 ? t1Count : t2Count;
                const otherTeamCount = clanTeam === 1 ? t2Count : t1Count;
                if ((currentTeamCount + 1) - otherTeamCount <= effectiveMaxImbalance) {
                  roundClanSuccesses++;
                }
              }
            }
          }
        }
        
        if (reconnectTeam) {
          roundRejoinAttempts++;
          let t1Count = saState.pendingAssignments[1] || 0, t2Count = saState.pendingAssignments[2] || 0;
          for (const p of saState.players.values()) {
            if (String(p.teamID) === '1') t1Count++;
            else if (String(p.teamID) === '2') t2Count++;
          }
          
          const totalPop = t1Count + t2Count;
          let maxImbalance;
          if (totalPop >= 96) maxImbalance = winner.params.cap_tier1;
          else if (totalPop >= 90) maxImbalance = winner.params.cap_tier2;
          else if (totalPop >= 82) maxImbalance = winner.params.cap_tier3;
          else maxImbalance = winner.params.cap_tier4;
          
          const effectiveMaxImbalance = Math.min(4, maxImbalance + winner.params.grace_extra);
          const currentTeamCount = reconnectTeam === 1 ? t1Count : t2Count;
          const otherTeamCount = reconnectTeam === 1 ? t2Count : t1Count;
          
          if ((currentTeamCount + 1) - otherTeamCount <= effectiveMaxImbalance) {
            roundRejoinSuccesses++;
          }
        }
        
        // Add player to state so they can be tracked for reconnects
        saState.players.set(ev.steamID, { steamID: ev.steamID, teamID: ev.teamID || null, mu: DEFAULT_MU });
      } else if (ev.eventType === 'LEAVE') {
        const existing = saState.players.get(ev.steamID);
        if (existing) {
          const tid = Number(existing.teamID);
          if (tid === 1 || tid === 2) saState.reconnectMemory.set(ev.steamID, { teamID: tid, leaveTime: (ev.ts ?? ev.timestamp) });
        }
        saState.players.delete(ev.steamID);
      } else if (ev.eventType === 'TEAM_CHANGE') {
        const existing = saState.players.get(ev.steamID);
        if (existing) existing.teamID = ev.newTeam;
        else saState.players.set(ev.steamID, { steamID: ev.steamID, teamID: ev.newTeam, mu: DEFAULT_MU });
      }
    }
    
    const rejoinRate = roundRejoinAttempts > 0 ? ((roundRejoinSuccesses / roundRejoinAttempts) * 100).toFixed(0) : 'N/A';
    const clanRate = roundClanOpportunities > 0 ? ((roundClanSuccesses / roundClanOpportunities) * 100).toFixed(0) : 'N/A';
    perRoundRejoinRates.push({ attempts: roundRejoinAttempts, successes: roundRejoinSuccesses });
    totalRejoinAttempts += roundRejoinAttempts;
    totalRejoinSuccesses += roundRejoinSuccesses;
    totalClanOpportunities += roundClanOpportunities;
    totalClanSuccesses += roundClanSuccesses;
    
    console.log(
      ` ${String(i + 1).padStart(2)}   ${layer}  ${actualSc.padStart(7)}  ${saRegret.padStart(9)}  ${noOpRegret.padStart(11)}  ${String(nJoins).padStart(6)}  ${String(rejoinRate).padStart(7)}%  ${String(clanRate).padStart(8)}%`
    );
  }
  console.log();

  // ─────────────────────────────────────────────────────────────────────────────
  // OVERFITTING WARNINGS: Outlier detection on per-round deltas (winner vs 2nd-best)
  // ─────────────────────────────────────────────────────────────────────────────

  const secondBest = coarseResults.length > 1 ? coarseResults[1] : null;
  const deltas = [];
  for (let i = 0; i < rounds.length; i++) {
    // Exclude seed rounds with score 0.00
    if (winner.roundScores[i] === 0 || !secondBest || secondBest.roundScores[i] === 0) continue;
    deltas.push(winner.roundScores[i] - secondBest.roundScores[i]);
  }

  const overfitWarnings = [];
  if (deltas.length > 0 && secondBest) {
    const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const variance = deltas.reduce((sum, d) => sum + Math.pow(d - meanDelta, 2), 0) / deltas.length;
    const stdDev = Math.sqrt(variance);
    const threshold = meanDelta - 2 * stdDev; // Negative outlier threshold (winner gains more than typical)

    for (let i = 0; i < rounds.length; i++) {
      if (winner.roundScores[i] === 0 || !secondBest || secondBest.roundScores[i] === 0) continue;
      const delta = winner.roundScores[i] - secondBest.roundScores[i];
      if (delta < threshold) {
        overfitWarnings.push({
          roundNum: rounds[i].lineNum,
          layer: rounds[i].data.layerName,
          delta: delta.toFixed(3),
          threshold: threshold.toFixed(3),
          winnerScore: winner.roundScores[i].toFixed(3),
          secondBestScore: secondBest.roundScores[i].toFixed(3),
        });
      }
    }
  }

  if (overfitWarnings.length > 0) {
    console.log('════════════════════════════════════════════════════════════════════');
    console.log('⚠  OVERFITTING WARNINGS');
    console.log('════════════════════════════════════════════════════════════════════\n');
    console.log('Rounds where winner outperforms 2nd-best anomalously (outlier deltas):\n');

    for (const w of overfitWarnings) {
      console.log(`  Round ${w.roundNum}: ${w.layer}`);
      console.log(`    Winner: ${w.winnerScore} vs 2nd: ${w.secondBestScore} | Delta: ${w.delta} (threshold: ${w.threshold})\n`);
    }
  }

  // Summary: Rejoin success rate
  console.log('════════════════════════════════════════════════════════════════════');
  console.log('RECONNECT SUMMARY');
  console.log('════════════════════════════════════════════════════════════════════\n');
  const overallRejoinRate = totalRejoinAttempts > 0 
    ? ((totalRejoinSuccesses / totalRejoinAttempts) * 100).toFixed(1)
    : 'N/A';
  console.log(`Rejoin success rate (overall): ${overallRejoinRate}% (${totalRejoinSuccesses}/${totalRejoinAttempts} attempts)\n`);

  // Summary: Clan grouping success rate
  console.log('════════════════════════════════════════════════════════════════════');
  console.log('CLAN GROUPING SUMMARY');
  console.log('════════════════════════════════════════════════════════════════════\n');
  const overallClanRate = totalClanOpportunities > 0 
    ? ((totalClanSuccesses / totalClanOpportunities) * 100).toFixed(1)
    : 'N/A';
  console.log(`Clan grouping success rate (overall): ${overallClanRate}% (${totalClanSuccesses}/${totalClanOpportunities} opportunities)\n`);

  // Baseline comparison: Winner with ClanGroup disabled
  if (winner.params.enableClanGrouping) {
    console.log('════════════════════════════════════════════════════════════════════');
    console.log('CLAN GROUPING IMPACT (Comparison: Winner with ClanGroup disabled)');
    console.log('════════════════════════════════════════════════════════════════════\n');

    const winnerNoClanParams = { ...winner.params, enableClanGrouping: false };
    let noClanClanOpportunities = 0;
    let noClanClanSuccesses = 0;

    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      const saState = createSimState();
      const deferredPlayers = new Map();
      let snapSeen = false;
      const roundTagMap = new Map();
      const events = (r.data.events || []).slice().sort((a, b) => (a.ts ?? a.timestamp) - (b.ts ?? b.timestamp));
      
      for (const ev of events) {
        if (deferredPlayers.size > 0 && ev.steamID && deferredPlayers.has(ev.steamID)) {
          let resolvedTeam = null;
          if (ev.eventType === 'LEAVE' && (ev.teamID === 1 || ev.teamID === 2)) {
            resolvedTeam = ev.teamID;
          } else if (ev.eventType === 'TEAM_CHANGE' && (ev.newTeam === 1 || ev.newTeam === 2)) {
            resolvedTeam = ev.newTeam === 1 ? 2 : 1;
          } else if (ev.eventType === 'JOIN') {
            resolvedTeam = ev.teamID === 1 || ev.teamID === 2 ? ev.teamID : null;
          }
          if (resolvedTeam) {
            const deferred = deferredPlayers.get(ev.steamID);
            saState.players.set(ev.steamID, {
              steamID: ev.steamID,
              teamID: resolvedTeam,
              mu: deferred.mu
            });
            deferredPlayers.delete(ev.steamID);
          }
        }

        if (snapSeen && ev.betweenRounds) break;
        if (ev.eventType === 'ROUND_SNAPSHOT') {
          snapSeen = true;
          for (const p of ev.players) {
            const tid = Number(p.teamID);
            if (tid === 1 || tid === 2) {
              saState.players.set(p.steamID, { steamID: p.steamID, teamID: tid, mu: DEFAULT_MU });
            }
            const rawTag = extractRawPrefix(p.name || '');
            if (rawTag) roundTagMap.set(p.steamID, rawTag.replace(/[^a-zA-Z0-9]/g, '').toUpperCase());
          }
          for (const p of ev.players) {
            const tid = Number(p.teamID);
            if (tid !== 1 && tid !== 2) {
              deferredPlayers.set(p.steamID, { mu: DEFAULT_MU });
            }
          }
        } else if (ev.eventType === 'JOIN') {
          const rawTag = extractRawPrefix(ev.name || '');
          if (rawTag) roundTagMap.set(ev.steamID, rawTag.replace(/[^a-zA-Z0-9]/g, '').toUpperCase());

          // Track clan grouping for this join (using winner params WITH clan grouping enabled)
          const joinerTag = roundTagMap.get(ev.steamID);
          if (joinerTag) {
            let t1Clan = 0, t2Clan = 0;
            for (const [sid, p] of saState.players) {
              if (sid === ev.steamID) continue;
              const pTag = roundTagMap.get(sid);
              if (pTag === joinerTag) {
                if (String(p.teamID) === '1') t1Clan++;
                else if (String(p.teamID) === '2') t2Clan++;
              }
            }
            const minMates = 1;
            if ((t1Clan >= minMates && t2Clan === 0) || (t2Clan >= minMates && t1Clan === 0)) {
              noClanClanOpportunities++;
              // Note: we count opportunities but assume 0% success since clan grouping is disabled
              // This shows the missed opportunities
            }
          }

          saState.reconnectMemory.set(ev.steamID, null);
        } else if (ev.eventType === 'LEAVE') {
          const existing = saState.players.get(ev.steamID);
          if (existing) {
            const tid = Number(existing.teamID);
            if (tid === 1 || tid === 2) saState.reconnectMemory.set(ev.steamID, { teamID: tid, leaveTime: ev.timestamp });
          }
          saState.players.delete(ev.steamID);
        } else if (ev.eventType === 'TEAM_CHANGE') {
          const existing = saState.players.get(ev.steamID);
          if (existing) existing.teamID = ev.newTeam;
          else saState.players.set(ev.steamID, { steamID: ev.steamID, teamID: ev.newTeam, mu: DEFAULT_MU });
        }
      }
    }

    const clanDisabledRate = 0; // When disabled, success rate is 0%
    console.log(`With ClanGroup ENABLED:  ${overallClanRate}% (${totalClanSuccesses}/${totalClanOpportunities} opportunities)`);
    console.log(`With ClanGroup DISABLED: ${clanDisabledRate}% (0/${noClanClanOpportunities} opportunities - all missed)\n`);
    console.log(`Clan grouping enabled ${totalClanSuccesses} successful groupings out of ${totalClanOpportunities} opportunities.\n`);
  }

  console.log('════════════════════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error(err); process.exit(1); });
