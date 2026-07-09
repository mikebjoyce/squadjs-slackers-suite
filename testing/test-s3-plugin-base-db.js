/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       S³ PLUGIN BASE DB CONVENIENCE TEST                     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Tests S3PluginBase database convenience methods: defineModel(),
 * registerExpectedVersion(), registerMigrations(), verifyAndRun-
 * Migrations(), _getModel(), _withDb().
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node SlackersSquadServices/testing/test-s3-plugin-base-db.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Uses DBService with in-memory SQLite — no files created.
 * - Does NOT require a running SquadJS server.
 *
 */

import assert from 'node:assert/strict';
import DBService from '../utils/db-service.js';
import MigrationEngine from '../utils/migration-engine.js';
import { Sequelize } from 'sequelize';

// ── S3PluginBase stub (only DB-relevant methods) ────────────────
// Same pattern as the lifecycle test, but we wire a real DBService

class S3PluginBaseDbStub {
  constructor(server, options, connectors) {
    this.server = server;
    this.options = options;
    this.connectors = connectors;
    this._s3 = null;
    this._s3db = null;
  }

  verbose(level, msg) {
    // no-op in tests
  }

  // ── DB Convenience (copied from s3-plugin-base.js) ────────

  defineModel(name, schema, opts = {}) {
    if (!this._s3db || typeof this._s3db.isReady !== 'function' || !this._s3db.isReady()) {
      return null;
    }
    return this._s3db.defineModel(name, schema, opts);
  }

  registerExpectedVersion(pluginName, version) {
    if (!this._s3db || typeof this._s3db.registerExpectedVersion !== 'function') {
      return;
    }
    this._s3db.registerExpectedVersion(pluginName, version);
  }

  registerMigrations(pluginName, migrations) {
    if (!this._s3db || !this._s3db.migrationEngine) {
      return;
    }
    this._s3db.migrationEngine.registerMigrations(pluginName, migrations);
  }

  async verifyAndRunMigrations(pluginName) {
    if (!this._s3db || typeof this._s3db.isReady !== 'function' || !this._s3db.isReady()) {
      return null;
    }
    const recheck = await this._s3db.verifySchemaVersions();
    if (!recheck.upToDate) {
      this._s3db.migrationEngine.confirmToken('__auto__');
      const result = await this._s3db.migrationEngine.runMigrations(pluginName);
      return result;
    }
    return null;
  }

  _getModel(name) {
    return this._s3db?.models?.[name] || null;
  }

  async _withDb(fn) {
    if (!this._s3db || typeof this._s3db.isReady !== 'function' || !this._s3db.isReady()) {
      return null;
    }
    try {
      return await this._s3db.withTransactionWithRetry(fn);
    } catch (err) {
      this.verbose(1, `[DB] Error in _withDb: ${err.message}`);
      return null;
    }
  }
}

// ── Test harness ─────────────────────────────────────────────────

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

// ── Helpers ──────────────────────────────────────────────────────

async function createDbService() {
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false,
    define: { freezeTableName: true }
  });
  await sequelize.authenticate();

  const db = new DBService({
    sequelize,
    defaultRetry: { attempts: 2, baseDelayMs: 0, jitterMs: 0 }
  });
  await db.mount();
  return db;
}

// ── Tests ────────────────────────────────────────────────────────

async function main() {

  // ──────────────────────────────────────
  // 1. defineModel() creates and registers a model
  // ──────────────────────────────────────
  await runTest('defineModel() creates and registers a model', async () => {
    const db = await createDbService();
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = db;

    const model = plugin.defineModel('Test_Table1', {
      name: { type: 'STRING' },
      value: { type: 'INTEGER' }
    }, { tableName: 'test_table1' });

    assert.ok(model, 'model should be returned');
    assert.equal(db.models.Test_Table1, model, 'model should be registered on db.models');
    assert.equal(plugin._getModel('Test_Table1'), model, '_getModel should return the model');
  });

  // ──────────────────────────────────────
  // 2. defineModel() returns null when DB is not ready
  // ──────────────────────────────────────
  await runTest('defineModel() returns null when DB is not ready', () => {
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = null;

    const result = plugin.defineModel('Test_Table2', { name: { type: 'STRING' } });
    assert.equal(result, null);
  });

  // ──────────────────────────────────────
  // 3. registerExpectedVersion() stores version
  // ──────────────────────────────────────
  await runTest('registerExpectedVersion() stores expected version', async () => {
    const db = await createDbService();
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = db;

    plugin.registerExpectedVersion('test-plugin', 2);
    const versions = await db.verifySchemaVersions();
    assert.equal(versions.pending.length, 1);
    assert.equal(versions.pending[0].pluginName, 'test-plugin');
    assert.equal(versions.pending[0].expectedVersion, 2);
  });

  // ──────────────────────────────────────
  // 4. registerExpectedVersion() is inert when no DB
  // ──────────────────────────────────────
  await runTest('registerExpectedVersion() is inert when _s3db is null', () => {
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = null;

    // Should not throw
    plugin.registerExpectedVersion('test-plugin', 2);
  });

  // ──────────────────────────────────────
  // 5. registerMigrations() registers via migrationEngine
  // ──────────────────────────────────────
  await runTest('registerMigrations() registers migrations with engine', async () => {
    const db = await createDbService();
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = db;

    let migrationRan = false;
    plugin.registerMigrations('test-plugin', [{
      version: 1,
      description: 'Initial schema',
      up: async (qi) => {
        migrationRan = true;
        await qi.createTable('test_mig_table', {
          id: { type: 'INTEGER', primaryKey: true }
        });
      },
      down: async (qi) => {
        await qi.dropTable('test_mig_table');
      }
    }]);

    plugin.registerExpectedVersion('test-plugin', 1);
    await plugin.verifyAndRunMigrations('test-plugin');
    assert.equal(migrationRan, true);

    // Verify table was created
    const tableNames = await db.sequelize.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='test_mig_table'",
      { type: 'SELECT' }
    );
    assert.equal(tableNames.length, 1);
  });

  // ──────────────────────────────────────
  // 6. registerMigrations() is inert when no DB/engine
  // ──────────────────────────────────────
  await runTest('registerMigrations() is inert when no migrationEngine', () => {
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = { migrationEngine: null };

    // Should not throw
    plugin.registerMigrations('test-plugin', [{
      version: 1,
      description: 'test',
      up: async () => {},
      down: async () => {}
    }]);
  });

  // ──────────────────────────────────────
  // 7. verifyAndRunMigrations() returns null when already up to date
  // ──────────────────────────────────────
  await runTest('verifyAndRunMigrations() returns null when already up to date', async () => {
    const db = await createDbService();
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = db;

    // Register and run v1
    plugin.registerMigrations('test-plugin2', [{
      version: 1,
      description: 'Initial',
      up: async (qi) => {
        await qi.createTable('test_t2', {
          id: { type: 'INTEGER', primaryKey: true }
        });
      },
      down: async (qi) => { await qi.dropTable('test_t2'); }
    }]);
    plugin.registerExpectedVersion('test-plugin2', 1);
    await plugin.verifyAndRunMigrations('test-plugin2');

    // Run again — should return null (already up to date)
    const result = await plugin.verifyAndRunMigrations('test-plugin2');
    assert.equal(result, null);
  });

  // ──────────────────────────────────────
  // 8. verifyAndRunMigrations() returns null when no DB
  // ──────────────────────────────────────
  await runTest('verifyAndRunMigrations() returns null when no DB', async () => {
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = null;

    const result = await plugin.verifyAndRunMigrations('test-plugin');
    assert.equal(result, null);
  });

  // ──────────────────────────────────────
  // 9. _getModel() returns null for unknown models
  // ──────────────────────────────────────
  await runTest('_getModel() returns null for unknown model names', async () => {
    const db = await createDbService();
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = db;

    const result = plugin._getModel('NonExistentModel');
    assert.equal(result, null);
  });

  // ──────────────────────────────────────
  // 10. _withDb() executes a function inside a transaction
  // ──────────────────────────────────────
  await runTest('_withDb() executes function inside a transaction', async () => {
    const db = await createDbService();
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = db;

    const result = await plugin._withDb(async (transaction) => {
      assert.ok(transaction, 'transaction object should be passed');
      return 'tx-result';
    });

    assert.equal(result, 'tx-result');
  });

  // ──────────────────────────────────────
  // 11. _withDb() returns null when DB not ready
  // ──────────────────────────────────────
  await runTest('_withDb() returns null when DB not ready', async () => {
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = null;

    const result = await plugin._withDb(async () => 'should-not-run');
    assert.equal(result, null);
  });

  // ──────────────────────────────────────
  // 12. _withDb() returns null on error (does not throw)
  // ──────────────────────────────────────
  await runTest('_withDb() returns null on error instead of throwing', async () => {
    const db = await createDbService();
    const plugin = new S3PluginBaseDbStub(null, {}, {});
    plugin._s3db = db;

    const result = await plugin._withDb(async () => {
      throw new Error('simulated DB error');
    });

    assert.equal(result, null);
  });

}

await main();

if (!process.exitCode) {
  console.log('\nAll s3-plugin-base DB tests passed.');
}