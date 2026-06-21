import BasePlugin from './base-plugin.js';
import GameStateService from '../utils/game-state-service.js';
import FactionsService from '../utils/factions-service.js';
import ClansService from '../utils/clans-service.js';
import DBService from '../utils/db-service.js';

/**
 * Base scaffold plugin for Slacker's Squad Services (S³).
 *
 * Stage 1 scope:
 * - Declare connector contracts only (Discord + database)
 * - Provide lifecycle skeleton for future service modules
 * - Implement gameState first; remaining modules follow in later stages
 */
export default class SlackersSquadServices extends BasePlugin {
  static get description() {
    return "Base Slacker's Squad Services scaffold plugin with Discord + database connector wiring.";
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
      db: null
    };
  }

  async prepareToMount() {
    this.services.gameState = new GameStateService({
      server: this.server,
      sequelize: this.options.database,
      ignoredGameModes: this.options.ignoredGameModes,
      verboseLogger: (...args) => this.verbose(...args)
    });

    this.services.factions = new FactionsService({
      server: this.server,
      gameState: this.services.gameState,
      verboseLogger: (...args) => this.verbose(...args)
    });

    this.services.clans = new ClansService({
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

    this.services.db = new DBService({
      sequelize: this.options.database,
      connectors: this.connectors,
      databaseOption: this.options.database,
      verboseLogger: (...args) => this.verbose(...args)
    });
  }

  async mount() {
    if (this.services.gameState) {
      await this.services.gameState.mount();
    }

    if (this.services.factions) {
      await this.services.factions.mount();
    }

    if (this.services.clans) {
      await this.services.clans.mount();
    }

    if (this.services.db) {
      await this.services.db.mount();
    }

    this.verbose(1, 'Mounted SlackerSquadServices with gameState, factions, clans, and db services.');
  }

  async unmount() {
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
}
