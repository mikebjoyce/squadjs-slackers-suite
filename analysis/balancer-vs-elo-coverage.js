/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║        WHAT THE BALANCER SEES THAT ELO NEVER RECORDS           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * EloTracker refuses to rate a round below `minPlayersForElo` (default 80,
 * checked at ROUND_ENDED against the live connected count). TeamBalancer has
 * no such gate — it scrambles whatever is on the server.
 *
 * That asymmetry matters for tuning. Every analysis built on Elo_RoundHistory
 * is silently conditioned on "rounds that were full enough to rate", so it
 * cannot see the balancer's behaviour on the lobbies Elo threw away. If the
 * scrambles that produce bad games are concentrated down there, the Elo-joined
 * analyses are structurally blind to them.
 *
 * TB_RoundReport is the unconditioned universe: it is written in a `finally`
 * for every ROUND_ENDED, including draws, ignored modes, and empty servers.
 * This script quantifies the gap between the two.
 *
 *   node --max-old-space-size=4096 analysis/balancer-vs-elo-coverage.js
 */

import {
  newestExport,
  loadExport,
  table,
  describe,
  gamemodeOf,
  isCompetitive,
  fmt,
  bar
} from './load-export.js';

const ELO_MIN_PLAYERS = 80; // elo-tracker.js → options.minPlayersForElo

const file = newestExport();
const exp = loadExport(file);
console.log(`\nexport: ${file.split(/[\\/]/).pop()}   (${exp.exportedAt})\n`);

const tbRounds = table(exp, 'TB_RoundReport');
const eloRounds = table(exp, 'Elo_RoundHistory');

/* ─── 1. Is TB_RoundReport.playerCount usable? ──────────────────────────────
 *
 * Unlike Elo_RoundHistory.playerCount (cumulative distinct participants, which
 * correlates negatively with real population), this one is the live S³ roster
 * length at ROUND_ENDED — an instantaneous count. But it is sourced from an
 * optional chain that yields 0 when the players service is unavailable, so a
 * zero here means "not measured", not "empty server". Check before trusting.
 */
console.log('─── TB_RoundReport.playerCount health ───\n');

const tbZero = tbRounds.filter((r) => !Number.isFinite(r.playerCount) || r.playerCount === 0);
const tbMeasured = tbRounds.filter((r) => Number.isFinite(r.playerCount) && r.playerCount > 0);
console.log(`  rounds recorded:          ${tbRounds.length}`);
console.log(
  `  playerCount == 0 or null: ${tbZero.length}` +
    `  (${fmt((tbZero.length / tbRounds.length) * 100, 1)}% — service unavailable, not empty)`
);
console.log(`  usable population:        ${tbMeasured.length}`);

const tbPop = describe(tbMeasured.map((r) => r.playerCount));
console.log(
  `\n  measured population: median ${fmt(tbPop.median, 1)}, ` +
    `p05 ${fmt(tbPop.p05, 1)}, p25 ${fmt(tbPop.p25, 1)}, max ${fmt(tbPop.max, 0)}`
);

/* Zeros clustered in time = an outage or a version without the wiring; zeros
 * spread evenly = a race at round end. The distinction decides whether the
 * missing rows can be treated as missing-at-random. */
if (tbZero.length > 0) {
  const zeroTs = tbZero.map((r) => r.ts).sort((a, b) => a - b);
  const allTs = tbRounds.map((r) => r.ts).sort((a, b) => a - b);
  const span = (a) => `${new Date(a[0]).toISOString().slice(0, 10)} → ${new Date(a[a.length - 1]).toISOString().slice(0, 10)}`;
  console.log(`  zero rows span:      ${span(zeroTs)}`);
  console.log(`  all rows span:       ${span(allTs)}`);
}

/* ─── 2. How many rounds does Elo never see? ─────────────────────────────── */
console.log('\n─── Coverage: TB_RoundReport vs Elo_RoundHistory ───\n');

/*
 * matchId alone is NOT sufficient here: it was backfilled into Elo_RoundHistory
 * partway through the window, so 540 of 1031 Elo rows carry none. Joining on it
 * scores every pre-backfill round as "the balancer played it and Elo ignored
 * it", which is false and inflates the interesting number by ~600.
 *
 * Fall back to the round-end timestamp. TB_RoundReport.ts and
 * Elo_RoundHistory.endedAt agree to within 1ms on all 489 pairs that DO share a
 * matchId, while consecutive rounds are at minimum ~36 minutes apart, so a
 * 60-second window is both exact and unambiguous.
 */
const TS_TOLERANCE_MS = 60_000;

const eloByMatch = new Map();
const eloByTs = [];
for (const r of eloRounds) {
  if (r.matchId) eloByMatch.set(r.matchId, r);
  if (Number.isFinite(r.endedAt)) eloByTs.push(r);
}
eloByTs.sort((a, b) => a.endedAt - b.endedAt);

function findEloRound(tb) {
  if (tb.matchId && eloByMatch.has(tb.matchId)) return eloByMatch.get(tb.matchId);
  if (!Number.isFinite(tb.ts)) return null;
  let lo = 0;
  let hi = eloByTs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = eloByTs[mid].endedAt - tb.ts;
    if (Math.abs(d) <= TS_TOLERANCE_MS) return eloByTs[mid];
    if (d < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

const rated = [];
const unrated = [];
for (const r of tbRounds) (findEloRound(r) ? rated : unrated).push(r);

console.log(`  rounds the balancer saw:  ${tbRounds.length}`);
console.log(`  → rated by Elo:           ${rated.length}`);
console.log(
  `  → NOT rated by Elo:       ${unrated.length}` +
    `  (${fmt((unrated.length / tbRounds.length) * 100, 1)}% of all rounds played)`
);
console.log(`  (Elo rows matched: ${rated.length} of ${eloRounds.length})`);

/* Why were they dropped? Elo skips on three grounds: population, ignored match
 * type, and draws. Attribute each unrated round so the population share is not
 * overstated by the mode exclusions. */
const reasons = { lowPop: 0, nonCompetitive: 0, draw: 0, unknown: 0 };
for (const r of unrated) {
  const pop = Number.isFinite(r.playerCount) ? r.playerCount : null;
  if (!isCompetitive(r.layerName)) reasons.nonCompetitive++;
  else if (pop !== null && pop > 0 && pop < ELO_MIN_PLAYERS) reasons.lowPop++;
  else if (!r.winningTeamID) reasons.draw++;
  else reasons.unknown++;
}
console.log('\n  attribution of unrated rounds:');
for (const [k, v] of Object.entries(reasons)) {
  console.log(`    ${k.padEnd(16)} ${String(v).padStart(4)}`);
}

/* ─── 3. Does the balancer actually scramble down there? ─────────────────── */
console.log('\n─── Scrambles by population band ───\n');

const BANDS = [
  ['0–39   (dead)', 0, 40],
  ['40–59  (thin)', 40, 60],
  ['60–79  (sub-Elo)', 60, 80],
  ['80–95  (full-ish)', 80, 96],
  ['96+    (packed)', 96, Infinity]
];

const rows = [];
for (const [label, lo, hi] of BANDS) {
  const inBand = tbMeasured.filter((r) => r.playerCount >= lo && r.playerCount < hi);
  const scrambled = inBand.filter((r) => r.scrambled);
  const margins = inBand
    .filter((r) => isCompetitive(r.layerName) && Number.isFinite(r.ticketMargin) && r.winningTeamID)
    .map((r) => Math.abs(r.ticketMargin));
  rows.push({ label, n: inBand.length, scrambled: scrambled.length, margins });
}

const maxN = Math.max(...rows.map((r) => r.n));
console.log('  band                rounds  scrambled   RAAS margin (mean/median, n)');
for (const r of rows) {
  const m = describe(r.margins);
  const rate = r.n > 0 ? `${fmt((r.scrambled / r.n) * 100, 1)}%` : '—';
  console.log(
    `  ${r.label.padEnd(18)} ${String(r.n).padStart(5)}  ` +
      `${String(r.scrambled).padStart(4)} ${rate.padStart(7)}   ` +
      `${m.n > 0 ? `${fmt(m.mean, 1)} / ${fmt(m.median, 1)}  (n=${m.n})` : '—'}`
  );
  console.log(`  ${''.padEnd(18)} ${bar(r.n, maxN, 30)}`);
}

/* ─── 4. The tuning question ─────────────────────────────────────────────── */
console.log('\n─── Sub-Elo rounds in detail ───\n');

const subElo = tbMeasured.filter((r) => r.playerCount < ELO_MIN_PLAYERS);
const subEloScrambled = subElo.filter((r) => r.scrambled);
console.log(`  rounds below the Elo threshold: ${subElo.length}`);
console.log(`  of those, scrambled:            ${subEloScrambled.length}`);

if (subEloScrambled.length > 0) {
  const byCond = new Map();
  for (const r of subEloScrambled) {
    const k = r.scrambleCondition || '(null)';
    byCond.set(k, (byCond.get(k) || 0) + 1);
  }
  console.log('\n  trigger conditions below the threshold:');
  for (const [k, v] of [...byCond].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(28)} ${String(v).padStart(4)}`);
  }

  const modes = new Map();
  for (const r of subEloScrambled) {
    const k = gamemodeOf(r.layerName);
    modes.set(k, (modes.get(k) || 0) + 1);
  }
  console.log('\n  gamemodes below the threshold:');
  for (const [k, v] of [...modes].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(28)} ${String(v).padStart(4)}`);
  }
}

console.log('');
