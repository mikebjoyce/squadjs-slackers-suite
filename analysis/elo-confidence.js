/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║        IS THE TEAM-LEVEL MU DELTA SIGNAL, OR IS IT NOISE?     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * The intuition that TrueSkill "doesn't know enough" is about the
 * INDIVIDUAL player: sigma starts at 8.33 (mu/3) and comes down slowly,
 * and a large share of any lobby has barely been seen. All true.
 *
 * But tb-scrambler.js never acts on an individual rating. It acts on
 * the MEAN of ~50 of them. The standard error of a mean falls with
 * sqrt(n), so the uncertainty that dominates a single player's rating
 * can be small relative to the difference between two team averages.
 *
 * This script quantifies that: per round it computes each team's mean
 * mu, the standard error of that mean implied by the players' own
 * sigmas, and the resulting z-score for the observed team gap. If the
 * gaps routinely exceed a couple of standard errors, mu delta is real
 * information and the objective is sound even when individual ratings
 * are uncertain.
 *
 *   node --max-old-space-size=6144 analysis/elo-confidence.js
 */

import { newestExport, loadExport, table, describe, correlation, quantile, fmt, bar } from './load-export.js';

const MU_DEFAULT = 25.0;
const SIGMA_DEFAULT = 25.0 / 3.0;
const MIN_PER_TEAM = 20;

function mean(xs) {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN;
}

const file = process.argv[2] || newestExport();
console.log(`\nExport: ${file}\n`);

const exp = loadExport(file);
const stats = table(exp, 'Elo_PlayerStats');
const rounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');

// ─── 1. The individual-rating picture ────────────────────────────
console.log('═══ 1. What the rating system knows about each PLAYER ═══\n');

const sigmas = describe(stats.map((p) => p.sigma));
const rp = describe(stats.map((p) => p.roundsPlayed));

console.log(`  Rated players in the table: ${stats.length}`);
console.log(
  `  sigma:         median ${fmt(sigmas.median, 3)}   p05 ${fmt(sigmas.p05, 3)}   p95 ${fmt(sigmas.p95, 3)}   (starts at ${fmt(SIGMA_DEFAULT, 3)})`
);
console.log(
  `  roundsPlayed:  median ${fmt(rp.median, 0)}   p75 ${fmt(rp.p75, 0)}   p95 ${fmt(rp.p95, 0)}   max ${fmt(rp.max, 0)}`
);

const neverMoved = stats.filter((p) => p.roundsPlayed === 0).length;
const oneRound = stats.filter((p) => p.roundsPlayed <= 1).length;
const under5 = stats.filter((p) => p.roundsPlayed < 5).length;
const over20 = stats.filter((p) => p.roundsPlayed >= 20).length;
console.log(`\n  never played a counted round: ${neverMoved} (${((neverMoved / stats.length) * 100).toFixed(1)}%)`);
console.log(`  1 round or fewer:             ${oneRound} (${((oneRound / stats.length) * 100).toFixed(1)}%)`);
console.log(`  under 5 rounds:               ${under5} (${((under5 / stats.length) * 100).toFixed(1)}%)`);
console.log(`  20+ rounds:                   ${over20} (${((over20 / stats.length) * 100).toFixed(1)}%)`);
console.log('\n  → The player table is dominated by drive-by visitors. This is the');
console.log('    observation behind "we barely recognise the lobby", and it is correct');
console.log('    as stated. Section 3 tests whether it matters for the scrambler.');

// Does sigma actually track experience, or is it stuck near its default?
// If it were stuck, it would be useless as a confidence measure and the
// noise floor in section 3 would be meaningless.
console.log('\n  sigma against experience (does uncertainty fall as we learn a player?):\n');
const buckets = [[0, 1], [1, 3], [3, 5], [5, 10], [10, 25], [25, 50], [50, 100], [100, 250], [250, Infinity]];
for (const [lo, hi] of buckets) {
  const sub = stats.filter((p) => p.roundsPlayed >= lo && p.roundsPlayed < hi);
  if (sub.length === 0) continue;
  const s = describe(sub.map((p) => p.sigma));
  const m = describe(sub.map((p) => p.mu));
  const label = `${lo}–${hi === Infinity ? 'max' : hi}`;
  console.log(
    `    rounds ${label.padEnd(9)} n=${String(sub.length).padStart(5)}   ` +
      `sigma median ${fmt(s.median, 3)}   mu p05–p95 ${fmt(m.p05, 1)}–${fmt(m.p95, 1)}`
  );
}
const sigmaVsRounds = correlation(stats.map((p) => p.roundsPlayed), stats.map((p) => p.sigma));
console.log(`\n    r(roundsPlayed, sigma) = ${fmt(sigmaVsRounds.r, 3)}`);
console.log('    → sigma is working, just slowly: even 250+ round veterans sit near 6.0.');
console.log('      Note mu SPREAD widens with experience (p05–p95 goes from ~1.5 wide to');
console.log('      ~20 wide) — the system separates known players, it just needs many rounds.');

// ─── 2. Who actually shows up in rounds ──────────────────────────
console.log('\n═══ 2. What the rating system knows about each LOBBY ═══\n');

const byRound = new Map();
for (const r of roundPlayers) {
  if (r.roundHistoryId === null || r.roundHistoryId === undefined) continue;
  let list = byRound.get(r.roundHistoryId);
  if (!list) {
    list = [];
    byRound.set(r.roundHistoryId, list);
  }
  list.push(r);
}

const lobbyRows = [];
for (const round of rounds) {
  const players = byRound.get(round.id);
  if (!players || players.length === 0) continue;
  const t1 = players.filter((p) => Number(p.teamID) === 1);
  const t2 = players.filter((p) => Number(p.teamID) === 2);
  if (t1.length < MIN_PER_TEAM || t2.length < MIN_PER_TEAM) continue;

  const unseen = players.filter((p) => p.muBefore === MU_DEFAULT).length;
  const nearDefaultSigma = players.filter((p) => p.sigmaBefore > SIGMA_DEFAULT * 0.98).length;

  lobbyRows.push({
    round,
    t1,
    t2,
    players,
    unseenShare: unseen / players.length,
    nearDefaultSigmaShare: nearDefaultSigma / players.length,
    medianSigma: quantile(
      players.map((p) => p.sigmaBefore).filter(Number.isFinite).sort((a, b) => a - b),
      0.5
    )
  });
}

const us = describe(lobbyRows.map((r) => r.unseenShare));
const nds = describe(lobbyRows.map((r) => r.nearDefaultSigmaShare));
const ms = describe(lobbyRows.map((r) => r.medianSigma));

console.log(`  Usable rounds: ${lobbyRows.length}`);
console.log(
  `  share of lobby with mu still at the ${MU_DEFAULT} default:  median ${(us.median * 100).toFixed(1)}%   p95 ${(us.p95 * 100).toFixed(1)}%`
);
console.log(
  `  share of lobby with sigma still ~untouched:          median ${(nds.median * 100).toFixed(1)}%   p95 ${(nds.p95 * 100).toFixed(1)}%`
);
console.log(`  median per-player sigma inside a lobby:              ${fmt(ms.median, 3)}`);
console.log('\n  → Lobbies are much better known than the player table suggests: the');
console.log('    regulars who fill most slots are exactly the players with history.');

// ─── 3. Signal vs noise at the level the scrambler acts on ───────
console.log('\n═══ 3. Is the TEAM mu delta above its own noise floor? ═══\n');
console.log('  For each round: observed |mean mu difference| between the two teams,');
console.log('  against the standard error of that difference implied by each player\'s');
console.log('  own sigma. SE(team mean) = sqrt(sum(sigma^2)) / n; the two teams combine');
console.log('  in quadrature. A |z| above ~2 means the gap is not a rating artifact.\n');

const zRows = [];
for (const row of lobbyRows) {
  const mu1 = row.t1.map((p) => p.muBefore).filter(Number.isFinite);
  const mu2 = row.t2.map((p) => p.muBefore).filter(Number.isFinite);
  const s1 = row.t1.map((p) => p.sigmaBefore).filter(Number.isFinite);
  const s2 = row.t2.map((p) => p.sigmaBefore).filter(Number.isFinite);
  if (mu1.length < MIN_PER_TEAM || mu2.length < MIN_PER_TEAM) continue;

  const se1 = Math.sqrt(s1.reduce((s, v) => s + v * v, 0)) / s1.length;
  const se2 = Math.sqrt(s2.reduce((s, v) => s + v * v, 0)) / s2.length;
  const seDiff = Math.sqrt(se1 * se1 + se2 * se2);
  const delta = Math.abs(mean(mu1) - mean(mu2));

  zRows.push({ delta, seDiff, z: seDiff > 0 ? delta / seDiff : NaN });
}

const seD = describe(zRows.map((r) => r.seDiff));
const deltaD = describe(zRows.map((r) => r.delta));
const zD = describe(zRows.map((r) => r.z));

console.log(`  typical SE of the team-mu difference:  median ${fmt(seD.median, 3)}`);
console.log(`  typical observed |team mu difference|: median ${fmt(deltaD.median, 3)}   p95 ${fmt(deltaD.p95, 3)}`);
console.log(`  resulting |z|:                         median ${fmt(zD.median, 2)}   p95 ${fmt(zD.p95, 2)}`);

const above2 = zRows.filter((r) => r.z >= 2).length;
const above1 = zRows.filter((r) => r.z >= 1).length;
console.log(
  `\n  rounds where the gap exceeds 1 SE: ${above1} / ${zRows.length} (${((above1 / zRows.length) * 100).toFixed(1)}%)`
);
console.log(
  `  rounds where the gap exceeds 2 SE: ${above2} / ${zRows.length} (${((above2 / zRows.length) * 100).toFixed(1)}%)`
);

console.log('\n  |z| distribution:\n');
const edges = [0, 0.5, 1, 1.5, 2, 3, 4, Infinity];
const counts = edges.slice(0, -1).map((lo, i) => zRows.filter((r) => r.z >= lo && r.z < edges[i + 1]).length);
const maxCount = Math.max(...counts);
edges.slice(0, -1).forEach((lo, i) => {
  const hi = edges[i + 1];
  const label = hi === Infinity ? `${lo}+` : `${lo}–${hi}`;
  console.log(`    ${label.padStart(8)}  ${String(counts[i]).padStart(4)}  ${bar(counts[i], maxCount)}`);
});

// ─── Reading this correctly ──────────────────────────────────────
// A median |z| of ~0.3 does NOT mean mu delta is worthless. Run
// mu-predicts-margin.js and the higher-mu team wins 62% of rounds,
// rising to 76.5% in the largest-gap quartile. Both results are true
// and they agree:
//
//   - Per round, the gap is usually well inside its own error bar, so
//     you cannot call a single match from mu.
//   - The estimate is attenuated, not biased, so its DIRECTION is
//     right more often than not, and that shows up over 1031 rounds.
//   - Reliability scales with gap size exactly as this z tells you:
//     the smallest-gap quartile (z well under 0.5) wins 49% of the
//     time — a coin flip — and the largest quartile (z approaching 2)
//     wins 76.5%.
//
// That is the actionable part. Driving the team mu gap toward zero
// moves rounds into the regime where the outcome genuinely is a coin
// flip, which is what a balancer is for.
console.log('\n  Read this together with mu-predicts-margin.js: a small per-round z');
console.log('  means you cannot call ONE match from mu, not that mu is worthless.');
console.log('  Reliability scales with the gap — smallest-gap quartile goes 49% (a coin');
console.log('  flip), largest-gap quartile 76.5%. Shrinking the gap is what buys fairness.');

console.log('');
