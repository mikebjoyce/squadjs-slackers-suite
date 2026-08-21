/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   CO-PLAY AFFINITY — LEARNED GROUPS, NOT DECLARED ONES         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * A clan tag is a DECLARED group. It is a proxy for the thing that actually
 * matters — people who have played together enough to have habits — and it is a
 * lossy one in both directions. It misses the regular who squads with the same
 * four people nightly under no tag at all, and it over-counts the tag-wearer who
 * happens to be online but squads with strangers.
 *
 * The underlying variable is observable. Every S3PlayerSnapshot records squadID
 * per player, so co-squad history can be accumulated across the whole export and
 * the real question asked directly: does a team whose squads contain people who
 * have played together before beat its rating?
 *
 * Note this is MORE than TrueSkill2 does. Their squad offset (docs/trueskill2.pdf
 * section 6) is a function of premade party SIZE — a lobby-time fact the
 * matchmaker is handed for free. It never learns who plays well with whom. That
 * is available here only because this server sees the same population repeatedly.
 *
 * ─── THE TWO WAYS THIS COULD LIE ─────────────────────────────────
 *
 *   1. EXPERIENCE. Co-play count is mechanically bounded by how many rounds each
 *      player has played. Veterans accumulate affinity with everyone, so raw
 *      affinity is partly a veteran-count in disguise, and veterans are better.
 *      Handled two ways: mean prior rounds carried as an explicit control in
 *      every model, and a normalised affinity that divides by sqrt(rounds_i *
 *      rounds_j) so it measures preferential pairing rather than exposure.
 *
 *   2. LEAKAGE. Using the full-export co-play graph to score a round inside that
 *      export lets the future predict the past. Every feature here is built from
 *      STRICTLY PRIOR rounds only: matches are walked in chronological order,
 *      features are computed, and only then is the history updated.
 *
 * Structure is read from the LIVE snapshot (median 3.0 min after round start),
 * never ENDGAME — see analysis/SCRAMBLE_BALANCE_INVESTIGATION.md section 6 for why
 * endgame rosters cannot be used as predictors.
 *
 *   node --max-old-space-size=4096 analysis/coplay-affinity.js
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

console.log('\n═══ CO-PLAY AFFINITY ═══\n');

/* ─── House clan ───────────────────────────────────────────────────────── */

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

/* ─── One roster per match, chronological ──────────────────────────────── */

/*
 * Co-play history wants maximum coverage, so it is built from EVERY match in the
 * export, including the ones with no Elo round and the non-RAAS ones. Only the
 * scoring set is filtered. Preference order LIVE > MID_ROUND > ENDGAME picks the
 * earliest reliable view of squad composition; taking all three per match would
 * silently triple-weight matches that happen to have all three.
 */
const PREF = { LIVE: 3, MID_ROUND: 2, ENDGAME: 1 };
const bestSnap = new Map();
for (const s of snapshots) {
  if (s.matchId == null || !PREF[s.trigger]) continue;
  const prev = bestSnap.get(s.matchId);
  if (!prev || PREF[s.trigger] > PREF[prev.trigger] || (PREF[s.trigger] === PREF[prev.trigger] && s.ts < prev.ts)) {
    bestSnap.set(s.matchId, s);
  }
}
const liveSnap = new Map();
for (const s of snapshots) {
  if (s.trigger !== 'LIVE' || s.matchId == null) continue;
  const prev = liveSnap.get(s.matchId);
  if (!prev || s.ts < prev.ts) liveSnap.set(s.matchId, s);
}

const timeline = [...bestSnap.values()].sort((a, b) => a.ts - b.ts);
console.log(`  matches contributing co-play history: ${timeline.length}`);
console.log(`  of which have a LIVE roster: ${liveSnap.size}\n`);

/* ─── Accumulating history ─────────────────────────────────────────────── */

const coSquad = new Map(); // "a|b" -> rounds sharing a squad
const roundsSeen = new Map(); // eosID -> rounds present
const nameOf = new Map(); // eosID -> most recent name
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/* ─── Feature construction for one scoring round ───────────────────────── */

const AFFINITY_STRONG = 3; // prior rounds together that counts as "knows them"

/* Exposure bands by how many rounds a tag fields a block of 3+. A median split
 * is useless here — the median non-house tag appears 3 times — so the question
 * has to be asked as a curve. */
const FREQ_BANDS = [
  ['1–5 rounds (one-off)', 1, 5],
  ['6–25 rounds (occasional)', 6, 25],
  ['26–100 rounds (regular)', 26, 100],
  ['101+ rounds (fixture)', 101, 1e9]
];

function teamAffinity(players, teamID) {
  const ps = players.filter((p) => p.teamID === teamID);
  const n = ps.length || 1;

  /* Squads on this team. */
  const bySquad = new Map();
  for (const p of ps) {
    if (p.squadID == null) continue;
    if (!bySquad.has(p.squadID)) bySquad.set(p.squadID, []);
    bySquad.get(p.squadID).push(p);
  }

  let pairSum = 0;
  let pairNormSum = 0;
  let pairCount = 0;
  let strongPairs = 0;
  const strongPartners = new Map(); // eosID -> count of strong current squadmates
  let maxTieGroup = 0;

  for (const squad of bySquad.values()) {
    /* Edge list within this squad, for the connected-component measure. */
    const idx = new Map(squad.map((p, i) => [p.eosID, i]));
    const parent = squad.map((_, i) => i);
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    };

    for (let i = 0; i < squad.length; i++) {
      for (let j = i + 1; j < squad.length; j++) {
        const a = squad[i];
        const b = squad[j];
        const c = coSquad.get(pairKey(a.eosID, b.eosID)) || 0;
        pairSum += c;
        pairCount++;
        const ra = roundsSeen.get(a.eosID) || 0;
        const rb = roundsSeen.get(b.eosID) || 0;
        /* Normalised affinity: how much MORE these two pair up than their
         * individual playtime alone would produce. Kills the veteran confound. */
        pairNormSum += ra > 0 && rb > 0 ? c / Math.sqrt(ra * rb) : 0;
        if (c >= AFFINITY_STRONG) {
          strongPairs++;
          strongPartners.set(a.eosID, (strongPartners.get(a.eosID) || 0) + 1);
          strongPartners.set(b.eosID, (strongPartners.get(b.eosID) || 0) + 1);
          union(idx.get(a.eosID), idx.get(b.eosID));
        }
      }
    }
    const compSize = new Map();
    for (let i = 0; i < squad.length; i++) {
      const r = find(i);
      compSize.set(r, (compSize.get(r) || 0) + 1);
    }
    for (const [root, size] of compSize) {
      /* A component of 1 is a player connected to nobody — not a group. */
      if (size > 1 && size > maxTieGroup) maxTieGroup = size;
    }
  }

  /* Team-level affinity: co-squad history applied across the whole team, not
   * just current squadmates. Catches a clan spread over several squads. */
  let teamPairSum = 0;
  let teamStrong = 0;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const c = coSquad.get(pairKey(ps[i].eosID, ps[j].eosID)) || 0;
      if (c > 0) {
        teamPairSum += c;
        if (c >= AFFINITY_STRONG) teamStrong++;
      }
    }
  }

  const meanMu = ps.reduce((s, p) => s + p.mu, 0) / n;
  return {
    n,
    meanMu,
    meanSigma: ps.reduce((s, p) => s + p.sigma, 0) / n,
    meanExperience: ps.reduce((s, p) => s + (roundsSeen.get(p.eosID) || 0), 0) / n,
    /* Affinity family */
    sqFamRaw: pairCount ? pairSum / pairCount : 0,
    sqFamNorm: pairCount ? pairNormSum / pairCount : 0,
    strongPairs,
    playersWithPartner: [...strongPartners.keys()].length,
    playersWith2Partners: [...strongPartners.values()].filter((v) => v >= 2).length,
    maxTieGroup,
    teamFam: teamPairSum / n,
    teamStrong,
    /* Clan family, for the head-to-head */
    clanExHouse: ps.filter((p) => p.blockExHouse >= 3).length,
    maxBlockExHouse: ps.reduce((m, p) => Math.max(m, p.blockExHouse), 1),
    maxBlockRare: ps.reduce((m, p) => Math.max(m, p.rareClan ? p.blockExHouse : 1), 1),
    maxBlockFreq: ps.reduce((m, p) => Math.max(m, p.rareClan === false ? p.blockExHouse : 1), 1),
    /* Largest block per exposure band, so the "does frequency matter" question
     * can be asked as a shape rather than a single median split. */
    maxBlockBand: FREQ_BANDS.map(([, lo, hi]) =>
      ps.reduce((m, p) => Math.max(m, p.tagAppear >= lo && p.tagAppear <= hi ? p.blockExHouse : 1), 1)
    ),
    houseBlock: ps.reduce((m, p) => Math.max(m, p.isHouse ? p.blockHouse : 0), 0)
  };
}

/* ─── Clan exposure: how often does each tag actually show up? ─────────── */

/*
 * The exposure hypothesis from section 6: a clan that plays here nightly has its
 * coordination already priced into its members' mu, because mu was estimated from
 * rounds where they were coordinating. A clan that visits occasionally does not.
 * If that is the mechanism, the clan effect should live in the RARE clans, and
 * the house-clan exemption stops being a hardcoded list and becomes a formula.
 */
const tagRounds = new Map();
for (const snap of timeline) {
  let roster;
  try {
    roster = JSON.parse(snap.playersJson);
  } catch {
    continue;
  }
  const seen = new Set();
  const blocks = new Map();
  for (const p of roster) {
    if (p.teamID !== 1 && p.teamID !== 2) continue;
    const t = tagOf(p.name);
    if (!t) continue;
    blocks.set(`${p.teamID}|${t}`, (blocks.get(`${p.teamID}|${t}`) || 0) + 1);
  }
  for (const [k, v] of blocks) if (v >= 3) seen.add(k.split('|')[1]);
  for (const t of seen) tagRounds.set(t, (tagRounds.get(t) || 0) + 1);
}
const exHouseTags = [...tagRounds.entries()].filter(([t]) => t !== HOUSE).sort((a, b) => b[1] - a[1]);
const medianAppearances = exHouseTags.length
  ? exHouseTags[Math.floor(exHouseTags.length / 2)][1]
  : 0;
const rareTag = new Set(exHouseTags.filter(([, c]) => c <= medianAppearances).map(([t]) => t));
console.log(
  `  non-house tags forming a block of 3+ in at least one round: ${exHouseTags.length}\n` +
    `  median appearances ${medianAppearances}; "rare" = at or below that (${rareTag.size} tags)\n`
);

/* ─── Walk the timeline ────────────────────────────────────────────────── */

const rounds = [];
let skippedNoOutcome = 0;

for (const snap of timeline) {
  const live = liveSnap.get(snap.matchId);
  let roster;
  try {
    roster = JSON.parse(snap.playersJson);
  } catch {
    continue;
  }

  /* --- score this round, using history that predates it --- */
  scoreBlock: if (live) {
    const rd = roundForSnapshot(live);
    if (!rd || !isCompetitive(rd.layerName) || !rd.winningTeamID) {
      skippedNoOutcome++;
      break scoreBlock;
    }
    const rps = byRoundId.get(rd.id) || [];
    if (effectivePopulation(rps) < MIN_EFFECTIVE_PLAYERS) {
      skippedNoOutcome++;
      break scoreBlock;
    }
    const muByEos = new Map();
    const sigByEos = new Map();
    for (const p of rps) {
      if (Number.isFinite(p.muBefore)) muByEos.set(p.eosID, p.muBefore);
      if (Number.isFinite(p.sigmaBefore)) sigByEos.set(p.eosID, p.sigmaBefore);
    }
    let liveRoster;
    try {
      liveRoster = JSON.parse(live.playersJson);
    } catch {
      break scoreBlock;
    }
    const onTeam = liveRoster.filter((p) => p.teamID === 1 || p.teamID === 2);
    if (onTeam.length < MIN_EFFECTIVE_PLAYERS) break scoreBlock;
    if (onTeam.filter((p) => muByEos.has(p.eosID)).length / onTeam.length < 0.5) break scoreBlock;

    const blockSize = new Map();
    for (const p of onTeam) {
      const t = tagOf(p.name);
      if (!t) continue;
      const k = `${p.teamID}|${t}`;
      blockSize.set(k, (blockSize.get(k) || 0) + 1);
    }
    const players = onTeam.map((p) => {
      const t = tagOf(p.name);
      const size = t ? blockSize.get(`${p.teamID}|${t}`) : 1;
      const isHouse = t === HOUSE;
      return {
        eosID: p.eosID,
        teamID: p.teamID,
        squadID: p.squadID,
        mu: muByEos.get(p.eosID) ?? DEFAULT_MU,
        sigma: sigByEos.get(p.eosID) ?? DEFAULT_SIGMA,
        blockExHouse: isHouse ? 1 : size,
        blockHouse: isHouse ? size : 0,
        isHouse,
        rareClan: t && !isHouse ? rareTag.has(t) : null,
        tagAppear: t && !isHouse ? tagRounds.get(t) || 0 : -1,
        /* Per-player affinity, for the calibration table: the strongest bond
         * this player has with anyone currently in their squad. */
        bestSquadmate: 0,
        experience: roundsSeen.get(p.eosID) || 0
      };
    });
    const bySquadAll = new Map();
    for (const p of players) {
      if (p.squadID == null) continue;
      const k = `${p.teamID}-${p.squadID}`;
      if (!bySquadAll.has(k)) bySquadAll.set(k, []);
      bySquadAll.get(k).push(p);
    }
    for (const squad of bySquadAll.values()) {
      for (let i = 0; i < squad.length; i++) {
        for (let j = i + 1; j < squad.length; j++) {
          const c = coSquad.get(pairKey(squad[i].eosID, squad[j].eosID)) || 0;
          if (c > squad[i].bestSquadmate) squad[i].bestSquadmate = c;
          if (c > squad[j].bestSquadmate) squad[j].bestSquadmate = c;
        }
      }
    }

    rounds.push({
      matchId: snap.matchId,
      ts: Number.isFinite(rd.endedAt) ? rd.endedAt : live.ts,
      t1Won: rd.winningTeamID === 1,
      players,
      t1: teamAffinity(players, 1),
      t2: teamAffinity(players, 2)
    });
  }

  /* --- now fold this match into the history --- */
  const bySquad = new Map();
  for (const p of roster) {
    if (p.teamID !== 1 && p.teamID !== 2) continue;
    if (p.eosID) {
      roundsSeen.set(p.eosID, (roundsSeen.get(p.eosID) || 0) + 1);
      if (p.name) nameOf.set(p.eosID, p.name);
    }
    if (p.squadID == null || !p.eosID) continue;
    const k = `${p.teamID}-${p.squadID}`;
    if (!bySquad.has(k)) bySquad.set(k, []);
    bySquad.get(k).push(p.eosID);
  }
  for (const squad of bySquad.values()) {
    for (let i = 0; i < squad.length; i++) {
      for (let j = i + 1; j < squad.length; j++) {
        const k = pairKey(squad[i], squad[j]);
        coSquad.set(k, (coSquad.get(k) || 0) + 1);
      }
    }
  }
}

for (const r of rounds) r.meanMuDiff = r.t1.meanMu - r.t2.meanMu;
rounds.sort((a, b) => a.ts - b.ts);

console.log(`  scoring rounds (LIVE roster + rated outcome): ${rounds.length}`);
console.log(`  distinct co-squad pairs recorded: ${coSquad.size}`);
console.log(`  distinct players seen: ${roundsSeen.size}\n`);

/* ─── 1. Does the method find real groups? ─────────────────────────────── */

/*
 * A sanity check before any modelling. If co-squad history is measuring what it
 * claims to, the top of this list should be recognisable to anyone who plays
 * here — recurring squads, not coincidences.
 */
console.log('─── 1. Strongest recurring pairings found ───\n');
const topPairs = [...coSquad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
for (const [k, c] of topPairs) {
  const [a, b] = k.split('|');
  const ra = roundsSeen.get(a) || 0;
  const rb = roundsSeen.get(b) || 0;
  console.log(
    `  ${String(c).padStart(4)} rounds together   ${(nameOf.get(a) || a).slice(0, 24).padEnd(25)} + ` +
      `${(nameOf.get(b) || b).slice(0, 24).padEnd(25)}  (${fmt((c / Math.min(ra, rb)) * 100, 0)}% of the rarer one's rounds)`
  );
}

console.log('\n─── 1b. Recurring groups (co-squad >= 15 rounds, components of 3+) ───\n');
const GROUP_EDGE = 15;
const adj = new Map();
for (const [k, c] of coSquad) {
  if (c < GROUP_EDGE) continue;
  const [a, b] = k.split('|');
  if (!adj.has(a)) adj.set(a, []);
  if (!adj.has(b)) adj.set(b, []);
  adj.get(a).push(b);
  adj.get(b).push(a);
}
const seenNode = new Set();
const groups = [];
for (const start of adj.keys()) {
  if (seenNode.has(start)) continue;
  const comp = [];
  const stack = [start];
  seenNode.add(start);
  while (stack.length) {
    const cur = stack.pop();
    comp.push(cur);
    for (const nb of adj.get(cur) || []) {
      if (!seenNode.has(nb)) {
        seenNode.add(nb);
        stack.push(nb);
      }
    }
  }
  if (comp.length >= 3) groups.push(comp);
}
groups.sort((a, b) => b.length - a.length);
console.log(`  ${groups.length} recurring groups of 3+ found`);
for (const g of groups.slice(0, 10)) {
  const names = g.map((id) => (nameOf.get(id) || id).slice(0, 18));
  console.log(`  ${String(g.length).padStart(2)} players: ${names.slice(0, 8).join(', ')}${g.length > 8 ? ', ...' : ''}`);
}
const taggedInGroups = groups.flat().filter((id) => tagOf(nameOf.get(id) || '')).length;
console.log(
  `\n  of ${groups.flat().length} players in recurring groups, ${taggedInGroups} wear a clan tag ` +
    `(${fmt((taggedInGroups / Math.max(1, groups.flat().length)) * 100, 1)}%)`
);
console.log('  — the remainder are groups no tag-based rule can see.');

/* ─── 2. Calibration: does prior familiarity beat the rating? ──────────── */

const y = rounds.map((r) => (r.t1Won ? 1 : 0));
const baseX = rounds.map((r) => [r.meanMuDiff]);
const base = fitLogistic(baseX, y);
const basePred = baseX.map((row) => base.predict(row));

console.log('\n─── 2. Win rate by strongest bond with a current squadmate ───\n');
console.log(`  baseline: mu-diff alone, n = ${rounds.length}, acc ${fmt(base.acc * 100, 1)}%, logLik ${fmt(base.ll, 1)}\n`);
console.log('  prior rounds w/ squadmate  players   actual   predicted     gap    +-2SE   rnds');
const FAM_BUCKETS = [
  ['0 (all strangers)', 0, 0], ['1–2', 1, 2], ['3–5', 3, 5],
  ['6–10', 6, 10], ['11–20', 11, 20], ['21–40', 21, 40], ['41+', 41, 1e9]
];
for (const [lab, lo, hi] of FAM_BUCKETS) {
  let nP = 0;
  let won = 0;
  let pred = 0;
  let roundsSeenB = 0;
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    let inThis = 0;
    for (const p of r.players) {
      if (p.bestSquadmate < lo || p.bestSquadmate > hi) continue;
      inThis++;
      nP++;
      const teamWon = p.teamID === 1 ? r.t1Won : !r.t1Won;
      if (teamWon) won++;
      pred += p.teamID === 1 ? basePred[i] : 1 - basePred[i];
    }
    if (inThis > 0) roundsSeenB++;
  }
  if (!nP) continue;
  const a = won / nP;
  const e = pred / nP;
  const gap = a - e;
  const se = Math.sqrt((a * (1 - a)) / Math.max(1, roundsSeenB));
  const thin = roundsSeenB < 10;
  console.log(
    `  ${lab.padEnd(25)} ${String(nP).padStart(7)}   ${`${fmt(a * 100, 1)}%`.padStart(6)}   ` +
      `${`${fmt(e * 100, 1)}%`.padStart(9)}   ${`${gap >= 0 ? '+' : ''}${fmt(gap * 100, 1)}`.padStart(6)}   ` +
      `${fmt(2 * se * 100, 1).padStart(5)}   ${String(roundsSeenB).padStart(4)}` +
      `${thin ? '  (thin)' : Math.abs(gap) > 2 * se ? '  ←' : ''}`
  );
}

/* ─── 3. Nested models ─────────────────────────────────────────────────── */

console.log('\n─── 3. Affinity features on top of mu, sigma and experience ───\n');

const CONTROLS = [
  ['mean sigma', (r) => r.t1.meanSigma - r.t2.meanSigma],
  ['mean experience', (r) => r.t1.meanExperience - r.t2.meanExperience]
];
const ctrlX = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r))]);
const ctrlM = fitLogistic(ctrlX, y);
console.log(
  `  control model (mu + sigma + experience): acc ${fmt(ctrlM.acc * 100, 1)}%, ` +
    `dLogLik vs mu-only ${fmt(ctrlM.ll - base.ll, 2)}, p ${pStr(chiSqP(Math.max(0, 2 * (ctrlM.ll - base.ll)), 2))}\n`
);

const FEATURES = [
  ['squad affinity, raw mean', (r) => r.t1.sqFamRaw - r.t2.sqFamRaw],
  ['squad affinity, normalised', (r) => r.t1.sqFamNorm - r.t2.sqFamNorm],
  ['strong pairs in squads (>=3)', (r) => r.t1.strongPairs - r.t2.strongPairs],
  ['players with a known squadmate', (r) => r.t1.playersWithPartner - r.t2.playersWithPartner],
  ['players with 2+ known squadmates', (r) => r.t1.playersWith2Partners - r.t2.playersWith2Partners],
  ['largest connected group in a squad', (r) => r.t1.maxTieGroup - r.t2.maxTieGroup],
  ['team-wide affinity', (r) => r.t1.teamFam - r.t2.teamFam],
  ['team-wide strong pairs', (r) => r.t1.teamStrong - r.t2.teamStrong],
  ['[clan] clan-blocked >=3, no house', (r) => r.t1.clanExHouse - r.t2.clanExHouse],
  ['[clan] largest block, no house', (r) => r.t1.maxBlockExHouse - r.t2.maxBlockExHouse],
  ['[clan] largest RARE-clan block', (r) => r.t1.maxBlockRare - r.t2.maxBlockRare],
  ['[clan] largest FREQUENT-clan block', (r) => r.t1.maxBlockFreq - r.t2.maxBlockFreq]
];

console.log('  feature added to control model       dLogLik   chi2 p     CV logLoss gain');
const cvCtrl = cvShared(ctrlX, y, 5);
const results = new Map();
for (const [name, fn] of FEATURES) {
  const X = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), fn(r)]);
  const m = fitLogistic(X, y);
  const p = chiSqP(Math.max(0, 2 * (m.ll - ctrlM.ll)), 1);
  const cv = cvShared(X, y, 5);
  const gain = cvCtrl.logLoss - cv.logLoss;
  results.set(name, { d: m.ll - ctrlM.ll, p, gain });
  console.log(
    `  ${name.padEnd(36)} ${fmt(m.ll - ctrlM.ll, 2).padStart(7)}   ${pStr(p).padEnd(9)} ` +
      `${`${gain >= 0 ? '+' : ''}${fmt(gain, 4)}`.padStart(10)}` +
      `${p < 0.05 && gain > 0 ? '  ← real' : p < 0.05 ? '  (in-sample only)' : ''}`
  );
}
console.log(`\n  control-model CV logLoss ${fmt(cvCtrl.logLoss, 4)}, acc ${fmt(cvCtrl.acc * 100, 1)}%`);

/* ─── 4. Head to head: does affinity replace the clan tag? ─────────────── */

/*
 * The decisive question for design. If measured affinity subsumes the clan tag,
 * the scrambler should carry affinity and forget tags entirely — which also
 * disposes of the house-clan special case, since the house clan's affinity is
 * whatever it actually is. If the clan tag survives on top of affinity, the tag
 * is carrying something co-play history does not capture (voice comms, shared
 * doctrine, playing on the same side rather than merely in the same squad).
 */
console.log('\n─── 4. Affinity vs clan tag, head to head ───\n');
function pick(name) {
  const f = FEATURES.find(([n]) => n === name);
  return f[1];
}
const AFF = pick('players with 2+ known squadmates');
const CLAN = pick('[clan] largest block, no house');

const affX = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), AFF(r)]);
const clanX = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), CLAN(r)]);
const bothX = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), AFF(r), CLAN(r)]);
const affM = fitLogistic(affX, y);
const clanM = fitLogistic(clanX, y);
const bothM = fitLogistic(bothX, y);
console.log(`  affinity alone       dLogLik vs ctrl ${fmt(affM.ll - ctrlM.ll, 2).padStart(6)}`);
console.log(`  clan alone           dLogLik vs ctrl ${fmt(clanM.ll - ctrlM.ll, 2).padStart(6)}`);
console.log(`  both                 dLogLik vs ctrl ${fmt(bothM.ll - ctrlM.ll, 2).padStart(6)}`);
console.log(
  `\n  clan added on top of affinity: ${fmt(bothM.ll - affM.ll, 2)} ` +
    `(p ${pStr(chiSqP(Math.max(0, 2 * (bothM.ll - affM.ll)), 1))})`
);
console.log(
  `  affinity added on top of clan: ${fmt(bothM.ll - clanM.ll, 2)} ` +
    `(p ${pStr(chiSqP(Math.max(0, 2 * (bothM.ll - clanM.ll)), 1))})`
);
const cvBoth = cvShared(bothX, y, 5);
const cvAff = cvShared(affX, y, 5);
const cvClan = cvShared(clanX, y, 5);
console.log(
  `\n  CV logLoss — ctrl ${fmt(cvCtrl.logLoss, 4)}, affinity ${fmt(cvAff.logLoss, 4)}, ` +
    `clan ${fmt(cvClan.logLoss, 4)}, both ${fmt(cvBoth.logLoss, 4)}`
);

/* ─── 5. The exposure hypothesis ───────────────────────────────────────── */

console.log('\n─── 5. Where in the exposure curve does the clan effect live? ───\n');
console.log('  The section-6 hypothesis was that a clan playing here nightly has its');
console.log('  coordination already priced into member mu, so the effect should sit in');
console.log('  the RARE clans. A median split cannot test that — the median non-house');
console.log('  tag appears 3 times — so this asks it as a curve instead.\n');

console.log('  tag exposure               tags   rounds w/ imbalance 2+   dLogLik   p          CV gain');
for (let b = 0; b < FREQ_BANDS.length; b++) {
  const [lab, lo, hi] = FREQ_BANDS[b];
  const nTags = exHouseTags.filter(([, c]) => c >= lo && c <= hi).length;
  const fn = (r) => r.t1.maxBlockBand[b] - r.t2.maxBlockBand[b];
  const imb = rounds.filter((r) => Math.abs(fn(r)) >= 2).length;
  const X = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), fn(r)]);
  const m = fitLogistic(X, y);
  const p = chiSqP(Math.max(0, 2 * (m.ll - ctrlM.ll)), 1);
  const gain = cvCtrl.logLoss - cvShared(X, y, 5).logLoss;
  console.log(
    `  ${lab.padEnd(26)} ${String(nTags).padStart(4)}   ${String(imb).padStart(21)}   ` +
      `${fmt(m.ll - ctrlM.ll, 2).padStart(7)}   ${pStr(p).padEnd(9)}  ` +
      `${`${gain >= 0 ? '+' : ''}${fmt(gain, 4)}`.padStart(8)}${p < 0.05 && gain > 0 ? '  ←' : ''}`
  );
}
/* The house clan is the far end of the same curve and belongs on the same plot. */
{
  const fn = (r) => r.t1.houseBlock - r.t2.houseBlock;
  const imb = rounds.filter((r) => Math.abs(fn(r)) >= 2).length;
  const X = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), fn(r)]);
  const m = fitLogistic(X, y);
  const p = chiSqP(Math.max(0, 2 * (m.ll - ctrlM.ll)), 1);
  const gain = cvCtrl.logLoss - cvShared(X, y, 5).logLoss;
  console.log(
    `  ${`${HOUSE} (house, ${tagRounds.get(HOUSE) || 0} rounds)`.padEnd(26)} ${'1'.padStart(4)}   ` +
      `${String(imb).padStart(21)}   ${fmt(m.ll - ctrlM.ll, 2).padStart(7)}   ${pStr(p).padEnd(9)}  ` +
      `${`${gain >= 0 ? '+' : ''}${fmt(gain, 4)}`.padStart(8)}`
  );
}

/* How lopsided does each band actually get? A band can be null simply because
 * the balancer already splits it evenly, which is a very different reason from
 * "this group is not worth anything". */
console.log('\n  how unbalanced does each band get, and how big are the blocks?\n');
console.log('  tag exposure               mean |imbalance|   mean larger block   max block seen');
for (let b = 0; b < FREQ_BANDS.length; b++) {
  const [lab] = FREQ_BANDS[b];
  const d = describe(rounds.map((r) => Math.abs(r.t1.maxBlockBand[b] - r.t2.maxBlockBand[b])));
  const big = describe(rounds.map((r) => Math.max(r.t1.maxBlockBand[b], r.t2.maxBlockBand[b])));
  console.log(
    `  ${lab.padEnd(26)} ${fmt(d.mean, 3).padStart(16)}   ${fmt(big.mean, 2).padStart(17)}   ${String(big.max).padStart(14)}`
  );
}
{
  const d = describe(rounds.map((r) => Math.abs(r.t1.houseBlock - r.t2.houseBlock)));
  const big = describe(rounds.map((r) => Math.max(r.t1.houseBlock, r.t2.houseBlock)));
  console.log(
    `  ${`${HOUSE} (house)`.padEnd(26)} ${fmt(d.mean, 3).padStart(16)}   ${fmt(big.mean, 2).padStart(17)}   ${String(big.max).padStart(14)}`
  );
}

/* ─── 6. Effect size ───────────────────────────────────────────────────── */

console.log('\n─── 6. Effect size in mu of team strength ───\n');
const teamN = rounds.reduce((s, r) => s + r.t1.n, 0) / rounds.length;
for (const [name, fn] of FEATURES) {
  const res = results.get(name);
  if (res.p >= 0.05) continue;
  const X = rounds.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), fn(r)]);
  const m = fitLogistic(X, y);
  const wMu = m.wRaw[0];
  if (Math.abs(wMu) < 1e-9) continue;
  const perMean = m.wRaw[3] / wMu;
  console.log(
    `  ${name.padEnd(36)} 1 unit = ${fmt(perMean * teamN, 2).padStart(7)} mu of team strength` +
      `${res.gain > 0 ? '  ←' : '  (no CV support)'}`
  );
}
console.log(`\n  (team size averages ${fmt(teamN, 1)} players)`);

/* ─── 7. Did the scrambler build these teams, or did they just happen? ─── */

/*
 * Everything above pools two very different populations: teams the scrambler built,
 * and teams that formed on their own (or on a night the balancer was switched off by
 * hand). Only the first speaks to what a scorer change would do.
 *
 * CAREFUL WITH THE FLAG. `TB_RoundReport.scrambled` marks the round that TRIGGERED a
 * scramble, not the round a scramble produced. The evidence is unambiguous: flagged
 * rounds average 167.8 ticket margin against 108.8 for the rest, the "Single Round
 * Margin" trigger averages 268.8, and the margin of the FOLLOWING round drops to
 * 120.2. Reading the flag as "this round was scrambled" makes the subset look 87.6%
 * predictable, which is just blowouts being easy to call.
 *
 * So the scrambler's output is the round immediately AFTER a flagged one, subject to
 * the two rounds actually being consecutive in time.
 *
 * The two subsets test different things. On post-scramble rounds clan blocks exist
 * partly BY CONSTRUCTION — tb-scrambler.js:548 rejects any candidate that splits a
 * clan, so cohesion is enforced and the only question is whether it was priced. On
 * organic rounds blocks are self-selected.
 */
const tbRounds = table(exp, 'TB_RoundReport')
  .filter((r) => Number.isFinite(r.ts))
  .sort((a, b) => a.ts - b.ts);

const MAX_GAP_MS = 3 * 60 * 60 * 1000; // consecutive rounds, not across a restart
const postScrambleMatch = new Set();
const organicMatch = new Set();
for (let i = 1; i < tbRounds.length; i++) {
  const prev = tbRounds[i - 1];
  const cur = tbRounds[i];
  if (cur.matchId == null) continue;
  const gap = (Number.isFinite(cur.roundStartTime) ? cur.roundStartTime : cur.ts) - prev.ts;
  if (!Number.isFinite(gap) || gap < 0 || gap > MAX_GAP_MS) continue;
  if (Number(prev.scrambled) === 1) postScrambleMatch.add(cur.matchId);
  else organicMatch.add(cur.matchId);
}

console.log('\n─── 7. Teams the scrambler built vs teams that formed on their own ───\n');
console.log('  (the `scrambled` flag marks the TRIGGER round — see the comment above)\n');
const scr = rounds.filter((r) => postScrambleMatch.has(r.matchId));
const uns = rounds.filter((r) => organicMatch.has(r.matchId));
console.log(
  `  scoring rounds: post-scramble ${scr.length}, organic ${uns.length}, ` +
    `unclassifiable ${rounds.length - scr.length - uns.length}\n`
);

const SUBSET_FEATURES = [
  ['largest clan block, no house', (r) => r.t1.maxBlockExHouse - r.t2.maxBlockExHouse],
  ['clan-blocked >=3, no house', (r) => r.t1.clanExHouse - r.t2.clanExHouse],
  ['players with 2+ known squadmates', (r) => r.t1.playersWith2Partners - r.t2.playersWith2Partners],
  ['largest house block', (r) => r.t1.houseBlock - r.t2.houseBlock]
];

function subsetTest(label, subset) {
  if (subset.length < 60) {
    console.log(`  ${label} — only ${subset.length} rounds, skipped`);
    return;
  }
  const sy = subset.map((r) => (r.t1Won ? 1 : 0));
  const sBase = fitLogistic(
    subset.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r))]),
    sy
  );
  console.log(`  ${label} (n=${subset.length}, control acc ${fmt(sBase.acc * 100, 1)}%)`);
  for (const [name, fn] of SUBSET_FEATURES) {
    const X = subset.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), fn(r)]);
    const m = fitLogistic(X, sy);
    const p = chiSqP(Math.max(0, 2 * (m.ll - sBase.ll)), 1);
    console.log(
      `     ${name.padEnd(34)} dLogLik ${fmt(m.ll - sBase.ll, 2).padStart(6)}   p ${pStr(p)}` +
        `${p < 0.05 ? '  ←' : ''}`
    );
  }
  console.log('');
}
subsetTest('POST-SCRAMBLE (teams the scrambler built)', scr);
subsetTest('ORGANIC (teams that formed on their own)', uns);

/* ─── 8. Sensitivity: drop the raid nights ─────────────────────────────── */

/*
 * Blocks of 14-26 from a tag that appears a handful of times are clan raid nights,
 * and the balancer is switched off by hand for those BY POLICY — scrambling a
 * visiting clan apart is worse than the imbalance. So those rounds are not evidence
 * about a scrambler decision, they are evidence about a deliberate non-decision, and
 * the whole "one-off" exposure band is largely made of them.
 *
 * Production runs maxSize 25 (not the 18 default), so a block of 25 is still held
 * together as a hard constraint — only a 26+ turnout is released.
 */
const PROD_MAX_SIZE = 25;
const bigBlock = (r) => Math.max(r.t1.maxBlockExHouse, r.t2.maxBlockExHouse);
const raid = rounds.filter((r) => bigBlock(r) > 10);
console.log('─── 8. Sensitivity to clan-event rounds ───\n');
console.log(`  rounds with a non-house block > 10: ${raid.length}`);
console.log(
  `  of those, above production maxSize ${PROD_MAX_SIZE} (released by the grouper): ` +
    `${rounds.filter((r) => bigBlock(r) > PROD_MAX_SIZE).length}`
);
console.log(
  `  held together as a hard constraint (11..${PROD_MAX_SIZE}): ` +
    `${rounds.filter((r) => bigBlock(r) > 10 && bigBlock(r) <= PROD_MAX_SIZE).length}\n`
);

const noRaid = rounds.filter((r) => bigBlock(r) <= 10);
const nry = noRaid.map((r) => (r.t1Won ? 1 : 0));
const nrCtrl = fitLogistic(
  noRaid.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r))]),
  nry
);
console.log(`  excluding them (n=${noRaid.length}):`);
for (let b = 0; b < FREQ_BANDS.length; b++) {
  const [lab] = FREQ_BANDS[b];
  const fn = (r) => r.t1.maxBlockBand[b] - r.t2.maxBlockBand[b];
  const X = noRaid.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), fn(r)]);
  const m = fitLogistic(X, nry);
  const p = chiSqP(Math.max(0, 2 * (m.ll - nrCtrl.ll)), 1);
  console.log(
    `     ${lab.padEnd(26)} dLogLik ${fmt(m.ll - nrCtrl.ll, 2).padStart(6)}   p ${pStr(p)}${p < 0.05 ? '  ←' : ''}`
  );
}
for (const [name, fn] of SUBSET_FEATURES.slice(0, 3)) {
  const X = noRaid.map((r) => [r.meanMuDiff, ...CONTROLS.map(([, f]) => f(r)), fn(r)]);
  const m = fitLogistic(X, nry);
  const p = chiSqP(Math.max(0, 2 * (m.ll - nrCtrl.ll)), 1);
  console.log(
    `     ${name.padEnd(26)} dLogLik ${fmt(m.ll - nrCtrl.ll, 2).padStart(6)}   p ${pStr(p)}${p < 0.05 ? '  ←' : ''}`
  );
}
console.log('');
