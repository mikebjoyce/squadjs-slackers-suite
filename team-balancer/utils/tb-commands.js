/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                PLAYER COMMAND & RESPONSE LOGIC                ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Registers in-game and Discord command handlers onto the TeamBalancer
 * plugin instance. Handles !teambalancer and !scramble commands with
 * permission enforcement, argument parsing, and response formatting.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * CommandHandlers (default)
 *   Object with a single register(tb) method. Mutates the TeamBalancer
 *   instance by attaching methods directly onto it:
 *     respond(player, msg)              — rcon.warn wrapper with logging.
 *     formatMessage(template, values)   — Simple {key} string interpolation.
 *     onTeamBalancerCommand(info)       — Handles !teambalancer chat commands.
 *     onScrambleCommand(info)           — Handles !scramble chat commands.
 *     onDiscordMessage(message)         — Handles Discord !teambalancer and !scramble commands.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Logger (../../core/logger.js)
 *   Verbose logging for command responses and permission failures.
 * DiscordHelpers (./tb-discord-helpers.js)
 *   Status and diagnostic embed builders for Discord responses.
 * TBDiagnostics (./tb-diagnostics.js)
 *   Diagnostic runner invoked by !teambalancer diag.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Admin permission is checked via server.getAdminPermBySteamID() or
 *   the discordAdminRoleIDs role check. devMode bypasses both.
 * - !scramble confirm has a scrambleConfirmationTimeout window. Pending
 *   state is stored on tb.scrambleConfirmation.
 * - Discord commands mirror the in-game admin command set. Public
 *   commands are available to all users in the configured admin channel.
 * - formatMessage replaces {key} placeholders — not a full template
 *   engine. Values not found in the params object are left as-is.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Logger from '../../core/logger.js';
import { DiscordHelpers } from './tb-discord-helpers.js';
import { TBDiagnostics } from './tb-diagnostics.js';

/**
 * Round-end broadcasts and scramble announcements — the most-read text in the
 * suite, seen by every player after every round.
 *
 * Every leaf is a live getter rather than a fixed string. register() runs from
 * the TeamBalancer constructor, which is BEFORE prepareToMount() discovers S³,
 * so tb.lang is still the default there: a plain object built here would pin
 * these broadcasts to English for the life of the process. SwapExecutor is
 * handed this same object in that constructor and keeps the reference, so the
 * object identity has to stay stable while the values resolve at read time.
 *
 * No vars are passed to localize(), so {team}/{margin}/... come back intact and
 * tb.formatMessage() substitutes them at the call site exactly as before.
 */
const RCON_MESSAGE_PATHS = [
  'draw',
  'nonDominant.streakBroken',
  'nonDominant.invasionAttackWin',
  'nonDominant.invasionDefendWin',
  'nonDominant.narrowVictory',
  'nonDominant.marginalVictory',
  'nonDominant.tacticalAdvantage',
  'nonDominant.operationalSuperiority',
  'dominant.steamrolled',
  'dominant.stomped',
  'dominant.dominantVictory',
  'dominant.invasionAttackStomp',
  'dominant.invasionDefendStomp',
  'scrambleAnnouncement',
  'consecutiveWinsScramble',
  'singleRoundScramble',
  'manualScrambleAnnouncement',
  'immediateManualScramble',
  'manualMicroScrambleAnnouncement',
  'immediateManualMicroScramble',
  'executeScrambleMessage',
  'executeDryRunMessage',
  'scrambleCompleteMessage',
  'scrambleFailedMessage',
  'playerScrambledWarning',
  'seedScrambleAnnouncement',
  'microScrambleAnnouncement',
  'microScrambleCompleteMessage',
  'microScrambleFailedMessage',
  'system.trackingEnabled',
  'system.trackingDisabled'
];

function buildRconMessages(tb) {
  // Not localized: a log/broadcast tag, not prose.
  const root = { prefix: '[TeamBalancer]' };

  for (const p of RCON_MESSAGE_PATHS) {
    const segs = p.split('.');
    let cur = root;
    for (const s of segs.slice(0, -1)) cur = (cur[s] ??= {});
    Object.defineProperty(cur, segs.at(-1), {
      enumerable: true,
      configurable: true,
      get: () => tb.localize(`teamBalancer.rconMessages.${p}`)
    });
  }

  return root;
}

const CommandHandlers = {
  register(tb) {
    tb.respond = async function (player, msg) {
      const playerName = player?.name || 'Unknown Player';
      const warnIdentifier = player?.name || player?.steamID;
      let logMessage = `[TeamBalancer][Response to ${playerName}`;
      logMessage += ` (${warnIdentifier || 'Unknown'})]\n${msg}`;
      Logger.verbose('TeamBalancer', 2, logMessage);

      if (warnIdentifier) {
        try {
          await this.server.rcon.warn(warnIdentifier, msg);
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, `Failed to send RCON warn to ${warnIdentifier}: ${err.message}`);
        }
      }
      return msg;
    };

    tb.formatMessage = (template, values) => {
      if (typeof template !== 'string') {
        Logger.verbose('TeamBalancer', 1, `[Error] formatMessage received invalid template: ${typeof template}`);
        return '';
      }
      for (const key in values) {
        template = template.split(`{${key}}`).join(values[key]);
      }
      return template;
    };

    tb.RconMessages = buildRconMessages(tb);

    tb.onChatMessage = async function (info) {
      const message = info.message?.trim();
      // Only respond to the exact '!teambalancer' command without arguments
      if (!message || message.toLowerCase() !== '!teambalancer') return;

      const steamID = info.steamID;
      const playerName = info.player?.name || 'Unknown';
      Logger.verbose('TeamBalancer', 4, `General teambalancer info requested by ${playerName} (${steamID})`);

      const now = Date.now();
      const timeDifference = now - this.lastScrambleTime;
      let lastScrambleText;

      if (!this.lastScrambleTime) {
        lastScrambleText = 'Never';
      } else {
        const minutes = Math.floor(timeDifference / 60000);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
          lastScrambleText = tb.localize(hours === 1 ? 'teamBalancer.status.hourAgo' : 'teamBalancer.status.hoursAgo', { hours });
        } else {
          lastScrambleText = tb.localize(minutes === 1 ? 'teamBalancer.status.minuteAgo' : 'teamBalancer.status.minutesAgo', { minutes });
        }
      }
      const statusText = !this.ready
        ? 'Initializing...'
        : this.manuallyDisabled
        ? tb.localize('teamBalancer.status.manuallyDisabled')
        : this.options.enableWinStreakTracking
        ? 'Active'
        : tb.localize('teamBalancer.status.disabledConfig');

      const winStreakText =
        this.winStreakCount > 0
          ? tb.localize('teamBalancer.status.hasDominantWinS', { teamName: this.getTeamName(this.winStreakTeam), winStreakCount: this.winStreakCount })
          : tb.localize('teamBalancer.status.noCurrentWinStreak');

      const eloTrackerPlugin = this.server.plugins?.find(p => p.constructor.name === 'EloTracker');
      const eloStatus = this.options?.useEloForBalance ? (eloTrackerPlugin ? 'Active' : 'Unavailable') : 'Disabled';

      // Formatted response for !teambalancer
      const infoMsg = [
        `=== TeamBalancer ===`,
        `Version: ${this.constructor.version}`,
        `Status: ${statusText}`,
        tb.localize('teamBalancer.status.eloIntegration', { eloStatus }),
        tb.localize('teamBalancer.status.dominanceStreak', { winStreakText }),
        tb.localize('teamBalancer.status.lastScramble', { lastScrambleText }),
        tb.localize('teamBalancer.status.maxStreakThresholdDominant', { maxWinStreak: this.options.maxWinStreak })
      ].join('\n');

      Logger.verbose('TeamBalancer', 4, `[TeamBalancer] !teambalancer response sent to ${playerName} (${steamID}):\n${infoMsg}`);

      try {
        // Use player name (always present for connected players) for the RCON warn
        await this.server.rcon.warn(playerName, infoMsg);
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, `Failed to send info message to ${playerName}: ${err.message || err}`);
      }
      return await this.respond(info.player || { steamID: info.steamID, name: playerName }, infoMsg);
    };

    tb.onChatCommand = async function (command) {
      Logger.verbose('TeamBalancer', 4, `Chat command received: !teambalancer ${command.message}`);

      // This line ensures commands are only processed from admin chat when devMode is false
      // The public-facing '!teambalancer' (no args) is handled by onChatMessage.
      if (!this.options.devMode && command.chat !== 'ChatAdmin') return;

      const message = command.message; // This is the part AFTER !teambalancer
      const steamID = command.steamID;
      const player = command.player; // Get the player object
      const adminName = player?.name || steamID; // Prioritize player name

      // If no subcommand is provided (i.e., just "!teambalancer"),
      // let onChatMessage handle the public status display.
      // This prevents an "Invalid command" response for the public status check.
      if (!message.trim()) {
        Logger.verbose('TeamBalancer', 4, 'No subcommand provided for !teambalancer (admin chat), letting onChatMessage handle public status.');
        return;
      }

      if (!this.ready) {
        const msg = message.trim().toLowerCase();
        // Allow 'status' to pass through so admins can see the "INITIALIZING" state
        if (!msg.startsWith('status')) {
          return await this.respond(command.player || { steamID: command.steamID }, tb.localize('teamBalancer.warn.teambalancerStillInitializingPlease'));
        }
      }

      const args = message.trim().split(/\s+/);
      const subcommand = args[0]?.toLowerCase();

      try {
        switch (subcommand) {
          case 'on': {
            if (!this.manuallyDisabled) {
              return await this.respond(player, tb.localize('teamBalancer.warn.winStreakTrackingAlready'));
            }
            this.manuallyDisabled = false;
            try {
              await this.db.saveManuallyDisabledState(false);
            } catch (err) {
              Logger.verbose('TeamBalancer', 1, `[DB] Failed to persist enabled state: ${err.message}`);
            }
            Logger.verbose('TeamBalancer', 2, `[TeamBalancer] Win streak tracking enabled by ${adminName}`);
            const response = await this.respond(player, this.enableConfirmationText());
            try {
              await this.server.rcon.broadcast(
                `${this.RconMessages.prefix} ${this.RconMessages.system.trackingEnabled}`
              );
            } catch (err) {
              Logger.verbose('TeamBalancer', 1, `Failed to broadcast tracking enabled message: ${err.message}`);
            }
            if (this.discordChannel) {
              const embed = {
                color: 0x3498db,
                title: tb.localize('teamBalancer.status.gameCommandTeambalancer'),
                description: tb.localize('teamBalancer.status.executedBy', { adminName }),
                fields: [{ name: tb.localize('teamBalancer.status.response'), value: this.enableConfirmationText(), inline: false }],
                timestamp: new Date().toISOString()
              };
              await DiscordHelpers.sendDiscordMessage(this.discordChannel, { embeds: [embed] });
            }
            return response;
          }
          case 'off': {
            if (this.manuallyDisabled) {
              return await this.respond(player, tb.localize('teamBalancer.warn.winStreakTrackingAlready2'));
            }
            this.manuallyDisabled = true;
            try {
              await this.db.saveManuallyDisabledState(true);
            } catch (err) {
              Logger.verbose('TeamBalancer', 1, `[DB] Failed to persist disabled state: ${err.message}`);
            }
            Logger.verbose('TeamBalancer', 2, `[TeamBalancer] Win streak tracking disabled by ${adminName}`);
            const response = await this.respond(player, tb.localize('teamBalancer.warn.winStreakTrackingDisabled', { seedScrambleOffNote: this.seedScrambleOffNote() }));
            try {
              await this.server.rcon.broadcast(
                `${this.RconMessages.prefix} ${this.RconMessages.system.trackingDisabled}`
              );
            } catch (err) {
              Logger.verbose('TeamBalancer', 1, `Failed to broadcast tracking disabled message: ${err.message}`);
            }
            if (this.discordChannel) {
              try {
                const embed = {
                  color: 0x3498db,
                  title: tb.localize('teamBalancer.status.gameCommandTeambalancerOff'),
                  description: tb.localize('teamBalancer.status.executedBy', { adminName }),
                fields: [{ name: tb.localize('teamBalancer.status.response'), value: tb.localize('teamBalancer.status.winStreakTrackingDisabled', { seedScrambleOffNote: this.seedScrambleOffNote() }), inline: false }],
                  timestamp: new Date().toISOString()
                };
                await DiscordHelpers.sendDiscordMessage(this.discordChannel, { embeds: [embed] });
              } catch (discordErr) {
                Logger.verbose('TeamBalancer', 1, `Discord embed failed: ${discordErr.message}`);
              }
            }
            await this.resetStreak('Manual disable');
            return response;
          }
          case 'status': {
            // Determine the effective plugin status
            const effectiveStatus = !this.ready
              ? 'INITIALIZING'
              : this.manuallyDisabled
              ? tb.localize('teamBalancer.status.disabledManual')
              : this.options.enableWinStreakTracking
              ? 'ENABLED'
              : tb.localize('teamBalancer.status.disabledConfig2');

            // Win Streak with Threshold
            const maxStreak = this.options?.maxWinStreak || 2;
            const winStreakText = this.winStreakTeam
              ? `${this.getTeamName(this.winStreakTeam)}: ${this.winStreakCount} / ${maxStreak} wins`
              : tb.localize('teamBalancer.status.noneThresholdWins', { maxStreak });

            const maxConsec = this.options.maxConsecutiveWinsWithoutThreshold;
            const consecText = maxConsec > 0
              ? (this.consecutiveWinsTeam
                  ? `${this.getTeamName(this.consecutiveWinsTeam)}: ${this.consecutiveWinsCount} / ${maxConsec} wins`
                  : tb.localize('teamBalancer.status.noneThresholdWins2', { maxConsec }))
              : 'Disabled';

            // Format the last scramble timestamp (Relative for in-game)
            let lastScrambleText = 'Never';
            if (this.lastScrambleTime) {
              const diff = Date.now() - this.lastScrambleTime;
              const mins = Math.floor(diff / 60000);
              const hours = Math.floor(mins / 60);
              if (hours > 0) {
                lastScrambleText = tb.localize('teamBalancer.status.hMAgo', { hours, value: mins % 60 });
              } else {
                lastScrambleText = tb.localize('teamBalancer.status.mAgo', { mins });
              }
            }

            // Player Counts
            const players = this.server.players;
            const t1Count = players.filter((p) => p.teamID === 1).length;
            const t2Count = players.filter((p) => p.teamID === 2).length;

            // Layer — from S³, never server.currentLayer (null after a
            // mid-round SquadJS restart, which made this read "Unknown").
            const currentLayer = this._s3?.gameState?.getLayerName?.() || this.layerNameCached || 'Unknown';

            const eloTrackerPlugin = this.server.plugins?.find(p => p.constructor.name === 'EloTracker');
            const eloStatus = this.options?.useEloForBalance ? (eloTrackerPlugin ? 'Active' : 'Unavailable') : 'Disabled';

            // Formatted response for !teambalancer status
            const statusMsg = [
              tb.localize('teamBalancer.status.teambalancerStatus'),
              `Version: ${this.constructor.version}`,
              tb.localize('teamBalancer.status.pluginStatus', { effectiveStatus }),
              tb.localize('teamBalancer.status.eloIntegration', { eloStatus }),
              tb.localize('teamBalancer.status.winStreak', { winStreakText }),
              tb.localize('teamBalancer.status.consecutiveWins', { consecText }),
              tb.localize('teamBalancer.status.seedAutoScramble', { seedAutoScrambleStatus: this.seedAutoScrambleStatus() }),
              tb.localize('teamBalancer.status.lastScramble', { lastScrambleText }),
              tb.localize('teamBalancer.status.playersT1T2', { value: players.length, t1Count, t2Count }),
              `Layer: ${currentLayer}`,
              `---------------------------`
            ].join('\n');

            const response = await this.respond(player, statusMsg);
            if (this.discordChannel) {
              const embed = DiscordHelpers.buildStatusEmbed(this);
              embed.description = tb.localize('teamBalancer.status.executedBy', { adminName });
              await DiscordHelpers.sendDiscordMessage(this.discordChannel, { embeds: [embed] });
            }
            return response;
          }
          case 'diag': {
            Logger.verbose('TeamBalancer', 4, 'Diagnostics command received.');
            await this.server.rcon.warn(player?.name || steamID, tb.localize('teamBalancer.warn.runningDiagnosticsPleaseWait'));

            const diagnostics = new TBDiagnostics(this);
            const results = await diagnostics.runAll();

            // By id, not by name: the name is display text and moves with the
            // configured language, so matching on it worked in English only.
            const s3Result = results.find((r) => r.id === 's3Integration');
            const scrambleResult = results.find((r) => r.id === 'scrambler');

            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

            // Page 1/3: Diagnostic results
            await this.respond(player, [
              tb.localize('teamBalancer.status.tbDiag'),
              `S³: ${s3Result.pass ? 'PASS' : 'FAIL'}`,
              tb.localize('teamBalancer.status.diagScramble', { message: scrambleResult.message }),
              tb.localize('teamBalancer.status.diagState', { value: this.manuallyDisabled ? 'DISABLED' : 'ENABLED' })
            ].join('\n'));
            await sleep(5500);

            // Page 2/3: Runtime state + threshold highlights
            const players = this.server.players;
            const squads = this.server.squads;
            const t1Players = players.filter((p) => p.teamID === 1);
            const t2Players = players.filter((p) => p.teamID === 2);
            const t1Squads = squads.filter((s) => s.teamID === 1);
            const t2Squads = squads.filter((s) => s.teamID === 2);
            // Layer/gamemode from S³ (single resolver); the local caches are
            // only a mirror of it, kept as a fallback if S³ is unavailable.
            const gs = this._s3?.gameState;
            const layerName = gs?.getLayerName?.() || this.layerNameCached || 'Unknown';
            const gameMode = gs?.getGamemode?.() || this.gameModeCached || 'N/A';
            const team1Name = this.getTeamName(1);
            const team2Name = this.getTeamName(2);

            await this.respond(player, [
              tb.localize('teamBalancer.status.scramblePending', { value: this._scramblePending ? 'Yes' : 'No' }),
              tb.localize('teamBalancer.status.scrambleActive', { value: this._scrambleInProgress ? 'Yes' : 'No' }),
              tb.localize('teamBalancer.status.plyrsT1T2', { value: players.length, value2: t1Players.length, value3: t2Players.length }),
              tb.localize('teamBalancer.status.squadsT1T2', { value: squads.length, value2: t1Squads.length, value3: t2Squads.length }),
              tb.localize('teamBalancer.status.diagLayer', { layerName, gameMode })
            ].join('\n'));
            await sleep(5500);

            // Page 3/3: Key config
            await this.respond(player, [
              tb.localize('teamBalancer.status.thresholdsWinsTix', { maxWinStreak: this.options.maxWinStreak, value: this.options?.minTicketsToCountAsDominantWin || 150 }),
              tb.localize('teamBalancer.status.scrambleSSeedS', { value: (this.options?.scramblePercentage || 0.5) * 100, scrambleAnnouncementDelay: this.options?.scrambleAnnouncementDelay, seedScrambleAnnouncementDelay: this.options?.seedScrambleAnnouncementDelay, maxScrambleCompletionTime: this.options?.maxScrambleCompletionTime }),
              tb.localize('teamBalancer.status.diagTeams', { team1Name, team2Name }),
              tb.localize('teamBalancer.status.diagSingleRound', {
                value: this.options?.enableSingleRoundScramble
                  ? `ON (> ${this.options?.singleRoundScrambleThreshold} tix)`
                  : 'OFF'
              }),
              tb.localize('teamBalancer.status.invasionAtkDef', { invasionAttackTeamThreshold: this.options?.invasionAttackTeamThreshold, invasionDefenceTeamThreshold: this.options?.invasionDefenceTeamThreshold }),
              // Kept on its own short line: 'std' rather than the resolved
              // number so an admin can see at a glance that TC is untuned.
              tb.localize('teamBalancer.status.tcDomMercy', { value: this.options?.tcDominantThreshold ?? 'std', value2: this.options?.tcSingleRoundScrambleThreshold ?? 'std' })
            ].join('\n'));

            const targetReportChannel = this.discordReportChannel || this.discordChannel;
            if (targetReportChannel) {
              const embeds = DiscordHelpers.buildDiagEmbeds(this, results);
              embeds[0].description = tb.localize('teamBalancer.status.executedByGame', { adminName, description: embeds[0].description });
              await DiscordHelpers.sendDiscordMessage(targetReportChannel, { embeds });
            }
            return;
          }
          default: {
            return await this.respond(
              player,
              tb.localize('teamBalancer.warn.invalidCommandUsageTeambalancer')
            );
          }
        }
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, `[TeamBalancer] Error processing chat command: ${err?.message || err}`);
        return await this.respond(player, tb.localize('teamBalancer.warn.errorProcessingCommand', { message: err.message }));
      }
    };

    tb.onScrambleCommand = async function (command) {
      Logger.verbose('TeamBalancer', 4, `Scramble command received: !scramble ${command.message}`);
      // This line ensures commands are only processed from admin chat when devMode is false
      if (!this.options.devMode && command.chat !== 'ChatAdmin') return;

      if (!this.ready) {
        return await this.respond(command.player || { steamID: command.steamID }, tb.localize('teamBalancer.warn.teambalancerStillInitializingPlease'));
      }

      let args = (command.message?.trim().toLowerCase().split(/\s+/) || []).filter(arg => arg);

      // ─── Unknown arg guard ──────────────────────────────────────────────
      // Reject any argument that isn't in the whitelist BEFORE touching
      // scrambleConfirmation state. A typo (e.g. "!scramble confiirm") would
      // otherwise fall through to the bare-scramble path, overwriting a
      // pending confirmation and triggering a live broadcast.
      const VALID_SCRAMBLE_ARGS = ['now', 'dry', 'matchend', 'cancel', 'confirm', 'elo'];
      const badArg = args.find(a => !VALID_SCRAMBLE_ARGS.includes(a));
      if (badArg) {
        return await this.respond(
          command.player,
          tb.localize('teamBalancer.warn.unknownArgumentUsageScramble', { badArg })
        );
      }

      const steamID = command.steamID;
      const player = command.player;
      const adminName = player?.name || steamID;

      const isConfirm = args.includes('confirm');

      if (isConfirm) {
        if (!this.scrambleConfirmation) {
          return await this.respond(player, tb.localize('teamBalancer.warn.noPendingScrambleConfirmation'));
        }
        const timeoutMs = (this.options.scrambleConfirmationTimeout || 60) * 1000;
        if (Date.now() - this.scrambleConfirmation.timestamp > timeoutMs) {
          this.scrambleConfirmation = null;
          return await this.respond(player, tb.localize('teamBalancer.warn.scrambleConfirmationExpired'));
        }
        args = this.scrambleConfirmation.args;
        this.scrambleConfirmation = null;
      }

      const hasNow = args.includes('now');
      const hasDry = args.includes('dry');
      const isCancel = args.includes('cancel');
      const isMatchEnd = args.includes('matchend');
      const hasElo = args.includes('elo');
      const scrambleType = hasElo ? 'EloDiff' : null;

      try {
        // Handle "!scramble matchend" — arm a deferred scramble for the end of this round.
        if (isMatchEnd) {
          if (hasNow || hasDry) {
            return await this.respond(player, tb.localize('teamBalancer.warn.scrambleMatchendCannotCombined'));
          }
          if (this._scrambleOnRoundEnd) {
            return await this.respond(player, tb.localize('teamBalancer.warn.matchEndScrambleAlready'));
          }
          await this._setScrambleArm({ name: adminName, eosID: player?.eosID ?? null, scrambleType });
          Logger.verbose('TeamBalancer', 2, `[TeamBalancer] Match-end ${hasElo ? 'micro ' : ''}scramble armed by ${adminName}`);
          const armResponseMsg = hasElo
            ? tb.localize('teamBalancer.status.microScrambleScheduledEnd')
            : tb.localize('teamBalancer.status.scrambleScheduledEndRound');
          const response = await this.respond(player, armResponseMsg);
          if (this.discordChannel) {
            const embed = {
              color: 0x3498db,
              title: tb.localize('teamBalancer.status.gameCommandScrambleMatchend', { value: hasElo ? ' elo' : '' }),
              description: tb.localize('teamBalancer.status.executedBy', { adminName }),
              fields: [{ name: tb.localize('teamBalancer.status.response'), value: armResponseMsg, inline: false }],
              timestamp: new Date().toISOString()
            };
            await DiscordHelpers.sendDiscordMessage(this.discordChannel, { embeds: [embed] });
          }
          return response;
        }

        // Handle cancel subcommand
        if (isCancel) {
          this.scrambleConfirmation = null;
          const cancelled = await this.cancelPendingScramble(steamID, player, false);
          if (cancelled) {
            Logger.verbose('TeamBalancer', 2, `[TeamBalancer] Scramble cancelled by ${adminName}`);
            const response = await this.respond(player, tb.localize('teamBalancer.warn.pendingScrambleCancelled'));
            if (this.discordChannel) {
              const embed = {
                color: 0x3498db,
                title: tb.localize('teamBalancer.status.gameCommandScrambleCancel'),
                description: tb.localize('teamBalancer.status.executedBy', { adminName }),
                fields: [{ name: tb.localize('teamBalancer.status.response'), value: tb.localize('teamBalancer.status.pendingScrambleCancelled'), inline: false }],
                timestamp: new Date().toISOString()
              };
              await DiscordHelpers.sendDiscordMessage(this.discordChannel, { embeds: [embed] });
            }
            return response;
          } else if (this._scrambleInProgress) {
            return await this.respond(player, tb.localize('teamBalancer.warn.cannotCancelScrambleAlready'));
          } else {
            return await this.respond(player, tb.localize('teamBalancer.warn.noPendingScrambleCancel'));
          }
        }

        // Prevent duplicate scrambles
        if (this._scramblePending || this._scrambleInProgress) {
          const status = this._scrambleInProgress ? 'executing' : 'pending';
          return await this.respond(
            player,
            tb.localize('teamBalancer.warn.warningScrambleAlreadyUse', { status })
          );
        }

        // Require confirmation for live scrambles
        if (this.options.requireScrambleConfirmation && !hasDry && !isConfirm) {
          this.scrambleConfirmation = { timestamp: Date.now(), args: args };
          const scrambleKind = hasElo ? 'micro' : 'full';
          const timing = hasNow
            ? tb.localize('teamBalancer.status.immediatelyWithNoCountdown')
            : tb.localize('teamBalancer.status.sAfterCountdownBroadcast', { scrambleAnnouncementDelay: this.options.scrambleAnnouncementDelay });
          const timeoutSec = this.options.scrambleConfirmationTimeout || 60;
          return await this.respond(
            player,
            tb.localize('teamBalancer.warn.confirmingWillExecuteScramble', { scrambleKind, timing, timeoutSec })
          );
        }

        // Dry runs are ALWAYS immediate (no countdown for simulations)
        const immediate = hasDry || hasNow;
        const isSimulated = hasDry;

        // Broadcast only for LIVE scrambles (dry runs are silent to players)
        if (!isSimulated) {
          const immediateMsgKey = hasElo ? 'immediateManualMicroScramble' : 'immediateManualScramble';
          const announcementMsgKey = hasElo ? 'manualMicroScrambleAnnouncement' : 'manualScrambleAnnouncement';
          const broadcastMsg = immediate
            ? `${this.RconMessages.prefix} ${this.RconMessages[immediateMsgKey]}`
            : `${this.RconMessages.prefix} ${this.formatMessage(
                this.RconMessages[announcementMsgKey],
                { delay: this.options.scrambleAnnouncementDelay }
              )}`;

          try {
            await this.server.rcon.broadcast(broadcastMsg);
          } catch (err) {
            Logger.verbose('TeamBalancer', 1, `[TeamBalancer] Error broadcasting scramble message: ${err?.message || err}`);
          }
        }

        // Log action
        const actionDesc = isSimulated
          ? tb.localize('teamBalancer.status.dryRunScramble', { value: hasElo ? 'micro ' : '', value2: immediate ? ' (immediate)' : '' })
          : tb.localize('teamBalancer.status.liveScramble', { value: hasElo ? 'micro ' : '', value2: immediate ? ' (immediate)' : '' });
        Logger.verbose('TeamBalancer', 2, `[TeamBalancer] ${adminName} initiated ${actionDesc}`);

        // Respond to admin
        let responseMsg;
        if (isSimulated) {
          responseMsg = tb.localize('teamBalancer.status.initiatingDryRunScramble', { value: hasElo ? 'micro ' : '' });
        } else {
          responseMsg = immediate
            ? tb.localize('teamBalancer.status.initiatingImmediateScramble', { value: hasElo ? 'micro ' : '' })
            : tb.localize('teamBalancer.status.initiatingScrambleWithCountdown', { value: hasElo ? 'micro ' : '' });
        }
        if (this.discordChannel) {
          const embed = {
            color: 0x3498db,
            title: tb.localize('teamBalancer.status.gameCommandScramble', { value: immediate ? 'now' : '', value2: isSimulated ? 'dry' : '', value3: hasElo ? 'elo' : '' }),
            description: tb.localize('teamBalancer.status.executedBy', { adminName }),
            fields: [{ name: tb.localize('teamBalancer.status.response'), value: responseMsg, inline: false }],
            timestamp: new Date().toISOString()
          };
          await DiscordHelpers.sendDiscordMessage(this.discordChannel, { embeds: [embed] });
        }
        await this.respond(player, responseMsg);

        // Execute
        const success = await this.initiateScramble(
          isSimulated,  // dry flag determines simulation
          immediate,    // dry runs force immediate execution
          steamID,
          player,
          null,
          scrambleType
        );

        if (!success) {
          return await this.respond(player, tb.localize('teamBalancer.warn.failedInitiateScrambleAnother'));
        }
        
        return responseMsg;
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, `[TeamBalancer] Error processing scramble command: ${err?.message || err}`);
        return await this.respond(player, tb.localize('teamBalancer.warn.errorProcessingCommand', { message: err.message }));
      }
    };
  }
};
export default CommandHandlers;