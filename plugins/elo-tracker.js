/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                      ELO TRACKER PLUGIN                      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Main SquadJS plugin entry point. Orchestrates session tracking,
 * ELO calculation, database persistence, Discord integration, and
 * in-game command handling across the round lifecycle.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * EloTracker (default)
 *   Extends BasePlugin. Registers and handles all SquadJS events.
 *   Key public methods:
 *     mount()                     — Initialises DB, session, Discord channels, and listeners.
 *     unmount()                   — Removes all listeners and clears ready state.
 *     getTeamElo(players)         — Returns average mu for a player array.
 *     getRatingsByEosIDs(eosIDs)  — Batch DB lookup; returns Map<eosID, rating>.
 *     buildRoundStartData()       — Builds team balance snapshot for Discord embeds.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * BasePlugin (./base-plugin.js)
 *   SquadJS base class providing server, options, and connectors.
 * Logger (../../core/logger.js)
 *   Verbose logging throughout all event handlers.
 * EloDatabase (../utils/elo-database.js)
 *   SQLite persistence for player stats, round history, and plugin state.
 * EloSessionManager (../utils/elo-session-manager.js)
 *   In-memory session tracker for player team segments and participation.
 * EloCalculator (../utils/elo-calculator.js)
 *   TrueSkill math module for computing per-player mu/sigma deltas.
 * EloDiscord (../utils/elo-discord.js)
 *   Discord embed builders, send helper, and Discord command registration.
 * EloCommands (../utils/elo-commands.js)
 *   In-game chat command handlers for !elo and !eloadmin.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - eloCache (Map<eosID, { mu, sigma, roundsPlayed, wins, losses }>)
 *   holds connected players only. Populated on UPDATED_PLAYER_INFORMATION,
 *   flushed on round end. All rating reads during a round use the cache.
 * - Restart recovery: on mount, persisted roundStartTime is compared to
 *   server.matchStartTime. If within 3 hours, the session resumes in-place.
 *   Otherwise a fresh round starts.
 * - Rating writes use bulkIncrementPlayerStats(), which INCREMENTS wins,
 *   losses, and roundsPlayed. Pass only the round delta — not cumulative totals.
 * - ignoredGameModes matches against both gamemode and layerName
 *   (case-insensitive substring). Default: ["Seed", "Jensen"].
 * - The round start embed posts after roundStartEmbedDelayMs (default 3 min)
 *   via a deferred check on UPDATED_PLAYER_INFORMATION.
 *
 * ─── COMMANDS ────────────────────────────────────────────────────
 *
 * In-Game — Public (all channels):
 *   !elo                           → Your ELO rating and rank.
 *   !elo <name | steamID>          → Look up another player's rating.
 *   !elo leaderboard               → Top 10 players by rating.
 *   !elo help                      → Show available commands.
 *
 * In-Game — Admin (ChatAdmin only):
 *   !eloadmin status               → Plugin status and current round info.
 *   !eloadmin reset <name|steamID> → Reset a player to default rating.
 *   !eloadmin help                 → Show available commands.
 *
 * Discord — Public (public + admin channel):
 *   !elo                           → Your linked ELO rating, rank, and local leaderboard.
 *   !elo <name | steamID | eosID>  → Look up another player.
 *   !elo link <SteamID>            → Link your Discord to your SteamID.
 *   !elo leaderboard [rank]        → Show 25 players, optionally centered around a specific rank.
 *   !elo explain                   → How the TrueSkill ranking system works.
 *   !elo help                      → Show available commands.
 *
 * Discord — Admin (admin channel only):
 *   !elo status                    → Plugin status and current round info.
 *   !elo roundinfo                 → Live round snapshot: team balance and veterancy.
 *   !elo reset                     → Wipe ALL ratings + history (requires confirm).
 *   !elo reset confirm             → Confirm a pending full reset.
 *   !elo reset <name|steamID>      → Reset a single player to default rating.
 *   !elo backup                    → Export all player stats as a JSON attachment.
 *   !elo restore                   → Restore from a JSON backup (attach file).
 *
 * ─── CONFIGURATION ───────────────────────────────────────────────
 *
 * Core:
 *   database                   - Sequelize/SQLite connector for persistent storage.
 *   enablePublicIngameCommands - Enable/disable public !elo in-game commands.
 *   eloLogPath                 - Path to JSONL file for round outcome history.
 *
 * ELO Algorithm:
 *   minParticipationRatio      - Min fraction of round played to earn ELO (default: 0.15).
 *
 * Eligibility:
 *   minPlayersForElo           - Min server population to run ELO updates (default: 80).
 *   minRoundsForLeaderboard    - Rounds required to appear in rankings (default: 10).
 *   ignoredGameModes           - Game modes excluded from ELO tracking (default: ["Seed", "Jensen"]).
 *
 * Discord:
 *   discordClient              - Discord connector name.
 *   discordAdminChannelID      - Channel ID for admin commands.
 *   discordPublicChannelID     - Channel ID for public-facing commands.
 *   discordReportChannelID     - Channel ID for automated reports (round summaries, balance tracking). Defaults to admin channel if unset.
 *   discordAdminRoleIDs        - Array of Role IDs required for Discord admin commands. Leave empty to allow all users in the admin channel.
 *   roundStartEmbedDelayMs     - Delay after round start before posting embed (default: 180000).
 *
 * "connectors": {
 *   "sqlite": { "dialect": "sqlite", "storage": "squad-server.sqlite" },
 *   "discord": { "connector": "discord", "token": "YOUR_BOT_TOKEN" }
 * },
 * {
 *   "plugin": "EloTracker",
 *   "enabled": true,
 *   "database": "sqlite",
 *   "eloLogPath": "./elo-match-log.jsonl",
 *   "minParticipationRatio": 0.15,
 *   "minPlayersForElo": 80,
 *   "minRoundsForLeaderboard": 10,
 *   "roundStartEmbedDelayMs": 180000,
 *   "ignoredGameModes": ["Seed", "Jensen"],
 *   "enablePublicIngameCommands": true,
 *   "discordClient": "discord",
 *   "discordAdminChannelID": "",
 *   "discordPublicChannelID": "",
 *   "discordReportChannelID": "",
 *   "discordAdminRoleIDs": []
 * }
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { appendFileSync, promises as fsPromises } from 'fs';
import BasePlugin from './base-plugin.js';
import Logger from '../../core/logger.js';
import EloDatabase from '../utils/elo-database.js';
import EloSessionManager from '../utils/elo-session-manager.js';
import EloCalculator from '../utils/elo-calculator.js';
import { EloDiscord } from '../utils/elo-discord.js';
import EloCommands from '../utils/elo-commands.js';

export default class EloTracker extends BasePlugin {
  static version = '1.2.3';

  static get description() {
    return 'A SquadJS plugin that tracks player participation across rounds, computes individual ELO ratings using a TrueSkill-based algorithm, and persists all data via SQLite.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      database: {
        required: true,
        connector: 'sequelize',
        description: 'Sequelize/SQLite connector.',
        default: 'sqlite'
      },
      eloLogPath: { required: false, default: './elo-match-log.jsonl', type: 'string' },
      minParticipationRatio: { default: 0.15, type: 'number' },
      minPlayersForElo: { default: 80, type: 'number' },
      minRoundsForLeaderboard: { default: 10, type: 'number' },
      roundStartEmbedDelayMs: { required: false, default: 180000, type: 'number' },
      ignoredGameModes: { default: ['Seed', 'Jensen'], type: 'array' },
      enablePublicIngameCommands: { default: true, type: 'boolean' },
      discordClient: {
        required: false,
        connector: 'discord',
        description: 'Discord connector.',
        default: 'discord'
      },
      discordAdminChannelID: { required: false, default: '', type: 'string' },
      discordPublicChannelID: { required: false, default: '', type: 'string' },
      discordReportChannelID: { required: false, default: '', type: 'string' },
      discordAdminRoleIDs: { required: false, default: [], type: 'array' },
      discordAdminRoleID: { required: false, default: '', type: 'string' }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.db = new EloDatabase(server, options, connectors);
    this.session = new EloSessionManager();

    this.thresholds = {
      visitorMaxGames: 3,      // 0-3 games
      provisionalMaxGames: 9,  // 4-9 games
      regularMinGames: 10,     // 10+ games
      troublingDelta: 1.5,     // Delta Mu trigger
      criticalDelta: 3.0,      // Delta Mu trigger
      imbalanceRatio: 1.5      // 50% more regulars trigger
    };

    // ELO cache — Map<eosID, { mu, sigma, roundsPlayed, wins, losses }>
    // Connected players only. Populated on join, flushed at round end.
    this.eloCache = new Map();

    this.discordAdminChannel = null;
    this.discordPublicChannel = null;
    this.discordReportChannel = null;

    // Fallback logic
    if ((!this.options.discordAdminRoleIDs || this.options.discordAdminRoleIDs.length === 0) && this.options.discordAdminRoleID) {
      this.options.discordAdminRoleIDs = [this.options.discordAdminRoleID];
    }

    this._isMounted = false;
    this.ready = false;
    this._roundStartEmbedPending = null;
    this.lastRoundSnapshot = null;
    this.lastKnownGoodLayer = null;
    this._scrambleEmbedTimer = null;

    // Bound listeners — mirror TeamBalancer pattern exactly
    this.listeners = {};
    this.listeners.onNewGame = this.onNewGame.bind(this);
    this.listeners.onLayerInfoUpdated = this.onLayerInfoUpdated.bind(this);
    this.listeners.onUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
    this.listeners.onRoundEnded = this.onRoundEnded.bind(this);
    this.listeners.onServerInfoUpdated = this.onServerInfoUpdated.bind(this);
    this.listeners.onTeamBalancerScramble = this.onTeamBalancerScramble.bind(this);
    EloDiscord.registerDiscordCommands(this);
    this.listeners.onDiscordMessage = this.onDiscordMessage.bind(this);
    EloCommands.register(this);
    this.listeners.onEloCommand = this.onEloCommand.bind(this);
    this.listeners.onEloAdminCommand = this.onEloAdminCommand.bind(this);
  }

  async mount() {
    if (this._isMounted) {
      return;
    }
    Logger.verbose('EloTracker', 1, 'Mounting plugin.');
    this.ready = false;

    const { roundStartTime: persistedStartTime } = await this.db.initDB();

    // --- Prune stale player entries ---
    const { tier1, tier2 } = await this.db.pruneStaleEntries(this.options.minRoundsForLeaderboard);
    Logger.verbose('EloTracker', 1, `[mount] Pruned stale entries — Tier 1 (provisional): ${tier1}, Tier 2 (calibrated): ${tier2}`);

    // Restart Recovery
    let serverRoundStart = this.server.matchStartTime ? this.server.matchStartTime.getTime() : null;

    if (!serverRoundStart && this.server.layerHistory && this.server.layerHistory.length > 0) {
      serverRoundStart = this.server.layerHistory[0].time.getTime();
    }

    if (!serverRoundStart) {
      Logger.verbose('EloTracker', 1, 'Restart recovery unavailable: Could not determine server round start time.');
    }

    const threeHours = 3 * 60 * 60 * 1000;

    if (persistedStartTime && serverRoundStart && Math.abs(persistedStartTime - serverRoundStart) < threeHours) {
      // Same round detected after a restart
      this.session.startRound(persistedStartTime);
      Logger.verbose('EloTracker', 1, `Restart detected. Resuming round from saved start time: ${new Date(persistedStartTime).toISOString()}`);
      // Immediately populate sessions for currently connected players
      this.session.updatePlayers(this.server.players, persistedStartTime);
    } else {
      // Fresh round
      const now = Date.now();
      this.session.startRound(now);
      await this.db.saveRoundStartTime(now);
      Logger.verbose('EloTracker', 1, `New round started. Start time set to: ${new Date(now).toISOString()}`);
    }

    // Fetch Discord channels
    if (this.options.discordClient) {
      if (this.options.discordAdminChannelID) {
        try {
          this.discordAdminChannel = await this.options.discordClient.channels.fetch(this.options.discordAdminChannelID);
          Logger.verbose('EloTracker', 1, `Fetched admin Discord channel: ${this.discordAdminChannel.name}`);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `Could not fetch admin Discord channel (ID: ${this.options.discordAdminChannelID}): ${err.message}`);
        }
      }
      if (this.options.discordPublicChannelID) {
        try {
          this.discordPublicChannel = await this.options.discordClient.channels.fetch(this.options.discordPublicChannelID);
          Logger.verbose('EloTracker', 1, `Fetched public Discord channel: ${this.discordPublicChannel.name}`);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `Could not fetch public Discord channel (ID: ${this.options.discordPublicChannelID}): ${err.message}`);
        }
      }
      if (this.options.discordReportChannelID) {
        try {
          this.discordReportChannel = await this.options.discordClient.channels.fetch(this.options.discordReportChannelID);
          Logger.verbose('EloTracker', 1, `Fetched report Discord channel: ${this.discordReportChannel.name}`);
        } catch (err) {
          Logger.verbose('EloTracker', 1, `Could not fetch report Discord channel (ID: ${this.options.discordReportChannelID}): ${err.message}`);
        }
      }
    }

    // Register listeners
    this.server.removeListener('NEW_GAME', this.listeners.onNewGame);
    this.server.removeListener('UPDATED_LAYER_INFORMATION', this.listeners.onLayerInfoUpdated);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);
    this.server.removeListener('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.removeListener('UPDATED_SERVER_INFORMATION', this.listeners.onServerInfoUpdated);
    this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.listeners.onTeamBalancerScramble);
    this.server.removeListener('CHAT_COMMAND:elo', this.listeners.onEloCommand);
    this.server.removeListener('CHAT_COMMAND:eloadmin', this.listeners.onEloAdminCommand);

    this.server.on('NEW_GAME', this.listeners.onNewGame);
    this.server.on('UPDATED_LAYER_INFORMATION', this.listeners.onLayerInfoUpdated);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);
    this.server.on('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.on('UPDATED_SERVER_INFORMATION', this.listeners.onServerInfoUpdated);
    this.server.on('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.listeners.onTeamBalancerScramble);
    this.server.on('CHAT_COMMAND:elo', this.listeners.onEloCommand);
    this.server.on('CHAT_COMMAND:eloadmin', this.listeners.onEloAdminCommand);

    if (this.server.currentLayer) {
      await this.resolveLayerInfo(this.server.currentLayer, 'mount');
    }
    
    if (this.options.discordClient) {
      this.options.discordClient.removeListener('message', this.listeners.onDiscordMessage);
      this.options.discordClient.on('message', this.listeners.onDiscordMessage);
    }

    this._isMounted = true;
    this.ready = true;
    Logger.verbose('EloTracker', 1, 'Plugin mounted and ready.');
  }

  async unmount() {
    if (!this._isMounted) {
      return;
    }
    Logger.verbose('EloTracker', 1, 'Unmounting plugin.');

    this.server.removeListener('NEW_GAME', this.listeners.onNewGame);
    this.server.removeListener('UPDATED_LAYER_INFORMATION', this.listeners.onLayerInfoUpdated);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);
    this.server.removeListener('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.removeListener('UPDATED_SERVER_INFORMATION', this.listeners.onServerInfoUpdated);
    this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.listeners.onTeamBalancerScramble);
    this.server.removeListener('CHAT_COMMAND:elo', this.listeners.onEloCommand);
    this.server.removeListener('CHAT_COMMAND:eloadmin', this.listeners.onEloAdminCommand);

    if (this.options.discordClient) {
      this.options.discordClient.removeListener('message', this.listeners.onDiscordMessage);
    }

    if (this._scrambleEmbedTimer) {
      clearTimeout(this._scrambleEmbedTimer);
      this._scrambleEmbedTimer = null;
    }

    this.ready = false;
    this._isMounted = false;
    Logger.verbose('EloTracker', 1, 'Plugin unmounted.');
  }

  /**
   * Event Handlers
   */

  inferGameMode(layerName) {
    if (!layerName) return 'Unknown';
    const name = layerName.toLowerCase();
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
        Logger.verbose('EloTracker', 1, `[${source}] Failed to resolve layer promise: ${err.message}`);
        layer = null;
      }
    }
    
    if (!layer) {
      Logger.verbose('EloTracker', 3, `[${source}] Layer object is completely null or undefined.`);
      return false;
    }
    
    let gamemode = 'Unknown';
    let name = 'Unknown';

    if (typeof layer === 'string') {
      name = layer;
      gamemode = this.inferGameMode(name);
      Logger.verbose('EloTracker', 4, `[${source}] Layer is a string ("${layer}"), inferred gamemode: ${gamemode}.`);
    } else if (typeof layer === 'object') {
      name = layer.name || layer.layer || 'Unknown';
      gamemode = layer.gamemode || this.inferGameMode(name);
      if (gamemode === 'Unknown' || name === 'Unknown') {
         Logger.verbose('EloTracker', 4, `[${source}] Layer object missing properties: ${JSON.stringify(layer)}`);
      }
    }

    this.lastKnownGoodLayer = { gamemode, name };
    Logger.verbose('EloTracker', 4, `[${source}] Layer info updated: ${gamemode} / ${name}`);
    return true;
  }

   async onNewGame(data) {
     if (!this.ready) return;

     Logger.verbose('EloTracker', 1, 'NEW_GAME event received. Starting new session.');

     if (data && data.layer) {
       await this.resolveLayerInfo(data.layer, 'onNewGame');
     }

     const now = Date.now();
     this.session.startRound(now);
     await this.db.saveRoundStartTime(now);
     this.lastRoundSnapshot = null;
     this.eloCache.clear();
     this._roundStartEmbedPending = Date.now();

     // NOTE (null-teamID transient): SquadJS RCON polling may return players with 
     // teamID === null immediately after NEW_GAME fires (see SQUADJS_PLUGIN_DEV_REFERENCE.md, 
     // Section 3). At full-server scale (93–99 players), the ENTIRE roster can be null-teamID 
     // for up to ~35 seconds as players load into the new map. The session manager will record 
     // these null-teamID states as initial segments; when teamID resolves, a "team switch" is 
     // detected and a new segment is opened. This means players' null-teamID wait time (~30–35s) 
     // contributes nothing to their timeOnTeam1 or timeOnTeam2, and thus does not factor into 
     // participationRatio. This is expected behaviour and harmless — the impact is <1% of a 
     // typical round. All tracking resumes normally once teamIDs resolve.
   }

  /**
   * Periodic update for player info.
   * Backgrounds DB fetches to prevent RCON/Main-thread stalls.
   */
  onUpdatedPlayerInfo() {
    if (!this.ready) return;

    const allPlayers = this.server.players;
    this.session.updatePlayers(allPlayers);

    // Sync check for uncached players (No .filter/.map to save memory)
    const uncachedIDs = [];
    for (let i = 0; i < allPlayers.length; i++) {
      const p = allPlayers[i];
      if (p?.eosID && !this.eloCache.has(p.eosID)) {
        uncachedIDs.push(p.eosID);
      }
    }

    if (uncachedIDs.length > 0) {
      // Non-blocking fetch
      this.db.getPlayerStatsBatch(uncachedIDs)
        .then((dbResults) => {
          // Re-verify connection state to prevent ghost caching
          const livePlayers = new Set(this.server.players.map(p => p.eosID));

          for (const [eosID, record] of dbResults) {
            if (livePlayers.has(eosID)) {
              this.eloCache.set(eosID, record || {
                mu: EloCalculator.MU_DEFAULT,
                sigma: EloCalculator.SIGMA_DEFAULT,
                roundsPlayed: 0,
                wins: 0,
                losses: 0
              });
            }
          }
        })
        .catch((err) => Logger.verbose('EloTracker', 1, `Background fetch failed: ${err.message}`));
    }

    // Delayed Round Start Embed logic — retry on each tick until threshold met or timeout expires
    if (this._roundStartEmbedPending !== null) {
      const elapsed = Date.now() - this._roundStartEmbedPending;
      const maxRetryMs = this.options.roundStartEmbedDelayMs + (10 * 60 * 1000); // delay + 10 min retry window

      if (elapsed >= this.options.roundStartEmbedDelayMs) {
        if (this.eloCache.size > 0 && allPlayers.length > this.options.minPlayersForElo) {
          this._roundStartEmbedPending = null; // success — clear and fire
          this.sendDelayedStartEmbed();
        } else if (elapsed >= maxRetryMs) {
          this._roundStartEmbedPending = null; // expired — give up silently
          Logger.verbose('EloTracker', 1, 'Round start embed abandoned: player count never recovered within retry window.');
        }
        // else: still within retry window but below threshold — leave pending and retry next tick
      }
    }
  }

  /**
   * Handles heavy embed construction and Discord API calls.
   */
  async sendDelayedStartEmbed() {
    try {
      const targetChannel = this.discordReportChannel || this.discordPublicChannel || this.discordAdminChannel;
      if (!targetChannel) return;
      const embedData = this.buildRoundStartData();
      const embed = EloDiscord.buildRoundStartEmbed(embedData);
      await EloDiscord.sendDiscordMessage(targetChannel, { embeds: [embed] });
      Logger.verbose('EloTracker', 1, 'Round start embed posted.');
    } catch (err) {
      Logger.verbose('EloTracker', 1, `Failed to post start embed: ${err.message}`);
    }
  }

  async onTeamBalancerScramble(data) {
    if (!this.ready) return;
    
    Logger.verbose('EloTracker', 1, '[onTeamBalancerScramble] Event received. Waiting 5s to capture post-scramble state...');
    
    this._scrambleEmbedTimer = setTimeout(async () => {
      try {
        const embedData = this.buildRoundStartData();
        if (embedData.status === 'warming' || embedData.status === 'empty') {
          Logger.verbose('EloTracker', 1, '[onTeamBalancerScramble] Data not ready, skipping embed.');
          return;
        }
        
        const embed = EloDiscord.buildRoundStartEmbed(embedData, 'manual');
        embed.title = `🔀 Post-Scramble Team Balance - ${embedData.layerName || 'Unknown'}`;
        
        const targetChannel = this.discordReportChannel || this.discordPublicChannel || this.discordAdminChannel;
        if (targetChannel) {
          await EloDiscord.sendDiscordMessage(targetChannel, { embeds: [embed] });
        }
        Logger.verbose('EloTracker', 1, '[onTeamBalancerScramble] Post-scramble embed posted.');
      } catch (err) {
        Logger.verbose('EloTracker', 1, `[onTeamBalancerScramble] Failed to post scramble embed: ${err.message}`);
      }
    }, 5000);
  }

  async onLayerInfoUpdated() {
    try {
      await this.resolveLayerInfo(this.server.currentLayer, 'onLayerInfoUpdated');
    } catch (err) {
      Logger.verbose('EloTracker', 4, `Error in onLayerInfoUpdated: ${err.message}`);
    }
  }

  async onServerInfoUpdated(info) {
    try {
      if (info && info.currentLayer) {
        const incomingName = typeof info.currentLayer === 'string'
          ? info.currentLayer
          : info.currentLayer?.name;

        if (this.lastKnownGoodLayer?.name === incomingName) return;

        await this.resolveLayerInfo(info.currentLayer, 'onServerInfoUpdated');
      }
    } catch (err) {
      Logger.verbose('EloTracker', 4, `Error in onServerInfoUpdated: ${err.message}`);
    }
  }

  isIgnoredMatch() {
    let gameMode = this.server.currentLayer?.gamemode ?? '';
    let layerName = this.server.currentLayer?.name ?? '';
    
    if (!gameMode && !layerName) {
      if (!this.lastKnownGoodLayer) return 'Unknown'; // distinct from null/"not ignored"
      gameMode = this.lastKnownGoodLayer.gamemode;
      layerName = this.lastKnownGoodLayer.name;
    }

    const gameModeLower = gameMode.toLowerCase();
    const layerNameLower = layerName.toLowerCase();

    for (const ignoredMode of this.options.ignoredGameModes) {
      const ignoredLower = ignoredMode.toLowerCase();
      if (gameModeLower.includes(ignoredLower) || layerNameLower.includes(ignoredLower)) {
        return ignoredMode;
      }
    }

    return null;
  }

  async onRoundEnded(data) {
    const gameMode = this.server.currentLayer?.gamemode
      ?? this.lastKnownGoodLayer?.gamemode
      ?? null;

    const layerName = this.server.currentLayer?.name
      ?? this.lastKnownGoodLayer?.name
      ?? 'Unknown';

    if (!this.ready) {
      Logger.verbose('EloTracker', 1, '[onRoundEnded] Fired but plugin not ready. Skipping.');
      const targetReportChannel = this.discordReportChannel || this.discordAdminChannel;
      if (targetReportChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed('Plugin not ready at round end', 0, layerName);
        await EloDiscord.sendDiscordMessage(targetReportChannel, { embeds: [embed] });
      }
      return;
    }

    const roundEndTime = Date.now();

    // --- Eligibility checks ---
    const playerCount = this.server.players.length;

    if (playerCount < this.options.minPlayersForElo) {
      Logger.verbose('EloTracker', 1, `[onRoundEnded] Skipping ELO update: player count ${playerCount} below threshold ${this.options.minPlayersForElo}.`);
      const targetReportChannel = this.discordReportChannel || this.discordAdminChannel;
      if (targetReportChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed(`Player count below threshold (Gamemode: ${gameMode ?? 'Unknown'})`, playerCount, layerName);
        await EloDiscord.sendDiscordMessage(targetReportChannel, { embeds: [embed] });
      }
      return;
    }

    const ignoredReason = this.isIgnoredMatch();
    if (ignoredReason) {
      const label = ignoredReason === 'Unknown' ? 'Game mode unknown — skipping (safe default)' : `Ignored match type: ${ignoredReason}`;
      Logger.verbose('EloTracker', 1, `[onRoundEnded] ${label}`);
      const targetReportChannel = this.discordReportChannel || this.discordAdminChannel;
      if (targetReportChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed(`Ignored match type: ${ignoredReason}`, playerCount, layerName);
        await EloDiscord.sendDiscordMessage(targetReportChannel, { embeds: [embed] });
      }
      return;
    }

    // --- Session flush ---
    const participants = this.session.endRound(roundEndTime);

    // --- Determine outcome ---
    // SquadJS ROUND_ENDED data.winner is an object like { team: '1', tickets: 150 }
    const winningTeamID = data?.winner ? parseInt(data.winner.team, 10) : null;
    const ticketDiff = Math.abs((data?.winner?.tickets ?? 0) - (data?.loser?.tickets ?? 0));
    const outcome = winningTeamID === 1 ? 'team1win'
                  : winningTeamID === 2 ? 'team2win'
                  : 'draw';

    // --- Filter by minParticipationRatio ---
    const eligible = participants.filter(
      p => p.participationRatio >= this.options.minParticipationRatio
    );

    if (eligible.length === 0) {
      Logger.verbose('EloTracker', 1, '[onRoundEnded] No eligible participants. Skipping ELO update.');
      const targetReportChannel = this.discordReportChannel || this.discordAdminChannel;
      if (targetReportChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed(
          `No eligible participants (0 players met minParticipationRatio of ${this.options.minParticipationRatio})`,
          participants.length,
          layerName
        );
        await EloDiscord.sendDiscordMessage(targetReportChannel, { embeds: [embed] });
      }
      return;
    }

    const calculationStartTime = Date.now();

    // --- Build team arrays with mu/sigma from cache ---
    const getRating = (eosID) =>
      this.eloCache.get(eosID) ?? { mu: EloCalculator.MU_DEFAULT, sigma: EloCalculator.SIGMA_DEFAULT };

    const team1Eligible = eligible.filter(p => p.assignedTeamID === 1);
    const team2Eligible = eligible.filter(p => p.assignedTeamID === 2);

    if (team1Eligible.length === 0 || team2Eligible.length === 0) {
      Logger.verbose('EloTracker', 1, `[onRoundEnded] Skipping ELO update: One or both teams have no eligible participants (Team 1: ${team1Eligible.length}, Team 2: ${team2Eligible.length}).`);
      const targetReportChannel = this.discordReportChannel || this.discordAdminChannel;
      if (targetReportChannel) {
        const embed = EloDiscord.buildRoundSkippedEmbed(
          `One or both teams had no eligible participants (Gamemode: ${gameMode ?? 'Unknown'})`,
          playerCount,
          layerName
        );
        await EloDiscord.sendDiscordMessage(targetReportChannel, { embeds: [embed] });
      }
      return;
    }

    // --- Run TrueSkill ---
    const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(
      team1Eligible.map(p => ({ ...getRating(p.eosID), participationRatio: p.participationRatio })),
      team2Eligible.map(p => ({ ...getRating(p.eosID), participationRatio: p.participationRatio })),
      outcome
    );

    const team1RatingsBefore = team1Eligible.map(p => getRating(p.eosID));
    const team2RatingsBefore = team2Eligible.map(p => getRating(p.eosID));

    // --- Apply participation scaling, build DB updates, track topMovers ---
    const dbUpdates = [];
    const now = Date.now();

    const processTeam = (players, updates, isWinner, isLoser) => {
      const metrics = this._getMatchMetrics(players);
      let totalDeltaMu = 0;
      let totalDeltaSigma = 0;
      const teamRegulars = [];

      players.forEach((player, i) => {
        const { deltaMu, deltaSigma } = updates[i];
        const rating = getRating(player.eosID);
        const scaledDeltaMu = deltaMu * player.participationRatio;
        const scaledDeltaSigma = deltaSigma * player.participationRatio;

        totalDeltaMu += scaledDeltaMu;
        totalDeltaSigma += Math.abs(scaledDeltaSigma); // Sum absolute change in uncertainty

        const newMu = rating.mu + scaledDeltaMu;
        const newSigma = Math.max(rating.sigma - scaledDeltaSigma, 0.5);
        const wins = (rating.wins ?? 0) + (isWinner ? 1 : 0);
        const losses = (rating.losses ?? 0) + (isLoser ? 1 : 0);

        dbUpdates.push({
          eosID: player.eosID,
          steamID: player.steamID ?? null,
          name: player.name,
          mu: newMu,
          sigma: newSigma,
          wins: isWinner ? 1 : 0,    // NOTE: bulkIncrementPlayerStats must INCREMENT not overwrite
          losses: isLoser ? 1 : 0,
          roundsPlayed: 1,
          lastSeen: now
        });

        // Track Regulars for Spread Snapshot
        const rounds = rating.roundsPlayed ?? 0;
        if (rounds >= this.thresholds.regularMinGames) {
          teamRegulars.push({
            name: player.name,
            muBefore: rating.mu,
            muAfter: newMu,
            deltaMu: scaledDeltaMu
          });
        }

        // Update cache immediately
        this.eloCache.set(player.eosID, { mu: newMu, sigma: newSigma, roundsPlayed: rounds + 1, wins, losses });
      });

      // Calculate Spread Snapshot
      teamRegulars.sort((a, b) => b.muBefore - a.muBefore);
      let spreadSnapshot = [];
      if (teamRegulars.length <= 5) {
        spreadSnapshot = teamRegulars.map((r, i) => ({ ...r, label: `${i + 1}.` }));
      } else {
        const midIndex = Math.floor(teamRegulars.length / 2);
        spreadSnapshot = [
          { ...teamRegulars[0], label: 'Top:' },
          { ...teamRegulars[1], label: 'Top:' },
          { ...teamRegulars[midIndex], label: 'Mid:' },
          { ...teamRegulars[teamRegulars.length - 2], label: 'Bot:' },
          { ...teamRegulars[teamRegulars.length - 1], label: 'Bot:' }
        ];
      }

      // Averages calculated outside of forEach loop after summation is complete
      return {
        ...metrics,
        avgDeltaMu: players.length > 0 ? totalDeltaMu / players.length : 0,
        avgDeltaSigma: players.length > 0 ? totalDeltaSigma / players.length : 0,
        spreadSnapshot
      };
    };

    const team1IsWinner = outcome === 'team1win';
    const team2IsWinner = outcome === 'team2win';
    const team1Summary = processTeam(team1Eligible, team1Updates, team1IsWinner, team2IsWinner);
    const team2Summary = processTeam(team2Eligible, team2Updates, team2IsWinner, team1IsWinner);

    // --- DB writes ---
    try {
      await this.db.bulkIncrementPlayerStats(dbUpdates);
      await this.db.insertRoundHistory({
        layerName: layerName,
        winningTeamID,
        ticketDiff: ticketDiff,
        roundDuration: roundEndTime - this.session.roundStartTime,
        endedAt: roundEndTime,
        playerCount: eligible.length
      });
    } catch (err) {
      Logger.verbose('EloTracker', 1, `[onRoundEnded] DB write failed: ${err.message}`);
    }

    const matchRecord = {
      ts: roundEndTime,
      matchId: roundEndTime.toString(),
      endedAt: roundEndTime,
      layerName: layerName,
      gameMode: gameMode ?? 'Unknown',
      outcome,
      roundDuration: roundEndTime - this.session.roundStartTime,
      params: {
        BETA: EloCalculator.BETA,
        TAU: EloCalculator.TAU,
        DRAW_PROBABILITY: EloCalculator.DRAW_PROBABILITY
      },
      players: [
        ...team1Eligible.map((player, i) => {
          const rating = team1RatingsBefore[i];
          const { deltaMu, deltaSigma } = team1Updates[i];
          const scaledDeltaMu = deltaMu * player.participationRatio;
          const scaledDeltaSigma = deltaSigma * player.participationRatio;
          return {
            eosID: player.eosID,
            name: player.name,
            teamID: 1,
            participationRatio: player.participationRatio,
            muBefore: rating.mu,
            sigmaBefore: rating.sigma,
            rawDeltaMu: deltaMu,
            rawDeltaSigma: deltaSigma,
            scaledDeltaMu,
            scaledDeltaSigma,
            muAfter: rating.mu + scaledDeltaMu,
            sigmaAfter: Math.max(rating.sigma - scaledDeltaSigma, 0.5)
          };
        }),
        ...team2Eligible.map((player, i) => {
          const rating = team2RatingsBefore[i];
          const { deltaMu, deltaSigma } = team2Updates[i];
          const scaledDeltaMu = deltaMu * player.participationRatio;
          const scaledDeltaSigma = deltaSigma * player.participationRatio;
          return {
            eosID: player.eosID,
            name: player.name,
            teamID: 2,
            participationRatio: player.participationRatio,
            muBefore: rating.mu,
            sigmaBefore: rating.sigma,
            rawDeltaMu: deltaMu,
            rawDeltaSigma: deltaSigma,
            scaledDeltaMu,
            scaledDeltaSigma,
            muAfter: rating.mu + scaledDeltaMu,
            sigmaAfter: Math.max(rating.sigma - scaledDeltaSigma, 0.5)
          };
        })
      ]
    };
    this._appendMatchLog(matchRecord).catch(err => Logger.verbose('EloTracker', 1, `Failed to append match log: ${err.message}`));

    const calculationDuration = Date.now() - calculationStartTime;

    // --- Discord post ---
    const targetReportChannel = this.discordReportChannel || this.discordAdminChannel;
    if (targetReportChannel) {
      try {
        const liveT1 = this._getMatchMetrics(this.server.players.filter(p => p.teamID === 1));
        const liveT2 = this._getMatchMetrics(this.server.players.filter(p => p.teamID === 2));

        const embed = EloDiscord.buildRoundSummaryEmbed({
          layerName: layerName,
          gameMode,
          winningTeamID,
          ticketDiff: ticketDiff,
          roundDuration: roundEndTime - this.session.roundStartTime,
          totalPlayerCount: this.server.players.length,
          playersUpdatedCount: eligible.length,
          team1Summary,
          team2Summary,
          liveT1,
          liveT2,
          calculationDuration
        });
        await EloDiscord.sendDiscordMessage(targetReportChannel, { embeds: [embed] });
      } catch (err) {
        Logger.verbose('EloTracker', 1, `[onRoundEnded] Discord post failed: ${err.message}`);
      }
    }

    // --- Flush cache ---
    this.lastRoundSnapshot = new Map(this.eloCache);
    this.eloCache.clear();
    Logger.verbose('EloTracker', 1, `[onRoundEnded] ELO update complete. ${eligible.length} players updated.`);
  }

  buildRoundStartData() {
    const players = this.server.players;

    // If the server is empty, return an 'empty' status instead of 'warming'
    if (players.length === 0) {
      return { status: 'empty', totalPlayerCount: 0 };
    }

    // Fallback for an actual cold cache if players are present
    if (this.eloCache.size === 0 && players.length > 0) {
      return { status: 'warming' };
    }

    const t1Players = players.filter(p => p.teamID === 1);
    const t2Players = players.filter(p => p.teamID === 2);

    const t1 = this._getMatchMetrics(t1Players);
    const t2 = this._getMatchMetrics(t2Players);

    const muDelta = Math.abs(t1.avgMu - t2.avgMu);
    const top15Delta = Math.abs(t1.top15Mu - t2.top15Mu);
    const regDelta = Math.abs(t1.tierStats.rCount - t2.tierStats.rCount);

    const regHigher = Math.max(t1.tierStats.rCount, t2.tierStats.rCount);
    const regLower = Math.min(t1.tierStats.rCount, t2.tierStats.rCount);
    const regRatio = regLower > 0 ? regHigher / regLower : (regHigher > 0 ? Infinity : 1);
    const isPopImbalance = regRatio > this.thresholds.imbalanceRatio && regHigher > regLower;
    
    const veteranLead = t1.tierStats.rCount === t2.tierStats.rCount ? 'Tie' : 
      (t1.tierStats.rCount > t2.tierStats.rCount ? 'Team 1' : 'Team 2');

    const matchVeterancy = (t1.count + t2.count) > 0 
      ? (t1.tierStats.rCount + t2.tierStats.rCount) / (t1.count + t2.count)
      : 0;

    const flags = {
      isHighDelta: muDelta >= this.thresholds.troublingDelta,
      isCriticalDelta: muDelta >= this.thresholds.criticalDelta,
      isPopImbalance
    };

    return {
      layerName: this.server.currentLayer?.name ?? this.lastKnownGoodLayer?.name ?? 'Unknown',
      roundStartTime: this.session.roundStartTime,
      t1, t2,
      muDelta,
      top15Delta,
      regDelta,
      flags,
      veteranLead,
      matchVeterancy,
      totalPlayerCount: players.length
    };
  }

  _getMatchMetrics(players) {
    const thresholds = this.thresholds;
    const defaultMu = EloCalculator.MU_DEFAULT;

    let vCount = 0, pCount = 0, rCount = 0;
    let totalMu = 0, totalRegMu = 0;
    const allMus = [];

    for (const p of players) {
      const cached = this.eloCache.get(p.eosID);
      const mu = cached?.mu ?? defaultMu;
      const rounds = cached?.roundsPlayed ?? 0;

      totalMu += mu;
      allMus.push(mu);
      if (rounds >= thresholds.regularMinGames) {
        rCount++;
        totalRegMu += mu;
      } else if (rounds > thresholds.visitorMaxGames) {
        pCount++;
      } else {
        vCount++;
      }
    }

    const count = players.length;
    const veterancy = count > 0 ? rCount / count : 0;

    // Top 15 average: sort descending, take up to 15, average them
    const top15Slice = [...allMus].sort((a, b) => b - a).slice(0, 15);
    const top15Mu = top15Slice.length > 0
      ? top15Slice.reduce((s, v) => s + v, 0) / top15Slice.length
      : defaultMu;

    return {
      count,
      tierStats: { vCount, pCount, rCount },
      tierString: `${vCount} Visitors | ${pCount} Prov. | ${rCount} Regs`,
      avgMu: count > 0 ? totalMu / count : defaultMu,
      avgRegMu: rCount > 0 ? totalRegMu / rCount : null,
      top15Mu,
      veterancy
    };
  }

  getTeamElo(players) {
    if (!players || players.length === 0) {
      return { averageMu: EloCalculator.MU_DEFAULT, playerCount: 0 };
    }
    const total = players.reduce((sum, p) => {
      const cached = this.eloCache.get(p.eosID);
      return sum + (cached ? cached.mu : EloCalculator.MU_DEFAULT);
    }, 0);
    return {
      averageMu: total / players.length,
      playerCount: players.length
    };
  }

  getMu(player) {
    if (!player) return EloCalculator.MU_DEFAULT;
    const cached = this.eloCache.get(player.eosID);
    if (cached) return cached.mu;
    return EloCalculator.MU_DEFAULT;
  }

  async getRatingsByEosIDs(eosIDs) {
    const results = await this.db.getPlayerStatsBatch(eosIDs);
    return new Map(eosIDs.map(id => [
        id,
        results.get(id) ?? { mu: EloCalculator.MU_DEFAULT, sigma: EloCalculator.SIGMA_DEFAULT, roundsPlayed: 0 }
    ]));
  }

  async _appendMatchLog(record) {
    try {
      await fsPromises.appendFile(this.options.eloLogPath, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      Logger.verbose('EloTracker', 1, `[_appendMatchLog] Failed to write log: ${err.message}`);
    }
  }
}