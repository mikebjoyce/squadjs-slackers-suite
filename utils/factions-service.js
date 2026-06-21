/**
 * Shared factions service for Slacker's Squad Services (S³).
 *
 * Stage 1 scope:
 * - Centralize team/faction abbreviation discovery
 * - Provide shared team-name lookup helpers
 * - Keep resolution gated to LIVE phase via gameState service
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
      onNewGame: this.onNewGame.bind(this),
      onRoundEnded: this.onRoundEnded.bind(this),
      onUpdatedPlayerInfo: this.onUpdatedPlayerInfo.bind(this)
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

    this.server.on('NEW_GAME', this.listeners.onNewGame);
    this.server.on('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);

    this._isMounted = true;
    this._ensurePollingState();
    this.verboseLogger(2, '[Factions] Mounted.');
  }

  async unmount() {
    if (!this._isMounted) return;

    this.server.removeListener('NEW_GAME', this.listeners.onNewGame);
    this.server.removeListener('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);

    this.stopPollingTeamAbbreviations();
    this._isMounted = false;
    this.verboseLogger(2, '[Factions] Unmounted.');
  }

  onNewGame() {
    this.cachedAbbreviations = {};
    this.stopPollingTeamAbbreviations();
    this.verboseLogger(3, '[Factions] NEW_GAME detected -> cleared abbreviation cache.');
  }

  onRoundEnded() {
    this.stopPollingTeamAbbreviations();
  }

  onUpdatedPlayerInfo() {
    this._ensurePollingState();
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
