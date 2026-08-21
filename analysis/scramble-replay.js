/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║        OFFLINE SCRAMBLE REPLAY — CHURN vs ACHIEVABLE μ GAP     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── WHAT THIS IS ────────────────────────────────────────────────
 *
 * Feeds real end-of-round lobbies through the REAL scrambler
 * (team-balancer/utils/tb-scrambler.js — imported, not reimplemented) under
 * different churn floors, and measures what mu gap each floor can actually
 * reach and what it costs in players moved.
 *
 * The question it exists to answer: team-balancer.js forces a 40–55 player
 * shuffle when the pre-scramble mean-mu delta is below a hardcoded 0.4, and
 * imposes no floor at all above it. That threshold sits at percentile 48.9 of
 * its own input distribution (see churn-floor-threshold.js), so it governs half
 * of all scrambles — and it withholds the floor from precisely the rounds with
 * the largest gaps to close. Is that costing us balance, or is squad atomicity
 * the binding constraint regardless of how many players we allow to move?
 *
 * ─── WHY THESE INPUTS ────────────────────────────────────────────
 *
 * Lobbies come from S3PlayerSnapshots ENDGAME rows: the actual roster, with
 * real squad composition, at the exact moment the balancer takes its scramble
 * decision. Not synthetic, and not reconstructed from Elo_RoundPlayers (which
 * records teams but not squads, and only for rounds Elo agreed to rate).
 *
 * Ratings are rebuilt as a point-in-time timeline. Elo_PlayerStats holds only
 * current values, so replaying a June lobby against today's ratings would be
 * look-ahead bias. Instead each player's muAfter history is indexed by round
 * end time, and a replay at time T sees only what was known before T.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node --max-old-space-size=4096 analysis/scramble-replay.js
 *   node --max-old-space-size=4096 analysis/scramble-replay.js --limit=200
 *   node --max-old-space-size=4096 analysis/scramble-replay.js --full
 *   node --max-old-space-size=4096 analysis/scramble-replay.js --repeats=3
 *
 * --limit   lobbies to replay (default 400; sampled evenly across the window)
 * --full    replay every eligible lobby
 * --repeats runs per lobby per config, to separate search noise from signal
 */

import { Scrambler } from '../team-balancer/utils/tb-scrambler.js';
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
  bar,
  fitLogistic
} from './load-export.js';

/* Same extraction the plugin uses, so `clanGroups` here matches production exactly
 * (house tag already excluded via ignoreList, discovered empirically below). */
const clans = new ClansService({ options: { enabled: true, minSize: 2, maxSize: 25 } });

/* ─── Constants mirrored from the live plugin ──────────────────────────────
 * If these drift from team-balancer.js the replay stops describing production,
 * so they are named and grouped rather than inlined at the call site. */
const DEFAULT_MU = 25.0; // EloCalculator.MU_DEFAULT
const CHURN_FLOOR_MU = 0.4; // team-balancer.js:2466 — the hardcoded threshold
const FLOOR_MIN = 40; // team-balancer.js:2468
const FLOOR_MAX = 55; // team-balancer.js:2469
const SCRAMBLE_PERCENTAGE = 0.5; // options.scramblePercentage default
const MIN_LOBBY = 80;
const Q1_TARGET = 0.2; // "already balanced" band from the outcome analysis

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const FULL = argv.includes('--full');
const LIMIT = argOf('limit', 400);
const REPEATS = argOf('repeats', 1);

/* ─── Load ─────────────────────────────────────────────────────────────── */

const exp = loadExport(newestExport());
const snapshots = table(exp, 'S3PlayerSnapshots');
const roundPlayers = table(exp, 'Elo_RoundPlayers');
const eloRounds = table(exp, 'Elo_RoundHistory');
const tbRounds = table(exp, 'TB_RoundReport');
const playerEvents = table(exp, 'S3PlayerEvents');

console.log('\n═══ SCRAMBLE REPLAY ═══\n');

/* ─── Point-in-time rating timeline ────────────────────────────────────────
 *
 * eosID → [{ at, mu }] sorted ascending by round end. `at` is the round's END,
 * because that is when the new rating becomes visible to anything that reads
 * the table afterwards. roundsPlayed at time T is just the index of the lookup,
 * which is what the veteran-parity term in the scorer consumes.
 */
const roundEndAt = new Map();
for (const r of eloRounds) if (Number.isFinite(r.endedAt)) roundEndAt.set(r.id, r.endedAt);

const timeline = new Map();
for (const p of roundPlayers) {
  const at = roundEndAt.get(p.roundHistoryId);
  if (!Number.isFinite(at) || !Number.isFinite(p.muAfter)) continue;
  if (!timeline.has(p.eosID)) timeline.set(p.eosID, []);
  timeline.get(p.eosID).push({ at, mu: p.muAfter });
}
for (const arr of timeline.values()) arr.sort((a, b) => a.at - b.at);

console.log(`  rating timeline: ${timeline.size} players, ${roundPlayers.length} observations`);

/** Rating as the DB would have held it immediately before `ts`. */
function ratingAt(eosID, ts) {
  const hist = timeline.get(eosID);
  if (!hist || hist.length === 0 || hist[0].at >= ts) return null;
  let lo = 0;
  let hi = hist.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hist[mid].at < ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return null;
  return { mu: hist[best].mu, roundsPlayed: best + 1 };
}

/* ─── Retention model — fitted once on real LIVE/ENDGAME/Elo rounds ────────
 *
 * Feeds stayerWeightingEnabled (tb-scrambler.js): scoreSwap()'s mean-mu term
 * can be weighted by predicted P(stay) instead of counting every LIVE-roster
 * player equally. analysis/retention-predictors.js established leaving is
 * predictable pre-round; analysis/stayer-weighted-balance.js established the
 * weighted mean tracks the realized ENDGAME gap better than the naive mean
 * (r 0.848 vs 0.842, mean abs error 0.2321 vs 0.2544, sign test z=2.79). This
 * fits the same model once, globally, to actually deploy it as a feature
 * generator here — this is not a validation study, so no held-out fold.
 */

const joinsByEos = new Map();
const leavesByEos = new Map();
for (const e of playerEvents) {
  if (e.eventType === 'JOIN') {
    if (!joinsByEos.has(e.eosID)) joinsByEos.set(e.eosID, []);
    joinsByEos.get(e.eosID).push(e.ts);
  } else if (e.eventType === 'LEAVE' && e.betweenRounds === 0) {
    if (!leavesByEos.has(e.eosID)) leavesByEos.set(e.eosID, []);
    leavesByEos.get(e.eosID).push(e.ts);
  }
}
for (const arr of joinsByEos.values()) arr.sort((a, b) => a - b);
for (const arr of leavesByEos.values()) arr.sort((a, b) => a - b);

function lastJoinBefore(eosID, ts) {
  const hist = joinsByEos.get(eosID);
  if (!hist) return null;
  let lo = 0;
  let hi = hist.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hist[mid] < ts) {
      best = hist[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}
function leftBetween(eosID, tsStart, tsEnd) {
  const hist = leavesByEos.get(eosID);
  if (!hist) return false;
  return hist.some((t) => t >= tsStart && t <= tsEnd);
}

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
  return bestD <= 300_000 ? best : null;
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

const retentionRows = [];
for (const [matchId, liveSnap] of liveByMatch) {
  const rd = roundForSnapshot(liveSnap);
  if (!rd || !Number.isFinite(rd.endedAt) || !isCompetitive(rd.layerName)) continue;
  const rps = byRoundId.get(rd.id) || [];
  if (effectivePopulation(rps) < MIN_EFFECTIVE_PLAYERS) continue;
  let liveRoster;
  try {
    liveRoster = JSON.parse(liveSnap.playersJson);
  } catch {
    continue;
  }
  const liveOnTeam = liveRoster.filter((p) => p.teamID === 1 || p.teamID === 2);
  if (liveOnTeam.length < MIN_EFFECTIVE_PLAYERS) continue;
  const muByEos = new Map();
  for (const p of rps) if (Number.isFinite(p.muBefore)) muByEos.set(p.eosID, p.muBefore);
  if (liveOnTeam.filter((p) => muByEos.has(p.eosID)).length / liveOnTeam.length < 0.5) continue;

  for (const p of liveOnTeam) {
    const lastJoin = lastJoinBefore(p.eosID, liveSnap.ts);
    if (lastJoin == null) continue;
    const r = ratingAt(p.eosID, liveSnap.ts);
    retentionRows.push({
      sessionMinutes: (liveSnap.ts - lastJoin) / 60000,
      roundsPlayed: r?.roundsPlayed ?? 0,
      rated: muByEos.has(p.eosID) ? 1 : 0,
      inSquad: p.squadID != null ? 1 : 0,
      mu: muByEos.get(p.eosID) ?? DEFAULT_MU,
      left: leftBetween(p.eosID, liveSnap.ts, rd.endedAt) ? 1 : 0
    });
  }
}

console.log(`  retention model training rows: ${retentionRows.length}`);
const retentionModel = fitLogistic(
  retentionRows.map((r) => [r.sessionMinutes, r.roundsPlayed, r.rated, r.inSquad, r.mu]),
  retentionRows.map((r) => r.left)
);

/** Predicted P(stay) for a LIVE-roster player, from features available at the
 * scramble decision point (mirrors the feature set the model was fit on). */
function predictPStay({ sessionMinutes, roundsPlayed, rated, inSquad, mu }) {
  return 1 - retentionModel.predict([sessionMinutes, roundsPlayed, rated, inSquad, mu]);
}

/* ─── Eligible lobbies ─────────────────────────────────────────────────── */

/* Snapshots carry a matchId but no layer, so mode has to come from the round
 * tables. matchId is only cohered for the later part of the window, so fall
 * back to the nearest round-end timestamp — the same join used in
 * balancer-vs-elo-coverage.js, exact to within 1ms on cohered pairs. */
const layerByMatch = new Map();
const roundsByTs = [];
for (const r of tbRounds) {
  if (r.matchId) layerByMatch.set(r.matchId, r.layerName);
  if (Number.isFinite(r.ts)) roundsByTs.push(r);
}
roundsByTs.sort((a, b) => a.ts - b.ts);

function layerFor(snap) {
  if (snap.matchId && layerByMatch.has(snap.matchId)) return layerByMatch.get(snap.matchId);
  // ENDGAME snapshots are taken at round end, so the round row is the nearest
  // ts in either direction; allow a few minutes of slack.
  let lo = 0;
  let hi = roundsByTs.length - 1;
  let best = null;
  let bestD = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const d = roundsByTs[mid].ts - snap.ts;
    if (Math.abs(d) < bestD) {
      bestD = Math.abs(d);
      best = roundsByTs[mid];
    }
    if (d < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  return bestD <= 300_000 ? best?.layerName : null;
}

/* ─── House clan, same empirical rule as squad-coordination.js ─────────── */

const tagOf = (name) => {
  const raw = clans.extractRawPrefix(name);
  return raw ? clans.normalizeTag(raw) : null;
};
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

const rejected = { notEndgame: 0, tooSmall: 0, noLayer: 0, nonCompetitive: 0, badJson: 0, noRatings: 0 };
const lobbies = [];

for (const snap of snapshots) {
  if (snap.trigger !== 'ENDGAME') {
    rejected.notEndgame++;
    continue;
  }
  let roster;
  try {
    roster = JSON.parse(snap.playersJson);
  } catch {
    rejected.badJson++;
    continue;
  }
  if (!Array.isArray(roster) || roster.length < MIN_LOBBY) {
    rejected.tooSmall++;
    continue;
  }
  const layer = layerFor(snap);
  if (!layer) {
    rejected.noLayer++;
    continue;
  }
  if (!isCompetitive(layer)) {
    rejected.nonCompetitive++;
    continue;
  }

  // Only players actually on a side participate in a swap.
  const onTeam = roster.filter((p) => p.teamID === 1 || p.teamID === 2);
  if (onTeam.length < MIN_LOBBY) {
    rejected.tooSmall++;
    continue;
  }

  const eloMap = new Map();
  let ratedCount = 0;
  for (const p of onTeam) {
    const r = ratingAt(p.eosID, snap.ts);
    if (r) {
      eloMap.set(p.eosID, { mu: r.mu, roundsPlayed: r.roundsPlayed });
      ratedCount++;
    }
  }
  // A lobby with almost no rating coverage tells us nothing about mu tuning.
  if (ratedCount / onTeam.length < 0.5) {
    rejected.noRatings++;
    continue;
  }

  /*
   * Shapes must match transformSquadJSData() in team-balancer.js exactly. In
   * particular a squad is keyed by `id`, not `squadID`: the scrambler dedupes
   * selected squads through `new Set(sel.map((s) => s.id))` and rejects any
   * candidate whose two sides intersect. Omit `id` and every squad collides on
   * `undefined`, so all of them are rejected and only unassigned pseudo-squads
   * (which mint their own id) can ever move — the scramble silently degenerates
   * to shuffling loose players.
   */
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
      squadMap.set(p.squadID, {
        id: p.squadID,
        teamID: String(p.teamID),
        players: [],
        locked: false
      });
    }
    squadMap.get(p.squadID).players.push(p.eosID);
  }

  const clanGroups = clans.extractClanGroups(
    onTeam.map((p) => ({ eosID: p.eosID, name: p.name })),
    { ignoreList: [HOUSE] }
  );

  const stayerWeights = new Map();
  for (const p of onTeam) {
    const lastJoin = lastJoinBefore(p.eosID, snap.ts);
    if (lastJoin == null) continue;
    const r = eloMap.get(p.eosID);
    stayerWeights.set(
      p.eosID,
      predictPStay({
        sessionMinutes: (snap.ts - lastJoin) / 60000,
        roundsPlayed: r?.roundsPlayed ?? 0,
        rated: r ? 1 : 0,
        inSquad: p.squadID != null ? 1 : 0,
        mu: r?.mu ?? DEFAULT_MU
      })
    );
  }

  lobbies.push({
    ts: snap.ts,
    layer,
    players,
    squads: [...squadMap.values()],
    eloMap,
    clanGroups,
    stayerWeights,
    ratedShare: ratedCount / onTeam.length,
    preMuDelta: muDeltaOf(players, eloMap),
    preClanImbalance: clanImbalanceOf(players, clanGroups)
  });
}

/** Non-house clan blocks of 3+ per team, before any scramble — the same
 * metric priced by clanBlockPenaltyEnabled in tb-scrambler.js. */
function clanImbalanceOf(players, clanGroups) {
  const teamOf = new Map(players.map((p) => [p.eosID, p.teamID]));
  let t1 = 0;
  let t2 = 0;
  for (const eosIDs of Object.values(clanGroups)) {
    let c1 = 0;
    let c2 = 0;
    for (const id of eosIDs) {
      if (teamOf.get(id) === '1') c1++;
      else if (teamOf.get(id) === '2') c2++;
    }
    if (c1 >= 3) t1++;
    if (c2 >= 3) t2++;
  }
  return Math.abs(t1 - t2);
}

/** The plugin's own arithmetic: all players, unrated substituted at 25.0. */
function muDeltaOf(players, eloMap) {
  let t1 = 0;
  let n1 = 0;
  let t2 = 0;
  let n2 = 0;
  for (const p of players) {
    const mu = eloMap.get(p.eosID)?.mu ?? DEFAULT_MU;
    if (String(p.teamID) === '1') {
      t1 += mu;
      n1++;
    } else {
      t2 += mu;
      n2++;
    }
  }
  if (n1 === 0 || n2 === 0) return NaN;
  return Math.abs(t1 / n1 - t2 / n2);
}

console.log(`  eligible lobbies: ${lobbies.length}`);
console.log(
  `  rejected — not ENDGAME ${rejected.notEndgame}, too small ${rejected.tooSmall}, ` +
    `no layer ${rejected.noLayer}, non-RAAS ${rejected.nonCompetitive}, ` +
    `thin ratings ${rejected.noRatings}, bad json ${rejected.badJson}`
);

/* Even sampling across the window rather than head/tail, so a subsample is not
 * secretly a study of one month's meta or one roster generation. */
lobbies.sort((a, b) => a.ts - b.ts);
let sample = lobbies;
if (!FULL && lobbies.length > LIMIT) {
  const stride = lobbies.length / LIMIT;
  sample = Array.from({ length: LIMIT }, (_, i) => lobbies[Math.floor(i * stride)]);
}
console.log(`  replaying: ${sample.length} lobbies × ${REPEATS} repeat(s)\n`);

/* ─── Configs ──────────────────────────────────────────────────────────────
 *
 * "current" reproduces production. The numbered floors are a sweep: each forces
 * the scrambler to move at least that many players, holding the 15-wide band
 * the plugin uses. Floor 0 removes the bound entirely, which is what production
 * does today for every round above 0.4.
 */
const CONFIGS = [
  { name: 'production', floor: null },
  { name: 'clan-priced', floor: null, clanPenalty: true },
  { name: 'stayer-weighted', floor: null, stayerWeighted: true },
  { name: 'no floor', floor: 0 },
  { name: 'floor 20', floor: 20 },
  { name: 'floor 30', floor: 30 },
  { name: 'floor 40', floor: 40 },
  { name: 'floor 50', floor: 50 },
  { name: 'floor 60', floor: 60 }
];

function boundsFor(config, preMuDelta) {
  if (config.floor === null) {
    // Production: floor only when already close.
    return preMuDelta < CHURN_FLOOR_MU
      ? { minPlayersToMove: FLOOR_MIN, maxPlayersToMove: FLOOR_MAX }
      : { minPlayersToMove: 0, maxPlayersToMove: 0 };
  }
  if (config.floor === 0) return { minPlayersToMove: 0, maxPlayersToMove: 0 };
  return { minPlayersToMove: config.floor, maxPlayersToMove: config.floor + 15 };
}

/* ─── Replay ───────────────────────────────────────────────────────────── */

const results = new Map(CONFIGS.map((c) => [c.name, []]));
const started = Date.now();
let done = 0;

for (const lobby of sample) {
  for (const config of CONFIGS) {
    const { minPlayersToMove, maxPlayersToMove } = boundsFor(config, lobby.preMuDelta);
    for (let rep = 0; rep < REPEATS; rep++) {
      const plan = await Scrambler.scrambleTeamsPreservingSquads({
        squads: lobby.squads.map((s) => ({ ...s, players: [...s.players] })),
        players: lobby.players.map((p) => ({ ...p })),
        winStreakTeam: 1,
        scramblePercentage: SCRAMBLE_PERCENTAGE,
        eloMap: lobby.eloMap,
        minPlayersToMove,
        maxPlayersToMove,
        clanGroups: lobby.clanGroups,
        clanBlockPenaltyEnabled: !!config.clanPenalty,
        stayerWeights: lobby.stayerWeights,
        stayerWeightingEnabled: !!config.stayerWeighted
      });
      const s = plan.eloSummary;
      if (!s) continue;
      const finalTeamOf = new Map(lobby.players.map((p) => [p.eosID, p.teamID]));
      for (const move of plan) finalTeamOf.set(move.eosID, String(move.targetTeamID));
      const postClanImbalance = clanImbalanceOf(
        lobby.players.map((p) => ({ eosID: p.eosID, teamID: finalTeamOf.get(p.eosID) })),
        lobby.clanGroups
      );
      // Recomputed with everyone weighted equally, regardless of what scoreSwap()
      // itself optimised for — the only way production and stayer-weighted plans
      // are comparable on the same yardstick.
      const postNaiveGap = muDeltaOf(
        lobby.players.map((p) => ({ eosID: p.eosID, teamID: finalTeamOf.get(p.eosID) })),
        lobby.eloMap
      );
      results.get(config.name).push({
        pre: s.preMeanDiff,
        post: s.postMeanDiff,
        preTop15: s.preTop15Diff,
        postTop15: s.postTop15Diff,
        postNaiveGap,
        moved: plan.length,
        band: lobby.preMuDelta < CHURN_FLOOR_MU ? 'below' : 'above',
        preClanImbalance: lobby.preClanImbalance,
        postClanImbalance
      });
    }
  }
  done++;
  if (done % 50 === 0) {
    const rate = (Date.now() - started) / done;
    const eta = Math.round(((sample.length - done) * rate) / 1000);
    process.stdout.write(`\r  ${done}/${sample.length} lobbies  (eta ${eta}s)   `);
  }
}
process.stdout.write(`\r  ${sample.length}/${sample.length} lobbies — done in ${Math.round((Date.now() - started) / 1000)}s\n`);

/* ─── Report ───────────────────────────────────────────────────────────── */

function summarise(rows) {
  const post = describe(rows.map((r) => r.post));
  const moved = describe(rows.map((r) => r.moved));
  const top15 = describe(rows.map((r) => r.postTop15));
  const q1 = rows.filter((r) => r.post < Q1_TARGET).length / rows.length;
  const worse = rows.filter((r) => r.post > r.pre).length / rows.length;
  return { post, moved, top15, q1, worse, n: rows.length };
}

function reportTable(label, filter) {
  console.log(`\n─── ${label} ───\n`);
  console.log(
    '  config        n     post mu gap        reach Q1   players moved      post top15   made worse'
  );
  console.log(
    '                      mean   median      (<0.20)    mean   median      mean'
  );
  for (const c of CONFIGS) {
    const rows = results.get(c.name).filter(filter);
    if (rows.length === 0) continue;
    const s = summarise(rows);
    console.log(
      `  ${c.name.padEnd(12)} ${String(s.n).padStart(4)}   ` +
        `${fmt(s.post.mean).padStart(5)}  ${fmt(s.post.median).padStart(6)}     ` +
        `${`${fmt(s.q1 * 100, 1)}%`.padStart(7)}    ` +
        `${fmt(s.moved.mean, 1).padStart(5)}  ${fmt(s.moved.median, 1).padStart(6)}     ` +
        `${fmt(s.top15.mean).padStart(5)}       ` +
        `${`${fmt(s.worse * 100, 1)}%`.padStart(6)}`
    );
  }
}

const preAll = describe(results.get('production').map((r) => r.pre));
console.log(`\n  pre-scramble mu gap across the sample: mean ${fmt(preAll.mean)}, median ${fmt(preAll.median)}`);

reportTable('All lobbies', () => true);
reportTable(`Lobbies ALREADY close (pre gap < ${CHURN_FLOOR_MU}) — production forces 40–55`, (r) => r.band === 'below');
reportTable(`Lobbies NOT close (pre gap >= ${CHURN_FLOOR_MU}) — production applies no floor`, (r) => r.band === 'above');

/* ─── The headline comparison ──────────────────────────────────────────── */

console.log('\n─── Marginal value of churn, on the rounds that need it ───\n');
const above = (name) => summarise(results.get(name).filter((r) => r.band === 'above'));
const base = above('no floor');
const maxMoved = Math.max(...CONFIGS.map((c) => above(c.name).moved.mean || 0));
for (const c of CONFIGS) {
  if (c.name === 'production') continue;
  const s = above(c.name);
  if (!s.n) continue;
  const dGap = s.post.mean - base.post.mean;
  const dMoved = s.moved.mean - base.moved.mean;
  console.log(
    `  ${c.name.padEnd(10)} gap ${fmt(s.post.mean)}  ` +
      `(${dGap <= 0 ? '' : '+'}${fmt(dGap)} vs no floor)   ` +
      `moved ${fmt(s.moved.mean, 1).padStart(5)} (${dMoved >= 0 ? '+' : ''}${fmt(dMoved, 1)})  ` +
      `${bar(s.moved.mean, maxMoved, 24)}`
  );
}

/* ─── Clan-block parity: does pricing it in scoreSwap() actually help? ─── */

/*
 * The question this whole harness exists to answer: docs/SCRAMBLE_BALANCE_
 * INVESTIGATION.md §7 found that non-house clan blocks of 3+ beat their rating
 * even on teams the scrambler itself built (post-scramble subset, n=132,
 * ΔlogLik 6.27, p<0.001). This checks whether pricing it (clanBlockPenaltyEnabled,
 * off by default in tb-scrambler.js) actually moves the scrambler's choices, on
 * these SAME real lobbies, holding churn identical to production.
 */
console.log('\n─── Clan-block parity: production vs clan-priced ───\n');
const prodRows = results.get('production');
const clanRows = results.get('clan-priced');
if (prodRows && clanRows && prodRows.length) {
  const prodImb = describe(prodRows.map((r) => r.postClanImbalance));
  const clanImb = describe(clanRows.map((r) => r.postClanImbalance));
  const preImb = describe(prodRows.map((r) => r.preClanImbalance));
  console.log(`  pre-scramble clan-block imbalance:  mean ${fmt(preImb.mean, 2)}, median ${fmt(preImb.median, 2)}`);
  console.log(
    `  production   post-scramble imbalance:  mean ${fmt(prodImb.mean, 2)}, median ${fmt(prodImb.median, 2)}, ` +
      `zero-imbalance ${fmt(prodRows.filter((r) => r.postClanImbalance === 0).length / prodRows.length * 100, 1)}%`
  );
  console.log(
    `  clan-priced  post-scramble imbalance:  mean ${fmt(clanImb.mean, 2)}, median ${fmt(clanImb.median, 2)}, ` +
      `zero-imbalance ${fmt(clanRows.filter((r) => r.postClanImbalance === 0).length / clanRows.length * 100, 1)}%`
  );
  const prodMu = describe(prodRows.map((r) => r.post));
  const clanMu = describe(clanRows.map((r) => r.post));
  const prodMoved = describe(prodRows.map((r) => r.moved));
  const clanMoved = describe(clanRows.map((r) => r.moved));
  console.log(
    `\n  mu gap after scramble:  production ${fmt(prodMu.mean)}   clan-priced ${fmt(clanMu.mean)}   ` +
      `(${clanMu.mean - prodMu.mean <= 0 ? '' : '+'}${fmt(clanMu.mean - prodMu.mean)})`
  );
  console.log(
    `  players moved:           production ${fmt(prodMoved.mean, 1)}   clan-priced ${fmt(clanMoved.mean, 1)}   ` +
      `(${clanMoved.mean - prodMoved.mean >= 0 ? '+' : ''}${fmt(clanMoved.mean - prodMoved.mean, 1)})`
  );
  const improved = clanRows.filter((r, i) => r.postClanImbalance < prodRows[i].postClanImbalance).length;
  const worsened = clanRows.filter((r, i) => r.postClanImbalance > prodRows[i].postClanImbalance).length;
  const same = clanRows.length - improved - worsened;
  console.log(
    `\n  lobby-by-lobby: clan-priced improves imbalance on ${improved}, worsens on ${worsened}, ` +
      `unchanged on ${same} (of ${clanRows.length})`
  );
} else {
  console.log('  (no data — run without --limit=0 or check config names)');
}

/* ─── Stayer-weighted parity: does reweighting scoreSwap() by P(stay)
 * actually help, on these same real lobbies, holding churn identical to
 * production? ───────────────────────────────────────────────────────────
 *
 * stayer-weighted-balance.js established weightedGap tracks the realized
 * ENDGAME gap better than naiveGap (r 0.848 vs 0.842, mean abs error 0.2321
 * vs 0.2544). That was a pre-round estimator comparison; this checks whether
 * pricing it into the scrambler's own search (stayerWeightingEnabled, off by
 * default) actually changes what it builds, judged on the SAME naive
 * (unweighted) yardstick production is judged on — since "weighted gap looks
 * smaller" is meaningless if it is only smaller because it is weighted.
 */
console.log('\n─── Stayer-weighted parity: production vs stayer-weighted ───\n');
const swRows = results.get('stayer-weighted');
if (prodRows && swRows && prodRows.length) {
  const prodNaive = describe(prodRows.map((r) => r.postNaiveGap));
  const swNaive = describe(swRows.map((r) => r.postNaiveGap));
  const prodMoved2 = describe(prodRows.map((r) => r.moved));
  const swMoved = describe(swRows.map((r) => r.moved));
  console.log(
    `  post-scramble mu gap (naive, everyone weighted equally — apples-to-apples):\n` +
      `    production        mean ${fmt(prodNaive.mean)}  median ${fmt(prodNaive.median)}\n` +
      `    stayer-weighted   mean ${fmt(swNaive.mean)}  median ${fmt(swNaive.median)}   ` +
      `(${swNaive.mean - prodNaive.mean <= 0 ? '' : '+'}${fmt(swNaive.mean - prodNaive.mean)})`
  );
  console.log(
    `\n  players moved:      production ${fmt(prodMoved2.mean, 1)}   stayer-weighted ${fmt(swMoved.mean, 1)}   ` +
      `(${swMoved.mean - prodMoved2.mean >= 0 ? '+' : ''}${fmt(swMoved.mean - prodMoved2.mean, 1)})`
  );
  const swBetter = swRows.filter((r, i) => r.postNaiveGap < prodRows[i].postNaiveGap - 1e-9).length;
  const prodBetter = swRows.filter((r, i) => r.postNaiveGap > prodRows[i].postNaiveGap + 1e-9).length;
  const same = swRows.length - swBetter - prodBetter;
  console.log(
    `\n  lobby-by-lobby (naive gap): stayer-weighted smaller on ${swBetter}, production smaller on ${prodBetter}, ` +
      `tied on ${same} (of ${swRows.length})`
  );
  const decisive = swBetter + prodBetter;
  if (decisive >= 20) {
    const se = Math.sqrt(0.25 / decisive);
    const z = (swBetter / decisive - 0.5) / se;
    console.log(`  sign test: z = ${fmt(z, 2)}  ${Math.abs(z) > 1.96 ? '← significant' : '(not distinguishable from a coin flip)'}`);
  }
} else {
  console.log('  (no data — run without --limit=0 or check config names)');
}

console.log('');
