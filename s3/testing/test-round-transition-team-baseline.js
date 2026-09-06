/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║        ROUND-TRANSITION TEAM BASELINE TEST                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Regression cover for the 2026-09-05 defect where a round transition was
 * reported as a roster-wide team change.
 *
 * From `docs/squadjs-log (48).log`, the JensensRange → Sumari_Seed_v1
 * transition (log lines 26229-26254), verbatim:
 *
 *   [GameState] STAGING timer elapsed -> LIVE (teams still resolving).
 *   [S3] UPDATED_PLAYER_INFORMATION tick: 15 players
 *   [GameState] All tracked players resolved -> resolving=false (phase LIVE).
 *   [Players] UPDATED_PLAYER_INFORMATION: ... hasNullTeams=false
 *   [Players] TEAM_CHANGE: [DRoG] Ax (...) 2→1, source=Admin     ← ×15
 *
 * Two faults produced that, and this suite pins both:
 *
 *   1. `resolving` cleared against a STALE registry. The S³ plugin delegates
 *      each tick gameState → factions → players, so GameStateService asked
 *      `areTeamsResolved()` before PlayersService had ingested the tick. On the
 *      first tick after NEW_GAME the registry still held the PREVIOUS round's
 *      teams — all real — so the answer was "yes" and the resolving window
 *      collapsed to nothing on every round transition.
 *
 *   2. The tick diff then compared those previous-round teams against the new
 *      round's assignment and emitted one S3_PLAYER_TEAM_CHANGED per player.
 *      The null-teamID projection exists to absorb exactly this, but it only
 *      arms when RCON happens to serve a null mid-transition — and that round
 *      it never did (`hasNullTeams=true` appears nowhere in the log).
 *
 * The fix is PlayersService._teamConfirmedKeys: a player's first sighting on a
 * real team in a round is a BASELINE, not a change. These cases assert that
 * property directly, and assert it holds on the no-null-tick path that defeated
 * the projection.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-round-transition-team-baseline.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Category 1: no database, no RCON, no running SquadJS. Mock server only.
 * - GameStateService is driven through a stub parent exposing the same flat
 *   `parent.players` accessor the real S³ plugin provides, and the tick is
 *   delegated in the real plugin's order (gameState → players) so the stale-read
 *   ordering that caused fault 1 is reproduced rather than assumed away.
 *
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import PlayersService from '../utils/players-service.js';
import GameStateService from '../utils/game-state-service.js';

class MockServer extends EventEmitter {
  constructor() {
    super();
    this.players = [];
    this.squads = [];
    this.emitted = [];
  }

  emit(event, ...args) {
    this.emitted.push({ event, payload: args[0] });
    return super.emit(event, ...args);
  }

  take(eventName) {
    return this.emitted.filter((e) => e.event === eventName);
  }

  clearEmitted() {
    this.emitted = [];
  }
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// The 15 players still connected across the logged transition, with the teams
// they held in the JensensRange round that just ended.
function rosterBeforeTransition() {
  return [
    { eosID: '0002edebf46f442d8b776debbd557c95', steamID: 's01', name: '[DRoG] Ax', teamID: 2, squadID: 1 },
    { eosID: '0002550e490a44f989e945e3dd112a58', steamID: 's02', name: ' Crane', teamID: 2, squadID: 1 },
    { eosID: '000298c32feb4670ad1e86bb91a44331', steamID: 's03', name: ' Gary', teamID: 1, squadID: 1 },
    { eosID: '000246fc8d9d4544b288d83504834129', steamID: 's04', name: ' Rafi [BzH]', teamID: 1, squadID: 1 },
    { eosID: '0002876a5e0941cfa6f5a215efe0011c', steamID: 's05', name: '[DRoG] Schnugaf', teamID: 2, squadID: 2 },
    { eosID: '0002fc6f599e418ba9c56172698b0396', steamID: 's06', name: ' Slacker', teamID: 2, squadID: 2 },
    { eosID: '00024360f8a04ba7bf16045738658379', steamID: 's07', name: ' TalhaMDFK', teamID: 1, squadID: 2 },
    { eosID: '000212ae2f9c406cbd028ad8b231ba3c', steamID: 's08', name: ' TrashmAn', teamID: 1, squadID: 2 },
    { eosID: '0002918ab8cb42a484621e7ac36e7da6', steamID: 's09', name: ' [ToG] subtlerod', teamID: 2, squadID: 3 },
    { eosID: '0002792bb1474451b2bd89ded5b1e762', steamID: 's10', name: ' andrejarijcev', teamID: 2, squadID: 3 },
    { eosID: '00020bd2cbfe4e1d9a75934325de5516', steamID: 's11', name: ' andrewsutton367', teamID: 1, squadID: 3 },
    { eosID: '0002e23cc2814876bf8b48b3041c55ea', steamID: 's12', name: ' dawolf8989', teamID: 1, squadID: 3 },
    { eosID: '0002fcc307774b15969f2ccb36a75483', steamID: 's13', name: ' fransul16', teamID: 1, squadID: 4 },
    { eosID: '0002f680a67b4e64b9ab9d4bb07284e7', steamID: 's14', name: ' jan_/34_', teamID: 1, squadID: 4 },
    { eosID: '0002b441a61647f2b6787c85d35c96b8', steamID: 's15', name: ' sefa', teamID: 2, squadID: 4 }
  ];
}

// What RCON served on the first tick of the new round: every player already on
// a real team, and every one of them the OPPOSITE of what they had. No null tick
// preceded this — that is the whole point.
function rosterAfterTransition() {
  return rosterBeforeTransition().map((p) => ({ ...p, teamID: p.teamID === 1 ? 2 : 1 }));
}

function buildServices({ unresolvedGraceMs = 60000 } = {}) {
  const server = new MockServer();
  const parent = { services: {}, get players() { return this.services.players; } };

  const players = new PlayersService({ parent, server, unresolvedGraceMs });
  const gameState = new GameStateService({
    parent,
    server,
    // Keep the deadline far away: these cases are about the PLAYERS_RESOLVED
    // path, and a BUDGET_EXPIRED clear would mask what they are asserting.
    resolvingTimeoutMs: 600000
  });

  parent.services.players = players;
  parent.services.gameState = gameState;

  return { server, parent, players, gameState };
}

// Delegate a tick in the real S³ plugin's order — gameState first, players
// second. See slackers-squad-services.js handleUpdatedPlayerInfo().
async function deliverTick(gameState, players) {
  await gameState.handleUpdatedPlayerInfo();
  await players.handleUpdatedPlayerInfo();
}

await runTest('a round transition with no null tick emits zero team changes', async () => {
  const { server, players, gameState } = buildServices();
  await players.mount();

  // Previous round, settled.
  server.players = rosterBeforeTransition();
  await players.handleUpdatedPlayerInfo(); // initial sync
  await players.handleUpdatedPlayerInfo();
  assert.equal(players.areTeamsResolved(), true);

  await gameState.handleNewGame({ layer: { classname: 'Sumari_Seed_v1', gamemode: 'Seed' } });
  players.handleNewGame();

  server.clearEmitted();
  server.players = rosterAfterTransition();
  await deliverTick(gameState, players);

  // THE regression. Before the fix this was 15.
  const changes = server.take('S3_PLAYER_TEAM_CHANGED');
  assert.equal(
    changes.length,
    0,
    `expected no team changes across the transition, got ${changes.length}: ` +
      changes.map((e) => `${e.payload.player.name} ${e.payload.previousTeamID}→${e.payload.teamID}`).join(', ')
  );

  // And the registry did take the new teams — suppression must not mean stale data.
  for (const raw of rosterAfterTransition()) {
    assert.equal(players.getPlayer(raw.eosID).teamID, raw.teamID, `${raw.name} should be on team ${raw.teamID}`);
  }

  await players.unmount();
});

await runTest('resolving survives the first post-NEW_GAME tick and clears on the next', async () => {
  const { server, players, gameState } = buildServices();
  await players.mount();

  server.players = rosterBeforeTransition();
  await players.handleUpdatedPlayerInfo();
  await players.handleUpdatedPlayerInfo();

  await gameState.handleNewGame({ layer: { classname: 'Sumari_Seed_v1', gamemode: 'Seed' } });
  players.handleNewGame();
  assert.equal(gameState.isResolving(), true);

  // First tick: gameState asks BEFORE players ingest, so it sees a registry full
  // of last round's teams. It must not call that resolved — this is the exact
  // line that failed in the log.
  server.players = rosterAfterTransition();
  await deliverTick(gameState, players);
  assert.equal(gameState.isResolving(), true, 'resolving must not clear on stale pre-tick registry state');

  // Second tick: every player has now been observed on a real team this round.
  await deliverTick(gameState, players);
  assert.equal(gameState.isResolving(), false, 'resolving should clear once teams are confirmed for this round');

  await players.unmount();
});

await runTest('a genuine switch after the transition still emits', async () => {
  const { server, players, gameState } = buildServices();
  await players.mount();

  server.players = rosterBeforeTransition();
  await players.handleUpdatedPlayerInfo();
  await players.handleUpdatedPlayerInfo();

  await gameState.handleNewGame({ layer: { classname: 'Sumari_Seed_v1', gamemode: 'Seed' } });
  players.handleNewGame();

  server.players = rosterAfterTransition();
  await deliverTick(gameState, players);
  await deliverTick(gameState, players);

  // Now one player really does switch, mid-round, unattributed.
  server.clearEmitted();
  const moved = rosterAfterTransition();
  moved[0].teamID = moved[0].teamID === 1 ? 2 : 1;
  server.players = moved;
  await deliverTick(gameState, players);

  const changes = server.take('S3_PLAYER_TEAM_CHANGED');
  assert.equal(changes.length, 1, 'a real mid-round switch must still be reported');
  assert.equal(changes[0].payload.player.eosID, moved[0].eosID);
  assert.equal(changes[0].payload.teamID, moved[0].teamID);

  await players.unmount();
});

await runTest('an attributed move is reported even on a player\'s first sighting of the round', async () => {
  const { server, players, gameState } = buildServices();
  await players.mount();

  server.players = rosterBeforeTransition();
  await players.handleUpdatedPlayerInfo();
  await players.handleUpdatedPlayerInfo();

  await gameState.handleNewGame({ layer: { classname: 'Sumari_Seed_v1', gamemode: 'Seed' } });
  players.handleNewGame();

  // A plugin moved this player across the boundary and said so. That is
  // positive evidence of a real switch, unlike the roster-wide reassignment
  // around it, so it must survive the baseline suppression.
  const after = rosterAfterTransition();
  const attributed = after[0];
  players.recordMove(attributed.eosID, attributed.teamID, 'TeamBalancer');

  server.clearEmitted();
  server.players = after;
  await deliverTick(gameState, players);

  const changes = server.take('S3_PLAYER_TEAM_CHANGED');
  assert.equal(changes.length, 1, 'the attributed move should be the only reported change');
  assert.equal(changes[0].payload.player.eosID, attributed.eosID);
  assert.equal(changes[0].payload.source, 'TeamBalancer');

  await players.unmount();
});

await runTest('the transition is still absorbed when RCON does serve a null window', async () => {
  const { server, players, gameState } = buildServices();
  await players.mount();

  server.players = rosterBeforeTransition();
  await players.handleUpdatedPlayerInfo();
  await players.handleUpdatedPlayerInfo();

  await gameState.handleNewGame({ layer: { classname: 'Sumari_Seed_v1', gamemode: 'Seed' } });
  players.handleNewGame();

  server.clearEmitted();

  // The shape the projection was built for: whole roster null for a tick or two,
  // then the new teams. This path must stay quiet too — and, unlike before, it
  // must stay quiet whether or not the transition actually flipped 1↔2.
  server.players = rosterBeforeTransition().map((p) => ({ ...p, teamID: null }));
  await deliverTick(gameState, players);
  assert.equal(gameState.isResolving(), true);

  server.players = rosterAfterTransition();
  await deliverTick(gameState, players);
  await deliverTick(gameState, players);

  const changes = server.take('S3_PLAYER_TEAM_CHANGED');
  assert.equal(
    changes.length,
    0,
    `null-window transition should emit nothing, got: ` +
      changes.map((e) => `${e.payload.player.name} ${e.payload.previousTeamID}→${e.payload.teamID} (${e.payload.source})`).join(', ')
  );

  await players.unmount();
});

await runTest('a transition that does NOT flip teams is also silent', async () => {
  const { server, players, gameState } = buildServices();
  await players.mount();

  server.players = rosterBeforeTransition();
  await players.handleUpdatedPlayerInfo();
  await players.handleUpdatedPlayerInfo();

  await gameState.handleNewGame({ layer: { classname: 'Sumari_Seed_v1', gamemode: 'Seed' } });
  players.handleNewGame();

  server.clearEmitted();

  // Null window, then everyone comes back on the SAME team they had. The
  // projection's 1↔2 flip is a guess, and this is the shape where the guess is
  // wrong for every player — reconciling against it would invent 15 changes,
  // which is the original bug wearing the other code path's coat.
  server.players = rosterBeforeTransition().map((p) => ({ ...p, teamID: null }));
  await deliverTick(gameState, players);

  server.players = rosterBeforeTransition();
  await deliverTick(gameState, players);
  await deliverTick(gameState, players);

  const changes = server.take('S3_PLAYER_TEAM_CHANGED');
  assert.equal(
    changes.length,
    0,
    `a non-flipping transition should emit nothing, got ${changes.length}: ` +
      changes.map((e) => `${e.payload.player.name} ${e.payload.previousTeamID}→${e.payload.teamID} (${e.payload.source})`).join(', ')
  );

  await players.unmount();
});

await runTest('a mid-round mount confirms teams from initial sync', async () => {
  const { server, players, gameState } = buildServices();
  await players.mount();

  // No NEW_GAME will arrive until the next round. If initial sync did not
  // confirm, areTeamsResolved() would be false for the rest of the round and
  // resolving could only ever end on the deadline.
  server.players = rosterBeforeTransition();
  await players.handleUpdatedPlayerInfo();

  assert.equal(players.areTeamsResolved(), true);

  // And a real switch right after a mid-round mount is still reported.
  server.clearEmitted();
  const moved = rosterBeforeTransition();
  moved[3].teamID = moved[3].teamID === 1 ? 2 : 1;
  server.players = moved;
  await deliverTick(gameState, players);

  assert.equal(server.take('S3_PLAYER_TEAM_CHANGED').length, 1);

  await players.unmount();
});

await runTest('a reconnecting player is re-baselined, not diffed against their old team', async () => {
  const { server, players, gameState } = buildServices();
  await players.mount();

  server.players = rosterBeforeTransition();
  await players.handleUpdatedPlayerInfo();
  await players.handleUpdatedPlayerInfo();

  // Player leaves...
  const withoutOne = rosterBeforeTransition().slice(1);
  server.players = withoutOne;
  await deliverTick(gameState, players);

  // ...and comes back on the other team. That is a new registration, not a
  // change, and must not be reported as a switch.
  server.clearEmitted();
  const returning = rosterBeforeTransition();
  returning[0].teamID = returning[0].teamID === 1 ? 2 : 1;
  server.players = returning;
  await deliverTick(gameState, players);

  assert.equal(server.take('S3_PLAYER_TEAM_CHANGED').length, 0);

  await players.unmount();
});

await runTest('a confirmed player who swaps during a null window still emits Deferred/Projection', async () => {
  const { server, players, gameState } = buildServices();
  await players.mount();

  // Mid-round null window — no NEW_GAME — so every player is already confirmed
  // on a real team. That confirmation is what makes the projection's previous
  // team a fact to diff against rather than a guess, so deferred detection must
  // still work here. This is the capability the baseline suppression is not
  // allowed to cost us.
  server.players = rosterBeforeTransition();
  await players.handleUpdatedPlayerInfo();
  await players.handleUpdatedPlayerInfo();

  server.clearEmitted();

  server.players = rosterBeforeTransition().map((p) => ({ ...p, teamID: null }));
  await deliverTick(gameState, players);

  // Teams come back exactly as they were, except one player really did switch.
  const resolved = rosterBeforeTransition();
  const swapped = resolved[2];
  swapped.teamID = swapped.teamID === 1 ? 2 : 1;
  server.players = resolved;
  await deliverTick(gameState, players);

  const changes = server.take('S3_PLAYER_TEAM_CHANGED');
  assert.equal(
    changes.length,
    1,
    `exactly the one real swap should be reported, got ${changes.length}: ` +
      changes.map((e) => `${e.payload.player.name} (${e.payload.source})`).join(', ')
  );
  assert.equal(changes[0].payload.player.eosID, swapped.eosID);
  assert.equal(changes[0].payload.teamID, swapped.teamID);
  assert.equal(changes[0].payload.source, 'Deferred/Projection');

  await players.unmount();
});

await runTest('an attributed move inside a round-transition null window is not swallowed', async () => {
  const { server, players, gameState } = buildServices();
  await players.mount();

  server.players = rosterBeforeTransition();
  await players.handleUpdatedPlayerInfo();
  await players.handleUpdatedPlayerInfo();

  await gameState.handleNewGame({ layer: { classname: 'Sumari_Seed_v1', gamemode: 'Seed' } });
  players.handleNewGame();

  server.clearEmitted();

  // Nobody is confirmed this round, so the tick-diff gate is shut and the
  // projection has no fact to diff against — reconcile is the only path left,
  // and an attributed move has to survive it. The transition here does NOT flip
  // (so the projection is wrong for everyone) and the moved player ends up
  // where the flip would have put them, which is the exact shape that hides a
  // real move behind a wrong guess.
  server.players = rosterBeforeTransition().map((p) => ({ ...p, teamID: null }));
  await deliverTick(gameState, players);

  const resolved = rosterBeforeTransition();
  const moved = resolved[1];
  moved.teamID = moved.teamID === 1 ? 2 : 1;
  players.recordMove(moved.eosID, moved.teamID, 'SmartAssign');

  server.players = resolved;
  await deliverTick(gameState, players);

  const changes = server.take('S3_PLAYER_TEAM_CHANGED');
  assert.equal(
    changes.length,
    1,
    `only the attributed move should be reported, got ${changes.length}: ` +
      changes.map((e) => `${e.payload.player.name} (${e.payload.source})`).join(', ')
  );
  assert.equal(changes[0].payload.player.eosID, moved.eosID);
  assert.equal(changes[0].payload.source, 'SmartAssign');

  await players.unmount();
});

console.log('\nRound-transition team baseline tests complete.');
