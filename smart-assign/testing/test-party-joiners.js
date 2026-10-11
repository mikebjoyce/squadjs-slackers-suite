/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      SMART ASSIGN — SQUAD PARTY JOINERS                       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Squad seats a joining party member on their party's team, and a forced
 * move splits the party. The party ID is no use as the signal: it shows on
 * the player row seconds after the join, later than a join move can wait.
 * S³ predicts it at the join instead ('party', 'likely-party' or 'solo'),
 * and smart-assign must act on that prediction with no added delay.
 *
 * What is pinned here, against the real plugin and a fake RCON:
 *
 *   - a predicted party joiner is never moved, a solo joiner still is;
 *   - the prediction is read from the join payload, from S³ when the payload
 *     has none, and a party ID already on the live row counts too;
 *   - a reconnecting party member is not sent back to their old team, and is
 *     not handed the blocked-reconnect remediation; a reconnecting solo is;
 *   - a party ID that shows up between the decision and the RCON send drops
 *     the move and unwinds the pending counters and the player lock;
 *   - the Switch handshake does not pick a queued player who is in a party;
 *   - a later team change by S³'s party reunite does not make smart-assign
 *     move the player again.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node smart-assign/testing/test-party-joiners.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - The plugin is loaded out of a throwaway install.cjs assembly, for the
 *   reason given in test-smart-assign-plugin.js. Monorepo-only.
 * - No EloTracker and no DB: with neither, the evaluator decides on team
 *   population alone, which makes "where would a solo joiner go" predictable.
 *
 */

import assert from 'node:assert/strict';

import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';
import { makeMockServer } from '../../s3/testing/mock-s3.js';
import { createPartyWorld } from '../../s3/testing/fake-party-rcon.js';

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

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

/** `count` squadless solo players on one team. */
function fillers(teamID, count) {
  return Array.from({ length: count }, (_, i) => ({
    eosID: `t${teamID}-${i}`, steamID: `steam-t${teamID}-${i}`, name: `T${teamID} Filler ${i}`, teamID, squadID: null, partyID: null
  }));
}

// Every player here carries a steamID. The evaluator leaves the joiner out of
// its team counts by comparing steamIDs, so a roster with none reads as two
// empty teams and nobody is ever moved, which would make every "not moved"
// assertion below pass for the wrong reason.

const assembly = buildAssembly('.tmp-smart-assign-party');
try {
  const SmartAssign = await importFromAssembly(assembly, 'smart-assign.js');

  /**
   * A mounted smart-assign over a fake party world.
   *
   * Team 1 is far over the population cap, so a solo joiner landing on Team 1
   * is always sent to Team 2. Every test's joiner starts on Team 1 for that
   * reason: a joiner who is still there afterwards was left alone on purpose.
   */
  async function scene({ joiner, extra = [], options = {}, t1 = 9, t2 = 2 } = {}) {
    const world = createPartyWorld([...fillers(1, t1), ...fillers(2, t2), ...extra, joiner]);
    const predictions = new Map();
    const locks = new Map();
    // Every lock ever taken. The plugin only locks a player once it has
    // decided to move them, so an empty list means the join stopped at the
    // party gate and not at the executor's later check.
    const lockCalls = [];
    const hooks = { beforeLock: null };
    const recordedMoves = [];

    const server = makeMockServer({
      players: world.roster,
      s3: {
        gameState: { isEndgameFactionVote: () => false },
        players: {
          getAllPlayers: world.players.getAllPlayers,
          getPlayer: world.players.getPlayer,
          refreshNow: world.players.refreshNow,
          canAct: () => true,
          recordMove: (...args) => { recordedMoves.push(args); return true; },
          getJoinPrediction: (eosID) => predictions.get(eosID) ?? null,
          lock: (eosID, owner) => {
            hooks.beforeLock?.(eosID);
            locks.set(eosID, owner);
            lockCalls.push(eosID);
            return true;
          },
          unlock: (eosID) => locks.delete(eosID),
          isLockedBy: (eosID) => locks.get(eosID) ?? null
        }
      }
    });
    server.rcon = world.rcon;

    const plugin = new SmartAssign(server, { discordClient: null, enableDatabaseLogging: false, ...options }, {});
    await plugin.prepareToMount();
    await plugin.mount();

    const live = (eosID) => world.roster.find((p) => p.eosID === eosID);
    return {
      world, server, plugin, predictions, locks, lockCalls, hooks, recordedMoves,
      /** Announce the joiner the way S³ does, then let the executor finish. */
      async join({ joinPrediction, previousTeamID = null } = {}) {
        const payload = { ...live(joiner.eosID) };
        if (joinPrediction !== undefined) payload.joinPrediction = joinPrediction;
        await plugin.onS3PlayerJoined({ player: payload, previousTeamID, source: 'test' });
        await settle();
      },
      async close() { await plugin.unmount(); }
    };
  }

  const soloJoiner = () => ({ eosID: 'J', steamID: 'steam-J', name: 'Joiner', teamID: 1, squadID: null, partyID: null });

  // ── 1. the gate ────────────────────────────────────────────────────────────
  await test('a solo joiner on the crowded team is still moved, with no added delay', async () => {
    const s = await scene({ joiner: soloJoiner() });
    const started = Date.now();
    await s.plugin.onS3PlayerJoined({ player: { ...soloJoiner(), joinPrediction: 'solo' }, previousTeamID: null });
    // The first RCON command goes out inside the join handler, not on a timer.
    assert.deepEqual(s.world.commands, ['J']);
    assert.ok(Date.now() - started < 1000, 'the join handler waited before sending');
    await settle();
    assert.equal(s.world.teamOf('J'), 2);
    await s.close();
  });

  await test('a joiner who already carries a party ID is not moved', async () => {
    const s = await scene({ joiner: { ...soloJoiner(), squadID: 4, partyID: 0 } });
    await s.join({ joinPrediction: 'party' });
    assert.deepEqual(s.world.commands, []);
    assert.equal(s.world.teamOf('J'), 1);
    assert.deepEqual(s.recordedMoves, [], 'no move may be attributed to SmartAssign');
    await s.close();
  });

  await test('the "party" prediction is enough on its own', async () => {
    // The ID was on the row when S³ announced the join and is off it now, which
    // happens when a party renumbers or a mate drops. The prediction still holds.
    const s = await scene({ joiner: { ...soloJoiner(), squadID: 4, partyID: null } });
    await s.join({ joinPrediction: 'party' });
    assert.deepEqual(s.world.commands, []);
    assert.deepEqual(s.lockCalls, []);
    await s.close();
  });

  await test('a joiner in a squad at first sighting, with no party ID yet, is not moved', async () => {
    const s = await scene({ joiner: { ...soloJoiner(), squadID: 4 } });
    await s.join({ joinPrediction: 'likely-party' });
    assert.deepEqual(s.world.commands, []);
    assert.equal(s.world.teamOf('J'), 1);
    await s.close();
  });

  await test('with no prediction on the payload, S³ is asked for it', async () => {
    const s = await scene({ joiner: { ...soloJoiner(), squadID: 4 } });
    s.predictions.set('J', 'likely-party');
    await s.join();
    assert.deepEqual(s.world.commands, []);
    await s.close();
  });

  await test('a party ID already on the live row counts, whatever the prediction said', async () => {
    const s = await scene({ joiner: soloJoiner() });
    // Predicted solo at the join, but the ID has landed on the row since.
    s.world.roster.find((p) => p.eosID === 'J').partyID = 3;
    await s.join({ joinPrediction: 'solo' });
    assert.deepEqual(s.world.commands, []);
    assert.deepEqual(s.lockCalls, [], 'the join got past the gate and was only stopped at the send');
    await s.close();
  });

  await test('a left-alone party joiner holds no lock and no pending assignment', async () => {
    const s = await scene({ joiner: { ...soloJoiner(), squadID: 4 } });
    await s.join({ joinPrediction: 'likely-party' });
    assert.equal(s.locks.size, 0);
    assert.deepEqual(s.plugin._pendingAssignments, { 1: 0, 2: 0 });
    assert.equal(s.plugin._joiningPlayers.size, 0, 'the double-join guard was not released');
    await s.close();
  });

  // ── 2. reconnects ──────────────────────────────────────────────────────────
  await test('a reconnecting solo player is sent back to their old team', async () => {
    // Even teams, so only reconnect memory can be the reason for a move.
    const s = await scene({ joiner: soloJoiner(), t1: 4, t2: 5 });
    await s.join({ joinPrediction: 'solo', previousTeamID: 2 });
    assert.deepEqual(s.world.commands, ['J']);
    assert.equal(s.world.teamOf('J'), 2);
    await s.close();
  });

  await test('a reconnecting party member stays with their party', async () => {
    const s = await scene({ joiner: { ...soloJoiner(), squadID: 4 }, t1: 4, t2: 5 });
    await s.join({ joinPrediction: 'likely-party', previousTeamID: 2 });
    assert.deepEqual(s.world.commands, []);
    assert.equal(s.world.teamOf('J'), 1);
    await s.close();
  });

  await test('a reconnecting party member gets no blocked-reconnect remediation; a solo does', async () => {
    // Passive mode is one of the paths that remediates: the plugin cannot put a
    // reconnecting player back, so it clears their Switch lockouts instead. A
    // party member on a new team is there with their party, not stuck there.
    for (const [joinPrediction, expected] of [['solo', ['J']], ['likely-party', []]]) {
      const s = await scene({ joiner: soloJoiner(), options: { enableSmartAssign: false } });
      const resets = [];
      s.plugin._switchPlugin = { _resetPlayerLockouts: async (eosID) => { resets.push(eosID); } };
      await s.join({ joinPrediction, previousTeamID: 2 });
      assert.deepEqual(resets, expected, `prediction ${joinPrediction}`);
      assert.deepEqual(s.world.commands, []);
      await s.close();
    }
  });

  // ── 3. the last-moment check ───────────────────────────────────────────────
  await test('a party ID that shows up between the decision and the send drops the move', async () => {
    const s = await scene({ joiner: soloJoiner() });
    // The player lock is taken after the decision and just before the move is
    // queued, so it marks the gap the ID can land in.
    s.hooks.beforeLock = (eosID) => { s.world.roster.find((p) => p.eosID === eosID).partyID = 2; };
    await s.join({ joinPrediction: 'solo' });

    assert.deepEqual(s.world.commands, [], 'the move was sent anyway');
    assert.equal(s.world.teamOf('J'), 1);
    assert.equal(s.plugin.executor.pendingPlayerMoves.size, 0);
    assert.deepEqual(s.plugin._pendingAssignments, { 1: 0, 2: 0 }, 'the pending count was not unwound');
    assert.equal(s.plugin._pendingPlayerMoves.size, 0);
    assert.equal(s.locks.size, 0, 'the player lock was not released');
    await s.close();
  });

  await test('the executor reports the dropped move as JoinedParty, and still moves a solo', async () => {
    const s = await scene({ joiner: soloJoiner() });
    const Executor = s.plugin.executor.constructor;

    for (const [partyID, expectSent] of [[5, false], [null, true]]) {
      const sent = [];
      const failures = [];
      const executor = new Executor({ players: [] }, {
        s3: { players: { getPlayer: () => ({ eosID: 'X', teamID: 1, partyID }), canAct: () => true } },
        requestTeamChange: async (eosID, opts) => { sent.push([eosID, opts.targetTeamID]); return { success: true, eosID, teamID: 2, name: 'X' }; },
        callbacks: { onFailed: (data) => failures.push(data.reason) }
      });
      executor.queueMove('X', 'Player X', 'X', 2);
      await settle(20);
      executor.cleanup();

      assert.deepEqual(sent, expectSent ? [['X', 2]] : [], `partyID ${partyID}`);
      assert.deepEqual(failures, expectSent ? [] : ['JoinedParty'], `partyID ${partyID}`);
    }
    await s.close();
  });

  // ── 4. the Switch handshake ────────────────────────────────────────────────
  await test('the handshake does not pick a queued player who is in a party', async () => {
    const queued = { eosID: 'Q', steamID: 'steam-Q', name: 'Queued', teamID: 2, squadID: 1, partyID: null };
    const s = await scene({ joiner: soloJoiner(), extra: [queued], t1: 5, t2: 5 });
    const snapshot = () => Promise.resolve({
      t2ToT1: [{ eosID: 'Q', steamID: null, playerName: 'Queued', currentTeamID: 2, targetTeamID: 1, queuedAt: Date.now() }],
      t1ToT2: []
    });
    const baseline = { targetTeam: 1, reason: 'Elo Balance' };

    const solo = await s.plugin._evaluateHandshakeSwap(soloJoiner(), baseline, snapshot());
    assert.equal(solo.shouldOverride, true, `a solo candidate should be swapped: ${solo.reason}`);

    s.world.roster.find((p) => p.eosID === 'Q').partyID = 1;
    const partied = await s.plugin._evaluateHandshakeSwap(soloJoiner(), baseline, snapshot());
    assert.equal(partied.shouldOverride, false);
    assert.match(partied.reason, /^F4b:/);
    await s.close();
  });

  // ── 5. after S³ reunites a party ───────────────────────────────────────────
  await test('a team change made by the party reunite does not trigger another move', async () => {
    // The squadless party joiner who looked solo: smart-assign moves them, the
    // ID shows, and S³ moves them back to their party. That must be the end of
    // it, or the two would trade the player back and forth.
    const s = await scene({ joiner: soloJoiner() });
    await s.join({ joinPrediction: 'solo' });
    assert.deepEqual(s.world.commands, ['J']);
    assert.equal(s.world.teamOf('J'), 2);

    const row = s.world.roster.find((p) => p.eosID === 'J');
    row.teamID = 1;
    row.partyID = 0;
    s.server.emit('S3_PLAYER_TEAM_CHANGED', { player: { ...row }, oldTeamID: 2, newTeamID: 1, source: 'S3:PartyReunite' });
    s.server.emit('S3_PLAYERS_UPDATED', { players: s.world.players.getAllPlayers() });
    await settle(700);

    assert.deepEqual(s.world.commands, ['J'], 'smart-assign moved the player again');
    assert.equal(s.world.teamOf('J'), 1);
    await s.close();
  });
} finally {
  cleanAssembly(assembly);
}

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed.`);
if (!process.exitCode) console.log('\nAll smart-assign party joiner tests passed.');
