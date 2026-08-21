/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       WHEN DO SMARTASSIGN MOVES FAIL? (ROUND-PHASE TEST)       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * 13.4% of SmartAssign's attempted moves fail, steadily, with a `reason` of
 * just "Failed". The proposed explanation: they cluster in the endgame, where
 * Squad's own team-change restrictions reject the RCON move, and which is also
 * the highest-churn period so it sees the most attempts.
 *
 * That is two separable claims and they need separating, because the second one
 * predicts more FAILURES in the endgame purely from volume without the failure
 * RATE changing at all. Only a rate that climbs toward round end supports the
 * restriction mechanism.
 *
 * SA_AssignmentLog carries roundStartTime, and round end comes from
 * TB_RoundReport (written for every ROUND_ENDED), so every attempt can be
 * placed on a round timeline and bucketed by phase.
 *
 *   node --max-old-space-size=4096 analysis/smartassign-failures.js
 */

import { newestExport, loadExport, table, describe, fmt, bar } from './load-export.js';

const exp = loadExport(newestExport());
const saLog = table(exp, 'SA_AssignmentLog');
const tbRounds = table(exp, 'TB_RoundReport');

console.log('\n═══ SMARTASSIGN FAILURES BY ROUND PHASE ═══\n');

/* ─── Round boundaries ─────────────────────────────────────────────────── */

/* TB_RoundReport records both the round start it observed and the end. Index by
 * matchId, and keep a time-sorted list for the rows SA references by a
 * roundStartTime that never produced a matching report. */
const endByMatch = new Map();
const startByMatch = new Map();
for (const r of tbRounds) {
  if (!r.matchId) continue;
  if (Number.isFinite(r.ts)) endByMatch.set(r.matchId, r.ts);
  if (Number.isFinite(r.roundStartTime)) startByMatch.set(r.matchId, r.roundStartTime);
}

const endsSorted = tbRounds
  .filter((r) => Number.isFinite(r.ts))
  .map((r) => r.ts)
  .sort((a, b) => a - b);

/** First round end at or after `ts` — the end of the round an event sits in. */
function nextEndAfter(ts) {
  let lo = 0;
  let hi = endsSorted.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (endsSorted[mid] >= ts) {
      best = endsSorted[mid];
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return best;
}

/* ─── Place each attempt on its round timeline ─────────────────────────── */

const events = [];
const skipped = { noTs: 0, noEnd: 0, noStart: 0, implausible: 0 };

for (const r of saLog) {
  const ts = Number(r.ts);
  if (!Number.isFinite(ts)) {
    skipped.noTs++;
    continue;
  }
  const start = Number.isFinite(Number(r.roundStartTime))
    ? Number(r.roundStartTime)
    : startByMatch.get(r.matchId);
  if (!Number.isFinite(start)) {
    skipped.noStart++;
    continue;
  }
  const end = endByMatch.get(r.matchId) ?? nextEndAfter(ts);
  if (!Number.isFinite(end)) {
    skipped.noEnd++;
    continue;
  }
  const duration = end - start;
  // Guard against mismatched joins producing absurd rounds.
  if (duration <= 5 * 60_000 || duration > 3 * 60 * 60_000) {
    skipped.implausible++;
    continue;
  }
  events.push({
    failed: r.eventType === 'MOVE_FAILED',
    sinceStart: ts - start,
    toEnd: end - ts,
    frac: (ts - start) / duration,
    duration
  });
}

console.log(`  attempts placed on a round timeline: ${events.length} of ${saLog.length}`);
console.log(
  `  skipped — no ts ${skipped.noTs}, no round start ${skipped.noStart}, ` +
    `no round end ${skipped.noEnd}, implausible round ${skipped.implausible}`
);

const overall = events.filter((e) => e.failed).length / events.length;
console.log(`  overall failure rate: ${fmt(overall * 100, 1)}%\n`);

/* ─── Rate vs volume, by time remaining in the round ───────────────────── */

/*
 * Bucketing by TIME REMAINING rather than elapsed is the right frame: the
 * hypothesis is about proximity to round end, and rounds vary in length.
 * Negative remaining time means the attempt landed after the round report —
 * i.e. between rounds, during the map change and staging — which is the other
 * window where Squad is known to reject moves.
 */
const BUCKETS = [
  ['after round end', -Infinity, 0],
  ['final 60s', 0, 60_000],
  ['60s–3m left', 60_000, 180_000],
  ['3m–6m left', 180_000, 360_000],
  ['6m–12m left', 360_000, 720_000],
  ['12m–25m left', 720_000, 1_500_000],
  ['>25m left', 1_500_000, Infinity]
];

console.log('─── Failure rate by time remaining in the round ───\n');
console.log('  window             attempts   failed   rate     vs overall');
const maxAttempts = Math.max(
  ...BUCKETS.map(([, lo, hi]) => events.filter((e) => e.toEnd >= lo && e.toEnd < hi).length)
);
for (const [label, lo, hi] of BUCKETS) {
  const inB = events.filter((e) => e.toEnd >= lo && e.toEnd < hi);
  if (inB.length === 0) continue;
  const f = inB.filter((e) => e.failed).length;
  const rate = f / inB.length;
  const lift = rate / overall;
  console.log(
    `  ${label.padEnd(18)} ${String(inB.length).padStart(7)}  ${String(f).padStart(7)}  ` +
      `${`${fmt(rate * 100, 1)}%`.padStart(6)}   ${`${fmt(lift, 2)}x`.padStart(6)}  ` +
      `${bar(inB.length, maxAttempts, 20)}`
  );
}

/* ─── Same question from the other end: elapsed since round start ──────── */

console.log('\n─── Failure rate by time since round start ───\n');
const START_BUCKETS = [
  ['first 60s', 0, 60_000],
  ['1m–4m (staging)', 60_000, 250_000],
  ['4m–10m', 250_000, 600_000],
  ['10m–25m', 600_000, 1_500_000],
  ['25m+', 1_500_000, Infinity]
];
console.log('  window             attempts   failed   rate     vs overall');
for (const [label, lo, hi] of START_BUCKETS) {
  const inB = events.filter((e) => e.sinceStart >= lo && e.sinceStart < hi);
  if (inB.length === 0) continue;
  const f = inB.filter((e) => e.failed).length;
  const rate = f / inB.length;
  console.log(
    `  ${label.padEnd(18)} ${String(inB.length).padStart(7)}  ${String(f).padStart(7)}  ` +
      `${`${fmt(rate * 100, 1)}%`.padStart(6)}   ${`${fmt(rate / overall, 2)}x`.padStart(6)}`
  );
}

/* ─── Deciles, so the shape is not imposed by bucket choice ────────────── */

console.log('\n─── Failure rate across the round, in tenths ───\n');
const inRound = events.filter((e) => e.frac >= 0 && e.frac <= 1);
console.log('  decile of round     attempts   failed   rate');
for (let d = 0; d < 10; d++) {
  const lo = d / 10;
  const hi = (d + 1) / 10;
  const inB = inRound.filter((e) => e.frac >= lo && (d === 9 ? e.frac <= hi : e.frac < hi));
  if (inB.length === 0) continue;
  const f = inB.filter((e) => e.failed).length;
  const rate = f / inB.length;
  console.log(
    `  ${`${d * 10}–${(d + 1) * 10}%`.padEnd(18)} ${String(inB.length).padStart(7)}  ` +
      `${String(f).padStart(7)}  ${`${fmt(rate * 100, 1)}%`.padStart(6)}  ${bar(rate * 100, 40, 24)}`
  );
}

/* ─── Volume vs rate: which claim does the data support? ───────────────── */

console.log('\n─── Volume or rate? ───\n');
const LATE_MS = 180_000;
const late = events.filter((e) => e.toEnd < LATE_MS);
const early = events.filter((e) => e.toEnd >= LATE_MS);
const lateRate = late.filter((e) => e.failed).length / (late.length || 1);
const earlyRate = early.filter((e) => e.failed).length / (early.length || 1);

console.log(`  attempts in the last 3 minutes (incl. post-end): ${late.length} (${fmt((late.length / events.length) * 100, 1)}% of all)`);
console.log(`  failure rate there:                              ${fmt(lateRate * 100, 1)}%`);
console.log(`  failure rate everywhere else:                    ${fmt(earlyRate * 100, 1)}%`);

const lateFails = late.filter((e) => e.failed).length;
const allFails = events.filter((e) => e.failed).length;
console.log(`\n  share of ALL failures occurring in that window:  ${fmt((lateFails / allFails) * 100, 1)}%`);

/* Two-proportion z-test — the buckets are large enough that eyeballing a
 * difference of a few points is not good enough. */
const p = allFails / events.length;
const se = Math.sqrt(p * (1 - p) * (1 / (late.length || 1) + 1 / (early.length || 1)));
const z = se > 0 ? (lateRate - earlyRate) / se : NaN;
console.log(`  z = ${fmt(z, 2)} ${Math.abs(z) > 2 ? '← significant' : '← not significant'}`);

const dur = describe(events.map((e) => e.duration / 60000));
console.log(`\n  (round length seen by these events: median ${fmt(dur.median, 1)} min)`);

/* ─── The post-end window in detail ────────────────────────────────────────
 *
 * Nearly every failure lands after ROUND_ENDED, so the actionable question is
 * how long the rejection lasts. Squad runs map travel and then a staging period
 * (RAAS/AAS 4m10s) before the next round goes live; if moves recover partway
 * through that, a fixed defer is enough, and if they only recover at round
 * live, SmartAssign needs to wait on the round-live event instead of a timer.
 */
console.log('\n─── Inside the post-round-end window ───\n');
const post = events.filter((e) => e.toEnd < 0).map((e) => ({ ...e, after: -e.toEnd }));
const POST_BUCKETS = [
  ['0–30s', 0, 30_000],
  ['30–60s', 30_000, 60_000],
  ['1–2m', 60_000, 120_000],
  ['2–3m', 120_000, 180_000],
  ['3–4m', 180_000, 240_000],
  ['4–5m', 240_000, 300_000],
  ['5–7m', 300_000, 420_000],
  ['7m+', 420_000, Infinity]
];
console.log('  time after round end   attempts   failed   rate');
for (const [label, lo, hi] of POST_BUCKETS) {
  const inB = post.filter((e) => e.after >= lo && e.after < hi);
  if (inB.length === 0) continue;
  const f = inB.filter((e) => e.failed).length;
  const rate = f / inB.length;
  console.log(
    `  ${label.padEnd(22)} ${String(inB.length).padStart(7)}  ${String(f).padStart(7)}  ` +
      `${`${fmt(rate * 100, 1)}%`.padStart(6)}  ${bar(rate * 100, 100, 24)}`
  );
}

const pd = describe(post.map((e) => e.after / 60000));
console.log(
  `\n  attempts land ${fmt(pd.median, 1)} min after round end (median), ` +
    `p95 ${fmt(pd.p95, 1)} min`
);
console.log('');
