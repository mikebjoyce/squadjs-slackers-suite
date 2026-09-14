/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   TWO-PROCESS ISOLATION — TWO NODE PROCESSES, ONE MySQL DB    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────
 *
 * Every other multi-server suite here runs its "two servers" as two objects
 * inside one Node process. That is enough for the scoping rules, and it is
 * structurally blind to the two things that actually broke: a lock that was a
 * per-process mutex, and a claim that raced on a connection the two service
 * objects shared. A test built that way passes against a database with no
 * cross-process coordination at all.
 *
 * So these cases fork real `node` processes against one real MySQL database.
 * The only channel between them is the database, which is the only channel two
 * SquadJS instances have.
 *
 * MySQL rather than SQLite, deliberately. `test-multi-process-locking.js`
 * already covers the lock on SQLite, which is where it was broken and which
 * needs no Docker. What SQLite cannot cover is the engine the deployment
 * actually runs: reserved-word quoting, camelCase identifiers, a real client/
 * server round trip per statement, and a rejected id-less insert are all
 * MySQL-only behaviours, and the first three are exactly what a second process
 * exercises hardest.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   round state       Each process reads back its own S3_GameState row, and
 *                     neither write disturbs the other's.
 *   match ids         Two rounds starting in the same clock second get
 *                     different ids, because the id carries the server.
 *   reconnect memory  Written on A, invisible on B. Restoring server A's team
 *                     on server B is worse than restoring nothing.
 *   token balances    Community-wide on purpose: spent on A, seen on B.
 *   lockdowns         Per-server on purpose: set on A, absent on B, and the
 *                     same eosID holds a row under both.
 *   settings          Two servers' explainMessageIds coexist; neither write
 *                     lands on the other's row.
 *   win streaks       TeamBalancerState is keyed BY the server, so this is the
 *                     case an attribute check gets backwards.
 *   scoped export     B's export carries B's rows and the community-wide ones,
 *                     and none of A's.
 *   migration race    Two processes migrating at once: one runs, one waits and
 *                     comes up clean having applied nothing.
 *   lock handoff      A lock released by A is acquirable by B immediately, not
 *                     after a TTL. A leaked lock looks like success until
 *                     something has to take it again.
 *   claim race        Two processes, one Discord message: exactly one 'won'
 *                     and exactly one 'lost'.
 *   reaper safety     Reaping an expired claim must not remove a migration
 *                     lock that another process is still holding.
 *   connector name    A connector named for the community rather than for its
 *                     dialect still takes a real lock.
 *   version lockstep  A process whose suite version differs from a live
 *                     sibling refuses, and stops refusing once that sibling's
 *                     row goes stale.
 *
 * ─── WHAT IS NOT COVERED ─────────────────────────────────────────
 *
 * Two live games. Both processes here are driven by the test rather than by a
 * Squad server, so gameplay divergence is out of reach until two Squad servers
 * exist. Say so in any report that cites this file.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-two-process-isolation.js
 *
 *   docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -p 3307:3306 mysql:8
 *
 * The whole file skips when MySQL is unreachable. It creates its own database
 * and drops it afterwards, so it never shares a namespace with another suite.
 *
 * Category: 4 (requires Docker for MySQL — every case skips when it is unreachable)
 */

'use strict';

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Sequelize } from 'sequelize';

import { buildAssembly, cleanAssembly } from './plugin-assembly.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Connection — ports match test-dialect-portability.js
// ---------------------------------------------------------------------------

const MYSQL_HOST = process.env.S3_TEST_MYSQL_HOST || '127.0.0.1';
const MYSQL_PORT = parseInt(process.env.S3_TEST_MYSQL_PORT || '3307', 10);
const MYSQL_USER = process.env.S3_TEST_MYSQL_ROOT_USER || 'root';
const MYSQL_PASS = process.env.S3_TEST_MYSQL_ROOT_PASSWORD || 'root';

/** One database per run, so a crashed run never poisons the next one. */
const RUN_DB = `s3_twoproc_${process.pid}_${Date.now() % 100000}`;

function mysqlOptions(database) {
  return {
    dialect: 'mysql',
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    username: MYSQL_USER,
    password: MYSQL_PASS,
    database,
    logging: false,
    define: { freezeTableName: true },
    dialectOptions: { connectTimeout: 4000 }
  };
}

let reachable = false;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  console.log('='.repeat(70));
  console.log('Two-Process Isolation  (real child processes, one MySQL database)');
  console.log('='.repeat(70));
  console.log('');

  for (const t of tests) {
    if (!reachable) {
      console.log(`  ⏭ ${t.name}  (MySQL unreachable)`);
      skipped++;
      continue;
    }
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

  console.log('');
  console.log('─'.repeat(70));
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped, ${tests.length} total`);
  console.log('─'.repeat(70));

  if (failed > 0) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// The child process
// ---------------------------------------------------------------------------

/**
 * One generic child, driven by a JSON list of operations.
 *
 * A child per case would be a dozen near-identical scripts, and the thing they
 * would differ in — which service writes what — is exactly what the cases are
 * about. So the child is a small interpreter and each case is data.
 *
 * Generated into the repo rather than the OS temp directory: it imports
 * `sequelize` by bare specifier, and Node resolves that by walking up from the
 * importing file. From a temp directory that walk reaches the drive root and
 * finds nothing. `.tmp-*` is not gitignored, so the `finally` that removes it
 * is not optional.
 */
const CHILD_SOURCE = `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Sequelize } from 'sequelize';

import DBService, { LOCK_KINDS } from '../s3/utils/db-service.js';
import MigrationEngine from '../s3/utils/migration-engine.js';
import GameStateService from '../s3/utils/game-state-service.js';
import PlayersService from '../s3/utils/players-service.js';
import SwitchDB from '../switch/utils/switch-db.js';
import EloDatabase from '../elo-tracker/utils/elo-database.js';
import { exportToJSON } from '../s3/utils/s3-export-import.js';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (phase) => {
  if (!config.markerPath) return;
  fs.appendFileSync(config.markerPath, JSON.stringify({ tag: config.tag, phase, t: Date.now() }) + '\\n');
};

const seq = new Sequelize(config.db);

const dbOptions = {
  verboseLogger: () => {},
  serverID: config.serverID,
  defaultRetry: { attempts: 3, baseDelayMs: 20, jitterMs: 0 }
};
// A connector named for the community rather than for its dialect goes in
// through the connectors map, which is the shape SquadJS hands S3 in
// production. Everything else takes the plain sequelize instance.
if (config.connectorName) {
  dbOptions.connectors = {};
  dbOptions.connectors[config.connectorName] = seq;
  dbOptions.databaseOption = config.connectorName;
} else {
  dbOptions.sequelize = seq;
}

const db = new DBService(dbOptions);
await db.mount();
db._migrationEngine = new MigrationEngine({
  dbService: db,
  verboseLogger: () => {},
  backupDir: config.backupDir
});

// ── Lazily built collaborators ──────────────────────────────────────
// Each is the shipped implementation, driven exactly as far as the call
// under test. Restating a model here would prove nothing about the one
// the plugin actually registers.

let _gameState = null;
async function gameState() {
  if (_gameState) return _gameState;
  const parent = { db, serverID: config.serverID, services: { db } };
  const gs = new GameStateService({ parent, server: { on: () => {}, off: () => {} } });
  await gs._initPersistence();
  _gameState = gs;
  return gs;
}

let _players = null;
async function playersService() {
  if (_players) return _players;
  const parent = { db, serverID: config.serverID, services: { db } };
  const svc = new PlayersService({
    parent,
    server: { on: () => {}, off: () => {}, removeListener: () => {} }
  });
  await svc._initReconnectPersistence();
  _players = svc;
  return svc;
}

let _switchReady = false;
async function switchSchema() {
  if (_switchReady) return true;
  await SwitchDB.register({
    _s3db: db,
    s3db: db,
    verbose: () => {},
    defineModel: (n, s, o) => db.defineModel(n, s, o),
    registerExpectedVersion: (n, v, o) => db.registerExpectedVersion(n, v, o),
    registerMigrations: (n, m) => db.migrationEngine.registerMigrations(n, m),
    verifyAndRunMigrations: async () => null,
    _getModel: (n) => db.getModel(n),
    _withDb: async (fn) => fn(),
    reportError: () => {}
  });
  db.migrationEngine.confirmToken('__force__');
  await db.migrationEngine.runMigrations('switch');
  _switchReady = true;
  return true;
}

let _tbState = null;
async function teamBalancerState() {
  if (_tbState) return _tbState;
  const target = config.assemblyDir + '/plugins/team-balancer.js';
  const mod = await import(pathToFileURL(target).href);
  const TeamBalancer = mod.default;

  const spec = TeamBalancer.optionsSpecification || {};
  const options = {};
  for (const key of Object.keys(spec)) options[key] = spec[key] && spec[key].default;

  const STOP = Symbol('stop');
  const plugin = Object.create(TeamBalancer.prototype);
  Object.assign(plugin, {
    _s3db: db,
    _s3: { isReady: () => true, db },
    options,
    server: { on: () => {}, off: () => {}, removeListener: () => {}, plugins: [] },
    _isMounted: false,
    ready: false,
    verbose: () => {},
    reportError: () => {},
    _checkS3Version: () => {},
    validateOptions: () => {},
    verifyAndRunMigrations: async () => { throw STOP; }
  });
  try {
    await TeamBalancer.prototype._onS3Ready.call(plugin);
  } catch (err) { /* everything past registration is out of scope */ }

  const model = db.getModel('TeamBalancerState');
  if (!model) throw new Error('TeamBalancer registered no TeamBalancerState model');
  await model.sync();
  _tbState = model;
  return model;
}

let _elo = null;
async function eloDatabase() {
  if (_elo) return _elo;
  const target = config.assemblyDir + '/plugins/elo-tracker.js';
  const mod = await import(pathToFileURL(target).href);
  const EloTracker = mod.default;

  const spec = EloTracker.optionsSpecification || {};
  const options = {};
  for (const key of Object.keys(spec)) options[key] = spec[key] && spec[key].default;

  const eloDb = new EloDatabase({}, options, db);
  eloDb.verbose = () => {};
  eloDb.reportError = () => {};

  const STOP = Symbol('stop');
  const plugin = Object.create(EloTracker.prototype);
  Object.assign(plugin, {
    _s3db: db,
    _s3: { isReady: () => true, db },
    db: eloDb,
    options,
    server: { on: () => {}, off: () => {}, removeListener: () => {}, plugins: [] },
    _isMounted: false,
    ready: false,
    verbose: () => {},
    reportError: () => {},
    _checkS3Version: () => {},
    defineModel: (n, sch, o) => db.defineModel(n, sch, o),
    registerExpectedVersion: (n, v, o) => db.registerExpectedVersion(n, v, o),
    registerMigrations: (n, m) => db.migrationEngine.registerMigrations(n, m),
    recordCommunityOptions: async () => true,
    verifyAndRunMigrations: async () => { throw STOP; }
  });
  try {
    await EloTracker.prototype._onS3Ready.call(plugin);
  } catch (err) { /* everything past migration registration is out of scope */ }

  db.migrationEngine.confirmToken('__force__');
  await db.migrationEngine.runMigrations('elo-tracker');

  if (!db.getModel('Elo_PlayerStats')) throw new Error('EloTracker registered no Elo_PlayerStats model');
  _elo = eloDb;
  return eloDb;
}

// ── Operations ──────────────────────────────────────────────────────

async function perform(step) {
  const op = step.op;

  if (op === 'sleep') { await sleep(step.ms); return { slept: step.ms }; }

  if (op === 'prepare') {
    // Every table this file touches, created once before any race starts.
    // Two processes bootstrapping the schema is a different race from the one
    // under test, and losing it reads as a failure of the thing under test.
    await gameState();
    await playersService();
    await switchSchema();
    await teamBalancerState();
    await eloDatabase();
    return { prepared: true };
  }

  if (op === 'gamestate.write') {
    const gs = await gameState();
    gs.phase = step.phase;
    gs.roundStartTime = step.roundStartTime;
    gs.layerNameCached = step.layer || null;
    gs.matchId = gs._mintMatchId();
    await gs._persistState();
    return { matchId: gs.matchId, id: gs._stateRowID() };
  }

  if (op === 'gamestate.read') {
    const gs = await gameState();
    await gs._recoverPersistedState();
    return {
      phase: gs.phase,
      matchId: gs.matchId,
      roundStartTime: gs.roundStartTime,
      layer: gs.layerNameCached || null,
      id: gs._stateRowID()
    };
  }

  if (op === 'gamestate.rows') {
    const gs = await gameState();
    const rows = await gs.GameStateModel.findAll({ raw: true });
    return { rows: rows.map((r) => ({ id: r.id, phase: r.phase, matchId: r.matchId })) };
  }

  if (op === 'reconnect.write') {
    const svc = await playersService();
    const ok = await svc.rememberReconnect(step.eosID, {
      playerName: step.playerName || null,
      lastTeamID: step.lastTeamID,
      lastSeenAt: Date.now()
    });
    return { ok };
  }

  if (op === 'reconnect.read') {
    const svc = await playersService();
    svc._reconnectMemory.clear();
    const row = await svc.getReconnect(step.eosID);
    return { row: row ? { eosID: row.eosID, lastTeamID: row.lastTeamID } : null };
  }

  if (op === 'token.set') {
    await switchSchema();
    const model = db.getModel('SwitchPlugin_PlayerCooldowns');
    await model.upsert({
      eosID: step.eosID,
      playerName: step.playerName || 'Tester',
      tokenBalance: step.balance,
      lastActiveTimestamp: new Date()
    });
    return { set: step.balance };
  }

  if (op === 'token.read') {
    await switchSchema();
    const model = db.getModel('SwitchPlugin_PlayerCooldowns');
    const row = await model.findByPk(step.eosID, { raw: true });
    return { balance: row ? row.tokenBalance : null };
  }

  if (op === 'lockdown.set') {
    await switchSchema();
    const model = db.getModel('SwitchPlugin_PlayerServerState');
    await model.upsert({
      serverID: db.getServerID(),
      eosID: step.eosID,
      scrambleLockdownExpiry: new Date(Date.now() + (step.minutes || 20) * 60000),
      lastActiveTimestamp: new Date()
    });
    return { serverID: db.getServerID() };
  }

  if (op === 'lockdown.read') {
    await switchSchema();
    const model = db.getModel('SwitchPlugin_PlayerServerState');
    const scope = db.scopePredicateFor('SwitchPlugin_PlayerServerState');
    const where = { eosID: step.eosID };
    if (scope) where[scope.column] = scope.value;
    const row = await model.findOne({ where, raw: true });
    const all = await model.findAll({ raw: true });
    return {
      mine: row ? { serverID: row.serverID, expiry: row.scrambleLockdownExpiry } : null,
      allServerIDs: all.map((r) => r.serverID).sort()
    };
  }

  if (op === 'setting.set') {
    await switchSchema();
    const model = db.getModel('SwitchPlugin_Settings');
    await model.upsert({ serverID: db.getServerID(), key: step.key, value: step.value });
    return { serverID: db.getServerID() };
  }

  if (op === 'setting.read') {
    await switchSchema();
    const model = db.getModel('SwitchPlugin_Settings');
    const row = await model.findOne({
      where: { serverID: db.getServerID(), key: step.key },
      raw: true
    });
    return { value: row ? row.value : null };
  }

  if (op === 'streak.set') {
    const model = await teamBalancerState();
    await model.upsert({
      id: db.getServerID(),
      winStreakTeam: step.team,
      winStreakCount: step.count
    });
    return { id: db.getServerID() };
  }

  if (op === 'streak.read') {
    const model = await teamBalancerState();
    const row = await model.findByPk(db.getServerID(), { raw: true });
    const all = await model.findAll({ raw: true });
    return {
      mine: row ? { team: row.winStreakTeam, count: row.winStreakCount } : null,
      ids: all.map((r) => r.id).sort()
    };
  }

  if (op === 'elo.seed') {
    await eloDatabase();
    const model = db.getModel('Elo_PlayerStats');
    await model.upsert({
      eosID: step.eosID,
      name: 'Concurrent Tester',
      mu: 25,
      sigma: 8.333,
      wins: 0,
      losses: 0,
      roundsPlayed: 0,
      lastSeen: Date.now()
    });
    return { seeded: true };
  }

  if (op === 'elo.rounds') {
    const eloDb = await eloDatabase();
    if (step.atMs) {
      const wait = step.atMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    let applied = 0;
    let failed = 0;
    for (let i = 0; i < step.count; i++) {
      const result = await eloDb.bulkIncrementPlayerStats([{
        eosID: step.eosID,
        name: 'Concurrent Tester',
        mu: step.mu,
        sigma: 8,
        wins: 1,
        losses: 0,
        roundsPlayed: 1,
        lastSeen: Date.now()
      }]);
      if (result === null) failed++; else applied++;
    }
    return { applied, failed };
  }

  if (op === 'elo.read') {
    await eloDatabase();
    const row = await db.getModel('Elo_PlayerStats').findByPk(step.eosID, { raw: true });
    return { row: row ? { mu: row.mu, wins: row.wins, roundsPlayed: row.roundsPlayed } : null };
  }

  if (op === 'export') {
    await gameState();
    await playersService();
    await switchSchema();
    await teamBalancerState();
    const envelope = await exportToJSON(db, { tier: 'all', allServers: false });
    const tables = {};
    for (const name of Object.keys(envelope.tables || {})) {
      tables[name] = envelope.tables[name];
    }
    return {
      scope: envelope.scope,
      serverID: envelope.serverID,
      containedServerIDs: envelope.containedServerIDs,
      rowCounts: envelope.rowCounts,
      gameStateIDs: (tables.S3GameState || []).map((r) => r.id).sort(),
      streakIDs: (tables.TeamBalancerState || []).map((r) => r.id).sort(),
      settingServerIDs: (tables.SwitchPlugin_Settings || []).map((r) => r.serverID).sort(),
      cooldownIDs: (tables.SwitchPlugin_PlayerCooldowns || []).map((r) => r.eosID).sort()
    };
  }

  if (op === 'lock.acquire') {
    const got = await db.acquireAdvisoryLock(step.key, { kind: LOCK_KINDS.MIGRATION });
    mark(got ? 'acquired' : 'refused');
    return { acquired: got };
  }

  if (op === 'lock.release') {
    await db.releaseAdvisoryLock(step.key);
    return { released: true };
  }

  if (op === 'lock.hold') {
    const got = await db.acquireAdvisoryLock(step.key, { kind: LOCK_KINDS.MIGRATION });
    mark(got ? 'holding' : 'refused');
    await sleep(step.ms);
    if (step.release !== false) await db.releaseAdvisoryLock(step.key);
    return { acquired: got };
  }

  if (op === 'lock.status') {
    const status = await db.isMigrationLockHeld(step.key || null);
    return { status };
  }

  if (op === 'claim') {
    if (step.atMs) {
      // Both children wait for the same wall-clock instant, so the race is a
      // race rather than whichever process finished booting first.
      const wait = step.atMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const result = await db.claimDiscordMessage(step.key, step.ttlMs ? { ttlMs: step.ttlMs } : {});
    mark(result.outcome);
    return result;
  }

  if (op === 'reap') {
    const removed = await db.reapExpiredLocks();
    return { removed };
  }

  if (op === 'locks.list') {
    const rows = await db.LocksModel.findAll({ raw: true });
    return { rows: rows.map((r) => ({ lockKey: r.lockKey, kind: r.kind, owner: r.owner })) };
  }

  if (op === 'register') {
    const result = await db.registerServer({
      server: { serverName: step.serverName || null },
      suiteVersion: step.suiteVersion || null,
      force: step.force === true
    });
    return { status: result.status, serverID: result.serverID };
  }

  if (op === 'lockstep') {
    const verdict = await db.checkVersionLockstep(step.suiteVersion);
    return {
      ok: verdict.ok,
      checked: verdict.checked,
      mismatches: verdict.mismatches.map((m) => ({ serverID: m.serverID, suiteVersion: m.suiteVersion }))
    };
  }

  if (op === 'migrate') {
    // A migration whose body is slow enough that a second process is certain
    // to arrive while it is running. The marker file is the only evidence
    // that survives the process: append-only, one line per event, so two
    // writers interleave without either losing a record.
    db.migrationEngine.registerMigrations(step.group, [
      {
        version: 1,
        description: 'Create a table, slowly',
        backup: false,
        touches: { creates: [step.table], columns: {} },
        up: async (qi) => {
          mark('enter');
          await sleep(step.holdMs || 0);
          await qi.createTable(step.table, {
            id: { type: db.getDataTypes().INTEGER, primaryKey: true, autoIncrement: true },
            note: { type: db.getDataTypes().STRING, allowNull: true }
          });
          mark('leave');
        }
      }
    ]);
    db.registerExpectedVersion(step.group, 1);
    db.migrationEngine.confirmToken('__auto__');
    const result = await db.migrationEngine.runMigrations(step.group);
    return { applied: result.applied, skipped: result.skipped };
  }

  throw new Error('unknown op: ' + op);
}

const out = { tag: config.tag, results: [], ok: false };

try {
  for (const step of config.ops) {
    out.results.push(await perform(step));
  }
  out.ok = true;
} catch (err) {
  out.error = err.message;
  out.stack = err.stack;
} finally {
  try { await db.unmount(); } catch (e) { /* best effort */ }
  try { await seq.close(); } catch (e) { /* best effort */ }
}

process.stdout.write('__RESULT__' + JSON.stringify(out));
`;

// ---------------------------------------------------------------------------
// Child plumbing
// ---------------------------------------------------------------------------

const CHILD_DIR = path.join(REPO_ROOT, '.tmp-twoproc');
const ASSEMBLY_DIR = path.join(REPO_ROOT, '.tmp-twoproc-asm');
const CHILD_PATH = path.join(CHILD_DIR, 'two-proc-child.js');

let workspace = null;

function setup() {
  fs.rmSync(CHILD_DIR, { recursive: true, force: true });
  fs.mkdirSync(CHILD_DIR, { recursive: true });
  fs.writeFileSync(CHILD_PATH, CHILD_SOURCE);
  buildAssembly('.tmp-twoproc-asm');
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 's3-twoproc-'));
}

function teardown() {
  fs.rmSync(CHILD_DIR, { recursive: true, force: true });
  cleanAssembly(ASSEMBLY_DIR);
  if (workspace) {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

let configSeq = 0;

/**
 * Run one child to completion and return the object it printed.
 *
 * Throws with the child's own error and stack when it reported one, because a
 * child failing inside an op is a test failure and the message is the whole
 * diagnosis.
 */
async function runChild({ tag, serverID, ops, markerPath = null, connectorName = null }) {
  const configPath = path.join(workspace, `cfg-${configSeq++}.json`);
  fs.writeFileSync(configPath, JSON.stringify({
    tag,
    serverID,
    ops,
    markerPath,
    connectorName,
    assemblyDir: ASSEMBLY_DIR.split(path.sep).join('/'),
    backupDir: workspace,
    db: mysqlOptions(RUN_DB)
  }));

  const { stdout, stderr } = await execFileAsync(process.execPath, [CHILD_PATH, configPath], {
    cwd: REPO_ROOT,
    maxBuffer: 32 * 1024 * 1024
  });
  const marker = stdout.lastIndexOf('__RESULT__');
  if (marker < 0) {
    throw new Error(`child "${tag}" produced no result\n  stdout: ${stdout}\n  stderr: ${stderr}`);
  }
  const result = JSON.parse(stdout.slice(marker + '__RESULT__'.length));
  if (!result.ok) {
    throw new Error(`child "${tag}" failed: ${result.error}\n${result.stack || ''}`);
  }
  return result.results;
}

/** Two children started together, so their operations genuinely overlap. */
function runBoth(a, b) {
  return Promise.all([runChild(a), runChild(b)]);
}

function markers(markerPath) {
  if (!fs.existsSync(markerPath)) return [];
  return fs.readFileSync(markerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function markerPath(name) {
  return path.join(workspace, `${name}.jsonl`);
}

/** A direct connection for the assertions a child should not be trusted with. */
async function withParentDb(fn) {
  const seq = new Sequelize(mysqlOptions(RUN_DB));
  try {
    return await fn(seq);
  } finally {
    try { await seq.close(); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Fixture: one database, one prepared schema
// ---------------------------------------------------------------------------

async function createDatabase() {
  const admin = new Sequelize(mysqlOptions('mysql'));
  try {
    await admin.authenticate();
    await admin.query(`CREATE DATABASE \`${RUN_DB}\``);
    reachable = true;
  } catch (err) {
    console.log(`  ⚠ MySQL not reachable on ${MYSQL_HOST}:${MYSQL_PORT} — every case will skip`);
    console.log(`    (${err.message})`);
    reachable = false;
  } finally {
    try { await admin.close(); } catch { /* best effort */ }
  }
}

async function dropDatabase() {
  if (!reachable) return;
  const admin = new Sequelize(mysqlOptions('mysql'));
  try {
    await admin.query(`DROP DATABASE IF EXISTS \`${RUN_DB}\``);
  } catch { /* best effort */ } finally {
    try { await admin.close(); } catch { /* best effort */ }
  }
}

const A = 1;
const B = 2;

// ═══════════════════════════════════════════════════════════════════════════
// 1. Round state
// ═══════════════════════════════════════════════════════════════════════════

test('S3_GameState: each process reads back its own row, and neither disturbs the other', async () => {
  const started = 1757000000000;

  await runBoth(
    { tag: 'A', serverID: A, ops: [{ op: 'gamestate.write', phase: 'LIVE', roundStartTime: started, layer: 'Gorodok_RAAS_v1' }] },
    { tag: 'B', serverID: B, ops: [{ op: 'gamestate.write', phase: 'STAGING', roundStartTime: started + 90000, layer: 'Mutaha_RAAS_v3' }] }
  );

  const [aRead] = await runChild({ tag: 'A2', serverID: A, ops: [{ op: 'gamestate.read' }] });
  const [bRead] = await runChild({ tag: 'B2', serverID: B, ops: [{ op: 'gamestate.read' }] });

  assert.equal(aRead.id, A, 'A read the wrong row id');
  assert.equal(bRead.id, B, 'B read the wrong row id');
  assert.equal(aRead.phase, 'LIVE', `A should read its own phase, got ${aRead.phase}`);
  assert.equal(bRead.phase, 'STAGING', `B should read its own phase, got ${bRead.phase}`);
  assert.equal(aRead.roundStartTime, started, 'A lost its round start time to B');
  assert.equal(bRead.roundStartTime, started + 90000, 'B lost its round start time to A');
  assert.notEqual(aRead.matchId, bRead.matchId, 'both servers ended up on one matchId');
});

test('matchId: two rounds starting in the same second are still different', async () => {
  // The same millisecond, deliberately. This is the case a timestamp-derived
  // id gets wrong, and on a shared Elo table it merges two servers' rounds.
  const same = 1757000123456;
  const [[aWrite], [bWrite]] = await runBoth(
    { tag: 'A', serverID: A, ops: [{ op: 'gamestate.write', phase: 'LIVE', roundStartTime: same, layer: 'Gorodok_RAAS_v1' }] },
    { tag: 'B', serverID: B, ops: [{ op: 'gamestate.write', phase: 'LIVE', roundStartTime: same, layer: 'Gorodok_RAAS_v1' }] }
  );

  assert.ok(aWrite.matchId, 'A minted no matchId');
  assert.ok(bWrite.matchId, 'B minted no matchId');
  assert.notEqual(
    aWrite.matchId, bWrite.matchId,
    `both servers minted ${aWrite.matchId} for rounds starting in the same millisecond`
  );
});

test('S3_GameState holds one row per server, not one row', async () => {
  const [rows] = await runChild({ tag: 'A', serverID: A, ops: [{ op: 'gamestate.rows' }] });
  const ids = rows.rows.map((r) => r.id).sort();
  assert.deepEqual(ids, [A, B], `expected a row for each server, got ${JSON.stringify(ids)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Per-server memory
// ═══════════════════════════════════════════════════════════════════════════

test('reconnect memory written on A does not route a player on B', async () => {
  const eosID = 'eos-reconnect-1';

  await runChild({ tag: 'A', serverID: A, ops: [{ op: 'reconnect.write', eosID, lastTeamID: 1, playerName: 'Alpha' }] });

  const [beforeB] = await runChild({ tag: 'B', serverID: B, ops: [{ op: 'reconnect.read', eosID }] });
  assert.equal(beforeB.row, null, 'B saw A\'s reconnect row — restoring the wrong server\'s team');

  await runChild({ tag: 'B', serverID: B, ops: [{ op: 'reconnect.write', eosID, lastTeamID: 2, playerName: 'Alpha' }] });

  const [afterA] = await runChild({ tag: 'A', serverID: A, ops: [{ op: 'reconnect.read', eosID }] });
  const [afterB] = await runChild({ tag: 'B', serverID: B, ops: [{ op: 'reconnect.read', eosID }] });
  assert.equal(afterA.row?.lastTeamID, 1, 'A\'s reconnect row was overwritten by B\'s');
  assert.equal(afterB.row?.lastTeamID, 2, 'B did not read back its own reconnect row');
});

test('a scramble lockdown set on A leaves B unlocked, and both hold a row for the same player', async () => {
  const eosID = 'eos-lockdown-1';

  await runChild({ tag: 'A', serverID: A, ops: [{ op: 'lockdown.set', eosID, minutes: 20 }] });

  const [bBefore] = await runChild({ tag: 'B', serverID: B, ops: [{ op: 'lockdown.read', eosID }] });
  assert.equal(bBefore.mine, null, 'a scramble on A locked the player down on B');
  assert.deepEqual(bBefore.allServerIDs, [A], 'expected exactly A\'s row to exist at this point');

  await runChild({ tag: 'B', serverID: B, ops: [{ op: 'lockdown.set', eosID, minutes: 20 }] });

  const [aAfter] = await runChild({ tag: 'A', serverID: A, ops: [{ op: 'lockdown.read', eosID }] });
  assert.ok(aAfter.mine, 'A lost its own lockdown row when B wrote one');
  assert.deepEqual(aAfter.allServerIDs, [A, B], 'the composite key did not admit the same eosID twice');
});

test('each server keeps its own explainMessageId', async () => {
  await runChild({ tag: 'A', serverID: A, ops: [{ op: 'setting.set', key: 'explainMessageId', value: 'msg-from-A' }] });
  await runChild({ tag: 'B', serverID: B, ops: [{ op: 'setting.set', key: 'explainMessageId', value: 'msg-from-B' }] });

  const [aRead] = await runChild({ tag: 'A2', serverID: A, ops: [{ op: 'setting.read', key: 'explainMessageId' }] });
  const [bRead] = await runChild({ tag: 'B2', serverID: B, ops: [{ op: 'setting.read', key: 'explainMessageId' }] });

  assert.equal(aRead.value, 'msg-from-A', 'A\'s explain message id did not survive B\'s write');
  assert.equal(bRead.value, 'msg-from-B', 'B read A\'s explain message id');
});

test('a win streak advanced on A does not move B\'s counter', async () => {
  await runChild({ tag: 'A', serverID: A, ops: [{ op: 'streak.set', team: 1, count: 3 }] });

  const [bBefore] = await runChild({ tag: 'B', serverID: B, ops: [{ op: 'streak.read' }] });
  assert.ok(
    bBefore.mine === null || bBefore.mine.count === 0,
    `B inherited A's win streak: ${JSON.stringify(bBefore.mine)}`
  );

  await runChild({ tag: 'B', serverID: B, ops: [{ op: 'streak.set', team: 2, count: 1 }] });

  const [aAfter] = await runChild({ tag: 'A2', serverID: A, ops: [{ op: 'streak.read' }] });
  assert.equal(aAfter.mine?.count, 3, 'A\'s win streak was overwritten by B\'s');
  assert.equal(aAfter.mine?.team, 1, 'A\'s winning team was overwritten by B\'s');
  assert.deepEqual(aAfter.ids, [A, B], 'TeamBalancerState did not end up with one row per server');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Community-wide on purpose
// ═══════════════════════════════════════════════════════════════════════════

test('a token balance spent on A is visible on B', async () => {
  const eosID = 'eos-token-1';

  await runChild({ tag: 'A', serverID: A, ops: [{ op: 'token.set', eosID, balance: 3 }] });
  const [bSees] = await runChild({ tag: 'B', serverID: B, ops: [{ op: 'token.read', eosID }] });
  assert.equal(bSees.balance, 3, 'the token bucket is not community-wide — B could not see A\'s balance');

  await runChild({ tag: 'B', serverID: B, ops: [{ op: 'token.set', eosID, balance: 2 }] });
  const [aSees] = await runChild({ tag: 'A2', serverID: A, ops: [{ op: 'token.read', eosID }] });
  assert.equal(aSees.balance, 2, 'a token spent on B was not visible on A');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Export scope
// ═══════════════════════════════════════════════════════════════════════════

test('a scoped export from B carries B\'s rows and the community-wide ones, and none of A\'s', async () => {
  const [envelope] = await runChild({ tag: 'B', serverID: B, ops: [{ op: 'export' }] });

  assert.equal(envelope.scope, 'server', 'the envelope did not describe itself as scoped');
  assert.equal(envelope.serverID, B, 'the envelope names the wrong server');

  // S3_GameState and TeamBalancerState are the case an attribute check gets
  // backwards: neither has a serverID column, because the primary key IS the
  // server. A scope test that looks for the column answers "global" here and
  // exports both servers' rows.
  assert.deepEqual(envelope.gameStateIDs, [B], `scoped export carried game state rows ${JSON.stringify(envelope.gameStateIDs)}`);
  assert.deepEqual(envelope.streakIDs, [B], `scoped export carried win streak rows ${JSON.stringify(envelope.streakIDs)}`);
  assert.deepEqual(envelope.settingServerIDs, [B], 'scoped export carried another server\'s settings');

  // The community-wide table is the other half of the claim: scoping must not
  // narrow a table that has no server.
  assert.ok(
    envelope.cooldownIDs.includes('eos-token-1'),
    'the community-wide cooldown row was dropped from a scoped export'
  );
  assert.ok(
    !envelope.containedServerIDs.includes(A),
    `the envelope reports containing server ${A}'s rows: ${JSON.stringify(envelope.containedServerIDs)}`
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Locking and claiming, across processes
// ═══════════════════════════════════════════════════════════════════════════

test('two processes migrating at once: one runs the body, the other waits and applies nothing', async () => {
  const marks = markerPath('migrate-race');
  const group = 'twoproc-race';

  const [aRes, bRes] = await runBoth(
    { tag: 'A', serverID: A, markerPath: marks, ops: [{ op: 'migrate', group, table: 'TwoProcRaceTable', holdMs: 1500 }] },
    { tag: 'B', serverID: B, markerPath: marks, ops: [{ op: 'migrate', group, table: 'TwoProcRaceTable', holdMs: 1500 }] }
  );

  const entered = markers(marks).filter((m) => m.phase === 'enter');
  assert.equal(entered.length, 1, `the migration body ran ${entered.length} times — the lock did not hold across processes`);

  const applied = [aRes[0].applied, bRes[0].applied];
  assert.deepEqual(
    applied.slice().sort(), [0, 1],
    `expected one process to apply one migration and the other none, got ${JSON.stringify(applied)}`
  );
});

test('a lock released by one process is acquirable by the next immediately, not after a TTL', async () => {
  // A leaked lock is invisible to a test that only checks mutual exclusion: it
  // looks like success right up until something has to take the lock again,
  // and then it looks like a ten-minute hang.
  await runChild({ tag: 'A', serverID: A, ops: [{ op: 'lock.acquire', key: 's3_migrate_handoff' }, { op: 'lock.release', key: 's3_migrate_handoff' }] });

  const began = Date.now();
  const [got] = await runChild({ tag: 'B', serverID: B, ops: [{ op: 'lock.acquire', key: 's3_migrate_handoff' }, { op: 'lock.release', key: 's3_migrate_handoff' }] });
  const elapsed = Date.now() - began;

  assert.equal(got.acquired, true, 'the second process could not take a lock the first had released');
  assert.ok(elapsed < 20000, `the handoff took ${elapsed}ms — the release left the row behind and B waited it out`);
});

test('two processes racing one Discord message: exactly one wins', async () => {
  const marks = markerPath('claim-race');
  const key = 'discord:1234567890';
  const at = Date.now() + 2500;

  const [aRes, bRes] = await runBoth(
    { tag: 'A', serverID: A, markerPath: marks, ops: [{ op: 'claim', key, atMs: at }] },
    { tag: 'B', serverID: B, markerPath: marks, ops: [{ op: 'claim', key, atMs: at }] }
  );

  const outcomes = [aRes[0].outcome, bRes[0].outcome].sort();
  assert.deepEqual(
    outcomes, ['lost', 'won'],
    `expected one 'won' and one 'lost', got ${JSON.stringify(outcomes)} — a duplicate reply or none at all`
  );
});

test('reaping an expired claim does not remove a migration lock another process still holds', async () => {
  const marks = markerPath('reap-safety');
  const lockKey = 's3_migrate_reapsafety';

  // A takes the migration lock and sits on it. B claims a Discord message with
  // a TTL of one millisecond, waits for it to expire, and reaps. One predicate
  // serves both populations, and getting it wrong here unblocks a live
  // migration for everybody.
  const [aRes, bRes] = await runBoth(
    { tag: 'A', serverID: A, markerPath: marks, ops: [{ op: 'lock.hold', key: lockKey, ms: 4000 }] },
    {
      tag: 'B',
      serverID: B,
      markerPath: marks,
      ops: [
        { op: 'sleep', ms: 800 },
        { op: 'claim', key: 'discord:reap-me', ttlMs: 1 },
        { op: 'sleep', ms: 600 },
        { op: 'reap' },
        { op: 'lock.status', key: lockKey },
        { op: 'locks.list' }
      ]
    }
  );

  assert.equal(aRes[0].acquired, true, 'A never took the migration lock, so the case proves nothing');

  const reaped = bRes[3];
  const status = bRes[4].status;
  const rows = bRes[5].rows;

  assert.ok(reaped.removed >= 1, 'the expired claim was not reaped, so the reaper was never exercised');
  assert.equal(status.held, true, 'reaping an expired claim released a migration lock that was still held');
  assert.ok(
    rows.some((r) => r.lockKey === lockKey && r.kind === 'migration'),
    `the migration lock row is gone: ${JSON.stringify(rows)}`
  );
});

test('a connector named for the community rather than its dialect still takes a real lock', async () => {
  // `databaseOption` is only conventionally the dialect name. A connector
  // called `squad-db` used to fall through the dialect branch and take a lock
  // that was not a lock.
  const marks = markerPath('connector-name');
  const key = 's3_migrate_namedconnector';

  const [aRes, bRes] = await runBoth(
    {
      tag: 'A',
      serverID: A,
      markerPath: marks,
      connectorName: 'squad-db',
      ops: [{ op: 'lock.hold', key, ms: 3000 }]
    },
    {
      tag: 'B',
      serverID: B,
      markerPath: marks,
      connectorName: 'northern-lights-db',
      ops: [{ op: 'sleep', ms: 700 }, { op: 'lock.status', key }]
    }
  );

  assert.equal(aRes[0].acquired, true, 'the named connector could not take the lock at all');
  assert.equal(
    bRes[1].status.held, true,
    'a second process saw no lock held while the first was holding one — the connector name decided whether the lock was real'
  );
});

test('two processes ending rounds against one Elo row lose no increments', async () => {
  // Elo_PlayerStats is community-wide by design — one rating per player across
  // every server — so a round ending on each server at once is a
  // read-modify-write two processes interleave. Without the row lock the
  // counters end short by however many times the reads overlapped, and nothing
  // reports it: the rating is still plausible and the rounds are simply gone.
  //
  // Twenty-five round-ends each rather than one each. A single pair would have
  // to interleave inside a window a few milliseconds wide, so it would pass
  // against unlocked code most runs — a test that fails a quarter of the time
  // against a real defect is worse than none.
  const eosID = 'eos-elo-concurrent';
  const each = 25;

  await runChild({ tag: 'seed', serverID: A, ops: [{ op: 'elo.seed', eosID }] });

  const at = Date.now() + 4000;
  const [aRes, bRes] = await runBoth(
    { tag: 'A', serverID: A, ops: [{ op: 'elo.rounds', eosID, count: each, mu: 26.5, atMs: at }] },
    { tag: 'B', serverID: B, ops: [{ op: 'elo.rounds', eosID, count: each, mu: 24.5, atMs: at }] }
  );

  assert.equal(aRes[0].failed, 0, `A lost ${aRes[0].failed} transactions outright`);
  assert.equal(bRes[0].failed, 0, `B lost ${bRes[0].failed} transactions outright`);

  const [read] = await runChild({ tag: 'read', serverID: A, ops: [{ op: 'elo.read', eosID }] });
  assert.equal(
    read.row?.roundsPlayed, each * 2,
    `roundsPlayed is ${read.row?.roundsPlayed}, not ${each * 2} — increments were read before a sibling's write and overwritten by it`
  );
  assert.equal(
    read.row?.wins, each * 2,
    `wins is ${read.row?.wins}, not ${each * 2} — the same lost update, on the column an admin would notice`
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Version lockstep
// ═══════════════════════════════════════════════════════════════════════════

test('a process on a different suite version than a live sibling refuses, and stops refusing once that sibling goes stale', async () => {
  await runChild({ tag: 'A', serverID: A, ops: [{ op: 'register', suiteVersion: '1.8.0', serverName: 'Server A' }] });

  const [, mismatch] = await runChild({
    tag: 'B',
    serverID: B,
    ops: [
      { op: 'register', suiteVersion: '1.7.0', serverName: 'Server B' },
      { op: 'lockstep', suiteVersion: '1.7.0' }
    ]
  });

  assert.equal(mismatch.ok, false, 'a mixed-version community was reported as being in lockstep');
  assert.equal(mismatch.checked, 1, `expected to compare against exactly one sibling, compared against ${mismatch.checked}`);
  assert.equal(mismatch.mismatches[0]?.serverID, A, 'the refusal named the wrong server');

  // Age A's row past the freshness window. A stopped server must not keep a
  // community pinned to the version it was running when it stopped.
  await withParentDb(async (seq) => {
    await seq.query('UPDATE S3_Servers SET lastSeenAt = lastSeenAt - 600000 WHERE serverID = :id', {
      replacements: { id: A }
    });
  });

  const [stale] = await runChild({ tag: 'B2', serverID: B, ops: [{ op: 'lockstep', suiteVersion: '1.7.0' }] });
  assert.equal(stale.ok, true, 'a stale sibling row still blocked the mount');
  assert.equal(stale.checked, 0, 'the stale row was still counted as live');
});

// ---------------------------------------------------------------------------

try {
  setup();
  await createDatabase();
  if (reachable) {
    // One child creates every table before any race starts. Two processes
    // bootstrapping the schema is a different race from the ones under test,
    // and losing it reads as a failure of the thing under test.
    await runChild({ tag: 'prepare', serverID: A, ops: [{ op: 'prepare' }] });
    await runChild({ tag: 'prepare-b', serverID: B, ops: [{ op: 'prepare' }] });
  }
  await run();
} finally {
  await dropDatabase();
  teardown();
}
