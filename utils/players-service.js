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
 *   Refresh:      registerRefreshInterest(), unregisterRefreshInterest(),
 *                 requestRefresh(), refreshNow()
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
 * - Lock priority ordering: TeamBalancer(3) > SmartAssign(2) > Switch(1).
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
const DEFAULT_RECONNECT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const DEFAULT_RECONNECT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_REFRESH_MIN_INTERVAL_MS = 3000;   // hard floor — no faster than 3s between RCON calls
const DEFAULT_REFRESH_MAX_INTERVAL_MS = 60000;   // hard ceiling — natural SquadJS tick rate
const DEFAULT_REFRESH_DEBOUNCE_WINDOW_MS = 250; // coalesce window for requestRefresh()
const DEFAULT_REFRESH_NOW_FLOOR_MS = 1000;      // minimum gap for refreshNow() before re-calling RCON

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
    refreshNowFloorMs = DEFAULT_REFRESH_NOW_FLOOR_MS
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

    this._migrationRegistered = false;
    this._isMounted = false;
    this._initialSyncComplete = false;
    // Snapshot of the last fully-resolved team list. Used to build projections when teamIDs go null.
    this._lastStablePlayers = null;
    // Active projection map when we detect the null-teamID window after NEW_GAME.
    this._projectedPlayers = null;
    // Snapshot of this.server.squads (raw SquadJS squad objects), refreshed each tick
    // when teams are fully resolved. Used by getSquads() to serve full squad metadata.
    this._squadsCache = null;

    this.PRIORITY = {
      TeamBalancer: 3,
      SmartAssign: 2,
      Switch: 1
    };

    // ---------------------------------------------------------------------------
    // Coalesced refresh manager
    //
    // Provides debounced requestRefresh() (fire-and-forget, coalesces burst calls)
    // and refreshNow() (awaitable, respects 1s floor). Consumers register their
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

    this._isMounted = true;
    this._initialSyncComplete = false;

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

    for (const lock of this.playerLocks.values()) {
      if (lock?.timeout) clearTimeout(lock.timeout);
    }
    this.playerLocks.clear();

    if (this.globalLock?.timeout) clearTimeout(this.globalLock.timeout);
    this.globalLock = null;

    this._isMounted = false;
    this._initialSyncComplete = false;
    this.verboseLogger(2, '[Players] Unmounted.');
  }

  isReady() {
    return this._isMounted;
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

  getSquads() {
    // Returns cached SquadJS squad objects enriched with leader-first player lists.
    // Array of { squadID, teamID, squadName, locked (bool), players: eosID[] }
    const squads = this._squadsCache || [];
    const active = this._getActiveRegistry();

    // Build squadID -> { leaders[], members[] } from player registry
    const bySquad = new Map();
    for (const [, p] of active) {
      if (p.squadID == null) continue;
      if (!bySquad.has(p.squadID)) {
        bySquad.set(p.squadID, { leaders: [], members: [] });
      }
      const entry = bySquad.get(p.squadID);
      if (p.isLeader) {
        entry.leaders.push(p.eosID);
      } else {
        entry.members.push(p.eosID);
      }
    }

    return squads
      .map((s) => ({
        squadID: s.squadID,
        teamID: s.teamID,
        squadName: s.squadName,
        locked: s.locked === 'True' || s.locked === true,
        players: bySquad.has(s.squadID)
          ? [...bySquad.get(s.squadID).leaders, ...bySquad.get(s.squadID).members]
          : []
      }))
      .filter((s) => s.players.length > 0);
  }

  areTeamsResolved() {
    const players = [...this.registry.values()];
    if (!players.length) return false;
    return players.every((player) => player?.teamID === 1 || player?.teamID === 2);
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

  async refreshNow(source) {
    const normalized = this._normalizeSource(source);
    if (!this._refreshState.registeredIntervals.has(normalized)) return;

    const now = Date.now();
    const elapsed = now - this._refreshState.lastRefreshTime;
    if (elapsed < this.refreshNowFloorMs) {
      this.verboseLogger(3, `[Players] refreshNow skipped: ${elapsed}ms since last (floor=${this.refreshNowFloorMs}ms)`);
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
      if (reconnect) {
        const secondsAgo = ((Date.now() - (Number(reconnect.lastSeenAt) || 0)) / 1000).toFixed(0);
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
    // If any player reports a non-1/2 teamID, we are in the null-teamID window.
    const hasNullTeams = players.some((player) => !this._isRealTeam(player?.teamID));
    const allResolved = players.length > 0 && !hasNullTeams;
    let joinCount = 0;
    let leaveCount = 0;
    let teamChangeCount = 0;

    this.verboseLogger(2, `[Players] UPDATED_PLAYER_INFORMATION: ${players.length} server players, ${this.registry.size} tracked, initialSync=${isInitialSync}, hasNullTeams=${hasNullTeams}`);

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

      if (
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

      // Build ClansService tag cache from initial player sync (closed loop)
      if (this.parent?.services?.clans) {
        this.parent.services.clans.rebuildFromAllPlayers([...this.registry.values()]);
      }

      return;
    }

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

    this._refreshProjectionState({
      current,
      allResolved,
      hasNullTeams
    });

    // Snapshot squad data when teams are resolved (metadata stable even during null-window)
    if (allResolved && this.server.squads) {
      this._squadsCache = [...this.server.squads];
    }

    this.verboseLogger(2, `[Players] Tick: ${joinCount} joined, ${leaveCount} left, ${this.registry.size} tracked`);

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
  }

  _isRealTeam(teamID) {
    return teamID === 1 || teamID === 2;
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
  // during Stage 1 implementation (S³ uses one lifecycle, not a separate singleton).
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
    // Log-only reconciliation when the null window resolves.
    // We do not issue corrective RCON commands here; this is diagnostics only.
    for (const [key, projected] of this._projectedPlayers.entries()) {
      const actual = this.registry.get(key);
      if (!actual || !this._isRealTeam(actual.teamID)) continue;

      if (String(projected.teamID) !== String(actual.teamID)) {
        const name = actual.name || projected.name || key;
        this.verboseLogger(
          2,
          `[Players Projection] ${name} projected team ${projected.teamID} -> actual ${actual.teamID}`
        );
      }
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
      isLeader: player?.isLeader ?? false,
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

  _normalizeSource(source) {
    return String(source || 'Unknown');
  }

  _priorityOf(source) {
    return this.PRIORITY[source] || 0;
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

      if (emitJoin) {
        // Synchronous in-memory peek for reconnect data to provide previousTeamID
        // in the join payload. Only checks the in-memory cache (prune already ran
        // before _registerPlayer is called), avoiding an async DB lookup.
        const reconnectInfo = this._reconnectMemory.get(key) || null;
        const previousTeamID = reconnectInfo?.lastTeamID ?? null;
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

    state.name = rawPlayer?.name || state.name;
    state.teamID = rawPlayer?.teamID ?? null;
    state.squadID = rawPlayer?.squadID ?? state.squadID;
    state.eosID = rawPlayer?.eosID || state.eosID;
    state.steamID = rawPlayer?.steamID || state.steamID;
    state.lastSeenAt = now;

    this._indexPlayer(state, key);

    if (emitJoin && !state.joinEmitted) {
      const reconnectInfo = this._reconnectMemory.get(key) || null;
      const previousTeamID = reconnectInfo?.lastTeamID ?? null;
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
      if (updatedAt && updatedAt < cutoff) {
        this._reconnectMemory.delete(key);
      }
    }
  }

  _isReconnectStale(record, now = Date.now()) {
    if (!record) return false;
    const updatedAt = Number(record?.updatedAt) || Number(record?.lastSeenAt) || 0;
    if (!updatedAt) return false;
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
          await connector.query('DELETE FROM S3PlayerReconnects WHERE updatedAt < :cutoff', {
            replacements: { cutoff }
          });
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

    if (!this._migrationRegistered && typeof dbService.registerMigration === 'function') {
      this._migrationRegistered = true;

      try {
        dbService.registerMigration('2026-06-21-002-s3-player-reconnects', async ({ sequelize, transaction }) => {
          const queryInterface = sequelize.getQueryInterface?.();

          if (queryInterface && typeof queryInterface.describeTable === 'function' && typeof queryInterface.createTable === 'function') {
            try {
              await queryInterface.describeTable('S3PlayerReconnects');
              return;
            } catch {
              // Table does not exist, continue.
            }

            const DataTypes = dbService.getDataTypes();
            await queryInterface.createTable('S3PlayerReconnects', {
              eosID: {
                type: DataTypes.STRING,
                primaryKey: true
              },
              steamID: {
                type: DataTypes.STRING,
                allowNull: true
              },
              playerName: {
                type: DataTypes.STRING,
                allowNull: true
              },
              lastTeamID: {
                type: DataTypes.INTEGER,
                allowNull: true
              },
              lastSeenAt: {
                type: DataTypes.BIGINT,
                allowNull: true
              },
              updatedAt: {
                type: DataTypes.BIGINT,
                allowNull: false
              }
            }, { transaction });
            return;
          }

          if (typeof sequelize.query === 'function') {
            await sequelize.query(`
              CREATE TABLE IF NOT EXISTS S3PlayerReconnects (
                eosID VARCHAR(64) PRIMARY KEY,
                steamID VARCHAR(64) NULL,
                playerName VARCHAR(255) NULL,
                lastTeamID INTEGER NULL,
                lastSeenAt BIGINT NULL,
                updatedAt BIGINT NOT NULL
              );
            `);
          }
        });
      } catch (err) {
        if (!String(err?.message || '').includes('Duplicate migration id')) {
          throw err;
        }
      }
    }

    if (typeof dbService.runMigrations === 'function') {
      await dbService.runMigrations();
    }

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
        tableName: 'S3PlayerReconnects',
        timestamps: false
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