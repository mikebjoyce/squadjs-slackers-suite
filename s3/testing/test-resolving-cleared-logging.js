/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   RESOLVING_CLEARED LOGGING — REAL ENGINE, REAL SERVICES      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * `resolving` is the trust gate on team data, and nothing recorded the moment
 * it cleared.
 *
 * It used to be force-cleared by the STAGING→LIVE timer, so the PHASE_CHANGE
 * row for that transition carried `resolving: 0` and timestamped the clear by
 * accident. Decoupling the two was correct — a seed round goes LIVE 5s after
 * NEW_GAME, long before the first player-info tick, so the old clear was
 * asserting teams had resolved when they had not — but it left the flag
 * clearing on a player tick or on its own deadline, neither of which is a phase
 * change. No row was written at all. The flag became correct and simultaneously
 * became unobservable.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   1. Each clear path writes exactly one RESOLVING_CLEARED row, tagged with
 *      WHICH path fired — a budget timeout must be distinguishable from a
 *      normal resolution in the data, because only the first is a failure.
 *   2. The row records `resolving: 0`, the matchId, and the layer.
 *   3. A clear that never happened writes nothing, and a second tick after the
 *      flag is already down does not write a duplicate.
 *   4. STAGING→LIVE no longer clears the flag: that row legitimately carries
 *      `resolving: 1` and is NOT a RESOLVING_CLEARED row.
 *   5. `durationMs` reaches the JSONL mirror.
 *   6. The table's column set is unchanged — see below.
 *
 * ─── WHY THERE IS NO durationMs COLUMN ───────────────────────────
 *
 * Duration is the number the 120s-budget question actually needs, and it is
 * deliberately NOT a column. Adding one is DDL, and the live MySQL user has no
 * DDL grants: the model would name a column the server does not have, and every
 * game-state write would fail — on a path that logs and continues, so silently.
 * `Model.sync()` would not save us either; without `alter` it emits nothing for
 * a table that already exists, so existing SQLite deployments would break the
 * same way.
 *
 * So duration goes to the schemaless JSONL mirror, and from the table it is
 * derived by joining the round's opening PHASE_CHANGE row. Case 6 pins the
 * column set so this stays a decision rather than a thing someone undoes by
 * accident.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-resolving-cleared-logging.js
 *
 * Runs against a real file-backed SQLite database, and against MySQL too when
 * s3-test-mysql (127.0.0.1:3307) is reachable — reading every assertion back
 * out of the engine. A mock would accept any write and prove nothing, which
 * is precisely how this regression survived a green suite, and MySQL is not
 * optional window-dressing here: the whole point of case 6 is a claim about
 * the engine with no DDL grants. MySQL cases report as skipped, not passed,
 * when the container is down — read the skip count.
 *
 * Category: 1 (no server required; Docker-optional, see above)
 */

'use strict';

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sequelize } from 'sequelize';

import DBService from '../utils/db-service.js';
import GameStateService from '../utils/game-state-service.js';
import LoggingService from '../utils/logging-service.js';

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

/*
 * SQLite is the default because it needs nothing running. MySQL matters for a
 * reason SQLite cannot express: it is the OTHER live target, and the one where
 * the DB user has no DDL grants. This suite's central claim — that
 * RESOLVING_CLEARED needs no schema change — is a claim about MySQL above all,
 * and asserting it only against a SQLite file that the test itself created
 * proves the easy half. Port matches test-dialect-portability.js.
 *
 *   docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -p 3307:3306 mysql:8
 */
const MYSQL = {
  dialect: 'mysql',
  host: process.env.S3_TEST_MYSQL_HOST || '127.0.0.1',
  port: parseInt(process.env.S3_TEST_MYSQL_PORT || '3307', 10),
  username: process.env.S3_TEST_MYSQL_ROOT_USER || 'root',
  password: process.env.S3_TEST_MYSQL_ROOT_PASSWORD || 'root',
  database: process.env.S3_TEST_MYSQL_DATABASE || 'mysql',
  logging: false,
  dialectOptions: { connectTimeout: 4000 }
};

let mysqlReachable = false;

async function probeMysql() {
  let seq;
  try {
    seq = new Sequelize(MYSQL);
    await seq.authenticate();
    mysqlReachable = true;
    console.log(`  mysql reachable on ${MYSQL.host}:${MYSQL.port}`);
  } catch {
    mysqlReachable = false;
    console.log(`  ⚠ mysql not reachable on ${MYSQL.host}:${MYSQL.port} — those cases will skip`);
  } finally {
    try { await seq?.close(); } catch { /* best effort */ }
  }
  console.log('');
}

/** Tables the mounted services create, most-dependent first. */
const S3_TABLES = [
  'S3_PlayerEvents',
  'S3_GameStateEvents',
  'S3_PlayerSnapshots',
  'S3_GameState',
  'S3_SchemaVersions'
];

async function dropS3Tables(seq) {
  const qi = seq.getQueryInterface().quoteIdentifier.bind(seq.getQueryInterface());
  for (const table of S3_TABLES) {
    try {
      await seq.query(`DROP TABLE IF EXISTS ${qi(table)}`);
    } catch { /* best effort — the next mount recreates whatever survived */ }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const tests = [];
const SKIP = Symbol('skip');

function test(name, fn) {
  tests.push({ name, fn });
}

class MockServer extends EventEmitter {
  constructor() {
    super();
    this.players = [];
    this.currentLayer = null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Mounts the real DBService, GameStateService and LoggingService against a real
 * SQLite file, in production's order (db → gameState → logging).
 *
 * @param {Object}   [opts]
 * @param {Object}   [opts.playersService] - parent.players, or null for the
 *                                           raw-roster fallback path.
 * @param {number}   [opts.resolvingTimeoutMs]
 * @param {boolean}  [opts.fileLogging]
 */
async function withServices(opts, fn) {
  const {
    playersService = null,
    resolvingTimeoutMs = 120000,
    stagingDurationMs = 180000,
    fileLogging = false,
    engine = 'sqlite'
  } = opts || {};

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-resolving-'));
  const storage = path.join(dir, 'test.sqlite');
  const logPath = path.join(dir, 'mirror.jsonl');

  const seq = engine === 'mysql'
    ? new Sequelize(MYSQL)
    : new Sequelize({ dialect: 'sqlite', storage, logging: false });

  // MySQL is a shared, persistent server, so unlike the throwaway SQLite file
  // it carries state between runs. Start from nothing, or row counts assert
  // against a previous run's leftovers.
  if (engine === 'mysql') await dropS3Tables(seq);
  const db = new DBService({
    sequelize: seq,
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();

  const server = new MockServer();

  // The S³ plugin exposes services as flat getters; both services read their
  // siblings off `parent`, so the shape matters more than the object.
  const parent = { db, players: playersService };

  const gameState = new GameStateService({
    parent,
    server,
    resolvingTimeoutMs,
    stagingDurationMs,
    verboseLogger: () => {}
  });
  await gameState.mount();

  const logging = new LoggingService({
    parent,
    server,
    dbService: db,
    gameState,
    enableDatabaseLogging: true,
    enableFileLogging: fileLogging,
    logPath,
    verboseLogger: () => {}
  });
  await logging.mount();

  /**
   * Read S3_GameStateEvents back out of the engine, oldest first.
   *
   * Identifiers are quoted through the engine's own quoting rather than with
   * literal double quotes: MySQL reads `"S3_GameStateEvents"` as a string
   * literal, not an identifier, so the hardcoded form worked on SQLite and
   * could never have run on the other live target.
   */
  const readEvents = async () => {
    const q = (name) => db.quoteIdentifier(name);
    const [rows] = await seq.query(
      `SELECT * FROM ${q('S3_GameStateEvents')} ORDER BY ${q('id')} ASC`
    );
    return rows;
  };

  try {
    return await fn({ db, gameState, logging, server, seq, readEvents, logPath });
  } finally {
    try { await logging.unmount(); } catch { /* best effort */ }
    try { await gameState.unmount(); } catch { /* best effort */ }
    try { await db.unmount(); } catch { /* best effort */ }
    try { await seq.close(); } catch { /* best effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** logGameStateEvent is fire-and-forget from the callback; let it land. */
async function settle() {
  await sleep(60);
}

function clearedRows(rows) {
  return rows.filter((r) => r.eventType === 'RESOLVING_CLEARED');
}

// ---------------------------------------------------------------------------
// 1. PlayersService path — the normal clear
// ---------------------------------------------------------------------------

test('PlayersService resolution writes one RESOLVING_CLEARED row tagged PLAYERS_RESOLVED', async () => {
  let resolved = false;
  const playersService = { areTeamsResolved: () => resolved };

  await withServices({ playersService }, async ({ gameState, readEvents }) => {
    await gameState.handleNewGame({ layer: 'Narva_RAAS_v2' });
    await settle();

    // Teams not yet settled: the tick must not write anything.
    await gameState.handleUpdatedPlayerInfo();
    await settle();
    assert.equal(
      clearedRows(await readEvents()).length,
      0,
      'a tick that did not clear the flag still wrote a row'
    );
    assert.equal(gameState.isResolving(), true);

    resolved = true;
    await gameState.handleUpdatedPlayerInfo();
    await settle();

    const cleared = clearedRows(await readEvents());
    assert.equal(cleared.length, 1, `expected exactly one row, got ${cleared.length}`);

    const row = cleared[0];
    assert.equal(row.oldPhase, 'RESOLVING');
    assert.equal(
      row.newPhase,
      'PLAYERS_RESOLVED',
      'the reason must be recorded — a budget timeout and a normal resolution ' +
      'are the same row without it, and only one of them is a failure'
    );
    assert.equal(row.resolving, 0, 'the row records the state AFTER the clear');
    assert.equal(row.matchId, gameState.getMatchId());
    assert.equal(row.layerName, 'Narva_RAAS_v2');
    assert.ok(Number(row.ts) > 0, 'ts must be populated');
  });
});

// ---------------------------------------------------------------------------
// 2. Raw-roster fallback — PlayersService absent
// ---------------------------------------------------------------------------

test('raw-roster fallback writes ROSTER_FALLBACK, distinct from the PlayersService path', async () => {
  await withServices({ playersService: null }, async ({ gameState, server, readEvents }) => {
    await gameState.handleNewGame({ layer: 'Gorodok_AAS_v1' });
    await settle();

    server.players = [{ teamID: 1 }, { teamID: null }];
    await gameState.handleUpdatedPlayerInfo();
    await settle();
    assert.equal(clearedRows(await readEvents()).length, 0, 'cleared with a player still unassigned');

    server.players = [{ teamID: 1 }, { teamID: 2 }];
    await gameState.handleUpdatedPlayerInfo();
    await settle();

    const cleared = clearedRows(await readEvents());
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].newPhase, 'ROSTER_FALLBACK');
    assert.equal(cleared[0].resolving, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. Budget expiry — the one path that IS a failure
// ---------------------------------------------------------------------------

test('the resolving deadline writes BUDGET_EXPIRED', async () => {
  await withServices({ playersService: null, resolvingTimeoutMs: 80, stagingDurationMs: 60000 }, async ({ gameState, readEvents }) => {
    const fired = new Promise((resolve) => {
      gameState.onResolvingChange((payload) => resolve(payload));
    });

    await gameState.handleNewGame({ layer: 'Yehorivka_RAAS_v1' });

    // Both lifecycle timers are unref'd — deliberately, so a mounted service
    // never holds a process open. Nothing else here has a ref'd handle, so the
    // sleep is what keeps the loop alive long enough for the deadline to fire.
    const [payload] = await Promise.all([fired, sleep(300)]);
    assert.equal(payload.reason, 'BUDGET_EXPIRED');
    assert.equal(payload.resolving, false);
    assert.ok(
      Number.isFinite(payload.durationMs) && payload.durationMs >= 80,
      `durationMs should span the budget, got ${payload.durationMs}`
    );

    await settle();
    const cleared = clearedRows(await readEvents());
    assert.equal(cleared.length, 1);
    assert.equal(
      cleared[0].newPhase,
      'BUDGET_EXPIRED',
      'a deadline clear must be identifiable in the table — it is the signal ' +
      'that the configured budget is too short for the live player count'
    );
  });
});

// ---------------------------------------------------------------------------
// 4. No duplicates once the flag is down
// ---------------------------------------------------------------------------

test('further ticks after the clear write no second row', async () => {
  const playersService = { areTeamsResolved: () => true };

  await withServices({ playersService }, async ({ gameState, readEvents }) => {
    await gameState.handleNewGame({ layer: 'Fallujah_RAAS_v1' });
    await settle();

    await gameState.handleUpdatedPlayerInfo();
    await gameState.handleUpdatedPlayerInfo();
    await gameState.handleUpdatedPlayerInfo();
    await settle();

    assert.equal(clearedRows(await readEvents()).length, 1);
  });
});

// ---------------------------------------------------------------------------
// 5. A round that ends before teams resolve
// ---------------------------------------------------------------------------

test('ROUND_ENDED is recorded when the round ends with the flag still set', async () => {
  await withServices({ playersService: null }, async ({ gameState, readEvents }) => {
    await gameState.handleNewGame({ layer: 'Skorpo_RAAS_v1' });
    await settle();
    assert.equal(gameState.isResolving(), true);

    await gameState.handleRoundEnded();
    await settle();

    const rows = await readEvents();
    const cleared = clearedRows(rows);
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].newPhase, 'ROUND_ENDED');

    // The phase change itself is still recorded, once, as its own row.
    const endgame = rows.filter((r) => r.eventType === 'PHASE_CHANGE' && r.newPhase === 'ENDGAME');
    assert.equal(endgame.length, 1, 'the resolving row must not replace or duplicate the phase row');
  });
});

test('a round ending with the flag already down writes no ROUND_ENDED row', async () => {
  const playersService = { areTeamsResolved: () => true };

  await withServices({ playersService }, async ({ gameState, readEvents }) => {
    await gameState.handleNewGame({ layer: 'Mutaha_RAAS_v1' });
    await gameState.handleUpdatedPlayerInfo();
    await settle();

    await gameState.handleRoundEnded();
    await settle();

    const cleared = clearedRows(await readEvents());
    assert.equal(cleared.length, 1, 'the clear was already recorded; ROUND_ENDED would double-count it');
    assert.equal(cleared[0].newPhase, 'PLAYERS_RESOLVED');
  });
});

// ---------------------------------------------------------------------------
// 6. STAGING→LIVE no longer clears the flag
// ---------------------------------------------------------------------------

test('STAGING->LIVE records resolving=1 and is not a RESOLVING_CLEARED row', async () => {
  await withServices(
    { playersService: null, stagingDurationMs: 60 },
    async ({ gameState, readEvents }) => {
      await gameState.handleNewGame({ layer: 'Narva_RAAS_v2' });
      await sleep(200);
      await settle();

      const rows = await readEvents();
      const live = rows.filter((r) => r.eventType === 'PHASE_CHANGE' && r.newPhase === 'LIVE');
      assert.equal(live.length, 1, 'the staging timer should have taken the round LIVE');
      assert.equal(
        live[0].resolving,
        1,
        'going LIVE says the staging clock elapsed, not that teams are settled — ' +
        'this row carrying resolving=1 is the correctness this task was built on'
      );
      assert.equal(clearedRows(rows).length, 0, 'a phase change is not a resolving clear');
      assert.equal(gameState.isResolving(), true);
    }
  );
});

// ---------------------------------------------------------------------------
// 7. durationMs reaches the JSONL mirror
// ---------------------------------------------------------------------------

test('the JSONL mirror carries durationMs and the reason', async () => {
  const playersService = { areTeamsResolved: () => true };

  await withServices({ playersService, fileLogging: true }, async ({ gameState, logging, logPath }) => {
    await gameState.handleNewGame({ layer: 'Anvil_RAAS_v1' });
    await sleep(40);
    await gameState.handleUpdatedPlayerInfo();
    await settle();
    await logging._flushJsonl();

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const cleared = lines.filter((l) => l.eventType === 'RESOLVING_CLEARED');
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].newPhase, 'PLAYERS_RESOLVED');
    assert.ok(
      Number.isFinite(cleared[0].durationMs),
      'durationMs has no column in the table, so the mirror is where it lives'
    );
    assert.ok(cleared[0].durationMs >= 0);

    // Rows that have no duration must not invent one.
    const phase = lines.filter((l) => l.eventType === 'PHASE_CHANGE');
    assert.ok(phase.length > 0);
    assert.ok(!('durationMs' in phase[0]), 'durationMs leaked onto an unrelated event');
  });
});

// ---------------------------------------------------------------------------
// 8. The table shape is unchanged — the no-DDL-grants guarantee
// ---------------------------------------------------------------------------

test('S3_GameStateEvents still has exactly its original columns', async () => {
  await withServices({}, async ({ seq }) => {
    const described = await seq.getQueryInterface().describeTable('S3_GameStateEvents');
    assert.deepEqual(
      Object.keys(described).sort(),
      ['eventType', 'gamemode', 'id', 'layerName', 'matchId', 'newPhase', 'oldPhase', 'resolving', 'ts'],
      'a column was added or removed. The live MySQL user has no DDL grants and ' +
      'sync() emits nothing for an existing table, so a new column exists in the ' +
      'model and nowhere else — every game-state write then fails silently. ' +
      'If a column is genuinely needed, it needs a hand-applied migration first.'
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Unsubscribing on unmount
// ---------------------------------------------------------------------------

test('LoggingService.unmount() detaches the resolving subscription', async () => {
  const playersService = { areTeamsResolved: () => true };

  await withServices({ playersService }, async ({ gameState, logging, readEvents }) => {
    const before = gameState._onResolvingChangeCallbacks.length;
    assert.equal(before, 1, 'LoggingService should have subscribed at mount');

    await logging.unmount();
    assert.equal(
      gameState._onResolvingChangeCallbacks.length,
      0,
      'the callback outlived the service that owns it — a remount would double-write'
    );

    await gameState.handleNewGame({ layer: 'Kohat_RAAS_v1' });
    await gameState.handleUpdatedPlayerInfo();
    await settle();
    assert.equal(clearedRows(await readEvents()).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 10. The same claims on MySQL — the other live target
// ---------------------------------------------------------------------------

/*
 * Everything above runs on a SQLite file the test created moments earlier,
 * which is the friendliest possible engine: it accepts double-quoted
 * identifiers, has no column-type strictness worth the name, and grants the
 * test full DDL. The deployed pair is SQLite AND MySQL, and the interesting
 * half is MySQL — the live user there has no DDL grants, so "this change needs
 * no schema change" is a claim that has to hold on MySQL specifically or the
 * write fails at runtime on a path that logs and continues.
 *
 * These re-run the load-bearing assertions against a real MySQL server. They
 * skip, loudly, when one is not reachable — a skipped case is reported as
 * skipped and never counted as a pass.
 */

test('[mysql] a clear writes one RESOLVING_CLEARED row with the reason intact', async () => {
  if (!mysqlReachable) return SKIP;

  let resolved = false;
  const playersService = { areTeamsResolved: () => resolved };

  await withServices({ engine: 'mysql', playersService }, async ({ gameState, readEvents }) => {
    await gameState.handleNewGame({ layer: 'Narva_RAAS_v2' });
    await settle();

    await gameState.handleUpdatedPlayerInfo();
    await settle();
    assert.equal(clearedRows(await readEvents()).length, 0);

    resolved = true;
    await gameState.handleUpdatedPlayerInfo();
    await settle();

    const cleared = clearedRows(await readEvents());
    assert.equal(cleared.length, 1, `expected exactly one row, got ${cleared.length}`);
    assert.equal(cleared[0].oldPhase, 'RESOLVING');
    assert.equal(cleared[0].newPhase, 'PLAYERS_RESOLVED');
    // MySQL stores this as TINYINT/INT while SQLite hands back a JS number for
    // the same value — compare numerically so the assertion is about the data.
    assert.equal(Number(cleared[0].resolving), 0);
    assert.equal(cleared[0].layerName, 'Narva_RAAS_v2');
    assert.equal(cleared[0].matchId, gameState.getMatchId());
  });
});

test('[mysql] the budget deadline reason survives the round trip', async () => {
  if (!mysqlReachable) return SKIP;

  await withServices(
    { engine: 'mysql', playersService: null, resolvingTimeoutMs: 80, stagingDurationMs: 60000 },
    async ({ gameState, readEvents }) => {
      const fired = new Promise((resolve) => gameState.onResolvingChange(resolve));
      await gameState.handleNewGame({ layer: 'Yehorivka_RAAS_v1' });
      const payload = await fired;
      await settle();

      assert.equal(payload.reason, 'BUDGET_EXPIRED');

      const cleared = clearedRows(await readEvents());
      assert.equal(cleared.length, 1);
      assert.equal(
        cleared[0].newPhase,
        'BUDGET_EXPIRED',
        'the reason is written into newPhase — a VARCHAR on MySQL, so a longer ' +
        'reason string than the column holds would truncate or throw here rather ' +
        'than on the live server'
      );
    }
  );
});

test('[mysql] S3_GameStateEvents has exactly its original columns', async () => {
  if (!mysqlReachable) return SKIP;

  await withServices({ engine: 'mysql' }, async ({ seq }) => {
    const described = await seq.getQueryInterface().describeTable('S3_GameStateEvents');
    assert.deepEqual(
      Object.keys(described).sort(),
      ['eventType', 'gamemode', 'id', 'layerName', 'matchId', 'newPhase', 'oldPhase', 'resolving', 'ts'],
      'RESOLVING_CLEARED must need no DDL on MySQL. durationMs goes to the JSONL ' +
      'mirror precisely so this list does not grow — the live MySQL user cannot ' +
      'add a column, and sync() emits nothing for an existing table.'
    );
  });
});

test('[mysql] the model resolves to S3_GameStateEvents, not S3GameStateEvents', async () => {
  if (!mysqlReachable) return SKIP;

  await withServices({ engine: 'mysql' }, async ({ logging, seq }) => {
    assert.equal(
      logging.GameStateEventsModel.tableName,
      'S3_GameStateEvents',
      'defineModel() injects freezeTableName, so a missing tableName silently ' +
      'targets the model name instead — a table the live server does not have'
    );

    // And the table it names is the one that actually exists on the engine.
    const [rows] = await seq.query(
      `SELECT COUNT(*) AS n FROM ${logging.dbService.quoteIdentifier('S3_GameStateEvents')}`
    );
    assert.ok(Number(rows[0].n) >= 0);
  });
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('='.repeat(72));
  console.log('RESOLVING_CLEARED logging  (real SQLite + MySQL, real services)');
  console.log('='.repeat(72));
  console.log('');

  await probeMysql();

  for (const t of tests) {
    try {
      // A case that returns SKIP was never run. Reported as skipped rather than
      // passed, so an unreachable MySQL cannot masquerade as coverage.
      const result = await t.fn();
      if (result === SKIP) {
        console.log(`  ⊘ ${t.name} (skipped — engine unreachable)`);
        skipped++;
        continue;
      }
      console.log(`  ✓ ${t.name}`);
      passed++;
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
      failed++;
    }
  }

  console.log('');
  console.log('─'.repeat(72));
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped, ${tests.length} total`);
  console.log('─'.repeat(72));

  if (failed > 0) process.exitCode = 1;
}

await run();
