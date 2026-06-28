/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║       S³ DISCORD PLUGIN BASE CLASS                            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Extends S3PluginBase with Discord channel setup and message
 * sending, mirroring SquadJS's own DiscordBasePlugin pattern but
 * on top of the S³ service layer. Consumer plugins that need both
 * S³ services (discovery, DB, migrations) and a simple single-
 * channel Discord presence extend this class rather than composing
 * S³ and DiscordBasePlugin manually.
 *
 * ─── WHAT IT ADDS OVER S3PLUGBASE ───────────────────────────────
 *
 *   - Adds discordClient connector to optionsSpecification
 *   - Fetches channel from options.channelID in prepareToMount
 *   - Provides sendDiscordMessage() with embed/copyright support
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   export default class MyPlugin extends S3DiscordPluginBase {
 *     static get optionsSpecification() {
 *       return {
 *         ...this.parentOptionsSpecification,
 *         // plugin-specific options, NOT discordClient or channelID
 *       };
 *     }
 *
 *     async _onS3Ready() {
 *       // S³ is ready, Discord channel is available via this.channel
 *     }
 *   }
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - This class expects `discordClient` (connector) and `channelID`
 *   (string) in options. Subclasses must include these via
 *   the parentOptionsSpecification spread pattern, or define
 *   them explicitly.
 * - channelID is intentionally NOT in optionsSpecification here
 *   because different subclasses may name it differently
 *   (e.g. adminChannelID, eventChannelID) — each subclass should
 *   declare its own channelID option. However, this base class
 *   does use `this.options.channelID` during prepareToMount(),
 *   so subclasses must provide an option with that exact key.
 * - sendDiscordMessage() gracefully degrades if the channel was
 *   not successfully fetched (logs a verbose warning and returns).
 * - Inherits all S³ features: _resolveS3(), _onS3Ready(), DB
 *   convenience methods, service accessors.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * S3PluginBase (s3-plugin-base.js)
 *   S³ discovery, DB boilerplate, service accessors.
 *
 * Discord client connector
 *   Resolved from SquadJS connectors map via discordClient option.
 * ─────────────────────────────────────────────────────────────────
 */

import S3PluginBase from './s3-plugin-base.js';

export default class S3DiscordPluginBase extends S3PluginBase {
  static get optionsSpecification() {
    return {
      discordClient: {
        required: true,
        description: 'Discord connector name.',
        connector: 'discord',
        default: 'discord'
      }
    };
  }

  /**
   * Returns the same specification as optionsSpecification, for
   * subclass inheritance via `...this.parentOptionsSpecification`.
   *
   * SquadJS DiscordBasePlugin provides this so that subclasses can
   * spread the parent's options alongside their own.  Without it,
   * Switch (and any future S3DiscordPluginBase subclass) would
   * inherit only its own declared options and miss discordClient.
   */
  static get parentOptionsSpecification() {
    return {
      discordClient: {
        required: true,
        description: 'Discord connector name.',
        connector: 'discord',
        default: 'discord'
      }
    };
  }

  /**
   * Prepares the plugin: discovers S³ (via super), then fetches
   * the Discord channel.
   */
  async prepareToMount() {
    await super.prepareToMount();

    try {
      this.channel = await this.options.discordClient.channels.fetch(
        this.options.channelID
      );
    } catch (error) {
      this.channel = null;
      this.verbose(
        1,
        `Could not fetch Discord channel with channelID "${this.options.channelID}". Error: ${error.message}`
      );
      this.verbose(2, `${error.stack}`);
    }
  }

  /**
   * Sends a message (plain text or embed) to the configured
   * Discord channel.
   *
   * If the message contains an `embed` property, it is converted
   * to an `embeds` array (matching Discord.js v13+ API), a footer
   * is added if missing, and hex colour strings are parsed.
   *
   * @param {string|object} message - Text string or embed object.
   */
  async sendDiscordMessage(message) {
    if (!this.channel) {
      this.verbose(1, 'Could not send Discord Message. Channel not initialized.');
      return;
    }

    if (typeof message === 'object' && 'embed' in message) {
      message.embed.footer = message.embed.footer || {
        text: 'Slackers Squad Services'
      };
      if (typeof message.embed.color === 'string') {
        message.embed.color = parseInt(message.embed.color, 16);
      }
      message = { ...message, embeds: [message.embed] };
    }

    await this.channel.send(message);
  }
}