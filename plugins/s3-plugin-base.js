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

export default class S3PluginBase extends BasePlugin {
  constructor(server, options, connectors) {
    super(server, options, connectors);
    this._s3 = null;
    this._s3db = null;
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
        '[S3] server.plugins not available. Cannot discover SlackersSquadServices.'
      );
    }
    const s3 = this.server.plugins.find(
      (p) => p.constructor.name === 'SlackersSquadServices'
    );
    if (!s3) {
      throw new Error(
        '[S3] SlackersSquadServices is required for this plugin. ' +
        'Ensure it is in config.json before this plugin and restart.'
      );
    }
    this._s3 = s3;
    this.verbose(2, '[S3] Discovered SlackersSquadServices.');
    return s3;
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
        '[S3] S³ not discovered. Call _resolveS3() or ensure prepareToMount() ran.'
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
      `[S3] S³ not ready after ${timeoutMs}ms timeout. ` +
      'Check that SlackersSquadServices is mounted and not crashing.'
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
      this.verbose(2, `[S3] S³ is ready. DB available: ${!!this._s3db}`);
    } else {
      this.verbose(1, '[S3] S³ not discovered before mount() — _onS3Ready will run without S³.');
    }
    await this._onS3Ready();
  }

  /**
   * Unmounts the plugin: clears cached S³ DB reference, then
   * delegates to the subclass _onUnmount() hook.
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
   * Registers an expected schema version for this plugin.
   *
   * @param {string} pluginName - Namespace (e.g. 'elo-tracker').
   * @param {number} version - Expected schema version number.
   */
  registerExpectedVersion(pluginName, version) {
    if (!this._s3db || typeof this._s3db.registerExpectedVersion !== 'function') {
      return;
    }
    this._s3db.registerExpectedVersion(pluginName, version);
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
   * @param {string} pluginName - Namespace to migrate.
   * @returns {Promise<object|null>} Migration result, or null if no
   *   DB available or already up to date.
   */
  async verifyAndRunMigrations(pluginName) {
    if (!this._s3db || typeof this._s3db.isReady !== 'function' || !this._s3db.isReady()) {
      return null;
    }
    const recheck = await this._s3db.verifySchemaVersions();
    if (!recheck.upToDate) {
      const result = await this._s3db.migrationEngine.runMigrations(pluginName);
      return result;
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
      this.verbose(1, `[DB] Error in _withDb: ${err.message}`);
      return null;
    }
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
   * Requests an RCON team change for a player, with retry and verification.
   *
   * Sends AdminForceTeamChange via the SquadJS core wrapper (rcon.switchTeam),
   * then polls server.players to verify the player landed on the opposite
   * team. Retries on failure up to maxAttempts, then returns the outcome.
   *
   * This is a single-move, fire-and-forget operation. It does NOT manage
   * queues, sessions, batching, or preemption — those remain the caller's
   * responsibility.
   *
   * @param {string} eosID - Player's EOS ID.
   * @param {object} [options] - Behaviour tuning.
   * @param {number} [options.maxAttempts=5] - Max RCON send attempts.
   * @param {number} [options.retryIntervalMs=100] - Delay between attempts (ms).
   * @param {number} [options.timeoutMs=5000] - Max wall-clock time (ms).
   * @param {boolean} [options.warnPlayer=false] - Send rcon.warn on success.
   * @param {string} [options.warnMessage] - Warning text
   *   (default: 'You have been scrambled').
   * @param {string} [options.source='S3PluginBase'] - Source for recordMove().
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
    const {
      maxAttempts = 5,
      retryIntervalMs = 100,
      timeoutMs = 5000,
      warnPlayer = false,
      warnMessage = 'You have been scrambled',
      source = 'S3PluginBase'
    } = options;

    // ── Resolve player ────────────────────────────────────────
    const player = this.server.players?.find((p) => p.eosID === eosID);
    if (!player) {
      this.verbose(2, `[TC] Player ${eosID} not found in server.players — aborting.`);
      return null;
    }

    const startTime = Date.now();
    const targetTeamID = player.teamID === 1 ? 2 : 1;
    const playerName = player.name;

    this.verbose(
      3,
      `[TC] Requesting team change for ${playerName} (${eosID}) -> T${targetTeamID} (source: ${source})`
    );

    // ── Record move via S³ player service ─────────────────────
    try {
      this._s3?.players?.recordMove(eosID, targetTeamID, source);
    } catch (err) {
      this.verbose(2, `[TC] recordMove warning: ${err.message}`);
    }

    // ── Helpers ──────────────────────────────────────────────
    const getCurrent = () => this.server.players?.find((p) => p.eosID === eosID);

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
      // Wall-clock timeout
      if (Date.now() - startTime >= timeoutMs) {
        this.verbose(2, `[TC] ${playerName} — timeout after ${Date.now() - startTime}ms (${attempts} attempts sent).`);
        return makeResult(false, null, attempts);
      }

      // Disconnect check
      const current = getCurrent();
      if (!current) {
        this.verbose(2, `[TC] ${playerName} disconnected during retry — aborting.`);
        return makeResult(false, null, attempts);
      }

      // Already on target team?
      if (String(current.teamID) === String(targetTeamID)) {
        this.verbose(3, `[TC] ${playerName} already on target team T${targetTeamID}.`);
        return makeResult(true, targetTeamID, attempts);
      }

      // Send RCON command
      try {
        this.verbose(3, `[TC] Attempt ${attempts + 1}/${maxAttempts}: switching ${playerName}...`);
        await this.server.rcon.switchTeam(playerName, targetTeamID);
      } catch (err) {
        this.verbose(2, `[TC] Attempt ${attempts + 1} RCON failed for ${playerName}: ${err.message}`);
      }

      // Wait before next check (skip after last attempt — we'll do a final check)
      if (attempts < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, retryIntervalMs));
      }
    }

    // ── Final check after all attempts ────────────────────────
    const final = getCurrent();
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