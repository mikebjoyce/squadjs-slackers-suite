/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              SLACKERS SQUAD SERVICES PLUGIN                  ║
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
 *                                   (recovery-timing only — that event carries no
 *                                   layer and server.currentLayer is unreliable)
 *     handleServerInfoUpdated(d)  — Delegates UPDATED_SERVER_INFORMATION to gameState.
 *                                   THE layer resolution path: info.currentLayer is the
 *                                   only place SquadJS reliably delivers layer data.
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
 *   - logging:      JSONL and DB logging for S³ player/game state events.
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
 *   factions → clans → players → logging. serverConfig must mount first so
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
 *   !s3 migrate <pending|status|force [--dry-run]|preview|verify|purge-deprecated>  → Schema migration management.
 *   !s3 confirm <token>                 → Confirm and run pending migrations from startup prompt.
 *   !s3 backup <create|list|restore <filename>>  → Database backup management.
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
import { configureStderrDiagnostics, flushStderrDiagnostics, stderrError } from '../utils/s3-stderr.js';
import { buildMigrationEmbed } from '../utils/s3-migration-discord.js';
import { t } from './i18n.js';

export default class SlackersSquadServices extends BasePlugin {
  static get description() {
    return "Shared Slacker's Squad Services plugin wiring gameState, factions, clans, db, and players modules.";
  }

  static get defaultEnabled() {
    return false;
  }

  static get version() { return '1.5.0'; }

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
        default: true
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
        description: 'Maximum Damerau-Levenshtein edit distance used when merging similar clan tags. Counts an adjacent-character transposition (e.g. "PHNTM" vs "PHTNM") as a single edit rather than two substitutions.',
        default: 1
      },
      clanTagMinMergeLength: {
        required: false,
        type: 'number',
        description: 'Minimum normalized tag length required for two tags to be eligible for Damerau-Levenshtein merging. Tags shorter than this only group together on an exact match — a 1-character edit is far less discriminating on a short tag (e.g. "CB" vs "8B") than on a long one.',
        default: 4
      },
      clanTagCaseSensitive: {
        required: false,
        type: 'boolean',
        description: 'When false, clan tags are normalized before grouping.',
        default: false
      },
      clanTagIgnoreList: {
        required: false,
        type: 'array',
        description: 'Clan tags to exclude from grouping, matched using the same normalization mode as grouping.',
        default: []
      },
      clanRecruitSuffixes: {
        required: false,
        type: 'array',
        description: 'Suffixes to strip from clan tags when the base tag (without suffix) exists on other players. Enabled by default with ["r", "-r"] for common recruit tags (case-insensitive, so "R" and "-R" are also matched). Set to [] to disable. Stripping only occurs when the base tag is present on at least one other player in the data set.',
        default: ["r", "-r"]
      },
      clanGroupingPullEntireSquads: {
        required: false,
        type: 'boolean',
        description: 'When true, clan grouping during scrambles pulls entire squads containing clan members rather than just the clan members themselves.',
        default: true
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
        description: 'When true, pending schema migrations are applied automatically on startup without Discord confirmation. Defaults to false.',
        default: false
      },
      stderrDiagnostics: {
        required: false,
        type: 'string',
        description:
          "Whether S³ failures are also copied to stderr. 'off' (default) changes nothing — everything goes to the SquadJS log as before. Set 'mirror' if you split the streams (`node index.js > squadjs.log 2> squadjs.err`, or pm2's separate out/err files) and want migration failures, DB errors and schema drift to land in the error file with their stack traces. 'auto' copies only when stdout and stderr lead to different places, for a config shared between a console session and a redirected service. Under Docker's default log driver or systemd/journald both streams end up in one sink, so 'mirror' there means every error appears twice.",
        default: 'off'
      },
      stderrDedupeWindowSeconds: {
        required: false,
        type: 'number',
        description:
          'Identical stderr events inside this window are counted rather than written, with the tally emitted afterwards. Stops a DB outage — which throws on every tick — from filling the error file. Defaults to 60.',
        default: 60
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

  /**
   * Helper to retrieve configured language or default to English.
   */
  get lang() {
    return this.options?.language || 'en';
  }

  // Flat accessors — consumers use this._s3?.gameState (not this._s3?.services?.gameState)
  // Each returns the underlying service instance (may be null before mount completes).
  get version()       { return SlackersSquadServices.version; }
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
    // Configure the stderr channel here, not in mount(). SquadJS calls
    // prepareToMount() on every plugin before mounting any of them, and S³ is
    // required to be first in the plugins array — so this is the earliest point
    // at which the operator's setting is known, and it lands before any consumer
    // plugin can fail. Doing it in mount() was too late for a whole class of
    // failure: S3DiscordPluginBase fetches its channel during prepareToMount, so
    // a bad channelID reported through reportError() was always suppressed by the
    // 'off' default and never reached the error file. Caught on a live server.
    this._configureStderrDiagnostics();

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
      // Staging duration is deliberately NOT a config option: it is a property
      // of the gamemode, not of the server. See STAGING_DURATION_MS_BY_GAMEMODE
      // in game-state-service.js.
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
        minMergeLength: this.options.clanTagMinMergeLength,
        caseSensitive: this.options.clanTagCaseSensitive,
        ignoreList: this.options.clanTagIgnoreList,
        pullEntireSquads: this.options.clanGroupingPullEntireSquads,
        recruitSuffixes: this.options.clanRecruitSuffixes
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
    // Belt and braces — prepareToMount() has normally already done this.
    this._configureStderrDiagnostics();

    if (this.services.serverConfig) {
      await this._mountService('serverConfig', () => this.services.serverConfig.mount());
    }

    if (this.services.db) {
      await this._mountService('db', () => this.services.db.mount());
    }

    if (this.services.gameState) {
      // Push S³'s ignoredGameModes config into GameStateService before mount
      // so isIgnoredMode() reads the single source of truth.
      this.services.gameState.setIgnoredGameModes(this.options.ignoredGameModes);
      await this._mountService('gameState', () => this.services.gameState.mount());
    }

    if (this.services.factions) {
      await this._mountService('factions', () => this.services.factions.mount());
    }

    if (this.services.clans) {
      await this._mountService('clans', () => this.services.clans.mount());
    }

    if (this.services.players) {
      await this._mountService('players', () => this.services.players.mount());
    }

    if (this.services.logging) {
      await this._mountService('logging', () => this.services.logging.mount());
    }

    this._bindServerEvents();

    // Register Discord !s3 commands (gracefully degrades if no discordClient configured)
    this._s3DiscordCleanup = registerS3DiscordCommands(this);

    // Register drift alert callback — when post-migration schema drift is detected,
    // DBService fires this to post a warning embed in the admin Discord channel.
    if (this.services.db) {
      this.services.db._driftAlertCallback = (drift, pluginNames) => {
        this.verbose(1, t('slackersSquadServices.drift.alertTriggered', { pluginNames: pluginNames.join(', ') }, this.lang));
        const discordClient = this.options.discordClient;
        const channelID = this.options.channelID;
        if (discordClient && channelID) {
          const parts = [];
          const missingCols = drift
            .filter(e => e.missing)
            .map(e => `- **${e.table}**: ${e.missing.join(', ')}`);
          if (missingCols.length > 0) parts.push(missingCols.join('\n'));
          const missingRows = drift
            .filter(e => e.missingRows)
            .map(e => `- **${e.table}**: ${e.missingRows.map(r => `${r.key}=${r.value}`).join(', ')}`);
          if (missingRows.length > 0) parts.push(missingRows.join('\n'));
          const dataViolations = drift
            .filter(e => e.dataViolations)
            .map(e => `- **${e.table}**: ${e.dataViolations.map(v => t('slackersSquadServices.driftViolations.emptyRows', { offenders: v.offenders, column: v.column }, this.lang)).join(', ')}`);
          if (dataViolations.length > 0) parts.push(dataViolations.join('\n'));
          const description = parts.length > 0
            ? t('slackersSquadServices.drift.descriptionSummary', { parts: parts.join('\n') }, this.lang)
            : t('slackersSquadServices.drift.descriptionFallback', {}, this.lang);
          discordClient.channels.fetch(channelID).then(channel => {
            if (channel) {
              channel.send({
                embeds: [{
                  color: 0xe74c3c,
                  title: t('slackersSquadServices.drift.embedTitle', {}, this.lang),
                  description,
                  timestamp: new Date().toISOString(),
                  footer: { text: t('slackersSquadServices.drift.footer', {}, this.lang) }
                }]
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      };
    }

    // Check for pending migrations and prompt via Discord if any
    this._scheduleMigrationPrompt();

    this.verbose(1, t('slackersSquadServices.verbose.mounted', {}, this.lang));

    // Resolve the ready promise — consumer plugins awaiting this._s3.ready() can now proceed
    this._resolveReady();
  }

  /**
   * NOTE: unmount() is defined here for correctness, but as of SquadJS v4.2.0 RC1
   * and earlier, the framework never calls plugin.unmount(). This method is kept
   * for future-proofing — if SquadJS ever implements dynamic mount/unmount,
   * cleanup will work correctly.
   */
  async unmount() {
    // Emit any suppressed stderr tallies before shutting down — a burst that
    // stopped before its dedupe window closed would otherwise never report its
    // final count, which is exactly the number an operator wants after an outage.
    flushStderrDiagnostics();

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

    this.verbose(1, t('slackersSquadServices.verbose.unmounted', {}, this.lang));
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
    this.verbose(3, t('slackersSquadServices.verbose.updatedPlayerInfoTick', { playerCount }, this.lang));

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
    this.verbose(2, t('slackersSquadServices.verbose.playerConnected', { playerName, eosID }, this.lang));

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
      this.verbose(3, t('slackersSquadServices.verbose.migrationDbNotReady', {}, this.lang));
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
      this.verbose(3, t('slackersSquadServices.verbose.noPendingMigrations', {}, this.lang));
      // Run live schema verification now that all consumer plugins have registered
      if (typeof db.verifyLiveSchema === 'function') {
        try {
          await db.verifyLiveSchema();
        } catch (err) {
          this.verbose(1, `[S3 Migration] Live schema verification failed: ${err.message}`);
        }
      }
      return;
    }

    const uniquePlugins = [...new Set(pending.map((m) => m.pluginName))];
    this.verbose(
      1,
      t('slackersSquadServices.verbose.pendingCount', {
        count: pending.length,
        plugins: uniquePlugins.length
      }, this.lang)
    );

    // Auto-migrate path: apply immediately without Discord confirmation
    if (this.options.autoMigrate) {
      this.verbose(1, t('slackersSquadServices.verbose.autoMigrateEnabled', {}, this.lang));
      try {
        const engine = db.migrationEngine;
        if (engine) {
          engine.confirmMigrations();
          for (const pluginName of uniquePlugins) {
            const pluginPending = pending.filter((m) => m.pluginName === pluginName);
            this.verbose(1, t('slackersSquadServices.verbose.applyingPlugin', { count: pluginPending.length, pluginName }, this.lang));
            const result = await engine.runMigrations(pluginName);
            this.verbose(1, t('slackersSquadServices.verbose.migrationApplied', { description: result.applied }, this.lang));
          }
          this.verbose(1, t('slackersSquadServices.verbose.allMigrationsApplied', {}, this.lang));
        }
      } catch (err) {
        this.verbose(1, t('slackersSquadServices.verbose.autoMigrateFailed', { message: err.message }, this.lang));
      }
      return;
    }

    // Generate confirmation token and store on MigrationEngine
    const confirmToken = crypto.randomBytes(3).toString('hex'); // 6-character hex
    const me = db.migrationEngine;
    if (me) {
      me.setConfirmToken(confirmToken, pending);
    }
    this.verbose(1, t('slackersSquadServices.verbose.tokenGenerated', { confirmToken }, this.lang));

    // Post to Discord channel if configured
    const discordClient = this.options.discordClient;
    const channelID = this.options.channelID;

    if (!discordClient || !channelID) {
      this.verbose(1, t('slackersSquadServices.verbose.noChannel', {}, this.lang));
      return;
    }

    try {
      const channel = await discordClient.channels.fetch(channelID);
      if (!channel) {
        this.verbose(1, t('slackersSquadServices.verbose.noChannel', {}, this.lang));
        return;
      }

      const embed = buildMigrationEmbed(pending, confirmToken);
      await channel.send({ embeds: [embed] });
      this.verbose(1, t('slackersSquadServices.verbose.promptSent', { channelID }, this.lang));
    } catch (err) {
      this.verbose(1, t('slackersSquadServices.verbose.promptFailed', { message: err.message }, this.lang));
    }
  }
}