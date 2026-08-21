/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   WHY BALANCE DECAYS: POST-SCRAMBLE CHURN AND SMART ASSIGN     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * The scrambler hands over a 0.09 mu gap; rounds are played at 0.25. Two
 * proposed mechanisms, both testable here:
 *
 *   1. Players leave after a scramble and strangers replace them. If so,
 *      roster turnover should be measurably HIGHER following a scramble than
 *      following a quiet round end.
 *   2. SmartAssign is what claws parity back as those newcomers arrive, and it
 *      has not always been running. SA_AssignmentLog begins 2026-07-01 and runs
 *      continuously afterwards, while the round data starts 2026-05-23 — a
 *      sharp activation partitioning the window into a natural experiment.
 *
 * ─── THE CONFOUND THAT WILL MISLEAD YOU HERE ─────────────────────
 *
 * A naive era comparison is worse than no comparison. Unrated players are
 * substituted at exactly mu = 25.0, so they shrink the MEASURED gap without
 * changing the real one. Rating coverage improves monotonically over time, so
 * the later era necessarily shows LARGER measured gaps for reasons that have
 * nothing to do with SmartAssign. Every era comparison below is therefore also
 * reported restricted to well-rated rounds, and the unrated share is printed
 * for both eras so the size of the bias is visible rather than assumed.
 *
 *   node --max-old-space-size=4096 analysis/smartassign-era.js
 */

import {
  newestExport,
  loadExport,
  table,
  describe,
  isCompetitive,
  effectivePopulation,
  MIN_EFFECTIVE_PLAYERS,
  correlation,
  fmt
} from './load-export.js';

const DEFAULT_MU = 25.0;
const SUCCESSOR_WINDOW_MS = 3 * 60 * 60 * 1000;
const WELL_RATED_MAX_UNRATED = 0.10;

const exp = loadExport(newestExport());
const eloRounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');
const tbRounds = table(exp, 'TB_RoundReport');
const saLog = table(exp, 'SA_AssignmentLog');

/* ─── When did SmartAssign come online? ────────────────────────────────── */

const saTs = saLog.map((r) => Number(r.ts)).filter(Number.isFinite).sort((a, b) => a - b);
const SA_START = saTs[0];

console.log('\n═══ POST-SCRAMBLE CHURN AND SMART ASSIGN ═══\n');
console.log(`  SmartAssign first assignment: ${new Date(SA_START).toISOString()}`);
console.log(`  last assignment:              ${new Date(saTs[saTs.length - 1]).toISOString()}`);

const evTypes = new Map();
for (const r of saLog) evTypes.set(r.eventType, (evTypes.get(r.eventType) || 0) + 1);
console.log('\n  assignment log event types:');
for (const [k, v] of [...evTypes].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(k).padEnd(22)} ${String(v).padStart(6)}`);
}

/* ─── Round-level facts ────────────────────────────────────────────────── */

const byRound = new Map();
for (const p of roundPlayers) {
  if (!byRound.has(p.roundHistoryId)) byRound.set(p.roundHistoryId, []);
  byRound.get(p.roundHistoryId).push(p);
}

function muDeltaOf(ps) {
  let t1 = 0;
  let n1 = 0;
  let t2 = 0;
  let n2 = 0;
  for (const p of ps) {
    const mu = Number.isFinite(p.muBefore) ? p.muBefore : DEFAULT_MU;
    if (p.teamID === 1) {
      t1 += mu;
      n1++;
    } else if (p.teamID === 2) {
      t2 += mu;
      n2++;
    }
  }
  if (n1 === 0 || n2 === 0) return NaN;
  return Math.abs(t1 / n1 - t2 / n2);
}

const played = eloRounds
  .filter((r) => isCompetitive(r.layerName) && Number.isFinite(r.endedAt))
  .map((r) => {
    const ps = byRound.get(r.id) || [];
    const unrated = ps.filter((p) => p.muBefore === DEFAULT_MU && p.sigmaBefore > 8.3).length;
    return {
      id: r.id,
      endedAt: r.endedAt,
      pop: effectivePopulation(ps),
      muDelta: muDeltaOf(ps),
      ticketDiff: Math.abs(r.ticketDiff),
      unratedShare: ps.length > 0 ? unrated / ps.length : NaN,
      roster: new Set(ps.map((p) => p.eosID)),
      era: r.endedAt >= SA_START ? 'with SA' : 'before SA'
    };
  })
  .filter((r) => r.pop >= MIN_EFFECTIVE_PLAYERS && Number.isFinite(r.muDelta))
  .sort((a, b) => a.endedAt - b.endedAt);

/* Attach the balancer decision that preceded each round. */
const tbSorted = tbRounds.filter((r) => Number.isFinite(r.ts)).sort((a, b) => a.ts - b.ts);
function precedingDecision(round) {
  let lo = 0;
  let hi = tbSorted.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tbSorted[mid].ts < round.endedAt - 60_000) {
      best = tbSorted[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (!best) return null;
  return round.endedAt - best.ts <= SUCCESSOR_WINDOW_MS ? best : null;
}

/* Consecutive pairs, so turnover can be attributed to the decision between. */
const pairs = [];
for (let i = 1; i < played.length; i++) {
  const prev = played[i - 1];
  const cur = played[i];
  if (cur.endedAt - prev.endedAt > SUCCESSOR_WINDOW_MS) continue;
  const d = precedingDecision(cur);
  if (!d) continue;
  let stayed = 0;
  for (const id of cur.roster) if (prev.roster.has(id)) stayed++;
  pairs.push({
    era: cur.era,
    scrambled: !!d.scrambled,
    churn: 1 - stayed / cur.roster.size,
    left: prev.roster.size - stayed,
    joined: cur.roster.size - stayed,
    muDelta: cur.muDelta,
    prevMuDelta: prev.muDelta,
    unratedShare: cur.unratedShare,
    ticketDiff: cur.ticketDiff,
    prevTicketDiff: prev.ticketDiff
  });
}

console.log(`\n  usable consecutive round pairs: ${pairs.length}`);
const byEra = { 'before SA': pairs.filter((p) => p.era === 'before SA'), 'with SA': pairs.filter((p) => p.era === 'with SA') };
console.log(`    before SA: ${byEra['before SA'].length}    with SA: ${byEra['with SA'].length}`);

/* ─── 1. Do players leave after a scramble? ────────────────────────────── */

console.log('\n─── Does a scramble drive people off the server? ───\n');
console.log('  group                      n     roster turnover      players lost');
console.log('                                   mean     median      mean   median');
for (const [label, rows] of [
  ['after a scramble', pairs.filter((p) => p.scrambled)],
  ['after no scramble', pairs.filter((p) => !p.scrambled)]
]) {
  const c = describe(rows.map((r) => r.churn));
  const l = describe(rows.map((r) => r.left));
  console.log(
    `  ${label.padEnd(24)} ${String(c.n).padStart(4)}   ` +
      `${`${fmt(c.mean * 100, 1)}%`.padStart(6)}  ${`${fmt(c.median * 100, 1)}%`.padStart(7)}     ` +
      `${fmt(l.mean, 1).padStart(5)}  ${fmt(l.median, 1).padStart(6)}`
  );
}

/*
 * A scramble follows a blowout, and a blowout drives people off by itself, so
 * the comparison above is confounded exactly as the mu-gap one was. Match on
 * provocation before concluding anything about the scramble specifically.
 */
const BLOWOUT = 150;
console.log(`\n  matched — both preceded by a >=${BLOWOUT} ticket blowout:`);
console.log('  group                      n     roster turnover      players lost');
console.log('                                   mean     median      mean   median');
for (const [label, rows] of [
  ['after a scramble', pairs.filter((p) => p.scrambled && p.prevTicketDiff >= BLOWOUT)],
  ['after no scramble', pairs.filter((p) => !p.scrambled && p.prevTicketDiff >= BLOWOUT)]
]) {
  const c = describe(rows.map((r) => r.churn));
  const l = describe(rows.map((r) => r.left));
  console.log(
    `  ${label.padEnd(24)} ${String(c.n).padStart(4)}   ` +
      `${`${fmt(c.mean * 100, 1)}%`.padStart(6)}  ${`${fmt(c.median * 100, 1)}%`.padStart(7)}     ` +
      `${fmt(l.mean, 1).padStart(5)}  ${fmt(l.median, 1).padStart(6)}`
  );
}

/* ─── 2. The SmartAssign era comparison ────────────────────────────────── */

console.log('\n─── Rating coverage by era (read this before the next table) ───\n');
for (const [era, rows] of Object.entries(byEra)) {
  const u = describe(rows.map((r) => r.unratedShare));
  console.log(
    `  ${era.padEnd(12)} unrated share: mean ${`${fmt(u.mean * 100, 1)}%`.padStart(6)}  ` +
      `median ${`${fmt(u.median * 100, 1)}%`.padStart(6)}   (n=${u.n})`
  );
}
console.log(
  '\n  Higher unrated share => smaller MEASURED gap, independent of real balance.\n' +
    '  Any era with better coverage is penalised by this metric.'
);

function eraTable(label, filter) {
  console.log(`\n  ${label}`);
  console.log('  era          scrambled?    n     mu gap          ticket margin    turnover');
  console.log('                                   mean   median   mean   median    mean');
  for (const era of ['before SA', 'with SA']) {
    for (const scr of [true, false]) {
      const rows = pairs.filter((p) => p.era === era && p.scrambled === scr && filter(p));
      if (rows.length === 0) continue;
      const d = describe(rows.map((r) => r.muDelta));
      const t = describe(rows.map((r) => r.ticketDiff));
      const c = describe(rows.map((r) => r.churn));
      console.log(
        `  ${era.padEnd(12)} ${(scr ? 'scrambled' : 'left alone').padEnd(12)} ${String(d.n).padStart(4)}  ` +
          `${fmt(d.mean).padStart(5)}  ${fmt(d.median).padStart(6)}   ` +
          `${fmt(t.mean, 1).padStart(5)}  ${fmt(t.median, 1).padStart(6)}    ` +
          `${`${fmt(c.mean * 100, 1)}%`.padStart(6)}`
      );
    }
  }
}

console.log('\n─── Balance by era ───');
eraTable('ALL rounds (contaminated by the coverage difference above):', () => true);
eraTable(
  `WELL-RATED rounds only (<=${WELL_RATED_MAX_UNRATED * 100}% unrated) — the fair comparison:`,
  (p) => p.unratedShare <= WELL_RATED_MAX_UNRATED
);

/* ─── 3. Is SmartAssign actually absorbing the inflow? ─────────────────── */

console.log('\n─── Does SmartAssign cover the inflow it would need to? ───\n');

const saByRound = new Map();
for (const r of saLog) {
  if (r.eventType !== 'MOVE_SUCCESS') continue;
  const k = r.matchId;
  if (!k) continue;
  saByRound.set(k, (saByRound.get(k) || 0) + 1);
}
const moveTotal = [...saByRound.values()].reduce((a, b) => a + b, 0);
const saRounds = saByRound.size;
const withSaPairs = byEra['with SA'];
const joined = describe(withSaPairs.map((p) => p.joined));

/*
 * Careful with the denominator here. SmartAssign runs its pipeline on EVERY
 * S3_PLAYER_JOINED, but SA_AssignmentLog only records MOVE_SUCCESS and
 * MOVE_FAILED — there is no row for "evaluated, already on the right team".
 * So this is its INTERVENTION rate, not its coverage: the share of arrivals it
 * judged to be on the wrong side. A player left in place is indistinguishable
 * here from a player never seen, which is itself a gap in the logging.
 */
const failed = evTypes.get('MOVE_FAILED') || 0;
console.log(`  rounds with at least one successful assignment: ${saRounds}`);
console.log(`  successful moves per such round:                ${fmt(moveTotal / saRounds, 1)}`);
console.log(`  new faces arriving per round (SA era):          ${fmt(joined.mean, 1)} mean, ${fmt(joined.median, 1)} median`);
console.log(
  `\n  => SmartAssign MOVES roughly ${fmt((moveTotal / saRounds / joined.mean) * 100, 0)}% ` +
    'of the players arriving between rounds.'
);
console.log(
  `  It evaluates all of them, but only moves is logged, so the rest cannot be\n` +
    `  split into "correctly left alone" versus "never processed".`
);
console.log(
  `\n  attempted moves that failed: ${failed} of ${failed + moveTotal} ` +
    `(${fmt((failed / (failed + moveTotal)) * 100, 1)}%)`
);

/*
 * If SmartAssign is meaningfully counteracting turnover, then within its era
 * the turnover -> mu gap relationship should be flatter than before it. Compare
 * on well-rated rounds only, for the coverage reason above.
 */
console.log('\n─── Turnover sensitivity, well-rated rounds only ───\n');
for (const era of ['before SA', 'with SA']) {
  const rows = pairs.filter((p) => p.era === era && p.unratedShare <= WELL_RATED_MAX_UNRATED);
  if (rows.length < 30) {
    console.log(`  ${era.padEnd(12)} n=${rows.length} — too few well-rated rounds to compare`);
    continue;
  }
  const c = correlation(rows.map((r) => r.churn), rows.map((r) => r.muDelta));
  console.log(`  ${era.padEnd(12)} r(turnover, mu gap) = ${fmt(c.r, 3)}   (n=${c.n})`);
}

console.log('');
