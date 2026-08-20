/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      TB SCRAMBLER — ELO PARITY vs SQUAD ATOMICITY             ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Pins the two halves of one rule. With `eloMap` supplied, the scrambler
 * scores candidates on ELO parity — but squad atomicity outranks it. A
 * skill stack spread across several squads must be broken up; the same
 * stack inside ONE squad must be left alone, because moving it whole would
 * wreck the count balance and decomposing it is forbidden outright:
 *
 *     "Squads are never decomposed — friend groups stay together."
 *       — tb-scrambler.js
 *
 * Both directions matter. Asserting only the first would pass an
 * implementation that quietly split squads to chase parity; asserting only
 * the second would pass an implementation that never moved anyone.
 *
 * ─── THE SCRAMBLER IS RANDOMISED ─────────────────────────────────
 *
 * scrambleTeamsPreservingSquads() is a randomised search — it shuffles the
 * squad lists and draws swap sizes from Math.random() across 2000
 * iterations, with no seed parameter. Identical input therefore yields
 * different plans on different runs; on some runs it returns no moves at
 * all. Any assertion made against a single call is flaky by construction,
 * which is a large part of why this plugin never acquired a stable suite.
 *
 * So the outcome assertions run the scenario TRIALS times and assert on the
 * distribution, while the two hard invariants — no squad is ever split, and
 * an atomic 15-man stack is never moved — are asserted on every single run,
 * because "usually" is not what an invariant means.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-tb-elo-scramble.js
 *
 * ─── HISTORY ─────────────────────────────────────────────────────
 *
 * Replaces elo-integration-test.js, which was unrunnable (its Logger import
 * was one `../` short, so it died on load in both the source tree and a
 * deployed target). Once that was fixed it turned out to assert something
 * impossible by construction: it put all 15 pros in a single squad and then
 * required that 5 of them move. Under squad atomicity the only legal move
 * is the whole 15-man squad, which takes a level 50/50 to 35/65 and is
 * correctly refused — so its "❌ FAILURE" was the algorithm behaving
 * exactly as specified. It also exited 0 on failure, so no runner could
 * have caught it either way.
 *
 * That scenario is kept below as the atomicity case, where it asserts the
 * true expectation instead of the false one.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Pure logic. tb-scrambler.js imports only Logger, so no sandbox,
 *   no server, no database.
 * - Moves carry `targetTeamID` as a STRING ('1'/'2') — the scrambler
 *   stringifies every team id internally. Comparing against a number
 *   silently counts zero moves.
 *
 */

import assert from 'node:assert/strict';

import { Scrambler } from '../utils/tb-scrambler.js';

// Chosen so both teams start with EXACTLY equal mean ELO:
//   team 1 = (15×39 + 35×19) / 50 = 1250/50 = 25.0
//   team 2 = 50×25 / 50           = 25.0
// ...while the top-15 average differs by 14 points (39.0 vs 25.0). This is
// the "a mean-only algorithm would do nothing" case the original test was
// reaching for; its own numbers (35/15/25) gave team 1 a mean of 21.0, not
// the 25.0 its comment claimed, so the premise never held.
const PRO_MU = 39.0;
const NOOB_MU = 19.0;
const AVG_MU = 25.0;

/** Runs per randomised scenario. High enough to be stable, low enough to stay fast. */
const TRIALS = 25;
/** Share of trials that must show the wanted behaviour. */
const THRESHOLD = 0.8;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (err) {
    results.push(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * Team 1 = 15 pros + 35 newbies. Team 2 = 50 averages.
 * @param {number} proSquadCount - how many squads the 15 pros are split across
 */
function buildStack(proSquadCount) {
  const players = [];
  const eloMap = new Map();
  const squads = [];

  const perSquad = 15 / proSquadCount;
  assert.equal(perSquad % 1, 0, 'pros must divide evenly across squads');

  for (let i = 0; i < 15; i++) {
    const id = `pro_${i}`;
    const squadID = 101 + Math.floor(i / perSquad);
    players.push({ eosID: id, teamID: 1, squadID, name: `Pro_${i}` });
    eloMap.set(id, { mu: PRO_MU, roundsPlayed: 50 });
  }
  for (let s = 0; s < proSquadCount; s++) {
    const squadID = 101 + s;
    squads.push({
      id: squadID,
      teamID: 1,
      players: players.filter((p) => p.squadID === squadID).map((p) => p.eosID),
      locked: false
    });
  }

  for (let i = 0; i < 35; i++) {
    const id = `noob_${i}`;
    players.push({ eosID: id, teamID: 1, squadID: null, name: `Noob_${i}` });
    eloMap.set(id, { mu: NOOB_MU, roundsPlayed: 50 });
  }
  for (let i = 0; i < 50; i++) {
    const id = `avg_${i}`;
    players.push({ eosID: id, teamID: 2, squadID: null, name: `Avg_${i}` });
    eloMap.set(id, { mu: AVG_MU, roundsPlayed: 50 });
  }

  return { players, squads, eloMap };
}

/** Apply a move plan and report the resulting team composition. */
function applyPlan(players, eloMap, plan) {
  const moved = new Map(plan.map((m) => [m.eosID, String(m.targetTeamID)]));
  const teams = { 1: [], 2: [] };
  for (const p of players) {
    teams[Number(moved.get(p.eosID) ?? p.teamID)].push(eloMap.get(p.eosID).mu);
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const top15 = (xs) => mean([...xs].sort((a, b) => b - a).slice(0, 15));
  return {
    counts: { 1: teams[1].length, 2: teams[2].length },
    meanDiff: Math.abs(mean(teams[1]) - mean(teams[2])),
    top15Diff: Math.abs(top15(teams[1]) - top15(teams[2]))
  };
}

/**
 * The scrambler's own composite: mean diff and top-15 diff, weighted 50/50.
 * Asserting on this rather than on mean alone matters — team 1 holds both the
 * best AND the worst players, so pulling a pro squad out necessarily WIDENS
 * the mean gap while closing the top-15 gap. An assertion that demanded both
 * improve would fail against a correct implementation.
 */
const composite = (m) => 0.5 * m.meanDiff + 0.5 * m.top15Diff;

async function trial(proSquadCount) {
  const { players, squads, eloMap } = buildStack(proSquadCount);
  const before = applyPlan(players, eloMap, []);
  const plan = await Scrambler.scrambleTeamsPreservingSquads({
    squads,
    players,
    winStreakTeam: 1,
    scramblePercentage: 0.2,
    eloMap
  });
  return { players, squads, eloMap, plan, before, after: applyPlan(players, eloMap, plan) };
}

// ── 1. a stack spread across three squads ────────────────────────────────────
{
  const runs = [];
  for (let i = 0; i < TRIALS; i++) runs.push(await trial(3));

  const movedPros = runs.map(
    (r) => r.plan.filter((m) => m.eosID.startsWith('pro') && m.targetTeamID === '2').length
  );

  await test(`pros split across 3 squads are moved in >=${THRESHOLD * 100}% of runs`, async () => {
    const hits = movedPros.filter((n) => n >= 5).length;
    assert.ok(
      hits >= TRIALS * THRESHOLD,
      `only ${hits}/${TRIALS} runs moved a full pro squad (counts: ${movedPros.join(',')})`
    );
  });

  await test('pros only ever move a whole squad at a time', async () => {
    // Every run, not most: a non-multiple of 5 means a squad was decomposed.
    for (const [i, n] of movedPros.entries()) {
      assert.equal(n % 5, 0, `run ${i}: ${n} pros moved — not a whole number of squads`);
    }
  });

  await test(`breaking the stack improves ELO parity in >=${THRESHOLD * 100}% of runs`, async () => {
    const improved = runs.filter((r) => composite(r.after) < composite(r.before)).length;
    assert.ok(
      improved >= TRIALS * THRESHOLD,
      `parity improved in only ${improved}/${TRIALS} runs ` +
      `(e.g. ${composite(runs[0].before).toFixed(2)} -> ${composite(runs[0].after).toFixed(2)})`
    );
    // And the term that actually distinguishes these teams must close.
    const closer = runs.filter((r) => r.after.top15Diff < r.before.top15Diff).length;
    assert.ok(closer >= TRIALS * THRESHOLD, `top-15 gap closed in only ${closer}/${TRIALS} runs`);
  });

  await test('count balance is never sacrificed for parity', async () => {
    for (const [i, r] of runs.entries()) {
      assert.ok(
        Math.abs(r.after.counts[1] - r.after.counts[2]) <= 2,
        `run ${i} ended ${r.after.counts[1]}/${r.after.counts[2]}`
      );
    }
  });

  await test('no squad is ever decomposed', async () => {
    for (const [i, r] of runs.entries()) {
      const target = new Map(r.plan.map((m) => [m.eosID, String(m.targetTeamID)]));
      for (const squad of r.squads) {
        const destinations = new Set(squad.players.map((id) => target.get(id) ?? '1'));
        assert.equal(
          destinations.size, 1,
          `run ${i}: squad ${squad.id} split across ${[...destinations].join('/')}`
        );
      }
    }
  });

  await test('every move carries targetTeamID as a string', async () => {
    const moves = runs.flatMap((r) => r.plan);
    assert.ok(moves.length > 0, 'no moves produced across any run');
    for (const move of moves) {
      assert.equal(typeof move.targetTeamID, 'string', `${move.eosID}: ${typeof move.targetTeamID}`);
      assert.ok(['1', '2'].includes(move.targetTeamID), `unexpected target ${move.targetTeamID}`);
    }
  });
}

// ── 2. the same stack in ONE squad is correctly left alone ───────────────────
{
  const runs = [];
  for (let i = 0; i < TRIALS; i++) runs.push(await trial(1));

  await test('a 15-man stack in one squad is NEVER moved — atomicity outranks parity', async () => {
    // Moving it whole would take a level 50/50 to 35/65. Splitting it is
    // forbidden. Refusing is the correct answer, not a failure to detect the
    // stack — and it must hold on every run, not most of them.
    for (const [i, r] of runs.entries()) {
      const moved = r.plan.filter((m) => m.eosID.startsWith('pro')).length;
      assert.equal(moved, 0, `run ${i}: ${moved} pros moved out of an atomic 15-man squad`);
    }
  });

  await test('refusing the stack move still leaves the counts balanced', async () => {
    for (const [i, r] of runs.entries()) {
      assert.ok(
        Math.abs(r.after.counts[1] - r.after.counts[2]) <= 2,
        `run ${i} ended ${r.after.counts[1]}/${r.after.counts[2]}`
      );
    }
  });

  await test('the top-15 gap survives, and that is the documented price', async () => {
    // Pinned deliberately. If this ever starts closing, someone has taught the
    // scrambler to split squads — which is the invariant this plugin exists to
    // protect, not an improvement.
    for (const [i, r] of runs.entries()) {
      assert.ok(
        r.after.top15Diff > 5,
        `run ${i}: top-15 gap closed to ${r.after.top15Diff.toFixed(2)} — was a squad split?`
      );
    }
  });
}

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed.`);
if (!process.exitCode) console.log('\nAll tb-scrambler ELO tests passed.');
