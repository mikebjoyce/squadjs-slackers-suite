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
 * ─── MULTI-PROCESS ──────────────────────────────────────────────
 *
 * Several Squad servers can share one database, which means several
 * copies of this engine can reach the same schema at the same time.
 * runMigrations() takes a cross-process lock keyed per plugin before
 * it writes anything, and fails the run rather than proceeding if it
 * cannot get one. Two processes applying the same migration is not a
 * duplicate of harmless work; it is two CREATE TABLE statements, two
 * ALTERs, and a SchemaVersion row that no longer describes the
 * database.
 *
 * The lock is a row in S3_Locks rather than a native primitive. MySQL
 * GET_LOCK and Postgres pg_try_advisory_lock are both scoped to the
 * connection that took them, and everything here runs through a pool,
 * so the release could land on a different connection than the
 * acquire. A row works identically on all three dialects and is
 * visible to an operator looking at the database.
 *
 * The pending list is read before the lock and re-read under it. In
 * between, the other process may have finished the very migrations
 * this one was going to run, and the second read is what turns that
 * into a no-op instead of a repeat.
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
 *   async markBootstrapApplied(pluginName)
 *     Records a group as applied WITHOUT running it, for the tables DBService
 *     creates unconditionally at mount. Confirmation-free by construction:
 *     the DDL has already happened.
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
 *   bulkInsert, bulkUpdate, bulkDelete
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
import SequelizeLib from 'sequelize';
import { createBackup } from './s3-backup.js';
import { exportToFile as jsonExportToFile } from './s3-export-import.js';
import { stderrError, stderrWarn } from './s3-stderr.js';

/**
 * `err.code` on the error thrown when the migration lock could not be taken.
 *
 * This is the one migration failure a caller may legitimately recover from
 * without operator involvement: another process holds the lock, so the work may
 * simply have been done by someone else. Every other failure means the schema
 * is in an unknown state.
 */
export const MIGRATION_LOCK_UNAVAILABLE = 'S3_MIGRATION_LOCK_UNAVAILABLE';

/**
 * Recognize a database permission-denied error and produce operator-facing
 * guidance, or return null for anything else. This is what tells an admin
 * "grant the DB user ALTER and retry" instead of leaving them to parse a raw
 * driver error inside a wall of stack trace — the same failure that broke
 * LoggingService's Model.sync() on a create-only MySQL grant
 * (2026-08-28, see s3/S3_DEVELOPER_GUIDE.md §11.4) surfaces identically
 * from any migration author's up(), and is otherwise indistinguishable from
 * a genuine bug in the migration itself.
 *
 * Confirmed empirically (Docker MySQL + Postgres, 2026-08-29):
 *   - MySQL: err.parent.code is one of the ER_*ACCESS_DENIED_ERROR family
 *     (ER_TABLEACCESS_DENIED_ERROR, ER_DBACCESS_DENIED_ERROR,
 *     ER_COLUMNACCESS_DENIED_ERROR, ER_SPECIFIC_ACCESS_DENIED_ERROR), and the
 *     message always leads with the specific missing privilege — "ALTER
 *     command denied to user 'x'@'y' for table 'z'" — extracted below so the
 *     guidance can name it rather than making the admin re-derive it.
 *   - Postgres: err.parent.code is SQLSTATE 42501 (insufficient_privilege);
 *     message is already plain English ("permission denied for schema
 *     public", "must be owner of table X").
 *   - SQLite: err.parent.code is SQLITE_READONLY or SQLITE_PERM when the
 *     file (or its directory, for WAL/journal files) isn't writable.
 * None of these overlap with the "already applied" duplicate-name/key
 * errors addColumn/bulkInsert/addIndex/removeIndex guard against — those
 * are a structurally different error family on every dialect tested, so
 * there is no risk of this classifier misfiring on a healthy retry.
 *
 * @param {Error} err
 * @returns {string|null}
 */
function describePermissionError(err) {
  const code = err?.parent?.code || err?.original?.code;
  const message = err?.message || '';

  if (typeof code === 'string' && /ACCESS_DENIED/.test(code)) {
    const m = message.match(/^(\w+) command denied/i);
    const priv = m ? m[1].toUpperCase() : null;
    return priv
      ? `the database user is missing the ${priv} privilege (GRANT ${priv} ON <database>.* TO '<user>'@'%'). Fix the grant, then retry with !s3 migrate force.`
      : 'the database user lacks a privilege required for this migration. Check its GRANTs, then retry with !s3 migrate force.';
  }

  if (code === '42501') {
    return `the database role lacks a required privilege (${message}). Fix the grant/ownership, then retry with !s3 migrate force.`;
  }

  if (code === 'SQLITE_READONLY' || code === 'SQLITE_PERM') {
    return 'the SQLite database file (or its containing directory) is not writable by this process. Fix the file permissions, then retry with !s3 migrate force.';
  }

  return null;
}

/**
 * Does `existing` contain `name`, ignoring identifier case?
 *
 * showAllTables() reports the names the engine actually stores, and those are
 * not always the names we asked for. MySQL with lower_case_table_names=1 folds
 * every identifier to lowercase on disk, so a server that was asked for
 * `SwitchPlugin_RoundStats` reports `switchplugin_roundstats` back. Statements
 * that name the table are folded the same way, so createTable, describeTable
 * and every query keep working — showAllTables() is the one place the
 * difference is visible, and an exact-match comparison there reads a table that
 * exists as missing.
 *
 * That has two costs, both of which have been paid on a live server. A create
 * guard concludes the table is absent and reissues the CREATE; a positive guard
 * (`if the table is there, alter it`) concludes it is absent and silently skips
 * the body it was protecting, which is the worse of the two because nothing
 * fails.
 *
 * Entries are strings on every dialect the suite runs except some Postgres
 * paths, which return `{ tableName, schema }`.
 *
 * @param {Array<string|{tableName:string}>} existing - showAllTables() result
 * @param {string} name - The table name the caller is asking about
 * @returns {boolean}
 */
function hasTable(existing, name) {
  if (!Array.isArray(existing) || typeof name !== 'string') return false;
  const target = name.toLowerCase();
  return existing.some((entry) => {
    const actual = typeof entry === 'string' ? entry : entry?.tableName;
    return typeof actual === 'string' && actual.toLowerCase() === target;
  });
}

/**
 * Create a QueryInterface object bound to a specific DBService + transaction.
 * Passed as the sole argument to migration up()/down() handlers.
 */
function createQueryInterface(sequelize, db, transaction, { isReapply = false } = {}) {
  const DataTypes = db.getDataTypes();

  /**
   * Find the registered model backing a raw table name, so bulk operations can
   * be given real attribute types.
   *
   * Without types, Sequelize's low-level bulk API escapes values by their JS
   * shape alone — and on SQLite a JS Date then lands in the column as an integer
   * epoch instead of the 'YYYY-MM-DD HH:MM:SS.SSS +00:00' TEXT that DataTypes.DATE
   * reads back. Every later read of that row throws "date.includes is not a
   * function". MySQL and Postgres escape Dates to a datetime literal regardless,
   * which is exactly why this class of bug reaches production on SQLite only.
   *
   * The model is needed in TWO places, and supplying only one is a trap:
   *   - `attributes` types the SET values.
   *   - `options.model` types the WHERE values.
   * Verified: updating `{ ts: <Date> }` as a WHERE with attributes but no model
   * matches zero rows on SQLite and reports success, because the comparison is
   * against a mis-escaped literal. Both are passed below.
   *
   * Models are keyed by model name, which is not always the table name, so match
   * on either.
   * @param {string} tableName
   * @returns {Object|null} the Sequelize model, or null if none owns the table
   */
  function modelForTable(tableName) {
    const direct = db.getModel(tableName);
    if (direct?.rawAttributes) return direct;
    for (const name of db.getModelNames?.() || []) {
      const model = db.getModel(name);
      if (model && (model.tableName || model.name) === tableName) return model;
    }
    return null;
  }

  return {
    sequelize,
    db,
    transaction,
    // Exposed so post-commit verification resolves models the same way bulk
    // operations do. db.getModel() alone misses any model whose name differs
    // from its table (e.g. model 'Elo_PluginState' → table 'Elo_PluginStates').
    modelForTable,

    /**
     * True when this up() is being re-applied to repair detected drift rather
     * than being applied for the first time.
     *
     * Drift recovery re-runs an already-applied migration on a live database,
     * which is only safe if up() is idempotent. A migration that performs a
     * one-time destructive step — resetting balances, truncating a table,
     * seeding over user edits — must guard that step on this flag, or drift
     * recovery silently destroys the very data the operator is trying to
     * repair. Adding a missing column is idempotent; wiping the rows that
     * column lives on is not.
     */
    isReapply,

    async addColumn(tableName, columnName, columnDef) {
      const qi = sequelize.getQueryInterface();
      // Check existence first — no-op if a prior attempt already added it.
      // DDL commits are not undone by rolling back the transaction wrapping
      // up() (confirmed on both SQLite and MySQL): a migration that adds
      // this column and then fails for any later reason — a mismatched
      // touches declaration, a backfill bug, a dropped connection — leaves
      // the column in place with the version never recorded, so the exact
      // same addColumn call runs again on the next retry. Without this
      // guard that throws a raw "duplicate column" error from the driver,
      // on every retry, forever, with no automatic recovery.
      const info = await qi.describeTable(tableName, { transaction });
      if (info[columnName]) return;
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

    // No retry guard needed: confirmed empirically on both SQLite (full
    // table-rebuild path) and MySQL (in-place MODIFY COLUMN) that re-running
    // changeColumn with the same target definition is already a safe no-op —
    // unlike addColumn there is no "already exists" failure mode to guard.
    async changeColumn(tableName, columnName, columnDef) {
      const qi = sequelize.getQueryInterface();
      await qi.changeColumn(tableName, columnName, columnDef, { transaction });
    },

    async addIndex(tableName, columns, options = {}) {
      const qi = sequelize.getQueryInterface();
      try {
        await qi.addIndex(tableName, columns, { ...options, transaction });
      } catch (err) {
        // Both dialects throw a plain DatabaseError (not a distinguished
        // class like UniqueConstraintError) for "index name already exists" —
        // confirmed empirically, for an explicit `options.name` and for
        // Sequelize's own deterministic auto-generated name alike. A retry
        // after a prior attempt's addIndex committed but a later step failed
        // hits this every time. Caught errors here don't poison the
        // transaction (confirmed on both dialects), so it's safe to keep
        // using it below. Verify the index actually landed before
        // swallowing, so an unrelated DDL error still surfaces.
        if (!/already exists|Duplicate key name/i.test(err.message)) throw err;
        const indexes = await qi.showIndex(tableName, { transaction });
        const columnList = Array.isArray(columns) ? columns : [columns];
        const alreadyThere = options.name
          ? indexes.some((i) => i.name === options.name)
          : indexes.some((i) => (i.fields || []).map((f) => f.attribute || f).join(',') === columnList.join(','));
        if (!alreadyThere) throw err;
        db.verboseLogger(2, `[MigrationEngine] addIndex on "${tableName}" hit a duplicate index name — treating as already applied from a prior attempt: ${err.message}`);
      }
    },

    async removeIndex(tableName, indexName, options = {}) {
      const qi = sequelize.getQueryInterface();
      // Check existence first — no-op if a prior attempt already removed it.
      // Confirmed empirically: SQLite's DROP INDEX is naturally idempotent
      // on a retry, but MySQL throws "Can't DROP '<name>'; check that
      // column/key exists" — the same "already applied" shape as every
      // other gap this hardening pass found, just on the removal side.
      const indexes = await qi.showIndex(tableName, { transaction });
      const stillThere = typeof indexName === 'string'
        ? indexes.some((i) => i.name === indexName)
        : indexes.some((i) => (i.fields || []).map((f) => f.attribute || f).join(',') === indexName.join(','));
      if (!stillThere) return;
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
      if (!hasTable(tables, tableName)) return;
      const timestamp = Date.now();
      const deprecatedName = `${tableName}_deprecated_${timestamp}`;
      await qi.renameTable(tableName, deprecatedName, { transaction });
    },

    async createTable(tableName, attributes, options = {}) {
      const qi = sequelize.getQueryInterface();
      await qi.createTable(tableName, attributes, { ...options, transaction });
    },

    /**
     * Bulk INSERT inside the migration transaction.
     * Attribute types are resolved from the registered model for the same
     * SQLite serialization reason described on bulkUpdate; `options.attributes`
     * overrides the lookup.
     *
     * Unlike addColumn/createTable, there is no cheap existence check for
     * "were these particular rows already inserted" — so a retry after a
     * prior attempt's insert committed but a later step failed re-runs the
     * same INSERT and collides on the primary/unique key. That collision
     * (Sequelize normalizes it to UniqueConstraintError on every dialect
     * tested — SQLite and MySQL both confirmed) is swallowed here rather
     * than left to crash the migration a second time: touches.rows already
     * verifies the intended rows exist after commit, so a duplicate-key
     * failure on retry means they do, just from the earlier attempt.
     */
    async bulkInsert(tableName, records, options = {}) {
      const qi = sequelize.getQueryInterface();
      const { attributes: override, ...rest } = options;
      const attributes = override || modelForTable(tableName)?.rawAttributes || null;
      try {
        await qi.bulkInsert(tableName, records, { ...rest, transaction }, attributes);
      } catch (err) {
        if (!(err instanceof SequelizeLib.UniqueConstraintError)) throw err;
        db.verboseLogger(2, `[MigrationEngine] bulkInsert into "${tableName}" hit a duplicate key — treating as already applied from a prior attempt: ${err.message}`);
      }
    },

    /**
     * Bulk UPDATE inside the migration transaction.
     * `where` is a Sequelize where-object; pass {} to update every row.
     * Use this for backfills — the query generator handles dialect-correct
     * identifier quoting, so camelCase columns survive on Postgres.
     *
     * The registered model is resolved automatically (see modelForTable) and
     * supplied twice — as `attributes` for the SET values and as `options.model`
     * for the WHERE values — so DATE/BOOLEAN/JSON serialize correctly on SQLite
     * on both sides of the statement. Pass `options.attributes` / `options.model`
     * only to override that lookup, e.g. for a table with no registered model.
     * @param {string} tableName
     * @param {Object} values - column → new value
     * @param {Object} [where] - where-object; {} means all rows
     */
    async bulkUpdate(tableName, values, where = {}, options = {}) {
      const qi = sequelize.getQueryInterface();
      const { attributes: attrOverride, model: modelOverride, ...rest } = options;
      const model = modelOverride || modelForTable(tableName);
      const attributes = attrOverride || model?.rawAttributes || null;
      await qi.bulkUpdate(
        tableName,
        values,
        where,
        { ...rest, transaction, ...(model ? { model } : {}) },
        attributes
      );
    },

    /**
     * Bulk DELETE inside the migration transaction.
     * `where` is a Sequelize where-object; pass {} to delete every row.
     *
     * The model is passed as Sequelize's fourth argument, which is what types
     * the WHERE values — without it, deleting `{ someDate: <Date> }` matches
     * nothing on SQLite and still reports success. Override with
     * `options.model` for a table with no registered model.
     * @param {string} tableName
     * @param {Object} [where] - where-object; {} means all rows
     */
    async bulkDelete(tableName, where = {}, options = {}) {
      const qi = sequelize.getQueryInterface();
      const { model: modelOverride, ...rest } = options;
      const model = modelOverride || modelForTable(tableName);
      await qi.bulkDelete(tableName, where, { ...rest, transaction }, model || undefined);
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
     * Does this table exist? Use this in migration guards instead of
     * `(await qi.showAllTables()).includes(name)`, which is case-sensitive and
     * therefore wrong on MySQL with lower_case_table_names=1. See hasTable().
     * @param {string} tableName
     * @returns {Promise<boolean>}
     */
    async tableExists(tableName) {
      const qi = sequelize.getQueryInterface();
      return hasTable(await qi.showAllTables({ transaction }), tableName);
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

/**
 * Resolve the set of registered model names that back the tables a migration
 * declares it touches.
 *
 * Scans every pending migration's `touches` for the categories that can
 * actually lose data: `columns` keys (table names whose columns are altered)
 * and `rows` keys (table names whose rows are backfilled). For each table
 * name, finds the registered Sequelize model whose `.tableName` matches,
 * using the same `modelForTable` resolution the query interface relies on.
 *
 * `touches.creates` is deliberately NOT backed up. A table a migration creates
 * is the one category that provably cannot lose data: either it does not exist
 * yet (nothing to export), or it already exists and the migration's idempotent
 * existence guard means the migration will not touch it. Including `creates`
 * here is what made the "scoped" backup export the entire table anyway — on a
 * live server, db-log's pure-create migration named eight dblog_* tables
 * holding ~900MB of stats, and the pre-migration backup loaded every row of
 * them into memory and OOM-killed the SquadJS process (exit 137) on mount.
 *
 * `models` is null if no pending migration declares any backup-worthy `touches`
 * metadata, so callers fall back to a full-db backup (original behaviour), and
 * an empty array if such touches exist but no table maps to a registered model.
 *
 * `unbacked` names the declared tables that resolved to no model, that no
 * pending migration creates, and that no migration declares `abandoned` —
 * s3-players, for one, lists the columns of the very table its migration
 * creates, and a table this run creates cannot lose data whatever else is
 * declared about it. `abandoned` covers the other exemption: a table whose
 * primary key had to change was replaced rather than altered, so the model
 * moved to the new table and the old one has none by design. The migration
 * that names it is a recorded contract and keeps running forever, so without
 * a way to say so, every such rename would abort every upgrade after it.
 * Those are the
 * silent half: a name the exporter is never even asked for leaves no trace in
 * the envelope, so the backup file reads `status: "ok"` on every line it does
 * contain while the table the migration is about to change is simply absent.
 * The caller decides what to do about it — it is only a real gap if the table
 * exists in this database, which a fresh install's does not.
 *
 * @param {object} dbService - DBService instance
 * @param {Array<object>} pending - Pending migration objects (with `touches`)
 * @returns {{models: string[]|null, unbacked: string[]}}
 */
function _resolveBackupModels(dbService, pending) {
  /** @type {Set<string>} */
  const tableNames = new Set();
  /** @type {Set<string>} Tables a pending migration declares it creates. */
  const createdNames = new Set();
  /** @type {Set<string>} Tables declared deliberately model-less. */
  const abandonedNames = new Set();
  // True if any pending migration declared `touches` at all — including a
  // creates-only declaration. Without this, a pure-create migration would
  // resolve to zero tables and fall through to the `tier: 'all'` full-database
  // backup, which is the very OOM this scoping exists to avoid.
  let sawTouches = false;

  for (const m of pending) {
    if (!m.touches) continue;
    sawTouches = true;
    // NOTE: touches.creates is intentionally skipped for the backup scope —
    // see the docblock above. It is still collected, because a table this same
    // run creates cannot lose data whatever else is declared about it, so it
    // must not be reported as an unbacked gap either.
    if (Array.isArray(m.touches.creates)) {
      for (const t of m.touches.creates) createdNames.add(t);
    }
    // Declared model-less on purpose. Collected from every pending migration,
    // not only the one that names the table in columns/rows, because the
    // declaration is a fact about the table rather than about one version.
    if (Array.isArray(m.touches.abandoned)) {
      for (const t of m.touches.abandoned) abandonedNames.add(t);
    }
    // Tables whose columns are altered (keys of touches.columns)
    if (m.touches.columns && typeof m.touches.columns === 'object') {
      for (const t of Object.keys(m.touches.columns)) tableNames.add(t);
    }
    // Tables whose rows are backfilled (keys of touches.rows)
    if (m.touches.rows && typeof m.touches.rows === 'object') {
      for (const t of Object.keys(m.touches.rows)) tableNames.add(t);
    }
  }

  if (!sawTouches) return { models: null, unbacked: [] };
  if (tableNames.size === 0) return { models: [], unbacked: [] };

  // Resolve table names → registered model names via the same lookup the
  // query interface uses for bulk operations.
  const modelNames = [];
  const resolved = new Set();
  const allModelNames = dbService.getModelNames?.() || [];
  for (const name of allModelNames) {
    const model = dbService.getModel(name);
    const table = model && (model.tableName || model.name);
    if (table && tableNames.has(table)) {
      modelNames.push(name);
      resolved.add(table);
    }
  }

  // Exact comparison, matching the resolution above rather than being kinder
  // than it. A declared `Big_Log` against a model whose tableName is `big_log`
  // is not exported either, so reporting it as backed would describe a file
  // that does not contain it.
  const unbacked = [...tableNames].filter((t) => !resolved.has(t) && !createdNames.has(t) && !abandonedNames.has(t));

  return { models: modelNames, unbacked };
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
    // Plugins whose next runMigrations() is a drift-repair re-application
    // rather than a first-time apply. Populated by DBService when it rolls a
    // version back to recover from drift.
    this._driftReapply = new Set();

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
   *   [{ version: number, description: string, up: async (qi) => void, down?: async (qi) => void, backup?: boolean, touches?: { creates?: string[], columns?: Record<string, string[]>, rows?: Record<string, string[]>, abandoned?: string[] } }]
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

      // ── touches (required) ────────────────────────────────────────
      // Every migration MUST declare the tables, columns, and data rows it
      // creates/alters/inserts. This enables _verifyMigrationResult() to confirm
      // the DDL/DML actually took effect after the migration commits, catching
      // permission issues that would otherwise go unnoticed (e.g. silent ADD
      // COLUMN failures when the MySQL user lacks ALTER TABLE privileges, or
      // silent row-insert failures from prior runs lost during a connector switch).
      //
      // Correct format:
      //   touches: {
      //     creates: ['TableA', 'TableB'],                        // new tables
      //     columns: { TableA: ['col1', 'col2'] },                // columns on existing tables
      //     rows: { TableA: [{ key: 'col', value: 'expected' }] } // seed rows (key=col to match, value=expected value)
      //   }
      //
      // A migration that touches no schema (e.g. a pure data migration) should
      // explicitly set touches: {} to indicate "intentionally no schema changes".
      // However, data-only migrations SHOULD declare touches.rows so drift
      // detection can confirm the seed rows actually exist on every mount.
      if (!m.touches || typeof m.touches !== 'object') {
        throw new Error(
          `Migration v${m.version} in "${pluginName}" is missing a "touches" declaration. ` +
          `Add touches: { creates: ['TableName'], columns: { TableName: ['col1','col2'] } } ` +
          `or touches: {} if the migration makes no schema changes.`
        );
      }

      // ── touches structural validation ────────────────────────────
      if (m.touches) {
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
        // Tables this migration names that no model backs, on purpose. The
        // only legitimate reason is a table the suite replaced rather than
        // altered, so this is deliberately not inferred: an unmodelled table
        // is normally the signature of a plugin that is installed but not
        // mounted, and that must keep aborting the run.
        if (m.touches.abandoned !== undefined) {
          if (!Array.isArray(m.touches.abandoned) || !m.touches.abandoned.every(t => typeof t === 'string')) {
            throw new Error(
              `Migration v${m.version} in "${pluginName}": touches.abandoned must be an array of table name strings.`
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
        // ── touches.rows validation ────────────────────────────
        // Each entry is a tableName → array of { key, value } objects
        // that must exist in the table after the migration commits.
        if (m.touches.rows !== undefined) {
          if (typeof m.touches.rows !== 'object' || m.touches.rows === null || Array.isArray(m.touches.rows)) {
            throw new Error(
              `Migration v${m.version} in "${pluginName}": touches.rows must be a Record<string, Array<{key, value}>>.`
            );
          }
          for (const [tableName, rowDefs] of Object.entries(m.touches.rows)) {
            if (!Array.isArray(rowDefs) || !rowDefs.every(r =>
              r && typeof r === 'object' && !Array.isArray(r) &&
              typeof r.key === 'string' && typeof r.value === 'string'
            )) {
              throw new Error(
                `Migration v${m.version} in "${pluginName}": touches.rows["${tableName}"] must be an array of { key: string, value: string } objects.`
              );
            }
          }
        }
        // ── touches.data validation ────────────────────────────
        // Post-conditions on column *values*, as opposed to touches.columns
        // which only asserts a column exists. A migration that adds a column
        // and backfills it can have the backfill silently do nothing — no rows
        // matched, an early return, a guard that skipped the branch — and
        // without this the version records as applied regardless.
        //
        //   data: { TableA: [{ column: 'col', notNull: true }] }
        //
        // An explicitly empty array means "author considered this table and
        // there is no invariant to assert"; the conformance harness treats it
        // as a deliberate opt-out rather than an omission.
        //
        // The predicate vocabulary is deliberately one word long. Every
        // predicate added is another thing that can be subtly wrong in a way
        // no one tests, and a rich assertion DSL becomes a second, worse
        // migration language. Add `equals` only when a real case demands it.
        if (m.touches.data !== undefined) {
          if (typeof m.touches.data !== 'object' || m.touches.data === null || Array.isArray(m.touches.data)) {
            throw new Error(
              `Migration v${m.version} in "${pluginName}": touches.data must be a Record<string, Array<{column, notNull}>>.`
            );
          }
          const KNOWN_PREDICATES = new Set(['column', 'notNull']);
          for (const [tableName, dataDefs] of Object.entries(m.touches.data)) {
            if (!Array.isArray(dataDefs)) {
              throw new Error(
                `Migration v${m.version} in "${pluginName}": touches.data["${tableName}"] must be an array of { column: string, notNull?: boolean } objects.`
              );
            }
            for (const def of dataDefs) {
              if (!def || typeof def !== 'object' || Array.isArray(def) || typeof def.column !== 'string' || def.column.length === 0) {
                throw new Error(
                  `Migration v${m.version} in "${pluginName}": touches.data["${tableName}"] entries must be objects with a non-empty "column" string.`
                );
              }
              // A typo'd predicate that silently passes is worse than no
              // assertion at all — the author believes they are covered.
              const unknown = Object.keys(def).filter(k => !KNOWN_PREDICATES.has(k));
              if (unknown.length > 0) {
                throw new Error(
                  `Migration v${m.version} in "${pluginName}": touches.data["${tableName}"].${def.column} has unknown predicate key(s): ${unknown.join(', ')}. Supported: notNull.`
                );
              }
              if (def.notNull !== undefined && typeof def.notNull !== 'boolean') {
                throw new Error(
                  `Migration v${m.version} in "${pluginName}": touches.data["${tableName}"].${def.column}.notNull must be a boolean.`
                );
              }
              if (def.notNull !== true) {
                throw new Error(
                  `Migration v${m.version} in "${pluginName}": touches.data["${tableName}"].${def.column} declares no assertion. Set notNull: true, or drop the entry.`
                );
              }
            }
          }
        }
      }
    }

    // Sort ascending by version

    const sorted = [...migrations].sort((a, b) => a.version - b.version);
    const prev = this._migrations.get(pluginName) || [];

    // Guard against duplicate registration — if all versions in sorted
    // are already present in prev, this is a re-registration (e.g. from
    // PlayersService calling registerMigrations from two init methods, or a
    // plugin remounting without a process restart). Must run BEFORE the gap
    // check below: re-registering the exact same set is not a gap, it's a
    // no-op, but the gap check can't tell the difference on its own.
    const prevVersions = new Set(prev.map((m) => m.version));
    const allExist = sorted.every((m) => prevVersions.has(m.version));
    if (allExist && prev.length > 0) {
      this.verboseLogger(4, `[MigrationEngine] Skipping re-registration: "${pluginName}" already has ${prev.length} migration(s).`);
      return;
    }

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
   * Record a group as applied without running it.
   *
   * For bootstrap groups only — the tables DBService creates unconditionally
   * during `mount()` because something needs them before the migration path
   * can open at all (`S3_Locks` is what serialises migrations; `S3_Servers` is
   * read by guards that run before the gate). Their DDL has already succeeded
   * by the time this is called, so there is nothing left to apply.
   *
   * They still need a registered group, because a table in no group has no
   * recorded version and `verifyLiveSchema()`'s drift check never looks at it.
   * But registering an expected version without ever recording it applied
   * leaves the group permanently behind: `verifySchemaVersions()` reports
   * pending forever, every consumer plugin's `verifyAndRunMigrations()` sees
   * drift, and operators are prompted at every boot to confirm a migration
   * whose work is already done.
   *
   * This closes that loop. It deliberately bypasses the confirmation gate,
   * which is not a hole in it: the gate exists so no schema changes under an
   * operator without their say-so, and this method changes no schema. It
   * writes one bookkeeping row describing DDL that has already committed.
   *
   * The caller must only reach this once the tables really exist. If a create
   * failed, leave the group behind on purpose — the ordinary confirm-and-run
   * path is then the recovery route, and it will retry the create.
   *
   * @param {string} pluginName - The bootstrap group
   * @returns {Promise<{recorded: number|null}>} The version written, or null if already at or ahead of it
   */
  async markBootstrapApplied(pluginName) {
    const migrations = this._migrations.get(pluginName);
    if (!migrations || migrations.length === 0) return { recorded: null };

    const target = migrations[migrations.length - 1];
    const applied = await this._getAppliedVersion(pluginName);
    if (applied >= target.version) return { recorded: null };

    // The real up() is hashed, not a stand-in, so the row is indistinguishable
    // from one a normal run would have written — the hash column is read as a
    // drift-recovery sentinel, and a bootstrap row must not look like one.
    await this._recordVersion(pluginName, target.version, target.up, undefined);
    this.verboseLogger(3, `[MigrationEngine] "${pluginName}" recorded at v${target.version} (bootstrap — DDL ran at mount).`);
    return { recorded: target.version };
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

    // Reassigned once the lock is held — see the re-check below. Read here as
    // well because the dry-run and confirmation gates both answer before any
    // lock is taken, and neither should acquire one to say "nothing to do".
    let appliedVersion = await this._getAppliedVersion(pluginName);
    let pending = this._getPendingMigrations(pluginName, appliedVersion);

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
    //
    // One implementation on all three dialects: a row in S3_Locks keyed by
    // lockKey. The native primitives this used to call — GET_LOCK on MySQL,
    // pg_try_advisory_lock on Postgres — are scoped to the CONNECTION that
    // called them, and every statement here goes through a pool, so acquire
    // and release landed on the same session only by luck. SQLite took no
    // cross-process lock at all: _s3_mutex serialises this process only, which
    // is exactly the guarantee that stops being enough with a second SquadJS
    // pointed at the same database. See acquireAdvisoryLock() in db-service.js.
    //
    // Failing to lock is fatal here on purpose — running a migration
    // unserialised is worse than not running it, and the operator gets a
    // message naming the reason.
    const lockKey = `s3_migrate_${pluginName}`;
    let locked = false;
    try {
      // No timeout literal here: the sizing argument belongs next to the
      // measurement it comes from, in LOCK_TTL_MS/LOCK_WAIT_MS.
      locked = await this.dbService.acquireAdvisoryLock(lockKey);
      if (!locked) {
        // Tagged, not just worded. The caller has to tell "another process is
        // migrating this" apart from every other migration failure in order to
        // decide whether re-checking can let it come up clean, and matching on
        // the message text would break the first time anyone rewords it.
        //
        // The two reasons a lock is refused read identically from here, and one
        // of them is not a race at all: a user without CREATE cannot have an
        // S3_Locks table, so every acquire fails closed forever. Reporting that
        // as "another migration is in progress" sends the operator looking for a
        // second server that does not exist, instead of at their GRANTs.
        const lockingAvailable = this.dbService.isLockingAvailable?.() !== false;
        let lockMessage = lockingAvailable
          ? `Could not acquire migration lock for "${pluginName}" — another migration is in progress ` +
            'and did not finish within the wait window.'
          : `Could not acquire migration lock for "${pluginName}" — the S3_Locks table could not be created, ` +
            'so migrations cannot be serialised and are refused rather than run unprotected.';

        // Run the locking outage through the same classifier a failed migration
        // uses. A grant too small to create S3_Locks is too small to migrate
        // anyway, so the operator's real problem is the privilege, and it should
        // read the same here as it would have three statements later.
        if (!lockingAvailable) {
          const hint = describePermissionError(this.dbService.getLocksInitError?.());
          if (hint) lockMessage += `\n\nThis looks like a database-permissions problem: ${hint}`;
        }

        const lockErr = new Error(lockMessage);
        lockErr.code = MIGRATION_LOCK_UNAVAILABLE;
        throw lockErr;
      }

      // Re-check under the lock. The pending list above was read BEFORE the
      // wait, and the whole point of waiting is that the other process was
      // changing the answer. A loser that skips this re-applies every migration
      // the winner just finished: idempotent `up()` bodies make that survivable
      // rather than harmless, since a one-time destructive step is guarded only
      // by `isReapply`, and the redundant backup and DDL are real work on a live
      // server.
      //
      // Coming up clean here is the specified behaviour on every dialect —
      // wait, re-check, and if the winner completed, report success having done
      // nothing. It is reported as skipped rather than applied because this
      // process applied nothing; the schema is nonetheless at the version the
      // caller asked for, which is what `applied: 0` with no error means.
      appliedVersion = await this._getAppliedVersion(pluginName);
      pending = this._getPendingMigrations(pluginName, appliedVersion);
      if (pending.length === 0) {
        this.verboseLogger(
          2,
          `[MigrationEngine] "${pluginName}" was migrated by another process while this one waited for the lock ` +
          `— now at v${appliedVersion}, nothing left to do.`
        );
        return { applied: 0, skipped: 0 };
      }

      // Pre-migration backup — produce BOTH formats for portability.
      // Tier 1: Fast SQLite file copy (if dbPath is available — SQLite only).
      // Tier 2: Connector-agnostic JSON export (works on all dialects, ensures
      // cross-connector portability for future Postgres/MySQL migration).
      // At least one must succeed; if both fail, the migration is aborted.
      //
      // Backup scope: only tables a pending migration can actually lose data
      // in — `touches.columns` and `touches.rows` — are backed up, rather than
      // the entire database. `touches.creates` is excluded on purpose: a table
      // a migration creates either does not exist yet, or already exists and
      // the idempotent existence guard means the migration leaves it alone.
      // A `tier: 'all'` export loads every row of every model into memory — on
      // a live server with years of stats in large logging tables, that can OOM
      // a Node.js process (exit code 137). If every pending migration
      // explicitly sets `backup: false`, the JSON backup is skipped entirely.
      let fileCopyResult = null;
      let jsonExportResult = null;

      // Determine backup scope from pending migrations' touches declarations
      const { models: backupModels, unbacked } = _resolveBackupModels(this.dbService, pending);
      const allBackupFalse = pending.length > 0 && pending.every((m) => m.backup === false);

      // A model whose table is not in the database yet holds nothing to lose,
      // and asking the exporter for it produces an incomplete envelope that
      // the check below discards — aborting a migration whose only fault is
      // that it has not run.
      //
      // Not hypothetical. A table whose primary key changed had to be replaced
      // rather than altered, so its model now points at a table the same run
      // creates, while `touches` names that new table because that is what the
      // migration builds. The declaration resolves, the model exists, and the
      // table does not — which is precisely the state in which there is
      // nothing to back up.
      //
      // Presence is read once from the live table list, through hasTable() so
      // that MySQL folding table names does not empty the scope. A list that
      // cannot be read leaves the scope alone: the same refusal to guess that
      // the unbacked check makes below, pointing the same way — toward backing
      // up more rather than less.
      let backupScope = backupModels;
      if (Array.isArray(backupModels) && backupModels.length > 0) {
        try {
          const live = await this.dbService.sequelize.getQueryInterface().showAllTables();
          const absent = [];
          backupScope = backupModels.filter((name) => {
            const table = this.dbService.getModel(name)?.tableName || name;
            if (hasTable(live, table)) return true;
            absent.push(`${name} (${table})`);
            return false;
          });
          if (absent.length > 0) {
            this.verboseLogger(
              2,
              `[MigrationEngine] Backup scope for "${pluginName}" excludes ${absent.join(', ')} — ` +
              'the table does not exist yet, so there is nothing in it to back up.'
            );
          }
        } catch (err) {
          this.verboseLogger(
            1,
            `[MigrationEngine] Could not list tables to scope the backup: ${err.message}. ` +
            'Backing up every model the pending migration(s) declare.'
          );
          backupScope = backupModels;
        }
      }

      // Tier 1: SQLite file copy (fast, binary-identical) — always full-db
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

      // Tier 2: JSON export
      if (allBackupFalse) {
        // Every pending migration explicitly opted out of backup — skip the
        // JSON export entirely. This is safe when every migration is a pure
        // createTable with an idempotent existence guard (no data migration,
        // no column changes, no backfills — nothing that can lose data).
        this.verboseLogger(2, `[MigrationEngine] JSON backup skipped — all ${pending.length} pending migration(s) for "${pluginName}" opted out (backup: false).`);
        jsonExportResult = { filename: 'skipped', sizeBytes: 0 };
      } else if (backupScope && backupScope.length === 0) {
        // Pending migrations declared `touches`, but none of it is data-bearing
        // — the only declarations were `creates` (a table a migration creates
        // cannot lose data: either it does not exist, or the idempotent guard
        // means the migration skips it), or the named tables map to no
        // registered model (which a full backup could not export either), or
        // every model they map to points at a table this database does not have
        // yet. Skipping here is what keeps a pure-create migration from falling
        // through to the `tier: 'all'` full-database export.
        this.verboseLogger(2, `[MigrationEngine] JSON backup skipped — pending migration(s) for "${pluginName}" touch no data-bearing table that exists in this database.`);
        jsonExportResult = { filename: 'skipped', sizeBytes: 0 };
      } else if (backupScope && backupScope.length > 0) {
        // Scoped backup — only the models backing tables this migration
        // actually touches. Prevents OOM on large datasets (e.g. years of
        // wound/death stats in a logging table that a createTable migration
        // will never modify).
        try {
          jsonExportResult = await jsonExportToFile(this.dbService, this.backupDir, {
            models: backupScope,
            retention: this.backupRetention
          });
          if (jsonExportResult) {
            this.verboseLogger(2, `[MigrationEngine] JSON backup created (scoped to ${backupScope.length} model(s)): ${jsonExportResult.filename} (${jsonExportResult.sizeBytes} bytes).`);
          }
        } catch (err) {
          this.verboseLogger(1, `[MigrationEngine] JSON backup failed: ${err.message}`);
          jsonExportResult = null;
        }
      } else {
        // No touches metadata on any pending migration — fall back to the
        // full-db backup (original behaviour, unchanged).
        try {
          jsonExportResult = await jsonExportToFile(this.dbService, this.backupDir, {
            tier: 'all',
            retention: this.backupRetention
          });
          if (jsonExportResult) {
            this.verboseLogger(2, `[MigrationEngine] JSON backup created (full — no touches metadata): ${jsonExportResult.filename} (${jsonExportResult.sizeBytes} bytes).`);
          }
        } catch (err) {
          this.verboseLogger(1, `[MigrationEngine] JSON backup failed: ${err.message}`);
          jsonExportResult = null;
        }
      }

      // A table named in `touches.columns` or `touches.rows` that no mounted
      // plugin registers a model for is the silent half of the same problem.
      // It is not merely missing from the export — it is never asked for, so
      // `filterByTier()` never sees it, the coverage stamp below has nothing to
      // report, and the branch above happily calls a run that exported nothing
      // "touches no data-bearing tables". That is the shape of an installed but
      // unmounted plugin, and it is how the archived production exports lost
      // db-log's eight tables while recording db-log as migrated in the same
      // file.
      //
      // Only a gap if the table is really there. On a fresh install, or when a
      // migration names a table a later one creates, there is nothing to lose
      // and nothing to abort over.
      //
      // Not applied when every pending migration set `backup: false`: that is an
      // explicit declaration that this run cannot lose data, and it claims no
      // backup to be wrong about.
      if (unbacked.length > 0 && !allBackupFalse) {
        let present = [];
        try {
          const live = await this.dbService.sequelize.getQueryInterface().showAllTables();
          present = unbacked.filter((t) => hasTable(live, t));
        } catch (err) {
          // Cannot prove it either way. Treat as present — the whole point is
          // to refuse to guess about what the backup contains.
          this.verboseLogger(1, `[MigrationEngine] Could not list tables to check backup coverage: ${err.message}. Assuming the unbacked table(s) exist.`);
          present = [...unbacked];
        }
        if (present.length > 0) {
          this.verboseLogger(
            1,
            `[MigrationEngine] The pre-migration backup for "${pluginName}" cannot cover ${present.join(', ')} — ` +
            'the migration changes those tables and no mounted plugin registers a model for them, so nothing exports them.'
          );
          stderrWarn(
            'MigrationEngine',
            `The pre-migration backup for "${pluginName}" cannot cover every table the migration changes.`,
            `No mounted plugin registers a model for: ${present.join(', ')}. Mount the plugin that owns them, or take a full backup by hand, before migrating.`
          );
          jsonExportResult = null;
        }
      }

      // A model the export was asked for that left no trace in the envelope is
      // not a backup gap the operator can see: `results` reports per model, and
      // a name that no `defineModel()` ever registered is dropped before the
      // export starts — so it appears in neither `tables` nor `results`, and
      // every remaining line reads `status: 'ok'`. The safety argument for
      // running a migration is that this file can undo it, and a file silently
      // missing a table the migration is about to change cannot.
      //
      // Deliberately narrow. A table the exporter TRIED and could not read is
      // reported separately below and does not block, because the commonest
      // cause of it is the drift this migration run exists to repair: a model
      // whose declared column is missing from the live table fails every read
      // until the repair lands.
      //
      // Discarding rather than throwing, because a SQLite file copy is the whole
      // database and is a complete backup on its own. The abort below fires only
      // when this was the only one.
      if (jsonExportResult && jsonExportResult.filename !== 'skipped' && jsonExportResult.complete === false) {
        const gaps = (jsonExportResult.incomplete || [])
          .map((g) => `${g.model} (${g.reason})`)
          .join(', ');
        this.verboseLogger(
          1,
          `[MigrationEngine] JSON backup for "${pluginName}" is incomplete and will not be counted as a backup — ` +
          `missing: ${gaps}.`
        );
        stderrWarn(
          'MigrationEngine',
          `The pre-migration JSON backup for "${pluginName}" did not cover everything it was asked for.`,
          `Missing: ${gaps}`
        );
        jsonExportResult = null;
      }

      // Loud but not fatal — see above.
      if (jsonExportResult && jsonExportResult.failedTables?.length) {
        const failed = jsonExportResult.failedTables.map((g) => `${g.model} (${g.reason})`).join(', ');
        this.verboseLogger(
          1,
          `[MigrationEngine] The pre-migration backup for "${pluginName}" could not read: ${failed}. ` +
          'If this run is a drift repair, that is expected — the table cannot be read until it is repaired.'
        );
      }

      // Informational, and only ever present on a full-database fallback export.
      // Names tables the process could not have exported because nothing
      // registered a model for them — the gap an "ok on every line" envelope has
      // no other way to report.
      if (jsonExportResult && jsonExportResult.unexportedTables?.length) {
        this.verboseLogger(
          1,
          `[MigrationEngine] The pre-migration backup does not cover ${jsonExportResult.unexportedTables.length} ` +
          `table(s) in this database, because no mounted plugin registers a model for them: ` +
          `${jsonExportResult.unexportedTables.join(', ')}.`
        );
      }

      if (!fileCopyResult && !jsonExportResult) {
        const msg = `[MigrationEngine] Backup FAILED for "${pluginName}" — aborting migration. Both file copy and JSON export failed. Check disk space, permissions, and DB connectivity.`;
        this.verboseLogger(1, msg);
        stderrError('MigrationEngine', `Backup failed for "${pluginName}" — migration aborted before any schema change.`,
          'Both the file copy and the JSON export failed. Check disk space, file permissions on the backup directory, and DB connectivity.');
        throw new Error(msg);
      }

      this.verboseLogger(2, `[MigrationEngine] Running ${pending.length} migration(s) for "${pluginName}"...`);

      let applied = 0;
      // Drift recovery re-runs migrations that were already applied once. Tell
      // up() which situation it is in so a destructive one-time step can be
      // skipped on the repair pass — see the isReapply docs on the qi object.
      //
      // Two sources, because _driftReapply is per-PROCESS and the version row it
      // describes is shared by every process on the database. Process A can
      // detect the drift and roll the row back while process B is the one that
      // actually re-applies, and B's engine has an empty set — so B would run
      // the migration as a first-time apply and repeat a one-time destructive
      // step. The recorded hash is the same decision, written where both can
      // see it.
      const isReapply =
        this._driftReapply.has(pluginName) ||
        ((await this.dbService.isDriftReapplyRecorded?.(pluginName)) === true);
      for (const migration of pending) {
        try {
          // Step 1: Run up() inside a transaction
          await this.dbService.withTransactionWithRetry(async (transaction) => {
            const qi = createQueryInterface(this.dbService.sequelize, this.dbService, transaction, { isReapply });
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
          // Single choke point for migration failure diagnostics: every caller
          // (autoMigrate, !s3 migrate force, !s3 confirm, a plugin's own
          // verifyAndRunMigrations) funnels through this loop, and the Discord
          // embed only carries err.message — the stack dies here otherwise.
          // Mirrored to stderr so `2>` redirection captures it, then re-thrown
          // unchanged so existing handling is untouched, except for a
          // permission-error guidance line appended to err.message itself —
          // that's the one field every caller actually reads (Discord's
          // failEmbed included), so enriching it here is what makes the
          // guidance visible everywhere the raw error already was.
          const permissionHint = describePermissionError(err);
          if (permissionHint) {
            err.message += `\n\nThis looks like a database-permissions problem: ${permissionHint}`;
          }
          stderrError(
            'MigrationEngine',
            `"${pluginName}" v${appliedVersion} -> v${migration.version} failed: ${err.message}`,
            err
          );
          this.verboseLogger(1, `[MigrationEngine] "${pluginName}" v${migration.version} failed: ${err.message}`);
          throw err; // Re-throw so the calling code knows the batch failed
        }
      }

      // The repair pass is over. Clearing here — not on the drift path — means
      // a later ordinary migration for this plugin is treated as a first-time
      // apply again and still gets its one-time destructive step.
      this._driftReapply.delete(pluginName);

      return { applied, skipped: pending.length - applied };
    } finally {
      if (locked) {
        await this.dbService.releaseAdvisoryLock(lockKey);
      }
    }
  }

  /**
   * Migrations registered for a plugin, lowest version first.
   *
   * Exposed so DBService's drift recovery can ask which migration owns a
   * column that has gone missing, instead of assuming it was the most recent
   * one. Returns a copy — callers must not mutate the registry.
   *
   * @param {string} pluginName
   * @returns {Array<Object>} registered migrations, or [] if none
   */
  getMigrations(pluginName) {
    return [...(this._migrations.get(pluginName) || [])];
  }

  /**
   * The exact DDL an operator has to run by hand, for the connected dialect.
   *
   * ─── WHY THIS EXISTS ───
   *
   * The live MySQL grant is CREATE without ALTER, so every `ADD COLUMN` in
   * every future migration is un-runnable by the plugin on the deployment this
   * repo is actually written for. That is the normal path here, not an
   * exception. What the operator got until now was "migration failed" plus a
   * driver error, leaving them to reconstruct the statement from the model
   * definition — for a column whose type they cannot see without reading the
   * source.
   *
   * ─── WHY IT IS GENERATED AND NOT WRITTEN ───
   *
   * Every statement comes out of Sequelize's own query generator, the same
   * object that would have produced the statement the migration tried to run.
   * A hand-written template would be a second source of truth for column types,
   * quoting and dialect syntax, and would start drifting from the models the
   * first time anyone changed one. Generated this way it cannot: the SQL an
   * operator pastes is the SQL the engine would have issued.
   *
   * ─── ONE DELIBERATE DEPARTURE ───
   *
   * Indexes are emitted as bare `CREATE INDEX`, NOT via the generator's
   * `addIndexQuery()`. Verified 2026-09-05: on MySQL that method renders
   * `ALTER TABLE ... ADD INDEX`, which is precisely the grant the operator is
   * working around — so following the generator there would hand them a script
   * that fails on the engine it was generated for. SQLite and Postgres render
   * `CREATE INDEX` either way, so the bare form is correct on all three.
   *
   * Only genuinely missing objects are emitted: tables absent from
   * `showAllTables()`, columns absent from `describeTable()`, indexes absent
   * from `showIndex()`. Table comparison is case-insensitive because production
   * MySQL runs with `lower_case_table_names=1`.
   *
   * @param {{pluginName?: string}} [opts] - restrict to one migration group.
   * @returns {Promise<{dialect: string, statements: Array<{pluginName: string, version: number, table: string, kind: string, sql: string}>, notes: string[]}>}
   */
  async buildHandApplyDdl({ pluginName = null } = {}) {
    const db = this.dbService;
    const out = { dialect: db.getDialect?.() || 'unknown', statements: [], notes: [] };

    const connector = db.getConnector?.();
    if (!connector) {
      out.notes.push('No database connector — nothing to generate.');
      return out;
    }
    const qi = connector.getQueryInterface();
    const qg = qi.queryGenerator || qi.QueryGenerator;
    if (!qg) {
      out.notes.push('This Sequelize build exposes no query generator, so DDL cannot be rendered.');
      return out;
    }
    const q = (id) => db.quoteIdentifier(id);

    const status = await db.verifySchemaVersions();
    let pending = status.pending || [];
    if (pluginName) pending = pending.filter((p) => p.pluginName === pluginName);
    if (pending.length === 0) return out;

    let liveTables = new Set();
    try {
      const rows = await qi.showAllTables();
      liveTables = new Set(rows.map((r) => String(r?.tableName ?? r).toLowerCase()));
    } catch (err) {
      out.notes.push(`Could not list tables (${err.message}) — every table is treated as already present, so only column statements are emitted.`);
    }

    const describeCache = new Map();
    const columnsOf = async (table) => {
      const key = table.toLowerCase();
      if (describeCache.has(key)) return describeCache.get(key);
      let cols = new Set();
      try {
        const desc = await qi.describeTable(table);
        cols = new Set(Object.keys(desc || {}).map((c) => c.toLowerCase()));
      } catch { /* absent or unreadable — the caller decides what that means */ }
      describeCache.set(key, cols);
      return cols;
    };

    const indexCache = new Map();
    const indexesOf = async (table) => {
      const key = table.toLowerCase();
      if (indexCache.has(key)) return indexCache.get(key);
      let names = new Set();
      try {
        const rows = await qi.showIndex(table);
        names = new Set(rows.map((r) => r.name));
      } catch { /* same */ }
      indexCache.set(key, names);
      return names;
    };

    const seen = new Set();
    const push = (statement) => {
      if (seen.has(statement.sql)) return;
      seen.add(statement.sql);
      out.statements.push(statement);
    };

    const emitIndexes = async (model, table, context, existing) => {
      for (const index of model.options?.indexes || []) {
        if (!index?.name || !Array.isArray(index.fields)) continue;
        if (existing.has(index.name)) continue;
        push({
          ...context,
          table,
          kind: 'index',
          sql: `CREATE INDEX ${q(index.name)} ON ${q(table)} (${index.fields.map(q).join(', ')});`
        });
      }
    };

    for (const target of pending) {
      const registered = (this._migrations.get(target.pluginName) || [])
        .filter((m) => m.version > target.currentVersion)
        .sort((a, b) => a.version - b.version);

      for (const migration of registered) {
        const context = { pluginName: target.pluginName, version: migration.version };
        const touches = migration.touches;
        if (!touches) {
          out.notes.push(
            `${target.pluginName} v${migration.version} declares no \`touches\`, so its DDL cannot be derived — ` +
            'it has to be applied by running the migration itself.'
          );
          continue;
        }

        // ── tables the migration creates ──
        for (const table of touches.creates || []) {
          if (liveTables.has(String(table).toLowerCase())) continue;
          const model = db.getModelForTable(table);
          if (!model) {
            out.notes.push(`No registered model resolves to table \`${table}\` — its CREATE TABLE cannot be rendered.`);
            continue;
          }
          const attributes = qg.attributesToSQL(model.rawAttributes, { context: 'createTable', table });
          push({ ...context, table, kind: 'table', sql: qg.createTableQuery(table, attributes, {}) });
          // A new table's indexes are always missing, by definition.
          await emitIndexes(model, table, context, new Set());
        }

        // ── columns added to tables that already exist ──
        for (const [table, columns] of Object.entries(touches.columns || {})) {
          if (!liveTables.has(String(table).toLowerCase())) continue; // covered by the CREATE above
          const model = db.getModelForTable(table);
          if (!model) {
            out.notes.push(`No registered model resolves to table \`${table}\` — its ADD COLUMN statements cannot be rendered.`);
            continue;
          }
          const present = await columnsOf(table);
          for (const column of columns || []) {
            if (present.has(String(column).toLowerCase())) continue;
            const attribute = model.rawAttributes?.[column];
            if (!attribute) {
              out.notes.push(
                `\`${table}.${column}\` is declared in \`touches\` but is not an attribute of model ` +
                `\`${model.name}\` — check whether \`touches\` was written in model names rather than table names.`
              );
              continue;
            }
            const normalized = typeof qi.normalizeAttribute === 'function'
              ? qi.normalizeAttribute(attribute)
              : attribute;
            push({ ...context, table, kind: 'column', sql: qg.addColumnQuery(table, column, normalized) });
          }
          await emitIndexes(model, table, context, await indexesOf(table));
        }
      }
    }

    return out;
  }

  /**
   * Mark plugins whose next migration run repairs drift rather than applying
   * for the first time. Consumed once, by the next runMigrations() for each.
   *
   * @param {string[]} pluginNames
   */
  markDriftReapply(pluginNames) {
    for (const name of pluginNames) this._driftReapply.add(name);
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
   * Verify that everything declared in migration.touches actually took effect
   * after up() committed. Runs outside any transaction to avoid dialect-specific
   * issues with describeTable inside user transactions.
   *
   * - If migration.touches is absent, verification is skipped (backward compatible).
   * - Checks showAllTables() for each entry in touches.creates.
   * - Checks describeTable() for every table named in touches.columns, whether
   *   or not that table is also in touches.creates.
   * - Checks touches.rows exist, by reading the named table directly.
   * - Checks touches.data post-conditions hold, by counting nulls in it.
   * - Collects all failures and throws one composite error.
   *
   * @param {{ touches?: { creates?: string[], columns?: Record<string, string[]>, rows?: Object, data?: Object } }} migration
   * @param {Object} qi - QueryInterface object (transaction must be null for DDL state checks)
   * @throws {Error} If any declared effect is absent from the live database
   */
  async _verifyMigrationResult(migration, qi) {
    if (!migration.touches) return;

    const q = (id) => this.dbService.quoteIdentifier(id);
    const failures = [];

    // ── Verify touches.creates ───────────────────────────────
    // Tables that failed to appear are recorded so the column, row and data
    // checks below can skip them — a table that does not exist would otherwise
    // produce a second failure for every column and every assertion on it,
    // burying the one line that says what actually went wrong.
    const missingTables = new Set();
    if (migration.touches.creates) {
      const existing = await qi.showAllTables();
      for (const tableName of migration.touches.creates) {
        if (!hasTable(existing, tableName)) {
          failures.push(`Table "${tableName}" was not created (permission denied?)`);
          missingTables.add(tableName);
        }
      }
    }

    // ── Verify touches.columns ───────────────────────────────
    // Every table named in touches.columns is described, not only those also
    // listed in touches.creates. addColumn on a pre-existing table is the
    // common case (and the one that fails on a DB user without ALTER grants),
    // so restricting this to created tables verified nothing where it mattered.
    if (migration.touches.columns) {
      for (const [tableName, cols] of Object.entries(migration.touches.columns)) {
        // A table we already reported as uncreated would only produce a second,
        // noisier failure for each of its columns.
        if (missingTables.has(tableName)) continue;
        let actual;
        try {
          actual = await qi.sequelize.getQueryInterface().describeTable(tableName);
        } catch (err) {
          failures.push(`Column verification: cannot describe "${tableName}": ${err.message}`);
          continue;
        }
        for (const col of cols) {
          if (!actual[col]) {
            failures.push(`Column "${tableName}.${col}" missing after migration`);
          }
        }
      }
    }

    // ── Verify touches.rows ──────────────────────────────────
    // A table name is resolved to a table, not to a model. `touches` is keyed
    // by TABLE name everywhere it is documented, but this used to look the
    // name up in the model registry and query whatever table that model
    // currently points at — which stops being the same table the moment a
    // model is repointed. switch v2 and v4 both write to SwitchPlugin_Settings
    // and the model of that name now backs SwitchPlugin_ServerSettings, so on
    // a fresh install their verification ran its SELECT against a table that
    // v9 had not created yet and failed two migrations that had done exactly
    // what they said. Reading the table by name cannot drift that way.
    //
    // Every identifier is quoted, which is also what makes `key` usable as a
    // column name here: unquoted it is reserved on MySQL alone.
    if (migration.touches.rows) {
      for (const [tableName, rowDefs] of Object.entries(migration.touches.rows)) {
        if (missingTables.has(tableName)) continue;
        for (const { key, value } of rowDefs) {
          let rows;
          try {
            rows = await qi.rawQuery(
              `SELECT ${q(key)} FROM ${q(tableName)} WHERE ${q(key)} = :value`,
              { value }
            );
          } catch (err) {
            failures.push(`Row verification: cannot read "${tableName}": ${err.message}`);
            continue;
          }
          if (!rows || rows.length === 0) {
            failures.push(`Row "${key}=${value}" not found in "${tableName}" after migration`);
          }
        }
      }
    }

    // ── Verify touches.data ──────────────────────────────────
    // The column existing proves the DDL ran; it says nothing about whether the
    // backfill that was supposed to populate it did anything. On a server whose
    // DB user has no ALTER grant the schema is applied by hand, so the data step
    // is the only part of up() the engine actually executes — a silent no-op
    // there is invisible by construction unless something counts the rows.
    if (migration.touches.data) {
      for (const [tableName, dataDefs] of Object.entries(migration.touches.data)) {
        if (dataDefs.length === 0) continue; // explicit "no invariant here"
        if (missingTables.has(tableName)) continue;
        for (const def of dataDefs) {
          let offenders;
          try {
            // Same reasoning as touches.rows above: count the nulls in the
            // table the migration named, not in whatever table a model of
            // that name happens to back.
            const counted = await qi.rawQuery(
              `SELECT COUNT(*) AS ${q('n')} FROM ${q(tableName)} WHERE ${q(def.column)} IS NULL`
            );
            offenders = Number(counted?.[0]?.n ?? 0);
          } catch (err) {
            failures.push(`Data verification failed for "${tableName}.${def.column}": ${err.message}`);
            continue;
          }
          if (offenders > 0) {
            failures.push(
              `${offenders} row(s) in "${tableName}" still have NULL "${def.column}" after migration ` +
              `(the backfill matched nothing — check the guard around it)`
            );
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

  /* ─────────────────────── ROW DRIFT EXPOSURE ─────────────────────── */

  /**
   * Aggregate all touches.rows declarations from ALL registered migrations
   * across ALL plugins. Returns a Map<tableName → Array<{ key, value }>>.
   *
   * This is consumed by DBService.verifyLiveSchema() so that ongoing drift
   * detection (on every mount) can confirm seed rows still exist — not just
   * at migration time, but across restarts, connector changes, and DB restores.
   *
   * @returns {Map<string, Array<{key: string, value: string}>>}
   */
  getExpectedRows() {
    const result = new Map();
    for (const migrations of this._migrations.values()) {
      for (const m of migrations) {
        if (m.touches?.rows) {
          for (const [tableName, rowDefs] of Object.entries(m.touches.rows)) {
            if (!result.has(tableName)) {
              result.set(tableName, []);
            }
            // Merge in new rows, avoiding duplicates (same key+value)
            const existing = result.get(tableName);
            for (const def of rowDefs) {
              const alreadyExists = existing.some(
                e => e.key === def.key && e.value === def.value
              );
              if (!alreadyExists) {
                existing.push({ key: def.key, value: def.value });
              }
            }
          }
        }
      }
    }
    return result;
  }

  /**
   * Aggregate all touches.data declarations from ALL registered migrations
   * across ALL plugins. Returns a Map<tableName → Array<{ column, notNull }>>.
   *
   * Consumed by DBService.verifyLiveSchema() so a declared data post-condition
   * is re-checked on every mount, not only in the moments after the migration
   * ran. A migration recorded as applied on a server that then loses the data —
   * a restore from an older dump, a connector switch, a hand-run UPDATE — would
   * otherwise never be looked at again, because nothing re-runs a version the
   * tracker already considers current.
   *
   * Only ever declare a predicate here that holds for the lifetime of the table.
   * A column that legitimately accepts NULL for rows written *after* the
   * migration is not an invariant, and asserting it as one puts the plugin into
   * a rollback-and-re-gate loop on every mount forever.
   *
   * @returns {Map<string, Array<{column: string, notNull: boolean}>>}
   */
  getExpectedData() {
    const result = new Map();
    for (const migrations of this._migrations.values()) {
      for (const m of migrations) {
        if (!m.touches?.data) continue;
        for (const [tableName, dataDefs] of Object.entries(m.touches.data)) {
          if (dataDefs.length === 0) continue; // explicit "no invariant here"
          if (!result.has(tableName)) {
            result.set(tableName, []);
          }
          const existing = result.get(tableName);
          for (const def of dataDefs) {
            if (!existing.some(e => e.column === def.column)) {
              existing.push({ column: def.column, notNull: def.notNull === true });
            }
          }
        }
      }
    }
    return result;
  }
}
