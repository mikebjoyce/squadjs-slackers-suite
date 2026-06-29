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
 *   gated behind the Discord confirmation flow (7.4d).
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
 * - This file replaces the old S3_Migrations table approach in
 *   db-service.js (7.4b). The new SchemaVersion table is per-plugin.
 * - 7.4d (Discord confirmation) and 7.4e (file backup) are stubbed;
 *   their integration points are marked with TODO comments.
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

    async removeColumn(tableName, columnName) {
      const qi = sequelize.getQueryInterface();
      await qi.removeColumn(tableName, columnName, { transaction });
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
      await qi.dropTable(tableName, { ...options, transaction });
    },

    async createTable(tableName, attributes, options = {}) {
      const qi = sequelize.getQueryInterface();
      await qi.createTable(tableName, attributes, { ...options, transaction });
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
   * @param {string}  [opts.dbPath]       - Path to the SQLite database file for backup (7.4e)
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
  }

  /* ────────────────────────────────────── PUBLIC API ────────────────────────────────────── */

  /**
   * Register a sequence of migrations for a plugin.
   * @param {string} pluginName  - Unique plugin identifier (e.g. 'smart-assign', 's3-core')
   * @param {Array}  migrations  - Array of migration objects:
   *   [{ version: number, up: async (qi) => void, down?: async (qi) => void }]
   *
   * Validates:
   *   - No duplicate version numbers
   *   - Versions are positive integers
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
   * Apply pending migrations for a plugin.
   * Each migration runs in its own transaction — a failure at v3 does
   * not roll back v2.
   *
   * @param {string}  pluginName  - Plugin to migrate
   * @param {Object}  [options]
   * @param {boolean} [options.dryRun=false] - If true, log what would run without committing
   * @param {boolean} [options.force=false]  - If true, skip pre-checks (backup still runs)
   * @returns {Promise<{applied: number, skipped: number}>}
   */
  async runMigrations(pluginName, options = {}) {
    const { dryRun = false, force = false } = options;

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
      }
      return { applied: 0, skipped: pending.length };
    }

    // 7.4e / 8.4b: Pre-migration backup — produce BOTH formats for portability.
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
        await this.dbService.withTransactionWithRetry(async (transaction) => {
          const qi = createQueryInterface(this.dbService.sequelize, this.dbService, transaction);

          await migration.up(qi);

          await this._recordVersion(pluginName, migration.version, migration.up, transaction);

          this.verboseLogger(3, `[MigrationEngine] Applied v${migration.version} for "${pluginName}".`);
        });

        applied += 1;
      } catch (err) {
        throw err; // Re-throw so the calling code knows the batch failed
      }
    }

    return { applied, skipped: pending.length - applied };
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
}