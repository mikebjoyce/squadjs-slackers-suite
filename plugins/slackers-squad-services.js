import BasePlugin from './base-plugin.js';
import GameStateService from '../utils/game-state-service.js';

/**
 * Base scaffold plugin for Slacker's Squad Services (S³).
 *
 * Stage 1 scope:
 * - Declare connector contracts only (Discord + database)
 * - Provide lifecycle skeleton for future service modules
 * - No service implementations yet (gameState/factions/clans/db/players)
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
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.services = {
      gameState: null
    };
  }

  async prepareToMount() {
    this.services.gameState = new GameStateService({
      server: this.server,
      ignoredGameModes: ['Seed', 'Jensen'],
      log: (...args) => this.verbose(...args)
    });
  }

  async mount() {
    if (this.services.gameState) {
      await this.services.gameState.mount();
    }

    this.verbose(1, 'Mounted SlackerSquadServices with gameState service.');
  }

  async unmount() {
    if (this.services.gameState) {
      await this.services.gameState.unmount();
    }

    this.verbose(1, 'Unmounted SlackerSquadServices and gameState service.');
  }
}
