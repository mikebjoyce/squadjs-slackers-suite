/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║        WHAT IS AN UNRATED PLAYER ACTUALLY WORTH?              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * `tb-scrambler.js:430` scores any player without a rating as exactly 25.0:
 *
 *     const getElo = (id) => playerEloMap.get(id) ?? defaultMu;
 *
 * 25.0 is TrueSkill's *initialisation* constant. It is not a measurement of
 * anything, and in particular it is not the mean skill of the people who turn
 * up unrated. Using it asserts that a stranger is precisely average.
 *
 * `analysis/squad-coordination.js` showed that assertion is wrong and expensive:
 * unrated-share difference between teams adds ΔlogLik 23.45 over mean-mu-diff
 * alone — more than every squad/clan structure feature combined — and rating-
 * confidence controls move held-out accuracy 67.4% → 70.1%. That is the single
 * largest effect found anywhere in the investigation.
 *
 * This script measures the replacement. Two independent approaches, because
 * each has a failure mode the other does not:
 *
 *   FORWARD-LOOKING (part 2) — follow newcomers and see where their rating
 *     settles. Direct and easy to interpret, but wide open to SURVIVORSHIP:
 *     a player who plays twice and leaves never converges to anything, so the
 *     estimate is built only from those who stayed. If weak players churn out
 *     faster, this is biased upward. Horizon sensitivity is reported so the
 *     size of that bias is visible rather than assumed away.
 *
 *   OUTCOME-CALIBRATED (part 3) — sweep the prior and ask which value makes
 *     unrated-share stop predicting the winner. Immune to survivorship, because
 *     it never needs a newcomer's rating to converge — it only uses whether
 *     their team won. Indirect, but it targets exactly the quantity the
 *     scrambler needs: the value at which team-strength comparisons become
 *     unbiased.
 *
 * If the two agree, the number is solid. If they disagree, the outcome-
 * calibrated one is the one to ship, and the gap between them is a measurement
 * of the churn selection effect.
 *
 * Part 4 then asks whether a single constant is even the right shape, or
 * whether sigma-weighted shrinkage (which subsumes the constant as a special
 * case) does better.
 *
 *   node --max-old-space-size=4096 analysis/newcomer-prior.js
 */

import {
  newestExport,
  loadExport,
  table,
  describe,
  isCompetitive,
  effectivePopulation,
  MIN_EFFECTIVE_PLAYERS,
  fmt,
  bar,
  fitLogistic,
  crossValidate,
  chiSqP,
  pStr
} from './load-export.js';

const DEFAULT_MU = 25.0;
const DEFAULT_SIGMA = 8.3333;
const TS_TOLERANCE_MS = 300_000;

const exp = loadExport(newestExport());
const snapshots = table(exp, 'S3PlayerSnapshots');
const eloRounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');

console.log('\n═══ NEWCOMER PRIOR ═══\n');

/* ─── Order every round, then every player's appearances within them ────── */

const roundById = new Map();
for (const r of eloRounds) roundById.set(r.id, r);

const appearances = [];
for (const rp of roundPlayers) {
  const rd = roundById.get(rp.roundHistoryId);
  if (!rd || !Number.isFinite(rd.endedAt)) continue;
  appearances.push({
    eosID: rp.eosID,
    ts: rd.endedAt,
    muBefore: rp.muBefore,
    muAfter: rp.muAfter,
    sigmaBefore: rp.sigmaBefore,
    sigmaAfter: rp.sigmaAfter,
    participationRatio: rp.participationRatio
  });
}
appearances.sort((a, b) => a.ts - b.ts);

const seen = new Map();
for (const a of appearances) {
  const n = seen.get(a.eosID) ?? 0;
  a.priorRounds = n;
  seen.set(a.eosID, n + 1);
}
const totalRounds = new Map(seen);

console.log(`  rated player-rounds: ${appearances.length}`);
console.log(`  distinct players:    ${totalRounds.size}\n`);

/* ─── Part 1: what does the rating system do with experience? ──────────── */

/*
 * muBefore at priorRounds = 0 is 25.0 by construction — that is the
 * initialisation, not a measurement, and it is the very thing under review.
 * The informative column is muAfter: where the system moves people once it has
 * seen them play.
 */
console.log('─── 1. Rating by experience ───\n');
console.log('  prior rounds     player-rounds   mean muBefore   mean muAfter   mean sigmaBefore');
const EXP_BUCKETS = [
  ['0 (first ever)', 0, 0], ['1–2', 1, 2], ['3–5', 3, 5], ['6–10', 6, 10],
  ['11–25', 11, 25], ['26–50', 26, 50], ['51–100', 51, 100], ['100+', 101, Infinity]
];
for (const [label, lo, hi] of EXP_BUCKETS) {
  const sel = appearances.filter((a) => a.priorRounds >= lo && a.priorRounds <= hi);
  if (sel.length === 0) continue;
  const mb = describe(sel.map((a) => a.muBefore));
  const ma = describe(sel.map((a) => a.muAfter));
  const sb = describe(sel.map((a) => a.sigmaBefore));
  console.log(
    `  ${label.padEnd(16)} ${String(sel.length).padStart(13)}   ` +
      `${fmt(mb.mean, 3).padStart(13)}   ${fmt(ma.mean, 3).padStart(12)}   ${fmt(sb.mean, 3).padStart(16)}`
  );
}

/* ─── Part 2: where does a newcomer's rating settle? ───────────────────── */

/*
 * For players who reached at least K rounds, what is their rating AT round K?
 * Sweeping K exposes survivorship directly: if the estimate climbs with K, the
 * population is being filtered, not measured. A flat line would mean the
 * newcomer prior is stable and the forward-looking estimate is trustworthy.
 */
console.log('\n─── 2. Where newcomers settle, and how much of that is survivorship ───\n');
const byPlayer = new Map();
for (const a of appearances) {
  if (!byPlayer.has(a.eosID)) byPlayer.set(a.eosID, []);
  byPlayer.get(a.eosID).push(a);
}

console.log('  horizon K   players reaching K   mean mu at round K   mean final mu');
for (const K of [1, 2, 3, 5, 10, 20, 50, 100]) {
  const reached = [...byPlayer.values()].filter((rs) => rs.length >= K);
  if (reached.length < 10) continue;
  const atK = describe(reached.map((rs) => rs[K - 1].muAfter));
  const fin = describe(reached.map((rs) => rs[rs.length - 1].muAfter));
  console.log(
    `  ${String(K).padEnd(11)} ${String(reached.length).padStart(18)}   ` +
      `${fmt(atK.mean, 3).padStart(18)}   ${fmt(fin.mean, 3).padStart(13)}`
  );
}

/*
 * The complementary cut: group players by how long they ultimately lasted, and
 * look at what the system thought of them after their FIRST round. If one-and-
 * done players start out worse than eventual regulars, churn is skill-selective
 * and every forward-looking estimate above is biased upward.
 */
console.log('\n  first-round rating, grouped by how long the player ultimately lasted:');
console.log('    career length   players   mean mu after round 1   mean participation');
const CAREER = [
  ['1 round', 1, 1], ['2–4', 2, 4], ['5–9', 5, 9],
  ['10–24', 10, 24], ['25–99', 25, 99], ['100+', 100, Infinity]
];
for (const [label, lo, hi] of CAREER) {
  const sel = [...byPlayer.values()].filter((rs) => rs.length >= lo && rs.length <= hi);
  if (sel.length === 0) continue;
  const first = describe(sel.map((rs) => rs[0].muAfter));
  const part = describe(sel.map((rs) => rs[0].participationRatio).filter(Number.isFinite));
  console.log(
    `    ${label.padEnd(15)} ${String(sel.length).padStart(7)}   ${fmt(first.mean, 3).padStart(21)}   ` +
      `${fmt(part.mean, 3).padStart(18)}`
  );
}

/* ─── Rebuild the round dataset (same construction as squad-coordination) ── */

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

const latestByMatch = new Map();
for (const s of snapshots) {
  if (s.trigger !== 'ENDGAME') continue;
  const prev = latestByMatch.get(s.matchId);
  if (!prev || s.ts > prev.ts) latestByMatch.set(s.matchId, s);
}

const rounds = [];
for (const snap of latestByMatch.values()) {
  const rd = roundForSnapshot(snap);
  if (!rd || !isCompetitive(rd.layerName) || !rd.winningTeamID) continue;
  const rps = byRoundId.get(rd.id) || [];
  if (effectivePopulation(rps) < MIN_EFFECTIVE_PLAYERS) continue;

  const muByEos = new Map();
  const sigByEos = new Map();
  for (const p of rps) {
    if (Number.isFinite(p.muBefore)) muByEos.set(p.eosID, p.muBefore);
    if (Number.isFinite(p.sigmaBefore)) sigByEos.set(p.eosID, p.sigmaBefore);
  }

  let roster;
  try {
    roster = JSON.parse(snap.playersJson);
  } catch {
    continue;
  }
  const onTeam = roster.filter((p) => p.teamID === 1 || p.teamID === 2);
  if (onTeam.length < MIN_EFFECTIVE_PLAYERS) continue;
  if (onTeam.filter((p) => muByEos.has(p.eosID)).length / onTeam.length < 0.5) continue;

  rounds.push({
    t1Won: rd.winningTeamID === 1,
    players: onTeam.map((p) => ({
      teamID: p.teamID,
      rated: muByEos.has(p.eosID),
      mu: muByEos.get(p.eosID) ?? null,
      sigma: sigByEos.get(p.eosID) ?? null
    }))
  });
}

const y = rounds.map((r) => (r.t1Won ? 1 : 0));
console.log(`\n  rounds available for outcome calibration: ${rounds.length}`);

/* ─── Part 3: which prior makes unrated share stop mattering? ──────────── */

/*
 * The logic: if the prior were correct, an unrated player would be scored at
 * their true expected strength, team means would be unbiased, and how MANY
 * unrated players a team has would carry no further information about who won.
 * Any residual predictive power in unrated-share is the prior being wrong.
 *
 * So sweep the prior, and for each value refit the mu-only model and measure
 * (a) how much unrated-share still adds on top, and (b) held-out log-loss.
 * The correct prior minimises both. This never needs a newcomer's rating to
 * converge, so churn cannot bias it.
 */
console.log('\n─── 3. Outcome-calibrated prior sweep ───\n');

function teamMeansWith(prior, shrinkTau = null) {
  return rounds.map((r) => {
    const acc = { 1: [0, 0], 2: [0, 0] };
    let unrated1 = 0;
    let unrated2 = 0;
    let n1 = 0;
    let n2 = 0;
    for (const p of r.players) {
      let v;
      if (!p.rated) {
        v = prior;
        if (p.teamID === 1) unrated1++;
        else unrated2++;
      } else if (shrinkTau === null) {
        v = p.mu;
      } else {
        // Bayesian shrinkage toward the prior, weighted by rating confidence.
        const s = Number.isFinite(p.sigma) ? p.sigma : DEFAULT_SIGMA;
        const w = (shrinkTau * shrinkTau) / (shrinkTau * shrinkTau + s * s);
        v = w * p.mu + (1 - w) * prior;
      }
      acc[p.teamID][0] += v;
      acc[p.teamID][1] += 1;
      if (p.teamID === 1) n1++;
      else n2++;
    }
    const m1 = acc[1][1] ? acc[1][0] / acc[1][1] : prior;
    const m2 = acc[2][1] ? acc[2][0] / acc[2][1] : prior;
    return {
      meanMuDiff: m1 - m2,
      unratedShareDiff: (n1 ? unrated1 / n1 : 0) - (n2 ? unrated2 / n2 : 0)
    };
  });
}

console.log('  prior    logLoss(mu only)   held-out acc   ΔlogLik from unrated share   p');
let bestPrior = null;
const priorRows = [];
for (let prior = 18; prior <= 28.001; prior += 0.5) {
  const feats = teamMeansWith(prior);
  const X = feats.map((f) => [f.meanMuDiff]);
  const cv = crossValidate(X, y);
  const base = fitLogistic(X, y);
  const withU = fitLogistic(feats.map((f) => [f.meanMuDiff, f.unratedShareDiff]), y);
  const d = withU.ll - base.ll;
  const p = chiSqP(Math.max(0, 2 * d), 1);
  priorRows.push({ prior, logLoss: cv.logLoss, acc: cv.acc, d, p });
  if (!bestPrior || cv.logLoss < bestPrior.logLoss) bestPrior = priorRows[priorRows.length - 1];
}
const minD = Math.min(...priorRows.map((r) => r.d));
for (const r of priorRows) {
  const tag =
    Math.abs(r.prior - DEFAULT_MU) < 1e-9 ? '  ← current default'
      : r === bestPrior ? '  ← best log-loss'
        : Math.abs(r.d - minD) < 1e-9 ? '  ← unrated share least informative'
          : '';
  console.log(
    `  ${r.prior.toFixed(1).padStart(5)}    ${fmt(r.logLoss, 4).padStart(16)}   ` +
      `${`${fmt(r.acc * 100, 1)}%`.padStart(12)}   ${fmt(r.d, 2).padStart(26)}   ${pStr(r.p)}${tag}`
  );
}

/* ─── Part 4: is a constant the right shape at all? ────────────────────── */

/*
 * A single constant treats a player with three rounds identically to one with
 * three hundred, as long as both are "rated". Sigma already encodes that
 * difference and is already stored per round-player, so shrinkage toward the
 * prior costs nothing extra to compute:
 *
 *     w = tau^2 / (tau^2 + sigma^2);   effectiveMu = w*mu + (1-w)*prior
 *
 * tau -> infinity recovers raw mu (no shrinkage), tau -> 0 collapses everyone
 * to the prior. If the best tau is large, the constant is enough and shrinkage
 * is not worth the complexity.
 */
console.log('\n─── 4. Sigma-weighted shrinkage vs a flat prior ───\n');
const P = bestPrior.prior;
console.log(`  (holding the prior at its best value from part 3: ${P.toFixed(1)})\n`);
console.log('  tau        logLoss   held-out acc   vs flat prior');
const flat = crossValidate(teamMeansWith(P).map((f) => [f.meanMuDiff]), y);
console.log(
  `  ${'none (flat)'.padEnd(9)} ${fmt(flat.logLoss, 4).padStart(8)}   ` +
    `${`${fmt(flat.acc * 100, 1)}%`.padStart(12)}   —`
);
let bestTau = null;
for (const tau of [2, 3, 4, 5, 6, 8, 10, 15, 25, 50]) {
  const cv = crossValidate(teamMeansWith(P, tau).map((f) => [f.meanMuDiff]), y);
  if (!bestTau || cv.logLoss < bestTau.cv.logLoss) bestTau = { tau, cv };
  const delta = cv.logLoss - flat.logLoss;
  console.log(
    `  ${String(tau).padEnd(9)} ${fmt(cv.logLoss, 4).padStart(8)}   ` +
      `${`${fmt(cv.acc * 100, 1)}%`.padStart(12)}   ${delta < 0 ? '' : '+'}${fmt(delta, 4)}`
  );
}

/* ─── Verdict ──────────────────────────────────────────────────────────── */

console.log('\n─── Verdict ───\n');
const current = priorRows.find((r) => Math.abs(r.prior - DEFAULT_MU) < 1e-9);
console.log(`  current default (25.0):  logLoss ${fmt(current.logLoss, 4)}, unrated ΔlogLik ${fmt(current.d, 2)} (p ${pStr(current.p)})`);
console.log(`  best flat prior:         ${bestPrior.prior.toFixed(1)} — logLoss ${fmt(bestPrior.logLoss, 4)}, unrated ΔlogLik ${fmt(bestPrior.d, 2)} (p ${pStr(bestPrior.p)})`);
console.log(`  best shrinkage tau:      ${bestTau.tau} — logLoss ${fmt(bestTau.cv.logLoss, 4)}`);
console.log(
  `\n  improvement from re-priored mu alone: ${fmt(current.logLoss - bestPrior.logLoss, 4)} log-loss` +
    `\n  further improvement from shrinkage:   ${fmt(flat.logLoss - bestTau.cv.logLoss, 4)} log-loss`
);
console.log('');
