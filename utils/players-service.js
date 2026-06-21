/**
 * Shared players service for Slacker's Squad Services (S³).
 *
 * Stage 1 scope:
 * - Centralize player registry diffing via UPDATED_PLAYER_INFORMATION
 * - Emit S3-prefixed lifecycle events (join/leave/team-change)
 * - Own per-player move attribution intent map
 * - Provide priority-based per-player + global locking helpers
 * - Provide minimal reconnect memory persistence (db-backed when available)
 */
const DEFAULT_ATTRIBUTION_TTL_MS = 90000;
const DEFAULT_LOCK_TTL_MS = 3000;

export default class PlayersService {
  constructor({
    server,
    dbService = null,
    verboseLogger = () => {},
    attributionTtlMs = DEFAULT_ATTRIBUTION_TTL_MS,
    defaultLockTtlMs = DEFAULT_LOCK_TTL_MS,
    reconnectPersistence = true
  } = {}) {
    this.server = server;
    this.dbService = dbService;
    this.verboseLogger = verboseLogger;

    this.attributionTtlMs = Number.isFinite(attributionTtlMs) ? attributionTtlMs : DEFAULT_ATTRIBUTION_TTL_MS;
    this.defaultLockTtlMs = Number.isFinite(defaultLockTtlMs) ? defaultLockTtlMs : DEFAULT_LOCK_TTL_MS;
    this.reconnectPersistence = reconnectPersistence !== false;

    this.registry = new Map(); // key -> player state
    this.steamIndex = new Map(); // steamID -> key
    this.moveAttribution = new Map(); // id -> { targetTeamID, source, expiresAt }

    this.playerLocks = new Map(); // key -> lock
    this.globalLock = null;

    this.reconnectModel = null;
    this._reconnectMemory = new Map();

    this._migrationRegistered = false;
    this._isMounted = false;

    this.PRIORITY = {
      TeamBalancer: 3,
      SmartAssign: 2,
      Switch: 1
    };

    this.listeners = {
      handleUpdatedPlayerInfo: this.handleUpdatedPlayerInfo.bind(this)
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

    this._isMounted = true;
    this.verboseLogger(2, '[Players] Mounted.');
  }

  async unmount() {
    if (!this._isMounted) return;

    for (const lock of this.playerLocks.values()) {
      if (lock?.timeout) clearTimeout(lock.timeout);
    }
    this.playerLocks.clear();

    if (this.globalLock?.timeout) clearTimeout(this.globalLock.timeout);
    this.globalLock = null;

    this._isMounted = false;
    this.verboseLogger(2, '[Players] Unmounted.');
  }

  getPlayer(eosIDOrSteamID) {
    const key = this._resolvePlayerKey(eosIDOrSteamID);
    if (!key) return null;

    const value = this.registry.get(key);
    return value ? { ...value } : null;
  }

  hasPlayer(eosIDOrSteamID) {
    return !!this._resolvePlayerKey(eosIDOrSteamID);
  }

  getAllPlayers() {
    return [...this.registry.values()].map((p) => ({ ...p }));
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

    return true;
  }

  canAct(eosIDOrSteamID, source) {
    this._cleanupExpiredState();

    const requester = this._normalizeSource(source);
    const requesterPriority = this._priorityOf(requester);

    if (this.globalLock && this.globalLock.source !== requester && this.globalLock.priority >= requesterPriority) {
      return false;
    }

    const key = this._resolvePlayerKey(eosIDOrSteamID) || this._normalizeIdentifier(eosIDOrSteamID);
    if (!key) return !this.globalLock;

    const held = this.playerLocks.get(key);
    if (!held) return true;
    if (held.source === requester) return true;
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

    this._setPlayerLock(key, normalizedSource, Math.max(1, ttlMs));
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
    return true;
  }

  lockGlobal(source, ttlMs = this.defaultLockTtlMs) {
    this._cleanupExpiredState();

    const normalizedSource = this._normalizeSource(source);
    const requesterPriority = this._priorityOf(normalizedSource);

    if (this.globalLock && this.globalLock.source !== normalizedSource && this.globalLock.priority >= requesterPriority) {
      return false;
    }

    this._setGlobalLock(normalizedSource, Math.max(1, ttlMs));
    return true;
  }

  unlockGlobal(source) {
    if (!this.globalLock) return false;

    const normalizedSource = this._normalizeSource(source);
    if (this.globalLock.source !== normalizedSource) return false;

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

    if (this.reconnectModel) {
      await this.dbService.executeWithRetry(async () => {
        await this.reconnectModel.upsert(record);
      });
    }

    this._reconnectMemory.set(key, record);
    return true;
  }

  async getReconnect(eosID) {
    const key = this._normalizeIdentifier(eosID);
    if (!key) return null;

    if (this.reconnectModel) {
      const row = await this.dbService.executeWithRetry(async () => this.reconnectModel.findByPk(key));
      if (row) {
        const normalized = this._normalizeReconnectRow(row);
        this._reconnectMemory.set(key, normalized);
        return normalized;
      }
    }

    return this._reconnectMemory.get(key) || null;
  }

  async clearReconnects() {
    if (this.reconnectModel) {
      await this.dbService.executeWithRetry(async () => {
        await this.reconnectModel.destroy({ where: {} });
      });
    }

    this._reconnectMemory.clear();
  }

  async handleUpdatedPlayerInfo() {
    this._cleanupExpiredState();

    const players = this.server.players || [];
    const now = Date.now();
    const current = new Set();

    for (const rawPlayer of players) {
      const key = this._selectPlayerKey(rawPlayer);
      if (!key) continue;

      current.add(key);
      const state = this.registry.get(key);

      if (!state) {
        const joined = this._toPlayerState(rawPlayer, now);
        this.registry.set(key, joined);
        this._indexPlayer(joined, key);

        this.server.emit('S3_PLAYER_JOINED', {
          player: { ...joined },
          source: 'S3PlayersRegistry'
        });
        continue;
      }

      const previousTeamID = state.teamID;
      const nextTeamID = rawPlayer?.teamID;

      state.name = rawPlayer?.name || state.name;
      state.teamID = nextTeamID;
      state.squadID = rawPlayer?.squadID ?? state.squadID;
      state.eosID = rawPlayer?.eosID || state.eosID;
      state.steamID = rawPlayer?.steamID || state.steamID;
      state.lastSeenAt = now;

      this._indexPlayer(state, key);

      if (
        String(previousTeamID) !== String(nextTeamID) &&
        this._isRealTeam(previousTeamID) &&
        this._isRealTeam(nextTeamID)
      ) {
        const attribution = this._consumeMoveAttribution(state, nextTeamID) || 'Manual/Game';
        this.server.emit('S3_PLAYER_TEAM_CHANGED', {
          player: { ...state },
          previousTeamID,
          teamID: nextTeamID,
          source: attribution
        });
      }
    }

    for (const [key, tracked] of this.registry.entries()) {
      if (current.has(key)) continue;

      this.registry.delete(key);
      this._deindexPlayer(tracked, key);

      this.server.emit('S3_PLAYER_LEFT', {
        player: { ...tracked },
        source: 'S3PlayersRegistry'
      });
    }
  }

  _isRealTeam(teamID) {
    return teamID === 1 || teamID === 2;
  }

  _toPlayerState(player, now) {
    return {
      eosID: player?.eosID || null,
      steamID: player?.steamID || null,
      name: player?.name || 'Unknown',
      teamID: player?.teamID ?? null,
      squadID: player?.squadID ?? null,
      joinTime: now,
      lastSeenAt: now
    };
  }

  _selectPlayerKey(player) {
    const eosID = this._normalizeIdentifier(player?.eosID);
    if (eosID) return eosID;
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

    this.globalLock = null;
    this.server.emit('S3_GLOBAL_LOCK_CHANGED', {
      source: previous.source,
      locked: false,
      expiresAt: null
    });
  }

  async _initReconnectPersistence() {
    if (!this.reconnectPersistence || !this.dbService) return;

    const connector = this.dbService.getConnector?.();
    if (!connector) return;

    if (!this._migrationRegistered && typeof this.dbService.registerMigration === 'function') {
      this._migrationRegistered = true;

      try {
        this.dbService.registerMigration('2026-06-21-002-s3-player-reconnects', async ({ sequelize, transaction }) => {
          const queryInterface = sequelize.getQueryInterface?.();

          if (queryInterface && typeof queryInterface.describeTable === 'function' && typeof queryInterface.createTable === 'function') {
            try {
              await queryInterface.describeTable('S3PlayerReconnects');
              return;
            } catch {
              // Table does not exist, continue.
            }

            const DataTypes = this.dbService.getDataTypes();
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

    if (typeof this.dbService.runMigrations === 'function') {
      await this.dbService.runMigrations();
    }

    this.reconnectModel = this.dbService.defineModel?.(
      'S3PlayerReconnect',
      {
        eosID: {
          type: this.dbService.getDataTypes().STRING,
          primaryKey: true
        },
        steamID: {
          type: this.dbService.getDataTypes().STRING,
          allowNull: true
        },
        playerName: {
          type: this.dbService.getDataTypes().STRING,
          allowNull: true
        },
        lastTeamID: {
          type: this.dbService.getDataTypes().INTEGER,
          allowNull: true
        },
        lastSeenAt: {
          type: this.dbService.getDataTypes().BIGINT,
          allowNull: true
        },
        updatedAt: {
          type: this.dbService.getDataTypes().BIGINT,
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
}
