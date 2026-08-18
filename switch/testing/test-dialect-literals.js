/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     TEST: DIALECT-SAFE LITERALS — Mock/Production Agreement   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Keeps the mock harness honest about the shape of the atomic-increment
 * literals the Switch token grants actually emit.
 *
 * The seed-bonus and scramble-reset grants build their increments with
 * `DBService.incrementLiteral()`, which QUOTES the column so camelCase names
 * survive Postgres identifier folding — `` `tokenBalance` + 1 `` on SQLite and
 * MySQL, `"tokenBalance" + 1` on Postgres. The mock previously recognised only
 * a bare `tokenBalance + 1`, so the moment production started quoting, every
 * mocked grant would have silently applied nothing while still reporting a
 * successful update — tests green, tokens never granted.
 *
 * These tests therefore feed the mock the literal produced by a REAL DBService
 * rather than a hand-written string. If the production literal ever changes
 * shape again, this file fails instead of the mock quietly drifting.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-dialect-literals.js
 *
 * ─── COVERAGE ────────────────────────────────────────────────────
 *
 * Companion to s3/testing/test-dialect-portability.js, which proves the same
 * literals behave correctly against real SQLite / MySQL / Postgres engines.
 * See docs/TASK_POSTGRES_PORTABILITY.md.
 *
 */

import { Sequelize } from 'sequelize';
import { createMockDb, parseIncrementExpression, assert } from './mock-harness.js';
import DBService from '../../s3/utils/db-service.js';

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

/** A DBService for a given dialect. No connection is opened — quoting is offline. */
function dbFor(dialect) {
  const opts = dialect === 'sqlite'
    ? { dialect: 'sqlite', storage: ':memory:', logging: false }
    : { dialect, logging: false };
  return new DBService({ sequelize: new Sequelize(opts) });
}

async function testSuite() {
  console.log('\n🧪 Dialect-Safe Literals\n');

  // ── parseIncrementExpression ────────────────────────────────

  await runTest('parses the bare identifier form (legacy + test helpers)', async () => {
    assert.deepStrictEqual(
      parseIncrementExpression('tokenBalance + 1'),
      { column: 'tokenBalance', delta: 1 }
    );
  });

  await runTest('parses the backtick form (sqlite / mysql)', async () => {
    assert.deepStrictEqual(
      parseIncrementExpression('`tokenBalance` + 1'),
      { column: 'tokenBalance', delta: 1 }
    );
  });

  await runTest('parses the double-quote form (postgres)', async () => {
    assert.deepStrictEqual(
      parseIncrementExpression('"seedBonusTokensEarned" + 1'),
      { column: 'seedBonusTokensEarned', delta: 1 }
    );
  });

  await runTest('parses negative deltas as subtraction', async () => {
    assert.deepStrictEqual(
      parseIncrementExpression('"tokenBalance" - 2'),
      { column: 'tokenBalance', delta: -2 }
    );
  });

  await runTest('returns null for a non-increment literal', async () => {
    assert.strictEqual(parseIncrementExpression('lower(name)'), null);
    assert.strictEqual(parseIncrementExpression(''), null);
    assert.strictEqual(parseIncrementExpression(undefined), null);
  });

  // ── The mock must apply what production actually emits ──────

  for (const dialect of ['sqlite', 'mysql', 'postgres']) {
    await runTest(`mock applies a real ${dialect} incrementLiteral`, async () => {
      const db = dbFor(dialect);
      const mock = createMockDb();
      await mock.upsert({ eosID: 'p1', tokenBalance: 1, seedBonusTokensEarned: 0 });

      const [count] = await mock.update(
        { tokenBalance: db.incrementLiteral('tokenBalance', 1) },
        { where: { eosID: 'p1' } }
      );

      assert.strictEqual(count, 1, 'update should report one affected row');
      const row = await mock.findByPk('p1');
      assert.strictEqual(
        row.tokenBalance, 2,
        `mock did not apply the ${dialect} literal — it silently left tokenBalance at ${row.tokenBalance}`
      );
    });
  }

  await runTest('mock applies the full seed-grant field set', async () => {
    // The exact shape of _checkSeedBonusGrants: two quoted increments issued
    // atomically alongside plain column assignments.
    const db = dbFor('postgres');
    const mock = createMockDb();
    await mock.upsert({
      eosID: 'p1',
      tokenBalance: 2,
      seedBonusTokensEarned: 1,
      seedPresenceStart: new Date(1000),
      lastSeedBonusRoundID: 'old-round'
    });

    const [count] = await mock.update(
      {
        tokenBalance: db.incrementLiteral('tokenBalance', 1),
        seedBonusTokensEarned: db.incrementLiteral('seedBonusTokensEarned', 1),
        seedPresenceStart: new Date(5000),
        lastSeedBonusRoundID: 'new-round'
      },
      { where: { eosID: 'p1' } }
    );

    assert.strictEqual(count, 1);
    const row = await mock.findByPk('p1');
    assert.strictEqual(row.tokenBalance, 3, 'tokenBalance increment lost');
    assert.strictEqual(row.seedBonusTokensEarned, 2, 'seedBonusTokensEarned increment lost');
    assert.strictEqual(row.lastSeedBonusRoundID, 'new-round', 'plain field not set');
    assert.strictEqual(row.seedPresenceStart.getTime(), 5000, 'date field not set');
  });

  await runTest('increment on a null/absent column starts from 0', async () => {
    const db = dbFor('sqlite');
    const mock = createMockDb();
    await mock.upsert({ eosID: 'p1', tokenBalance: null });
    await mock.update(
      { tokenBalance: db.incrementLiteral('tokenBalance', 1) },
      { where: { eosID: 'p1' } }
    );
    const row = await mock.findByPk('p1');
    assert.strictEqual(row.tokenBalance, 1);
  });

  await runTest('non-matching rows are left untouched', async () => {
    const db = dbFor('mysql');
    const mock = createMockDb();
    await mock.upsert({ eosID: 'p1', tokenBalance: 1 });
    await mock.upsert({ eosID: 'p2', tokenBalance: 5 });
    const [count] = await mock.update(
      { tokenBalance: db.incrementLiteral('tokenBalance', 1) },
      { where: { eosID: 'p1' } }
    );
    assert.strictEqual(count, 1);
    assert.strictEqual((await mock.findByPk('p2')).tokenBalance, 5);
  });

  // ── The LIKE operator the Switch admin lookup depends on ────

  await runTest('caseInsensitiveLikeOp differs on postgres only', async () => {
    const { Op } = Sequelize;
    assert.strictEqual(dbFor('sqlite').caseInsensitiveLikeOp(), Op.like);
    assert.strictEqual(dbFor('mysql').caseInsensitiveLikeOp(), Op.like);
    assert.strictEqual(dbFor('postgres').caseInsensitiveLikeOp(), Op.iLike);
  });
}

// ── Run ──────────────────────────────────────────────────────

testSuite().then(() => {
  const total = passed + failed;
  console.log(`\n📊 Results: ${passed}/${total} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
