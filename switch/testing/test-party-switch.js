/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   TEST: SQUAD PARTIES — a party switches as a group            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Since Squad's party patch, force-moving a party's leader takes the
 * whole party along and force-moving any other member splits it, and
 * RCON does not say who leads. A solo !switch from a party member is
 * therefore wrong either way. switch-parties.js makes it a request for
 * the party; this file pins that against the real shipped files and a
 * fake RCON that implements the drag (s3/testing/fake-party-rcon.js):
 *
 *   - a party moves together whichever member asks, and whoever leads;
 *   - size cap, with liberal mode exempt;
 *   - one member's lockout bars the party, and tokens never do;
 *   - each member who moves pays one token, never below zero;
 *   - a split party is reunited by one half asking;
 *   - a party that does not fit queues as one entry, found from any
 *     member, served only when all of it fits, with solo entries
 *     behind it still served;
 *   - a queue entry is cancelled when the party behind it changes, on
 *     the parties-changed notice and again just before any move;
 *   - the SmartAssign handshake never takes a party's entry;
 *   - admin moves name the party mates left behind;
 *   - a party member's own double switch is refused.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-party-switch.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Category 1: no database engine. The two models the gate and the
 *   token spend read are in-memory stand-ins, because nothing here is
 *   about SQL. Wallet and lock behaviour against real engines lives in
 *   test-admin-mutations.js and test-seed-token-lifecycle.js.
 * - The real gate reads Date.now(), so lockouts are staged by writing
 *   timestamps rather than by moving a clock.
 */

'use strict';

import assert from 'node:assert/strict';

import SwitchOutput from '../utils/switch-output.js';
import SwitchQueue from '../utils/switch-queue.js';
import SwitchParties from '../utils/switch-parties.js';
import SwitchCommands from '../utils/switch-commands.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';
import { createPartyWorld } from '../../s3/testing/fake-party-rcon.js';

const ASSEMBLY = buildAssembly('.tmp-switch-party');
const Switch = await importFromAssembly(ASSEMBLY, 'switch.js');

let passed = 0;
let failed = 0;
const live = [];

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  } finally {
    // Queue entries hold a 30s interval each; a leftover one keeps node alive.
    for (const plugin of live.splice(0)) plugin._clearAllQueueEntries('test end');
  }
}

/** `count` solo players on one team. */
function fillers(teamID, count) {
  return Array.from({ length: count }, (_, i) => ({
    eosID: `f${teamID}-${i}`, steamID: `sf${teamID}-${i}`, name: `Filler${teamID}${i}`, teamID, squadID: null
  }));
}

const P = (eosID, teamID, extra = {}) => ({ eosID, steamID: `s-${eosID}`, name: eosID, teamID, squadID: 1, ...extra });

/**
 * A real Switch instance over a fake party world.
 *
 * The roster's `party` field is the party, exactly as the fake RCON reads
 * it, and the S³ stand-in derives getParty() from the same field, so what
 * the plugin is told about parties and what a forced move does agree.
 */
function buildScene(roster, { options = {} } = {}) {
  const world = createPartyWorld(roster);
  const wallets = new Map();
  const serverStates = new Map();
  const warns = [];
  const partyListeners = new Set();

  const partyOf = (eosID) => {
    const me = world.roster.find((p) => p.eosID === eosID);
    if (!me || !me.party) return null;
    const members = world.roster.filter((p) => p.party === me.party).map((p) => p.eosID);
    return { key: `key-${me.party}`, partyID: 0, members, size: members.length };
  };

  const server = { players: world.roster, rcon: world.rcon, on: () => {}, off: () => {}, removeListener: () => {} };
  const plugin = new Switch(server, {}, {});
  SwitchOutput.register(plugin);
  SwitchQueue.register(plugin);
  SwitchParties.register(plugin);
  SwitchCommands.register(plugin);
  live.push(plugin);

  const cooldowns = {
    findByPk: async (eosID) => (wallets.has(eosID) ? { ...wallets.get(eosID) } : null),
    upsert: async (fields) => { wallets.set(fields.eosID, { ...wallets.get(fields.eosID), ...fields }); }
  };
  const states = { findOne: async ({ where }) => serverStates.get(where.eosID) ?? null };

  Object.assign(plugin.options, { dynamicBalanceTolerance: false, doubleSwitchDelaySeconds: 0, ...options });
  Object.assign(plugin, {
    verbose: () => {},
    warn: (eosID, message) => { warns.push([eosID, message]); },
    // The key and its variables, so a test can assert which message went out.
    localize: (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    timeLimitEnabled: true,
    _liberalModes: ['seed'],
    _roundStats: plugin._initRoundStats(),
    _s3db: {
      models: { SwitchPlugin_PlayerCooldowns: cooldowns, SwitchPlugin_PlayerServerState: states },
      isReady: () => true,
      shouldSkipDb: () => false,
      getServerID: () => 1,
      withTransactionWithRetry: async (fn) => fn({ LOCK: { UPDATE: 'UPDATE' } })
    },
    _s3: {
      gameState: {
        getLayerName: () => scene.layerName,
        getGamemode: () => 'RAAS',
        getPhase: () => 'LIVE',
        isEndgameFactionVote: () => false,
        getRoundStartTime: () => Date.now() - 60_000
      },
      players: {
        ...world.players,
        isReady: () => true,
        canAct: (eosID) => !scene.locked.has(eosID),
        getJoinTime: () => Date.now() - 60_000,
        getParty: partyOf,
        isInParty: (eosID) => (partyOf(eosID)?.size ?? 0) >= 2,
        onPartiesChanged: (cb) => { partyListeners.add(cb); return () => partyListeners.delete(cb); },
        requestRefresh: () => {},
        registerRefreshInterest: () => {},
        unregisterRefreshInterest: () => {}
      }
    }
  });

  const scene = {
    world, plugin, wallets, serverStates, warns, partyListeners,
    layerName: 'Fallujah_RAAS_v2',
    locked: new Set(),
    row: (eosID) => world.roster.find((p) => p.eosID === eosID),
    /** What S³ does after a tick that changed a party. */
    partiesChanged() { for (const cb of [...partyListeners]) cb({ formed: [], changed: [], dissolved: [] }); },
    /** The keys of every message sent to one player. */
    warnsTo: (eosID) => warns.filter(([to]) => to === eosID).map(([, message]) => message.split(' ')[0]),
    chat: (eosID, message, chat = 'ChatAll') => {
      const p = scene.row(eosID);
      return plugin.onChatMessage({ player: { eosID: p.eosID, steamID: p.steamID, name: p.name, teamID: p.teamID }, message, chat });
    },
    setTeam: (eosIDs, teamID) => { for (const id of eosIDs) scene.row(id).teamID = teamID; },
    teams: () => {
      const count = { 1: 0, 2: 0 };
      for (const p of world.roster) count[p.teamID]++;
      return count;
    }
  };
  return scene;
}

/** A pair on Team 1 with room to move: 7 v 3, so two players leaving T1 lands on 5 v 5. */
function pairWithRoom(extra = {}) {
  return buildScene([
    P('Lead', 1, { party: 'A', leader: true }),
    P('Mate', 1, { party: 'A' }),
    ...fillers(1, 5), ...fillers(2, 3)
  ], extra);
}

/** The same pair with no room: 5 v 5, so two leaving T1 would make 3 v 7. */
function pairWithoutRoom(extra = {}) {
  return buildScene([
    P('Lead', 1, { party: 'A', leader: true }),
    P('Mate', 1, { party: 'A' }),
    ...fillers(1, 3), ...fillers(2, 5)
  ], extra);
}

console.log('');
console.log('🧪 Squad parties — a party switches as a group');
console.log('');

// ── 1. The move ───────────────────────────────────────────────────
await runTest('the option defaults to parties of three', async () => {
  const s = pairWithRoom();
  assert.strictEqual(s.plugin.options.maxPartySwitchSize, 3);
});

await runTest('the leader asks: one command moves both, and both end on the target', async () => {
  const s = pairWithRoom();
  await s.chat('Lead', '!switch');
  assert.deepStrictEqual(s.world.commands, ['Lead'], 'the dragged mate should cost no command');
  assert.strictEqual(s.world.teamOf('Lead'), 2);
  assert.strictEqual(s.world.teamOf('Mate'), 2);
});

await runTest('a member asks: the party still ends together', async () => {
  const s = pairWithRoom();
  await s.chat('Mate', '!switch');
  assert.strictEqual(s.world.teamOf('Lead'), 2);
  assert.strictEqual(s.world.teamOf('Mate'), 2);
  assert.ok(s.world.commands.length <= 2, 'at most one command per member');
});

await runTest('every member who moved is told, pays one token and gets the post-switch lockout', async () => {
  const s = pairWithRoom();
  await s.chat('Lead', '!switch');
  for (const id of ['Lead', 'Mate']) {
    assert.ok(s.warnsTo(id).includes('switch.warn.partySwitched'), `${id} was not told`);
    assert.strictEqual(s.wallets.get(id).tokenBalance, s.plugin.options.maxSwitchTokens - 1, `${id} did not pay one token`);
    assert.ok(s.plugin.recentSwitches.some((e) => e.eosID === id), `${id} has no post-switch lockout`);
  }
});

await runTest('a party switch is one round-stat entry carrying its size', async () => {
  const s = pairWithRoom();
  await s.chat('Lead', '!switch');
  const stats = s.plugin._roundStats.instantSwitches;
  assert.strictEqual(stats.length, 1, 'two members must not read as two switches');
  assert.strictEqual(stats[0].partySize, 2);
  assert.strictEqual(stats[0].toTeam, 2);
});

// ── 2. Size ───────────────────────────────────────────────────────
await runTest('a party over maxPartySwitchSize is refused and nobody moves', async () => {
  const s = buildScene([
    P('Lead', 1, { party: 'A', leader: true }), P('M1', 1, { party: 'A' }), P('M2', 1, { party: 'A' }), P('M3', 1, { party: 'A' }),
    ...fillers(1, 5), ...fillers(2, 1)
  ]);
  await s.chat('M1', '!switch');
  assert.deepStrictEqual(s.world.commands, []);
  assert.deepStrictEqual(s.warnsTo('M1'), ['switch.warn.partyTooLarge']);
  assert.strictEqual(s.plugin._getQueueSize(), 0);
});

await runTest('liberal mode moves a party of any size', async () => {
  const s = buildScene([
    P('Lead', 1, { party: 'A', leader: true }), P('M1', 1, { party: 'A' }), P('M2', 1, { party: 'A' }), P('M3', 1, { party: 'A' }),
    ...fillers(1, 5), ...fillers(2, 1)
  ]);
  s.layerName = 'Sumari_Seed_v1';
  await s.chat('M1', '!switch');
  for (const id of ['Lead', 'M1', 'M2', 'M3']) assert.strictEqual(s.world.teamOf(id), 2, `${id} did not move`);
  assert.strictEqual(s.wallets.size, 0, 'liberal mode charges no tokens');
});

// ── 3. Lockouts and tokens ────────────────────────────────────────
await runTest("a mate's scramble lockdown bars the party, and the refusal names nobody", async () => {
  const s = pairWithRoom();
  s.serverStates.set('Mate', { scrambleLockdownExpiry: new Date(Date.now() + 10 * 60_000) });
  await s.chat('Lead', '!switch');
  assert.deepStrictEqual(s.world.commands, []);
  assert.deepStrictEqual(s.warnsTo('Lead'), ['switch.warn.partyMemberLockedOut']);
  assert.ok(!s.warns.some(([, message]) => message.includes('Mate')), 'the refusal names the locked member');
  assert.deepStrictEqual(s.warnsTo('Mate'), [], 'the locked member is not messaged');
});

await runTest("a mate's post-switch lockout bars the party too", async () => {
  const s = pairWithRoom();
  s.plugin.recentSwitches.push({ eosID: 'Mate', datetime: new Date() });
  await s.chat('Lead', '!switch');
  assert.deepStrictEqual(s.world.commands, []);
  assert.deepStrictEqual(s.warnsTo('Lead'), ['switch.warn.partyMemberLockedOut']);
});

await runTest("the requester's own lockdown gets the ordinary, specific message", async () => {
  const s = pairWithRoom();
  s.serverStates.set('Lead', { scrambleLockdownExpiry: new Date(Date.now() + 10 * 60_000) });
  await s.chat('Lead', '!switch');
  assert.deepStrictEqual(s.world.commands, []);
  assert.deepStrictEqual(s.warnsTo('Lead'), ['switch.warn.switchScrambleLockActive']);
});

await runTest('tokens never bar a party: a member with none still moves and stays at zero', async () => {
  const s = pairWithRoom();
  s.wallets.set('Mate', { eosID: 'Mate', tokenBalance: 0, tokenRegenAnchor: new Date() });
  await s.chat('Lead', '!switch');
  assert.strictEqual(s.world.teamOf('Mate'), 2);
  assert.strictEqual(s.wallets.get('Mate').tokenBalance, 0, 'a balance must never go negative');
  assert.strictEqual(s.wallets.get('Lead').tokenBalance, s.plugin.options.maxSwitchTokens - 1);
});

await runTest('the same empty wallet does refuse a player who is not in a party', async () => {
  // The control for the test above: without it, "still moves" could mean the
  // token check was never reached at all.
  const s = buildScene([P('Solo', 1), ...fillers(1, 5), ...fillers(2, 4)]);
  s.wallets.set('Solo', { eosID: 'Solo', tokenBalance: 0, tokenRegenAnchor: new Date() });
  await s.chat('Solo', '!switch');
  assert.deepStrictEqual(s.world.commands, []);
  assert.ok(['switch.warn.switchOutSwitchTokens', 'switch.warn.switchCooldownAvailableM'].includes(s.warnsTo('Solo')[0]));
});

// ── 4. A split party ──────────────────────────────────────────────
await runTest('a split party reunites: only the members on the requester team move', async () => {
  const s = buildScene([
    P('Lead', 2, { party: 'A', leader: true }), P('Stray', 1, { party: 'A' }),
    ...fillers(1, 5), ...fillers(2, 4)
  ]);
  await s.chat('Stray', '!switch');
  assert.deepStrictEqual(s.world.commands, ['Stray']);
  assert.strictEqual(s.world.teamOf('Stray'), 2);
  assert.strictEqual(s.world.teamOf('Lead'), 2);
  assert.strictEqual(s.wallets.has('Lead'), false, 'a member who did not move pays nothing');
  assert.strictEqual(s.plugin._roundStats.instantSwitches[0].partySize, 1);
});

// ── 5. The group gate ─────────────────────────────────────────────
await runTest('getSwitchGroupSlots agrees with the solo gate for one player', async () => {
  for (const [t1, t2] of [[5, 5], [6, 4], [4, 6], [7, 3], [49, 49]]) {
    const s = buildScene([...fillers(1, t1), ...fillers(2, t2)]);
    for (const teamID of [1, 2]) {
      assert.strictEqual(
        s.plugin.getSwitchGroupSlots(teamID, 1), s.plugin.getSwitchSlotsPerTeam(teamID),
        `${t1}v${t2}, leaving T${teamID}`
      );
    }
  }
});

await runTest('getSwitchGroupSlots asks about all n at once', async () => {
  const s = buildScene([...fillers(1, 7), ...fillers(2, 3)]);
  assert.strictEqual(s.plugin.getSwitchGroupSlots(1, 2), 2, '7v3: two leaving T1 makes 5v5');
  assert.strictEqual(s.plugin.getSwitchGroupSlots(1, 3), 0, '7v3: three leaving T1 makes 4v6, past the cap of 1');
  assert.strictEqual(s.plugin.getSwitchGroupSlots(2, 2), 0, '7v3: two leaving T2 makes 9v1');

  const full = buildScene([...fillers(1, 49), ...fillers(2, 48)]);
  assert.strictEqual(full.plugin.getSwitchGroupSlots(1, 1), 1, '49v48: one more fits on T2');
  assert.strictEqual(full.plugin.getSwitchGroupSlots(1, 2, 10), 0, 'T2 has one free place, not two, whatever the cap');
  assert.strictEqual(full.plugin.getSwitchGroupSlots(1, 2, 10, true), 2, 'skipHardCap lifts only the team-size limit');
});

// ── 6. The queue ──────────────────────────────────────────────────
await runTest('a party that does not fit queues as one entry, and every member is told', async () => {
  const s = pairWithoutRoom();
  await s.chat('Lead', '!switch');
  assert.deepStrictEqual(s.world.commands, []);
  assert.strictEqual(s.plugin._getQueueSize(), 1);
  const entry = s.plugin._switchQueue.t1[0];
  assert.strictEqual(entry.kind, 'party');
  assert.deepStrictEqual([...entry.memberEosIDs].sort(), ['Lead', 'Mate']);
  for (const id of ['Lead', 'Mate']) assert.deepStrictEqual(s.warnsTo(id), ['switch.warn.partyQueueAdded']);
});

await runTest("a second member's !switch finds the entry instead of adding another", async () => {
  const s = pairWithoutRoom();
  await s.chat('Lead', '!switch');
  await s.chat('Mate', '!switch');
  assert.strictEqual(s.plugin._getQueueSize(), 1);
  assert.strictEqual(s.plugin._findQueueEntry('Mate').entry, s.plugin._switchQueue.t1[0]);
  assert.strictEqual(s.warnsTo('Mate').at(-1), 'switch.warn.partyAlreadyQueued');
});

await runTest('the queue serves a party only once all of it fits', async () => {
  const s = pairWithoutRoom();
  await s.chat('Lead', '!switch');

  // One place opens (6v4 → 5v5 for one mover): not enough for two.
  s.setTeam(['f2-0'], 1);
  await s.plugin._processQueue();
  assert.deepStrictEqual(s.world.commands, [], 'a party must not be served one member at a time');
  assert.strictEqual(s.plugin._getQueueSize(), 1);

  // Two places (7v3): now it goes.
  s.setTeam(['f2-1'], 1);
  await s.plugin._processQueue();
  assert.strictEqual(s.world.teamOf('Lead'), 2);
  assert.strictEqual(s.world.teamOf('Mate'), 2);
  assert.strictEqual(s.plugin._getQueueSize(), 0);
  const stat = s.plugin._roundStats.queueNormal;
  assert.strictEqual(stat.length, 1);
  assert.strictEqual(stat[0].partySize, 2);
});

await runTest('a solo entry behind a waiting party is served, and the party keeps its place', async () => {
  const s = buildScene([
    P('Lead', 1, { party: 'A', leader: true }), P('Mate', 1, { party: 'A' }), P('Solo', 1),
    ...fillers(1, 2), ...fillers(2, 5)
  ]);
  await s.chat('Lead', '!switch');
  await s.plugin._enqueuePlayer({ ...s.row('Solo') }, 'test');
  assert.deepStrictEqual(s.plugin._switchQueue.t1.map((e) => e.eosID), ['Lead', 'Solo']);

  // 6v4: room for one mover, not for two.
  s.setTeam(['f2-0'], 1);
  await s.plugin._processQueue();
  assert.deepStrictEqual(s.world.commands, ['Solo']);
  assert.deepStrictEqual(s.plugin._switchQueue.t1.map((e) => e.eosID), ['Lead'], 'the party should still be queued, at the head');
});

await runTest('a party entry is never one side of a pair trade', async () => {
  const s = buildScene([
    P('Lead', 1, { party: 'A', leader: true }), P('Mate', 1, { party: 'A' }), P('Other', 2),
    ...fillers(1, 3), ...fillers(2, 4)
  ]);
  await s.chat('Lead', '!switch');
  await s.plugin._enqueuePlayer({ ...s.row('Other') }, 'test');
  // 5v5 with a party waiting on T1 and a solo on T2. Trading the solo for one
  // party member would split the party.
  await s.plugin._processQueue();
  assert.ok(!s.world.commands.includes('Lead') && !s.world.commands.includes('Mate'), 'a party member was traded alone');
  assert.strictEqual(s.plugin._roundStats.queueTeamTrades.length, 0);
});

await runTest('any member can cancel the party entry, and the others are told who did', async () => {
  const s = pairWithoutRoom();
  await s.chat('Lead', '!switch');
  await s.chat('Mate', '!switch cancel');
  assert.strictEqual(s.plugin._getQueueSize(), 0);
  assert.strictEqual(s.warnsTo('Lead').at(-1), 'switch.warn.partyQueueCancelledByMember');
});

// ── 7. Party changes while queued ─────────────────────────────────
await runTest('a queued solo who joins a party is cancelled on the parties-changed notice', async () => {
  const s = buildScene([P('Solo', 1), P('Friend', 1), ...fillers(1, 3), ...fillers(2, 5)]);
  s.plugin._startPartyWatch();
  await s.plugin._enqueuePlayer({ ...s.row('Solo') }, 'test');
  s.warns.length = 0;

  s.row('Solo').party = 'B';
  s.row('Friend').party = 'B';
  s.partiesChanged();

  assert.strictEqual(s.plugin._getQueueSize(), 0);
  assert.deepStrictEqual(s.warnsTo('Solo'), ['switch.warn.partyQueueCancelledJoined']);
  assert.strictEqual(s.plugin._roundStats.queueRemovals.at(-1).reason, 'joined_party');
});

await runTest('with no notice at all, the same solo is still caught just before the move', async () => {
  const s = buildScene([P('Solo', 1), P('Friend', 1), ...fillers(1, 4), ...fillers(2, 4)]);
  await s.plugin._enqueuePlayer({ ...s.row('Solo') }, 'test');
  s.row('Solo').party = 'B';
  s.row('Friend').party = 'B';

  // 6v4: a solo mover fits, so only the party check stands between this
  // entry and a move that would split the new party.
  await s.plugin._processQueue();
  assert.deepStrictEqual(s.world.commands, []);
  assert.strictEqual(s.plugin._getQueueSize(), 0);
  assert.deepStrictEqual(s.warnsTo('Solo').slice(-1), ['switch.warn.partyQueueCancelledJoined']);
});

for (const [label, change] of [
  ['gains a member', (s) => { s.row('Newcomer').party = 'A'; }],
  ['loses a member', (s) => { s.row('Mate').party = null; s.row('Third').party = null; }],
  ['has a member moved off the team', (s) => { s.row('Mate').teamID = 2; }]
]) {
  await runTest(`a queued party that ${label} is cancelled, and its members are told`, async () => {
    const s = buildScene([
      P('Lead', 1, { party: 'A', leader: true }), P('Mate', 1, { party: 'A' }), P('Third', 1, { party: 'A' }), P('Newcomer', 1),
      ...fillers(1, 1), ...fillers(2, 5)
    ]);
    s.plugin._startPartyWatch();
    await s.chat('Lead', '!switch');
    assert.strictEqual(s.plugin._getQueueSize(), 1, 'precondition: the party is queued');
    s.warns.length = 0;

    change(s);
    s.partiesChanged();

    assert.strictEqual(s.plugin._getQueueSize(), 0);
    assert.deepStrictEqual(s.warnsTo('Lead'), ['switch.warn.partyQueueCancelledChanged']);
    assert.strictEqual(s.plugin._roundStats.queueRemovals.at(-1).reason, 'party_changed');
  });
}

await runTest('a change on the other half of a split party cancels the entry too', async () => {
  // Stray1 and Stray2 are queued to rejoin Lead. The members who would move
  // are the same afterwards, but it is no longer the party that was checked.
  const s = buildScene([
    P('Lead', 2, { party: 'A', leader: true }), P('Stray1', 1, { party: 'A' }), P('Stray2', 1, { party: 'A' }), P('Newcomer', 2),
    ...fillers(1, 3), ...fillers(2, 3)
  ]);
  s.plugin._startPartyWatch();
  await s.chat('Stray1', '!switch');
  assert.strictEqual(s.plugin._getQueueSize(), 1, 'precondition: the two strays are queued');

  s.row('Newcomer').party = 'A';
  s.partiesChanged();
  assert.strictEqual(s.plugin._getQueueSize(), 0);
  assert.strictEqual(s.plugin._roundStats.queueRemovals.at(-1).reason, 'party_changed');
});

/** Run `hook` once, in the middle of the first RCON command the scene sends. */
function duringFirstMove(s, hook) {
  const execute = s.world.rcon.execute;
  let fired = false;
  s.world.rcon.execute = async (cmd) => {
    if (!fired) { fired = true; hook(); }
    return execute(cmd);
  };
}

await runTest('a player who joins a party while an earlier pair is being traded is not traded', async () => {
  const s = buildScene([
    P('A1', 1), P('A2', 1), P('Friend', 1), P('B1', 2), P('B2', 2),
    ...fillers(1, 2), ...fillers(2, 3)
  ]);
  for (const id of ['A1', 'A2', 'B1', 'B2']) await s.plugin._enqueuePlayer({ ...s.row(id) }, 'test');
  duringFirstMove(s, () => { s.row('A2').party = 'Z'; s.row('Friend').party = 'Z'; });

  await s.plugin._processQueue();
  assert.strictEqual(s.world.teamOf('A1'), 2, 'the first pair should trade');
  assert.strictEqual(s.world.teamOf('B1'), 1, 'the first pair should trade');
  assert.ok(!s.world.commands.includes('A2'), 'A2 joined a party mid-trade and was still moved alone');
  assert.strictEqual(s.plugin._findQueueEntry('A2'), null);
  assert.strictEqual(s.warnsTo('A2').at(-1), 'switch.warn.partyQueueCancelledJoined');
});

await runTest('an entry removed while an earlier pair is being traded is not traded from a stale copy', async () => {
  // The pair loop works from a copy of the queue. A2 leaves the queue (a
  // cancel, here) while A1 and B1 are mid-move, and must not be moved anyway.
  const s = buildScene([
    P('A1', 1), P('A2', 1), P('B1', 2), P('B2', 2),
    ...fillers(1, 3), ...fillers(2, 3)
  ]);
  for (const id of ['A1', 'A2', 'B1', 'B2']) await s.plugin._enqueuePlayer({ ...s.row(id) }, 'test');
  duringFirstMove(s, () => { s.plugin._removePlayerFromQueue('A2'); });

  await s.plugin._processQueue();
  assert.strictEqual(s.world.teamOf('A1'), 2, 'the first pair should trade');
  assert.ok(!s.world.commands.includes('A2'), 'A2 had left the queue and was still moved');
  assert.ok(!s.world.commands.includes('B2'), 'B2 lost its partner and should wait, not move');
});

await runTest('a player who joins a party during a pair trade is not given the slot that follows', async () => {
  // After A1 and B1 trade it is 6v4 with Solo at the head of the T1 queue:
  // a solo mover fits, so only the party check stops the move.
  const s = buildScene([
    P('A1', 1), P('Solo', 1), P('Friend', 1), P('B1', 2),
    ...fillers(1, 3), ...fillers(2, 3)
  ]);
  for (const id of ['A1', 'Solo', 'B1']) await s.plugin._enqueuePlayer({ ...s.row(id) }, 'test');
  duringFirstMove(s, () => { s.row('Solo').party = 'Z'; s.row('Friend').party = 'Z'; });

  await s.plugin._processQueue();
  assert.strictEqual(s.world.teamOf('A1'), 2);
  assert.ok(!s.world.commands.includes('Solo'), 'Solo joined a party mid-trade and was still moved alone');
  assert.strictEqual(s.plugin._getQueueSize(), 0);
});

await runTest('a queued party is cancelled at processing time when no notice arrived', async () => {
  const s = pairWithoutRoom();
  await s.chat('Lead', '!switch');
  s.row('Mate').party = null;
  s.row('Lead').party = null;

  // 7v3: both would fit, so only the party check stops a move of two
  // players who are no longer a party.
  s.setTeam(['f2-0', 'f2-1'], 1);
  await s.plugin._processQueue();
  assert.deepStrictEqual(s.world.commands, []);
  assert.strictEqual(s.plugin._getQueueSize(), 0);
});

await runTest('a member disconnecting cancels the party entry for those still here', async () => {
  const s = pairWithoutRoom();
  await s.chat('Lead', '!switch');
  s.warns.length = 0;

  // S³ drops a leaver from the roster before it announces the leave.
  s.world.roster.splice(s.world.roster.findIndex((p) => p.eosID === 'Mate'), 1);
  s.plugin.handlePlayerLeave('Mate', 1, 'Mate');

  assert.strictEqual(s.plugin._getQueueSize(), 0);
  assert.deepStrictEqual(s.warnsTo('Lead'), ['switch.warn.partyQueueCancelledChanged']);
  assert.deepStrictEqual(s.warnsTo('Mate'), [], 'the leaver is gone and is not messaged');
  assert.strictEqual(s.plugin._roundStats.queueDisconnects.length, 0, 'this is a party change, not a queued disconnect');
});

await runTest('the party watch subscribes once and lets go at unmount', async () => {
  const s = pairWithRoom();
  s.plugin._startPartyWatch();
  s.plugin._startPartyWatch();
  assert.strictEqual(s.partyListeners.size, 1);
  s.plugin._stopPartyWatch();
  assert.strictEqual(s.partyListeners.size, 0);
});

// ── 8. The SmartAssign handshake ──────────────────────────────────
await runTest('the queue snapshot leaves party entries out', async () => {
  const s = buildScene([
    P('Lead', 1, { party: 'A', leader: true }), P('Mate', 1, { party: 'A' }), P('Solo', 1),
    ...fillers(1, 2), ...fillers(2, 5)
  ]);
  await s.chat('Lead', '!switch');
  await s.plugin._enqueuePlayer({ ...s.row('Solo') }, 'test');
  assert.deepStrictEqual(s.plugin.getQueueSnapshot().t1ToT2.map((e) => e.eosID), ['Solo']);
});

await runTest("forceQueueSwap refuses a party's entry and leaves it queued", async () => {
  const s = pairWithoutRoom();
  await s.chat('Lead', '!switch');
  for (const id of ['Lead', 'Mate']) {
    assert.strictEqual(await s.plugin.forceQueueSwap(id), false);
    assert.strictEqual(s.plugin.consumeQueueEntry(id), null);
  }
  assert.deepStrictEqual(s.world.commands, []);
  assert.strictEqual(s.plugin._getQueueSize(), 1);
});

await runTest('forceQueueSwap refuses a queued solo who has joined a party since', async () => {
  const s = buildScene([P('Solo', 1), P('Friend', 1), ...fillers(1, 3), ...fillers(2, 5)]);
  await s.plugin._enqueuePlayer({ ...s.row('Solo') }, 'test');
  s.row('Solo').party = 'B';
  s.row('Friend').party = 'B';
  assert.strictEqual(await s.plugin.forceQueueSwap('Solo'), false);
  assert.deepStrictEqual(s.world.commands, []);
  assert.strictEqual(s.plugin._getQueueSize(), 0, 'the stale entry should be cancelled, not left behind');
});

// ── 9. Admin moves and double switch ──────────────────────────────
await runTest('!switch now on a party member tells the admin who they are tied to', async () => {
  const s = buildScene([
    P('Lead', 1, { party: 'A', leader: true }), P('Mate', 1, { party: 'A' }), P('Admin', 2),
    ...fillers(1, 3), ...fillers(2, 4)
  ]);
  await s.chat('Admin', '!switch now mate', 'ChatAdmin');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.strictEqual(s.world.teamOf('Mate'), 2, 'the admin move itself still runs, on the named player');
  assert.strictEqual(s.world.teamOf('Lead'), 1, 'and only on the named player');
  const notice = s.warns.find(([to, message]) => to === 'Admin' && message.startsWith('switch.warn.adminPartyNotice'));
  assert.ok(notice, 'the admin was not told about the party');
  assert.ok(notice[1].includes('"name":"Mate"') && notice[1].includes('Lead'));
});

await runTest('the notice leaves out mates who are being moved as well', async () => {
  const s = pairWithRoom();
  assert.strictEqual(s.plugin._partyNotice(['Lead', 'Mate']), null);
  assert.strictEqual(s.plugin._partyNotice(['f1-0']), null);
  assert.ok(s.plugin._partyNotice(['Lead']).includes('Mate'));
});

await runTest("a party member's own double switch is refused; an admin's forced one runs", async () => {
  const s = pairWithRoom();
  await s.plugin.doubleSwitchPlayer('Mate');
  assert.deepStrictEqual(s.world.commands, []);
  assert.deepStrictEqual(s.warnsTo('Mate'), ['switch.warn.doubleSwitchParty']);

  await s.plugin.doubleSwitchPlayer('Mate', true);
  assert.deepStrictEqual(s.world.commands, ['Mate', 'Mate']);
  assert.strictEqual(s.world.teamOf('Mate'), 1, 'a double switch ends where it began');
});

await runTest('a solo player can still double switch', async () => {
  const s = buildScene([P('Solo', 1), ...fillers(1, 4), ...fillers(2, 5)]);
  await s.plugin.doubleSwitchPlayer('Solo');
  assert.deepStrictEqual(s.world.commands, ['Solo', 'Solo']);
});

console.log('');
console.log(`📊 Results: ${passed}/${passed + failed} passed, ${failed} failed`);
console.log('');

cleanAssembly(ASSEMBLY);
if (failed > 0) process.exitCode = 1;
