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
 *   acquireAdvisoryLock(key, timeoutMs) — Acquire cross-process advisory lock
 *   releaseAdvisoryLock(key)            — Release advisory lock
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
 *   flat S3_Migrations table pattern).
 * - The MigrationEngine does NOT auto-run on startup — migrations are
 *   gated behind Discord confirmation or the autoMigrate config option.
 * - SQLite operations are serialized through a per-connector mutex to
 *   prevent concurrent write contention.
 * - Retry defaults: 5 attempts, 200ms base delay, 500ms jitter.
 * - Backup/migration assumes a single shared SQLite file. On mount, a
 *   diagnostic checks for multiple SQLite storage paths in the connectors
 *   map and warns if backup/migration coverage is partial. See getDatabasePath().
 * - getModelNames() returns all Sequelize model names registered with
 *   defineModel(), used by s3-export-import.js for backup/restore.
 * - canBackup(connector) returns true for all connectors, enabling the
 *   connector-agnostic JSON export/import fallback in s3-export-import.js.
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
    this._pluginModels = new Map();     // pluginName → model name array (for drift detection)
    this._migrationEngine = null;
    this._dbPath = null; // SQLite file path for backup (resolved on mount)

    // Migration gate: pending list + promise for consumer wait
    this._pendingMigrations = null;     // null = no check done, [] = up-to-date, array = pending
    this._lastDriftResult = null;       // result of the last verifyLiveSchema() call (cached for !s3 diag display)
    this._migrationGate = null;         // Promise that consumers await
    this._resolveMigrationGateFn = null; // Resolver for the gate

    // Network backoff — after a network-level DB failure, all calls return null
    // for a cooldown period rather than retrying on every tick.
    this._networkErrorBackoff = null;   // null = no backoff, timestamp = skip until
    this._networkErrorBackoffMs = 30000; // 30-second cooldown

    // Unhandled-rejection safety net for Sequelize-internal promise leaks
    this._unhandledRejectionHandler = null;
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

  /* ───── Network error recovery: retry network errors ───── */
  static NETWORK_ERROR_SUBSTRINGS = [
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ECONNRESET',
    'EPIPE'
  ];

  static NETWORK_ERROR_NAMES = new Set([
    'SequelizeConnectionError',
    'SequelizeConnectionRefusedError',
    'SequelizeHostNotFoundError',
    'SequelizeHostNotReachableError',
    'SequelizeConnectionAcquireTimeoutError'
  ]);

  static isNetworkError(err) {
    if (!err) return false;
    const message = String(err.message || '');
    if (DBService.NETWORK_ERROR_SUBSTRINGS.some((s) => message.includes(s))) {
      return true;
    }
    return DBService.NETWORK_ERROR_NAMES.has(err?.name);
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
          if ((DBService.isLockError(err) || DBService.isNetworkError(err)) && i < attempts) {
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

    // Sequelize on MySQL may leak an unhandled rejection from its connection
    // pool when the DB is unreachable. The outer promise still rejects correctly
    // — this catch prevents the duplicate UnhandledPromiseRejectionWarning.
    const tx = connector.transaction(logicFn);
    if (tx && typeof tx.catch === 'function') {
      tx.catch(() => {});
    }
    return tx;
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

  /**
   * Get the last schema drift detection result.
   * Returns null if no check has been run yet.
   * @returns {Array<{pluginName: string, table: string, model?: string, missing?: string[], extra?: string[], error?: string}>|null}
   */
  getLastDriftResult() {
    return this._lastDriftResult;
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

    // Resolve the SQLite storage path from the raw connector config.
    // Used for fast file-copy backup optimization. The connectors map always
    // holds the raw config from config.json. Non-SQLite connectors (Postgres,
    // MySQL) have no `storage` property → null → MigrationEngine falls back to
    // connector-agnostic JSON export (s3-export-import.js) for pre-migration backup.
    this._dbPath = this.connectors?.[this._databaseOption]?.storage || null;

    // Multi-SQLite diagnostic — warn if connectors map contains
    // multiple SQLite storage paths. Backup/migration only covers the
    // primary connector, so other files' tables would be invisible.
    this._logMultiSqliteWarning();

    // Create MigrationEngine instance
    this._migrationEngine = new MigrationEngine({
      dbService: this,
      verboseLogger: this.verboseLogger,
      dbPath: this._dbPath
    });

    // Verify schema versions (logs pending migrations but does NOT auto-run)
    await this._verifySchemaVersions();

    // Safety net for Sequelize-internal unhandled rejections.
    // When the DB is unreachable, Sequelize's connection pool may leak
    // rejections that aren't chained to any consumer promise. This handler
    // catches those at the process level and logs them at level 4 (debug).
    this._unhandledRejectionHandler = (reason) => {
      if (
        reason &&
        (DBService.isNetworkError(reason) || reason.name === 'SequelizeConnectionError')
      ) {
        this.verboseLogger(4, `[DB] Suppressed unhandled rejection (Sequelize internal): ${reason?.message || reason}`);
      }
    };
    process.on('unhandledRejection', this._unhandledRejectionHandler);

    this._isMounted = true;
    this.verboseLogger(2, '[DB] Mounted.');
  }

  async unmount() {
    if (this._unhandledRejectionHandler) {
      process.removeListener('unhandledRejection', this._unhandledRejectionHandler);
      this._unhandledRejectionHandler = null;
    }
    this._migrationEngine = null;
    this._isMounted = false;
    this._dbPath = null;
    this._networkErrorBackoff = null;
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

  /**
   * Acquire an advisory lock scoped to a logical key (e.g. 's3_migrate_s3-players').
   * Prevents concurrent execution of critical sections across multiple processes.
   *
   * - SQLite: already serialized by _s3_mutex — returns true immediately.
   * - Postgres: uses pg_try_advisory_lock(hashtext(key)) — non-blocking, returns false if held.
   * - MySQL: uses GET_LOCK(key, timeout) — waits up to timeoutMs.
   *
   * @param {string} key        - Logical lock name (e.g. 's3_migrate_s3-players')
   * @param {number} [timeoutMs=30000] - Max wait time in ms (MySQL only; Postgres is non-blocking)
   * @returns {Promise<boolean>} True if lock was acquired, false otherwise
   */
  async acquireAdvisoryLock(key, timeoutMs = 30000) {
    if (!this.sequelize || typeof this.sequelize.query !== 'function') {
      this.verboseLogger(2, `[DB] acquireAdvisoryLock("${key}"): no connector — returning true (no-op mode).`);
      return true;
    }

    const dialect = this.getConnectorName();

    // SQLite: already fully serialized by _s3_mutex promise chain.
    // No additional lock needed — return true immediately.
    if (dialect === 'sqlite') {
      return true;
    }

    // Postgres: pg_try_advisory_lock is non-blocking.
    // Returns true if lock acquired, false if already held.
    if (dialect === 'postgres') {
      try {
        const [result] = await this.sequelize.query(
          'SELECT pg_try_advisory_lock(hashtext(:key)) AS acquired',
          { replacements: { key }, type: this.sequelize.QueryTypes.SELECT }
        );
        const acquired = result?.acquired === true;
        if (!acquired) {
          this.verboseLogger(2, `[DB] Advisory lock "${key}" already held (Postgres pg_try_advisory_lock returned false).`);
        }
        return acquired;
      } catch (err) {
        this.verboseLogger(1, `[DB] acquireAdvisoryLock("${key}") Postgres error: ${err.message}`);
        return false;
      }
    }

    // MySQL: GET_LOCK is blocking with timeout.
    // Returns 1 if lock acquired, 0 if timeout, NULL on error.
    if (dialect === 'mysql') {
      try {
        const [result] = await this.sequelize.query(
          'SELECT GET_LOCK(:key, :timeout) AS acquired',
          {
            replacements: { key, timeout: Math.max(0, Math.floor(timeoutMs / 1000)) },
            type: this.sequelize.QueryTypes.SELECT
          }
        );
        const acquired = result?.acquired === 1;
        if (!acquired) {
          this.verboseLogger(2, `[DB] Advisory lock "${key}" could not be acquired (MySQL GET_LOCK returned ${result?.acquired}).`);
        }
        return acquired;
      } catch (err) {
        this.verboseLogger(1, `[DB] acquireAdvisoryLock("${key}") MySQL error: ${err.message}`);
        return false;
      }
    }

    // Unknown dialect — log warning, return true (don't block on unknown)
    this.verboseLogger(1, `[DB] acquireAdvisoryLock("${key}"): unknown dialect "${dialect}" — returning true (unprotected).`);
    return true;
  }

  /**
   * Release an advisory lock previously acquired via acquireAdvisoryLock().
   *
   * - SQLite: no-op (mutex auto-releases via promise chain).
   * - Postgres: pg_advisory_unlock(hashtext(key)).
   * - MySQL: DO RELEASE_LOCK(key).
   *
   * @param {string} key - Logical lock name (must match acquireAdvisoryLock call)
   * @returns {Promise<void>}
   */
  async releaseAdvisoryLock(key) {
    if (!this.sequelize || typeof this.sequelize.query !== 'function') {
      return;
    }

    const dialect = this.getConnectorName();

    // SQLite: no-op — mutex auto-releases via promise chain
    if (dialect === 'sqlite') {
      return;
    }

    // Postgres
    if (dialect === 'postgres') {
      try {
        await this.sequelize.query(
          'SELECT pg_advisory_unlock(hashtext(:key))',
          { replacements: { key }, type: this.sequelize.QueryTypes.SELECT }
        );
      } catch (err) {
        this.verboseLogger(2, `[DB] releaseAdvisoryLock("${key}") Postgres error (non-fatal): ${err.message}`);
      }
      return;
    }

    // MySQL
    if (dialect === 'mysql') {
      try {
        await this.sequelize.query(
          'DO RELEASE_LOCK(:key)',
          { replacements: { key } }
        );
      } catch (err) {
        this.verboseLogger(2, `[DB] releaseAdvisoryLock("${key}") MySQL error (non-fatal): ${err.message}`);
      }
      return;
    }

    // Unknown dialect — no-op
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

  /* ───── Network backoff ───── */

  /**
   * Returns true when a network-level DB failure activated backoff, and the
   * cooldown period has not yet expired. Consumer callers should check this
   * before making DB calls to avoid hammering an unreachable database every
   * refresh tick.
   */
  shouldSkipDb() {
    return this._networkErrorBackoff !== null && Date.now() < this._networkErrorBackoff;
  }

  async withTransactionWithRetry(logicFn, options = {}) {
    if (this.shouldSkipDb()) {
      return null;
    }
    try {
      const result = await this.executeWithRetry(() =>
        DBService.withTransaction(this.sequelize, logicFn, options)
      );
      // Success — clear any active backoff
      if (this._networkErrorBackoff !== null) {
        this._networkErrorBackoff = null;
        this.verboseLogger(3, '[DB] Network backoff cleared — DB is reachable again.');
      }
      return result;
    } catch (err) {
      if (DBService.isNetworkError(err)) {
        this._networkErrorBackoff = Date.now() + this._networkErrorBackoffMs;
        this.verboseLogger(
          2,
          `[DB] Network backoff for ${this._networkErrorBackoffMs}ms: ${err.message}`
        );
      }
      throw err;
    }
  }

  async ensureSqlitePragmas() {
    return DBService.ensureSqlitePragmas(this.sequelize);
  }

  /**
   * Retrieve a previously-defined model by name.
   * Returns null if the model has not been defined yet.
   * @param {string} name - Model name (e.g. 'Elo_PlayerStats')
   * @returns {import('sequelize').Model|null}
   */
  getModel(name) {
    return this.models?.[name] ?? null;
  }

  /**
   * Define a Sequelize model on the S³ connector.
   *
   * **model name → table name resolution (in priority order):**
   *   1. Explicit `tableName` in `modelOptions` (highest — caller controls it)
   *   2. `freezeTableName: true` (injected by default — model name IS the table name)
   *   3. Sequelize auto-pluralization (disabled by freezeTableName, never reached)
   *
   * This means a caller can use a **singular model name** (e.g. `'Elo_PluginState'`)
   * while the actual DB table is **plural** (e.g. `'Elo_PluginStates'`) by passing
   * `{ tableName: 'Elo_PluginStates' }`.  The model is always looked up by its
   * original `name` argument — never by its table name.
   *
   * @param {string} name - Model name (key in `this.models`).  Not necessarily the table name.
   * @param {object} schema - Sequelize attribute definitions.
   * @param {object} [modelOptions] - Passed through to `sequelize.define()`.
   *   `freezeTableName: true` is always prepended; an explicit `tableName` overrides it.
   * @returns {import('sequelize').Model}
   */
  defineModel(name, schema, modelOptions = {}) {
    if (!this.sequelize || typeof this.sequelize.define !== 'function') {
      throw new Error('defineModel called without a valid sequelize connector.');
    }

    if (this.models[name]) {
      return this.models[name];
    }

    const opts = { freezeTableName: true, ...modelOptions };
    const model = this.sequelize.define(name, schema, opts);
    this.models[name] = model;
    return model;
  }

   /* ────────────────────────────────────── SCHEMA VERSION PUBLIC API ────────────────────────────────────── */

   /**
    * Register a plugin's expected schema version and, optionally, the
    * Sequelize model names it owns. The model list feeds verifyLiveSchema()
    * so drift detection can diff rawAttributes against the actual
    * database columns.
    *
    * **Important:** `options.models` must be **model names** (first arg to
    * `defineModel()`), NOT table names. `verifyLiveSchema()` dereferences
    * them via `this.models[name].tableName` to find the real DB table.
    * See `defineModel()` for how model names map to table names.
    *
    * @param {string} pluginName - Unique plugin identifier
    * @param {number} version    - Expected schema version (positive integer)
    * @param {{ models?: string[] }} [options] - Model names owned by this plugin
    */
   registerExpectedVersion(pluginName, version, options = {}) {
    if (!pluginName || typeof pluginName !== 'string') {
      throw new Error('registerExpectedVersion requires a non-empty pluginName string.');
    }
    if (!Number.isInteger(version) || version < 0) {
      throw new Error(`registerExpectedVersion for "${pluginName}" requires a non-negative integer version, got ${version}.`);
    }

    this._expectedVersions.set(pluginName, version);
    if (options.models) {
      this._pluginModels.set(pluginName, options.models);
    }
    this.verboseLogger(4, `[DB] Registered expected version v${version} for "${pluginName}".`);
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

  /* ────────────────────────────────────── MIGRATION GATE API ────────────────────────────────────── */

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

  /* ────────────────────────────────────── SCHEMA DRIFT DETECTION ────────────────────────────────────── */

  /**
   * Verify live schema against registered Sequelize model definitions.
   * Diffs each plugin's registered models' rawAttributes against the actual
   * database columns via describeTable(). Returns an array of drift entries.
   * Called on every mount (metadata-only, negligible cost).
   *
   * Drift entry shapes:
   *   { pluginName, table, error }       — describeTable() failure
   *   { pluginName, table, missing }     — columns expected in model but absent from DB
   *   { pluginName, table, extra }       — columns in DB but not in model
   *
   * @returns {Promise<Array<{pluginName: string, table: string, model?: string, missing?: string[], extra?: string[], error?: string}>>}
   */
  async verifyLiveSchema() {
    if (this._pluginModels.size === 0) {
      this.verboseLogger(3, '[DB] No plugin models registered for drift detection — skipping verifyLiveSchema.');
      return [];
    }

    const drift = [];

    for (const [pluginName, modelNames] of this._pluginModels.entries()) {
      for (const modelName of modelNames) {
        // model names come from registerExpectedVersion()'s `models` array
        const model = this.models[modelName];
        if (!model) {
          drift.push({ pluginName, model: modelName, error: 'Model not found in registry' });
          continue;
        }

        // model.tableName is the explicit tableName passed in defineModel() options,
        // or falls back to the model name (since freezeTableName is injected by default).
        // This is how the singular-model / plural-table bridge works:
        //   defineModel('Elo_PluginState', ..., { tableName: 'Elo_PluginStates' })
        //   → model.tableName = 'Elo_PluginStates', this.models['Elo_PluginState'] = model
        const tableName = model.tableName || model.name;

        let actualColumns;
        try {
          actualColumns = await this.sequelize.getQueryInterface().describeTable(tableName);
        } catch (err) {
          drift.push({ pluginName, table: tableName, error: `Cannot describe: ${err.message}` });
          continue;
        }

        const expectedColumns = Object.keys(model.rawAttributes);
        const missing = expectedColumns.filter(col => !actualColumns[col]);
        const extra = Object.keys(actualColumns).filter(col => !expectedColumns.includes(col));

        if (missing.length > 0) {
          drift.push({ pluginName, table: tableName, missing });
        }
        if (extra.length > 0) {
          drift.push({ pluginName, table: tableName, extra });
        }
      }
    }

    // Log results
    if (drift.length === 0) {
      this.verboseLogger(3, '[DB] Schema drift check passed — all registered models match live database.');
    } else {
      for (const entry of drift) {
        if (entry.error) {
          this.verboseLogger(1, `[DB] DRIFT: ${entry.pluginName}/${entry.table || entry.model}: ${entry.error}`);
        }
        if (entry.missing) {
          this.verboseLogger(1, `[DB] DRIFT: ${entry.table} missing columns: ${entry.missing.join(', ')}`);
        }
        if (entry.extra) {
          this.verboseLogger(2, `[DB] DRIFT: ${entry.table} has extra columns: ${entry.extra.join(', ')}`);
        }
      }
    }

    return drift;
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
   * Does NOT auto-trigger migrations — that is gated behind Discord confirmation.
   * The Discord prompt is fired later (after Discord registers) via _checkAndPromptMigrations().
   */
  async _verifySchemaVersions() {
    const result = await this.verifySchemaVersions();

    // Run live schema drift detection on every mount (metadata-only, negligible cost)
    const liveDrift = await this.verifyLiveSchema();
    this._lastDriftResult = liveDrift;

    if (result.upToDate) {
      if (this._expectedVersions.size > 0) {
        const versions = [...this._expectedVersions.entries()]
          .map(([name, ver]) => `${name} v${ver}`)
          .join(', ');
        this.verboseLogger(3, `[DB] All schema versions current: ${versions}.`);
      } else {
        this.verboseLogger(3, '[DB] No plugin schema versions registered yet — deferring version check.');
      }
      this._pendingMigrations = [];
      return;
    }

    // Store pending migrations for the Discord prompt
    this._pendingMigrations = result.pending;

    // Create migration gate — consumer plugins can await this before sync({ alter: true })
    this._migrationGate = new Promise((resolve) => {
      this._resolveMigrationGateFn = resolve;
    });

    this.verboseLogger(2, `[DB] ${result.pending.length} plugin(s) have pending schema migrations. Gate created.`);
    for (const p of result.pending) {
      this.verboseLogger(2, `  "${p.pluginName}": v${p.currentVersion || '(new)'} → v${p.expectedVersion} (${p.behind} behind)`);
    }

    this.verboseLogger(2, '[DB] Migrations are NOT auto-applied. Waiting for Discord confirmation.');
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