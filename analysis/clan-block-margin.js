/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   DOES CLAN-BLOCK IMBALANCE PREDICT TICKET MARGIN (LIVE)?     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * §7 of analysis/SCRAMBLE_BALANCE_INVESTIGATION.md found that a non-house clan
 * block >=3 on one team beats the mu-based direction call (ΔlogLik 6.27 at
 * LIVE, held-out positive). analysis/scramble-replay.js then showed the new
 * clanBlockPenaltyEnabled scorer can push more lobbies to zero clan-block
 * imbalance (47.5% -> 58.0%) for a trivial mu cost.
 *
 * Neither of those establishes that closing the clan-block gap closes the
 * SCORELINE. mu-predicts-margin.js already showed mu itself is a fine
 * predictor of who wins but a weak one of by how much (r ~ 0.155, measured
 * at ENDGAME there). This script asks the same magnitude question about
 * clan-block imbalance specifically, on the LIVE (pre-outcome) roster, using
 * the same pairing machinery as reverse-causation-check.js so the timing is
 * not re-litigated.
 *
 * Two things decide whether clanBlockPenaltyEnabled is worth flipping on:
 *
 *   1. Does |clan-block imbalance| correlate with |ticket diff| at all,
 *      controlling for |mu delta|? If it adds nothing over mu, closing the
 *      block gap cannot be expected to close the scoreline.
 *
 *   2. What's the effect size — how many tickets does one unit of block
 *      imbalance cost, on top of mu? That converts the replay's "imbalance
 *      count" result into the unit that actually matters.
 *
 *   node --max-old-space-size=4096 analysis/clan-block-margin.js
 */

import ClansService from '../s3/utils/clans-service.js';
import {
  newestExport,
  loadExport,
  table,
  describe,
  correlation,
  isCompetitive,
  effectivePopulation,
  MIN_EFFECTIVE_PLAYERS,
  fmt,
  pStr,
  chiSqP
} from './load-export.js';

const DEFAULT_MU = 25.0;
const TS_TOLERANCE_MS = 300_000;
const CLAN_BLOCK_THRESHOLD = 3;

const clans = new ClansService({ options: { enabled: true, minSize: 2, maxSize: 25 } });
const tagOf = (name) => {
  const raw = clans.extractRawPrefix(name);
  return raw ? clans.normalizeTag(raw) : null;
};

const exp = loadExport(newestExport());
const snapshots = table(exp, 'S3PlayerSnapshots');
const eloRounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');

console.log('\n═══ CLAN-BLOCK IMBALANCE vs TICKET MARGIN (LIVE roster) ═══\n');

/* ─── House clan, same empirical rule as the other scripts ─────────────── */

const tagCounts = new Map();
for (const s of snapshots) {
  if (s.trigger !== 'ENDGAME') continue;
  let roster;
  try {
    roster = JSON.parse(s.playersJson);
  } catch {
    continue;
  }
  for (const p of roster) {
    const t = tagOf(p.name);
    if (t) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }
}
const HOUSE = [...tagCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
console.log(`  house clan (excluded from clan-block scoring): ${HOUSE}\n`);

/* ─── Joins, identical pattern to reverse-causation-check.js ───────────── */

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

/* ─── Build one record per usable round, LIVE roster only ──────────────── */

const paired = [];
const rejected = { noLive: 0, noRound: 0, nonCompetitive: 0, noTickets: 0, tooSmall: 0, badRoster: 0 };

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
  if (!Number.isFinite(rd.ticketDiff)) {
    rejected.noTickets++;
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
  if (onTeam.filter((p) => muByEos.has(p.eosID)).length / onTeam.length < 0.5) {
    rejected.badRoster++;
    continue;
  }

  const blockSize = new Map();
  for (const p of onTeam) {
    const t = tagOf(p.name);
    if (!t || t === HOUSE) continue;
    const bk = `${p.teamID}|${t}`;
    blockSize.set(bk, (blockSize.get(bk) || 0) + 1);
  }
  let t1Blocks = 0;
  let t2Blocks = 0;
  for (const [bk, size] of blockSize) {
    if (size < CLAN_BLOCK_THRESHOLD) continue;
    if (bk.startsWith('1|')) t1Blocks++;
    else t2Blocks++;
  }

  const mu1 = onTeam.filter((p) => p.teamID === 1).map((p) => muByEos.get(p.eosID) ?? DEFAULT_MU);
  const mu2 = onTeam.filter((p) => p.teamID === 2).map((p) => muByEos.get(p.eosID) ?? DEFAULT_MU);
  const meanMu1 = mu1.reduce((s, v) => s + v, 0) / mu1.length;
  const meanMu2 = mu2.reduce((s, v) => s + v, 0) / mu2.length;

  paired.push({
    matchId,
    ts: rd.endedAt,
    ticketDiff: Math.abs(rd.ticketDiff),
    absMuDelta: Math.abs(meanMu1 - meanMu2),
    clanBlockImbalance: Math.abs(t1Blocks - t2Blocks),
    t1Blocks,
    t2Blocks
  });
}

console.log('─── Round selection ───');
console.log(`  usable rounds:              ${paired.length}`);
console.log(`  dropped, no matching round: ${rejected.noRound}`);
console.log(`  dropped, non-RAAS:          ${rejected.nonCompetitive}`);
console.log(`  dropped, no ticket data:    ${rejected.noTickets}`);
console.log(`  dropped, under ${MIN_EFFECTIVE_PLAYERS} eff pop:   ${rejected.tooSmall}`);
console.log(`  dropped, thin roster:       ${rejected.badRoster}\n`);

if (paired.length < 30) {
  console.log('Too few usable rounds to say anything. Stopping.\n');
  process.exit(0);
}

/* ─── Ordinary least squares via normal equations, no external deps ────── */
function ols(rows, y) {
  const n = rows.length;
  const k = rows[0].length + 1; // + intercept
  const X = rows.map((r) => [1, ...r]);
  // XtX (k x k) and Xty (k)
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  // Gaussian elimination solve XtX * beta = Xty
  const A = XtX.map((row, i) => [...row, Xty[i]]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const pv = A[col][col] || 1e-12;
    for (let c = col; c <= k; c++) A[col][c] /= pv;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let c = col; c <= k; c++) A[r][c] -= f * A[col][c];
    }
  }
  const beta = A.map((row) => row[k]);
  const predict = (row) => beta[0] + row.reduce((s, v, j) => s + v * beta[j + 1], 0);
  let ssRes = 0;
  let ssTot = 0;
  const my = y.reduce((s, v) => s + v, 0) / n;
  for (let i = 0; i < n; i++) {
    const p = predict(rows[i]);
    ssRes += (y[i] - p) ** 2;
    ssTot += (y[i] - my) ** 2;
  }
  const r2 = 1 - ssRes / ssTot;
  return { beta, predict, r2, n, k };
}

/* ─── 1. Simple correlations ────────────────────────────────────────────── */

console.log('═══ 1. Simple correlation with |ticket diff| ═══\n');
const cMu = correlation(paired.map((r) => r.absMuDelta), paired.map((r) => r.ticketDiff));
const cBlock = correlation(paired.map((r) => r.clanBlockImbalance), paired.map((r) => r.ticketDiff));
console.log(`  r(|mu delta|, ticket diff)             = ${fmt(cMu.r, 3)}   (n=${cMu.n})`);
console.log(`  r(clan-block imbalance, ticket diff)   = ${fmt(cBlock.r, 3)}   (n=${cBlock.n})`);
console.log(`  r(|mu delta|, clan-block imbalance)    = ${fmt(correlation(paired.map((r) => r.absMuDelta), paired.map((r) => r.clanBlockImbalance)).r, 3)}  (collinearity check)\n`);

/* ─── 2. Does clan-block imbalance add anything on top of mu? ──────────── */

console.log('═══ 2. OLS on |ticket diff|: does clan-block imbalance add anything over |mu delta|? ═══\n');
const y = paired.map((r) => r.ticketDiff);
const baseRows = paired.map((r) => [r.absMuDelta]);
const fullRows = paired.map((r) => [r.absMuDelta, r.clanBlockImbalance]);
const base = ols(baseRows, y);
const full = ols(fullRows, y);
console.log(`  |mu delta| only              R^2 = ${fmt(base.r2, 4)}`);
console.log(`  |mu delta| + clan imbalance  R^2 = ${fmt(full.r2, 4)}   (ΔR^2 = ${fmt(full.r2 - base.r2, 4)})`);
console.log(`\n  coefficients (full model): intercept ${fmt(full.beta[0], 1)}, ` +
  `mu-delta ${fmt(full.beta[1], 2)} tickets/mu, clan-imbalance ${fmt(full.beta[2], 2)} tickets/unit`);

/* F-test for whether adding clan-block imbalance significantly improves fit */
const n = paired.length;
const ssResBase = (1 - base.r2) * y.reduce((s, v) => s + (v - y.reduce((a, b) => a + b, 0) / n) ** 2, 0);
const ssResFull = (1 - full.r2) * y.reduce((s, v) => s + (v - y.reduce((a, b) => a + b, 0) / n) ** 2, 0);
const F = ((ssResBase - ssResFull) / 1) / (ssResFull / (n - full.k));
// F(1, n-k) ~ chi-sq(1) approx for large n via chiSqP on F itself is wrong, but
// LRT-style using chi-sq(1) on n*log(ssResBase/ssResFull) is the standard normal-errors LRT.
const lrtStat = n * Math.log(ssResBase / ssResFull);
const p = chiSqP(lrtStat, 1);
console.log(`\n  F(1,${n - full.k}) = ${fmt(F, 2)}   LRT chi-sq(1) = ${fmt(lrtStat, 2)}   p = ${pStr(p)}`);
console.log(p < 0.05
  ? '  ← clan-block imbalance predicts margin beyond mu alone.'
  : '  clan-block imbalance adds nothing detectable to margin beyond mu.');

/* ─── 3. Quartile view, mirrors mu-predicts-margin.js §2 ────────────────── */

console.log('\n═══ 3. Mean ticket diff by clan-block imbalance ═══\n');
const byImb = new Map();
for (const r of paired) {
  const k = r.clanBlockImbalance;
  if (!byImb.has(k)) byImb.set(k, []);
  byImb.get(k).push(r.ticketDiff);
}
for (const k of [...byImb.keys()].sort((a, b) => a - b)) {
  const d = describe(byImb.get(k));
  console.log(`  imbalance = ${String(k).padStart(2)}   n=${String(d.n).padStart(4)}   mean ticket diff ${fmt(d.mean, 1).padStart(6)}   median ${fmt(d.median, 1).padStart(6)}`);
}

/* ─── 4. Translate the replay's imbalance-count win into tickets ────────── */

console.log('\n═══ 4. Converting §7\'s replay result into tickets ═══\n');
console.log('  scramble-replay.js --full: production 47.5% zero-imbalance -> clan-priced 58.0%');
console.log('  (96 lobbies improved by exactly 1 unit of imbalance, 2 worsened, of 793)\n');
if (p < 0.05) {
  const perUnit = full.beta[2];
  console.log(`  at ${fmt(perUnit, 2)} tickets per unit of imbalance, moving ~96 lobbies from`);
  console.log(`  imbalance 1 -> 0 predicts roughly ${fmt(Math.abs(perUnit) * 96, 0)} cumulative tickets closer margin`);
  console.log(`  across those lobbies (${fmt(Math.abs(perUnit), 2)} tickets/lobby on average), holding mu delta fixed.`);
} else {
  console.log('  No significant tickets-per-unit coefficient to report — see §2 above.');
  console.log('  The replay\'s imbalance-count win cannot currently be translated into a ticket-margin claim.');
}
console.log('');
