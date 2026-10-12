/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               PARTIES SERVICE TEST                           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates PartiesService (Squad party tracking) and its wiring into
 * PlayersService and the S³ plugin:
 *
 *   - stable party keys through renumbering, merges and splits;
 *   - a party split across teams stays one party;
 *   - the per-team-numbering warning;
 *   - the join prediction, its 60 s self-check and the accuracy
 *     warnings;
 *   - partyID at the four registry touch points;
 *   - every limit on reuniting a party split at join.
 *
 * The tick sequences are built from cases seen on a live server: a
 * party forming on one team renumbering both teams' parties, two
 * players partying up across teams with no move, four players joining
 * in the same second with one placed on the other team.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-parties-service.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Sections 1 to 3 are a pure mock harness: PartiesService and
 *   PlayersService load from the source tree with no database and no
 *   server. Reunite moves go through fake-party-rcon.js, whose
 *   AdminForceTeamChange drags a party the way the game does.
 * - Section 4 builds a throwaway flattened assembly (plugin-assembly.js)
 *   to load the shipped S³ plugin class, because the reunite move is
 *   S3PluginBase._requestTeamChange borrowed onto that class and a
 *   hand-built stub would test a copy.
 *
 */

'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import PartiesService, { predictJoin } from '../utils/parties-service.js';
import PlayersService from '../utils/players-service.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from './plugin-assembly.js';
import { createPartyWorld } from './fake-party-rcon.js';

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const T0 = 1_000_000;
const SEC = 1000;

// A PartiesService over a rows array the test swaps between ticks.
function tracker(options = {}, deps = {}) {
  const state = { rows: [], logs: [] };
  const service = new PartiesService({
    verboseLogger: (level, message) => state.logs.push(`[v${level}] ${message}`),
    getRows: () => state.rows,
    options,
    ...deps
  });
  const tick = (rows, now) => {
    state.rows = rows;
    return service.handleTick(now);
  };
  return { service, state, tick };
}

const row = (eosID, teamID, partyID = null, squadID = null) => ({ eosID, name: eosID, teamID, partyID, squadID });
const keyOf = (service, eosID) => service.getParty(eosID)?.key ?? null;
const level = (logs, n) => logs.filter((line) => line.startsWith(`[v${n}]`));
const settle = () => new Promise((resolve) => setImmediate(resolve));

// ═══════════════════════════════════════════════════════════════
//  1. Tracking
// ═══════════════════════════════════════════════════════════════

test('a party forming renumbers every later party on both teams; keys do not change', () => {
  const { service, tick } = tracker();
  tick([row('A', 1, 0), row('B', 1, 0), row('C', 2, 1), row('D', 2, 1)], T0);
  const ab = keyOf(service, 'A');
  const cd = keyOf(service, 'C');
  assert.ok(ab && cd && ab !== cd);

  // E and F party up on T1 and take #0. Everyone else shifts +1.
  const changes = tick(
    [row('E', 1, 0), row('F', 1, 0), row('A', 1, 1), row('B', 1, 1), row('C', 2, 2), row('D', 2, 2)],
    T0 + 30 * SEC
  );
  assert.equal(keyOf(service, 'A'), ab);
  assert.equal(keyOf(service, 'C'), cd);
  assert.equal(service.getParty('C').partyID, 2, 'the in-game number follows the tick');
  assert.equal(changes.formed.length, 1);
  assert.equal(changes.changed.length, 0, 'a renumbering alone is not a change');
  assert.equal(changes.dissolved.length, 0);
});

test('a party dissolving shifts every later party down; keys do not change', () => {
  const { service, tick } = tracker();
  tick([row('A', 1, 0), row('B', 1, 0), row('C', 2, 1), row('D', 2, 1), row('E', 1, 2), row('F', 1, 2)], T0);
  const cd = keyOf(service, 'C');
  const ef = keyOf(service, 'E');

  const changes = tick([row('A', 1), row('B', 1), row('C', 2, 0), row('D', 2, 0), row('E', 1, 1), row('F', 1, 1)], T0 + SEC);
  assert.equal(keyOf(service, 'C'), cd);
  assert.equal(keyOf(service, 'E'), ef);
  assert.equal(service.isInParty('A'), false);
  assert.equal(changes.dissolved.length, 1);
  assert.equal(service.getParties().length, 2);
});

test('a member moved alone to the other team stays in the same party', () => {
  const { service, tick } = tracker();
  tick([row('A', 1, 4), row('B', 1, 4)], T0);
  const key = keyOf(service, 'A');
  const changes = tick([row('A', 1, 4), row('B', 2, 4)], T0 + SEC);
  assert.equal(changes, null, 'same members, so nothing to report');
  assert.equal(keyOf(service, 'B'), key);
  assert.deepEqual(service.getParty('A').members.sort(), ['A', 'B']);
});

test('two players on opposite teams partying up with no move are one party', () => {
  const { service, tick } = tracker();
  tick([row('Nuke', 1), row('beanboi', 2)], T0);
  assert.equal(service.getParties().length, 0);
  const changes = tick([row('Nuke', 1, 3), row('beanboi', 2, 3)], T0 + SEC);
  assert.equal(changes.formed.length, 1);
  assert.equal(keyOf(service, 'Nuke'), keyOf(service, 'beanboi'));
});

test('members leaving and joining change the party; the last pair breaking up dissolves it', () => {
  const { service, tick } = tracker();
  tick([row('A', 1, 0), row('B', 1, 0), row('C', 1, 0)], T0);
  const key = keyOf(service, 'A');

  // C disconnects: their row is gone.
  let changes = tick([row('A', 1, 0), row('B', 1, 0)], T0 + SEC);
  assert.deepEqual(changes.changed[0].removed, ['C']);
  assert.equal(keyOf(service, 'A'), key);
  assert.equal(service.getParty('A').changedAt, T0 + SEC);
  assert.equal(service.getParty('A').formedAt, T0);

  // D joins the party.
  changes = tick([row('A', 1, 0), row('B', 1, 0), row('D', 1, 0)], T0 + 2 * SEC);
  assert.deepEqual(changes.changed[0].added, ['D']);
  assert.equal(keyOf(service, 'D'), key);

  // B and D drop out. A still carries the ID, alone.
  changes = tick([row('A', 1, 0), row('B', 1), row('D', 1)], T0 + 3 * SEC);
  assert.equal(changes.dissolved.length, 1);
  assert.equal(service.isInParty('A'), false, 'a lone player carrying an ID is not a party');
  assert.equal(service.getParty('A'), null);
});

test('a merge keeps the larger party\'s key', () => {
  const { service, tick } = tracker();
  tick([row('A', 1, 0), row('B', 1, 0), row('C', 1, 0), row('D', 1, 1), row('E', 1, 1)], T0);
  const big = keyOf(service, 'A');
  const small = keyOf(service, 'D');

  const changes = tick([row('A', 1, 0), row('B', 1, 0), row('C', 1, 0), row('D', 1, 0), row('E', 1, 0)], T0 + SEC);
  assert.equal(keyOf(service, 'D'), big);
  assert.equal(service.getParties().length, 1);
  assert.deepEqual(changes.changed[0].added.sort(), ['D', 'E']);
  assert.equal(changes.dissolved[0].key, small);
});

test('a split leaves the key on the larger half', () => {
  const { service, tick } = tracker();
  tick([row('A', 1, 0), row('B', 1, 0), row('C', 1, 0), row('D', 1, 0), row('E', 1, 0)], T0);
  const key = keyOf(service, 'A');

  const changes = tick([row('A', 1, 0), row('B', 1, 0), row('C', 1, 0), row('D', 1, 1), row('E', 1, 1)], T0 + SEC);
  assert.equal(keyOf(service, 'A'), key);
  assert.notEqual(keyOf(service, 'D'), key);
  assert.equal(changes.formed.length, 1);
  assert.deepEqual(changes.changed[0].removed.sort(), ['D', 'E']);
});

test('the per-team-numbering warning fires on its signature, once an hour, and not on an ordinary split', () => {
  const { service, state, tick } = tracker();
  const together = [row('A', 1, 0), row('B', 1, 0), row('C', 2, 0), row('D', 2, 0)];
  const alongTeams = [row('A', 1, 0), row('B', 1, 0), row('C', 2, 1), row('D', 2, 1)];
  const warned = () => level(state.logs, 1).filter((line) => line.includes('per team')).length;

  // An ordinary split inside one team says nothing.
  tick([row('W', 1, 5), row('X', 1, 5), row('Y', 1, 5), row('Z', 1, 5)], T0);
  tick([row('W', 1, 5), row('X', 1, 5), row('Y', 1, 6), row('Z', 1, 6)], T0 + SEC);
  assert.equal(warned(), 0);

  tick(together, T0 + 2 * SEC);
  tick(alongTeams, T0 + 3 * SEC);
  assert.equal(warned(), 1);

  // Again inside the hour: quiet.
  tick(together, T0 + 4 * SEC);
  tick(alongTeams, T0 + 5 * SEC);
  assert.equal(warned(), 1);

  // And again after it.
  tick(together, T0 + 3700 * SEC);
  tick(alongTeams, T0 + 3701 * SEC);
  assert.equal(warned(), 2);
  assert.ok(service.getParties().length >= 2);
});

test('onPartiesChanged fires only when something changed, survives a throwing subscriber, and unsubscribes', () => {
  const { service, tick } = tracker();
  const seen = [];
  service.onPartiesChanged(() => { throw new Error('boom'); });
  const off = service.onPartiesChanged((changes) => seen.push(changes));

  tick([row('A', 1, 0), row('B', 1, 0)], T0);
  tick([row('A', 1, 0), row('B', 1, 0)], T0 + SEC);
  assert.equal(seen.length, 1);

  off();
  tick([row('A', 1), row('B', 1)], T0 + 2 * SEC);
  assert.equal(seen.length, 1);
  assert.throws(() => service.onPartiesChanged('nope'), /function callback/);
});

// ═══════════════════════════════════════════════════════════════
//  2. Join prediction
// ═══════════════════════════════════════════════════════════════

test('predictJoin: a party ID, else a squad, else solo', () => {
  assert.equal(predictJoin(row('A', 1, 0, null)), 'party');
  assert.equal(predictJoin(row('A', 1, 0, 3)), 'party');
  assert.equal(predictJoin(row('A', 1, null, 3)), 'likely-party');
  assert.equal(predictJoin(row('A', 1, null, null)), 'solo');
  assert.equal(predictJoin({ eosID: 'A' }), 'solo', 'a row with no party or squad field at all');
});

test('each prediction is judged at 60 s against whether a party ID showed', () => {
  const { service, tick } = tracker();
  const joiners = {
    CONF: row('CONF', 1, 0, 1),     // carried an ID
    HIT: row('HIT', 1, null, 1),    // in a squad, ID follows
    FA: row('FA', 1, null, 2),      // in a squad, never an ID
    MISS: row('MISS', 1, null),     // squadless, ID follows
    OK: row('OK', 1, null)          // squadless, never an ID
  };
  for (const r of Object.values(joiners)) service.noteJoin(r, T0);
  assert.equal(service.getJoinPrediction('HIT'), 'likely-party');
  assert.equal(service.getJoinPrediction('nobody'), null);

  tick(Object.values(joiners), T0);
  joiners.HIT.partyID = 0;
  joiners.MISS.partyID = 0;
  tick(Object.values(joiners), T0 + 59 * SEC);
  assert.equal(service.getJoinPredictionStats().judged, 0, 'nothing is judged before 60 s');
  assert.equal(service.getJoinPredictionStats().pending, 5);

  tick(Object.values(joiners), T0 + 60 * SEC);
  const stats = service.getJoinPredictionStats();
  assert.deepEqual(
    { confirmed: stats.confirmed, hit: stats.hit, falseAlarm: stats.falseAlarm, miss: stats.miss, correct: stats.correct },
    { confirmed: 1, hit: 1, falseAlarm: 1, miss: 1, correct: 1 }
  );
  assert.equal(stats.falseAlarmShare, 0.5);
  assert.equal(stats.missShare, 1 / 3);
  assert.equal(stats.pending, 0);

  // Judged once, not again on the next tick.
  tick(Object.values(joiners), T0 + 90 * SEC);
  assert.equal(service.getJoinPredictionStats().judged, 5);
});

test('a joiner who leaves inside 60 s is not counted', () => {
  const { service, tick } = tracker();
  const gone = row('GONE', 1, null, 1);
  service.noteJoin(gone, T0);
  tick([gone], T0);
  service.noteLeave('GONE');
  tick([], T0 + 60 * SEC);
  assert.equal(service.getJoinPredictionStats().judged, 0);
  assert.equal(service.getJoinPrediction('GONE'), null);
});

test('a party ID that showed and was lost again before 60 s still counts', () => {
  const { service, tick } = tracker();
  const flaky = row('FLAKY', 1, null, 1);
  service.noteJoin(flaky, T0);
  tick([flaky], T0);
  flaky.partyID = 2;
  tick([flaky], T0 + 20 * SEC);
  flaky.partyID = null;
  tick([flaky], T0 + 60 * SEC);
  assert.equal(service.getJoinPredictionStats().hit, 1);
});

test('a miss is logged at level 2 with the mates\' teams', () => {
  const { service, state, tick } = tracker();
  const mate = row('Mate', 2, 0, 4);
  const late = row('Late', 1, null);
  tick([mate], T0);
  service.noteJoin(late, T0);
  late.partyID = 0;
  tick([mate, late], T0 + 60 * SEC);
  const lines = level(state.logs, 2).filter((line) => line.includes('prediction miss'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Late \(T1\)/);
  assert.match(lines[0], /Mate \(T2\)/);
});

test('the false-alarm warning needs a sample, fires past its limit, and at most once an hour', () => {
  const { service, state, tick } = tracker();
  const warned = () => level(state.logs, 1).filter((line) => line.includes('drifting')).length;
  let clock = T0;
  let n = 0;
  // Joins `count` players in a squad; `withID` of them get a party ID.
  const batch = (count, withID) => {
    const rows = [];
    for (let i = 0; i < count; i++) {
      const r = row(`J${n++}`, 1, null, 1);
      service.noteJoin(r, clock);
      if (i < withID) r.partyID = 900 + n; // distinct, so no party forms
      rows.push(r);
    }
    clock += 60 * SEC;
    tick(rows, clock);
    for (const r of rows) service.noteLeave(r.eosID);
  };

  batch(9, 0); // 9 of 9 false alarms, but under the sample floor
  assert.equal(warned(), 0);
  batch(1, 0); // 10 of 10
  assert.equal(warned(), 1);
  assert.match(level(state.logs, 1).pop(), /10 of 10 joiners who arrived in a squad/);
  batch(5, 0);
  assert.equal(warned(), 1, 'quiet inside the hour');
  clock += 3600 * SEC;
  batch(1, 0);
  assert.equal(warned(), 2);
});

test('the miss warning fires when too many party joiners arrive squadless; a healthy mix stays quiet', () => {
  const quiet = tracker();
  const noisy = tracker();
  const run = ({ service, tick }, misses) => {
    const rows = [];
    for (let i = 0; i < 10; i++) {
      const squadless = i < misses;
      const r = row(`P${i}`, 1, null, squadless ? null : 1);
      service.noteJoin(r, T0);
      r.partyID = 500 + i;
      rows.push(r);
    }
    tick(rows, T0 + 60 * SEC);
  };
  run(quiet, 4);  // 4 of 10 = 40%, not past the limit
  run(noisy, 5);  // 5 of 10 = 50%
  assert.equal(level(quiet.state.logs, 1).length, 0);
  assert.match(level(noisy.state.logs, 1)[0], /5 of 10 party joiners arrived squadless/);
});

test('the counts cover the last 100 judged joins only', () => {
  const { service, tick } = tracker({ statsWindow: 100 });
  const rows = [];
  for (let i = 0; i < 130; i++) {
    const r = row(`S${i}`, 1, null);
    service.noteJoin(r, T0);
    rows.push(r);
  }
  tick(rows, T0 + 60 * SEC);
  const stats = service.getJoinPredictionStats();
  assert.equal(stats.judged, 100);
  assert.equal(stats.correct, 100);
});

// ═══════════════════════════════════════════════════════════════
//  3. Reuniting a party split at join
// ═══════════════════════════════════════════════════════════════

// A fake game world plus a tracker reading its roster. The mover is the
// smallest thing with _requestTeamChange's contract: say the target, send
// nothing if the player is already there, report where they ended up.
function reuniteWorld(players, options = {}, deps = {}) {
  const world = createPartyWorld(players);
  const warned = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { service, state } = tracker(options, { getRows: () => world.roster, ...deps });

  service.setReuniteHandlers({
    move: async (eosID, { targetTeamID, source }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await settle();
      if (world.teamOf(eosID) !== targetTeamID) {
        await world.rcon.execute(`AdminForceTeamChange "${eosID}"`);
      }
      inFlight--;
      assert.equal(source, 'S3:PartyReunite');
      return { success: world.teamOf(eosID) === targetTeamID };
    },
    warn: async (player, targetTeamID) => { warned.push(`${player.eosID}>T${targetTeamID}`); }
  });

  const tick = async (now) => {
    service.handleTick(now);
    for (let i = 0; i < 20; i++) await settle();
  };
  const join = (eosID, now) => service.noteJoin(world.roster.find((p) => p.eosID === eosID), now);
  const set = (eosID, fields) => Object.assign(world.roster.find((p) => p.eosID === eosID), fields);
  return { world, service, state, warned, tick, join, set, maxInFlight: () => maxInFlight };
}

// Filler so a one-player move doesn't trip the team-balance limit.
const crowd = (perTeam = 10) => {
  const out = [];
  for (let i = 0; i < perTeam; i++) {
    out.push({ eosID: `c1-${i}`, name: `c1-${i}`, teamID: 1, partyID: null });
    out.push({ eosID: `c2-${i}`, name: `c2-${i}`, teamID: 2, partyID: null });
  }
  return out;
};

test('reunite: four players join together and the game puts one on the other team', async () => {
  const w = reuniteWorld([
    { eosID: 'Scullo', name: 'Scullo', teamID: 1, party: 'A', partyID: null, leader: true },
    { eosID: 'furkan', name: 'furkan', teamID: 1, party: 'A', partyID: null },
    { eosID: 'snow', name: 'snow', teamID: 1, party: 'A', partyID: null },
    { eosID: 'XuThan', name: 'XuThan', teamID: 2, party: 'A', partyID: 1 },
    ...crowd(),
    { eosID: 'x1', name: 'x1', teamID: 2, partyID: null },
    { eosID: 'x2', name: 'x2', teamID: 2, partyID: null }
  ]);
  for (const id of ['Scullo', 'furkan', 'snow', 'XuThan']) w.join(id, T0);
  await w.tick(T0);
  assert.deepEqual(w.world.commands, [], 'XuThan carries an ID but nobody shares it yet');

  for (const id of ['Scullo', 'furkan', 'snow']) w.set(id, { partyID: 1 });
  await w.tick(T0 + 15 * SEC);
  assert.deepEqual(w.world.commands, ['XuThan']);
  assert.equal(w.world.teamOf('XuThan'), 1);
  assert.deepEqual(w.warned, ['XuThan>T1']);
  assert.deepEqual(w.service.getReuniteStats(), { moved: 1, failed: 0, skippedBalance: 0 });
  assert.equal(level(w.state.logs, 1).filter((line) => line.includes('Reunited XuThan')).length, 1);
});

test('reunite: a squadless joiner SmartAssign moved away from their party is moved back', async () => {
  const w = reuniteWorld([
    { eosID: 'Kam', name: 'Kam', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'Sat', name: 'Sat', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'NIKI', name: 'NIKI', teamID: 1, party: 'A', partyID: null },
    ...crowd()
  ]);
  await w.tick(T0);
  w.join('NIKI', T0 + SEC);
  // SmartAssign moves NIKI for balance before any party ID shows.
  w.set('NIKI', { teamID: 2 });
  w.service.noteTeamChange('NIKI', 'SmartAssign');
  await w.tick(T0 + 5 * SEC);
  assert.deepEqual(w.world.commands, []);

  w.set('NIKI', { partyID: 0 });
  await w.tick(T0 + 31 * SEC);
  assert.equal(w.world.teamOf('NIKI'), 1);
  assert.equal(w.service.getReuniteStats().moved, 1);
});

test('reunite: not once the window has passed', async () => {
  const w = reuniteWorld([
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: null },
    ...crowd()
  ]);
  await w.tick(T0);
  w.join('J', T0);
  w.set('J', { partyID: 0 });
  await w.tick(T0 + 91 * SEC);
  assert.deepEqual(w.world.commands, []);

  // The same sighting one second earlier would have moved them.
  const inside = reuniteWorld([
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: 0 },
    ...crowd()
  ]);
  inside.join('J', T0);
  await inside.tick(T0 + 90 * SEC);
  assert.deepEqual(inside.world.commands, ['J']);
});

test('reunite: an even split moves nobody', async () => {
  const w = reuniteWorld([
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'B', name: 'B', teamID: 2, party: 'A', partyID: 0 },
    ...crowd()
  ]);
  w.join('A', T0);
  w.join('B', T0);
  await w.tick(T0 + SEC);
  assert.deepEqual(w.world.commands, []);
});

test('reunite: the group is never moved to the strays, and a long-standing member\'s side never moves', async () => {
  // Two fresh joiners on T2, one long-standing mate on T1: the smaller side
  // is the mate, who has no join record.
  const outnumbered = reuniteWorld([
    { eosID: 'Old', name: 'Old', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: 0 },
    { eosID: 'K', name: 'K', teamID: 2, party: 'A', partyID: 0 },
    ...crowd()
  ]);
  await outnumbered.tick(T0);
  outnumbered.join('J', T0 + SEC);
  outnumbered.join('K', T0 + SEC);
  await outnumbered.tick(T0 + 2 * SEC);
  assert.deepEqual(outnumbered.world.commands, []);

  // The smaller side is one fresh joiner and one long-standing member.
  const mixed = reuniteWorld([
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'C', name: 'C', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'Old', name: 'Old', teamID: 2, party: 'A', partyID: 0 },
    { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: 0 },
    ...crowd()
  ]);
  mixed.join('J', T0);
  await mixed.tick(T0 + SEC);
  assert.deepEqual(mixed.world.commands, []);
});

test('reunite: a player moved since joining by an admin, Switch or a scramble is left alone', async () => {
  for (const source of ['Admin', 'Manual/Game', 'Player-Self', 'Player-Queue', 'TeamBalancer:Full']) {
    const w = reuniteWorld([
      { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
      { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
      { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: 0 },
      ...crowd()
    ]);
    w.join('J', T0);
    w.service.noteTeamChange('J', source);
    await w.tick(T0 + SEC);
    assert.deepEqual(w.world.commands, [], `moved by ${source}`);
  }
});

test('reunite: one attempt per connection; a failed move is not retried', async () => {
  const w = reuniteWorld([
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: 0 },
    ...crowd()
  ]);
  w.join('J', T0);
  w.world.refuse = true; // the game accepts the command and moves nobody
  await w.tick(T0 + SEC);
  assert.deepEqual(w.world.commands, ['J']);
  assert.deepEqual(w.service.getReuniteStats(), { moved: 0, failed: 1, skippedBalance: 0 });
  assert.deepEqual(w.warned, []);

  w.world.refuse = false;
  await w.tick(T0 + 10 * SEC);
  assert.deepEqual(w.world.commands, ['J'], 'no second attempt');

  // A reconnect is a new connection, and gets its own attempt.
  w.service.noteLeave('J');
  w.join('J', T0 + 20 * SEC);
  await w.tick(T0 + 21 * SEC);
  assert.deepEqual(w.world.commands, ['J', 'J']);
  assert.equal(w.world.teamOf('J'), 1);
});

test('reunite: held back while it would leave the party\'s team too far ahead, then done if the teams even out', async () => {
  // T1 has 12, T2 has 10 before the move; moving J makes it 13 v 9.
  const w = reuniteWorld([
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: 0 },
    ...crowd(9),
    { eosID: 'x1', name: 'x1', teamID: 1, partyID: null }
  ]);
  w.join('J', T0);
  await w.tick(T0 + SEC);
  await w.tick(T0 + 10 * SEC);
  assert.deepEqual(w.world.commands, []);
  assert.equal(w.service.getReuniteStats().skippedBalance, 1, 'counted once, not once per tick');
  assert.equal(level(w.state.logs, 2).filter((line) => line.includes('Not reuniting J')).length, 1);

  // Two players join T2: 12 v 12, so the move leaves 13 v 11.
  w.world.roster.push({ eosID: 'y1', name: 'y1', teamID: 2, partyID: null }, { eosID: 'y2', name: 'y2', teamID: 2, partyID: null });
  await w.tick(T0 + 20 * SEC);
  assert.deepEqual(w.world.commands, ['J']);

  // The limit is the option, not a constant.
  const loose = reuniteWorld([
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: 0 },
    ...crowd(9),
    { eosID: 'x1', name: 'x1', teamID: 1, partyID: null }
  ], { reuniteMaxTeamDiff: 4 });
  loose.join('J', T0);
  await loose.tick(T0 + SEC);
  assert.deepEqual(loose.world.commands, ['J']);
});

test('reunite: waits out a scramble\'s global lock, unsettled teams and a per-player lock', async () => {
  const gates = { global: false, settled: true, locked: new Set() };
  const w = reuniteWorld([
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: 0 },
    ...crowd()
  ], {}, {
    isGloballyLocked: () => gates.global,
    isTeamDataSettled: () => gates.settled,
    isPlayerLocked: (eosID) => gates.locked.has(eosID)
  });
  w.join('J', T0);

  gates.global = true;
  await w.tick(T0 + SEC);
  gates.global = false;
  gates.settled = false;
  await w.tick(T0 + 2 * SEC);
  gates.settled = true;
  gates.locked.add('J');
  await w.tick(T0 + 3 * SEC);
  assert.deepEqual(w.world.commands, [], 'held back three times');

  gates.locked.clear();
  await w.tick(T0 + 4 * SEC);
  assert.deepEqual(w.world.commands, ['J'], 'and still a candidate afterwards');
});

test('reunite: off by option, and inert with no mover installed', async () => {
  const players = () => [
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: 0 },
    ...crowd()
  ];
  const off = reuniteWorld(players(), { reuniteEnabled: false });
  off.join('J', T0);
  await off.tick(T0 + SEC);
  assert.deepEqual(off.world.commands, []);

  const noMover = reuniteWorld(players());
  noMover.service.setReuniteHandlers({});
  noMover.join('J', T0);
  await noMover.tick(T0 + SEC);
  assert.deepEqual(noMover.world.commands, []);
  assert.equal(noMover.service.getParties().length, 1, 'tracking still works');
});

test('reunite: two strays move one at a time, and a stray the leader dragged costs no command', async () => {
  const w = reuniteWorld([
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'C', name: 'C', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'Lead', name: 'Lead', teamID: 2, party: 'A', partyID: 0, leader: true },
    { eosID: 'K', name: 'K', teamID: 2, party: 'A', partyID: 0 },
    ...crowd(),
    ...['x1', 'x2', 'x3', 'x4'].map((id) => ({ eosID: id, name: id, teamID: 2, partyID: null }))
  ]);
  w.join('Lead', T0);
  w.join('K', T0);
  await w.tick(T0 + SEC);
  // Moving the leader sets the whole party to T1, K included.
  assert.deepEqual(w.world.commands, ['Lead']);
  assert.equal(w.world.teamOf('K'), 1);
  assert.equal(w.world.teamOf('A'), 1, 'the mates already there stayed put');
  assert.equal(w.service.getReuniteStats().moved, 2);
  assert.equal(w.maxInFlight(), 1);
});

test('reunite: a tick arriving mid-move does not start a second move', async () => {
  const w = reuniteWorld([
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: 0 },
    ...crowd()
  ]);
  w.join('J', T0);
  w.world.refuse = true; // J stays on T2, so a second pass would still see a split
  w.service.handleTick(T0 + SEC);
  w.service.handleTick(T0 + SEC + 1); // the refresh a move triggers re-enters here
  w.service.handleTick(T0 + SEC + 2);
  for (let i = 0; i < 30; i++) await settle();
  assert.deepEqual(w.world.commands, ['J']);
});

test('reunite: a second party that becomes due mid-move waits for the next tick', async () => {
  const w = reuniteWorld([
    { eosID: 'A', name: 'A', teamID: 1, party: 'A', partyID: 0, leader: true },
    { eosID: 'B', name: 'B', teamID: 1, party: 'A', partyID: 0 },
    { eosID: 'J', name: 'J', teamID: 2, party: 'A', partyID: 0 },
    { eosID: 'C', name: 'C', teamID: 2, party: 'B', partyID: null, leader: true },
    { eosID: 'D', name: 'D', teamID: 2, party: 'B', partyID: null },
    { eosID: 'K', name: 'K', teamID: 1, party: 'B', partyID: null },
    ...crowd()
  ]);
  w.join('J', T0);
  w.join('K', T0);
  w.service.handleTick(T0 + SEC); // J's move is now in flight
  for (const id of ['C', 'D', 'K']) w.set(id, { partyID: 1 });
  w.service.handleTick(T0 + SEC + 1); // K's party is due, but a move is running
  for (let i = 0; i < 30; i++) await settle();
  assert.deepEqual(w.world.commands, ['J']);
  assert.equal(w.maxInFlight(), 1);

  await w.tick(T0 + 2 * SEC);
  assert.deepEqual(w.world.commands, ['J', 'K']);
  assert.equal(w.world.teamOf('K'), 2);
  assert.equal(w.maxInFlight(), 1);
});

// ═══════════════════════════════════════════════════════════════
//  PlayersService wiring
// ═══════════════════════════════════════════════════════════════

class MockServer extends EventEmitter {
  constructor() {
    super();
    this.players = [];
    this.emitted = [];
  }

  emit(event, ...args) {
    this.emitted.push({ event, payload: args[0] });
    return super.emit(event, ...args);
  }

  take(eventName) {
    return this.emitted.filter((e) => e.event === eventName).map((e) => e.payload);
  }
}

async function mountedPlayers(initial = []) {
  const server = new MockServer();
  const service = new PlayersService({ server });
  await service.mount();
  server.players = initial;
  await service.handleUpdatedPlayerInfo(); // initial sync
  return { server, service };
}

const raw = (eosID, teamID, partyID, squadID = null) => ({ eosID, steamID: `s-${eosID}`, name: eosID, teamID, squadID, partyID });

test('registry: partyID lands on a new row and follows every tick, including back to null', async () => {
  const { server, service } = await mountedPlayers([raw('A', 1, 2), raw('B', 1, 2)]);
  assert.equal(service.getPlayer('A').partyID, 2);
  assert.equal(service.isInParty('A'), true, 'parties are tracked from initial sync');

  server.players = [raw('A', 1, 5), raw('B', 1, 5)];
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.getPlayer('A').partyID, 5);

  server.players = [raw('A', 1, null), raw('B', 1, null)];
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.getPlayer('A').partyID, null, 'null is a real value, not "keep the old one"');
  assert.equal(service.isInParty('A'), false);
  await service.unmount();
});

test('registry: PLAYER_CONNECTED sets partyID when it carries one and leaves the row alone when it does not', async () => {
  const { server, service } = await mountedPlayers([raw('A', 1, 3), raw('B', 1, 3)]);

  // No party field on the payload: the tick's value survives.
  await service.handlePlayerConnected({ player: { eosID: 'A', steamID: 's-A', name: 'A', teamID: 1 } });
  assert.equal(service.getPlayer('A').partyID, 3);

  // A fresh connect that does carry one.
  await service.handlePlayerConnected({ player: raw('C', 1, 3, 2) });
  assert.equal(service.getPlayer('C').partyID, 3);
  assert.equal(server.take('S3_PLAYER_JOINED').pop().player.joinPrediction, 'party');
  await service.unmount();
});

test('registry: the null-window projection carries partyID', async () => {
  const { server, service } = await mountedPlayers([raw('A', 1, 0), raw('B', 1, 0), raw('C', 2, null), raw('D', 2, null)]);
  // One player goes null: the projection arms and serves projected rows.
  server.players = [raw('A', 1, 4), raw('B', 1, 4), raw('C', 2, null), raw('D', null, null)];
  await service.handleUpdatedPlayerInfo();
  assert.ok(service._projectedPlayers, 'projection active');
  assert.equal(service.getPlayer('A').partyID, 4);
  await service.unmount();
});

test('registry: a join carries its prediction on the S3_PLAYER_JOINED payload; initial-sync players get none', async () => {
  const { server, service } = await mountedPlayers([raw('Old', 1, null, 4)]);
  assert.equal(service.getPlayer('Old').joinPrediction, null);
  assert.equal(service.getPlayer('Old').joinedInSquad, true);
  assert.equal(service.getJoinPrediction('Old'), null);

  server.players = [raw('Old', 1, null, 4), raw('Squad', 1, null, 2), raw('Solo', 2, null, null)];
  await service.handleUpdatedPlayerInfo();
  const joined = Object.fromEntries(server.take('S3_PLAYER_JOINED').map((p) => [p.player.eosID, p.player]));
  assert.equal(joined.Squad.joinPrediction, 'likely-party');
  assert.equal(joined.Squad.joinedInSquad, true);
  assert.equal(joined.Solo.joinPrediction, 'solo');
  assert.equal(joined.Solo.joinedInSquad, false);
  assert.equal(service.getJoinPrediction('Squad'), 'likely-party');

  // Fixed at registration: joining a squad later changes neither field.
  server.players = [raw('Old', 1, null, 4), raw('Squad', 1, null, 2), raw('Solo', 2, null, 6)];
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.getPlayer('Solo').joinedInSquad, false);
  assert.equal(service.getPlayer('Solo').joinPrediction, 'solo');
  await service.unmount();
});

test('registry: parties are current when S3_PLAYERS_UPDATED fires, and a leaver drops out', async () => {
  const { server, service } = await mountedPlayers([raw('A', 1, null), raw('B', 1, null)]);
  let seenInEvent = null;
  server.on('S3_PLAYERS_UPDATED', () => { seenInEvent = service.getParties().length; });
  const changes = [];
  service.onPartiesChanged((c) => changes.push(c));

  server.players = [raw('A', 1, 0), raw('B', 1, 0), raw('J', 1, 0, 1)];
  await service.handleUpdatedPlayerInfo();
  assert.equal(seenInEvent, 1);
  assert.deepEqual(service.getParty('J').members.sort(), ['A', 'B', 'J']);
  assert.equal(changes.length, 1);

  server.players = [raw('A', 1, 0), raw('B', 1, 0)];
  await service.handleUpdatedPlayerInfo();
  assert.equal(service.getParty('J'), null);
  assert.equal(service.getJoinPrediction('J'), null, 'the join record goes with the player');
  assert.deepEqual(changes[1].changed[0].removed, ['J']);
  await service.unmount();
  assert.equal(service.getParties().length, 0, 'unmount forgets everything');
});

test('registry: a team change S³ reports reaches the tracker with its source', async () => {
  const { server, service } = await mountedPlayers([raw('A', 1, 0), raw('B', 1, 0), ...crowd().map((p) => raw(p.eosID, p.teamID, null))]);
  const moves = [];
  service.parties.setReuniteHandlers({ move: async (eosID) => { moves.push(eosID); return { success: true }; } });

  // J joins on T1 beside their party, then !switches to T2.
  const everyone = () => [raw('A', 1, 0), raw('B', 1, 0), ...crowd().map((p) => raw(p.eosID, p.teamID, null))];
  server.players = [...everyone(), raw('J', 1, 0)];
  await service.handleUpdatedPlayerInfo();
  service.recordMove('J', 2, 'Player-Self');
  server.players = [...everyone(), raw('J', 2, 0)];
  await service.handleUpdatedPlayerInfo();
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(server.take('S3_PLAYER_TEAM_CHANGED').pop().source, 'Player-Self');
  assert.deepEqual(moves, [], 'a switch the player asked for is not undone');
  await service.unmount();
});

// ═══════════════════════════════════════════════════════════════
//  4. The S³ plugin's move (throwaway assembly)
// ═══════════════════════════════════════════════════════════════

const ASSEMBLY = buildAssembly('.tmp-parties-service');

try {
  const S3 = await importFromAssembly(ASSEMBLY, 'slackers-squad-services.js');

  test('S³ plugin: the reunite move is the shared target-team move, sent through S³\'s own RCON and logger', async () => {
    const world = createPartyWorld([
      { eosID: 'A', name: 'Alpha', teamID: 1, party: 'A', leader: true },
      { eosID: 'B', name: 'Bravo', teamID: 1, party: 'A' },
      { eosID: 'J', name: 'Juliet', steamID: '7656', teamID: 2, party: 'A' }
    ]);
    const warns = [];
    const plugin = Object.create(S3.prototype);
    plugin.server = { rcon: { ...world.rcon, warn: async (id, message) => warns.push([id, message]) } };
    plugin.services = { players: world.players };
    plugin.options = { language: 'en' };
    plugin.logs = [];
    plugin.verbose = (lvl, message) => plugin.logs.push(`[v${lvl}] ${message}`);

    const result = await plugin._requestTeamChange('J', { targetTeamID: 1, source: 'S3:PartyReunite', maxAttempts: 3 });
    assert.equal(result.success, true);
    assert.equal(result.source, 'S3:PartyReunite');
    assert.deepEqual(world.commands, ['J']);
    assert.equal(world.teamOf('J'), 1);
    assert.ok(plugin.logs.some((line) => line.includes('[TC]')), 'the move logs through the S³ plugin');

    // Already there: success, no command.
    const again = await plugin._requestTeamChange('J', { targetTeamID: 1, source: 'S3:PartyReunite' });
    assert.equal(again.success, true);
    assert.deepEqual(world.commands, ['J']);

    await plugin._warnPartyReunited(world.players.getPlayer('J'));
    assert.deepEqual(warns, [['7656', "Moved to your party's team."]]);
  });

  test('S³ plugin: its party options have the documented defaults', () => {
    const spec = S3.optionsSpecification;
    assert.equal(spec.partyReunite.default, true);
    assert.equal(spec.partyReuniteWindowSeconds.default, 90);
    assert.equal(spec.partyReuniteMaxTeamDiff.default, 3);
    assert.equal(spec.partyJoinCheckSeconds.default, 60);
    assert.equal(spec.partyFalseAlarmWarnPercent.default, 30);
    assert.equal(spec.partyMissWarnPercent.default, 40);
  });

  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.stack || err.message}`);
    }
  }
} finally {
  cleanAssembly(ASSEMBLY);
}

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed ? 1 : 0);
