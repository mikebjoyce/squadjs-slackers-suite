/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   WOULD LOWERING THE REACTIVE SCRAMBLE THRESHOLDS HELP?        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Prompted by a tech-chat proposal (Fiercer/Slacker) to test two candidate
 * threshold changes to team-balancer.js's REACTIVE triggers:
 *
 *   A. minTicketsToCountAsDominantWin 150→100, singleRoundScrambleThreshold 200→150
 *   B. disable the dominant-win gate entirely (every win builds win-streak),
 *      singleRoundScrambleThreshold 200→150, maxConsecutiveWinsWithoutThreshold 3→2
 *
 * Fiercer's own objection is correct and worth stating up front: you cannot
 * naively replay a whole season under a different policy from history, because
 * every round after the first policy-changed decision would have had a
 * different roster (or none of this data would exist at all). This script does
 * NOT attempt that. What it *can* do without lying about it:
 *
 *   1. Reimplement the exact reactive state machine from team-balancer.js
 *      (consecutive-wins tracking, single-round margin, dominant-win gate,
 *      win-streak-to-scramble) as a pure function of the REAL recorded
 *      sequence of (winner, ticket margin) per round — no roster dependency —
 *      and replay it chronologically under each candidate config. This asks
 *      "how many more times would this policy have fired, given the games
 *      that actually happened," not "what would the games have looked like."
 *      That's a real, first-order answer to "how much more often," which is
 *      most of what was asked, with an honest label on what it isn't.
 *   2. For the rounds that are newly triggered under a candidate config (fired
 *      there, didn't fire in reality) — and ONLY those, not a full season
 *      replay — look up the same ENDGAME lobby snapshot scramble-replay.js
 *      uses and run it through the REAL Scrambler to see what balance it
 *      would have actually produced. This uses real historical rosters, so
 *      it's not circular in the way a full-season replay would be.
 *
 * Validation: the state machine below is checked against team-balancer.js's
 * own recorded scrambled/scrambleCondition counts before trusting any config
 * comparison — if it can't reproduce production's real trigger count under
 * production's real thresholds, nothing else here means anything.
 *
 *   node --max-old-space-size=4096 analysis/reactive-threshold-sweep.js
 */

import { Scrambler } from '../team-balancer/utils/tb-scrambler.js';
import ClansService from '../s3/utils/clans-service.js';
import { newestExport, loadExport, table, describe, fmt } from './load-export.js';

const DEFAULT_MU = 25.0;
const MIN_LOBBY = 80;
const TS_TOLERANCE_MS = 300_000;

const clans = new ClansService({ options: { enabled: true, minSize: 2, maxSize: 25 } });

/* isIgnoredMode() default list (game-state-service.js / S3_DEVELOPER_GUIDE.md
 * §1962): ['Seed', 'Jensen']. An ignored-mode round takes a full reset path in
 * team-balancer.js (isIgnoredMatch() → resetStreak(), returns before the
 * consecutive-wins increment) — it does NOT feed the streak counters. Every
 * other mode (RAAS, Invasion, AAS, Territory Control, Unknown) DOES feed them,
 * so filtering the input to RAAS-only breaks real win/loss chains across mode
 * changes. The full chronological non-ignored sequence has to be simulated;
 * only the RAAS subset is compared against TB_RoundReport's recorded numbers. */
const IGNORED_MODES = ['Seed', 'Jensen'];
const isIgnoredMode = (gameMode) => IGNORED_MODES.includes(gameMode);

const exp = loadExport(newestExport());
const allRounds = table(exp, 'TB_RoundReport')
  .filter((r) => !isIgnoredMode(r.gameMode))
  .sort((a, b) => a.ts - b.ts);
const tbRounds = allRounds.filter((r) => r.gameMode === 'RAAS');
const snapshots = table(exp, 'S3PlayerSnapshots');
const roundPlayers = table(exp, 'Elo_RoundPlayers');
const eloRounds = table(exp, 'Elo_RoundHistory');

console.log(`\n═══ REACTIVE THRESHOLD SWEEP — would lowering the triggers fire more, and would it help? ═══\n`);
console.log(`  non-ignored-mode rounds (feed the streak counters): ${allRounds.length}`);
console.log(`  of which RAAS: ${tbRounds.length}`);
console.log(`  RAAS rounds actually scrambled (recorded): ${tbRounds.filter((r) => r.scrambled).length}\n`);

/* ─── State machine, ported directly from team-balancer.js onRoundEnded ───
 * Runs over ALL non-ignored-mode rounds (matching production, which sees
 * every mode), but only rounds passed in `rounds` can themselves fire a
 * trigger the caller cares about recording — every round still updates the
 * counters and can still trigger, matching the real control flow exactly;
 * the caller decides which mode subset it wants triggers reported FOR by
 * filtering the returned list, not the input. */
function simulate(rounds, cfg) {
  let consecutiveWinsTeam = null;
  let consecutiveWinsCount = 0;
  let winStreakTeam = null;
  let winStreakCount = 0;
  const triggers = [];

  for (const r of rounds) {
    const isInvasion = r.gameMode === 'Invasion';

    if (consecutiveWinsTeam === r.winningTeamID) consecutiveWinsCount++;
    else {
      consecutiveWinsTeam = r.winningTeamID;
      consecutiveWinsCount = 1;
    }

    let condition = null;

    if (cfg.maxConsecutiveWinsWithoutThreshold > 0 && consecutiveWinsCount >= cfg.maxConsecutiveWinsWithoutThreshold) {
      condition = 'Consecutive Wins';
    } else if (cfg.enableSingleRoundScramble && !isInvasion && r.ticketMargin >= cfg.singleRoundScrambleThreshold) {
      condition = 'Single Round Margin';
    } else {
      let isDominant;
      if (isInvasion) {
        const atk = cfg.invasionAttackTeamThreshold ?? 300;
        const def = cfg.invasionDefenceTeamThreshold ?? 650;
        isDominant = (r.winningTeamID === 1 && r.ticketMargin >= atk) || (r.winningTeamID === 2 && r.ticketMargin >= def);
      } else {
        isDominant =
          cfg.minTicketsToCountAsDominantWin == null ? true : r.ticketMargin >= cfg.minTicketsToCountAsDominantWin;
      }
      if (!isDominant) {
        winStreakTeam = null;
        winStreakCount = 0;
      } else {
        if (winStreakTeam === r.winningTeamID) winStreakCount++;
        else {
          winStreakTeam = r.winningTeamID;
          winStreakCount = 1;
        }
        if (winStreakCount >= cfg.maxWinStreak) condition = 'Win Streak Threshold';
      }
    }

    if (condition) {
      triggers.push({ id: r.id, matchId: r.matchId, ts: r.ts, gameMode: r.gameMode, condition });
      consecutiveWinsTeam = null;
      consecutiveWinsCount = 0;
      winStreakTeam = null;
      winStreakCount = 0;
    }
  }
  return triggers;
}

const PRODUCTION_CFG = {
  maxConsecutiveWinsWithoutThreshold: 3,
  enableSingleRoundScramble: true,
  singleRoundScrambleThreshold: 200,
  minTicketsToCountAsDominantWin: 150,
  maxWinStreak: 2
};

/* ─── Validate against team-balancer.js's own recorded counts ─────────────
 * simulate() runs over ALL non-ignored-mode rounds so the streak counters
 * chain correctly across mode changes, exactly as production does; results
 * are then filtered down to RAAS to compare against TB_RoundReport's RAAS
 * scrambled/scrambleCondition counts. */
const prodSimAll = simulate(allRounds, PRODUCTION_CFG);
const prodSim = prodSimAll.filter((t) => t.gameMode === 'RAAS');
const realCount = tbRounds.filter((r) => r.scrambled).length;
console.log('─── Validation: does this state machine reproduce production\'s real trigger count? ───\n');
console.log(`  recorded scrambled rounds:     ${realCount}`);
console.log(`  simulated (production config): ${prodSim.length}`);
const byCondReal = new Map();
for (const r of tbRounds) if (r.scrambled) byCondReal.set(r.scrambleCondition, (byCondReal.get(r.scrambleCondition) || 0) + 1);
const byCondSim = new Map();
for (const t of prodSim) byCondSim.set(t.condition, (byCondSim.get(t.condition) || 0) + 1);
for (const cond of ['Single Round Margin', 'Consecutive Wins', 'Win Streak Threshold']) {
  console.log(`    ${cond.padEnd(22)} recorded ${String(byCondReal.get(cond) || 0).padStart(4)}   simulated ${String(byCondSim.get(cond) || 0).padStart(4)}`);
}
const closeEnough = Math.abs(prodSim.length - realCount) <= realCount * 0.1;
console.log(
  closeEnough
    ? '\n  Close enough to trust the state machine — small gaps are expected from manual/Discord-triggered\n  scrambles and mid-scramble edge cases this replay can\'t see.\n'
    : '\n  NOT close enough — do not trust the comparisons below without fixing this first.\n'
);

/* ─── The two candidate configs from tech chat ───────────────────────────── */
const CONFIGS = {
  'A (100/150)': { ...PRODUCTION_CFG, minTicketsToCountAsDominantWin: 100, singleRoundScrambleThreshold: 150 },
  'B (no dominant gate)': {
    ...PRODUCTION_CFG,
    minTicketsToCountAsDominantWin: null,
    singleRoundScrambleThreshold: 150,
    maxConsecutiveWinsWithoutThreshold: 2
  }
};

console.log('═══ 1. How much more often would each config fire? ═══\n');
const results = {};
const prodIds = new Set(prodSim.map((t) => t.id));
for (const [name, cfg] of Object.entries(CONFIGS)) {
  const sim = simulate(allRounds, cfg).filter((t) => t.gameMode === 'RAAS');
  results[name] = sim;
  const marginal = sim.filter((t) => !prodIds.has(t.id));
  console.log(
    `  ${name.padEnd(22)} total triggers ${String(sim.length).padStart(4)} (${fmt((sim.length / tbRounds.length) * 100, 1)}% of RAAS rounds)   ` +
      `new vs production: +${marginal.length}`
  );
}

/* ─── Build ENDGAME lobbies for the marginal rounds only ─────────────────── */
console.log('\n═══ 2. What would the real scrambler actually do on the marginally-triggered rounds? ═══\n');

const roundEndAt = new Map();
for (const r of eloRounds) if (Number.isFinite(r.endedAt)) roundEndAt.set(r.id, r.endedAt);
const timeline = new Map();
for (const p of roundPlayers) {
  const at = roundEndAt.get(p.roundHistoryId);
  if (!Number.isFinite(at) || !Number.isFinite(p.muAfter)) continue;
  if (!timeline.has(p.eosID)) timeline.set(p.eosID, []);
  timeline.get(p.eosID).push({ at, mu: p.muAfter });
}
for (const arr of timeline.values()) arr.sort((a, b) => a.at - b.at);
function ratingAt(eosID, ts) {
  const hist = timeline.get(eosID);
  if (!hist || hist.length === 0 || hist[0].at >= ts) return null;
  let lo = 0;
  let hi = hist.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hist[mid].at < ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return null;
  return { mu: hist[best].mu, roundsPlayed: best + 1 };
}

const endgameByMatch = new Map();
const endgameByTs = [];
for (const s of snapshots) {
  if (s.trigger !== 'ENDGAME') continue;
  if (s.matchId) endgameByMatch.set(s.matchId, s);
  endgameByTs.push(s);
}
endgameByTs.sort((a, b) => a.ts - b.ts);
function endgameFor(round) {
  if (round.matchId && endgameByMatch.has(round.matchId)) return endgameByMatch.get(round.matchId);
  let lo = 0;
  let hi = endgameByTs.length - 1;
  let best = null;
  let bestD = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = endgameByTs[mid].ts - round.ts;
    if (Math.abs(d) < bestD) {
      bestD = Math.abs(d);
      best = endgameByTs[mid];
    }
    if (d < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return bestD <= TS_TOLERANCE_MS ? best : null;
}

function buildLobby(round) {
  const snap = endgameFor(round);
  if (!snap) return null;
  let roster;
  try {
    roster = JSON.parse(snap.playersJson);
  } catch {
    return null;
  }
  const onTeam = roster.filter((p) => p.teamID === 1 || p.teamID === 2);
  if (onTeam.length < MIN_LOBBY) return null;

  const eloMap = new Map();
  let rated = 0;
  for (const p of onTeam) {
    const r = ratingAt(p.eosID, snap.ts);
    if (r) {
      eloMap.set(p.eosID, r);
      rated++;
    }
  }
  if (rated / onTeam.length < 0.5) return null;

  const players = onTeam.map((p) => ({
    eosID: p.eosID,
    name: p.name,
    teamID: String(p.teamID),
    squadID: p.squadID ? `T${p.teamID}-S${p.squadID}` : null
  }));
  const squadMap = new Map();
  for (const p of players) {
    if (!p.squadID) continue;
    if (!squadMap.has(p.squadID)) squadMap.set(p.squadID, { id: p.squadID, teamID: p.teamID, players: [], locked: false });
    squadMap.get(p.squadID).players.push(p.eosID);
  }
  const clanGroups = clans.extractClanGroups(onTeam.map((p) => ({ eosID: p.eosID, name: p.name })), {});

  const preGap = muDeltaOf(players, eloMap);
  return { players, squads: [...squadMap.values()], eloMap, clanGroups, preGap };
}

function muDeltaOf(players, eloMap) {
  let t1 = 0, n1 = 0, t2 = 0, n2 = 0;
  for (const p of players) {
    const mu = eloMap.get(p.eosID)?.mu ?? DEFAULT_MU;
    if (p.teamID === '1') { t1 += mu; n1++; } else { t2 += mu; n2++; }
  }
  return n1 && n2 ? Math.abs(t1 / n1 - t2 / n2) : NaN;
}

const byId = new Map(tbRounds.map((r) => [r.id, r]));

for (const [name, sim] of Object.entries(results)) {
  const marginal = sim.filter((t) => !prodIds.has(t.id));
  const gaps = { pre: [], post: [], moved: [] };
  let skipped = 0;
  for (const t of marginal) {
    const round = byId.get(t.id);
    const lobby = buildLobby(round);
    if (!lobby) {
      skipped++;
      continue;
    }
    const plan = await Scrambler.scrambleTeamsPreservingSquads({
      squads: lobby.squads.map((s) => ({ ...s, players: [...s.players] })),
      players: lobby.players.map((p) => ({ ...p })),
      winStreakTeam: 1,
      scramblePercentage: 0.5,
      eloMap: lobby.eloMap,
      minPlayersToMove: 0,
      maxPlayersToMove: 0,
      clanGroups: lobby.clanGroups
    });
    if (!Array.isArray(plan)) {
      skipped++;
      continue;
    }
    /* This branch's Scrambler.scrambleTeamsPreservingSquads doesn't attach an
     * eloSummary (that property doesn't exist on tb-scrambler.js here) — the
     * pre/post gap is computed the same way scramble-replay.js's postNaiveGap
     * is: apply the plan's moves to the pre-scramble team assignment and rerun
     * the plugin's own muDeltaOf() arithmetic. */
    const finalTeamOf = new Map(lobby.players.map((p) => [p.eosID, p.teamID]));
    for (const move of plan) finalTeamOf.set(move.eosID, String(move.targetTeamID));
    const postGap = muDeltaOf(
      lobby.players.map((p) => ({ eosID: p.eosID, teamID: finalTeamOf.get(p.eosID) })),
      lobby.eloMap
    );
    gaps.pre.push(lobby.preGap);
    gaps.post.push(postGap);
    gaps.moved.push(plan.length);
  }
  console.log(`  ${name}: ${marginal.length} marginal rounds, ${gaps.pre.length} matched to a usable lobby (${skipped} skipped — no ENDGAME/thin roster)`);
  if (gaps.pre.length >= 10) {
    const pre = describe(gaps.pre);
    const post = describe(gaps.post);
    const moved = describe(gaps.moved);
    console.log(
      `    mu gap on those rounds:  currently-left-alone mean ${fmt(pre.mean)}  →  if scrambled, mean ${fmt(post.mean)}   ` +
        `(players moved: mean ${fmt(moved.mean, 1)})`
    );
  }
  console.log('');
}

console.log('═══ Verdict ═══\n');
console.log('  This answers "how much more often would it fire, and what would the scrambler actually');
console.log('  do to those specific rounds" — both real, first-order answers. It does NOT answer "what');
console.log('  would the season have looked like," because a scramble that happens changes who\'s on the');
console.log('  server for the NEXT round\'s streak counters, and this replay can\'t rewind that. The');
console.log('  already-validated alternative (§4 direction 1, analysis/predictive-trigger-simulate.js) is');
console.log('  structurally cleaner for exactly this reason: it evaluates one round at a time against a');
console.log('  fixed pre-round gap threshold, so it never depends on a counterfactual chain of prior');
console.log('  decisions the way a lowered reactive-margin threshold does.\n');
