// DEPRECATED — Stage 5: This script imports from sa-clan-grouper.js which was replaced by S³ ClansService.
// sa-clan-grouper.js has been deleted. This test/tool script cannot be migrated to S³ and is retained for reference only.

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                CLAN-TAG-TIMING-TESTER                        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Diagnostic plugin to measure whether clan tags are available at
 * PLAYER_CONNECTED time (log parser) or arrive later via RCON polling.
 * Captures timing and Elo cache state to validate clan grouping design
 * decisions in SmartAssign.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/clan-tag-timing-tester.js
 *
 * Requires a running SquadJS server with the plugin enabled in config.json:
 *   { "plugin": "ClanTagTimingTester", "enabled": true, "targetEOSID": null }
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - This is a DEV-ONLY diagnostic tool. Do NOT deploy to production.
 * - DEPRECATED: imports from sa-clan-grouper.js which was removed in
 *   Stage 5 (replaced by S³ ClansService). Retained for reference only.
 * - Set targetEOSID to null to monitor all joins, or to a specific
 *   EOSID to focus on a single player.
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Logger from '../../core/logger.js';
import BasePlugin from '../plugins/base-plugin.js';
import { extractRawPrefix } from '../utils/sa-clan-grouper.js';

export default class ClanTagTimingTester extends BasePlugin {
  static version = '0.1.0';

  static get description() {
    return 'Diagnostic: Monitors clan tag presence at join vs RCON polling times.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      targetEOSID: {
        required: false,
        description:
          'EOSID of player to monitor (null = monitor all joins). Leave null for broad diagnostics.',
        default: null,
        type: 'string'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    // Track join-state for each player
    // Map<steamID, { joinTime, eosID, nameAtJoin, tagAtJoin, initialRconName, eloKnown, eloDBName, eloDBTag, reports }>
    this.joinStates = new Map();

    // Get reference to EloTracker if available
    this.eloTracker = null;

    this.onPlayerConnected = this.onPlayerConnected.bind(this);
    this.onUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
  }

  async mount() {
    this.eloTracker =
      this.server.plugins.find((p) => p.constructor.name === 'EloTracker') || null;

    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);

    Logger.verbose(
      'ClanTagTimingTester',
      1,
      `[CLAN-TAG-DIAGNOSTIC] Mounted. Monitoring ${
        this.options.targetEOSID ? `player ${this.options.targetEOSID}` : 'all joins'
      }`
    );
  }

  async unmount() {
    this.server.removeListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
  }

  async onPlayerConnected(info) {
    const player = info.player;
    if (!player || !player.steamID) return;

    // Skip if filtering to specific target and this isn't them
    if (this.options.targetEOSID && player.eosID !== this.options.targetEOSID) {
      return;
    }

    const raw = extractRawPrefix(player.name);
    const tag = raw ? raw : null;

    // Check if EloTracker knows this player
    const eloKnown = this._isPlayerKnownToElo(player);

    const state = {
      joinTime: Date.now(),
      eosID: player.eosID,
      nameAtJoin: player.name,
      tagAtJoin: tag,
      initialRconName: null, // Will be set on first UPDATED_PLAYER_INFORMATION
      eloKnown: eloKnown,
      eloDBName: null,
      eloDBTag: null,
      eloDBQueryTime: 0,
      reports: []
    };

    this.joinStates.set(player.steamID, state);

    Logger.verbose(
      'ClanTagTimingTester',
      2,
      `[JOIN] ${player.name} (${player.steamID}) | Tag at join: ${tag ? `"${tag}"` : 'NONE'} | Elo known: ${eloKnown}`
    );

    // Fire async query to Elo DB for historical name (don't await, store result when ready)
    if (this.eloTracker && this.eloTracker.db && player.eosID) {
      this._queryEloDBAsync(player.eosID, state);
    }
  }

  /**
   * Asynchronously queries the Elo DB for a player's historical name.
   * Updates the state object when the result arrives.
   */
  async _queryEloDBAsync(eosID, state) {
    try {
      const dbStart = Date.now();
      const playerStats = await this.eloTracker.db.getPlayerStats(eosID);
      state.eloDBQueryTime = Date.now() - dbStart;

      if (playerStats && playerStats.name) {
        state.eloDBName = playerStats.name;
        const dbRaw = extractRawPrefix(playerStats.name);
        state.eloDBTag = dbRaw ? dbRaw : null;
        Logger.verbose(
          'ClanTagTimingTester',
          3,
          `[ELO-DB] Retrieved historical name for ${eosID}: "${playerStats.name}" → tag: ${state.eloDBTag ? `"${state.eloDBTag}"` : 'NONE'} (${state.eloDBQueryTime}ms)`
        );
      }
    } catch (e) {
      Logger.verbose(
        'ClanTagTimingTester',
        3,
        `[ELO-DB] Query failed for ${eosID}: ${e?.message}`
      );
    }
  }

  async onUpdatedPlayerInfo() {
    const now = Date.now();

    // Check each player currently being tracked
    for (const [steamID, state] of this.joinStates.entries()) {
      const player = this.server.players.find((p) => p.steamID === steamID);

      if (!player) {
        // Player has left — finalize and report
        this._finalizeAndReport(steamID, state, now);
        this.joinStates.delete(steamID);
        continue;
      }

      // First RCON poll after join — capture the name as seen by RCON
      if (state.initialRconName === null) {
        state.initialRconName = player.name;
      }

      // Check if name changed (tag arrived)
      const currentRaw = extractRawPrefix(player.name);
      const currentTag = currentRaw ? currentRaw : null;

      // If tag arrived and we didn't capture it before
      if (currentTag && !state.tagAtJoin && !state.tagArrivedTime) {
        state.tagArrivedTime = now;
        state.tagAfterArrival = currentTag;

        const timeSinceJoin = now - state.joinTime;
        Logger.verbose(
          'ClanTagTimingTester',
          2,
          `[TAG-ARRIVAL] ${player.name}: Tag arrived ${timeSinceJoin}ms after join. Elo known: ${state.eloKnown}`
        );
      }

      // Finalize after ~2 minutes or once tag arrives (if was missing)
      const ageMs = now - state.joinTime;
      if (ageMs > 120000 || state.tagArrivedTime) {
        this._finalizeAndReport(steamID, state, now);
        this.joinStates.delete(steamID);
      }
    }
  }

  /**
   * Generates and logs the final diagnostic report for a player.
   */
  _finalizeAndReport(steamID, state, endTime) {
    const totalTimeMs = endTime - state.joinTime;
    const tagArrivedTimeMs = state.tagArrivedTime ? state.tagArrivedTime - state.joinTime : null;

    const verdict =
      state.tagAtJoin || state.tagAfterArrival
        ? state.tagAtJoin
          ? '✓ TAG AVAILABLE AT JOIN'
          : `⚠ TAG ARRIVED LATE (+${tagArrivedTimeMs}ms)`
        : '✗ NO TAG DETECTED';

    const eloStatus = state.eloKnown ? 'KNOWN (reconnect eligible)' : 'NEW (no reconnect memory)';

    // Determine if Elo DB has a usable fallback
    const eloDBUsable =
      state.eloDBName && state.eloDBTag && !state.tagAtJoin && state.tagAfterArrival;
    const eloDBSection = state.eloDBName
      ? `
  From Elo DB (Historical Name):
    name stored:  "${state.eloDBName}"
    tag found:    ${state.eloDBTag ? `YES → "${state.eloDBTag}"` : 'NO'}
    query time:   ~${state.eloDBQueryTime}ms
    usable:       ${eloDBUsable ? '✓ YES — tag available from history' : state.eloDBTag ? '⚠ YES, but tag also now live' : '✗ NO — no tag in history'}
`
      : `
  From Elo DB (Historical Name):
    (no record)
    usable:       ✗ NO — new player, no history available
`;

    Logger.verbose(
      'ClanTagTimingTester',
      1,
      `
╔═══════════════════════════════════════════════════════════════╗
║             CLAN TAG TIMING DIAGNOSTIC REPORT                 ║
╠═══════════════════════════════════════════════════════════════╣
  Player:       ${state.nameAtJoin}
  SteamID:      ${steamID}
  EOSID:        ${state.eosID}

  At PLAYER_CONNECTED (Log Parser, ~100ms after join):
    name:       "${state.nameAtJoin}"
    tag found:  ${state.tagAtJoin ? `YES → "${state.tagAtJoin}"` : 'NO'}

  At first UPDATED_PLAYER_INFORMATION (RCON poll):
    name:       "${state.initialRconName}"
    tag change: ${state.tagAfterArrival && !state.tagAtJoin ? `YES → arrived +${tagArrivedTimeMs}ms` : 'NONE'}
${eloDBSection}
  Elo Status:   ${eloStatus}
  Total span:   ${totalTimeMs}ms

  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  VERDICT:      ${verdict}
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  IMPLICATION:
${
  state.tagAtJoin
    ? '  • Clan grouping will work correctly for this player.'
    : state.tagAfterArrival
      ? `  • Clan grouping was MISSED at join (+${tagArrivedTimeMs}ms delay).\n  • Within 3s swap window: ${tagArrivedTimeMs < 3000 ? 'maybe recoverable' : 'too late for recovery'}${eloDBUsable ? '\n  • ELO DB FALLBACK: Historical tag available — can pre-resolve from DB' : ''}`
      : '  • No clan tag detected. Clan grouping irrelevant for this player.'
}
${
  !state.eloKnown && state.tagAfterArrival
    ? '  • NEW player with late tag = worst case: no reconnect + no clan grouping + no Elo DB history.'
    : ''
}
╚═══════════════════════════════════════════════════════════════╝`
    );
  }

  /**
   * Checks if EloTracker has a known Elo rating for the player.
   * (Indicates whether they're a new/unknown player or a returning regular.)
   */
  _isPlayerKnownToElo(player) {
    if (!this.eloTracker || !this.eloTracker.ready) {
      return null; // Can't determine
    }

    try {
      // Try internal caches first (same pattern as sa-team-evaluator.js)
      if (this.eloTracker.eloCache && player.eosID) {
        const cached = this.eloTracker.eloCache.get(player.eosID);
        if (cached) return true;
      }

      if (this.eloTracker.eloMap && player.steamID) {
        const mu = this.eloTracker.eloMap.get(player.steamID);
        if (mu !== undefined) return true;
      }

      // Try public API as fallback
      if (typeof this.eloTracker.getMu === 'function') {
        const mu = this.eloTracker.getMu(player);
        return mu !== null && mu !== undefined && mu !== 25.0; // 25 is default for unknowns
      }

      return false;
    } catch (e) {
      Logger.verbose(
        'ClanTagTimingTester',
        3,
        `[ELO-CHECK] Could not determine Elo status: ${e?.message}`
      );
      return null;
    }
  }
}
