/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   PREDICTIVE PRE-ROUND μ-GAP TRIGGER — OFFLINE SIMULATION      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * §4 direction 1 ("scramble more often") is the top-ranked open item: today's
 * triggers are all reactive (blowout margin, consecutive wins, win streak) —
 * they fire after a bad round, one round late. §2.5 proposed a predictive
 * trigger instead: scramble whenever the pre-round μ gap clears a threshold,
 * with the caveat that forcing the existing 40-55 floor on ALREADY-close
 * lobbies made the gap worse 24% of the time (vs 0.2% above 0.4μ), so the
 * threshold should gate WHETHER to scramble, not how hard.
 *
 * This script simulates that trigger directly, on real historical rounds:
 *
 *   1. For every round, reconstruct the LIVE (round-start) roster and its
 *      real pre-round μ gap — the exact quantity a predictive trigger would
 *      read, and the only timing the scrambler can actually act on (see §6
 *      for why ENDGAME rosters are the wrong timing).
 *   2. Run the REAL Scrambler (team-balancer/utils/tb-scrambler.js, imported
 *      not reimplemented) with NO forced floor — the trigger's whole point is
 *      to let the optimizer do only as much work as the lobby needs, not to
 *      re-impose the flawed floor logic.
 *   3. Sweep candidate thresholds. At each one, "triggered" rounds get the
 *      scrambler's real output gap; untriggered rounds are left exactly as
 *      observed.
 *   4. Translate the μ-gap change into a ticket-margin projection using the
 *      SAME honest regression discipline as clan-block-margin.js: report R²
 *      and significance alongside the projection, because §2.6 already
 *      established μ explains only ~2.4% of margin variance. The projection
 *      is a best-linear-guess, not a measured result.
 *
 *   node --max-old-space-size=4096 analysis/predictive-trigger-simulate.js
 */

import { Scrambler } from '../team-balancer/utils/tb-scrambler.js';
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
const SCRAMBLE_PERCENTAGE = 0.5;
const THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0];
const CURRENT_TRIGGER_COVERAGE = 0.259; // §2.5 — reactive triggers today, for reference only

const clans = new ClansService({ options: { enabled: true, minSize: 2, maxSize: 25 } });
const tagOf = (name) => {
  const raw = clans.extractRawPrefix(name);
  return raw ? clans.normalizeTag(raw) : null;
};

const exp = loadExport(newestExport());
const snapshots = table(exp, 'S3PlayerSnapshots');
const eloRounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');

console.log('\n═══ PREDICTIVE PRE-ROUND μ-GAP TRIGGER — SIMULATION ═══\n');

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
console.log(`  house clan (excluded from clan-split constraint): ${HOUSE}\n`);

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

/* ─── roundsPlayed timeline, so the veteran-parity term the real scorer
 * uses sees a plausible history rather than always-zero ────────────────── */

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

/* ─── Build one candidate lobby per usable round, LIVE roster ───────────── */

const lobbies = [];
const rejected = { noRound: 0, nonCompetitive: 0, noTickets: 0, tooSmall: 0, badRoster: 0, thinRatings: 0 };

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
    rejected.thinRatings++;
    continue;
  }

  /* Shape must match transformSquadJSData() — squads keyed by `id`, not
   * `squadID`, exactly as scramble-replay.js documents. */
  const players = onTeam.map((p) => ({
    eosID: p.eosID,
    name: p.name,
    teamID: String(p.teamID),
    squadID: p.squadID ? `T${p.teamID}-S${p.squadID}` : null
  }));
  const squadMap = new Map();
  for (const p of players) {
    if (!p.squadID) continue;
    if (!squadMap.has(p.squadID)) {
      squadMap.set(p.squadID, { id: p.squadID, teamID: p.teamID, players: [], locked: false });
    }
    squadMap.get(p.squadID).players.push(p.eosID);
  }
  const eloMap = new Map();
  for (const p of onTeam) {
    eloMap.set(p.eosID, {
      mu: muByEos.get(p.eosID) ?? DEFAULT_MU,
      roundsPlayed: roundsPlayedBefore(p.eosID, liveSnap.ts)
    });
  }
  const clanGroups = clans.extractClanGroups(
    onTeam.map((p) => ({ eosID: p.eosID, name: p.name })),
    { ignoreList: [HOUSE] }
  );

  lobbies.push({
    matchId,
    ts: rd.endedAt,
    ticketDiff: Math.abs(rd.ticketDiff),
    players,
    squads: [...squadMap.values()],
    eloMap,
    clanGroups
  });
}

console.log('─── Round selection ───');
console.log(`  usable rounds:              ${lobbies.length}`);
console.log(`  dropped, no matching round: ${rejected.noRound}`);
console.log(`  dropped, non-RAAS:          ${rejected.nonCompetitive}`);
console.log(`  dropped, no ticket data:    ${rejected.noTickets}`);
console.log(`  dropped, under ${MIN_EFFECTIVE_PLAYERS} eff pop:   ${rejected.tooSmall}`);
console.log(`  dropped, thin roster/ratings: ${rejected.thinRatings + rejected.badRoster}\n`);

if (lobbies.length < 30) {
  console.log('Too few usable rounds to say anything. Stopping.\n');
  process.exit(0);
}

/* ─── Run the real scrambler once per lobby, no forced floor ───────────── */

console.log(`  running scrambler on ${lobbies.length} lobbies (no floor)...`);
const started = Date.now();
let done = 0;
for (const lobby of lobbies) {
  const plan = await Scrambler.scrambleTeamsPreservingSquads({
    squads: lobby.squads.map((s) => ({ ...s, players: [...s.players] })),
    players: lobby.players.map((p) => ({ ...p })),
    winStreakTeam: 1,
    scramblePercentage: SCRAMBLE_PERCENTAGE,
    eloMap: lobby.eloMap,
    minPlayersToMove: 0,
    maxPlayersToMove: 0,
    clanGroups: lobby.clanGroups,
    clanBlockPenaltyEnabled: false
  });
  const s = plan.eloSummary;
  lobby.preGap = s ? s.preMeanDiff : NaN;
  lobby.postGap = s ? s.postMeanDiff : NaN;
  lobby.moved = plan.length;
  done++;
  if (done % 100 === 0) {
    const rate = (Date.now() - started) / done;
    const eta = Math.round(((lobbies.length - done) * rate) / 1000);
    process.stdout.write(`\r  ${done}/${lobbies.length}  (eta ${eta}s)   `);
  }
}
process.stdout.write(`\r  ${lobbies.length}/${lobbies.length} — done in ${Math.round((Date.now() - started) / 1000)}s\n\n`);

const usable = lobbies.filter((l) => Number.isFinite(l.preGap) && Number.isFinite(l.postGap));
console.log(`  usable scrambler outputs: ${usable.length} (of ${lobbies.length})\n`);

/* ─── OLS: ticket diff ~ mu gap, fit once on this sample ───────────────── */

function ols(rows, y) {
  const n = rows.length;
  const k = rows[0].length + 1;
  const X = rows.map((r) => [1, ...r]);
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
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
  return { beta, predict, r2: 1 - ssRes / ssTot, ssRes, n, k };
}

const y = usable.map((l) => l.ticketDiff);
const model = ols(usable.map((l) => [l.preGap]), y);
const c = correlation(usable.map((l) => l.preGap), y);

console.log('═══ 1. Does pre-round μ gap predict ticket margin, on this sample? ═══\n');
console.log(`  r(preGap, ticketDiff) = ${fmt(c.r, 3)}   R^2 = ${fmt(model.r2, 4)}`);
console.log(`  fitted: ticketDiff ≈ ${fmt(model.beta[0], 1)} + ${fmt(model.beta[1], 1)} * preGap\n`);
console.log('  Reminder: §2.6 found the same relationship explains ~2.4% of margin variance.');
console.log('  Everything from §3 onward is a projection through this weak model, not a measurement.\n');

/* ─── 2. Real, exact check: does the no-floor scrambler ever make gap worse? */

console.log('═══ 2. Does scrambling an already-close lobby make the gap worse? (exact, no model) ═══\n');
for (const [label, lo, hi] of [['gap < 0.4', 0, 0.4], ['gap >= 0.4', 0.4, Infinity]]) {
  const sel = usable.filter((l) => l.preGap >= lo && l.preGap < hi);
  if (!sel.length) continue;
  const worse = sel.filter((l) => l.postGap > l.preGap).length;
  console.log(`  ${label.padEnd(12)} n=${String(sel.length).padStart(4)}   made worse: ${fmt((worse / sel.length) * 100, 1)}%`);
}
console.log('  (§2.5 reported 24% / 0.2% from the ENDGAME-roster, forced-floor replay — this is the');
console.log('   round-start, no-floor equivalent: the trigger design actually being proposed.)\n');

/* ─── 3. Threshold sweep ────────────────────────────────────────────────── */

console.log('═══ 3. Threshold sweep — coverage, achieved μ gap, projected ticket margin ═══\n');
console.log('  threshold  coverage   post-trigger gap (mean)   projected mean ticketDiff   Δ vs no trigger');
const baselineMeanTicket = describe(y).mean;
for (const theta of THRESHOLDS) {
  const triggered = usable.filter((l) => l.preGap >= theta);
  const coverage = triggered.length / usable.length;
  const gapUsed = usable.map((l) => (l.preGap >= theta ? l.postGap : l.preGap));
  const meanGapUsed = describe(gapUsed).mean;
  const projectedTicket = gapUsed.map((g) => model.predict([g]));
  const projMean = describe(projectedTicket).mean;
  const delta = projMean - baselineMeanTicket;
  console.log(
    `  ${fmt(theta, 2).padStart(5)}μ    ${`${fmt(coverage * 100, 1)}%`.padStart(6)}     ` +
      `${fmt(meanGapUsed, 3).padStart(8)}                  ${fmt(projMean, 1).padStart(8)}                  ` +
      `${delta <= 0 ? '' : '+'}${fmt(delta, 1)}`
  );
}
console.log(`\n  current reactive coverage, for reference: ~${fmt(CURRENT_TRIGGER_COVERAGE * 100, 1)}% (§2.5, different trigger logic)`);
console.log(`  baseline (no predictive trigger) mean ticket diff, this sample: ${fmt(baselineMeanTicket, 1)}`);

/* ─── 4. Players moved, for the cost side of the ledger ─────────────────── */

console.log('\n═══ 4. Cost: players moved when triggered ═══\n');
for (const theta of [0.4, 0.5, 0.6]) {
  const triggered = usable.filter((l) => l.preGap >= theta);
  if (!triggered.length) continue;
  const d = describe(triggered.map((l) => l.moved));
  console.log(`  threshold ${fmt(theta, 1)}μ   n=${String(triggered.length).padStart(4)}   players moved: mean ${fmt(d.mean, 1)}, median ${fmt(d.median, 1)}`);
}

/* ─── 5. Verdict ─────────────────────────────────────────────────────────── */

console.log('\n═══ 5. Verdict ═══\n');
const lrtStat = usable.length * Math.log((describe(y).sd ** 2 * (usable.length - 1)) / model.ssRes);
const p = chiSqP(Math.max(0, lrtStat), 1);
console.log(`  mu-gap -> margin relationship: R^2=${fmt(model.r2, 4)}, p=${pStr(p)}`);
console.log(p < 0.05
  ? '  Statistically real, but tiny — treat the §3 projections as directional at best.'
  : '  Not distinguishable from noise in this sample — the §3 projections are speculative.');
console.log('');
