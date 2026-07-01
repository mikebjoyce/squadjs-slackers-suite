/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               GAME STATE SERVICE                             ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Centralizes round phase tracking (STAGING → LIVE → ENDGAME with
 * resolving sub-state), layer and gamemode inference from layer names,
 * ENDGAME sub-state progression via timer-based voting approximations,
 * and crash-safe state persistence and recovery with round-age validation.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * GameStateService (class, default)
 *   mount()              — Initialises persistence, recovers state,
 *                          resolves current layer, registers event listeners.
 *   unmount()            — Clears timers and resets mounted state.
 *   isReady()            — Returns true when service is mounted.
 *   Phase: getPhase(), isStaging(), isLive(), isEnding(), isResolving()
 *   Layer: getGamemode(), getLayerName(), inferGameMode(layerName),
 *          resolveLayerInfo(layerData, source), isIgnoredMode(),
 *          isSeedMode(), isTrainingMode(), setIgnoredGameModes(modes)
 *   Timing: getRoundStartTime(), getMatchId()
 *   ENDGAME sub-state: getEndgameSubState(), isEndgameScoreboard(),
 *          isEndgameLayerVote(), isEndgameFactionVote(),
 *          isEndgameFactionVoteTeam1(), isEndgameFactionVoteTeam2(),
 *          isEndgamePostVoting(), isEndgameVotingComplete()
 *   Lifecycle events: handleNewGame(), handleRoundEnded(),
 *          handleLayerInfoUpdated(), handleServerInfoUpdated(),
 *          handleUpdatedPlayerInfo()
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * (No local imports — service is dependency-injected with parent,
 *  server, and verboseLogger.)
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Implicit dependency: serverConfig must be mounted before gameState
 *   so ENDGAME timers can read real vote durations from VoteConfig.cfg.
 * - Persists phase, resolving, timestamps, layer info, roundStartTime,
 *   and matchId to the S3_GameState database table for crash recovery.
 * - Recovered rounds older than maxRecoveredRoundAgeMs (default 2 hours)
 *   are invalidated and transitioned to LIVE; Seed and Training mode
 *   rounds are exempted from both the age check and the staging-overdue
 *   check since they have no meaningful STAGING phase and can run 4+ hours.
 * - ENDGAME sub-states are NOT persisted. Recovering into ENDGAME
 *   warns about lost sub-state visibility.
 * - Timer-based ENDGAME progression is approximate — actual voting may
 *   end early if enough players cast votes.
 * - _transitionRecoveredStateToLive() backfills roundStartTime and
 *   matchId to prevent null returns when a recovered round is invalidated.
 * - _validateRecoveredState layer-name comparison normalises names
 *   (strips underscores and hyphens) to avoid false divergences from
 *   SquadJS layer-name format mismatches.
 *
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
    stagingDurationMs = 180000, //default staging phase is 3 minutes (depends on game mode, squad wiki source; veracity unknown)
    maxRecoveredRoundAgeMs = 7200000
  } = {}) {
    this.parent = parent;
    this.server = server;
    this.verboseLogger = verboseLogger;

    this.defaultIgnoredGameModes = Array.isArray(ignoredGameModes)
      ? ignoredGameModes
      : [];

    // Internal overridable ignoredGameModes, set by S³ plugin via setIgnoredGameModes() at mount time
    this._ignoredGameModes = null;

    this.stagingDurationMs = Number.isFinite(stagingDurationMs) ? stagingDurationMs : 180000;
    this.maxRecoveredRoundAgeMs = Number.isFinite(maxRecoveredRoundAgeMs)
      ? maxRecoveredRoundAgeMs
      : 7200000;

    this.phase = 'LIVE';
    this.resolving = false;
    this.lastPhaseChangeAt = Date.now();
    this.lastNewGameAt = null;
    this.lastRoundEndedAt = null;

    // Centralized round start time and matchId hash for cross-plugin consistency
    this.roundStartTime = null;
    this.matchId = null;

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

    // Subscription callbacks
    this._onGamePhaseChangeCallbacks = [];
    this._onLayerGameModeChangeCallbacks = [];

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

    // Backfill roundStartTime when mounting mid-round (phase is LIVE but no NEW_GAME has fired yet).
    // This is the earliest moment S³ knows about the current round. Consumer plugins (EloTracker,
    // SmartAssign) rely on getRoundStartTime() for restart recovery — without this, they'd get null
    // and start a fresh session mid-round, losing continuity.
    if (this.phase === 'LIVE' && this.roundStartTime === null) {
      this.roundStartTime = Date.now();
      this.matchId = Math.floor(this.roundStartTime / 1000).toString(36).slice(-8);
      await this._persistState();
      this.verboseLogger(2, `[GameState] Mounted mid-round — backfilled roundStartTime: ${new Date(this.roundStartTime).toISOString()}`);
    }

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

  /**
   * Register a callback for game phase changes (STAGING/LIVE/ENDGAME transitions
   * including ENDGAME sub-state changes). Fires after the service's internal state
   * is fully committed.
   * @param {Function} callback - Receives { phase, prevPhase, subPhase, roundStartTime, matchId, layer }
   * @returns {Function} unsubscribe function
   */
  onGamePhaseChange(callback) {
    if (typeof callback !== 'function') {
      throw new Error('GameStateService.onGamePhaseChange requires a function callback.');
    }
    this._onGamePhaseChangeCallbacks.push(callback);
    this.verboseLogger(4, `[GameState] Added phase change subscriber (total: ${this._onGamePhaseChangeCallbacks.length})`);
    return () => {
      this._onGamePhaseChangeCallbacks = this._onGamePhaseChangeCallbacks.filter(cb => cb !== callback);
      this.verboseLogger(4, `[GameState] Removed phase change subscriber (total: ${this._onGamePhaseChangeCallbacks.length})`);
    };
  }

  /**
   * Register a callback for layer/game mode changes. Fires after the service
   * resolves new layer info and the cached values are updated.
   * @param {Function} callback - Receives { layerName, gameMode }
   * @returns {Function} unsubscribe function
   */
  onLayerGameModeChange(callback) {
    if (typeof callback !== 'function') {
      throw new Error('GameStateService.onLayerGameModeChange requires a function callback.');
    }
    this._onLayerGameModeChangeCallbacks.push(callback);
    this.verboseLogger(4, `[GameState] Added layer/gamemode subscriber (total: ${this._onLayerGameModeChangeCallbacks.length})`);
    return () => {
      this._onLayerGameModeChangeCallbacks = this._onLayerGameModeChangeCallbacks.filter(cb => cb !== callback);
      this.verboseLogger(4, `[GameState] Removed layer/gamemode subscriber (total: ${this._onLayerGameModeChangeCallbacks.length})`);
    };
  }

  // ── Notification methods ──────────────────────────────────────────

  _notifyGamePhaseChange(prevPhase) {
    const payload = {
      phase: this.phase,
      prevPhase,
      subPhase: this.endgameSubState,
      roundStartTime: this.roundStartTime,
      matchId: this.matchId,
      layer: this.layerNameCached
    };
    for (const cb of this._onGamePhaseChangeCallbacks) {
      try {
        cb(payload);
      } catch (err) {
        this.verboseLogger(1, `[GameState] Phase change callback error: ${err.message}`);
      }
    }
  }

  _notifyLayerGameModeChange(prevLayer, prevGameMode) {
    const payload = {
      layerName: this.layerNameCached,
      gameMode: this.gameModeCached,
      prevLayer,
      prevGameMode
    };
    for (const cb of this._onLayerGameModeChangeCallbacks) {
      try {
        cb(payload);
      } catch (err) {
        this.verboseLogger(1, `[GameState] Layer/gamemode callback error: ${err.message}`);
      }
    }
  }

  /**
   * Get the current round's start time (Unix epoch ms).
   * Set synchronously in handleNewGame() before any await.
   * Returns null if no round has started yet.
   */
  getRoundStartTime() {
    return this.roundStartTime;
  }

  /**
   * Get the current round's matchId hash (base-36 encoded timestamp).
   * Derived from roundStartTime using the same formula across all consumers:
   *   Math.floor(roundStartTime / 1000).toString(36).slice(-8)
   * Returns null if no round has started yet.
   */
  getMatchId() {
    return this.matchId;
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

    // Capture previous values for notification
    const prevLayer = this.layerNameCached;
    const prevGameMode = this.gameModeCached;

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
    this._notifyLayerGameModeChange(prevLayer, prevGameMode);
    return true;
  }

  isIgnoredMode() {
    const ignoredGameModes = this._ignoredGameModes ?? this.defaultIgnoredGameModes;
    const gameMode = this.getGamemode().toLowerCase();
    const layerName = this.getLayerName().toLowerCase();

    return ignoredGameModes.some((mode) => {
      const candidate = String(mode).toLowerCase();
      return gameMode.includes(candidate) || layerName.includes(candidate);
    });
  }

  /**
   * Check if current layer is a Seed mode round (used for auto-scramble decisions).
   * Intentionally distinct from isIgnoredMode() — Seed can be both "ignored" for
   * win-streak tracking AND trigger auto-scramble behaviour (e.g. TeamBalancer).
   * Jensen/Training rounds are NOT Seed — see isTrainingMode().
   */
  isSeedMode() {
    const gameMode = this.getGamemode().toLowerCase();
    const layerName = this.getLayerName().toLowerCase();
    return gameMode.includes('seed') || layerName.includes('seed');
  }

  /**
   * Check if current layer is a Training/Jensen's Range round.
   * Separate from isSeedMode() so consumers can distinguish between
   * "auto-scramble on Seed" and "skip Elite/ranking logic on Training".
   */
  isTrainingMode() {
    const gameMode = this.getGamemode().toLowerCase();
    const layerName = this.getLayerName().toLowerCase();
    return gameMode.includes('jensen') || layerName.includes('jensen');
  }

  /**
   * Set ignored game modes at runtime. Called by S³ plugin during mount().
   * Normalizes all entries to lowercase for consistent matching.
   * @param {string[]} modes - Array of mode/map substrings to ignore.
   */
  setIgnoredGameModes(modes) {
    this._ignoredGameModes = (modes || []).map(m => String(m).toLowerCase());
    this.verboseLogger(3, `[GameState] Ignored game modes set: ${JSON.stringify(this._ignoredGameModes)}`);
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

    // S³ owns roundStartTime — use our own process clock as the single source of truth.
    // server.matchStartTime is not reliable across restarts (new Date per process lifetime).
    this.roundStartTime = Date.now();
    this.matchId = Math.floor(this.roundStartTime / 1000).toString(36).slice(-8);

    if (data?.layer) {
      await this.resolveLayerInfo(data.layer, 'handleNewGame');
    }

    this._startStagingLiveTimer(now);
    await this._persistState();

    this.verboseLogger(2, '[GameState] NEW_GAME -> STAGING (resolving=true).');
    this._notifyGamePhaseChange('STAGING');
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
    this._notifyGamePhaseChange('ENDGAME');
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

    // Flat access via S³ plugin getters
    const playersService = this.parent?.players || null;
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

    // Seed and Training maps have no meaningful STAGING phase — players join/leave
    // freely and the server stays in pre-round indefinitely. Skip the forced timer
    // transition; the next NEW_GAME event will handle phase advancement naturally.
    if (this.isSeedMode() || this.isTrainingMode()) {
      this.verboseLogger(2, '[GameState] Seed/Training mode — skipping STAGING timer (phase remains STAGING until NEW_GAME).');
      return;
    }

    const elapsed = Math.max(0, Date.now() - Number(stagingStartedAtMs || Date.now()));
    const remaining = Math.max(0, this.stagingDurationMs - elapsed);

    this._stagingLiveTimer = setTimeout(async () => {
      if (this.phase !== 'STAGING') return;
      this._recoveredStateActive = false;

      this.phase = 'LIVE';
      this.resolving = false;
      this.lastPhaseChangeAt = Date.now();
      await this._persistState();
      this.verboseLogger(2, '[GameState] STAGING timer elapsed -> LIVE.');
      this._notifyGamePhaseChange('LIVE');

      // Emit server-wide event so consumer plugins (e.g. SmartAssign snapshot)
      // can capture the full player roster once the round is live and teams resolved.
      this.server?.emit?.('S3_ROUND_LIVE', {
        roundStartTime: this.roundStartTime,
        matchId: this.matchId,
        layerName: this.layerNameCached,
        gamemode: this.gameModeCached
      });
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
      this._notifyGamePhaseChange('ENDGAME');
      this._startEndgameTimer(Date.now());
      return;
    }

    if (this.endgameSubState === 'layerVote') {
      this.endgameSubState = 'factionVoteTeam1';
      this.verboseLogger(2, '[GameState] ENDGAME layerVote elapsed -> factionVoteTeam1.');
      this._notifyGamePhaseChange('ENDGAME');
      this._startEndgameTimer(Date.now());
      return;
    }

    if (this.endgameSubState === 'factionVoteTeam1') {
      this.endgameSubState = 'factionVoteTeam2';
      this.verboseLogger(2, '[GameState] ENDGAME factionVoteTeam1 elapsed -> factionVoteTeam2.');
      this._notifyGamePhaseChange('ENDGAME');
      this._startEndgameTimer(Date.now());
      return;
    }

    if (this.endgameSubState === 'factionVoteTeam2') {
      this.endgameSubState = 'postVoting';
      this.verboseLogger(2, '[GameState] ENDGAME factionVoteTeam2 elapsed -> postVoting.');
      this._notifyGamePhaseChange('ENDGAME');
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
      },
      roundStartTime: {
        type: DataTypes.BIGINT,
        allowNull: true
      },
      matchId: {
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

    // Recover centralized roundStartTime and matchId
    this.roundStartTime = state.roundStartTime ? Number(state.roundStartTime) : null;
    this.matchId = state.matchId || null;

    this.layerNameCached = state.lastLayerName || this.layerNameCached;
    this.gameModeCached = state.lastGamemode || this.gameModeCached;

    if (this.layerNameCached || this.gameModeCached) {
      this.lastKnownGoodLayer = {
        name: this.layerNameCached || 'Unknown',
        gamemode: this.gameModeCached || 'Unknown'
      };
    }

    if (this.phase === 'STAGING' && this.lastNewGameAt) {
      if (this.resolving === false) {
        // Teams were already resolved before crash — skip timer, go straight to LIVE
        this.phase = 'LIVE';
        this._recoveredStateActive = false;
        this.lastPhaseChangeAt = Date.now();
        this.verboseLogger(2, '[GameState] Recovered STAGING with resolving=false -> LIVE (skipping timer).');
        this._notifyGamePhaseChange('STAGING');
      } else {
        this._startStagingLiveTimer(this.lastNewGameAt);
      }
    }

    // ENDGAME stale-round guard: if lastRoundEndedAt >5 min ago, the next NEW_GAME
    // likely already passed — transition to LIVE rather than sitting in a phantom ENDGAME.
    // Leave endgameSubState as null (constructor default) — the timer chain is NOT
    // restarted; consumers see isEnding()=true but isEndgameFactionVote()=false (safe).
    if (this.phase === 'ENDGAME' && this.lastRoundEndedAt) {
      if ((Date.now() - this.lastRoundEndedAt) > 300000) {
        this.phase = 'LIVE';
        this.resolving = false;
        this._recoveredStateActive = false;
        this.lastPhaseChangeAt = Date.now();
        this.verboseLogger(2, '[GameState] Recovered ENDGAME but round stale (>5min) -> LIVE.');
        this._notifyGamePhaseChange('ENDGAME');
      }
      // else: stay in ENDGAME, subState=null, no timer, wait for NEW_GAME
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
    // Seed and Training modes have no meaningful round lifecycle — players join/leave
    // freely and a single "round" can last 4+ hours. Exclude from age check so crash
    // recovery doesn't falsely invalidate a legitimate seed/training round.
    if (this.isSeedMode() || this.isTrainingMode()) return false;
    return (now - this.lastNewGameAt) > this.maxRecoveredRoundAgeMs;
  }

  _isRecoveredStagingOverdue(now = Date.now()) {
    if (this.phase !== 'STAGING' || !this.lastNewGameAt) return false;
    // Seed and Training modes have no meaningful STAGING phase — the server sits in
    // pre-round indefinitely. Exclude from overdue check so recovery doesn't force
    // a premature LIVE transition on seed/training layers.
    if (this.isSeedMode() || this.isTrainingMode()) return false;
    return (now - this.lastNewGameAt) >= this.stagingDurationMs;
  }

  async _transitionRecoveredStateToLive(reason, now = Date.now()) {
    const prevPhase = this.phase;
    this._clearStagingLiveTimer();
    this._clearEndgameTimer();
    this.phase = 'LIVE';
    this.resolving = false;
    this.lastPhaseChangeAt = now;
    this.lastNewGameAt = null;
    // Backfill roundStartTime only when:
    // 1. No valid recovered value exists (null from DB or first boot), OR
    // 2. The round was actually too old (recovered_round_too_old) — start fresh.
    // For false-positive layer_divergence or staging_overdue, the recovered
    // roundStartTime is still valid and should be preserved.
    if (this.roundStartTime === null || reason.includes('recovered_round_too_old')) {
      this.roundStartTime = Date.now();
      this.matchId = Math.floor(this.roundStartTime / 1000).toString(36).slice(-8);
    }
    this._recoveredStateActive = false;
    await this._persistState();
    this.verboseLogger(1, `[GameState] Recovered state invalidated -> LIVE (${reason}).`);
    this._notifyGamePhaseChange(prevPhase);
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
      if (this._isKnownLayerName(recoveredLayerName)) {
        // Normalize both names for comparison — SquadJS handleLayerInfoUpdated may store
        // spaces (e.g. "Manicouagan Skirmish v3") while raw server info from
        // handleServerInfoUpdated may use underscores ("Manicouagan_Skirmish_v3").
        // Strip underscores and hyphens from both sides before comparing so minor
        // formatting differences don't trigger a false-positive layer_divergence.
        const normalizeForCompare = (name) => String(name).replace(/[_\-\s]/g, '').toLowerCase();
        if (normalizeForCompare(recoveredLayerName) !== normalizeForCompare(serverLayerName)) {
          await this._transitionRecoveredStateToLive(`${source}:layer_divergence`, now);
          return;
        }
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
        lastGamemode: this.gameModeCached || null,
        roundStartTime: this.roundStartTime,
        matchId: this.matchId
      });
    };
    if (dbService?.executeWithRetry) {
      await dbService.executeWithRetry(write);
    } else {
      await write();
    }
  }

  _getDbService() {
    // Flat access via S³ plugin getters
    return this.parent?.db || null;
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
    // Flat access via S³ plugin getters
    return this.parent?.serverConfig || null;
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