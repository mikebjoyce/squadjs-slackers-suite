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
 *   getDialect()                — Returns the TRUE SQL dialect (use this, not
 *                                  getConnectorName(), to branch on SQL syntax).
 *   quoteIdentifier(name)       — Dialect-correct identifier quoting.
 *   escapeValue(value)          — Dialect-correct SQL string literal escaping.
 *   incrementLiteral(col, n)    — Portable atomic `col + n` update expression.
 *   caseInsensitiveLikeOp()     — Op.iLike on Postgres, Op.like elsewhere.
 *   caseInsensitiveLikeLiteral(col, term, opts) — Portable case-insensitive LIKE
 *                                  literal with a working ESCAPE clause.
 *                                  `{ exact: true }` drops the wildcards for a
 *                                  whole-value compare that stays
 *                                  case-insensitive on every dialect.
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
 * - Dialect portability: any raw SQL (Sequelize.literal, connector.query(),
 *   bootstrap DDL) that names a camelCase identifier MUST quote it via
 *   quoteIdentifier(). Postgres folds unquoted identifiers to lower case while
 *   Sequelize creates camelCase columns quoted, so the two stop agreeing —
 *   invisibly on SQLite and MySQL, fatally on Postgres. See the helper block
 *   under "DIALECT PORTABILITY" and s3/testing/test-dialect-portability.js.
 *
 */
import SequelizeLib from 'sequelize';
import MigrationEngine, { countNullColumn } from './migration-engine.js';
import { stderrError, stderrWarn } from './s3-stderr.js';

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

    // Drift alert callback — called when post-migration drift is detected
    this._driftAlertCallback = null;     // Set by S³ plugin owner to fire Discord notifications

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
    //
    // CRITICAL: registering ANY unhandledRejection listener replaces Node's
    // default handler for the WHOLE process — not just for the rejections this
    // one recognises. Node does not print, and does not exit, once a listener
    // exists. So an early `return` on the branch below would silently swallow
    // every unhandled rejection in SquadJS, ours and every other plugin's, from
    // the moment this service mounts.
    //
    // That is not hypothetical: it hid a failed S³ mount completely. A DB user
    // without a CREATE grant made PlayersService's bootstrap DDL throw, the
    // rejection propagated to SquadJS's un-caught `main()`, and the result was
    // a half-mounted S³ with zero output on either stream — the server carried
    // on as if nothing had happened.
    //
    // So anything this handler does not positively recognise is reported, not
    // dropped. It is deliberately not re-thrown: restoring the crash would let
    // any unrelated plugin's stray rejection take the game server down, which
    // is a worse failure than a loud log line.
    this._unhandledRejectionHandler = (reason) => {
      if (
        reason &&
        (DBService.isNetworkError(reason) || reason.name === 'SequelizeConnectionError')
      ) {
        this.verboseLogger(4, `[DB] Suppressed unhandled rejection (Sequelize internal): ${reason?.message || reason}`);
        return;
      }
      const message = reason?.message || String(reason);
      this.verboseLogger(1, `[DB] UNHANDLED REJECTION: ${message}`);
      stderrError(
        'UnhandledRejection',
        `An unhandled promise rejection reached the process: ${message}`,
        reason instanceof Error ? reason : undefined
      );
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

  /* ────────────────────────────────────── DIALECT PORTABILITY ────────────────────────────────────── */

  /**
   * The true SQL dialect of the active connector.
   *
   * Prefer this over getConnectorName() whenever the answer decides which SQL
   * to emit. getConnectorName() returns the *connector label* from config.json
   * (`databaseOption`), which is only conventionally the dialect name — a
   * connector keyed as "main" or "s3" would return that string and silently
   * miss every dialect branch.
   *
   * @returns {'sqlite'|'mysql'|'postgres'|string|null} dialect, or null with no connector.
   */
  getDialect() {
    if (this.sequelize && typeof this.sequelize.getDialect === 'function') {
      return this.sequelize.getDialect();
    }
    // Raw config object (not a live Sequelize instance) — resolveConnector may
    // hand back the config straight from the connectors map.
    if (this.sequelize && typeof this.sequelize.dialect === 'string') {
      return this.sequelize.dialect;
    }
    if (this.sequelize && typeof this.sequelize.storage === 'string') {
      return 'sqlite';
    }
    return null;
  }

  /**
   * Quote a table or column identifier for the active dialect.
   *
   * **Why this exists.** Postgres folds unquoted identifiers to lower case.
   * Sequelize creates camelCase columns *quoted* (`"tokenBalance"`), so any raw
   * SQL that names one unquoted resolves to `tokenbalance` and errors with
   * `column "tokenbalance" does not exist`. SQLite ignores identifier case and
   * MySQL column names are case-insensitive, which is why this class of defect
   * is invisible until a Postgres URL is pointed at the suite.
   *
   * **The rule:** a raw SQL fragment — `Sequelize.literal`, `connector.query()`,
   * bootstrap DDL — is Postgres-safe only if every identifier it names is
   * already all-lowercase. Anything camelCase must come through here.
   *
   * @param {string} identifier - Bare table or column name.
   * @returns {string} Dialect-quoted identifier (`"x"` on Postgres, `` `x` `` elsewhere).
   */
  quoteIdentifier(identifier) {
    const name = String(identifier);
    if (this.sequelize && typeof this.sequelize.getQueryInterface === 'function') {
      try {
        return this.sequelize.getQueryInterface().quoteIdentifier(name);
      } catch {
        // Fall through to the static form below.
      }
    }
    // No live connector (no-op mode / raw config). Emit the ANSI form, which is
    // correct for SQLite and Postgres; MySQL only differs when ANSI_QUOTES is off,
    // and without a connector there is nothing to execute the SQL against anyway.
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Escape a value into a literal SQL string constant for the active dialect.
   * Use when a value must be inlined into a `Sequelize.literal` rather than bound.
   *
   * @param {*} value
   * @returns {string} Quoted, escaped SQL literal (e.g. `'%O''Brien%'`).
   */
  escapeValue(value) {
    if (this.sequelize && typeof this.sequelize.escape === 'function') {
      return this.sequelize.escape(value);
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  /**
   * Build a dialect-safe atomic increment expression for `Model.update()`.
   *
   * Use instead of a hand-written `Sequelize.literal('col + 1')` whenever the
   * column is camelCase. `Model.increment()` is preferable for a *pure*
   * increment, but does not fit when the same statement must also set other
   * columns atomically (as the Switch seed-bonus grants do).
   *
   * @param {string} column     - Column name (quoted for you).
   * @param {number} [amount=1] - Integer amount to add; may be negative.
   * @returns {object} A Sequelize literal suitable as an update field value.
   */
  incrementLiteral(column, amount = 1) {
    const n = Number(amount);
    if (!Number.isFinite(n)) {
      throw new Error(`incrementLiteral requires a finite numeric amount, got ${amount}`);
    }
    const expr = `${this.quoteIdentifier(column)} ${n < 0 ? '-' : '+'} ${Math.abs(n)}`;
    const literal = this.sequelize && typeof this.sequelize.literal === 'function'
      ? this.sequelize.literal.bind(this.sequelize)
      : null;
    if (!literal) {
      // No-op mode: hand back a shape the mock/no-connector paths still recognise.
      return { val: expr };
    }
    return literal(expr);
  }

  /**
   * The Sequelize operator giving case-INsensitive `LIKE` on the active dialect.
   *
   * MySQL's default collation is case-insensitive and SQLite's `LIKE` is
   * case-insensitive for ASCII, so `Op.like` already behaves this way on both.
   * Postgres `LIKE` is case-sensitive and needs `Op.iLike` — which is a syntax
   * error on the other two, so the branch is mandatory rather than cosmetic.
   *
   * @returns {symbol} `Op.iLike` on Postgres, `Op.like` elsewhere.
   */
  caseInsensitiveLikeOp() {
    const Op = this.sequelize?.constructor?.Op || SequelizeLib.Op;
    return this.getDialect() === 'postgres' ? Op.iLike : Op.like;
  }

  /**
   * Build a case-insensitive substring match as a raw literal, for the cases
   * that also need a `LIKE ... ESCAPE` clause (which `Op.like` cannot express).
   *
   * Handles three things that are easy to get wrong by hand:
   *   1. The column is quoted, so camelCase survives Postgres identifier folding.
   *   2. The term is escaped through the connector, so an apostrophe in a player
   *      name cannot break — or inject into — the statement.
   *   3. `%`, `_` and the escape character itself are neutralised so they match
   *      literally instead of acting as wildcards.
   *
   * **The escape character is `!`, not `\`.** A backslash cannot be made
   * portable: MySQL processes backslash escapes inside string literals (so the
   * escape char must be written `'\\'`), while SQLite and Postgres do not (so it
   * must be written `'\'`). Either spelling is a hard error on the other engines
   * — `'\\'` fails on SQLite with *"ESCAPE expression must be a single
   * character"*. `!` needs no escaping in any of the three.
   *
   * Pass `{ exact: true }` to drop the surrounding wildcards and compare the
   * whole column case-insensitively. That is not the same as `col = 'term'`:
   * equality is case-**sensitive** on Postgres and on any binary-collated MySQL
   * column, whereas a wildcard-free LIKE/ILIKE stays case-insensitive on all
   * three engines while still escaping the term literally.
   *
   * Pass `{ trimColumn: true }` to compare against `TRIM(col)` rather than the
   * stored value. Mostly pointless for a substring match, but essential with
   * `exact`: game clients routinely store names with surrounding whitespace
   * (in one production Squad data set 10,604 of 11,787 player names had a
   * leading space), so an exact compare against the raw column silently matches
   * almost nothing. `TRIM()` is standard SQL and behaves identically on SQLite,
   * MySQL and Postgres. Note this defeats an index on the column — fine for a
   * player-name lookup, think twice on a hot path.
   *
   * @param {string} column - Column to match against (quoted for you).
   * @param {string} term   - Raw user-supplied search term.
   * @param {object} [opts]
   * @param {boolean} [opts.exact=false] - Match the whole value instead of a substring.
   * @param {boolean} [opts.trimColumn=false] - Compare against TRIM(column).
   * @returns {object} A Sequelize literal usable as a `where`, including inside `Op.or`.
   */
  caseInsensitiveLikeLiteral(column, term, opts = {}) {
    const escaped = String(term)
      .replace(/!/g, '!!')
      .replace(/%/g, '!%')
      .replace(/_/g, '!_');
    const keyword = this.getDialect() === 'postgres' ? 'ILIKE' : 'LIKE';
    const pattern = opts.exact ? escaped : `%${escaped}%`;
    const target = opts.trimColumn
      ? `TRIM(${this.quoteIdentifier(column)})`
      : this.quoteIdentifier(column);
    const expr =
      `${target} ${keyword} ${this.escapeValue(pattern)} ESCAPE '!'`;
    const literal = this.sequelize && typeof this.sequelize.literal === 'function'
      ? this.sequelize.literal.bind(this.sequelize)
      : null;
    return literal ? literal(expr) : { val: expr };
  }

  /**
   * Acquire an advisory lock scoped to a logical key (e.g. 's3_migrate_s3-players').
   * Prevents concurrent execution of critical sections across multiple processes.
   *
   * - SQLite: already serialized by _s3_mutex — returns true immediately.
   * - Postgres: uses pg_try_advisory_lock(hashtext(key)) — non-blocking, returns false if held.
   * - MySQL: uses GET_LOCK(key, timeout) — waits up to timeoutMs.
   *
   * ⚠️ **KNOWN LIMITATION — branches on the connector LABEL, not the dialect.**
   * `getConnectorName()` returns `databaseOption`, which is the key of the
   * connector in `config.json`'s `connectors` block. SquadJS does not constrain
   * that key: `squad-server/factory.js` reads the dialect from the connector's
   * *config value* and uses the key only for a log line, so
   * `connectors: { squadDB: { dialect: 'postgres', … } }` is entirely legal.
   * With such a name this falls through to the "unknown dialect" branch below
   * and returns true **unprotected** — the cross-process migration lock in
   * MigrationEngine.runMigrations() silently stops guarding anything.
   *
   * Deliberately left as-is (2026-08-18): every known deployment names the
   * connector after its dialect, which is the documented SquadJS convention, and
   * SQLite is unaffected either way (both the sqlite branch and the unknown
   * branch return true). Changing it would start taking real locks where none
   * are taken today — a concurrency behaviour change not worth making blind.
   * The fix, if ever wanted, is to consult `getDialect()` in the unknown branch.
   * See docs/TASK_POSTGRES_PORTABILITY.md.
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
   * ⚠️ Same connector-label limitation as acquireAdvisoryLock() — see the note
   * there. The two must keep using the SAME detection: if one resolves the
   * dialect and the other does not, a lock would be taken and never released.
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
   * Return all registered model names.
   * Used by s3-export-import.js for backup/restore enumeration.
   * @returns {string[]}
   */
  getModelNames() {
    return Object.keys(this.models);
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
      this.verboseLogger(3, `[DB] Registered ${options.models.length} model(s) for drift detection for "${pluginName}": ${options.models.join(', ')}`);
    } else {
      this.verboseLogger(3, `[DB] Registered expected version v${version} for "${pluginName}" — no models registered for drift detection.`);
    }
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
   * **Always re-runs verifyLiveSchema()** regardless of wasApplied — the initial
   * drift check during db.mount() ran before any consumer models were registered,
   * so it could not detect silently-failed migrations. This second pass catches
   * missing columns on servers where S3_SchemaVersions is already up to date.
   *
   * Only invokes drift recovery (rollback + re-gate) when drifts have missing
   * columns — extra-only drifts (columns in the DB but not in the model) are
   * informational only and do not block consumer plugins.
   *
   * @param {boolean} [wasApplied=false] - If true, pending migrations were applied.
   *   Drift detection runs unconditionally regardless of this flag.
   */
  _resolveMigrationGate(wasApplied = false) {
    if (this._resolveMigrationGateFn) {
      this._resolveMigrationGateFn();
      this._resolveMigrationGateFn = null;
    }
    if (wasApplied) {
      this._pendingMigrations = []; // Clear pending — they're applied now
    }
    // Re-run live schema verification now that all plugins have registered their
    // models via registerExpectedVersion() during _onS3Ready(). The initial
    // verifyLiveSchema() during mount() ran before any models were registered, so
    // it could not detect drift. This second pass captures the actual schema state
    // regardless of whether migrations were applied — on a server where the
    // SchemaVersion already matches, the gate resolves with wasApplied=false but
    // drift may still exist (e.g. from a prior migration that silently failed).
    //
    // IMPORTANT: All gate state management (nulling _migrationGate, logging) happens
    // INSIDE the .then() callback, not after it. verifyLiveSchema() returns a Promise
    // that resolves asynchronously — setting _migrationGate = null outside the .then()
    // callback would create a race: consumers calling waitForMigrations() would see
    // no gate and proceed with sync({ alter: true }) before the drift check completed.
    // By keeping the close-out inside the callback, consumers remain blocked until
    // the drift check finishes.
    this.verifyLiveSchema().then(async drift => {
      this._lastDriftResult = drift;
      // Only invoke recovery for missing columns, missing rows, or violated data
      // post-conditions — extra-only drift does not block the gate.
      // _handleDetectedDrift() re-opens the gate and returns without closing it;
      // the caller must not fall through to gate-null.
      const hasMissing = drift.some(e => e.missing || e.missingRows || e.dataViolations);
      if (hasMissing) {
        await this._handleDetectedDrift(drift);
        return;
      }
      // No drift detected, or drift with extra columns only.
      // Close the gate so consumer plugins can proceed with sync({ alter: true }).
      this._migrationGate = null;
      this.verboseLogger(2, `[DB] Migration gate resolved (wasApplied=${wasApplied}). Consumer plugins unblocked.`);
    }).catch(err => {
      this.verboseLogger(1, `[DB] Post-migration drift check failed: ${err.message}`);
      // Null the gate so consumers don't hang forever on a transient DB error.
      // This is a safe fail-open: if we can't verify the schema, let consumers
      // proceed rather than deadlocking until process restart.
      this._migrationGate = null;
    });
  }

  /**
   * Handle schema drift detected by verifyLiveSchema().
   * Rolls back S3_SchemaVersions records for affected plugins, creates a new
   * migration gate so consumer plugins remain blocked, and fires the drift
   * alert callback (Discord notification) so the admin can re-apply the
   * idempotent migration via !s3 migrate force.
   *
   * Called both from _resolveMigrationGate() (post-migration verification) and
   * from _checkAndPromptMigrations() (startup drift check when all versions are
   * up to date).  This ensures drift detection also fires on servers where
   * S3_SchemaVersions already matches the expected version but the actual DB
   * columns are missing (e.g. a prior migration's ADD COLUMN silently failed
   * due to MySQL permissions).
   *
   * @param {Array<{pluginName: string, table: string, model?: string, missing?: string[], missingRows?: Array<{key: string, value: string}>, dataViolations?: Array<{column: string, offenders: number}>, extra?: string[], error?: string}>} drift
   */
  async _handleDetectedDrift(drift) {
    const stderrLines = [];
    for (const entry of drift) {
      if (entry.missing) {
        this.verboseLogger(1, `[DB] POST-MIGRATION DRIFT: ${entry.table} missing columns: ${entry.missing.join(', ')}`);
        stderrLines.push(`${entry.pluginName}: ${entry.table} missing column(s): ${entry.missing.join(', ')}`);
      }
      if (entry.missingRows) {
        this.verboseLogger(1, `[DB] POST-MIGRATION ROW DRIFT: ${entry.table} missing row(s): ${entry.missingRows.map(r => `${r.key}=${r.value}`).join(', ')}`);
        stderrLines.push(`${entry.pluginName}: ${entry.table} missing row(s): ${entry.missingRows.map(r => `${r.key}=${r.value}`).join(', ')}`);
      }
      if (entry.dataViolations) {
        const summary = entry.dataViolations.map(v => `${v.offenders} row(s) with NULL "${v.column}"`).join('; ');
        this.verboseLogger(1, `[DB] POST-MIGRATION DATA DRIFT: ${entry.table}: ${summary}`);
        stderrLines.push(`${entry.pluginName}: ${entry.table}: ${summary}`);
      }
    }
    // Mirror to stderr for operators who split the streams. WARN rather than
    // ERROR: drift is a state the operator must act on (!s3 migrate force), not
    // a failure that just happened. Extra-only drift is deliberately excluded —
    // it is informational and would put noise in the error file on every mount.
    if (stderrLines.length > 0) {
      stderrWarn(
        'SchemaDrift',
        `Expected schema or data is missing from the live database — run '!s3 migrate force' to re-apply.`,
        stderrLines.join('\n')
      );
    }
    // Only act on missing columns, missing rows, or violated data post-conditions
    // — extra columns are informational only
    const pluginNames = [...new Set(drift.filter(e => e.missing || e.missingRows || e.dataViolations).map(e => e.pluginName))];
    if (pluginNames.length === 0) {
      this.verboseLogger(2, '[DB] Drift detected but only extra columns — no recovery needed.');
      return;
    }
    // Populate pending migrations for the affected plugins so the Discord
    // prompt renders "v2 → v3" rather than "v-1 → v3". The S3_SchemaVersions
    // DB row is also rolled back below, so runMigrations() will detect the
    // gap and re-apply the idempotent migration.
    this._pendingMigrations = pluginNames.map(pn => ({
      pluginName: pn,
      currentVersion: (this._expectedVersions.get(pn) || 1) - 1,
      expectedVersion: this._expectedVersions.get(pn) || -1,
      behind: 1
    }));
    // Roll back S3_SchemaVersions records so runMigrations() sees a pending
    // migration and re-applies the idempotent up(). Without this, !s3 migrate
    // force would skip the migration because the DB still says e.g. v3 is
    // applied, even though columns are missing.
    for (const pn of pluginNames) {
      const prevVersion = Math.max(0, (this._expectedVersions.get(pn) || 1) - 1);
      if (this.SchemaVersionsModel) {
        try {
          const existing = await this.SchemaVersionsModel.findOne({ where: { pluginName: pn } });
          if (existing) {
            await existing.update({ version: prevVersion, appliedAt: Date.now(), migrationHash: 'drift-recovery' });
          } else {
            await this.SchemaVersionsModel.create({
              pluginName: pn,
              version: prevVersion,
              appliedAt: Date.now(),
              migrationHash: 'drift-recovery',
              description: 'Rolled back due to schema drift'
            });
          }
          this.verboseLogger(2, `[DB] Rolled back "${pn}" to v${prevVersion} for drift recovery.`);
        } catch (rollbackErr) {
          this.verboseLogger(1, `[DB] Failed to roll back "${pn}" version for drift recovery: ${rollbackErr.message}`);
        }
      }
    }
    // Create a new gate so consumer plugins stay blocked and the migration
    // prompt re-appears in Discord for a re-confirmation.
    this._migrationGate = new Promise((resolve) => {
      this._resolveMigrationGateFn = resolve;
    });
    // Fire external alert callback (e.g. Discord notification handled by S³ plugin)
    if (typeof this._driftAlertCallback === 'function') {
      this._driftAlertCallback(drift, pluginNames);
    }
    // Gate is re-open — do NOT log "resolved". The admin must re-confirm
    // (!s3 confirm <token> or !s3 migrate force) which will call
    // _resolveMigrationGate(wasApplied=true) again.
    //
    // Potential retry loop: If the re-applied migration also silently fails
    // (e.g. persistent MySQL permission denial for ALTER TABLE), drift will
    // be re-detected and the gate re-opened on this next call. This creates
    // an intentional retry loop that prompts the admin each round until the
    // underlying issue (permissions, connectivity) is resolved. The
    // migration's up() must be idempotent for re-application to succeed.
  }
  /* ────────────────────────────────────── SCHEMA DRIFT DETECTION ────────────────────────────────────── */

  /**
   * Verify live schema against registered Sequelize model definitions.
   * Diffs each plugin's registered models' rawAttributes against the actual
   * database columns via describeTable(). Returns an array of drift entries.
   * Called on every mount. Schema checks are metadata-only. The data checks add
   * one COUNT per declared post-condition, and only migrations that declare
   * touches.data contribute any. Each COUNT is an unindexed scan, so declaring
   * one on a table with millions of rows wants an index on the asserted column.
   *
   * Drift entry shapes:
   *   { pluginName, table, error }          — describeTable() failure, or row/data verification error
   *   { pluginName, table, missing }        — columns expected in model but absent from DB
   *   { pluginName, table, missingRows }    — seed rows declared via migration touches.rows absent from DB
   *   { pluginName, table, dataViolations } — touches.data post-conditions no longer hold
   *   { pluginName, table, extra }          — columns in DB but not in model
   *
   * @returns {Promise<Array<{pluginName: string, table: string, model?: string, missing?: string[], missingRows?: Array<{key: string, value: string}>, dataViolations?: Array<{column: string, offenders: number}>, extra?: string[], error?: string}>>}
   */
  async verifyLiveSchema() {
    if (this._pluginModels.size === 0) {
      this.verboseLogger(3, '[DB] No plugin models registered for drift detection — skipping verifyLiveSchema.');
      return [];
    }

    // Log which plugins/models are about to be checked so admins can
    // confirm drift detection coverage during troubleshooting.
    const summary = [...this._pluginModels.entries()]
      .map(([pn, models]) => `${pn} (${models.length} model(s))`)
      .join(', ');
    this.verboseLogger(3, `[DB] Running drift detection on ${this._pluginModels.size} plugin(s): ${summary}`);

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

    // ── Row drift detection ──────────────────────────────────
    // Check that seed rows declared via migration touches.rows still exist.
    // This catches silent data loss from prior buggy migrations, connector
    // switches, or DB restores that wiped data but left the version tracker intact.
    if (this._migrationEngine) {
      const expectedRows = this._migrationEngine.getExpectedRows();
      for (const [tableName, rowDefs] of expectedRows.entries()) {
        const owner = this._resolveTableOwner(tableName);
        if (!owner) {
          // No registered plugin claims this table — skip to avoid false positives
          continue;
        }
        const { pluginName: owningPlugin, model: rowModel } = owner;
        if (!rowModel) {
          drift.push({ pluginName: owningPlugin, table: tableName, error: 'Row verification: model not found in registry' });
          continue;
        }

        for (const { key, value } of rowDefs) {
          try {
            const row = await rowModel.findOne({ where: { [key]: value } });
            if (!row) {
              drift.push({ pluginName: owningPlugin, table: tableName, missingRows: [{ key, value }] });
            }
          } catch (err) {
            drift.push({ pluginName: owningPlugin, table: tableName, error: `Row verification failed: ${err.message}` });
          }
        }
      }

      // ── Data drift detection ─────────────────────────────────
      // Re-check touches.data post-conditions on every mount. The migration-time
      // check in _verifyMigrationResult() only sees the moment after up() ran;
      // this sees a database that has since been restored from an older dump,
      // switched connectors, or edited by hand. Nothing else would look, because
      // nothing re-runs a version the tracker already considers current.
      const expectedData = this._migrationEngine.getExpectedData?.() || new Map();
      for (const [tableName, dataDefs] of expectedData.entries()) {
        const owner = this._resolveTableOwner(tableName);
        if (!owner) continue;
        const { pluginName: owningPlugin, model: dataModel } = owner;
        if (!dataModel) {
          drift.push({ pluginName: owningPlugin, table: tableName, error: 'Data verification: model not found in registry' });
          continue;
        }

        const violations = [];
        for (const def of dataDefs) {
          if (def.notNull !== true) continue;
          try {
            const offenders = await countNullColumn(dataModel, def.column);
            if (offenders > 0) {
              violations.push({ column: def.column, offenders });
            }
          } catch (err) {
            drift.push({ pluginName: owningPlugin, table: tableName, error: `Data verification failed for "${def.column}": ${err.message}` });
          }
        }
        if (violations.length > 0) {
          drift.push({ pluginName: owningPlugin, table: tableName, dataViolations: violations });
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
        if (entry.missingRows) {
          this.verboseLogger(1, `[DB] ROW DRIFT: ${entry.table} missing row(s): ${entry.missingRows.map(r => `${r.key}=${r.value}`).join(', ')}`);
        }
        if (entry.dataViolations) {
          this.verboseLogger(1, `[DB] DATA DRIFT: ${entry.table} ${entry.dataViolations.map(v => `${v.offenders} row(s) with NULL ${v.column}`).join('; ')}`);
        }
        if (entry.extra) {
          this.verboseLogger(2, `[DB] DRIFT: ${entry.table} has extra columns: ${entry.extra.join(', ')}`);
        }
      }
    }

    return drift;
  }

  /**
   * Resolve which registered plugin owns a raw table name, and that plugin's
   * model for it. Model names are not always table names — a model registered
   * as 'Elo_PluginState' backs the table 'Elo_PluginStates' — so both the
   * ownership lookup and the model lookup match on tableName with a fallback
   * to the model name, exactly as verifyLiveSchema does for column drift.
   *
   * Returns null when no registered plugin claims the table — callers skip
   * rather than report a false drift, because a table nobody registered a model
   * for is not something this service can have an opinion about.
   *
   * `model` is non-null whenever a result is returned (ownership is established
   * *by* finding the model). Callers still guard, so that a future change to the
   * matching rule surfaces as a drift entry rather than a TypeError mid-mount.
   *
   * @param {string} tableName
   * @returns {{ pluginName: string, model: Object }|null}
   */
  _resolveTableOwner(tableName) {
    for (const [pluginName, modelNames] of this._pluginModels.entries()) {
      for (const mn of modelNames) {
        const m = this.models[mn];
        if (m && (m.tableName || m.name) === tableName) {
          return { pluginName, model: m };
        }
      }
    }
    return null;
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