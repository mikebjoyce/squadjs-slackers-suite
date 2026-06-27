/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               DB SERVICE                                     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Centralises Sequelize connector management with SQLite-specific
 * retry+jitter locking, WAL pragma enforcement, mutex serialization,
 * per-plugin schema version tracking, and a MigrationEngine for
 * applying version-ordered schema migrations. Provides a uniform
 * database interface for all S³ services and plugin consumers.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * DBService (class, default)
 *   mount()                     — Initialises Sequelize, runs WAL pragmas,
 *                                  inits SchemaVersion model, verifies versions.
 *   unmount()                   — Resets mounted state.
 *   isReady()                   — Returns true when service is mounted.
 *   getConnector()              — Returns the underlying Sequelize instance.
 *   getConnectorName()          — Returns dialect name or connector label.
 *   getDataTypes()              — Resolves Sequelize DataTypes from connector.
 *   getDatabasePath()           — Returns the SQLite file path used for backup.
 *   defineModel(name, schema, opts) — Defines and caches a Sequelize model.
 *   registerExpectedVersion(pluginName, version) — Declares a plugin's expected
 *                                  schema version for verification.
 *   verifySchemaVersions()      — Returns { upToDate, pending } comparing
 *                                  registered expected versions against DB.
 *   get migrationEngine()       — Returns the MigrationEngine instance.
 *   executeWithRetry(fn, opts)  — Wraps logicFn with retry+jitter, SQLite-mutexed.
 *   withTransaction(fn, opts)   — Executes logicFn inside a Sequelize transaction.
 *   withTransactionWithRetry(fn, opts) — Transaction with retry+jitter.
 *   ensureSqlitePragmas()       — Enforces WAL + synchronous=NORMAL on SQLite.
 *   Static: resolveConnector(), isLockError(), isSqlite(),
 *           withConnectorMutex(), withSqliteMutex(),
 *           executeWithRetry(), withTransaction(),
 *           ensureSqlitePragmas(), sleep(), getConnectorMutex()
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * MigrationEngine (../utils/migration-engine.js)
 *   Per-plugin migration runner with transaction-safe up/down.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Falls back to no-op mode when no Sequelize connector is available.
 * - SchemaVersion enables per-plugin version tracking (replaces old
 *   flat S3_Migrations table from Stage 7.4b).
 * - The MigrationEngine does NOT auto-run on startup — migrations are
 *   gated behind Discord confirmation (7.4d).
 * - SQLite operations are serialized through a per-connector mutex to
 *   prevent concurrent write contention.
 * - Retry defaults: 5 attempts, 200ms base delay, 500ms jitter.
 * - Backup/migration assumes a single shared SQLite file. On mount, a
 *   diagnostic checks for multiple SQLite storage paths in the connectors
 *   map and warns if backup/migration coverage is partial. See getDatabasePath().
 *
 */
import MigrationEngine from './migration-engine.js';

export default class DBService {
  constructor({
    sequelize = null,
    connectors = null,
    databaseOption = null,
    verboseLogger = () => {},
    defaultRetry = {},
    server = null
  } = {}) {
    this.verboseLogger = verboseLogger;
    this.connectors = connectors || null;
    this.server = server;
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

    this._databaseOption = databaseOption ?? null;

    this.models = {};
    this._isMounted = false;
    this.SchemaVersionsModel = null;
    this._expectedVersions = new Map();
    this._migrationEngine = null;
    this._dbPath = null; // 7.4e: SQLite file path for backup (resolved on mount)

    // 7.4d — Migration gate: pending list + promise for consumer wait
    this._pendingMigrations = null;     // null = no check done, [] = up-to-date, array = pending
    this._migrationGate = null;         // Promise that consumers await
    this._resolveMigrationGateFn = null; // Resolver for the gate
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

  static async withConnectorMutex(connector, logicFn) {
    if (!connector || typeof logicFn !== 'function') {
      throw new Error('withConnectorMutex requires connector and logicFn.');
    }

    const mutex = DBService.getConnectorMutex(connector);
    const resultPromise = mutex.then(() => logicFn());
    connector._s3_mutex = resultPromise.catch(() => {});
    return resultPromise;
  }

  static async withSqliteMutex(connector, logicFn) {
    if (!connector || typeof logicFn !== 'function') {
      throw new Error('withSqliteMutex requires connector and logicFn.');
    }

    if (!DBService.isSqlite(connector)) {
      return logicFn();
    }

    return DBService.withConnectorMutex(connector, logicFn);
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

    // Only serialize for SQLite connectors; other dialects handle concurrency internally.
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

  /* ────────────────────────────────────── PUBLIC ACCESSORS ────────────────────────────────────── */

  /**
   * Get the MigrationEngine instance. Created lazily on first mount.
   * @returns {import('./migration-engine.js').default|null}
   */
  get migrationEngine() {
    return this._migrationEngine;
  }

  /**
   * The SQLite storage path used by the backup/migration system.
   * Returns null if no SQLite connector is available or if the path
   * could not be resolved from the connector config.
   *
   * Consumer plugins that need to know "where is the DB file" should
   * call this method rather than reading `sequelize.config.storage`
   * directly, because the connector may be a raw config object (not
   * a fully-initialised Sequelize instance), in which case `storage`
   * lives at the root level.
   *
   * @returns {string|null}
   */
  getDatabasePath() {
    return this._dbPath;
  }

  /* ────────────────────────────────────── LIFECYCLE ────────────────────────────────────── */

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

    // Initialise SchemaVersion table (per-plugin version tracking, replaces old S3_Migrations)
    await this._initSchemaVersionModel();

    // 7.4e: Extract SQLite storage path from connector config for backup.
    // The connector may be a raw config object (e.g. { dialect, storage })
    // returned via the string-key resolver branch, OR a fully-initialised
    // Sequelize instance (which nests storage under .config.storage).
    this._dbPath = this.sequelize?.config?.storage || this.sequelize?.storage || null;

    // 7.4k-2: Multi-SQLite diagnostic — warn if connectors map contains
    // multiple SQLite storage paths. Backup/migration only covers the
    // primary connector, so other files' tables would be invisible.
    this._logMultiSqliteWarning();

    // Create MigrationEngine instance
    this._migrationEngine = new MigrationEngine({
      dbService: this,
      verboseLogger: this.verboseLogger,
      server: this.server,
      dbPath: this._dbPath
    });

    // Verify schema versions (logs pending migrations but does NOT auto-run)
    await this._verifySchemaVersions();

    this._isMounted = true;
    this.verboseLogger(2, '[DB] Mounted.');
  }

  async unmount() {
    this._migrationEngine = null;
    this._isMounted = false;
    this._dbPath = null;
    this.verboseLogger(2, '[DB] Unmounted.');
  }

  /* ────────────────────────────────────── CONNECTOR METHODS ────────────────────────────────────── */

  getConnector() {
    return this.sequelize;
  }

  isReady() {
    return this._isMounted;
  }

  getConnectorName() {
    if (typeof this._databaseOption === 'string') {
      return this._databaseOption;
    }
    if (this.sequelize && typeof this.sequelize.getDialect === 'function') {
      return this.sequelize.getDialect();
    }
    return this.sequelize ? 'sequelize' : null;
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

  /* ────────────────────────────────────── DELEGATED HELPERS ────────────────────────────────────── */

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

  /* ────────────────────────────────────── SCHEMA VERSION PUBLIC API ────────────────────────────────────── */

  /**
   * Register a plugin's expected schema version.
   * Called by consumer plugins during their own mount/init to declare
   * their expected schema version. This is used by verifySchemaVersions()
   * to detect pending migrations.
   *
   * @param {string} pluginName - Unique plugin identifier
   * @param {number} version    - Expected schema version (positive integer)
   */
  registerExpectedVersion(pluginName, version) {
    if (!pluginName || typeof pluginName !== 'string') {
      throw new Error('registerExpectedVersion requires a non-empty pluginName string.');
    }
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`registerExpectedVersion for "${pluginName}" requires a non-negative integer version, got ${version}.`);
    }

    this._expectedVersions.set(pluginName, version);
    this.verboseLogger(3, `[DB] Registered expected version v${version} for "${pluginName}".`);
  }

  /**
   * Verify all registered plugin schema versions against the DB.
   * Does NOT run migrations — only reports the diff.
   *
   * @returns {Promise<{upToDate: boolean, pending: Array<{pluginName: string, currentVersion: number, expectedVersion: number}>}>}
   */
  async verifySchemaVersions() {
    if (!this.SchemaVersionsModel) {
      return { upToDate: true, pending: [] };
    }

    const pending = [];

    for (const [pluginName, expectedVersion] of this._expectedVersions) {
      try {
        const row = await this.SchemaVersionsModel.findOne({ where: { pluginName } });
        const currentVersion = row ? row.version : 0;

        if (currentVersion < expectedVersion) {
          pending.push({
            pluginName,
            currentVersion,
            expectedVersion,
            behind: expectedVersion - currentVersion
          });
        }
      } catch (err) {
        this.verboseLogger(1, `[DB] Error checking version for "${pluginName}": ${err.message}`);
        pending.push({
          pluginName,
          currentVersion: -1,
          expectedVersion,
          error: err.message
        });
      }
    }

    return { upToDate: pending.length === 0, pending };
  }

  /* ────────────────────────────────────── 7.4d MIGRATION GATE API ────────────────────────────────────── */

  /**
   * Check if there are pending schema migrations that require human approval.
   * Returns null if verification has not been run yet, an empty array if
   * everything is up to date, or an array of pending migration descriptors.
   *
   * Consumer plugins call this before running sync({ alter: true }) to decide
   * whether to skip their DB init until after migrations complete.
   *
   * @returns {Array<{pluginName: string, currentVersion: number, expectedVersion: number, behind: number}>|null}
   */
  getPendingMigrations() {
    return this._pendingMigrations;
  }

  /**
   * Wait for pending migrations to be resolved (confirmed, cancelled, or timed out).
   * If no migrations are pending, returns immediately.
   * Consumer plugins can await this before running sync({ alter: true }).
   *
   * @returns {Promise<void>}
   */
  async waitForMigrations() {
    // No gate was created — either up-to-date or no check yet
    if (!this._migrationGate) return;
    // If check already ran and found nothing, the gate resolves instantly
    if (this._pendingMigrations !== null && this._pendingMigrations.length === 0) return;
    await this._migrationGate;
  }

  /**
   * Resolve the migration gate, unblocking consumer plugins that are awaiting
   * waitForMigrations(). Called by the Discord confirmation handler after
   * migrations complete, are cancelled, or time out.
   *
   * @param {boolean} [wasApplied=false] - If true, pending migrations were applied
   */
  _resolveMigrationGate(wasApplied = false) {
    if (this._resolveMigrationGateFn) {
      this._resolveMigrationGateFn();
      this._resolveMigrationGateFn = null;
    }
    if (wasApplied) {
      this._pendingMigrations = []; // Clear pending — they're applied now
    }
    this._migrationGate = null;
    this.verboseLogger(2, `[DB] Migration gate resolved (wasApplied=${wasApplied}). Consumer plugins unblocked.`);
  }

  /* ────────────────────────────────────── INTERNAL ────────────────────────────────────── */

  /**
   * Initialise the S3_SchemaVersions table (per-plugin version tracking).
   * Replaces the old flat S3_Migrations table.
   */
  async _initSchemaVersionModel() {
    const DataTypes = this.getDataTypes();

    this.SchemaVersionsModel = this.sequelize.models?.S3SchemaVersions || this.sequelize.define(
      'S3SchemaVersions',
      {
        id: {
          type: DataTypes.INTEGER,
          primaryKey: true,
          autoIncrement: true
        },
        pluginName: {
          type: DataTypes.STRING,
          allowNull: false,
          unique: true
        },
        version: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0
        },
        appliedAt: {
          type: DataTypes.BIGINT,
          allowNull: false
        },
        migrationHash: {
          type: DataTypes.STRING,
          allowNull: false
        },
        description: {
          type: DataTypes.STRING,
          allowNull: true
        }
      },
      {
        tableName: 'S3_SchemaVersions',
        timestamps: false
      }
    );

    await this.executeWithRetry(async () => {
      await this.SchemaVersionsModel.sync();
    });

    this.verboseLogger(3, '[DB] Initialised S3_SchemaVersions table.');
  }

  /**
   * Verify registered schema versions on mount and log any pending migrations.
   * Stores the result in _pendingMigrations and creates the migration gate
   * promise so consumer plugins can await waitForMigrations().
   * Does NOT auto-trigger migrations — that is gated behind 7.4d (Discord confirmation).
   * The Discord prompt is fired later (after Discord registers) via _checkAndPromptMigrations().
   */
  async _verifySchemaVersions() {
    const result = await this.verifySchemaVersions();

    if (result.upToDate) {
      if (this._expectedVersions.size > 0) {
        this.verboseLogger(3, '[DB] All plugin schema versions are up to date.');
      } else {
        this.verboseLogger(3, '[DB] No plugin schema versions registered yet — deferring version check.');
      }
      this._pendingMigrations = [];
      return;
    }

    // Store pending migrations for the Discord prompt (7.4d)
    this._pendingMigrations = result.pending;

    // Create migration gate — consumer plugins can await this before sync({ alter: true })
    this._migrationGate = new Promise((resolve) => {
      this._resolveMigrationGateFn = resolve;
    });

    this.verboseLogger(2, `[DB] ${result.pending.length} plugin(s) have pending schema migrations. Gate created.`);
    for (const p of result.pending) {
      this.verboseLogger(2, `  "${p.pluginName}": v${p.currentVersion || '(new)'} → v${p.expectedVersion} (${p.behind} behind)`);
    }

    this.verboseLogger(2, '[DB] Migrations are NOT auto-applied. Waiting for Discord confirmation (see 7.4d).');
  }

  /**
   * Scan all connectors in the connectors map for SQLite storage paths.
   * If multiple unique storage paths are found, log a warning that
   * backup/migration coverage is partial — only the primary connector
   * file is backed up before schema migrations.
   *
   * This is a diagnostic-only check. It does not block mount.
   */
  _logMultiSqliteWarning() {
    if (!this.connectors || typeof this.connectors !== 'object') return;

    const sqlitePaths = new Set();

    for (const [key, value] of Object.entries(this.connectors)) {
      if (!value || typeof value !== 'object') continue;

      // A SQLite-like connector has either a dialect of 'sqlite' or a 'storage' property
      const isSqliteLike = value.dialect === 'sqlite' || typeof value.storage === 'string';
      if (!isSqliteLike) continue;

      const storage = value.storage || value.config?.storage;
      if (typeof storage === 'string') {
        sqlitePaths.add(storage);
      }
    }

    // Remove the primary path from the set — we only warn about OTHER paths
    sqlitePaths.delete(this._dbPath);

    if (sqlitePaths.size > 0) {
      const primary = this._dbPath || '(unknown)';
      const others = [...sqlitePaths].join(', ');
      this.verboseLogger(
        1,
        `[DB] WARNING: Multiple SQLite storage paths detected. ` +
        `Backup and migration only cover "${primary}". ` +
        `Tables in other files (${others}) will be skipped. ` +
        `All S³-managed plugins should share the same database connector.`
      );
    }
  }
}