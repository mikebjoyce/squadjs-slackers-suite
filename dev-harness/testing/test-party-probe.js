/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          PARTY PROBE TEST                                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Exercises dev-harness/plugins/party-probe.js before it goes on the
 * live server: census counts, the party-drag verdict on a team-change
 * tick, round-transition suppression, join-time party assignment, the
 * raw RCON sample against the fork's regex, and that a throwing handler
 * never escapes into SquadJS's emit loop.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node dev-harness/testing/test-party-probe.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - No running SquadJS required; server, RCON and S³ are all mocked.
 * - Same sandbox pattern as test-dev-rcon-harness.js: a stub
 *   base-plugin.js lives in an OS temp dir, never in dev-harness/plugins/.
 * - The mocks prove the probe's own bookkeeping only. What real parties
 *   look like is exactly what the probe exists to find out.
 *
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.join(HERE, '..', 'plugins', 'party-probe.js');

const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), 'party-probe-'));

await fs.mkdir(path.join(SANDBOX, 'plugins'), { recursive: true });
await fs.writeFile(
  path.join(SANDBOX, 'plugins', 'base-plugin.js'),
  `export default class BasePlugin {
  constructor(server, options, connectors) {
    this.server = server;
    const spec = this.constructor.optionsSpecification || {};
    const defaults = {};
    for (const [key, def] of Object.entries(spec)) defaults[key] = def.default;
    this.options = { ...defaults, ...options };
    this.logs = [];
  }
  verbose(level, message) { this.logs.push(\`[v\${level}] \${message}\`); }
}
`,
  'utf8'
);
await fs.copyFile(PLUGIN_SRC, path.join(SANDBOX, 'plugins', 'party-probe.js'));
const { default: PartyProbe } = await import(pathToFileURL(path.join(SANDBOX, 'plugins', 'party-probe.js')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err.stack}`);
  }
}

// 24 players: party 5 = A,B,C on T1; party 7 = D,E on T2; rest unique ids.
function roster() {
  const players = [
    { eosID: 'A', name: 'Alpha', teamID: 1, squadID: 1, partyID: 5 },
    { eosID: 'B', name: 'Bravo', teamID: 1, squadID: 1, partyID: 5 },
    { eosID: 'C', name: 'Charlie', teamID: 1, squadID: 2, partyID: 5 },
    { eosID: 'D', name: 'Delta', teamID: 2, squadID: 1, partyID: 7 },
    { eosID: 'E', name: 'Echo', teamID: 2, squadID: 1, partyID: 7 }
  ];
  for (let i = 0; i < 17; i++) {
    players.push({ eosID: `S${i}`, name: `Solo${i}`, teamID: i % 2 ? 1 : 2, squadID: 3, partyID: 100 + i });
  }
  players.push({ eosID: 'N', name: 'NoParty', teamID: null, squadID: null, partyID: null });
  players.push({ eosID: 'L', name: 'Legacy', teamID: 1, squadID: 4 }); // no partyID field at all
  return players;
}

async function makeProbe(options = {}, rconResponses = {}) {
  const dataDir = await fs.mkdtemp(path.join(SANDBOX, 'data-'));
  const server = new EventEmitter();
  server.players = roster();
  server.rcon = { execute: async (cmd) => rconResponses[cmd] ?? '' };
  const probe = new PartyProbe(server, {
    enabled: true,
    dataDir,
    censusIntervalMinutes: 999,
    rawSampleIntervalMinutes: 999,
    attributionDelayMs: 10,
    ...options
  }, {});
  await probe.mount();
  const entries = async () => {
    const text = await fs.readFile(path.join(dataDir, 'party-probe.jsonl'), 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  };
  const tick = () => server.emit('UPDATED_PLAYER_INFORMATION');
  const move = (eosID, teamID) => { server.players.find((p) => p.eosID === eosID).teamID = teamID; };
  return { probe, server, entries, tick, move, dataDir };
}

console.log('\nPartyProbe');

await test('disabled probe attaches no listeners', async () => {
  const server = new EventEmitter();
  const probe = new PartyProbe(server, {}, {});
  await probe.mount();
  assert.equal(server.listenerCount('UPDATED_PLAYER_INFORMATION'), 0);
  await probe.unmount();
});

await test('census counts party field shapes, sizes and largest parties', async () => {
  const { probe, server, entries, tick } = await makeProbe({ censusIntervalMinutes: 0 });
  server.squads = [
    { teamID: 1, squadID: 1, squadName: 'ALPHA PARTY', creatorName: 'Alpha' },
    { teamID: 1, squadID: 2, squadName: 'Squad 2', creatorName: 'Zulu' }
  ];
  tick();
  const census = (await entries()).find((e) => e.kind === 'census');
  assert.ok(census, 'census entry written');
  assert.deepEqual(census.largest[0].squadNames, ['ALPHA PARTY', 'Squad 2'], 'party 5 spans squads 1 and 2');
  assert.deepEqual(census.largest[0].squadCreators, ['Alpha', 'Zulu']);
  assert.equal(census.players, 24);
  assert.deepEqual(census.partyField, { number: 22, null: 1, absent: 1 });
  assert.equal(census.distinctPartyIDs, 19);
  assert.deepEqual(census.sizeHistogram, { 1: 17, 2: 1, 3: 1 });
  assert.equal(census.largest[0].partyID, 5);
  assert.equal(census.largest[0].size, 3);
  assert.equal(census.spanningSquadsCount, 1, 'party 5 spans squads 1 and 2');
  assert.equal(census.spanningBothTeams.length, 0);
  assert.deepEqual(census.oversized, [], 'nothing above the default cap of 9');
  await probe.unmount();
});

await test('census flags a party id shared by more players than the cap', async () => {
  const { probe, entries, tick } = await makeProbe({ censusIntervalMinutes: 0, maxPartySize: 2 });
  tick();
  const census = (await entries()).find((e) => e.kind === 'census');
  assert.deepEqual(census.oversized, [{ partyID: 5, size: 3 }]);
  await probe.unmount();
});

await test('census is skipped below minPlayersForSample', async () => {
  const { probe, entries, tick } = await makeProbe({ censusIntervalMinutes: 0, minPlayersForSample: 50 });
  tick();
  assert.equal((await entries()).filter((e) => e.kind === 'census').length, 0);
  await probe.unmount();
});

await test('drag: one attributed move plus party mates moving the same tick', async () => {
  const { probe, server, entries, tick, move } = await makeProbe();
  tick();
  move('A', 2); move('B', 2); move('C', 2);
  tick();
  // S³ emits after the tick; the probe waits attributionDelayMs before reading.
  server.emit('S3_PLAYER_TEAM_CHANGED', { player: { eosID: 'A' }, source: 'TeamBalancer:Full' });
  server.emit('S3_PLAYER_TEAM_CHANGED', { player: { eosID: 'B' }, source: 'Manual/Game' });
  server.emit('S3_PLAYER_TEAM_CHANGED', { player: { eosID: 'C' }, source: 'Admin' });
  await sleep(40);
  const entry = (await entries()).find((e) => e.kind === 'team-change-tick');
  assert.ok(entry, 'team-change-tick written');
  assert.equal(entry.changes.length, 3);
  const party = entry.parties.find((p) => p.partyID === 5);
  assert.equal(party.verdict, 'leader-drag');
  assert.equal(party.inferredLeader, 'Alpha');
  assert.deepEqual(party.attributed, ['Alpha']);
  assert.deepEqual(party.unattributedMovedWith.sort(), ['Bravo', 'Charlie']);
  assert.deepEqual(party.movedOpposite, []);
  assert.deepEqual(party.leftBehind, []);
  const charlie = entry.changes.find((c) => c.eosID === 'C');
  assert.equal(charlie.squadBefore, 2, 'squad before the move is kept');
  await probe.unmount();
});

await test('leader move with a mate already on the destination team: mate recorded as already there', async () => {
  const { probe, server, entries, tick, move } = await makeProbe();
  move('C', 2); // Charlie already crossed to T2 earlier
  tick();
  move('A', 2); move('B', 2);
  tick();
  server.emit('S3_PLAYER_TEAM_CHANGED', { player: { eosID: 'A' }, source: 'TeamBalancer:Full' });
  server.emit('S3_PLAYER_TEAM_CHANGED', { player: { eosID: 'B' }, source: 'Admin' });
  await sleep(40);
  const party = (await entries()).find((e) => e.kind === 'team-change-tick').parties[0];
  assert.equal(party.verdict, 'leader-drag');
  assert.deepEqual(party.matesAlreadyThere, ['Charlie'], 'stayed on T2 = the drag sets a team');
  await probe.unmount();
});

await test('leader move that swaps a mate the other way is flagged, not called a clean drag', async () => {
  const { probe, server, entries, tick, move } = await makeProbe();
  move('C', 2);
  tick();
  move('A', 2); move('B', 2); move('C', 1); // Charlie swapped back to T1
  tick();
  server.emit('S3_PLAYER_TEAM_CHANGED', { player: { eosID: 'A' }, source: 'TeamBalancer:Full' });
  await sleep(40);
  const party = (await entries()).find((e) => e.kind === 'team-change-tick').parties[0];
  assert.equal(party.verdict, 'mixed');
  assert.deepEqual(party.movedOpposite, ['Charlie'], 'swapped = the drag toggles each member');
  assert.deepEqual(party.matesAlreadyThere, []);
  await probe.unmount();
});

await test('a party move snapshots ListParties, at most once per cooldown', async () => {
  const calls = [];
  // Periodic samples are population-gated; push the gate out of reach so only
  // the party-move snapshot (which is not gated) can call RCON.
  const { probe, server, entries, tick, move } = await makeProbe({ minPlayersForSample: 999 });
  server.rcon.execute = async (cmd) => { calls.push(cmd); return 'Party #5 | Leader: Alpha\r\n'; };
  tick();
  move('D', 1);
  tick();
  await sleep(40);
  move('E', 1);
  tick();
  await sleep(40);
  assert.deepEqual(calls, ['ListParties'], 'second party move inside the cooldown takes no snapshot');
  const raw = (await entries()).find((e) => e.kind === 'raw-sample');
  assert.equal(raw.reason, 'party-move');
  assert.deepEqual(raw.ListParties.sample, ['Party #5 | Leader: Alpha']);
  await probe.unmount();
});

await test('admin-chat marker writes the note and snapshots at once; other chat is ignored', async () => {
  const calls = [];
  const { probe, server, entries } = await makeProbe();
  server.rcon.execute = async (cmd) => { calls.push(cmd); return ''; };
  server.emit('CHAT_MESSAGE', { chat: 'ChatAll', message: '!partyprobe not admin chat', player: { name: 'Rando' } });
  server.emit('CHAT_MESSAGE', { chat: 'ChatAdmin', message: '!partyprobeX nope', player: { name: 'Slacker' } });
  server.emit('CHAT_MESSAGE', { chat: 'ChatAdmin', message: '!partyprobe moving Bravo (member) to T2', player: { name: 'Slacker' } });
  await sleep(40);
  const all = await entries();
  const markers = all.filter((e) => e.kind === 'marker');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].note, 'moving Bravo (member) to T2');
  assert.equal(markers[0].admin, 'Slacker');
  assert.deepEqual(calls, ['ListParties', 'ListPlayers']);
  assert.equal(all.find((e) => e.kind === 'raw-sample').reason, 'marker');
  await probe.unmount();
});

await test('no drag: the party mate who stayed is listed as left behind', async () => {
  const { probe, server, entries, tick, move } = await makeProbe();
  tick();
  move('D', 1);
  tick();
  server.emit('S3_PLAYER_TEAM_CHANGED', { player: { eosID: 'D' }, source: 'Player-Self' });
  await sleep(40);
  const party = (await entries()).find((e) => e.kind === 'team-change-tick').parties[0];
  assert.equal(party.verdict, 'member-solo');
  assert.equal(party.inferredLeader, null);
  assert.deepEqual(party.attributed, ['Delta']);
  assert.deepEqual(party.unattributedMovedWith, []);
  assert.deepEqual(party.leftBehind.map((m) => m.name), ['Echo']);
  await probe.unmount();
});

await test('a solo move records no party and a null source without S³', async () => {
  const { probe, entries, tick, move } = await makeProbe();
  tick();
  move('S0', 1);
  tick();
  await sleep(40);
  const entry = (await entries()).find((e) => e.kind === 'team-change-tick');
  assert.equal(entry.changes[0].source, null);
  assert.equal(entry.parties.length, 1, 'solo still has a numeric id here');
  assert.equal(entry.parties[0].size, 1);
  await probe.unmount();
});

await test('a round-transition swap is summarised, not analysed', async () => {
  const { probe, server, entries, tick } = await makeProbe();
  tick();
  for (const p of server.players) if (p.teamID) p.teamID = p.teamID === 1 ? 2 : 1;
  tick();
  await sleep(40);
  const all = await entries();
  assert.equal(all.filter((e) => e.kind === 'team-change-tick').length, 0);
  assert.equal(all.find((e) => e.kind === 'mass-team-change').count, 23);
  await probe.unmount();
});

await test('a joining party member is checked against their mates\' team', async () => {
  const { probe, server, entries, tick } = await makeProbe();
  tick();
  server.players.push({ eosID: 'F', name: 'Foxtrot', teamID: null, squadID: null, partyID: 7 });
  tick();
  server.players.find((p) => p.eosID === 'F').teamID = 1;
  tick();
  const assigned = (await entries()).filter((e) => e.kind === 'party-member-assigned');
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].name, 'Foxtrot');
  assert.equal(assigned[0].sameTeamAsAllMates, false, 'mates D and E are on T2');
  await probe.unmount();
});

await test('party id changes are logged per player, and summarised when many', async () => {
  const { probe, server, entries, tick } = await makeProbe();
  tick();
  server.players.find((p) => p.eosID === 'E').partyID = 42;
  tick();
  server.emit('NEW_GAME');
  for (const p of server.players) if (typeof p.partyID === 'number') p.partyID += 1000;
  tick();
  const changes = (await entries()).filter((e) => e.kind === 'party-id-changed');
  assert.equal(changes[0].eosID, 'E');
  assert.equal(changes[0].from, 7);
  assert.equal(changes[0].to, 42);
  assert.equal(changes[1].count, 22);
  assert.equal(changes[1].crossedNewGame, true);
  await probe.unmount();
});

await test('raw sample saves verbatim output and flags lines the fork regex misses', async () => {
  const listPlayers = [
    '----- Active Players -----',
    'ID: 5 | Online IDs: EOS: a steam: 1 | Name: Alpha | Team ID: 1 | Party ID: #0 | Squad ID: 1 | Is Leader: True | Role: X_SL_01 | Vehicle: N/A',
    'ID: 6 | Online IDs: EOS: b steam: 2 | Name: Bravo | Team ID: 1 | Squad ID: 1 | Is Leader: False | Role: X_Rifleman_01',
    'ID: 7 | Online IDs: EOS: c steam: 3 | Name: Charlie | Team ID: 1 | Party ID: #3 | Squad ID: 1 | Is Leader: False | Role: X_Medic_01 | Vehicle: N/A | Something New: 1',
    '----- Recently Disconnected Players [Max of 15] -----',
    'ID: 2 | Online IDs: EOS: d steam: 4 | Since Disconnect: 04m.32s | Name: Gone',
    ''
  ].join('\r\n');
  const { probe, entries, tick } = await makeProbe(
    { rawSampleIntervalMinutes: 0 },
    {
      ListPlayers: listPlayers,
      ListSquads: '----- Active Squads -----\r\n',
      ListParties: '----- Parties -----\r\nParty #3 | Leader: Charlie\r\n'
    }
  );
  tick();
  await sleep(40);
  const raw = (await entries()).find((e) => e.kind === 'raw-sample');
  assert.ok(raw, 'raw-sample written');
  assert.equal(raw.ListPlayers.crlf, true);
  assert.equal(raw.ListPlayers.playerLines, 3, 'disconnected line excluded');
  assert.equal(raw.ListPlayers.withPartyField, 2);
  assert.equal(raw.ListPlayers.unmatchedByForkRegex, 0,
    'the trailing extra field is swallowed by the Vehicle group — a known blind spot of the fork regex');
  assert.equal(raw.ListPlayers.fieldLabels['Something New'], 1, 'field inventory catches what the regex hides');
  assert.equal(raw.ListPlayers.fieldLabels['Party ID'], 2);
  assert.equal(raw.ListPlayers.fieldLabels['Team ID'], 3);
  assert.equal(await fs.readFile(raw.ListPlayers.file, 'utf8'), listPlayers, 'saved verbatim');
  assert.ok(raw.ListSquads.file);
  assert.deepEqual(raw.ListParties.sample, ['----- Parties -----', 'Party #3 | Leader: Charlie'],
    'unknown-format ListParties head goes into the log verbatim, CR stripped');
  await probe.unmount();
});

await test('a failing RCON sample is recorded, not thrown', async () => {
  const { probe, server, entries, tick } = await makeProbe({ rawSampleIntervalMinutes: 0 });
  server.rcon.execute = async () => { throw new Error('Not connected.'); };
  tick();
  await sleep(40);
  const raw = (await entries()).find((e) => e.kind === 'raw-sample');
  assert.equal(raw.ListPlayers.error, 'Not connected.');
  await probe.unmount();
});

await test('a throwing handler never escapes into the emit loop', async () => {
  const { probe, server } = await makeProbe();
  let later = false;
  server.on('UPDATED_PLAYER_INFORMATION', () => { later = true; });
  Object.defineProperty(server, 'players', { get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => server.emit('UPDATED_PLAYER_INFORMATION'));
  assert.equal(later, true, 'listeners after the probe still ran');
  assert.ok(probe.logs.some((l) => l.includes('tick failed: boom')));
  await probe.unmount();
});

const lpLine = (id, eos, name, team, party, squad) =>
  `ID: ${id} | Online IDs: EOS: ${eos} steam: 7656${id} | Name: ${name} | Team ID: ${team} | Party ID: ${party} | Squad ID: ${squad} | Is Leader: False | Role: X_Rifleman_01 | Vehicle: N/A`;

await test('join timeline: direct RCON sees the party before the tick does, and the entry says which came first', async () => {
  // RCON answers: first query — listed with no party; second — party #7, squad 1.
  const answers = [
    lpLine(9, 'G', 'Golf', 2, 'N/A', 'N/A'),
    lpLine(9, 'G', 'Golf', 2, '#7', '1')
  ];
  const { probe, server, entries, tick } = await makeProbe({
    minPlayersForSample: 999, joinQueryDelaysMs: [0, 30], joinQueryMinGapMs: 5, joinTimelineSeconds: 0.15
  });
  server.rcon.execute = async () => answers.shift() ?? answers[answers.length - 1] ?? '';
  tick();
  server.emit('PLAYER_CONNECTED', { player: { eosID: 'G', name: 'Golf' } });
  await sleep(60);
  server.players.push({ eosID: 'G', name: 'Golf', teamID: 2, squadID: null, partyID: null });
  tick();
  server.players.find((p) => p.eosID === 'G').partyID = 7;
  server.players.find((p) => p.eosID === 'G').squadID = 1;
  tick();
  await sleep(150);
  tick();
  const tl = (await entries()).find((e) => e.kind === 'join-timeline' && e.eosID === 'G');
  assert.ok(tl, 'join-timeline written once the window elapses');
  assert.equal(tl.sawConnectEvent, true);
  assert.equal(tl.firstParty.src, 'rcon', 'the direct query saw the party first');
  assert.deepEqual(tl.atFirstTick, { teamID: 2, squadID: null, partyID: null });
  assert.equal(tl.firstSquad.src, 'rcon');
  assert.equal(tl.endedInParty, true);
  assert.equal(tl.left, false);
  assert.ok(tl.samples.length >= 3, 'changes only, from both sources');
  await probe.unmount();
});

await test('a burst of joins shares join queries instead of one per joiner', async () => {
  let calls = 0;
  const { probe, server } = await makeProbe({
    minPlayersForSample: 999, joinQueryDelaysMs: [0], joinQueryMinGapMs: 50
  });
  server.rcon.execute = async () => { calls++; return ''; };
  for (let i = 0; i < 10; i++) server.emit('PLAYER_CONNECTED', { player: { eosID: `J${i}`, name: `J${i}` } });
  await sleep(120);
  assert.ok(calls <= 2, `10 joins made ${calls} queries`);
  await probe.unmount();
});

await test('a joiner who leaves inside the window is written with left: true; the cap is honoured', async () => {
  const { probe, server, entries, tick } = await makeProbe({
    minPlayersForSample: 999, joinQueryDelaysMs: [], maxTrackedJoiners: 1, joinTimelineSeconds: 60
  });
  tick();
  server.players.push({ eosID: 'H', name: 'Hotel', teamID: 1, squadID: null, partyID: null });
  server.players.push({ eosID: 'I', name: 'India', teamID: 1, squadID: null, partyID: null });
  tick();
  assert.equal(probe._joiners.size, 1, 'second joiner not followed past the cap');
  server.players = server.players.filter((p) => p.eosID !== 'H' && p.eosID !== 'I');
  tick();
  const tl = (await entries()).filter((e) => e.kind === 'join-timeline');
  assert.equal(tl.length, 1);
  assert.equal(tl[0].left, true);
  assert.equal(tl[0].sawConnectEvent, false);
  await probe.unmount();
});

await test('party-joiner-context: a squadless party joiner gets one entry with their mates\' squads as they were at join', async () => {
  const { probe, server, entries, tick } = await makeProbe({ minPlayersForSample: 999, joinQueryDelaysMs: [] });
  tick();
  server.squads = [
    { teamID: 1, squadID: 1, size: 9, locked: true },
    { teamID: 1, squadID: 2, size: 4, locked: false }
  ];
  server.players.push({ eosID: 'G', name: 'Golf', teamID: 1, squadID: null, partyID: null });
  tick();
  server.squads = [
    { teamID: 1, squadID: 1, size: 9, locked: true },
    { teamID: 1, squadID: 2, size: 5, locked: false }
  ];
  const golf = server.players.find((p) => p.eosID === 'G');
  golf.partyID = 5;
  golf.squadID = 2;
  tick();
  tick();
  const ctx = (await entries()).filter((e) => e.kind === 'party-joiner-context');
  assert.equal(ctx.length, 1, 'written once, on the first tick with an ID');
  assert.equal(ctx[0].eosID, 'G');
  assert.equal(ctx[0].joinedInSquad, false);
  assert.equal(ctx[0].squadNow, 2);
  assert.deepEqual(ctx[0].ownSquadNow, { size: 5, locked: false });
  assert.deepEqual(ctx[0].mates.map((m) => m.name).sort(), ['Alpha', 'Bravo', 'Charlie']);
  const alpha = ctx[0].mates.find((m) => m.name === 'Alpha');
  assert.deepEqual(alpha.squadThen, { size: 9, locked: true }, 'squad 1 was full and locked when Golf arrived');
  assert.equal(alpha.joinedMsBeforeThisPlayer, null, 'Alpha was on before tracking started');
  await probe.unmount();
});

await test('join prediction: each join is judged at 30 s and the census carries the running counts', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const { probe, server, entries, tick } = await makeProbe({
      minPlayersForSample: 1, censusIntervalMinutes: 0, joinQueryDelaysMs: [], joinTimelineSeconds: 40
    });
    tick();
    const join = (eosID, squadID) => server.players.push({ eosID, name: eosID, teamID: 2, squadID, partyID: null });
    join('HIT', 4);      // in a squad, party ID follows: hit
    join('FA', 4);       // in a squad, never a party: false alarm
    join('MISS', null);  // squadless, party ID follows: miss
    join('OK', null);    // squadless, never a party: correct
    join('GONE', null);  // leaves at 10 s: unjudged
    tick();
    clock += 10000;
    server.players.find((p) => p.eosID === 'HIT').partyID = 7;
    server.players.find((p) => p.eosID === 'MISS').partyID = 7;
    server.players = server.players.filter((p) => p.eosID !== 'GONE');
    tick();
    clock += 31000;
    tick();
    const tl = Object.fromEntries((await entries()).filter((e) => e.kind === 'join-timeline').map((e) => [e.eosID, e]));
    assert.equal(tl.HIT.prediction, 'likely-party');
    assert.equal(tl.HIT.judged, 'hit');
    assert.equal(tl.FA.judged, 'falseAlarm');
    assert.equal(tl.MISS.prediction, 'solo');
    assert.equal(tl.MISS.judged, 'miss');
    assert.equal(tl.OK.judged, 'correct');
    assert.equal(tl.GONE.judged, 'unjudged');
    const census = (await entries()).filter((e) => e.kind === 'census').pop();
    assert.deepEqual(census.joinPrediction, { hit: 1, falseAlarm: 1, miss: 1, correct: 1, unjudged: 1 });
    await probe.unmount();
  } finally {
    Date.now = realNow;
  }
});

await test('unmount removes every listener and pending timer', async () => {
  const { probe, server, tick, move } = await makeProbe({ attributionDelayMs: 5000 });
  tick();
  move('A', 2);
  tick();
  assert.equal(probe._timers.size, 1);
  await probe.unmount();
  assert.equal(probe._timers.size, 0);
  for (const ev of ['UPDATED_PLAYER_INFORMATION', 'S3_PLAYER_TEAM_CHANGED', 'NEW_GAME', 'CHAT_MESSAGE', 'PLAYER_CONNECTED']) {
    assert.equal(server.listenerCount(ev), 0, ev);
  }
});

await fs.rm(SANDBOX, { recursive: true, force: true });
console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
