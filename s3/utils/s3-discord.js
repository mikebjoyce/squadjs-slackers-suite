/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               S³ DISCORD                                     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Thin Discord integration layer for the !s3 admin command surface.
 * Handles Discord-specific infrastructure (channel setup, message
 * listener, verbose-log watch relay) while delegating command
 * execution to s3-commands.js.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * registerS3DiscordCommands(plugin) (function)
 *   Attaches a Discord message listener for !s3 commands and returns
 *   a cleanup function to call during unmount().
 *
 * Internal:
 *   sendDiscordMessage()  — Resilient Discord message sender (rate-limit,
 *                           v12 fallback, empty-message guard).
 *   WatchManager          — Manages verbose-log interception and relay
 *                           to Discord channels with configurable TTL.
 *   onDiscordMessage      — Message handler (parses !s3, dispatches to
 *                           commandHandlers, catches errors).
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * s3-commands.js — createCommandHandlers, buildHelpEmbed
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Integration pattern: Pattern B (manual Discord management) from
 *   elo-tracker. registerS3DiscordCommands(plugin) is called during
 *   S³ plugin mount() and returns a cleanup function.
 * - All !s3 commands are gated to the configured admin channel only.
 * - Watch relay intercepts plugin.verbose() using an interceptor
 *   pattern; automatically expires after 5 minutes by default.
 * - Command handlers, embed builders, and test runners live in
 *   s3-commands.js (extracted 8.4a) — this file is Discord
 *   infrastructure only (channel setup, message listener, watch relay).
 *
 */
import { createCommandHandlers, buildHelpEmbed } from './s3-commands.js';

/**
 * Send a Discord message with embed(s). Resilient: normalises embed→embeds,
 * handles 429 rate-limit with one automatic retry, falls back to v12 embed shape.
 * @param {object} channel - Discord.js channel object
 * @param {object} content - { embeds: [...], content?: string }
 * @param {string} [pluginTag='S3'] - Tag for verbose logging
 * @param {Function} [verboseLogger=()=>{}] - Plugin's verbose logger
 * @returns {Promise<boolean>}
 */
async function sendDiscordMessage(channel, content, pluginTag = 'S3', verboseLogger = () => {}) {
  if (!channel) {
    verboseLogger(1, `[${pluginTag} Discord] Send failed: No channel available`);
    return false;
  }

  if (!content) {
    verboseLogger(1, `[${pluginTag} Discord] Send failed: Content was empty.`);
    return false;
  }

  // Standardize: ensure embeds array
  let payload = content;
  if (typeof content === 'object' && content !== null) {
    payload = { ...content };
    if (payload.embed && !payload.embeds) {
      payload.embeds = [payload.embed];
      delete payload.embed;
    }
  }

  const executeSend = async (data, isRetry = false) => {
    try {
      await channel.send(data);
      return true;
    } catch (err) {
      if (err.status === 429 && !isRetry) {
        let waitTime = 1000;
        if (err.retryAfter) waitTime = err.retryAfter;
        else if (err.headers?.['retry-after']) {
          waitTime = parseFloat(err.headers['retry-after']) * 1000;
        }

        verboseLogger(1, `[${pluginTag} Discord] 429 Rate Limit hit. Waiting ${waitTime}ms before retry.`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        return executeSend(data, true);
      }

      if (err.message === 'Cannot send an empty message' && data.embeds?.length > 0) {
        const legacyData = { ...data, embed: data.embeds[0] };
        delete legacyData.embeds;
        return executeSend(legacyData, isRetry);
      }

      throw err;
    }
  };

  try {
    await executeSend(payload);
    return true;
  } catch (err) {
    verboseLogger(1, `[${pluginTag} Discord] Send failed: ${err.message}`);
    return false;
  }
}

// ============================================================================
// Verbose Watch Relay
// ============================================================================

/**
 * Manages !s3 watch subscriptions. Intercepts plugin.verbose() calls and relays
 * matching service logs to Discord for a configurable TTL (default 5 min).
 */
class WatchManager {
  constructor(plugin, defaultWatchDurationMs = 5 * 60 * 1000) {
    this.plugin = plugin;
    this.defaultWatchDurationMs = defaultWatchDurationMs;
    this.activeWatches = new Map(); // channelID -> { services: Set, channel, expiresAt, timer }
    this._originalVerbose = null;
  }

  /**
   * Start a watch for a specific service on a channel.
   */
  start(channel, services) {
    const channelID = channel.id;

    // Clear existing watch for this channel
    if (this.activeWatches.has(channelID)) {
      this.stop(channelID);
    }

    const expiresAt = Date.now() + this.defaultWatchDurationMs;
    const timer = setTimeout(() => {
      this.stop(channelID);
      sendDiscordMessage(channel, {
        embeds: [{
          color: 0x95a5a6,
          title: '⏰ Watch Expired',
          description: `Watch for \`${[...services].join(', ')}\` automatically stopped after ${this._formatDuration(this.defaultWatchDurationMs)}.`,
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...args) => this.plugin.verbose(...args)).catch(() => {});
    }, this.defaultWatchDurationMs);

    this.activeWatches.set(channelID, {
      services,
      channel,
      expiresAt,
      timer
    });

    // Install verbose interceptor if this is the first watch
    if (!this._originalVerbose) {
      this._installInterceptor();
    }
  }

  /**
   * Stop a watch on a specific channel.
   */
  stop(channelID) {
    const watch = this.activeWatches.get(channelID);
    if (!watch) return;

    if (watch.timer) clearTimeout(watch.timer);
    this.activeWatches.delete(channelID);

    // Uninstall interceptor if no more watches
    if (this.activeWatches.size === 0 && this._originalVerbose) {
      this._uninstallInterceptor();
    }
  }

  /**
   * Stop all active watches.
   */
  stopAll() {
    for (const [channelID] of this.activeWatches) {
      this.stop(channelID);
    }
  }

  /**
   * Get list of active watches for display.
   */
  getActiveWatches() {
    return [...this.activeWatches.entries()].map(([channelID, w]) => ({
      channelID,
      services: [...w.services],
      expiresAt: w.expiresAt
    }));
  }

  _installInterceptor() {
    this._originalVerbose = this.plugin.verbose;

    const self = this;
    this.plugin.verbose = function (level, message) {
      // Call original
      if (self._originalVerbose) {
        self._originalVerbose.call(this, level, message);
      }

      // Relay to matching watch channels
      const msg = String(message ?? '');
      for (const [, watch] of self.activeWatches) {
        for (const svc of watch.services) {
          const pattern = svc.toLowerCase();
          if (msg.toLowerCase().includes(pattern)) {
            const levelLabel = level >= 3 ? '🐛' : level >= 2 ? '📘' : '📙';
            const maxLen = 1500;
            const truncated = msg.length > maxLen ? msg.substring(0, maxLen - 3) + '...' : msg;
            sendDiscordMessage(watch.channel, {
              embeds: [{
                color: 0x2c3e50,
                title: `${levelLabel} [${svc}] Verbose L${level}`,
                description: `\`\`\`\n${truncated}\n\`\`\``,
                timestamp: new Date().toISOString()
              }]
            }, 'S3', () => {}).catch(() => {});
            break;
          }
        }
      }
    };
  }

  _uninstallInterceptor() {
    if (this._originalVerbose) {
      this.plugin.verbose = this._originalVerbose;
      this._originalVerbose = null;
    }
  }

  _formatDuration(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
  }
}

// ============================================================================
// Main Registration
// ============================================================================

/**
 * Register !s3 Discord commands on the plugin instance.
 * Attaches on('message') listener to the discordClient and returns a cleanup function.
 *
 * @param {object} plugin - The SlackersSquadServices plugin instance
 * @returns {Function} Cleanup function to call during unmount()
 */
export function registerS3DiscordCommands(plugin) {
  const discordClient = plugin.options.discordClient;

  if (!discordClient) {
    plugin.verbose(1, '[S3 Discord] No discordClient configured — Discord commands disabled.');
    return () => {};
  }

  let discordChannel = null;

  // Watch manager
  const watchManager = new WatchManager(plugin);

  // Staging variable for !s3 db import — holds parsed import JSON until --confirm
  const stagedImportRef = { current: null };

  // Create command handlers from s3-commands.js
  const { handlers } = createCommandHandlers({
    sendDiscordMessage,
    watchManager,
    stagedImportRef
  });

  async function onDiscordMessage(message) {
    if (message.author.bot) return;

    const content = message.content.trim();
    if (!content.startsWith('!s3')) return;

    // Gate to configured admin channel only
    const channelID = plugin.options.channelID;
    if (!channelID || message.channel.id !== channelID) return;

    const args = content.replace(/^!s3\s*/i, '').trim().split(/\s+/).filter(Boolean);
    const sub = args[0]?.toLowerCase();

    try {
      // Look up handler, fall back to help for bare !s3 or unknown subcommands
      const handler = sub ? handlers.get(sub) : null;
      if (handler) {
        await handler(plugin, message, args);
      } else {
        // Unknown command — show help
        const embed = buildHelpEmbed();
        await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
      }
    } catch (err) {
      plugin.verbose(1, `[S3 Discord] Command error (!s3 ${sub}): ${err.message}`);

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0xe74c3c,
          title: `⚠️ Error: !s3 ${sub}`,
          description: `**${err.message}**`,
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
    }
  }

  // Fetch channel and register listener
  plugin.options.discordClient.channels.fetch(plugin.options.channelID)
    .then((channel) => {
      discordChannel = channel;
      plugin.verbose(1, `[S3 Discord] Fetched admin channel: ${channel.name || plugin.options.channelID}`);
    })
    .catch((err) => {
      plugin.verbose(1, `[S3 Discord] Failed to fetch channel ${plugin.options.channelID}: ${err.message}`);
    });

  plugin.options.discordClient.on('message', onDiscordMessage);

  plugin.verbose(1, '[S3 Discord] Registered !s3 commands.');

  // Return cleanup function
  return () => {
    if (plugin.options.discordClient && typeof plugin.options.discordClient.removeListener === 'function') {
      plugin.options.discordClient.removeListener('message', onDiscordMessage);
    }
    watchManager.stopAll();
    plugin.verbose(1, '[S3 Discord] Unregistered !s3 commands.');
  };
}