/**
 * Shared game state service for Slacker's Squad Services (S³).
 *
 * Stage 1 scope:
 * - Centralize round phase tracking (STAGING -> LIVE -> ENDGAME)
 * - Keep SA-style "resolving" as an internal STAGING sub-state
 * - Share inferGameMode/resolveLayerInfo behavior with parity to reference plugins
 * - Provide ignored-game-mode matching utility
 * - Persist/recover state via sequelize connector for restart resilience
 */
export default class GameStateService {
  constructor({
    server,
    log = () => {},
    ignoredGameModes = [],
    sequelize = null,
    stagingDurationMs = 360000,
    maxRecoveredRoundAgeMs = 7200000
  } = {}) {
    this.server = server;
    this.log = log;
    this.sequelize = sequelize;

    this.defaultIgnoredGameModes = Array.isArray(ignoredGameModes)
      ? ignoredGameModes
      : [];

    this.stagingDurationMs = Number.isFinite(stagingDurationMs) ? stagingDurationMs : 360000;
    this.maxRecoveredRoundAgeMs = Number.isFinite(maxRecoveredRoundAgeMs)
      ? maxRecoveredRoundAgeMs
      : 7200000;

    this.phase = 'LIVE';
    this.resolving = false;
    this.lastPhaseChangeAt = Date.now();
    this.lastNewGameAt = null;
    this.lastRoundEndedAt = null;

    this.gameModeCached = null;
    this.layerNameCached = null;
    this.lastKnownGoodLayer = null;

    this._stagingLiveTimer = null;
    this._isMounted = false;
    this.GameStateModel = null;
    this._recoveredStateActive = false;

    this.listeners = {
      onNewGame: this.onNewGame.bind(this),
      onRoundEnded: this.onRoundEnded.bind(this),
      onLayerInfoUpdated: this.onLayerInfoUpdated.bind(this),
      onServerInfoUpdated: this.onServerInfoUpdated.bind(this),
      onUpdatedPlayerInfo: this.onUpdatedPlayerInfo.bind(this)
    };
  }

  async mount() {
    if (!this.server || typeof this.server.on !== 'function') {
      throw new Error('GameStateService requires a valid SquadJS server EventEmitter.');
    }

    if (this._isMounted) {
      await this.unmount();
    }

    await this._initPersistence();
    await this._recoverPersistedState();
    await this._validateRecoveredState('mount');

    this.server.on('NEW_GAME', this.listeners.onNewGame);
    this.server.on('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.on('UPDATED_LAYER_INFORMATION', this.listeners.onLayerInfoUpdated);
    this.server.on('UPDATED_SERVER_INFORMATION', this.listeners.onServerInfoUpdated);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);

    if (this.server.currentLayer) {
      await this.resolveLayerInfo(this.server.currentLayer, 'mount');
    }

    this._isMounted = true;
    this.log(2, '[GameState] Mounted.');
  }

  async unmount() {
    if (!this._isMounted) return;

    this.server.removeListener('NEW_GAME', this.listeners.onNewGame);
    this.server.removeListener('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.removeListener('UPDATED_LAYER_INFORMATION', this.listeners.onLayerInfoUpdated);
    this.server.removeListener('UPDATED_SERVER_INFORMATION', this.listeners.onServerInfoUpdated);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);

    this._clearStagingLiveTimer();
    this._isMounted = false;
    this.log(2, '[GameState] Unmounted.');
  }

  getPhase() {
    return this.phase;
  }

  isStaging() {
    return this.phase === 'STAGING';
  }

  isLive() {
    return this.phase === 'LIVE';
  }

  isEnding() {
    return this.phase === 'ENDGAME';
  }

  isResolving() {
    return this.phase === 'STAGING' && this.resolving;
  }

  getGamemode() {
    return this.gameModeCached || this.lastKnownGoodLayer?.gamemode || 'Unknown';
  }

  getLayerName() {
    return this.layerNameCached || this.lastKnownGoodLayer?.name || 'Unknown';
  }

  inferGameMode(layerName) {
    if (!layerName) return 'Unknown';
    const name = String(layerName).toLowerCase();
    if (name.includes('seed')) return 'Seed';
    if (name.includes('invasion')) return 'Invasion';
    if (name.includes('raas')) return 'RAAS';
    if (name.includes('aas')) return 'AAS';
    if (name.includes('tc')) return 'TC';
    if (name.includes('skirmish')) return 'Skirmish';
    if (name.includes('insurgency')) return 'Insurgency';
    if (name.includes('destruction')) return 'Destruction';
    if (name.includes('jensen')) return 'Jensen';
    return 'Unknown';
  }

  async resolveLayerInfo(layerData, source = 'Unknown') {
    let layer = layerData;
    if (layer instanceof Promise) {
      try {
        layer = await layer;
      } catch (err) {
        this.log(1, `[GameState:${source}] Failed to resolve layer promise: ${err.message}`);
        layer = null;
      }
    }

    if (!layer) {
      this.log(3, `[GameState:${source}] Layer object is null/undefined.`);
      return false;
    }

    let gamemode = 'Unknown';
    let name = 'Unknown';

    if (typeof layer === 'string') {
      name = layer;
      gamemode = this.inferGameMode(name);
    } else if (typeof layer === 'object') {
      name = layer.name || layer.layer || 'Unknown';
      gamemode = layer.gamemode || this.inferGameMode(name);
    }

    this.gameModeCached = gamemode;
    this.layerNameCached = name;
    this.lastKnownGoodLayer = { gamemode, name };
    await this._persistState();

    this.log(4, `[GameState:${source}] Layer info updated: ${gamemode} / ${name}`);
    return true;
  }

  isIgnoredMode(ignoredGameModes = this.defaultIgnoredGameModes) {
    const gameMode = this.getGamemode().toLowerCase();
    const layerName = this.getLayerName().toLowerCase();

    return ignoredGameModes.some((mode) => {
      const candidate = String(mode).toLowerCase();
      return gameMode.includes(candidate) || layerName.includes(candidate);
    });
  }

  async onNewGame(data) {
    const now = Date.now();
    this._recoveredStateActive = false;
    this.phase = 'STAGING';
    this.resolving = true;
    this.lastNewGameAt = now;
    this.lastPhaseChangeAt = now;

    if (data?.layer) {
      await this.resolveLayerInfo(data.layer, 'onNewGame');
    }

    this._startStagingLiveTimer(now);
    await this._persistState();

    this.log(2, '[GameState] NEW_GAME -> STAGING (resolving=true).');
  }

  async onRoundEnded() {
    const now = Date.now();
    this._recoveredStateActive = false;
    this._clearStagingLiveTimer();
    this.resolving = false;
    this.phase = 'ENDGAME';
    this.lastRoundEndedAt = now;
    this.lastPhaseChangeAt = now;
    await this._persistState();
    this.log(2, '[GameState] ROUND_ENDED -> ENDGAME.');
  }

  async onLayerInfoUpdated() {
    await this.resolveLayerInfo(this.server.currentLayer, 'onLayerInfoUpdated');
  }

  async onServerInfoUpdated(info) {
    if (!info?.currentLayer) return;

    const incomingName = this._extractLayerName(info.currentLayer);

    await this._validateRecoveredState('onServerInfoUpdated', { serverLayerName: incomingName });

    if (!this._isKnownLayerName(incomingName)) return;

    if (this.lastKnownGoodLayer?.name === incomingName) return;

    await this.resolveLayerInfo(info.currentLayer, 'onServerInfoUpdated');
  }

  async onUpdatedPlayerInfo() {
    await this._validateRecoveredState('onUpdatedPlayerInfo');

    if (!(this.phase === 'STAGING' && this.resolving)) return;

    const players = this.server.players || [];
    if (!players.length) return;

    const allResolved = players.every((p) => p?.teamID === 1 || p?.teamID === 2);
    if (!allResolved) return;

    this.resolving = false;
    await this._persistState();
    this.log(2, `[GameState] All ${players.length} players resolved -> STAGING(resolving=false).`);
  }

  _clearStagingLiveTimer() {
    if (this._stagingLiveTimer) {
      clearTimeout(this._stagingLiveTimer);
      this._stagingLiveTimer = null;
    }
  }

  _startStagingLiveTimer(stagingStartedAtMs) {
    this._clearStagingLiveTimer();

    const elapsed = Math.max(0, Date.now() - Number(stagingStartedAtMs || Date.now()));
    const remaining = Math.max(0, this.stagingDurationMs - elapsed);

    this._stagingLiveTimer = setTimeout(async () => {
      if (this.phase !== 'STAGING') return;

      this.phase = 'LIVE';
      this.resolving = false;
      this.lastPhaseChangeAt = Date.now();
      await this._persistState();
      this.log(2, '[GameState] STAGING timer elapsed -> LIVE.');
    }, remaining);
  }

  async _initPersistence() {
    if (!this.sequelize) return;

    const DataTypes = this._getDataTypes();

    if (this.sequelize.models?.S3GameState) {
      this.GameStateModel = this.sequelize.models.S3GameState;
      return;
    }

    this.GameStateModel = this.sequelize.define('S3GameState', {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true
      },
      phase: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'LIVE'
      },
      resolving: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      lastPhaseChangeAt: {
        type: DataTypes.BIGINT,
        allowNull: true
      },
      lastNewGameAt: {
        type: DataTypes.BIGINT,
        allowNull: true
      },
      lastRoundEndedAt: {
        type: DataTypes.BIGINT,
        allowNull: true
      },
      lastLayerName: {
        type: DataTypes.STRING,
        allowNull: true
      },
      lastGamemode: {
        type: DataTypes.STRING,
        allowNull: true
      }
    }, {
      tableName: 'S3_GameState',
      timestamps: false
    });

    await this.GameStateModel.sync();
  }

  async _recoverPersistedState() {
    if (!this.GameStateModel) return;

    const row = await this.GameStateModel.findByPk(1);
    if (!row) {
      this._recoveredStateActive = false;
      await this._persistState();
      return;
    }

    const state = row.toJSON ? row.toJSON() : row;

    this.phase = state.phase || 'LIVE';
    this.resolving = !!state.resolving;
    this.lastPhaseChangeAt = Number(state.lastPhaseChangeAt) || Date.now();
    this.lastNewGameAt = state.lastNewGameAt ? Number(state.lastNewGameAt) : null;
    this.lastRoundEndedAt = state.lastRoundEndedAt ? Number(state.lastRoundEndedAt) : null;

    this.layerNameCached = state.lastLayerName || this.layerNameCached;
    this.gameModeCached = state.lastGamemode || this.gameModeCached;

    if (this.layerNameCached || this.gameModeCached) {
      this.lastKnownGoodLayer = {
        name: this.layerNameCached || 'Unknown',
        gamemode: this.gameModeCached || 'Unknown'
      };
    }

    if (this.phase === 'STAGING' && this.lastNewGameAt) {
      this._startStagingLiveTimer(this.lastNewGameAt);
    }

    this._recoveredStateActive = true;
  }

  _extractLayerName(layerData) {
    if (!layerData) return null;
    if (typeof layerData === 'string') return layerData;
    if (typeof layerData === 'object') return layerData.name || layerData.layer || null;
    return null;
  }

  _isKnownLayerName(layerName) {
    if (!layerName) return false;
    const normalized = String(layerName).trim();
    return !!normalized && normalized.toLowerCase() !== 'unknown';
  }

  _isRecoveredRoundTooOld(now = Date.now()) {
    if (!this.lastNewGameAt) return false;
    return (now - this.lastNewGameAt) > this.maxRecoveredRoundAgeMs;
  }

  _isRecoveredStagingOverdue(now = Date.now()) {
    if (this.phase !== 'STAGING' || !this.lastNewGameAt) return false;
    return (now - this.lastNewGameAt) >= this.stagingDurationMs;
  }

  async _transitionRecoveredStateToLive(reason, now = Date.now()) {
    this._clearStagingLiveTimer();
    this.phase = 'LIVE';
    this.resolving = false;
    this.lastPhaseChangeAt = now;
    this.lastNewGameAt = null;
    this._recoveredStateActive = false;
    await this._persistState();
    this.log(1, `[GameState] Recovered state invalidated -> LIVE (${reason}).`);
  }

  async _validateRecoveredState(source = 'unknown', { serverLayerName = null } = {}) {
    if (!this._recoveredStateActive) return;

    const now = Date.now();

    if (this._isRecoveredRoundTooOld(now)) {
      await this._transitionRecoveredStateToLive(`${source}:recovered_round_too_old`, now);
      return;
    }

    if (this._isRecoveredStagingOverdue(now)) {
      await this._transitionRecoveredStateToLive(`${source}:staging_overdue`, now);
      return;
    }

    if (this._isKnownLayerName(serverLayerName)) {
      const recoveredLayerName = this.lastKnownGoodLayer?.name;
      if (this._isKnownLayerName(recoveredLayerName) && recoveredLayerName !== serverLayerName) {
        await this._transitionRecoveredStateToLive(`${source}:layer_divergence`, now);
        return;
      }

      this._recoveredStateActive = false;
    }
  }

  async _persistState() {
    if (!this.GameStateModel) return;

    await this.GameStateModel.upsert({
      id: 1,
      phase: this.phase,
      resolving: this.resolving,
      lastPhaseChangeAt: this.lastPhaseChangeAt,
      lastNewGameAt: this.lastNewGameAt,
      lastRoundEndedAt: this.lastRoundEndedAt,
      lastLayerName: this.layerNameCached || null,
      lastGamemode: this.gameModeCached || null
    });
  }

  _getDataTypes() {
    const dataTypes =
      this.sequelize?.constructor?.DataTypes ||
      this.sequelize?.Sequelize?.DataTypes ||
      this.sequelize?.DataTypes;

    if (!dataTypes) {
      throw new Error('GameStateService could not resolve Sequelize DataTypes from connector.');
    }

    return dataTypes;
  }
}
