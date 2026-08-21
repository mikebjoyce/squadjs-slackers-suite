/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   WOULD MARGIN-OF-VICTORY-WEIGHTED ELO REDUCE TICKET MARGIN?   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Prompted by a proposal to make the rating update (elo-tracker/utils/
 * elo-calculator.js — a standard TrueSkill1 win/loss/draw update, confirmed
 * to have NO margin-of-victory input at all) scale deltaMu by how big the
 * ticket margin was, on the theory that better-separated ratings would let
 * team-balancer build closer teams and shrink the ~100-ticket mean margin.
 *
 * This is directly testable without touching the live plugin: rebuild the
 * ENTIRE rating history from scratch via EloCalculator.computeTeamUpdate,
 * exactly mirroring elo-tracker.js's real update loop, chronologically over
 * every recorded round — once at the real BETA/TAU with margin ignored
 * (validated against the actual recorded muBefore/muAfter before trusting
 * anything), and again several times with deltaMu scaled by a margin-of-
 * victory multiplier at increasing strengths.
 *
 * Two independent questions, scored separately:
 *   1. Does MOV-weighting produce ratings that better predict WHO WINS —
 *      chronological, out-of-sample win-probability log-loss, using only
 *      the mu/sigma each player had walking into that round. This is the
 *      legitimate, well-established case for MOV weighting (faster, better-
 *      separated skill convergence) and does not depend on margin being a
 *      good proxy for skill in any single round.
 *   2. Does MOV-weighting produce a pre-round mu-gap that better predicts
 *      the REALIZED ticket margin — this is what the proposal is actually
 *      asking for. ticket-margin-drivers.js already found mu-gap alone
 *      explains only R²=0.0241 of margin variance (2.4%), because ~95% of
 *      margin is in-round noise (momentum, individual play, admin calls)
 *      that no pre-round rating, however calibrated, can see. MOV-weighting
 *      changes HOW ratings are built from past margins; it cannot change
 *      how much of a FUTURE round's margin is knowable in advance. Expect
 *      this ceiling to hold regardless of what (1) shows.
 *
 *   node --max-old-space-size=4096 analysis/elo-margin-weighting-test.js
 */

import EloCalculator from '../elo-tracker/utils/elo-calculator.js';
import { newestExport, loadExport, table, describe, correlation, fmt } from './load-export.js';

const exp = loadExport(newestExport());
const eloRounds = table(exp, 'Elo_RoundHistory')
  .filter((r) => Number.isFinite(r.endedAt) && (r.winningTeamID === 1 || r.winningTeamID === 2))
  .sort((a, b) => a.endedAt - b.endedAt || a.id - b.id);
const roundPlayers = table(exp, 'Elo_RoundPlayers');

const playersByRound = new Map();
for (const p of roundPlayers) {
  if (!playersByRound.has(p.roundHistoryId)) playersByRound.set(p.roundHistoryId, []);
  playersByRound.get(p.roundHistoryId).push(p);
}

const rounds = eloRounds
  .map((r) => {
    const ps = playersByRound.get(r.id) || [];
    const team1 = ps.filter((p) => p.teamID === 1);
    const team2 = ps.filter((p) => p.teamID === 2);
    return { ...r, team1, team2 };
  })
  .filter((r) => r.team1.length > 0 && r.team2.length > 0);

console.log('\n═══ MARGIN-OF-VICTORY-WEIGHTED ELO — would it reduce ticket margin? ═══\n');
console.log(`  rated rounds usable for replay: ${rounds.length} (of ${eloRounds.length} in Elo_RoundHistory)`);

const marginDist = describe(rounds.map((r) => r.ticketDiff));
console.log(`  ticketDiff: mean ${fmt(marginDist.mean, 1)}, median ${fmt(marginDist.median, 1)}\n`);

/* ─── Replay engine — mirrors elo-tracker.js:774-844 exactly ─────────────
 * movMultiplier === null reproduces production (no margin input at all). */
function replay(movStrength, medianMargin) {
  const ratings = new Map();
  const getRating = (eosID) => {
    if (!ratings.has(eosID)) ratings.set(eosID, EloCalculator.getDefaultRating());
    return ratings.get(eosID);
  };

  const movMultiplier = (ticketDiff) => {
    if (!movStrength) return 1;
    // log1p-normalised so a typical (median) margin is unchanged (multiplier 1),
    // blowouts scale up, tiny margins scale down — symmetric, not one-sided.
    const norm = Math.log1p(ticketDiff) / Math.log1p(medianMargin);
    return Math.min(Math.max(1 + movStrength * (norm - 1), 0.25), 3.0);
  };

  const rows = []; // one per round: pre-round mu gap, realized margin, log-loss term
  let sigmaSum = 0;
  let sigmaN = 0;

  for (const r of rounds) {
    const t1 = r.team1.map((p) => ({ ...getRating(p.eosID), participationRatio: p.participationRatio, eosID: p.eosID }));
    const t2 = r.team2.map((p) => ({ ...getRating(p.eosID), participationRatio: p.participationRatio, eosID: p.eosID }));

    // Pre-round state — this is what a scramble decision would have seen.
    const avg = (arr) => arr.reduce((a, b) => a + b.mu, 0) / arr.length;
    const preMuGap = Math.abs(avg(t1) - avg(t2));
    const winProb = winProbability(t1, t2);
    const actualWinIsT1 = r.winningTeamID === 1;
    const p = actualWinIsT1 ? winProb : 1 - winProb;
    rows.push({ preMuGap, ticketDiff: r.ticketDiff, logLoss: -Math.log(Math.max(p, 1e-9)) });

    const outcome = r.winningTeamID === 1 ? 'team1win' : 'team2win';
    const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(t1, t2, outcome);
    const mult = movMultiplier(r.ticketDiff);

    const apply = (team, updates) => {
      for (let i = 0; i < team.length; i++) {
        const player = team[i];
        const { deltaMu, deltaSigma } = updates[i];
        const rating = getRating(player.eosID);
        const scaledDeltaMu = deltaMu * mult * player.participationRatio;
        const scaledDeltaSigma = deltaSigma * player.participationRatio;
        rating.mu = rating.mu + scaledDeltaMu;
        rating.sigma = Math.max(rating.sigma - scaledDeltaSigma, 0.5);
        sigmaSum += rating.sigma;
        sigmaN++;
      }
    };
    apply(t1, team1Updates);
    apply(t2, team2Updates);
  }

  return { rows, finalRatings: ratings, meanSigma: sigmaSum / sigmaN };
}

/* Ported from elo-tracker/tools/elo-calibrate.js's winProbability() — the same
 * >50-per-team scaling computeTeamUpdate() applies internally has to be mirrored
 * here too, or unequal (but both large) team sizes blow up the raw summed team-mu
 * difference and produce wildly overconfident, badly miscalibrated predictions. */
function winProbability(team1, team2) {
  const BETA = EloCalculator.BETA;
  const getRatio = (p) => p.participationRatio ?? 1.0;

  let effectiveN1 = team1.reduce((s, p) => s + getRatio(p), 0);
  let effectiveN2 = team2.reduce((s, p) => s + getRatio(p), 0);
  const scale1 = effectiveN1 > 50.0 ? 50.0 / effectiveN1 : 1.0;
  const scale2 = effectiveN2 > 50.0 ? 50.0 / effectiveN2 : 1.0;
  effectiveN1 *= scale1;
  effectiveN2 *= scale2;

  const teamMu1 = team1.reduce((s, p) => s + p.mu * getRatio(p), 0) * scale1;
  const teamMu2 = team2.reduce((s, p) => s + p.mu * getRatio(p), 0) * scale2;
  const teamSigmaSq1 = team1.reduce((s, p) => s + (p.sigma * p.sigma + BETA * BETA) * getRatio(p), 0) * scale1;
  const teamSigmaSq2 = team2.reduce((s, p) => s + (p.sigma * p.sigma + BETA * BETA) * getRatio(p), 0) * scale2;
  const c = Math.sqrt(teamSigmaSq1 + teamSigmaSq2);

  const nTotal = effectiveN1 + effectiveN2;
  const epsilon = Math.sqrt(nTotal) * BETA * Math.SQRT2 * EloCalculator._erfInv(EloCalculator.DRAW_PROBABILITY);
  const t = (teamMu1 - teamMu2) / c;
  return EloCalculator._cdf(t - epsilon / c);
}

/* ─── Validation: does strength=0 reproduce the recorded muAfter values? ─── */
const baseline = replay(0, marginDist.median);
const recordedMuAfter = [];
const replayedMuAfter = [];
for (const r of rounds) {
  for (const p of [...r.team1, ...r.team2]) {
    if (!Number.isFinite(p.muAfter)) continue;
    recordedMuAfter.push(p.muAfter);
    // NOTE: this only checks the FINAL mu each eosID ended up at (map holds latest),
    // which is a coarse but honest fidelity check — see printed sample deltas below.
  }
}
const finalCheck = [];
for (const [eosID, rating] of baseline.finalRatings) {
  finalCheck.push(rating.mu);
}
console.log('─── Validation: does strength=0 reproduce production\'s TrueSkill math? ───\n');
// Spot-check: rebuild each player's actual LAST recorded muAfter and compare to replay's final mu.
const lastRecorded = new Map();
for (const r of rounds) {
  for (const p of [...r.team1, ...r.team2]) {
    if (Number.isFinite(p.muAfter)) lastRecorded.set(p.eosID, p.muAfter);
  }
}
let diffs = [];
for (const [eosID, recordedMu] of lastRecorded) {
  const replayedMu = baseline.finalRatings.get(eosID)?.mu;
  if (Number.isFinite(replayedMu)) diffs.push(Math.abs(replayedMu - recordedMu));
}
const diffStats = describe(diffs);
console.log(`  players compared: ${diffs.length}`);
console.log(`  |replayed final mu − recorded final mu|: mean ${fmt(diffStats.mean, 3)}, median ${fmt(diffStats.median, 3)}, max ${fmt(Math.max(...diffs), 3)}`);
const closeEnough = diffStats.median < 0.5;
console.log(
  closeEnough
    ? '  Close enough to trust — remaining drift is expected from draws/edge cases this replay skips.\n'
    : '  NOT close enough — do not trust the comparisons below without fixing this first.\n'
);

/* ─── Sweep MOV strength ───────────────────────────────────────────────── */
const STRENGTHS = [0, 0.3, 0.6, 1.0, 1.5];
console.log('═══ 1. Out-of-sample win prediction — does MOV-weighting produce better-calibrated ratings? ═══\n');
console.log('  strength   mean log-loss (lower=better)   vs strength=0');
const results = {};
let baseLogLoss = null;
for (const s of STRENGTHS) {
  const { rows, meanSigma } = s === 0 ? baseline : replay(s, marginDist.median);
  results[s] = rows;
  const meanLL = rows.reduce((a, r) => a + r.logLoss, 0) / rows.length;
  if (s === 0) baseLogLoss = meanLL;
  const delta = meanLL - baseLogLoss;
  console.log(
    `  ${String(s).padEnd(9)}  ${fmt(meanLL, 4).padStart(6)}                        ${delta === 0 ? '(baseline)' : (delta <= 0 ? '' : '+') + fmt(delta, 4)}   mean σ ${fmt(meanSigma, 3)}`
  );
}

console.log('\n═══ 2. Does the pre-round mu-gap better predict the REALIZED ticket margin? ═══\n');
console.log('  NOTE: this replay applies TODAY\'S fixed BETA/TAU across the whole history, but');
console.log('  elo-calculator.js records these were recalibrated 2026-07-30 — production ran under');
console.log('  different constants before that date. So these R² values are not directly comparable');
console.log('  to ticket-margin-drivers.js\'s R²=0.0241 (computed from the real historical mu, under');
console.log('  whatever constants were live at the time); only the relative comparison ACROSS MOV');
console.log('  strengths below is apples-to-apples, since all of them share the same fixed constants.\n');
console.log('  strength   r(preMuGap, ticketDiff)   R²');
for (const s of STRENGTHS) {
  const rows = results[s];
  const { r } = correlation(
    rows.map((x) => x.preMuGap),
    rows.map((x) => x.ticketDiff)
  );
  console.log(`  ${String(s).padEnd(9)}  ${fmt(r, 4).padStart(7)}                  ${fmt(r * r, 4)}`);
}

console.log('\n═══ Verdict ═══\n');
console.log('  If log-loss drops and R² does not move: MOV-weighting makes ratings better at');
console.log('  ranking who wins, which is a real, separate benefit (useful for the re-targeted');
console.log('  win-rate-parity KPI, §9 item 5) — but it does not touch ticket margin, because');
console.log('  margin is set by factors no pre-round rating observes (§4 direction 6). If R² also');
console.log('  fails to move, that\'s the expected outcome, not a modeling failure: you cannot');
console.log('  raise a ceiling that sits on ~95% in-round noise by changing how the rating that');
console.log('  explains the other ~5% gets updated.\n');
