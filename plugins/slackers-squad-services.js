/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           SLACKERS SQUAD SERVICES PLUGIN v1.0.0              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * S³ (Slacker's Squad Services) is the centralized service container
 * for shared state across SquadJS plugins. It composes and manages the
 * lifecycle of seven services — serverConfig, db, gameState, factions,
 * clans, players, and logging — and delegates SquadJS server events to
 * them. Consumer plugins (TeamBalancer, SmartAssign, Switch, EloTracker)
 * discover S³ at runtime and access services via flat getters.
 *
 * Also manages the !s3 admin command surface (backup, export, import,
 * db operations) through s3-discord.js → s3-commands.js dispatch, and
 * hosts the MigrationEngine for version-ordered schema migrations.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SlackersSquadServices (default)
 *   Extends BasePlugin. Key public methods:
 *     prepareToMount()           — Instantiates all 7 service instances.
 *     mount()                    — Mounts services in order (serverConfig→db→gameState→factions→clans→players→logging),
 *                                   binds server events, registers Discord !s3 commands.
 *     unmount()                  — Unbinds events, unmounts services in reverse order, cleans up Discord.
 *     handleNewGame(data)         — Delegates NEW_GAME to gameState and factions.
 *     handleRoundEnded(data)      — Delegates ROUND_ENDED to gameState and factions.
 *     handleLayerInfoUpdated(d)   — Delegates UPDATED_LAYER_INFORMATION to gameState.
 *     handleServerInfoUpdated(d)  — Delegates UPDATED_SERVER_INFORMATION to gameState.
 *     handleUpdatedPlayerInfo(d)  — Delegates UPDATED_PLAYER_INFORMATION to gameState, factions, players.
 *     handlePlayerConnected(d)    — Delegates PLAYER_CONNECTED to players.
 *
 *   Flat accessors:
 *     get gameState()             — Returns this.services.gameState.
 *     get serverConfig()          — Returns this.services.serverConfig.
 *     get db()                    — Returns this.services.db.
 *     get factions()              — Returns this.services.factions.
 *     get clans()                 — Returns this.services.clans.
 *     get players()               — Returns this.services.players.
 *     get logging()               — Returns this.services.logging.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * BasePlugin (./base-plugin.js)
 *   SquadJS base class providing server, options, and connectors.
 * GameStateService (../utils/game-state-service.js)
 *   Round phase tracking, matchId/roundStartTime, ENDGAME timer chain.
 * FactionsService (../utils/factions-service.js)
 *   Faction/team name resolution from game layer data.
 * ClansService (../utils/clans-service.js)
 *   Clan tag detection, normalization, merging, and grouping.
 * DBService (../utils/db-service.js)
 *   Sequelize/SQLite persistence for game state across restarts.
 * PlayersService (../utils/players-service.js)
 *   Player tracking, reconnect detection, global/per-player locking.
 * ServerConfigService (../utils/server-config-service.js)
 *   Parses Squad Server.cfg and VoteConfig.cfg at mount time.
 * LoggingService (../utils/logging-service.js)
 *   JSONL and DB logging for S³ player/game state events.
 * registerS3DiscordCommands (../utils/s3-discord.js)
 *   Discord !s3 admin command registration and dispatch.
 *
 * buildMigrationEmbed (../utils/s3-migration-discord.js)
 *   Discord embed builder for migration status display. The confirmation
 *   flow uses a token-based system (!s3 confirm <token>) handled by
 *   migration-engine.js (confirmToken gate) and s3-commands.js.
 *
 * ─── S³ INTEGRATION ──────────────────────────────────────────────
 *
 * This plugin IS the S³ service container. Consumer plugins discover
 * it at runtime by searching this.server.plugins for SlackersSquadServices
 * and storing the reference as this._s3. Services are accessed via flat
 * getters (e.g., this._s3.gameState) guarded with isReady() checks.
 *
 * Provided Services:
 *   - serverConfig: Squad Server.cfg / VoteConfig.cfg parsing.
 *   - db:           Sequelize/SQLite persistence for round state.
 *   - gameState:    Round phase, matchId, roundStartTime, ENDGAME chain.
 *   - factions:     Faction/team name resolution for teamIDs.
 *   - clans:        Clan tag grouping, normalization, merging.
 *   - players:      Player tracking, reconnect detection, locks.
 *
 * Delegated SquadJS Events:
 *   NEW_GAME                  → gameState, factions
 *   ROUND_ENDED               → gameState, factions
 *   UPDATED_LAYER_INFORMATION  → gameState
 *   UPDATED_SERVER_INFORMATION → gameState
 *   UPDATED_PLAYER_INFORMATION → gameState, factions, players
 *   PLAYER_CONNECTED          → players
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Service mount order is strict: serverConfig → db → gameState →
 *   factions → clans → players. serverConfig must mount first so
 *   vote durations are available before ENDGAME fires.
 * - ignoredGameModes is pushed into GameStateService before its mount
 *   so isIgnoredMode() reads the single source of truth.
 * - Discord integration gracefully degrades — if no discordClient
 *   connector is configured, registerS3DiscordCommands is a no-op.
 * - Unmount destroys services in reverse order (logging → players → clans →
 *   db → factions → gameState → serverConfig).
 *   Note: logging is unmounted first (before unbinding events) so it can
 *   capture any final teardown activity.
 * - Consumer plugins use the flat access pattern: this._s3?.gameState
 *   (not this._s3?.services?.gameState). Guard with isReady() before
 *   direct access.
 * - Flat getters are backed by this.services — they return null
 *   before prepareToMount() runs and valid instances afterward.
 *
 * ─── COMMANDS ────────────────────────────────────────────────────
 *
 * No in-game chat commands.
 *
 * Discord Admin (channelID only):
 *   !s3 status               → Overview: service mount status (🟢/🟡/⚫), game phase, players, locks.
 *   !s3 services             → Per-service detail with internal state emoji.
 *   !s3 gamestate            → Phase, matchId, roundStartTime, mode, layer, sub-state.
 *   !s3 factions             → Team 1/2 names, polling status, resolving gate.
 *   !s3 players              → Full player list with teamID, clan tag, locks.
 *   !s3 clans                → Detected clan groups.
 *   !s3 locks                → Global lock + per-player locks + priority table.
 *   !s3 config               → Server config values.
 *   !s3 db status            → Connector type, schema version status per plugin.
 *   !s3 db export [--logs|--all] [--to-file]  → Export tables as JSON.
 *   !s3 db import [--confirm] [--dry-run]       → Import from backup.
 *   !s3 diag                 → Consolidated read-only health check.
 *   !s3 migrate <pending|status|force>  → Schema migration management.
 *   !s3 backup <create|list|restore>    → Database backup management.
 *   !s3 help                 → Command reference.
 *
 * ─── AUTHOR ──────────────────────────────────────────────────────
 *
 * Slacker
 * Discord: `real_slacker`
 * GitHub:  https://github.com/mikebjoyce/squadjs-slackers-squad-services
 *
 */

import BasePlugin from './base-plugin.js';
import GameStateService from '../utils/game-state-service.js';
import FactionsService from '../utils/factions-service.js';
import ClansService from '../utils/clans-service.js';
import DBService from '../utils/db-service.js';
import PlayersService from '../utils/players-service.js';
import ServerConfigService from '../utils/server-config-service.js';
import LoggingService from '../utils/logging-service.js';
import crypto from 'node:crypto';
import { registerS3DiscordCommands } from '../utils/s3-discord.js';
import { buildMigrationEmbed } from '../utils/s3-migration-discord.js';
export default class SlackersSquadServices extends BasePlugin {
  static get description() {
    return "Shared Slacker's Squad Services plugin wiring gameState, factions, clans, db, and players modules.";
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      database: {
        required: true,
        connector: 'sequelize',
        description: 'Sequelize connector name used for persistent storage.',
        default: 'sqlite'
      },
      discordClient: {
        required: false,
        connector: 'discord',
        description: 'Discord connector name for S³ admin commands (!s3). Set to null to disable Discord integration.',
        default: 'discord'
      },
      channelID: {
        required: false,
        description: 'Discord admin channel ID for !s3 commands. Only required if discordClient is configured.',
        default: '',
        example: '667741905228136459'
      },
      configPath: {
        required: false,
        description: 'Path to Squad server ServerConfig directory containing Server.cfg and VoteConfig.cfg.',
        default: './SquadGame/ServerConfig/'
      },
      ignoredGameModes: {
        required: false,
        description: 'Modes/maps excluded by shared game-state ignored-mode checks.',
        default: ['Seed', 'Jensen']
      },
      enableClanTagGrouping: {
        required: false,
        type: 'boolean',
        description: 'Enable shared clan-tag grouping utilities for consuming modules.',
        default: false
      },
      minClanGroupSize: {
        required: false,
        type: 'number',
        description: 'Minimum clan member count required for a clan group to qualify.',
        default: 2
      },
      maxClanGroupSize: {
        required: false,
        type: 'number',
        description: 'Maximum clan member count allowed for a clan group to qualify.',
        default: 18
      },
      clanTagMaxEditDistance: {
        required: false,
        type: 'number',
        description: 'Maximum Levenshtein edit distance used when merging similar clan tags.',
        default: 1
      },
      clanTagCaseSensitive: {
        required: false,
        type: 'boolean',
        description: 'When false, clan tags are normalized before grouping (matches current TeamBalancer behavior).',
        default: false
      },
      clanTagIgnoreList: {
        required: false,
        type: 'array',
        description: 'Clan tags to exclude from grouping, matched using the same normalization mode as grouping.',
        default: []
      },
      clanGroupingPullEntireSquads: {
        required: false,
        type: 'boolean',
        description: 'Compatibility option for later consumers that may pull full squads when preserving clans.',
        default: false
      },
      enableDatabaseLogging: {
        required: false,
        type: 'boolean',
        description: 'Enable shared S³ logging tables (S3_PlayerEvents, S3_GameStateEvents, S3_PlayerSnapshots). When false, LoggingService runs in no-op mode.',
        default: false
      },
      enableFileLogging: {
        required: false,
        type: 'boolean',
        description: 'Enable JSONL file mirror for S³ logging events. Each DB write is also appended as a self-contained JSONL line to the logPath file.',
        default: false
      },
      logPath: {
        required: false,
        description: 'Path to JSONL file for S³ event mirror. Only used when enableFileLogging is true.',
        default: './s3-log.jsonl',
        type: 'string'
      },
      autoMigrate: {
        required: false,
        type: 'boolean',
        description: 'When true, pending schema migrations are applied automatically on startup without Discord confirmation. Defaults to false (requires Discord ✅ reaction).',
        default: false
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.services = {
      gameState: null,
      factions: null,
      clans: null,
      db: null,
      players: null,
      serverConfig: null,
      logging: null
    };

    this._s3DiscordCleanup = null;
    this._migrationDiscordCleanup = null;
    this._migrationPromptTimer = null; // Delay timer used by _scheduleMigrationPrompt()

    // Deferred ready promise — consumer plugins await this._s3.ready() to ensure
    // all services, Discord registration, and migration check have completed.
    this._readyPromise = new Promise((resolve) => { this._resolveReady = resolve; });

    this.listeners = {
      handleNewGame: this.handleNewGame.bind(this),
      handleRoundEnded: this.handleRoundEnded.bind(this),
      handleLayerInfoUpdated: this.handleLayerInfoUpdated.bind(this),
      handleServerInfoUpdated: this.handleServerInfoUpdated.bind(this),
      handleUpdatedPlayerInfo: this.handleUpdatedPlayerInfo.bind(this),
      handlePlayerConnected: this.handlePlayerConnected.bind(this)
    };
  }

  // Flat accessors — consumers use this._s3?.gameState (not this._s3?.services?.gameState)
  // Each returns the underlying service instance (may be null before mount completes).
  get gameState()     { return this.services.gameState; }
  get serverConfig()  { return this.services.serverConfig; }
  get db()            { return this.services.db; }
  get factions()      { return this.services.factions; }
  get clans()         { return this.services.clans; }
  get players()       { return this.services.players; }
  get logging()       { return this.services.logging; }

  /**
   * Returns a promise that resolves when S³ has fully mounted — all services,
   * Discord registration, and migration check are complete. Consumer plugins
   * (SA, Elo, Switch, TB) should await this before accessing S³ services during
   * their own mount() to avoid the concurrent-mount race.
   */
  ready() {
    return this._readyPromise;
  }

  async prepareToMount() {
    this.services.db = new DBService({
      parent: this,
      server: this.server,
      sequelize: this.options.database,
      connectors: this.connectors,
      databaseOption: this.options.database,
      verboseLogger: (...args) => this.verbose(...args)
    });

    this.services.gameState = new GameStateService({
      parent: this,
      server: this.server,
      ignoredGameModes: this.options.ignoredGameModes,
      verboseLogger: (...args) => this.verbose(...args)
    });

    this.services.factions = new FactionsService({
      parent: this,
      server: this.server,
      gameState: this.services.gameState,
      verboseLogger: (...args) => this.verbose(...args)
    });

    this.services.clans = new ClansService({
      parent: this,
      verboseLogger: (...args) => this.verbose(...args),
      options: {
        enabled: this.options.enableClanTagGrouping,
        minSize: this.options.minClanGroupSize,
        maxSize: this.options.maxClanGroupSize,
        maxEditDistance: this.options.clanTagMaxEditDistance,
        caseSensitive: this.options.clanTagCaseSensitive,
        ignoreList: this.options.clanTagIgnoreList,
        pullEntireSquads: this.options.clanGroupingPullEntireSquads
      }
    });

    this.services.players = new PlayersService({
      parent: this,
      server: this.server,
      verboseLogger: (...args) => this.verbose(...args)
    });

    this.services.serverConfig = new ServerConfigService({
      parent: this,
      verboseLogger: (...args) => this.verbose(...args),
      configPath: this.options.configPath
    });

    this.services.logging = new LoggingService({
      parent: this,
      server: this.server,
      verboseLogger: (...args) => this.verbose(...args),
      dbService: this.services.db,
      gameState: this.services.gameState,
      enableDatabaseLogging: this.options.enableDatabaseLogging,
      enableFileLogging: this.options.enableFileLogging,
      logPath: this.options.logPath
    });
  }

  async mount() {
    if (this.services.serverConfig) {
      await this.services.serverConfig.mount();
    }

    if (this.services.db) {
      await this.services.db.mount();
    }

    if (this.services.gameState) {
      // Push S³'s ignoredGameModes config into GameStateService before mount
      // so isIgnoredMode() reads the single source of truth.
      this.services.gameState.setIgnoredGameModes(this.options.ignoredGameModes);
      await this.services.gameState.mount();
    }

    if (this.services.factions) {
      await this.services.factions.mount();
    }

    if (this.services.clans) {
      await this.services.clans.mount();
    }

    if (this.services.players) {
      await this.services.players.mount();
    }

    if (this.services.logging) {
      await this.services.logging.mount();
    }

    this._bindServerEvents();

    // Register Discord !s3 commands (gracefully degrades if no discordClient configured)
    this._s3DiscordCleanup = registerS3DiscordCommands(this);

    // Check for pending migrations and prompt via Discord if any
    this._scheduleMigrationPrompt();

    this.verbose(1, 'Mounted SlackerSquadServices with gameState, factions, clans, db, players, serverConfig, and logging services.');

    // Resolve the ready promise — consumer plugins awaiting this._s3.ready() can now proceed
    this._resolveReady();
  }

  async unmount() {
    // Clean up migration prompt debounce timer
    if (this._migrationPromptTimer) {
      clearTimeout(this._migrationPromptTimer);
      this._migrationPromptTimer = null;
    }

    // Clean up migration Discord prompt
    if (this._migrationDiscordCleanup) {
      this._migrationDiscordCleanup();
      this._migrationDiscordCleanup = null;
    }

    // Deregister Discord commands before shutting down services
    if (this._s3DiscordCleanup) {
      this._s3DiscordCleanup();
      this._s3DiscordCleanup = null;
    }

    this._unbindServerEvents();

    if (this.services.logging) {
      await this.services.logging.unmount();
    }

    if (this.services.players) {
      await this.services.players.unmount();
    }

    if (this.services.clans) {
      await this.services.clans.unmount();
    }

    if (this.services.db) {
      await this.services.db.unmount();
    }

    if (this.services.factions) {
      await this.services.factions.unmount();
    }

    if (this.services.gameState) {
      await this.services.gameState.unmount();
    }

    if (this.services.serverConfig) {
      await this.services.serverConfig.unmount();
    }

    this.verbose(1, 'Unmounted SlackerSquadServices and shared services.');
  }

  _bindServerEvents() {
    if (!this.server || typeof this.server.on !== 'function') return;

    this.server.on('NEW_GAME', this.listeners.handleNewGame);
    this.server.on('ROUND_ENDED', this.listeners.handleRoundEnded);
    this.server.on('UPDATED_LAYER_INFORMATION', this.listeners.handleLayerInfoUpdated);
    this.server.on('UPDATED_SERVER_INFORMATION', this.listeners.handleServerInfoUpdated);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.listeners.handleUpdatedPlayerInfo);
    this.server.on('PLAYER_CONNECTED', this.listeners.handlePlayerConnected);
  }

  _unbindServerEvents() {
    if (!this.server || typeof this.server.removeListener !== 'function') return;

    this.server.removeListener('NEW_GAME', this.listeners.handleNewGame);
    this.server.removeListener('ROUND_ENDED', this.listeners.handleRoundEnded);
    this.server.removeListener('UPDATED_LAYER_INFORMATION', this.listeners.handleLayerInfoUpdated);
    this.server.removeListener('UPDATED_SERVER_INFORMATION', this.listeners.handleServerInfoUpdated);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.listeners.handleUpdatedPlayerInfo);
    this.server.removeListener('PLAYER_CONNECTED', this.listeners.handlePlayerConnected);
  }

  async handleNewGame(data) {
    if (this.services.gameState?.handleNewGame) {
      await this.services.gameState.handleNewGame(data);
    }

    if (this.services.factions?.handleNewGame) {
      this.services.factions.handleNewGame(data);
    }
  }

  async handleRoundEnded(data) {
    if (this.services.gameState?.handleRoundEnded) {
      await this.services.gameState.handleRoundEnded(data);
    }

    if (this.services.factions?.handleRoundEnded) {
      this.services.factions.handleRoundEnded(data);
    }
  }

  async handleLayerInfoUpdated(data) {
    if (this.services.gameState?.handleLayerInfoUpdated) {
      await this.services.gameState.handleLayerInfoUpdated(data);
    }
  }

  async handleServerInfoUpdated(data) {
    if (this.services.gameState?.handleServerInfoUpdated) {
      await this.services.gameState.handleServerInfoUpdated(data);
    }
  }

  async handleUpdatedPlayerInfo(data) {
    const playerCount = this.server?.players?.length ?? 0;
    this.verbose(3, `[S3] UPDATED_PLAYER_INFORMATION tick: ${playerCount} players`);

    if (this.services.gameState?.handleUpdatedPlayerInfo) {
      await this.services.gameState.handleUpdatedPlayerInfo(data);
    }

    if (this.services.factions?.handleUpdatedPlayerInfo) {
      this.services.factions.handleUpdatedPlayerInfo(data);
    }

    if (this.services.players?.handleUpdatedPlayerInfo) {
      await this.services.players.handleUpdatedPlayerInfo(data);
    }
  }

  async handlePlayerConnected(data) {
    const player = data?.player || {};
    const playerName = player?.name || data?.name || 'Unknown';
    const eosID = player?.eosID || data?.eosID || 'N/A';
    this.verbose(2, `[S3] PLAYER_CONNECTED: ${playerName} (eosID=${eosID})`);

    if (this.services.players?.handlePlayerConnected) {
      await this.services.players.handlePlayerConnected(data);
    }
  }

  /**
   * Check for pending schema migrations after Discord is registered, and
   * post an embed to the admin channel for human confirmation if autoMigrate is false.
   * If no migrations are pending, does nothing.
   * If Discord isn't configured, logs a warning about pending migrations.
   */
  async _checkAndPromptMigrations() {
    const db = this.services.db;
    if (!db || !db.isReady()) {
      this.verbose(3, '[S3 Migration] DB not ready yet — skipping migration check.');
      return;
    }

    // Use fresh verifySchemaVersions() instead of cached getPendingMigrations()
    // so the check reflects all plugins that have registered since mount.
    const status = await db.verifySchemaVersions();
    const pending = status.pending;

    // Refresh the cached pending list and create the migration gate so that
    // getPendingMigrations() and waitForMigrations() return correct data
    // for any consumer that calls them after this point.
    db._pendingMigrations = pending;
    if (pending.length > 0 && !db._migrationGate) {
      db._migrationGate = new Promise((resolve) => {
        db._resolveMigrationGateFn = resolve;
      });
    }

    if (!pending || pending.length === 0) {
      this.verbose(3, '[S3 Migration] No pending migrations.');
      return;
    }

    // Idempotency guard: if a valid unexpired token already exists, prompt was already posted
    const me = db.migrationEngine;
    if (me && me._confirmToken && me._tokenExpiresAt && Date.now() < me._tokenExpiresAt) {
      this.verbose(3, '[S3 Migration] Prompt already posted — skipping duplicate.');
      return;
    }

    // autoMigrate: skip Discord prompt, run directly
    if (this.options.autoMigrate) {
      this.verbose(1, `[S3 Migration] autoMigrate is enabled — running ${pending.length} pending migration(s) directly.`);
      const me = db.migrationEngine;
      if (me) {
        me.confirmToken('__auto__');
      }
      for (const p of pending) {
        try {
          if (!me) {
            this.verbose(1, `[S3 Migration] MigrationEngine not available — cannot migrate "${p.pluginName}".`);
            continue;
          }
          const result = await me.runMigrations(p.pluginName);
          this.verbose(2, `[S3 Migration] "${p.pluginName}": ${result.applied} applied, ${result.skipped} skipped.`);
        } catch (err) {
          this.verbose(1, `[S3 Migration] Auto-migration failed for "${p.pluginName}": ${err.message}`);
        }
      }
      db._resolveMigrationGate(true);
      return;
    }

    // Generate a confirmation token and post embed to Discord admin channel.
    // The admin types `!s3 confirm <token>` to authorize migrations.
    const token = crypto.randomBytes(4).toString('hex'); // e.g. "a3f9c2"

    // Store token on the engine with 5-minute expiry
    if (me) {
      me._confirmToken = token;
      me._tokenExpiresAt = Date.now() + 5 * 60 * 1000;
    }

    // Build token embed using the existing buildMigrationEmbed helper.
    // The embed already includes generic instructions from buildMigrationEmbed().
    // Append the token-specific line so the admin knows which token to use.
    const embed = buildMigrationEmbed(pending, 'pending', null);
    embed.description += `\nToken: \`${token}\``;

    this.verbose(1, `[S3 Migration] ${pending.length} plugin(s) have pending schema migrations. Generated token: ${token}`);

    // Post embed to the admin Discord channel
    const discordClient = this.options.discordClient;
    const channelID = this.options.channelID;
    if (discordClient && channelID) {
      try {
        const channel = await discordClient.channels.fetch(channelID);
        if (channel) {
          await channel.send({ embeds: [embed] });
          this.verbose(1, `[S3 Migration] Token embed posted to Discord — ${pending.length} plugin(s) pending.`);
        }
      } catch (err) {
        this.verbose(1, `[S3 Migration] Failed to post token embed: ${err.message}`);
        this.verbose(1, `[S3 Migration] Use !s3 migrate force or set autoMigrate: true in S³ config to run migrations.`);
      }
    } else {
      this.verbose(1, `[S3 Migration] Cannot prompt — Discord not configured. ${pending.length} plugin(s) pending. Use !s3 migrate force or autoMigrate: true.`);
    }

    // Set 5-minute auto-expiry timeout
    if (me) {
      setTimeout(() => {
        if (me._confirmToken === token && !me._confirmed) {
          me._confirmToken = null;
          me._tokenExpiresAt = null;
          this.verbose(1, '[S3 Migration] Token expired — migrations not confirmed. Restart S³ or use !s3 migrate force to regenerate.');
        }
      }, 5 * 60 * 1000);
    }
  }

  /**
   * Debounced migration prompt scheduler. Called by consumer plugins via
   * verifyAndRunMigrations() when they detect pending-but-unconfirmed
   * migrations. Multiple plugins may call this in rapid succession during
   * initialisation — the 500ms debounce ensures only one Discord embed is
   * posted after all plugins have registered their expected versions.
   *
   * Idempotency guard: if a valid unexpired token already exists on the
   * MigrationEngine, the prompt was already posted and this is a no-op.
   */
  _scheduleMigrationPrompt() {
    // Idempotency: if a valid token already exists, prompt was already posted
    const me = this.services.db?.migrationEngine;
    if (me && me._confirmToken && me._tokenExpiresAt && Date.now() < me._tokenExpiresAt) {
      this.verbose(3, '[S3 Migration] Prompt already active — skipping duplicate schedule.');
      return;
    }

    // Clear any existing debounce timer
    if (this._migrationPromptTimer) {
      clearTimeout(this._migrationPromptTimer);
    }

    // Debounce: wait 500ms for all consumer plugins to register, then fire
    this._migrationPromptTimer = setTimeout(() => {
      this._migrationPromptTimer = null;
      this._checkAndPromptMigrations();
    }, 500);
  }
}
