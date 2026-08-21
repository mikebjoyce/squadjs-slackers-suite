/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║        DOES PRE-ROUND MU BALANCE PREDICT A CLOSE GAME?        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * tb-scrambler.js scores candidate swaps almost entirely on mu: mean
 * mu difference between the hypothetical teams, plus a top-15 mu
 * difference term, plus veteran parity. Tuning those scalers is only
 * worth doing if mu difference actually predicts match outcome. This
 * script tests that directly, and needs no scramble reports to do it.
 *
 * Elo_RoundPlayers stores muBefore/sigmaBefore and teamID for every
 * player in every round, keyed to Elo_RoundHistory by roundHistoryId.
 * So for each historical round we can reconstruct exactly the quantity
 * the scrambler optimizes — the pre-round team mu delta — and compare
 * it against what actually happened.
 *
 * Two outcome measures, because they fail differently:
 *
 *   1. DIRECTION — did the higher-mu team win? If this sits at ~50%,
 *      mu carries no team-level signal at all and every scaler in the
 *      ELO scoring path is ranking candidates on noise.
 *
 *   2. MAGNITUDE — does |mu delta| correlate with |ticket diff|? This
 *      is the quantity the scrambler is actually trying to minimize.
 *      A near-zero correlation means driving mu delta to zero cannot
 *      close out games, whatever the optimizer does.
 *
 * Seed and training layers are excluded throughout: they are not
 * competitive rounds and their ticket counts are not comparable.
 *
 *   node --max-old-space-size=6144 analysis/mu-predicts-margin.js
 */

import {
  newestExport,
  loadExport,
  table,
  describe,
  correlation,
  gamemodeOf,
  COMPETITIVE_MODES,
  effectivePopulation,
  MIN_EFFECTIVE_PLAYERS,
  fmt,
  bar
} from './load-export.js';

const MU_DEFAULT = 25.0;

// Minimum bodies per side before a round tells us anything. Squad is 50v50
// at full pop; anything under this is a seed or a dying lobby.
const MIN_PER_TEAM = 20;

// Invasion, Seed and Training are excluded by default — see COMPETITIVE_MODES
// in load-export.js for why. Pass --all to score every mode together.
const INCLUDE_ALL_MODES = process.argv.includes('--all');

function mean(xs) {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : NaN;
}

/** Mean of the top N values — mirrors the scrambler's top-15 term. */
function topNMean(xs, n) {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => b - a);
  return mean(sorted.slice(0, Math.min(n, sorted.length)));
}

const file = process.argv[2] || newestExport();
console.log(`\nExport: ${file}`);

const exp = loadExport(file);
const rounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');

console.log(`Rounds: ${rounds.length}   Round-player rows: ${roundPlayers.length}\n`);

// ─── Join round players onto their round ─────────────────────────
const byRound = new Map();
for (const rp of roundPlayers) {
  const key = rp.roundHistoryId;
  if (key === null || key === undefined) continue;
  let list = byRound.get(key);
  if (!list) {
    list = [];
    byRound.set(key, list);
  }
  list.push(rp);
}

// ─── Build one record per usable round ───────────────────────────
const records = [];
const rejected = { noPlayers: 0, tooSmall: 0, seed: 0, noWinner: 0, noTickets: 0, lowPop: 0 };

for (const round of rounds) {
  const players = byRound.get(round.id);
  if (!players || players.length === 0) {
    rejected.noPlayers++;
    continue;
  }

  const gamemode = gamemodeOf(round.layerName);
  if (!INCLUDE_ALL_MODES && !COMPETITIVE_MODES.has(gamemode)) {
    rejected.seed++;
    continue;
  }
  if (round.winningTeamID !== 1 && round.winningTeamID !== 2) {
    rejected.noWinner++;
    continue;
  }
  if (!Number.isFinite(round.ticketDiff)) {
    rejected.noTickets++;
    continue;
  }

  // Full lobbies only — see effectivePopulation() for why playerCount is unusable.
  const effPop = effectivePopulation(players);
  if (effPop < MIN_EFFECTIVE_PLAYERS) {
    rejected.lowPop++;
    continue;
  }

  const t1 = players.filter((p) => Number(p.teamID) === 1);
  const t2 = players.filter((p) => Number(p.teamID) === 2);
  if (t1.length < MIN_PER_TEAM || t2.length < MIN_PER_TEAM) {
    rejected.tooSmall++;
    continue;
  }

  const mu1 = t1.map((p) => p.muBefore).filter(Number.isFinite);
  const mu2 = t2.map((p) => p.muBefore).filter(Number.isFinite);
  if (mu1.length < MIN_PER_TEAM || mu2.length < MIN_PER_TEAM) {
    rejected.tooSmall++;
    continue;
  }

  const meanMu1 = mean(mu1);
  const meanMu2 = mean(mu2);
  const top15Mu1 = topNMean(mu1, 15);
  const top15Mu2 = topNMean(mu2, 15);

  // Signed toward the winner: positive means the higher-mu team won.
  const winnerIsT1 = round.winningTeamID === 1;
  const signedMuDelta = winnerIsT1 ? meanMu1 - meanMu2 : meanMu2 - meanMu1;
  const signedTop15Delta = winnerIsT1 ? top15Mu1 - top15Mu2 : top15Mu2 - top15Mu1;

  // Share of the lobby the rating system has genuinely never seen.
  const unseen = players.filter((p) => p.muBefore === MU_DEFAULT).length;

  records.push({
    id: round.id,
    matchId: round.matchId,
    layerName: round.layerName,
    gamemode,
    ticketDiff: Math.abs(round.ticketDiff),
    roundDuration: round.roundDuration,
    playerCount: players.length,
    absMuDelta: Math.abs(meanMu1 - meanMu2),
    absTop15Delta: Math.abs(top15Mu1 - top15Mu2),
    signedMuDelta,
    signedTop15Delta,
    higherMuTeamWon: signedMuDelta > 0,
    unseenShare: unseen / players.length,
    muSpread: describe([...mu1, ...mu2]).sd
  });
}

console.log('─── Round selection ───');
console.log(`  usable rounds:            ${records.length}`);
console.log(`  dropped, no player rows:  ${rejected.noPlayers}`);
console.log(`  dropped, non-competitive: ${rejected.seed}${INCLUDE_ALL_MODES ? ' (--all: none excluded)' : ' (Invasion/Seed/Training/Other)'}`);
console.log(`  dropped, under ${MIN_EFFECTIVE_PLAYERS} effective pop: ${rejected.lowPop}`);
console.log(`  dropped, under ${MIN_PER_TEAM}/side:  ${rejected.tooSmall}`);
console.log(`  dropped, no winner:       ${rejected.noWinner}`);
console.log(`  dropped, no ticket data:  ${rejected.noTickets}`);

if (records.length < 30) {
  console.log('\nToo few usable rounds to say anything. Stopping.\n');
  process.exit(0);
}

// ─── 1. DIRECTION: did the higher-mu team win? ───────────────────
console.log('\n═══ 1. Does mu predict WHO wins? ═══\n');

function directionReport(label, subset, key = 'signedMuDelta') {
  const usable = subset.filter((r) => Number.isFinite(r[key]) && r[key] !== 0);
  if (usable.length < 20) {
    console.log(`  ${label.padEnd(18)} (only ${usable.length} rounds — skipped)`);
    return;
  }
  const wins = usable.filter((r) => r[key] > 0).length;
  const rate = wins / usable.length;
  // Standard error of a proportion, for a 95% interval around 50%.
  const se = Math.sqrt(0.25 / usable.length);
  const z = (rate - 0.5) / se;
  const significant = Math.abs(z) > 1.96;
  console.log(
    `  ${label.padEnd(18)} ${(rate * 100).toFixed(1)}% of ${String(usable.length).padStart(4)} rounds` +
      `   z=${fmt(z, 2).padStart(6)}  ${significant ? '← significant' : 'not distinguishable from a coin flip'}`
  );
}

console.log('  Share of rounds won by the team with the higher mean mu:\n');
directionReport('all rounds', records);
for (const gm of ['RAAS', 'AAS', 'Invasion']) {
  const subset = records.filter((r) => r.gamemode === gm);
  if (subset.length >= 20) directionReport(gm, subset);
}

console.log('\n  Same test on the top-15 mu term the scrambler also optimizes:\n');
directionReport('all rounds', records, 'signedTop15Delta');

// Does a BIGGER mu edge win more often? If mu means anything, the
// rounds with the largest pre-round gap should be the most lopsided.
console.log('\n  Win rate by size of the mu edge (largest gaps should predict best):\n');
const byGap = [...records]
  .filter((r) => Number.isFinite(r.absMuDelta))
  .sort((a, b) => a.absMuDelta - b.absMuDelta);
const quartileSize = Math.floor(byGap.length / 4);
for (let q = 0; q < 4; q++) {
  const slice = byGap.slice(q * quartileSize, q === 3 ? byGap.length : (q + 1) * quartileSize);
  const wins = slice.filter((r) => r.higherMuTeamWon).length;
  const lo = slice[0]?.absMuDelta ?? NaN;
  const hi = slice[slice.length - 1]?.absMuDelta ?? NaN;
  console.log(
    `    Q${q + 1}  mu gap ${fmt(lo, 3)}–${fmt(hi, 3)}`.padEnd(34) +
      `${((wins / slice.length) * 100).toFixed(1)}% won by higher-mu team  (n=${slice.length})`
  );
}

// ─── 2. MAGNITUDE: does mu delta predict the blowout size? ───────
console.log('\n═══ 2. Does mu delta predict HOW lopsided the game is? ═══\n');

function magnitudeReport(label, subset) {
  if (subset.length < 20) return;
  const c = correlation(
    subset.map((r) => r.absMuDelta),
    subset.map((r) => r.ticketDiff)
  );
  const cTop = correlation(
    subset.map((r) => r.absTop15Delta),
    subset.map((r) => r.ticketDiff)
  );
  console.log(
    `  ${label.padEnd(14)} n=${String(c.n).padStart(4)}   ` +
      `r(mean mu delta, ticket diff) = ${fmt(c.r, 3).padStart(6)}   ` +
      `r(top15 delta, ticket diff) = ${fmt(cTop.r, 3).padStart(6)}`
  );
}

magnitudeReport('all rounds', records);
for (const gm of ['RAAS', 'AAS', 'Invasion']) {
  magnitudeReport(gm, records.filter((r) => r.gamemode === gm));
}

console.log('\n  Mean ticket diff by mu-gap quartile (should climb if mu matters):\n');
for (let q = 0; q < 4; q++) {
  const slice = byGap.slice(q * quartileSize, q === 3 ? byGap.length : (q + 1) * quartileSize);
  const td = describe(slice.map((r) => r.ticketDiff));
  const lo = slice[0]?.absMuDelta ?? NaN;
  const hi = slice[slice.length - 1]?.absMuDelta ?? NaN;
  console.log(
    `    Q${q + 1}  mu gap ${fmt(lo, 3)}–${fmt(hi, 3)}`.padEnd(34) +
      `mean ticket diff ${fmt(td.mean, 1).padStart(6)}   median ${fmt(td.median, 1).padStart(6)}  (n=${slice.length})`
  );
}

// ─── 3. Context: what do the outcomes even look like? ────────────
console.log('\n═══ 3. Outcome distributions ═══\n');

const td = describe(records.map((r) => r.ticketDiff));
console.log(`  Ticket diff:  mean ${fmt(td.mean, 1)}  median ${fmt(td.median, 1)}  sd ${fmt(td.sd, 1)}`);
console.log(
  `                p05 ${fmt(td.p05, 0)}  p25 ${fmt(td.p25, 0)}  p75 ${fmt(td.p75, 0)}  p95 ${fmt(td.p95, 0)}  max ${fmt(td.max, 0)}`
);

const md = describe(records.map((r) => r.absMuDelta));
console.log(`\n  Pre-round |mean mu delta|:  median ${fmt(md.median, 3)}  p95 ${fmt(md.p95, 3)}  max ${fmt(md.max, 3)}`);
console.log(`  Within-lobby mu spread (sd): median ${fmt(describe(records.map((r) => r.muSpread)).median, 3)}`);

const us = describe(records.map((r) => r.unseenShare));
console.log(
  `\n  Share of each lobby never rated before (mu exactly ${MU_DEFAULT}):  ` +
    `median ${(us.median * 100).toFixed(1)}%   p95 ${(us.p95 * 100).toFixed(1)}%`
);

console.log('\n  Ticket diff distribution:\n');
const edges = [0, 25, 50, 100, 150, 200, 300, 400, 600, Infinity];
const counts = edges.slice(0, -1).map((lo, i) =>
  records.filter((r) => r.ticketDiff >= lo && r.ticketDiff < edges[i + 1]).length
);
const maxCount = Math.max(...counts);
edges.slice(0, -1).forEach((lo, i) => {
  const hi = edges[i + 1];
  const label = hi === Infinity ? `${lo}+` : `${lo}–${hi}`;
  console.log(`    ${label.padStart(8)}  ${String(counts[i]).padStart(4)}  ${bar(counts[i], maxCount)}`);
});

console.log('\n  By gamemode:\n');
const modes = [...new Set(records.map((r) => r.gamemode))].sort();
for (const gm of modes) {
  const subset = records.filter((r) => r.gamemode === gm);
  const d = describe(subset.map((r) => r.ticketDiff));
  console.log(
    `    ${gm.padEnd(18)} n=${String(subset.length).padStart(4)}  mean ${fmt(d.mean, 1).padStart(6)}  median ${fmt(d.median, 1).padStart(6)}`
  );
}

console.log('');
