/**
 * Shared server config service for Slacker's Squad Services (S³).
 *
 * Stage 1 scope:
 * - Parse Squad server configuration files at mount time
 * - Cache key values for runtime access
 * - Provide fallback defaults when files are unavailable
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

// Default fallback values (from current config file contents)
const DEFAULT_CONFIG = {
  // Server.cfg defaults
  AllowTeamChanges: false,
  MaxPlayers: 100,
  NumReservedSlots: 2,
  TimeBetweenMatches: 60, // End round timer before we move to next match in case when voting is OFF
  TimeBeforeVote: 30, // For how long end screen will be displayed before we move to voting
  // VoteConfig.cfg defaults
  TeamVote_Duration: 25, // Duration of voting phase for each faction/team
  LayerVoteDuration: 25 // Duration of voting phase for next layer
};

//Allow team changes lets us (if false) determine the source of team changes. We track all of them except admin team changes. We can infer.
//Max players and Num reserved slots play together to determine how high the server pop naturally goes to. 100 - 2 = 98 is the natural max, if admins join then it can go up to 100. Both TeamBalancer and SmartAssign (and I guess switch too) care about the max team size and this information is going to be very important. Note: 98 may be natural state, but theres lots of admins on so it is normal for it to be full too...
//TimeBetweenMatches is for when voting is off, but we cant tell right now if voting is on. lets assume it always is.
// TimeBeforeVote and LayerVoteDuration is really important for TeamBalancer as it needs to get its scramble out before faction voting starts or it'll get blocked. 
// So when the round ends we get the first timer TimeBeforeVote, the layer voting starts and lasts for LayerVoteDuration, then faction voting starts (and no team changes can occur as the engine blocks it) for TeamVote_Duration amt of time until we get a short 10s window or something (unknown) before the map rolls.
// It should be noted that during the voting, if enough people cast their vote for an option it can end the timer completely and just move forward. So these are hard bounds rather than actual truths... but still... good to know the stage or infer an approximation of the end game phase.
// (1) it'd be nice if the game state could know that our switch failure are probably due to faction voting having been started. 
// (2) we can have more sub phases like the resolving stage, but for the end game where its pre-vote, layerVote, factionVote. We should stop trying to switch players during faction vote (at least SA and Switch plugins).

/**
 * Parse a Squad config file and extract key=value pairs.
 * Handles comments (//), empty lines, and quoted values.
 * @param {string} filePath - Absolute path to the config file
 * @param {string[]} keys - Array of keys to extract
 * @returns {Object} - Object with extracted key-value pairs
 */
function parseConfigFile(filePath, keys) {
  const result = {};

  if (!existsSync(filePath)) {
    return result;
  }

  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
      // Skip empty lines and comments
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) {
        continue;
      }

      // Parse key=value
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;

      const [, key, rawValue] = match;

      // Only extract requested keys
      if (!keys.includes(key)) continue;

      // Remove surrounding quotes if present
      let value = rawValue.trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }

      // Convert to appropriate type
      if (value === 'true' || value === 'false') {
        result[key] = value === 'true';
      } else if (!isNaN(Number(value)) && value !== '') {
        result[key] = Number(value);
      } else {
        result[key] = value;
      }
    }
  } catch (err) {
    // Return empty object on parse error - caller will use defaults
  }

  return result;
}

export default class ServerConfigService {
  constructor({
    parent = null,
    verboseLogger = () => {},
    configPath = './SquadGame/ServerConfig/'
  } = {}) {
    this.parent = parent;
    this.verboseLogger = verboseLogger;

    // Resolve config path relative to SquadJS cwd
    this.configPath = resolve(configPath);

    this._config = { ...DEFAULT_CONFIG };
    this._loadedSuccessfully = false;
    this._isMounted = false;
  }

  /**
   * Get the server config directory path.
   * @returns {string} - The resolved config path
   */
  getConfigPath() {
    return this.configPath;
  }

  /**
   * Check if config files were loaded successfully.
   * @returns {boolean} - True if files were parsed successfully
   */
  isLoadedSuccessfully() {
    return this._loadedSuccessfully;
  }

  /**
   * Check if the service is currently mounted and ready.
   * @returns {boolean} - True if service is mounted
   */
  isReady() {
    return this._isMounted;
  }

  /**
   * Mount the service - parse config files once.
   */
  async mount() {
    if (this._isMounted) {
      await this.unmount();
    }

    const serverCfgPath = join(this.configPath, 'Server.cfg');
    const voteCfgPath = join(this.configPath, 'VoteConfig.cfg');

    // Parse Server.cfg
    const serverKeys = [
      'AllowTeamChanges',
      'MaxPlayers',
      'NumReservedSlots',
      'TimeBetweenMatches',
      'TimeBeforeVote'
    ];
    const serverValues = parseConfigFile(serverCfgPath, serverKeys);

    // Parse VoteConfig.cfg
    const voteKeys = ['TeamVote_Duration', 'LayerVoteDuration'];
    const voteValues = parseConfigFile(voteCfgPath, voteKeys);

    // Merge parsed values with defaults
    this._config = {
      ...DEFAULT_CONFIG,
      ...serverValues,
      ...voteValues
    };

    // Check if at least one file was parsed
    this._loadedSuccessfully =
      Object.keys(serverValues).length > 0 || Object.keys(voteValues).length > 0;

    this.verboseLogger(2, `[ServerConfig] Mounted. Loaded: ${this._loadedSuccessfully}`);
    if (this._loadedSuccessfully) {
      this.verboseLogger(4, `[ServerConfig] Parsed values:`, this._config);
    }
    this.verboseLogger(4, `[ServerConfig] Using config path: ${this.configPath}`);

    this._isMounted = true;
  }

  /**
   * Unmount the service.
   */
  async unmount() {
    this._isMounted = false;
    this.verboseLogger(2, '[ServerConfig] Unmounted.');
  }

  /**
   * Get all parsed config values as a flat object.
   * @returns {Object} - All config values
   */
  getConfig() {
    return { ...this._config };
  }

  // Individual getters for direct access

  /**
   * @returns {boolean} - AllowTeamChanges setting
   */
  getAllowTeamChanges() {
    return this._config.AllowTeamChanges;
  }

  /**
   * @returns {number} - MaxPlayers setting
   */
  getMaxPlayers() {
    return this._config.MaxPlayers;
  }

  /**
   * @returns {number} - NumReservedSlots setting
   */
  getNumReservedSlots() {
    return this._config.NumReservedSlots;
  }

  /**
   * @returns {number} - TimeBetweenMatches setting (seconds)
   */
  getTimeBetweenMatches() {
    return this._config.TimeBetweenMatches;
  }

  /**
   * @returns {number} - TimeBeforeVote setting (seconds)
   */
  getTimeBeforeVote() {
    return this._config.TimeBeforeVote;
  }

  /**
   * @returns {number} - TeamVote_Duration setting (seconds)
   */
  getTeamVoteDuration() {
    return this._config.TeamVote_Duration;
  }

  /**
   * @returns {number} - LayerVoteDuration setting (seconds)
   */
  getLayerVoteDuration() {
    return this._config.LayerVoteDuration;
  }
}