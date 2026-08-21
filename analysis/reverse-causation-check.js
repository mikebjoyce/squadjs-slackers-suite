/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   REVERSE CAUSATION CHECK — WAS THE STRUCTURE THERE FIRST?     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * squad-coordination.js measures every team feature on the ENDGAME roster and
 * predicts the outcome of the round that roster just finished. That is backwards
 * in principle: the ENDGAME roster is downstream of the result. People quit a
 * team that is being stomped and the server backfills with whoever is queuing,
 * so a "team feature" measured at the end can be a photograph of the loss rather
 * than a cause of it.
 *
 * That is not hypothetical here. Splitting the unrated players by whether Elo
 * has ever seen them shows 93.2% are established players who joined late, not
 * newcomers, and the losing side carries +1.21 more of them (z = 8.7) with a
 * clean dose-response against blowout size. "Unrated share" was being used as a
 * CONTROL in that script. It is substantially an outcome.
 *
 * So every conclusion needs re-testing on a roster captured before the result
 * exists. S3PlayerSnapshots has one: the LIVE trigger fires a median 3.0 minutes
 * after round start (p95 3.0), with a median roster of 96 against ENDGAME's 97.
 * That is the post-scramble, pre-outcome team — which is also exactly the team
 * the scrambler actually chose, and therefore the only roster a scrambler change
 * could ever act on.
 *
 * This script rebuilds the headline tests on LIVE rosters and prints them beside
 * the ENDGAME numbers on the SAME matches, so the difference is the measurement
 * timing and nothing else. Three outcomes are possible per feature:
 *
 *   survives at LIVE  — real, and actionable by the scrambler
 *   collapses at LIVE — was an artefact of who was standing there at the end
 *   only at LIVE      — was being masked by endgame churn
 *
 *   node --max-old-space-size=4096 analysis/reverse-causation-check.js
 */

import ClansService from '../s3/utils/clans-service.js';
import {
  newestExport,
  loadExport,
  table,
  describe,
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

const clans = new ClansService({ options: { enabled: true, minSize: 2 } });
const tagOf = (name) => {
  const raw = clans.extractRawPrefix(name);
  return raw ? clans.normalizeTag(raw) : null;
};

const exp = loadExport(newestExport());
const snapshots = table(exp, 'S3PlayerSnapshots');
const eloRounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');

console.log('\n═══ REVERSE CAUSATION CHECK ═══\n');

/* ─── House clan, same empirical rule as squad-coordination.js ─────────── */

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

/* ─── Joins ────────────────────────────────────────────────────────────── */

const byRoundId = new Map();
for (const p of roundPlayers) {
  if (!byRoundId.has(p.roundHistoryId)) byRoundId.set(p.roundHistoryId, []);
  byRoundId.get(p.roundHistoryId).push(p);
}
/* Every eosID Elo has ever scored, in any round — lets an "unrated" player in
 * one round be identified as a regular who simply joined that round late. */
const everRated = new Set(roundPlayers.map((p) => p.eosID));

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

/* ─── Pick one snapshot per (match, trigger) ───────────────────────────── */

/* LIVE keeps the EARLIEST — closest to round start, least contaminated.
 * ENDGAME keeps the LATEST, matching squad-coordination.js exactly. */
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
const endByMatch = pickByMatch('ENDGAME', 'latest');

/* ─── Feature construction, identical for either roster ────────────────── */

function buildFeatures(snap, rd) {
  const rps = byRoundId.get(rd.id) || [];
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
    return null;
  }
  const onTeam = roster.filter((p) => p.teamID === 1 || p.teamID === 2);
  if (onTeam.length < MIN_EFFECTIVE_PLAYERS) return null;
  if (onTeam.filter((p) => muByEos.has(p.eosID)).length / onTeam.length < 0.5) return null;

  const squadSize = new Map();
  const blockSize = new Map();
  const squadClan = new Map();
  for (const p of onTeam) {
    if (p.squadID != null) {
      const k = `${p.teamID}-${p.squadID}`;
      squadSize.set(k, (squadSize.get(k) || 0) + 1);
    }
    const t = tagOf(p.name);
    if (!t) continue;
    const bk = `${p.teamID}|${t}`;
    blockSize.set(bk, (blockSize.get(bk) || 0) + 1);
    if (p.squadID != null) {
      const sk = `${p.teamID}-${p.squadID}|${t}`;
      squadClan.set(sk, (squadClan.get(sk) || 0) + 1);
    }
  }

  const players = onTeam.map((p) => {
    const sk = p.squadID == null ? null : `${p.teamID}-${p.squadID}`;
    const t = tagOf(p.name);
    const bk = t ? `${p.teamID}|${t}` : null;
    const size = bk ? blockSize.get(bk) : 1;
    const sqClan = t && sk ? squadClan.get(`${sk}|${t}`) ?? 1 : 1;
    const isHouse = t === HOUSE;
    return {
      eosID: p.eosID,
      teamID: p.teamID,
      mu: muByEos.get(p.eosID) ?? DEFAULT_MU,
      sigma: sigByEos.get(p.eosID) ?? DEFAULT_SIGMA,
      rated: muByEos.has(p.eosID),
      everRated: everRated.has(p.eosID),
      squadSize: sk ? squadSize.get(sk) : 1,
      blockAll: size,
      blockExHouse: isHouse ? 1 : size,
      blockHouse: isHouse ? size : 0,
      squadClanExHouse: isHouse ? 1 : sqClan,
      squadClanHouse: isHouse ? sqClan : 0
    };
  });
  return players;
}

function teamStats(players, teamID) {
  const ps = players.filter((p) => p.teamID === teamID);
  const n = ps.length || 1;
  const meanMu = ps.reduce((s, p) => s + p.mu, 0) / n;
  return {
    n,
    meanMu,
    meanSigma: ps.reduce((s, p) => s + p.sigma, 0) / n,
    unratedShare: ps.filter((p) => !p.rated).length / n,
    /* Unrated AND never seen by Elo in any round — the genuine newcomers, the
     * only population a newcomer prior could ever apply to. */
    newcomerShare: ps.filter((p) => !p.rated && !p.everRated).length / n,
    meanSquadSize: ps.reduce((s, p) => s + p.squadSize, 0) / n,
    inBigSquad: ps.filter((p) => p.squadSize >= 6).length,
    clanAll: ps.filter((p) => p.blockAll >= 3).length,
    clanExHouse: ps.filter((p) => p.blockExHouse >= 3).length,
    houseCount: ps.filter((p) => p.blockHouse > 0).length,
    maxBlockExHouse: ps.reduce((m, p) => Math.max(m, p.blockExHouse), 1),
    sqClanExHouse: ps.filter((p) => p.squadClanExHouse >= 4).length,
    sqClanHouse: ps.filter((p) => p.squadClanHouse >= 4).length,
    maxSqClanHouse: ps.reduce((m, p) => Math.max(m, p.squadClanHouse), 0),
    concClanMu: ps.reduce((s, p) => s + (p.blockAll >= 3 ? p.mu - meanMu : 0), 0)
  };
}

/* ─── Paired sample: matches that have BOTH rosters and a rated outcome ── */

const paired = [];
const rejected = { noLive: 0, noRound: 0, nonCompetitive: 0, undecided: 0, tooSmall: 0, badRoster: 0 };

for (const [matchId, endSnap] of endByMatch) {
  const liveSnap = liveByMatch.get(matchId);
  if (!liveSnap) {
    rejected.noLive++;
    continue;
  }
  const rd = roundForSnapshot(endSnap);
  if (!rd) {
    rejected.noRound++;
    continue;
  }
  if (!isCompetitive(rd.layerName)) {
    rejected.nonCompetitive++;
    continue;
  }
  if (!rd.winningTeamID) {
    rejected.undecided++;
    continue;
  }
  if (effectivePopulation(byRoundId.get(rd.id) || []) < MIN_EFFECTIVE_PLAYERS) {
    rejected.tooSmall++;
    continue;
  }
  const livePlayers = buildFeatures(liveSnap, rd);
  const endPlayers = buildFeatures(endSnap, rd);
  if (!livePlayers || !endPlayers) {
    rejected.badRoster++;
    continue;
  }
  paired.push({
    matchId,
    ts: Number.isFinite(rd.endedAt) ? rd.endedAt : endSnap.ts,
    t1Won: rd.winningTeamID === 1,
    ticketDiff: Math.abs(rd.ticketDiff),
    live: { players: livePlayers, t1: teamStats(livePlayers, 1), t2: teamStats(livePlayers, 2) },
    end: { players: endPlayers, t1: teamStats(endPlayers, 1), t2: teamStats(endPlayers, 2) }
  });
}
/* Chronological, so the CV folds below are contiguous blocks of real time rather
 * than an arbitrary Map iteration order. */
paired.sort((a, b) => a.ts - b.ts);
for (const r of paired) {
  r.live.meanMuDiff = r.live.t1.meanMu - r.live.t2.meanMu;
  r.end.meanMuDiff = r.end.t1.meanMu - r.end.t2.meanMu;
}

console.log(`  paired rounds (LIVE + ENDGAME + rated outcome): ${paired.length}`);
console.log(
  `  rejected — no LIVE ${rejected.noLive}, no Elo round ${rejected.noRound}, ` +
    `non-RAAS ${rejected.nonCompetitive}, undecided ${rejected.undecided}, ` +
    `small ${rejected.tooSmall}, thin roster ${rejected.badRoster}\n`
);

/* ─── 1. How much does the roster actually turn over? ──────────────────── */

console.log('─── 1. Roster churn between round start and round end ───\n');
console.log('  If losing teams shed players, the churn gap should widen with the margin.\n');
console.log('  ticket margin   rounds   winner keeps   loser keeps   gap');

const CHURN_BANDS = [
  ['0-50', 0, 50], ['50-100', 50, 100], ['100-150', 100, 150],
  ['150-250', 150, 250], ['250+', 250, 1e9]
];
function keepRate(r, teamID, side) {
  const startIds = new Set(r.live.players.filter((p) => p.teamID === teamID).map((p) => p.eosID));
  const endIds = new Set(r.end.players.filter((p) => p.teamID === teamID).map((p) => p.eosID));
  if (!startIds.size) return null;
  let kept = 0;
  for (const id of startIds) if (endIds.has(id)) kept++;
  return kept / startIds.size;
}
for (const [lab, lo, hi] of CHURN_BANDS) {
  const sel = paired.filter((r) => r.ticketDiff >= lo && r.ticketDiff < hi);
  if (!sel.length) continue;
  const win = [];
  const lose = [];
  for (const r of sel) {
    const kw = keepRate(r, r.t1Won ? 1 : 2);
    const kl = keepRate(r, r.t1Won ? 2 : 1);
    if (kw != null) win.push(kw);
    if (kl != null) lose.push(kl);
  }
  const w = describe(win);
  const l = describe(lose);
  console.log(
    `  ${lab.padEnd(14)} ${String(sel.length).padStart(6)}   ` +
      `${`${fmt(w.mean * 100, 1)}%`.padStart(12)}   ${`${fmt(l.mean * 100, 1)}%`.padStart(11)}   ` +
      `${fmt((w.mean - l.mean) * 100, 1).padStart(5)}pp`
  );
}

/* ─── 2. The unrated-share confound, at both timings ───────────────────── */

console.log('\n─── 2. Unrated share: predictor or symptom? ───\n');
function unratedTowardLoser(key) {
  const vals = paired.map((r) => {
    const s = r[key];
    const u1 = s.t1.unratedShare * s.t1.n;
    const u2 = s.t2.unratedShare * s.t2.n;
    return r.t1Won ? u2 - u1 : u1 - u2;
  });
  return describe(vals);
}
for (const key of ['live', 'end']) {
  const d = unratedTowardLoser(key);
  const se = d.sd / Math.sqrt(d.n);
  const label = key === 'live' ? 'at round start (LIVE)' : 'at round end (ENDGAME)';
  console.log(
    `  ${label.padEnd(24)} losing side carries ${fmt(d.mean, 3).padStart(6)} more unrated ` +
      `(z = ${fmt(d.mean / se, 2)})`
  );
}
const newc = paired.flatMap((r) => r.live.players.filter((p) => !p.rated && !p.everRated));
const lateJoin = paired.flatMap((r) => r.live.players.filter((p) => !p.rated && p.everRated));
console.log(
  `\n  at round start, unrated players are ${newc.length} genuine newcomers vs ` +
    `${lateJoin.length} known regulars`
);
console.log(
  `  (${fmt((newc.length / Math.max(1, newc.length + lateJoin.length)) * 100, 1)}% genuine — ` +
    'compare the endgame roster, where it is 6.8%)'
);

/* ─── 3. Do squads even exist yet at LIVE? ─────────────────────────────── */

console.log('\n─── 3. Is structure already formed 3 minutes in? ───\n');
for (const key of ['live', 'end']) {
  const sq = paired.flatMap((r) => r[key].players.map((p) => p.squadSize));
  const big = sq.filter((s) => s >= 6).length / sq.length;
  const solo = sq.filter((s) => s === 1).length / sq.length;
  const blocks = paired.flatMap((r) => [r[key].t1.maxBlockExHouse, r[key].t2.maxBlockExHouse]);
  const d = describe(sq);
  const b = describe(blocks);
  console.log(
    `  ${(key === 'live' ? 'LIVE' : 'ENDGAME').padEnd(8)} mean squad ${fmt(d.mean, 2)}, ` +
      `unassigned ${fmt(solo * 100, 1)}%, in squads>=6 ${fmt(big * 100, 1)}%, ` +
      `mean largest clan block ${fmt(b.mean, 2)}`
  );
}

/* ─── 4. The headline tests, side by side ──────────────────────────────── */

const y = paired.map((r) => (r.t1Won ? 1 : 0));

const CONTROLS = [
  ['unrated share', (s) => s.t1.unratedShare - s.t2.unratedShare],
  ['mean sigma', (s) => s.t1.meanSigma - s.t2.meanSigma]
];
const STRUCTURE = [
  ['players in squads >=6', (s) => s.t1.inBigSquad - s.t2.inBigSquad],
  ['mean squad size', (s) => s.t1.meanSquadSize - s.t2.meanSquadSize],
  ['clan-blocked >=3 (all clans)', (s) => s.t1.clanAll - s.t2.clanAll],
  [`clan-blocked >=3, no ${HOUSE}`, (s) => s.t1.clanExHouse - s.t2.clanExHouse],
  [`largest clan block, no ${HOUSE}`, (s) => s.t1.maxBlockExHouse - s.t2.maxBlockExHouse],
  [`${HOUSE} headcount on team`, (s) => s.t1.houseCount - s.t2.houseCount],
  ['mu concentrated in clan blocks', (s) => s.t1.concClanMu - s.t2.concClanMu],
  [`squad-clan >=4, no ${HOUSE}`, (s) => s.t1.sqClanExHouse - s.t2.sqClanExHouse],
  [`squad-clan >=4, ${HOUSE} only`, (s) => s.t1.sqClanHouse - s.t2.sqClanHouse],
  [`largest ${HOUSE} squad-stack`, (s) => s.t1.maxSqClanHouse - s.t2.maxSqClanHouse]
];

function suite(key) {
  const baseX = paired.map((r) => [r[key].meanMuDiff]);
  const base = fitLogistic(baseX, y);
  const ctrlX = paired.map((r) => [r[key].meanMuDiff, ...CONTROLS.map(([, f]) => f(r[key]))]);
  const ctrl = fitLogistic(ctrlX, y);
  const out = { base, ctrl, plain: new Map(), onCtrl: new Map() };
  for (const [name, fn] of CONTROLS) {
    const X = paired.map((r) => [r[key].meanMuDiff, fn(r[key])]);
    const m = fitLogistic(X, y);
    out.plain.set(name, { d: m.ll - base.ll, p: chiSqP(Math.max(0, 2 * (m.ll - base.ll)), 1) });
  }
  for (const [name, fn] of STRUCTURE) {
    const X1 = paired.map((r) => [r[key].meanMuDiff, fn(r[key])]);
    const m1 = fitLogistic(X1, y);
    out.plain.set(name, { d: m1.ll - base.ll, p: chiSqP(Math.max(0, 2 * (m1.ll - base.ll)), 1) });
    const X2 = paired.map((r) => [
      r[key].meanMuDiff,
      ...CONTROLS.map(([, f]) => f(r[key])),
      fn(r[key])
    ]);
    const m2 = fitLogistic(X2, y);
    out.onCtrl.set(name, { d: m2.ll - ctrl.ll, p: chiSqP(Math.max(0, 2 * (m2.ll - ctrl.ll)), 1) });
  }
  return out;
}
const L = suite('live');
const E = suite('end');

console.log('\n─── 4. Same features, measured at round start vs round end ───\n');
console.log(`  baseline (mean mu diff alone)   LIVE acc ${fmt(L.base.acc * 100, 1)}%  logLik ${fmt(L.base.ll, 1)}`);
console.log(`                                  END  acc ${fmt(E.base.acc * 100, 1)}%  logLik ${fmt(E.base.ll, 1)}\n`);
console.log('  A. added to mean-mu-diff alone       LIVE dLL   p        END dLL   p');
for (const [name] of [...CONTROLS, ...STRUCTURE]) {
  const l = L.plain.get(name);
  const e = E.plain.get(name);
  const mark = l.p < 0.05 ? ' ←' : '  ';
  console.log(
    `  ${name.padEnd(35)} ${fmt(l.d, 2).padStart(7)}  ${pStr(l.p).padEnd(8)} ` +
      `${fmt(e.d, 2).padStart(7)}  ${pStr(e.p).padEnd(8)}${mark}`
  );
}
console.log('\n  B. added on top of both controls     LIVE dLL   p        END dLL   p');
for (const [name] of STRUCTURE) {
  const l = L.onCtrl.get(name);
  const e = E.onCtrl.get(name);
  const mark = l.p < 0.05 ? ' ←' : '  ';
  console.log(
    `  ${name.padEnd(35)} ${fmt(l.d, 2).padStart(7)}  ${pStr(l.p).padEnd(8)} ` +
      `${fmt(e.d, 2).padStart(7)}  ${pStr(e.p).padEnd(8)}${mark}`
  );
}
console.log('\n  ← marks features that hold up at LIVE, the only timing the scrambler can act on.');

/* ─── 5. Effect size, LIVE only ────────────────────────────────────────── */

/*
 * Only the LIVE numbers are quotable as a scrambler offset. Sigma stays as a
 * control because sigmaBefore is genuinely pre-round; unrated share is dropped,
 * because at LIVE it is nearly all genuine newcomers and carrying an outcome
 * proxy into the coefficient is what caused this re-test in the first place.
 */
console.log('\n─── 5. LIVE effect sizes, in mu of team strength ───\n');
const teamN = paired.reduce((s, r) => s + r.live.t1.n, 0) / paired.length;
const SIGMA_ONLY = [['mean sigma', (s) => s.t1.meanSigma - s.t2.meanSigma]];
for (const [name, fn] of STRUCTURE) {
  const X = paired.map((r) => [
    r.live.meanMuDiff,
    ...SIGMA_ONLY.map(([, f]) => f(r.live)),
    fn(r.live)
  ]);
  const m = fitLogistic(X, y);
  const wMu = m.wRaw[0];
  const wF = m.wRaw[2];
  if (Math.abs(wMu) < 1e-9) continue;
  const perMean = wF / wMu;
  const sig = L.onCtrl.get(name).p < 0.05;
  console.log(
    `  ${name.padEnd(33)} 1 unit = ${fmt(perMean * teamN, 2).padStart(7)} mu of team strength` +
      `${sig ? '  ←' : ''}`
  );
}
console.log(`\n  (team size averages ${fmt(teamN, 1)} players at round start)`);

/* ─── 6. Held-out performance at LIVE ──────────────────────────────────── */

/*
 * The LRTs above are in-sample. §5 reported five-fold CV survival for the clan
 * term, but that was measured at ENDGAME — the wrong timing. This is the number
 * that should actually decide whether a scorer change ships.
 *
 * Folds are contiguous chronological blocks, not random: the population drifts
 * (clans arrive and leave, the roster turns over), so random folds would let a
 * clan's good months predict its bad ones and overstate everything.
 *
 * sigma stays as the control. unratedShare is deliberately NOT carried here —
 * sections 1-4 established it is largely an outcome, and conditioning on it is
 * over-control.
 */
console.log('\n─── 6. Five-fold CV, contiguous chronological folds, LIVE rosters ───\n');
const cvBaseX = paired.map((r) => [r.live.meanMuDiff]);
const cvCtrlX = paired.map((r) => [r.live.meanMuDiff, r.live.t1.meanSigma - r.live.t2.meanSigma]);
const cvBase = cvShared(cvBaseX, y, 5);
const cvCtrl = cvShared(cvCtrlX, y, 5);
console.log(`  mu only                             logLoss ${fmt(cvBase.logLoss, 4)}   acc ${fmt(cvBase.acc * 100, 1)}%`);
console.log(
  `  mu + sigma                          logLoss ${fmt(cvCtrl.logLoss, 4)}   acc ${fmt(cvCtrl.acc * 100, 1)}%` +
    `   (${fmt(cvBase.logLoss - cvCtrl.logLoss, 4)} vs mu only)\n`
);
console.log('  + structure feature                 logLoss     acc      vs mu+sigma');
for (const [name, fn] of STRUCTURE) {
  const X = paired.map((r) => [
    r.live.meanMuDiff,
    r.live.t1.meanSigma - r.live.t2.meanSigma,
    fn(r.live)
  ]);
  const cv = cvShared(X, y, 5);
  const gain = cvCtrl.logLoss - cv.logLoss;
  console.log(
    `  ${name.padEnd(33)} ${fmt(cv.logLoss, 4).padStart(8)}   ${`${fmt(cv.acc * 100, 1)}%`.padStart(6)}   ` +
      `${`${gain >= 0 ? '+' : ''}${fmt(gain, 4)}`.padStart(11)}${gain > 0 ? '  ← generalises' : ''}`
  );
}
console.log(
  '\n  A positive gain means the feature helps on rounds the model never saw.\n' +
    '  In-sample LRT significance with a negative gain here is overfitting.'
);
console.log('');
