import BasePlugin from './base-plugin.js';
import GameStateService from '../utils/game-state-service.js';
import FactionsService from '../utils/factions-service.js';
import ClansService from '../utils/clans-service.js';
import DBService from '../utils/db-service.js';
import PlayersService from '../utils/players-service.js';

/**
 * Shared services plugin for Slacker's Squad Services (S³).
 *
 * Stage 1 status:
 * - Provides connector/config contracts (Discord + database + shared service options)
 * - Composes and mounts gameState, factions, clans, db, and players services
 * - Exposes a single lifecycle-managed service container for later migration wiring
 */
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
        required: true,
        connector: 'discord',
        description: 'Discord connector name for admin channel integration.',
        default: 'discord'
      },
      channelID: {
        required: true,
        description: 'Discord admin channel ID used by SlackersSquadServices.',
        default: '',
        example: '667741905228136459'
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
      players: null
    };

    this.listeners = {
      handleNewGame: this.handleNewGame.bind(this),
      handleRoundEnded: this.handleRoundEnded.bind(this),
      handleLayerInfoUpdated: this.handleLayerInfoUpdated.bind(this),
      handleServerInfoUpdated: this.handleServerInfoUpdated.bind(this),
      handleUpdatedPlayerInfo: this.handleUpdatedPlayerInfo.bind(this),
      handlePlayerConnected: this.handlePlayerConnected.bind(this)
    };
  }

  async prepareToMount() {
    this.services.db = new DBService({
      parent: this,
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
  }

  async mount() {
    if (this.services.db) {
      await this.services.db.mount();
    }

    if (this.services.gameState) {
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

    this._bindServerEvents();

    this.verbose(1, 'Mounted SlackerSquadServices with gameState, factions, clans, db, and players services.');
  }

  async unmount() {
    this._unbindServerEvents();

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
    if (this.services.players?.handlePlayerConnected) {
      await this.services.players.handlePlayerConnected(data);
    }
  }
}
