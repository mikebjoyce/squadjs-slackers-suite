/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  DOES WEIGHTING PARITY TOWARD LIKELY STAYERS PREDICT THE      ║
 * ║  BALANCE THAT ACTUALLY PLAYS OUT BETTER THAN NAIVE PARITY?    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Part 1 (retention-predictors.js) established that mid-round leaving is
 * predictable pre-round, and pre-round features alone capture almost all the
 * signal that even knowing the outcome would (CV logLoss 0.5465 vs 0.5435
 * with the outcome added). Part 2 asks the actual direction-3 question: if
 * the scrambler weighted its parity objective toward players unlikely to
 * leave, would that objective track the balance that actually plays out
 * BETTER than today's parity-among-everyone objective does?
 *
 * Ground truth for "the balance that actually plays out" is the ENDGAME
 * roster's mu gap — the realized team strengths after whatever churn
 * happened, using each player's real muBefore (ratings don't change
 * mid-round, so this is exact, not modeled).
 *
 * Two candidate PRE-ROUND estimators of that same quantity, both computed
 * only from information available at round start:
 *
 *   naiveGap    — today's scrambler input: mean mu diff over the whole LIVE
 *                 roster, everyone weighted equally.
 *   weightedGap — mean mu diff over the LIVE roster, each player weighted by
 *                 their out-of-fold predicted P(stay) from part 1's model.
 *
 * If weightedGap tracks the realized ENDGAME gap more closely than naiveGap
 * does, direction 3 has a real, actionable lever. If not, the retention
 * signal from part 1 doesn't translate into a better balance objective and
 * direction 3 stops here despite passing part 1's gate.
 *
 * Out-of-fold P(stay): the retention model is refit on 5 chronological folds
 * and each player-round is scored by a model that never saw its own fold, so
 * this is not circular — weightedGap could not "cheat" using its own outcome.
 *
 *   node --max-old-space-size=4096 analysis/stayer-weighted-balance.js
 */

import {
  newestExport,
  loadExport,
  table,
  isCompetitive,
  effectivePopulation,
  MIN_EFFECTIVE_PLAYERS,
  describe,
  correlation,
  fmt,
  fitLogistic
} from './load-export.js';

const DEFAULT_MU = 25.0;
const TS_TOLERANCE_MS = 300_000;
const FOLDS = 5;

const exp = loadExport(newestExport());
const snapshots = table(exp, 'S3PlayerSnapshots');
const eloRounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');
const playerEvents = table(exp, 'S3PlayerEvents');

console.log('\n═══ STAYER-WEIGHTED PARITY vs NAIVE PARITY — WHICH PREDICTS THE REALIZED GAP? ═══\n');

/* ─── JOIN/LEAVE history, identical to retention-predictors.js ─────────── */

const joinsByEos = new Map();
const leavesByEos = new Map();
for (const e of playerEvents) {
  if (e.eventType === 'JOIN') {
    if (!joinsByEos.has(e.eosID)) joinsByEos.set(e.eosID, []);
    joinsByEos.get(e.eosID).push(e.ts);
  } else if (e.eventType === 'LEAVE' && e.betweenRounds === 0) {
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

/* ─── Round joins, LIVE + ENDGAME + Elo, identical pattern to §6/§7 ─────── */

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
const endByMatch = pickByMatch('ENDGAME', 'latest');

/* ─── Build rounds: LIVE roster with per-player features, + END roster set */

const rounds = [];
const rejected = { noEnd: 0, noRound: 0, nonCompetitive: 0, tooSmall: 0, badRoster: 0 };

for (const [matchId, liveSnap] of liveByMatch) {
  const endSnap = endByMatch.get(matchId);
  if (!endSnap) {
    rejected.noEnd++;
    continue;
  }
  const rd = roundForSnapshot(liveSnap);
  if (!rd) {
    rejected.noRound++;
    continue;
  }
  if (!isCompetitive(rd.layerName)) {
    rejected.nonCompetitive++;
    continue;
  }
  if (!Number.isFinite(rd.endedAt)) {
    rejected.noRound++;
    continue;
  }
  if (effectivePopulation(byRoundId.get(rd.id) || []) < MIN_EFFECTIVE_PLAYERS) {
    rejected.tooSmall++;
    continue;
  }

  let liveRoster;
  let endRoster;
  try {
    liveRoster = JSON.parse(liveSnap.playersJson);
    endRoster = JSON.parse(endSnap.playersJson);
  } catch {
    rejected.badRoster++;
    continue;
  }
  const liveOnTeam = liveRoster.filter((p) => p.teamID === 1 || p.teamID === 2);
  const endOnTeam = endRoster.filter((p) => p.teamID === 1 || p.teamID === 2);
  if (liveOnTeam.length < MIN_EFFECTIVE_PLAYERS || endOnTeam.length < MIN_EFFECTIVE_PLAYERS) {
    rejected.badRoster++;
    continue;
  }
  const endIds = new Set(endOnTeam.map((p) => p.eosID));

  const rps = byRoundId.get(rd.id) || [];
  const muByEos = new Map();
  for (const p of rps) if (Number.isFinite(p.muBefore)) muByEos.set(p.eosID, p.muBefore);
  if (liveOnTeam.filter((p) => muByEos.has(p.eosID)).length / liveOnTeam.length < 0.5) {
    rejected.badRoster++;
    continue;
  }

  const players = liveOnTeam.map((p) => {
    const lastJoin = lastJoinBefore(p.eosID, liveSnap.ts);
    const sessionMinutes = lastJoin != null ? (liveSnap.ts - lastJoin) / 60000 : null;
    return {
      eosID: p.eosID,
      teamID: p.teamID,
      mu: muByEos.get(p.eosID) ?? DEFAULT_MU,
      rated: muByEos.has(p.eosID) ? 1 : 0,
      inSquad: p.squadID != null ? 1 : 0,
      roundsPlayed: roundsPlayedBefore(p.eosID, liveSnap.ts),
      sessionMinutes,
      actuallyStayed: endIds.has(p.eosID) ? 1 : 0,
      left: leftBetween(p.eosID, liveSnap.ts, rd.endedAt) ? 1 : 0
    };
  });
  if (players.some((p) => p.sessionMinutes == null)) {
    // Drop the whole round rather than silently zero-filling a feature the
    // retention model depends on for every player in it.
    rejected.badRoster++;
    continue;
  }

  rounds.push({ matchId, ts: rd.endedAt, players });
}
rounds.sort((a, b) => a.ts - b.ts);

console.log('─── Round selection ───');
console.log(`  usable rounds:              ${rounds.length}`);
console.log(`  dropped, no ENDGAME match:   ${rejected.noEnd}`);
console.log(`  dropped, no round/no end ts: ${rejected.noRound}`);
console.log(`  dropped, non-RAAS:           ${rejected.nonCompetitive}`);
console.log(`  dropped, under ${MIN_EFFECTIVE_PLAYERS} eff pop:    ${rejected.tooSmall}`);
console.log(`  dropped, thin roster/session: ${rejected.badRoster}\n`);

if (rounds.length < 30) {
  console.log('Too few usable rounds to say anything. Stopping.\n');
  process.exit(0);
}

/* ─── Out-of-fold P(stay) — retrain per fold, score only the held-out fold */

console.log(`  fitting retention model, ${FOLDS}-fold chronological, out-of-fold scoring...\n`);
const allRows = rounds.flatMap((r) => r.players.map((p) => ({ ...p, roundIdx: rounds.indexOf(r) })));
const n = allRows.length;
const X = allRows.map((r) => [r.sessionMinutes, r.roundsPlayed, r.rated, r.inSquad, r.mu]);
const y = allRows.map((r) => r.left);
const pStayOOF = new Array(n).fill(null);
for (let f = 0; f < FOLDS; f++) {
  const lo = Math.floor((f * n) / FOLDS);
  const hi = Math.floor(((f + 1) * n) / FOLDS);
  const trX = [];
  const trY = [];
  for (let i = 0; i < n; i++) {
    if (i >= lo && i < hi) continue;
    trX.push(X[i]);
    trY.push(y[i]);
  }
  const m = fitLogistic(trX, trY);
  for (let i = lo; i < hi; i++) pStayOOF[i] = 1 - m.predict(X[i]);
}
allRows.forEach((r, i) => {
  r.pStay = pStayOOF[i];
});

/* Re-attach pStay back onto each round's player list */
const byIdx = new Map();
for (const r of allRows) {
  if (!byIdx.has(r.roundIdx)) byIdx.set(r.roundIdx, new Map());
  byIdx.get(r.roundIdx).set(r.eosID, r.pStay);
}
for (let i = 0; i < rounds.length; i++) {
  const m = byIdx.get(i);
  for (const p of rounds[i].players) p.pStay = m.get(p.eosID);
}

/* ─── Per-round gaps: naive, stayer-weighted, and the realized ENDGAME gap */

function teamMean(list) {
  return list.length ? list.reduce((s, v) => s + v, 0) / list.length : NaN;
}
function weightedMean(list, weights) {
  const wsum = weights.reduce((s, v) => s + v, 0);
  if (wsum <= 0) return NaN;
  return list.reduce((s, v, i) => s + v * weights[i], 0) / wsum;
}

const results = [];
for (const r of rounds) {
  const t1 = r.players.filter((p) => p.teamID === 1);
  const t2 = r.players.filter((p) => p.teamID === 2);
  const naiveGap = Math.abs(teamMean(t1.map((p) => p.mu)) - teamMean(t2.map((p) => p.mu)));
  const weightedGap = Math.abs(
    weightedMean(t1.map((p) => p.mu), t1.map((p) => p.pStay)) -
      weightedMean(t2.map((p) => p.mu), t2.map((p) => p.pStay))
  );
  const t1Stayed = t1.filter((p) => p.actuallyStayed);
  const t2Stayed = t2.filter((p) => p.actuallyStayed);
  if (t1Stayed.length < 5 || t2Stayed.length < 5) continue;
  const actualGap = Math.abs(teamMean(t1Stayed.map((p) => p.mu)) - teamMean(t2Stayed.map((p) => p.mu)));
  if (![naiveGap, weightedGap, actualGap].every(Number.isFinite)) continue;
  results.push({ matchId: r.matchId, naiveGap, weightedGap, actualGap });
}

console.log(`  rounds with a usable realized (ENDGAME) gap: ${results.length}\n`);

/* ─── 1. Correlation with the realized gap ──────────────────────────────── */

console.log('═══ 1. Correlation with the realized ENDGAME gap ═══\n');
const cNaive = correlation(results.map((r) => r.naiveGap), results.map((r) => r.actualGap));
const cWeighted = correlation(results.map((r) => r.weightedGap), results.map((r) => r.actualGap));
console.log(`  r(naiveGap, actualGap)     = ${fmt(cNaive.r, 3)}   (n=${cNaive.n})`);
console.log(`  r(weightedGap, actualGap)  = ${fmt(cWeighted.r, 3)}   (n=${cWeighted.n})`);

/* ─── 2. Prediction error — which is closer, round by round? ───────────── */

console.log('\n═══ 2. Absolute error vs the realized gap ═══\n');
const naiveErr = results.map((r) => Math.abs(r.naiveGap - r.actualGap));
const weightedErr = results.map((r) => Math.abs(r.weightedGap - r.actualGap));
const dNaive = describe(naiveErr);
const dWeighted = describe(weightedErr);
console.log(`  naive       mean abs error ${fmt(dNaive.mean, 4)}   median ${fmt(dNaive.median, 4)}`);
console.log(`  weighted    mean abs error ${fmt(dWeighted.mean, 4)}   median ${fmt(dWeighted.median, 4)}`);

const weightedCloser = results.filter((r, i) => weightedErr[i] < naiveErr[i]).length;
const naiveCloser = results.filter((r, i) => naiveErr[i] < weightedErr[i]).length;
const tied = results.length - weightedCloser - naiveCloser;
console.log(
  `\n  round-by-round: stayer-weighted closer on ${weightedCloser}, naive closer on ${naiveCloser}, ` +
    `tied on ${tied} (of ${results.length})`
);
// Sign test — is "weighted wins" different from a coin flip?
const decisive = weightedCloser + naiveCloser;
if (decisive >= 20) {
  const se = Math.sqrt(0.25 / decisive);
  const z = (weightedCloser / decisive - 0.5) / se;
  console.log(`  sign test: z = ${fmt(z, 2)}  ${Math.abs(z) > 1.96 ? '← significant' : '(not distinguishable from a coin flip)'}`);
}

/* ─── 3. Verdict ─────────────────────────────────────────────────────────── */

console.log('\n═══ 3. Verdict ═══\n');
const meaningfullyBetter = dWeighted.mean < dNaive.mean * 0.97 && weightedCloser > naiveCloser * 1.1;
if (meaningfullyBetter) {
  console.log('  Stayer-weighted parity tracks the realized gap better than naive parity, both by');
  console.log('  correlation and round-by-round error. Direction 3 has a real, implementable lever:');
  console.log('  weight scoreSwap()\'s mu-mean terms by predicted P(stay) instead of counting every');
  console.log('  LIVE-roster player equally.');
} else {
  console.log('  Stayer-weighted parity does not meaningfully outpredict naive parity for the gap');
  console.log('  that actually plays out. Part 1\'s retention signal is real, but it does not turn');
  console.log('  into a better balance objective on this evidence — the naive mu-mean the scrambler');
  console.log('  already uses is already a decent proxy for who ends up on the field.');
}
console.log('');
