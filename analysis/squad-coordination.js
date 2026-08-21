/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   SQUAD COORDINATION — IS TEAM STRENGTH MORE THAN SUM OF MU?   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * tb-scrambler.js scores candidates by summing mu and comparing team means. It
 * keeps squads intact as atoms but is entirely indifferent to how talent is
 * distributed across them: nine strong players in one organised squad and nine
 * strong players scattered across nine squads score identically.
 *
 * TrueSkill2 (Minka, Cleven & Zaykov 2018, docs/trueskill2.pdf section 6) tests
 * exactly this assumption on Halo 5 and falsifies it — solo players are
 * perfectly calibrated, but 10-player premades win 89% of the time where the
 * model predicts 67%. Their fix is an additive `squadOffset(size)` on skill.
 *
 * Their "squad" is a premade party that queued together. Squad's in-game squad
 * is an organisational unit that may be strangers. Those are different things,
 * so both are measured separately here:
 *
 *   - in-game squad  — what the scrambler already treats as atomic
 *   - clan block     — same-tag players on the same team, the closer analogue
 *                      to TrueSkill2's premade (uses the real S3 ClansService
 *                      extractor, not a copy, so it cannot drift)
 *
 * ─── TWO DIFFERENT USES OF A CLAN TAG ────────────────────────────
 *
 * These must not be conflated, and the house clan is treated oppositely by each:
 *
 *   COHESION — "keep this clan together when scrambling". The house clan is
 *     excluded in production, correctly: it has hundreds of members, so keeping
 *     them together would produce exactly the stacking the balancer exists to
 *     prevent.
 *
 *   BALANCE WEIGHTING — "this group is worth more than the sum of its mu".
 *     Here the house clan absolutely should count. Fifteen of them coordinating
 *     on one side is real strength whether or not the balancer chose to group
 *     them, and if that strength is invisible to the scorer the scrambler will
 *     happily hand it to one team.
 *
 * So every clan result is reported three ways — all clans, house excluded,
 * house only. House-excluded informs cohesion; all-clans informs the offset.
 *
 * ─── WHAT WOULD COUNT AS A FINDING ───────────────────────────────
 *
 * Not "big groups win more" — strong players cluster, so that is expected and
 * is already priced in by mu. The claim under test is that grouping predicts
 * outcomes BEYOND mu. Two ways of asking:
 *
 *   A. calibration — bucket players by group size, compare actual win rate to
 *      the win rate a mu-only model predicts for them (the TrueSkill2 table).
 *   B. nested models — does a team-level structure feature add likelihood over
 *      mean-mu-diff alone, by likelihood-ratio test?
 *
 * ─── TWO WAYS THIS COULD LIE ─────────────────────────────────────
 *
 *   1. RATING CONFIDENCE. Clan members are regulars with well-estimated mu.
 *      Transients are unrated and default to mu=25.0 — the model treats them as
 *      exactly average. If they are in fact below average, then any team full of
 *      transients is over-rated by the model, and its clan-heavy opponent looks
 *      like it "beat its rating" without coordinating at all. Controlled by
 *      carrying unrated-share and mean sigmaBefore as competing features, and
 *      by re-testing every structure feature on top of those controls.
 *
 *   2. DOUBLE-COUNTED ROUNDS. 1099 ENDGAME snapshots cover only 708 distinct
 *      matches. Deduplicated by matchId, keeping the latest.
 *
 *   node --max-old-space-size=4096 analysis/squad-coordination.js
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

console.log('\n═══ SQUAD COORDINATION ═══\n');

/* ─── Identify the house clan empirically ──────────────────────────────── */

/* Not hardcoded: whichever tag dominates the server gets split out, so this
 * still does the right thing if the community changes hands. */
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
const ranked = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
const HOUSE = ranked[0][0];
console.log(
  `  house clan: ${HOUSE} — ${ranked[0][1]} player-rounds, ` +
    `${fmt(ranked[0][1] / ranked[1][1], 1)}x the next (${ranked[1][0]}, ${ranked[1][1]})`
);
console.log(`  distinct tags extracted: ${tagCounts.size}\n`);

/* ─── Join snapshots to their round ────────────────────────────────────── */

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

/* ─── Deduplicate ENDGAME snapshots ────────────────────────────────────── */

const latestByMatch = new Map();
for (const s of snapshots) {
  if (s.trigger !== 'ENDGAME') continue;
  const prev = latestByMatch.get(s.matchId);
  if (!prev || s.ts > prev.ts) latestByMatch.set(s.matchId, s);
}

/* ─── Build per-round structure ────────────────────────────────────────── */

const rejected = { noRound: 0, nonCompetitive: 0, undecided: 0, tooSmall: 0, thinRatings: 0 };
const rounds = [];

for (const snap of latestByMatch.values()) {
  const rd = roundForSnapshot(snap);
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
  const rps = byRoundId.get(rd.id) || [];
  if (effectivePopulation(rps) < MIN_EFFECTIVE_PLAYERS) {
    rejected.tooSmall++;
    continue;
  }

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
  if (onTeam.length < MIN_EFFECTIVE_PLAYERS) {
    rejected.tooSmall++;
    continue;
  }
  const ratedCount = onTeam.filter((p) => muByEos.has(p.eosID)).length;
  if (ratedCount / onTeam.length < 0.5) {
    rejected.thinRatings++;
    continue;
  }

  /* Squad sizes. Unassigned players count as a group of 1, which is what they
   * are organisationally — a lone wolf, TrueSkill2's calibrated baseline. */
  const squadSize = new Map();
  for (const p of onTeam) {
    if (p.squadID == null) continue;
    const k = `${p.teamID}-${p.squadID}`;
    squadSize.set(k, (squadSize.get(k) || 0) + 1);
  }

  /* Clan blocks: same normalised tag, same team. Size 1 is not a block. */
  const blockSize = new Map();
  for (const p of onTeam) {
    const t = tagOf(p.name);
    if (!t) continue;
    const k = `${p.teamID}|${t}`;
    blockSize.set(k, (blockSize.get(k) || 0) + 1);
  }

  /* Clan members sharing a SQUAD, which is not the same measurement as clan
   * members sharing a team. For a 6-person clan the two coincide — if they are
   * on the team at all they are in one squad. For a clan with dozens of members
   * online they diverge completely: 12 of them on a team might be one 9-stack
   * plus stragglers, or twelve people in eleven different squads full of
   * strangers. Only the first is a coordination unit, and the team-level
   * measurement averages straight over the difference. */
  const squadClan = new Map();
  for (const p of onTeam) {
    const t = tagOf(p.name);
    if (!t || p.squadID == null) continue;
    const k = `${p.teamID}-${p.squadID}|${t}`;
    squadClan.set(k, (squadClan.get(k) || 0) + 1);
  }

  const players = onTeam.map((p) => {
    const sk = p.squadID == null ? null : `${p.teamID}-${p.squadID}`;
    const t = tagOf(p.name);
    const bk = t ? `${p.teamID}|${t}` : null;
    const size = bk ? blockSize.get(bk) : 1;
    const sqClan = t && sk ? squadClan.get(`${sk}|${t}`) ?? 1 : 1;
    const isHouse = t === HOUSE;
    return {
      teamID: p.teamID,
      tag: t,
      mu: muByEos.get(p.eosID) ?? DEFAULT_MU,
      sigma: sigByEos.get(p.eosID) ?? DEFAULT_SIGMA,
      rated: muByEos.has(p.eosID),
      squadSize: sk ? squadSize.get(sk) : 1,
      /* All three views, because cohesion and balance weighting want different
       * ones (see the header). */
      blockAll: size,
      blockExHouse: isHouse ? 1 : size,
      blockHouse: isHouse ? size : 0,
      /* Same three views at squad granularity. */
      squadClanAll: sqClan,
      squadClanExHouse: isHouse ? 1 : sqClan,
      squadClanHouse: isHouse ? sqClan : 0
    };
  });

  rounds.push({
    id: rd.id,
    t1Won: rd.winningTeamID === 1,
    ticketDiff: Math.abs(rd.ticketDiff),
    players
  });
}

console.log(`  distinct ENDGAME matches: ${latestByMatch.size}`);
console.log(`  usable rounds (structure + rated outcome): ${rounds.length}`);
console.log(
  `  rejected — no Elo round ${rejected.noRound}, non-RAAS ${rejected.nonCompetitive}, ` +
    `undecided ${rejected.undecided}, small ${rejected.tooSmall}, thin ratings ${rejected.thinRatings}`
);
console.log(
  '  (the no-Elo-round rejections are mostly a genuine gap, not a broken join:\n' +
    '   Elo recorded nothing 2026-07-03..08 and rates only 80+ RAAS rounds,\n' +
    '   while ENDGAME snapshots are written for every round.)\n'
);

/* ─── Team-level features ──────────────────────────────────────────────── */

function teamStats(players, teamID) {
  const ps = players.filter((p) => p.teamID === teamID);
  const n = ps.length || 1;
  const meanMu = ps.reduce((s, p) => s + p.mu, 0) / n;
  const meanSigma = ps.reduce((s, p) => s + p.sigma, 0) / n;
  const unratedShare = ps.filter((p) => !p.rated).length / n;
  const meanSquadSize = ps.reduce((s, p) => s + p.squadSize, 0) / n;
  const inBigSquad = ps.filter((p) => p.squadSize >= 6).length;
  const clanAll = ps.filter((p) => p.blockAll >= 3).length;
  const clanExHouse = ps.filter((p) => p.blockExHouse >= 3).length;
  const houseCount = ps.filter((p) => p.blockHouse > 0).length;
  const maxBlockExHouse = ps.reduce((m, p) => Math.max(m, p.blockExHouse), 1);
  /* Squad-level clan concentration: players sitting in a squad with 4+ of their
   * own clanmates, which is the coordination unit the team-level count blurs. */
  const sqClanExHouse = ps.filter((p) => p.squadClanExHouse >= 4).length;
  const sqClanHouse = ps.filter((p) => p.squadClanHouse >= 4).length;
  const maxSqClanHouse = ps.reduce((m, p) => Math.max(m, p.squadClanHouse), 0);
  const maxSqClanExHouse = ps.reduce((m, p) => Math.max(m, p.squadClanExHouse), 1);
  /* Talent concentration: mu carried by players sitting in large groups, above
   * the team's own baseline. Positive when the strong players are the grouped
   * ones, near zero when talent is spread evenly across group sizes. */
  const concSquadMu = ps.reduce((s, p) => s + (p.squadSize >= 6 ? p.mu - meanMu : 0), 0);
  const concClanMu = ps.reduce((s, p) => s + (p.blockAll >= 3 ? p.mu - meanMu : 0), 0);
  return {
    n, meanMu, meanSigma, unratedShare, meanSquadSize, inBigSquad,
    clanAll, clanExHouse, houseCount, maxBlockExHouse, concSquadMu, concClanMu,
    sqClanExHouse, sqClanHouse, maxSqClanHouse, maxSqClanExHouse
  };
}

for (const r of rounds) {
  r.t1 = teamStats(r.players, 1);
  r.t2 = teamStats(r.players, 2);
  r.meanMuDiff = r.t1.meanMu - r.t2.meanMu;
}


const y = rounds.map((r) => (r.t1Won ? 1 : 0));
const baseX = rounds.map((r) => [r.meanMuDiff]);
const base = fitLogistic(baseX, y);
const basePred = baseX.map((row) => base.predict(row));

console.log('─── Baseline: mean mu difference alone ───\n');
console.log(`  n = ${rounds.length}   accuracy ${fmt(base.acc * 100, 1)}%   logLik ${fmt(base.ll, 1)}\n`);

/* ─── A. The TrueSkill2 calibration table ──────────────────────────────── */

/*
 * For every player: did their team win, and what did the mu-only model give
 * their team? Bucketed by group size, a gap between the two columns is
 * coordination value that mu cannot see. Solo players are the control — they
 * should be calibrated, exactly as in the paper.
 */
function calibrationTable(sizeKey, label, buckets) {
  console.log(`─── A. Win rate by ${label}, actual vs mu-predicted ───\n`);
  console.log(`  ${label.padEnd(22)} players   actual   predicted     gap    +-2SE   rnds`);
  for (const [blabel, lo, hi] of buckets) {
    let nP = 0;
    let won = 0;
    let pred = 0;
    let roundsSeen = 0;
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      let inThis = 0;
      for (const p of r.players) {
        const sz = p[sizeKey];
        if (sz < lo || sz > hi) continue;
        inThis++;
        nP++;
        const teamWon = p.teamID === 1 ? r.t1Won : !r.t1Won;
        if (teamWon) won++;
        pred += p.teamID === 1 ? basePred[i] : 1 - basePred[i];
      }
      if (inThis > 0) roundsSeen++;
    }
    if (nP === 0) continue;
    const a = won / nP;
    const e = pred / nP;
    const gap = a - e;
    /* Player-rounds inside one round share an outcome, so they are nowhere near
     * independent. The honest sample size is the number of ROUNDS contributing
     * to the bucket, not the number of player-rounds — using nP here would
     * overstate precision by roughly sqrt(players per round). */
    const se = Math.sqrt((a * (1 - a)) / Math.max(1, roundsSeen));
    /* A bucket drawn from a handful of rounds can report 100% with a zero SE,
     * which is an artefact of the binomial and not a finding. Below MIN_ROUNDS
     * the row is printed for completeness but never flagged. */
    const MIN_ROUNDS = 10;
    const thin = roundsSeen < MIN_ROUNDS;
    console.log(
      `  ${blabel.padEnd(22)} ${String(nP).padStart(7)}   ` +
        `${`${fmt(a * 100, 1)}%`.padStart(6)}   ${`${fmt(e * 100, 1)}%`.padStart(9)}   ` +
        `${`${gap >= 0 ? '+' : ''}${fmt(gap * 100, 1)}`.padStart(6)}   ` +
        `${fmt(2 * se * 100, 1).padStart(5)}   ${String(roundsSeen).padStart(4)}` +
        `${thin ? '  (too few rounds)' : Math.abs(gap) > 2 * se ? '  ←' : ''}`
    );
  }
  console.log('');
}

const SQUAD_BUCKETS = [
  ['1 (unassigned)', 1, 1], ['2', 2, 2], ['3', 3, 3], ['4–5', 4, 5],
  ['6–7', 6, 7], ['8', 8, 8], ['9', 9, 9], ['10+', 10, 99]
];
const CLAN_BUCKETS = [
  ['1 (none/solo)', 1, 1], ['2', 2, 2], ['3', 3, 3], ['4–5', 4, 5],
  ['6–8', 6, 8], ['9+', 9, 99]
];

calibrationTable('squadSize', 'in-game squad size', SQUAD_BUCKETS);
calibrationTable('blockExHouse', `clan block, no ${HOUSE}`, CLAN_BUCKETS);
calibrationTable('blockHouse', `${HOUSE} on team`, [
  ['2–5', 2, 5], ['6–8', 6, 8], ['9–12', 9, 12], ['13–16', 13, 16], ['17+', 17, 99]
]);

/*
 * The decisive pair. "N clanmates on my team" and "N clanmates in my squad" are
 * the same thing for a small clan and completely different for a large one. If
 * coordination is what drives the effect, the squad-level view should be the
 * stronger of the two — and the house clan, which is the only clan big enough
 * for the two to diverge, should stop looking irrelevant.
 */
calibrationTable('squadClanExHouse', `clanmates in squad, no ${HOUSE}`, CLAN_BUCKETS);
calibrationTable('squadClanHouse', `${HOUSE} in same squad`, [
  ['2', 2, 2], ['3', 3, 3], ['4–5', 4, 5], ['6–7', 6, 7], ['8+', 8, 99]
]);

/* ─── B. Nested model comparison ───────────────────────────────────────── */

console.log('─── B. Does structure add anything beyond mean mu? ───\n');
console.log('  feature added to meanMuDiff        acc      dLogLik   chi2 p');

const CONTROLS = [
  ['[ctrl] unrated share', (r) => r.t1.unratedShare - r.t2.unratedShare],
  ['[ctrl] mean sigma', (r) => r.t1.meanSigma - r.t2.meanSigma]
];
const STRUCTURE = [
  ['players in squads >=6', (r) => r.t1.inBigSquad - r.t2.inBigSquad],
  ['mean squad size', (r) => r.t1.meanSquadSize - r.t2.meanSquadSize],
  ['mu concentrated in big squads', (r) => r.t1.concSquadMu - r.t2.concSquadMu],
  ['clan-blocked >=3 (all clans)', (r) => r.t1.clanAll - r.t2.clanAll],
  [`clan-blocked >=3, no ${HOUSE}`, (r) => r.t1.clanExHouse - r.t2.clanExHouse],
  [`largest clan block, no ${HOUSE}`, (r) => r.t1.maxBlockExHouse - r.t2.maxBlockExHouse],
  [`${HOUSE} headcount on team`, (r) => r.t1.houseCount - r.t2.houseCount],
  ['mu concentrated in clan blocks', (r) => r.t1.concClanMu - r.t2.concClanMu],
  [`squad-clan >=4, no ${HOUSE}`, (r) => r.t1.sqClanExHouse - r.t2.sqClanExHouse],
  [`squad-clan >=4, ${HOUSE} only`, (r) => r.t1.sqClanHouse - r.t2.sqClanHouse],
  [`largest ${HOUSE} squad-stack`, (r) => r.t1.maxSqClanHouse - r.t2.maxSqClanHouse],
  [`largest squad-stack, no ${HOUSE}`, (r) => r.t1.maxSqClanExHouse - r.t2.maxSqClanExHouse]
];

for (const [name, fn] of [...CONTROLS, ...STRUCTURE]) {
  const X = rounds.map((r) => [r.meanMuDiff, fn(r)]);
  const m = fitLogistic(X, y);
  const p = chiSqP(Math.max(0, 2 * (m.ll - base.ll)), 1);
  console.log(
    `  ${name.padEnd(33)} ${`${fmt(m.acc * 100, 1)}%`.padStart(6)}   ` +
      `${fmt(m.ll - base.ll, 2).padStart(7)}   ${pStr(p)}${p < 0.05 ? '  ← significant' : ''}`
  );
}

/* ─── B2. Do the structure features survive the confound controls? ─────── */

/*
 * The decisive test. If "clan block" is really a proxy for "this team has fewer
 * unrated transients", then adding it on TOP of the rating-confidence controls
 * buys nothing and its chi-square collapses. If it survives, the controls are
 * not the explanation.
 */
console.log('\n─── B2. Structure on top of rating-confidence controls ───\n');
const ctrlX = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, fn]) => fn(r))]);
const ctrlM = fitLogistic(ctrlX, y);
console.log(
  `  control model (mu + unrated + sigma): acc ${fmt(ctrlM.acc * 100, 1)}%, ` +
    `dLogLik vs mu-only ${fmt(ctrlM.ll - base.ll, 2)}, ` +
    `p ${pStr(chiSqP(Math.max(0, 2 * (ctrlM.ll - base.ll)), 2))}\n`
);
console.log('  feature added to control model     acc      dLogLik   chi2 p');
for (const [name, fn] of STRUCTURE) {
  const X = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), fn(r)]);
  const m = fitLogistic(X, y);
  const p = chiSqP(Math.max(0, 2 * (m.ll - ctrlM.ll)), 1);
  console.log(
    `  ${name.padEnd(33)} ${`${fmt(m.acc * 100, 1)}%`.padStart(6)}   ` +
      `${fmt(m.ll - ctrlM.ll, 2).padStart(7)}   ${pStr(p)}${p < 0.05 ? '  ← survives' : ''}`
  );
}

/* ─── C. Effect size in mu-equivalent units ────────────────────────────── */

/*
 * The only number that can be acted on. If a grouped player is worth an extra
 * X mu, that is exactly the offset the scrambler would add before comparing
 * team means — the TrueSkill2 squadOffset, translated to this server. The ratio
 * of raw logistic weights converts one unit of the structure feature into
 * mu-diff units directly.
 */
console.log('\n─── C. What is one grouped player worth, in mu? ───\n');
const teamN = rounds.reduce((s, r) => s + r.t1.n, 0) / rounds.length;
for (const [name, fn] of STRUCTURE) {
  const X = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), fn(r)]);
  const m = fitLogistic(X, y);
  const wMu = m.wRaw[0];
  const wF = m.wRaw[3];
  if (Math.abs(wMu) < 1e-9) continue;
  /* meanMuDiff is a difference of MEANS, so one extra unit of the feature moves
   * the team mean by (wF/wMu) mu; times team size gives total team strength. */
  const perMean = wF / wMu;
  console.log(
    `  ${name.padEnd(33)} 1 unit = ${fmt(perMean, 4).padStart(8)} mu of team mean ` +
      `= ${fmt(perMean * teamN, 2).padStart(6)} mu of team strength`
  );
}
console.log(`\n  (team size averages ${fmt(teamN, 1)} players)`);

/* ─── D. Is there anything to fix? ─────────────────────────────────────── */

/*
 * A real effect is only worth acting on if the quantity is actually imbalanced
 * in practice. If clan blocks already land evenly across teams there is no
 * headroom, however significant the coefficient.
 */
console.log('\n─── D. How imbalanced is grouping in practice? ───\n');
const ce = describe(rounds.map((r) => Math.abs(r.t1.clanExHouse - r.t2.clanExHouse)));
const ho = describe(rounds.map((r) => Math.abs(r.t1.houseCount - r.t2.houseCount)));
const mi = describe(rounds.map((r) => Math.abs(r.meanMuDiff)));
console.log(`  |clan-blocked diff|, no ${HOUSE}:  median ${fmt(ce.median, 1)}, mean ${fmt(ce.mean, 1)}, p95 ${fmt(ce.p95, 1)}, max ${fmt(ce.max, 0)}`);
console.log(`  |${HOUSE} headcount diff|:${' '.repeat(Math.max(0, 12 - HOUSE.length))}  median ${fmt(ho.median, 1)}, mean ${fmt(ho.mean, 1)}, p95 ${fmt(ho.p95, 1)}, max ${fmt(ho.max, 0)}`);
console.log(`  |mean mu diff| (for scale):    median ${fmt(mi.median, 2)}, mean ${fmt(mi.mean, 2)}, p95 ${fmt(mi.p95, 2)}`);

function imbalanceTable(key, label, bands) {
  console.log(`\n  win rate of the side with more ${label}:`);
  console.log('    imbalance      rounds   heavy-side win   mu-predicted    gap');
  for (const [lab, lo, hiB] of bands) {
    let n = 0;
    let won = 0;
    let pred = 0;
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i];
      const d = Math.abs(r.t1[key] - r.t2[key]);
      if (d < lo || d > hiB) continue;
      n++;
      const t1Heavy = r.t1[key] >= r.t2[key];
      if (t1Heavy === r.t1Won) won++;
      pred += t1Heavy ? basePred[i] : 1 - basePred[i];
    }
    if (n === 0) continue;
    const a = won / n;
    const e = pred / n;
    const se = Math.sqrt((a * (1 - a)) / n);
    console.log(
      `    ${lab.padEnd(14)} ${String(n).padStart(6)}   ${`${fmt(a * 100, 1)}%`.padStart(14)}   ` +
        `${`${fmt(e * 100, 1)}%`.padStart(12)}   ${`${a - e >= 0 ? '+' : ''}${fmt((a - e) * 100, 1)}`.padStart(6)}` +
        `${Math.abs(a - e) > 2 * se ? '  ←' : ''}`
    );
  }
}
imbalanceTable('clanExHouse', `clan-blocked players (no ${HOUSE})`, [
  ['even (0–1)', 0, 1], ['2–3 ahead', 2, 3], ['4–6 ahead', 4, 6], ['7+ ahead', 7, 999]
]);
imbalanceTable('houseCount', `${HOUSE} members`, [
  ['even (0–1)', 0, 1], ['2–3 ahead', 2, 3], ['4–6 ahead', 4, 6], ['7–9 ahead', 7, 9], ['10+ ahead', 10, 999]
]);

/* ─── E. The house-clan tail ───────────────────────────────────────────── */

/*
 * Headcount of the house clan, entered linearly, is worth nothing once rating
 * confidence is controlled — it is a proxy for "this side has fewer unrated
 * transients", not for coordination. But the imbalance table shows the extreme
 * tail behaving differently: when one side is 10+ house members ahead it beats
 * its rating badly.
 *
 * A linear term cannot see that, so test it directly with a hinge — the excess
 * beyond a threshold, signed toward team 1, zero everywhere else. If the tail
 * is real it will survive the controls where the linear term did not; if it is
 * the same rating-confidence artefact concentrated at the extreme, it will die
 * the same way.
 */
console.log(`\n─── E. Does extreme ${HOUSE} stacking behave differently? ───\n`);
console.log('  hinge threshold   n rounds beyond   acc      dLogLik   chi2 p');
for (const thr of [6, 8, 10, 12]) {
  const hinge = (r) => {
    const d = r.t1.houseCount - r.t2.houseCount;
    return Math.sign(d) * Math.max(0, Math.abs(d) - thr);
  };
  const beyond = rounds.filter((r) => Math.abs(r.t1.houseCount - r.t2.houseCount) > thr).length;
  const X = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), hinge(r)]);
  const m = fitLogistic(X, y);
  const p = chiSqP(Math.max(0, 2 * (m.ll - ctrlM.ll)), 1);
  console.log(
    `  |diff| > ${String(thr).padEnd(2)}          ${String(beyond).padStart(11)}   ` +
      `${`${fmt(m.acc * 100, 1)}%`.padStart(6)}   ${fmt(m.ll - ctrlM.ll, 2).padStart(7)}   ` +
      `${pStr(p)}${p < 0.05 ? '  ← survives' : ''}`
  );
}

/* ─── F. Out-of-sample check ───────────────────────────────────────────── */

/*
 * Every accuracy and log-likelihood above is in-sample: adding a feature can
 * only ever improve them, which is why the likelihood-ratio test rather than
 * the accuracy column is what the conclusions rest on. But a feature can pass
 * an LRT and still fail to generalise, so this refits on 4/5 of the rounds and
 * scores the held-out fifth. Held-out log-loss is the honest comparison —
 * lower is better, and a feature that only memorises will make it worse.
 *
 * Folds are contiguous blocks in export order, i.e. roughly chronological, so
 * this also asks whether the effect holds up out of its own time period.
 */
console.log('\n─── F. 5-fold out-of-sample (held-out log-loss, lower is better) ───\n');

function crossValidate(buildRow, folds = 5) {
  return cvShared(rounds.map(buildRow), y, folds);
}

const CV_MODELS = [
  ['intercept only', () => [0]],
  ['meanMuDiff', (r) => [r.meanMuDiff]],
  ['+ rating-confidence controls', (r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r))]],
  [
    `+ largest clan block (no ${HOUSE})`,
    (r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), r.t1.maxBlockExHouse - r.t2.maxBlockExHouse]
  ],
  [
    `+ clan-blocked >=3 (no ${HOUSE})`,
    (r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), r.t1.clanExHouse - r.t2.clanExHouse]
  ],
  [
    '+ mean squad size (negative control)',
    (r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), r.t1.meanSquadSize - r.t2.meanSquadSize]
  ],
  [
    `+ ${HOUSE} headcount on team`,
    (r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), r.t1.houseCount - r.t2.houseCount]
  ],
  [
    `+ squad-clan >=4, no ${HOUSE}`,
    (r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), r.t1.sqClanExHouse - r.t2.sqClanExHouse]
  ],
  [
    `+ squad-clan >=4, ${HOUSE} only`,
    (r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), r.t1.sqClanHouse - r.t2.sqClanHouse]
  ],
  [
    `+ largest ${HOUSE} squad-stack`,
    (r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), r.t1.maxSqClanHouse - r.t2.maxSqClanHouse]
  ],
  [
    '+ both squad-clan terms',
    (r) => [
      r.meanMuDiff,
      ...CONTROLS.map(([, f]) => f(r)),
      r.t1.sqClanExHouse - r.t2.sqClanExHouse,
      r.t1.sqClanHouse - r.t2.sqClanHouse
    ]
  ]
];

console.log('  model                                  logLoss   held-out acc');
let prevLoss = null;
for (const [name, fn] of CV_MODELS) {
  const cv = crossValidate(fn);
  const delta = prevLoss === null ? '' : `  (${cv.logLoss < prevLoss ? '' : '+'}${fmt(cv.logLoss - prevLoss, 4)})`;
  console.log(
    `  ${name.padEnd(38)} ${fmt(cv.logLoss, 4).padStart(7)}   ${`${fmt(cv.acc * 100, 1)}%`.padStart(12)}${delta}`
  );
  if (name === '+ rating-confidence controls') prevLoss = cv.logLoss;
}
console.log(
  '\n  (deltas are against the rating-confidence control model, which is the\n' +
    '   thing any structure feature has to beat to be worth adding.)'
);

/* ─── Context: how much grouping is there to exploit? ──────────────────── */

console.log('\n─── How much structure exists in these lobbies? ───\n');
const allPlayers = rounds.flatMap((r) => r.players);
const sq = describe(allPlayers.map((p) => p.squadSize));
const share = (fn) => fmt((allPlayers.filter(fn).length / allPlayers.length) * 100, 1);
console.log(`  players observed:                 ${allPlayers.length}`);
console.log(`  squad size: median ${fmt(sq.median, 1)}, mean ${fmt(sq.mean, 1)}, max ${fmt(sq.max, 0)}`);
console.log(`  in a squad of 6+:                 ${share((p) => p.squadSize >= 6)}%`);
console.log(`  in a ${HOUSE} block:${' '.repeat(Math.max(0, 22 - HOUSE.length))}${share((p) => p.blockHouse > 0)}%`);
console.log(`  in a non-${HOUSE} block of 2+:${' '.repeat(Math.max(0, 14 - HOUSE.length))}${share((p) => p.blockExHouse >= 2)}%`);
console.log(`  in a non-${HOUSE} block of 3+:${' '.repeat(Math.max(0, 14 - HOUSE.length))}${share((p) => p.blockExHouse >= 3)}%`);
console.log(`  unrated:                          ${share((p) => !p.rated)}%`);

console.log('');
