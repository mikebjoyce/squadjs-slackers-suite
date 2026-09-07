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
 * ─── SERVER IDENTITY AND SCOPE ───────────────────────────────────
 *
 * Two or more Squad servers can share one database and one Discord
 * server. This file owns everything that makes that safe, and the
 * method list below is the surface; this is the shape.
 *
 * IDENTITY. Each process declares a serverID and claims a row in
 * S3_Servers at mount through registerServer(). A claim on an id a
 * DIFFERENT live process already holds is a collision and writes
 * nothing — it returns a verdict the caller refuses the mount over,
 * rather than overwriting a running server's registration. Liveness
 * is a freshness window over lastSeenAt, stamped by heartbeatServer().
 * getRegisteredServerCount() is the operator-facing count and the one
 * every gate should use; getLiveServers() answers liveness questions
 * only, and the two are different questions.
 *
 * SCOPE. Every model declares how it narrows to one server, at its
 * definition, via defineModel(name, schema, { scopeKind }):
 *
 *   'server-column'  a serverID column carries the scope
 *   'server-key'     the PRIMARY KEY is the server id, so there is
 *                    no serverID column at all
 *   'global'         community-wide; one row answers for everyone
 *
 * scopePredicateFor() turns a declaration into a {column, value} and
 * returns null for global. Nothing infers scope by looking for a
 * serverID attribute, and that is the point: S3_GameState and
 * TeamBalancerState are 'server-key', so an attribute check reads the
 * two tables holding live round state as community-wide and hands a
 * sibling's rows to whoever asked. isServerScoped() THROWS on an
 * undeclared model rather than guessing.
 *
 * LOCKS. One mechanism on every dialect: a row in S3_Locks, taken by
 * primary-key insert, with a per-row expiry. There is no native
 * advisory lock any more. MySQL's GET_LOCK is session-scoped and the
 * connector pools five connections, so acquire and release land on
 * different sessions under any concurrency and the lock is never
 * freed — invisible in a quiet single-process mount, which is why it
 * survived. A losing insert is recognised by Sequelize's
 * UniqueConstraintError class and never by the driver's error string,
 * which is SQLITE_CONSTRAINT, ER_DUP_ENTRY and 23505 on the three
 * engines. Migration locks fail CLOSED and Discord claims fail OPEN,
 * because a missed migration corrupts and a missed answer annoys.
 *
 * CLOCKS. Anything two processes compare goes through dbNow(), which
 * reads the DATABASE's clock, not Date.now(). Registry freshness,
 * lock expiry and version lockstep are all comparisons between two
 * machines, and two machines do not agree on the time.
 *
 * VERSION. checkVersionLockstep() refuses when a live sibling reports
 * a different suite version, so a half-finished upgrade stops rather
 * than writing against a schema it does not know. A null version is
 * unknown, not different.
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
 *   dbNow(opts)                 — The DATABASE's clock in epoch ms. Use this,
 *                                  not Date.now(), for anything two processes
 *                                  compare. `{ strict: true }` throws instead
 *                                  of falling back to the local clock.
 *   getClockSkewMs()            — Measured local-vs-database clock difference.
 *   acquireAdvisoryLock(key, opts) — Take a cross-process lock, held as a row
 *                                  in S3_Locks on every dialect. `opts` may be
 *                                  a bare number (legacy `timeoutMs`) or
 *                                  `{ kind, ttlMs, waitMs }`.
 *   releaseAdvisoryLock(key)    — Release a lock this process owns.
 *   isLockingAvailable()        — Is S3_Locks usable on this connection?
 *   getLocksInitError()         — The error that made it unusable, or null.
 *   holdsLock(key)              — Does this process believe it holds `key`?
 *   isMigrationLockHeld(key)    — Is any process mid-migration? Fails closed.
 *   claimDiscordMessage(key)    — Claim the right to answer one Discord
 *                                  message. Reports 'won' / 'lost' /
 *                                  'unavailable' separately, and fails OPEN.
 *   reapExpiredLocks()          — Delete every lock row past its expiry.
 *   probeDdlGrants(opts)        — Which DDL this database user can actually
 *                                  perform, established by attempting it.
 *   getModelForTable(name)      — Model whose tableName is `name`, or null.
 *   getServerID()               — The id stamped onto server-scoped rows.
 *   getDataTypes()              — Resolves Sequelize DataTypes from connector.
 *   getDatabasePath()           — Returns the SQLite file path used for backup.
 *   defineModel(name, schema, opts) — Defines and caches a Sequelize model.
 *                                  `opts.exportTier` declares which backup tier
 *                                  the model belongs to (see EXPORT_TIERS).
 *   getModelTier(name)          — Declared tier, or null if undeclared.
 *   getEffectiveModelTier(name) — Declared tier, or DEFAULT_EXPORT_TIER.
 *   getModelsByTier(tier)       — Model names whose effective tier is `tier`.
 *   getUndeclaredModelNames()   — Models relying on the default-tier fallback.
 *   getModelScopeKind(name)     — Declared scope kind, or null if undeclared.
 *   getModelScopeColumn(name)   — Discriminator column for a server-column model.
 *   scopePredicateFor(name, id) — {column, value} narrowing one model to one
 *                                 server, or null when the model is global.
 *   isServerScoped(name)        — Server-scoped or community-wide. Throws when
 *                                  the model declared no scope kind.
 *   getUnscopedModelNames()     — Models that declared no scope kind.
 *   getModelsByScopeKind(kind)  — Model names declaring that kind.
 *   registerServer(opts)        — Claim this process's S3_Servers row. Returns a
 *                                  verdict; writes nothing on a live collision.
 *   heartbeatServer()           — Stamp lastSeenAt. Never throws.
 *   getRegisteredServers()      — Every registry row, oldest id first.
 *   getRegisteredServerCount()  — How many servers exist. The operator-facing
 *                                  definition; use it for every gate.
 *   getKnownServerCount()       — The same number as of the last heartbeat,
 *                                  read synchronously and without a query.
 *   recordCommunityOptions(p, v)  — Merge a plugin’s post-validation option
 *                                 values onto this server’s row.
 *   getCommunityOptionSummary()   — Resolve and compare them across the
 *                                 registry. Cached; see communityOptions.
 *   communityOptions              — The cached summary, read synchronously by
 *                                 the gameplay path.
 *   refreshRegisteredServerCount() — Re-read it and log a one-to-many or
 *                                  many-to-one transition. Rides the heartbeat.
 *   getLiveServers()            — Rows inside the freshness window. Liveness
 *                                  questions only.
 *   checkVersionLockstep(v)     — Every live server on the same suite version?
 *                                  Nulls are unknown, not different.
 *   setServerAlias(id, alias)   — Rename, enforcing uniqueness AND distinctness.
 *   claimDefaultAlias(opts)     — Name an unnamed server. Never fails a mount.
 *   resolveServerToken(token)   — One row, or a refusal listing the candidates.
 *                                 A bare number is read as a serverID first,
 *                                 which is why normalizeAlias() refuses to
 *                                 mint a numeric alias that could shadow one.
 *   forgetServer(id)            — Deregister. Refuses while the row is fresh.
 *   registerExpectedVersion(pluginName, version) — Declares a plugin's expected
 *                                  schema version for verification.
 *   verifySchemaVersions()      — Returns { upToDate, pending } comparing
 *                                  registered expected versions against DB.
 *   get migrationEngine()       — Returns the MigrationEngine instance.
 *   executeWithRetry(fn, opts)  — Wraps logicFn with retry+jitter, SQLite-mutexed.
 *                                  opts.totalTimeoutMs (opt-in) caps the WHOLE
 *                                  retry loop's wall-clock time, not just each
 *                                  attempt — see inline comment at its call site.
 *   withTransaction(fn, opts)   — Executes logicFn inside a Sequelize transaction.
 *   withTransactionWithRetry(fn, opts) — Transaction with retry+jitter. opts may
 *                                  include totalTimeoutMs (see executeWithRetry).
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
 * - Export tiers are declared per model, at its definition site, via
 *   `defineModel(name, schema, { exportTier, scopeKind })` — NOT by a central list inside
 *   s3-export-import.js. A third-party S³ consumer plugin can therefore classify
 *   its own tables without editing S³. A model that declares nothing is exported
 *   at the default tier and warned about at mount; see DEFAULT_EXPORT_TIER for
 *   why the fallback is the inclusive direction.
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
import os from 'node:os';
import SequelizeLib from 'sequelize';
import MigrationEngine from './migration-engine.js';
import { stderrError, stderrWarn } from './s3-stderr.js';
import {
  OPTION_KIND,
  COMMUNITY_OPTION_GROUPS,
  summariseCommunityOptions,
  describeDisagreement,
  parseCommunityOptions
} from './community-options.js';

/**
 * The three export tiers a model may declare via `defineModel(name, schema,
 * { exportTier })`.
 *
 * This list is **fixed** and plugins may not extend it. The tiers are an
 * operator-facing CLI surface (`!s3 db export`, `--logs`, `--all`); if a plugin
 * could mint a new tier name, the flag list would depend on which plugins
 * happen to be loaded, two plugins could collide on a name, and an operator
 * would have no way to know what a given flag covers. Plugins classify *into*
 * this set; they do not add to it.
 *
 *   historical — irreplaceable. Losing it costs data that cannot be regenerated.
 *   logging    — forensic. Useful, bulky, roughly reproducible.
 *   ephemeral  — auto-recoverable plugin state, rebuilt from live play.
 *
 * Lives here rather than in s3-export-import.js so `defineModel()` can validate
 * a declaration without importing the exporter (which imports s3-backup.js and
 * would close an import cycle).
 */
export const EXPORT_TIERS = Object.freeze(['historical', 'logging', 'ephemeral']);

/**
 * The tier an undeclared model falls into.
 *
 * Deliberately the most inclusive tier, because the two failure directions are
 * not symmetric. Over-exporting fails **visibly and recoverably** — the
 * exporter already errors with "exceeds Discord's 25 MB limit. Try without
 * `--all`". Under-exporting fails **silently and permanently**: the backup is
 * taken, reports success, and is missing a table nobody notices until they try
 * to restore it. An unclassified model is therefore treated as irreplaceable
 * until its author says otherwise.
 */
export const DEFAULT_EXPORT_TIER = 'historical';

/**
 * The populations that share the S3_Locks table.
 *
 * One table, not two, because the coordination primitive is identical and a
 * second table would double the bootstrap surface for no gain. What differs is
 * lifetime, by orders of magnitude — a migration may legitimately run for
 * minutes, a Discord interaction claim is stale after seconds — so the TTL is
 * carried per row rather than as one global threshold, and `kind` is what lets
 * a single reaper apply the right one to each.
 */
export const LOCK_KINDS = Object.freeze({
  MIGRATION: 'migration',
  CLAIM: 'claim'
});

/**
 * How long a lock row stays valid before another process may steal it.
 *
 * These are ceilings on how long a crashed holder can block everyone else, not
 * expected durations, and the migration figure is sized against a measurement
 * rather than a guess. `Elo_RoundPlayers` is the largest S³-owned table — 179,118
 * rows in the 2026-09-01 production export — and the whole shape of the slowest
 * migration over it was timed on MySQL 8 on 2026-09-05: reading and serialising
 * every row for the pre-migration backup 1.0s, ADD COLUMN 1.3s, backfilling all
 * 180,000 rows 3.4s, CREATE INDEX 0.5s. **6.2 seconds end to end.** Ten minutes
 * is roughly a hundredfold margin, which is the right shape of margin for a
 * number whose two failure directions are not symmetric: too low means two
 * processes running the same ALTER concurrently, too high means a crashed
 * holder blocks others for longer than necessary — and that one an operator can
 * clear by hand with a DELETE.
 *
 * The old value here was a hardcoded 30 seconds at the single call site, which
 * was under the measured time for the migration Phase 3 will run against a
 * production-sized table once the host is loaded rather than idle.
 *
 * **The claim figure is a ceiling on a Discord command, not on a lock wait,
 * and it was 30 seconds until Phase 6 gave it a caller.** Every process
 * attempts a message claim exactly once, within milliseconds of the message
 * arriving, and never retries — so a row that expires while its winner is
 * still working cannot hand the message to a second responder, because no
 * second responder is still asking. What the TTL actually bounds is a
 * duplicate emit: a process that somehow sees one message twice is stopped
 * by its own row only while that row is alive. Five minutes is longer than
 * the slowest command in the suite by a wide margin (the largest export
 * serialises 179,118 rows in about a second), and short enough that the
 * table holds a handful of rows rather than a day of admin traffic.
 */
export const LOCK_TTL_MS = Object.freeze({
  [LOCK_KINDS.MIGRATION]: 10 * 60 * 1000,
  [LOCK_KINDS.CLAIM]: 5 * 60 * 1000
});

/**
 * How long a caller keeps re-checking before giving up on a held lock.
 *
 * The migration wait deliberately EXCEEDS the migration TTL, and the ordering
 * is the whole point. Wait for less than the TTL and a loser gives up while the
 * winner is still legitimately working — which is what the old hardcoded 30
 * seconds did. Wait for longer, and a loser blocked by a holder that has died
 * outlives that holder's TTL, steals the row, and proceeds. So the wait always
 * ends in progress, and the only way to return false is a holder that is alive
 * and inside its TTL, where giving up sooner would have been the wrong answer.
 */
export const LOCK_WAIT_MS = Object.freeze({
  [LOCK_KINDS.MIGRATION]: 10 * 60 * 1000 + 30 * 1000,
  [LOCK_KINDS.CLAIM]: 2 * 1000
});

/**
 * The value written to `S3_SchemaVersions.migrationHash` when drift recovery
 * rolls a version back.
 *
 * Doubles as the cross-process "the next run of this plugin is a repair" flag.
 * It is a marker in an existing column rather than a new boolean column because
 * the live MySQL grant has CREATE without ALTER, so a column cannot be added to
 * a table that already exists — and it clears itself, since a successful
 * migration overwrites the hash with a real one.
 */
export const DRIFT_RECOVERY_HASH = 'drift-recovery';

/**
 * Widest server id the suite accepts.
 *
 * Server-scoped round keys are prefixed rather than paired with a second
 * column, and the tightest of them is `matchId` — `STRING(20)` in
 * `Elo_RoundHistory`, `Elo_RoundPlayer` and `TB_RoundReport`. The prefixed form
 * is `${serverID}-${eight base-36 characters}`, which spends nine of those
 * twenty characters before the id is written, leaving eleven.
 *
 * Refused at mount rather than truncated, because truncation is the one failure
 * this cannot survive. MySQL outside strict mode shortens an over-long value
 * silently, so two ids agreeing on their first eleven digits would write their
 * rounds onto the same key with no error raised anywhere — the two servers'
 * histories would merge, and nothing would say so.
 */
export const MAX_SERVER_ID_LENGTH = 11;

/**
 * The id used when SquadJS reports none.
 *
 * Not a guess at which server is running — identity is declared by the
 * operator, never inferred from what a process observes, because the registry
 * is empty on a genuine first boot and stays empty for every server that has
 * not started yet. This is simply the value a single-server install has always
 * behaved as, so an operator who never set `id` in their SquadJS config keeps
 * the rows they already have.
 *
 * Logged at level 1 when it is used, so a second server that also falls back is
 * visible as the collision it is rather than as quietly shared rows.
 */
export const DEFAULT_SERVER_ID = 1;

/**
 * How recently a registry row must have been stamped for the process that wrote
 * it to count as still running.
 *
 * Two minutes, and the number is a trade rather than a measurement: long enough
 * that a heartbeat on the round roll cannot lapse during an ordinary round, short
 * enough that an operator restarting a server does not have to wait out a false
 * collision. Compared against the DATABASE clock on both sides — see dbNow().
 */
export const SERVER_FRESHNESS_MS = 2 * 60 * 1000;

/**
 * How wide the alias column is, and how wide a normalised alias may be.
 *
 * Deliberately narrow. An alias is typed into Discord by hand, in the middle
 * of a command, while something is going wrong on a live server — a long one
 * invites the typo that resolves to a different game.
 */
export const ALIAS_MAX_LENGTH = 32;

/**
 * How far apart two aliases must be before both are allowed to exist.
 *
 * Two, meaning anything within a single edit is refused. Uniqueness alone is
 * not the property that matters here: `srv1` and `srv2` are unique and are one
 * keystroke apart in the position an admin is least likely to reread. The
 * clan-tag matcher guards its own merges the same way and for the same reason.
 */
export const ALIAS_MIN_EDIT_DISTANCE = 2;

/**
 * How a model's rows are divided between the servers sharing one database.
 *
 * Declared at `defineModel()` beside `exportTier`, and it is the **only**
 * answer to "is this server-scoped?". The obvious alternative — ask whether the
 * model has a `serverID` attribute — gets two tables wrong in the direction
 * that loses data: `S3_GameState` and `TeamBalancerState` carry their scope in
 * the primary key and have no such column, so a column test passes them through
 * as community-wide, and an export then contains every server's round state
 * while an import overwrites a sibling's live round.
 *
 *   server-column — one row set per server, told apart by a column. Which
 *                   column is `scopeColumn`, defaulting to `serverID`; db-log's
 *                   tables use `server`, and honouring that is cheaper than
 *                   renaming a column in a plugin this suite does not own.
 *   server-key    — the primary key *is* the server id. Two tables do this, both
 *                   former singletons pinned at `id = 1`, and it is why neither
 *                   needs DDL to become per-server.
 *   global        — community-wide by decision, not by omission. One rating per
 *                   player, one token balance per player, one schema version for
 *                   the database, one lock table, one server registry.
 *
 * A composite key like `(serverID, eosID)` is `server-column`, not
 * `server-key`: what matters here is how a query narrows to one server, and
 * that is a predicate on the column either way.
 */
export const SCOPE_KINDS = Object.freeze(['server-column', 'server-key', 'global']);

/** The `server-column` discriminator when a model does not name its own. */
export const DEFAULT_SCOPE_COLUMN = 'serverID';

export default class DBService {
  constructor({
    sequelize = null,
    connectors = null,
    databaseOption = null,
    verboseLogger = () => {},
    defaultRetry = {},
    server = null,
    serverID = null
  } = {}) {
    this.verboseLogger = verboseLogger;
    this.connectors = connectors || null;
    this.server = server;

    // Server identity, stamped onto every server-scoped row. S³ resolves it —
    // it owns the override option and the mount refusal — and passes the
    // answer down. A DBService built directly, which every testing harness
    // does, gets whatever SquadJS reported and otherwise the single-server
    // default, so getServerID() always has an answer.
    this._serverID = DBService.coerceServerID(serverID) ?? DBService.coerceServerID(server?.id) ?? DEFAULT_SERVER_ID;
    // The last registered count this process read, for noticing a change — not
    // for answering "how many servers are there". See
    // refreshRegisteredServerCount(). Null until the first read, so a process
    // that boots into an already-multi-server community announces nothing.
    this._lastKnownServerCount = null;
    // What this process has recorded onto its own row, accumulated across
    // plugin mounts. Held rather than re-read so two plugins recording in the
    // same boot cannot lose each other’s keys to a read-modify-write, and so a
    // plugin that has been uninstalled since the last boot drops out of the
    // blob instead of lingering in it forever.
    this._recordedCommunityOptions = {};
    // The resolved/compared view of every registered row’s options. Unlike the
    // count cache above this one IS read directly — see
    // getCommunityOptionSummary() for why a synchronous answer is the only
    // answer the gameplay path can use.
    this._communityOptionSummary = { resolved: {}, disagreements: [] };
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
    this._modelTiers = new Map();       // model name → declared exportTier (undeclared models are absent)
    this._tierWarned = new Set();       // model names already warned about, so a re-mount does not re-spam
    this._modelScopes = new Map();      // model name → { kind, column } (undeclared models are absent)
    this._scopeWarned = new Set();      // same purpose as _tierWarned, for the scope declaration
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

    // ── Cross-process locking (S3_Locks) ──
    // The owner string has to distinguish two SquadJS processes that may be on
    // the same host or on different ones, and it survives into log lines that
    // tell an operator which process is holding a lock they are waiting on. So:
    // host to name the machine, pid to name the process on it, and a random
    // suffix so a restart that reuses a pid cannot be mistaken for the process
    // that just died holding the lock.
    this._lockOwner = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
    this._heldLocks = new Map();        // lockKey → { kind, expiresAt }, this process's own belief
    this.LocksModel = null;
    this.ServersModel = null;
    this._serversInitError = null;      // why S3_Servers is unavailable, if it is
    this._serversIndexReport = null;    // ensureIndexes() result, so the alias uniqueness can be checked
    this._clockSkewMs = null;           // measured at mount; null until then
    this._ddlGrants = null;             // cached probeDdlGrants() result for this mount
    this._locksInitError = null;        // why S3_Locks is unavailable, if it is
  }

  /**
   * Narrows an operator-supplied value to a usable server id, or null.
   *
   * Null rather than a throw so the two callers can differ on what a bad value
   * means: `resolveServerID()` turns it into a mount refusal naming the option,
   * while the constructor — which the testing harnesses drive directly — treats
   * it as "nothing was supplied" and falls back.
   *
   * Whole numbers only, because `S3_Servers` stores the id as an INTEGER
   * primary key; and never zero, since a falsy id cannot be distinguished from
   * an absent one by the `override || server.id` idiom used across the suite.
   */
  static coerceServerID(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return null;
    if (String(n).length > MAX_SERVER_ID_LENGTH) return null;
    return n;
  }

  /**
   * Resolves the id this process stamps onto every server-scoped row.
   *
   * Declared, not discovered. The value comes from the operator's SquadJS `id`,
   * or from an explicit override for the case where two installs both shipped
   * `"id": 1` and changing the SquadJS-side id would renumber rows that other
   * plugins already wrote. Nothing here reads the database to work out who it
   * is: a boot that finds an empty registry is indistinguishable from a boot
   * that genuinely is first, so a guess would be wrong exactly when it mattered.
   *
   * Returns `{ serverID, source, fallback }` rather than a bare number so the
   * caller can log the fallback in its own voice instead of this needing to know
   * how the caller logs.
   *
   * Throws when a value was supplied but is unusable — a mount refusal, never a
   * silent repair. See MAX_SERVER_ID_LENGTH for why an over-wide id in
   * particular cannot be truncated into something workable.
   */
  static resolveServerID({ overrideServerID = null, server = null } = {}) {
    const overrideGiven = overrideServerID !== null && overrideServerID !== undefined && overrideServerID !== '';
    const raw = overrideGiven ? overrideServerID : (server?.id ?? null);
    const source = overrideGiven ? 'overrideServerID' : 'the SquadJS server id';

    if (raw === null || raw === undefined || raw === '') {
      return { serverID: DEFAULT_SERVER_ID, source: 'default', fallback: true };
    }

    const serverID = DBService.coerceServerID(raw);
    if (serverID === null) {
      const digits = String(raw).length;
      if (digits > MAX_SERVER_ID_LENGTH) {
        throw new Error(
          `[S3] ${source} is ${digits} characters long (${raw}); the limit is ${MAX_SERVER_ID_LENGTH}. ` +
          'Round keys are written as `<serverID>-<8 characters>` into a 20-character column, so a wider id would be ' +
          "truncated by the database rather than rejected, and two servers' rounds would silently merge onto one key."
        );
      }
      throw new Error(
        `[S3] ${source} must be a whole number of 1 or more, but is ${JSON.stringify(raw)}. ` +
        'Server-scoped rows are keyed by it and the S3_Servers registry stores it as an INTEGER primary key.'
      );
    }

    return { serverID, source, fallback: false };
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
      // InnoDB picks a victim and rolls it back whole; the retry loop is
      // exactly the “try restarting transaction” the server is asking for.
      // This arrived with the first SELECT ... FOR UPDATE in the codebase
      // (Elo_PlayerStats, which two servers now write concurrently): taking
      // a lock is what makes a deadlock reachable, and a deadlock the retry
      // loop does not recognise is a lost round of Elo, not a slow one.
      //
      // Both the code and the wording are checked because they fail
      // independently — a wrapped or re-thrown error can arrive without its
      // `parent`. MySQL 8 on 127.0.0.1:3307, two transactions locking the
      // same two rows in opposite order, throws SequelizeDatabaseError with
      // parent.code 'ER_LOCK_DEADLOCK' (errno 1213) and precisely this
      // message. Verified by forcing one rather than read off a manual.
      err?.parent?.code === 'ER_LOCK_DEADLOCK' ||
      message.includes('Deadlock found when trying to get lock') ||
      err?.name === 'SequelizeTimeoutError'
    );
  }

  /** How often acquireAdvisoryLock() re-checks a held lock. */
  static LOCK_POLL_MS = 500;

  /** Local-vs-database clock difference past which mount() warns. */
  static CLOCK_SKEW_WARN_MS = 5000;

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
    'SequelizeConnectionAcquireTimeoutError',
    'S3RetryBudgetExceededError'
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
    // Opt-in only — omitted for every existing caller, so nothing changes for them.
    const totalTimeoutMs = Number.isFinite(retryOptions.totalTimeoutMs) ? retryOptions.totalTimeoutMs : null;

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
    const attemptPromise = DBService.withSqliteMutex(connector, runAttempt);
    if (totalTimeoutMs === null) {
      return attemptPromise;
    }

    // Bounds the WHOLE retry loop, not a single attempt. A single attempt's own
    // timeout (e.g. Sequelize's connection-pool `acquire` timeout — commonly 60s,
    // configured outside this repo by core SquadJS) can itself run long under pool
    // exhaustion; five retries at that cost compound to minutes (observed: a real
    // 301s EloTracker round-end write during a live outage, which sat directly
    // upstream of a TeamBalancer scramble-trigger check on the same connection
    // pool). Racing the whole loop against a budget — instead of only bounding each
    // attempt — is what actually caps how long a caller can be blocked. The
    // underlying attempt keeps running in the background after losing the race;
    // it just can no longer hold this specific caller hostage.
    attemptPromise.catch(() => {});
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`DB retry budget of ${totalTimeoutMs}ms exceeded`);
        err.name = 'S3RetryBudgetExceededError';
        reject(err);
      }, totalTimeoutMs);
    });

    try {
      return await Promise.race([attemptPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
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

    // Initialise S3_Locks. Must come before anything that takes a lock —
    // acquireAdvisoryLock() fails CLOSED without it, which would abort a
    // migration rather than let it run unserialised.
    await this._initLocksModel();

    // Initialise S3_Servers. After the lock table because it is ordinary state
    // rather than the coordination primitive, and before the migration gate
    // because the guards that read it run at mount, ahead of it.
    await this._initServersModel();

    // Sample the clock difference once. Not a gate: every cross-process
    // comparison is minted from the database clock precisely so skew cannot
    // affect correctness. It is logged because a host far out of sync is
    // otherwise invisible until it produces a symptom nobody connects to NTP.
    await this.measureClockSkew();

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

    // Put DBService's own tables under a group, so drift verification covers
    // them. Has to follow the engine and precede the verification below.
    await this._registerCoreMigrations();

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

  /* ────────────────────────────────────── DATABASE CLOCK ────────────────────────────────────── */

  /**
   * The database's own clock, in epoch milliseconds.
   *
   * Every lock TTL and freshness window in a multi-process deployment compares
   * a timestamp one machine wrote against a decision another machine is making.
   * `Date.now()` makes that comparison against the *local* clock, so two hosts a
   * minute apart turn mutual exclusion into a race: one process reads a live
   * lock as expired and steals it. Mint both sides from the database and the
   * skew cancels, because there is only one clock left.
   *
   * The three expressions below were RUN against SQLite, MySQL 8 and Postgres
   * on 2026-09-05, not reasoned about, and three of the results contradict what
   * a careful reading predicts:
   *
   *   - `strftime('%s','now')` is SECOND precision — it read back 622 ms behind
   *     `Date.now()`. The julianday form is millisecond-accurate (delta 0 ms).
   *     `strftime('%f')` returns seconds-within-the-minute, not an epoch at all.
   *   - `UNIX_TIMESTAMP()` is likewise second precision on MySQL (934 ms
   *     behind). `NOW(3)` is what makes it millisecond.
   *   - Postgres returns BIGINT **as a string** — `"1788580981099"` — where
   *     SQLite and MySQL return a JS number. Hence Number() on the way out here
   *     and _asEpochMs() on every BIGINT column read.
   *   - `now()` is transaction-start time on Postgres and freezes inside a
   *     transaction; `clock_timestamp()` advances. Measured: 1200 ms of real
   *     time read back as 1215 ms inside an open transaction.
   *
   * @param {object}  [opts]
   * @param {boolean} [opts.strict=false] - Throw instead of falling back to the
   *        local clock. Callers whose correctness depends on a shared clock —
   *        the lock path — pass this, so a clock failure fails closed rather
   *        than silently reintroducing local-clock comparisons.
   * @returns {Promise<number>} epoch ms
   */
  async dbNow({ strict = false } = {}) {
    const expr = this._dbNowExpression();
    if (!expr) {
      if (strict) throw new Error('no connector — cannot read a database clock');
      return Date.now();
    }
    try {
      const [row] = await this.sequelize.query(
        `SELECT ${expr} AS ts`,
        { type: this.sequelize.QueryTypes.SELECT }
      );
      const ts = Number(row?.ts);
      if (!Number.isFinite(ts)) {
        throw new Error(`non-numeric clock value ${JSON.stringify(row?.ts)}`);
      }
      return ts;
    } catch (err) {
      if (strict) throw err;
      this.verboseLogger(1, `[DB] dbNow() failed (${err.message}) — falling back to the local clock.`);
      return Date.now();
    }
  }

  /**
   * Dialect SQL for "now, in epoch milliseconds", or null with no connector.
   *
   * Branches on getDialect() and NEVER on getConnectorName(): the label is the
   * key of the connector in config.json, so a connector keyed "squadDB" would
   * miss every branch and fall through — the exact defect that made the old
   * advisory lock silently unprotected.
   */
  _dbNowExpression() {
    if (!this.sequelize || typeof this.sequelize.query !== 'function') return null;
    switch (this.getDialect()) {
      case 'sqlite':
        return "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
      case 'mysql':
      case 'mariadb':
        return 'CAST(ROUND(UNIX_TIMESTAMP(NOW(3)) * 1000) AS SIGNED)';
      case 'postgres':
        return 'CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT)';
      default:
        return null;
    }
  }

  /**
   * Coerce a BIGINT column read back from any dialect into a JS number.
   *
   * Postgres hands BIGINT to the driver as a string. Comparing two of those
   * with `<` is a LEXICOGRAPHIC comparison, and "999" < "1000" is false — so a
   * TTL check written the obvious way silently refuses to reap expired rows on
   * exactly one of the three engines, with no error anywhere. Verified
   * 2026-09-05 on all three.
   */
  static _asEpochMs(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Measured difference between this process's clock and the database's,
   * in milliseconds. Positive means the local clock is ahead. Null until
   * mount() has measured it, or when there is no connector.
   */
  getClockSkewMs() {
    return this._clockSkewMs;
  }

  /**
   * Sample the local-vs-database clock difference once, correcting for the
   * round trip. Logged at level 1 past the threshold because a skewed host is
   * invisible until it corrupts a TTL decision, and by then the evidence is
   * gone.
   */
  async measureClockSkew() {
    if (!this._dbNowExpression()) {
      this._clockSkewMs = null;
      return null;
    }
    try {
      const before = Date.now();
      const dbTs = await this.dbNow({ strict: true });
      const after = Date.now();
      // Midpoint of the round trip is the best local estimate of the instant
      // the database answered, so the round trip itself does not read as skew.
      const skew = Math.round((before + after) / 2) - dbTs;
      this._clockSkewMs = skew;
      if (Math.abs(skew) > DBService.CLOCK_SKEW_WARN_MS) {
        this.verboseLogger(
          1,
          `[DB] Clock skew ${skew > 0 ? '+' : ''}${skew} ms against the database. ` +
          'Lock TTLs and freshness windows are minted from the database clock so this is not ' +
          'itself a correctness problem, but a host this far out usually means NTP is not running.'
        );
      } else {
        this.verboseLogger(3, `[DB] Clock skew ${skew} ms against the database.`);
      }
      return skew;
    } catch (err) {
      this.verboseLogger(2, `[DB] Could not measure clock skew: ${err.message}`);
      this._clockSkewMs = null;
      return null;
    }
  }

  /* ────────────────────────────────────── CROSS-PROCESS LOCKS ────────────────────────────────────── */

  /**
   * Acquire a cross-process lock on a logical key, held as a row in S3_Locks.
   *
   * ─── WHY A ROW AND NOT GET_LOCK / pg_try_advisory_lock ───
   *
   * Both native primitives are scoped to the *connection* that called them, and
   * this service issues every statement through Sequelize's pool. The previous
   * implementation took the lock with one `sequelize.query()` and released it
   * with another, so acquire and release landed on the same pooled connection
   * only by luck. Reproduced 2026-09-04 on a connector built exactly as the
   * deployed fork builds it (no `pool` option, so Sequelize 6's default of five):
   * eight sequential queries stay on one session, eight concurrent ones fan out
   * to five; `GET_LOCK` on session 54065, concurrent work, then `RELEASE_LOCK`
   * on session 54067 returned **0**, the return value was discarded, and
   * `IS_USED_LOCK` confirmed the lock still held by 54065 with nothing left that
   * could ever free it. A quiet single-process mount never sees it because
   * sequential work never leaves the first connection — which is why it
   * survived two rounds of fixes to this function.
   *
   * A row has no session affinity, behaves identically on all three engines,
   * and replaces three code paths (a SQLite no-op that serialised nothing
   * across processes, plus the two native arms) with one. It also deletes the
   * last dialect branch in this pair, which is what made the connector-label
   * bug reachable at all.
   *
   * ─── HOW A LOSER IS RECOGNISED ───
   *
   * By Sequelize's `UniqueConstraintError` class, never by the driver's error
   * string: the same losing insert reports `SQLITE_CONSTRAINT`, `ER_DUP_ENTRY`
   * and `23505` on the three engines, so a string match fails open on two of
   * them. Anything that is *not* a unique-constraint violation is a database
   * failure and returns false — "I could not take the lock" — rather than being
   * mistaken for "someone else holds it".
   *
   * @param {string} key - Logical lock name, e.g. 's3_migrate_s3-players'.
   * @param {object|number} [options] - A bare number is the legacy `timeoutMs`
   *        call shape and means `{ waitMs }`.
   * @param {string} [options.kind='migration'] - Which population this row
   *        belongs to. Migration locks and Discord claims live in one table
   *        with lifetimes orders of magnitude apart, so the reaper needs to
   *        tell them apart and the default TTL differs per kind.
   * @param {number} [options.ttlMs] - How long the row stays valid before
   *        another process may steal it. Defaults per kind.
   * @param {number} [options.waitMs] - How long to keep re-checking before
   *        giving up. Defaults per kind.
   * @returns {Promise<boolean>} true if this process now holds the lock.
   */
  async acquireAdvisoryLock(key, options = {}) {
    const opts = typeof options === 'number' ? { waitMs: options } : (options || {});
    const kind = opts.kind || LOCK_KINDS.MIGRATION;
    const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : (LOCK_TTL_MS[kind] ?? LOCK_TTL_MS[LOCK_KINDS.MIGRATION]);
    const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : (LOCK_WAIT_MS[kind] ?? LOCK_WAIT_MS[LOCK_KINDS.MIGRATION]);
    const pollMs = Number.isFinite(opts.pollMs) ? opts.pollMs : DBService.LOCK_POLL_MS;

    if (!this.sequelize || typeof this.sequelize.query !== 'function') {
      this.verboseLogger(2, `[DB] acquireAdvisoryLock("${key}"): no connector — returning true (no-op mode).`);
      return true;
    }

    if (!this.LocksModel) {
      // Fail CLOSED. Returning true here is what the old unknown-dialect branch
      // did, and it means the caller runs a migration believing it is
      // serialised when nothing is serialising it.
      this.verboseLogger(1, `[DB] acquireAdvisoryLock("${key}"): S3_Locks is not initialised — refusing the lock rather than running unprotected.`);
      return false;
    }

    // The wait budget is a duration measured inside THIS process, so the local
    // clock is the right one for it. Only the lock's expiry crosses machines,
    // and that is minted from the database below.
    const deadline = Date.now() + waitMs;
    let announcedWait = false;

    for (;;) {
      let now;
      try {
        now = await this.dbNow({ strict: true });
      } catch (err) {
        this.verboseLogger(1, `[DB] acquireAdvisoryLock("${key}"): no database clock (${err.message}) — refusing the lock.`);
        return false;
      }

      const expiresAt = now + ttlMs;

      try {
        await this.LocksModel.create({
          lockKey: key,
          kind,
          owner: this._lockOwner,
          acquiredAt: now,
          expiresAt
        });
        this._heldLocks.set(key, { kind, expiresAt });
        this.verboseLogger(3, `[DB] Lock "${key}" acquired (kind=${kind}, ttl=${ttlMs}ms).`);
        return true;
      } catch (err) {
        if (!DBService.isUniqueConstraintError(err)) {
          this.verboseLogger(1, `[DB] acquireAdvisoryLock("${key}") failed on a database error, not a lost race: ${err.message}`);
          return false;
        }
      }

      // Someone holds it. Steal only if their row has genuinely expired.
      if (await this._stealExpiredLock(key, kind, now, ttlMs)) return true;

      if (Date.now() >= deadline) {
        this.verboseLogger(
          1,
          `[DB] acquireAdvisoryLock("${key}"): still held after ${waitMs}ms — giving up. ` +
          'The holder is alive and its TTL has not expired.'
        );
        return false;
      }

      if (!announcedWait) {
        announcedWait = true;
        this.verboseLogger(2, `[DB] Lock "${key}" is held by another process — waiting up to ${waitMs}ms and re-checking.`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /**
   * Delete a lock row whose expiry has passed and take it, atomically enough:
   * the conditional DELETE is the race, and only the process whose DELETE
   * actually removed a row goes on to insert. A second process arriving in the
   * same instant either deletes nothing, or deletes and then loses the insert —
   * both of which land on the "did not get it" path.
   */
  async _stealExpiredLock(key, kind, now, ttlMs) {
    const Op = this.sequelize?.constructor?.Op || SequelizeLib.Op;
    let previous = null;
    try {
      previous = await this.LocksModel.findByPk(key, { raw: true });
    } catch { /* best effort — only used for the log line */ }

    const heldUntil = previous ? DBService._asEpochMs(previous.expiresAt) : null;
    if (heldUntil === null || heldUntil >= now) return false;

    let removed = 0;
    try {
      removed = await this.LocksModel.destroy({
        where: { lockKey: key, expiresAt: { [Op.lt]: now } }
      });
    } catch (err) {
      this.verboseLogger(1, `[DB] Could not reap expired lock "${key}": ${err.message}`);
      return false;
    }
    if (!removed) return false;

    this.verboseLogger(
      1,
      `[DB] Stole expired lock "${key}" from owner "${previous.owner}" ` +
      `(expired ${now - heldUntil}ms ago). If that process is still running, its critical section outran its TTL.`
    );

    try {
      await this.LocksModel.create({
        lockKey: key,
        kind,
        owner: this._lockOwner,
        acquiredAt: now,
        expiresAt: now + ttlMs
      });
      this._heldLocks.set(key, { kind, expiresAt: now + ttlMs });
      return true;
    } catch (err) {
      if (!DBService.isUniqueConstraintError(err)) {
        this.verboseLogger(1, `[DB] Re-taking stolen lock "${key}" failed: ${err.message}`);
      }
      return false;
    }
  }

  /**
   * Release a lock previously taken by THIS process.
   *
   * Owner-scoped on purpose: if our TTL expired and another process legitimately
   * stole the key, an unscoped delete would silently drop *their* lock. The
   * predicate is what makes a stolen lock visible instead of destructive, and a
   * release that removes no row is reported rather than discarded — which is
   * precisely what the old implementation got wrong.
   *
   * @param {string} key - Must match the acquireAdvisoryLock call.
   */
  async releaseAdvisoryLock(key) {
    if (!this.sequelize || typeof this.sequelize.query !== 'function') return;
    if (!this.LocksModel) return;

    try {
      const removed = await this.LocksModel.destroy({
        where: { lockKey: key, owner: this._lockOwner }
      });
      if (removed) {
        this.verboseLogger(3, `[DB] Lock "${key}" released.`);
      } else {
        this.verboseLogger(
          1,
          `[DB] releaseAdvisoryLock("${key}"): no row owned by this process. The lock expired and was ` +
          'stolen while the critical section was still running, so two processes may have overlapped. ' +
          'Raise the TTL for this operation.'
        );
      }
    } catch (err) {
      this.verboseLogger(1, `[DB] releaseAdvisoryLock("${key}") failed: ${err.message}`);
    } finally {
      this._heldLocks.delete(key);
    }
  }

  /**
   * Can locks be taken at all on this connection?
   *
   * False means `_initLocksModel()` could not create or reach S3_Locks — in
   * practice a database user without CREATE. Every acquire then fails closed,
   * which is correct but indistinguishable, from the caller's side, from losing
   * a race to another process. Callers that report a lock failure to a human
   * need the difference: "another server is migrating, wait" and "this user
   * cannot create a table, fix the grant" have nothing in common except the
   * return value.
   */
  isLockingAvailable() {
    return this.LocksModel !== null;
  }

  /**
   * The error that made locking unavailable, or null.
   *
   * Handed back as the original driver error rather than a string, so callers
   * can run it through their own error classification — a permission refusal
   * here is the same shape as a permission refusal anywhere else.
   */
  getLocksInitError() {
    return this._locksInitError;
  }

  /**
   * True when this process currently believes it holds `key`.
   *
   * Belief, not proof: the row may have expired and been stolen. Used by drift
   * recovery to answer "is a migration in flight?" without a round trip, and by
   * tests. Callers that need the truth query S3_Locks.
   */
  holdsLock(key) {
    return this._heldLocks.has(key);
  }

  /**
   * Is any migration lock currently held, by this process or another?
   *
   * Drift recovery asks this before concluding that a missing column is drift:
   * with N processes, "a column my schema says should exist is absent" has a
   * second cause that has never existed before — another process is midway
   * through the migration that adds it — and rolling the shared version record
   * back is destructive to that case.
   *
   * @param {string} [key] - Check one key; omit to check for any migration lock.
   * @returns {Promise<{held: boolean, owner: string|null, lockKey: string|null}>}
   */
  async isMigrationLockHeld(key = null) {
    const miss = { held: false, owner: null, lockKey: null };
    if (!this.LocksModel) return miss;
    const Op = this.sequelize?.constructor?.Op || SequelizeLib.Op;
    try {
      const now = await this.dbNow({ strict: true });
      const where = key
        ? { lockKey: key, expiresAt: { [Op.gte]: now } }
        : { kind: LOCK_KINDS.MIGRATION, expiresAt: { [Op.gte]: now } };
      const row = await this.LocksModel.findOne({ where, raw: true });
      if (!row) return miss;
      return { held: true, owner: row.owner, lockKey: row.lockKey };
    } catch (err) {
      // Fail CLOSED: an unreadable lock table must not be reported as "no lock
      // held", because the caller's next move is a destructive rollback.
      this.verboseLogger(1, `[DB] Could not read S3_Locks (${err.message}) — assuming a migration IS in flight.`);
      return { held: true, owner: null, lockKey: key };
    }
  }

  /**
   * Claim the right to answer one Discord message, and say WHY when the
   * answer is no.
   *
   * ─── WHY NOT acquireAdvisoryLock() ───
   *
   * That function returns a bare boolean, and a claim needs three outcomes
   * rather than two. "I lost the race" and "the database did not answer"
   * are the same `false` there, and the two demand opposite behaviour here:
   * a lost race means stay silent because somebody else is replying, and a
   * broken query means reply anyway because nobody may be. Collapsing them
   * takes the silent branch on a connection blip and silences every
   * responder in the community at once — a channel where a command simply
   * produces nothing, with no error anywhere to explain it.
   *
   * So this fails **open**. A duplicate reply is visible and an admin can
   * read past it; a missing one looks like the bot is down.
   *
   * ─── AND WHY IT NEVER STEALS ───
   *
   * `acquireAdvisoryLock()` takes over a row whose TTL has passed, which is
   * right for a migration lock left behind by a crashed holder. It is wrong
   * here. A message key is a snowflake and is never contended twice, so the
   * only thing an expired claim row can mean is that this process is looking
   * at the same message a second time — exactly the case the row exists to
   * stop. Stealing it would restore the duplicate.
   *
   * @param {string} key - `discord:<messageID>` for a message exactly one
   *        process may answer, `discord:<messageID>:<serverID>` for a
   *        broadcast read where each server answers for itself.
   * @param {object} [opts]
   * @param {number} [opts.ttlMs]
   * @returns {Promise<{claimed: boolean, outcome: string, error?: string}>}
   *          `outcome` is 'won', 'lost', 'no-op' or 'unavailable'.
   */
  async claimDiscordMessage(key, { ttlMs = LOCK_TTL_MS[LOCK_KINDS.CLAIM] } = {}) {
    if (!this.sequelize || typeof this.sequelize.query !== 'function') {
      return { claimed: true, outcome: 'no-op' };
    }
    if (!this.LocksModel) {
      return { claimed: true, outcome: 'unavailable', error: this._locksInitError?.message || 'S3_Locks is not initialised' };
    }

    let now;
    try {
      now = await this.dbNow({ strict: true });
    } catch (err) {
      return { claimed: true, outcome: 'unavailable', error: err.message };
    }

    try {
      await this.LocksModel.create({
        lockKey: key,
        kind: LOCK_KINDS.CLAIM,
        owner: this._lockOwner,
        acquiredAt: now,
        expiresAt: now + ttlMs
      });
      this.verboseLogger(4, `[DB] Claimed "${key}".`);
      return { claimed: true, outcome: 'won' };
    } catch (err) {
      if (DBService.isUniqueConstraintError(err)) return { claimed: false, outcome: 'lost' };
      this.verboseLogger(1, `[DB] claimDiscordMessage("${key}") failed on a database error, not a lost race: ${err.message}`);
      return { claimed: true, outcome: 'unavailable', error: err.message };
    }
  }

  /**
   * Delete every lock row whose expiry has passed, of any kind.
   *
   * Per-row `expiresAt` is what makes one reaper safe for both populations: a
   * migration lock with a fifteen-minute TTL and a Discord claim with a
   * five-minute one are reaped by the same predicate at the right time each,
   * where a single global threshold would either reap a live migration or
   * strand claims for an hour.
   */
  async reapExpiredLocks() {
    if (!this.LocksModel) return 0;
    const Op = this.sequelize?.constructor?.Op || SequelizeLib.Op;
    try {
      const now = await this.dbNow({ strict: true });
      const removed = await this.LocksModel.destroy({ where: { expiresAt: { [Op.lt]: now } } });
      if (removed) this.verboseLogger(2, `[DB] Reaped ${removed} expired lock row(s).`);
      return removed;
    } catch (err) {
      this.verboseLogger(2, `[DB] reapExpiredLocks() failed: ${err.message}`);
      return 0;
    }
  }

  /**
   * "Lost the race" versus "the database broke".
   *
   * The losing insert reports SQLITE_CONSTRAINT, ER_DUP_ENTRY and 23505 on the
   * three engines — verified 2026-09-05 — so this matches the Sequelize error
   * CLASS and never a driver string. A string match here fails open on whichever
   * two engines the author did not have in front of them.
   */
  static isUniqueConstraintError(err) {
    const UniqueConstraintError =
      SequelizeLib.UniqueConstraintError ||
      SequelizeLib.Sequelize?.UniqueConstraintError;
    if (UniqueConstraintError && err instanceof UniqueConstraintError) return true;
    // Defensive: a connector built from a different copy of the sequelize
    // package fails instanceof across realms. The name is still Sequelize's own,
    // not the driver's, so this stays a class check rather than a string match
    // on the underlying error text.
    return err?.name === 'SequelizeUniqueConstraintError';
  }

  /**
   * The id this process stamps onto server-scoped rows.
   *
   * A plain property read, never a query — it is on the hot path for every
   * write, and it is settled before mount so that it is available to any
   * service that needs it while building its schema.
   */
  getServerID() {
    return this._serverID;
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
    // totalTimeoutMs is a retry-budget knob for executeWithRetry, not a Sequelize
    // transaction option — split it out before forwarding the rest to withTransaction().
    // Note: the remaining `passthroughOptions` is NOT the nested Sequelize transaction
    // options itself — withTransaction() expects that nested one level down, under its
    // own `transactionOptions` key (e.g. { transactionOptions: { isolationLevel } }).
    const { totalTimeoutMs, ...passthroughOptions } = options;
    try {
      const result = await this.executeWithRetry(
        () => DBService.withTransaction(this.sequelize, logicFn, passthroughOptions),
        { totalTimeoutMs }
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
   *   Three keys are S³'s own and are stripped before the rest is forwarded:
   *   `exportTier` (see EXPORT_TIERS), `scopeKind` (see SCOPE_KINDS) and
   *   `scopeColumn` (the discriminator for a `server-column` model, default
   *   `serverID`). Both declarations are mandatory in practice — an omitted
   *   one warns at level 1 on the author's own mount.
   * @returns {import('sequelize').Model}
   */
  defineModel(name, schema, modelOptions = {}) {
    if (!this.sequelize || typeof this.sequelize.define !== 'function') {
      throw new Error('defineModel called without a valid sequelize connector.');
    }

    // `exportTier`, `scopeKind` and `scopeColumn` are ours, not Sequelize's —
    // record them and strip them before the rest is forwarded to define().
    // Recorded BEFORE the idempotency returns below, so a model adopted from
    // the connector on a re-mount still lands in both registries.
    const { exportTier, scopeKind, scopeColumn, ...defineOptions } = modelOptions;
    this._recordExportTier(name, exportTier);
    this._recordScopeKind(name, scopeKind, scopeColumn);

    if (this.models[name]) {
      return this.models[name];
    }

    // Adopt a model already present on the connector rather than redefining it.
    // Callers that previously guarded with `sequelize.models?.X || sequelize.define(...)`
    // relied on this to stay idempotent across a re-mount, where DBService is
    // rebuilt but the connector is reused. Without this branch the redefine
    // would succeed but discard the original model object, orphaning any
    // reference a service captured on its first mount.
    const existing = this.sequelize.models?.[name];
    if (existing) {
      this.models[name] = existing;
      return existing;
    }

    const opts = { freezeTableName: true, ...defineOptions };
    const model = this.sequelize.define(name, schema, opts);
    this.models[name] = model;
    return model;
  }

  /**
   * Create declared indexes on an already-existing table, one at a time, via
   * a bare `CREATE INDEX` — never `ALTER TABLE` / Sequelize's `addIndex()`,
   * which emit `ALTER TABLE ... ADD INDEX` on MySQL/Postgres and require the
   * ALTER grant a CREATE-only live user doesn't have. Each index is skipped
   * if it already exists (via `showIndex()`), so this is safe to call on
   * every mount as a self-healing step — see LoggingService._initModels()
   * for the pattern this generalises.
   *
   * Deliberately untransacted: intended to be called after the caller's own
   * table-creation step (migration or otherwise) has already committed, not
   * from inside one. `defineModel()`'s `indexes` option is Sequelize
   * metadata only — sync() would read it, but nothing here calls sync() —
   * so index creation always has to be driven explicitly, via this method.
   *
   * A failure is logged (verboseLogger + stderrWarn) and non-fatal — it never
   * blocks the table itself from being written to or read. For an ordinary
   * index that is the right call, since a missing one costs query time and
   * nothing else. For a `unique: true` index it is not: the index is the
   * constraint, so losing it loses the guarantee silently. Hence the return
   * value — a caller that declared a unique index is expected to read it and
   * decide what a missing constraint means for its own table.
   *
   * @param {string} tableName
   * @param {{name: string, fields: string[], unique?: boolean}[]} indexes
   * @returns {Promise<{created: string[], existing: string[], failed: {name: string, unique: boolean, error: string}[]}>}
   */
  async ensureIndexes(tableName, indexes) {
    const connector = this.getConnector();
    const qi = connector.getQueryInterface();

    let existing = new Set();
    try {
      const rows = await qi.showIndex(tableName);
      existing = new Set(rows.map((r) => r.name));
    } catch (err) {
      this.verboseLogger(1, `[DB] Could not read existing indexes on ${tableName}: ${err.message}`);
    }

    const q = (id) => this.quoteIdentifier(id);
    const report = { created: [], existing: [], failed: [] };
    for (const { name, fields, unique = false } of indexes) {
      if (existing.has(name)) { report.existing.push(name); continue; }
      try {
        const cols = fields.map(q).join(', ');
        await connector.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${q(name)} ON ${q(tableName)} (${cols})`);
        report.created.push(name);
      } catch (err) {
        report.failed.push({ name, unique, error: err.message });
        this.verboseLogger(1, `[DB] Failed to create index ${name} on ${tableName}: ${err.message}`);
        stderrWarn(
          'DBService',
          unique
            ? `Could not create UNIQUE index "${name}" on ${tableName} — the uniqueness it enforces is not in effect.`
            : `Could not create index "${name}" on ${tableName} — queries against it will be unindexed.`,
          err.message
        );
      }
    }
    return report;
  }

  /* ────────────────────────────────────── EXPORT TIER REGISTRY ────────────────────────────────────── */

  /**
   * Record (and validate) a model's declared export tier.
   *
   * An invalid tier throws **at definition time**, which surfaces on the
   * author's own server during mount rather than months later when someone
   * discovers the table missing from a restore.
   *
   * @param {string} name - Model name
   * @param {string|undefined} tier - Declared tier, or undefined when omitted
   * @private
   */
  _recordExportTier(name, tier) {
    if (tier === undefined || tier === null) {
      if (!this._modelTiers.has(name) && !this._tierWarned.has(name)) {
        this._tierWarned.add(name);
        this.verboseLogger(
          1,
          `[DB] Model "${name}" was defined without an exportTier — it will be exported ` +
          `at the "${DEFAULT_EXPORT_TIER}" (default) tier. Declare one explicitly: ` +
          `defineModel('${name}', schema, { exportTier: '${EXPORT_TIERS.join("' | '")}' }).`
        );
      }
      return;
    }

    if (!EXPORT_TIERS.includes(tier)) {
      throw new Error(
        `defineModel("${name}") was given exportTier "${tier}", which is not a valid tier. ` +
        `Valid tiers are: ${EXPORT_TIERS.join(', ')}. Plugins classify into this fixed set; ` +
        `they cannot define new tiers.`
      );
    }

    const previous = this._modelTiers.get(name);
    if (previous && previous !== tier) {
      // Keep the first declaration — a later caller silently retiering someone
      // else's model is exactly the kind of quiet reclassification this task
      // exists to prevent.
      this.verboseLogger(
        1,
        `[DB] Model "${name}" was re-declared with exportTier "${tier}" but is already ` +
        `registered as "${previous}". Keeping "${previous}".`
      );
      return;
    }

    this._modelTiers.set(name, tier);
  }

  /**
   * The tier a model **declared**, or null if it declared none.
   * Use getEffectiveModelTier() when you need a tier for every model.
   *
   * @param {string} name - Model name
   * @returns {string|null}
   */
  getModelTier(name) {
    return this._modelTiers.get(name) ?? null;
  }

  /**
   * The tier a model is actually treated as, falling back to
   * DEFAULT_EXPORT_TIER when it declared none.
   *
   * @param {string} name - Model name
   * @returns {string}
   */
  getEffectiveModelTier(name) {
    return this._modelTiers.get(name) ?? DEFAULT_EXPORT_TIER;
  }

  /**
   * Registered model names that declared no tier and are therefore relying on
   * the default-tier fallback. Should be empty on a clean install — a non-empty
   * result is what the mount-time warning reports.
   *
   * @returns {string[]}
   */
  getUndeclaredModelNames() {
    return this.getModelNames().filter((name) => !this._modelTiers.has(name));
  }

  /**
   * Registered model names whose effective tier is `tier`.
   *
   * @param {string} tier - One of EXPORT_TIERS
   * @returns {string[]} Model names in declaration order
   */
  getModelsByTier(tier) {
    if (!EXPORT_TIERS.includes(tier)) {
      throw new Error(`getModelsByTier("${tier}") — valid tiers are: ${EXPORT_TIERS.join(', ')}.`);
    }
    return this.getModelNames().filter((name) => this.getEffectiveModelTier(name) === tier);
  }

  /* ────────────────────────────────────── SCOPE REGISTRY ────────────────────────────────────── */

  /**
   * Record (and validate) how a model's rows divide between servers.
   *
   * Same shape as _recordExportTier() on purpose: an invalid value throws at
   * definition time, an omitted one warns once, and the first declaration wins
   * over a later re-declaration. The difference is what happens downstream —
   * an undeclared tier has a defensible default and an undeclared scope does
   * not, so isServerScoped() refuses to answer rather than guessing.
   *
   * @param {string} name - Model name
   * @param {string|undefined} kind - Declared scope kind, or undefined when omitted
   * @param {string|undefined} column - Discriminator column for `server-column`
   * @private
   */
  _recordScopeKind(name, kind, column) {
    if (kind === undefined || kind === null) {
      if (!this._modelScopes.has(name) && !this._scopeWarned.has(name)) {
        this._scopeWarned.add(name);
        this.verboseLogger(
          1,
          `[DB] Model "${name}" was defined without a scopeKind — nothing can tell whether its rows ` +
          'belong to one server or to the community, and anything that has to know will refuse rather ' +
          `than guess. Declare one: defineModel('${name}', schema, { scopeKind: '${SCOPE_KINDS.join("' | '")}' }).`
        );
      }
      return;
    }

    if (!SCOPE_KINDS.includes(kind)) {
      throw new Error(
        `defineModel("${name}") was given scopeKind "${kind}", which is not a valid kind. ` +
        `Valid kinds are: ${SCOPE_KINDS.join(', ')}. This set is fixed — a model that does not fit ` +
        'one of the three is a design question, not a fourth kind.'
      );
    }

    if (column !== undefined && column !== null && kind !== 'server-column') {
      throw new Error(
        `defineModel("${name}") declared scopeColumn "${column}" with scopeKind "${kind}". ` +
        'Only server-column rows are told apart by a column; declaring one elsewhere reads as a ' +
        'filter that nothing applies.'
      );
    }

    const previous = this._modelScopes.get(name);
    const resolved = {
      kind,
      column: kind === 'server-column' ? (column ?? DEFAULT_SCOPE_COLUMN) : null
    };
    if (previous && (previous.kind !== resolved.kind || previous.column !== resolved.column)) {
      this.verboseLogger(
        1,
        `[DB] Model "${name}" was re-declared as scopeKind "${resolved.kind}" but is already ` +
        `registered as "${previous.kind}". Keeping "${previous.kind}".`
      );
      return;
    }

    this._modelScopes.set(name, resolved);
  }

  /**
   * The scope kind a model **declared**, or null if it declared none.
   *
   * @param {string} name - Model name
   * @returns {string|null} one of SCOPE_KINDS
   */
  getModelScopeKind(name) {
    return this._modelScopes.get(name)?.kind ?? null;
  }

  /**
   * The column a `server-column` model is told apart by, or null for the other
   * two kinds and for an undeclared model.
   *
   * ⚠ This names the discriminator; it does not promise the column exists yet.
   * The classification is declared ahead of the migrations that add the
   * columns, deliberately, so that each phase sets the field as it touches a
   * model rather than every call site being retro-fitted at the end. Code that
   * builds a WHERE clause from this must check the attribute is present on the
   * model and say so plainly when it is not, rather than emitting a predicate
   * against a column the database does not have.
   *
   * @param {string} name - Model name
   * @returns {string|null}
   */
  getModelScopeColumn(name) {
    return this._modelScopes.get(name)?.column ?? null;
  }

  /**
   * Whether a model's rows belong to one server rather than to the community.
   *
   * Throws on an undeclared model rather than answering. Every caller of this
   * is on a path where a wrong answer is expensive and silent — an export that
   * quietly contains a sibling's rows, an import that quietly overwrites them,
   * an audit that quietly passes — and on those paths "I do not know" has to
   * stop the operation, not resolve to a default.
   *
   * @param {string} name - Model name
   * @returns {boolean}
   */
  isServerScoped(name) {
    const scope = this._modelScopes.get(name);
    if (!scope) {
      throw new Error(
        `isServerScoped("${name}") — that model declared no scopeKind, so whether its rows belong to ` +
        'one server or to the community is unknown. Declare it at its defineModel() call site; do not ' +
        'infer it from whether the model has a serverID attribute, which reads two tables backwards.'
      );
    }
    return scope.kind !== 'global';
  }

  /**
   * Registered model names that declared no scope kind.
   *
   * The counterpart of getUndeclaredModelNames() for tiers, and reported the
   * same way — a non-empty result here is a plugin that has not been through
   * the multi-server classification, and anything scope-aware will refuse to
   * act on those models rather than assume.
   *
   * @returns {string[]}
   */
  getUnscopedModelNames() {
    return this.getModelNames().filter((name) => !this._modelScopes.has(name));
  }

  /**
   * Registered model names whose declared scope kind is `kind`.
   *
   * Undeclared models are in no bucket — they are absent from every result
   * here, which is why getUnscopedModelNames() exists beside it.
   *
   * @param {string} kind - One of SCOPE_KINDS
   * @returns {string[]} Model names in declaration order
   */
  getModelsByScopeKind(kind) {
    if (!SCOPE_KINDS.includes(kind)) {
      throw new Error(`getModelsByScopeKind("${kind}") — valid kinds are: ${SCOPE_KINDS.join(', ')}.`);
    }
    return this.getModelNames().filter((name) => this.getModelScopeKind(name) === kind);
  }

  /**
   * How to narrow one model's rows to one server, or null for global.
   *
   * Every scope-aware path — export, import, the overwrite count, the audit
   * — goes through here rather than working the classification out again,
   * because the two tables that are easiest to get wrong are wrong in a way
   * nothing reports: `S3_GameState` and `TeamBalancerState` have no scope
   * COLUMN, they have a scope KEY, and code that goes looking for a
   * `serverID` attribute reads both as community-wide.
   *
   *   server-column — the declared discriminator, usually `serverID`,
   *                   `server` for the db-log tables this suite does not own.
   *   server-key    — the model's own primary key, which IS the server id.
   *   global        — null. Not "no filter yet"; there is no per-server
   *                   subset of a rating table or a schema-version row.
   *
   * Returns null for a declared column the table does not have yet, which is
   * the state between a classification landing and the migration that adds
   * the column. Over-including on a read is visible and recoverable; the
   * import side stamps those rows rather than dropping them.
   *
   * Throws for an undeclared model, the same way `isServerScoped()` does. A
   * caller that cannot tell whether a table is one server's must stop.
   *
   * @param {string} name - Model name
   * @param {number} [serverID] - Defaults to this process's server
   * @returns {{column: string, value: number}|null}
   */
  scopePredicateFor(name, serverID = this._serverID) {
    if (!this.isServerScoped(name)) return null;

    const kind = this.getModelScopeKind(name);
    const model = this.getModel(name);

    if (kind === 'server-key') {
      const keys = Array.isArray(model?.primaryKeyAttributes) ? model.primaryKeyAttributes : [];
      // A server-key model with a composite key is a contradiction — the key
      // is supposed to BE the server — and guessing which half to filter on
      // is how a sibling's rows end up in an envelope.
      if (keys.length !== 1) {
        throw new Error(
          `scopePredicateFor("${name}") — declared server-key but its primary key is ` +
          `${keys.length === 0 ? 'absent' : `composite (${keys.join(', ')})`}. A server-key model's ` +
          'primary key is the server id; declare server-column instead if the scope lives in a column.'
        );
      }
      return { column: keys[0], value: serverID };
    }

    const column = this.getModelScopeColumn(name);
    if (!column) return null;
    const attributes = model?.rawAttributes || model?.getAttributes?.() || {};
    return attributes[column] ? { column, value: serverID } : null;
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
  /**
   * How far back to roll a plugin's recorded version so that re-running its
   * migrations actually restores what drifted.
   *
   * Rolling back one version is only correct when the missing schema belongs to
   * the newest migration. Observed on a live server: SwitchPlugin_PlayerCooldowns
   * had lost five columns added by switch v3 plus one added by v5. Rolling back
   * to v4 made only v5 pending, so `!s3 migrate force` re-added v5's column,
   * drift re-fired on v3's five, the version was rolled back to v4 again — a
   * repair loop that ran on every mount and could never converge.
   *
   * Each migration's mandatory `touches` says which tables and columns it owns,
   * so the correct target is one below the LOWEST-versioned migration owning
   * anything currently missing. Falls back to the old expected-1 behaviour when
   * no migration claims the drifting schema, which is the best guess available.
   *
   * @param {string} pluginName
   * @param {Array<Object>} drift - entries from _detectSchemaDrift()
   * @returns {number} version to record, never below 0
   */
  /**
   * Recorded schema version per plugin, straight from S3_SchemaVersions.
   *
   * @returns {Promise<Map<string, number>>} pluginName -> applied version
   */
  async getRecordedVersions() {
    const versions = new Map();
    if (!this.SchemaVersionsModel) return versions;
    const rows = await this.SchemaVersionsModel.findAll({ raw: true });
    for (const row of rows) versions.set(row.pluginName, row.version);
    return versions;
  }

  /**
   * Does the SHARED version row say this plugin's next run is a drift repair?
   *
   * Drift recovery writes `migrationHash: DRIFT_RECOVERY_HASH` when it rolls a
   * version back, so the marker is already persisted and already community-wide
   * — no new column, which matters because the live grant cannot add one. This
   * is what lets a process that did not observe the drift still know that the
   * migration it is about to run is a repair, and skip a one-time destructive
   * step accordingly.
   *
   * @returns {Promise<boolean>}
   */
  async isDriftReapplyRecorded(pluginName) {
    if (!this.SchemaVersionsModel) return false;
    try {
      const row = await this.SchemaVersionsModel.findOne({ where: { pluginName }, raw: true });
      return row?.migrationHash === DRIFT_RECOVERY_HASH;
    } catch (err) {
      this.verboseLogger(2, `[DB] Could not read the drift-recovery marker for "${pluginName}": ${err.message}`);
      return false;
    }
  }

  /**
   * Lowest migration version that declares ownership of a thing, or null.
   *
   * `kind` selects which `touches` category to search: 'columns' matches a
   * table+column pair, 'creates' and 'rows' match a table alone.
   */
  _owningVersion(migrations, kind, table, column = null) {
    const wanted = String(table).toLowerCase();
    let lowest = null;
    for (const migration of migrations) {
      const touches = migration.touches;
      if (!touches) continue;
      let owns = false;
      if (kind === 'creates') {
        owns = (touches.creates || []).some((t) => String(t).toLowerCase() === wanted);
      } else if (kind === 'rows') {
        owns = Object.keys(touches.rows || {}).some((t) => t.toLowerCase() === wanted);
      } else {
        const target = String(column).toLowerCase();
        for (const [t, columns] of Object.entries(touches.columns || {})) {
          if (t.toLowerCase() !== wanted) continue;
          if ((columns || []).some((c) => String(c).toLowerCase() === target)) { owns = true; break; }
        }
      }
      if (owns && (lowest === null || migration.version < lowest)) lowest = migration.version;
    }
    return lowest;
  }

  /**
   * Narrow raw drift to what is genuinely drift for this database's state.
   *
   * verifyLiveSchema() compares registered models against the live schema and
   * cannot tell "this column was applied and then lost" from "this column
   * belongs to a migration that has not run yet". Both read as missing. That
   * distinction does not matter while drift is only ever checked on a server
   * with nothing pending — which is exactly why the check was gated that way,
   * and exactly why a server that was both behind AND drifted needed two
   * passes to repair: the drift was invisible until the pending run finished.
   *
   * Checking drift on a server with pending migrations means separating the two
   * here, or every routine version upgrade would raise a false drift alarm and
   * roll versions backwards. `touches` already records which migration owns
   * each table and column, so anything owned by a migration ABOVE the recorded
   * version is simply not applied yet and is dropped. Plugins with no recorded
   * version at all are dropped wholesale — nothing has ever been applied, so
   * nothing can have drifted, which is the brand-new-install case.
   *
   * @param {Array<Object>} drift - entries from verifyLiveSchema()
   * @returns {Promise<Array<Object>>} entries trimmed to genuine drift
   */
  async filterDriftToApplied(drift) {
    const recorded = await this.getRecordedVersions();
    const kept = [];

    for (const entry of drift) {
      const applied = recorded.get(entry.pluginName) || 0;
      if (applied <= 0) continue; // never installed here — cannot have drifted

      const migrations = this._migrationEngine?.getMigrations?.(entry.pluginName) || [];

      // A table whose creating migration has not run yet is legitimately absent,
      // and so is everything in it.
      const createdBy = this._owningVersion(migrations, 'creates', entry.table);
      if (createdBy !== null && createdBy > applied) continue;

      const trimmed = { ...entry };

      if (entry.missing) {
        trimmed.missing = entry.missing.filter((column) => {
          const owner = this._owningVersion(migrations, 'columns', entry.table, column);
          // An undeclared column cannot be attributed to a pending migration,
          // so treat it as drift rather than silently ignoring a real loss.
          return owner === null || owner <= applied;
        });
        if (trimmed.missing.length === 0) delete trimmed.missing;
      }

      if (entry.missingRows) {
        const owner = this._owningVersion(migrations, 'rows', entry.table);
        if (owner !== null && owner > applied) delete trimmed.missingRows;
      }

      if (entry.dataViolations) {
        trimmed.dataViolations = entry.dataViolations.filter((violation) => {
          const owner = this._owningVersion(migrations, 'columns', entry.table, violation.column);
          return owner === null || owner <= applied;
        });
        if (trimmed.dataViolations.length === 0) delete trimmed.dataViolations;
      }

      if (trimmed.missing || trimmed.missingRows || trimmed.dataViolations || trimmed.error) {
        kept.push(trimmed);
      }
    }

    return kept;
  }

  _rollbackTargetForDrift(pluginName, drift) {
    const expected = this._expectedVersions.get(pluginName) || 1;
    const fallback = Math.max(0, expected - 1);

    const migrations = this._migrationEngine?.getMigrations?.(pluginName) || [];
    if (migrations.length === 0) return fallback;

    // Identifier case is not portable — MySQL with lower_case_table_names=1
    // reports tables folded to lowercase while `touches` declares them as
    // written — so match case-insensitively throughout.
    const key = (table, column) => `${String(table).toLowerCase()}.${String(column).toLowerCase()}`;
    const missingColumns = new Set();
    const missingTables = new Set();
    for (const entry of drift) {
      if (entry.pluginName !== pluginName) continue;
      for (const column of entry.missing || []) missingColumns.add(key(entry.table, column));
      for (const violation of entry.dataViolations || []) missingColumns.add(key(entry.table, violation.column));
      if (entry.missingRows || entry.dataViolations) missingTables.add(String(entry.table).toLowerCase());
    }
    if (missingColumns.size === 0 && missingTables.size === 0) return fallback;

    let lowest = null;
    for (const migration of migrations) {
      const touches = migration.touches;
      if (!touches) continue;
      let owns = false;
      for (const [table, columns] of Object.entries(touches.columns || {})) {
        if ((columns || []).some((column) => missingColumns.has(key(table, column)))) { owns = true; break; }
      }
      if (!owns) {
        owns = Object.keys(touches.rows || {}).some((table) => missingTables.has(table.toLowerCase()));
      }
      if (owns && (lowest === null || migration.version < lowest)) lowest = migration.version;
    }

    return lowest === null ? fallback : Math.max(0, lowest - 1);
  }

  /**
   * Roll the shared schema-version record back because the live schema is
   * missing something a recorded migration should have left behind.
   *
   * ─── WHY THIS TAKES THE MIGRATION LOCK ───
   *
   * This is the only schema-mutating decision in the service that used to take
   * no lock at all, and what it writes — `S3_SchemaVersions` — is community-wide:
   * one row per plugin, shared by every process pointed at the database. With a
   * single process, "a column my models say should exist is absent" has exactly
   * one cause, and rolling back is right. With two, it has a second: another
   * process is midway through the migration that adds it. From outside, the two
   * are indistinguishable, and rolling back on the wrong one corrupts the record
   * for everybody.
   *
   * So the question this asks first is not "is the column there" but "is anyone
   * migrating this plugin". A held lock IS the answer — the process holding it
   * is the one adding the column.
   *
   * ─── AND WHY IT RE-OBSERVES AFTERWARDS ───
   *
   * The drift was observed BEFORE the lock was taken. Between those two moments
   * the racing process can finish, release, and leave a schema that is now
   * correct — at which point the caller's observation describes a database that
   * no longer exists. Taking the lock without re-observing narrows that window
   * rather than closing it. The re-check can only SHRINK the caller's drift set,
   * never widen it, which is what keeps it compatible with the one call site
   * that pre-filters through filterDriftToApplied(): entries that filter dropped
   * cannot come back in through here.
   */
  async _handleDetectedDrift(drift) {
    const gate = await this._acquireDriftRecoveryLocks(drift);
    if (gate.blocked.length > 0) {
      this.verboseLogger(
        1,
        `[DB] Skipping drift recovery for ${gate.blocked.join(', ')} — another process holds the migration ` +
        'lock, so the missing schema is a migration in flight rather than drift.'
      );
    }
    try {
      const scoped = gate.blocked.length
        ? drift.filter((e) => !gate.blocked.includes(e.pluginName))
        : drift;
      if (scoped.length === 0) return;

      const confirmed = await this._reconfirmDriftUnderLock(scoped);
      if (confirmed.length === 0) {
        this.verboseLogger(2, '[DB] Drift did not survive re-checking under the migration lock — another process had it in hand.');
        return;
      }
      return await this._handleConfirmedDrift(confirmed);
    } finally {
      for (const key of gate.acquired) {
        await this.releaseAdvisoryLock(key);
      }
    }
  }

  /**
   * Take the per-plugin migration lock for every plugin named in a drift set.
   *
   * Locks that are already held BY THIS PROCESS are left alone and not returned
   * for release — an outer critical section owns them and releasing here would
   * hand its lock away mid-migration.
   *
   * With no S3_Locks table there is nothing to take, and this proceeds anyway.
   * That is not a hole: acquireAdvisoryLock() fails closed without the table, so
   * runMigrations() refuses to run in every process, so there is no migration
   * anywhere that this could be racing against. No locks means no migrations
   * means nothing to lose to.
   */
  async _acquireDriftRecoveryLocks(drift) {
    const acquired = [];
    const blocked = [];
    if (!this.LocksModel) {
      this.verboseLogger(2, '[DB] Drift recovery running without a lock — S3_Locks is unavailable, so no process can be migrating.');
      return { acquired, blocked };
    }

    const plugins = [...new Set(drift.map((e) => e.pluginName).filter(Boolean))];
    for (const pluginName of plugins) {
      const key = `s3_migrate_${pluginName}`;
      if (this.holdsLock(key)) continue;
      // waitMs: 0 — one attempt, no polling. A held lock is not a queue to join
      // here, it is the answer to the question being asked.
      const ok = await this.acquireAdvisoryLock(key, { kind: LOCK_KINDS.MIGRATION, waitMs: 0 });
      if (ok) acquired.push(key);
      else blocked.push(pluginName);
    }
    return { acquired, blocked };
  }

  /**
   * Re-run schema verification while holding the lock and keep only the drift
   * that is still there.
   *
   * Intersects rather than replaces, for two reasons. It preserves whatever the
   * caller already filtered out, so the one call site that runs
   * filterDriftToApplied() does not have that work undone. And it cannot invent
   * a rollback target the caller never asked for, which keeps the destructive
   * write bounded by what was observed twice rather than once.
   */
  async _reconfirmDriftUnderLock(drift) {
    let fresh;
    try {
      fresh = await this.verifyLiveSchema();
    } catch (err) {
      // Cannot re-observe. Trusting the caller's view is the pre-existing
      // behaviour and no worse than it; refusing outright would turn a
      // transient read failure into unrepaired drift.
      this.verboseLogger(1, `[DB] Could not re-verify drift under the lock (${err.message}) — proceeding on the original observation.`);
      return drift;
    }

    // Merge rather than last-wins. verifyLiveSchema() emits one entry per KIND
    // of drift, so a table that is both missing a declared column and carrying
    // an undeclared one arrives as two entries with the same plugin and table.
    // Keyed by that pair, the second silently erased the first — and since the
    // `extra` entry is pushed after the `missing` one, what got erased was
    // always the half that drives recovery. The intersection below then found no
    // missing columns, so the rollback fell through to `expected - 1` instead of
    // to the version below the migration that owns the lost column.
    const at = new Map();
    for (const e of fresh) {
      const k = `${e.pluginName}|${String(e.table).toLowerCase()}`;
      const prev = at.get(k);
      if (!prev) { at.set(k, { ...e }); continue; }
      for (const field of ['missing', 'extra', 'missingRows', 'dataViolations']) {
        if (e[field]) prev[field] = [...(prev[field] || []), ...e[field]];
      }
    }

    const kept = [];
    for (const entry of drift) {
      const still = at.get(`${entry.pluginName}|${String(entry.table).toLowerCase()}`);
      if (!still) continue;

      const missing = entry.missing && still.missing
        ? entry.missing.filter((c) => still.missing.includes(c))
        : null;
      const missingRows = entry.missingRows && still.missingRows
        ? entry.missingRows.filter((r) => still.missingRows.some((s) => s.key === r.key && s.value === r.value))
        : null;
      const dataViolations = entry.dataViolations && still.dataViolations
        ? entry.dataViolations.filter((v) => still.dataViolations.some((s) => s.column === v.column))
        : null;

      const survivor = { ...entry };
      if (missing && missing.length) survivor.missing = missing; else delete survivor.missing;
      if (missingRows && missingRows.length) survivor.missingRows = missingRows; else delete survivor.missingRows;
      if (dataViolations && dataViolations.length) survivor.dataViolations = dataViolations; else delete survivor.dataViolations;

      if (survivor.missing || survivor.missingRows || survivor.dataViolations || survivor.extra) kept.push(survivor);
    }
    return kept;
  }

  async _handleConfirmedDrift(drift) {
    const stderrLines = [];
    // Labelled "CONFIRMED" rather than "POST-MIGRATION": this runs both after a
    // migration pass and, since one-pass repair, before one — on a server that
    // is behind AND drifted. What the label marks is that these entries have
    // already been through filterDriftToApplied(), so every one names schema
    // that a migration recorded as applied should have left behind. The raw
    // "[DB] DRIFT:" lines above it are the unfiltered view and will legitimately
    // list more, including columns merely waiting on a pending migration.
    for (const entry of drift) {
      if (entry.missing) {
        this.verboseLogger(1, `[DB] CONFIRMED DRIFT: ${entry.table} missing columns: ${entry.missing.join(', ')}`);
        stderrLines.push(`${entry.pluginName}: ${entry.table} missing column(s): ${entry.missing.join(', ')}`);
      }
      if (entry.missingRows) {
        this.verboseLogger(1, `[DB] CONFIRMED ROW DRIFT: ${entry.table} missing row(s): ${entry.missingRows.map(r => `${r.key}=${r.value}`).join(', ')}`);
        stderrLines.push(`${entry.pluginName}: ${entry.table} missing row(s): ${entry.missingRows.map(r => `${r.key}=${r.value}`).join(', ')}`);
      }
      if (entry.dataViolations) {
        const summary = entry.dataViolations.map(v => `${v.offenders} row(s) with NULL "${v.column}"`).join('; ');
        this.verboseLogger(1, `[DB] CONFIRMED DATA DRIFT: ${entry.table}: ${summary}`);
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
    const driftPending = pluginNames.map(pn => {
      const currentVersion = this._rollbackTargetForDrift(pn, drift);
      const expectedVersion = this._expectedVersions.get(pn) || -1;
      return {
        pluginName: pn,
        currentVersion,
        expectedVersion,
        behind: Math.max(1, expectedVersion - currentVersion)
      };
    });
    // Merge rather than replace. Drift can now be detected while other plugins
    // have ordinary migrations pending; overwriting the list would drop those
    // plugins from the prompt and leave them un-migrated with no further prompt.
    const untouched = (this._pendingMigrations || []).filter(p => !pluginNames.includes(p.pluginName));
    this._pendingMigrations = [...untouched, ...driftPending];
    // Roll back S3_SchemaVersions records so runMigrations() sees a pending
    // migration and re-applies the idempotent up(). Without this, !s3 migrate
    // force would skip the migration because the DB still says e.g. v3 is
    // applied, even though columns are missing.
    // Tell the engine these runs are repairs, so a migration with a one-time
    // destructive step can skip it (see qi.isReapply in migration-engine.js).
    //
    // Belt AND braces, deliberately. markDriftReapply() records it on THIS
    // process's engine, and the rollback below records it on the shared row as
    // `migrationHash: DRIFT_RECOVERY_HASH`. The in-memory flag alone is wrong the
    // moment a second process exists: the row it guards is community-wide, so
    // the process that performs the re-apply is often not the one that decided
    // it was a re-apply, and there the one-time destructive step runs a second
    // time. The recorded hash travels with the decision because it IS the
    // decision, and _recordVersion() overwrites it with a real hash on success,
    // so it clears itself without needing a column that a restricted grant
    // could not add.
    this._migrationEngine?.markDriftReapply?.(pluginNames);
    for (const pn of pluginNames) {
      const prevVersion = this._rollbackTargetForDrift(pn, drift);
      if (this.SchemaVersionsModel) {
        try {
          const existing = await this.SchemaVersionsModel.findOne({ where: { pluginName: pn } });
          if (existing) {
            await existing.update({ version: prevVersion, appliedAt: Date.now(), migrationHash: DRIFT_RECOVERY_HASH });
          } else {
            await this.SchemaVersionsModel.create({
              pluginName: pn,
              version: prevVersion,
              appliedAt: Date.now(),
              migrationHash: DRIFT_RECOVERY_HASH,
              // Not localized: this lands in the schema-version row, so it is
              // a stored value rather than a message.
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
      this._lastDriftResult = [];
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
        // The owner lookup still goes through the registry, because that is
        // how a drift entry learns which plugin to blame. The QUERY does
        // not: it reads the table the migration named. A model whose
        // tableName was repointed — SwitchPlugin_Settings, since Phase 4 —
        // would otherwise send this check at a different table and report
        // the wrong one either healthy or drifted.
        const { pluginName: owningPlugin } = owner;
        const q = (id) => this.quoteIdentifier(id);

        for (const { key, value } of rowDefs) {
          try {
            const [found] = await this.sequelize.query(
              `SELECT ${q(key)} FROM ${q(tableName)} WHERE ${q(key)} = :value`,
              { replacements: { value }, type: this.sequelize.constructor.QueryTypes.SELECT }
            );
            if (!found) {
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
        const { pluginName: owningPlugin } = owner;
        const q = (id) => this.quoteIdentifier(id);

        const violations = [];
        for (const def of dataDefs) {
          if (def.notNull !== true) continue;
          try {
            // Table-name query, for the reason given on row drift above.
            const [counted] = await this.sequelize.query(
              `SELECT COUNT(*) AS ${q('n')} FROM ${q(tableName)} WHERE ${q(def.column)} IS NULL`,
              { type: this.sequelize.constructor.QueryTypes.SELECT }
            );
            const offenders = Number(counted?.n ?? 0);
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

    // Cache here rather than at each call site. Two callers already did this by
    // hand and a third (`!s3 migrate verify`) would have had to remember; a
    // caller that forgot would leave `!s3 diag` reporting a stale verdict that
    // contradicts the check just run.
    this._lastDriftResult = drift;

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

    // Registered via defineModel() — NOT raw sequelize.define() — so the model
    // lands in this.models and is therefore visible to getModelNames(), which is
    // what s3-export-import.js enumerates. Defining it raw made S3_SchemaVersions
    // invisible to every export tier including --all, so schema version tracking
    // was silently absent from every backup ever taken. The explicit tableName
    // below is load-bearing: defineModel() injects freezeTableName, so without it
    // Sequelize would target a table named 'S3SchemaVersions' instead.
    this.SchemaVersionsModel = this.defineModel(
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
        timestamps: false,
        // Not regenerable: it records which migrations a database has already
        // applied. A restore without it re-runs migrations against data that
        // already has them.
        exportTier: 'historical',
        // One schema serves the database, so one version row per plugin serves
        // every server sharing it. Per-server versions would be a second answer
        // to a question the tables can only answer once.
        scopeKind: 'global'
      }
    );

    await this.executeWithRetry(async () => {
      await this.SchemaVersionsModel.sync();
    });

    this.verboseLogger(3, '[DB] Initialised S3_SchemaVersions table.');
  }

  /**
   * Initialise S3_Locks — the table that backs every cross-process lock.
   *
   * `lockKey` is the PRIMARY KEY, and that is the whole coordination primitive:
   * the database refuses the second concurrent INSERT of the same key, so the
   * winner is decided by the engine rather than by anything this code does. No
   * SELECT-then-INSERT, which has a window; no dialect branch, because a unique
   * violation is a unique violation on all three engines.
   *
   * Created with createTable() + a bare CREATE INDEX rather than Model.sync().
   * sync() emits CREATE TABLE and then a separate ALTER TABLE ... ADD INDEX for
   * every declared index, even on a table it just created, and the live MySQL
   * grant has CREATE without ALTER — so sync() would fail on every mount here
   * exactly as it does in logging-service.js. createTable()'s own `indexes`
   * option is silently a no-op on MySQL, so the index is issued explicitly.
   *
   * Failure leaves LocksModel null, which makes acquireAdvisoryLock() fail
   * closed. That is the intended direction: a migration that cannot be
   * serialised should abort with a message, not proceed unprotected.
   */
  /**
   * The `S3_Locks` schema, in one place.
   *
   * Hoisted out of `_initLocksModel()` so the `s3-core` migration creates the
   * table from the same definition the model is built from, rather than from a
   * copy that can drift away from it.
   *
   * @returns {object}
   * @private
   */
  _locksSchema() {
    const DataTypes = this.getDataTypes();
    return {
      // Not autoIncrement: the key IS the lock name, and that is what makes the
      // uniqueness constraint mean "someone already holds this".
      //
      // Named lockKey rather than key because raw SQL against this table is the
      // normal access path and `key` is reserved in MySQL. SwitchPlugin_
      // ServerSettings is decided the other way for the opposite reason — it
      // predates this and is reached only through Sequelize, which quotes
      // identifiers unconditionally. Do not reconcile the two names; one of
      // them will break.
      lockKey: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
      kind: { type: DataTypes.STRING, allowNull: false },
      owner: { type: DataTypes.STRING, allowNull: false },
      // Epoch ms, minted from the DATABASE clock. BIGINT reads back as a string
      // on Postgres — see DBService._asEpochMs(), which every read goes through.
      acquiredAt: { type: DataTypes.BIGINT, allowNull: false },
      expiresAt: { type: DataTypes.BIGINT, allowNull: false }
    };
  }

  async _initLocksModel() {
    const locksSchema = this._locksSchema();
    const locksIndexes = [
      { name: 'idx_s3_locks_expiresAt', fields: ['expiresAt'] }
    ];

    // The explicit tableName is load-bearing — defineModel() injects
    // freezeTableName, so without it Sequelize targets 'S3Locks'.
    this.LocksModel = this.defineModel(
      'S3Locks',
      locksSchema,
      {
        tableName: 'S3_Locks',
        timestamps: false,
        // Pure coordination state with a TTL measured in minutes. Restoring a
        // backup's lock rows would resurrect locks held by processes that no
        // longer exist, which is strictly worse than starting with none.
        exportTier: 'ephemeral',
        // Community-wide by definition: the whole point of the table is that a
        // row taken by one process is seen by every other one.
        scopeKind: 'global',
        indexes: locksIndexes
      }
    );

    try {
      const qi = this.getConnector().getQueryInterface();
      await this.executeWithRetry(async () => {
        await qi.createTable('S3_Locks', locksSchema);
      });
      await this.ensureIndexes('S3_Locks', locksIndexes);
      this.verboseLogger(3, '[DB] Initialised S3_Locks table.');
    } catch (err) {
      this.LocksModel = null;
      // Kept, not just logged. Every subsequent lock refusal traces back to this
      // one error, and it is the only place the driver's actual reason exists —
      // by the time a migration is refused, all a caller has is `false`.
      this._locksInitError = err;
      this.verboseLogger(
        1,
        `[DB] Could not initialise S3_Locks (${err.message}). Cross-process locking is unavailable, ` +
        'so migrations will refuse to run rather than run unserialised.'
      );
      stderrWarn(
        'DBService',
        'Could not create the S3_Locks table — migrations will refuse to run until this is fixed.',
        err.message
      );
    }
  }


  /**
   * The `S3_Servers` schema and indexes, in one place.
   *
   * Hoisted out of `_initServersModel()` so the `s3-core` migration below
   * creates the table from the same definition the model is built from. Two
   * copies of a schema drift apart; one used twice cannot.
   *
   * @returns {{schema: object, indexes: {name: string, fields: string[], unique?: boolean}[]}}
   * @private
   */
  _serversDefinition() {
    const DataTypes = this.getDataTypes();

    const schema = {
      // Declared by the operator, never minted here — hence no autoIncrement.
      // A registry that handed out ids would be inferring identity, which is the
      // one thing nothing in this design is allowed to do.
      serverID: { type: DataTypes.INTEGER, primaryKey: true, allowNull: false },
      // The short token an admin types. Kept narrow deliberately: it is typed
      // into Discord under time pressure, and a long one invites a typo that
      // resolves to the wrong live game.
      alias: { type: DataTypes.STRING(32), allowNull: true },
      // Display only. A Squad server name is long and full of punctuation, which
      // is exactly why it cannot be the token above.
      serverName: { type: DataTypes.STRING(255), allowNull: true },
      // The fingerprint. A change here with a stale heartbeat is an operator
      // moving a server; a change with a fresh one is two processes claiming one
      // identity while both are writing.
      host: { type: DataTypes.STRING(255), allowNull: true },
      queryPort: { type: DataTypes.INTEGER, allowNull: true },
      rconPort: { type: DataTypes.INTEGER, allowNull: true },
      // Enforced rather than diagnostic: a mismatch against any live row refuses
      // the mount, because an older process writing against a schema it does not
      // know about announces itself nowhere else.
      suiteVersion: { type: DataTypes.STRING(32), allowNull: true },
      // Epoch ms from the DATABASE clock, like every other cross-process
      // timestamp in this file — see dbNow(). Comparing two hosts' wall clocks
      // is what the freshness window would otherwise rest on.
      firstSeenAt: { type: DataTypes.BIGINT, allowNull: true },
      lastSeenAt: { type: DataTypes.BIGINT, allowNull: true },
      // What this server’s host clock reads against the database’s, measured at
      // mount. Stored rather than only logged because the log is on the skewed
      // host: the operator asking "why did that expire early" is reading a
      // different machine’s Discord channel, and !s3 servers is where they can
      // see all of them at once.
      clockSkewMs: { type: DataTypes.INTEGER, allowNull: true },
      // A JSON blob rather than a column per option, because the set of
      // community-affecting options will grow and each addition would otherwise
      // be an ALTER on the one table every process writes at mount — on a grant
      // that does not have ALTER.
      communityOptions: { type: DataTypes.TEXT, allowNull: true }
    };

    const indexes = [
      // UNIQUE, and that is the point rather than a performance note: the
      // --server token resolves to exactly one row, and two rows answering to
      // "main" is a mutating command reaching the wrong live game.
      { name: 'idx_s3_servers_alias', fields: ['alias'], unique: true },
      // Every freshness question scans this column.
      { name: 'idx_s3_servers_lastSeenAt', fields: ['lastSeenAt'] }
    ];

    return { schema, indexes };
  }

  /**
   * Initialise `S3_Servers` — the registry that says which servers share this
   * database, and the table every multi-server decision is answered from.
   *
   * Created the same way `S3_Locks` is, and for the same reason: `createTable()`
   * plus a bare `CREATE INDEX`, never `Model.sync()`, which emits
   * `ALTER TABLE ... ADD INDEX` for every declared index even on a table it has
   * just created — and the live MySQL grant has CREATE without ALTER.
   *
   * A failure here is not fatal the way a failed `S3_Locks` is. Locking fails
   * closed because an unserialised migration corrupts a schema; an unavailable
   * registry costs the multi-server guards, and taking a running game server
   * down over that is the worse trade. The error is kept rather than only
   * logged, so the refusals that follow from it can name a cause.
   *
   * Every column is nullable and only `serverID` is required. The registry is
   * written by this suite and by nothing else, so the constraint would buy
   * nothing — and the grant that cannot ALTER also cannot relax one later, which
   * makes a NOT NULL here a decision that outlives its reasoning.
   *
   * @private
   */
  async _initServersModel() {
    const { schema, indexes } = this._serversDefinition();

    this.ServersModel = this.defineModel(
      'S3Servers',
      schema,
      {
        // Load-bearing: defineModel() injects freezeTableName, so without it
        // Sequelize targets 'S3Servers'.
        tableName: 'S3_Servers',
        timestamps: false,
        // Operator-set aliases and first-seen dates are not regenerable from
        // live play — a lost registry loses which server "main" referred to.
        exportTier: 'historical',
        // It IS the server list. Filtering it by server would leave each process
        // able to see only itself, which is the opposite of what it is for.
        scopeKind: 'global',
        indexes
      }
    );

    try {
      const qi = this.getConnector().getQueryInterface();
      await this.executeWithRetry(async () => {
        await qi.createTable('S3_Servers', schema);
      });
      this._serversIndexReport = await this.ensureIndexes('S3_Servers', indexes);
      this.verboseLogger(3, '[DB] Initialised S3_Servers table.');
    } catch (err) {
      this.ServersModel = null;
      this._serversInitError = err;
      this.verboseLogger(
        1,
        `[DB] Could not initialise S3_Servers (${err.message}). The server registry is unavailable, ` +
        'so nothing can tell whether a second server shares this database.'
      );
      stderrWarn(
        'DBService',
        'Could not create the S3_Servers table — the multi-server guards that read it are inert.',
        err.message
      );
    }
  }

  /**
   * Register the `s3-core` migration group — the tables DBService owns itself.
   *
   * `S3_Locks` and `S3_Servers` are both created unconditionally at mount, above,
   * because the first is needed before any migration can be serialised and the
   * second is read by guards that run before the migration gate opens. Being
   * created that way is exactly why they need a group: a table outside every
   * group has no recorded version and drift verification never looks at it, so a
   * column lost from either would go unnoticed indefinitely.
   *
   * `S3_SchemaVersions` is deliberately not in the group. It is the table the
   * versions are recorded *in*, and bookkeeping that has to read itself before it
   * exists has no fixed point to start from.
   *
   * `models:` takes MODEL names and `touches` takes TABLE names. Both of these
   * are among the models where the two spellings differ (`S3Locks` → `S3_Locks`),
   * so writing the model spelling into `touches` would name tables that do not
   * exist and leave verification re-running a migration that already succeeded.
   *
   * @private
   */
  async _registerCoreMigrations() {
    if (!this._migrationEngine) return;

    const { schema: serversSchema } = this._serversDefinition();
    const locksSchema = this._locksSchema();

    this._migrationEngine.registerMigrations('s3-core', [
      {
        version: 1,
        description: 'S3_Locks and S3_Servers (bootstrap — DDL runs unconditionally at mount)',
        // createTable is CREATE TABLE IF NOT EXISTS and has already run above, so
        // there is no row this can lose. It is also the group that owns the lock
        // table itself, and taking a backup — which needs the lock — to protect
        // the lock table is a knot with nothing at the end of it.
        backup: false,
        touches: {
          creates: ['S3_Locks', 'S3_Servers'],
          columns: {
            S3_Locks: Object.keys(locksSchema),
            S3_Servers: Object.keys(serversSchema)
          }
        },
        up: async (qi) => {
          // Idempotent, and run through qi so verification sees the tables on
          // the connection it reads from.
          await qi.createTable('S3_Locks', locksSchema);
          await qi.createTable('S3_Servers', serversSchema);
        }
      }
    ]);

    this.registerExpectedVersion('s3-core', 1, { models: ['S3Locks', 'S3Servers'] });

    // Record it applied straight away, because it already is. Both creates ran
    // above, unconditionally and before any migration could be serialised —
    // that is the whole reason this group is a bootstrap. Registering the
    // expected version without this leaves s3-core permanently behind, and a
    // group that is permanently behind is not a harmless inaccuracy: every
    // consumer plugin's verifyAndRunMigrations() reads the same verdict, so
    // each one would prompt for confirmation of a migration with no work in it,
    // at every boot, and the real pending migrations would be lost in the noise.
    //
    // Only when both tables are actually there. _initServersModel() is
    // non-fatal on failure, and marking a version applied over a table that was
    // never created would record a lie that drift verification then has to
    // discover. Left behind instead, the ordinary confirm-and-run path retries
    // the create, which is the recovery this wants.
    if (this.LocksModel && this.ServersModel) {
      await this._migrationEngine.markBootstrapApplied('s3-core');
    } else {
      this.verboseLogger(
        2,
        '[DB] s3-core left unrecorded — a core table is missing, so the migration path keeps it as pending work.'
      );
    }
  }


  /* ────────────────────────────────────── SERVER REGISTRY LIFECYCLE ────────────────────────────────────── */

  /**
   * The three fields that identify a Squad server as a machine rather than as a
   * name — pulled out of a SquadJS `server` in one place so the mount write and
   * the comparison can never read them differently.
   *
   * `serverName` is deliberately not among them. It is set by
   * `updateServerInformation()`, which has usually not run when S³ mounts, and
   * an admin renaming a server in-game is not a change of identity.
   *
   * @param {object} server - A SquadJS server, or anything with the same `options`
   * @returns {{host: string|null, queryPort: number|null, rconPort: number|null}}
   */
  static serverFingerprint(server) {
    const opts = server?.options || {};
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    return {
      host: typeof opts.host === 'string' && opts.host !== '' ? opts.host : null,
      queryPort: num(opts.queryPort),
      rconPort: num(opts.rconPort)
    };
  }

  /**
   * Whether two fingerprints disagree, naming the fields that do.
   *
   * A field that is null on either side is not a disagreement. Absence is not a
   * value: at first boot the ports may not be configured on this side, and a row
   * written by an older revision of the suite has nulls on the other. Reading
   * "unknown" as "different" would refuse a mount over a field nobody set.
   *
   * @returns {string[]} The differing field names, empty when they agree
   */
  static fingerprintDifferences(a = {}, b = {}) {
    const differences = [];
    for (const field of ['host', 'queryPort', 'rconPort']) {
      const left = a?.[field] ?? null;
      const right = b?.[field] ?? null;
      if (left === null || right === null) continue;
      if (String(left) !== String(right)) differences.push(field);
    }
    return differences;
  }

  /**
   * Whether a registry row was written by a process that is probably still
   * running.
   *
   * This is the whole of the stale/fresh split, and both halves matter. A stale
   * row means the operator moved a server or changed a port, and refusing to
   * mount over that would take a running game offline for a config edit. A fresh
   * row means a second live process is writing under this identity right now,
   * which is the case that silently interleaves two communities' data.
   *
   * `now` is a DATABASE timestamp, not a local one — see `dbNow()`. Two SquadJS
   * hosts have two wall clocks, and a two-minute window compared across them is
   * a window of two minutes plus whatever they disagree by.
   *
   * @param {object} row - An S3_Servers row
   * @param {number} now - Epoch ms from the database clock
   */
  static isServerRowFresh(row, now) {
    const lastSeen = DBService._asEpochMs(row?.lastSeenAt);
    if (lastSeen === null || !Number.isFinite(lastSeen)) return false;
    return (now - lastSeen) < SERVER_FRESHNESS_MS;
  }

  /**
   * Claim this process's row in `S3_Servers`, or report why it cannot.
   *
   * Writes nothing and decides nothing on a collision — it returns a verdict and
   * lets the caller act. The refusal it can lead to takes consumer plugins down,
   * so the decision belongs where the operator-facing message is written, not
   * buried in a database helper.
   *
   * **The first-boot race is settled by the primary key, not by a read.** Two
   * processes starting together would both see an empty table if this began with
   * a SELECT, and both would conclude they own the id. So it inserts first: the
   * database picks a winner, and the loser's constraint violation is the signal
   * to read the row back and compare fingerprints against it. That comparison is
   * the same one an ordinary second boot does, so the race needs no separate
   * path — it only needs the insert to come first.
   *
   * @param {object} opts
   * @param {object} opts.server        - The SquadJS server, for the fingerprint
   * @param {string} [opts.suiteVersion]
   * @param {object} [opts.communityOptions] - Serialised to JSON; the values
   *        enumerated in community-options.js
   * @param {boolean} [opts.force=false] - Treat a fresh collision as a stale one.
   *        The operator override for a false positive: a legitimate port change
   *        plus a restart inside the freshness window is indistinguishable from a
   *        real collision, and without this the suite would refuse to come up
   *        until the window passed.
   * @returns {Promise<object>} A verdict — see `status`
   */
  async registerServer({
    server = null,
    suiteVersion = null,
    communityOptions = null,
    fallbackServerName = null,
    force = false
  } = {}) {
    if (!this.ServersModel) {
      return {
        status: 'unavailable',
        serverID: this._serverID,
        reason: this._serversInitError?.message || 'the S3_Servers table is not available'
      };
    }

    const serverID = this._serverID;
    const fingerprint = DBService.serverFingerprint(server);
    const now = await this.dbNow();
    // RCON first, config file second. They carry the same string, but the
    // live one reflects a rename an admin made without editing Server.cfg,
    // and the config one is the only one that exists at mount — which is when
    // this runs on a first boot, and why the column used to land null.
    const serverName = [server?.serverName, fallbackServerName]
      .map((candidate) => (typeof candidate === 'string' ? candidate.trim() : ''))
      .find((candidate) => candidate !== '')?.slice(0, 255) ?? null;
    const options = communityOptions === null || communityOptions === undefined
      ? null
      : JSON.stringify(communityOptions);

    // The insert comes first, and its failure is expected rather than
    // exceptional — every boot after the first takes the catch.
    try {
      const created = await this.executeWithRetry(async () => this.ServersModel.create({
        serverID,
        // alias is left unset on purpose. It is operator-facing and unique, so
        // minting one here would have to consult every other row to avoid a
        // collision, and a unique index rejects a duplicate by aborting this
        // insert — turning a naming convention into a failure to register.
        alias: null,
        serverName,
        ...fingerprint,
        suiteVersion,
        firstSeenAt: now,
        lastSeenAt: now,
        clockSkewMs: this.getClockSkewMs(),
        communityOptions: options
      }));

      this.verboseLogger(1, `[DB] Registered server ${serverID} in S3_Servers (first boot against this database).`);
      return { status: 'created', serverID, row: created, fingerprint };
    } catch (err) {
      // Anything other than "the row is already there" is a real failure. Read
      // it back rather than matching on the error text, which differs on all
      // three dialects: if the row exists, the insert lost a race it was
      // supposed to lose.
      const existing = await this.ServersModel.findOne({ where: { serverID } });
      if (!existing) {
        this.verboseLogger(1, `[DB] Could not register server ${serverID}: ${err.message}`);
        return { status: 'unavailable', serverID, reason: err.message };
      }

      const stored = {
        host: existing.host ?? null,
        queryPort: existing.queryPort ?? null,
        rconPort: existing.rconPort ?? null
      };
      const differences = DBService.fingerprintDifferences(stored, fingerprint);
      const fresh = DBService.isServerRowFresh(existing, now);

      if (differences.length > 0 && fresh && !force) {
        // Nothing is written. A second process is live under this identity, and
        // overwriting its fingerprint would make this process look like the
        // rightful owner to the next one along.
        return {
          status: 'collision',
          serverID,
          fresh: true,
          differences,
          stored,
          fingerprint,
          lastSeenAt: DBService._asEpochMs(existing.lastSeenAt),
          row: existing
        };
      }

      await this.executeWithRetry(async () => existing.update({
        serverName: serverName ?? existing.serverName,
        ...fingerprint,
        suiteVersion: suiteVersion ?? existing.suiteVersion,
        lastSeenAt: now,
        clockSkewMs: this.getClockSkewMs(),
        communityOptions: options ?? existing.communityOptions,
        firstSeenAt: existing.firstSeenAt ?? now
      }));

      if (differences.length === 0) {
        return { status: 'refreshed', serverID, row: existing, fingerprint };
      }

      return {
        status: 'reclaimed',
        serverID,
        fresh,
        forced: fresh && force,
        differences,
        stored,
        fingerprint,
        row: existing
      };
    }
  }

  /**
   * Stamp `lastSeenAt` on this process's row.
   *
   * Called on mount and on every round roll. The freshness window is what tells
   * a live collision from a moved server, so a heartbeat that stops is a
   * process that has gone away — which is exactly the reading it should get.
   *
   * Never throws. A heartbeat is a diagnostic write, and taking a game server
   * down because one of them failed would invert the trade the registry exists
   * to make.
   *
   * @returns {Promise<number|null>} The database timestamp written, or null
   */
  async heartbeatServer() {
    if (!this.ServersModel) return null;
    try {
      const now = await this.dbNow();
      const [updated] = await this.ServersModel.update(
        { lastSeenAt: now, clockSkewMs: this.getClockSkewMs() },
        { where: { serverID: this._serverID } }
      );

      // On the same heartbeat, deliberately: the count and the timestamp must
      // not be able to come apart, and a caller that stamps without re-reading
      // is the single-server-forever bug in a different place.
      await this.refreshRegisteredServerCount();

      // Same argument, and the same call site for the same reason: the resolved
      // token cap is read synchronously on the switch path, so its only
      // staleness bound is how often this runs.
      await this.getCommunityOptionSummary();

      return updated > 0 ? now : null;
    } catch (err) {
      this.verboseLogger(2, `[DB] Server heartbeat failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Every row in the registry, oldest first.
   *
   * @returns {Promise<object[]>} Plain rows, or an empty array when unavailable
   */
  async getRegisteredServers() {
    if (!this.ServersModel) return [];
    try {
      return await this.ServersModel.findAll({ order: [['serverID', 'ASC']], raw: true });
    } catch (err) {
      this.verboseLogger(2, `[DB] Could not read S3_Servers: ${err.message}`);
      return [];
    }
  }

  /**
   * Reduce an operator-typed token to the form aliases are stored and compared
   * in: lowercase, and letters, digits, `-` and `_` only.
   *
   * A Squad server name is mostly punctuation and clan brackets, and an alias is
   * typed into Discord by hand under time pressure. Folding case here means
   * `--server Main` finds `main`, which is one fewer way to be told a server
   * does not exist while looking straight at it.
   *
   * @param {*} raw
   * @returns {string|null} The normalised alias, or null if nothing survived
   */
  static normalizeAlias(raw) {
    if (typeof raw !== 'string') return null;
    const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '')
      // A leading hyphen makes an alias unaddressable rather than ugly. The
      // routing gate reads the token after `--server`, and one that starts
      // with `-` is a flag the admin typed instead of a name — so
      // `--server -main` refuses with "you did not name a server", and
      // retyping it more carefully does not help. Trailing separators go
      // with it because `main-` and `main` are the same name to a reader.
      .replace(/^[-_]+/, '')
      .replace(/[-_]+$/, '');
    if (cleaned === '') return null;

    // A bare number shadows a server id. `resolveServerToken()` reads one as
    // an id BEFORE it looks at aliases, so an alias of "2" on server 3 sends
    // every `--server 2` to server 2 — the wrong live game, and nothing on
    // screen says so. Refusing the name is the only place this is catchable:
    // by the time the token is being resolved the two readings are
    // indistinguishable, and picking either one is a coin toss.
    if (/^[0-9]+$/.test(cleaned)) return null;

    return cleaned.slice(0, ALIAS_MAX_LENGTH);
  }

  /**
   * The alias a server gets when nobody has chosen one.
   *
   * The first word of the server name, not `srv<serverID>`. That default is the
   * obvious one, and it is the exact shape the confirmation guards exist to
   * prevent: `srv1` and `srv2` differ by one keystroke, in the last
   * position, which is where a typo is least likely to be caught by eye. Two
   * servers named "NL Slackers #1" and "Event Server" give `nl` and `event`,
   * which cannot be confused for one another.
   *
   * Falls back to `srv<serverID>` only when there is no name to read. That is
   * rarer than it looks: SquadJS fills `serverName` in from
   * `updateServerInformation()`, which has usually not run at mount, so the
   * caller passes ServerConfigService's copy of the same string instead.
   *
   * A name is not always a usable alias, and a community that numbers its
   * servers is exactly the case where it is not. "Northern Lights #1" and
   * "Northern Lights #2" both mint `northern`, so the second takes the
   * suffixed form from claimDefaultAlias() and the bare one goes to whichever
   * booted first — arbitrary, and not what an operator would have chosen.
   * Deriving something longer does not help: every pair that keeps both
   * numbers is one edit apart, which setServerAlias() refuses. Naming two
   * numbered servers is an operator decision, and `!s3 servers alias` is
   * where it gets made.
   *
   * @returns {string} Always a usable alias
   */
  static defaultAliasFor({ serverName = null, serverID = DEFAULT_SERVER_ID } = {}) {
    const firstWord = typeof serverName === 'string'
      ? serverName.trim().split(/\s+/)[0]
      : null;
    return DBService.normalizeAlias(firstWord) || `srv${serverID}`;
  }

  /**
   * Levenshtein edit distance, iterative with one row of state.
   *
   * Written here rather than imported from `elo-clan-grouping.js`, which has the
   * same routine: install.cjs flattens every plugin into one directory, and a
   * cross-plugin import would resolve in the source tree and fail in the shipped
   * layout. Twenty duplicated lines is the cheaper side of that trade.
   */
  static aliasEditDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    if (a.length > b.length) [a, b] = [b, a];

    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => i);

    for (let j = 1; j <= n; j++) {
      let prev = dp[0];
      dp[0] = j;
      for (let i = 1; i <= m; i++) {
        const tmp = dp[i];
        dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
        prev = tmp;
      }
    }
    return dp[m];
  }

  /**
   * Which existing rows an alias would collide with, or sit too close to.
   *
   * **`exceptServerID` is not an optimisation.** The comparison is against
   * *other* rows only, and without the exemption renaming `main` to `mains`
   * would be refused for being one edit from `main` — which is the row being
   * renamed. A distinctness rule that forbids editing a name is not a
   * distinctness rule.
   *
   * @param {string} alias - Already normalised
   * @param {{exceptServerID?: number|null}} [opts]
   * @returns {Promise<{duplicate: object|null, near: object[]}>}
   */
  async findAliasConflicts(alias, { exceptServerID = null } = {}) {
    const rows = (await this.getRegisteredServers())
      .filter((r) => r.alias !== null && r.serverID !== exceptServerID);

    const duplicate = rows.find((r) => r.alias === alias) || null;
    const near = rows.filter(
      (r) => r.alias !== alias && DBService.aliasEditDistance(r.alias, alias) < ALIAS_MIN_EDIT_DISTANCE
    );

    return { duplicate, near };
  }

  /**
   * Set a server's alias, or explain why not.
   *
   * Uniqueness and distinctness are checked in the same place deliberately.
   * Uniqueness is what the index enforces and what stops `--server main`
   * resolving to two rows; distinctness is what stops the two aliases being one
   * keystroke apart in the first place, which is the failure a unique index
   * cannot see. Splitting them across two call sites is how one of them ends up
   * running on the registration path and not on the rename path.
   *
   * @param {number} serverID
   * @param {string} rawAlias
   * @returns {Promise<{ok: boolean, alias?: string, reason?: string, conflicts?: object}>}
   */
  async setServerAlias(serverID, rawAlias) {
    if (!this.ServersModel) {
      return { ok: false, reason: 'the server registry is unavailable' };
    }

    const alias = DBService.normalizeAlias(rawAlias);
    if (alias === null) {
      return {
        ok: false,
        reason:
          'an alias needs at least one letter, digit, hyphen or underscore once punctuation is stripped, ' +
          'and cannot be a bare number — a numeric alias shadows a server id, and `--server 2` would reach ' +
          'server 2 rather than the server you named'
      };
    }

    const row = await this.ServersModel.findOne({ where: { serverID } });
    if (!row) return { ok: false, reason: `no server is registered under id ${serverID}` };

    const conflicts = await this.findAliasConflicts(alias, { exceptServerID: serverID });
    if (conflicts.duplicate) {
      return {
        ok: false,
        reason: `server ${conflicts.duplicate.serverID} already answers to "${alias}"`,
        conflicts
      };
    }
    if (conflicts.near.length > 0) {
      const names = conflicts.near.map((r) => `"${r.alias}" (server ${r.serverID})`).join(', ');
      return {
        ok: false,
        reason:
          `"${alias}" is one edit away from ${names}. Two aliases a keystroke apart is how a ` +
          'mutating command reaches the wrong live game — pick something that cannot be mistyped into the other.',
        conflicts
      };
    }

    try {
      await this.executeWithRetry(async () => row.update({ alias }));
      return { ok: true, alias };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /**
   * Give this server an alias if it has none, without ever failing the mount
   * over it.
   *
   * Registration must not depend on a naming clash: `registerServer()`
   * deliberately leaves `alias` null so that a unique index cannot abort the
   * insert. This runs afterwards, and if the obvious name is taken it falls back
   * to a suffixed form rather than giving up — an unnamed server is one that
   * `--server` cannot address at all.
   *
   * @returns {Promise<string|null>} The alias now on the row, or null
   */
  async claimDefaultAlias({ serverID = this._serverID, serverName = null } = {}) {
    if (!this.ServersModel) return null;

    try {
      const row = await this.ServersModel.findOne({ where: { serverID } });
      if (!row) return null;
      if (row.alias) return row.alias;

      const base = DBService.defaultAliasFor({ serverName, serverID });
      // The suffixed form is only reached when the first word is shared, which
      // two servers in one community very often do ("NL Slackers #1", "NL
      // Slackers #2"). It stays distinct because the id is appended, not
      // substituted into the last character.
      for (const candidate of [base, `${base}-${serverID}`]) {
        const attempt = await this.setServerAlias(serverID, candidate);
        if (attempt.ok) {
          this.verboseLogger(1, `[DB] Server ${serverID} registered under the alias "${attempt.alias}".`);
          return attempt.alias;
        }
      }

      this.verboseLogger(
        1,
        `[DB] Could not give server ${serverID} a default alias — every candidate collided with an ` +
        'existing one. Set one by hand with !s3 servers alias, or the server cannot be named by --server.'
      );
      return null;
    } catch (err) {
      this.verboseLogger(2, `[DB] Default alias assignment failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Resolve a `--server` token to exactly one registry row.
   *
   * Never picks a winner. An ambiguous token is the wrong-server hazard the
   * alias rules exist to prevent, and resolving it to the first row would turn
   * the one case that is detectable into the one case that is silent. The
   * candidates come back with the refusal so the reply can list them.
   *
   * A bare number is accepted as a serverID, because an operator reading a log
   * line has the id in front of them and not the alias.
   *
   * @param {string} token
   * @returns {Promise<{row: object}|{ambiguous: object[]}|{notFound: true, candidates: object[]}>}
   */
  async resolveServerToken(token) {
    const rows = await this.getRegisteredServers();
    const normalized = DBService.normalizeAlias(token);

    const asID = DBService.coerceServerID(token);
    if (asID !== null) {
      const byID = rows.filter((r) => r.serverID === asID);
      if (byID.length === 1) return { row: byID[0] };
    }

    const matches = normalized === null ? [] : rows.filter((r) => r.alias === normalized);
    if (matches.length === 1) return { row: matches[0] };
    if (matches.length > 1) return { ambiguous: matches };
    return { notFound: true, candidates: rows };
  }

  /**
   * How many servers are **registered** — the row count, live or not.
   *
   * This is the operator-facing definition, and it is the one every gate that
   * changes what an admin has to type must use: selectors, labels,
   * confirmations. A stale row is still a server the community owns, and
   * quietly dropping back to implicit targeting because a process happens to be
   * restarting is precisely the wrong-server hazard the selectors exist for.
   *
   * Its counterpart is `getLiveServers()`. Keeping the two definitions in one
   * helper each is the point: a second, informal definition of "is this a
   * multi-server install" is how a decommissioned server keeps a community in
   * multi-server mode forever, or how a restarting one silently drops it out.
   *
   * @returns {Promise<number>}
   */
  async getRegisteredServerCount() {
    if (!this.ServersModel) return 0;
    try {
      return await this.ServersModel.count();
    } catch (err) {
      this.verboseLogger(2, `[DB] Could not count S3_Servers: ${err.message}`);
      return 0;
    }
  }

  /**
   * Look for evidence that this database was already being written by more
   * than one server before `serverID` existed to record which.
   *
   * **Every Phase 3 backfill rests on an assumption this checks rather than
   * makes.** Stamping every pre-upgrade row with this process’s `server.id`
   * is correct only if this process wrote all of them. It usually did. But
   * the communities that want multi-server support are exactly the ones most
   * likely to have already pointed two servers at one database — that is the
   * corruption the registry’s collision split exists to detect — and on such
   * a database the backfill does not lose data, it launders interleaved
   * history into confident, wrong attribution. Wrong attribution is worse
   * than none: a NULL says "unknown", a wrong id says "server 1" to every
   * report that ever reads the row again.
   *
   * Two signals, and either one is enough:
   *
   * 1. `S3_Servers` already holds more than one row. The registry is new, so
   *    on an upgrade it holds this process alone unless something else has
   *    already introduced itself.
   * 2. Two distinct rounds overlap in time in `S3_GameStateEvents`. One
   *    server cannot have two rounds live at once, so an overlap is two
   *    writers.
   *
   * The second signal’s threshold was measured, not guessed. Across the 992
   * rounds in the newest single-writer production export there is **not one**
   * overlapping pair, and the tightest gap between consecutive rounds is 76ms
   * against a median of 175 seconds. So the honest threshold is zero, and the
   * 1s used below is thirteen times the tightest real boundary purely so a
   * single out-of-order write cannot raise a false alarm.
   *
   * Memoised for the life of the process: five plugin groups call this during
   * one migration pass and the answer cannot change between them.
   *
   * @returns {Promise<{interleaved: boolean, reason: string|null, checked: string[]}>}
   */
  async detectPriorInterleaving() {
    if (this._interleavingVerdict) return this._interleavingVerdict;

    const checked = [];
    let verdict = { interleaved: false, reason: null, checked };

    try {
      if (this.ServersModel) {
        checked.push('S3_Servers');
        const count = await this.ServersModel.count();
        if (count > 1) {
          verdict = {
            interleaved: true,
            reason: `S3_Servers already holds ${count} servers, so this database has more than one writer`,
            checked
          };
        }
      }

      if (!verdict.interleaved) {
        const Events = this.getModel('S3GameStateEvents');
        if (Events) {
          checked.push('S3_GameStateEvents');
          const overlap = await this._findOverlappingRounds(Events);
          if (overlap) {
            verdict = {
              interleaved: true,
              reason: `rounds ${overlap.a} and ${overlap.b} overlap by ${overlap.ms}ms in S3_GameStateEvents, ` +
                      'and one server cannot have two rounds live at once',
              checked
            };
          }
        }
      }
    } catch (err) {
      // A check that cannot run is not a clean bill of health, but it is also
      // not evidence of interleaving. Say which, and let the backfill proceed
      // — refusing on an unreadable table would block every upgrade whose
      // logging service is switched off.
      this.verboseLogger(1, `[DB] Could not check for prior interleaving: ${err.message}`);
    }

    this._interleavingVerdict = verdict;
    return verdict;
  }

  /**
   * Group the game-state log into rounds and return the first pair whose
   * windows overlap, or null. Aggregated in the engine rather than by reading
   * every row: the production table is 24k rows and the three dialects all
   * do MIN/MAX/GROUP BY.
   *
   * @private
   */
  async _findOverlappingRounds(Events) {
    const Op = this.sequelize?.constructor?.Op || SequelizeLib.Op;
    const { fn, col } = SequelizeLib;
    const rows = await Events.findAll({
      attributes: [
        'matchId',
        [fn('MIN', col('ts')), 'minTs'],
        [fn('MAX', col('ts')), 'maxTs']
      ],
      where: { matchId: { [Op.ne]: null } },
      group: ['matchId'],
      raw: true
    });

    const rounds = rows
      .map((r) => ({ id: r.matchId, min: Number(r.minTs), max: Number(r.maxTs) }))
      .filter((r) => Number.isFinite(r.min) && Number.isFinite(r.max))
      .sort((a, b) => a.min - b.min);

    const TOLERANCE_MS = 1000;
    for (let i = 1; i < rounds.length; i++) {
      const overlap = rounds[i - 1].max - rounds[i].min;
      if (overlap > TOLERANCE_MS) {
        return { a: rounds[i - 1].id, b: rounds[i].id, ms: overlap };
      }
    }
    return null;
  }

  /**
   * Stamp this server’s id onto pre-upgrade rows of one Class A table.
   *
   * Called from inside a migration’s `up()`, on the migration’s own
   * transaction, so a later failure takes the backfill back with the
   * `ADD COLUMN` rather than leaving rows stamped against a column that no
   * longer exists.
   *
   * Three things it deliberately does:
   *
   * • Matches on `IS NULL`, never on "the column was just added". A database
   *   where an operator hand-applied the ALTER, or where an earlier attempt
   *   failed after it, arrives with the column present and every row NULL,
   *   and a guarded backfill is a silent no-op on exactly that database.
   *   Callers must invoke this OUTSIDE their addColumn guard for the same
   *   reason.
   * • Refuses, loudly, when `detectPriorInterleaving()` finds another writer.
   *   The rows stay NULL. A NULL row is one no per-server report will claim,
   *   which is the correct answer for a row nothing can attribute.
   * • Refuses when this process has no server id, rather than defaulting to 1.
   *
   * @param {object} qi   migration query interface (carries the transaction)
   * @param {string} table  physical table name
   * @param {number|null} serverID
   * @returns {Promise<{stamped: boolean, reason: string|null}>}
   */
  async backfillServerID(qi, table, serverID) {
    const Op = this.sequelize?.constructor?.Op || SequelizeLib.Op;

    if (serverID == null) {
      stderrWarn(
        'DBService',
        `Backfill of ${table}.serverID skipped — this process has no resolved server id.`,
        'Rows stay NULL and no per-server report will include them.'
      );
      return { stamped: false, reason: 'no-server-id' };
    }

    const verdict = await this.detectPriorInterleaving();
    if (verdict.interleaved) {
      stderrWarn(
        'DBService',
        `Backfill of ${table}.serverID REFUSED — ${verdict.reason}.`,
        `Existing rows cannot be attributed to one server and are being left NULL rather than ` +
        `stamped as server ${serverID}. New rows carry the correct id. If you know these rows ` +
        `belong to one server, set the column by hand.`
      );
      return { stamped: false, reason: 'interleaved' };
    }

    await qi.bulkUpdate(table, { serverID }, { serverID: { [Op.is]: null } });
    this.verboseLogger(2, `[DB] Backfilled ${table}.serverID to ${serverID} for rows that had none.`);
    return { stamped: true, reason: null };
  }

  /**
   * Re-read the registered count and report whether it crossed the line that
   * changes what admins have to type.
   *
   * **Reading the count once at mount is the bug this exists to prevent.** A
   * process that booted alone would stay in single-server mode for as long as it
   * runs: no selector required, no label on a reply, no confirmation armed —
   * while the admin in Discord, who can see two servers in `!s3 servers`,
   * believes every one of those guards is live. The count is therefore refreshed
   * on the heartbeat, which is the one event that already recurs for exactly the
   * reason this needs to.
   *
   * The transition is logged at level 1 rather than left to be inferred, because
   * it changes the meaning of every admin command in the channel and it happens
   * while nobody is looking at this server. Both directions are logged: a
   * `!s3 servers forget` on another process silently gives this one implicit
   * targeting back, which is the same surprise in reverse.
   *
   * The cached value is deliberately **not** exposed. Anything deciding an
   * operator-facing outcome awaits `getRegisteredServerCount()` — one definition
   * of "how many servers are there", which is the whole point of that helper.
   * This cache answers only "has it changed since I last looked".
   *
   * @returns {Promise<{count: number, previous: number|null, transition: 'one-to-many'|'many-to-one'|null}>}
   */
  /**
   * The registered count as of the last heartbeat, without a query.
   *
   * The routing gate runs on every admin Discord message and asks this
   * question first, so it reads the heartbeat's cached answer rather than
   * counting rows each time. Null means no heartbeat has run yet — the
   * caller reads it once the slow way and the heartbeat takes over.
   *
   * @returns {number|null}
   */
  getKnownServerCount() {
    return this._lastKnownServerCount;
  }

  async refreshRegisteredServerCount() {
    const count = await this.getRegisteredServerCount();
    const previous = this._lastKnownServerCount;
    this._lastKnownServerCount = count;

    // A first read establishes the baseline. Logging a transition here would
    // announce "a second server joined" to every process that boots into an
    // already-multi-server community.
    if (previous === null || previous === count) {
      return { count, previous, transition: null };
    }

    if (previous <= 1 && count > 1) {
      this.verboseLogger(
        1,
        `[DB] Another server has joined this database — ${count} are now registered. Server-scoped admin ` +
        'commands need a --server selector from here on, and mutating ones confirm against live context first.'
      );
      return { count, previous, transition: 'one-to-many' };
    }

    if (previous > 1 && count <= 1) {
      this.verboseLogger(
        1,
        `[DB] Down to ${count} registered server. Server-scoped admin commands target this server ` +
        'implicitly again, with no --server selector.'
      );
      return { count, previous, transition: 'many-to-one' };
    }

    return { count, previous, transition: null };
  }

  /**
   * The servers that are **live** — a `lastSeenAt` inside the freshness window.
   *
   * Use only where liveness is the actual question: the version comparison, the
   * identity collision split, and refusing to target a server that is not
   * answering. Never for an operator-facing gate — see
   * `getRegisteredServerCount()`.
   *
   * @returns {Promise<object[]>}
   */
  async getLiveServers() {
    const now = await this.dbNow();
    return (await this.getRegisteredServers()).filter((row) => DBService.isServerRowFresh(row, now));
  }

  /**
   * Compare this process's suite version against every other server that is
   * currently live.
   *
   * **Refusing rather than warning is the point.** A mixed pair is not a
   * degraded state that limps along: an older process writes against a schema it
   * does not know about, and a community-wide command handed to an arbitrary
   * responder may run a superseded routine against shared data. Neither failure
   * announces itself, so the only moment either can be caught is this one.
   *
   * Three exclusions, each deliberate:
   *
   *   - **This server's own row.** It was written moments ago by this process.
   *   - **Stale rows.** This is one of the few genuinely liveness-shaped
   *     questions (see `getLiveServers()`): a stopped server writes nothing, so
   *     it cannot be the one running superseded code. Using the registered count
   *     here would refuse every mount after an upgrade until the old rows were
   *     forgotten by hand.
   *   - **A null version on either side.** Unknown, not different — the same
   *     rule the fingerprint comparison uses, and for the same reason. Every
   *     version of this suite records the field, so a null is a hand-edited or
   *     partially restored row rather than an old process, and refusing a mount
   *     over one would be refusing over an absence of evidence.
   *
   * Two processes booting together with different versions both write, then both
   * see the other, and both refuse. That is the intended outcome: with no way to
   * tell which of the two is the upgrade, coming up on either is a coin toss
   * against the schema.
   *
   * @param {string|null} suiteVersion - This process's version
   * @returns {Promise<{ok: boolean, version: string|null, checked: number, mismatches: object[]}>}
   */
  async checkVersionLockstep(suiteVersion) {
    const mine = typeof suiteVersion === 'string' && suiteVersion !== '' ? suiteVersion : null;
    if (!this.ServersModel || mine === null) {
      return { ok: true, version: mine, checked: 0, mismatches: [] };
    }

    try {
      const others = (await this.getLiveServers()).filter((row) => row.serverID !== this._serverID);
      const mismatches = others.filter(
        (row) => typeof row.suiteVersion === 'string' && row.suiteVersion !== '' && row.suiteVersion !== mine
      );

      return { ok: mismatches.length === 0, version: mine, checked: others.length, mismatches };
    } catch (err) {
      // A registry this process cannot read is already reported by the claim
      // path. Refusing every mount because a query failed would turn a database
      // hiccup into a community-wide outage.
      this.verboseLogger(2, `[DB] Version lockstep check could not run: ${err.message}`);
      return { ok: true, version: mine, checked: 0, mismatches: [] };
    }
  }

  /**
   * Record one plugin's community-affecting option values onto this server's row.
   *
   * **Post-validation values only.** Switch clamps a non-positive
   * `maxSwitchTokens` to 1 at mount, so a caller that records what was in
   * `config.json` reports agreement between two servers that disagree and
   * disagreement between two that agree. Every caller therefore records after
   * its own clamping, not before.
   *
   * Merged into an in-process accumulator and written whole, rather than
   * read-modify-written against the stored blob. Two plugins mounting in the
   * same boot would otherwise be able to lose each other's keys, and — the part
   * that matters more — a plugin uninstalled since the last boot would leave its
   * option in the blob forever, where it would go on constraining a community
   * that no longer runs it.
   *
   * Never throws. A failed record makes this server contribute no candidate,
   * which resolves to the rest of the community rather than to nothing.
   *
   * @param {string} pluginName - For the log line only
   * @param {object} values - `{optionKey: number}`, post-validation
   * @returns {Promise<boolean>} Whether the row was written
   */
  async recordCommunityOptions(pluginName, values) {
    if (!this.ServersModel || !values || typeof values !== 'object') return false;

    this._recordedCommunityOptions = { ...this._recordedCommunityOptions, ...values };

    try {
      const [updated] = await this.executeWithRetry(async () => this.ServersModel.update(
        { communityOptions: JSON.stringify(this._recordedCommunityOptions) },
        { where: { serverID: this._serverID } }
      ));
      if (updated > 0) {
        this.verboseLogger(
          2,
          `[DB] Recorded ${pluginName}'s community-affecting options on server ${this._serverID}: ` +
          `${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(', ')}.`
        );
      }
      // Warn here rather than from S³'s own mount, which runs before any
      // consumer plugin has recorded anything and would therefore compare this
      // server against a row it has not written yet. This is also where the
      // operator is looking: the divergence is announced by the mount of the
      // plugin that owns the option.
      await this._warnCommunityOptionDivergence(pluginName, values);

      return updated > 0;
    } catch (err) {
      this.verboseLogger(2, `[DB] Could not record ${pluginName}'s community options: ${err.message}`);
      return false;
    }
  }

  /**
   * The mount warning: log, at level 1, what this server just recorded
   * disagrees with and what is actually in force because of it.
   *
   * **Warn, never refuse.** Extending the version check's mount refusal to
   * cover configuration would take a live game offline over `maxSwitchTokens`,
   * and a config mismatch is two admins disagreeing about policy — which they
   * may well have meant — rather than a process writing against a schema it
   * cannot read.
   *
   * The override half is not decoration. A server whose configured cap has been
   * resolved away reads a value that appears nowhere in its own config file,
   * and an operator who is not told will spend an evening editing an option
   * that no longer does anything.
   *
   * Scoped to the keys just recorded so each plugin announces its own options
   * once, rather than every plugin re-announcing the whole list.
   */
  async _warnCommunityOptionDivergence(pluginName, values) {
    const summary = await this.getCommunityOptionSummary();
    const groups = COMMUNITY_OPTION_GROUPS.filter((g) => g.keys.some((k) => k in values));

    for (const group of groups) {
      const entry = summary.disagreements.find((d) => d.name === group.name);
      if (entry) {
        const note = group.kind === OPTION_KIND.MUST_AGREE
          ? 'The housekeeping writes that read it decline until these agree.'
          : group.kind === OPTION_KIND.MAY_DIFFER
            ? 'This one is allowed to differ — each server applies its own to its own rounds — but it is worth being deliberate about.'
            : 'Every server reads one resolved value for it; see below.';
        this.verboseLogger(1, `[DB] Configuration divergence across this community — ${describeDisagreement(entry)}. ${note}`);
      }

      if (group.kind !== OPTION_KIND.RESOLVED) continue;
      const winner = summary.resolved[group.name];
      if (!winner) continue;

      const overridden = group.keys.filter((k) => k in values && values[k] !== winner.values[k]);
      if (overridden.length === 0) continue;

      const who = winner.alias ? `"${winner.alias}"` : `server ${winner.serverID}`;
      const mine = overridden.map((k) => `${k}=${values[k]}`).join(', ');
      const theirs = group.keys.map((k) => `${k}=${winner.values[k]}`).join(', ');
      this.verboseLogger(
        1,
        `[DB] This server is configured ${mine}, but the community resolves to ${theirs} — the lowest ` +
        `registered value, from ${who}. That is what this process will read, on the gameplay path included. ` +
        'Editing the local option changes nothing until every registered server agrees.'
      );
    }
  }

  /**
   * Record which Discord channel this server uses for a named purpose.
   *
   * ─── WHY THIS IS NOT A COMMUNITY OPTION ───
   *
   * It rides in the same blob and is deliberately invisible to the
   * resolver: `summariseCommunityOptions()` reads only the groups it
   * declares, and a channel id is a string, so it contributes no candidate
   * to anything. Two servers pointing at different channels is not a
   * disagreement to reconcile — it is the arrangement this exists to
   * confirm.
   *
   * Kept out of a column of its own because the blob is the one place a
   * per-server fact can be added without an ALTER, and the grant this runs
   * on does not have ALTER.
   *
   * @param {string} name - The purpose, e.g. 'switchReporting'
   * @param {string|null} channelID
   * @returns {Promise<boolean>} Whether the row was written
   */
  async recordChannelBinding(name, channelID) {
    if (!this.ServersModel || typeof name !== 'string' || name === '') return false;

    // Merged a level down rather than through the shallow spread the option
    // recorder uses, so two plugins binding two channels in one boot do not
    // erase each other.
    const channels = { ...(this._recordedCommunityOptions.channels || {}) };
    if (channelID === null || channelID === undefined || channelID === '') delete channels[name];
    else channels[name] = String(channelID);
    this._recordedCommunityOptions = { ...this._recordedCommunityOptions, channels };

    try {
      const [updated] = await this.executeWithRetry(async () => this.ServersModel.update(
        { communityOptions: JSON.stringify(this._recordedCommunityOptions) },
        { where: { serverID: this._serverID } }
      ));
      return updated > 0;
    } catch (err) {
      this.verboseLogger(2, `[DB] Could not record the ${name} channel binding: ${err.message}`);
      return false;
    }
  }

  /**
   * The OTHER registered servers pointing the same named channel at the
   * same id.
   *
   * Registered rather than live, for the reason the wipe confirmation is:
   * a stopped server's round summaries are still sitting in that channel,
   * and a scrape cannot tell them apart from this server's because it is
   * running and the neighbour is not.
   *
   * An empty array means nobody else declares it — which is also what a
   * registry this process cannot read returns, because refusing an admin
   * command over a query failure is the worse of the two outcomes and the
   * failure it guards is bounded by how long the neighbour stays silent.
   *
   * @param {string} name
   * @param {string|null} channelID
   * @returns {Promise<Array<{serverID: number, alias: string|null}>>}
   */
  async getChannelSharers(name, channelID) {
    if (!this.ServersModel || !channelID) return [];
    const wanted = String(channelID);

    try {
      const rows = await this.getRegisteredServers();
      return rows
        .filter((row) => row.serverID !== this._serverID)
        .filter((row) => parseCommunityOptions(row.communityOptions)?.channels?.[name] === wanted)
        .map((row) => ({ serverID: row.serverID, alias: row.alias ?? null }));
    } catch (err) {
      this.verboseLogger(2, `[DB] Could not read the ${name} channel bindings: ${err.message}`);
      return [];
    }
  }

  /**
   * Resolve and compare every registered server's community-affecting options.
   *
   * Over **registered** rows, not live ones, and that is the opposite of the
   * version check on purpose. A stopped server is not writing against a schema
   * it does not understand, so its version does not matter; its configuration
   * still states what this community's policy is, and it is coming back.
   * Resolving over live rows would also make the token cap in force flap every
   * time a neighbour restarted.
   *
   * The result is cached on `communityOptions` because the gameplay path needs
   * it synchronously — `_regenTokens()` runs inside a balance read and cannot
   * await a query. That is the difference from the registered-count cache, which
   * is deliberately not exposed: there, every consumer can await the helper and
   * get a currently-correct answer, so a second, staler definition would be pure
   * hazard. Here no such option exists, and the staleness bound is instead made
   * explicit — this is refreshed on every heartbeat, so at worst a consumer
   * reads a value that was correct one round ago.
   *
   * Never throws; on failure the previous summary stands.
   *
   * @returns {Promise<{resolved: object, disagreements: object[]}>}
   */
  async getCommunityOptionSummary() {
    if (!this.ServersModel) return this._communityOptionSummary;
    try {
      this._communityOptionSummary = summariseCommunityOptions(await this.getRegisteredServers());
    } catch (err) {
      this.verboseLogger(2, `[DB] Could not summarise community options: ${err.message}`);
    }
    return this._communityOptionSummary;
  }

  /**
   * The cached option summary, read synchronously.
   *
   * Empty until the first `getCommunityOptionSummary()`, and an empty `resolved`
   * means "no community value is in force" rather than "the value is zero" —
   * every consumer falls back to its own configured option, which is the right
   * answer for a community of one and the only answer available before the
   * registry has been read.
   */
  get communityOptions() {
    return this._communityOptionSummary;
  }

  /**
   * Remove a server from the registry.
   *
   * Refuses while the row is fresh, which is the whole safety of it: forgetting
   * a server that is still running deletes the row it is about to write again,
   * and in the window between the two nothing knows the server exists.
   *
   * Deregistration has to be a real operation rather than an omission. Without
   * it, a community that retires a server can only return to single-server
   * behaviour by editing the table by hand, which is the sort of thing that gets
   * done wrong at 2am.
   *
   * @param {number} serverID
   * @returns {Promise<{ok: boolean, reason?: string, row?: object}>}
   */
  async forgetServer(serverID) {
    if (!this.ServersModel) return { ok: false, reason: 'the server registry is unavailable' };

    const row = await this.ServersModel.findOne({ where: { serverID } });
    if (!row) return { ok: false, reason: `no server is registered under id ${serverID}` };

    const now = await this.dbNow();
    if (DBService.isServerRowFresh(row, now)) {
      const age = Math.round((now - DBService._asEpochMs(row.lastSeenAt)) / 1000);
      return {
        ok: false,
        reason: `server ${serverID} was seen ${age}s ago and is still running — stop it first`,
        row: row.get({ plain: true })
      };
    }

    const plain = row.get({ plain: true });
    await this.executeWithRetry(async () => row.destroy());
    this.verboseLogger(1, `[DB] Forgot server ${serverID} ("${plain.alias || 'unnamed'}") from the registry.`);
    return { ok: true, row: plain };
  }

  /* ────────────────────────────────────── DDL GRANT PRE-FLIGHT ────────────────────────────────────── */

  /**
   * Which DDL the connected database user can actually perform.
   *
   * The live MySQL profile this repo targets is `SELECT, INSERT, UPDATE,
   * DELETE, CREATE, INDEX` — CREATE without ALTER. Under that grant a migration
   * that adds a column does not fail cleanly: it creates whatever tables it
   * needs, then throws on the first ADD COLUMN, leaving the schema half-changed
   * and the operator holding an error message rather than a fix. Knowing the
   * answer BEFORE running is what lets the engine skip, emit the script, and say
   * so plainly instead.
   *
   * Probed by attempting, not by parsing `SHOW GRANTS`. Grants arrive through
   * roles, wildcards and inheritance, so the text of a grant statement is a poor
   * predictor of what a statement will actually be allowed to do; the only
   * reliable question is the one the database itself answers.
   *
   * The scratch table is left in place when DROP is refused — which is itself
   * the DROP result, so the probe cleans up exactly when it is permitted to. A
   * lingering empty `S3_GrantProbe` on a restricted install is deliberate and
   * is re-used rather than recreated on the next probe.
   *
   * @param {{force?: boolean}} [opts] - force re-probes instead of using the
   *        cached answer from this mount.
   * @returns {Promise<{dialect: string, create: boolean, index: boolean, alter: boolean, drop: boolean, errors: Record<string,string>, probedAt: number}>}
   */
  async probeDdlGrants({ force = false } = {}) {
    if (this._ddlGrants && !force) return this._ddlGrants;

    const result = {
      dialect: this.getDialect(),
      create: false,
      index: false,
      alter: false,
      drop: false,
      errors: {},
      probedAt: Date.now()
    };

    const connector = this.getConnector();
    if (!connector) {
      result.errors.create = 'no connector';
      return result;
    }

    const DataTypes = this.getDataTypes();
    const qi = connector.getQueryInterface();
    const q = (id) => this.quoteIdentifier(id);
    const TABLE = 'S3_GrantProbe';
    const INDEX = 'idx_s3_grant_probe';
    const COLUMN = 'probeColumn';

    try {
      // CREATE TABLE IF NOT EXISTS — succeeds whether or not a previous probe
      // left the table behind, and either way proves the CREATE grant.
      await qi.createTable(TABLE, { id: { type: DataTypes.INTEGER, primaryKey: true } });
      result.create = true;
    } catch (err) {
      result.errors.create = err.message;
      this._ddlGrants = result;
      return result;
    }

    // Existence is checked before each attempt rather than inferring "already
    // there" from an error string. Driver error text differs on all three
    // engines, and a probe that reads a refusal as a success is worse than no
    // probe at all.
    let existingIndexes = new Set();
    try {
      const rows = await qi.showIndex(TABLE);
      existingIndexes = new Set(rows.map((r) => r.name));
    } catch { /* treated as "none", and the attempt below decides */ }

    if (existingIndexes.has(INDEX)) {
      result.index = true;
    } else {
      try {
        await connector.query(`CREATE INDEX ${q(INDEX)} ON ${q(TABLE)} (${q('id')})`);
        result.index = true;
      } catch (err) {
        result.errors.index = err.message;
      }
    }

    let existingColumns = new Set();
    try {
      const desc = await qi.describeTable(TABLE);
      existingColumns = new Set(Object.keys(desc || {}).map((c) => c.toLowerCase()));
    } catch { /* same */ }

    if (existingColumns.has(COLUMN.toLowerCase())) {
      result.alter = true;
    } else {
      try {
        await qi.addColumn(TABLE, COLUMN, { type: DataTypes.INTEGER, allowNull: true });
        result.alter = true;
      } catch (err) {
        result.errors.alter = err.message;
      }
    }

    // Probed last on purpose: a successful DROP is also the cleanup.
    try {
      await qi.dropTable(TABLE);
      result.drop = true;
    } catch (err) {
      result.errors.drop = err.message;
      this.verboseLogger(
        2,
        `[DB] DDL probe left ${TABLE} in place — this user cannot DROP. The table is empty and is re-used by the next probe.`
      );
    }

    this.verboseLogger(
      3,
      `[DB] DDL grants on ${result.dialect}: create=${result.create} index=${result.index} alter=${result.alter} drop=${result.drop}`
    );
    this._ddlGrants = result;
    return result;
  }

  /**
   * The model whose table is `tableName`, or null.
   *
   * getModel() alone is not enough: model names and table names diverge for
   * nine models in this repo (`S3GameState` → `S3_GameState`), and production
   * MySQL runs with `lower_case_table_names=1`, so the comparison is
   * case-insensitive as well.
   */
  getModelForTable(tableName) {
    const direct = this.getModel(tableName);
    if (direct?.rawAttributes) return direct;
    const wanted = String(tableName).toLowerCase();
    for (const name of this.getModelNames()) {
      const model = this.getModel(name);
      const table = model?.tableName || model?.name;
      if (table && String(table).toLowerCase() === wanted) return model;
    }
    return null;
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

    for (const value of Object.values(this.connectors)) {
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