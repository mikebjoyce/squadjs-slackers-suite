/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   EXPORT MODEL REGISTRATION — REAL ENGINE, REAL SERVICES      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * `!s3 db export --all` silently omitted four tables that exist and hold data:
 * S3_SchemaVersions, S3_PlayerEvents, S3_GameStateEvents, S3_PlayerSnapshots.
 *
 * The cause was registration, not filtering. `getModelNames()` returns
 * `Object.keys(dbService.models)`, which only `defineModel()` populates. Those
 * four called `sequelize.define()` directly on the raw connector, so they never
 * entered the map and were invisible at EVERY tier including `--all`.
 *
 * The pre-existing export test did not catch this because it registered
 * `S3_PlayerEvents` itself, via `defineModel()` — the path production does not
 * use. A test that constructs its own model can only ever prove the exporter
 * works; it cannot prove the services registered anything.
 *
 * **So this file mounts the REAL LoggingService and the REAL DBService against
 * a REAL engine and asserts what they actually registered.** Nothing here
 * defines a model of its own. That distinction is the entire point of the file.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   1. LoggingService.mount() registers its three models where the exporter
 *      looks for them.
 *   2. DBService.mount() registers S3SchemaVersions likewise.
 *   3. Resolved table names are UNCHANGED — the no-DDL-grants guarantee.
 *   4. The tier sets hold model names that actually exist, partition the
 *      registry exhaustively, and never double-assign.
 *   5. defineModel() stays idempotent across a re-mount on a shared connector.
 *
 * ─── WHY THE TABLE-NAME ASSERTION MATTERS ────────────────────────
 *
 * `defineModel()` injects `freezeTableName: true`, which makes the MODEL name
 * the table name unless an explicit `tableName` overrides it. These models pair
 * a non-underscored model name with an underscored table name, so dropping the
 * override retargets `S3_GameStateEvents` → `S3GameStateEvents`: a brand new,
 * empty table.
 *
 * On the live MySQL server the DB user has **no DDL grants**. That failure does
 * not surface at review time or in CI — it surfaces at runtime, on a write path
 * that logs and continues. Case 3 is the check that stands in for a server we
 * cannot break safely.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node s3/testing/test-export-model-registration.js
 *
 *   # with the Docker engine (port matches test-dialect-portability.js):
 *   docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root \
 *     -p 3307:3306 mysql:8
 *
 * SQLite always runs. MySQL is Docker-gated and skips gracefully — but MySQL is
 * a live deployment target, so run it before trusting a change to model
 * registration.
 *
 * Category: 1 (SQLite always; MySQL auto-skips)
 */

'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sequelize } from 'sequelize';

import DBService from '../utils/db-service.js';
import LoggingService from '../utils/logging-service.js';
import { TIER_SETS } from '../utils/s3-export-import.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
const tests = [];
const SKIP = Symbol('skip');

function test(name, fn) {
  tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Connection config — ports match test-dialect-portability.js
// ---------------------------------------------------------------------------

const SQLITE = { dialect: 'sqlite', storage: ':memory:', logging: false };

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

const DIALECTS = [
  { name: 'sqlite', opts: SQLITE },
  { name: 'mysql', opts: MYSQL }
];

const reachability = new Map([['sqlite', true]]);

async function probeReachability() {
  let seq;
  try {
    seq = new Sequelize(MYSQL);
    await seq.authenticate();
    reachability.set('mysql', true);
    console.log(`  mysql reachable on ${MYSQL.host}:${MYSQL.port}`);
  } catch {
    reachability.set('mysql', false);
    console.log(`  ⚠ mysql not reachable on ${MYSQL.host}:${MYSQL.port} — those cases will skip`);
  } finally {
    try { await seq?.close(); } catch { /* best effort */ }
  }
  console.log('');
}

/**
 * The exact registration production performs: mount DBService, then mount
 * LoggingService on top of it. No model is defined by the test itself.
 */
async function withMountedServices(dialectName, fn) {
  if (!reachability.get(dialectName)) return SKIP;

  const opts = DIALECTS.find((d) => d.name === dialectName).opts;
  const seq = new Sequelize(opts);
  const db = new DBService({
    sequelize: seq,
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();

  const logging = new LoggingService({
    dbService: db,
    enableDatabaseLogging: true,
    verboseLogger: () => {}
  });
  await logging.mount();

  try {
    return await fn({ db, logging, seq });
  } finally {
    try { await logging.unmount(); } catch { /* best effort */ }
    try { await db.unmount(); } catch { /* best effort */ }
    try { await seq.close(); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// The four models that were invisible, and the table each MUST resolve to.
// ---------------------------------------------------------------------------

const PREVIOUSLY_INVISIBLE = Object.freeze({
  S3SchemaVersions: 'S3_SchemaVersions',
  S3PlayerEvents: 'S3_PlayerEvents',
  S3GameStateEvents: 'S3_GameStateEvents',
  S3PlayerSnapshots: 'S3_PlayerSnapshots'
});

// ---------------------------------------------------------------------------
// 1 + 2. The services register where the exporter looks
// ---------------------------------------------------------------------------

for (const { name: dialect } of DIALECTS) {
  test(`[${dialect}] mounted services register all four previously-invisible models`, async () =>
    withMountedServices(dialect, ({ db }) => {
      const registered = db.getModelNames();

      for (const model of Object.keys(PREVIOUSLY_INVISIBLE)) {
        assert.ok(
          registered.includes(model),
          `${model} missing from getModelNames() — the exporter cannot see it, so it ` +
          `reaches no backup at any tier. Registered: ${registered.join(', ')}`
        );
      }
    }));

  // ---------------------------------------------------------------------------
  // 3. Resolved table names are unchanged — protects the no-DDL-grants server
  // ---------------------------------------------------------------------------

  test(`[${dialect}] resolved table names are unchanged by the registration move`, async () =>
    withMountedServices(dialect, ({ db }) => {
      for (const [model, expectedTable] of Object.entries(PREVIOUSLY_INVISIBLE)) {
        const resolved = db.getModel(model)?.tableName;
        assert.equal(
          resolved,
          expectedTable,
          `${model} resolves to table "${resolved}" but must resolve to "${expectedTable}". ` +
          `defineModel() injects freezeTableName, so an omitted explicit tableName silently ` +
          `retargets a NEW table. The live MySQL user has no DDL grants — this fails at ` +
          `runtime on a path that logs and continues, not here.`
        );
      }
    }));

  test(`[${dialect}] the tables the models point at actually exist on the engine`, async () =>
    withMountedServices(dialect, async ({ db, seq }) => {
      // sync() ran during mount. If a tableName were wrong we would have created
      // the WRONG table and this would still pass on a DDL-capable engine — so
      // pair it with the assertion above, which pins the name itself.
      const qi = seq.getQueryInterface();
      const existing = await qi.showAllTables();
      const normalized = existing.map((t) => (typeof t === 'string' ? t : t.tableName));

      for (const expectedTable of Object.values(PREVIOUSLY_INVISIBLE)) {
        assert.ok(
          normalized.includes(expectedTable),
          `table ${expectedTable} not present after mount. Found: ${normalized.join(', ')}`
        );
      }
    }));

  // ---------------------------------------------------------------------------
  // 5. Idempotence across a re-mount on a shared connector
  // ---------------------------------------------------------------------------

  test(`[${dialect}] defineModel adopts an existing model rather than redefining it`, async () =>
    withMountedServices(dialect, async ({ db, seq }) => {
      const before = db.getModel('S3GameStateEvents');

      // A second DBService over the SAME connector — the re-mount shape. The old
      // `sequelize.models?.X || sequelize.define(...)` guard made this safe; the
      // move to defineModel() must preserve that, or a service holding a
      // reference from its first mount ends up writing through an orphan.
      const db2 = new DBService({
        sequelize: seq,
        defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
      });
      await db2.mount();
      const logging2 = new LoggingService({
        dbService: db2,
        enableDatabaseLogging: true,
        verboseLogger: () => {}
      });
      await logging2.mount();

      try {
        assert.equal(
          db2.getModel('S3GameStateEvents'),
          before,
          're-mount produced a different model object for S3GameStateEvents'
        );
        assert.equal(db2.getModel('S3GameStateEvents').tableName, 'S3_GameStateEvents');
      } finally {
        try { await logging2.unmount(); } catch { /* best effort */ }
        try { await db2.unmount(); } catch { /* best effort */ }
      }
    }));
}

// ---------------------------------------------------------------------------
// 6. UPGRADE IN PLACE — the check that stands in for the live server
// ---------------------------------------------------------------------------
//
// The concern this answers: an existing deployment already has these tables,
// populated, created by the previous (raw sequelize.define) code. Does mounting
// the new code against them alter anything?
//
// It must not. The model names and explicit tableNames are byte-identical to
// what the raw defines used — only the registration call changed — so sync()
// should find the tables already correct and issue no DDL. On live MySQL the DB
// user cannot issue DDL at all, so "should" is not good enough: this asserts the
// full column shape is unchanged and pre-existing rows survive and read back.

for (const { name: dialect } of DIALECTS) {
  test(`[${dialect}] mounting over pre-existing populated tables changes no schema and loses no data`, async () => {
    if (!reachability.get(dialect)) return SKIP;

    const opts = DIALECTS.find((d) => d.name === dialect).opts;
    // A file-backed SQLite DB (not :memory:) so state genuinely survives the
    // reconnect — an in-memory DB would be recreated and prove nothing.
    const storage = dialect === 'sqlite'
      ? path.join(os.tmpdir(), `s3-upgrade-${process.pid}-${Date.now()}.sqlite`)
      : null;
    const connOpts = storage ? { ...opts, storage } : opts;

    const describeAll = async (seq) => {
      const qi = seq.getQueryInterface();
      const out = {};
      for (const table of Object.values(PREVIOUSLY_INVISIBLE)) {
        const desc = await qi.describeTable(table);
        // Normalise to name→type so the comparison is about shape, not about
        // driver metadata that differs run to run.
        out[table] = Object.fromEntries(
          Object.entries(desc).map(([col, meta]) => [col, String(meta.type).toUpperCase()])
        );
      }
      return out;
    };

    // ── Pass 1: create and populate, as an existing deployment would have ──
    let before;
    {
      const seq = new Sequelize(connOpts);
      const db = new DBService({
        sequelize: seq,
        defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
      });
      await db.mount();
      const logging = new LoggingService({
        dbService: db, enableDatabaseLogging: true, verboseLogger: () => {}
      });
      await logging.mount();

      await db.getModel('S3GameStateEvents').create({
        matchId: 'upgrade-probe', ts: 1234567890, eventType: 'PHASE_CHANGE',
        oldPhase: 'STAGING', newPhase: 'LIVE', resolving: 1,
        layerName: 'Sumari_Seed_v1', gamemode: 'Seed'
      });

      before = await describeAll(seq);
      try { await logging.unmount(); } catch { /* best effort */ }
      try { await db.unmount(); } catch { /* best effort */ }
      await seq.close();
    }

    // ── Pass 2: a completely fresh process-equivalent mount over that data ──
    try {
      const seq = new Sequelize(connOpts);
      const db = new DBService({
        sequelize: seq,
        defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
      });
      await db.mount();
      const logging = new LoggingService({
        dbService: db, enableDatabaseLogging: true, verboseLogger: () => {}
      });
      await logging.mount();

      const after = await describeAll(seq);
      assert.deepEqual(
        after,
        before,
        'schema changed across a re-mount — on live MySQL this DDL would be REFUSED ' +
        '(the DB user has no DDL grants) and the failure would surface at runtime ' +
        'on a path that logs and continues'
      );

      const row = await db.getModel('S3GameStateEvents').findOne({
        where: { matchId: 'upgrade-probe' }
      });
      assert.ok(row, 'pre-existing row not readable after upgrade — wrong table targeted');
      assert.equal(row.layerName, 'Sumari_Seed_v1');
      assert.equal(row.newPhase, 'LIVE');

      await db.getModel('S3GameStateEvents').destroy({ where: { matchId: 'upgrade-probe' } });
      try { await logging.unmount(); } catch { /* best effort */ }
      try { await db.unmount(); } catch { /* best effort */ }
      await seq.close();
    } finally {
      if (storage) { try { fs.unlinkSync(storage); } catch { /* best effort */ } }
    }
  });
}

// ---------------------------------------------------------------------------
// 4. Tier sets hold real model names, partition exhaustively, never overlap
// ---------------------------------------------------------------------------

test('tier sets never assign the same model to two tiers', () => {
  const seen = new Map();
  for (const [tier, set] of Object.entries(TIER_SETS)) {
    for (const name of set) {
      assert.ok(
        !seen.has(name),
        `${name} appears in both "${seen.get(name)}" and "${tier}"`
      );
      seen.set(name, tier);
    }
  }
});

test('every S³-owned registered model belongs to exactly one tier', async () =>
  withMountedServices('sqlite', ({ db }) => {
    const union = new Set();
    for (const set of Object.values(TIER_SETS)) for (const n of set) union.add(n);

    // Only S³'s own models are registered here — the consumer plugins are not
    // mounted — so restrict the exhaustiveness check to what this mount created.
    const unassigned = db.getModelNames().filter((n) => !union.has(n));

    assert.deepEqual(
      unassigned,
      [],
      `these registered models are in NO tier, so --all exports them but the ` +
      `default and --logs tiers silently drop them: ${unassigned.join(', ')}`
    );
  }));

test('tier sets use model names, not table names', () => {
  // The original defect in one assertion: every underscored *table* name whose
  // model name differs must NOT appear in any tier set.
  const tableNamesThatAreNotModelNames = Object.values(PREVIOUSLY_INVISIBLE);

  for (const [tier, set] of Object.entries(TIER_SETS)) {
    for (const wrong of tableNamesThatAreNotModelNames) {
      assert.ok(
        !set.has(wrong),
        `tier "${tier}" contains "${wrong}", which is a TABLE name. filterByTier() ` +
        `matches against getModelNames(), so this entry matches nothing and the ` +
        `table is silently omitted from that tier.`
      );
    }
  }
});

test('the production model roster is fully accounted for', () => {
  // Ground truth: the 13 models a real production export emitted on 2026-08-19,
  // plus the 4 that were invisible. If a future change adds a model without
  // assigning it a tier, this list and the tier sets fall out of step.
  const PRODUCTION_ROSTER = [
    'S3SchemaVersions', 'S3PlayerEvents', 'S3GameStateEvents', 'S3PlayerSnapshots',
    'S3GameState', 'S3PlayerReconnect', 'S3_PlayerSession',
    'SwitchPlugin_PlayerCooldowns', 'SwitchPlugin_Endmatches', 'SwitchPlugin_Settings',
    'TeamBalancerState', 'TB_RoundReport',
    'Elo_PluginState', 'Elo_PlayerStats', 'Elo_RoundHistory', 'Elo_RoundPlayers',
    'SA_AssignmentLog'
  ];

  assert.equal(PRODUCTION_ROSTER.length, 17, 'roster drifted');

  const union = new Set();
  for (const set of Object.values(TIER_SETS)) for (const n of set) union.add(n);

  const missing = PRODUCTION_ROSTER.filter((n) => !union.has(n));
  assert.deepEqual(missing, [], `production models in no tier: ${missing.join(', ')}`);

  const extra = [...union].filter((n) => !PRODUCTION_ROSTER.includes(n));
  assert.deepEqual(extra, [], `tier sets name models that do not exist: ${extra.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function run() {
  console.log('='.repeat(72));
  console.log('Export Model Registration  (sqlite / mysql — real services)');
  console.log('='.repeat(72));
  console.log('');

  await probeReachability();

  for (const t of tests) {
    try {
      const result = await t.fn();
      if (result === SKIP) {
        console.log(`  ⚠ ${t.name} — SKIPPED (engine unreachable)`);
        skipped++;
      } else {
        console.log(`  ✓ ${t.name}`);
        passed++;
      }
    } catch (err) {
      console.log(`  ✗ ${t.name}`);
      console.log(`      ${String(err.message).split('\n')[0]}`);
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
