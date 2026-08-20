/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      SMART ASSIGN — PLUGIN LIFECYCLE                          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * smart-assign.js had no test that constructed it at all — its evaluator
 * was covered (test-sa-team-evaluator.js) but the plugin wrapping it was
 * not, so an edit to mount/unmount shipped unchecked.
 *
 * The assertions here are the ones with a cost attached if they break:
 *
 *   - the S³ version gate fires, and the live S³ satisfies it,
 *   - every listener bound at mount is released at unmount,
 *   - the players-service refresh interest registered at mount is
 *     unregistered at unmount. That one is reference-counted on the real
 *     service, so a leak pins the poll rate at 20s for the life of the
 *     process — invisible in logs, and paid for on every RCON tick.
 *   - the evaluator is fed layer facts from S³, not server.currentLayer,
 *     which is null after a mid-round SquadJS restart.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-smart-assign-plugin.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - smart-assign.js imports './s3-plugin-base.js', a sibling only in the
 *   flattened layout install.cjs produces, so the plugin is loaded out of a
 *   throwaway assembly. See s3/testing/plugin-assembly.js.
 * - Monorepo-only: reaching into ../../s3/ does not resolve at a deployed
 *   target, where every plugin shares one flat directory.
 * - No DB. The mock S³ carries `db: null`, so the model/migration block is
 *   skipped; schema behaviour lives in s3/testing/test-migration-conformance.js.
 *
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';
import { makeMockServer, makeMockS3, S3_VERSION } from '../../s3/testing/mock-s3.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.join(HERE, '..', 'plugins', 'smart-assign.js');

const BOUND_EVENTS = [
  'NEW_GAME',
  'ROUND_ENDED',
  'TEAM_BALANCER_SCRAMBLE_EXECUTED',
  'S3_PLAYER_JOINED',
  'S3_PLAYER_LEFT'
];

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

const assembly = buildAssembly('.tmp-smart-assign');
try {
  const SmartAssign = await importFromAssembly(assembly, 'smart-assign.js');

  async function mount(server, options = {}) {
    const plugin = new SmartAssign(server, { discordClient: null, ...options }, {});
    await plugin.prepareToMount();
    await plugin.mount();
    return plugin;
  }

  const somePlayers = [
    { eosID: 'a', teamID: 1, name: 'A' },
    { eosID: 'b', teamID: 2, name: 'B' }
  ];

  // ── 1. mount / unmount symmetry ────────────────────────────────────────────
  {
    const server = makeMockServer({ players: somePlayers });
    const plugin = await mount(server);

    await test('mounts against S³ and binds its listeners', async () => {
      for (const event of BOUND_EVENTS) {
        assert.ok(server.listenerCount(event) > 0, `${event} not bound`);
      }
    });

    await test('registers a players-service refresh interest at mount', async () => {
      const interests = server.s3.refreshInterests();
      assert.ok(interests.has('SmartAssign'), 'no refresh interest registered');
      assert.equal(interests.get('SmartAssign').maxStalenessMs, 20000);
    });

    await test('unmount releases every listener', async () => {
      await plugin.unmount();
      for (const event of BOUND_EVENTS) {
        assert.equal(server.listenerCount(event), 0, `${event} still bound after unmount`);
      }
    });

    await test('unmount releases the refresh interest', async () => {
      // Reference-counted on the real service: leaking this holds the poll rate
      // high for the rest of the process, silently.
      assert.equal(
        server.s3.refreshInterests().has('SmartAssign'), false,
        'refresh interest leaked past unmount'
      );
    });
  }

  // ── 2. the S³ contract ─────────────────────────────────────────────────────
  await test('refuses to mount against an S³ older than required', async () => {
    const server = makeMockServer({ players: somePlayers });
    server.plugins = [makeMockS3({ version: '0.9.0' })];

    await assert.rejects(() => mount(server), /Incompatible S³ version/);
    for (const event of BOUND_EVENTS) {
      assert.equal(server.listenerCount(event), 0, `${event} bound despite a refused mount`);
    }
  });

  await test(`the live S³ version (${S3_VERSION}) satisfies smart-assign's floor`, async () => {
    const server = makeMockServer({ players: somePlayers });
    const plugin = await mount(server);
    await plugin.unmount();
  });

  await test('refuses to mount with no S³ present', async () => {
    const server = makeMockServer({ players: somePlayers, withS3: false });
    await assert.rejects(() => mount(server), /SlackersSquadServices is required/);
  });

  // ── 3. optional EloTracker discovery ───────────────────────────────────────
  {
    const server = makeMockServer({ players: somePlayers });

    await test('mounts happily with no EloTracker present', async () => {
      const plugin = await mount(server);
      assert.equal(plugin.eloTracker, null);
      await plugin.unmount();
    });

    await test('discovers an EloTracker when one is mounted', async () => {
      class EloTracker { getRating() { return { mu: 25, sigma: 8.333 }; } }
      server.plugins.push(new EloTracker());

      const plugin = await mount(server);
      assert.ok(plugin.eloTracker, 'EloTracker not discovered');
      assert.equal(typeof plugin.eloTracker.getRating, 'function');
      await plugin.unmount();
      server.plugins.pop();
    });

    await test('tolerates an EloTracker missing getRating()', async () => {
      // The real plugin logs a warning and falls back rather than throwing —
      // an ELO plugin at the wrong version must not take smart-assign down.
      class EloTracker {}
      server.plugins.push(new EloTracker());

      const plugin = await mount(server);
      assert.ok(plugin.eloTracker, 'EloTracker not discovered');
      await plugin.unmount();
      server.plugins.pop();
    });
  }

  // ── 4. layer facts come from S³ ────────────────────────────────────────────
  await test('the plugin reads no layer facts from server.currentLayer', async () => {
    // sa-team-evaluator.js was moved off server.currentLayer onto S³-supplied
    // layerName/gamemode; the plugin is the call site that has to keep it that
    // way. A behavioural assertion cannot see this — the evaluator would just
    // silently score against '' — so scan the source.
    const code = fs.readFileSync(PLUGIN_SRC, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    assert.ok(
      !/\bserver\.currentLayer\b/.test(code),
      'server.currentLayer is read again — it is null after a mid-round restart'
    );
  });

  await test('the evaluator sees the layer S³ reports, not a stale one', async () => {
    // Behavioural rather than a source scan. The plugin's own
    // evaluateTeamAssignment() wrapper is what assembles the evaluator context
    // from S³; driving it end to end proves the wiring instead of pattern-
    // matching the call site.
    const server = makeMockServer({
      players: somePlayers,
      s3: { state: { ignoredGameModes: ['seed'], layerName: 'Sumari_Seed_v1', gamemode: 'Seed' } }
    });
    const plugin = await mount(server);

    const ignored = await plugin.evaluateTeamAssignment({ eosID: 'new', name: 'Newcomer' });
    assert.equal(
      ignored.reason, 'Ignored Gamemode',
      'the evaluator did not see the Seed layer S³ is reporting'
    );

    // Now move S³ to a normal round through the same subscription the plugin
    // listens on. The verdict must follow.
    server.s3.emitLayerGameModeChange('Fallujah_RAAS_v2', 'RAAS');
    const notIgnored = await plugin.evaluateTeamAssignment({ eosID: 'new2', name: 'Newcomer2' });
    assert.notEqual(notIgnored.reason, 'Ignored Gamemode');

    await plugin.unmount();
  });
} finally {
  cleanAssembly(assembly);
}

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed.`);
if (!process.exitCode) console.log('\nAll smart-assign plugin tests passed.');
