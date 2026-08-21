/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   IS THE UNRATED-SHARE RESIDUAL JUST σ IN DISGUISE?           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * §6 retracted direction 5's headline (unrated share, ΔlogLik 22.78 at ENDGAME)
 * as mostly reverse causation, but a residual survived at round start: ΔlogLik
 * 2.20 (p=0.036). The follow-on note in §5 flagged an unresolved question:
 * `sigmaBefore` is already recorded and already pre-round-clean, and TrueSkill's
 * own answer to "how much do I trust this rating" is sigma, not a binary
 * rated/unrated flag. Scoring every unrated player as flatly mu=25.0 is wrong
 * either way, but it was never checked whether sigma already explains the
 * residual — in which case no separate unrated-share correction is needed at
 * all — or whether unrated players are predictive beyond their sigma.
 *
 * Two questions, both on the LIVE (round-start) roster, the only timing that
 * matters per §6:
 *
 *   1. NESTED TEST: does unrated share still predict the winner once mean sigma
 *      is already in the model? And does sigma still predict once unrated share
 *      is already in? Whichever survives the other's presence is the real
 *      signal; whichever doesn't was riding on the other.
 *
 *   2. THE ACTIONABLE VERSION: TrueSkill's own answer to "conservative skill
 *      estimate" is mu - k*sigma, not mu with a side-channel confidence flag.
 *      Sweep k and see whether substituting a conservative team-mean for the
 *      scrambler's raw mu-mean beats raw mu outright, out of sample. If it
 *      does, that is a one-line change to the quantity already fed into
 *      scoreSwap() — no new control, no new plumbing beyond what sigmaBefore
 *      already provides.
 *
 *   node --max-old-space-size=4096 analysis/sigma-shrinkage-check.js
 */

import ClansService from '../s3/utils/clans-service.js';
import {
  newestExport,
  loadExport,
  table,
  isCompetitive,
  effectivePopulation,
  MIN_EFFECTIVE_PLAYERS,
  fmt,
  fitLogistic,
  crossValidate as cvShared,
  chiSqP,
  pStr
} from './load-export.js';

const DEFAULT_MU = 25.0;
const DEFAULT_SIGMA = 8.3333;
const TS_TOLERANCE_MS = 300_000;
const K_SWEEP = [0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];

const clans = new ClansService({ options: { enabled: true, minSize: 2 } });
const tagOf = (name) => {
  const raw = clans.extractRawPrefix(name);
  return raw ? clans.normalizeTag(raw) : null;
};

const exp = loadExport(newestExport());
const snapshots = table(exp, 'S3PlayerSnapshots');
const eloRounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');

console.log('\n═══ IS THE UNRATED-SHARE RESIDUAL JUST σ? ═══\n');

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

/* ─── Build one record per usable round, LIVE roster, per-player mu+sigma ── */

const paired = [];
const rejected = { noRound: 0, nonCompetitive: 0, undecided: 0, tooSmall: 0, badRoster: 0 };

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
  if (rd.winningTeamID !== 1 && rd.winningTeamID !== 2) {
    rejected.undecided++;
    continue;
  }
  if (effectivePopulation(byRoundId.get(rd.id) || []) < MIN_EFFECTIVE_PLAYERS) {
    rejected.tooSmall++;
    continue;
  }

  const rps = byRoundId.get(rd.id) || [];
  const muByEos = new Map();
  const sigByEos = new Map();
  for (const p of rps) {
    if (Number.isFinite(p.muBefore)) muByEos.set(p.eosID, p.muBefore);
    if (Number.isFinite(p.sigmaBefore)) sigByEos.set(p.eosID, p.sigmaBefore);
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
  if (onTeam.filter((p) => muByEos.has(p.eosID)).length / onTeam.length < 0.5) {
    rejected.badRoster++;
    continue;
  }

  const players = onTeam.map((p) => ({
    teamID: p.teamID,
    mu: muByEos.get(p.eosID) ?? DEFAULT_MU,
    sigma: sigByEos.get(p.eosID) ?? DEFAULT_SIGMA,
    rated: muByEos.has(p.eosID)
  }));

  paired.push({
    matchId,
    ts: rd.endedAt,
    t1Won: rd.winningTeamID === 1,
    players
  });
}
paired.sort((a, b) => a.ts - b.ts);

console.log(`  paired rounds (LIVE + rated outcome): ${paired.length}`);
console.log(
  `  rejected — no round ${rejected.noRound}, non-RAAS ${rejected.nonCompetitive}, ` +
    `undecided ${rejected.undecided}, small/thin ${rejected.tooSmall + rejected.badRoster}\n`
);

if (paired.length < 30) {
  console.log('Too few usable rounds to say anything. Stopping.\n');
  process.exit(0);
}

/* ─── 1. Nested test: unrated share vs mean sigma ──────────────────────── */

console.log('═══ 1. Nested test — does one survive the other\'s presence? ═══\n');

function teamAgg(players, teamID) {
  const ps = players.filter((p) => p.teamID === teamID);
  const n = ps.length || 1;
  return {
    meanMu: ps.reduce((s, p) => s + p.mu, 0) / n,
    meanSigma: ps.reduce((s, p) => s + p.sigma, 0) / n,
    unratedShare: ps.filter((p) => !p.rated).length / n
  };
}
for (const r of paired) {
  r.t1 = teamAgg(r.players, 1);
  r.t2 = teamAgg(r.players, 2);
  r.muDiff = r.t1.meanMu - r.t2.meanMu;
  r.sigmaDiff = r.t1.meanSigma - r.t2.meanSigma;
  r.unratedDiff = r.t1.unratedShare - r.t2.unratedShare;
}

const y = paired.map((r) => (r.t1Won ? 1 : 0));
const mMu = fitLogistic(paired.map((r) => [r.muDiff]), y);
const mMuSigma = fitLogistic(paired.map((r) => [r.muDiff, r.sigmaDiff]), y);
const mMuUnrated = fitLogistic(paired.map((r) => [r.muDiff, r.unratedDiff]), y);
const mFull = fitLogistic(paired.map((r) => [r.muDiff, r.sigmaDiff, r.unratedDiff]), y);

const dSigmaAlone = mMuSigma.ll - mMu.ll;
const dUnratedAlone = mMuUnrated.ll - mMu.ll;
const dUnratedOnSigma = mFull.ll - mMuSigma.ll;
const dSigmaOnUnrated = mFull.ll - mMuUnrated.ll;

console.log(`  mu alone                          logLik ${fmt(mMu.ll, 2)}   acc ${fmt(mMu.acc * 100, 1)}%`);
console.log(`  + sigma                           ΔlogLik ${fmt(dSigmaAlone, 2)}   p ${pStr(chiSqP(Math.max(0, 2 * dSigmaAlone), 1))}`);
console.log(`  + unrated share                   ΔlogLik ${fmt(dUnratedAlone, 2)}   p ${pStr(chiSqP(Math.max(0, 2 * dUnratedAlone), 1))}\n`);
console.log(`  + unrated share, ON TOP OF sigma   ΔlogLik ${fmt(dUnratedOnSigma, 2)}   p ${pStr(chiSqP(Math.max(0, 2 * dUnratedOnSigma), 1))}` +
  (chiSqP(Math.max(0, 2 * dUnratedOnSigma), 1) < 0.05 ? '  ← survives' : '  — absorbed by sigma'));
console.log(`  + sigma, ON TOP OF unrated share   ΔlogLik ${fmt(dSigmaOnUnrated, 2)}   p ${pStr(chiSqP(Math.max(0, 2 * dSigmaOnUnrated), 1))}` +
  (chiSqP(Math.max(0, 2 * dSigmaOnUnrated), 1) < 0.05 ? '  ← survives' : '  — absorbed by unrated share'));

/* ─── 2. The actionable version: conservative mu = mu - k*sigma ────────── */

console.log('\n═══ 2. Does a conservative team-mean (mu - k·sigma) beat raw mu? ═══\n');
console.log('  5-fold chronological CV, single feature = signed team-mean diff at each k\n');
console.log('  k       in-sample acc   CV logLoss   CV acc');

let bestK = 0;
let bestCvLogLoss = Infinity;
for (const k of K_SWEEP) {
  const X = paired.map((r) => {
    const c1 = r.players.filter((p) => p.teamID === 1);
    const c2 = r.players.filter((p) => p.teamID === 2);
    const cm1 = c1.reduce((s, p) => s + (p.mu - k * p.sigma), 0) / c1.length;
    const cm2 = c2.reduce((s, p) => s + (p.mu - k * p.sigma), 0) / c2.length;
    return [cm1 - cm2];
  });
  const m = fitLogistic(X, y);
  const cv = cvShared(X, y, 5);
  if (cv.logLoss < bestCvLogLoss) {
    bestCvLogLoss = cv.logLoss;
    bestK = k;
  }
  console.log(
    `  ${fmt(k, 2).padStart(4)}    ${`${fmt(m.acc * 100, 1)}%`.padStart(9)}        ${fmt(cv.logLoss, 4).padStart(8)}     ${fmt(cv.acc * 100, 1)}%` +
      (k === 0 ? '  (= raw mu, today\'s baseline)' : '')
  );
}
console.log(`\n  best out-of-sample k: ${fmt(bestK, 2)}  (CV logLoss ${fmt(bestCvLogLoss, 4)})`);

const k0X = paired.map((r) => [r.muDiff]);
const k0Cv = cvShared(k0X, y, 5);
console.log(`  raw mu (k=0) CV logLoss: ${fmt(k0Cv.logLoss, 4)}   improvement at best k: ${fmt(k0Cv.logLoss - bestCvLogLoss, 4)}`);

/* ─── 3. Verdict ─────────────────────────────────────────────────────────── */

console.log('\n═══ 3. Verdict ═══\n');
const unratedSurvives = chiSqP(Math.max(0, 2 * dUnratedOnSigma), 1) < 0.05;
if (!unratedSurvives) {
  console.log('  Unrated share adds nothing once mean sigma is already in the model.');
  console.log('  The residual from §6 was sigma wearing a binary disguise.');
} else {
  console.log('  Unrated share still predicts on top of sigma — it is not just generic');
  console.log('  rating uncertainty; genuine newcomers behave differently from established');
  console.log('  players with a merely uncertain rating.');
}
if (bestK > 0 && k0Cv.logLoss - bestCvLogLoss > 0.001) {
  console.log(`\n  A conservative team-mean (mu - ${fmt(bestK, 2)}·sigma) beats raw mu out of sample.`);
  console.log('  Recommendation: feed this quantity into scoreSwap() in place of raw mu-mean.');
  console.log('  That is a one-line substitution — sigmaBefore is already carried per player —');
  console.log('  and it folds the unrated-share correction into the same number without a');
  console.log('  separate control, config flag, or new column.');
} else {
  console.log('\n  No k beats raw mu by a margin worth acting on. Substituting a conservative');
  console.log('  mean would add a tuning knob for no measurable held-out benefit.');
}
console.log('');
