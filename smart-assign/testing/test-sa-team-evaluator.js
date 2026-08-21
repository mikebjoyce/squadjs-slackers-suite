/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          SA TEAM EVALUATOR — IGNORED MODE TEST               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * evaluateTeamAssignment() decides whether the current round is an
 * "ignored gamemode" and bails out early if so. It does NOT call
 * GameStateService.isIgnoredMode() — it reimplements the match against
 * the same ignoredGameModes array, because the evaluator is a pure
 * function with no S³ reference.
 *
 * Two implementations of one rule will drift. This is a DIFFERENTIAL
 * test: for every input, the evaluator's verdict must equal
 * gameState.isIgnoredMode(). It fails if either side changes alone.
 *
 * Also pins the behaviour that motivated the recent change: the layer
 * facts arrive from S³ via context, never from server.currentLayer,
 * which is null after a mid-round SquadJS restart.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-sa-team-evaluator.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - sa-team-evaluator.js is a pure module with no base-class import, so
 *   it loads directly from the source tree. Plugins that DO import
 *   './base-plugin.js' need the sandbox pattern in
 *   dev-harness/testing/test-dev-rcon-harness.js instead.
 *
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { evaluateTeamAssignment } from '../utils/sa-team-evaluator.js';
import GameStateService from '../../s3/utils/game-state-service.js';

class MockServer extends EventEmitter {
  constructor() {
    super();
    this.players = [];
    this.currentLayer = null;
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

/** Ask the evaluator whether it considers this layer/gamemode ignored. */
async function evaluatorSaysIgnored(gs, { layerName, gamemode }) {
  const server = new MockServer();
  server.players = [
    { eosID: 'a', teamID: 1, name: 'A' },
    { eosID: 'b', teamID: 2, name: 'B' }
  ];

  const result = await evaluateTeamAssignment(
    { eosID: 'new', name: 'Newcomer' },
    server,
    {
      // Exactly what smart-assign.js:1363 passes at the real call site.
      ignoredModes: gs.ignoredGameModes ?? [],
      layerName,
      gamemode
    }
  );

  return result.reason === 'Ignored Gamemode';
}

// The matrix deliberately mixes casing and both layer-name conventions
// (pretty "Sumari Bala Seed v1" vs classname "Sumari_Seed_v1"), because S³
// resolves either depending on which event delivered the layer.
const CASES = [
  { layerName: 'Sumari_Seed_v1', gamemode: 'Seed' },
  { layerName: 'Sumari Bala Seed v1', gamemode: 'Seed' },
  { layerName: 'SUMARI_SEED_V1', gamemode: 'SEED' },
  { layerName: 'JensensRange_USA-PLA', gamemode: 'Training' },
  { layerName: 'Fallujah_RAAS_v2', gamemode: 'RAAS' },
  { layerName: 'Fallujah RAAS v2', gamemode: 'RAAS' },
  { layerName: 'Yehorivka_AAS_v2', gamemode: 'AAS' },
  { layerName: 'Narva_Invasion_v1', gamemode: 'Invasion' },
  { layerName: 'Unknown', gamemode: 'Unknown' },
  { layerName: '', gamemode: '' }
];

const CONFIGS = [
  ['seed', 'jensen'],          // what the live server runs
  ['SEED', 'Jensen'],          // operator typed capitals
  ['seed'],
  [],                          // nothing ignored
  ['raas']                     // deliberately odd, to catch substring surprises
];

await runTest('evaluator agrees with GameStateService.isIgnoredMode() on every case', async () => {
  let compared = 0;

  for (const modes of CONFIGS) {
    for (const { layerName, gamemode } of CASES) {
      const gs = new GameStateService({ server: new MockServer() });
      gs.setIgnoredGameModes(modes);
      // Seed the caches directly: resolveLayerInfo rejects "Unknown" and the
      // empty case, and here we want to compare verdicts on those too.
      gs.layerNameCached = layerName;
      gs.gameModeCached = gamemode;

      const authoritative = gs.isIgnoredMode();
      const evaluated = await evaluatorSaysIgnored(gs, { layerName, gamemode });

      assert.equal(
        evaluated,
        authoritative,
        `disagreement for modes=${JSON.stringify(modes)} layer="${layerName}" gamemode="${gamemode}": ` +
        `evaluator=${evaluated} isIgnoredMode=${authoritative}`
      );
      compared += 1;
    }
  }

  assert.equal(compared, CONFIGS.length * CASES.length);
});

await runTest('matching is case-insensitive on both the config and the layer facts', async () => {
  const gs = new GameStateService({ server: new MockServer() });
  gs.setIgnoredGameModes(['SEED']);
  gs.layerNameCached = 'sumari_seed_v1';
  gs.gameModeCached = 'seed';

  assert.equal(gs.isIgnoredMode(), true);
  assert.equal(await evaluatorSaysIgnored(gs, { layerName: 'sumari_seed_v1', gamemode: 'seed' }), true);

  // Capitals on every axis at once.
  assert.equal(await evaluatorSaysIgnored(gs, { layerName: 'SUMARI_SEED_V1', gamemode: 'SEED' }), true);
});

await runTest('either the layer name or the gamemode alone is enough to match', async () => {
  const gs = new GameStateService({ server: new MockServer() });
  gs.setIgnoredGameModes(['seed']);

  // Gamemode carries it, layer name does not.
  assert.equal(await evaluatorSaysIgnored(gs, { layerName: 'Mutaha_RAAS_v1', gamemode: 'Seed' }), true);
  // Layer name carries it, gamemode does not.
  assert.equal(await evaluatorSaysIgnored(gs, { layerName: 'Sumari_Seed_v1', gamemode: 'RAAS' }), true);
  // Neither.
  assert.equal(await evaluatorSaysIgnored(gs, { layerName: 'Mutaha_RAAS_v1', gamemode: 'RAAS' }), false);
});

await runTest('an empty or missing needle never matches everything', async () => {
  const gs = new GameStateService({ server: new MockServer() });

  // ''.includes('') is true in JS, so an empty needle would ignore EVERY round
  // if the guard were dropped. This is the assertion that catches that.
  for (const modes of [[''], ['', 'seed'], [null], [undefined]]) {
    const evaluated = await evaluatorSaysIgnored(
      { ignoredGameModes: modes },
      { layerName: 'Fallujah_RAAS_v2', gamemode: 'RAAS' }
    );
    assert.equal(evaluated, false, `empty needle in ${JSON.stringify(modes)} matched a normal RAAS round`);
  }

  // ...but a real needle alongside an empty one still works.
  gs.setIgnoredGameModes(['', 'seed']);
  assert.equal(await evaluatorSaysIgnored(gs, { layerName: 'Sumari_Seed_v1', gamemode: 'Seed' }), true);
});

await runTest('layer facts come from context, never from server.currentLayer', async () => {
  const server = new MockServer();
  // The mid-round-restart state: SquadJS never repopulates this from RCON.
  server.currentLayer = null;
  server.players = [{ eosID: 'a', teamID: 1 }, { eosID: 'b', teamID: 2 }];

  const result = await evaluateTeamAssignment(
    { eosID: 'new', name: 'Newcomer' },
    server,
    { ignoredModes: ['seed'], layerName: 'Sumari_Seed_v1', gamemode: 'Seed' }
  );

  // Reading server.currentLayer would yield '' here and miss the match.
  assert.equal(result.reason, 'Ignored Gamemode');
  assert.equal(result.targetTeam, null);

  // And the converse: a populated server.currentLayer must NOT override the
  // context, or the two sources could disagree.
  server.currentLayer = { name: 'Sumari_Seed_v1', gamemode: 'Seed' };
  const notIgnored = await evaluateTeamAssignment(
    { eosID: 'new', name: 'Newcomer' },
    server,
    { ignoredModes: ['seed'], layerName: 'Fallujah_RAAS_v2', gamemode: 'RAAS' }
  );
  assert.notEqual(notIgnored.reason, 'Ignored Gamemode');
});

if (!process.exitCode) {
  console.log('\nAll sa-team-evaluator tests passed.');
}
