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
 * ─── SERVICE ACCESSORS ───────────────────────────────────────────
 *
 *   get s3()          → this._s3 reference
 *   get s3db()        → this._s3.db reference (cached in mount)
 *   get gameState()   → this._s3?.gameState
 *   get players()     → this._s3?.players
 *   get clans()       → this._s3?.clans
 *   get factions()    → this._s3?.factions
 *   get serverConfig()→ this._s3?.serverConfig
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
import { t } from './i18n.js';

// Module-scope, not per-instance: SmartAssign, Switch and TeamBalancer each
// extend this class and would otherwise each print their own copy of the
// same discovery the first time any of them hits it.
let eosRejectionWarned = false;

export default class S3PluginBase extends BasePlugin {
  constructor(server, options, connectors) {
    super(server, options, connectors);
    this._s3 = null;
    this._s3db = null;
  }

  /**
   * Helper to retrieve configured language or default to English.
   */
  get lang() {
    return this.options?.language || 'en';
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
        t('s3PluginBase.errors.pluginsNotAvailable', {}, this.lang)
      );
    }
    const s3 = this.server.plugins.find(
      (p) => p.constructor.name === 'SlackersSquadServices'
    );
    if (!s3) {
      throw new Error(
        t('s3PluginBase.errors.servicesRequired', {}, this.lang)
      );
    }
    this._s3 = s3;
    this.verbose(2, t('s3PluginBase.verbose.discovered', {}, this.lang));
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
        t('s3PluginBase.errors.notDiscovered', {}, this.lang)
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
        this.verbose(1, t('s3PluginBase.verbose.readyPromiseRejected', { message: err.message }, this.lang));
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
      t('s3PluginBase.errors.readyTimeout', { timeoutMs }, this.lang)
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
      this._s3db = this._s3.db || null;
      this.verbose(2, t('s3PluginBase.verbose.readyDbAvailable', { available: !!this._s3db }, this.lang));
    } else {
      this.verbose(1, t('s3PluginBase.verbose.notDiscoveredBeforeMount', {}, this.lang));
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
      this.verbose(3, t('s3PluginBase.verbose.registeredModelsForDrift', {
        pluginName,
        count: options.models.length,
        models: options.models.join(', ')
      }, this.lang));
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
        this.verbose(1, t('s3PluginBase.verbose.migrationsPending', { pluginName }, this.lang));
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
            t('s3PluginBase.teamChange.warnings.nameCollision', {
              value,
              playerName,
              collisionName: collision.name
            }, this.lang)
          );
          continue;
        }
      }

      const attempt = await this._tryOneIdentifier(type, value);
      if (!attempt.ok) continue; // RCON error, already logged
      if (attempt.rejected) continue;

      return { ok: true, type, response: attempt.response };
    }

    this.verbose(2, t('s3PluginBase.teamChange.verbose.allRejected', { playerName }, this.lang));
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
      this.verbose(2, t('s3PluginBase.teamChange.verbose.rconError', { type, value, error: err.message }, this.lang));
      return { ok: false, rejected: false, response: null };
    }

    const rejected = typeof response === 'string' && /unable to find player/i.test(response);
    if (rejected) {
      this.verbose(3, t('s3PluginBase.teamChange.verbose.identifierRejected', { type, value }, this.lang));

      if (type === 'eosID' && !eosRejectionWarned) {
        eosRejectionWarned = true;
        this.verbose(
          1,
          t('s3PluginBase.teamChange.warnings.eosRejected', {}, this.lang)
        );
      }

      return { ok: true, rejected: true, response };
    }

    this.verbose(3, t('s3PluginBase.teamChange.verbose.identifierAccepted', { type, value }, this.lang));
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
    const defaultWarnMessage = t('s3PluginBase.teamChange.defaults.warnMessage', {}, this.lang);
    const {
      maxAttempts = 5,
      warnPlayer = false,
      warnMessage = defaultWarnMessage,
      source = 'S3PluginBase'
    } = options;

    // ── Resolve player via S³ ─────────────────────────────────
    const playerState = this.players?.getPlayer(eosID);
    if (!playerState) {
      this.verbose(2, t('s3PluginBase.teamChange.verbose.playerNotFound', { eosID }, this.lang));
      return null;
    }

    const targetTeamID = playerState.teamID === 1 ? 2 : 1;
    const playerName = playerState.name;

    this.verbose(
      3,
      t('s3PluginBase.teamChange.verbose.requesting', {
        playerName,
        eosID,
        targetTeamID,
        source
      }, this.lang)
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
        this.verbose(2, t('s3PluginBase.teamChange.verbose.disconnected', { playerName }, this.lang));
        return makeResult(false, null, attempts);
      }

      // Already on target team?
      const current = getFromS3();
      if (current && String(current.teamID) === String(targetTeamID)) {
        this.verbose(3, t('s3PluginBase.teamChange.verbose.alreadyOnTarget', { playerName, targetTeamID }, this.lang));
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
        this.verbose(2, t('s3PluginBase.teamChange.verbose.recordMoveWarning', { error: err.message }, this.lang));
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
        this.verbose(3, t('s3PluginBase.teamChange.verbose.attempting', {
          attempt: attempts + 1,
          maxAttempts,
          playerName
        }, this.lang));
        await this._sendTeamChangeCommand(current, playerName);
      } catch (err) {
        this.verbose(2, t('s3PluginBase.teamChange.verbose.attemptRconFailed', {
          attempt: attempts + 1,
          playerName,
          error: err.message
        }, this.lang));
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
      this.verbose(3, t('s3PluginBase.teamChange.verbose.verifiedOnTarget', {
        playerName,
        targetTeamID,
        attempts
      }, this.lang));

      if (warnPlayer) {
        try {
          await this.server.rcon.warn(playerName, warnMessage);
        } catch (warnErr) {
          this.verbose(2, t('s3PluginBase.teamChange.verbose.warnFailed', { playerName, error: warnErr.message }, this.lang));
        }
      }

      return makeResult(true, targetTeamID, attempts);
    }

    this.verbose(2, t('s3PluginBase.teamChange.verbose.allAttemptsExhausted', { playerName, maxAttempts }, this.lang));
    return makeResult(false, null, attempts);
  }

  /**
   * Loads localized JSON messages into this.messages automatically.
   * @param {string} pluginNamespace - e.g. 'elo-tracker', 'smart-assign', 'switch'
   * @param {string} [langCode='en'] - e.g. 'en', 'pt'
   */
  async loadMessages(pluginNamespace, langCode = 'en') {
    const safeLang = String(langCode).toLowerCase().replace(/[^a-z0-9_-]/g, '');

    // Path points from s3/plugins/ to top-level locales/ folder
    const rootLocalesDir = path.resolve(__dirname, '../../locales');
    const targetPath = path.join(rootLocalesDir, `${safeLang}.json`);
    const fallbackPath = path.join(rootLocalesDir, 'en.json');

    const fileToLoad = existsSync(targetPath) ? targetPath : fallbackPath;

    try {
      const module = await import(fileToLoad, { assert: { type: 'json' } });
      // Assigns only the sub-namespace for this specific plugin (e.g. this.messages['elo-tracker'])
      this.messages = module.default;
      this.pluginNamespace = pluginNamespace;
    } catch (err) {
      const fallbackModule = await import(fallbackPath, { assert: { type: 'json' } });
      this.messages = fallbackModule.default;
    }
  }

  /**
   * Global message formatter helper for variables like {playerCount}
   */
  formatMessage(template, vars = {}) {
    if (!template) return '';
    return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
  }
}