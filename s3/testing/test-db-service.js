/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          DB SERVICE TEST                                     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates DBService: Sequelize initialization, table creation, CRUD
 * operations, retry logic, and dialect detection.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-db-service.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Mostly mock Sequelize — no SQLite file created, no running server
 *   required. The migration case is the exception: it runs against real
 *   in-memory SQLite, because a mock cannot answer the only question worth
 *   asking there ("did the table actually get created?").
 *
 */

import assert from 'node:assert/strict';
import Sequelize from 'sequelize';
import DBService from '../utils/db-service.js';

class MockSequelize {
  constructor({ dialect = 'sqlite' } = {}) {
    this._dialect = dialect;
    this.models = {};
    this.queryCalls = [];
    this.transactionCalls = 0;
    this.constructor.DataTypes = {
      STRING: 'STRING',
      BIGINT: 'BIGINT'
    };
  }

  getDialect() {
    return this._dialect;
  }

  async query(sql) {
    this.queryCalls.push(sql);
    return [];
  }

  define(name) {
    const rows = new Map();
    const model = {
      async sync() {},
      async findByPk(id) {
        return rows.get(id) || null;
      },
      async create(payload) {
        const row = { ...payload };
        rows.set(payload.id, row);
        return row;
      }
    };

    this.models[name] = model;
    return model;
  }

  async transaction(logicFn) {
    this.transactionCalls += 1;
    const tx = { id: this.transactionCalls };
    return logicFn(tx);
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

await runTest('executeWithRetry retries lock errors then succeeds', async () => {
  const sequelize = new MockSequelize({ dialect: 'sqlite' });

  let attempts = 0;
  const result = await DBService.executeWithRetry(sequelize, async () => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error('SQLITE_BUSY: database is locked');
    }
    return 'ok';
  }, {
    attempts: 5,
    baseDelayMs: 0,
    jitterMs: 0
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

await runTest('executeWithRetry without totalTimeoutMs never races a stuck attempt (default, unchanged behaviour)', async () => {
  const sequelize = new MockSequelize({ dialect: 'sqlite' });

  // Simulates 5 attempts each blocking on a slow connection-pool acquire — the exact
  // shape that produced a real ~301s EloTracker round-end stall. Without opting into
  // totalTimeoutMs, every existing caller must still just wait it out (no regression).
  let attempts = 0;
  const start = Date.now();
  const result = await DBService.executeWithRetry(sequelize, async () => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return 'ok';
  }, { attempts: 1, baseDelayMs: 0, jitterMs: 0 });

  assert.equal(result, 'ok');
  assert.ok(Date.now() - start >= 15, 'must have actually waited for the slow attempt');
});

await runTest('executeWithRetry with totalTimeoutMs fails fast on a stuck retry loop', async () => {
  const sequelize = new MockSequelize({ dialect: 'sqlite' });

  // Every attempt "hangs" far longer than the budget — the real-world equivalent is
  // Sequelize's connection-pool acquire() blocking under pool exhaustion. The budget
  // must trip well before 5 attempts would ever resolve on their own.
  const result = DBService.executeWithRetry(sequelize, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return 'never';
  }, { attempts: 5, baseDelayMs: 0, jitterMs: 0, totalTimeoutMs: 50 });

  await assert.rejects(result, (err) => {
    assert.equal(err.name, 'S3RetryBudgetExceededError');
    return true;
  });
});

await runTest('executeWithRetry with totalTimeoutMs still returns normally when the attempt is fast', async () => {
  const sequelize = new MockSequelize({ dialect: 'sqlite' });

  const result = await DBService.executeWithRetry(sequelize, async () => 'ok', {
    attempts: 5,
    baseDelayMs: 0,
    jitterMs: 0,
    totalTimeoutMs: 5000
  });

  assert.equal(result, 'ok');
});

await runTest('withTransactionWithRetry treats a totalTimeoutMs budget-exceeded error as a network error and engages backoff', async () => {
  const sequelize = new MockSequelize({ dialect: 'sqlite' });
  const db = new DBService({ sequelize });

  // withTransactionWithRetry rethrows like any other DB error — callers (every real
  // one in this repo) wrap it in their own try/catch and return null. What matters
  // here is that the rejection is classified as a network error so backoff engages.
  await assert.rejects(
    db.withTransactionWithRetry(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return 'never';
    }, { totalTimeoutMs: 50 }),
    (err) => err.name === 'S3RetryBudgetExceededError'
  );
  assert.ok(db.shouldSkipDb(), 'budget-exceeded must engage the same network backoff as a real connection failure');
});

await runTest('SQLite mutex serializes concurrent operations', async () => {
  const sequelize = new MockSequelize({ dialect: 'sqlite' });

  const order = [];

  const p1 = DBService.executeWithRetry(sequelize, async () => {
    order.push('start-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('end-1');
    return 1;
  }, {
    attempts: 1,
    baseDelayMs: 0,
    jitterMs: 0
  });

  const p2 = DBService.executeWithRetry(sequelize, async () => {
    order.push('start-2');
    order.push('end-2');
    return 2;
  }, {
    attempts: 1,
    baseDelayMs: 0,
    jitterMs: 0
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});

await runTest('Non-SQLite mutex allows concurrent operations (no serialization)', async () => {
  const sequelize = new MockSequelize({ dialect: 'postgres' });

  const order = [];

  const p1 = DBService.executeWithRetry(sequelize, async () => {
    order.push('start-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('end-1');
    return 1;
  }, {
    attempts: 1,
    baseDelayMs: 0,
    jitterMs: 0
  });

  const p2 = DBService.executeWithRetry(sequelize, async () => {
    order.push('start-2');
    order.push('end-2');
    return 2;
  }, {
    attempts: 1,
    baseDelayMs: 0,
    jitterMs: 0
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  // Non-SQLite connectors should allow concurrent execution (no mutex serialization)
  assert.deepEqual(order, ['start-1', 'start-2', 'end-2', 'end-1']);
});

await runTest('ensureSqlitePragmas applies once per connector', async () => {
  const sequelize = new MockSequelize({ dialect: 'sqlite' });

  const first = await DBService.ensureSqlitePragmas(sequelize);
  const second = await DBService.ensureSqlitePragmas(sequelize);

  assert.equal(first, true);
  assert.equal(second, false);
  assert.deepEqual(sequelize.queryCalls, [
    'PRAGMA journal_mode=WAL;',
    'PRAGMA synchronous=NORMAL;'
  ]);
});

await runTest('runMigrations applies a registered migration exactly once', async () => {
  // This case used to call db.registerMigration() and db.runMigrations() —
  // neither of which has ever existed on DBService. Migrations live on the
  // MigrationEngine (db.migrationEngine.registerMigrations(plugin, [...])),
  // so the case threw TypeError on its first line and had been asserting
  // nothing at all. It also predates the confirmation gate: without a
  // confirmToken() the engine refuses to run and reports zero applied.
  //
  // Real in-memory SQLite rather than MockSequelize: a mock cannot tell you
  // whether the DDL landed, and "the table exists afterwards" is the only
  // assertion here worth making.
  const sequelize = new Sequelize.Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false
  });
  const db = new DBService({
    sequelize,
    verboseLogger: () => {},
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });

  await db.mount();
  db.migrationEngine.confirmToken('__force__');

  let upCalls = 0;
  db.migrationEngine.registerMigrations('test-db-service', [
    {
      version: 1,
      description: 'create the probe table',
      touches: { creates: ['DbServiceProbe'] },
      up: async (qi) => {
        upCalls += 1;
        await qi.createTable('DbServiceProbe', {
          id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true },
          label: { type: Sequelize.DataTypes.STRING }
        });
      }
    }
  ]);

  const first = await db.migrationEngine.runMigrations('test-db-service');
  assert.equal(first.applied, 1);
  assert.equal(upCalls, 1);

  const tables = (await sequelize.getQueryInterface().showAllTables())
    .map((t) => (typeof t === 'string' ? t : t.tableName));
  assert.ok(tables.includes('DbServiceProbe'), 'the migration reported success but created no table');

  // Second run is a no-op: the recorded version says v1 is already applied.
  const second = await db.migrationEngine.runMigrations('test-db-service');
  assert.equal(second.applied, 0);
  assert.equal(upCalls, 1);

  await db.unmount();
});

await runTest('ensureIndexes creates missing indexes and is idempotent on re-run', async () => {
  // Real in-memory SQLite, same reasoning as the migration case above: a mock
  // cannot answer "did the index actually land," which is the whole point.
  const sequelize = new Sequelize.Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false
  });
  const db = new DBService({ sequelize, verboseLogger: () => {} });
  await db.mount();

  const qi = sequelize.getQueryInterface();
  await qi.createTable('EnsureIndexesProbe', {
    id: { type: Sequelize.DataTypes.INTEGER, primaryKey: true },
    matchId: { type: Sequelize.DataTypes.STRING },
    ts: { type: Sequelize.DataTypes.BIGINT }
  });

  const indexes = [
    { name: 'idx_eip_matchId', fields: ['matchId'] },
    { name: 'idx_eip_ts', fields: ['ts'] }
  ];

  await db.ensureIndexes('EnsureIndexesProbe', indexes);
  let names = (await qi.showIndex('EnsureIndexesProbe')).map((i) => i.name);
  assert.ok(names.includes('idx_eip_matchId'), 'idx_eip_matchId was not created');
  assert.ok(names.includes('idx_eip_ts'), 'idx_eip_ts was not created');

  // Re-run: showIndex() already reports both, so this must be a no-op, not an
  // error from re-declaring an index that already exists.
  await db.ensureIndexes('EnsureIndexesProbe', indexes);
  names = (await qi.showIndex('EnsureIndexesProbe')).map((i) => i.name);
  assert.equal(names.filter((n) => n === 'idx_eip_matchId').length, 1, 'index was duplicated on re-run');
  assert.equal(names.filter((n) => n === 'idx_eip_ts').length, 1, 'index was duplicated on re-run');

  await db.unmount();
});

await runTest('ensureIndexes logs and continues past a failed CREATE INDEX rather than throwing', async () => {
  // No such table exists, so the CREATE INDEX itself fails (whether or not
  // showIndex() throws first depends on dialect — SQLite tolerates PRAGMA
  // index_list on a missing table). Either way this must never propagate:
  // a missing index is a query-performance concern, not a correctness one.
  const sequelize = new Sequelize.Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false
  });
  const warnings = [];
  const db = new DBService({
    sequelize,
    verboseLogger: (level, msg) => warnings.push(msg)
  });
  await db.mount();

  await db.ensureIndexes('NoSuchTable', [{ name: 'idx_nst_x', fields: ['x'] }]);

  assert.ok(
    warnings.some((m) => m.includes('Failed to create index')),
    'expected a logged failure, got: ' + JSON.stringify(warnings)
  );

  await db.unmount();
});

if (!process.exitCode) {
  console.log('\nAll db-service tests passed.');
}
