/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   WHICH DEFINITION OF "BALANCED" ACTUALLY PREDICTS OUTCOMES?   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * The scrambler scores a candidate as a blend of two quantities:
 *
 *   master:       0.6 * meanMuDiff + 0.4 * top15MuDiff
 *   experimental: 0.9 * meanMuDiff + 0.1 * top15MuDiff
 *
 * The experimental branch picked its weights by grid search against ticket
 * margin, on a surface flat enough that ~29% of the grid sat within 0.005 of
 * the optimum. A flat surface means the search cannot distinguish the weights,
 * so the reported winner is close to arbitrary.
 *
 * This asks the prior question instead, and asks it of outcomes rather than of
 * the scrambler: given the teams that actually took the field, which blend best
 * predicts who won and by how much? Whatever the scrambler optimises should be
 * the thing that correlates with results. If no blend separates from the others,
 * the tuning is unresolvable on this data and should be left alone.
 *
 * Direction (who won) is reported alongside margin because the two behave very
 * differently here — mu predicts direction strongly and magnitude weakly — and a
 * grid searched on margin alone is optimising the weaker of the two signals.
 *
 *   node --max-old-space-size=4096 analysis/objective-formulation.js
 */

import {
  newestExport,
  loadExport,
  table,
  isCompetitive,
  effectivePopulation,
  MIN_EFFECTIVE_PLAYERS,
  correlation,
  describe,
  fmt,
  bar
} from './load-export.js';

const DEFAULT_MU = 25.0;
const TOP_N = 15; // the "top-15" the scorer uses

const exp = loadExport(newestExport());
const eloRounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');

const byRound = new Map();
for (const p of roundPlayers) {
  if (!byRound.has(p.roundHistoryId)) byRound.set(p.roundHistoryId, []);
  byRound.get(p.roundHistoryId).push(p);
}

/* ─── Build per-round signed differences ───────────────────────────────── */

/*
 * Signed, from team 1's perspective, so direction can be tested. The scrambler
 * scores magnitudes, but to ask "does this quantity predict the winner" the
 * sign has to be preserved.
 */
const rounds = [];
for (const r of eloRounds) {
  if (!isCompetitive(r.layerName)) continue;
  if (!r.winningTeamID) continue;
  const ps = byRound.get(r.id) || [];
  if (effectivePopulation(ps) < MIN_EFFECTIVE_PLAYERS) continue;

  const t1 = [];
  const t2 = [];
  for (const p of ps) {
    const mu = Number.isFinite(p.muBefore) ? p.muBefore : DEFAULT_MU;
    if (p.teamID === 1) t1.push(mu);
    else if (p.teamID === 2) t2.push(mu);
  }
  if (t1.length === 0 || t2.length === 0) continue;

  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const topMean = (a) => {
    const s = [...a].sort((x, y) => y - x).slice(0, TOP_N);
    return s.reduce((acc, v) => acc + v, 0) / s.length;
  };

  rounds.push({
    meanDiff: mean(t1) - mean(t2),
    top15Diff: topMean(t1) - topMean(t2),
    t1Won: r.winningTeamID === 1,
    ticketDiff: Math.abs(r.ticketDiff)
  });
}

console.log(`\n═══ OBJECTIVE FORMULATION ═══\n`);
console.log(`  RAAS rounds, ${MIN_EFFECTIVE_PLAYERS}+ effective pop, decided: ${rounds.length}\n`);

/* How much independent information is in the second term at all? */
const collin = correlation(rounds.map((r) => r.meanDiff), rounds.map((r) => r.top15Diff));
console.log(`  r(meanDiff, top15Diff) = ${fmt(collin.r, 3)}`);
console.log(
  '  The two terms are largely the same measurement. A blend weight can only\n' +
    '  matter to the extent they diverge, which bounds how much any tuning here\n' +
    '  could ever be worth.\n'
);

/* ─── Sweep the blend ──────────────────────────────────────────────────── */

const WEIGHTS = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

function evaluate(w) {
  // w = weight on meanDiff; (1-w) on top15Diff
  const score = rounds.map((r) => w * r.meanDiff + (1 - w) * r.top15Diff);
  // Direction: does a positive score mean team 1 won?
  let correct = 0;
  let decided = 0;
  for (let i = 0; i < rounds.length; i++) {
    if (score[i] === 0) continue;
    decided++;
    if (score[i] > 0 === rounds[i].t1Won) correct++;
  }
  const dirAcc = correct / decided;
  // Magnitude: does |score| track |ticket margin|?
  const mag = correlation(score.map(Math.abs), rounds.map((r) => r.ticketDiff));
  return { w, dirAcc, r: mag.r, n: decided };
}

const results = WEIGHTS.map(evaluate);

console.log('─── Blend sweep: w*meanDiff + (1-w)*top15Diff ───\n');
console.log('  w(mean)  direction accuracy      r(|score|, margin)');
const bestDir = Math.max(...results.map((x) => x.dirAcc));
for (const x of results) {
  const tag =
    Math.abs(x.w - 0.6) < 1e-9 ? '  ← master' : Math.abs(x.w - 0.9) < 1e-9 ? '  ← experimental' : '';
  console.log(
    `  ${x.w.toFixed(1)}      ${`${fmt(x.dirAcc * 100, 1)}%`.padStart(6)}  ` +
      `${bar(x.dirAcc * 100, bestDir * 100, 22)}  ${fmt(x.r, 3)}${tag}`
  );
}

/* ─── Is any of that spread real? ──────────────────────────────────────── */

console.log('\n─── Is the spread distinguishable from noise? ───\n');
const accs = results.map((x) => x.dirAcc);
const spread = Math.max(...accs) - Math.min(...accs);
const n = results[0].n;
/* Standard error of a proportion around ~0.63 at this n. Two formulations
 * differing by less than a couple of SEs are not separable, and these are
 * furthermore evaluated on the SAME rounds, so they are highly correlated —
 * this is a generous bound, not a strict test. */
const se = Math.sqrt(0.63 * 0.37 / n);
console.log(`  best - worst direction accuracy: ${fmt(spread * 100, 2)} points`);
console.log(`  standard error at n=${n}:          ${fmt(se * 100, 2)} points`);
console.log(
  `  => spread is ${fmt(spread / se, 1)} SE wide` +
    `${spread / se < 2 ? ' — not separable' : ' — possibly separable'}`
);

const bestW = results.reduce((a, b) => (b.dirAcc > a.dirAcc ? b : a));
const master = results.find((x) => Math.abs(x.w - 0.6) < 1e-9);
const experimental = results.find((x) => Math.abs(x.w - 0.9) < 1e-9);
console.log(
  `\n  master (0.6):       ${fmt(master.dirAcc * 100, 1)}% direction, r=${fmt(master.r, 3)}`
);
console.log(
  `  experimental (0.9): ${fmt(experimental.dirAcc * 100, 1)}% direction, r=${fmt(experimental.r, 3)}`
);
console.log(`  best on this data:  w=${bestW.w.toFixed(1)} at ${fmt(bestW.dirAcc * 100, 1)}%`);

/* ─── What the margin correlation is worth in tickets ──────────────────── */

console.log('\n─── Practical size of the effect ───\n');
const t = describe(rounds.map((r) => r.ticketDiff));
const rBest = Math.max(...results.map((x) => Math.abs(x.r)));
console.log(`  ticket margin: mean ${fmt(t.mean, 1)}, sd ${fmt(t.sd, 1)}`);
console.log(`  best |r| against margin across all blends: ${fmt(rBest, 3)}`);
console.log(
  `  => the blend explains at most ${fmt(rBest * rBest * 100, 1)}% of margin variance.\n` +
    `     Reweighting within that ceiling cannot move the ticket KPI materially.`
);

console.log('');
