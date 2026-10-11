/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          PARTY GROUPS TEST                                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Squad parties through the scrambler:
 *
 *   - buildScrambleGroups() (tb-party-groups.js): parties and clan
 *     groups merged wherever they share a player, parties already
 *     split across teams left out, groups always disjoint;
 *   - the scrambler keeps a party on one team when its members sit in
 *     two squads, or one of them is in no squad;
 *   - a party-only group takes just its members out of an extra squad
 *     (membersOnlyTags), where a clan group pulls the whole squad;
 *   - the scramble report names a party unit and explains the marker.
 *
 * Each scrambler scenario is run many times over random rosters, and
 * each has a control run without party grouping that must split the
 * party at least once. Without the control, a scenario the scrambler
 * happens never to split would pass whether or not grouping worked.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node team-balancer/testing/test-party-groups.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Pure: the scrambler, tb-party-groups.js and the Discord helpers
 *   load from the source tree. No server, no database.
 *
 */

import assert from 'node:assert/strict';
import { Scrambler } from '../utils/tb-scrambler.js';
import { buildScrambleGroups, PARTY_TAG_PREFIX } from '../utils/tb-party-groups.js';
import { DiscordHelpers } from '../utils/tb-discord-helpers.js';
import localize from '../../s3/utils/s3-i18n.js';
import { generateMockPlayers, generateMockSquads, transformForScrambler } from './mock-data-generator.js';

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const RUNS = 40;

// ── buildScrambleGroups ──────────────────────────────────────────

const roster = (...entries) => entries.map(([eosID, teamID, name = eosID]) => ({ eosID, name, teamID }));

test('no clans and no parties gives no groups', () => {
  const built = buildScrambleGroups({ clanGroups: null, parties: [], players: roster(['a', 1]) });
  assert.equal(built.groups, null);
  assert.equal(built.partyCount, 0);
});

test('clan groups pass through untouched when there are no parties', () => {
  const clanGroups = { NL: ['a', 'b', 'c'], ToG: ['d', 'e'] };
  const built = buildScrambleGroups({ clanGroups, parties: [], players: roster(['a', 1], ['b', 1], ['c', 1], ['d', 2], ['e', 2]) });
  assert.deepEqual(built.groups, clanGroups);
  assert.equal(built.membersOnlyTags.size, 0);
});

test('a party alone becomes a group named after a member, never its in-game number', () => {
  const built = buildScrambleGroups({
    parties: [{ key: 'p1', partyID: 7, members: ['a', 'b', 'c'] }],
    players: roster(['a', 1, '  Mandela Caos'], ['b', 1], ['c', 1])
  });
  const tag = `${PARTY_TAG_PREFIX}Mandela Caos +2`;
  assert.deepEqual(built.groups, { [tag]: ['a', 'b', 'c'] });
  assert.ok(built.membersOnlyTags.has(tag));
  assert.ok(!tag.includes('7'));
  assert.equal(built.partyCount, 1);
});

test('a party overlapping a clan joins the clan\'s group and keeps the clan tag', () => {
  const built = buildScrambleGroups({
    clanGroups: { NL: ['a', 'b', 'c'] },
    parties: [{ members: ['c', 'd'] }],
    players: roster(['a', 1], ['b', 1], ['c', 1], ['d', 1])
  });
  assert.deepEqual(Object.keys(built.groups), ['NL']);
  assert.deepEqual([...built.groups.NL].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(built.membersOnlyTags.size, 0, 'a group with a clan in it follows the clan option');
});

test('one party bridging two clans makes them one group; two parties sharing nobody stay separate', () => {
  const bridged = buildScrambleGroups({
    clanGroups: { AAA: ['a', 'b'], BBB: ['c', 'd'] },
    parties: [{ members: ['b', 'c'] }, { members: ['e', 'f'] }, { members: ['g', 'h'] }],
    players: roster(['a', 1], ['b', 1], ['c', 1], ['d', 1], ['e', 1], ['f', 1], ['g', 2], ['h', 2])
  });
  assert.deepEqual([...bridged.groups['AAA+BBB']].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(Object.keys(bridged.groups).length, 3);
  assert.equal(bridged.membersOnlyTags.size, 2);

  // Disjoint by construction: no player in two groups.
  const seen = new Set();
  for (const members of Object.values(bridged.groups)) {
    for (const id of members) {
      assert.ok(!seen.has(id), `${id} is in two groups`);
      seen.add(id);
    }
  }
});

test('a party split across teams is left out and counted', () => {
  const built = buildScrambleGroups({
    parties: [{ members: ['a', 'b'] }, { members: ['c', 'd'] }],
    players: roster(['a', 1], ['b', 2], ['c', 2], ['d', 2])
  });
  assert.equal(Object.keys(built.groups).length, 1);
  assert.deepEqual(Object.values(built.groups)[0], ['c', 'd']);
  assert.equal(built.splitPartyCount, 1);
  assert.equal(built.partyCount, 1);
});

test('a party with a member not on a real team, or with one member connected, is left out', () => {
  const built = buildScrambleGroups({
    parties: [{ members: ['a', 'b'] }, { members: ['c', 'gone'] }],
    players: roster(['a', 1], ['b', null], ['c', 2])
  });
  assert.equal(built.groups, null);
  assert.equal(built.splitPartyCount, 1);
});

test('two parties whose first members share a name get distinct tags', () => {
  const built = buildScrambleGroups({
    parties: [{ members: ['a', 'b'] }, { members: ['c', 'd'] }],
    players: roster(['a', 1, 'Smith'], ['b', 1], ['c', 2, 'Smith'], ['d', 2])
  });
  assert.equal(Object.keys(built.groups).length, 2);
  assert.equal(built.membersOnlyTags.size, 2);
});

// ── Through the scrambler ────────────────────────────────────────

// A random 80-player roster with a party planted on Team 1. `plant` picks
// the members from the generated squads and returns their eosIDs.
function scenario(plant, { unassignedRatio = 0 } = {}) {
  const players = generateMockPlayers(80, 0.5, unassignedRatio);
  const squads = generateMockSquads(players);
  const t1Squads = squads.filter((s) => s.teamID === 1 && s.players.length >= 4).sort((a, b) => b.players.length - a.players.length);
  const party = plant({ players, squads, t1Squads });
  const { squads: tfSquads, players: tfPlayers } = transformForScrambler(players, squads);
  return { players, squads, tfSquads, tfPlayers, party };
}

async function scramble(sc, { grouped, pullEntireSquads = true, clanGroups = null }) {
  const built = grouped
    ? buildScrambleGroups({ clanGroups, parties: [{ members: sc.party }], players: sc.players })
    : { groups: clanGroups, membersOnlyTags: null };
  const plan = await Scrambler.scrambleTeamsPreservingSquads({
    squads: sc.tfSquads,
    players: sc.tfPlayers,
    winStreakTeam: 1,
    scramblePercentage: 0.5,
    clanGroups: built.groups,
    membersOnlyTags: built.membersOnlyTags,
    pullEntireSquads
  });
  const moved = new Set(plan.map((m) => m.eosID));
  const movedCount = sc.party.filter((id) => moved.has(id)).length;
  return { plan, built, split: movedCount > 0 && movedCount < sc.party.length };
}

// Two members in the biggest Team 1 squad, one in the next.
const acrossTwoSquads = ({ t1Squads }) => [t1Squads[0].players[0], t1Squads[0].players[1], t1Squads[1].players[0]];

test('a party spread over two squads is never split by the plan (and is, without grouping)', async () => {
  let splitGrouped = 0;
  let splitControl = 0;
  for (let run = 0; run < RUNS; run++) {
    const sc = scenario(acrossTwoSquads);
    if ((await scramble(sc, { grouped: true })).split) splitGrouped++;
    if ((await scramble(sc, { grouped: false })).split) splitControl++;
  }
  assert.equal(splitGrouped, 0, `split in ${splitGrouped}/${RUNS} grouped runs`);
  assert.ok(splitControl > 0, 'the control never split the party, so this scenario proves nothing');
});

test('a party with a squadless member is never split by the plan (and is, without grouping)', async () => {
  const withSquadless = ({ players, t1Squads }) => {
    const loose = players.find((p) => p.teamID === 1 && p.squadID === null);
    assert.ok(loose, 'the roster has an unassigned Team 1 player');
    return [t1Squads[0].players[0], t1Squads[0].players[1], loose.eosID];
  };
  let splitGrouped = 0;
  let splitControl = 0;
  for (let run = 0; run < RUNS; run++) {
    const sc = scenario(withSquadless, { unassignedRatio: 0.15 });
    if ((await scramble(sc, { grouped: true })).split) splitGrouped++;
    if ((await scramble(sc, { grouped: false })).split) splitControl++;
  }
  assert.equal(splitGrouped, 0, `split in ${splitGrouped}/${RUNS} grouped runs`);
  assert.ok(splitControl > 0, 'the control never split the party, so this scenario proves nothing');
});

test('a party-only unit takes just its member from the second squad; a clan unit pulls the whole squad', async () => {
  const sc = scenario(acrossTwoSquads);
  const [anchorSquad, otherSquad] = sc.squads
    .filter((s) => s.teamID === 1 && s.players.length >= 4)
    .sort((a, b) => b.players.length - a.players.length);

  const asParty = await scramble(sc, { grouped: true, pullEntireSquads: true });
  const partyUnit = asParty.plan.virtualSquads.find((vs) => vs.members.includes(sc.party[0]));
  assert.equal(partyUnit.members.length, 3);
  assert.equal(partyUnit.members.length + partyUnit.pulled.length, anchorSquad.players.length + 1);
  assert.ok(partyUnit.tag.startsWith(PARTY_TAG_PREFIX));

  // The same three players as a clan group: the second squad comes whole.
  const asClan = await scramble(sc, { grouped: false, pullEntireSquads: true, clanGroups: { NL: sc.party } });
  const clanUnit = asClan.plan.virtualSquads.find((vs) => vs.members.includes(sc.party[0]));
  assert.equal(clanUnit.members.length + clanUnit.pulled.length, anchorSquad.players.length + otherSquad.players.length);
});

test('a party merged into a clan moves with the clan as one unit', async () => {
  let split = 0;
  for (let run = 0; run < RUNS; run++) {
    // Clan: three players of the biggest squad. Party: one of them plus a
    // player from the next squad.
    let clan;
    const sc = scenario(({ t1Squads }) => {
      clan = t1Squads[0].players.slice(0, 3);
      return [clan[2], t1Squads[1].players[0]];
    });
    const { plan, built } = await scramble(sc, { grouped: true, clanGroups: { NL: clan } });
    assert.deepEqual(Object.keys(built.groups), ['NL']);
    const moved = new Set(plan.map((m) => m.eosID));
    const unit = [...new Set([...clan, ...sc.party])];
    const movedCount = unit.filter((id) => moved.has(id)).length;
    if (movedCount > 0 && movedCount < unit.length) split++;
  }
  assert.equal(split, 0);
});

// ── The scramble report ──────────────────────────────────────────

test('the report names a party unit and explains the marker in its legend', async () => {
  const p = (eosID, name, teamID, squadID) => ({ eosID, name, teamID, squadID, steamID: eosID });
  const players = [p('e1', 'Mandela', '1', '1'), p('e2', 'Kovacs', '1', '1'), p('e3', 'Okonkwo', '1', '2'), p('e4', 'Ridley', '2', '3')];
  const squads = [
    { squadID: '1', teamID: '1', squadName: 'Alpha', players: ['e1', 'e2'] },
    { squadID: '2', teamID: '1', squadName: 'Bravo', players: ['e3'] },
    { squadID: '3', teamID: '2', squadName: 'Charlie', players: ['e4'] }
  ];
  const tag = `${PARTY_TAG_PREFIX}Mandela +2`;
  const plan = [
    { eosID: 'e1', targetTeamID: '2' }, { eosID: 'e2', targetTeamID: '2' }, { eosID: 'e3', targetTeamID: '2' },
    { eosID: 'e4', targetTeamID: '1' }
  ];
  plan.calculationTime = 5;
  plan.virtualSquads = [{ teamID: '1', tag, tags: [tag], anchorEosID: 'e1', members: ['e1', 'e2', 'e3'], pulled: [] }];

  const balancer = {
    server: { players, squads },
    getTeamName: (id) => (String(id) === '1' ? 'USA' : 'RGF'),
    localize: (key, vars) => localize(key, vars, 'en')
  };
  const message = await DiscordHelpers.createScrambleDetailsMessage(plan, false, balancer, null);
  const embed = message.embeds ? message.embeds[0] : message;
  const body = embed.fields.map((f) => f.value).join('\n');
  assert.ok(body.includes(tag), 'the unit is named after the party');
  assert.match(embed.footer.text, new RegExp(`${PARTY_TAG_PREFIX.trim()} Squad party`));

  // No party unit in the plan, no legend entry for it.
  const plain = [{ eosID: 'e4', targetTeamID: '1' }];
  plain.calculationTime = 5;
  const plainMessage = await DiscordHelpers.createScrambleDetailsMessage(plain, false, balancer, null);
  const plainEmbed = plainMessage.embeds ? plainMessage.embeds[0] : plainMessage;
  assert.ok(!(plainEmbed.footer?.text || '').includes('Squad party'));
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
