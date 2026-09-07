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
 *     get serverID()              — Returns the id stamped onto server-scoped rows.
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
 * - Server identity is resolved in prepareToMount(), BEFORE any
 *   service is constructed, because the id is part of what several of
 *   them write and cannot be settled afterwards. The refusal still
 *   happens in mount(): an unusable id is recorded here and stops the
 *   mount there, so a bad configuration fails in one legible place
 *   rather than as a null appearing in rows.
 * - With no id configured, resolveServerID() falls back and says so
 *   at verbose level 1. That fallback is safe for one server and is
 *   the single most dangerous thing to ignore before pointing a
 *   second one at the same database: two servers both falling back
 *   share one identity and interleave their rows.
 * - The registry row is claimed at mount through registerServer(),
 *   kept alive by a heartbeat, and reported by !s3 servers. A claim
 *   on an id another LIVE process holds writes nothing and refuses,
 *   rather than overwriting a running server's registration.
 * - Everything about scope, locking, clocks and version lockstep
 *   lives in DBService — see its SERVER IDENTITY AND SCOPE header.
 *   This plugin owns the identity decision and the mount refusal;
 *   it does not own the rules.
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
 *   !s3 servers              → The server registry: who else writes to this database, with
 *                              each row’s suite version, clock skew and community options.
 *   !s3 servers alias ...    → Rename a registered server.
 *   !s3 servers forget ...   → Deregister one that has stopped heartbeating.
 *   !s3 config               → Server config values.
 *   !s3 switches [ident] [range]  → Team-switch leaderboard, or one player's breakdown by source.
 *   !s3 switches export [range] [period] [--json]  → All-players switch/round counts per period, as a file attachment.
 *   !s3 karma <ident> [range]     → Win-rate of a player's own switches (excludes balancer/SmartAssign) vs. round outcome.
 *   !s3 db status            → Connector type, schema version status per plugin.
 *   !s3 db orphans           → Tables in the database that no live model claims —
 *                              what a rename or a removed plugin left behind.
 *   !s3 db export [--logs|--all] [--to-file]  → Export tables as JSON.
 *   !s3 db import [--confirm] [--dry-run]       → Import from backup.
 *   !s3 diag                 → Consolidated read-only health check.
 *   !s3 migrate <pending|status|force [--dry-run]|preview|ddl [plugin]|verify|purge-deprecated>  → Schema migration management.
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
import { registerS3DiscordCommands, sendDiscordMessage } from '../utils/s3-discord.js';
import { configureStderrDiagnostics, flushStderrDiagnostics, stderrError, stderrWarn } from '../utils/s3-stderr.js';
import { MIGRATION_LOCK_UNAVAILABLE } from '../utils/migration-engine.js';
import { serverLabels, publishServerLabel } from '../utils/s3-server-label.js';
import { buildMigrationEmbed } from '../utils/s3-migration-discord.js';
import { localize as lookupMessage, DEFAULT_LANGUAGE } from '../utils/s3-i18n.js';

/**
 * How often the registry heartbeat may stamp, at most.
 *
 * UPDATED_PLAYER_INFORMATION fires about every thirty seconds on the deployed
 * fork, and the throttle exists so that a server configured to poll harder
 * does not turn a liveness signal into a write loop. It has to stay well
 * inside SERVER_FRESHNESS_MS (two minutes) or a live server reads as stale
 * between its own beats — the ratio, not either number alone, is what makes
 * the freshness window mean anything.
 */
const S3_HEARTBEAT_INTERVAL_MS = 45 * 1000;

/**
 * How often expired lock rows are cleared.
 *
 * Nothing depends on this being prompt. An expired row blocks nobody: the
 * migration path steals a row whose TTL has passed, and a Discord message key
 * is a snowflake that is never contended twice. This is housekeeping so the
 * table does not accumulate a day of admin traffic, and five minutes is
 * frequent enough for that and infrequent enough to be invisible.
 */
const S3_LOCK_REAP_INTERVAL_MS = 5 * 60 * 1000;
export default class SlackersSquadServices extends BasePlugin {
  static get description() {
    return "Shared Slacker's Squad Services plugin wiring gameState, factions, clans, db, and players modules.";
  }

  static get defaultEnabled() {
    return false;
  }

  static get version() { return '1.8.0'; }

  static get optionsSpecification() {
    return {
      // The only place language is set. Every S³ plugin reads it through
      // S3PluginBase's `lang` getter; consumers declare no language option.
      language: {
        required: false,
        description: 'Language for all S³ plugin messages. Available: en, pt. Unknown codes fall back to en with a warning.',
        default: 'en'
      },
      // Escape hatch for two installs that both ship `"id": 1`. Changing the
      // SquadJS-side id is the better fix where it is available, but it
      // renumbers rows other plugins have already written, so this overrides
      // the id for S³ alone. Mirrors db-log's option of the same name.
      overrideServerID: {
        required: false,
        description: 'An overridden server ID, for multi-server setups sharing one database.',
        default: null
      },
      forceServerClaim: {
        required: false,
        description:
          'Claim this server id even when another process appears to be live under it. ' +
          'The escape hatch for a false positive: a legitimate port change plus a restart inside ' +
          'the two-minute freshness window looks exactly like a second server writing under the ' +
          'same id, and without this the suite refuses to come up until the window passes. Turn ' +
          'it back off once the server is up — left on, it disables the check that stops two ' +
          'communities interleaving their data.',
        default: false
      },
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
        default: true
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

    // Resolved in prepareToMount(), because the services built there need it.
    // A bad value is held rather than thrown so that mount() can be the single
    // place S³ refuses — a throw out of prepareToMount() takes the whole
    // SquadJS boot down before any plugin has a logger the operator will read.
    this._serverID = null;
    // The verdict registerServer() returned, kept so !s3 can report it.
    this._serverRegistration = null;
    // The version-lockstep comparison’s result, kept for tests and diagnostics. Null
    // until the claim has run; the refusal itself lives in
    // _serverIdentityBlocked, which is the one gate the plugins read.
    this._versionLockstep = null;
    // Set to an operator-facing sentence when a live process is already
    // claiming this id. Consumer plugins read it through S3PluginBase and
    // refuse to mount; S³ itself stays up so the operator can diagnose.
    this._serverIdentityBlocked = null;
    this._serverIDError = null;

    this._s3DiscordCleanup = null;
    this._migrationDiscordCleanup = null;
    this._migrationPromptTimer = null; // Delay timer used by _scheduleMigrationPrompt()

    // Throttles for _registryTick(). Zero rather than null so the first
    // player-info tick after mount stamps immediately — a process that has
    // just registered is exactly the one whose row other servers most need
    // to see, and waiting 45 seconds for the first beat would leave it
    // reading as stale to a command typed in the meantime.
    this._lastRegistryHeartbeatAt = 0;
    this._lastLockReapAt = 0;

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
  get version()       { return SlackersSquadServices.version; }
  get serverID()      { return this._serverID; }
  get serverIdentityBlocked() { return this._serverIdentityBlocked; }
  get serverRegistration()    { return this._serverRegistration; }
  get versionLockstep()       { return this._versionLockstep; }
  get gameState()     { return this.services.gameState; }
  get serverConfig()  { return this.services.serverConfig; }
  get db()            { return this.services.db; }
  get factions()      { return this.services.factions; }
  get clans()         { return this.services.clans; }
  get players()       { return this.services.players; }
  get logging()       { return this.services.logging; }

  // The single source of language for the whole suite. S3PluginBase reads this
  // through this._s3?.lang, so every consumer plugin follows whatever is set
  // here and declares no language option of its own.
  get lang()          { return this.options?.language || DEFAULT_LANGUAGE; }

  // S³ extends BasePlugin rather than S3PluginBase, so it does not inherit that
  // class's localize() and needs its own for its own messages.
  localize(key, vars = {}) {
    return lookupMessage(key, vars, this.lang);
  }

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

    // Server identity, before any service is built — the id is part of what
    // several of them write, so it cannot be settled later. Resolved here and
    // not in mount() for that reason; the refusal still happens in mount().
    try {
      const resolved = DBService.resolveServerID({
        overrideServerID: this.options.overrideServerID,
        server: this.server
      });
      this._serverID = resolved.serverID;
      if (resolved.fallback) {
        this.verbose(
          1,
          `[S3] No server id configured — using ${resolved.serverID}. Set "id" in your SquadJS server config, ` +
          'or overrideServerID on this plugin, before pointing a second server at this database: two servers ' +
          'both falling back here would share one identity and interleave their rows.'
        );
      } else {
        this.verbose(1, `[S3] Server id ${resolved.serverID}, from ${resolved.source}.`);
      }
    } catch (err) {
      this._serverIDError = err;
    }

    this.services.db = new DBService({
      parent: this,
      server: this.server,
      serverID: this._serverID,
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

  /**
   * Apply the operator's stderr settings to the diagnostic channel.
   *
   * Called from prepareToMount() so it takes effect before any plugin can fail,
   * and again from mount() so a host that mounts without preparing (tests, or a
   * future SquadJS change) still gets configured. Idempotent.
   */
  _configureStderrDiagnostics() {
    const stderrMode = ['auto', 'mirror', 'off'].includes(this.options.stderrDiagnostics)
      ? this.options.stderrDiagnostics
      : 'off';
    configureStderrDiagnostics({
      mode: stderrMode,
      windowMs: Math.max(0, Number(this.options.stderrDedupeWindowSeconds ?? 60)) * 1000
    });
  }

  /**
   * Mount one service, naming it if it throws.
   *
   * SquadJS mounts plugins with `Promise.all(...)` from an un-caught `main()`,
   * so a rejection here surfaces as an unhandled rejection rather than as
   * anything a caller handles. Once DBService has mounted it has also installed
   * a process-level listener for those, which means the server keeps running
   * with a half-mounted S³ — so a service failing after `db` needs to announce
   * itself or it announces nothing. Reporting the service by name is the
   * difference between "S³ is broken" and "PlayersService could not create its
   * table". Re-thrown unchanged: this adds a diagnostic, it does not decide
   * that a failed mount is survivable.
   *
   * Reports through stderrError directly rather than reportError(): this class
   * extends SquadJS's BasePlugin, not S3PluginBase, so it has no reportError.
   *
   * @param {string} name - Service key, used in the message
   * @param {Function} fn - Async thunk performing the mount
   */
  async _mountService(name, fn) {
    try {
      await fn();
    } catch (err) {
      this.verbose(1, `[S3] ${name} service failed to mount: ${err.message}`);
      stderrError(
        'S3Mount',
        `${name} service failed to mount — S³ is only partially available.`,
        err
      );
      throw err;
    }
  }

  async mount() {
    // Belt and braces — prepareToMount() has normally already done this.
    this._configureStderrDiagnostics();

    // Refuse here rather than repairing. An unusable server id is a
    // configuration mistake whose only silent outcomes are bad ones: a
    // truncated key merges two servers' rounds, and a substituted id claims
    // rows that belong to someone else.
    if (this._serverIDError) {
      this.verbose(1, this._serverIDError.message);
      stderrError('S3Mount', 'S³ cannot mount: the configured server id is unusable.', this._serverIDError);
      throw this._serverIDError;
    }

    if (this.services.serverConfig) {
      await this._mountService('serverConfig', () => this.services.serverConfig.mount());
    }

    if (this.services.db) {
      await this._mountService('db', () => this.services.db.mount());
      // Before any service that writes server-scoped rows. A live collision
      // means somebody else's rows are already under this id, and every write
      // after this point would add to them.
      await this._claimServerIdentity();
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
        this.verbose(1, `[S3] Schema drift alert triggered for: ${pluginNames.join(', ')}`);
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
            .map(e => `- **${e.table}**: ${e.dataViolations.map(v => this.localize('slackersSquadServices.driftViolations.emptyRows', { offenders: v.offenders, column: v.column })).join(', ')}`);
          if (dataViolations.length > 0) parts.push(dataViolations.join('\n'));
          const description = parts.length > 0
            ? this.localize('slackersSquadServices.drift.descriptionSummary', { parts: parts.join('\n') })
            : this.localize('slackersSquadServices.drift.descriptionFallback');
          discordClient.channels.fetch(channelID).then(channel => {
            if (channel) {
              channel.send({
                embeds: [{
                  color: 0xe74c3c,
                  title: this.localize('slackersSquadServices.drift.embedTitle'),
                  description,
                  timestamp: new Date().toISOString(),
                  footer: { text: this.localize('slackersSquadServices.drift.footer') }
                }]
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      };
    }

    // Check for pending migrations and prompt via Discord if any
    this._scheduleMigrationPrompt();

    this.verbose(1, 'Mounted SlackerSquadServices with gameState, factions, clans, db, players, serverConfig, and logging services.');

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

  /**
   * Claim this process's row in the server registry and act on the verdict.
   *
   * The interesting case is the one that refuses. Two SquadJS installs pointed
   * at one database with the stock `"id": 1` do not fail — they interleave,
   * quietly, and the damage is only visible much later in rounds attributed to
   * the wrong community. So a fingerprint that disagrees with a row somebody
   * else stamped in the last two minutes stops the server-scoped plugins from
   * mounting at all.
   *
   * S³ itself stays up. The operator needs `!s3` to see what happened, and a
   * process that exits leaves them reading a log for the reason.
   *
   * A stale row is the opposite case and must not refuse: it is what a port
   * change or a moved server looks like, and taking a live game offline for a
   * config edit is a worse outcome than the one being prevented.
   *
   * @private
   */
  async _claimServerIdentity() {
    // Server.cfg's copy of the name, for the boot where RCON has not answered
    // yet — which is most of them, since serverConfig mounts before db and
    // `updateServerInformation()` runs on its own schedule. Without it the
    // registry row is created nameless and stays that way until something
    // else updates it, so every `!s3 servers` listing and every ambiguous
    // `--server` refusal shows an id where a name would settle the question.
    const configName = this.services.serverConfig?.getServerName?.() ?? null;

    const verdict = await this.services.db.registerServer({
      server: this.server,
      suiteVersion: this.version,
      fallbackServerName: configName,
      force: this.options.forceServerClaim === true
    });

    this._serverRegistration = verdict;

    switch (verdict.status) {
      case 'created':
      case 'refreshed':
      case 'reclaimed':
        // Naming happens after the claim, never inside it. registerServer()
        // leaves alias null so a unique index cannot abort the insert, which
        // means an unnamed row is the normal state for one instant and this is
        // what ends it. A failure here costs the --server token, not the mount.
        await this.services.db.claimDefaultAlias({
          serverName: this.server?.serverName || configName
        });
        break;
    }

    switch (verdict.status) {
      case 'created':
        break;

      case 'refreshed':
        this.verbose(3, `[S3] Server ${verdict.serverID} re-registered; fingerprint unchanged.`);
        break;

      case 'reclaimed': {
        const fields = verdict.differences.join(', ');
        if (verdict.forced) {
          this.verbose(
            1,
            `[S3] forceServerClaim is set: took server ${verdict.serverID} from a process that stamped it ` +
            `less than two minutes ago (${fields} differ). Turn the option back off — while it is set, ` +
            'nothing stops a second install writing under this id.'
          );
        } else {
          this.verbose(
            1,
            `[S3] Server ${verdict.serverID} was last seen with a different ${fields}. The row was stale, ` +
            'so this looks like a moved server or a changed port; the registry has been updated.'
          );
        }
        break;
      }

      case 'collision': {
        const fields = verdict.differences.join(', ');
        const age = Math.round((Date.now() - (verdict.lastSeenAt || Date.now())) / 1000);
        this._serverIdentityBlocked =
          `another process is live under server id ${verdict.serverID} with a different ${fields} ` +
          `(last seen ${age}s ago)`;

        this.verbose(
          1,
          `[S3] Refusing to claim server id ${verdict.serverID}: another process stamped it ${age}s ago ` +
          `with a different ${fields}. Give each install its own overrideServerID, or set ` +
          'forceServerClaim if this is a port change rather than a second server.'
        );
        stderrError(
          'S3ServerIdentity',
          `Server id ${verdict.serverID} is claimed by another live process — server-scoped plugins will not mount.`,
          `${fields} differ; the other row was stamped ${age}s ago.`
        );
        this._postServerCollisionEmbed(verdict, age);
        break;
      }

      case 'unavailable':
      default:
        this.verbose(
          1,
          `[S3] Server registry unavailable (${verdict.reason}). Nothing can tell whether a second ` +
          'install shares this database, so the multi-server guards are inert.'
        );
        break;
    }

    // Version lockstep, gated on the claim having succeeded. A collision
    // has already blocked the mount for a more specific reason, and replacing
    // it with this one would send an operator after the wrong problem.
    if (!this._serverIdentityBlocked) {
      await this._checkVersionLockstep();
    }

    // Establish the baseline the heartbeat compares against. Without it the
    // first round roll would absorb whatever the count is by then — and a
    // server that joins during the round this process booted into would never
    // be announced, which is the case the heartbeat re-read exists for.
    await this.services.db.refreshRegisteredServerCount();

    // And the label the senders read, before the first embed goes out rather
    // than at the first heartbeat thirty seconds later. A boot that answers a
    // command in its first half-minute would otherwise answer it unlabelled.
    await this._publishServerLabel();
  }

  /**
   * Refuse to bring the server-scoped plugins up beside a process running a
   * different suite version.
   *
   * This reuses the fingerprint-collision path exactly — same registry table,
   * same `serverIdentityBlocked` gate, same operator-facing shape — because it
   * is the same decision: something about the shared database is not what this
   * process assumes, and writing anyway is worse than not coming up. It is one
   * comparison and one message.
   *
   * Runs only when the identity claim itself succeeded. A collision has already
   * blocked the mount with a more specific reason, and overwriting it with this
   * one would send an operator after the wrong problem.
   */
  async _checkVersionLockstep() {
    const result = await this.services.db.checkVersionLockstep(this.version);
    this._versionLockstep = result;
    if (result.ok) return;

    const named = result.mismatches
      .map((row) => `${row.alias || `server ${row.serverID}`} on ${row.suiteVersion}`)
      .join(', ');

    this._serverIdentityBlocked =
      `this install is on ${result.version} and ${named} is live on this database — every process in a ` +
      'community must run the same suite version';

    this.verbose(
      1,
      `[S3] Refusing to mount: this install is on ${result.version}, ${named}. A mixed pair writes ` +
      'against a schema one of them does not know about, and a community-wide command answered by the ' +
      'older process runs a superseded handler. Stop every process, upgrade them all, then start them.'
    );
    stderrError(
      'S3VersionLockstep',
      `Suite version mismatch — server-scoped plugins will not mount.`,
      `This install is on ${result.version}; ${named}.`
    );
    this._postVersionMismatchEmbed(result, named);
  }

  _postVersionMismatchEmbed(result, named) {
    const discordClient = this.options.discordClient;
    const channelID = this.options.channelID;
    if (!discordClient || !channelID) return;

    discordClient.channels.fetch(channelID).then((channel) => {
      if (!channel) return;
      channel.send({
        embeds: [{
          color: 0xe74c3c,
          title: this.localize('slackersSquadServices.serverRegistry.versionMismatchTitle'),
          description: this.localize('slackersSquadServices.serverRegistry.versionMismatchDescription', {
            version: result.version,
            others: named
          }),
          timestamp: new Date().toISOString(),
          footer: { text: this.localize('slackersSquadServices.serverRegistry.collisionFooter') }
        }]
      }).catch(() => {});
    }).catch(() => {});
  }

  /**
   * Post the collision to the admin channel.
   *
   * Best-effort and deliberately silent on failure — the refusal has already
   * happened and is already in the log. Mirrors the drift-alert embed rather
   * than inventing a second shape for the same kind of news.
   *
   * @private
   */
  _postServerCollisionEmbed(verdict, ageSeconds) {
    const discordClient = this.options.discordClient;
    const channelID = this.options.channelID;
    if (!discordClient || !channelID) return;

    discordClient.channels.fetch(channelID).then((channel) => {
      if (!channel) return;
      channel.send({
        embeds: [{
          color: 0xe74c3c,
          title: this.localize('slackersSquadServices.serverRegistry.collisionTitle'),
          description: this.localize('slackersSquadServices.serverRegistry.collisionDescription', {
            serverID: verdict.serverID,
            fields: verdict.differences.join(', '),
            age: ageSeconds
          }),
          timestamp: new Date().toISOString(),
          footer: { text: this.localize('slackersSquadServices.serverRegistry.collisionFooter') }
        }]
      }).catch(() => {});
    }).catch(() => {});
  }
  /**
   * Stamp the registry, re-read the count, and clear expired lock rows.
   *
   * ─── WHY THIS EVENT ───
   *
   * The round roll was the only heartbeat until Phase 6, and the reasoning
   * for it stands: it is evidence the server is genuinely running, which a
   * `setInterval` is not — a timer keeps stamping the row of a process that
   * has stopped doing everything else. UPDATED_PLAYER_INFORMATION is the same
   * kind of evidence at a usable rate. It fires only when RCON answered, and
   * it fires about every thirty seconds instead of about every hour.
   *
   * The rate is what the freshness window needs. A two-minute window against
   * an hourly stamp means every server in the community reads as stale for
   * most of every round, which makes "is that server answering" unanswerable
   * and would have the version check comparing against nobody.
   *
   * It also carries the registered count, because `heartbeatServer()` refreshes
   * it on the same call — deliberately, so the two cannot come apart. A server
   * that joins mid-round changes what every admin command in the channel has to
   * say, and noticing that at the next map roll is noticing it far too late.
   *
   * ─── THE REAPER ───
   *
   * `S3_Locks` holds two populations with lifetimes orders of magnitude apart,
   * and the reaper deletes on each row's own `expiresAt` rather than on an age
   * threshold. That is the whole reason it is safe to run here: a reaper tuned
   * to the seconds-long Discord claims would happily delete a migration lock
   * that is still ten minutes from expiring and legitimately held.
   *
   * Both are throttled against the local clock, which is the right clock for a
   * "how often do I do this" question — only the lock expiries themselves cross
   * machines, and those are minted from the database.
   *
   * @private
   */
  async _registryTick() {
    const db = this.services.db;
    if (!db || !db.isReady()) return;

    const now = Date.now();

    if (now - this._lastRegistryHeartbeatAt >= S3_HEARTBEAT_INTERVAL_MS) {
      this._lastRegistryHeartbeatAt = now;
      await db.heartbeatServer();
      // On the same tick as the count it depends on. A server joining
      // mid-round is the moment every embed in the channel starts needing to
      // say which one it came from, and picking that up at the next map roll
      // is picking it up an hour late.
      await this._publishServerLabel();
    }

    if (now - this._lastLockReapAt >= S3_LOCK_REAP_INTERVAL_MS) {
      this._lastLockReapAt = now;
      await db.reapExpiredLocks();
    }
  }

  /**
   * Resolve this process's embed label and hand it to the senders.
   *
   * ─── WHY IT IS RESOLVED HERE ───
   *
   * Every Discord embed in the suite goes out through one of four senders,
   * and three of them are free functions taking `(channel, content)` — no
   * plugin, no language, no server id, no database. They cannot work out
   * what to say, and they must not: they run on every message and a lookup
   * there would be a query per embed.
   *
   * So the string is resolved on the heartbeat, where the registry has just
   * been read anyway, and published to a module the senders read from.
   * One `localize()` call, which is also what keeps the label to one line in
   * one translation template — `make-locale-templates.mjs` classifies a key
   * by where it is localized, so four call sites in four plugins would be
   * four verdicts about a string every one of them puts the same way.
   *
   * The verdict it does reach is player-facing, which is right: the footer
   * rides on every embed the suite sends, and some of those are public `!elo`
   * replies rather than staff channels.
   *
   * ─── WHY IT CAN BE NULL ───
   *
   * A single-server install publishes nothing, and the decoration becomes a
   * no-op at the sender rather than a branch. That is the zero-delta
   * guarantee, held in one place instead of asserted across 138 embeds.
   *
   * A registered name that is not distinct also publishes nothing — see
   * `serverLabels()`. The alias is the fallback there, because it is unique
   * by construction and a label that could mean either of two servers is
   * worse than no label at all.
   *
   * @private
   */
  async _publishServerLabel() {
    const db = this.services.db;

    try {
      if (!db?.isReady?.() || db.getKnownServerCount() === 1) {
        publishServerLabel(null);
        return;
      }

      const rows = await db.getRegisteredServers();
      if (rows.length < 2) {
        publishServerLabel(null);
        return;
      }

      const mine = rows.find((row) => row.serverID === db.getServerID());
      const alias = serverLabels(rows).get(db.getServerID()) || mine?.alias || null;

      publishServerLabel(
        alias ? this.localize('s3ServerLabel.footer', { alias }) : null
      );
    } catch (err) {
      // A label is decoration. Losing it must not cost the heartbeat that
      // was the point of this tick, and an unlabelled embed is legible.
      this.verbose(2, `[S3] Could not resolve the server label: ${err.message}`);
    }
  }

  async handleNewGame(data) {
    // The round roll still stamps, unconditionally and ahead of the throttle.
    // _registryTick() is the cadence now (see it for why this event is not
    // enough on its own), but a roll is the one moment a report boundary and
    // the registry ought to agree exactly, and it costs one write an hour.
    this._lastRegistryHeartbeatAt = Date.now();
    if (this.services.db) await this.services.db.heartbeatServer();

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

    await this._registryTick();

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
    let pending = status.pending;

    // Refresh the cached pending list and create the migration gate so that
    // getPendingMigrations() and waitForMigrations() return correct data
    // for any consumer that calls them after this point.
    db._pendingMigrations = pending;
    if (pending.length > 0 && !db._migrationGate) {
      db._migrationGate = new Promise((resolve) => {
        db._resolveMigrationGateFn = resolve;
      });
    }

    // Drift on a server that ALSO has migrations pending used to be invisible
    // here — the check below only ran when nothing was pending — so it could
    // only surface in post-migration verification, i.e. after a run. Repairing
    // it then took a second run: one to reveal the drift, one to fix it.
    // Checking now folds both into the single prompt the operator already gets.
    // filterDriftToApplied() is what makes this safe: it drops schema belonging
    // to migrations that simply have not run yet, so a routine upgrade — and a
    // brand-new install, where nothing exists at all — raises no false alarm.
    if (pending && pending.length > 0) {
      const raw = await db.verifyLiveSchema();
      db._lastDriftResult = raw;
      const drift = await db.filterDriftToApplied(raw);
      if (drift.some(e => e.missing || e.missingRows || e.dataViolations)) {
        this.verbose(1, `[S3 Migration] Schema drift detected alongside ${pending.length} pending migration(s) — ${drift.length} issue(s).`);
        await db._handleDetectedDrift(drift);
        // _handleDetectedDrift() widens the pending list to the rollback targets
        // it just wrote, so the prompt renders the full range to be re-applied.
        pending = db._pendingMigrations;
      }
    }

    if (!pending || pending.length === 0) {
      this.verbose(3, '[S3 Migration] No pending migrations.');
      // Run live schema verification now that all consumer plugins have registered
      // their models. The initial verifyLiveSchema() during db.mount() ran before
      // any models were registered, so it could not detect drift. This second pass
      // captures the actual schema state — on a server where S3_SchemaVersions
      // already matches the expected version but the actual DB columns are missing
      // (e.g. a prior migration's ADD COLUMN silently failed due to MySQL permissions),
      // this will detect the drift and trigger recovery.
      const drift = await db.verifyLiveSchema();
      db._lastDriftResult = drift;
      if (drift.length > 0) {
        this.verbose(1, `[S3 Migration] Schema drift detected on up-to-date server — ${drift.length} issue(s).`);
        await db._handleDetectedDrift(drift);
        // Only re-schedule the migration prompt if the drift includes missing
        // columns, missing rows, or violated data post-conditions — extra-only
        // drift is informational and does not require admin intervention.
        // _handleDetectedDrift() only re-opens the migration gate for those
        // three; unconditionally re-scheduling here would create an infinite
        // loop since extra-only drift never creates a pending migration.
        if (drift.some(e => e.missing || e.missingRows || e.dataViolations)) {
          this._scheduleMigrationPrompt();
        }
      }
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
      const lostTheLock = [];
      let hardFailure = false;
      for (const p of pending) {
        try {
          if (!me) {
            this.verbose(1, `[S3 Migration] MigrationEngine not available — cannot migrate "${p.pluginName}".`);
            hardFailure = true;
            continue;
          }
          const result = await me.runMigrations(p.pluginName);
          this.verbose(2, `[S3 Migration] "${p.pluginName}": ${result.applied} applied, ${result.skipped} skipped.`);
        } catch (err) {
          if (err?.code === MIGRATION_LOCK_UNAVAILABLE) {
            lostTheLock.push(p.pluginName);
            this.verbose(1, `[S3 Migration] Another process is migrating "${p.pluginName}" — will re-check rather than assume.`);
          } else {
            hardFailure = true;
            this.verbose(1, `[S3 Migration] Auto-migration failed for "${p.pluginName}": ${err.message}`);
          }
        }
      }

      // ─── The losing process's behaviour, identical on all three dialects ───
      //
      // Wait, re-check, come up clean if the winner completed the work. The
      // waiting already happened inside acquireAdvisoryLock(), which polls for
      // the whole wait window rather than returning at the first refusal — so
      // by the time a lock error reaches here, the holder was still alive and
      // inside its TTL for the full duration. What is left is the re-check, and
      // that has to read the SHARED version record, because the whole point is
      // that the work may have been done by a process this one cannot see.
      //
      // This used to fall straight through to _resolveMigrationGate(true),
      // which clears _pendingMigrations and unblocks every consumer plugin. A
      // process that knows it did not migrate must not mount plugins against a
      // schema another process is halfway through changing, so a failure that
      // survives the re-check now fails CLOSED: the gate stays shut, consumers
      // stay blocked in waitForMigrations(), and the prompt is re-scheduled.
      if (lostTheLock.length === 0 && !hardFailure) {
        db._resolveMigrationGate(true);
        return;
      }

      let stillPending = [];
      try {
        const recheck = await db.verifySchemaVersions();
        stillPending = recheck.pending || [];
      } catch (err) {
        // Cannot tell whether the winner finished. Fail closed — this is the
        // direction where being wrong is recoverable.
        this.verbose(1, `[S3 Migration] Could not re-check schema versions after a lock conflict: ${err.message}`);
        stillPending = pending;
      }

      if (stillPending.length === 0 && !hardFailure) {
        this.verbose(
          1,
          `[S3 Migration] Another process applied ${lostTheLock.join(', ')} while this one waited — schema is up to date, coming up clean.`
        );
        db._resolveMigrationGate(true);
        return;
      }

      db._pendingMigrations = stillPending;
      const names = stillPending.map((p) => p.pluginName).join(', ') || lostTheLock.join(', ');
      this.verbose(
        1,
        `[S3 Migration] ${stillPending.length} migration(s) still pending after auto-migration (${names}). ` +
        'Consumer plugins stay blocked rather than mounting against a schema that is mid-change.'
      );
      stderrWarn(
        'S3Migration',
        'Auto-migration did not complete and the schema is not at its expected version. Consumer plugins are blocked until it is.',
        names
      );
      this._scheduleMigrationPrompt();
      return;
    }

    // ─── One prompt per community, not one per process ───────────────
    //
    // Every process reaches this point with the same pending set, so on a
    // two-server install the admin channel gets two embeds carrying two
    // tokens for one schema change. The migration itself was already safe —
    // `runMigrations()` takes the advisory lock and a loser waits and
    // re-checks — so this is not a correctness fix. It is a legibility one,
    // and the failure it prevents is an admin confirming the token that
    // scrolled past rather than the one on screen.
    //
    // Keyed on the pending set rather than on a message id, because there is
    // no message yet — this claim is what decides who gets to make one. The
    // claim's TTL and the token's expiry are both five minutes, so a prompt
    // that goes unanswered frees the key at the same moment its token dies
    // and the next boot is free to ask again.
    //
    // A loser does not mint a token. Minting one would arm an idempotency
    // guard on a prompt that reached nobody, and `confirmToken()` rejects
    // anything the engine did not mint, so the winner's token reaches the
    // winner by construction. The loser stays blocked, which is where a
    // process facing an unapplied migration belongs.
    const promptKey = `migrate-prompt:${pending.map((p) => `${p.pluginName}@${p.expectedVersion}`).sort().join(',')}`;
    const sharedSchema = (db.getKnownServerCount?.() ?? 1) > 1;
    if (sharedSchema) {
      const claim = await db.claimDiscordMessage(promptKey);
      if (claim?.claimed !== true) {
        this.verbose(
          1,
          `[S3 Migration] Another server already posted the prompt for ${pending.length} pending migration(s) — ` +
          'staying blocked rather than posting a second token for the same schema change.'
        );
        return;
      }
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
    const embed = buildMigrationEmbed(this, pending, 'pending', null);
    // Said before the token, not after it. An admin who reads only as far as
    // the thing they have to type has still read that this changes the schema
    // every server shares, and they may well be thinking about only one.
    if (sharedSchema) {
      embed.description += '\n' + this.localize('slackersSquadServices.migrate.sharedSchemaWarning', {
        count: String(db.getKnownServerCount?.() ?? '?')
      });
    }
    embed.description += '\n' + this.localize('slackersSquadServices.migrate.tokenLine', { token });

    this.verbose(1, `[S3 Migration] ${pending.length} plugin(s) have pending schema migrations. Generated token: ${token}`);

    // Post embed to the admin Discord channel
    const discordClient = this.options.discordClient;
    const channelID = this.options.channelID;
    if (discordClient && channelID) {
      try {
        const channel = await discordClient.channels.fetch(channelID);
        if (channel) {
          // Through sendDiscordMessage(), not channel.send() directly. This was
          // the one embed in the suite that bypassed the shared sender, and it
          // is the embed that can least afford to: it carries the confirmation
          // token, and the token exists nowhere else an operator can reach.
          // When it fails, someone running autoMigrate:false — the whole
          // audience for a gated migration — is left with no way to proceed.
          //
          // The helper adds three things this needs. It retries once on a 429,
          // which a boot-time burst can provoke. It falls back to the older
          // single-embed payload shape on "Cannot send an empty message",
          // which is the error this actually failed with in the field. And it
          // applies the server label, so that on a shared database two servers
          // prompting at once produce two tokens an operator can tell apart —
          // without it they are two identical embeds with different tokens.
          const sent = await sendDiscordMessage(
            channel, { embeds: [embed] }, 'S3 Migration', (...a) => this.verbose(...a)
          );
          if (sent) {
            this.verbose(1, `[S3 Migration] Token embed posted to Discord — ${pending.length} plugin(s) pending.`);
          } else {
            // sendDiscordMessage() reports the reason itself and returns false
            // rather than throwing, so say what to do about it.
            this.verbose(1, `[S3 Migration] Token embed could not be posted. Token: ${token} — use !s3 confirm ${token} in the admin channel, or !s3 migrate force, or set autoMigrate: true in S³ config.`);
          }
        }
      } catch (err) {
        this.verbose(1, `[S3 Migration] Failed to reach the admin channel: ${err.message}`);
        this.verbose(1, `[S3 Migration] Token: ${token} — use !s3 confirm ${token}, or !s3 migrate force, or set autoMigrate: true in S³ config.`);
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
   * migrations, AND by the drift-recovery path after _handleDetectedDrift()
   * repopulates _pendingMigrations for affected plugins.
   *
   * Multiple callers may invoke this in rapid succession during
   * initialisation — the 500ms debounce ensures only one Discord embed is
   * posted after all plugins have registered their expected versions.
   * Each call to verifyAndRunMigrations() from a consumer plugin resets
   * the timer, so the prompt fires 500ms after the LAST consumer registers.
   *
   * Idempotency guard: if a valid unexpired token already exists on the
   * MigrationEngine, the prompt was already posted and this is a no-op.
   * The drift-recovery path may still bypass this if the token expired
   * but the gate is still re-open — _handleDetectedDrift() creates a new
   * gate and nullifies any stale token, so the next call will proceed.
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
