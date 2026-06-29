/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                   ELO TRACKER PLUGIN v2.0.0                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * TrueSkill-based player skill rating tracker that persists across
 * server restarts. Orchestrates session tracking, ELO calculation,
 * database persistence (Elo_PlayerStats, Elo_RoundHistory,
 * Elo_RoundPlayers), Discord integration, and in-game command
 * handling across the round lifecycle. Extends S3PluginBase for S³
 * service discovery, DB convenience, and readiness gating. Schema
 * versioning via MigrationEngine.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * EloTracker (default)
 *   Extends S3PluginBase. Registers and handles all SquadJS events.
 *   Key public methods:
 *     mount()                     — Initialises DB, session, Discord channels, and listeners.
 *     unmount()                   — Removes all listeners and clears ready state.
 *     getTeamElo(players)         — Returns average mu for a player array.
 *     getRatingsByEosIDs(eosIDs)  — Batch DB lookup; returns Map<eosID, rating>.
 *     buildRoundStartData()       — Builds team balance snapshot for Discord embeds.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * S3PluginBase (./s3-plugin-base.js)
 *   S³ plugin base class providing S³ discovery, readiness gating, DB convenience,
 *   and flat service accessors. Extends SquadJS BasePlugin under the hood.
 * Logger (../../core/logger.js)
 *   Verbose logging throughout all event handlers.
 * EloDatabase (../utils/elo-database.js)
 *   Multi-database persistence layer (SQLite, MySQL, PostgreSQL, etc.)
 *   for player stats, round history, and plugin state.
 * EloSessionManager (../utils/elo-session-manager.js)
 *   In-memory session tracker for player team segments and participation.
 * EloCalculator (../utils/elo-calculator.js)
 *   TrueSkill math module for computing per-player mu/sigma deltas.
 * EloDiscord (../utils/elo-discord.js)
 *   Discord embed builders, send helper, and Discord command registration.
 * EloCommands (../utils/elo-commands.js)
 *   In-game chat command handlers for !elo and !eloadmin.
 *
 * ─── S³ INTEGRATION ──────────────────────────────────────────────
 *
 * S³ (Slacker's Squad Services) is the centralised service container
 * for shared state across Slacker's Squad plugins.  It owns the
 * ground truth for server configuration, game-state lifecycle,
 * player state, faction metadata, clan grouping, database access,
 * and cross-plugin event routing.  Consumer plugins discover S³ at
 * runtime via this.server.plugins and access services through flat
 * getters (e.g. this._s3?.gameState) guarded by isReady() checks.
 *
 * GitHub: https://github.com/mikebjoyce/squadjs-slackers-squad-services
 *
 * Consumed Services:
 *   - gameState: roundStartTime recovery, layer/gamemode fallback on
 *     server restart, and layer-name checks for ignored game modes.
 *
 * Emitted Events:
 *   - None.
 *
 * Listened Events:
 *   - TEAM_BALANCER_SCRAMBLE_EXECUTED: fired by TeamBalancer after a
 *     scramble; EloTracker captures a team-balance snapshot for Discord
 *     reporting.
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
 * In-Game:
 *
 *   Public (all players):
 *     !elo                           → Your ELO rating and rank.
 *     !elo <name | steamID>          → Look up another player's rating.
 *     !elo leaderboard               → Top 10 players by rating.
 *     !elo help                      → Show available commands.
 *
 *   Admin (ChatAdmin only):
 *     !eloadmin status               → Plugin status and current round info.
 *     !eloadmin reset <name|steamID> → Reset a player to default rating.
 *     !eloadmin help                 → Show available commands.
 *
 * Discord:
 *
 *   Public (public + admin channel):
 *     !elo                           → Your linked ELO rating, rank, and local leaderboard.
 *     !elo <name | steamID | eosID>  → Look up another player.
 *     !elo link <SteamID>            → Link your Discord to your SteamID.
 *     !elo leaderboard [rank]        → Show 25 players, optionally centered around a specific rank.
 *     !elo clans                     → Show the top 25 clans ranked by average CSR.
 *     !elo clan <tag>                → Show detailed roster and stats for a specific clan.
 *     !elo explain                   → How the TrueSkill ranking system works.
 *     !elo help                      → Show available commands.
 *
 *   Admin (admin channel only):
 *     !elo status                    → Plugin status and current round info.
 *     !elo roundinfo                 → Live round snapshot: team balance and veterancy.
 *     !elo clans [n|all]             → Advanced clan leaderboard (n up to 50, "all" for all tags).
 *     !elo reset                     → Wipe ALL ratings + history (requires confirm).
 *     !elo reset confirm             → Confirm a pending full reset.
 *     !elo reset <name|steamID>      → Reset a single player to default rating.
 *     !elo backup                    → Export all player stats as a JSON attachment.
 *     !elo restore                   → Restore from a JSON backup (attach file).
 *
 * ─── AUTHOR ──────────────────────────────────────────────────────
 *
 * Slacker
 * Discord: real_slacker
 * GitHub:  https://github.com/mikebjoyce/squadjs-elo-tracker
 *
 */

import { appendFileSync, promises as fsPromises } from 'fs';
import S3PluginBase from './s3-plugin-base.js';
import Logger from '../../core/logger.js';
import EloDatabase from '../utils/elo-database.js';
import EloSessionManager from '../utils/elo-session-manager.js';
import EloCalculator from '../utils/elo-calculator.js';
import { EloDiscord } from '../utils/elo-discord.js';
import EloCommands from '../utils/elo-commands.js';

export default class EloTracker extends S3PluginBase {
  static version = '2.0.0';

  static get description() {
    return 'A SquadJS plugin that tracks player participation across rounds, computes individual ELO ratings using a TrueSkill-based algorithm, and persists all data via Sequelize-compatible databases (SQLite, MySQL, PostgreSQL, etc.).';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      eloLogPath: { required: false, default: './elo-match-log.jsonl', type: 'string' },
      minParticipationRatio: { default: 0.15, type: 'number' },
      minPlayersForElo: { default: 80, type: 'number' },
      minRoundsForLeaderboard: { default: 10, type: 'number' },
      roundStartEmbedDelayMs: { required: false, default: 180000, type: 'number' },
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
       discordAdminRoleID: { required: false, default: '', type: 'string' },
       enableDatabaseLogging: {
         required: false,
         description: 'If true, mirrors round outcome data into database tables for querying (default: false).',
         default: false,
         type: 'boolean'
       }
     };
   }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.db = new EloDatabase(server, options, null);
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
    this._scrambleEmbedTimer = null;

    // Bound listeners — mirror TeamBalancer pattern exactly
    this.listeners = {};
    this.listeners.onNewGame = this.onNewGame.bind(this);
    this.listeners.onUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
    this.listeners.onRoundEnded = this.onRoundEnded.bind(this);
    this.listeners.onTeamBalancerScramble = this.onTeamBalancerScramble.bind(this);
    EloDiscord.registerDiscordCommands(this);
    this.listeners.onDiscordMessage = this.onDiscordMessage.bind(this);
    EloCommands.register(this);
    this.listeners.onEloCommand = this.onEloCommand.bind(this);
    this.listeners.onEloAdminCommand = this.onEloAdminCommand.bind(this);
  }

  /// S3PluginBase lifecycle hooks

  async _onS3Ready() {
    if (this._isMounted) {
      return;
    }
    Logger.verbose('EloTracker', 1, 'Mounting plugin.');
    this.ready = false;

    // Define Elo models on S³ connector (idempotent — defineModel caches)
    this.defineModel('Elo_PluginState', {
      id: { type: this.s3db?.getDataTypes().INTEGER, primaryKey: true, autoIncrement: false, defaultValue: 1 }
    }, { timestamps: false });

    this.defineModel('Elo_PlayerStats', {
      eosID: { type: this.s3db?.getDataTypes().STRING, primaryKey: true, allowNull: false },
      steamID: { type: this.s3db?.getDataTypes().STRING, allowNull: true },
      discordID: { type: this.s3db?.getDataTypes().STRING, allowNull: true },
      name: { type: this.s3db?.getDataTypes().STRING, allowNull: true },
      mu: { type: this.s3db?.getDataTypes().FLOAT, defaultValue: 25.0 },
      sigma: { type: this.s3db?.getDataTypes().FLOAT, defaultValue: 8.333333333333334 },
      wins: { type: this.s3db?.getDataTypes().INTEGER, defaultValue: 0 },
      losses: { type: this.s3db?.getDataTypes().INTEGER, defaultValue: 0 },
      roundsPlayed: { type: this.s3db?.getDataTypes().INTEGER, defaultValue: 0 },
      lastSeen: { type: this.s3db?.getDataTypes().BIGINT, allowNull: true }
    }, { timestamps: false, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

    this.defineModel('Elo_RoundHistory', {
      id: { type: this.s3db?.getDataTypes().INTEGER, primaryKey: true, autoIncrement: true },
      layerName: { type: this.s3db?.getDataTypes().STRING, allowNull: true },
      winningTeamID: { type: this.s3db?.getDataTypes().INTEGER, allowNull: true },
      ticketDiff: { type: this.s3db?.getDataTypes().INTEGER, allowNull: true },
      roundDuration: { type: this.s3db?.getDataTypes().INTEGER, allowNull: true },
      endedAt: { type: this.s3db?.getDataTypes().BIGINT, allowNull: true },
      playerCount: { type: this.s3db?.getDataTypes().INTEGER, allowNull: true }
    }, { timestamps: false });

    this.defineModel('Elo_RoundPlayers', {
      id: { type: this.s3db?.getDataTypes().INTEGER, primaryKey: true, autoIncrement: true },
      matchId: { type: this.s3db?.getDataTypes().STRING(20), allowNull: true },
      roundStartTime: { type: this.s3db?.getDataTypes().BIGINT, allowNull: true },
      roundHistoryId: { type: this.s3db?.getDataTypes().INTEGER, allowNull: false },
      eosID: { type: this.s3db?.getDataTypes().STRING, allowNull: false },
      steamID: { type: this.s3db?.getDataTypes().STRING, allowNull: true },
      name: { type: this.s3db?.getDataTypes().STRING, allowNull: true },
      teamID: { type: this.s3db?.getDataTypes().INTEGER, allowNull: false },
      participationRatio: { type: this.s3db?.getDataTypes().FLOAT, allowNull: false },
      muBefore: { type: this.s3db?.getDataTypes().FLOAT, allowNull: false },
      sigmaBefore: { type: this.s3db?.getDataTypes().FLOAT, allowNull: false },
      rawDeltaMu: { type: this.s3db?.getDataTypes().FLOAT, allowNull: false },
      rawDeltaSigma: { type: this.s3db?.getDataTypes().FLOAT, allowNull: false },
      scaledDeltaMu: { type: this.s3db?.getDataTypes().FLOAT, allowNull: false },
      scaledDeltaSigma: { type: this.s3db?.getDataTypes().FLOAT, allowNull: false },
      muAfter: { type: this.s3db?.getDataTypes().FLOAT, allowNull: false },
      sigmaAfter: { type: this.s3db?.getDataTypes().FLOAT, allowNull: false }
    }, { timestamps: false, tableName: 'Elo_RoundPlayers', charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });

    // Inject S³ DBService into EloDatabase delegate
    if (this.s3db?.isReady() && this.db) {
      this.db._s3db = this.s3db;
      this.db.verbose = (level, message) => Logger.verbose('EloTracker', level, message);
    }

    // Register Elo migrations on S³ connector (v1 creates tables, v2 drops roundStartTime)
    if (this.s3db?.isReady() && this.s3db.migrationEngine) {
      this.registerExpectedVersion('elo-tracker', 2);

      this.registerMigrations('elo-tracker', [
        {
          version: 1,
          description: 'Create Elo_PluginState, Elo_PlayerStats, Elo_RoundHistory, Elo_RoundPlayers',
          up: async (qi) => {
            const existing = await qi.showAllTables();

            if (!existing.includes('Elo_PluginState')) {
              await qi.createTable('Elo_PluginState', {
                id: { type: qi.DataTypes.INTEGER, primaryKey: true, autoIncrement: false, defaultValue: 1 }
              }, { timestamps: false });
            }

            if (!existing.includes('Elo_PlayerStats')) {
              await qi.createTable('Elo_PlayerStats', {
                eosID: { type: qi.DataTypes.STRING, primaryKey: true, allowNull: false },
                steamID: { type: qi.DataTypes.STRING, allowNull: true },
                discordID: { type: qi.DataTypes.STRING, allowNull: true },
                name: { type: qi.DataTypes.STRING, allowNull: true },
                mu: { type: qi.DataTypes.FLOAT, defaultValue: 25.0 },
                sigma: { type: qi.DataTypes.FLOAT, defaultValue: 8.333333333333334 },
                wins: { type: qi.DataTypes.INTEGER, defaultValue: 0 },
                losses: { type: qi.DataTypes.INTEGER, defaultValue: 0 },
                roundsPlayed: { type: qi.DataTypes.INTEGER, defaultValue: 0 },
                lastSeen: { type: qi.DataTypes.BIGINT, allowNull: true }
              }, { timestamps: false, charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });
            }

            if (!existing.includes('Elo_RoundHistory')) {
              await qi.createTable('Elo_RoundHistory', {
                id: { type: qi.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
                layerName: { type: qi.DataTypes.STRING, allowNull: true },
                winningTeamID: { type: qi.DataTypes.INTEGER, allowNull: true },
                ticketDiff: { type: qi.DataTypes.INTEGER, allowNull: true },
                roundDuration: { type: qi.DataTypes.INTEGER, allowNull: true },
                endedAt: { type: qi.DataTypes.BIGINT, allowNull: true },
                playerCount: { type: qi.DataTypes.INTEGER, allowNull: true }
              }, { timestamps: false });
            }

            if (!existing.includes('Elo_RoundPlayers')) {
              await qi.createTable('Elo_RoundPlayers', {
                id: { type: qi.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
                matchId: { type: qi.DataTypes.STRING(20), allowNull: true },
                roundStartTime: { type: qi.DataTypes.BIGINT, allowNull: true },
                roundHistoryId: { type: qi.DataTypes.INTEGER, allowNull: false },
                eosID: { type: qi.DataTypes.STRING, allowNull: false },
                steamID: { type: qi.DataTypes.STRING, allowNull: true },
                name: { type: qi.DataTypes.STRING, allowNull: true },
                teamID: { type: qi.DataTypes.INTEGER, allowNull: false },
                participationRatio: { type: qi.DataTypes.FLOAT, allowNull: false },
                muBefore: { type: qi.DataTypes.FLOAT, allowNull: false },
                sigmaBefore: { type: qi.DataTypes.FLOAT, allowNull: false },
                rawDeltaMu: { type: qi.DataTypes.FLOAT, allowNull: false },
                rawDeltaSigma: { type: qi.DataTypes.FLOAT, allowNull: false },
                scaledDeltaMu: { type: qi.DataTypes.FLOAT, allowNull: false },
                scaledDeltaSigma: { type: qi.DataTypes.FLOAT, allowNull: false },
                muAfter: { type: qi.DataTypes.FLOAT, allowNull: false },
                sigmaAfter: { type: qi.DataTypes.FLOAT, allowNull: false }
              }, { timestamps: false, tableName: 'Elo_RoundPlayers', charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' });
            }
          },
          down: async (qi) => {
            await qi.dropTable('Elo_RoundPlayers');
            await qi.dropTable('Elo_RoundHistory');
            await qi.dropTable('Elo_PlayerStats');
            await qi.dropTable('Elo_PluginState');
          }
        },
        {
          version: 2,
          description: 'Drop vestigial roundStartTime column from Elo_PluginState (now read from S³ GameStateService)',
          up: async (qi) => {
            // Note: if the column was already dropped by Sequelize sync(), removeColumn is a no-op
            await qi.removeColumn('Elo_PluginState', 'roundStartTime');
          },
          down: async (qi) => {
            await qi.addColumn('Elo_PluginState', 'roundStartTime', {
              type: qi.DataTypes.BIGINT,
              allowNull: true
            });
          }
        }
      ]);

      // Apply pending migrations
      await this.verifyAndRunMigrations('elo-tracker');
    } else {
      Logger.verbose('EloTracker', 1, '[8.2] S³ DB or migrationEngine not available — skipping migration registration.');
    }

    // Initialize DB models (tables created by MigrationEngine above; initDB will find them)
    await this.db.initDB();

    // --- Prune stale player entries ---
    const { tier1, tier2 } = await this.db.pruneStaleEntries(this.options.minRoundsForLeaderboard);
    Logger.verbose('EloTracker', 1, `[mount] Pruned stale entries — Tier 1 (provisional): ${tier1}, Tier 2 (calibrated): ${tier2}`);

    // Restart Recovery — delegated to S³ GameStateService
    const gs = this._s3?.gameState;
    const recoveredStart = gs?.getRoundStartTime?.();
    if (recoveredStart) {
      this.session.startRound(recoveredStart);
      Logger.verbose('EloTracker', 1, `Restart detected. Resuming round from S³ roundStartTime: ${new Date(recoveredStart).toISOString()}`);
      // Immediately populate sessions for currently connected players
      this.session.updatePlayers(this.server.players, recoveredStart);
    } else {
      // Fresh round — S³ will set roundStartTime on NEW_GAME; for now use Date.now() as fallback
      // so the session manager has a timestamp to work with during early-join players
      Logger.verbose('EloTracker', 1, 'No restart recovery from S³. Starting fresh.');
      this.session.startRound(Date.now());
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

    // Register listeners (LAYER_INFO_UPDATED and SERVER_INFO_UPDATED are owned by S³ — Elo defers to gameState)
    this.server.removeListener('NEW_GAME', this.listeners.onNewGame);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);
    this.server.removeListener('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.listeners.onTeamBalancerScramble);
    this.server.removeListener('CHAT_COMMAND:elo', this.listeners.onEloCommand);
    this.server.removeListener('CHAT_COMMAND:eloadmin', this.listeners.onEloAdminCommand);

    this.server.on('NEW_GAME', this.listeners.onNewGame);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);
    this.server.on('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.on('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.listeners.onTeamBalancerScramble);
    this.server.on('CHAT_COMMAND:elo', this.listeners.onEloCommand);
    this.server.on('CHAT_COMMAND:eloadmin', this.listeners.onEloAdminCommand);

    // Layer info is owned by S³ gameState — it resolves at mount, on events, and provides getLayerName()/getGamemode()
    
    if (this.options.discordClient) {
      this.options.discordClient.removeListener('message', this.listeners.onDiscordMessage);
      this.options.discordClient.on('message', this.listeners.onDiscordMessage);
    }

    this._isMounted = true;
    this.ready = true;
    Logger.verbose('EloTracker', 1, 'Plugin mounted and ready.');
  }

  async _onUnmount() {
    if (!this._isMounted) {
      return;
    }
    Logger.verbose('EloTracker', 1, 'Unmounting plugin.');

    this.server.removeListener('NEW_GAME', this.listeners.onNewGame);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.listeners.onUpdatedPlayerInfo);
    this.server.removeListener('ROUND_ENDED', this.listeners.onRoundEnded);
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

   async onNewGame(data) {
     if (!this.ready) return;

      Logger.verbose('EloTracker', 1, 'NEW_GAME event received. Starting new session.');

      // Layer info and round start time are owned by S³ gameState — it resolves on NEW_GAME
      // via its own handlers. Read roundStartTime from S³ for cross-plugin consistency.
      const gs = this._s3?.gameState;
      const roundStartTime = gs?.getRoundStartTime?.() ?? Date.now();
      this.session.startRound(roundStartTime);
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

  _isIgnoredMatch() {
    const gs = this._s3?.gameState;
    if (!gs) return null; // No S³ → can't determine, not ignored
    const matched = gs.isIgnoredMode?.();
    if (matched) return true; // true → the mode was matched
    if (gs.getGamemode?.() === 'Unknown' && gs.getLayerName?.() === 'Unknown') return 'Unknown';
    return null;
  }

  _getLayerName() {
    return this._s3?.gameState?.getLayerName?.();
  }

  _getGamemode() {
    return this._s3?.gameState?.getGamemode?.();
  }

  async onRoundEnded(data) {
    const gameMode = this._getGamemode();
    const layerName = this._getLayerName();

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

    const ignoredReason = this._isIgnoredMatch();
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
    let roundRecord = null;
    try {
      await this.db.bulkIncrementPlayerStats(dbUpdates);
      roundRecord = await this.db.insertRoundHistory({
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

    const gs = this._s3?.gameState;
    const matchRecord = {
      ts: roundEndTime,
      matchId: gs?.getMatchId?.() ?? roundEndTime.toString(),
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

    // Fire-and-forget database insert if enabled and roundRecord was created
    if (this.options.enableDatabaseLogging && roundRecord && roundRecord.id) {
      // Read matchId and roundStartTime from S³ GameStateService for cross-plugin consistency
      const gs = this._s3?.gameState;
      const roundStartTime = gs?.getRoundStartTime?.() ?? this.session.roundStartTime;
      const matchId = gs?.getMatchId?.();

      const playerRows = matchRecord.players.map(p => ({
        matchId: matchId,
        roundStartTime: roundStartTime,
        roundHistoryId: roundRecord.id,
        eosID: p.eosID,
        steamID: p.steamID || null,
        name: p.name,
        teamID: p.teamID,
        participationRatio: p.participationRatio,
        muBefore: p.muBefore,
        sigmaBefore: p.sigmaBefore,
        rawDeltaMu: p.rawDeltaMu,
        rawDeltaSigma: p.rawDeltaSigma,
        scaledDeltaMu: p.scaledDeltaMu,
        scaledDeltaSigma: p.scaledDeltaSigma,
        muAfter: p.muAfter,
        sigmaAfter: p.sigmaAfter
      }));
      this.db.insertRoundPlayers(roundRecord.id, roundEndTime, playerRows).catch(err =>
        Logger.verbose('EloTracker', 1, `[onRoundEnded] Database player insert failed: ${err.message}`)
      );
    }

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
      layerName: this._getLayerName(),
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

  async getMu(player) {
    if (!player) return EloCalculator.MU_DEFAULT;
    
    // Check cache first
    const cached = this.eloCache.get(player.eosID);
    if (cached) return cached.mu;
    
    // Cache miss — fetch from database
    try {
      const record = await this.db.getPlayerStats(player.eosID);
      if (record) {
        // Populate cache for future calls
        this.eloCache.set(player.eosID, record);
        return record.mu;
      }
    } catch (err) {
      Logger.verbose('EloTracker', 1, `[getMu] DB fetch failed for ${player.eosID}: ${err.message}`);
    }
    
    // No record found or fetch failed — return default
    return EloCalculator.MU_DEFAULT;
  }

  /**
   * Retrieves player rating (mu and roundsPlayed) from cache or database.
   * Mirrors getMu() pattern but returns full rating object for skill + veterancy calculations.
   *
   * @param {object} player - Player object with eosID
   * @returns {Promise<object>} { mu, roundsPlayed } — both with defaults if not found
   */
  async getRating(player) {
    if (!player) return { mu: EloCalculator.MU_DEFAULT, roundsPlayed: 0 };
    
    // Check cache first
    const cached = this.eloCache.get(player.eosID);
    if (cached) return { mu: cached.mu, roundsPlayed: cached.roundsPlayed ?? 0 };
    
    // Cache miss — fetch from database
    try {
      const record = await this.db.getPlayerStats(player.eosID);
      if (record) {
        // Populate cache for future calls
        this.eloCache.set(player.eosID, record);
        return { mu: record.mu, roundsPlayed: record.roundsPlayed ?? 0 };
      }
    } catch (err) {
      Logger.verbose('EloTracker', 1, `[getRating] DB fetch failed for ${player.eosID}: ${err.message}`);
    }
    
    // No record found or fetch failed — return defaults
    return { mu: EloCalculator.MU_DEFAULT, roundsPlayed: 0 };
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