/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      TEAM BALANCER — PLUGIN LIFECYCLE & LAYER MIRROR          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * team-balancer.js used to carry its own copy of S³'s layer stack —
 * inferGameMode(), resolveLayerInfo(), onLayerInfoUpdated(),
 * onServerInfoUpdated() and a 10s startPollingGameInfo() loop. All of it
 * was deleted, leaving gameModeCached / layerNameCached / lastKnownGoodLayer
 * as a pure mirror of S³ fed by one gameState.onLayerGameModeChange()
 * subscription.
 *
 * That deletion had no test behind it. This file supplies one, and asserts
 * the three things the deletion actually turns on:
 *
 *   1. the mirror really is fed by the subscription,
 *   2. it is NOT fed by server.currentLayer — which is null after a
 *      mid-round SquadJS restart, and is what the deleted methods read,
 *   3. the deleted names are gone and nothing calls them.
 *
 * Point 3 is a source scan rather than a behavioural assertion, because a
 * call to a deleted method throws only on the code path that reaches it —
 * which, for a once-per-round layer handler, may be days after the deploy.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-team-balancer-plugin.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - team-balancer.js imports './s3-plugin-base.js', a sibling only in the
 *   flattened layout install.cjs produces, so the plugin is loaded out of a
 *   throwaway assembly. See s3/testing/plugin-assembly.js.
 * - Monorepo-only: reaching into ../../s3/ does not resolve at a deployed
 *   target, where every plugin shares one flat directory.
 * - No DB. The mock S³ carries `db: null`, so S3PluginBase leaves _s3db
 *   null and the plugin's model/migration block is skipped. Schema
 *   behaviour is covered by s3/testing/test-migration-conformance.js.
 *
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAssembly, importFromAssembly, cleanAssembly } from '../../s3/testing/plugin-assembly.js';
import { makeMockServer, makeMockS3, S3_VERSION } from '../../s3/testing/mock-s3.js';
import { MESSAGES as EN } from '../../s3/utils/s3-locale-en.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.join(HERE, '..', 'plugins', 'team-balancer.js');

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

const assembly = buildAssembly('.tmp-team-balancer');
let TeamBalancer;
try {
  TeamBalancer = await importFromAssembly(assembly, 'team-balancer.js');

  const OPTIONS = {
    // Everything else falls through to optionsSpecification defaults, which the
    // assembly's BasePlugin applies exactly as SquadJS does.
    discordClient: null,
    enableAutomaticScrambles: false,
    useEloForBalance: false
  };

  /** Construct → prepareToMount (S³ discovery) → mount. */
  async function mount(server, options = {}) {
    const plugin = new TeamBalancer(server, { ...OPTIONS, ...options }, {});
    await plugin.prepareToMount();
    await plugin.mount();
    return plugin;
  }

  // ── 1. mount ───────────────────────────────────────────────────────────────
  {
    const server = makeMockServer();
    const plugin = await mount(server);

    await test('mounts against S³ and reports ready', async () => {
      assert.equal(plugin.ready, true);
      assert.equal(plugin._isMounted, true);
    });

    await test('binds its round and command listeners', async () => {
      for (const event of ['ROUND_ENDED', 'NEW_GAME', 'CHAT_COMMAND:teambalancer', 'CHAT_COMMAND:scramble']) {
        assert.ok(server.listenerCount(event) > 0, `${event} not bound`);
      }
    });

    await test('subscribes to the S³ layer/gamemode change exactly once', async () => {
      assert.equal(server.s3.layerGameModeSubscriberCount(), 1);
    });

    // ── 2. the mirror ────────────────────────────────────────────────────────
    await test('the layer mirror is fed by the S³ subscription', async () => {
      server.s3.emitLayerGameModeChange('Narva_Invasion_v1', 'Invasion');

      assert.equal(plugin.layerNameCached, 'Narva_Invasion_v1');
      assert.equal(plugin.gameModeCached, 'Invasion');
      assert.deepEqual(plugin.lastKnownGoodLayer, {
        name: 'Narva_Invasion_v1',
        gamemode: 'Invasion'
      });
    });

    await test('the payload key is gameMode, not gamemode', async () => {
      // GameStateService._notifyLayerGameModeChange() emits `gameMode` while the
      // accessor is getGamemode(). A subscriber that destructured the wrong one
      // would silently mirror `undefined` on every round — which reads as
      // "Unknown layer" downstream, the exact bug the deleted stack caused.
      server.s3.emitLayerGameModeChange('Mutaha_RAAS_v1', 'RAAS');
      assert.equal(plugin.gameModeCached, 'RAAS');
      assert.notEqual(plugin.gameModeCached, undefined);
    });

    await test('server.currentLayer never feeds the mirror', async () => {
      const before = { ...plugin.lastKnownGoodLayer };
      // The state SquadJS leaves behind after a mid-round restart, and then the
      // opposite: a populated currentLayer disagreeing with S³.
      server.currentLayer = null;
      assert.deepEqual(plugin.lastKnownGoodLayer, before);

      server.currentLayer = { name: 'Sumari_Seed_v1', gamemode: 'Seed' };
      server.emit('UPDATED_LAYER_INFORMATION');
      server.emit('UPDATED_SERVER_INFORMATION');
      await new Promise((r) => setTimeout(r, 20));

      assert.deepEqual(
        plugin.lastKnownGoodLayer, before,
        'a server.currentLayer read has been re-introduced'
      );
    });

    // ── 3. unmount ───────────────────────────────────────────────────────────
    await test('unmount unsubscribes from S³ and unbinds every listener', async () => {
      await plugin.unmount();

      assert.equal(server.s3.layerGameModeSubscriberCount(), 0, 'layer subscription leaked');
      assert.equal(plugin._unsubscribeLayerChange, null);
      for (const event of ['ROUND_ENDED', 'NEW_GAME', 'CHAT_COMMAND:teambalancer', 'CHAT_COMMAND:scramble', 'CHAT_MESSAGE']) {
        assert.equal(server.listenerCount(event), 0, `${event} still bound after unmount`);
      }
      assert.equal(plugin.ready, false);
      assert.equal(plugin._isMounted, false);
    });

    await test('an unsubscribed plugin stops mirroring', async () => {
      const stale = { ...plugin.lastKnownGoodLayer };
      server.s3.emitLayerGameModeChange('Gorodok_AAS_v1', 'AAS');
      assert.deepEqual(plugin.lastKnownGoodLayer, stale, 'still receiving callbacks after unmount');
    });
  }

  // ── 4. the layer fallback ──────────────────────────────────────────────────
  //
  // _applyLayerFallback() substitutes the last resolved layer when this round's own
  // never resolved. Its guard tests lastKnownGoodLayer against null, so the field has
  // to actually BE null before the first S³ callback — left undefined, the guard
  // misses and the fallback dereferences it. That is the crash reported against
  // v4.0.6 on a live server:
  //
  //   TypeError: Cannot read properties of undefined (reading 'gamemode')
  //     at TeamBalancer._applyLayerFallback
  //     at TeamBalancer.onRoundEnded
  //
  // It needs a restart where the layer never resolved, so it survived every round
  // that had one — hence the explicit fresh-construct assertion below.
  {
    const server = makeMockServer();
    const plugin = await mount(server);

    await test('the layer mirror initialises to null, not undefined', async () => {
      const fresh = new TeamBalancer(makeMockServer(), OPTIONS, {});
      for (const field of ['gameModeCached', 'layerNameCached', 'lastKnownGoodLayer']) {
        assert.strictEqual(fresh[field], null, `${field} is not initialised in the constructor`);
      }
    });

    await test('the fallback is a no-op when no layer has ever resolved', async () => {
      // A mid-round SquadJS restart: NEW_GAME nulls the two caches, and the S³ layer
      // callback has never fired, so there is nothing to fall back to.
      await plugin.onNewGame({});

      // The call itself is the assertion: in v4.0.6 an undefined lastKnownGoodLayer
      // sailed past the guard and was dereferenced right here, taking round-end
      // processing down with it.
      const roundReport = {};
      plugin._applyLayerFallback(roundReport);

      assert.equal(plugin.lastKnownGoodLayer, null);
      assert.equal(roundReport.gameMode, undefined);
      assert.equal(roundReport.layerName, undefined);
      assert.notEqual(roundReport.layerFallback, true, 'claimed a fallback it never had');
      // The branch is silent otherwise, so this flag and its log line are the only
      // evidence an operator gets that a round was processed with no layer at all.
      assert.equal(roundReport.layerUnresolved, true, 'no provenance for a blind round');
    });

    await test("the fallback substitutes the previous round's layer when it has one", async () => {
      server.s3.emitLayerGameModeChange('Yehorivka_RAAS_v1', 'RAAS');
      await plugin.onNewGame({});   // clears the two caches, keeps lastKnownGoodLayer

      const roundReport = {};
      plugin._applyLayerFallback(roundReport);

      assert.equal(roundReport.gameMode, 'RAAS');
      assert.equal(roundReport.layerName, 'Yehorivka_RAAS_v1');
      assert.equal(roundReport.layerFallback, true);
    });

    await plugin.unmount();
  }

  // ── 5. an unclassifiable round does not feed the streak ────────────────────
  //
  // Once the v4.0.6 crash stopped aborting onRoundEnded, a round whose layer never
  // resolved began falling through to the win-streak evaluation. Both gates that
  // would have excluded it — the seed check and isIgnoredMatch() — read S³, which is
  // the very service with no layer, so both answer "no" and a seed round gets counted
  // as an ordinary competitive one. Left unguarded that builds a streak out of seed
  // rounds and eventually scrambles off it.
  {
    const logPath = path.join(HERE, '.tmp-round-reports.jsonl');
    const ROUND_OPTS = {
      enableWinStreakTracking: true,
      enableSeedAutoScramble: false,
      enableDatabaseLogging: false,       // the mock S³ carries db: null
      // Both scramble triggers return before the streak bookkeeping, which would mask
      // whether the round was evaluated at all. This block is about the layer guard,
      // not about threshold tuning.
      enableSingleRoundScramble: false,
      maxConsecutiveWinsWithoutThreshold: 0,
      reportLogPath: logPath
    };
    // An ordinary Team 1 win: a 100-ticket margin stays under every scramble threshold.
    const WIN = { winner: { team: '1', tickets: '250' }, loser: { team: '2', tickets: '150' } };

    function roundEndServer() {
      const server = makeMockServer();
      server._sent = [];
      server.rcon.broadcast = async (msg) => { server._sent.push(msg); };
      server.rcon.warn = async () => {};
      return server;
    }

    await test('a round with no resolvable layer is skipped and the streak is left alone', async () => {
      const server = roundEndServer();
      const plugin = await mount(server, ROUND_OPTS);

      // No layer has ever resolved; NEW_GAME nulls the caches and there is no fallback.
      await plugin.onNewGame({});
      plugin.winStreakTeam = 1;
      plugin.winStreakCount = 2;

      await plugin.onRoundEnded(WIN);

      // consecutiveWinsCount is the tell: it advances on every non-ignored win
      // regardless of margin, so it is the cleanest evidence of whether the round
      // was evaluated at all, without coupling the test to threshold tuning.
      assert.equal(plugin.consecutiveWinsCount, 0, 'an unclassifiable round was evaluated');
      assert.equal(plugin.winStreakCount, 2, 'an unclassifiable round fed the win streak');
      assert.equal(plugin.winStreakTeam, 1, 'streak team changed on an unclassifiable round');
      assert.equal(server._sent.length, 0, 'broadcast a result for a round it could not classify');

      await plugin.unmount();
    });

    await test('a round that HAS a layer still feeds the streak', async () => {
      // The guard must not swallow ordinary rounds — without this the test above
      // passes just as well against a plugin that stopped evaluating anything.
      const server = roundEndServer();
      const plugin = await mount(server, ROUND_OPTS);

      server.s3.emitLayerGameModeChange('Yehorivka_RAAS_v1', 'RAAS');
      plugin.winStreakTeam = 1;
      plugin.winStreakCount = 2;

      await plugin.onRoundEnded(WIN);

      assert.equal(plugin.consecutiveWinsCount, 1, 'the guard is swallowing classifiable rounds');
      assert.equal(plugin.consecutiveWinsTeam, 1);
      assert.ok(server._sent.length > 0, 'a classifiable round announced nothing');

      await plugin.unmount();
    });

    fs.rmSync(logPath, { force: true });
  }

  // ── 6. mount is idempotent ─────────────────────────────────────────────────
  {
    const server = makeMockServer();
    const plugin = await mount(server);
    const listenersAfterFirst = server.listenerCount('ROUND_ENDED');

    await test('a second mount does not double-bind', async () => {
      await plugin.mount();
      assert.equal(server.listenerCount('ROUND_ENDED'), listenersAfterFirst);
      assert.equal(server.s3.layerGameModeSubscriberCount(), 1);
    });

    await plugin.unmount();
  }

  // ── 7. the S³ contract ─────────────────────────────────────────────────────
  await test('refuses to mount against an S³ older than required', async () => {
    const server = makeMockServer();
    server.plugins = [makeMockS3({ version: '0.9.0' })];

    await assert.rejects(
      () => mount(server),
      /Incompatible S³ version/
    );
    assert.equal(server.listenerCount('ROUND_ENDED'), 0, 'listeners bound despite a refused mount');
  });

  await test(`the live S³ version (${S3_VERSION}) satisfies team-balancer's floor`, async () => {
    const server = makeMockServer();
    const plugin = await mount(server);
    await plugin.unmount();
  });

  await test('refuses to mount with no S³ present', async () => {
    const server = makeMockServer({ withS3: false });
    await assert.rejects(() => mount(server), /SlackersSquadServices is required/);
  });

  // ── 8. the deleted layer stack stays deleted ───────────────────────────────
  await test('the removed layer-resolution methods are gone and uncalled', async () => {
    const source = fs.readFileSync(PLUGIN_SRC, 'utf8');
    // Comments legitimately name these while explaining the removal, so strip
    // comments before scanning rather than matching the bare identifier.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    for (const name of [
      'inferGameMode',
      'resolveLayerInfo',
      'onLayerInfoUpdated',
      'onServerInfoUpdated',
      'startPollingGameInfo'
    ]) {
      assert.ok(
        !new RegExp(`\\b${name}\\s*\\(`).test(code),
        `${name}() is referenced again in team-balancer.js — S³ owns layer resolution`
      );
    }
  });

  await test('the plugin reads no layer facts from server.currentLayer', async () => {
    const source = fs.readFileSync(PLUGIN_SRC, 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    assert.ok(
      !/\bserver\.currentLayer\b/.test(code),
      'server.currentLayer is read again — it is null after a mid-round restart'
    );
  });

  // ── RconMessages ─────────────────────────────────────────────────────────
  //
  // These are the round-end broadcasts every player reads. They are built by
  // CommandHandlers.register() inside the constructor — before prepareToMount()
  // discovers S³ — and SwapExecutor is handed the same object in that same
  // constructor and keeps the reference for the life of the plugin. So the
  // values cannot be plain strings: they would be resolved against the default
  // language and stay English no matter what the operator configured, and the
  // bug would be invisible to anyone who does not read the second language.
  {
    const server = makeMockServer();
    const plugin = new TeamBalancer(server, { ...OPTIONS }, {});
    const messages = plugin.RconMessages;

    await test('RconMessages leaves are accessors, not values snapshotted at construction', async () => {
      const top = Object.getOwnPropertyDescriptor(messages, 'draw');
      assert.equal(typeof top?.get, 'function', 'draw is a plain value — it snapshots the default language');

      const nested = Object.getOwnPropertyDescriptor(messages.dominant, 'steamrolled');
      assert.equal(typeof nested?.get, 'function', 'dominant.steamrolled is a plain value');
    });

    await test('every read goes back through localize(), so language changes take effect', async () => {
      const seen = [];
      const real = plugin.localize;
      plugin.localize = (key) => { seen.push(key); return '<<resolved>>'; };

      assert.equal(messages.draw, '<<resolved>>');
      assert.equal(messages.system.trackingEnabled, '<<resolved>>');
      assert.deepEqual(seen, ['teamBalancer.rconMessages.draw', 'teamBalancer.rconMessages.system.trackingEnabled']);

      plugin.localize = real;
      assert.equal(messages.draw, EN.teamBalancer.rconMessages.draw);
    });

    await test('S³ discovery does not replace the object SwapExecutor is holding', async () => {
      await plugin.prepareToMount();
      assert.equal(plugin.RconMessages, messages, 'RconMessages was rebuilt — SwapExecutor now holds a stale object');
    });

    await test('every message matches the catalogue and keeps its placeholders', async () => {
      const walk = (node, cat, path = []) => {
        for (const [k, expected] of Object.entries(cat)) {
          const where = [...path, k].join('.');
          if (expected && typeof expected === 'object') { walk(node[k], expected, [...path, k]); continue; }
          assert.equal(node[k], expected, `teamBalancer.rconMessages.${where} does not match the catalogue`);
          // formatMessage() substitutes at the call site, so localize() must
          // hand the placeholders back untouched.
          for (const m of expected.matchAll(/\{(\w+)\}/g)) {
            assert.ok(node[k].includes(`{${m[1]}}`), `${where} lost placeholder {${m[1]}}`);
          }
        }
      };
      walk(messages, EN.teamBalancer.rconMessages);
    });

    await test('the prefix tag stays English and is not a catalogue key', async () => {
      assert.equal(messages.prefix, '[TeamBalancer]');
      assert.ok(!('prefix' in EN.teamBalancer.rconMessages), 'prefix was localized — it is a log tag, not prose');
    });

    await test('the getters survive spreading and serialization', async () => {
      // Consumers that spread or log the object must see strings, not accessors.
      const plain = JSON.parse(JSON.stringify(messages));
      assert.equal(plain.draw, EN.teamBalancer.rconMessages.draw);
      assert.equal(plain.dominant.stomped, EN.teamBalancer.rconMessages.dominant.stomped);
      assert.equal({ ...messages }.scrambleCompleteMessage, EN.teamBalancer.rconMessages.scrambleCompleteMessage);
    });
  }

  // ─── Diagnostics carry a stable id ──────────────────────────────
  //
  // tb-commands.js pulls the two results out of the array to build the RCON
  // diag page. It used to find them by comparing r.name against a localized
  // string while TBDiagnostics wrote that name in English — agreeing only in
  // English, and dereferencing undefined in every other language. The name is
  // display text now and the id is what code matches on, so this asserts the
  // ids survive a language that changes every string.
  {
    // Imported from source, not the assembly: importFromAssembly resolves a
    // plugin entry point, and this is a util the plugin pulls in.
    const { TBDiagnostics } = await import('../utils/tb-diagnostics.js');

    // Stands in for a configured language: every key comes back different, and
    // nothing that a human reads keeps its English value.
    const translated = (key) => `«${key}»`;
    const stubTB = (localize) => ({
      localize,
      s3db: null,                       // both probes fail; the ids still have to be there
      server: { squads: [], players: [] },
      transformSquadJSData: () => ({ squads: [], players: [] }),
      options: { scramblePercentage: 0.5 },
      winStreakTeam: null
    });

    await test('every diagnostic result carries an id', async () => {
      const results = await new TBDiagnostics(stubTB((k) => k)).runAll();
      assert.deepEqual(results.map((r) => r.id), ['s3Integration', 'scrambler']);
    });

    await test('the ids do not move when the language does', async () => {
      const results = await new TBDiagnostics(stubTB(translated)).runAll();
      assert.deepEqual(results.map((r) => r.id), ['s3Integration', 'scrambler']);

      // The display text did move — otherwise this proves nothing.
      assert.ok(results.every((r) => r.name.startsWith('«')), 'names were not localized');

      // The lookup tb-commands.js performs, under that language.
      assert.ok(results.find((r) => r.id === 's3Integration'), 'S³ result unreachable by id');
      assert.ok(results.find((r) => r.id === 'scrambler'), 'scrambler result unreachable by id');
    });

    await test('tb-commands finds diagnostics by id, never by name', async () => {
      const src = fs.readFileSync(path.join(HERE, '..', 'utils', 'tb-commands.js'), 'utf8');
      assert.ok(/results\.find\(\(r\) => r\.id === 's3Integration'\)/.test(src),
        'the S³ result is no longer matched by id');
      // \b matters: constructor.name === 'EloTracker' ends in "r.name === ".
      assert.ok(!/\br\.name === /.test(src), 'a diagnostic result is being matched by its localized name again');
    });
  }

} finally {
  cleanAssembly(assembly);
}

console.log(results.join('\n'));
console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} passed.`);
if (!process.exitCode) console.log('\nAll team-balancer plugin tests passed.');
