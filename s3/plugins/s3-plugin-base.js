/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          S³ PLUGIN BASE CLASS                                 ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Extends SquadJS BasePlugin with S³ service discovery, readiness
 * gating, database boilerplate (model definition, migration
 * registration/execution, transactional DB access), flat service
 * accessors, and a standardised _requestTeamChange() retry/verify
 * method. Consumer plugins that need S³ services or DB-backed
 * schemas extend this class instead of BasePlugin directly,
 * eliminating ~50 lines of repetitive mount() logic.
 *
 * ─── LIFECYCLE ───────────────────────────────────────────────────
 *
 *   prepareToMount()  → calls super.prepareToMount(), then _resolveS3()
 *                        to discover S³ at runtime.
 *   mount()           → calls super.mount(), awaits this._s3.ready(),
 *                        caches _s3db reference, then calls _onS3Ready().
 *   unmount()         → calls super.unmount(), clears _s3db, then
 *                        calls _onUnmount().
 *
 * Subclasses override _onS3Ready() and _onUnmount() instead of
 * mount()/unmount() to ensure S³ lifecycle management is handled.
 *
 * ─── DB CONVENIENCE ──────────────────────────────────────────────
 *
 *   defineModel(name, schema, opts)
 *   registerExpectedVersion(pluginName, version)
 *   registerMigrations(pluginName, migrations)
 *   verifyAndRunMigrations(pluginName)
 *   _getModel(name)
 *   _withDb(fn)
 *
 * ─── COMMUNITY-AFFECTING OPTIONS ─────────────────────────────────
 *
 *   recordCommunityOptions(values)      — post-validation, at mount
 *   resolvedCommunityOption(g, k, dflt) — the community value, read sync
 *   strictestCommunityOption(g, k, dflt)— the strictest registered value
 *   communityOptionRefusal(group)       — a reason string, or null
 *
 * Writes and reads want different tools here. A write that would apply
 * one server's value to every server's rows should decline while the
 * registry disagrees, which is communityOptionRefusal(). A read has to
 * answer something, and answering out of this.options makes the same
 * command in the same channel return a different list depending on
 * which process replied, which is what strictestCommunityOption() is
 * for.
 *
 * ─── SERVICE ACCESSORS ───────────────────────────────────────────
 *
 *   get s3()          → this._s3 reference
 *   get s3db()        → this._s3.db reference (cached in mount)
 *   get gameState()   → this._s3?.gameState
 *   get players()     → this._s3?.players
 *   get clans()       → this._s3?.clans
 *   get factions()    → this._s3?.factions
 *   get serverConfig()→ this._s3?.serverConfig
 *   get serverID()    → this._s3?.serverID, or null before discovery
 *
 * ─── DISCORD ROUTING ─────────────────────────────────────────────
 *
 *   routeDiscordCommand(opts)      — which server answers, and with what
 *   buildRoutingRefusalEmbed(v)    — the embed for a refusing verdict
 *
 * ─── SERVER IDENTITY ─────────────────────────────────────────────
 *
 *   get requiresServerIdentity() → true by default. A plugin that writes
 *     only community-wide rows can override it to false and keep mounting
 *     while S³ is refusing a contested server id.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - S³ discovery uses the constructor-name lookup pattern
 *   (this.server.plugins.find) matching all existing consumers.
 * - Database methods are inert if no S³ DB service is available —
 *   DB-free plugins can ignore them.
 * - All service accessors return null before S³ is discovered.
 * - This class does NOT define optionsSpecification — subclasses
 *   are free to define their own without composition concerns.
 * - This class does NOT provide Discord functionality; see
 *   S3DiscordPluginBase (s3-discord-plugin-base.js) for that.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * BasePlugin (squad-server/plugins/base-plugin.js)
 *   SquadJS core: server, options, connectors, verbose().
 *
 * SlackersSquadServices (slackers-squad-services.js)
 *   The S³ service container discovered at runtime. Must appear
 *   before this plugin in config.json so mount ordering works.
 * ─────────────────────────────────────────────────────────────────
 */

import BasePlugin from './base-plugin.js';
import { stderrError } from '../utils/s3-stderr.js';
import { versionAtLeast } from '../utils/s3-common.js';
import { enforcedDisagreement, describeDisagreement } from '../utils/community-options.js';
import {
  localize as lookupMessage,
  isSupportedLanguage,
  supportedLanguages,
  DEFAULT_LANGUAGE
} from '../utils/s3-i18n.js';
import {
  routeDiscordCommand as routeCommand,
  buildRoutingRefusalEmbed as buildRefusalEmbed
} from '../utils/s3-discord-routing.js';
import {
  applyServerLabel as labelPayload,
  readServerLabel,
  SERVER_TITLE_SEPARATOR
} from '../utils/s3-server-label.js';
import { PendingActions, PENDING } from '../utils/s3-pending-actions.js';

/**
 * How long a process with no matching token waits before claiming the
 * right to say so. Long enough for the process that does hold it to have
 * claimed first, short enough that a mistyped token is answered while the
 * admin is still looking at the channel.
 */
const CONFIRM_REJECT_GRACE_MS = 2000;
import { readLiveContext, renderLiveContext, CONTEXT } from '../utils/s3-live-context.js';

// Module-scope, not per-instance: SmartAssign, Switch and TeamBalancer each
// extend this class and would otherwise each print their own copy of the
// same discovery the first time any of them hits it.
let eosRejectionWarned = false;

// Same reasoning, per language code: an operator who typos one language in
// config should see one warning, not one per plugin extending this class.
const languageWarned = new Set();

export default class S3PluginBase extends BasePlugin {
  constructor(server, options, connectors) {
    super(server, options, connectors);
    this._s3 = null;
    this._s3db = null;
    // Two-step admin commands live here rather than in a field per command.
    // Built eagerly because arming must not be the thing that discovers the
    // store is missing — that is the path this exists to make reliable.
    this._pending = new PendingActions();
  }

  /**
   * The language this plugin renders messages in.
   *
   * Read from S³, never from this plugin's own options. Language is a
   * server-wide property: an operator running a Portuguese server wants the
   * whole suite in Portuguese, and there is no coherent deployment where
   * EloTracker speaks English while Switch speaks Portuguese.
   *
   * A per-plugin override was considered and dropped. The case for one is
   * always a per-SURFACE split — English Discord embeds over a Portuguese
   * server, say — and a per-plugin option cannot express that, because Switch
   * and TeamBalancer each write to both RCON and Discord from a single value.
   * Wrong granularity for the only use it would have had, so consumer plugins
   * deliberately do not declare a `language` option at all. test-i18n.js
   * asserts they still don't.
   *
   * Read off S³ directly rather than through a mounted service: `_s3` is set
   * during prepareToMount(), earlier than any service becomes available, so
   * this resolves sooner. It is still null before discovery, so anything
   * emitted during early mount is English regardless of config — accepted
   * rather than worked around, since one of those strings is the "S³ not
   * available" error itself.
   */
  get lang() {
    return this._s3?.lang || DEFAULT_LANGUAGE;
  }

  /**
   * The id S³ stamps onto server-scoped rows, or null before S³ is discovered.
   *
   * Null rather than a default, deliberately: a consumer that writes rows keyed
   * by this before discovery would be writing them under an identity S³ has not
   * agreed to, and a wrong id is worse than a missing one because it silently
   * claims another server's rows. Callers on a write path should treat null as
   * "not ready yet", the same way they already treat a null service.
   */
  get serverID() {
    return this._s3?.serverID ?? null;
  }

  /**
   * Whether this plugin's rows are keyed by the server id.
   *
   * True by default, because that is what a consumer of this base class
   * normally is, and the safe answer to "does this write server-scoped data?"
   * is yes — a plugin that gets it wrong in this direction refuses to mount
   * during an incident, and one that gets it wrong the other way writes into
   * another community's rows.
   *
   * Override to false only for a plugin whose every model declares
   * `scopeKind: 'global'`.
   */
  get requiresServerIdentity() {
    return true;
  }

  /**
   * Resolves a message key to a formatted string in this plugin's language.
   * Never throws; an unknown key returns the key itself.
   *
   * @param {string} key - Dotted key path (e.g. 'switch.discord.scrambleEmbedTitle')
   * @param {object} [vars={}] - Placeholder values (e.g. { count: 12, minutes: 20 })
   * @returns {string} Formatted localized string
   */
  localize(key, vars = {}) {
    return lookupMessage(key, vars, this.lang);
  }

  // ═══════════════════════════════════════════════════════════════
  //  S³ DISCOVERY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Discovers the S³ plugin at runtime by constructor name.
   * Throws if SlackersSquadServices is not found — S³ is required
   * for any plugin using this base class.
   * @returns {object} The S³ plugin instance.
   */
  _resolveS3() {
    if (!this.server.plugins) {
      throw new Error(
        this.localize('s3PluginBase.errors.pluginsNotAvailable', {})
      );
    }
    const s3 = this.server.plugins.find(
      (p) => p.constructor.name === 'SlackersSquadServices'
    );
    if (!s3) {
      throw new Error(
        this.localize('s3PluginBase.errors.servicesRequired', {})
      );
    }
    this._s3 = s3;

    // First point at which the inherited language is knowable. Warn rather
    // than throw: a typo'd language code degrades to English and must not
    // stop a server booting. Deliberately not localized — the one message
    // that says the language system is misconfigured has to render in a
    // language we know is present.
    const configured = s3?.lang;
    if (configured && !isSupportedLanguage(configured) && !languageWarned.has(configured)) {
      languageWarned.add(configured);
      this.verbose(
        1,
        `[S3] Unknown language "${configured}" — falling back to "${DEFAULT_LANGUAGE}". ` +
        `Available: ${supportedLanguages().join(', ')}.`
      );
    }

    this.verbose(2, '[S3] Discovered SlackersSquadServices.');
    return s3;
  }

  /**
   * True when the discovered S³ is at or above `required`.
   *
   * Consumers gate mounting on this. See utils/s3-common.js for why the
   * comparison is numeric rather than the string `<` it replaced.
   *
   * @param {string} required - Minimum acceptable S³ version, e.g. '1.4.0'.
   * @returns {boolean}
   */
  _s3VersionAtLeast(required) {
    return versionAtLeast(this._s3?.version, required);
  }

  /**
   * Waits for S³ to be fully ready, with an optional timeout.
   *
   * Checks isReady() first; if not ready, awaits this._s3.ready().
   * Falls back to polling isReady() as a safety net.
   *
   * @param {number} timeoutMs - Max time to wait (default 30000).
   * @returns {Promise<boolean>} True if S³ is ready.
   * @throws {Error} If S³ was never discovered, or if readiness
   *   is not achieved within the timeout.
   */
  async _awaitS3Ready(timeoutMs = 30000) {
    if (!this._s3) {
      throw new Error(
        this.localize('s3PluginBase.errors.notDiscovered', {})
      );
    }

    // Fast path — already ready
    if (typeof this._s3.isReady === 'function' && this._s3.isReady()) {
      return true;
    }

    // Primary path — await the deferred ready promise
    if (typeof this._s3.ready === 'function') {
      try {
        await this._s3.ready();
        return true;
      } catch (err) {
        this.verbose(1, `[S3] ready() promise rejected: ${err.message}`);
      }
    }

    // Fallback — poll isReady() with timeout
    const pollInterval = 100;
    const maxAttempts = Math.ceil(timeoutMs / pollInterval);
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (typeof this._s3.isReady === 'function' && this._s3.isReady()) {
        return true;
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(
      this.localize('s3PluginBase.errors.readyTimeout', { timeoutMs })
    );
  }

  // ═══════════════════════════════════════════════════════════════
  //  LIFECYCLE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Prepares the plugin by discovering S³.
   * Subclasses that override this MUST call super.prepareToMount()
   * to ensure S³ is discovered before mount().
   */
  async prepareToMount() {
    await super.prepareToMount();
    this._resolveS3();
  }

  /**
   * Mounts the plugin: awaits S³ readiness, caches the DB reference,
   * then delegates to the subclass _onS3Ready() hook.
   *
   * Subclasses should NOT override mount() directly — use _onS3Ready()
   * and _onUnmount() instead.
   */
  async mount() {
    await super.mount();
    if (this._s3) {
      await this._s3.ready();

      // S³ found another live process claiming this server id. Every row this
      // plugin would write is keyed by that id, so mounting means adding to
      // somebody else's data — which is the failure the check exists to stop,
      // not a degraded mode to run in. S³ itself stays up; only the plugins
      // that write under the contested identity refuse.
      const blocked = this._s3.serverIdentityBlocked;
      if (blocked && this.requiresServerIdentity) {
        const err = new Error(
          `[${this.constructor.name}] refusing to mount: ${blocked}. ` +
          'Give each install its own overrideServerID, or set forceServerClaim on S³ if this is a ' +
          'port change rather than a second server.'
        );
        this.verbose(1, err.message);
        throw err;
      }

      this._s3db = this._s3.db || null;
      this.verbose(2, `[S3] S³ is ready. DB available: ${!!this._s3db}`);
    } else {
      this.verbose(1, '[S3] S³ not discovered before mount() — _onS3Ready will run without S³.');
    }
    await this._onS3Ready();
  }

  /**
   * Unmounts the plugin: clears cached S³ DB reference, then
   * delegates to the subclass _onUnmount() hook.
   *
   * NOTE: unmount() is defined here for correctness, but as of SquadJS v4.2.0 RC1
   * and earlier, the framework never calls plugin.unmount(). This method is kept
   * for future-proofing — if SquadJS ever implements dynamic mount/unmount,
   * cleanup will work correctly.
   */
  async unmount() {
    await super.unmount();
    await this._onUnmount();
    this._s3db = null;
  }

  /**
   * Subclass hook — called after S³ is fully ready.
   *
   * Override this instead of mount(). At this point:
   *   - this._s3 is the S³ plugin reference
   *   - this._s3db is S³'s DBService (or null if no DB)
   *   - Service accessors (gameState, players, etc.) are usable
   *
   * Default implementation is a no-op.
   */
  async _onS3Ready() {
    // Override in subclass
  }

  /**
   * Subclass hook — called during unmount.
   *
   * Override this instead of unmount(). At this point S³ services
   * are still available if needed for cleanup.
   *
   * Default implementation is a no-op.
   */
  async _onUnmount() {
    // Override in subclass
  }

  // ═══════════════════════════════════════════════════════════════
  //  DATABASE CONVENIENCE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Defines a Sequelize model on the S³ connector.
   * Safe to call even when S³ or DB is not available (returns null).
   *
   * @param {string} name - Model name.
   * @param {object} schema - Column definitions.
   * @param {object} [opts={}] - Model options (tableName, timestamps, etc.).
   * @returns {object|null} The defined model, or null.
   */
  defineModel(name, schema, opts = {}) {
    if (!this._s3db || typeof this._s3db.isReady !== 'function' || !this._s3db.isReady()) {
      return null;
    }
    return this._s3db.defineModel(name, schema, opts);
  }

  /**
   * Registers an expected schema version for this plugin, along with
   * optional model names owned by the plugin (used by drift detection).
   *
   * IMPORTANT: The 3rd argument (options) MUST be forwarded to the S³ DB
   * service — consumer plugins pass { models: ['MyModel', ...] } in this
   * argument. Without it, verifyLiveSchema() cannot find or verify the
   * plugin's tables, and drift detection silently skips them.
   *
   * @param {string} pluginName - Namespace (e.g. 'elo-tracker').
   * @param {number} version - Expected schema version number.
   * @param {{ models?: string[] }} [options] - Optional model names owned by
   *   this plugin, forwarded to DBService for drift detection.
   */
  registerExpectedVersion(pluginName, version, options) {
    if (!this._s3db || typeof this._s3db.registerExpectedVersion !== 'function') {
      return;
    }
    this._s3db.registerExpectedVersion(pluginName, version, options);
    // Log model registrations at level 3 so admins can confirm drift
    // detection coverage during troubleshooting.
    if (options && Array.isArray(options.models) && options.models.length > 0) {
      this.verbose(3, `[${pluginName}] Registered ${options.models.length} model(s) for drift detection: ${options.models.join(', ')}`);
    }
  }

  /**
   * Registers an ordered set of migration functions for this plugin.
   *
   * @param {string} pluginName - Namespace matching registerExpectedVersion.
   * @param {Array<{version: number, description: string, up: Function, down: Function}>} migrations
   */
  registerMigrations(pluginName, migrations) {
    if (!this._s3db || !this._s3db.migrationEngine) {
      return;
    }
    this._s3db.migrationEngine.registerMigrations(pluginName, migrations);
  }

  /**
   * Verifies schema versions and runs any pending migrations.
   *
   * **`null` is ambiguous by design and must not be read as "up to date".** It is
   * returned for three different outcomes:
   *   - the DB service is unavailable;
   *   - migrations are pending but unconfirmed (this method logs that itself, and
   *     S³ posts the Discord prompt);
   *   - the schema is already current.
   * A caller that prints "already up to date" on null will contradict the
   * pending-but-unconfirmed line logged moments earlier. If you need to tell the
   * cases apart, ask `s3db.verifySchemaVersions()` rather than inferring.
   *
   * @param {string} pluginName - Namespace to migrate.
   * @returns {Promise<{applied: number, skipped: number}|null>} Result when
   *   migrations actually ran; otherwise null — see above.
   */
  async verifyAndRunMigrations(pluginName) {
    if (!this._s3db || typeof this._s3db.isReady !== 'function' || !this._s3db.isReady()) {
      return null;
    }
    const recheck = await this._s3db.verifySchemaVersions();
    if (!recheck.upToDate) {
      const me = this._s3db.migrationEngine;
      if (me && !me._confirmed) {
        this.verbose(1, `[${pluginName}] Migrations pending but not confirmed. Use !s3 confirm <token> or set autoMigrate: true in S³ config.`);
        // Trigger the Discord prompt via S³'s debounced scheduler.
        // Multiple consumer plugins may call this in rapid succession during
        // initialisation — the scheduler debounces to avoid duplicate embeds.
        if (this._s3 && typeof this._s3._scheduleMigrationPrompt === 'function') {
          this._s3._scheduleMigrationPrompt();
        }
        return null;
      }
      const result = await (me ? me.runMigrations(pluginName) : null);
      return result;
    }
    // Schema versions are up to date — still re-schedule the migration prompt
    // so _checkAndPromptMigrations() fires the drift check (verifyLiveSchema())
    // after all consumer plugins have registered their models. The initial
    // verifyLiveSchema() during db.mount() ran before any models were registered,
    // so it could not detect drift. This re-schedule ensures the drift check runs
    // after the last consumer registers, catching silently-failed prior migrations.
    //
    // Debounce effect: Each consumer plugin that calls this resets the 500ms
    // debounce timer via _scheduleMigrationPrompt(), so _checkAndPromptMigrations()
    // only fires after the LAST consumer finishes registering its expected versions
    // and models. Typically 4 consumers (Switch, EloTracker, SmartAssign, TeamBalancer)
    // plus the initial S³ mount call, resulting in 5 resets on a normal boot.
    if (this._s3 && typeof this._s3._scheduleMigrationPrompt === 'function') {
      this._s3._scheduleMigrationPrompt();
    }
    return null;
  }

  /**
   * Returns a cached model by name from the S³ connector.
   *
   * @param {string} name - Model name (e.g. 'Elo_PlayerStats').
   * @returns {object|null} The Sequelize model, or null.
   */
  _getModel(name) {
    return this._s3db?.models?.[name] || null;
  }

  /**
   * Executes a function inside a transactional, retry-safe database
   * context. Returns null if the DB is not ready.
   *
   * @param {Function} fn - Async function receiving a transaction.
   * @returns {Promise<*|null>} The function's return value, or null.
   */
  async _withDb(fn) {
    if (!this._s3db || typeof this._s3db.isReady !== 'function' || !this._s3db.isReady()) {
      return null;
    }
    try {
      return await this._s3db.withTransactionWithRetry(fn);
    } catch (err) {
      this.reportError('DB', `Error in _withDb: ${err.message}`, err);
      return null;
    }
  }

  /**
   * Log a caught error at verbose level 1, and — when the operator has opted in
   * via S³'s `stderrDiagnostics` option — also mirror it to stderr so it lands in
   * `2>` redirection alongside migration failures. The default is 'off', so on a
   * stock install this behaves exactly like the `verbose(1, ...)` call it replaced.
   *
   * Use this for errors an operator would want to find after the fact —
   * a swallowed exception in an event handler, a failed DB write. Do not use
   * it for expected conditions or retry-and-recover paths; those belong at
   * verbose level 2+ and would only add noise to the error file.
   *
   * The stderr side deduplicates identical events, so a per-tick failure
   * (a DB outage, say) writes once and then a suppressed count rather than
   * thousands of blocks. The verbose line is unaffected — the main log keeps
   * every occurrence, in sequence.
   *
   * @param {string} scope - Short subsystem tag, e.g. 'DB' or 'Commands'
   * @param {string} summary - One-line description; also the stdout message
   * @param {Error} [err] - The error, if available; its stack goes to stderr
   * @param {object} [options]
   * @param {boolean} [options.includeStackInLog=false] - Also append the stack to
   *   the stdout line. Set at call sites that logged the stack before this
   *   helper existed, so nothing an operator reading only stdout used to see
   *   disappears. Leave false for per-tick paths, where a stack every tick in
   *   the main log is what made the error file necessary in the first place.
   */
  reportError(scope, summary, err = null, { includeStackInLog = false } = {}) {
    const stackSuffix = includeStackInLog && err?.stack ? `\n${err.stack}` : '';
    this.verbose(1, `[${scope}] ${summary}${stackSuffix}`);
    stderrError(`${this.constructor.name || 'S3Plugin'}:${scope}`, summary, err);
  }

  // ═══════════════════════════════════════════════════════════════
  //  COMMUNITY-AFFECTING OPTIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Record this plugin's community-affecting option values onto the server's
   * registry row.
   *
   * Call it **after** the plugin's own clamping, not before. Switch forces a
   * non-positive `maxSwitchTokens` to 1 at mount; recording the raw config
   * value would report two agreeing servers as divergent and two divergent
   * ones as agreeing.
   *
   * @param {object} values - `{optionKey: number}`
   * @returns {Promise<boolean>}
   */
  async recordCommunityOptions(values) {
    if (!this._s3db || typeof this._s3db.recordCommunityOptions !== 'function') return false;
    return await this._s3db.recordCommunityOptions(this.constructor.name || 'plugin', values);
  }

  /**
   * The community value for one option, or `fallback` when none is in force.
   *
   * Synchronous on purpose: the reads this exists for happen inside a token
   * balance computation on the switch path, which cannot await a query. The
   * cache behind it is refreshed on every heartbeat, so the worst case is a
   * value that was correct one round ago.
   *
   * A missing resolution means “no community value”, not zero — a community of
   * one, or a boot before the registry has been read — and the caller's own
   * configured option is the right answer in both.
   *
   * @param {string} group - A `COMMUNITY_OPTION_GROUPS` name
   * @param {string} key - One of that group's keys
   * @param {*} fallback - Usually `this.options[key]`
   */
  resolvedCommunityOption(group, key, fallback) {
    const resolved = this._s3db?.communityOptions?.resolved?.[group];
    const value = resolved?.values?.[key];
    return value === undefined ? fallback : value;
  }

  /**
   * The strictest value the registered servers hold for a must-agree option.
   *
   * For the reads, where `communityOptionRefusal()` is the wrong tool. A
   * write that would apply one server's value to everybody's rows should
   * decline; a read has to answer, and answering out of `this.options`
   * makes the same command in the same channel return a different list
   * depending on which process happened to win the claim — a wrong answer
   * with nothing visibly wrong about it.
   *
   * So: the highest candidate across the registry, which for a threshold is
   * the strictest. Two properties make that the right tie-break rather than
   * merely a deterministic one. It is the same number on every process, so
   * the answer stops depending on the election. And it never shows a player
   * a placement that one of the community's own servers would consider
   * unearned — erring toward the server that asked for more evidence.
   *
   * When the servers agree there is no disagreement entry to read, and this
   * process's own configured value IS the community value, so the fallback
   * is exact rather than approximate. Same on a single-server install, and
   * same before the registry has been read once.
   *
   * @param {string} group - A `COMMUNITY_OPTION_GROUPS` name
   * @param {string} key - One of that group's keys
   * @param {number} fallback - Usually `this.options[key]`
   * @returns {number}
   */
  strictestCommunityOption(group, key, fallback) {
    const entry = (this._s3db?.communityOptions?.disagreements || [])
      .find((d) => d.name === group);
    if (!entry) return fallback;

    const values = (entry.values || [])
      .map((candidate) => candidate?.values?.[key])
      .filter((v) => typeof v === 'number' && Number.isFinite(v));
    return values.length === 0 ? fallback : Math.max(...values);
  }

  /**
   * Why a community-wide write must decline right now, or null.
   *
   * Only ever non-null for a must-agree option. A may-differ one never comes
   * back from here, so naming the wrong option cannot accidentally start
   * enforcing agreement on something two admins are entitled to disagree about.
   *
   * @param {string} group - A `COMMUNITY_OPTION_GROUPS` name
   * @returns {string|null} A reason, phrased for a log line or a Discord reply
   */
  communityOptionRefusal(group) {
    const entry = enforcedDisagreement(this._s3db?.communityOptions, group);
    if (!entry) return null;
    return `the registered servers disagree on ${describeDisagreement(entry)}, and this write would apply ` +
      'one of those values to every server’s rows';
  }

  // ═══════════════════════════════════════════════════════════════
  //  SERVICE ACCESSORS
  // ═══════════════════════════════════════════════════════════════

  /** @returns {object|null} The S³ plugin reference. */
  get s3() { return this._s3; }

  /** @returns {object|null} S³'s DBService instance. */
  get s3db() { return this._s3db; }

  /** @returns {object|null} S³ game state service (round phase, matchId, etc.). */
  get gameState() { return this._s3?.gameState || null; }

  /** @returns {object|null} S³ player tracking service. */
  get players() { return this._s3?.players || null; }

  /** @returns {object|null} S³ clan tag resolution service. */
  get clans() { return this._s3?.clans || null; }

  /** @returns {object|null} S³ faction/team resolution service. */
  get factions() { return this._s3?.factions || null; }

  /** @returns {object|null} S³ server configuration service. */
  get serverConfig() { return this._s3?.serverConfig || null; }

  // ═══════════════════════════════════════════════════════════════
  //  DISCORD ROUTING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Decides whether THIS process should answer a Discord command.
   *
   * Every plugin in the suite shares one Discord server, so on a two-server
   * install every process sees every command and, without this, every
   * process answers it. The gate parses and strips a `--server` selector,
   * and returns one of three verdicts: act on it, drop it silently because
   * another server owns it, or refuse it because the operator has to say
   * which server they meant. See `s3/utils/s3-discord-routing.js`.
   *
   * **It lives on this class rather than being imported at the call site**
   * because the install flattens `s3/utils/` and `<plugin>/utils/` into one
   * directory: no import specifier written in a consumer plugin resolves
   * both in this repository and at the target. This class does not have
   * that problem — `s3/plugins/` and the flattened `plugins/` sit the same
   * distance from `utils/` — so the consumers reach the gate through here.
   *
   * On a single-server install (nothing registered, or one row) every call
   * returns `act` with the arguments untouched, and no lock is taken.
   *
   * @param {object} opts
   * @param {string} opts.scope - A `COMMAND_SCOPE` value
   * @param {string[]} opts.args - The raw argument list, selector included
   * @param {string} opts.messageID - The Discord message snowflake
   * @param {string} [opts.command] - The command, for the refusal text
   * @param {boolean} [opts.selectorRequired] - Refuse a bare server read
   *        rather than broadcasting it. For the replies too large to arrive
   *        once per server.
   * @returns {Promise<{routing: string, args: string[], reason?: string,
   *          candidates?: Array, token?: string, command?: string}>}
   */
  async routeDiscordCommand({ scope, args, messageID, command, selectorRequired = false } = {}) {
    return routeCommand({
      db: this._s3db,
      scope,
      args,
      messageID,
      command,
      selectorRequired,
      verbose: (level, msg) => this.verbose(level, msg)
    });
  }

  /**
   * Renders a refusing verdict from `routeDiscordCommand()` as an embed.
   *
   * Localized through this plugin's own `localize()`, so the refusal comes
   * back in the same language as everything else the plugin says.
   *
   * @param {object} verdict - A verdict whose `routing` is `refuse`
   * @returns {object} A Discord embed object
   */
  buildRoutingRefusalEmbed(verdict) {
    return buildRefusalEmbed(verdict, (key, vars) => this.localize(key, vars));
  }

  /**
   * Appends this server's label to every embed in a Discord payload.
   *
   * A no-op until S³ publishes a label, and on a single-server install it
   * never does — so this is safe to call unconditionally, and the sender
   * that calls it needs no knowledge of the registry.
   *
   * It exists on the base class because of where the module lives. EloTracker
   * and TeamBalancer send through their own helper objects, in their own
   * `utils/` directories, and no import specifier from there resolves both in
   * this repository and in the flattened layout install.cjs produces. This
   * class is in `s3/plugins/`, which reaches `../utils/` in both, so those
   * plugins hand the function to their sender from here instead:
   *
   *   EloDiscord.applyServerLabel = (payload) => this.applyServerLabel(payload);
   *
   * @param {object} payload - { embeds: [...] } or { embed: {...} }
   * @returns {object} The payload, labelled if there is a label
   */
  applyServerLabel(payload) {
    return labelPayload(payload);
  }

  // ═══════════════════════════════════════════════════════════════
  //  TWO-STEP CONFIRMATIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * This server, as a fragment safe to put in a filename.
   *
   * Two commands answer with a file rather than an embed, so there is no
   * footer to label and the filename is the only place the answer can say
   * where it came from. Empty on a single-server install, where the files
   * keep the names they have always had.
   *
   * Whether the tag describes the file's SCOPE or merely its author
   * depends on the command: a switches export holds one server's rows, an
   * Elo backup holds the whole community's ratings and the tag says only
   * which process produced it. Both are worth saying — two files in one
   * channel's scrollback are otherwise told apart by their timestamps.
   *
   * @returns {string} `-<slug>`, or '' when there is nothing to say
   */
  serverFileTag() {
    const server = this.serverDescriptor();
    if (!server) return '';
    const slug = String(server)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24)
      .replace(/-+$/, '');
    return slug === '' ? '' : `-${slug}`;
  }

  /**
   * Whether this community has more than one registered server.
   *
   * The same cached count the routing gate reads, refreshed on the
   * registry heartbeat. Every multi-server behaviour hangs off this: at one
   * registered server nothing arms differently, no token is minted and no
   * title changes, which is the zero-delta guarantee stated as a branch
   * rather than hoped for across a dozen call sites.
   *
   * @returns {boolean}
   */
  isMultiServer() {
    const count = this._s3db?.getKnownServerCount?.();
    return Number.isFinite(count) && count > 1;
  }

  /**
   * How to name this server to an admin: the label, else the alias, else
   * `#<id>`. Null when there is only one server to talk about.
   *
   * @returns {string|null}
   */
  serverDescriptor() {
    if (!this.isMultiServer()) return null;
    const label = readServerLabel();
    if (label) return label;
    const id = this._s3db?.getServerID?.();
    return Number.isFinite(id) ? `#${id}` : null;
  }

  /**
   * Put the server in an embed title, where a mutation cannot be misread.
   *
   * The author line every embed gets (§ the label module) is right for a
   * read and still too quiet for a scramble: a reply confirming that
   * something was DONE to a live game has to name the game in the same
   * type size as the thing that was done. A no-op on a single-server
   * install.
   *
   * A title built here suppresses the author line rather than stacking
   * under it — `labelOne()` recognises this exact shape, which is why the
   * separator is imported rather than written out again.
   *
   * @param {string} title
   * @returns {string}
   */
  titleWithServer(title) {
    const server = this.serverDescriptor();
    const text = typeof title === 'string' ? title : '';
    if (!server) return text;
    // Server first. A title is truncated from the right by Discord and by
    // every narrow client, and the half that must survive is which server.
    return text === '' ? server : `${server}${SERVER_TITLE_SEPARATOR}${text}`;
  }

  /**
   * Arm a two-step action, and describe what is about to happen to it.
   *
   * ─── THE SINGLE-SERVER PATH IS THE OLD ONE ───
   *
   * At one registered server this arms and returns no token and no prompt
   * lines, so the caller prints exactly the prompt it printed before and
   * the admin types exactly the bare `confirm` they typed before.
   *
   * ─── AND THE MULTI-SERVER PATH REFUSES RATHER THAN GUESSES ───
   *
   * A prompt that cannot say what it is about to change is not a
   * confirmation. When the live context cannot be read the action is not
   * armed at all and `refusal` explains why, rather than falling through
   * to a token that confirms nothing in particular.
   *
   * @param {object} opts
   * @param {string} opts.kind - Action family, e.g. 'scramble'
   * @param {*} opts.payload - What the confirm path needs to execute
   * @param {string} opts.command - What the admin types to confirm
   * @param {number} [opts.ttlMs] - Deadline for this arm
   * @param {string} [opts.radius='server'] - 'server' confirms against this
   *        server's live game; 'community' says how many servers share the
   *        data instead, because that is what the command touches
   * @returns {{armed: boolean, token: string|null, lines: string[], refusal: string|null}}
   */
  armConfirmation({ kind, payload, command = '', ttlMs, radius = 'server' } = {}) {
    const server = this.serverDescriptor();

    if (!server) {
      this._pending.arm(kind, payload, { ttlMs });
      return { armed: true, token: null, lines: [], refusal: null };
    }

    let opening;

    if (radius === 'community') {
      // A community mutation is not confirmed against one server's live
      // game, because that is not what it touches. Naming the radius is
      // the honest opening line, and a round state nobody is about to
      // change would reassure against the wrong thing entirely.
      const count = this._s3db?.getKnownServerCount?.();
      opening = this.localize('s3Confirm.targetCommunity', {
        count: Number.isFinite(count) ? String(count) : '?',
        server
      });
    } else {
      const context = readLiveContext(this._s3);
      if (context.status !== CONTEXT.OK) {
        return {
          armed: false,
          token: null,
          lines: [],
          refusal: this.localize('s3Confirm.contextUnavailable', { server })
        };
      }
      opening = this.localize('s3Confirm.target', {
        server,
        context: renderLiveContext(context, (key, vars) => this.localize(key, vars))
      });
    }

    const { token, ttlMs: life } = this._pending.arm(kind, payload, { ttlMs });
    return {
      armed: true,
      token,
      lines: [
        opening,
        this.localize('s3Confirm.token', { command, token }),
        this.localize('s3Confirm.expires', { seconds: String(Math.round(life / 1000)) })
      ],
      refusal: null
    };
  }

  /**
   * Take an armed action back out, by token where there is one.
   *
   * A bare confirm with no token is the single-server path and the in-game
   * path — the latter arrives over this server's own RCON, so the process
   * that armed it is the only one that can be reading it, and a token
   * would be ceremony with nothing to disambiguate.
   *
   * @param {string} kind
   * @param {string|null} [token]
   * @returns {{status: string, payload?: *}}
   */
  takeConfirmation(kind, token = null) {
    const key = typeof token === 'string' ? token.trim() : '';
    if (key === '') return this._pending.takeNewest(kind);
    return this._pending.take(key, kind);
  }

  /**
   * Declare which Discord channel this server uses for a named purpose.
   *
   * @param {string} name
   * @param {string|null} channelID
   * @returns {Promise<boolean>}
   */
  async recordChannelBinding(name, channelID) {
    if (typeof this._s3db?.recordChannelBinding !== 'function') return false;
    return await this._s3db.recordChannelBinding(name, channelID);
  }

  /**
   * The other registered servers pointing the same named channel at the
   * same id. Empty on a single-server install, which is what makes every
   * shared-channel guard inert there.
   *
   * @param {string} name
   * @param {string|null} channelID
   * @returns {Promise<Array<{serverID: number, alias: string|null}>>}
   */
  async channelSharers(name, channelID) {
    if (typeof this._s3db?.getChannelSharers !== 'function') return [];
    return await this._s3db.getChannelSharers(name, channelID);
  }

  /** Drop every armed action of a kind. What a `cancel` verb does. */
  cancelConfirmations(kind) {
    return this._pending.cancel(kind);
  }

  /** Whether anything of this kind is armed and still inside its window. */
  hasConfirmation(kind) {
    return this._pending.has(kind);
  }

  /** The reasons `takeConfirmation()` can fail, for a caller's switch. */
  get PENDING() {
    return PENDING;
  }

  /**
   * Whether this process is the one that replies to a token confirm.
   *
   * ─── WHY A TOKEN CONFIRM IS THE ONE COMMAND WITH NO ELECTION ───
   *
   * Every other command is handed to an arbitrary process by the claim,
   * and for a token confirm that is exactly wrong: the arbitrary winner
   * would reject a token it never minted while the process actually
   * holding the armed action never sees the message. So the gate lets
   * every process inspect one, and the token itself decides — an election
   * settled at arm time rather than at reply time, and a stricter one,
   * because it picks the correct process rather than any process.
   *
   * ─── WHICH LEAVES A TOKEN NOBODY HOLDS ───
   *
   * Mistyped, expired, or armed on a process that has since restarted.
   * Every process rejects it, so without something here the admin gets
   * either silence or one copy of the rejection per server. The claim is
   * what makes it exactly one.
   *
   * ─── AND WHY THE REJECTION WAITS ───
   *
   * A rejecting process has no work to do and would reach the claim well
   * ahead of the one that is executing the confirmed action, winning it,
   * and printing "that token is not recognised" into the channel while
   * the scramble it names runs on the neighbour. The grace is what orders
   * the two: it costs the common case nothing, because the holder does
   * not wait, and it costs a genuinely bad token a couple of seconds
   * before an accurate answer.
   *
   * @param {string|number} messageID
   * @param {boolean} matched - Whether THIS process held the token
   * @returns {Promise<boolean>} Whether to send a reply
   */
  async claimConfirmReply(messageID, matched) {
    const db = this._s3db;
    if (!db?.claimDiscordMessage || !this.isMultiServer()) return true;

    const key = `discord:${messageID}`;

    if (matched) {
      // Claimed to shut the rejectors up, not to ask permission. The
      // action this is replying about has already been taken, and a
      // process that did something and then said nothing about it is the
      // worst outcome available here.
      try { await db.claimDiscordMessage(key); } catch { /* reply anyway */ }
      return true;
    }

    // Not unref-ed: this promise is what the reply is waiting on, and a
    // timer the event loop is allowed to skip is one that never resolves it.
    await new Promise((resolve) => { setTimeout(resolve, CONFIRM_REJECT_GRACE_MS); });

    try {
      const claim = await db.claimDiscordMessage(key);
      return claim?.claimed === true;
    } catch {
      // Something else is already replying, probably. One silence beats N
      // copies of a rejection that may not even be true.
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  TEAM CHANGE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Sends AdminForceTeamChange, cascading through identifiers until one is
   * accepted. Squad's admin command parser rejects an unrecognised
   * identifier with a response containing "Unable to find player" instead
   * of throwing — a plain rcon.switchTeam()/execute() call can't see that,
   * so this calls rcon.execute() directly to inspect the response text.
   *
   * Tries, in order: eosID, steamID (if the player has one), playerName.
   * eosID and steamID are exact matches; playerName is a last resort
   * because Squad partial-matches plain names (the "Hunt"/"Hunty" bug: a
   * short name like "Hunt" can hit an unrelated player whose name merely
   * contains it, e.g. "Hunty"). AdminForceTeamChange does not reliably
   * accept every identifier for every player: on our test server, a
   * player's eosID (bare and "EOS:"-prefixed) was rejected outright and
   * only steamID/playerName worked; on the production server, the same
   * player's bare eosID was accepted. The two sessions differed in how the
   * player connected (their steamID was null in one, populated in the
   * other), which is the more likely explanation than any difference
   * between the two Squad servers themselves. Either way, no single tier
   * can be trusted to work for a given player on a given connection, which
   * is why this always cascades rather than sending eosID alone.
   *
   * Because the name tier can hit the wrong player, it is never sent blind:
   * _findNameCollision() checks whether any OTHER connected player's name
   * contains the value about to be sent, and refuses to send it at all if
   * so. This is prevention only, deliberately with no after-the-fact
   * revert: a revert can only fire by diffing the roster across the RCON
   * round-trip, and that window is wide enough for something unrelated to
   * legitimately change a bystander's team (another admin's command,
   * SmartAssign/TeamBalancer, the player self-switching) — an automated
   * revert can't tell that apart from a real collision and would silently
   * undo a legitimate change. If _findNameCollision's substring heuristic
   * misses a real Squad-side match, the wrong player's team stays flipped
   * until a human notices; that's judged safer than a revert mechanism
   * that can itself flip the wrong player's team.
   *
   * @param {object} player - Player state with eosID/steamID/name.
   * @param {string} playerName - Fallback label for logging.
   * @returns {Promise<{ok: boolean, type: string|null, response: string|null}>}
   */
  async _sendTeamChangeCommand(player, playerName) {
    const identifiers = [
      { type: 'eosID', value: player?.eosID },
      { type: 'steamID', value: player?.steamID },
      { type: 'name', value: player?.name || playerName }
    ];

    for (const { type, value } of identifiers) {
      if (!value) continue;

      if (type === 'name') {
        // Refuse to gamble: check for an ambiguous name BEFORE sending, so a
        // known-bad command is never fired in the first place. A collateral
        // team change is a real, disruptive mistake even when it gets
        // reverted a moment later — prevention beats cleanup.
        const collision = this._findNameCollision(value, player?.eosID);
        if (collision) {
          this.verbose(
            1,
            `[TC] WARNING: name collision — refusing to send AdminForceTeamChange "${value}" for ` +
            `${playerName}. ${collision.name} is also connected and their name contains this ` +
            `substring, so Squad's admin parser could hit either player. No safer identifier ` +
            `(eosID/steamID) is available. Skipping until the ambiguity clears.`
          );
          continue;
        }
      }

      const attempt = await this._tryOneIdentifier(type, value);
      if (!attempt.ok) continue; // RCON error, already logged
      if (attempt.rejected) continue;

      return { ok: true, type, response: attempt.response };
    }

    this.verbose(2, `[TC] All identifiers rejected for ${playerName}.`);
    return { ok: false, type: null, response: null };
  }

  /**
   * Sends a single AdminForceTeamChange attempt for one identifier and
   * classifies the response. Split out of _sendTeamChangeCommand() so the
   * rejection-detection logic lives in one place.
   *
   * @param {string} type - 'eosID' | 'steamID' | 'name', for logging only.
   * @param {string} value - The identifier value to send.
   * @returns {Promise<{ok: boolean, rejected: boolean, response: string|null}>}
   *   ok=false means the RCON call itself errored (network/transport, not a
   *   game-side rejection); rejected=true means Squad responded "Unable to
   *   find player".
   */
  async _tryOneIdentifier(type, value) {
    let response;
    try {
      response = await this.server.rcon.execute(`AdminForceTeamChange "${value}"`);
    } catch (err) {
      this.verbose(2, `[TC] RCON error for ${type}="${value}": ${err.message}`);
      return { ok: false, rejected: false, response: null };
    }

    const rejected = typeof response === 'string' && /unable to find player/i.test(response);
    if (rejected) {
      this.verbose(3, `[TC] Identifier ${type}="${value}" rejected — trying next.`);

      if (type === 'eosID' && !eosRejectionWarned) {
        eosRejectionWarned = true;
        this.verbose(
          1,
          `[TC] WARNING: this server rejects eosID in AdminForceTeamChange — falling ` +
          `back to steamID/playerName. Team changes still work, but every attempt now ` +
          `costs an extra RCON round-trip. This is the Squad game server's own ` +
          `admin-command parser, not a SquadJS version issue.`
        );
      }

      return { ok: true, rejected: true, response };
    }

    this.verbose(3, `[TC] Identifier ${type}="${value}" accepted.`);
    return { ok: true, rejected: false, response };
  }

  /**
   * Checks whether sending `value` as a name-tier AdminForceTeamChange could
   * plausibly hit someone other than the intended target — i.e. whether any
   * OTHER connected player's name contains `value` as a substring, the same
   * direction Squad's own admin parser matched on in the "Hunt"/"Hunty" bug
   * (identifier "Hunt" found inside player name "Hunty").
   *
   * @param {string} value - The name about to be sent.
   * @param {string} excludeEosID - The intended target; never their own collision.
   * @returns {object|null} The colliding player, or null if none found.
   */
  _findNameCollision(value, excludeEosID) {
    const all = this.players?.getAllPlayers?.() ?? [];
    const needle = String(value).toLowerCase();
    return (
      all.find(
        (p) => p.eosID !== excludeEosID && typeof p.name === 'string' && p.name.toLowerCase().includes(needle)
      ) ?? null
    );
  }

  /**
   * Requests an RCON team change for a player, with retry and S³-based
   * verification.
   *
   * Sends AdminForceTeamChange, trying eosID, then steamID, then playerName
   * until one is accepted (see _sendTeamChangeCommand), then uses S³'s
   * players service to verify the player landed on the opposite team.
   * After each RCON attempt, `refreshNow()` forces
   * an immediate player-list refresh via S³ so verification reads fresh
   * data instead of stale cache. Retries on failure up to maxAttempts,
   * then returns the outcome.
   *
   * This is a single-move, fire-and-forget operation. It does NOT manage
   * queues, sessions, batching, or preemption — those remain the caller's
   * responsibility.
   *
   * @param {string} eosID - Player's EOS ID.
   * @param {object} [options] - Behaviour tuning.
   * @param {number} [options.maxAttempts=5] - Max RCON send attempts.
   * @param {boolean} [options.warnPlayer=false] - Send rcon.warn on success.
   * @param {string} [options.warnMessage] - Warning text
   *   (default: 'You have been scrambled').
   * @param {string} [options.source='S3PluginBase'] - Source identifier
   *   passed to S³'s refreshNow() and the result object.
   * @returns {Promise<object|null>} Result object, or null if player not found.
   *   - success {boolean}: true if verification passed.
   *   - eosID {string}: The player's EOS ID.
   *   - teamID {string|number|null}: The team the player ended up on
   *     (1 or 2), or null on failure.
   *   - attempts {number}: Total RCON sends attempted.
   *   - name {string}: Player name at time of move.
   *   - source {string}: Source identifier passed through.
   */
  async _requestTeamChange(eosID, options = {}) {
    const defaultWarnMessage = this.localize('s3PluginBase.teamChange.defaults.warnMessage', {});
    const {
      maxAttempts = 5,
      warnPlayer = false,
      warnMessage = defaultWarnMessage,
      source = 'S3PluginBase'
    } = options;

    // ── Resolve player via S³ ─────────────────────────────────
    const playerState = this.players?.getPlayer(eosID);
    if (!playerState) {
      this.verbose(2, `[TC] Player ${eosID} not found in S³ registry — aborting.`);
      return null;
    }

    // Strict === is safe here: teamID is documented as number|null (see
    // docs/.agents/skills/creating-squadjs-plugins/references/event-reliability.md),
    // never a string. Below, current/final-team comparisons go through
    // String() instead because they compare against targetTeamID, a value
    // this file computed itself and could just as easily have left numeric.
    const targetTeamID = playerState.teamID === 1 ? 2 : 1;
    const playerName = playerState.name;

    this.verbose(
      3,
      `[TC] Requesting team change for ${playerName} (${eosID}) -> T${targetTeamID} (source: ${source})`
    );

    // ── Helpers ──────────────────────────────────────────────
    const getFromS3 = () => this.players?.getPlayer(eosID);

    const makeResult = (success, teamID, attempts) => ({
      success,
      eosID,
      teamID: teamID ?? null,
      attempts,
      name: playerName,
      source
    });

    // ── Retry loop ───────────────────────────────────────────
    let attempts;

    for (attempts = 0; attempts < maxAttempts; attempts++) {
      // Disconnect check — if the player isn't in S³'s registry after a
      // refreshNow(), they've disconnected. No need to fall back
      // to server.players as S³'s registry is derived from it.
      if (!getFromS3()) {
        this.verbose(2, `[TC] ${playerName} disconnected during retry — aborting.`);
        return makeResult(false, null, attempts);
      }

      // Already on target team?
      const current = getFromS3();
      if (current && String(current.teamID) === String(targetTeamID)) {
        this.verbose(3, `[TC] ${playerName} already on target team T${targetTeamID}.`);
        return makeResult(true, targetTeamID, attempts);
      }

      // ── Record move attribution before each RCON attempt ─
      // Re-recorded per-attempt because _consumeMoveAttribution deletes
      // the record on first match. If the Squad server auto-balances the
      // player back (bounce-back), subsequent retries need a fresh
      // attribution so TEAM_CHANGE shows the correct source (e.g.
      // "Player-Queue") instead of "Manual/Game".
      try {
        this._s3?.players?.recordMove(eosID, targetTeamID, source);
      } catch (err) {
        this.verbose(2, `[TC] recordMove warning: ${err.message}`);
      }

      // Send RCON command. Tries eosID, then steamID, then playerName, in
      // that order — cascading past a rejection so we never fall back to a
      // weaker identifier than this connection actually needs. Squad's
      // AdminForceTeamChange partial-matches plain names, so a shorter name
      // (e.g. "Hunt") can hit an unrelated player whose name contains it
      // (e.g. "Hunty"); eosID/steamID are exact matches and avoid that
      // entirely. Live RCON testing found eosID rejected for a player on one
      // server and accepted for the same player on another — the
      // difference tracked with whether steamID was populated for that
      // connection, not the server itself — so no single identifier can be
      // trusted to work, which is why this cascades instead of trusting
      // eosID alone.
      try {
        this.verbose(3, `[TC] Attempt ${attempts + 1}/${maxAttempts}: switching ${playerName}...`);
        await this._sendTeamChangeCommand(current, playerName);
      } catch (err) {
        this.verbose(2, `[TC] Attempt ${attempts + 1} RCON failed for ${playerName}: ${err.message}`);
      }

      // Force-refresh S³ player registry after the RCON command so the
      // next iteration (or the final check) sees up-to-date team data.
      if (this.players?.refreshNow) {
        await this.players.refreshNow(source).catch(() => { });
      }
    }

    // ── Final check after all attempts ────────────────────────
    const final = getFromS3();
    if (final && String(final.teamID) === String(targetTeamID)) {
      this.verbose(3, `[TC] ✅ ${playerName} verified on T${targetTeamID} after ${attempts} attempts.`);

      if (warnPlayer) {
        try {
          await this.server.rcon.warn(playerName, warnMessage);
        } catch (warnErr) {
          this.verbose(2, `[TC] Warn failed for ${playerName}: ${warnErr.message}`);
        }
      }

      return makeResult(true, targetTeamID, attempts);
    }

    this.verbose(2, `[TC] ❌ ${playerName} — all ${maxAttempts} attempts exhausted.`);
    return makeResult(false, null, attempts);
  }

}