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

if (!process.exitCode) {
  console.log('\nAll db-service tests passed.');
}
