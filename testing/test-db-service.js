import assert from 'node:assert/strict';
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

await runTest('runMigrations applies pending migrations once', async () => {
  const sequelize = new MockSequelize({ dialect: 'sqlite' });
  const db = new DBService({
    sequelize,
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });

  let counter = 0;
  db.registerMigration('2026-06-21-001-initial', async () => {
    counter += 1;
  });

  await db.mount();
  assert.equal(counter, 1);

  await db.runMigrations();
  assert.equal(counter, 1);

  await db.unmount();
});

if (!process.exitCode) {
  console.log('\nAll db-service tests passed.');
}
