/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          WHERE THE HARDCODED 0.4μ CHURN FLOOR LANDS            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * team-balancer.js computes, at ROUND_ENDED, the mean-mu delta between the two
 * teams that just played, and if it is below a hardcoded 0.4 it forces the
 * scrambler to move 40–55 players ("to ensure a fresh match feeling"). Above
 * 0.4 there is no churn floor at all — the scrambler may satisfy its objective
 * with an arbitrarily small swap.
 *
 * The question this answers: is 0.4 a rare edge case, as the comment's "edge
 * cases" framing implies, or does it sit in the middle of the distribution and
 * govern half of all scrambles?
 *
 * This reproduces the plugin's arithmetic exactly, which matters in one
 * specific way: it averages over ALL players on each team, substituting
 * mu = 25.0 for anyone unrated. Unrated players sit at exactly the population
 * mean, so every one of them pulls both team averages toward 25.0 and SHRINKS
 * the measured delta. Restricting to rated players would overstate it.
 *
 *   node --max-old-space-size=4096 analysis/churn-floor-threshold.js
 */

import {
  newestExport,
  loadExport,
  table,
  describe,
  quantile,
  isCompetitive,
  effectivePopulation,
  MIN_EFFECTIVE_PLAYERS,
  fmt,
  bar
} from './load-export.js';

const CHURN_FLOOR_MU = 0.4; // team-balancer.js — hardcoded
const DEFAULT_MU = 25.0; // EloCalculator.MU_DEFAULT

const exp = loadExport(newestExport());

const rounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');

const byRound = new Map();
for (const p of roundPlayers) {
  if (!byRound.has(p.roundHistoryId)) byRound.set(p.roundHistoryId, []);
  byRound.get(p.roundHistoryId).push(p);
}

/*
 * The teams recorded in Elo_RoundPlayers for round N are the teams the
 * balancer is looking at when it decides whether to scramble for round N+1 —
 * the decision is taken at ROUND_ENDED, before anyone is moved. So this is the
 * right population, not a proxy.
 */
const samples = [];
for (const r of rounds) {
  if (!isCompetitive(r.layerName)) continue;
  const ps = byRound.get(r.id) || [];
  if (ps.length === 0) continue;
  if (effectivePopulation(ps) < MIN_EFFECTIVE_PLAYERS) continue;

  let t1 = 0;
  let n1 = 0;
  let t2 = 0;
  let n2 = 0;
  let unrated = 0;
  for (const p of ps) {
    const mu = Number.isFinite(p.muBefore) ? p.muBefore : DEFAULT_MU;
    if (mu === DEFAULT_MU) unrated++;
    if (p.teamID === 1) {
      t1 += mu;
      n1++;
    } else if (p.teamID === 2) {
      t2 += mu;
      n2++;
    }
  }
  if (n1 === 0 || n2 === 0) continue;
  samples.push({
    muDelta: Math.abs(t1 / n1 - t2 / n2),
    ticketDiff: Math.abs(r.ticketDiff),
    unratedShare: unrated / ps.length
  });
}

const deltas = samples.map((s) => s.muDelta).sort((a, b) => a - b);
const d = describe(deltas);

console.log(`\n─── Pre-scramble mu delta, RAAS, ${MIN_EFFECTIVE_PLAYERS}+ effective pop ───\n`);
console.log(`  rounds:  ${d.n}`);
console.log(
  `  p05 ${fmt(d.p05)}   p25 ${fmt(d.p25)}   median ${fmt(d.median)}   ` +
    `p75 ${fmt(d.p75)}   p95 ${fmt(d.p95)}   max ${fmt(d.max)}`
);

const below = samples.filter((s) => s.muDelta < CHURN_FLOOR_MU);
const above = samples.filter((s) => s.muDelta >= CHURN_FLOOR_MU);
const pct = (n) => `${fmt((n / samples.length) * 100, 1)}%`;

console.log(`\n  the 0.4 threshold sits at percentile ${fmt(percentileOf(deltas, CHURN_FLOOR_MU) * 100, 1)}`);
console.log(`\n  mu delta <  0.4  → FORCED 40–55 churn:  ${below.length} rounds (${pct(below.length)})`);
console.log(`  mu delta >= 0.4  → no churn floor:      ${above.length} rounds (${pct(above.length)})`);

/*
 * The consequence worth reading twice: the forced-churn branch fires on the
 * rounds that were ALREADY balanced, and the no-floor branch fires on the
 * rounds that were not. Compare what each group's games actually looked like.
 */
const mb = describe(below.map((s) => s.ticketDiff));
const ma = describe(above.map((s) => s.ticketDiff));
console.log('\n  resulting ticket margin of the round that was just played:');
console.log(`    below 0.4 (gets forced churn):  mean ${fmt(mb.mean, 1)}  median ${fmt(mb.median, 1)}`);
console.log(`    above 0.4 (gets no floor):      mean ${fmt(ma.mean, 1)}  median ${fmt(ma.median, 1)}`);

/* ─── Histogram, so the shape is visible rather than asserted ─────────────── */
console.log('\n─── Distribution ───\n');
const EDGES = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0, 1.5, Infinity];
const counts = EDGES.slice(0, -1).map((lo, i) =>
  deltas.filter((v) => v >= lo && v < EDGES[i + 1]).length
);
const maxC = Math.max(...counts);
for (let i = 0; i < counts.length; i++) {
  const hi = EDGES[i + 1] === Infinity ? '+' : `–${EDGES[i + 1]}`;
  const marker = EDGES[i] === CHURN_FLOOR_MU ? '  ← floor stops here' : '';
  console.log(
    `  ${`${EDGES[i]}${hi}`.padEnd(9)} ${String(counts[i]).padStart(4)}  ` +
      `${bar(counts[i], maxC, 34)}${marker}`
  );
}

console.log('');

function percentileOf(sorted, value) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}
