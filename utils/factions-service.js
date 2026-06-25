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
 * - Polling is gated to the LIVE phase only — faction abbreviations are
 *   meaningless during STAGING (teams resolving) and ENDGAME (voting).
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

  // LIVE-gating rationale: faction abbreviations (e.g. "US", "RUS", "GB", "CAF") are only
  // meaningful during active gameplay. During STAGING (teams resolving, map loading) and
  // ENDGAME (scoreboard, voting), player roles may not be loaded yet or may reflect the
  // previous round's factions. Polling is therefore restricted to the LIVE phase only.
  // Once both teams are resolved (cache complete), polling stops automatically — no need
  // to keep scanning every interval. A NEW_GAME event clears the cache and polling resumes
  // when LIVE is reached again.
  _ensurePollingState() {
    const live = this.gameState.isLive();
    const hasBoth = this._hasBothTeams();

    if (!live || hasBoth) {
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
    if (!this.gameState.isLive()) return;

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