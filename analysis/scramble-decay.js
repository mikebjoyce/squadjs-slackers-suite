/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      DOES THE SCRAMBLE SURVIVE UNTIL THE ROUND IS PLAYED?      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * scramble-replay.js establishes that the scrambler reaches a mean-mu gap of
 * ~0.09 at the moment it acts, and that this is insensitive to how many players
 * it is allowed to move. Yet the rounds that actually get played have a median
 * mu gap of ~0.42 — four times worse than what the scrambler hands over.
 *
 * Both numbers cannot describe the same teams. Either the scramble is not being
 * applied, or the balance it produces decays before the round is scored. This
 * measures which, by comparing the mu gap of rounds that were preceded by a
 * scramble against the mu gap of rounds that were not.
 *
 * If scrambled and unscrambled successors look alike, tuning the scrambler's
 * objective is pointless — the loss is downstream of it.
 *
 *   node --max-old-space-size=4096 analysis/scramble-decay.js
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
  fmt,
  bar
} from './load-export.js';

const DEFAULT_MU = 25.0;
/* A scramble at the end of round N applies to round N+1. Rounds run ~50min and
 * sit ~36min apart at the closest, so a 3h window finds the successor without
 * reaching past an empty server into an unrelated session. */
const SUCCESSOR_WINDOW_MS = 3 * 60 * 60 * 1000;

const exp = loadExport(newestExport());
const tbRounds = table(exp, 'TB_RoundReport');
const eloRounds = table(exp, 'Elo_RoundHistory');
const roundPlayers = table(exp, 'Elo_RoundPlayers');

const byRound = new Map();
for (const p of roundPlayers) {
  if (!byRound.has(p.roundHistoryId)) byRound.set(p.roundHistoryId, []);
  byRound.get(p.roundHistoryId).push(p);
}

/** Plugin arithmetic: every player, unrated substituted at 25.0. */
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

/* Usable played rounds, in time order. */
const played = eloRounds
  .filter((r) => isCompetitive(r.layerName) && Number.isFinite(r.endedAt))
  .map((r) => {
    const ps = byRound.get(r.id) || [];
    /* "Unrated" = still sitting on the default. A genuinely rated player can
     * land on 25.0 by coincidence, but only if sigma has also moved, so require
     * both to be untouched. */
    const unrated = ps.filter(
      (p) => p.muBefore === DEFAULT_MU && p.sigmaBefore > 8.3
    ).length;
    return {
      id: r.id,
      endedAt: r.endedAt,
      pop: effectivePopulation(ps),
      muDelta: muDeltaOf(ps),
      ticketDiff: Math.abs(r.ticketDiff),
      unratedShare: ps.length > 0 ? unrated / ps.length : NaN,
      roster: new Set(ps.map((p) => p.eosID)),
      n: ps.length
    };
  })
  .filter((r) => r.pop >= MIN_EFFECTIVE_PLAYERS && Number.isFinite(r.muDelta))
  .sort((a, b) => a.endedAt - b.endedAt);

/* Attach each played round to the balancer's decision that preceded it. */
const tbSorted = tbRounds
  .filter((r) => Number.isFinite(r.ts))
  .sort((a, b) => a.ts - b.ts);

function precedingDecision(round) {
  // The last TB round report strictly before this round ended, i.e. the
  // decision taken at the end of the previous round.
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

const scrambled = [];
const notScrambled = [];
for (let i = 0; i < played.length; i++) {
  const r = played[i];
  const d = precedingDecision(r);
  if (!d) continue;
  /* The previous round's margin is the confound control. Scrambles are
   * TRIGGERED by blowouts (Single Round Margin, Consecutive Wins), so a
   * scrambled round follows a lopsided one by construction, and regression to
   * the mean alone would make its successor look closer. Carry the predecessor
   * margin so the two groups can be compared at equal provocation. */
  const prev = i > 0 && r.endedAt - played[i - 1].endedAt <= SUCCESSOR_WINDOW_MS ? played[i - 1] : null;
  (d.scrambled ? scrambled : notScrambled).push({
    ...r,
    condition: d.scrambleCondition,
    prevTicketDiff: prev ? prev.ticketDiff : NaN,
    prevMuDelta: prev ? prev.muDelta : NaN
  });
}

console.log('\n═══ DID THE SCRAMBLE SURVIVE? ═══\n');
console.log(`  played rounds matched to a preceding decision: ${scrambled.length + notScrambled.length}`);
console.log(`    preceded by a scramble:     ${scrambled.length}`);
console.log(`    preceded by no scramble:    ${notScrambled.length}\n`);

function row(label, rows) {
  const d = describe(rows.map((r) => r.muDelta));
  const t = describe(rows.map((r) => r.ticketDiff));
  const q1 = rows.filter((r) => r.muDelta < 0.2).length / rows.length;
  console.log(
    `  ${label.padEnd(26)} ${String(d.n).padStart(4)}   ` +
      `${fmt(d.mean).padStart(5)}  ${fmt(d.median).padStart(6)}   ` +
      `${`${fmt(q1 * 100, 1)}%`.padStart(7)}   ` +
      `${fmt(t.mean, 1).padStart(6)}  ${fmt(t.median, 1).padStart(6)}`
  );
}

console.log('  group                        n     mu gap at round      still    ticket margin');
console.log('                                     mean   median        <0.20    mean   median');
row('after a scramble', scrambled);
row('after no scramble', notScrambled);

/*
 * The scrambler hands over ~0.09. Anything materially above that in the
 * "after a scramble" row is balance lost between the decision and the round.
 */
const s = describe(scrambled.map((r) => r.muDelta));
console.log(`\n  scrambler achieves at decision time:  0.09  (scramble-replay.js, n=793)`);
console.log(`  observed when the round is scored:    ${fmt(s.median)}  (median)`);
console.log(`  balance lost in between:              ${fmt(s.median - 0.09)}`);

/* ─── Confound control: were the two groups equally provoked? ────────────── */
console.log('\n─── Regression-to-the-mean control ───\n');
const pdS = describe(scrambled.map((r) => r.prevTicketDiff));
const pdN = describe(notScrambled.map((r) => r.prevTicketDiff));
console.log(`  margin of the round BEFORE the decision:`);
console.log(`    scrambled group:    mean ${fmt(pdS.mean, 1)}  median ${fmt(pdS.median, 1)}  (n=${pdS.n})`);
console.log(`    unscrambled group:  mean ${fmt(pdN.mean, 1)}  median ${fmt(pdN.median, 1)}  (n=${pdN.n})`);

/*
 * Restrict both groups to rounds that followed a comparable blowout. If the
 * scramble is doing real work the gap between them should survive; if it was
 * regression to the mean the two rows should converge.
 */
const BLOWOUT = 150;
const sB = scrambled.filter((r) => r.prevTicketDiff >= BLOWOUT);
const nB = notScrambled.filter((r) => r.prevTicketDiff >= BLOWOUT);
console.log(`\n  matched on provocation — both preceded by a >=${BLOWOUT} ticket blowout:`);
console.log('  group                        n     mu gap at round      still    ticket margin');
console.log('                                     mean   median        <0.20    mean   median');
row('after a scramble', sB);
row('after no scramble', nB);

/* ─── Where does it go? Roster turnover between decision and scoring ─────── */
console.log('\n─── Roster turnover, round N → round N+1 ───\n');

const turnovers = [];
for (let i = 1; i < played.length; i++) {
  const prev = played[i - 1];
  const cur = played[i];
  if (cur.endedAt - prev.endedAt > SUCCESSOR_WINDOW_MS) continue;
  let stayed = 0;
  for (const id of cur.roster) if (prev.roster.has(id)) stayed++;
  turnovers.push({
    churn: 1 - stayed / cur.roster.size,
    muDelta: cur.muDelta,
    unratedShare: cur.unratedShare,
    newPlayers: cur.roster.size - stayed
  });
}
const tc = describe(turnovers.map((t) => t.churn));
const np = describe(turnovers.map((t) => t.newPlayers));
console.log(`  consecutive round pairs: ${tc.n}`);
console.log(
  `  share of the next round's roster that was NOT in the previous round: ` +
    `median ${fmt(tc.median * 100, 1)}%  (p25 ${fmt(tc.p25 * 100, 1)}%, p75 ${fmt(tc.p75 * 100, 1)}%)`
);
console.log(`  absolute new faces per round: median ${fmt(np.median, 1)}, p75 ${fmt(np.p75, 1)}`);

const c = correlation(turnovers.map((t) => t.churn), turnovers.map((t) => t.muDelta));
console.log(`\n  r(roster turnover, resulting mu gap) = ${fmt(c.r, 3)}  (n=${c.n})`);

/*
 * That sign is backwards — more turnover should not produce BETTER balance —
 * so treat it as an artifact until proven otherwise. The obvious mechanism:
 * unrated players are substituted at exactly mu = 25.0, the population mean, so
 * every one of them drags both team averages toward the same point and shrinks
 * the measured gap. A high-turnover round is full of newcomers, hence full of
 * 25.0s, hence "balanced" by construction rather than in fact.
 *
 * If that is what is happening, turnover should predict unrated share strongly,
 * and the turnover→gap relationship should collapse once we look only at rounds
 * with good rating coverage.
 */
const cr = correlation(turnovers.map((t) => t.churn), turnovers.map((t) => t.unratedShare));
console.log(`  r(roster turnover, unrated share)    = ${fmt(cr.r, 3)}`);
console.log(`  r(unrated share, resulting mu gap)   = ${fmt(correlation(turnovers.map((t) => t.unratedShare), turnovers.map((t) => t.muDelta)).r, 3)}`);

const wellRated = turnovers.filter((t) => t.unratedShare <= 0.10);
if (wellRated.length > 30) {
  const cw = correlation(wellRated.map((t) => t.churn), wellRated.map((t) => t.muDelta));
  console.log(
    `\n  restricted to rounds with <=10% unrated (n=${cw.n}): ` +
      `r(turnover, mu gap) = ${fmt(cw.r, 3)}`
  );
}

/* Dose-response is more informative than r alone when the relationship may be
 * threshold-shaped rather than linear. */
const sorted = [...turnovers].sort((a, b) => a.churn - b.churn);
const qsize = Math.floor(sorted.length / 4);
console.log('\n  turnover quartile → resulting mu gap:');
for (let q = 0; q < 4; q++) {
  const slice = sorted.slice(q * qsize, q === 3 ? sorted.length : (q + 1) * qsize);
  const d = describe(slice.map((x) => x.muDelta));
  const lo = fmt(slice[0].churn * 100, 1);
  const hi = fmt(slice[slice.length - 1].churn * 100, 1);
  console.log(
    `    Q${q + 1}  turnover ${`${lo}–${hi}%`.padEnd(14)} ` +
      `mu gap mean ${fmt(d.mean)}  median ${fmt(d.median)}  (n=${d.n})  ${bar(d.mean * 100, 60, 20)}`
  );
}

/* ─── How often does the balancer even act? ─────────────────────────────── */
console.log('\n─── Intervention rate ───\n');
const competitiveTb = tbRounds.filter((r) => isCompetitive(r.layerName));
const scr = competitiveTb.filter((r) => r.scrambled).length;
console.log(`  RAAS rounds recorded by the balancer: ${competitiveTb.length}`);
console.log(`  of those, scrambled:                  ${scr} (${fmt((scr / competitiveTb.length) * 100, 1)}%)`);
console.log(`  left alone:                           ${competitiveTb.length - scr}`);

console.log('');
