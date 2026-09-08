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
 * sendDiscordMessage(channel, content, tag, verbose) (function)
 *   Resilient Discord message sender (rate-limit retry, empty-message
 *   guard, and one-embed-per-message delivery on a discord.js too old
 *   for an embeds array). Exported so the shipped send path can be
 *   exercised directly; inside the suite only this file calls it.
 *
 * Internal:
 *   WatchManager          — Manages verbose-log interception and relay
 *                           to Discord channels with configurable TTL.
 *   onDiscordMessage      — Message handler (parses !s3, dispatches to
 *                           commandHandlers, catches errors).
 *
 * ─── ROUTING (multi-server) ──────────────────────────────────────
 *
 * Every process running this suite watches the same admin channel,
 * so one typed command arrives at all of them. onDiscordMessage
 * runs a routing gate between the channel gate and the verb
 * dispatch: scopeForS3Command() classifies the verb, and
 * routeDiscordCommand() decides whether this process acts, stays
 * quiet, or refuses with an explanation.
 *
 * The gate sits where it does on purpose. It is after the channel
 * check so a message in the wrong channel costs nothing, and before
 * the dispatch so the handlers below never learn that selectors
 * exist — they receive verdict.args with any --server already
 * stripped. On a single-server install the gate is inert: it strips
 * a selector nobody types and returns act.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * s3-commands.js — createCommandHandlers, buildHelpEmbed,
 *                  scopeForS3Command
 * s3-discord-routing.js — routeDiscordCommand, ROUTING,
 *                  buildRoutingRefusalEmbed
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
import { createCommandHandlers, buildHelpEmbed, scopeForS3Command } from './s3-commands.js';
import { routeDiscordCommand, buildRoutingRefusalEmbed, ROUTING } from './s3-discord-routing.js';
import { applyServerLabel } from './s3-server-label.js';

/**
 * Sticky once discovered: this discord.js only understands the singular
 * `embed` key, so every multi-embed payload has to be sent one at a time.
 *
 * ─── WHY THIS IS DISCOVERED, NOT CONFIGURED ───
 *
 * SquadJS 4.1.0 pins discord.js 12.5.3; forks and manual bumps run v13 and
 * v14. The suite is installed into whichever of those the host already has,
 * so the only honest way to know is to try the modern shape and read the
 * refusal. The flag exists so the process pays that failed round trip once
 * rather than on every embed it ever sends.
 *
 * ─── WHAT THIS REPLACED, AND WHY IT MATTERED ───
 *
 * The v12 fallback used to retry as `{ embed: data.embeds[0] }` — the first
 * embed, the others dropped — and then return `true`. On a v12 host every
 * multi-embed reply silently lost all but its first embed and logged nothing.
 * `!s3 players` posted its overview and quietly discarded both team rosters,
 * which is how this was found: the same command answered from a v14 host and
 * a v12 host side by side, three embeds against one.
 */
let legacyEmbedMode = false;

/**
 * Send a Discord message with embed(s). Resilient: normalises embed→embeds,
 * handles 429 rate-limit with one automatic retry, and falls back to one
 * embed per message on a discord.js too old to accept an embeds array.
 * @param {object} channel - Discord.js channel object
 * @param {object} content - { embeds: [...], content?: string }
 * @param {string} [pluginTag='S3'] - Tag for verbose logging
 * @param {Function} [verboseLogger=()=>{}] - Plugin's verbose logger
 * @returns {Promise<boolean>}
 */
export async function sendDiscordMessage(channel, content, pluginTag = 'S3', verboseLogger = () => {}) {
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

  // Which server this came from, when there is more than one. A no-op on a
  // single-server install, because S³ publishes nothing there.
  payload = applyServerLabel(payload);

  // One message, with the 429 retry. Everything above this decides *what* to
  // send; this only decides how hard to try.
  const sendOnce = async (data, isRetry = false) => {
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
        return sendOnce(data, true);
      }

      throw err;
    }
  };

  // One embed per message, because that is all discord.js v12 will take.
  // Content and files ride on the first so a reply that pairs text with an
  // embed still reads as one thing; the rest follow in order.
  const sendOnePerMessage = async (data) => {
    const embeds = data.embeds ?? [];
    const rest = { ...data };
    delete rest.embeds;
    delete rest.embed;

    if (embeds.length === 0) return sendOnce(rest);

    let allSent = true;
    for (let i = 0; i < embeds.length; i++) {
      const part = i === 0 ? { ...rest, embed: embeds[i] } : { embed: embeds[i] };
      try {
        await sendOnce(part);
      } catch (err) {
        // Keep going. Losing embed 2 is no reason to also lose embed 3, and
        // the whole point of this path is that embeds stop disappearing.
        allSent = false;
        verboseLogger(1, `[${pluginTag} Discord] Embed ${i + 1}/${embeds.length} failed: ${err.message}`);
      }
    }
    return allSent;
  };

  try {
    if (legacyEmbedMode && Array.isArray(payload.embeds)) return await sendOnePerMessage(payload);

    try {
      return await sendOnce(payload);
    } catch (err) {
      // The v12 tell. It has no `embeds` key, so an embeds-only payload looks
      // empty to it and the API says so. Discovered rather than version-
      // sniffed, so this keeps working on whatever the host pinned.
      const looksLegacy = err.message === 'Cannot send an empty message'
        && Array.isArray(payload.embeds) && payload.embeds.length > 0;
      if (!looksLegacy) throw err;

      legacyEmbedMode = true;
      verboseLogger(1, `[${pluginTag} Discord] discord.js rejected an embeds array; switching to one embed per message for the rest of this process.`);
      return await sendOnePerMessage(payload);
    }
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
          title: this.plugin.localize('slackersSquadServices.watch.watchExpired'),
          description: this.plugin.localize('slackersSquadServices.watch.watchForServicesAutomatically', {
            services: [...services].join(', '),
            duration: this._formatDuration(this.defaultWatchDurationMs)
          }),
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
                // Not localized: the body is raw SquadJS verbose output, and a
                // translated header on an English log line reads worse than either.
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

    const rawArgs = content.replace(/^!s3\s*/i, '').trim().split(/\s+/).filter(Boolean);

    // ── Routing gate ──────────────────────────────────────────────
    // After the channel gate and before the verb dispatch, so `args[0]`
    // below never learns that selectors exist. Inert on a single-server
    // install: it strips a `--server` nobody types and returns act.
    const { scope, selectorRequired } = scopeForS3Command(rawArgs);
    const verdict = await routeDiscordCommand({
      db: plugin.services.db,
      scope,
      selectorRequired,
      args: rawArgs,
      messageID: message.id,
      command: `!s3 ${rawArgs.slice(0, 2).join(' ')}`.trim(),
      verbose: (...a) => plugin.verbose(...a)
    });

    if (verdict.routing === ROUTING.DROP) return;
    if (verdict.routing === ROUTING.REFUSE) {
      await sendDiscordMessage(message.channel, {
        embeds: [buildRoutingRefusalEmbed(verdict, (k, v) => plugin.localize(k, v))]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    const args = verdict.args;
    const sub = args[0]?.toLowerCase();

    try {
      // Look up handler, fall back to help for bare !s3 or unknown subcommands
      const handler = sub ? handlers.get(sub) : null;
      if (handler) {
        await handler(plugin, message, args);
      } else {
        // Unknown command — show help
        const embed = buildHelpEmbed(plugin);
        await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
      }
    } catch (err) {
      plugin.verbose(1, `[S3 Discord] Command error (!s3 ${sub}): ${err.message}`);

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0xe74c3c,
          title: plugin.localize('slackersSquadServices.onDiscordMessage.errorS3Sub', { sub }),
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