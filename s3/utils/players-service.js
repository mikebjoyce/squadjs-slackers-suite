/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               PLAYERS SERVICE                                ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Centralizes player registry management with per-tick diffing via
 * UPDATED_PLAYER_INFORMATION events. Provides move attribution with
 * TTL-based consumption, priority-based per-player and global locking
 * for multi-plugin coordination, DB-backed reconnect memory, a
 * coalesced refresh manager, and a null-teamID projection subsystem
 * for round-transition stability.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * PlayersService (class, default)
 *   Registry:     getPlayer(), hasPlayer(), getAllPlayers(),
 *                 getSquads(), areTeamsResolved()
 *   Locking:      canAct(), lock(), unlock(), lockGlobal(),
 *                 unlockGlobal(), isLockedBy(), isGloballyLockedBy()
 *   Attribution:  recordMove()
 *   Reconnects:   rememberReconnect(), getReconnect(), peekReconnect(),
 *                 clearReconnects()
 *   Sessions:     getJoinTime(eosID)
 *   Refresh:      registerRefreshInterest(), unregisterRefreshInterest(),
 *                 requestRefresh(), refresh(), refreshNow()
 *   Lifecycle:    mount(), unmount(), isReady(),
 *                 handlePlayerConnected(), handleUpdatedPlayerInfo()
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * (No local imports — depends on parent, server, and verboseLogger
 *  injected via constructor.)
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Registry rows are refreshed in place every tick: name, teamID, squadID
 *   and isLeader all track the live server.players entry, so leadership
 *   reflects the current SL rather than the state at first registration.
 * - Lock priority ordering: TeamBalancer(3) > SmartAssign(2) > Switch(1).
 * - registerPriority('MyPlugin', 4) allows third-party plugins to
 *   register a custom priority level — extensible beyond the hardcoded map.
 *   Plugins that call lock()/canAct() without registering get fallback priority 0.
 * - Null-teamID projection: When teams go null after NEW_GAME, a
 *   projected player list is served with teams flipped 1↔2.
 * - Emitted events: S3_PLAYER_JOINED, S3_PLAYER_LEFT,
 *   S3_PLAYER_TEAM_CHANGED, S3_PLAYER_RECONNECTED, S3_PLAYERS_UPDATED,
 *   S3_PLAYER_LOCK_CHANGED, S3_GLOBAL_LOCK_CHANGED.
 * - Refresh manager coalesces burst requestRefresh() calls with
 *   configurable debounce; periodic forced refreshes when consumer
 *   intervals are registered.
 * - Reconnect memory is DB-backed when DBService is available, with
 *   in-memory fallback and periodic pruning.
 * - Session tracking: S3_PlayerSessions table persists per-player
 *   sessionStart time across SquadJS restarts. joinTime is hydrated from
 *   this table after initial sync. Sessions expire after 30 min of inactivity.
 *
 */

// Round flow notes for future reference:
// - LIVE -> ROUND_ENDED event -> ENDGAME (map/faction voting window)
// - NEW_GAME event -> STAGING(resolving=true) -> STAGING(resolving=false) -> LIVE.
// - During map load around NEW_GAME, players can briefly report teamID=null (sometimes
//   a tick before NEW_GAME). Treat this as transient while teams resolve; prior teams
//   remain valid unless a player actually swaps during this window.

const DEFAULT_ATTRIBUTION_TTL_MS = 90000;
const DEFAULT_LOCK_TTL_MS = 3000;
const DEFAULT_RECONNECT_MAX_AGE_MS = 1 * 60 * 60 * 1000;
const DEFAULT_RECONNECT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_REFRESH_MIN_INTERVAL_MS = 3000;   // hard floor — no faster than 3s between RCON calls
const DEFAULT_REFRESH_MAX_INTERVAL_MS = 60000;   // hard ceiling — natural SquadJS tick rate
const DEFAULT_REFRESH_DEBOUNCE_WINDOW_MS = 250; // coalesce window for requestRefresh()
const DEFAULT_REFRESH_NOW_FLOOR_MS = 1000;      // minimum gap for refreshNow() before re-calling RCON
const DEFAULT_SESSION_EXPIRY_MS = 30 * 60 * 1000; // 30 min — how long without activity before a session expires
const DEFAULT_SESSION_UPDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 min — how often to refresh lastActivity in DB
const DEFAULT_RCON_RECOVERY_GRACE_MS = 30000; // 30s — suppress leave detection for this long after an RCON_ERROR
// How long a single player may sit at teamID N/A before they stop counting
// against the roster-wide resolution gate. The legitimate post-NEW_GAME null
// window clears in seconds, so this is deliberately far longer than it needs to
// be: quarantining a player who was about to resolve is the worse mistake, and
// waiting costs nothing because the clock is cleared the moment they report a
// real team or leave. Longer than GameStateService's 120s resolving budget,
// which means the round a client first wedges still ends its resolving window
// on the deadline — every subsequent round resolves normally.
const DEFAULT_UNRESOLVED_GRACE_MS = 180000;

/**
 * Coerce a raw SquadJS `isLeader` into a boolean, distinguishing "not a leader"
 * from "the source did not say".
 *
 * SquadJS documents Player.isLeader as a bool, but its sibling Squad.locked
 * arrives as the string "True"/"False" straight out of the RCON parse, so the
 * string form is accepted here too — LoggingService already normalises it the
 * same way. Sources that carry no leadership information at all (the
 * PLAYER_CONNECTED payload, for one) must not be read as a demotion, so
 * null/undefined returns `fallback` rather than false.
 *
 * @param {*} raw - Value from the SquadJS player object.
 * @param {boolean} fallback - Returned when `raw` is null/undefined.
 * @returns {boolean} Normalised leadership flag.
 */
function normalizeIsLeader(raw, fallback = false) {
  if (raw === null || raw === undefined) return fallback === true;
  return raw === true || raw === 'True';
}

/* ────────────────────────── BOOTSTRAP DDL ──────────────────────────
 *
 * S3_PlayerReconnects and S3_PlayerSessions are infrastructure tables created
 * by raw DDL at mount (rather than by model sync) so they exist before any
 * query runs. The DDL is emitted from these builders, in one place, because it
 * runs from FOUR call sites — the two bootstrap paths in _initSessionPersistence
 * / _initReconnectPersistence, and the two migration up() bodies that re-run it
 * through the migration engine's query interface.
 *
 * Every identifier is quoted. Unquoted, Postgres folds them to lower case and
 * creates `s3_playerreconnects(eosid, updatedat, …)`, while the Sequelize models
 * below declare `tableName: 'S3_PlayerReconnects'` and are quoted by Sequelize —
 * so the models address a table that does not exist and every read and write
 * against them fails. SQLite ignores identifier case and MySQL column names are
 * case-insensitive, which is why the unquoted form worked for years.
 *
 * Quoting is backward-compatible on SQLite and MySQL: `CREATE TABLE IF NOT
 * EXISTS "S3_PlayerReconnects"` matches a table an older build created unquoted,
 * so no second table appears and existing rows stay reachable. Verified against
 * SQLite, MySQL 8 and Postgres 16 in s3/testing/test-dialect-portability.js.
 *
 * @param {(id: string) => string} q - Identifier quoter (DBService.quoteIdentifier).
 */
function reconnectsTableDDL(q) {
  return `
      CREATE TABLE IF NOT EXISTS ${q('S3_PlayerReconnects')} (
        ${q('eosID')} VARCHAR(64) PRIMARY KEY,
        ${q('steamID')} VARCHAR(64) NULL,
        ${q('playerName')} VARCHAR(255) NULL,
        ${q('lastTeamID')} INTEGER NULL,
        ${q('lastSeenAt')} BIGINT NULL,
        ${q('updatedAt')} BIGINT NOT NULL
      );
    `;
}

function sessionsTableDDL(q) {
  return `
      CREATE TABLE IF NOT EXISTS ${q('S3_PlayerSessions')} (
        ${q('eosID')} VARCHAR(64) PRIMARY KEY,
        ${q('steamID')} VARCHAR(64) NULL,
        ${q('playerName')} VARCHAR(255) NULL,
        ${q('sessionStart')} BIGINT NOT NULL,
        ${q('lastActivity')} BIGINT NOT NULL
      );
    `;
}

export default class PlayersService {
  constructor({
    parent = null,
    server,
    verboseLogger = () => {},
    attributionTtlMs = DEFAULT_ATTRIBUTION_TTL_MS,
    defaultLockTtlMs = DEFAULT_LOCK_TTL_MS,
    reconnectPersistence = true,
    refreshMinIntervalMs = DEFAULT_REFRESH_MIN_INTERVAL_MS,
    refreshMaxIntervalMs = DEFAULT_REFRESH_MAX_INTERVAL_MS,
    refreshDebounceWindowMs = DEFAULT_REFRESH_DEBOUNCE_WINDOW_MS,
    refreshNowFloorMs = DEFAULT_REFRESH_NOW_FLOOR_MS,
    sessionExpiryMs = DEFAULT_SESSION_EXPIRY_MS,
    sessionUpdateIntervalMs = DEFAULT_SESSION_UPDATE_INTERVAL_MS,
    unresolvedGraceMs = DEFAULT_UNRESOLVED_GRACE_MS
  } = {}) {
    this.parent = parent;
    this.server = server;
    this.verboseLogger = verboseLogger;

    this.attributionTtlMs = Number.isFinite(attributionTtlMs) ? attributionTtlMs : DEFAULT_ATTRIBUTION_TTL_MS;
    this.defaultLockTtlMs = Number.isFinite(defaultLockTtlMs) ? defaultLockTtlMs : DEFAULT_LOCK_TTL_MS;
    this.reconnectPersistence = reconnectPersistence !== false;
    this.refreshMinIntervalMs = Number.isFinite(refreshMinIntervalMs) ? Math.max(1000, refreshMinIntervalMs) : DEFAULT_REFRESH_MIN_INTERVAL_MS;
    this.refreshMaxIntervalMs = Number.isFinite(refreshMaxIntervalMs) ? Math.max(this.refreshMinIntervalMs, refreshMaxIntervalMs) : DEFAULT_REFRESH_MAX_INTERVAL_MS;
    this.refreshDebounceWindowMs = Number.isFinite(refreshDebounceWindowMs) ? Math.max(50, refreshDebounceWindowMs) : DEFAULT_REFRESH_DEBOUNCE_WINDOW_MS;
    this.refreshNowFloorMs = Number.isFinite(refreshNowFloorMs) ? Math.max(500, refreshNowFloorMs) : DEFAULT_REFRESH_NOW_FLOOR_MS;
    this.sessionExpiryMs = Number.isFinite(sessionExpiryMs) ? Math.max(60000, sessionExpiryMs) : DEFAULT_SESSION_EXPIRY_MS;
    this.sessionUpdateIntervalMs = Number.isFinite(sessionUpdateIntervalMs) ? Math.max(60000, sessionUpdateIntervalMs) : DEFAULT_SESSION_UPDATE_INTERVAL_MS;
    this.unresolvedGraceMs = Number.isFinite(unresolvedGraceMs) ? Math.max(0, unresolvedGraceMs) : DEFAULT_UNRESOLVED_GRACE_MS;

    this.registry = new Map(); // key (prefer EOS ID; fallback to steamID) -> player state
    // Optional index for legacy/secondary IDs. steamID may be undefined for EOS-only players.
    this.steamIndex = new Map(); // steamID -> key
    // Map keyed by EOS ID (preferred) or steamID (fallback) for move attribution.
    // steamID may be undefined for EOS-only players.
    this.moveAttribution = new Map(); // id -> { targetTeamID, source, expiresAt }

    this.playerLocks = new Map(); // key -> lock
    this.globalLock = null;

    this.reconnectModel = null;
    this._reconnectMemory = new Map();
    this.reconnectMaxAgeMs = DEFAULT_RECONNECT_MAX_AGE_MS;
    this.reconnectPruneIntervalMs = DEFAULT_RECONNECT_PRUNE_INTERVAL_MS;
    this._lastReconnectPruneAt = 0;

    // Session tracking
    this.sessionModel = null;
    this._sessionInitialized = false;
    this._lastSessionActivityUpdate = 0; // timestamp of last bulk lastActivity write

    this._migrationRegistered = false;
    this._isMounted = false;
    this._initialSyncComplete = false;

    // Subscription callbacks
    this._onPlayerDataChangedCallbacks = [];
    this._onPlayerConnectedCallbacks = [];
    // Snapshot of the last fully-resolved team list. Used to build projections when teamIDs go null.
    this._lastStablePlayers = null;
    // Active projection map when we detect the null-teamID window after NEW_GAME.
    this._projectedPlayers = null;
    // Snapshot of this.server.squads (raw SquadJS squad objects), refreshed each tick
    // when teams are fully resolved. Used by getSquads() to serve full squad metadata.
    this._squadsCache = null;
    // key -> { since, warned } for every player currently reporting an unreal
    // teamID. Once `since` is older than the grace window the player is treated
    // as stuck and excluded from the roster-wide gate. See _ageUnresolvedPlayers.
    this._unresolvedSince = new Map();
    // Keys quarantined by the pass above — exposed via getStuckPlayerKeys().
    this._stuckKeys = new Set();
    // Edge-triggers the mass-unresolved log so a round transition does not
    // reprint it on every tick.
    this._systemicUnresolved = false;

    this.PRIORITY = {
      TeamBalancer: 3,
      SmartAssign: 2,
      Switch: 1
    };
    // Runtime extensible priority map — third-party plugins can register
    // their own priority via registerPriority(). Defaults to 0 for unregistered sources.
    this._customPriorities = new Map();

    // ---------------------------------------------------------------------------
    // Coalesced refresh manager
    //
    // Provides debounced requestRefresh() (fire-and-forget, coalesces burst calls)
    // and refresh() (awaitable, respects 1s floor). Consumers register their
    // desired max-staleness interval; the effective interval is the minimum of
    // all registered intervals, clamped to [refreshMinIntervalMs, refreshMaxIntervalMs].
    // When a natural UPDATED_PLAYER_INFORMATION tick arrives, any pending debounce
    // is cancelled (data is already fresh). After each full tick, S3_PLAYERS_UPDATED
    // is emitted so consumers can run post-refresh logic without their own polling.
    // ---------------------------------------------------------------------------
    this._refreshState = {
      debounceTimer: null,           // setTimeout handle for pending requestRefresh()
      lastRefreshTime: 0,            // timestamp of last actual updatePlayerList() call
      registeredIntervals: new Map(), // Map<source (string), maxStalenessMs (number)>
      effectiveInterval: null,         // computed clamp(min(allRegistered), refreshMin, refreshMax)
      periodicTimer: null,           // setInterval handle for periodic forced refreshes
      requestorUrgency: null         // 'high' | 'normal' — highest urgency seen in current window
    };

    this.listeners = {
      handleUpdatedPlayerInfo: this.handleUpdatedPlayerInfo.bind(this),
      handlePlayerConnected: this.handlePlayerConnected.bind(this)
    };

    // RCON recovery tracking: SquadJS emits RCON_ERROR when RCON operations fail
    // (e.g. socket drop). We suppress leave detection for a grace period after
    // the last error to prevent mass false JOINs when server.players repopulates.
    this._lastRconErrorTime = 0;
    this._rconRecoveryGraceMs = DEFAULT_RCON_RECOVERY_GRACE_MS;
    this._onRconError = () => {
      this._lastRconErrorTime = Date.now();
      this.verboseLogger(2, `[Players] RCON_ERROR detected — entering recovery window (${this._rconRecoveryGraceMs}ms leave suppression)`);
    };
  }

  async mount() {
    if (!this.server || typeof this.server.on !== 'function') {
      throw new Error('PlayersService requires a valid SquadJS server EventEmitter.');
    }

    if (this._isMounted) {
      await this.unmount();
    }

    await this._initReconnectPersistence();
    await this._pruneReconnects(Date.now(), { force: true });
    await this._initSessionPersistence();

    this._isMounted = true;
    this._initialSyncComplete = false;

    // Wire RCON_ERROR listener for reconnect recovery
    this.server.on('RCON_ERROR', this._onRconError);

    // Start periodic refresh timer if any consumer registered interest before mount.
    if (this._refreshState.effectiveInterval) {
      this._startPeriodicRefresh();
    }

    this.verboseLogger(2, '[Players] Mounted.');
  }

  async unmount() {
    if (!this._isMounted) return;

    // Stop periodic refresh timer and cancel any pending debounce.
    this._stopPeriodicRefresh();

    // Remove RCON_ERROR listener
    this.server.removeListener('RCON_ERROR', this._onRconError);

    for (const lock of this.playerLocks.values()) {
      if (lock?.timeout) clearTimeout(lock.timeout);
    }
    this.playerLocks.clear();

    if (this.globalLock?.timeout) clearTimeout(this.globalLock.timeout);
    this.globalLock = null;

    this._isMounted = false;
    this._initialSyncComplete = false;
    this._lastRconErrorTime = 0;
    // Drop the unreal-teamID clocks with the rest of the resolution state. A
    // remount re-runs initial sync, so a clock left over from before it would
    // quarantine a player on their first tick back without any grace.
    this._unresolvedSince.clear();
    this._stuckKeys.clear();
    this.verboseLogger(2, '[Players] Unmounted.');
  }

  isReady() {
    return this._isMounted;
  }

  /**
   * Register a callback for player data changes (after every UPDATED_PLAYER_INFORMATION
   * tick is fully processed). Fires after the service's registry and projections are
   * committed.
   * @param {Function} callback - Receives { joinCount, leaveCount, teamChangeCount, playerCount, projectionActive }
   * @returns {Function} unsubscribe function
   */
  onPlayerDataChanged(callback) {
    if (typeof callback !== 'function') {
      throw new Error('PlayersService.onPlayerDataChanged requires a function callback.');
    }
    this._onPlayerDataChangedCallbacks.push(callback);
    this.verboseLogger(4, `[Players] Added player-data subscriber (total: ${this._onPlayerDataChangedCallbacks.length})`);
    return () => {
      this._onPlayerDataChangedCallbacks = this._onPlayerDataChangedCallbacks.filter(cb => cb !== callback);
      this.verboseLogger(4, `[Players] Removed player-data subscriber (total: ${this._onPlayerDataChangedCallbacks.length})`);
    };
  }

  /**
   * Register a callback when a player connects to the server (after PLAYER_CONNECTED
   * event is fully processed, including reconnect detection).
   * @param {Function} callback - Receives { player, isNew, previousTeamID }
   * @returns {Function} unsubscribe function
   */
  onPlayerConnected(callback) {
    if (typeof callback !== 'function') {
      throw new Error('PlayersService.onPlayerConnected requires a function callback.');
    }
    this._onPlayerConnectedCallbacks.push(callback);
    this.verboseLogger(4, `[Players] Added player-connected subscriber (total: ${this._onPlayerConnectedCallbacks.length})`);
    return () => {
      this._onPlayerConnectedCallbacks = this._onPlayerConnectedCallbacks.filter(cb => cb !== callback);
      this.verboseLogger(4, `[Players] Removed player-connected subscriber (total: ${this._onPlayerConnectedCallbacks.length})`);
    };
  }

  // ── Notification methods ──────────────────────────────────────────

  _notifyPlayerDataChanged() {
    const payload = {
      joinCount: this._lastTickJoinCount || 0,
      leaveCount: this._lastTickLeaveCount || 0,
      teamChangeCount: this._lastTickTeamChangeCount || 0,
      playerCount: this.registry.size,
      projectionActive: !!this._projectedPlayers,
      phase: this.phase
    };
    for (const cb of this._onPlayerDataChangedCallbacks) {
      try {
        cb(payload);
      } catch (err) {
        this.verboseLogger(1, `[Players] Player-data callback error: ${err.message}`);
      }
    }
  }

  _notifyPlayerConnected(player, isNew, previousTeamID) {
    const payload = {
      player: { ...player },
      isNew,
      previousTeamID
    };
    for (const cb of this._onPlayerConnectedCallbacks) {
      try {
        cb(payload);
      } catch (err) {
        this.verboseLogger(1, `[Players] Player-connected callback error: ${err.message}`);
      }
    }
  }

  getPlayer(eosIDOrSteamID) {
    const key = this._resolvePlayerKey(eosIDOrSteamID);
    if (!key) return null;

    // Return best-available data (projected while resolving, otherwise real registry).
    const active = this._getActiveRegistry();
    const value = active.get(key) || this.registry.get(key);
    return value ? { ...value } : null;
  }

  hasPlayer(eosIDOrSteamID) {
    return !!this._resolvePlayerKey(eosIDOrSteamID);
  }

  getAllPlayers() {
    // Keep call sites blind to projection; always return the most stable data we can provide.
    const active = this._getActiveRegistry();
    return [...active.values()].map((p) => ({ ...p }));
  }

  /**
   * Returns the joinTime (session start timestamp) for a player.
   * This is the DB-persisted value recovered across restarts.
   * Returns 0 if the player is not tracked or has no session data.
   * @param {string} eosIDOrSteamID - Player EOS ID or Steam ID
   * @returns {number} joinTime timestamp in ms, or 0
   */
  getJoinTime(eosIDOrSteamID) {
    const player = this.getPlayer(eosIDOrSteamID);
    return player?.joinTime || 0;
  }

  /**
   * Resets a player's joinTime to now, reopening their switch eligibility window.
   * Called by Switch when granting remediation tokens so the player can actually
   * use !switch without being gated by a stale connection window.
   *
   * Mutates the registry state directly (not the getPlayer() copy) and fire-and-forget
   * upserts S3_PlayerSessions so a future SquadJS restart doesn't resurrect the old time.
   *
   * @param {string} eosIDOrSteamID - Player EOS ID or Steam ID
   * @returns {boolean} true if the player was found and joinTime was reset
   */
  resetJoinTime(eosIDOrSteamID) {
    const key = this._resolvePlayerKey(eosIDOrSteamID);
    if (!key) return false;

    // Mutate the live registry state (or projected state during null-window).
    const state = this.registry.get(key) || this._projectedPlayers?.get(key);
    if (!state) return false;

    const now = Date.now();
    state.joinTime = now;

    // Persist so _recoverSessionTimes() on next mount doesn't resurrect the old time.
    if (state.eosID) {
      this._upsertSessionRow(state.eosID, state.steamID, state.name, now, now).catch((err) => {
        this.verboseLogger(2, `[Players] resetJoinTime session upsert failed for ${state.name || key}: ${err.message}`);
      });
    }

    this.verboseLogger(2, `[Players] resetJoinTime: ${state.name || key} joinTime reset to now`);
    return true;
  }

  getSquads() {
    // Returns cached SquadJS squad objects enriched with leader-first player lists.
    // Array of { squadID, teamID, squadName, locked (bool), players: eosID[] }
    const squads = this._squadsCache || [];
    const active = this._getActiveRegistry();

    // Build "teamID:squadID" -> { leaders[], members[] } from player registry.
    // Squad numbers restart per team (both teams have a squad 1), so keying on
    // squadID alone merges the two teams' same-numbered squads into one bucket.
    const squadKey = (teamID, squadID) => `${Number(teamID)}:${Number(squadID)}`;

    const bySquad = new Map();
    for (const [, p] of active) {
      if (p.squadID == null) continue;
      const key = squadKey(p.teamID, p.squadID);
      if (!bySquad.has(key)) {
        bySquad.set(key, { leaders: [], members: [] });
      }
      const entry = bySquad.get(key);
      if (p.isLeader) {
        entry.leaders.push(p.eosID);
      } else {
        entry.members.push(p.eosID);
      }
    }

    return squads
      .map((s) => {
        const entry = bySquad.get(squadKey(s.teamID, s.squadID));
        return {
          squadID: s.squadID,
          teamID: s.teamID,
          squadName: s.squadName,
          locked: s.locked === 'True' || s.locked === true,
          players: entry ? [...entry.leaders, ...entry.members] : []
        };
      })
      .filter((s) => s.players.length > 0);
  }

  areTeamsResolved() {
    const entries = [...this.registry.entries()];
    if (!entries.length) return false;
    // A quarantined player does not count against this. Without that, one stuck
    // client meant GameStateService could only ever leave `resolving` on the
    // BUDGET_EXPIRED deadline rather than on PLAYERS_RESOLVED — for every round
    // that player stayed connected.
    if (!entries.some(([, p]) => this._isRealTeam(p?.teamID))) return false;
    return entries.every(([key, p]) => this._isRealTeam(p?.teamID) || this._stuckKeys.has(key));
  }

  /**
   * How often the registry is actually refreshed, in ms — clamp(fastest
   * registered interval, refreshMinIntervalMs, refreshMaxIntervalMs), or null
   * when nothing has registered interest.
   *
   * Exposed because it is the unit any "how long should I wait for team data"
   * budget has to be measured in: areTeamsResolved() can only change on a tick,
   * so a timeout shorter than a few of these expires before the answer could
   * possibly have arrived. GameStateService uses it to floor its resolving
   * deadline.
   */
  getEffectiveRefreshIntervalMs() {
    return this._refreshState?.effectiveInterval || null;
  }

  // ---------------------------------------------------------------------------
  // Coalesced refresh manager — public API
  // ---------------------------------------------------------------------------

  registerRefreshInterest(source, { maxStalenessMs } = {}) {
    const normalized = this._normalizeSource(source);
    const interval = Number.isFinite(maxStalenessMs) ? Math.max(1000, maxStalenessMs) : this.refreshMaxIntervalMs;
    this._refreshState.registeredIntervals.set(normalized, interval);
    this._recomputeEffectiveInterval();
  }

  unregisterRefreshInterest(source) {
    const normalized = this._normalizeSource(source);
    this._refreshState.registeredIntervals.delete(normalized);
    this._recomputeEffectiveInterval();
  }

  requestRefresh(source, { urgency = 'normal' } = {}) {
    const normalized = this._normalizeSource(source);
    // Only honor requests from registered consumers.
    if (!this._refreshState.registeredIntervals.has(normalized)) return;

    // Upgrade urgency if needed.
    if (urgency === 'high') {
      this._refreshState.requestorUrgency = 'high';
    }

    if (this._refreshState.debounceTimer) {
      // Timer already pending; let it ride (urgency upgrade above ensures it
      // will be handled on fire if needed).
      return;
    }

    const debounceMs = this._refreshState.requestorUrgency === 'high'
      ? Math.min(this.refreshDebounceWindowMs, 100)
      : this.refreshDebounceWindowMs;

    this._refreshState.debounceTimer = setTimeout(async () => {
      this._refreshState.debounceTimer = null;
      const urgency = this._refreshState.requestorUrgency;
      this._refreshState.requestorUrgency = null;

      const now = Date.now();
      const elapsed = now - this._refreshState.lastRefreshTime;
      if (elapsed < this.refreshMinIntervalMs) {
        // Too soon since last refresh; reschedule for remaining gap.
        const remaining = this.refreshMinIntervalMs - elapsed;
        this.verboseLogger(3, `[Players] Refresh debounce: ${elapsed}ms since last, rescheduling in ${remaining}ms (urgency=${urgency || 'normal'})`);
        this._refreshState.debounceTimer = setTimeout(() => {
          this._refreshState.debounceTimer = null;
          this._refreshState.requestorUrgency = null;
          this._executeRefresh(source);
        }, remaining);
        return;
      }

      await this._executeRefresh(normalized);
    }, debounceMs);
  }

  async refresh(source) {
    const normalized = this._normalizeSource(source);
    if (!this._refreshState.registeredIntervals.has(normalized)) return;

    const now = Date.now();
    const elapsed = now - this._refreshState.lastRefreshTime;
    if (elapsed < this.refreshNowFloorMs) {
      this.verboseLogger(3, `[Players] refresh skipped: ${elapsed}ms since last (floor=${this.refreshNowFloorMs}ms)`);
      return;
    }

    // Cancel any pending debounce.
    if (this._refreshState.debounceTimer) {
      clearTimeout(this._refreshState.debounceTimer);
      this._refreshState.debounceTimer = null;
      this._refreshState.requestorUrgency = null;
    }

    await this._executeRefresh(normalized);
  }

  /**
   * One-shot explicit refresh that bypasses the registration check and floor.
   * Cancels any pending debounce and immediately calls updatePlayerList().
   * Designed for consumers that need a single post-move verification refresh
   * without maintaining a registered periodic interest (e.g., TeamBalancer's
   * SwapExecutor after a scramble, or S3PluginBase._requestTeamChange).
   */
  async refreshNow(source) {
    const normalized = this._normalizeSource(source);

    // Cancel any pending debounce so we don't double-refresh.
    if (this._refreshState.debounceTimer) {
      clearTimeout(this._refreshState.debounceTimer);
      this._refreshState.debounceTimer = null;
      this._refreshState.requestorUrgency = null;
    }

    await this._executeRefresh(normalized);
  }

  recordMove(eosIDOrSteamID, targetTeamID, source, options = {}) {
    const id = this._normalizeIdentifier(eosIDOrSteamID);
    if (!id) return false;

    const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : this.attributionTtlMs;
    const expiresAt = Date.now() + Math.max(1, ttlMs);

    this.moveAttribution.set(id, {
      targetTeamID: Number(targetTeamID),
      source: source || 'Unknown',
      expiresAt
    });

    this.verboseLogger(3, `[Lock] Attribution recorded: key=${id}, target=${Number(targetTeamID)}, source=${source || 'Unknown'}, ttlMs=${ttlMs}`);

    return true;
  }

  canAct(eosIDOrSteamID, source) {
    this._cleanupExpiredState();

    const requester = this._normalizeSource(source);
    const requesterPriority = this._priorityOf(requester);

    if (this.globalLock && this.globalLock.source !== requester && this.globalLock.priority >= requesterPriority) {
      this.verboseLogger(2, `[Lock] canAct(${eosIDOrSteamID}, ${requester}) => false: blocked by global lock (holder=${this.globalLock.source}, priority=${this.globalLock.priority} >= ${requesterPriority})`);
      return false;
    }

    const key = this._resolvePlayerKey(eosIDOrSteamID) || this._normalizeIdentifier(eosIDOrSteamID);
    if (!key) return !this.globalLock;

    const held = this.playerLocks.get(key);
    if (!held) return true;
    if (held.source === requester) return true;

    this.verboseLogger(2, `[Lock] canAct(${key}, ${requester}) => false: locked by ${held.source} (priority=${held.priority} >= ${requesterPriority})`);
    return held.priority < requesterPriority;
  }

  lock(eosIDOrSteamID, source, ttlMs = this.defaultLockTtlMs) {
    this._cleanupExpiredState();

    const key = this._resolvePlayerKey(eosIDOrSteamID) || this._normalizeIdentifier(eosIDOrSteamID);
    if (!key) return false;

    const normalizedSource = this._normalizeSource(source);
    const requesterPriority = this._priorityOf(normalizedSource);

    if (this.globalLock && this.globalLock.source !== normalizedSource && this.globalLock.priority >= requesterPriority) {
      return false;
    }

    const existing = this.playerLocks.get(key);
    if (existing && existing.source !== normalizedSource && existing.priority >= requesterPriority) {
      return false;
    }

    const ttl = Math.max(1, ttlMs);
    this._setPlayerLock(key, normalizedSource, ttl);
    this.verboseLogger(2, `[Lock] Player lock acquired on ${key} by ${normalizedSource} (priority=${requesterPriority}, ttlMs=${ttl})`);
    return true;
  }

  unlock(eosIDOrSteamID, source) {
    const key = this._resolvePlayerKey(eosIDOrSteamID) || this._normalizeIdentifier(eosIDOrSteamID);
    if (!key) return false;

    const existing = this.playerLocks.get(key);
    if (!existing) return false;

    const normalizedSource = this._normalizeSource(source);
    if (existing.source !== normalizedSource) return false;

    this._clearPlayerLock(key);
    this.verboseLogger(2, `[Lock] Player lock released on ${key} by ${normalizedSource}`);
    return true;
  }

  lockGlobal(source, ttlMs = this.defaultLockTtlMs) {
    this._cleanupExpiredState();

    const normalizedSource = this._normalizeSource(source);
    const requesterPriority = this._priorityOf(normalizedSource);

    if (this.globalLock && this.globalLock.source !== normalizedSource && this.globalLock.priority >= requesterPriority) {
      this.verboseLogger(2, `[Lock] lockGlobal denied for ${normalizedSource}: already held by ${this.globalLock.source} (priority=${this.globalLock.priority} >= ${requesterPriority})`);
      return false;
    }

    const ttl = Math.max(1, ttlMs);
    this._setGlobalLock(normalizedSource, ttl);
    this.verboseLogger(1, `[Lock] Global lock acquired by ${normalizedSource} (priority=${requesterPriority}, ttlMs=${ttl})`);
    return true;
  }

  unlockGlobal(source) {
    if (!this.globalLock) return false;

    const normalizedSource = this._normalizeSource(source);
    if (this.globalLock.source !== normalizedSource) return false;

    this.verboseLogger(1, `[Lock] Global lock released by ${this.globalLock.source}`);
    this._clearGlobalLock();
    return true;
  }

  isLockedBy(eosIDOrSteamID) {
    this._cleanupExpiredState();
    const key = this._resolvePlayerKey(eosIDOrSteamID) || this._normalizeIdentifier(eosIDOrSteamID);
    if (!key) return null;
    return this.playerLocks.get(key)?.source || null;
  }

  isGloballyLockedBy() {
    this._cleanupExpiredState();
    return this.globalLock?.source || null;
  }

  async rememberReconnect(eosID, payload = {}) {
    await this._pruneReconnects();
    const key = this._normalizeIdentifier(eosID);
    if (!key) return false;

    const record = {
      eosID: key,
      steamID: payload.steamID || null,
      playerName: payload.playerName || null,
      lastTeamID: Number.isFinite(Number(payload.lastTeamID)) ? Number(payload.lastTeamID) : null,
      lastSeenAt: Number.isFinite(Number(payload.lastSeenAt)) ? Number(payload.lastSeenAt) : Date.now(),
      updatedAt: Date.now()
    };

    const dbService = this._getDbService();
    if (this.reconnectModel && dbService?.executeWithRetry) {
      await dbService.executeWithRetry(async () => {
        await this.reconnectModel.upsert(record);
      });
    }

    this._reconnectMemory.set(key, record);
    return true;
  }

  async getReconnect(eosID) {
    await this._pruneReconnects();
    const key = this._normalizeIdentifier(eosID);
    if (!key) return null;

    const dbService = this._getDbService();
    if (this.reconnectModel) {
      const row = await dbService?.executeWithRetry
        ? dbService.executeWithRetry(async () => this.reconnectModel.findByPk(key))
        : this.reconnectModel.findByPk(key);
      if (row) {
        const normalized = this._normalizeReconnectRow(row);
        if (this._isReconnectStale(normalized)) {
          await this._deleteReconnectRow(key);
          this._reconnectMemory.delete(key);
          return null;
        }
        this._reconnectMemory.set(key, normalized);
        return normalized;
      }
    }

    const cached = this._reconnectMemory.get(key) || null;
    if (cached && this._isReconnectStale(cached)) {
      this._reconnectMemory.delete(key);
      return null;
    }

    return cached;
  }

  async clearReconnects() {
    const dbService = this._getDbService();
    if (this.reconnectModel && dbService?.executeWithRetry) {
      await dbService.executeWithRetry(async () => {
        await this.reconnectModel.destroy({ where: {} });
      });
    }

    this._reconnectMemory.clear();
  }

  /**
   * Non-destructive reconnect lookup — returns the same data as getReconnect()
   * but does NOT delete the record. Multiple consumers can call this for the
   * same player without consuming it. Used internally to enrich S3_PLAYER_JOINED
   * payloads with previousTeamID so all listeners get the data without calling
   * the destructive getReconnect().
   *
   * Still respects staleness checks — returns null for stale/expired data without
   * removing the underlying record (bulk cleanup via prune handles that).
   */
  async peekReconnect(eosID) {
    await this._pruneReconnects();
    const key = this._normalizeIdentifier(eosID);
    if (!key) return null;

    const dbService = this._getDbService();
    if (this.reconnectModel) {
      const row = await dbService?.executeWithRetry
        ? dbService.executeWithRetry(async () => this.reconnectModel.findByPk(key))
        : this.reconnectModel.findByPk(key);
      if (row) {
        const normalized = this._normalizeReconnectRow(row);
        if (this._isReconnectStale(normalized)) {
          return null;
        }
        this._reconnectMemory.set(key, normalized);
        return normalized;
      }
    }

    const cached = this._reconnectMemory.get(key) || null;
    if (cached && this._isReconnectStale(cached)) {
      return null;
    }
    return cached || null;
  }

  async _checkReconnect(playerState) {
    // Fire-and-forget reconnect detection: check if this player was recently on the server.
    // If found, emit S3_PLAYER_RECONNECTED for consumers.
    const eosID = this._normalizeIdentifier(playerState?.eosID);
    if (!eosID) return;

    try {
      const reconnect = await this.getReconnect(eosID);
      // Guard: skip if reconnect has no valid team (null/0) or zero/absent lastSeenAt.
      // Corrupted pre-migration rows that survived the stale check with
      // lastSeenAt=0 and lastTeamID=null must not emit S3_PLAYER_RECONNECTED.
      if (reconnect && this._isRealTeam(reconnect.lastTeamID) && Number(reconnect.lastSeenAt) > 0) {
        const secondsAgo = ((Date.now() - Number(reconnect.lastSeenAt)) / 1000).toFixed(0);
        const playerName = playerState?.name || reconnect.playerName || eosID;
        this.verboseLogger(
          1,
          `[Players] RECONNECT: ${playerName} (eosID=${eosID}) lastSeen ${secondsAgo}s ago, prevTeam=${reconnect.lastTeamID}`
        );
        this.server.emit('S3_PLAYER_RECONNECTED', {
          player: { ...playerState, eosID },
          previousTeamID: reconnect.lastTeamID,
          disconnectedAt: reconnect.lastSeenAt,
          reconnectedAt: Date.now()
        });
      } else if (reconnect) {
        this.verboseLogger(2, `[Players] RECONNECT skipped for ${eosID}: lastTeamID=${reconnect.lastTeamID}, lastSeenAt=${reconnect.lastSeenAt} — corrupted/pre-migration data, will be pruned`);
      }
    } catch (err) {
      this.verboseLogger(1, `[Players] RECONNECT check error for ${eosID}: ${err.message}`);
    }
  }

  async handlePlayerConnected(data = {}) {
    this._cleanupExpiredState();
    await this._pruneReconnects();

    const now = Date.now();
    const player = data?.player || {};

    const rawPlayer = {
      eosID: player?.eosID || data?.eosID || null,
      steamID: player?.steamID || data?.steamID || null,
      name: player?.name || data?.name || 'Unknown',
      teamID: player?.teamID ?? null,
      squadID: player?.squadID ?? null
    };

    const playerName = rawPlayer.name;
    this.verboseLogger(1, `[Players] PLAYER_CONNECTED: ${playerName} (eosID=${rawPlayer.eosID}, steamID=${rawPlayer.steamID}, teamID=${rawPlayer.teamID})`);

    const result = this._registerPlayer(rawPlayer, now, {
      emitJoin: true,
      source: 'PLAYER_CONNECTED'
    });

    if (!result) return;

    if (result.isNew && result.state) {
      // Check for reconnect on first-time registration via PLAYER_CONNECTED
      await this._checkReconnect(result.state);
    }

    if (!result.isNew) {
      result.state.lastSeenAt = now;
    }

    // Notify connected subscribers
    if (result) {
      this._notifyPlayerConnected(result.state, result.isNew, result.previousTeamID);
    }
  }

  async handleUpdatedPlayerInfo() {
    this._cleanupExpiredState();
    await this._pruneReconnects();

    // Cancel any pending scheduled refresh — natural tick just provided fresh data.
    if (this._refreshState.debounceTimer) {
      clearTimeout(this._refreshState.debounceTimer);
      this._refreshState.debounceTimer = null;
      this._refreshState.requestorUrgency = null;
      this.verboseLogger(3, '[Players] Cancelled pending refresh — natural UPDATED_PLAYER_INFORMATION tick arrived.');
    }

    // Reset periodic timer clock: the natural tick counts as a full refresh.
    this._refreshState.lastRefreshTime = Date.now();

    const players = this.server.players || [];
    const now = Date.now();
    const current = new Set();
    const isInitialSync = !this._initialSyncComplete;
    // Players reporting a non-1/2 teamID who are still inside the grace window —
    // i.e. genuinely mid-resolve rather than stuck. Anyone past the window has
    // been quarantined and no longer holds the whole lobby hostage.
    const { blocking, keyed } = this._ageUnresolvedPlayers(players, now);
    const hasNullTeams = blocking.size > 0;
    // `keyed`, not players.length: a roster S³ could not key a single player
    // out of has resolved nothing, and must not be reported as settled.
    const allResolved = keyed > 0 && !hasNullTeams;
    let joinCount = 0;
    let leaveCount = 0;
    let teamChangeCount = 0;

    this.verboseLogger(2, `[Players] UPDATED_PLAYER_INFORMATION: ${players.length} server players, ${this.registry.size} tracked, initialSync=${isInitialSync}, hasNullTeams=${hasNullTeams}, stuck=${this._stuckKeys.size}`);

    for (const rawPlayer of players) {
      const result = this._registerPlayer(rawPlayer, now, {
        emitJoin: !isInitialSync,
        source: 'S3PlayersRegistry'
      });

      if (!result) continue;

      current.add(result.key);

      if (result.isNew) {
        joinCount++;

        // Check for reconnect on new player registration via tick diff
        if (!isInitialSync && result.state) {
          // Fire-and-forget reconnect check
          this._checkReconnect(result.state);
        }
      }

      if (isInitialSync || result.isNew) continue;

      const previousTeamID = result.previousTeamID;
      const nextTeamID = result.state.teamID;

      // ── Null-teamID projection gate ──
      // During the round-transition projection window, raw teamIDs are untrustworthy
      // (some players already report post-swap teams while others are still null).
      // Comparing pre-swap registry values against partially-resolved server data
      // produces false 1→2 / 2→1 floods. Suppress all S3_PLAYER_TEAM_CHANGED
      // emissions while projection is active (or on the first tick where null teams
      // appear but projection hasn't been built yet); genuine changes during this
      // window are deferred and emitted by _reconcileProjection() on tear-down.
      if (
        !hasNullTeams &&
        !this._projectedPlayers &&
        String(previousTeamID) !== String(nextTeamID) &&
        this._isRealTeam(previousTeamID) &&
        this._isRealTeam(nextTeamID)
      ) {
        teamChangeCount++;
        const attribution = this._consumeMoveAttribution(result.state, nextTeamID) || 'Manual/Game';
        const playerName = result.state.name || result.key;
        this.verboseLogger(1, `[Players] TEAM_CHANGE: ${playerName} (${result.key}) ${previousTeamID}→${nextTeamID}, source=${attribution}`);
        this.server.emit('S3_PLAYER_TEAM_CHANGED', {
          player: { ...result.state },
          previousTeamID,
          teamID: nextTeamID,
          source: attribution
        });
      }
    }

    if (isInitialSync) {
      for (const [key, tracked] of this.registry.entries()) {
        if (current.has(key)) continue;
        this.registry.delete(key);
        this._deindexPlayer(tracked, key);
      }

      // Mark all players registered during initial sync as having join emitted.
      // This prevents them from emitting S3_PLAYER_JOINED on the very next tick.
      for (const [key] of this.registry.entries()) {
        const state = this.registry.get(key);
        if (state && !state.joinEmitted) {
          state.joinEmitted = true;
        }
      }

      this._initialSyncComplete = true;
      // We still want projection readiness on the very first tick.
      this._refreshProjectionState({
        current,
        allResolved,
        hasNullTeams
      });

      // ── Session recovery ──
      // After initial sync populates the registry with all current server players,
      // hydrate their joinTime from S3_PlayerSessions (survives SquadJS restarts).
      // Fire-and-forget — errors are logged internally.
      this._recoverSessionTimes().catch((err) => {
        this.verboseLogger(1, `[Players] Session recovery error: ${err.message}`);
      });

      // Build ClansService tag cache from initial player sync (closed loop)
      if (this.parent?.services?.clans) {
        this.parent.services.clans.rebuildFromAllPlayers([...this.registry.values()]);
      }

      return;
    }

    // ── RCON Recovery Guard ──────────────────────────────────────────
    // When SquadJS's RCON socket drops and reconnects mid-game, SquadJS emits
    // RCON_ERROR events during the outage, then briefly serves empty/partial
    // server.players on the first tick after reconnect. The leave loop below
    // would delete all registry entries, causing mass false S3_PLAYER_JOINED
    // events on the next tick when the full player list repopulates.
    //
    // Detection: if RCON_ERROR fired within the recovery grace period, suppress
    // the leave loop. The registry stays intact, and _registerPlayer() will
    // recognize returning players as existing (team-change check) instead of
    // new (JOIN emitted). Players genuinely gone during the outage are cleaned
    // up once the grace period expires.
    const isRconRecovery = !isInitialSync
      && this._lastRconErrorTime > 0
      && (now - this._lastRconErrorTime) < this._rconRecoveryGraceMs;

    if (!isRconRecovery) {
      for (const [key, tracked] of this.registry.entries()) {
        if (current.has(key)) continue;

        this.registry.delete(key);
        this._deindexPlayer(tracked, key);

        leaveCount++;

        const playerName = tracked.name || key;
        this.verboseLogger(1, `[Players] Player LEFT: ${playerName} (eosID=${tracked.eosID}, steamID=${tracked.steamID}, teamID=${tracked.teamID})`);

        this.server.emit('S3_PLAYER_LEFT', {
          player: { ...tracked },
          source: 'S3PlayersRegistry'
        });

        // Remove from ClansService tag cache (closed loop)
        if (this.parent?.services?.clans) {
          this.parent.services.clans.removePlayerFromCache(tracked?.eosID);
        }

        // Fire-and-forget: remember this player for reconnect detection on return
        this.rememberReconnect(tracked.eosID, {
          steamID: tracked.steamID,
          playerName: tracked.name,
          lastTeamID: tracked.teamID,
          lastSeenAt: tracked.lastSeenAt || now
        });
      }
    } else {
      this.verboseLogger(
        1,
        `[Players] RCON recovery active — skipping leave detection (last RCON error ${Math.round((now - this._lastRconErrorTime) / 1000)}s ago, registry=${this.registry.size})`
      );
    }

    this._refreshProjectionState({
      current,
      allResolved,
      hasNullTeams
    });

    // Snapshot squad data when teams are resolved (metadata stable even during null-window)
    if (allResolved && this.server.squads) {
      this._squadsCache = [...this.server.squads];
    }

    // Store tick counts for notification payload
    this._lastTickJoinCount = joinCount;
    this._lastTickLeaveCount = leaveCount;
    this._lastTickTeamChangeCount = teamChangeCount;

    this.verboseLogger(2, `[Players] Tick: ${joinCount} joined, ${leaveCount} left, ${this.registry.size} tracked`);

    // ── Periodic session activity update ──
    // Bulk-update lastActivity for all tracked players every sessionUpdateIntervalMs.
    // This is fire-and-forget and does not block the tick.
    if (this.sessionModel && now - this._lastSessionActivityUpdate > this.sessionUpdateIntervalMs) {
      this._lastSessionActivityUpdate = now;
      this._bulkUpdateSessionActivity(now).catch((err) => {
        this.verboseLogger(2, `[Players] Session activity update failed: ${err.message}`);
      });
    }

    // Emit batch-complete signal for consumers
    this.server.emit('S3_PLAYERS_UPDATED', {
      joinCount,
      leaveCount,
      teamChangeCount,
      playerCount: this.registry.size,
      isInitialSync,
      projectionActive: !!this._projectedPlayers,
      source: 'S3PlayersRegistry'
    });

    // Notify data-changed subscribers after everything is committed
    this._notifyPlayerDataChanged();
  }

  _isRealTeam(teamID) {
    return teamID === 1 || teamID === 2;
  }

  /**
   * "Name (eosID)" where the registry knows the player, bare key otherwise.
   * A stuck-client log naming only an EOS ID is not actionable by an admin who
   * has to go find that player in game.
   */
  _describeKey(key) {
    const name = this.registry.get(key)?.name;
    return name ? `${name} (${key})` : key;
  }

  /**
   * How long a player may report an unreal teamID before being quarantined.
   *
   * Floored at three refresh ticks for the same reason the resolving deadline
   * is floored at four: the answer can only change on a tick, so a window
   * shorter than the cadence would quarantine players who simply have not been
   * looked at yet.
   */
  _unresolvedGraceWindowMs() {
    const tickMs = this.getEffectiveRefreshIntervalMs() || 0;
    return Math.max(this.unresolvedGraceMs, tickMs * 3);
  }

  /**
   * Age the unreal-teamID clock for every player on the server and return the
   * set of keys that should still block the roster-wide resolution gate.
   *
   * BUG HISTORY: `allResolved` used to be a flat `players.some(...)` over the
   * raw roster, so a SINGLE player whose client wedged at `Team ID: N/A` — one
   * did, stuck on the previous layer across a whole round — pinned it false
   * indefinitely. That froze `_lastStablePlayers` and `_squadsCache`, and, far
   * worse, suppressed S3_PLAYER_TEAM_CHANGED for EVERY player for the whole
   * round, blinding TeamBalancer, SmartAssign and Switch. `resolving` had a
   * deadline to escape on; this gate had none.
   *
   * The transient window that gate exists for is a property of the round
   * transition, where the roster goes null en masse and clears in seconds. So
   * quarantine is deliberately withheld while HALF OR MORE of the roster is
   * unreal: that shape is either a real transition or a systemic RCON/parse
   * failure, and in neither case should S³ declare teams resolved.
   */
  _ageUnresolvedPlayers(players, now) {
    const blocking = new Set();
    const seen = new Set();
    const unresolved = [];

    for (const raw of players) {
      const key = this._selectPlayerKey(raw);
      if (!key) continue;
      seen.add(key);

      if (this._isRealTeam(raw?.teamID)) {
        if (this._unresolvedSince.has(key)) {
          const entry = this._unresolvedSince.get(key);
          this._unresolvedSince.delete(key);
          this._stuckKeys.delete(key);
          if (entry.warned) {
            this.verboseLogger(1, `[Players] ${this._describeKey(key)} reports team ${raw.teamID} again after ${Math.round((now - entry.since) / 1000)}s stuck — back in the resolution gate.`);
          }
        }
        continue;
      }

      unresolved.push(key);
      if (!this._unresolvedSince.has(key)) {
        this._unresolvedSince.set(key, { since: now, warned: false });
      }
    }

    // Forget anyone who left, so a reconnect starts a fresh clock.
    for (const key of [...this._unresolvedSince.keys()]) {
      if (!seen.has(key)) {
        this._unresolvedSince.delete(key);
        this._stuckKeys.delete(key);
      }
    }
    for (const key of [...this._stuckKeys]) {
      if (!seen.has(key)) this._stuckKeys.delete(key);
    }

    // Mass-unresolved: a transition or a systemic failure, never one bad client.
    // Measured against the players S³ can actually key, not the raw list — a row
    // with neither ID is invisible to the registry, and counting it in the
    // denominator would drag the ratio down and quarantine people early.
    const systemic = unresolved.length * 2 >= seen.size;

    // Edge-triggered on purpose: this fires on every legitimate round
    // transition, and printing it per tick would bury it. What makes it worth
    // logging at all is the case it is NOT designed for — if this state is
    // entered and never left, quarantine can never engage, and this line is the
    // only evidence of why the resolution gate is still down.
    if (systemic !== this._systemicUnresolved) {
      this._systemicUnresolved = systemic;
      if (systemic && seen.size > 0) {
        this.verboseLogger(2, `[Players] ${unresolved.length}/${seen.size} players report no teamID — mass window (transition or RCON fault), quarantine withheld.`);
      } else if (!systemic) {
        this.verboseLogger(2, `[Players] Mass null-teamID window cleared — ${unresolved.length}/${seen.size} still unresolved.`);
      }
    }

    if (systemic) {
      if (unresolved.length > 0) this._stuckKeys.clear();
      return { blocking: new Set(unresolved), keyed: seen.size };
    }

    const grace = this._unresolvedGraceWindowMs();
    for (const key of unresolved) {
      const entry = this._unresolvedSince.get(key);
      if (now - entry.since < grace) {
        blocking.add(key);
        continue;
      }

      this._stuckKeys.add(key);
      if (!entry.warned) {
        entry.warned = true;
        this.verboseLogger(1, `[Players] ${this._describeKey(key)} has reported no teamID for ${Math.round((now - entry.since) / 1000)}s — treating as a stuck client and excluding it from the team-resolution gate. They usually need to reconnect.`);
      }
    }

    return { blocking, keyed: seen.size };
  }

  /**
   * Keys of players excluded from the resolution gate because their client is
   * wedged at teamID N/A. They are still tracked and still in the registry —
   * they just no longer speak for whether the lobby's teams are settled.
   */
  getStuckPlayerKeys() {
    return new Set(this._stuckKeys);
  }

  isPlayerStuck(key) {
    return this._stuckKeys.has(this._normalizeIdentifier(key));
  }

  _getActiveRegistry() {
    return this._projectedPlayers || this.registry;
  }

  // ---------------------------------------------------------------------------
  // Coalesced refresh manager — private helpers
  // ---------------------------------------------------------------------------

  async _executeRefresh(source) {
    this._refreshState.debounceTimer = null;
    this._refreshState.requestorUrgency = null;

    try {
      await this.server.updatePlayerList();
      this._refreshState.lastRefreshTime = Date.now();
      this.verboseLogger(2, `[Players] Refresh executed (source=${source})`);
    } catch (err) {
      this.verboseLogger(1, `[Players] Refresh failed (source=${source}): ${err.message}`);
      // Don't throw — handleUpdatedPlayerInfo won't have been called, but
      // we still track lastRefreshTime to avoid spamming retries.
    }
  }

  _recomputeEffectiveInterval() {
    const intervals = [...this._refreshState.registeredIntervals.values()];
    if (intervals.length === 0) {
      this._refreshState.effectiveInterval = null;
      this._stopPeriodicRefresh();
      return;
    }

    const minInterval = Math.min(...intervals);
    this._refreshState.effectiveInterval = Math.max(
      this.refreshMinIntervalMs,
      Math.min(minInterval, this.refreshMaxIntervalMs)
    );

    this._startPeriodicRefresh();
    this.verboseLogger(3, `[Players] Effective refresh interval: ${this._refreshState.effectiveInterval}ms (from ${intervals.length} registrant(s): [${intervals.join(', ')}])`);
  }

  _startPeriodicRefresh() {
    this._stopPeriodicRefresh();
    if (!this._refreshState.effectiveInterval) return;
    this._refreshState.periodicTimer = setInterval(async () => {
      await this._executeRefresh('S3Periodic');
    }, this._refreshState.effectiveInterval);
  }

  _stopPeriodicRefresh() {
    if (this._refreshState.periodicTimer) {
      clearInterval(this._refreshState.periodicTimer);
      this._refreshState.periodicTimer = null;
    }
    if (this._refreshState.debounceTimer) {
      clearTimeout(this._refreshState.debounceTimer);
      this._refreshState.debounceTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Null-teamID projection subsystem
  //
  // At round transition (NEW_GAME), RCON briefly serves teamID=null for some or
  // all players while teams re-establish (~30-90s). Instead of blocking all
  // join/assignment logic during this window, we serve a projected player list
  // built from the last stable snapshot, with teams flipped (1↔2) to match the
  // known round-transition swap. This design was originally specified in
  // DesignDocs/player-state-manager-design.md and was subsumed into PlayersService
  // during initial implementation (S³ uses one lifecycle, not a separate singleton).
  //
  // Flow:
  //   1. _refreshProjectionState() — called every UPDATED_PLAYER_INFORMATION tick.
  //      Decides whether to build, update, or tear down the projection.
  //   2. _snapshotRegistry() — copies the current registry as a stable baseline
  //      when all teamIDs are real (1/2). Used as the projection seed.
  //   3. _buildProjection(snapshot) — flips team 1↔2 on the stable snapshot to
  //      produce projected state representing post-swap reality.
  //   4. _syncProjection(currentKeys) — keeps projected state in sync with live
  //      data (names, squad IDs, new joiners) while the null window is active.
  //   5. _reconcileProjection() — when the null window resolves, logs mismatches
  //      between projected and actual teams for diagnostics. No corrective RCON
  //      commands are issued — log-only reconciliation.
  //
  // Key invariants:
  //   - getPlayer()/getAllPlayers() return projected data when projection is active
  //     (via _getActiveRegistry()), so callers are never exposed to null teamIDs.
  //   - _projectedPlayers is null when not in the projection window (fast path).
  //   - Team-change emissions are suppressed during the null window (both old/new
  //     team must be real before S3_PLAYER_TEAM_CHANGED fires).
  // ---------------------------------------------------------------------------

  _refreshProjectionState({ current, allResolved, hasNullTeams }) {
    // When we have a fully-resolved player list, cache it as a stable baseline.
    // This baseline is flipped when the null-teamID window appears after NEW_GAME.
    if (allResolved) {
      if (this._projectedPlayers) {
        this._reconcileProjection();
        this._projectedPlayers = null;
      }

      this._lastStablePlayers = this._snapshotRegistry();
    }

    // Only build projection once per resolving window, using the last stable snapshot.
    if (hasNullTeams && this._lastStablePlayers && !this._projectedPlayers) {
      this._projectedPlayers = this._buildProjection(this._lastStablePlayers);
      if (this._projectedPlayers.size) {
        this.verboseLogger(2, `[Players] Projection active for ${this._projectedPlayers.size} players.`);
      }
    }

    // Keep projected entries synced with the latest real data (names/squad IDs/joined players).
    if (this._projectedPlayers) {
      this._syncProjection(current);
    }

    return;
  }

  _snapshotRegistry() {
    // Copy to avoid mutating the stable snapshot while real registry updates continue.
    return new Map([...this.registry.entries()].map(([key, state]) => [key, { ...state }]));
  }

  _buildProjection(snapshot) {
    const projected = new Map();

    for (const [key, state] of snapshot.entries()) {
      if (!this._isRealTeam(state.teamID)) continue;

      // Flip teams 1 <-> 2 to match the known swap at round transition.
      const teamID = state.teamID === 1 ? 2 : 1;
      projected.set(key, { ...state, teamID });
    }

    return projected;
  }

  _syncProjection(currentKeys) {
    for (const key of currentKeys) {
      const registryState = this.registry.get(key);
      if (!registryState) continue;

      const projected = this._projectedPlayers.get(key);
      // New player during the null window: just inject their real teamID.
      if (!projected) {
        this._projectedPlayers.set(key, { ...registryState });
        continue;
      }

      projected.name = registryState.name;
      projected.eosID = registryState.eosID;
      projected.steamID = registryState.steamID;
      projected.squadID = registryState.squadID;
      projected.isLeader = registryState.isLeader;
      projected.lastSeenAt = registryState.lastSeenAt;

      // Overwrite projected team if the real team is resolved mid-window.
      if (this._isRealTeam(registryState.teamID)) {
        projected.teamID = registryState.teamID;
      }
    }

    // Remove projected players no longer present in the live registry.
    for (const key of this._projectedPlayers.keys()) {
      if (!currentKeys.has(key)) {
        this._projectedPlayers.delete(key);
      }
    }
  }

  _reconcileProjection() {
    // When the null window resolves, emit deferred S3_PLAYER_TEAM_CHANGED events
    // for any players whose actual team differs from the projected (flipped) team.
    // These represent genuine mid-window swaps — not the round-transition 1↔2 flip.
    //
    // We do NOT issue corrective RCON commands here; this is diagnostics + deferred
    // emission only. Projected-vs-actual matches (the common case) are silently correct.
    let deferredCount = 0;

    for (const [key, projected] of this._projectedPlayers.entries()) {
      const actual = this.registry.get(key);
      if (!actual || !this._isRealTeam(actual.teamID)) continue;

      if (String(projected.teamID) !== String(actual.teamID)) {
        const name = actual.name || projected.name || key;
        this.verboseLogger(
          2,
          `[Players Projection] ${name} projected team ${projected.teamID} -> actual ${actual.teamID}`
        );

        // Emit deferred team-change — this player genuinely swapped during the
        // projection window (not just the round-transition 1↔2 flip).
        this.server.emit('S3_PLAYER_TEAM_CHANGED', {
          player: { ...actual },
          previousTeamID: projected.teamID,
          teamID: actual.teamID,
          source: 'Deferred/Projection'
        });
        deferredCount++;
      }
    }

    if (deferredCount > 0) {
      this.verboseLogger(2, `[Players Projection] ${deferredCount} deferred TEAM_CHANGE(s) emitted.`);
    }
  }

  _toPlayerState(player, now, { joinEmitted = false } = {}) {
    return {
      eosID: player?.eosID || null,
      // steamID may be undefined/null for EOS-only players.
      steamID: player?.steamID || null,
      name: player?.name || 'Unknown',
      teamID: player?.teamID ?? null,
      squadID: player?.squadID ?? null,
      isLeader: normalizeIsLeader(player?.isLeader, false),
      joinTime: now,
      lastSeenAt: now,
      joinEmitted
    };
  }

  _selectPlayerKey(player) {
    const eosID = this._normalizeIdentifier(player?.eosID);
    if (eosID) return eosID;
    // Fallback for non-EOS identifiers (steamID can be undefined for EOS-only players).
    return this._normalizeIdentifier(player?.steamID);
  }

  _normalizeIdentifier(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).trim();
    return normalized || null;
  }

  /**
   * Register or update a custom priority level for a plugin source.
   * Allows third-party plugins to participate in the lock system without
   * hardcoding entries in the PRIORITY map. Existing hardcoded priorities
   * (TeamBalancer=3, SmartAssign=2, Switch=1) are unaffected — custom
   * registrations only apply to sources not already in PRIORITY.
   *
   * @param {string} source - Plugin/source name (e.g., 'MyPlugin')
   * @param {number} priority - Priority level (higher = more authority)
   */
  registerPriority(source, priority) {
    const normalized = this._normalizeSource(source);
    const level = Number.isFinite(priority) ? Math.max(0, priority) : 0;
    this._customPriorities.set(normalized, level);
    this.verboseLogger(2, `[Lock] Priority registered: ${normalized}=${level}`);
  }

  _normalizeSource(source) {
    return String(source || 'Unknown');
  }

  _priorityOf(source) {
    // Check hardcoded PRIORITY first, then custom registrations, fallback 0.
    return this.PRIORITY[source] ?? this._customPriorities.get(source) ?? 0;
  }

  _resolvePlayerKey(eosIDOrSteamID) {
    const id = this._normalizeIdentifier(eosIDOrSteamID);
    if (!id) return null;

    if (this.registry.has(id)) return id;
    if (this.steamIndex.has(id)) return this.steamIndex.get(id);
    return null;
  }

  _indexPlayer(playerState, key) {
    if (playerState?.steamID) {
      this.steamIndex.set(playerState.steamID, key);
    }
  }

  _deindexPlayer(playerState, key) {
    if (playerState?.steamID && this.steamIndex.get(playerState.steamID) === key) {
      this.steamIndex.delete(playerState.steamID);
    }
  }

  _consumeMoveAttribution(playerState, observedTeamID) {
    const now = Date.now();
    const keys = [
      this._normalizeIdentifier(playerState?.eosID),
      this._normalizeIdentifier(playerState?.steamID)
    ].filter(Boolean);

    for (const key of keys) {
      const recorded = this.moveAttribution.get(key);
      if (!recorded) continue;

      if (recorded.expiresAt <= now) {
        this.moveAttribution.delete(key);
        continue;
      }

      if (String(recorded.targetTeamID) === String(observedTeamID)) {
        this.moveAttribution.delete(key);
        return recorded.source;
      }
    }

    return null;
  }

  _cleanupExpiredState() {
    const now = Date.now();

    this._pruneReconnectMemory(now);

    for (const [id, attribution] of this.moveAttribution.entries()) {
      if (attribution.expiresAt <= now) {
        this.moveAttribution.delete(id);
      }
    }

    for (const [key, lock] of this.playerLocks.entries()) {
      if (lock.expiresAt <= now) {
        this._clearPlayerLock(key);
      }
    }

    if (this.globalLock && this.globalLock.expiresAt <= now) {
      this._clearGlobalLock();
    }
  }

  _registerPlayer(rawPlayer, now, { emitJoin = true, source = 'S3PlayersRegistry' } = {}) {
    const key = this._selectPlayerKey(rawPlayer);
    if (!key) return null;

    const state = this.registry.get(key);

    if (!state) {
      const joined = this._toPlayerState(rawPlayer, now, { joinEmitted: emitJoin });
      this.registry.set(key, joined);
      this._indexPlayer(joined, key);

      const playerName = joined.name || key;
      this.verboseLogger(1, `[Players] NEW player: ${playerName} (eosID=${joined.eosID}, steamID=${joined.steamID}, teamID=${joined.teamID}, source=${source})`);

      // ── Session row creation (Bug 2 fix) ──
      // Ensure every player in the registry has a S3_PlayerSessions row.
      // Previously, only _recoverSessionTimes() (post-initial-sync) wrote
      // session rows. Players joining after initial sync never got a row,
      // which broke _bulkUpdateSessionActivity (uses UPDATE, not UPSERT)
      // and prevented session recovery across restarts. Now we upsert on
      // first detection so the row always exists.
      if (joined.eosID && this.sessionModel) {
        this._upsertSessionRow(joined.eosID, joined.steamID, playerName, joined.joinTime || now, now).catch((err) => {
          this.verboseLogger(2, `[Players] Session row upsert failed for ${playerName}: ${err.message}`);
        });
      }

      if (emitJoin) {
        // Synchronous in-memory peek for reconnect data to provide previousTeamID
        // in the join payload. Only checks the in-memory cache (prune already ran
        // before _registerPlayer is called), avoiding an async DB lookup.
        const reconnectInfo = this._reconnectMemory.get(key) || null;
        let previousTeamID = this._isRealTeam(reconnectInfo?.lastTeamID) ? reconnectInfo.lastTeamID : null;

        // Cross-round reconnect: if the disconnect predates the current round,
        // teams have swapped sides (1↔2). Flip the reconnect team to match.
        if (previousTeamID && reconnectInfo?.lastSeenAt) {
          const gs = this.parent?.services?.gameState;
          const roundStart = gs?.getRoundStartTime?.();
          if (roundStart && reconnectInfo.lastSeenAt < roundStart) {
            previousTeamID = previousTeamID === 1 ? 2 : 1;
            this.verboseLogger(2, `[Players] Cross-round reconnect flip: ${playerName} team ${reconnectInfo.lastTeamID} → ${previousTeamID}`);
          }
        }

        this.server.emit('S3_PLAYER_JOINED', {
          player: { ...joined },
          previousTeamID,
          source
        });

        // Update ClansService tag cache incrementally (closed loop)
        if (this.parent?.services?.clans) {
          this.parent.services.clans.addPlayerToCache(joined.eosID, joined.name);
        }

        this.verboseLogger(1, `[Players] JOIN emitted: ${playerName} (eosID=${joined.eosID}, teamID=${joined.teamID}, source=${source})`);
      }

      return {
        key,
        state: joined,
        previousTeamID: null,
        isNew: true
      };
    }

    const previousTeamID = state.teamID;
    const previousName = state.name;

    state.name = rawPlayer?.name || state.name;
    state.teamID = rawPlayer?.teamID ?? null;
    state.squadID = rawPlayer?.squadID ?? state.squadID;
    state.eosID = rawPlayer?.eosID || state.eosID;
    state.steamID = rawPlayer?.steamID || state.steamID;
    // Leadership is per-tick state, not join-time state: a player connects as a
    // non-leader and only becomes SL later, and can be demoted at any point.
    // Omitting this line pinned isLeader to whatever it was on the tick the
    // player was first registered — which for anyone who joined and *then* made
    // a squad meant a permanent false, so getSquads() sorted them as a grunt and
    // `!s3 players` never crowned them. PLAYER_CONNECTED carries no isLeader at
    // all, hence the undefined-means-keep guard rather than a bare `??`.
    state.isLeader = normalizeIsLeader(rawPlayer?.isLeader, state.isLeader);
    state.lastSeenAt = now;

    // Refresh the ClansService tag cache when a name change lands after the
    // player's initial registration. A clan tag is resolved server-side and
    // often isn't present yet on PLAYER_CONNECTED's name — it can land a
    // few RCON polls later — but addPlayerToCache() only ever ran once, at
    // that first (possibly tagless) name. Without this, a player whose tag
    // arrived late stayed invisible to clan grouping for their whole
    // session. Gated on an actual name change so this doesn't re-run the
    // cache's corroboration scan on every tick for every unchanged player.
    //
    // Squad's own in-game clan-tag system prepends the tag onto the
    // already-visible name a few seconds after it resolves, producing one of
    // three observable transitions (see docs/clan-tag-confirmation-rework.md
    // §2): append (tag arrives — old name is a trailing run of tokens of the
    // new name), shrink (tag removed — new name is a trailing run of tokens
    // of the old name), or swap (tag changed directly — same token count,
    // only the leading token differs, every other token matches exactly).
    // These are ground truth, not a shape guess, so they're recorded as
    // "confirmed" tags that corroborate other players' low-confidence
    // extractions of the same tag. Token-based comparison (not raw-character
    // endsWith) is required — a character-level suffix check misclassifies
    // swaps whose old/new leading tokens happen to share a trailing
    // character (e.g. "meep"/"moop").
    if (state.eosID && rawPlayer?.name && rawPlayer.name !== previousName && this.parent?.services?.clans) {
      const clans = this.parent.services.clans;
      const oldTokens = (previousName || '').trim().split(/\s+/).filter(Boolean);
      const newTokens = rawPlayer.name.trim().split(/\s+/).filter(Boolean);

      const isSuffixOf = (shorter, longer) =>
        shorter.length > 0 && longer.length > shorter.length &&
        shorter.every((tok, i) => tok === longer[longer.length - shorter.length + i]);

      if (isSuffixOf(oldTokens, newTokens)) {
        // Append: tag arrived. old name is preserved as a trailing run of tokens.
        const confirmedRaw = newTokens.slice(0, newTokens.length - oldTokens.length).join(' ');
        if (confirmedRaw) clans.recordConfirmedTag(state.eosID, confirmedRaw);
      } else if (isSuffixOf(newTokens, oldTokens)) {
        // Shrink: tag removed. new name is preserved as a trailing run of tokens.
        clans.clearConfirmedTag(state.eosID);
      } else if (
        oldTokens.length > 1 &&
        oldTokens.length === newTokens.length &&
        oldTokens[0] !== newTokens[0] &&
        oldTokens.slice(1).every((tok, i) => tok === newTokens[i + 1])
      ) {
        // Swap: same token count, only the leading token differs, every other
        // token matches exactly (the base name is unchanged). Treat the new
        // leading token as a new confirmed tag. No further length/shape
        // gating on the TAG itself, but the base-name-must-match requirement
        // is NOT optional: without it this branch would also fire on
        // unrelated renames that share no trailing tokens at all.
        // oldTokens.length > 1 excludes single-token names, which have no
        // base name to anchor a swap against.
        clans.recordConfirmedTag(state.eosID, newTokens[0]);
      }

      clans.addPlayerToCache(state.eosID, rawPlayer.name);
    }

    this._indexPlayer(state, key);

    if (emitJoin && !state.joinEmitted) {
      const reconnectInfo = this._reconnectMemory.get(key) || null;
      let previousTeamID = this._isRealTeam(reconnectInfo?.lastTeamID) ? reconnectInfo.lastTeamID : null;

      // Cross-round reconnect: if the disconnect predates the current round,
      // teams have swapped sides (1↔2). Flip the reconnect team to match.
      if (previousTeamID && reconnectInfo?.lastSeenAt) {
        const gs = this.parent?.services?.gameState;
        const roundStart = gs?.getRoundStartTime?.();
        if (roundStart && reconnectInfo.lastSeenAt < roundStart) {
          previousTeamID = previousTeamID === 1 ? 2 : 1;
          const playerName = state.name || key;
          this.verboseLogger(2, `[Players] Cross-round reconnect flip: ${playerName} team ${reconnectInfo.lastTeamID} → ${previousTeamID}`);
        }
      }

      this.server.emit('S3_PLAYER_JOINED', {
        player: { ...state },
        previousTeamID,
        source
      });
      state.joinEmitted = true;
      const playerName = state.name || key;
      this.verboseLogger(1, `[Players] JOIN emitted (returning): ${playerName} (eosID=${state.eosID}, teamID=${state.teamID}, source=${source})`);
    }

    return {
      key,
      state,
      previousTeamID,
      isNew: false
    };
  }

  _pruneReconnectMemory(now = Date.now()) {
    const cutoff = now - this.reconnectMaxAgeMs;

    for (const [key, record] of this._reconnectMemory.entries()) {
      const updatedAt = Number(record?.updatedAt) || Number(record?.lastSeenAt) || 0;
      if (updatedAt < cutoff) {
        this._reconnectMemory.delete(key);
      }
    }
  }

  _isReconnectStale(record, now = Date.now()) {
    if (!record) return true;
    const updatedAt = Number(record?.updatedAt) || Number(record?.lastSeenAt) || 0;
    if (!updatedAt) return true;
    return updatedAt < (now - this.reconnectMaxAgeMs);
  }

  async _deleteReconnectRow(eosID) {
    const dbService = this._getDbService();
    if (!this.reconnectModel || !dbService?.executeWithRetry) return;

    await dbService.executeWithRetry(async () => {
      await this.reconnectModel.destroy({ where: { eosID } });
    });
  }

  async _pruneReconnects(now = Date.now(), { force = false } = {}) {
    this._pruneReconnectMemory(now);

    const dbService = this._getDbService();
    if (!this.reconnectPersistence || !this.reconnectModel || !dbService) return;

    if (!force && this._lastReconnectPruneAt) {
      if ((now - this._lastReconnectPruneAt) < this.reconnectPruneIntervalMs) return;
    }

    this._lastReconnectPruneAt = now;
    const cutoff = now - this.reconnectMaxAgeMs;

    const connector = dbService.getConnector?.();
    if (connector && typeof connector.query === 'function') {
      try {
        await dbService.executeWithRetry(async () => {
          await connector.query(
            `DELETE FROM ${dbService.quoteIdentifier('S3_PlayerReconnects')} ` +
            `WHERE ${dbService.quoteIdentifier('updatedAt')} < :cutoff`,
            { replacements: { cutoff } }
          );
        });
      } catch (err) {
        this.verboseLogger(1, `[Players] Failed pruning reconnect DB rows: ${err.message}`);
      }
      return;
    }

    const Op =
      this.reconnectModel?.sequelize?.constructor?.Op ||
      this.reconnectModel?.sequelize?.Sequelize?.Op ||
      dbService.getConnector?.()?.constructor?.Sequelize?.Op ||
      dbService.getConnector?.()?.Sequelize?.Op ||
      null;
    if (!Op) {
      this.verboseLogger(1, '[Players] Skipping reconnect DB prune: Sequelize Op not available.');
      return;
    }

    try {
      await dbService.executeWithRetry(async () => {
        await this.reconnectModel.destroy({ where: { updatedAt: { [Op.lt]: cutoff } } });
      });
    } catch (err) {
      this.verboseLogger(1, `[Players] Failed pruning reconnect DB rows: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Session tracking — S3_PlayerSessions table
  //
  // The S3_PlayerSessions table persists per-player sessionStart timestamps
  // across SquadJS restarts. This allows consumer plugins (Switch, EloTracker)
  // to answer "how long has this player been on the server?" even after a
  // restart, preventing the time-based switch window from falsely resetting.
  //
  // Lifecycle:
  //   1. Player first detected (never seen before, or 30+ min gap since last activity)
  //      → INSERT sessionStart = Date.now(), lastActivity = Date.now()
  //   2. Player still on server (periodic tick)
  //      → UPDATE lastActivity = Date.now() (every sessionUpdateIntervalMs)
  //   3. Player leaves, returns within 30 min
  //      → Keep sessionStart unchanged (recovery path)
  //   4. Player away 30+ min
  //      → Next detection: sessionStart = Date.now() (fresh session)
  //   5. SquadJS restart mid-round
  //      → _recoverSessionTimes() hydrates registry joinTime from DB
  // ---------------------------------------------------------------------------

  /**
   * Initialize the S3_PlayerSessions model definition (the v2 table migration is
   * registered and run in _initReconnectPersistence() alongside v1, so both
   * "s3-players" migrations are applied in a single call — avoiding duplicate logs).
   */
  async _initSessionPersistence() {
    const dbService = this._getDbService();
    if (!dbService) return;

    const connector = dbService.getConnector?.();
    if (!connector) return;

    // Bootstrap DDL — ensures S3_PlayerSessions exists unconditionally at mount.
    // Infrastructure table, not a migration — no confirmation needed.
    const q = (id) => dbService.quoteIdentifier(id);
    await connector.query(sessionsTableDDL(q));

    // Clean up stale session rows (>24h inactive). These are never used for
    // session recovery — _recoverSessionTimes() treats anything >30min as stale.
    // Mount-time cleanup is sufficient; no periodic timer needed.
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      await connector.query(
        `DELETE FROM ${q('S3_PlayerSessions')} WHERE ${q('lastActivity')} < :cutoff`,
        { replacements: { cutoff } }
      );
      this.verboseLogger(3, `[Players] Session cleanup: removed rows with lastActivity < ${new Date(cutoff).toISOString()}`);
    } catch (err) {
      this.verboseLogger(2, `[Players] Session cleanup failed (non-fatal): ${err.message}`);
    }

    this.sessionModel = dbService.defineModel?.(
      'S3_PlayerSession',
      {
        eosID: {
          type: dbService.getDataTypes().STRING,
          primaryKey: true
        },
        steamID: {
          type: dbService.getDataTypes().STRING,
          allowNull: true
        },
        playerName: {
          type: dbService.getDataTypes().STRING,
          allowNull: true
        },
        sessionStart: {
          type: dbService.getDataTypes().BIGINT,
          allowNull: false
        },
        lastActivity: {
          type: dbService.getDataTypes().BIGINT,
          allowNull: false
        }
      },
      {
        tableName: 'S3_PlayerSessions',
        timestamps: false,
        // Session start times are rebuilt from live play on the next tick, and
        // stale rows are pruned by the cleanup above.
        exportTier: 'ephemeral'
      }
    ) || null;
  }

  /**
   * Recover session times from S3_PlayerSessions after initial sync.
   * Called once after _initialSyncComplete is set to true.
   *
   * For each player in the registry:
   *   - If DB row exists and lastActivity is within sessionExpiryMs →
   *     adopt sessionStart as joinTime
   *   - If DB row exists but is stale →
   *     write new sessionStart = now, keep joinTime = now
   *   - If no DB row →
   *     write new sessionStart = now, keep joinTime from initial sync
   */
  async _recoverSessionTimes() {
    if (!this.sessionModel) return;
    const dbService = this._getDbService();
    if (!dbService?.executeWithRetry) return;

    const now = Date.now();
    const expiryCutoff = now - this.sessionExpiryMs;
    const registryPlayers = [...this.registry.entries()];
    const eosIDs = registryPlayers.map(([, p]) => p.eosID).filter(Boolean);

    if (eosIDs.length === 0) return;

    // Fetch all session rows for currently tracked players.
    let dbRows = [];
    try {
      dbRows = await dbService.executeWithRetry(async () => {
        const Op = this.sessionModel?.sequelize?.constructor?.Op ||
          this.sessionModel?.sequelize?.Sequelize?.Op ||
          dbService.getConnector?.()?.constructor?.Sequelize?.Op ||
          null;
        if (Op) {
          return await this.sessionModel.findAll({
            where: { eosID: { [Op.in]: eosIDs } }
          });
        }
        // Fallback: fetch one by one if Op not available.
        const results = [];
        for (const eosID of eosIDs) {
          const row = await this.sessionModel.findByPk(eosID);
          if (row) results.push(row);
        }
        return results;
      });
    } catch (err) {
      this.verboseLogger(1, `[Players] Session recovery DB query failed: ${err.message}`);
      return;
    }

    // Build lookup map: eosID -> { sessionStart, lastActivity }
    const sessionMap = new Map();
    for (const row of dbRows) {
      const plain = typeof row.toJSON === 'function' ? row.toJSON() : row;
      if (plain.eosID) {
        sessionMap.set(plain.eosID, {
          sessionStart: Number(plain.sessionStart) || 0,
          lastActivity: Number(plain.lastActivity) || 0
        });
      }
    }

    this.verboseLogger(2, `[Players] Session recovery: ${registryPlayers.length} players, ${sessionMap.size} DB rows`);

    const upsertOps = [];

    for (const [key, state] of registryPlayers) {
      // Only update if we have an eosID (primary key for sessions table).
      if (!state.eosID) continue;

      const existing = sessionMap.get(state.eosID);

      if (existing) {
        if (existing.lastActivity >= expiryCutoff) {
          // Session is still active — adopt stored sessionStart as joinTime.
          state.joinTime = existing.sessionStart;
          this.verboseLogger(3, `[Players] Recovered session for ${state.name || key}: start=${new Date(existing.sessionStart).toISOString()}, lastActivity=${new Date(existing.lastActivity).toISOString()}`);
        } else {
          // Session is stale (inactive > sessionExpiryMs) — start fresh.
          state.joinTime = now;
          upsertOps.push({
            eosID: state.eosID,
            steamID: state.steamID || null,
            playerName: state.name || null,
            sessionStart: now,
            lastActivity: now
          });
          this.verboseLogger(2, `[Players] Stale session for ${state.name || key}: lastActivity=${new Date(existing.lastActivity).toISOString()} > ${this.sessionExpiryMs}ms ago, starting fresh`);
        }
      } else {
        // No DB row — first time seeing this player. Write new session.
        upsertOps.push({
          eosID: state.eosID,
          steamID: state.steamID || null,
          playerName: state.name || null,
          sessionStart: state.joinTime || now,
          lastActivity: now
        });
        this.verboseLogger(3, `[Players] New session for ${state.name || key}: joinTime=${new Date(state.joinTime).toISOString()}`);
      }
    }

    // Write new/updated sessions in batch.
    if (upsertOps.length > 0) {
      try {
        await dbService.executeWithRetry(async () => {
          for (const op of upsertOps) {
            await this.sessionModel.upsert(op);
          }
        });
        this.verboseLogger(2, `[Players] Session recovery: upserted ${upsertOps.length} rows`);
      } catch (err) {
        this.verboseLogger(1, `[Players] Session recovery upsert failed: ${err.message}`);
      }
    }
  }

  /**
   * Upsert a single session row (used by _registerPlayer on first detection
   * and by _recoverSessionTimes for batch recovery). Fire-and-forget from
   * _registerPlayer; awaited in _recoverSessionTimes.
   */
  async _upsertSessionRow(eosID, steamID, playerName, sessionStart, lastActivity) {
    if (!this.sessionModel) return;
    const dbService = this._getDbService();
    if (!dbService?.executeWithRetry) return;

    await dbService.executeWithRetry(async () => {
      await this.sessionModel.upsert({
        eosID,
        steamID: steamID || null,
        playerName: playerName || null,
        sessionStart,
        lastActivity
      });
    });
  }

  /**
   * Bulk-update lastActivity for all tracked players.
   * This runs periodically (every sessionUpdateIntervalMs) to keep the
   * session expiry window accurate for disconnect-during-restart scenarios.
   * Fire-and-forget — errors are logged internally.
   */
  async _bulkUpdateSessionActivity(now = Date.now()) {
    if (!this.sessionModel) return;
    const dbService = this._getDbService();
    if (!dbService?.executeWithRetry) return;

    const players = [...this.registry.values()].filter(p => p.eosID);
    if (players.length === 0) return;

    try {
      const eosIDs = players.map(p => p.eosID);
      const Op = this.sessionModel?.sequelize?.constructor?.Op ||
        this.sessionModel?.sequelize?.Sequelize?.Op ||
        dbService.getConnector?.()?.constructor?.Sequelize?.Op ||
        null;

      if (Op) {
        await dbService.executeWithRetry(async () => {
          await this.sessionModel.update(
            { lastActivity: now },
            { where: { eosID: { [Op.in]: eosIDs } } }
          );
        });
      } else {
        // Fallback: update one by one.
        await dbService.executeWithRetry(async () => {
          for (const p of players) {
            await this.sessionModel.update(
              { lastActivity: now },
              { where: { eosID: p.eosID } }
            );
          }
        });
      }
      this.verboseLogger(3, `[Players] Session activity updated for ${players.length} players`);
    } catch (err) {
      this.verboseLogger(2, `[Players] Session activity bulk update failed: ${err.message}`);
    }
  }

  _setPlayerLock(key, source, ttlMs) {
    this._clearPlayerLock(key);

    const expiresAt = Date.now() + ttlMs;
    const timeout = setTimeout(() => {
      this._clearPlayerLock(key);
    }, ttlMs);

    this.playerLocks.set(key, {
      source,
      priority: this._priorityOf(source),
      expiresAt,
      timeout
    });

    this.server.emit('S3_PLAYER_LOCK_CHANGED', {
      key,
      source,
      locked: true,
      expiresAt
    });
  }

  _clearPlayerLock(key) {
    const existing = this.playerLocks.get(key);
    if (!existing) return;

    if (existing.timeout) {
      clearTimeout(existing.timeout);
    }

    this.playerLocks.delete(key);
    this.verboseLogger(2, `[Lock] Player lock on ${key} expired (source=${existing.source})`);
    this.server.emit('S3_PLAYER_LOCK_CHANGED', {
      key,
      source: existing.source,
      locked: false,
      expiresAt: null
    });
  }

  _setGlobalLock(source, ttlMs) {
    this._clearGlobalLock();

    const expiresAt = Date.now() + ttlMs;
    const timeout = setTimeout(() => {
      this._clearGlobalLock();
    }, ttlMs);

    this.globalLock = {
      source,
      priority: this._priorityOf(source),
      expiresAt,
      timeout
    };

    this.server.emit('S3_GLOBAL_LOCK_CHANGED', {
      source,
      locked: true,
      expiresAt
    });
  }

  _clearGlobalLock() {
    if (!this.globalLock) return;

    const previous = this.globalLock;
    if (previous.timeout) {
      clearTimeout(previous.timeout);
    }

    this.verboseLogger(2, `[Lock] Global lock ${this.globalLock.source === previous.source ? 'expired' : 'cleared'} (source=${previous.source})`);
    this.globalLock = null;
    this.server.emit('S3_GLOBAL_LOCK_CHANGED', {
      source: previous.source,
      locked: false,
      expiresAt: null
    });
  }

  async _initReconnectPersistence() {
    const dbService = this._getDbService();
    if (!this.reconnectPersistence || !dbService) return;

    const connector = dbService.getConnector?.();
    if (!connector) return;

    // ── Bootstrap DDL ───────────────────────────────────────────────
    // Infrastructure table — DDL runs unconditionally at mount so the
    // table always exists before any query. No confirmation needed.
    // The migration registration below also runs idempotent DDL through
    // the migration engine's query interface so verification passes on
    // fresh databases (see NOTE below for details).
    await connector.query(reconnectsTableDDL((id) => dbService.quoteIdentifier(id)));

    // ── Migration registration ─────────────────────────────────────
    // NOTE: The bootstrap DDL above (connector.query) creates tables before
    // defineModel runs, ensuring the table exists for Sequelize model sync.
    // However, the migration engine's verification step uses dbService.sequelize
    // (a different connection than connector.query), which can cause a visibility
    // race on fresh SQLite databases — the verification's showAllTables() may not
    // see the table created by the raw connector query.
    //
    // To fix this, each migration's up() ALSO runs CREATE TABLE IF NOT EXISTS
    // through the qi.rawQuery() interface (same Sequelize connection the verifier
    // reads from). This is idempotent — safe whether the bootstrap DDL already
    // created the table or not. The engine's duplicate-registration guard prevents
    // re-registration on subsequent mounts.
    if (dbService.migrationEngine) {
      dbService.migrationEngine.registerMigrations('s3-players', [
        {
          version: 1,
          description: 'S3_PlayerReconnects table (bootstrap — DDL runs unconditionally at mount)',
          touches: {
            creates: ['S3_PlayerReconnects'],
            columns: {
              S3_PlayerReconnects: ['eosID', 'steamID', 'playerName', 'lastTeamID', 'lastSeenAt', 'updatedAt']
            }
          },
          up: async (qi) => {
            // Run through qi so verification sees the table on the same connection.
            // Idempotent — safe if bootstrap DDL already created it.
            await qi.rawQuery(reconnectsTableDDL((id) => dbService.quoteIdentifier(id)));
          }
        },
        {
          version: 2,
          description: 'S3_PlayerSessions table (bootstrap — DDL runs unconditionally at mount)',
          touches: {
            creates: ['S3_PlayerSessions'],
            columns: {
              S3_PlayerSessions: ['eosID', 'steamID', 'playerName', 'sessionStart', 'lastActivity']
            }
          },
          up: async (qi) => {
            // Run through qi so verification sees the table on the same connection.
            // Idempotent — safe if bootstrap DDL already created it.
            await qi.rawQuery(sessionsTableDDL((id) => dbService.quoteIdentifier(id)));
          }
        }
      ]);
    }

    // ── Register expected version ──────────────────────────────────
    // Makes s3-players visible in !s3 migrate status / pending.
    // Safe to call unconditionally — overwrites same value on re-mount.
    dbService.registerExpectedVersion('s3-players', 2, {
      models: ['S3PlayerReconnect', 'S3_PlayerSession']
    });

    // ── Define Sequelize model ─────────────────────────────────────
    // Runs AFTER bootstrap DDL so the table exists before defineModel.
    // tableName updated to S3_PlayerReconnects for consistency with other S³ tables.
    this.reconnectModel = dbService.defineModel?.(
      'S3PlayerReconnect',
      {
        eosID: {
          type: dbService.getDataTypes().STRING,
          primaryKey: true
        },
        steamID: {
          type: dbService.getDataTypes().STRING,
          allowNull: true
        },
        playerName: {
          type: dbService.getDataTypes().STRING,
          allowNull: true
        },
        lastTeamID: {
          type: dbService.getDataTypes().INTEGER,
          allowNull: true
        },
        lastSeenAt: {
          type: dbService.getDataTypes().BIGINT,
          allowNull: true
        },
        updatedAt: {
          type: dbService.getDataTypes().BIGINT,
          allowNull: false
        }
      },
      {
        tableName: 'S3_PlayerReconnects',
        timestamps: false,
        // Reconnect memory — repopulated from live play, and entries expire on
        // their own.
        exportTier: 'ephemeral'
      }
    ) || null;
  }

  _normalizeReconnectRow(row) {
    if (!row) return null;
    const plain = typeof row.toJSON === 'function' ? row.toJSON() : row;
    return {
      eosID: plain.eosID,
      steamID: plain.steamID ?? null,
      playerName: plain.playerName ?? null,
      lastTeamID: plain.lastTeamID ?? null,
      lastSeenAt: plain.lastSeenAt ?? null,
      updatedAt: plain.updatedAt ?? null
    };
  }

  _getDbService() {
    return this.parent?.services?.db || null;
  }
}