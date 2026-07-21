/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               FACTIONS SERVICE                               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Discovers team and faction abbreviations from player role strings
 * (e.g., "US", "RUS", "GB", "CAF") by scanning roles during the LIVE
 * phase. Provides shared team-name lookup helpers for all consumer
 * plugins that display faction information.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * FactionsService (class, default)
 *   mount()     — Registers event listeners, starts abbreviation polling.
 *   unmount()   — Stops polling, resets mounted state.
 *   isReady()   — Returns true when service is mounted.
 *   isEnabled() — Returns true when mounted (alias for isReady()).
 *   getTeamName(teamID, opts) — Returns faction abbreviation or
 *                               generic "Team N".
 *   getFactionId(faction)     — Resolves a faction name/role to teamID.
 *   getCachedAbbreviations()  — Returns current cached abbreviations.
 *   handleNewGame()           — Clears abbreviation cache on NEW_GAME.
 *   handleRoundEnded()        — Stops polling on ROUND_ENDED.
 *   handleUpdatedPlayerInfo() — Ensures polling state on each tick.
 *   pollTeamAbbreviations()       — Scans roles for faction abbreviations.
 *   extractTeamAbbreviationsFromRoles() — Extracts abbreviations from
 *                                   player role strings.
 *   stopPollingTeamAbbreviations() — Stops the polling interval.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * (No local imports — depends on server and gameState injected via
 *  constructor.)
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Polling runs whenever the abbreviation cache is incomplete AND the
 *   resolving flag is false. The resolving flag is set true on NEW_GAME
 *   (after match start) and cleared once all players have valid team IDs.
 *   During resolving, player roles may carry stale faction data from the
 *   previous round — polling is safely skipped. Once teams settle,
 *   polling runs regardless of phase (STAGING or LIVE), so seed-mode
 *   rounds (which never transition to LIVE) still get abbreviations.
 * - Polling stops automatically once both teams' abbreviations are cached.
 * - Cache clears on every NEW_GAME event.
 * - Falls back to generic "Team N" when abbreviation is not yet cached.
 * - The abbreviation regex extracts 2–6 uppercase characters before an
 *   underscore in the role string (e.g., "US_Rifleman" → "US").
 *
 */
export default class FactionsService {
  constructor({
    server,
    gameState,
    verboseLogger = () => {},
    pollIntervalMs = 5000
  } = {}) {
    this.server = server;
    this.gameState = gameState;
    this.verboseLogger = verboseLogger;

    this.pollIntervalMs = Number.isFinite(pollIntervalMs) ? pollIntervalMs : 5000;

    this.cachedAbbreviations = {};
    this._isMounted = false;
    this._teamAbbreviationPollingInterval = null;

    // Subscription callbacks — fires once per round when both team abbreviations are discovered
    this._onFactionsResolvedCallbacks = [];

    this.listeners = {
      handleNewGame: this.handleNewGame.bind(this),
      handleRoundEnded: this.handleRoundEnded.bind(this),
      handleUpdatedPlayerInfo: this.handleUpdatedPlayerInfo.bind(this)
    };
  }

  async mount() {
    if (!this.server || typeof this.server.on !== 'function') {
      throw new Error('FactionsService requires a valid SquadJS server EventEmitter.');
    }

    if (!this.gameState || typeof this.gameState.isLive !== 'function') {
      throw new Error('FactionsService requires a gameState service with isLive().');
    }

    if (this._isMounted) {
      await this.unmount();
    }

    this._isMounted = true;
    this._ensurePollingState();
    this.verboseLogger(2, '[Factions] Mounted.');
  }

  async unmount() {
    if (!this._isMounted) return;

    this.stopPollingTeamAbbreviations();
    this._isMounted = false;
    this.verboseLogger(2, '[Factions] Unmounted.');
  }

  handleNewGame() {
    this.cachedAbbreviations = {};
    this.stopPollingTeamAbbreviations();
    this.verboseLogger(3, '[Factions] NEW_GAME detected -> cleared abbreviation cache.');
  }

  handleRoundEnded() {
    this.stopPollingTeamAbbreviations();
  }

  handleUpdatedPlayerInfo() {
    this._ensurePollingState();
  }

  isEnabled() {
    return this._isMounted;
  }

  isReady() {
    return this._isMounted;
  }

  /**
   * Register a callback for faction abbreviations being resolved (both team
   * abbreviations discovered via role scanning during LIVE phase).
   * Fires after the abbreviation cache is updated. Fires at most once per round.
   * @param {Function} callback - Receives { abbreviations: { 1: 'US', 2: 'RUS' } }
   * @returns {Function} unsubscribe function
   */
  onFactionsResolved(callback) {
    if (typeof callback !== 'function') {
      throw new Error('FactionsService.onFactionsResolved requires a function callback.');
    }
    this._onFactionsResolvedCallbacks.push(callback);
    this.verboseLogger(4, `[Factions] Added factions-resolved subscriber (total: ${this._onFactionsResolvedCallbacks.length})`);
    return () => {
      this._onFactionsResolvedCallbacks = this._onFactionsResolvedCallbacks.filter(cb => cb !== callback);
      this.verboseLogger(4, `[Factions] Removed factions-resolved subscriber (total: ${this._onFactionsResolvedCallbacks.length})`);
    };
  }

  _notifyFactionsResolved() {
    const payload = {
      abbreviations: { ...this.cachedAbbreviations }
    };
    for (const cb of this._onFactionsResolvedCallbacks) {
      try {
        cb(payload);
      } catch (err) {
        this.verboseLogger(1, `[Factions] Factions-resolved callback error: ${err.message}`);
      }
    }
  }

  getCachedAbbreviations() {
    return { ...this.cachedAbbreviations };
  }

  getTeamName(teamID, { useGenericNames = false } = {}) {
    const normalizedTeamID = Number(teamID);
    if (!Number.isFinite(normalizedTeamID) || normalizedTeamID <= 0) {
      return `Team ${teamID}`;
    }

    if (useGenericNames) {
      return `Team ${normalizedTeamID}`;
    }

    return this.cachedAbbreviations[normalizedTeamID] || `Team ${normalizedTeamID}`;
  }

  getFactionId(faction) {
    if (faction === null || faction === undefined) return null;

    if (Number.isFinite(Number(faction))) {
      const numericTeamID = Number(faction);
      return numericTeamID === 1 || numericTeamID === 2 ? numericTeamID : null;
    }

    const query = String(faction).trim();
    if (!query) return null;

    const queryUpper = query.toUpperCase();
    for (const [teamID, abbreviation] of Object.entries(this.cachedAbbreviations)) {
      if (String(abbreviation).toUpperCase() === queryUpper) {
        return Number(teamID);
      }
    }

    const queryLower = query.toLowerCase();
    const firstPlayer = (this.server.players || []).find((player) => {
      const role = this._extractRoleString(player);
      if (!role) return false;
      return role.toLowerCase().startsWith(queryLower);
    });

    return firstPlayer ? Number(firstPlayer.teamID) || null : null;
  }

  // Gate polling on the resolving flag rather than isLive(). The resolving flag is
  // set to true on NEW_GAME (after match start) and cleared once all players have
  // valid team IDs. During the resolving window, player roles may carry stale
  // faction data from the previous round — skip polling until teams settle.
  // Once resolving=false, poll regardless of phase (STAGING or LIVE), so seed-mode
  // rounds (which never transition to LIVE) still get faction abbreviations.
  _ensurePollingState() {
    const hasBoth = this._hasBothTeams();

    if (hasBoth) {
      this.stopPollingTeamAbbreviations();
      return;
    }

    // Skip during the null-teamID window — roles may be from the previous round
    if (this.gameState.resolving) {
      this.stopPollingTeamAbbreviations();
      return;
    }

    if (!this._teamAbbreviationPollingInterval) {
      this._teamAbbreviationPollingInterval = setInterval(() => this.pollTeamAbbreviations(), this.pollIntervalMs);
      this.verboseLogger(4, '[Factions] Starting team abbreviation polling.');
    }

    this.pollTeamAbbreviations();
  }

  stopPollingTeamAbbreviations() {
    if (!this._teamAbbreviationPollingInterval) return;

    clearInterval(this._teamAbbreviationPollingInterval);
    this._teamAbbreviationPollingInterval = null;
    this.verboseLogger(4, '[Factions] Stopped team abbreviation polling.');
  }

  pollTeamAbbreviations() {
    // Double-check: skip if still in resolving window (guard against race where
    // interval fires between resolving=false and a subsequent NEW_GAME)
    if (this.gameState.resolving) return;

    const wasComplete = this._hasBothTeams();
    const discovered = this.extractTeamAbbreviationsFromRoles();
    if (Object.keys(discovered).length > 0) {
      this.cachedAbbreviations = {
        ...this.cachedAbbreviations,
        ...discovered
      };
      this.verboseLogger(4, `[Factions] Updated cached abbreviations: ${JSON.stringify(this.cachedAbbreviations)}`);
    }

    if (this._hasBothTeams()) {
      this.stopPollingTeamAbbreviations();
      // Notify subscribers if this is the first time both teams resolved
      if (!wasComplete) {
        this._notifyFactionsResolved();
      }
    }
  }

  extractTeamAbbreviationsFromRoles(players = this.server.players || []) {
    const abbreviations = {};

    for (const player of players) {
      const teamID = Number(player?.teamID);
      if (teamID !== 1 && teamID !== 2) continue;

      if (abbreviations[teamID] || this.cachedAbbreviations[teamID]) {
        if (this._hasBothTeamsWithCandidate(abbreviations)) break;
        continue;
      }

      const role = this._extractRoleString(player);
      if (!role) continue;

      const match = role.match(/^([A-Z]{2,6})_/);
      if (!match) continue;

      abbreviations[teamID] = match[1];

      if (this._hasBothTeamsWithCandidate(abbreviations)) {
        break;
      }
    }

    return abbreviations;
  }

  _extractRoleString(player) {
    return player?.roles?.[0] || player?.role || null;
  }

  _hasBothTeams() {
    return !!(this.cachedAbbreviations[1] && this.cachedAbbreviations[2]);
  }

  _hasBothTeamsWithCandidate(candidate = {}) {
    return !!((this.cachedAbbreviations[1] || candidate[1]) && (this.cachedAbbreviations[2] || candidate[2]));
  }
}