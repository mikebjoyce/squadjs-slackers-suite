/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           MIGRATION ENGINE                                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Per-plugin schema migration runner. Consumer plugins (SmartAssign,
 * TeamBalancer, EloTracker) register migration functions keyed by
 * version number. The engine applies pending migrations in ascending
 * order, each wrapped in its own transaction, and records the result
 * in the S³ SchemaVersion table.
 *
 * ─── ARCHITECTURE ───────────────────────────────────────────────
 *
 * - One engine instance is created by DBService on mount.
 * - Each migration is a discrete function, not a SQL string — safer
 *   for programmatic logic.
 * - Migrations run in isolation (one transaction per migration), so
 *   a failure at v3 does not roll back v2. Partial progress is better
 *   than phantom rollback of already-applied changes.
 * - The engine NEVER auto-triggers migrations on startup — that is
 *   gated behind the Discord confirmation flow (!s3 confirm <token>).
 *
 * ─── METHODS ────────────────────────────────────────────────────
 *
 *   registerMigrations(pluginName, migrations)
 *     Validates version sequence. Stores in-memory for later execution.
 *
 *   async runMigrations(pluginName, options = {})
 *     Applies pending migrations for a plugin. Returns { applied, skipped }.
 *     Each migration runs in its own transaction.
 *
 *   async rollbackMigrations(pluginName, targetVersion)
 *     Reverses migrations down to a target version.
 *     Each down() call runs in its own transaction.
 *
 *   pendingMigrations(pluginName)
 *     Returns list of migrations that haven't been applied yet.
 *
 *   appliedVersions(pluginName)
 *     Reads current version from SchemaVersion table.
 *
 * ─── QUERY INTERFACE ────────────────────────────────────────────
 *
 * The object passed to up()/down() provides:
 *   sequelize       - Sequelize connector instance
 *   db              - DBService instance (access to models, connectors)
 *   transaction     - Active Sequelize transaction
 *   addColumn, removeColumn, addIndex, removeIndex, rawQuery
 *
 * ─── DEPENDENCIES ───────────────────────────────────────────────
 *
 * DBService (constructor arg) — for connector, models, transactions.
 * Node crypto module — SHA-256 hashing of migration code.
 *
 * ─── NOTES ──────────────────────────────────────────────────────
 *
 * - This file replaces the old S3_Migrations table approach.
 *   The new SchemaVersion table is per-plugin.
 * - Discord confirmation is handled via confirmToken() gate — the
 *   engine requires a valid token before executing migrations.
 * - Connector-agnostic export fallback: When SQLite file-copy
 *   backup is unavailable (non-SQLite connectors), the engine falls
 *   back to JSON export/import via s3-export-import.js (exportToFile /
 *   restoreFromFile). This ensures pre-migration backups work on
 *   Postgres, MySQL, or any other Sequelize dialect.
 * - migrations must be idempotent where possible.
 *
 */

import crypto from 'node:crypto';
import { createBackup } from './s3-backup.js';
import { exportToFile as jsonExportToFile } from './s3-export-import.js';

/**
 * Create a QueryInterface object bound to a specific DBService + transaction.
 * Passed as the sole argument to migration up()/down() handlers.
 */
function createQueryInterface(sequelize, db, transaction) {
  const DataTypes = db.getDataTypes();

  return {
    sequelize,
    db,
    transaction,

    async addColumn(tableName, columnName, columnDef) {
      const qi = sequelize.getQueryInterface();
      await qi.addColumn(tableName, columnName, columnDef, { transaction });
    },

    async removeColumn(tableName, columnName, options = {}) {
      if (options.forceDrop) {
        const qi = sequelize.getQueryInterface();
        await qi.removeColumn(tableName, columnName, { transaction });
        return;
      }
      // Check existence first — no-op if column already gone
      const info = await sequelize.getQueryInterface().describeTable(tableName, { transaction });
      if (!info[columnName]) return;
      const timestamp = Date.now();
      const deprecatedName = `${columnName}_deprecated_${timestamp}`;
      const qi = sequelize.getQueryInterface();
      await qi.renameColumn(tableName, columnName, deprecatedName, { transaction });
    },

    async changeColumn(tableName, columnName, columnDef) {
      const qi = sequelize.getQueryInterface();
      await qi.changeColumn(tableName, columnName, columnDef, { transaction });
    },

    async addIndex(tableName, columns, options = {}) {
      const qi = sequelize.getQueryInterface();
      await qi.addIndex(tableName, columns, { ...options, transaction });
    },

    async removeIndex(tableName, indexName, options = {}) {
      const qi = sequelize.getQueryInterface();
      await qi.removeIndex(tableName, indexName, { ...options, transaction });
    },

    async dropTable(tableName, options = {}) {
      const qi = sequelize.getQueryInterface();
      if (options.forceDrop) {
        await qi.dropTable(tableName, { transaction });
        return;
      }
      // Check existence first — no-op if already gone (e.g. orphan tables from partial runs)
      const tables = await sequelize.getQueryInterface().showAllTables({ transaction });
      if (!tables.includes(tableName)) return;
      const timestamp = Date.now();
      const deprecatedName = `${tableName}_deprecated_${timestamp}`;
      await qi.renameTable(tableName, deprecatedName, { transaction });
    },

    async createTable(tableName, attributes, options = {}) {
      const qi = sequelize.getQueryInterface();
      await qi.createTable(tableName, attributes, { ...options, transaction });
    },

    async bulkInsert(tableName, records, options = {}) {
      const qi = sequelize.getQueryInterface();
      await qi.bulkInsert(tableName, records, { ...options, transaction });
    },

    /**
     * List existing table names in a dialect-agnostic way.
     * Use this instead of raw sqlite_master queries.
     * @returns {Promise<string[]>}
     */
    async showAllTables() {
      const qi = sequelize.getQueryInterface();
      return qi.showAllTables({ transaction });
    },

    /**
     * Describe a table's columns in a dialect-agnostic way.
     * Returns a map of column name → column metadata.
     * Use this instead of raw PRAGMA / information_schema queries.
     * @param {string} tableName
     * @returns {Promise<Record<string, Object>>}
     */
    async describeTable(tableName) {
      const qi = sequelize.getQueryInterface();
      return qi.describeTable(tableName, { transaction });
    },

    async rawQuery(sql, replacements = {}) {
      const result = await sequelize.query(sql, {
        replacements,
        transaction
      });
      // Sequelize returns [rows, metadata] for SELECT-type queries.
      // Unwrap to just the rows so migration code (e.g. PRAGMA checks)
      // works with a flat array of row objects.
      if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
        return result[0];
      }
      return result;
    },

    DataTypes
  };
}

export default class MigrationEngine {
  /**
   * @param {Object} opts
   * @param {import('./db-service.js').default} opts.dbService - DBService instance
   * @param {Function} opts.verboseLogger - SquadJS verbose logger
   * @param {string}  [opts.dbPath]       - Path to the SQLite database file for backup
   * @param {string}  [opts.backupDir]    - Backup directory override (default: './backups')
   * @param {number}  [opts.backupRetention=5] - Max backups to retain
   */
   constructor({ dbService, verboseLogger = () => {}, dbPath = null, backupDir = null, backupRetention = 5 } = {}) {
    if (!dbService) {
      throw new Error('MigrationEngine requires a dbService instance.');
    }

    this.dbService = dbService;
    this.verboseLogger = verboseLogger;
    this.dbPath = dbPath;
    this.backupDir = backupDir;
    this.backupRetention = backupRetention;

    /** @type {Map<string, Array<{version: number, up: Function, down?: Function}>>} */
    this._migrations = new Map();

    /** Token expected from Discord confirmation prompt. Set by _checkAndPromptMigrations(). */
    this._confirmToken = null;

    /** True once confirmToken() was called with a matching token, '__auto__', or '__force__'. */
    this._confirmed = false;

    /** Epoch ms when the current token expires (5 min from generation). */
    this._tokenExpiresAt = null;
  }

  /* ────────────────────────────────────── PUBLIC API ────────────────────────────────────── */

  /**
   * Register a sequence of migrations for a plugin.
   * @param {string} pluginName  - Unique plugin identifier (e.g. 'smart-assign', 's3-core')
   * @param {Array}  migrations  - Array of migration objects:
   *   [{ version: number, description: string, up: async (qi) => void, down?: async (qi) => void, touches?: { creates?: string[], columns?: Record<string, string[]> } }]
   *
   * Validates:
   *   - No duplicate version numbers
   *   - Versions are positive integers
   *   - description is a non-empty string
   *   - up() is a function
   */
  registerMigrations(pluginName, migrations) {
    if (!pluginName || typeof pluginName !== 'string') {
      throw new Error('registerMigrations requires a non-empty pluginName string.');
    }
    if (!Array.isArray(migrations) || migrations.length === 0) {
      throw new Error(`registerMigrations for "${pluginName}" requires a non-empty migrations array.`);
    }

    const seen = new Set();
    for (const m of migrations) {
      if (!Number.isInteger(m.version) || m.version < 1) {
        throw new Error(`Migration in "${pluginName}" has invalid version: ${m.version}. Must be a positive integer.`);
      }
      if (seen.has(m.version)) {
        throw new Error(`Duplicate version ${m.version} in "${pluginName}" migrations.`);
      }
      seen.add(m.version);
      if (typeof m.up !== 'function') {
        throw new Error(`Migration v${m.version} in "${pluginName}" is missing an up() function.`);
      }

      // ── description (required) ────────────────────────────────────
      if (typeof m.description !== 'string' || m.description.trim().length === 0) {
        throw new Error(
          `Migration v${m.version} in "${pluginName}" is missing a non-empty description string.`
        );
      }

      // ── touches (optional — structural validation) ────────────────
      if (m.touches !== undefined) {
        if (typeof m.touches !== 'object' || m.touches === null || Array.isArray(m.touches)) {
          throw new Error(
            `Migration v${m.version} in "${pluginName}": touches must be an object if provided.`
          );
        }
        if (m.touches.creates !== undefined) {
          if (!Array.isArray(m.touches.creates) || !m.touches.creates.every(t => typeof t === 'string')) {
            throw new Error(
              `Migration v${m.version} in "${pluginName}": touches.creates must be an array of table name strings.`
            );
          }
        }
        if (m.touches.columns !== undefined) {
          if (typeof m.touches.columns !== 'object' || m.touches.columns === null || Array.isArray(m.touches.columns)) {
            throw new Error(
              `Migration v${m.version} in "${pluginName}": touches.columns must be a Record<string, string[]>.`
            );
          }
          for (const [tableName, cols] of Object.entries(m.touches.columns)) {
            if (!Array.isArray(cols) || !cols.every(c => typeof c === 'string')) {
              throw new Error(
                `Migration v${m.version} in "${pluginName}": touches.columns["${tableName}"] must be an array of column name strings.`
              );
            }
          }
        }
      }
    }

    // Sort ascending by version
    const sorted = [...migrations].sort((a, b) => a.version - b.version);

    // Check for gaps only if there are existing registrations
    if (this._migrations.has(pluginName)) {
      const existing = this._migrations.get(pluginName);
      const existingMax = existing.reduce((max, m) => Math.max(max, m.version), 0);
      const newMin = sorted.reduce((min, m) => Math.min(min, m.version), Infinity);
      if (newMin <= existingMax) {
        throw new Error(
          `New migrations for "${pluginName}" start at v${newMin} but existing go up to v${existingMax}. ` +
          `Versions must be strictly increasing.`
        );
      }
    }

    const prev = this._migrations.get(pluginName) || [];

    // Guard against duplicate registration — if all versions in sorted
    // are already present in prev, this is a re-registration (e.g. from
    // PlayersService calling registerMigrations from two init methods).
    const prevVersions = new Set(prev.map((m) => m.version));
    const allExist = sorted.every((m) => prevVersions.has(m.version));
    if (allExist && prev.length > 0) {
      this.verboseLogger(4, `[MigrationEngine] Skipping re-registration: "${pluginName}" already has ${prev.length} migration(s).`);
      return;
    }

    this._migrations.set(pluginName, [...prev, ...sorted]);

    this.verboseLogger(4, `[MigrationEngine] Registered ${sorted.length} migration(s) for "${pluginName}".`);
  }

  /**
   * Confirm that migrations are authorized to run.
   * Accepts special tokens '__auto__' (autoMigrate config / bootstrap DDL),
   * '__force__' (!s3 migrate force), or a plain string token from a Discord prompt.
   * Synchronous — no async operations required.
   *
   * @param {string} token - The token to validate.
   * @returns {boolean} True if the token was accepted and migrations are now authorized.
   */
  confirmToken(token) {
    // Already confirmed — idempotent
    if (this._confirmed) return true;

    // Check token expiry first
    if (this._confirmToken && this._tokenExpiresAt && Date.now() > this._tokenExpiresAt) {
      this._confirmToken = null;
      this._tokenExpiresAt = null;
      return false;
    }

    // Special tokens always work
    if (token === '__auto__' || token === '__force__') {
      this._confirmed = true;
      this._confirmToken = null;
      this._tokenExpiresAt = null;
      return true;
    }

    // Plain token must match the stored token
    if (this._confirmToken !== null && token === this._confirmToken) {
      this._confirmed = true;
      this._confirmToken = null;
      this._tokenExpiresAt = null;
      return true;
    }

    return false;
  }

  /**
   * Apply pending migrations for a plugin.
   * Each migration runs in its own transaction — a failure at v3 does
   * not roll back v2.
   *
   * @param {string}  pluginName  - Plugin to migrate
   * @param {Object}  [options]
   * @param {boolean} [options.dryRun=false] - If true, log what would run without committing
   * @returns {Promise<{applied: number, skipped: number}>}
   */
  async runMigrations(pluginName, options = {}) {
    const { dryRun = false } = options;

    if (!this._migrations.has(pluginName)) {
      this.verboseLogger(2, `[MigrationEngine] No migrations registered for "${pluginName}".`);
      return { applied: 0, skipped: 0 };
    }

    const appliedVersion = await this._getAppliedVersion(pluginName);
    const pending = this._getPendingMigrations(pluginName, appliedVersion);

    if (pending.length === 0) {
      this.verboseLogger(3, `[MigrationEngine] "${pluginName}" is up to date (v${appliedVersion}).`);
      return { applied: 0, skipped: 0 };
    }

    if (dryRun) {
      this.verboseLogger(2, `[MigrationEngine] [DRY RUN] "${pluginName}" has ${pending.length} pending migration(s):`);
      for (const m of pending) {
        this.verboseLogger(2, `  v${m.version} — ${m.description || '(no description)'}`);
        if (m.touches) {
          if (m.touches.creates && m.touches.creates.length > 0) {
            for (const tableName of m.touches.creates) {
              this.verboseLogger(2, `    Creates table: ${tableName}`);
              if (m.touches.columns?.[tableName]) {
                this.verboseLogger(2, `    Columns: ${m.touches.columns[tableName].join(', ')}`);
              }
            }
          }
          if (m.touches.columns) {
            for (const [tableName, cols] of Object.entries(m.touches.columns)) {
              if (!m.touches.creates || !m.touches.creates.includes(tableName)) {
                this.verboseLogger(2, `    Columns (${tableName}): ${cols.join(', ')}`);
              }
            }
          }
        }
      }
      return { applied: 0, skipped: pending.length };
    }

    // Confirmation gate — must be confirmed before running any migrations
    if (!this._confirmed) {
      throw new Error(
        `Migration not confirmed for "${pluginName}". ` +
        'Use !s3 confirm <token> or !s3 migrate force, ' +
        'or set autoMigrate: true in S³ config.'
      );
    }

    // Concurrency guard — prevent double-apply across processes.
    // SQLite is already serialized by _s3_mutex (acquireAdvisoryLock returns true immediately).
    // Postgres/MySQL use native advisory locks to serialize per-pluginName.
    const lockKey = `s3_migrate_${pluginName}`;
    let locked = false;
    try {
      locked = await this.dbService.acquireAdvisoryLock(lockKey, 30000);
      if (!locked) {
        throw new Error(
          `Could not acquire migration lock for "${pluginName}" — another migration may be in progress.`
        );
      }

      // Pre-migration backup — produce BOTH formats for portability.
      // Tier 1: Fast SQLite file copy (if dbPath is available — SQLite only).
      // Tier 2: Connector-agnostic JSON export (works on all dialects, ensures
      // cross-connector portability for future Postgres/MySQL migration).
      // At least one must succeed; if both fail, the migration is aborted.
      let fileCopyResult = null;
      let jsonExportResult = null;

      // Tier 1: SQLite file copy (fast, binary-identical)
      if (this.dbPath) {
        try {
          fileCopyResult = createBackup(this.dbPath, this.backupDir, this.backupRetention);
          if (fileCopyResult) {
            this.verboseLogger(2, `[MigrationEngine] File backup created: ${fileCopyResult.filename} (${fileCopyResult.sizeBytes} bytes).`);
          }
        } catch (err) {
          this.verboseLogger(1, `[MigrationEngine] File backup failed: ${err.message}`);
          fileCopyResult = null;
        }
      }

      // Tier 2: JSON export (always run — ensures cross-connector portability)
      try {
        jsonExportResult = await jsonExportToFile(this.dbService, this.backupDir, {
          tier: 'all',
          retention: this.backupRetention
        });
        if (jsonExportResult) {
          this.verboseLogger(2, `[MigrationEngine] JSON backup created: ${jsonExportResult.filename} (${jsonExportResult.sizeBytes} bytes).`);
        }
      } catch (err) {
        this.verboseLogger(1, `[MigrationEngine] JSON backup failed: ${err.message}`);
        jsonExportResult = null;
      }

      if (!fileCopyResult && !jsonExportResult) {
        const msg = `[MigrationEngine] Backup FAILED for "${pluginName}" — aborting migration. Both file copy and JSON export failed. Check disk space, permissions, and DB connectivity.`;
        this.verboseLogger(1, msg);
        throw new Error(msg);
      }

      this.verboseLogger(2, `[MigrationEngine] Running ${pending.length} migration(s) for "${pluginName}"...`);

      let applied = 0;
      for (const migration of pending) {
        try {
          // Step 1: Run up() inside a transaction
          await this.dbService.withTransactionWithRetry(async (transaction) => {
            const qi = createQueryInterface(this.dbService.sequelize, this.dbService, transaction);
            await migration.up(qi);
          });

          // Step 2: Verify DDL outside transaction, then record version
          // The verify qi has null transaction so showAllTables/describeTable
          // see the committed state without dialect-specific transaction issues.
          const verifyQi = createQueryInterface(this.dbService.sequelize, this.dbService, null);
          await this._verifyMigrationResult(migration, verifyQi);

          // Verification passed — record the version in a separate transaction
          await this.dbService.withTransactionWithRetry(async (transaction) => {
            await this._recordVersion(pluginName, migration.version, migration.up, transaction);
          });

          this.verboseLogger(3, `[MigrationEngine] Applied v${migration.version} for "${pluginName}".`);
          applied += 1;
        } catch (err) {
          throw err; // Re-throw so the calling code knows the batch failed
        }
      }

      return { applied, skipped: pending.length - applied };
    } finally {
      if (locked) {
        await this.dbService.releaseAdvisoryLock(lockKey);
      }
    }
  }

  /**
   * Roll back migrations for a plugin down to (but not including) a target version.
   * Each down() call runs in its own transaction.
   *
   * @param {string} pluginName    - Plugin to roll back
   * @param {number} targetVersion - Roll back to this version (migrations at or below this stay)
   * @returns {Promise<{rolledBack: number}>}
   */
  async rollbackMigrations(pluginName, targetVersion) {
    if (!this._migrations.has(pluginName)) {
      throw new Error(`No migrations registered for "${pluginName}".`);
    }

    const appliedVersion = await this._getAppliedVersion(pluginName);

    if (targetVersion >= appliedVersion) {
      this.verboseLogger(2, `[MigrationEngine] "${pluginName}" is already at or below v${targetVersion} (currently v${appliedVersion}). Nothing to roll back.`);
      return { rolledBack: 0 };
    }

    // Collect migrations to roll back: versions > targetVersion, ordered descending
    const allMigrations = this._migrations.get(pluginName);
    const toRollBack = allMigrations
      .filter((m) => m.version > targetVersion && m.version <= appliedVersion)
      .sort((a, b) => b.version - a.version); // descending

    if (toRollBack.length === 0) {
      this.verboseLogger(2, `[MigrationEngine] No rollback-eligible migrations found for "${pluginName}".`);
      return { rolledBack: 0 };
    }

    // Check that all have down() defined
    const missingDown = toRollBack.find((m) => typeof m.down !== 'function');
    if (missingDown) {
      throw new Error(
        `Cannot roll back v${missingDown.version} for "${pluginName}" — missing down() function.`
      );
    }

    this.verboseLogger(2, `[MigrationEngine] Rolling back ${toRollBack.length} migration(s) for "${pluginName}" to v${targetVersion}...`);

    let rolledBack = 0;
    for (const migration of toRollBack) {
      await this.dbService.withTransactionWithRetry(async (transaction) => {
        const qi = createQueryInterface(this.dbService.sequelize, this.dbService, transaction);

        await migration.down(qi);

        // Update SchemaVersion to reflect the rollback
        const newVersion = rolledBack === toRollBack.length - 1
          ? targetVersion
          : migration.version - 1;

        await this._recordVersion(pluginName, newVersion, migration.down, transaction);

        this.verboseLogger(3, `[MigrationEngine] Rolled back v${migration.version} for "${pluginName}" (now v${newVersion}).`);
      });

      rolledBack += 1;
    }

    return { rolledBack };
  }

  /**
   * List pending (not-yet-applied) migrations for a plugin.
   * @param {string} pluginName
   * @returns {Array<{version: number, up: Function, down?: Function}>}
   */
  async pendingMigrations(pluginName) {
    if (!this._migrations.has(pluginName)) return [];
    const appliedVersion = await this._getAppliedVersion(pluginName);
    return this._getPendingMigrations(pluginName, appliedVersion);
  }

  /* ────────────────────────────────────── INTERNAL ────────────────────────────────────── */

  /**
   * Read the current applied version for a plugin from SchemaVersion table.
   * Returns 0 if no row exists (fresh install).
   */
  async _getAppliedVersion(pluginName) {
    const model = this.dbService.SchemaVersionsModel;
    if (!model) return 0;

    try {
      const row = await model.findOne({ where: { pluginName } });
      return row ? row.version : 0;
    } catch {
      // If the table doesn't exist yet (first mount), treat as version 0
      return 0;
    }
  }

  /**
   * Get migrations that are > current applied version.
   */
  _getPendingMigrations(pluginName, appliedVersion) {
    const allMigrations = this._migrations.get(pluginName) || [];
    return allMigrations.filter((m) => m.version > appliedVersion);
  }

  /**
   * Upsert a version record in SchemaVersion table.
   */
  async _recordVersion(pluginName, version, runFn, transaction) {
    const model = this.dbService.SchemaVersionsModel;
    if (!model) return;

    const migrationHash = crypto
      .createHash('sha256')
      .update(runFn.toString())
      .digest('hex');

    const existing = await model.findOne({
      where: { pluginName },
      transaction
    });

    if (existing) {
      await existing.update(
        { version, appliedAt: Date.now(), migrationHash },
        { transaction }
      );
    } else {
      await model.create(
        {
          pluginName,
          version,
          appliedAt: Date.now(),
          migrationHash,
          description: ''
        },
        { transaction }
      );
    }
  }

  /**
   * Verify that the DDL declared in migration.touches actually took effect
   * after up() committed. Runs outside any transaction to avoid dialect-specific
   * issues with describeTable inside user transactions.
   *
   * - If migration.touches is absent, verification is skipped (backward compatible).
   * - Checks showAllTables() for each entry in touches.creates.
   * - Checks describeTable() for each column in touches.columns.
   * - Collects all failures and throws one composite error.
   *
   * @param {{ touches?: { creates?: string[], columns?: Record<string, string[]> } }} migration
   * @param {Object} qi - QueryInterface object (transaction must be null for DDL state checks)
   * @throws {Error} If any table or column declared in touches is absent from the live schema
   */
  async _verifyMigrationResult(migration, qi) {
    if (!migration.touches) return;

    const failures = [];

    if (migration.touches.creates) {
      const existing = await qi.showAllTables();
      for (const tableName of migration.touches.creates) {
        if (!existing.includes(tableName)) {
          failures.push(`Table "${tableName}" was not created (permission denied?)`);
          continue;
        }
        if (migration.touches.columns?.[tableName]) {
          const actual = await qi.sequelize.getQueryInterface().describeTable(tableName);
          for (const col of migration.touches.columns[tableName]) {
            if (!actual[col]) {
              failures.push(`Column "${tableName}.${col}" missing after migration`);
            }
          }
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `Migration v${migration.version} reported success but verification failed:\n${failures.join('\n')}`
      );
    }
  }
}
