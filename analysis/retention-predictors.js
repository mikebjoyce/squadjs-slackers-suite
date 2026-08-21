/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   DOES ANYTHING PRE-ROUND PREDICT WHO WILL LEAVE MID-ROUND?   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * §4 direction 3: the scrambler optimises parity over a lobby that is 42% gone
 * by round end (§2.4's 0.09 → 0.25 decay). The proposal is to weight the
 * objective toward players likely to stay, using session length so far and
 * historical round count. That is only worth building if retention is
 * predictable from information available AT round start — nothing else is
 * usable by a scrambler that runs once, before the round plays out.
 *
 * This is a gating test, not the full direction. If nothing pre-round predicts
 * who leaves, direction 3 is dead in one script, the same way direction 2
 * (squad coordination) died in one script. If something does, it's worth
 * building the weighted objective and testing it against the decay curve.
 *
 * Player-round leave label comes from S3PlayerEvents directly (real connect/
 * disconnect log, not the coarser LIVE-vs-ENDGAME roster diff §6 used): a
 * mid-round LEAVE (betweenRounds=0) between round start and round end. Session
 * length comes from the same table — ts minus the player's most recent JOIN
 * before round start, the actual connect time, not S3_PlayerSession (which
 * only holds each player's CURRENT session at export time, unusable for
 * historical rounds).
 *
 * Candidate predictors, all available at round start:
 *   sessionMinutes   — minutes since this connection began
 *   roundsPlayed     — Elo-tracked historical experience (veteran vs fresh)
 *   rated            — has Elo ever scored this player at all
 *   inSquad          — assigned to a squad at round start, or solo
 *
 * onLosingTeam is included ONLY as a benchmark for how much variance the
 * outcome itself explains — a real scrambler cannot see it, so it does not
 * count toward "is this actionable".
 *
 *   node --max-old-space-size=4096 analysis/retention-predictors.js
 */

import {
  newestExport,
  loadExport,
  table,
  isCompetitive,
  effectivePopulation,
  MIN_EFFECTIVE_PLAYERS,
  describe,
  fmt,
  fitLogistic,
  crossValidate as cvShared,
  chiSqP,
  pStr
} from './load-export.js';

const DEFAULT_MU = 25.0;
const TS_TOLERANCE_MS = 300_000;

const exp = loadExport(newestExport());
const snapshots = table(exp, 'S3PlayerSnapshots');
const eloRounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');
const playerEvents = table(exp, 'S3PlayerEvents');

console.log('\n═══ DOES ANYTHING PRE-ROUND PREDICT MID-ROUND LEAVING? ═══\n');

/* ─── JOIN history per player, for session length ───────────────────────── */

const joinsByEos = new Map();
const leavesByEos = new Map();
for (const e of playerEvents) {
  if (e.eventType === 'JOIN') {
    if (!joinsByEos.has(e.eosID)) joinsByEos.set(e.eosID, []);
    joinsByEos.get(e.eosID).push(e.ts);
  } else if (e.eventType === 'LEAVE' && e.betweenRounds === 0) {
    // Mid-round leaves only — a between-rounds leave is a normal disconnect,
    // not the churn §2.4 measured.
    if (!leavesByEos.has(e.eosID)) leavesByEos.set(e.eosID, []);
    leavesByEos.get(e.eosID).push(e.ts);
  }
}
for (const arr of joinsByEos.values()) arr.sort((a, b) => a - b);
for (const arr of leavesByEos.values()) arr.sort((a, b) => a - b);

function lastJoinBefore(eosID, ts) {
  const hist = joinsByEos.get(eosID);
  if (!hist) return null;
  let lo = 0;
  let hi = hist.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hist[mid] < ts) {
      best = hist[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}
function leftBetween(eosID, tsStart, tsEnd) {
  const hist = leavesByEos.get(eosID);
  if (!hist) return false;
  return hist.some((t) => t >= tsStart && t <= tsEnd);
}

/* ─── roundsPlayed timeline (same construction as predictive-trigger-simulate.js) */

const roundEndAt = new Map();
for (const r of eloRounds) if (Number.isFinite(r.endedAt)) roundEndAt.set(r.id, r.endedAt);
const playedTimeline = new Map();
for (const p of roundPlayers) {
  const at = roundEndAt.get(p.roundHistoryId);
  if (!Number.isFinite(at)) continue;
  if (!playedTimeline.has(p.eosID)) playedTimeline.set(p.eosID, []);
  playedTimeline.get(p.eosID).push(at);
}
for (const arr of playedTimeline.values()) arr.sort((a, b) => a - b);
function roundsPlayedBefore(eosID, ts) {
  const hist = playedTimeline.get(eosID);
  if (!hist) return 0;
  let lo = 0;
  let hi = hist.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hist[mid] < ts) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/* ─── Round joins, identical pattern to the other §6/§7 scripts ────────── */

const byRoundId = new Map();
for (const p of roundPlayers) {
  if (!byRoundId.has(p.roundHistoryId)) byRoundId.set(p.roundHistoryId, []);
  byRoundId.get(p.roundHistoryId).push(p);
}
const eloByMatch = new Map();
const eloByTs = [];
for (const r of eloRounds) {
  if (r.matchId) eloByMatch.set(r.matchId, r);
  if (Number.isFinite(r.endedAt)) eloByTs.push(r);
}
eloByTs.sort((a, b) => a.endedAt - b.endedAt);

function roundForSnapshot(snap) {
  if (snap.matchId && eloByMatch.has(snap.matchId)) return eloByMatch.get(snap.matchId);
  let lo = 0;
  let hi = eloByTs.length - 1;
  let best = null;
  let bestD = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = eloByTs[mid].endedAt - snap.ts;
    if (Math.abs(d) < bestD) {
      bestD = Math.abs(d);
      best = eloByTs[mid];
    }
    if (d < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return bestD <= TS_TOLERANCE_MS ? best : null;
}
function pickByMatch(trigger, keep) {
  const out = new Map();
  for (const s of snapshots) {
    if (s.trigger !== trigger) continue;
    if (s.matchId == null) continue;
    const prev = out.get(s.matchId);
    if (!prev || (keep === 'earliest' ? s.ts < prev.ts : s.ts > prev.ts)) out.set(s.matchId, s);
  }
  return out;
}
const liveByMatch = pickByMatch('LIVE', 'earliest');

/* ─── Build player-round rows ────────────────────────────────────────────── */

const rows = [];
const rejected = { noRound: 0, nonCompetitive: 0, undecided: 0, tooSmall: 0, badRoster: 0 };
let noJoinData = 0;

for (const [matchId, liveSnap] of liveByMatch) {
  const rd = roundForSnapshot(liveSnap);
  if (!rd) {
    rejected.noRound++;
    continue;
  }
  if (!isCompetitive(rd.layerName)) {
    rejected.nonCompetitive++;
    continue;
  }
  if (rd.winningTeamID !== 1 && rd.winningTeamID !== 2) {
    rejected.undecided++;
    continue;
  }
  if (!Number.isFinite(rd.endedAt)) {
    rejected.undecided++;
    continue;
  }
  if (effectivePopulation(byRoundId.get(rd.id) || []) < MIN_EFFECTIVE_PLAYERS) {
    rejected.tooSmall++;
    continue;
  }

  let roster;
  try {
    roster = JSON.parse(liveSnap.playersJson);
  } catch {
    rejected.badRoster++;
    continue;
  }
  const onTeam = roster.filter((p) => p.teamID === 1 || p.teamID === 2);
  if (onTeam.length < MIN_EFFECTIVE_PLAYERS) {
    rejected.badRoster++;
    continue;
  }

  const rps = byRoundId.get(rd.id) || [];
  const muByEos = new Map();
  for (const p of rps) if (Number.isFinite(p.muBefore)) muByEos.set(p.eosID, p.muBefore);

  for (const p of onTeam) {
    const lastJoin = lastJoinBefore(p.eosID, liveSnap.ts);
    const sessionMinutes = lastJoin != null ? (liveSnap.ts - lastJoin) / 60000 : null;
    if (sessionMinutes == null) {
      noJoinData++;
      continue;
    }
    const left = leftBetween(p.eosID, liveSnap.ts, rd.endedAt) ? 1 : 0;
    rows.push({
      matchId,
      eosID: p.eosID,
      left,
      sessionMinutes,
      roundsPlayed: roundsPlayedBefore(p.eosID, liveSnap.ts),
      rated: muByEos.has(p.eosID) ? 1 : 0,
      mu: muByEos.get(p.eosID) ?? DEFAULT_MU,
      inSquad: p.squadID != null ? 1 : 0,
      onLosingTeam: p.teamID !== rd.winningTeamID ? 1 : 0
    });
  }
}

console.log('─── Round selection ───');
console.log(`  usable rounds:              ${liveByMatch.size - rejected.noRound - rejected.nonCompetitive - rejected.undecided - rejected.tooSmall - rejected.badRoster}`);
console.log(`  dropped, no matching round: ${rejected.noRound}`);
console.log(`  dropped, non-RAAS:          ${rejected.nonCompetitive}`);
console.log(`  dropped, undecided/no end:  ${rejected.undecided}`);
console.log(`  dropped, under ${MIN_EFFECTIVE_PLAYERS} eff pop:   ${rejected.tooSmall}`);
console.log(`  dropped, thin roster:       ${rejected.badRoster}`);
console.log(`  player-rounds:              ${rows.length}   (dropped, no JOIN before round: ${noJoinData})\n`);

if (rows.length < 200) {
  console.log('Too few player-rounds to say anything. Stopping.\n');
  process.exit(0);
}

/* ─── 1. Base rate and the known driver (outcome), for context ─────────── */

console.log('═══ 1. Base rates ═══\n');
const overallLeftRate = rows.filter((r) => r.left).length / rows.length;
console.log(`  overall mid-round leave rate: ${fmt(overallLeftRate * 100, 1)}% (n=${rows.length})`);
const winLeft = rows.filter((r) => !r.onLosingTeam).map((r) => r.left);
const loseLeft = rows.filter((r) => r.onLosingTeam).map((r) => r.left);
console.log(
  `  winning side: ${fmt((winLeft.reduce((s, v) => s + v, 0) / winLeft.length) * 100, 1)}%   ` +
    `losing side: ${fmt((loseLeft.reduce((s, v) => s + v, 0) / loseLeft.length) * 100, 1)}%   ` +
    '(outcome — NOT usable by the scrambler pre-round, shown for scale only)\n'
);

console.log(`  session length (minutes): median ${fmt(describe(rows.map((r) => r.sessionMinutes)).median, 1)}, ` +
  `p95 ${fmt(describe(rows.map((r) => r.sessionMinutes)).p95, 1)}`);
console.log(`  rounds played (Elo history): median ${fmt(describe(rows.map((r) => r.roundsPlayed)).median, 0)}, ` +
  `p95 ${fmt(describe(rows.map((r) => r.roundsPlayed)).p95, 0)}`);
console.log(`  unrated share: ${fmt((rows.filter((r) => !r.rated).length / rows.length) * 100, 1)}%`);
console.log(`  solo (no squad) share: ${fmt((rows.filter((r) => !r.inSquad).length / rows.length) * 100, 1)}%\n`);

/* ─── 2. Does anything PRE-ROUND predict leaving? ───────────────────────── */

console.log('═══ 2. Nested LRT — pre-round predictors only (no outcome) ═══\n');

const y = rows.map((r) => r.left);
const p1 = overallLeftRate;
const llConst = y.reduce((s, v) => s + (v ? Math.log(p1) : Math.log(1 - p1)), 0);

const PREROUND = [
  ['sessionMinutes', (r) => r.sessionMinutes],
  ['roundsPlayed', (r) => r.roundsPlayed],
  ['rated', (r) => r.rated],
  ['inSquad', (r) => r.inSquad],
  ['mu', (r) => r.mu]
];

console.log('  feature            ΔlogLik vs constant   p         direction');
const single = new Map();
for (const [name, fn] of PREROUND) {
  const X = rows.map((r) => [fn(r)]);
  const m = fitLogistic(X, y);
  const d = m.ll - llConst;
  const p = chiSqP(Math.max(0, 2 * d), 1);
  single.set(name, { d, p, w: m.wRaw[0] });
  console.log(
    `  ${name.padEnd(18)} ${fmt(d, 2).padStart(6)}                ${pStr(p).padEnd(9)} ` +
      `${m.wRaw[0] > 0 ? 'higher → more likely to leave' : 'higher → less likely to leave'}` +
      `${p < 0.05 ? '  ←' : ''}`
  );
}

const allPreX = rows.map((r) => [r.sessionMinutes, r.roundsPlayed, r.rated, r.inSquad, r.mu]);
const allPre = fitLogistic(allPreX, y);
const dAll = allPre.ll - llConst;
const pAll = chiSqP(Math.max(0, 2 * dAll), 4);
console.log(`\n  all five together   ΔlogLik ${fmt(dAll, 2)}   p ${pStr(pAll)} (df=4)   in-sample acc ${fmt(allPre.acc * 100, 1)}%`);

/* ─── 3. Held-out check — the number that should decide this ───────────── */

console.log('\n═══ 3. Five-fold CV — does it generalise? ═══\n');
const cvConst = { logLoss: -llConst / rows.length, acc: Math.max(p1, 1 - p1) };
console.log(`  constant-rate baseline              logLoss ${fmt(cvConst.logLoss, 4)}   acc ${fmt(cvConst.acc * 100, 1)}%`);
const cvAll = cvShared(allPreX, y, 5);
console.log(`  all pre-round predictors            logLoss ${fmt(cvAll.logLoss, 4)}   acc ${fmt(cvAll.acc * 100, 1)}%   ` +
  `${cvConst.logLoss - cvAll.logLoss > 0 ? `(${fmt(cvConst.logLoss - cvAll.logLoss, 4)} better)` : '(no better, or worse)'}`);

/* Benchmark: how much does the outcome (unusable pre-round) explain, for scale */
const withOutcomeX = rows.map((r) => [r.sessionMinutes, r.roundsPlayed, r.rated, r.inSquad, r.mu, r.onLosingTeam]);
const cvOutcome = cvShared(withOutcomeX, y, 5);
console.log(`  + onLosingTeam (not usable pre-round) logLoss ${fmt(cvOutcome.logLoss, 4)}   acc ${fmt(cvOutcome.acc * 100, 1)}%   (benchmark only)`);

/* ─── 4. Verdict ─────────────────────────────────────────────────────────── */

console.log('\n═══ 4. Verdict ═══\n');
const genuinelyHelps = cvConst.logLoss - cvAll.logLoss > 0.001 && pAll < 0.05;
if (genuinelyHelps) {
  console.log('  Pre-round information predicts mid-round leaving, held out. Direction 3 is worth');
  console.log('  building: weight the objective toward the predicted stayers using the features that');
  console.log('  survived the test above.');
} else {
  console.log('  Pre-round information barely moves held-out prediction of who leaves — most of what');
  console.log('  determines leaving is the outcome itself (see the onLosingTeam benchmark), which the');
  console.log('  scrambler cannot see at round start. Direction 3 does not have a usable lever here.');
}
console.log('');
