import BasePlugin from './base-plugin.js';
import GameStateService from '../utils/game-state-service.js';
import FactionsService from '../utils/factions-service.js';

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
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.services = {
      gameState: null,
      factions: null
    };
  }

  async prepareToMount() {
    this.services.gameState = new GameStateService({
      server: this.server,
      sequelize: this.options.database,
      ignoredGameModes: this.options.ignoredGameModes,
      log: (...args) => this.verbose(...args)
    });

    this.services.factions = new FactionsService({
      server: this.server,
      gameState: this.services.gameState,
      log: (...args) => this.verbose(...args)
    });
  }

  async mount() {
    if (this.services.gameState) {
      await this.services.gameState.mount();
    }

    if (this.services.factions) {
      await this.services.factions.mount();
    }

    this.verbose(1, 'Mounted SlackerSquadServices with gameState and factions services.');
  }

  async unmount() {
    if (this.services.factions) {
      await this.services.factions.unmount();
    }

    if (this.services.gameState) {
      await this.services.gameState.unmount();
    }

    this.verbose(1, 'Unmounted SlackerSquadServices and shared services.');
  }
}
