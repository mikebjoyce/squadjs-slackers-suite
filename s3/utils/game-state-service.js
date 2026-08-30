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
 *   Layer: getGamemode(), getLayerName(), getLayerDisplayName(),
 *          inferGameMode(layerName), resolveLayerInfo(layerData, source),
 *          isIgnoredMode(), isSeedMode(), isTrainingMode(),
 *          setIgnoredGameModes(modes)
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
 * - Layer names are CANONICALISED onto the SquadJS classname
 *   ("Sumari_Seed_v1") inside resolveLayerInfo(), so every cache,
 *   comparison and persisted row uses one convention regardless of which
 *   event delivered the layer. getLayerName() returns the canonical form;
 *   getLayerDisplayName() returns the pretty one for human output.
 *   See _canonicalLayerName().
 * - Layer-name comparisons go through _layerNamesMatch(), which is
 *   punctuation-insensitive, alias-aware, and tolerant of a map-name word
 *   the classname omits — while still holding RAAS and AAS on the same map
 *   apart. Used by handleServerInfoUpdated's change guard and by
 *   _validateRecoveredState's divergence check.
 * - Staging length is per-gamemode (STAGING_DURATION_MS_BY_GAMEMODE), read
 *   through _stagingDurationForRound() and never from a cached field.
 *   Seed and Training bypass it entirely with a 5s staging-to-LIVE timer,
 *   since those modes have no meaningful STAGING phase and the server sits
 *   in pre-round indefinitely.
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

/**
 * How long after NEW_GAME a round is still STAGING, per gamemode.
 *
 * ── WHY THIS IS A TABLE AND NOT A CONFIG OPTION ──────────────────────
 * Staging length is a property of the gamemode, decided by the game. There is
 * no Server.cfg key for it and no reason an operator would ever want a
 * different number than the true one — an option here would only be a way to
 * get it wrong. When a value is missing or a gamemode is added, the fix is to
 * measure the real round and correct this table.
 *
 * ── WHAT THE NUMBERS MEASURE ─────────────────────────────────────────
 * Each value spans TWO things, because the clock starts at NEW_GAME:
 *
 *   1. the match-start countdown — players cannot spawn yet, and
 *   2. the staging phase itself — 4 minutes, the same in every mode.
 *
 * Only the countdown differs by mode. RAAS and AAS run 10s (→ 250000);
 * Invasion runs a full minute, presumably for defender setup (→ 300000).
 * Owner-observed in-game, 2026-08-19.
 *
 * Corroborated independently on the test server: rolling Fallujah_Invasion_v1,
 * `server.matchStartTime` — which SquadJS derives from the A2S PLAYTIME rule,
 * so it is the game's own clock and not one of ours — kept sliding while the
 * map loaded and settled ~78s after NEW_GAME, well past the 10s that RAAS
 * takes. The dev harness records it on every lifecycle event, which is how to
 * measure any mode added here later.
 *
 * The previous single 180000 was a wiki figure of unknown provenance. It ran a
 * minute short on RAAS and TWO minutes short on Invasion, taking those rounds
 * LIVE while players were still locked in main.
 *
 * Seed and Training are absent deliberately: they have no meaningful staging
 * phase at all and are short-circuited to 5s in _startStagingLiveTimer().
 *
 * ── UNMEASURED MODES ─────────────────────────────────────────────────
 * Only measured modes are listed. Anything else — TC, Skirmish, Insurgency,
 * Destruction — falls back to DEFAULT_STAGING_DURATION_MS rather than being
 * guessed at here, so the table never implies knowledge it does not have.
 */
const STAGING_DURATION_MS_BY_GAMEMODE = Object.freeze({
  RAAS: 250000,      // 10s match-start countdown + 4min staging
  AAS: 250000,       // same as RAAS
  Invasion: 300000   // 1min match-start countdown + 4min staging
});

/**
 * Fallback for an unmeasured gamemode. Set to the RAAS/AAS figure: it is the
 * common case, and the countdown is the only part that varies. Erring long is
 * the safer direction — a round declared LIVE early has consumer plugins
 * acting on a round that has not started, while one declared late merely
 * delays them.
 */
const DEFAULT_STAGING_DURATION_MS = 250000;

export default class GameStateService {
  constructor({
    parent = null,
    server,
    verboseLogger = () => {},
    ignoredGameModes = [],
    // null means "use STAGING_DURATION_MS_BY_GAMEMODE" — the production path.
    // A number here OVERRIDES the table for every gamemode, which exists so a
    // test can drive a whole round in milliseconds. It is not plumbed to any
    // config key, deliberately; see the table's header for why.
    stagingDurationMs = null,
    maxRecoveredRoundAgeMs = 7200000,
    layerRefreshTimeoutMs = 5000,
    resolvingTimeoutMs = 120000
  } = {}) {
    this.parent = parent;
    this.server = server;
    this.verboseLogger = verboseLogger;

    this.defaultIgnoredGameModes = Array.isArray(ignoredGameModes)
      ? ignoredGameModes
      : [];

    // Internal overridable ignoredGameModes, set by S³ plugin via setIgnoredGameModes() at mount time
    this._ignoredGameModes = null;

    // An explicit duration OVERRIDES the per-gamemode table outright — it is
    // how tests drive a whole round in milliseconds. The S³ plugin passes
    // nothing, so in production the table always wins and there is no config
    // key that could set a wrong value.
    //
    // There is deliberately no `this.stagingDurationMs` field any more. It used
    // to be the single source of truth and would now be a lie on every mode but
    // RAAS/AAS: it could only hold one number, while the answer depends on the
    // round's gamemode. Ask _stagingDurationForRound() instead — a stale field
    // that still reads plausibly is worse than no field.
    this.stagingDurationOverrideMs = Number.isFinite(stagingDurationMs) ? stagingDurationMs : null;
    this.maxRecoveredRoundAgeMs = Number.isFinite(maxRecoveredRoundAgeMs)
      ? maxRecoveredRoundAgeMs
      : 7200000;

    // Cap on the forced server.updateServerInformation() call used to pull a
    // layer immediately instead of waiting out SquadJS's ~30s poll. It goes to
    // RCON, so it must never be able to stall S³'s mount.
    this.layerRefreshTimeoutMs = Number.isFinite(layerRefreshTimeoutMs) ? layerRefreshTimeoutMs : 5000;
    this._layerRefreshInFlight = null;

    // Upper bound on the resolving window. `resolving` normally clears when a
    // player-info tick reports every tracked player on a real team; this is
    // only the escape hatch for a round where that never happens (empty
    // server, a player stuck with teamID=null). Must comfortably exceed the
    // player refresh interval — several ticks, not one.
    this.resolvingTimeoutMs = Number.isFinite(resolvingTimeoutMs) ? resolvingTimeoutMs : 120000;
    this._resolvingTimer = null;

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

    // The human-facing spelling of layerNameCached. S³ canonicalises the layer
    // name onto the classname ("Sumari_Seed_v1") because that is what the DB,
    // AdminChangeLayer and the reliable event all use — this keeps the pretty
    // name ("Sumari Bala Seed v1") available for display. In-memory only; it
    // re-derives on the next resolution. See _canonicalLayerName().
    this.layerDisplayNameCached = null;

    // normalized pretty name -> classname, learned from the Layer objects that
    // carry both. Lets a bare pretty string be canonicalised later.
    this._layerAliases = new Map();

    // True once the CURRENT round's layer has been resolved (or recovered from
    // the DB for this same round). getLayerName() happily serves the previous
    // round's layer as a fallback, which is fine for display and fatal for the
    // seed/training staging shortcut — see _startStagingLiveTimer.
    this._roundLayerTrusted = false;

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
    this._onResolvingChangeCallbacks = [];

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

    await this._bootstrapLayer();

    this._isMounted = true;
    this.verboseLogger(2, '[GameState] Mounted.');
  }

  async unmount() {
    if (!this._isMounted) return;

    this._clearStagingLiveTimer();
    this._clearEndgameTimer();
    this._clearResolvingTimer();
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

  /**
   * True while team data is not yet trustworthy for the current round.
   *
   * Deliberately NOT tied to the phase. It used to be `phase === 'STAGING' &&
   * resolving`, which made it a lie on every seed round: seed/training layers
   * advance to LIVE after 5s, and the player-info tick that actually confirms
   * teams runs on a ~20s interval, so the flag was cleared before a single
   * tick had been seen. Resolution is a property of the data, not of the phase.
   */
  isResolving() {
    return this.resolving;
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

  /**
   * Register a callback for changes to the `resolving` sub-state.
   *
   * This is a channel of its own rather than a phase-change payload because
   * `resolving` no longer moves with the phase: it clears on a player-info
   * tick, or on its own deadline, neither of which is a phase transition. Every
   * subscriber of onGamePhaseChange() treats its payload as a transition (the
   * LoggingService writes a PHASE_CHANGE row per call), so folding this into
   * that channel would fabricate phase changes that never happened.
   *
   * @param {Function} callback - Receives
   *   { resolving, reason, durationMs, phase, matchId, layer }
   * @returns {Function} unsubscribe function
   */
  onResolvingChange(callback) {
    if (typeof callback !== 'function') {
      throw new Error('GameStateService.onResolvingChange requires a function callback.');
    }
    this._onResolvingChangeCallbacks.push(callback);
    this.verboseLogger(4, `[GameState] Added resolving subscriber (total: ${this._onResolvingChangeCallbacks.length})`);
    return () => {
      this._onResolvingChangeCallbacks = this._onResolvingChangeCallbacks.filter(cb => cb !== callback);
      this.verboseLogger(4, `[GameState] Removed resolving subscriber (total: ${this._onResolvingChangeCallbacks.length})`);
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

  /**
   * @param {string} reason - Which path ended the resolving window:
   *   'PLAYERS_RESOLVED' | 'ROSTER_FALLBACK' | 'BUDGET_EXPIRED' |
   *   'ROUND_ENDED' | 'RECOVERY_STALE' | 'RECOVERY_INVALIDATED'
   * @param {number|null} durationMs - How long `resolving` was true, measured
   *   from lastNewGameAt. This is the number the 120s budget question needs;
   *   it is the reason the event carries a payload at all.
   */
  _notifyResolvingChange(reason, durationMs = null) {
    const payload = {
      resolving: this.resolving,
      reason,
      durationMs,
      phase: this.phase,
      matchId: this.matchId,
      layer: this.layerNameCached
    };
    for (const cb of this._onResolvingChangeCallbacks) {
      try {
        cb(payload);
      } catch (err) {
        this.verboseLogger(1, `[GameState] Resolving callback error: ${err.message}`);
      }
    }
  }

  /**
   * The single clear path for `resolving`: flag, deadline timer, persistence
   * and notification in one place, so no future caller can clear the flag and
   * leave the moment unrecorded — which is exactly how the observability hole
   * this method closes was introduced.
   *
   * @param {string} reason - see _notifyResolvingChange
   * @returns {Promise<boolean>} true if the flag was set and is now cleared
   */
  async _clearResolving(reason) {
    if (!this.resolving) return false;

    const durationMs = this.lastNewGameAt
      ? Math.max(0, Date.now() - Number(this.lastNewGameAt))
      : null;

    this.resolving = false;
    this._clearResolvingTimer();
    await this._persistState();

    // Notified after persistence so a subscriber that reads state back from the
    // database sees the same thing the payload reports.
    this.verboseLogger(
      4,
      `[GameState] resolving cleared: reason=${reason} durationMs=${durationMs} phase=${this.phase} ` +
      `matchId=${this.matchId} subscribers=${this._onResolvingChangeCallbacks.length}`
    );
    this._notifyResolvingChange(reason, durationMs);
    return true;
  }

  _notifyLayerGameModeChange(prevLayer, prevGameMode) {
    const payload = {
      layerName: this.layerNameCached,
      // Additive: existing subscribers read layerName and are unaffected.
      layerDisplayName: this.layerDisplayNameCached || this.layerNameCached,
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

  /**
   * The layer name as a human should read it ("Sumari Bala Seed v1").
   *
   * getLayerName() is canonical and stable — use it for comparisons, storage
   * and anything replayed into AdminChangeLayer. Use this one only for output
   * aimed at people (!s3 status, Discord embeds). Falls back to the canonical
   * name when no prettier spelling has been seen, so it is always safe to call.
   */
  getLayerDisplayName() {
    return this.layerDisplayNameCached || this.lastKnownGoodLayer?.displayName || this.getLayerName();
  }

  /**
   * True when S³ holds a real layer name (not the 'Unknown' placeholder).
   *
   * getLayerName()/getGamemode() return the string 'Unknown' both when the
   * layer genuinely has not resolved yet and when SquadJS itself reported
   * "Unknown" — consumers that gate behaviour on the layer (ignored modes,
   * seed detection, liberal switch rules) cannot tell those apart from a
   * real layer name without this. Use it to decide whether a negative answer
   * from isIgnoredMode()/isSeedMode() is trustworthy yet.
   */
  isLayerResolved() {
    return this._isKnownLayerName(this.layerNameCached || this.lastKnownGoodLayer?.name);
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

    // Capture previous values for notification
    const prevLayer = this.layerNameCached;
    const prevGameMode = this.gameModeCached;

    // ── CANONICALISE THE NAME HERE, ONCE ──────────────────────────────
    // Every resolution path funnels through this method, so this is the one
    // place the two SquadJS naming conventions have to be reconciled. Callers
    // downstream — and everything they persist or compare — then only ever see
    // the classname form. See _canonicalLayerName().
    const { name, displayName } = this._canonicalLayerName(layer);
    // Infer from the canonical name, not the pretty one: inferGameMode()'s TC
    // needle is '_tc_', which only ever matches a classname.
    const gamemode = (typeof layer === 'object' && layer?.gamemode) || this.inferGameMode(name);

    // ── NEVER CACHE AN "Unknown" LAYER ────────────────────────────────
    // SquadJS documents server.currentLayer / NEW_GAME data.layer as
    // possibly reading literally "Unknown" during and after a server
    // restart. Writing that into the caches is strictly worse than
    // keeping what we already had: it overwrites a good layer recovered
    // from the DB (mount order is _recoverPersistedState -> _bootstrapLayer)
    // and it makes lastKnownGoodLayer — the stale-but-valid fallback that
    // getLayerName()/getGamemode() lean on — hold a value that is neither
    // last, known, nor good. Reject it and wait for the next real
    // UPDATED_SERVER_INFORMATION payload instead.
    if (!this._isKnownLayerName(name)) {
      this.verboseLogger(2, `[GameState:${source}] Ignoring unresolved layer ("${name}") — keeping ${this.getLayerName()} / ${this.getGamemode()}.`);
      return false;
    }

    // ── VALIDATE RECOVERY BEFORE OVERWRITING THE RECOVERED LAYER ──────
    // _validateRecoveredState compares the authoritative name against
    // lastKnownGoodLayer, which still holds the DB-recovered value at this
    // point — one line further down it would be gone. Doing it here means
    // every resolution path (mount bootstrap, NEW_GAME, forced refresh,
    // UPDATED_SERVER_INFORMATION) gets divergence detection for free; before
    // this, no caller passed serverLayerName at all and the check was dead.
    await this._validateRecoveredState(source, { serverLayerName: name });

    this.gameModeCached = gamemode;
    this.layerNameCached = name;
    this.layerDisplayNameCached = displayName || name;
    this.lastKnownGoodLayer = { gamemode, name, displayName: this.layerDisplayNameCached };
    this._roundLayerTrusted = true;
    await this._persistState();

    // Both spellings and the shape they came from, because "which convention
    // did this path deliver" is the only question that matters when a layer
    // looks like it changed twice. `canonical=` is what everything compares and
    // persists; `display=` is what a human sees; `via=` says whether the
    // classname was read off a Layer object, recovered from a learned alias, or
    // absent entirely.
    const canonSource = typeof layer === 'object' && layer?.classname
      ? 'object.classname'
      : (displayName !== name ? 'alias' : 'as-given');
    this.verboseLogger(
      4,
      `[GameState:${source}] Layer info updated: ${gamemode} / canonical=${name} display=${displayName} via=${canonSource}`
    );

    // The staging shortcut for seed/training rounds is decided from the layer,
    // and the layer often arrives AFTER NEW_GAME (null data.layer, restart,
    // forced refresh). Re-arm the timer now that we actually know what we are
    // playing — it recomputes from lastNewGameAt, so a seed layer identified
    // 20s in fires immediately rather than adding another full duration.
    if (this.phase === 'STAGING' && this.lastNewGameAt) {
      this._startStagingLiveTimer(this.lastNewGameAt);
    }

    this._notifyLayerGameModeChange(prevLayer, prevGameMode);
    return true;
  }

  /**
   * Force SquadJS to repopulate its own layer state, then resolve from it.
   *
   * server.updateServerInformation() is the only SquadJS call that refills
   * server.currentLayer, and it emits UPDATED_SERVER_INFORMATION when it
   * completes — so handleServerInfoUpdated may resolve the layer before this
   * method's own resolveLayerInfo call does. That is harmless: resolveLayerInfo
   * is idempotent for an unchanged layer, and reading server.currentLayer
   * directly here means the bootstrap does not depend on the S³ plugin having
   * bound its listeners yet (it has not, at service-mount time).
   *
   * Concurrent callers share one in-flight refresh — the point is to shorten
   * the unresolved window, not to hammer RCON.
   *
   * @returns {Promise<boolean>} true if a real layer was resolved.
   */
  async refreshLayer(source = 'refreshLayer') {
    if (typeof this.server?.updateServerInformation !== 'function') {
      this.verboseLogger(3, `[GameState:${source}] server.updateServerInformation() unavailable — cannot force a layer refresh.`);
      return false;
    }

    if (this._layerRefreshInFlight) return this._layerRefreshInFlight;

    this._layerRefreshInFlight = (async () => {
      let timedOut = false;
      try {
        let timer = null;
        const pending = Promise.resolve(this.server.updateServerInformation());
        // Promise.race abandons the loser: if the timeout wins, this RCON call
        // still settles later and a late rejection would come back as an
        // unhandled rejection. Attach the handler up front so it gets reported.
        pending.catch((err) => {
          if (timedOut) this.verboseLogger(2, `[GameState:${source}] updateServerInformation rejected after it had already timed out: ${err.message}`);
        });
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`updateServerInformation timed out after ${this.layerRefreshTimeoutMs}ms`));
          }, this.layerRefreshTimeoutMs);
        });
        try {
          await Promise.race([pending, timeout]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (err) {
        this.verboseLogger(2, `[GameState:${source}] Forced server-information refresh failed: ${err.message}`);
        return false;
      }
      return this.resolveLayerInfo(this.server?.currentLayer, source);
    })();

    try {
      return await this._layerRefreshInFlight;
    } finally {
      this._layerRefreshInFlight = null;
    }
  }

  /**
   * Establish a layer at mount time.
   *
   * This is the fix for the original "everything says Unknown after a SquadJS
   * restart" bug class. Mounting mid-round used to read server.currentLayer
   * once and give up: SquadJS 4.2.0 does not repopulate it from RCON on
   * recovery, so S³ served 'Unknown' — and every consumer gate that reads the
   * layer (ignored modes, seed detection, liberal switch rules) silently
   * answered "no" — until the next ~30s UPDATED_SERVER_INFORMATION poll.
   *
   * Three sources, cheapest first. Each is validated by resolveLayerInfo, so
   * a literal "Unknown" from any of them falls through to the next.
   */
  async _bootstrapLayer() {
    // 1. Whatever SquadJS already holds — free, and correct when S³ mounts
    //    into an already-running SquadJS process.
    if (await this.resolveLayerInfo(this.server?.currentLayer, 'mount')) return true;

    // 2. Make SquadJS go and ask the server now, rather than waiting out its poll.
    if (await this.refreshLayer('mount:forcedRefresh')) return true;

    // 3. Last resort: newest entry of layerHistory (newest first). Populated
    //    from NEW_GAME, so it is empty on a cold SquadJS start but survives an
    //    S³-only remount.
    const historical = Array.isArray(this.server?.layerHistory) ? this.server.layerHistory[0]?.layer : null;
    if (historical && await this.resolveLayerInfo(historical, 'mount:layerHistory')) return true;

    if (this.isLayerResolved()) {
      // Nothing live to be had, but DB recovery left us a usable layer.
      this.verboseLogger(2, `[GameState] Mount: no live layer available — serving recovered ${this.getLayerName()} / ${this.getGamemode()}.`);
      return false;
    }

    this.verboseLogger(1, '[GameState] Mount: layer unresolved — getLayerName()/getGamemode() report Unknown until the next UPDATED_SERVER_INFORMATION poll.');
    return false;
  }

  /**
   * Both spellings of the layer name, lowercased, for the substring gates below.
   *
   * The gates take operator-supplied needles (ignoredGameModes defaults to
   * ['Seed', 'Jensen'], but a server can list anything). Single words match
   * under either convention, so the defaults never cared — but a needle with a
   * space in it, "al basrah", only ever matched the pretty name, and
   * canonicalisation would have silently stopped it matching. Checking both is
   * cheaper than telling operators their config now means something else.
   */
  _layerNameHaystacks() {
    const canonical = this.getLayerName().toLowerCase();
    const display = this.getLayerDisplayName().toLowerCase();
    return display === canonical ? [canonical] : [canonical, display];
  }

  isIgnoredMode() {
    const ignoredGameModes = this._ignoredGameModes ?? this.defaultIgnoredGameModes;
    const gameMode = this.getGamemode().toLowerCase();
    const layerNames = this._layerNameHaystacks();

    return ignoredGameModes.some((mode) => {
      const candidate = String(mode).toLowerCase();
      return gameMode.includes(candidate) || layerNames.some((n) => n.includes(candidate));
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
    return gameMode.includes('seed') || this._layerNameHaystacks().some((n) => n.includes('seed'));
  }

  /**
   * Check if current layer is a Training/Jensen's Range round.
   * Separate from isSeedMode() so consumers can distinguish between
   * "auto-scramble on Seed" and "skip Elite/ranking logic on Training".
   */
  isTrainingMode() {
    const gameMode = this.getGamemode().toLowerCase();
    return gameMode.includes('jensen') || this._layerNameHaystacks().some((n) => n.includes('jensen'));
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

  /**
   * Get the currently active ignored game modes list.
   * @returns {string[]} The overridden ignored modes if set by S³, otherwise the defaults.
   */
  get ignoredGameModes() {
    return this._ignoredGameModes ?? this.defaultIgnoredGameModes;
  }

  async handleNewGame(data) {
    const now = Date.now();
    const prevPhase = this.phase;
    this._recoveredStateActive = false;
    this._clearEndgameTimer();
    this.endgameSubState = null; // Clear ENDGAME sub-state when entering STAGING
    this.phase = 'STAGING';
    this.resolving = true;
    this.lastNewGameAt = now;
    this.lastPhaseChangeAt = now;

    // A new round invalidates the layer we know: whatever getLayerName() still
    // returns belongs to the round that just ended, until something resolves
    // this one. resolveLayerInfo() flips this back to true.
    this._roundLayerTrusted = false;

    // S³ owns roundStartTime — use our own process clock as the single source of truth.
    // server.matchStartTime is not reliable across restarts (new Date per process lifetime).
    this.roundStartTime = Date.now();
    this.matchId = Math.floor(this.roundStartTime / 1000).toString(36).slice(-8);

    // ── LAYER RESOLUTION ON NEW_GAME ──────────────────────────────────
    // BUG HISTORY (2026-07-21): server.currentLayer was routinely null after
    // S³ restarts mid-round (SquadJS 4.2.0 behaviour). The original code only
    // checked data?.layer — if null, the round started with a stale cached
    // layer from DB recovery (e.g. "Black Coast Invasion v1" from 5 hours ago).
    //
    // FIX: Fall back to server.currentLayer when data.layer is null. If both
    // are null or read "Unknown" (server just restarted, SquadJS hasn't
    // populated currentLayer yet), force a server-information refresh so we
    // don't sit on the previous round's layer for a whole ~30s poll cycle;
    // handleServerInfoUpdated remains the backstop if that refresh fails.
    //
    // DO NOT rely solely on data.layer — it can be null. DO NOT rely solely
    // on server.currentLayer — it can be null after restart. Always try both.
    const layerSource = data?.layer || this.server.currentLayer;
    this.verboseLogger(2, `[GameState] NEW_GAME: data.layer=${JSON.stringify(data?.layer)}, server.currentLayer=${JSON.stringify(this.server.currentLayer)}, using=${JSON.stringify(layerSource)}`);

    const layerResolved = layerSource
      ? await this.resolveLayerInfo(layerSource, 'handleNewGame')
      : false;

    if (!layerResolved) {
      // Fire-and-forget: a new round must not wait on an RCON round trip to
      // reach STAGING. refreshLayer() reports its own failures.
      this.refreshLayer('handleNewGame:forcedRefresh').catch((err) => {
        this.verboseLogger(2, `[GameState] NEW_GAME forced layer refresh rejected: ${err.message}`);
      });
    }

    this._startStagingLiveTimer(now);
    this._startResolvingTimer(now);
    await this._persistState();

    this.verboseLogger(2, '[GameState] NEW_GAME -> STAGING (resolving=true).');
    this._notifyGamePhaseChange(prevPhase);
  }

  async handleRoundEnded() {
    const now = Date.now();
    const prevPhase = this.phase;
    this._recoveredStateActive = false;
    this._clearStagingLiveTimer();
    this._clearResolvingTimer();
    // A round can end with teams still unresolved (a short seed round, or a
    // stall in player-info). That is its own outcome and is recorded as one —
    // _clearResolving() is not used here because it would persist mid-transition,
    // before the ENDGAME phase is written.
    const wasResolving = this.resolving;
    const resolvingDurationMs = this.lastNewGameAt
      ? Math.max(0, now - Number(this.lastNewGameAt))
      : null;
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
    if (wasResolving) {
      this.verboseLogger(2, `[GameState] Round ended with teams still resolving after ${resolvingDurationMs}ms.`);
      this._notifyResolvingChange('ROUND_ENDED', resolvingDurationMs);
    }
    this._notifyGamePhaseChange(prevPhase);
  }

  async handleLayerInfoUpdated() {
    // ── WHY THIS HANDLER IS NEUTERED ──────────────────────────────────
    // BUG HISTORY (2026-07-21): This handler originally performed layer
    // resolution by reading server.currentLayer. However, server.currentLayer
    // is null when S³ restarts mid-round (SquadJS 4.2.0 does not repopulate
    // it from RCON on recovery — confirmed via verbose logging). It MAY be
    // non-null after a fresh NEW_GAME, but we CANNOT trust it because the
    // conditions under which SquadJS sets it are opaque and unreliable.
    //
    // Per the SquadJS plugin creator skill (see references/event-reliability.md
    // at https://github.com/Hans-Vader/squadjs-plugin-creator-skill),
    // UPDATED_LAYER_INFORMATION carries NO payload — consumers are told to
    // "read server.currentLayer". But server.currentLayer is only populated
    // by UPDATED_SERVER_INFORMATION, not by UPDATED_LAYER_INFORMATION. This
    // is a SquadJS architecture quirk: the event that tells you "layer info
    // updated" doesn't actually give you the layer info — you need the OTHER
    // event for that.
    //
    // FIX: Layer resolution moved exclusively to handleServerInfoUpdated,
    // which receives the actual layer data via info.currentLayer. This handler
    // now only performs crash-recovery timing checks via _validateRecoveredState.
    //
    // DO NOT re-add layer resolution here — server.currentLayer is unreliable.
    await this._validateRecoveredState('handleLayerInfoUpdated');
  }

  async handleServerInfoUpdated(info) {
    // ── SOLE LAYER RESOLUTION PATH ────────────────────────────────────
    // BUG HISTORY (2026-07-21): This handler was originally neutered to
    // prevent "flip-flopping" with handleLayerInfoUpdated (the two events
    // use different layer name formats — e.g. "Sumari_Seed_v1" vs
    // "Sumari Bala Seed v1"). However, handleLayerInfoUpdated was later
    // found to be unreliable (server.currentLayer is null after mid-round
    // restarts), so neutering this handler meant NO handler could resolve
    // layers — the layer displayed in !s3 status was permanently stale.
    //
    // FIX: This is now the SINGLE source of truth for layer resolution.
    // It reads info.currentLayer from the UPDATED_SERVER_INFORMATION event
    // payload — the ONLY place SquadJS reliably delivers layer data
    // (see https://github.com/Hans-Vader/squadjs-plugin-creator-skill).
    //
    // The normalization guard (_normalizeLayerName comparison) prevents
    // redundant resolveLayerInfo calls when the layer hasn't actually
    // changed, avoiding the original flip-flop concern.
    //
    // DO NOT neuter this handler again without providing an alternative
    // layer resolution path. handleLayerInfoUpdated CANNOT do it.
    if (!info?.currentLayer) return;

    const incomingName = this._extractLayerName(info.currentLayer);
    this.verboseLogger(2, `[GameState] UPDATED_SERVER_INFORMATION: info.currentLayer=${JSON.stringify(info.currentLayer)}, extractedName=${incomingName}`);

    // Pass the authoritative name in: this is the one event that carries a
    // trustworthy layer, so it is what recovery validation must be judged
    // against. It also has to happen here rather than only inside
    // resolveLayerInfo — an unchanged layer returns below without resolving,
    // and that agreement is exactly what confirms the recovered state.
    await this._validateRecoveredState('handleServerInfoUpdated', { serverLayerName: incomingName });

    if (!this._isKnownLayerName(incomingName)) return;
    // _layerNamesMatch, not raw normalized equality: NEW_GAME resolved this
    // round from the pretty name and this poll carries the classname. On layers
    // where the two differ by a WORD ("Sumari Bala Seed v1" vs "Sumari_Seed_v1")
    // the normalized fingerprints disagree, so every ~30s poll re-resolved an
    // unchanged layer and fired another onLayerGameModeChange — harmless only
    // for as long as every subscriber stays idempotent.
    const cachedName = this.lastKnownGoodLayer?.name;
    if (this._layerNamesMatch(cachedName, incomingName)) {
      // The suppression this whole change exists to produce. Logged with both
      // sides and with the strict verdict alongside the tolerant one, so a
      // "strict=false tolerant=true" line is direct evidence of a duplicate
      // layer-change notification that WOULD have fired before and did not.
      const strict = this._normalizeLayerName(cachedName) === this._normalizeLayerName(incomingName);
      this.verboseLogger(
        4,
        `[GameState] Layer unchanged — no re-resolve. cached=${cachedName} incoming=${incomingName} ` +
        `strictMatch=${strict} tolerantMatch=true${strict ? '' : ' (this poll would have re-fired onLayerGameModeChange before canonicalisation)'}`
      );
      return;
    }

    this.verboseLogger(
      4,
      `[GameState] Layer CHANGED — re-resolving. cached=${cachedName} incoming=${incomingName}`
    );
    await this.resolveLayerInfo(info.currentLayer, 'handleServerInfoUpdated');
  }

  async handleUpdatedPlayerInfo() {
    await this._validateRecoveredState('handleUpdatedPlayerInfo');

    // Gate on the flag alone, not on the phase. A seed/training round is LIVE
    // 5s after NEW_GAME — long before the first player-info tick — so a
    // STAGING-only check meant those rounds could never clear `resolving` here
    // and had to have it force-cleared by the staging timer instead, whether or
    // not teams had actually settled.
    if (!this.resolving) return;

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

      await this._clearResolving('PLAYERS_RESOLVED');
      this.verboseLogger(2, `[GameState] All tracked players resolved -> resolving=false (phase ${this.phase}).`);
      return;
    }

    // Fallback: PlayersService absent — check raw server data.
    const players = this.server.players || [];
    if (!players.length) return;

    const allResolved = players.every((p) => p?.teamID === 1 || p?.teamID === 2);
    if (!allResolved) return;

    await this._clearResolving('ROSTER_FALLBACK');
    this.verboseLogger(2, `[GameState] All ${players.length} players resolved -> resolving=false (phase ${this.phase}).`);
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

  _clearResolvingTimer() {
    if (this._resolvingTimer) {
      clearTimeout(this._resolvingTimer);
      this._resolvingTimer = null;
    }
  }

  /**
   * Upper bound on the resolving window, armed at NEW_GAME.
   *
   * The staging timer used to double as this deadline, which coupled a
   * data-trust question to a phase-length guess — fine at 180s, actively wrong
   * at the 5s seed/training duration. This timer is independent: it only fires
   * when no player-info tick ever confirmed teams, and it says so in the log
   * rather than pretending resolution happened.
   */
  /**
   * The resolving deadline, floored against the real player-refresh cadence.
   *
   * `resolving` can only clear on a player-info tick, so a budget shorter than
   * several ticks expires before the answer could have arrived — which is the
   * bug that made the old 5s staging-timer clear meaningless. The tick interval
   * is not a constant: PlayersService clamps it to [3s, 60s] and takes the
   * fastest interval any plugin registered, so a deployment with a 60s cadence
   * gets only two ticks out of the 120s default. Derive the floor instead of
   * assuming prod's 20s.
   */
  _resolvingBudgetMs() {
    const tickMs = this.parent?.players?.getEffectiveRefreshIntervalMs?.() || 0;
    const floor = tickMs > 0 ? tickMs * 4 : 0;
    return Math.max(this.resolvingTimeoutMs, floor);
  }

  _startResolvingTimer(resolvingStartedAtMs) {
    this._clearResolvingTimer();

    const budget = this._resolvingBudgetMs();
    if (budget > this.resolvingTimeoutMs) {
      this.verboseLogger(3, `[GameState] Resolving deadline raised to ${budget}ms (4 player-info ticks) — the configured ${this.resolvingTimeoutMs}ms is shorter than the refresh cadence allows.`);
    }

    const elapsed = Math.max(0, Date.now() - Number(resolvingStartedAtMs || Date.now()));
    const remaining = Math.max(0, budget - elapsed);

    this._resolvingTimer = setTimeout(async () => {
      if (!this.resolving) return;
      this._resolvingTimer = null;
      await this._clearResolving('BUDGET_EXPIRED');
      this.verboseLogger(1, `[GameState] Teams never resolved within ${budget}ms — clearing resolving on the deadline (phase ${this.phase}).`);
    }, remaining);

    // Housekeeping deadline, not work worth keeping the process alive for. A
    // live SquadJS always has sockets holding the loop open, so this only
    // matters where it should: a test or a shutdown exits instead of waiting
    // out the full timeout.
    this._resolvingTimer.unref?.();
  }

  _startStagingLiveTimer(stagingStartedAtMs) {
    this._clearStagingLiveTimer();

    // Seed and Training maps have no meaningful STAGING phase — players join/leave
    // freely and the server stays in pre-round indefinitely. Use a short 5s
    // effective duration so the phase advances to LIVE instead of getting stuck
    // at STAGING (Seed rounds are perpetual and never fire another NEW_GAME).
    //
    // ── ONLY ON A LAYER RESOLVED FOR THIS ROUND ──────────────────────
    // BUG HISTORY (prod log, squadjs-log (29).log ~line 19019): NEW_GAME
    // arrived with data.layer=null AND server.currentLayer=null while the
    // previous round was JensensRange. isTrainingMode() consulted the stale
    // cached layer, said yes, and S³ declared LIVE 5 seconds into what was
    // really a full ~3 minute staging phase. The mirror image is just as bad:
    // a seed round following a RAAS round sits in STAGING for the full
    // duration. Requiring _roundLayerTrusted makes the default the safe
    // answer, and resolveLayerInfo() re-arms this timer the moment the real
    // layer lands — usually within a second or two thanks to refreshLayer().
    const shortStaging = this._roundLayerTrusted && (this.isSeedMode() || this.isTrainingMode());

    const effectiveDuration = shortStaging ? 5000 : this._stagingDurationForRound();

    if (!this._roundLayerTrusted) {
      this.verboseLogger(3, `[GameState] Staging timer armed on an unresolved layer — using the default ${effectiveDuration}ms, will re-arm when the layer resolves.`);
    }

    const elapsed = Math.max(0, Date.now() - Number(stagingStartedAtMs || Date.now()));
    const remaining = Math.max(0, effectiveDuration - elapsed);

    // Which of the four sources supplied the number. The table is only consulted
    // once the round's own layer is trusted, so this line is also how a re-arm
    // (unresolved -> resolved) is seen switching from the fallback to the real
    // per-gamemode value without a second NEW_GAME.
    const durationSource = shortStaging
      ? 'seed/training shortcut'
      : this.stagingDurationOverrideMs !== null
        ? 'explicit override'
        : !this._roundLayerTrusted
          ? 'fallback (layer not yet resolved)'
          : STAGING_DURATION_MS_BY_GAMEMODE[this.gameModeCached] !== undefined
            ? `gamemode table [${this.gameModeCached}]`
            : `fallback (gamemode ${this.gameModeCached} not in table)`;
    this.verboseLogger(
      4,
      `[GameState] Staging timer armed: duration=${effectiveDuration}ms source="${durationSource}" ` +
      `elapsed=${elapsed}ms remaining=${remaining}ms layer=${this.getLayerName()} trusted=${this._roundLayerTrusted}`
    );

    this._stagingLiveTimer = setTimeout(async () => {
      // A fired timeout handle stays truthy — Node never nulls it out — so the
      // field has to be cleared here, on BOTH exits, or it reads as "a staging
      // timer is pending" for the rest of the round. `!s3 gamestate` reported
      // `Staging Timer 🟡 Pending` on every LIVE round because of this; the
      // only time it showed None was before the first NEW_GAME after boot.
      // _startResolvingTimer has always done this; this one did not.
      this._stagingLiveTimer = null;

      if (this.phase !== 'STAGING') return;
      this._recoveredStateActive = false;

      const prevPhase = this.phase;
      this.phase = 'LIVE';
      // NOTE: `resolving` is deliberately NOT cleared here. Going LIVE says the
      // round has started; it says nothing about whether team data has settled,
      // and on seed/training rounds this timer fires 5s in — before the first
      // player-info tick. handleUpdatedPlayerInfo() clears the flag when teams
      // are actually resolved, and _startResolvingTimer() is the upper bound.
      this.lastPhaseChangeAt = Date.now();
      await this._persistState();
      this.verboseLogger(2, `[GameState] STAGING timer elapsed -> LIVE${this.resolving ? ' (teams still resolving).' : '.'}`);
      this._notifyGamePhaseChange(prevPhase);

      // Emit server-wide event so consumer plugins (e.g. SmartAssign snapshot)
      // can capture the full player roster once the round is live and teams resolved.
      this.server?.emit?.('S3_ROUND_LIVE', {
        roundStartTime: this.roundStartTime,
        matchId: this.matchId,
        layerName: this.layerNameCached,
        gamemode: this.gameModeCached
      });
    }, remaining);

    // Same reasoning as the resolving deadline: a phase clock is not work worth
    // keeping the process alive for. A live SquadJS always has sockets holding
    // the loop open. Without this a test that mounts and walks away hangs for
    // the full staging duration — four minutes, now that the duration is right.
    this._stagingLiveTimer.unref?.();
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
    //
    // Sub-state transitions do NOT fire _notifyGamePhaseChange() — the phase (ENDGAME) hasn't changed.
    // Only actual phase transitions (handleNewGame, staging timer, handleRoundEnded) notify subscribers.
    // Consumer plugins use public sub-state getters (isEndgameScoreboard(), etc.) when they need
    // sub-state detail.

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

    const defineModel = dbService?.defineModel?.bind(dbService);

    // Only short-circuit on a model already present on the connector when there
    // is NO DBService to register with. With one, defineModel() adopts the
    // existing model *and* records it in dbService.models; returning early here
    // instead would leave S3GameState out of getModelNames() — and therefore
    // out of every export tier including --all, which is the exact defect that
    // hid four tables from every backup.
    if (!defineModel && sequelize.models?.S3GameState) {
      this.GameStateModel = sequelize.models.S3GameState;
      return;
    }

    // Raw define is a last resort for a bare connector with no DBService (test
    // harnesses only). Nothing enumerates models in that configuration, so an
    // unregistered model has no export consequence there — but this branch must
    // never be reached when a DBService is present, or the model becomes
    // invisible to the exporter.
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
      timestamps: false,
      // A single row of live round bookkeeping, rewritten on every phase change
      // and rebuilt from the server on the next map roll.
      exportTier: 'ephemeral'
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
    // No prettier spelling survives a restart — the persisted column holds the
    // canonical name and nothing else (adding a column for a cosmetic field is
    // not worth a migration on a DB whose live user has no DDL grants). Display
    // falls back to the canonical name until the next resolution supplies one.
    this.layerDisplayNameCached = this.layerNameCached;

    if (this.layerNameCached || this.gameModeCached) {
      this.lastKnownGoodLayer = {
        name: this.layerNameCached || 'Unknown',
        displayName: this.layerNameCached || 'Unknown',
        gamemode: this.gameModeCached || 'Unknown'
      };
      // A persisted layer belongs to the round we are resuming, not to a
      // previous one — it is trustworthy for the staging shortcut below.
      this._roundLayerTrusted = this._isKnownLayerName(this.layerNameCached);
    }

    if (this.phase === 'STAGING' && this.lastNewGameAt) {
      if (this.resolving === false) {
        // Teams were already resolved before crash — skip timer, go straight to LIVE
        const prevPhase = this.phase;
        this.phase = 'LIVE';
        this._recoveredStateActive = false;
        this.lastPhaseChangeAt = Date.now();
        this.verboseLogger(2, '[GameState] Recovered STAGING with resolving=false -> LIVE (skipping timer).');
        this._notifyGamePhaseChange(prevPhase);
      } else {
        this._startStagingLiveTimer(this.lastNewGameAt);
      }
    }

    // A recovered round can be mid-resolving in any phase now that the flag is
    // no longer bounded by STAGING — re-arm its deadline from the original
    // NEW_GAME, so a crash cannot leave `resolving` true forever.
    if (this.resolving) {
      this._startResolvingTimer(this.lastNewGameAt || Date.now());
    }

    // ENDGAME stale-round guard: if lastRoundEndedAt >5 min ago, the next NEW_GAME
    // likely already passed — transition to LIVE rather than sitting in a phantom ENDGAME.
    // Leave endgameSubState as null (constructor default) — the timer chain is NOT
    // restarted; consumers see isEnding()=true but isEndgameFactionVote()=false (safe).
    if (this.phase === 'ENDGAME' && this.lastRoundEndedAt) {
      if ((Date.now() - this.lastRoundEndedAt) > 300000) {
        const prevPhase = this.phase;
        const wasResolving = this.resolving;
        this.phase = 'LIVE';
        this.resolving = false;
        this._recoveredStateActive = false;
        this.lastPhaseChangeAt = Date.now();
        this.verboseLogger(2, '[GameState] Recovered ENDGAME but round stale (>5min) -> LIVE.');
        // Usually notifies into an empty subscriber list — LoggingService mounts
        // after GameStateService — but the flag genuinely clears here, and a
        // clear path that cannot report itself is what this channel exists for.
        if (wasResolving) this._notifyResolvingChange('RECOVERY_STALE', null);
        this._notifyGamePhaseChange(prevPhase);
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

  // Normalize a layer name for comparison. SquadJS uses different string formats
  // across events (spaces vs underscores/hyphens, e.g. "Tallil Outskirts Invasion v1"
  // vs "Tallil_Invasion_v1"). Stripping non-alphanumerics gives a format-agnostic
  // fingerprint for identity checks.
  _normalizeLayerName(name) {
    if (!name) return '';
    // toLowerCase FIRST. The class [^a-z0-9] does not include A-Z, so stripping
    // before lowercasing deletes every capital — and layer gamemode tokens are
    // all-caps, so "Yehorivka_RAAS_v2" and "Yehorivka_AAS_v2" both collapsed to
    // "ehorivkav2". handleServerInfoUpdated compares normalized names to decide
    // whether the layer changed, so that collision made it return early on a
    // real RAAS->AAS switch: the layer went stale for the whole round and no
    // subscriber was notified. Caught on the live test server, 2026-08-19.
    return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // ── LAYER NAME CANONICALISATION ─────────────────────────────────────
  //
  // SquadJS delivers one layer under two conventions, and which one you get
  // depends on the event:
  //
  //   NEW_GAME data.layer            Layer object  .name "Sumari Bala Seed v1"
  //                                                .classname "Sumari_Seed_v1"
  //   UPDATED_SERVER_INFORMATION     string        "Sumari_Seed_v1"  (MapName_s)
  //   server.currentLayer            Layer object  (same object shape)
  //
  // S³ canonicalises on the CLASSNAME. It is what AdminChangeLayer accepts, it
  // is what S3GameState.lastLayerName already holds in the live DB, and it is
  // the format the always-fires event uses — so the reliable path needs no
  // conversion at all.
  //
  // The conversion is a field read, not a guess: every object-shaped source is
  // a squad-server/layers/layer.js instance carrying BOTH names, so the pretty
  // name never has to be reverse-engineered into a classname. Pretty names that
  // arrive as bare strings (some callers, older persisted rows) are mapped
  // through _layerAliases, which learns pairings from the objects it has seen.

  // Gamemode words as they appear inside a layer name. Deliberately the same
  // vocabulary inferGameMode() uses, minus the ones that are not standalone
  // tokens.
  static get LAYER_MODE_TOKENS() {
    return new Set(['seed', 'invasion', 'raas', 'aas', 'tc', 'skirmish', 'insurgency', 'destruction', 'training']);
  }

  /**
   * Split a layer name into lowercase words, bridging the two conventions.
   * Non-alphanumerics separate, and so does a camel-case boundary, so
   * "AlBasrah_AAS_v1" and "Al Basrah AAS v1" both tokenise to
   * [al, basrah, aas, v1].
   *
   * Letter/digit boundaries are deliberately NOT split: keeping "v1" whole is
   * what stops "…_v1" reading as a subset of "…_v10".
   */
  _layerNameTokens(name) {
    if (!name) return [];
    return String(name)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((t) => t.toLowerCase());
  }

  /**
   * True when two names denote the same layer under either convention.
   *
   * Three strategies, cheapest first:
   *
   *  1. Punctuation-insensitive equality (_normalizeLayerName). Covers every
   *     difference that is only spacing or punctuation — including the
   *     apostrophe case seen in production: "Fool's Road RAAS v1" and
   *     "FoolsRoad_RAAS_v1" both fingerprint to "foolsroadraasv1".
   *  2. The same comparison after resolving each side through the learned
   *     pretty->classname aliases.
   *  3. Word-level containment, which is the only thing that can bridge a
   *     convention difference in WORDS: the classname drops "Bala" from
   *     "Sumari Bala Seed v1". This is deliberately narrow — the gamemode
   *     token and everything after it must match EXACTLY, and only the map-name
   *     words in front of it may differ by containment. Without that restriction
   *     the tolerance would re-open the bug this guard exists to catch: a real
   *     RAAS->AAS switch on one map read as "no change" and ignored for the
   *     whole round.
   */
  _layerNamesMatch(a, b) {
    if (!a || !b) return false;
    if (this._normalizeLayerName(a) === this._normalizeLayerName(b)) return true;

    const aliasA = this._resolveLayerAlias(a);
    const aliasB = this._resolveLayerAlias(b);
    if (this._normalizeLayerName(aliasA) === this._normalizeLayerName(aliasB)) return true;

    const modeTokens = GameStateService.LAYER_MODE_TOKENS;
    const isMode = (t) => modeTokens.has(t);

    const ta = this._layerNameTokens(a);
    const tb = this._layerNameTokens(b);
    const ia = ta.findIndex(isMode);
    const ib = tb.findIndex(isMode);

    // Needs a gamemode token with at least one map word in front of it. No
    // gamemode token (JensensRange_USA-PLA and friends) means no tolerance:
    // strategies 1 and 2 already had their say.
    if (ia < 1 || ib < 1) return false;

    // Gamemode + version + anything trailing must be identical, so
    // "Narva_Invasion_v1" never matches a hypothetical "Narva_Invasion_v1_Alt".
    if (ta.slice(ia).join('|') !== tb.slice(ib).join('|')) return false;

    const prefixA = new Set(ta.slice(0, ia));
    const prefixB = new Set(tb.slice(0, ib));
    const [smaller, larger] = prefixA.size <= prefixB.size ? [prefixA, prefixB] : [prefixB, prefixA];
    for (const token of smaller) {
      if (!larger.has(token)) return false;
    }
    return true;
  }

  /**
   * Remember that a pretty name and a classname are the same layer. Called
   * whenever a Layer object arrives carrying both, which every object-shaped
   * source does.
   */
  _learnLayerAlias(prettyName, classname) {
    if (!this._isKnownLayerName(prettyName) || !this._isKnownLayerName(classname)) return;
    const key = this._normalizeLayerName(prettyName);
    if (!key || key === this._normalizeLayerName(classname)) return;
    this._layerAliases.set(key, String(classname));
  }

  /** Map a name onto its classname if one has been learned; otherwise pass it through. */
  _resolveLayerAlias(name) {
    if (!name) return name;
    return this._layerAliases.get(this._normalizeLayerName(name)) || name;
  }

  /**
   * Reduce any layer source to { name, displayName }.
   *
   * `name` is the canonical classname wherever it is knowable — it is what
   * every cache, every comparison and the persisted row use. `displayName` is
   * the human-facing string, kept so `!s3 status` can still show
   * "Sumari Bala Seed v1" rather than "Sumari_Seed_v1".
   *
   * displayName is in-memory only. Persisting it would need a column on
   * S3GameState, and the live MySQL user holds no DDL grants — a schema change
   * is not worth a cosmetic field that re-derives on the next resolution.
   */
  _canonicalLayerName(layer) {
    if (typeof layer === 'string') {
      const canonical = this._resolveLayerAlias(layer);
      return { name: canonical, displayName: layer };
    }

    if (layer && typeof layer === 'object') {
      const pretty = layer.name || layer.layer || null;
      const classname = layer.classname || null;
      this._learnLayerAlias(pretty, classname);

      if (this._isKnownLayerName(classname)) {
        return { name: String(classname), displayName: this._isKnownLayerName(pretty) ? String(pretty) : String(classname) };
      }

      const fallback = pretty || 'Unknown';
      return { name: this._resolveLayerAlias(fallback), displayName: fallback };
    }

    return { name: 'Unknown', displayName: 'Unknown' };
  }

  _isRecoveredRoundTooOld(now = Date.now()) {
    if (!this.lastNewGameAt) return false;
    // Seed and Training modes have no meaningful round lifecycle — players join/leave
    // freely and a single "round" can last 4+ hours. Exclude from age check so crash
    // recovery doesn't falsely invalidate a legitimate seed/training round.
    if (this.isSeedMode() || this.isTrainingMode()) return false;
    return (now - this.lastNewGameAt) > this.maxRecoveredRoundAgeMs;
  }

  /**
   * Staging length for the round in progress.
   *
   * The per-gamemode value is only consulted once the round's OWN layer has
   * resolved. Reading it from a stale cached layer is how S³ once declared a
   * full RAAS round LIVE 5 seconds in (prod log, squadjs-log (29).log ~19019):
   * the previous round was JensensRange, the new one arrived with no layer, and
   * the training shortcut fired. An unresolved layer therefore gets the
   * fallback, and resolveLayerInfo() re-arms the timer the moment the real
   * layer lands.
   */
  _stagingDurationForRound() {
    if (this.stagingDurationOverrideMs !== null) return this.stagingDurationOverrideMs;
    if (!this._roundLayerTrusted) return DEFAULT_STAGING_DURATION_MS;
    return STAGING_DURATION_MS_BY_GAMEMODE[this.gameModeCached] ?? DEFAULT_STAGING_DURATION_MS;
  }

  _isRecoveredStagingOverdue(now = Date.now()) {
    if (this.phase !== 'STAGING' || !this.lastNewGameAt) return false;
    // Seed and Training modes have no meaningful STAGING phase — the server sits in
    // pre-round indefinitely. Exclude from overdue check so recovery doesn't force
    // a premature LIVE transition on seed/training layers.
    if (this.isSeedMode() || this.isTrainingMode()) return false;
    // Same duration the live timer would have used, so a recovered round and a
    // running one cannot disagree about when staging should have ended.
    return (now - this.lastNewGameAt) >= this._stagingDurationForRound();
  }

  async _transitionRecoveredStateToLive(reason, now = Date.now()) {
    const prevPhase = this.phase;
    this._clearStagingLiveTimer();
    this._clearEndgameTimer();
    this._clearResolvingTimer();
    this.phase = 'LIVE';
    const wasResolving = this.resolving;
    const resolvingDurationMs = this.lastNewGameAt
      ? Math.max(0, now - Number(this.lastNewGameAt))
      : null;
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
    // ── CLEAR STALE LAYER CACHES ON RECOVERY INVALIDATION ────────────
    // BUG HISTORY (2026-07-21): When _transitionRecoveredStateToLive
    // invalidated a recovered round (e.g. mount:recovered_round_too_old),
    // it reset phase/timers but LEFT the cached layer intact. The stale
    // layer from the DB (e.g. "Black Coast Invasion v1" from a round that
    // ended 5 hours ago) would then be served by getLayerName() and
    // getGamemode() indefinitely — because handleLayerInfoUpdated was a
    // permanent no-op (server.currentLayer always null) and handleNewGame
    // only resolved when data.layer was non-null.
    //
    // FIX: Explicitly null out all three layer caches when invalidating
    // recovered state. The next successful layer resolution (from
    // handleServerInfoUpdated or handleNewGame) will repopulate them.
    //
    // DO NOT remove this clearing — it is the only defense against stale
    // DB-persisted layer data surviving recovery invalidation.
    this.layerNameCached = null;
    this.layerDisplayNameCached = null;
    this.gameModeCached = null;
    this.lastKnownGoodLayer = null;
    this._roundLayerTrusted = false;
    this._recoveredStateActive = false;
    await this._persistState();
    this.verboseLogger(1, `[GameState] Recovered state invalidated -> LIVE (${reason}). Layer caches cleared.`);
    if (wasResolving) this._notifyResolvingChange('RECOVERY_INVALIDATED', resolvingDurationMs);
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
        // The highest-risk comparison in the canonicalisation change, so it uses
        // the most tolerant form. recoveredLayerName comes out of the DB and may
        // predate canonicalisation (rows written when the pretty name was
        // whatever resolved last); serverLayerName is canonical. Judging those
        // unequal invalidates a perfectly good recovered round on every restart
        // and drops it straight to LIVE. _layerNamesMatch bridges the convention
        // gap while still separating RAAS from AAS on the same map.
        if (!this._layerNamesMatch(recoveredLayerName, serverLayerName)) {
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
    // Best-effort: every caller awaits this immediately before firing a phase-change
    // notification (onGamePhaseChange subscribers include Switch's seed-token grant
    // and SmartAssign's roster snapshot). This row is only for restart recovery — an
    // uncaught throw here must never suppress the notification that keeps consumer
    // plugins' own in-memory state in sync with a phase change S3 already committed
    // to memory.
    try {
      if (dbService?.executeWithRetry) {
        await dbService.executeWithRetry(write);
      } else {
        await write();
      }
    } catch (err) {
      this.verboseLogger(1, `[GameState] _persistState failed (state kept in memory, restart recovery may be stale): ${err.message}`);
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