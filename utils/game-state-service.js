/**
 * Shared game state service for Slacker's Squad Services (S³).
 *
 * Stage 1 scope:
 * - Centralize round phase tracking (STAGING -> LIVE -> ENDING)
 * - Keep SA-style "resolving" as an internal STAGING sub-state
 * - Share inferGameMode/resolveLayerInfo behavior with parity to reference plugins
 * - Provide ignored-game-mode matching utility
 */
export default class GameStateService {
  constructor({ server, log = () => {}, ignoredGameModes = ['Seed', 'Jensen'], resolvingTimeoutMs = 60000 } = {}) {
    this.server = server;
    this.log = log;

    this.defaultIgnoredGameModes = Array.isArray(ignoredGameModes)
      ? ignoredGameModes
      : ['Seed', 'Jensen'];

    this.resolvingTimeoutMs = Number.isFinite(resolvingTimeoutMs)
      ? resolvingTimeoutMs
      : 60000;

    this.phase = 'STAGING';
    this.resolving = false;

    this.gameModeCached = null;
    this.layerNameCached = null;
    this.lastKnownGoodLayer = null;

    this._resolvingTimeout = null;
    this._isMounted = false;

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

    this._clearResolvingTimeout();
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
    return this.phase === 'ENDING';
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
    this.phase = 'STAGING';
    this.resolving = true;

    if (data?.layer) {
      await this.resolveLayerInfo(data.layer, 'onNewGame');
    }

    this._clearResolvingTimeout();
    this._resolvingTimeout = setTimeout(() => {
      if (this.phase === 'STAGING' && this.resolving) {
        this.resolving = false;
        this.phase = 'LIVE';
        this.log(2, '[GameState] Resolving timeout reached; moved to LIVE.');
      }
    }, this.resolvingTimeoutMs);

    this.log(2, '[GameState] NEW_GAME -> STAGING (resolving=true).');
  }

  async onRoundEnded() {
    this._clearResolvingTimeout();
    this.resolving = false;
    this.phase = 'ENDING';
    this.log(2, '[GameState] ROUND_ENDED -> ENDING.');
  }

  async onLayerInfoUpdated() {
    await this.resolveLayerInfo(this.server.currentLayer, 'onLayerInfoUpdated');
  }

  async onServerInfoUpdated(info) {
    if (!info?.currentLayer) return;

    const incomingName = typeof info.currentLayer === 'string'
      ? info.currentLayer
      : info.currentLayer?.name;

    if (this.lastKnownGoodLayer?.name === incomingName) return;

    await this.resolveLayerInfo(info.currentLayer, 'onServerInfoUpdated');
  }

  async onUpdatedPlayerInfo() {
    if (!(this.phase === 'STAGING' && this.resolving)) return;

    const players = this.server.players || [];
    if (!players.length) return;

    const allResolved = players.every((p) => p?.teamID === 1 || p?.teamID === 2);
    if (!allResolved) return;

    this._clearResolvingTimeout();
    this.resolving = false;
    this.phase = 'LIVE';
    this.log(2, `[GameState] All ${players.length} players resolved -> LIVE.`);
  }

  _clearResolvingTimeout() {
    if (this._resolvingTimeout) {
      clearTimeout(this._resolvingTimeout);
      this._resolvingTimeout = null;
    }
  }
}
