/**
 * Shared DB service for Slacker's Squad Services (S³).
 *
 * Stage 1 scope:
 * - Centralize retry+jitter lock handling for sequelize operations
 * - Provide optional SQLite mutex serialization helpers
 * - Enforce SQLite WAL pragmas once per connector
 * - Provide lightweight migration runner (no sync({ alter: true }))
 */
export default class DBService {
  constructor({
    sequelize = null,
    connectors = null,
    databaseOption = null,
    verboseLogger = () => {},
    defaultRetry = {}
  } = {}) {
    this.verboseLogger = verboseLogger;
    this.connectors = connectors || null;
    this.defaultRetry = {
      attempts: Number.isFinite(defaultRetry.attempts) ? defaultRetry.attempts : 5,
      baseDelayMs: Number.isFinite(defaultRetry.baseDelayMs) ? defaultRetry.baseDelayMs : 200,
      jitterMs: Number.isFinite(defaultRetry.jitterMs) ? defaultRetry.jitterMs : 500
    };

    this.sequelize = DBService.resolveConnector({
      sequelize,
      connectors: this.connectors,
      databaseOption
    });

    this.models = {};
    this._isMounted = false;
    this._migrations = [];
    this.MigrationsModel = null;
  }

  static resolveConnector({ sequelize = null, connectors = null, databaseOption = null } = {}) {
    if (sequelize && typeof sequelize.define === 'function') {
      return sequelize;
    }

    if (databaseOption && typeof databaseOption.define === 'function') {
      return databaseOption;
    }

    if (typeof databaseOption === 'string' && connectors && connectors[databaseOption]) {
      return connectors[databaseOption];
    }

    if (connectors && connectors.sqlite) {
      return connectors.sqlite;
    }

    return null;
  }

  static isLockError(err) {
    const message = String(err?.message || '');
    return (
      message.includes('SQLITE_BUSY') ||
      message.includes('database is locked') ||
      message.includes('Lock wait timeout exceeded') ||
      err?.name === 'SequelizeTimeoutError'
    );
  }

  static isSqlite(connector) {
    return !!(
      connector &&
      typeof connector.getDialect === 'function' &&
      connector.getDialect() === 'sqlite'
    );
  }

  static async sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  static getConnectorMutex(connector) {
    if (!connector) return null;
    if (!connector._s3_mutex) {
      connector._s3_mutex = Promise.resolve();
    }
    return connector._s3_mutex;
  }

  static async withSqliteMutex(connector, logicFn) {
    if (!connector || typeof logicFn !== 'function') {
      throw new Error('withSqliteMutex requires connector and logicFn.');
    }

    if (!DBService.isSqlite(connector)) {
      return logicFn();
    }

    const mutex = DBService.getConnectorMutex(connector);
    const resultPromise = mutex.then(() => logicFn());
    connector._s3_mutex = resultPromise.catch(() => {});
    return resultPromise;
  }

  static async executeWithRetry(connector, logicFn, retryOptions = {}) {
    if (typeof logicFn !== 'function') {
      throw new Error('executeWithRetry requires a logicFn callback.');
    }

    const attempts = Number.isFinite(retryOptions.attempts) ? retryOptions.attempts : 5;
    const baseDelayMs = Number.isFinite(retryOptions.baseDelayMs) ? retryOptions.baseDelayMs : 200;
    const jitterMs = Number.isFinite(retryOptions.jitterMs) ? retryOptions.jitterMs : 500;

    const runAttempt = async () => {
      for (let i = 1; i <= attempts; i += 1) {
        try {
          return await logicFn();
        } catch (err) {
          if (DBService.isLockError(err) && i < attempts) {
            const jitter = Math.random() * jitterMs;
            await DBService.sleep(baseDelayMs + jitter);
            continue;
          }
          throw err;
        }
      }

      return null;
    };

    return DBService.withSqliteMutex(connector, runAttempt);
  }

  static async withTransaction(connector, logicFn, { transactionOptions = null } = {}) {
    if (!connector || typeof connector.transaction !== 'function') {
      throw new Error('withTransaction requires a Sequelize connector with transaction().');
    }

    if (transactionOptions) {
      return connector.transaction(transactionOptions, logicFn);
    }

    return connector.transaction(logicFn);
  }

  static async ensureSqlitePragmas(connector) {
    if (!connector || typeof connector.query !== 'function') return false;
    if (!DBService.isSqlite(connector)) return false;
    if (connector._s3_wal_initialized) return false;

    await connector.query('PRAGMA journal_mode=WAL;');
    await connector.query('PRAGMA synchronous=NORMAL;');
    connector._s3_wal_initialized = true;
    return true;
  }

  async mount() {
    if (this._isMounted) {
      await this.unmount();
    }

    if (!this.sequelize) {
      this.verboseLogger(1, '[DB] No sequelize connector available. Service mounted in no-op mode.');
      this._isMounted = true;
      return;
    }

    await DBService.ensureSqlitePragmas(this.sequelize);
    await this._initMigrationsModel();
    await this.runMigrations();

    this._isMounted = true;
    this.verboseLogger(2, '[DB] Mounted.');
  }

  async unmount() {
    this._isMounted = false;
    this.verboseLogger(2, '[DB] Unmounted.');
  }

  getConnector() {
    return this.sequelize;
  }

  getDataTypes() {
    const dataTypes =
      this.sequelize?.constructor?.DataTypes ||
      this.sequelize?.Sequelize?.DataTypes ||
      this.sequelize?.DataTypes;

    if (!dataTypes) {
      throw new Error('DBService could not resolve Sequelize DataTypes from connector.');
    }

    return dataTypes;
  }

  async executeWithRetry(logicFn, retryOptions = {}) {
    return DBService.executeWithRetry(this.sequelize, logicFn, {
      ...this.defaultRetry,
      ...retryOptions
    });
  }

  async withTransaction(logicFn, options = {}) {
    return DBService.withTransaction(this.sequelize, logicFn, options);
  }

  async withTransactionWithRetry(logicFn, options = {}) {
    return this.executeWithRetry(() => DBService.withTransaction(this.sequelize, logicFn, options));
  }

  async ensureSqlitePragmas() {
    return DBService.ensureSqlitePragmas(this.sequelize);
  }

  defineModel(name, schema, modelOptions = {}) {
    if (!this.sequelize || typeof this.sequelize.define !== 'function') {
      throw new Error('defineModel called without a valid sequelize connector.');
    }

    if (this.models[name]) {
      return this.models[name];
    }

    const model = this.sequelize.define(name, schema, modelOptions);
    this.models[name] = model;
    return model;
  }

  registerMigration(id, runFn) {
    if (!id || typeof id !== 'string') {
      throw new Error('registerMigration requires a non-empty string id.');
    }
    if (typeof runFn !== 'function') {
      throw new Error('registerMigration requires a function runFn.');
    }

    if (this._migrations.some((m) => m.id === id)) {
      throw new Error(`Duplicate migration id: ${id}`);
    }

    this._migrations.push({ id, runFn });
    this._migrations.sort((a, b) => a.id.localeCompare(b.id));
  }

  async runMigrations() {
    if (!this.sequelize || !this.MigrationsModel) return;

    for (const migration of this._migrations) {
      const existing = await this.MigrationsModel.findByPk(migration.id);
      if (existing) continue;

      await this.withTransactionWithRetry(async (t) => {
        await migration.runFn({
          sequelize: this.sequelize,
          db: this,
          transaction: t
        });

        await this.MigrationsModel.create({
          id: migration.id,
          appliedAt: Date.now()
        }, { transaction: t });
      });

      this.verboseLogger(3, `[DB] Applied migration ${migration.id}.`);
    }
  }

  async _initMigrationsModel() {
    const DataTypes = this.getDataTypes();

    this.MigrationsModel = this.sequelize.models?.S3Migrations || this.sequelize.define(
      'S3Migrations',
      {
        id: {
          type: DataTypes.STRING,
          primaryKey: true
        },
        appliedAt: {
          type: DataTypes.BIGINT,
          allowNull: false
        }
      },
      {
        tableName: 'S3_Migrations',
        timestamps: false
      }
    );

    await this.executeWithRetry(async () => {
      await this.MigrationsModel.sync();
    });
  }
}
