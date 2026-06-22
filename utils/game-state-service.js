/**
 * GameState — Centralizes round phase tracking and layer/gamemode resolution.
 * Part of Slacker's Squad Services (S³).
 *
 * Scope:
 * - Tracks round phases (STAGING → LIVE → ENDGAME) with resolving sub-state during STAGING
 * - Infers and resolves layer information (gamemode from layer name)
 * - Manages ENDGAME sub-state progression via timer-based voting state machine
 * - Provides parameterized ignored-mode substring matching utility
 * - Persists/recovers state for restart resilience with round-age validation
 *
 * Build order: 3 (depends on: parent, server, verboseLogger, ignoredGameModes; consumed by: factions; <planned, not yet wired> TB, SA, Switch, Elo)
 * Design ref: DesignDocs/slackers-squad-services-design.md §5
 *
 * @example
 * // inside factions-service handleUpdatedPlayerInfo, gates team abbreviation polling in LIVE phase
 * this.gameState.isLive(); // true if round is in LIVE phase
 */

// Round flow notes for future reference:
// - LIVE -> ROUND_ENDED event -> ENDGAME (map/faction voting window)
// - ENDGAME sub-states: scoreboard -> layerVote -> factionVoteTeam1 -> factionVoteTeam2 -> postVoting -> (waiting for NEW_GAME)
// - postVoting is passive (~10s results display before map roll); no timer — we sit until NEW_GAME clears it
// - NEW_GAME event -> STAGING(resolving=true) -> STAGING(resolving=false) -> LIVE.
// - During map load around NEW_GAME, players can briefly report teamID=null (sometimes
//   a tick before NEW_GAME). Treat this as transient while teams resolve; prior teams
//   remain valid unless a player actually swaps during this window.

export default class GameStateService {
  constructor({
    parent = null,
    server,
    verboseLogger = () => {},
    ignoredGameModes = [],
    stagingDurationMs = 360000,
    maxRecoveredRoundAgeMs = 7200000
  } = {}) {
    this.parent = parent;
    this.server = server;
    this.verboseLogger = verboseLogger;

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
    this._endgameTimer = null;
    this._isMounted = false;
    this.GameStateModel = null;
    this._recoveredStateActive = false;
    // ENDGAME sub-state: 'scoreboard' | 'layerVote' | 'factionVoteTeam1' | 'factionVoteTeam2' | 'postVoting' | null
    // Note: ENDGAME sub-states are NOT persisted. Recovering into ENDGAME is dangerous and warns.
    this.endgameSubState = null;

    this.listeners = {
      handleNewGame: this.handleNewGame.bind(this),
      handleRoundEnded: this.handleRoundEnded.bind(this),
      handleLayerInfoUpdated: this.handleLayerInfoUpdated.bind(this),
      handleServerInfoUpdated: this.handleServerInfoUpdated.bind(this),
      handleUpdatedPlayerInfo: this.handleUpdatedPlayerInfo.bind(this)
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

    if (this.server.currentLayer) {
      await this.resolveLayerInfo(this.server.currentLayer, 'mount');
    }

    this._isMounted = true;
    this.verboseLogger(2, '[GameState] Mounted.');
  }

  async unmount() {
    if (!this._isMounted) return;

    this._clearStagingLiveTimer();
    this._clearEndgameTimer();
    this._isMounted = false;
    this.verboseLogger(2, '[GameState] Unmounted.');
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

  isReady() {
    return this._isMounted;
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
    if (name.includes('_tc_')) return 'TC';
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
        this.verboseLogger(1, `[GameState:${source}] Failed to resolve layer promise: ${err.message}`);
        layer = null;
      }
    }

    if (!layer) {
      this.verboseLogger(3, `[GameState:${source}] Layer object is null/undefined.`);
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

    this.verboseLogger(4, `[GameState:${source}] Layer info updated: ${gamemode} / ${name}`);
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

  async handleNewGame(data) {
    const now = Date.now();
    this._recoveredStateActive = false;
    this._clearEndgameTimer();
    this.endgameSubState = null; // Clear ENDGAME sub-state when entering STAGING
    this.phase = 'STAGING';
    this.resolving = true;
    this.lastNewGameAt = now;
    this.lastPhaseChangeAt = now;

    if (data?.layer) {
      await this.resolveLayerInfo(data.layer, 'handleNewGame');
    }

    this._startStagingLiveTimer(now);
    await this._persistState();

    this.verboseLogger(2, '[GameState] NEW_GAME -> STAGING (resolving=true).');
  }

  async handleRoundEnded() {
    const now = Date.now();
    this._recoveredStateActive = false;
    this._clearStagingLiveTimer();
    this.resolving = false;
    this.phase = 'ENDGAME';
    this.lastRoundEndedAt = now;
    this.lastPhaseChangeAt = now;

    // Warn if we're recovering into ENDGAME state (dangerous - no visibility into sub-state)
    if (this._recoveredStateActive) {
      this.verboseLogger(1, '[GameState] WARNING: Recovered into ENDGAME phase. Voting sub-states unknown - timer approximations may be inaccurate.');
    }

    // Start ENDGAME sub-state timer chain
    this.endgameSubState = 'scoreboard';
    this._startEndgameTimer(now);

    await this._persistState();
    this.verboseLogger(2, '[GameState] ROUND_ENDED -> ENDGAME(scoreboard).');
  }

  async handleLayerInfoUpdated() {
    await this.resolveLayerInfo(this.server.currentLayer, 'handleLayerInfoUpdated');
  }

  async handleServerInfoUpdated(info) {
    if (!info?.currentLayer) return;

    const incomingName = this._extractLayerName(info.currentLayer);

    await this._validateRecoveredState('handleServerInfoUpdated', { serverLayerName: incomingName });

    if (!this._isKnownLayerName(incomingName)) return;

    if (this.lastKnownGoodLayer?.name === incomingName) return;

    await this.resolveLayerInfo(info.currentLayer, 'handleServerInfoUpdated');
  }

  async handleUpdatedPlayerInfo() {
    await this._validateRecoveredState('handleUpdatedPlayerInfo');

    if (!(this.phase === 'STAGING' && this.resolving)) return;

    // Two-tier team resolution check:
    //
    // 1. Prefer PlayersService (lines 263-272): If playersService is mounted, its `areTeamsResolved()`
    //    checks the service's own curated `this.registry` — a managed subset of tracked players.
    //    When the method returns `false` (not resolved), the early `return` on line 266 prevents
    //    fallthrough to the raw-server fallback below. This is intentional: the two checks target
    //    different data pools (registry vs server.players) and could disagree; gating on the
    //    service's opinion avoids false positives from stale server-side player entries.
    //
    // 2. Fallback (lines 274-282): Only reached when `playersService` is absent (null/undefined).
    //    Checks raw `this.server.players` directly — the unmanaged, full server player list.
    //    This is a degraded-mode safety net that still works when no PlayersService has mounted.

    const playersService = this.parent?.services?.players || null;
    if (playersService?.areTeamsResolved) {
      const allResolved = playersService.areTeamsResolved();
      if (!allResolved) return;

      this.resolving = false;
      await this._persistState();
      this.verboseLogger(2, '[GameState] All tracked players resolved -> STAGING(resolving=false).');
      return;
    }

    // Fallback: PlayersService absent — check raw server data.
    const players = this.server.players || [];
    if (!players.length) return;

    const allResolved = players.every((p) => p?.teamID === 1 || p?.teamID === 2);
    if (!allResolved) return;

    this.resolving = false;
    await this._persistState();
    this.verboseLogger(2, `[GameState] All ${players.length} players resolved -> STAGING(resolving=false).`);
  }

  _clearStagingLiveTimer() {
    if (this._stagingLiveTimer) {
      clearTimeout(this._stagingLiveTimer);
      this._stagingLiveTimer = null;
    }
  }

  _clearEndgameTimer() {
    if (this._endgameTimer) {
      clearTimeout(this._endgameTimer);
      this._endgameTimer = null;
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
      this.verboseLogger(2, '[GameState] STAGING timer elapsed -> LIVE.');
    }, remaining);
  }

  _startEndgameTimer(endgameStartedAtMs) {
    this._clearEndgameTimer();

    const elapsed = Math.max(0, Date.now() - Number(endgameStartedAtMs || Date.now()));

    // Calculate remaining time based on current sub-state
    let remaining = 0;
    if (this.endgameSubState === 'scoreboard') {
      remaining = Math.max(0, this._getTimeBeforeVote() - elapsed);
    } else if (this.endgameSubState === 'layerVote') {
      remaining = Math.max(0, this._getLayerVoteDuration() - elapsed);
    } else if (this.endgameSubState === 'factionVoteTeam1' || this.endgameSubState === 'factionVoteTeam2') {
      remaining = Math.max(0, this._getTeamVoteDuration() - elapsed);
    }

    this._endgameTimer = setTimeout(() => {
      if (this.phase !== 'ENDGAME') return;
      this._advanceEndgameSubState();
    }, remaining);
  }

  _advanceEndgameSubState() {
    // Timer-based sub-state progression - approximate since SquadJS has no explicit voting events
    // WARNING: These timers are estimates only. Actual voting may end early or extend due to player activity.
    // Reloading during ENDGAME will lose track of voting state entirely.

    if (this.endgameSubState === 'scoreboard') {
      this.endgameSubState = 'layerVote';
      this.verboseLogger(2, '[GameState] ENDGAME scoreboard elapsed -> layerVote.');
      this._startEndgameTimer(Date.now());
      return;
    }

    if (this.endgameSubState === 'layerVote') {
      this.endgameSubState = 'factionVoteTeam1';
      this.verboseLogger(2, '[GameState] ENDGAME layerVote elapsed -> factionVoteTeam1.');
      this._startEndgameTimer(Date.now());
      return;
    }

    if (this.endgameSubState === 'factionVoteTeam1') {
      this.endgameSubState = 'factionVoteTeam2';
      this.verboseLogger(2, '[GameState] ENDGAME factionVoteTeam1 elapsed -> factionVoteTeam2.');
      this._startEndgameTimer(Date.now());
      return;
    }

    if (this.endgameSubState === 'factionVoteTeam2') {
      this.endgameSubState = 'postVoting';
      this.verboseLogger(2, '[GameState] ENDGAME factionVoteTeam2 elapsed -> postVoting.');
      // Stay in postVoting (passive, no timer) until NEW_GAME clears the ENDGAME phase.
      // postVoting represents the ~10s results-display window before the map rolls.
      // We wait for the server's NEW_GAME event rather than approximating with another timer.
      return;
    }

    if (this.endgameSubState === 'postVoting') {
      // No timer transition from postVoting — this is a passive wait state.
      // NEW_GAME in handleNewGame() will clear endgameSubState to null and set phase to STAGING.
      this.verboseLogger(3, '[GameState] ENDGAME postVoting elapsed but no transition — waiting for NEW_GAME.');
    }
  }

  // ENDGAME sub-state getters
  getEndgameSubState() {
    return this.endgameSubState;
  }

  isEndgameScoreboard() {
    return this.phase === 'ENDGAME' && this.endgameSubState === 'scoreboard';
  }

  isEndgameLayerVote() {
    return this.phase === 'ENDGAME' && this.endgameSubState === 'layerVote';
  }

  isEndgameFactionVote() {
    return this.phase === 'ENDGAME' && (this.endgameSubState === 'factionVoteTeam1' || this.endgameSubState === 'factionVoteTeam2');
  }

  isEndgameFactionVoteTeam1() {
    return this.phase === 'ENDGAME' && this.endgameSubState === 'factionVoteTeam1';
  }

  isEndgameFactionVoteTeam2() {
    return this.phase === 'ENDGAME' && this.endgameSubState === 'factionVoteTeam2';
  }

  isEndgamePostVoting() {
    return this.phase === 'ENDGAME' && this.endgameSubState === 'postVoting';
  }

  isEndgameVotingComplete() {
    return this.phase === 'ENDGAME' && (this.endgameSubState === 'postVoting' || this.endgameSubState === null);
  }

  async _initPersistence() {
    const dbService = this._getDbService();
    const sequelize = this._getSequelize(dbService);
    if (!sequelize) return;

    const DataTypes = this._getDataTypes(dbService, sequelize);

    if (sequelize.models?.S3GameState) {
      this.GameStateModel = sequelize.models.S3GameState;
      return;
    }

    const defineModel = dbService?.defineModel?.bind(dbService);
    const modelFactory = defineModel || sequelize.define.bind(sequelize);

    this.GameStateModel = modelFactory('S3GameState', {
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

    if (dbService?.executeWithRetry) {
      await dbService.executeWithRetry(async () => {
        await this.GameStateModel.sync();
      });
    } else {
      await this.GameStateModel.sync();
    }
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
    this._clearEndgameTimer();
    this.phase = 'LIVE';
    this.resolving = false;
    this.lastPhaseChangeAt = now;
    this.lastNewGameAt = null;
    this._recoveredStateActive = false;
    await this._persistState();
    this.verboseLogger(1, `[GameState] Recovered state invalidated -> LIVE (${reason}).`);
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

    const dbService = this._getDbService();

    const write = async () => {
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
    };
    if (dbService?.executeWithRetry) {
      await dbService.executeWithRetry(write);
    } else {
      await write();
    }
  }

  _getDbService() {
    return this.parent?.services?.db || null;
  }

  _getSequelize(dbService = this._getDbService()) {
    return dbService?.getConnector?.() || null;
  }

  _getDataTypes(dbService = this._getDbService(), sequelize = this._getSequelize(dbService)) {
    if (dbService?.getDataTypes) {
      return dbService.getDataTypes();
    }

    const dataTypes =
      sequelize?.constructor?.DataTypes ||
      sequelize?.Sequelize?.DataTypes ||
      sequelize?.DataTypes;

    if (!dataTypes) {
      throw new Error('GameStateService could not resolve Sequelize DataTypes from connector.');
    }

    return dataTypes;
  }

  // Get voting durations from server config (with safe defaults).
  //
  // IMPLICIT DEPENDENCY: serverConfig must be mounted before gameState.
  // The ENDGAME sub-state timer chain (scoreboard→layerVote→factionVoteTeam1→factionVoteTeam2)
  // reads real vote durations from the server's VoteConfig.cfg via ServerConfigService.
  // If serverConfig hasn't mounted yet when gameState enters ENDGAME, the timers fall back
  // to safe defaults (30s/25s/25s), which match standard Squad voting durations.
  // This dependency was discovered during implementation and is why the container mounts
  // serverConfig first in mount(), diverging from the original build-order plan.
  _getServerConfig() {
    return this.parent?.services?.serverConfig || null;
  }

  _getTimeBeforeVote() {
    const config = this._getServerConfig();
    // default 30s from VoteConfig.cfg
    return config?.getTimeBeforeVote ? config.getTimeBeforeVote() * 1000 : 30000;
  }

  _getLayerVoteDuration() {
    const config = this._getServerConfig();
    // default 25s from VoteConfig.cfg
    return config?.getLayerVoteDuration ? config.getLayerVoteDuration() * 1000 : 25000;
  }

  _getTeamVoteDuration() {
    const config = this._getServerConfig();
    // default 25s from VoteConfig.cfg
    return config?.getTeamVoteDuration ? config.getTeamVoteDuration() * 1000 : 25000;
  }
}