/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   SINGLETON SCOPING — THE TWO TABLES WHOSE KEY IS THE SERVER  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * `S3_GameState` and `TeamBalancerState` are single-row tables whose primary
 * key used to be a meaningless `1`. Under multi-server that integer becomes an
 * identity: row 2 is server 2's round state and win streak. The change costs no
 * DDL — the column was already an integer primary key — which is exactly what
 * makes it easy to get wrong, because nothing in the schema records that the
 * meaning of the column changed.
 *
 * Two things can go wrong, and neither raises anything on the engine the
 * maintainer runs:
 *
 *   An insert with no `id`. On SQLite `INTEGER PRIMARY KEY` is the rowid alias,
 *   so the column auto-assigns whether or not the model asked it to, and the
 *   phantom row reads as some other server's state. MySQL and Postgres reject
 *   the same statement, so the failure is SQLite-only and silent.
 *
 *   An implicit renumber. A long-standing install declaring `server.id: 3`
 *   owns the legacy row numbered 1, and from inside the process that is
 *   indistinguishable from a new server 3 joining a community whose incumbent
 *   declares 1 — same config, same empty registry, opposite correct answers.
 *   Every rule that tries to work it out (boot first, empty registry, oldest
 *   row) silently destroys somebody's state in one of the four boot orders.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   the id-less insert   Both models refuse a create with no `id`, on SQLite,
 *                        where the rowid would otherwise supply one quietly.
 *   the four boot orders New-server-first and incumbent-first, each with the
 *                        incumbent declaring 1 and declaring non-1. No order
 *                        may cost the incumbent its round state or win streak.
 *   no implicit renumber A server declaring 4 against a legacy database leaves
 *                        row 1 byte-for-byte alone.
 *   adoption             `!s3 migrate adopt-state` previews without writing,
 *                        moves both singletons under `--confirm`, and tells a
 *                        server declaring 1 that there is nothing to adopt.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * File-backed SQLite, because half of these cases need two DBServices looking
 * at the same rows and `:memory:` gives each connection a database of its own.
 * TeamBalancer is imported from a real flattened assembly — its entry point
 * imports S³ as a flat sibling, which only resolves in the shipped layout.
 *
 * Category: 1 (no external services)
 * Run:    node s3/testing/test-singleton-scoping.js
 */

'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Sequelize } from 'sequelize';

import DBService from '../utils/db-service.js';
import GameStateService from '../utils/game-state-service.js';
import { localize as lookupMessage } from '../utils/s3-i18n.js';
import * as cmds from '../utils/s3-commands.js';
import { buildAssembly, importFromAssembly, cleanAssembly } from './plugin-assembly.js';

const ASSEMBLY = buildAssembly('.tmp-singleton-scoping');
const TeamBalancer = await importFromAssembly(ASSEMBLY, 'team-balancer.js');

// Every mounted DBService registers its own process-level rejection handler,
// and the boot-order matrix stands up more than the default ten. The warning
// is Node counting listeners, not a leak this file can fix.
process.setMaxListeners(64);

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const tests = [];
const tempDirs = [];
const openConnections = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(70));
  console.log('Singleton Scoping  (id is the server, and nothing renumbers itself)');
  console.log('='.repeat(70));
  console.log('');

  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${String(err.message).split('\n').join('\n      ')}`);
      failed++;
    }
  }

  for (const sequelize of openConnections) {
    try { await sequelize.close(); } catch { /* ignore */ }
  }
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  cleanAssembly(ASSEMBLY);

  console.log('');
  console.log('─'.repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed, ${tests.length} total`);
  console.log('─'.repeat(70));

  if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A file-backed SQLite database two DBServices can genuinely share. */
function sharedStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-singleton-'));
  tempDirs.push(dir);
  return path.join(dir, 'singleton.sqlite');
}

/** One process's mounted view of the shared database. */
async function dbFor(storage, serverID) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  openConnections.push(sequelize);
  const db = new DBService({
    sequelize,
    serverID,
    verboseLogger: () => {},
    defaultRetry: { attempts: 3, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();
  return db;
}

/**
 * GameStateService driven exactly as far as the two methods that carry the id.
 *
 * Not mount(): that wants a SquadJS EventEmitter and goes on to bootstrap a
 * layer over RCON. `_initPersistence()` and `_recoverPersistedState()` are the
 * whole of what this file is about, and they are the shipped implementations.
 */
async function bootGameState(db) {
  const gs = new GameStateService({ parent: { db }, server: { on: () => {}, off: () => {} } });
  await gs._initPersistence();
  await gs._recoverPersistedState();
  return gs;
}

function defaultOptions(PluginClass) {
  const spec = PluginClass.optionsSpecification || {};
  const options = {};
  for (const [key, def] of Object.entries(spec)) options[key] = def?.default;
  return options;
}

const STOP_AFTER_REGISTRATION = Symbol('stop');

/**
 * TeamBalancer driven far enough to have registered `TeamBalancerState` and
 * built its S³ wrapper, and no further.
 *
 * The model and the six call sites under test live inside `_onS3Ready()` and
 * `_buildS3DbWrapper()` respectively, so both are called on the real prototype
 * rather than restated here. A wrapper rebuilt in the test would prove nothing
 * about which row the shipped one addresses. Registration is stopped by
 * throwing out of `verifyAndRunMigrations()`, the same sentinel
 * test-migration-conformance.js uses, which unwinds before any listener or
 * timer starts.
 */
async function bootTeamBalancer(db) {
  const plugin = Object.create(TeamBalancer.prototype);
  Object.assign(plugin, {
    _s3db: db,
    _s3: { isReady: () => true, db },
    options: defaultOptions(TeamBalancer),
    server: { on: () => {}, off: () => {}, removeListener: () => {}, plugins: [] },
    _isMounted: false,
    ready: false,
    verbose: () => {},
    reportError: () => {},
    _checkS3Version: () => {},
    validateOptions: () => {},
    verifyAndRunMigrations: async () => { throw STOP_AFTER_REGISTRATION; }
  });

  try {
    await TeamBalancer.prototype._onS3Ready.call(plugin);
  } catch { /* everything past registration is out of scope */ }

  const model = db.getModel('TeamBalancerState');
  assert.ok(model, 'TeamBalancer registered no TeamBalancerState model — the probe stopped too early');
  await model.sync();

  const wrapper = TeamBalancer.prototype._buildS3DbWrapper.call(plugin, db);
  assert.ok(wrapper, 'TeamBalancer built no S³ wrapper');
  return wrapper;
}

const LEGACY = {
  phase: 'ENDGAME',
  matchId: 'legacy-match',
  layer: 'Mutaha_RAAS_v3',
  roundStartTime: 1725400000000,
  winStreakTeam: 2,
  winStreakCount: 4
};

/**
 * A database as it exists the moment before the upgrade: both singletons hold
 * a single row numbered 1, written when that number meant nothing, and
 * `S3_Servers` is empty because the registry did not exist yet.
 */
async function legacyDatabase() {
  const storage = sharedStorage();
  const db = await dbFor(storage, 1);

  const gs = await bootGameState(db);
  gs.phase = LEGACY.phase;
  gs.matchId = LEGACY.matchId;
  gs.layerNameCached = LEGACY.layer;
  gs.roundStartTime = LEGACY.roundStartTime;
  await gs._persistState();

  const tb = await bootTeamBalancer(db);
  await tb.initDB();
  await tb.saveState(LEGACY.winStreakTeam, LEGACY.winStreakCount, null, 0);

  // The legacy database predates the registry, so leave nothing in it. A row
  // here would let a case pass by reading the registry rather than the
  // declaration, which is the inference this whole design forbids.
  await db.ServersModel.destroy({ where: {} });

  await db.sequelize.close();
  return storage;
}

/** Raw read, so an assertion cannot be satisfied by the model's own scoping. */
async function rawRow(storage, table, id) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage, logging: false });
  try {
    const [rows] = await sequelize.query(`SELECT * FROM "${table}" WHERE id = ${Number(id)}`);
    return rows[0] || null;
  } finally {
    await sequelize.close();
  }
}

// ---------------------------------------------------------------------------
// The id-less insert
// ---------------------------------------------------------------------------

test('S3_GameState refuses a create with no id', async () => {
  const db = await dbFor(sharedStorage(), 1);
  const gs = await bootGameState(db);

  // On SQLite this column is the rowid alias: without the model-layer guard
  // the row is created and numbered 2, which under per-server scoping is
  // server 2's round state. Nothing is raised on any engine's console.
  await assert.rejects(
    () => gs.GameStateModel.create({ phase: 'LIVE', resolving: false }),
    /cannot be null/i,
    'an id-less insert was accepted — SQLite minted a server id out of the rowid'
  );

  const all = await gs.GameStateModel.findAll();
  assert.deepEqual(all.map((r) => r.id), [1], 'a phantom row survived the refusal');
});

test('TeamBalancerState refuses a create with no id', async () => {
  const db = await dbFor(sharedStorage(), 1);
  await bootTeamBalancer(db);
  const model = db.getModel('TeamBalancerState');

  // This model used to carry `defaultValue: 1`, which turned an id-less create
  // into a write onto server 1's win streak rather than an error.
  await assert.rejects(
    () => model.create({ winStreakTeam: 1, winStreakCount: 9 }),
    /cannot be null/i,
    'an id-less insert was accepted — it would have landed on whichever server that integer names'
  );
});

// ---------------------------------------------------------------------------
// The four boot orders
// ---------------------------------------------------------------------------

/**
 * Boot the incumbent and a brand-new server 2 against one legacy database, in
 * the given order, and assert that nothing either of them did cost the
 * incumbent anything.
 */
async function bootOrder({ incumbentID, incumbentFirst }) {
  const storage = await legacyDatabase();

  const boot = async (serverID) => {
    const db = await dbFor(storage, serverID);
    const gs = await bootGameState(db);
    const tb = await bootTeamBalancer(db);
    const state = await tb.initDB();
    return { db, gs, tb, state };
  };

  const incumbent = incumbentFirst ? await boot(incumbentID) : null;
  const newcomer = await boot(2);
  const late = incumbentFirst ? null : await boot(incumbentID);
  const inc = incumbent || late;

  // The newcomer is a new server. Whatever it found, it must have started from
  // nothing rather than from somebody else's round.
  assert.notEqual(newcomer.gs.matchId, LEGACY.matchId,
    'server 2 recovered the legacy round as its own');
  assert.equal(newcomer.state.winStreakCount, 0,
    'server 2 inherited the legacy win streak');

  if (incumbentID === 1) {
    // The declaration settles it: the legacy row IS this server's row.
    assert.equal(inc.gs.matchId, LEGACY.matchId,
      'the incumbent declaring 1 did not recover its own round state');
    assert.equal(inc.state.winStreakCount, LEGACY.winStreakCount,
      'the incumbent declaring 1 did not recover its own win streak');
  } else {
    // Declaration cannot settle this one, so nothing may act on it. The state
    // stays exactly where it is, intact, until an operator adopts it.
    const gsRow = await rawRow(storage, 'S3_GameState', 1);
    const tbRow = await rawRow(storage, 'TeamBalancerState', 1);
    assert.equal(gsRow?.matchId, LEGACY.matchId, 'the legacy round state was overwritten');
    assert.equal(gsRow?.phase, LEGACY.phase, 'the legacy round state was overwritten');
    assert.equal(tbRow?.winStreakCount, LEGACY.winStreakCount, 'the legacy win streak was overwritten');
  }

  // And in every order, the row numbered 1 belongs to whoever declared 1 — no
  // process may have renumbered it onto itself.
  const survivors = await inc.db.getModel('TeamBalancerState').findAll({ order: [['id', 'ASC']] });
  const ids = survivors.map((r) => r.id).sort((a, b) => a - b);
  const expected = incumbentID === 1 ? [1, 2] : [1, 2, incumbentID].sort((a, b) => a - b);
  assert.deepEqual(ids, expected, `TeamBalancerState holds ${ids.join(',')} — expected ${expected.join(',')}`);
}

for (const incumbentID of [1, 3]) {
  for (const incumbentFirst of [true, false]) {
    test(
      `boot order: incumbent declares ${incumbentID}, ${incumbentFirst ? 'boots first' : 'boots second'}`,
      () => bootOrder({ incumbentID, incumbentFirst })
    );
  }
}

test('a server declaring 4 against a legacy database leaves row 1 alone', async () => {
  const storage = await legacyDatabase();
  const before = await rawRow(storage, 'S3_GameState', 1);

  const db = await dbFor(storage, 4);
  const gs = await bootGameState(db);
  const tb = await bootTeamBalancer(db);
  const state = await tb.initDB();

  const after = await rawRow(storage, 'S3_GameState', 1);
  assert.deepEqual(after, before, 'booting as server 4 rewrote the legacy row');

  const tbRow = await rawRow(storage, 'TeamBalancerState', 1);
  assert.equal(tbRow?.winStreakCount, LEGACY.winStreakCount, 'booting as server 4 rewrote the legacy win streak');

  // Leaving the row alone on disk is only half of it. A process that reads
  // the legacy row instead of its own writes nothing and still adopts the
  // round — findByPk(1) finds a row, so no fresh one is ever persisted and
  // the bytes on disk are unchanged. Without these two the whole case passes
  // against a build that has silently taken over server 1’s state.
  assert.notEqual(gs.matchId, LEGACY.matchId, 'server 4 read the legacy round as its own');
  assert.equal(state.winStreakCount, 0, 'server 4 read the legacy win streak as its own');
  assert.ok(await rawRow(storage, 'S3_GameState', 4), 'server 4 never wrote a row of its own');
  assert.ok(await rawRow(storage, 'TeamBalancerState', 4), 'server 4 never wrote a win-streak row of its own');
});

// ---------------------------------------------------------------------------
// Adoption
// ---------------------------------------------------------------------------

async function runMigrateCommand(db, gs, argv) {
  const captured = [];
  const { handlers } = cmds.createCommandHandlers({
    sendDiscordMessage: async (_channel, payload) => { captured.push(payload); },
    watchManager: null,
    stagedImportRef: { current: null }
  });

  const message = {
    channel: { id: 'c1', send: async (p) => { captured.push(p); return { id: 'x' }; } },
    author: { id: 'u1' },
    reply: async (p) => { captured.push(p); return { id: 'x' }; },
    attachments: { first: () => null }
  };

  const plugin = {
    services: { db, gameState: gs },
    options: {},
    verbose: () => {},
    localize: (key, vars) => lookupMessage(key, vars)
  };

  await handlers.get(argv[0])(plugin, message, argv);

  const embeds = captured.map((p) => p?.embeds?.[0]).filter(Boolean);
  return {
    embeds,
    title: embeds.map((e) => e.title || '').join(' '),
    body: embeds.map((e) => e.description || '').join('\n')
  };
}

test('adopt-state without --confirm names both tables and the target id, and writes nothing', async () => {
  const storage = await legacyDatabase();
  const db = await dbFor(storage, 3);
  const gs = await bootGameState(db);
  await bootTeamBalancer(db);

  const before = await rawRow(storage, 'S3_GameState', 1);
  const { title, body } = await runMigrateCommand(db, gs, ['migrate', 'adopt-state']);

  assert.match(title, /Adoptable/i, `expected the preview, got: ${title}`);
  assert.match(body, /S3_GameState/, 'the preview did not name S3_GameState');
  assert.match(body, /TeamBalancerState/, 'the preview did not name TeamBalancerState');
  assert.match(body, /id = 3/, 'the preview did not name the target serverID');
  // The row it would replace has to be on screen, because that is what the
  // admin is being asked to agree to losing.
  assert.match(body, /replacing/i, 'the preview did not show the row it would replace');

  assert.deepEqual(await rawRow(storage, 'S3_GameState', 1), before, 'the preview wrote to the database');
});

test('adopt-state --confirm moves both singletons onto the declared id', async () => {
  const storage = await legacyDatabase();
  const db = await dbFor(storage, 3);
  const gs = await bootGameState(db);
  const tb = await bootTeamBalancer(db);
  await tb.initDB();

  const { title } = await runMigrateCommand(db, gs, ['migrate', 'adopt-state', '--confirm']);
  assert.match(title, /Adoption Complete/i, `expected a completion, got: ${title}`);

  assert.equal(await rawRow(storage, 'S3_GameState', 1), null, 'the legacy game-state row was left behind');
  assert.equal(await rawRow(storage, 'TeamBalancerState', 1), null, 'the legacy win-streak row was left behind');

  const adopted = await rawRow(storage, 'S3_GameState', 3);
  assert.equal(adopted?.matchId, LEGACY.matchId, 'the adopted row is not the legacy round state');

  const streak = await rawRow(storage, 'TeamBalancerState', 3);
  assert.equal(streak?.winStreakCount, LEGACY.winStreakCount, 'the adopted row is not the legacy win streak');

  // The running service has to see it too, or the next phase change writes the
  // pre-adoption state straight back over the row that was just adopted.
  assert.equal(gs.matchId, LEGACY.matchId, 'the running GameStateService did not re-read the adopted row');
});

test('adopt-state on a server declaring 1 says there is nothing to adopt', async () => {
  const storage = await legacyDatabase();
  const db = await dbFor(storage, 1);
  const gs = await bootGameState(db);
  await bootTeamBalancer(db);

  const before = await rawRow(storage, 'S3_GameState', 1);
  const { title, body } = await runMigrateCommand(db, gs, ['migrate', 'adopt-state', '--confirm']);

  assert.match(title, /Nothing to Adopt/i, `expected a refusal, got: ${title}`);
  assert.match(body, /serverID: 1/, 'the refusal did not say why');
  assert.deepEqual(await rawRow(storage, 'S3_GameState', 1), before, 'a no-op adoption wrote to the database');
});

test('adopt-state reports nothing to adopt when there is no legacy row', async () => {
  const storage = sharedStorage();
  const db = await dbFor(storage, 3);
  const gs = await bootGameState(db);
  const tb = await bootTeamBalancer(db);
  await tb.initDB();

  const { title } = await runMigrateCommand(db, gs, ['migrate', 'adopt-state']);
  assert.match(title, /Nothing to Adopt/i, `expected a refusal, got: ${title}`);
});

test('a bracketed --confirm is refused rather than treated as a preview', async () => {
  const storage = await legacyDatabase();
  const db = await dbFor(storage, 3);
  const gs = await bootGameState(db);
  await bootTeamBalancer(db);

  const { title } = await runMigrateCommand(db, gs, ['migrate', 'adopt-state', '[--confirm]']);
  assert.match(title, /Unrecognised Argument/i, `expected a refusal, got: ${title}`);
});

await run();
