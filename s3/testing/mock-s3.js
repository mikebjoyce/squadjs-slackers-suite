/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   MOCK S³ — a stand-in SlackersSquadServices for consumers    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Every consumer plugin (elo-tracker, team-balancer, smart-assign,
 * switch) extends S3PluginBase, which discovers S³ by
 * `constructor.name === 'SlackersSquadServices'`, awaits its `ready()`,
 * and then gates itself on `this._s3.version`. A test that constructs a
 * consumer plugin against a bare mock server therefore dies at mount with
 * "Incompatible S³ version: got unknown" long before any assertion runs.
 *
 * This module supplies the smallest object that satisfies that contract,
 * plus the handful of service methods the consumers actually call.
 *
 * ─── THE VERSION IS READ FROM THE REAL SOURCE ────────────────────
 *
 * `version` is scraped out of s3/plugins/slackers-squad-services.js rather
 * than hardcoded. The version gates exist precisely to catch S³ moving
 * ahead of a consumer's requirement; a hardcoded mock version would make
 * every one of those gates untestable-by-construction, and would go on
 * passing after a real incompatibility appeared.
 *
 * The plugin is not imported for this because importing it drags in
 * BasePlugin, sequelize and the whole DB stack — far more than a version
 * string is worth. See s3/testing/test-install-layout.js, which reads
 * ALL_PLUGINS out of install.cjs the same way and for the same reason.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   import { makeMockS3, makeMockServer, S3_VERSION } from '../../s3/testing/mock-s3.js';
 *
 *   const server = makeMockServer({ players: [...] });
 *   const plugin = new EloTracker(server, options, {});
 *   await plugin.prepareToMount();   // discovers the mock S³
 *   await plugin.mount();
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Monorepo-only. Reaching into ../../s3/ does not resolve at a deployed
 *   target, where install.cjs flattens every plugin into one directory.
 * - The mock proves a consumer's own logic. It says nothing about whether
 *   the real service returns what the mock claims — for that, mount the
 *   real service (see s3/testing/test-export-model-registration.js).
 */

'use strict';

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Sequelize from 'sequelize';

import ClansService from '../utils/clans-service.js';
import DBService from '../utils/db-service.js';
import FactionsService from '../utils/factions-service.js';
import GameStateService from '../utils/game-state-service.js';
import PlayersService from '../utils/players-service.js';
import ServerConfigService from '../utils/server-config-service.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The real classes, used as the schema for the mock.
 *
 * They are imported but never instantiated. Mounting a real service starts
 * polling timers and RCON traffic — far past what a plugin-lifecycle test
 * should carry — but the class still answers the one question a hand-written
 * mock cannot: which methods actually exist, and under what names. Every stub
 * below is checked against its real prototype at construction, so a renamed
 * or deleted service method breaks these tests instead of quietly diverging.
 */
const SERVICE_CLASSES = {
  gameState: GameStateService,
  players: PlayersService,
  factions: FactionsService,
  clans: ClansService,
  serverConfig: ServerConfigService
};

/** Every method name on a class's prototype chain, excluding Object's. */
function prototypeMethods(Class) {
  const names = new Set();
  let proto = Class.prototype;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (desc && typeof desc.value === 'function') names.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

/**
 * Build one mock service: every real method present, stubbed ones behaving,
 * the rest throwing a message that says exactly what to do.
 *
 * Unstubbed methods throw rather than returning undefined on purpose. A mock
 * that answers `undefined` to a question it was never taught lets a plugin
 * take the "no data" branch and the test pass — which is how a mock ends up
 * certifying behaviour nobody wrote.
 */
function buildService(serviceName, stubs, overrides) {
  const Class = SERVICE_CLASSES[serviceName];
  const real = prototypeMethods(Class);

  for (const name of Object.keys(stubs)) {
    if (!real.has(name)) {
      throw new Error(
        `mock-s3.js stubs ${serviceName}.${name}(), which no longer exists on ` +
        `${Class.name}. The service was renamed or removed — update the mock, ` +
        'do not delete the assertion.'
      );
    }
  }

  const service = {};
  for (const name of real) {
    service[name] = () => {
      throw new Error(
        `mock-s3.js has no stub for ${serviceName}.${name}(). ` +
        'Add one to buildService()\'s defaults, or pass it via makeMockS3() overrides.'
      );
    };
  }
  return Object.assign(service, stubs, overrides);
}

/** The real S³ version, read from the plugin source. */
export const S3_VERSION = readS3Version();

function readS3Version() {
  const source = fs.readFileSync(
    path.join(REPO_ROOT, 's3', 'plugins', 'slackers-squad-services.js'),
    'utf8'
  );
  const match = source.match(/static\s+get\s+version\s*\(\s*\)\s*\{\s*return\s*'([^']+)'/);
  if (!match) {
    throw new Error(
      'mock-s3.js could not read S³ version from slackers-squad-services.js. ' +
      'If the declaration moved, update readS3Version() — do not hardcode a version.'
    );
  }
  return match[1];
}

/**
 * A REAL DBService over in-memory SQLite, mounted and ready.
 *
 * Not a mock. Everything a consumer plugin does through `this.s3db` —
 * defineModel(), registerMigrations(), withTransaction(), the identifier
 * quoting — is engine behaviour, and a hand-written stand-in reports green on
 * SQL the database would reject. The suite's standing rule is to never trust a
 * mock for SQL, so the DB is the one part of S³ that is not mocked here.
 *
 * SQLite only. MySQL is the other live target, but a plugin-lifecycle test is
 * not where dialect differences belong — see
 * s3/testing/test-dialect-portability.js for those.
 *
 * @returns {Promise<DBService>} mounted service; call unmount() when done
 */
export async function makeS3Db({ verboseLogger = () => {} } = {}) {
  // Options form, not the 'sqlite::memory:' URL: Node now emits DEP0170 for
  // that URL shape, and a deprecation warning in every test run trains people
  // to ignore warnings.
  const sequelize = new Sequelize.Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false
  });
  const db = new DBService({ sequelize, verboseLogger });
  await db.mount();

  // Migrations are gated behind Discord confirmation or `autoMigrate: true`.
  // Without this the engine refuses to run, verifyAndRunMigrations() returns
  // null, no tables are created, and every persistence assertion downstream
  // fails with "no such table" — which reads like a plugin bug and is not one.
  // '__auto__' is the same token the autoMigrate config path uses.
  db.migrationEngine?.confirmToken('__auto__');

  return db;
}

/**
 * A stand-in S³ plugin.
 *
 * The class is named SlackersSquadServices because S3PluginBase._resolveS3()
 * discovers S³ by constructor name and by nothing else.
 *
 * @param {object} [overrides] - Per-service overrides, merged one level deep.
 *   e.g. `{ gameState: { getGamemode: () => 'Invasion' } }`
 * @returns {object} the mock S³ instance
 */
export function makeMockS3(overrides = {}) {
  const state = {
    layerName: 'Fallujah_RAAS_v2',
    gamemode: 'RAAS',
    matchId: 'match-0001',
    roundStartTime: Date.now(),
    maxPlayers: 100,
    ignoredGameModes: [],
    clansEnabled: false,
    clanOptions: { minSize: 2, maxSize: 18, caseSensitive: false, ignoreList: [] },
    players: [],
    squads: [],
    ...(overrides.state || {})
  };

  // Every real service exposes isReady(); consumers gate on it before reading,
  // so a service missing it throws "isReady is not a function" at mount.
  const defaults = {
    gameState: {
      isReady: () => true,
      getLayerName: () => state.layerName,
      // Display spelling. The real service keeps the classname canonical and
      // this separate; the mock has only one name, so both return it.
      getLayerDisplayName: () => state.layerDisplayName || state.layerName,
      getGamemode: () => state.gamemode,
      getPhase: () => 'LIVE',
      isResolving: () => false,
      isLayerResolved: () => true,
      isSeedMode: () => false,
      isTrainingMode: () => false,
      isIgnoredMode: () => false,
      getMatchId: () => state.matchId,
      getRoundStartTime: () => state.roundStartTime,
      // Consumers subscribe here to keep their own layer mirror fresh. The
      // returned function is the unsubscribe handle; a consumer that drops it
      // leaks a listener across rounds, so hand back a real one.
      onLayerGameModeChange: (fn) => {
        listeners.layerGameMode.push(fn);
        return () => {
          const i = listeners.layerGameMode.indexOf(fn);
          if (i >= 0) listeners.layerGameMode.splice(i, 1);
        };
      }
    },
    players: {
      isReady: () => true,
      getAllPlayers: () => state.players,
      getPlayer: (eosID) => state.players.find((p) => p.eosID === eosID) || null,
      getSquads: () => state.squads,
      areTeamsResolved: () => true,
      canAct: () => true,
      // Movement bookkeeping. Recorded rather than discarded so a test can
      // assert a plugin told S³ about a move it made — an unreported move
      // leaves S³'s attribution wrong for the rest of the round.
      recordMove: (...args) => { recordedMoves.push(args); return true; },
      rememberReconnect: (...args) => { rememberedReconnects.push(args); return true; },
      refreshNow: async () => true,
      lockGlobal: () => true,
      unlockGlobal: () => true,
      getEffectiveRefreshIntervalMs: () => 20000,
      // Refresh interest is reference-counted on the real service: a plugin
      // that registers at mount and never unregisters pins the poll rate high
      // for the rest of the process. Tracking it here lets a test assert the
      // mount/unmount pair actually balances.
      registerRefreshInterest: (source, opts) => {
        refreshInterests.set(source, opts ?? {});
      },
      unregisterRefreshInterest: (source) => {
        refreshInterests.delete(source);
      }
    },
    factions: {
      isReady: () => true,
      getTeamName: (teamID) => (Number(teamID) === 1 ? 'US' : 'MEA'),
      getCachedAbbreviations: () => ({ 1: 'US', 2: 'MEA' })
    },
    clans: {
      isReady: () => true,
      // Off by default: clan grouping is opt-in on the real service too, and a
      // test that wants it should say so rather than inherit it.
      isEnabled: () => state.clansEnabled,
      getPlayerTagCache: () => new Map(),
      normalizeTag: (tag) => (tag ? String(tag).toUpperCase() : null),
      extractRawPrefix: () => null,
      extractClanGroups: () => ({})
    },
    serverConfig: {
      isReady: () => true,
      getMaxPlayers: () => state.maxPlayers
    }
  };

  const listeners = { layerGameMode: [] };
  const refreshInterests = new Map();
  const recordedMoves = [];
  const rememberedReconnects = [];

  const services = {};
  for (const [name, methods] of Object.entries(defaults)) {
    services[name] = buildService(name, methods, overrides[name] || {});
  }

  // Data properties, not methods, so buildService() does not see them.
  // Consumers read gameState.ignoredGameModes directly (smart-assign builds the
  // evaluator context from it) rather than through an accessor.
  services.gameState.ignoredGameModes = state.ignoredGameModes;
  services.clans.options = state.clanOptions;

  // The class name is the whole discovery mechanism — see _resolveS3().
  class SlackersSquadServices {
    constructor() {
      this.version = overrides.version ?? S3_VERSION;
      this.db = overrides.db ?? null;
      this.services = services;
      this.state = state;
      // Flat getters, mirroring the real plugin, which exposes services both
      // as a map and as top-level properties.
      Object.assign(this, services);
      // Fire every registered layer/gamemode subscriber. Tests use this to
      // prove a consumer's local mirror is fed by the subscription and not by
      // a second, duplicate resolution stack of its own.
      // The payload key is `gameMode` (capital M) even though the accessor is
      // getGamemode() (lowercase) — see GameStateService._notifyLayerGameModeChange().
      // Consumers destructure `{ layerName, gameMode }`, so a mock that emitted
      // `gamemode` would hand every subscriber undefined and still "pass".
      this.emitLayerGameModeChange = (layerName, gameMode) => {
        const prevLayer = state.layerName;
        const prevGameMode = state.gamemode;
        state.layerName = layerName;
        state.gamemode = gameMode;
        for (const fn of [...listeners.layerGameMode]) {
          fn({ layerName, gameMode, prevLayer, prevGameMode });
        }
      };
      this.layerGameModeSubscriberCount = () => listeners.layerGameMode.length;
      this.refreshInterests = () => new Map(refreshInterests);
      this.recordedMoves = () => [...recordedMoves];
      this.rememberedReconnects = () => [...rememberedReconnects];
    }

    isReady() { return true; }
    async ready() { return true; }
  }

  return new SlackersSquadServices();
}

/**
 * A mock SquadJS server carrying a mock S³ in `plugins`.
 *
 * Extends EventEmitter so `server.on(...)` / `server.emit(...)` behave the way
 * SquadJS's do — several consumer plugins count listeners at unmount, which a
 * hand-rolled `{ on, removeListener }` stub cannot answer.
 *
 * @param {object} [opts]
 * @param {Array}  [opts.players]  - server.players
 * @param {Array}  [opts.squads]   - server.squads
 * @param {object} [opts.s3]       - overrides forwarded to makeMockS3()
 * @param {boolean}[opts.withS3]   - false to omit S³ entirely (discovery failure path)
 */
export function makeMockServer({ players = [], squads = [], s3 = {}, withS3 = true } = {}) {
  class MockServer extends EventEmitter {
    constructor() {
      super();
      this.players = players;
      this.squads = squads;
      this.a2sPlayerCount = players.length;
      // Deliberately null: this is the mid-round-restart state SquadJS never
      // repopulates, and the reason consumers take layer facts from S³.
      this.currentLayer = null;
      this.nextLayer = null;
      this.layerHistory = [];
      this.matchStartTime = new Date();
      this.rcon = { execute: async (cmd) => `ok: ${cmd}` };
      this.plugins = [];
    }
  }

  const server = new MockServer();
  if (withS3) {
    server.s3 = makeMockS3({ ...s3, state: { players, squads, ...(s3.state || {}) } });
    server.plugins.push(server.s3);
  }
  return server;
}
