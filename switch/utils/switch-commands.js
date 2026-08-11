/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              SWITCH PLUGIN — COMMAND HANDLING                 ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * All string parsing and dispatch for player/admin commands for the
 * Switch plugin: in-game !switch / !change / double-switch commands,
 * Discord !switch admin commands, and the Discord stats scraper.
 * No business logic — delegates to plugin methods. Extracted from
 * switch.js during the refactor to keep the main plugin focused on
 * orchestration.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SwitchCommands (default)
 *   Singleton with a single register(plugin) method.
 *   Attaches onChatMessage, onDiscordMessage, safeDiscordReply,
 *   and _handleStatsCommand to the plugin instance.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * timers/promises (setTimeout as delay) — for delayed warnings in
 *   the "explain" subcommand and stats scrape throttling.
 * All other dependencies are accessed via plugin.* (the live plugin
 * instance passed to register()).
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - onChatMessage handles the massive switch(subCommand) dispatch
 *   for all in-game commands (public + admin).
 * - onDiscordMessage handles Discord !switch admin commands.
 * - _handleStatsCommand scrapes historical round summary embeds.
 * - safeDiscordReply is a guarded wrapper around message.reply().
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { setTimeout as delay } from "timers/promises";

const SwitchCommands = {
  /**
   * Attaches onChatMessage, onDiscordMessage, safeDiscordReply,
   * and _handleStatsCommand to the plugin instance.
   *
   * @param {object} plugin — the live Switch plugin instance
   */
  register(plugin) {
    // ── Discord reply helper ───────────────────────────────────

    plugin.safeDiscordReply = async function (message, content) {
      if (!message || !content) return;
      try {
        await message.reply(content);
      } catch (err) {
        plugin.verbose(1, `Discord reply failed: ${err.message}`);
      }
    };

    // ── In-game chat command handler ───────────────────────────

    plugin.onChatMessage = async function (info) {
      try {
        const eosID = info.player?.eosID;
        const steamID = info.player?.steamID;
        const playerName = info.player?.name;
        // Use S³ authoritative registry for teamID (includes null-teamID projection during STAGING)
        // Falls back to raw CHAT_MESSAGE event data if S³ isn't ready.
        const s3Player = plugin._s3?.players?.isReady() ? plugin._s3.players.getPlayer(eosID) : null;
        const teamID = s3Player?.teamID ?? info.player?.teamID;
        const message = info.message.toLowerCase();

        if (!eosID && !steamID) {
          plugin.verbose(1, `[Switch] Aborting onChatMessage: player ${playerName} has no eosID or steamID`);
          return;
        }

        if (plugin.options.doubleSwitchCommands.find(c => c.toLowerCase() == message))
          plugin.doubleSwitchPlayer(eosID);

        const commandPrefixInUse = typeof plugin.options.commandPrefix === 'string' ? plugin.options.commandPrefix : plugin.options.commandPrefix.find(c => message.startsWith(c.toLowerCase()));

        if ((typeof plugin.options.commandPrefix === 'string' && !message.startsWith(plugin.options.commandPrefix)) || (typeof plugin.options.commandPrefix === 'object' && plugin.options.commandPrefix.length >= 1 && !plugin.options.commandPrefix.find(c => message.startsWith(c.toLowerCase())))) return;

        const connectionSeconds = await plugin.getSecondsFromJoin(eosID);
        const connectionLog = connectionSeconds > 0 ? `${connectionSeconds.toFixed(1)}s` : "0s (New Join/Plugin Reload)";
        plugin.verbose(2, `${playerName}:\n > Connection: ${connectionLog}\n > Match Start: ${plugin.getSecondsFromMatchStart().toFixed(1)}s`);
        plugin.verbose(2, `[Command] Player ${playerName} sent: ${info.message}`);

        const commandSplit = message.substring(commandPrefixInUse.length).trim().split(' ').filter(Boolean);
        const subCommand = commandSplit[0];

        const isAdmin = info.chat === "ChatAdmin" || (plugin.server.admins && Object.prototype.hasOwnProperty.call(plugin.server.admins, steamID));
        if (subCommand && subCommand != '') {
          let pl;
          switch (subCommand) {
            case 'now':
              if (!isAdmin) {
                plugin.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                return;
              }
              plugin.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
              pl = plugin.getPlayerByUsernameOrSteamID(steamID, commandSplit.splice(1).join(' '))
              if (pl) {
                plugin._taggedSwitchPlayer(pl.eosID, 'Admin-Force').catch(err => {
                  plugin.verbose(1, `Admin switch now failed: ${err.message}`);
                });
              }
              break;
            case 'swap':
              if (!isAdmin) {
                plugin.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                return;
              }
              plugin.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
              {
                const swapArgs = commandSplit.splice(1).join(' ').split(' ');
                const name1 = swapArgs[0];
                const name2 = swapArgs[1];
                const p1 = plugin.getPlayerByUsernameOrSteamID(steamID, name1);
                const p2 = plugin.getPlayerByUsernameOrSteamID(steamID, name2);
                if (p1 && p2) {
                  await plugin._taggedSwitchPlayer(p1.eosID, 'Admin-Force');
                  await plugin._taggedSwitchPlayer(p2.eosID, 'Admin-Force');
                  plugin.warn(steamID, `Swapped ${p1.name} and ${p2.name}.`);
                } else {
                  plugin.warn(steamID, 'One or both players not found.');
                }
              }
              break;
            case 'double':
              if (!isAdmin) {
                plugin.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                return;
              }
              plugin.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
              pl = plugin.getPlayerByUsernameOrSteamID(steamID, commandSplit.splice(1).join(' '))
              if (pl) {
                await plugin.doubleSwitchPlayer(pl.eosID, true);
              }
              break;
            case 'squad':
              if (!isAdmin) {
                plugin.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                return;
              }
              plugin.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
              await plugin.server.updateSquadList();
              await plugin.server.updatePlayerList();
              await plugin.switchSquad(+commandSplit[1], commandSplit[2]);
              break;
            case 'refresh':
              await plugin.server.updateSquadList();
              await plugin.server.updatePlayerList();
              plugin.warn(eosID, `Players and squads refreshed.`);
              break;
            case 'slots':
              await plugin.server.updateSquadList();
              await plugin.server.updatePlayerList();
              plugin.warn(eosID, `Switch Slots:\nTeam 1: ${plugin.getSwitchSlotsPerTeam(1)}\nTeam 2: ${plugin.getSwitchSlotsPerTeam(2)}`);
              break;
            case "matchend":
              if (!isAdmin) {
                plugin.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                return;
              }
              plugin.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
              await plugin.server.updatePlayerList();
              pl = plugin.getPlayerByUsernameOrSteamID(steamID, commandSplit.splice(1).join(' '));
              plugin.warn(eosID, `Player "${pl.name}" queued for switch at match end.`);
              plugin.addPlayerToMatchendSwitches(pl);
              break;
            case "doublesquad":
              if (!isAdmin) {
                plugin.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                return;
              }
              plugin.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
              await plugin.server.updateSquadList();
              await plugin.server.updatePlayerList();
              await plugin.doubleSwitchSquad(+commandSplit[1], commandSplit[2]);
              break;
            case "matchendsquad":
              if (!isAdmin) {
                plugin.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                return;
              }
              plugin.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
              await plugin.server.updateSquadList();
              await plugin.server.updatePlayerList();
              plugin.warn(eosID, `Squad ${commandSplit[1]} (${commandSplit[2]}) queued for switch at match end.`);
              await plugin.addSquadToMatchendSwitches(+commandSplit[1], commandSplit[2]);
              break;
            case "triggermatchend":
              if (!isAdmin) {
                plugin.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                return;
              }
              plugin.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
              plugin.warn(eosID, 'Triggering match-end switch sequence...');
              await plugin.doSwitchMatchend();
              plugin.warn(eosID, 'Match-end switch sequence complete.');
              break;
            case "test":
              plugin.warn(eosID, 'Test 1');
              await delay(2000);
              plugin.warn(eosID, 'Test 2');
              setTimeout(() => {
                plugin.warn(eosID, 'Test 3');
              }, 2000);
              break;
            case "help":
              if (isAdmin) {
                plugin.warn(eosID, "Admin Controls\nPlayer: now, double, matchend, check, clear\nSquad: squad, doublesquad, matchendsquad");
              } else {
                plugin.warn(eosID, `[Switch] Commands\n!switch         | Request a team switch\n!switch check   | Check your eligibility\n!switch explain | How switching works\n!switch cancel  | Leave the queue`);
              }
              break;
            case "explain":
              {
                const cooldownHours = plugin.options.switchCooldownMinutes > 0
                  ? (plugin.options.switchCooldownMinutes / 60).toFixed(1)
                  : plugin.options.switchCooldownHours;
                plugin.warn(eosID, `[Switch] How It Works (1/5)\nYou can request a switch in the first ${plugin.options.switchEnabledMinutes}m after joining or after match start — whichever gives you more time.`);
                await delay(5000);
                plugin.warn(eosID, `[Switch] How It Works (2/5)\nIf teams are uneven, you are queued until a slot opens or a swap partner on the other team is found.`);
                await delay(5000);
                plugin.warn(eosID, `[Switch] How It Works (3/5)\nOnce in the queue, you have ${plugin.options.queueTimeoutMinutes}m before your request expires. Use !switch check to see your status.`);
                await delay(5000);
                plugin.warn(eosID, `[Switch] How It Works (4/5)\nAfter switching, there is a ${cooldownHours}h cooldown before you can switch again.`);
                await delay(5000);
                plugin.warn(eosID, `[Switch] How It Works (5/5)\nAfter a scramble, switches are locked for ${plugin.options.scrambleLockdownDurationMinutes}m.\nUse !switch check to see your current status.`);
              }
              break;
            case "check":
              {
                const ident = commandSplit.splice(1).join(' ');
                if (ident) {
                  if (!isAdmin) {
                    plugin.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                    plugin.warn(eosID, 'Only admins can check other players. Use !switch check with no name to see your own status.');
                    return;
                  }
                  plugin.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                  const result = await plugin.checkPlayer(ident);
                  if (!result) plugin.warn(eosID, 'Player not found.');
                  else if (result === 'multiple') plugin.warn(eosID, 'Multiple players found. Please use SteamID.');
                  else {
                    const now = new Date();
                    const locked = result.scrambleLockdownExpiry && result.scrambleLockdownExpiry > now;
                    const cooldownDuration = plugin.options.switchCooldownMinutes > 0 ? plugin.options.switchCooldownMinutes * 60 * 1000 : plugin.options.switchCooldownHours * 60 * 60 * 1000;
                    const cooldown = result.lastSwitchTimestamp && (new Date(result.lastSwitchTimestamp.getTime() + cooldownDuration) > now);
                    plugin.warn(eosID, `Status: ${result.playerName || result.steamID} | Locked: ${locked ? 'Yes' : 'No'} | Cooldown: ${cooldown ? 'Yes' : 'No'}`);
                    plugin.verbose(1, `[Check] Admin check result: player=${result.playerName || result.steamID}, locked=${locked}, cooldown=${cooldown}`);
                  }
                } else {
                  const eosID = info.player?.eosID;
                  const teamID = info.player?.teamID;
                  if (!eosID || !teamID) {
                    plugin.warn(eosID, `[Switch] Unable to check eligibility.`);
                    return;
                  }

                  const isLiberal = plugin.isLiberalMode();
                  const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
                  const cooldownData = PlayerCooldowns ? await PlayerCooldowns.findByPk(eosID) : null;
                  const now = Date.now();

                  const effectiveCap = isLiberal ? plugin.options.liberalSwitchMaxUnbalancedSlots : null;
                  const availableSwitchSlots = plugin.getSwitchSlotsPerTeam(teamID, effectiveCap);
                  const balanceOK = availableSwitchSlots > 0;

                  const connectionSeconds = await plugin.getSecondsFromJoin(eosID);
                  const matchSeconds = plugin.getSecondsFromMatchStart();
                  const limit = plugin.options.switchEnabledMinutes;
                  const timeWindowOK = isLiberal || (connectionSeconds / 60 <= limit || matchSeconds / 60 <= limit);
                  let timeWindowMsg = '';
                  if (timeWindowOK) {
                    timeWindowMsg = 'Open';
                  } else {
                    const connMin = Math.ceil(connectionSeconds / 60);
                    const matchMin = Math.ceil(matchSeconds / 60);
                    timeWindowMsg = `Closed (${connMin}m join, ${matchMin}m match)`;
                  }

                  const cooldownDuration = plugin.options.switchCooldownMinutes > 0
                    ? plugin.options.switchCooldownMinutes * 60 * 1000
                    : plugin.options.switchCooldownHours * 60 * 60 * 1000;
                  let cooldownOK = true;
                  let cooldownMsg = 'Clear';
                  if (!isLiberal && cooldownData && cooldownData.lastSwitchTimestamp) {
                    const lastSwitchTime = new Date(cooldownData.lastSwitchTimestamp).getTime();
                    if (now - lastSwitchTime < cooldownDuration) {
                      cooldownOK = false;
                      const remaining = Math.ceil((cooldownDuration - (now - lastSwitchTime)) / 60000);
                      cooldownMsg = `${remaining}m remaining`;
                    }
                  }

                  let scrambleOK = true;
                  let scrambleMsg = 'Not active';
                  if (cooldownData && cooldownData.scrambleLockdownExpiry && new Date(cooldownData.scrambleLockdownExpiry).getTime() > now) {
                    scrambleOK = false;
                    const remaining = Math.ceil((new Date(cooldownData.scrambleLockdownExpiry).getTime() - now) / 60000);
                    scrambleMsg = `${remaining}m remaining`;
                  }

                  let statusMsg = '[Switch] Status:\n';
                  statusMsg += `[${balanceOK ? 'OK' : 'X '}] Balance  | ${balanceOK ? 'Slot available' : 'Teams full'}\n`;

                  if (isLiberal) {
                    statusMsg += `[OK] Time       | Seed Mode\n`;
                    statusMsg += `[OK] Cooldown   | Seed Mode\n`;
                  } else {
                    statusMsg += `[${timeWindowOK ? 'OK' : 'X '}] Time       | ${timeWindowMsg}\n`;
                    statusMsg += `[${cooldownOK ? 'OK' : 'X '}] Cooldown   | ${cooldownMsg}\n`;
                  }

                  statusMsg += `[${scrambleOK ? 'OK' : 'X '}] Scramble   | ${scrambleMsg}`;

                  // If player is queued, show queue position and timeout
                  const queueEntry = plugin._findQueueEntry(eosID);
                  if (queueEntry) {
                    const pos = plugin._switchQueue[queueEntry.subQueue].findIndex(e => e.eosID === eosID) + 1;
                    const remainingMs = plugin._getRemainingQueueMs(queueEntry.entry.queuedAt);
                    const remainingMin = (remainingMs / 60000).toFixed(1);
                    statusMsg += `\n[  ] Queue      | Position ${pos}, ~${remainingMin}m timeout remaining`;
                  }

                  const allOK = balanceOK && timeWindowOK && cooldownOK && scrambleOK;
                  if (allOK) {
                    statusMsg += `\nType !switch to request.`;
                  } else {
                    statusMsg += `\nUse !switch explain.`;
                  }

                  plugin.warn(eosID, statusMsg);
                }
              }
              break;
            case "clear":
              if (!isAdmin) {
                plugin.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                return;
              }
              plugin.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
              {
                const ident = commandSplit.splice(1).join(' ');
                const result = await plugin.checkPlayer(ident);
                if (!result || result === 'multiple') {
                  plugin.warn(eosID, 'Player not found or multiple matches.');
                  return;
                }
                const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
                if (PlayerCooldowns) {
                  await plugin._withDb(async (t) => {
                    await PlayerCooldowns.destroy({ where: { eosID: result.eosID }, transaction: t });
                  });
                }
                plugin.warn(eosID, `Cleared cooldowns for ${result.playerName || result.steamID}`);
              }
              break;
            case "clearall":
              if (!isAdmin) {
                plugin.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                return;
              }
              plugin.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
              {
                const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
                if (PlayerCooldowns) {
                  await plugin._withDb(async (t) => {
                    await PlayerCooldowns.destroy({ where: {}, truncate: true, transaction: t });
                  });
                }
              }
              plugin.warn(eosID, "All player cooldowns cleared.");
              break;
            case 'cancel':
              if (!plugin.options.queueEnabled) {
                plugin.warn(eosID, '[Switch Queue] Queue is currently disabled.');
              } else {
                const cancelEntry = plugin._findQueueEntry(info.player?.eosID);
                if (plugin._removePlayerFromQueue(info.player?.eosID)) {
                  plugin.warn(eosID, '[Switch Queue] Removed — you left the queue.');
                  if (plugin._roundStats && cancelEntry) {
                    const dur = Math.round((Date.now() - cancelEntry.entry.queuedAt) / 1000);
                    plugin._roundStats.queueCancels.push({
                      name: playerName,
                      eosID,
                      currentTeamID: cancelEntry.entry.currentTeamID,
                      toTeam: cancelEntry.entry.targetTeamID,
                      queueDurationSeconds: dur
                    });
                  }
                  plugin.verbose(1, `[Queue] ${playerName} cancelled — left the queue.`);
                } else {
                  plugin.warn(eosID, '[Switch Queue] You are not currently in the queue.');
                }
              }
              break;
            default:
              // Show invalid-input notice first, then full help 5s later
              plugin.warn(eosID, `Unknown subcommand: "${subCommand}". Showing help...`);
              await delay(5000);
              plugin.warn(eosID, `[Switch] Commands\n!switch         | Request a team switch\n!switch check   | Check your eligibility\n!switch explain | How switching works\n!switch cancel  | Leave the queue`);
              return;
          }
        } else {
          // Use S³'s immediate refresh for a fresh player list instead of raw RCON
          if (plugin._s3?.players?.refreshNow) {
            await plugin._s3.players.refreshNow('Switch').catch(() => {});
          } else {
            await plugin.server.updatePlayerList();
          }

          if (plugin.s3IsEndgameFactionVote()) {
            plugin.warn(eosID, '[Switch] Team changes are locked during faction voting. Try again when the next round starts.');
            plugin.verbose(1, `[Switch] Denied ${playerName}: faction vote in progress.`);
            return;
          }

          // Check hard eligibility first (scramble lock, time window, cooldown)
          // before the soft canAct gate, so permanently-ineligible players get
          // the correct deny message. canAct failures are transient and will be
          // handled by enqueuing instead of a dead-end return.
          if (!eosID) {
            plugin.verbose(1, `[PlayerCooldowns] Missing eosID for player ${playerName}, skipping switch validation`);
            return;
          }

          const eligibility = await plugin._checkSwitchEligibility(info.player);
          if (!eligibility.eligible) {
            if (eligibility.reason === 'scramble_lock') {
              plugin.warn(eosID, `[Switch] Scramble lock active — expires in ${eligibility.remaining}m.\nYour switch window may close before this expires.\nUse !switch check to see your full status.`);
              plugin.verbose(1, `[Switch] Denied ${playerName}: Scramble lockdown active.`);
              plugin._trackDenial(eosID, playerName, 'scramble_lock');
            } else if (eligibility.reason === 'time_window') {
              plugin.warn(eosID, `[Switch] Eligibility window closed.\nYou can only request a switch in the first ${plugin.options.switchEnabledMinutes}m after joining or after\nmatch start — whichever gives you more time.\nUse !switch explain for details.`);
              plugin.verbose(1, `[Switch] Denied ${playerName}: Match time limit exceeded.`);
              plugin._trackDenial(eosID, playerName, 'time_window');
            } else if (eligibility.reason === 'cooldown') {
              plugin.warn(eosID, `[Switch] On cooldown — available in ${eligibility.remaining}m.\nUse !switch check to see your full status.`);
              plugin.verbose(1, `[Switch] Denied ${playerName}: Cooldown active.`);
              plugin._trackDenial(eosID, playerName, 'cooldown');
            }
            return;
          }

          // Soft gate: if another plugin holds a lock on this player, enqueue
          // instead of dead-ending. The queue's periodic _processQueue will pick
          // them up when the lock releases. If the queue is disabled, fall back
          // to a generic retry message — _enqueuePlayer silently returns when
          // queueEnabled is false, which would leave the player with no feedback.
          const eosID2 = info.player?.eosID;
          const canActPlayers = plugin._s3.players;
          if (eosID2 && canActPlayers?.isReady?.() && canActPlayers.canAct) {
            if (!canActPlayers.canAct(eosID2, 'Switch')) {
              if (!plugin.options.queueEnabled) {
                plugin.verbose(1, `[Switch] ${playerName}: canAct returned false — queue disabled, asking retry.`);
                plugin.warn(eosID, '[Switch] Please try again shortly.');
                return;
              }
              plugin.verbose(1, `[Switch] ${playerName}: canAct returned false — enqueuing.`);
              await plugin._enqueuePlayer(info.player, 'Your request has been queued.');
              return;
            }
          }

          const isLiberal = plugin.isLiberalMode();
          const effectiveCap = isLiberal ? plugin.options.liberalSwitchMaxUnbalancedSlots : null;
          const availableSwitchSlots = plugin.getSwitchSlotsPerTeam(teamID, effectiveCap);

          const targetTeam = teamID === 1 ? 2 : 1;
          let teamPlayerCount = [null, 0, 0];
          for (let p of plugin.server.players) {
            teamPlayerCount[+p.teamID]++;
          }
          const balanceDiff = teamPlayerCount[1] - teamPlayerCount[2];
          const effectiveMaxSlots = effectiveCap !== null ? effectiveCap : plugin.options.maxUnbalancedSlots;

          plugin.verbose(2, `[Switch Request] ${playerName} (T${teamID} -> T${targetTeam})`);
          plugin.verbose(2, `[Team Counts] Team 1: ${teamPlayerCount[1]} | Team 2: ${teamPlayerCount[2]} | Balance Diff: ${balanceDiff}`);
          plugin.verbose(2, `[Switch Slots] Max Unbalance Cap: ${effectiveMaxSlots} | Available Slots: ${availableSwitchSlots}`);
          if (isLiberal) {
            plugin.verbose(2, `[Liberal Mode] ${playerName} - relaxed switch restrictions active (Seed/Jensen).`);
          }

          // v2.0.0: Queue-disabled path — deny early if queue is off and no slot
          if (!plugin.options.queueEnabled) {
            if (availableSwitchSlots <= 0) {
              plugin.warn(eosID, '[Switch] Queue is currently disabled and no slots are available. Try again shortly.');
              return;
            }
            // If queue disabled but slot available, fall through to switch below
          } else {
            // v2.0.0: FIFO check — if players are already waiting, enqueue behind them
            const queueSameTeam = plugin._switchQueue[teamID === 1 ? 't1' : 't2'].length;
            if (queueSameTeam > 0) {
              plugin._enqueuePlayer(info.player, 'Other players are already waiting in the queue.');
              return;
            }

            if (availableSwitchSlots <= 0) {
              plugin._enqueuePlayer(info.player, 'Teams are currently full on that side.');
              return;
            }
          }

          let switchSuccess = false;
          let preSwitchTeam = teamID;
          try {
            await plugin._taggedSwitchPlayer(eosID, 'Player-Self');

            await delay(1000);
            await plugin.server.updatePlayerList();
            const postSwitchPlayer = plugin.server.players.find(p => p.eosID === eosID);
            const postSwitchTeam = postSwitchPlayer?.teamID;

            if (postSwitchTeam !== undefined && postSwitchTeam !== null && String(postSwitchTeam) !== String(preSwitchTeam)) {
              plugin.verbose(1, `[Switch] RCON SUCCESS + VERIFIED: ${playerName} moved from T${preSwitchTeam} to T${postSwitchTeam}`);
              switchSuccess = true;
            } else {
              plugin.verbose(1, `[Switch] RCON returned success but team DID NOT CHANGE for ${playerName} (was T${preSwitchTeam}, still T${postSwitchTeam || '??'}). Not recording cooldown.`);
              plugin.warn(eosID, `[Switch] The server could not complete the team change. Try again later.`);
            }
          } catch (err) {
            plugin.verbose(1, `[Switch] RCON exception for ${playerName}: ${err.message}`);

            if (err.message && (err.message.toLowerCase().includes('timeout') || err.message.toLowerCase().includes('timed out'))) {
              plugin.verbose(1, `[Switch] RCON timeout for ${playerName}, verifying switch status...`);
              await delay(3000);
              await plugin.server.updatePlayerList();
              const currentPlayer = plugin.server.players.find(p => p.eosID === eosID);

              if (currentPlayer && String(currentPlayer.teamID) !== String(preSwitchTeam)) {
                plugin.verbose(1, `[Switch] Verified after timeout: ${playerName} switched from Team ${preSwitchTeam} to Team ${currentPlayer.teamID}`);
                switchSuccess = true;
              } else {
                plugin.verbose(1, `[Switch] Verified after timeout: ${playerName} switch failed (${currentPlayer ? `still on Team ${preSwitchTeam}` : 'player disconnected'})`);
                plugin.warn(eosID, "[Switch] Switch failed — please try again or contact an admin.");
              }
            } else {
              plugin.verbose(1, `Error executing switch: ${err.message}`);
              plugin.warn(eosID, "[Switch] Switch failed — please try again or contact an admin.");
            }
          }

          if (switchSuccess) {
            plugin.verbose(1, `[Switch] Cooldown decision: liberalMode=${isLiberal}, writing cooldown=${!isLiberal}`);
            if (!isLiberal) {
              try {
                const eosID = info.player?.eosID;
                if (!eosID) {
                  plugin.verbose(1, `[PlayerCooldowns] Missing eosID for player ${playerName}, skipping cooldown write`);
                } else {
                  const now = new Date();
                  plugin.verbose(1, `[Switch] Writing cooldown for ${playerName} (eosID=${eosID}) at ${now.toISOString()}`);
                  const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
                  if (PlayerCooldowns) {
                    await plugin._withDb(async (t) => {
                      await PlayerCooldowns.upsert({ eosID, steamID, playerName, lastSwitchTimestamp: now }, { transaction: t });
                    });
                  }
                  plugin.verbose(1, `[Switch] Cooldown written successfully for ${playerName}`);
                }
              } catch (dbErr) {
                plugin.verbose(1, `[Switch] Database update failed: ${dbErr.message}`);
              }
            }

            // Track successful instant switch
            if (plugin._roundStats) {
              const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
              plugin._roundStats.instantSwitches.push({
                name: playerName,
                eosID,
                fromTeam: preSwitchTeam,
                toTeam: teamID === 1 ? 2 : 1,
                gamePhase
              });
              plugin._updateMaxQueueSize();
            }

            plugin.verbose(1, `[Switch] Executed for ${playerName}.`);
          } else {
            plugin.verbose(1, `[Switch] NOT recording cooldown for ${playerName} — switchSuccess=${switchSuccess}`);
          }
        }
      } catch (err) {
        // Track denied switch (only for unexpected errors — gameplay denials are tracked inline)
        if (plugin._roundStats) {
          const gamePhase = plugin._s3?.gameState?.getPhase?.() || 'UNKNOWN';
          plugin._roundStats.deniedSwitches.push({
            name: playerName || 'unknown',
            eosID: eosID || 'unknown',
            reason: err.message || 'unknown',
            gamePhase
          });
        }
        plugin.verbose(1, `Error in onChatMessage: ${err.stack}`);
      }
    };

    // ── Discord stats scraper ──────────────────────────────────

    /**
     * Parse the mode from a round summary embed.
     *
     * Reads the "📊 Stats" field and checks the `**Mode:**` line to determine
     * if the round was played under liberal (Seed/Jensen) rules or standard
     * rules. Liberal rounds are excluded from the aggregate stats embed
     * (see `_handleStatsCommand` line 663-666), so correct classification
     * is essential to avoid polluting standard-round aggregates with
     * liberal-mode data.
     *
     * Format matched:
     *   `**Mode:** Liberal (Seed/Jensen)`   → 'liberal'
     *   `**Mode:** Standard`                → 'standard'
     *   No Stats field / no **Mode:** line  → 'standard' (covers pre-v2.2.0 embeds)
     *
     * @param {object} embed — Discord embed object from a "Switch Round Summary" message
     * @returns {'liberal'|'standard'}
     */
    plugin._parseMode = function (embed) {
      // Locate the 📊 Stats field by name — this is the first field in the embed
      const statsField = embed.fields?.find(f => f.name?.includes('Stats'));
      // If the Stats field is entirely absent (e.g. old-format embed or data loss),
      // default to 'standard' so the round is included rather than silently skipped.
      if (!statsField?.value) return 'standard';
      // The embed builder at switch-output.js:383 writes the **Mode:** line as:
      //   `**Mode:** Liberal (Seed/Jensen)` or `**Mode:** Standard`
      // We match case-insensitively on "Liberal" to handle any future wording changes.
      if (/\*\*Mode:\*\*.*Liberal/i.test(statsField.value)) return 'liberal';
      // Any other value (Standard, missing, unknown) → standard.
      return 'standard';
    };

    /**
     * Parse movement type counts from a round summary embed.
     *
     * Reads the "🔄 Switch Methods" field and extracts the parenthetical
     * count from each sub-section header. Each header is only rendered
     * by `_buildRoundSummaryEmbed()` when its count is > 0, so a missing
     * header naturally returns 0 via `_parseStatsNum`'s no-match behaviour.
     *
     * Sub-section headers and their embed builder lines:
     *   `**Instant Switches (N)**`        — switch-output.js:408 (s.instantSwitches.length)
     *   `**Queue Normal (N)**`            — switch-output.js:419 (s.queueNormal.length)
     *   `**Queue Team Trade (N)**`        — switch-output.js:429 (s.queueTeamTrades.length)
     *   `**Queue Join Swap (N)**`         — switch-output.js:440 (s.queueJoinSwaps.length)
     *   `**Queue Timeout Switch (N)**`    — switch-output.js:451 (s.queueTimeoutSwitches.length)
     *
     * @param {object} embed — Discord embed object from a "Switch Round Summary" message
     * @returns {{ instant: number, queueNormal: number, queueTeamTrade: number, queueJoinSwap: number, queueTimeoutSwitch: number }}
     */
    plugin._parseMoveTypes = function (embed) {
      // The Switch Methods field is only present when there is at least one
      // successful switch of any type. If absent, all counts default to 0.
      const field = embed.fields?.find(f => f.name?.includes('Switch Methods'));
      const v = field?.value || '';
      return {
        // Each regex matches the sub-section header format: **{Label} (N)**\n...
        // The capture group extracts N, and _parseStatsNum handles non-matches → 0.
        instant:             plugin._parseStatsNum(/\*\*Instant Switches\s*\((\d+)\)/, v),
        queueNormal:         plugin._parseStatsNum(/\*\*Queue Normal\s*\((\d+)\)/, v),
        queueTeamTrade:      plugin._parseStatsNum(/\*\*Queue Team Trade\s*\((\d+)\)/, v),
        queueJoinSwap:       plugin._parseStatsNum(/\*\*Queue Join Swap\s*\((\d+)\)/, v),
        queueTimeoutSwitch:  plugin._parseStatsNum(/\*\*Queue Timeout Switch\s*\((\d+)\)/, v),
      };
    };

    /**
     * Parse denial reason counts from a round summary embed.
     *
     * Reads the "📊 Stats" field and extracts the per-reason breakdown
     * from the `**Denied:**` line, e.g.:
     *   `**Denied:** 5 players (3 cooldown, 1 time_window, 1 scramble_lock)`
     *
     * The denial breakdown string is built by `_buildRoundSummaryEmbed()` at
     * switch-output.js:378-380 from `s.deniedSwitches` array, grouping by
     * `reason` property. The possible reasons are:
     *   - `cooldown`      — player is within their switch cooldown window
     *   - `time_window`   — player joined after the switch eligibility window closed
     *   - `scramble_lock` — player is under scramble lockdown
     *
     * If no denials occurred this round, the `**Denied:**` line is absent
     * (guarded by `if (totalDenied > 0)` at switch-output.js:386), so the
     * regex won't match and we return zeroes.
     *
     * @param {object} embed — Discord embed object from a "Switch Round Summary" message
     * @returns {{ cooldown: number, time_window: number, scramble_lock: number }}
     */
    plugin._parseDenialReasons = function (embed) {
      // The Stats field is always present for rounds that produced a summary
      // (it's the first field in the embed), but guard anyway for safety.
      const statsField = embed.fields?.find(f => f.name?.includes('Stats'));
      const v = statsField?.value || '';
      // Match the entire Denied line and capture the parenthesised breakdown.
      // Pattern breakdown:
      //   \*\*Denied:\*\*       — literal "**Denied:**"
      //   \s*\d+\s*players?\s*  — space, count, "player" or "players", space
      //   \((.+?)\)             — capture the parenthesised breakdown (non-greedy)
      const denyMatch = v.match(/\*\*Denied:\*\*\s*\d+\s*players?\s*\((.+?)\)/);
      // No Denied line → no denials this round → return zeroes.
      if (!denyMatch) return { cooldown: 0, time_window: 0, scramble_lock: 0 };
      // Capture group 1 contains e.g. "3 cooldown, 1 time_window, 1 scramble_lock"
      const parts = denyMatch[1];
      return {
        // Each sub-regex extracts the number before the reason keyword.
        // _parseStatsNum returns 0 if the keyword is not found in the breakdown.
        cooldown:      plugin._parseStatsNum(/(\d+)\s+cooldown/, parts),
        time_window:   plugin._parseStatsNum(/(\d+)\s+time_window/, parts),
        scramble_lock: plugin._parseStatsNum(/(\d+)\s+scramble_lock/, parts),
      };
    };

    /**
     * Parse queue outcome counts from a round summary embed.
     *
     * Reads the "ℹ️ Queue Activity" field and extracts the parenthetical
     * count from each non-success outcome header. Each header is only
     * rendered by `_buildRoundSummaryEmbed()` when its count is > 0,
     * so missing headers naturally return 0.
     *
     * Unlike movement types (which represent successes), queue outcomes
     * represent terminal states that did NOT result in a switch:
     *
     *   `**Expired (N)**`            — queue timeout without timeout-switch enabled
     *   `**DC'd in Queue (N)**`      — player disconnected while in queue
     *   `**Cancelled (N)**`          — player manually left the queue
     *   `**Removed (N)**`            — removed due to team change (scramble, admin, etc.)
     *
     * Sub-section header embed builder lines:
     *   expired   — switch-output.js:466
     *   dc        — switch-output.js:486
     *   cancelled — switch-output.js:497
     *   removed   — switch-output.js:504
     *
     * @param {object} embed — Discord embed object from a "Switch Round Summary" message
     * @returns {{ expired: number, dc: number, cancelled: number, removed: number }}
     */
    plugin._parseQueueOutcomes = function (embed) {
      // The Queue Activity field is only present when there is at least one
      // non-success queue outcome or denied switch. If absent, all counts default to 0.
      const field = embed.fields?.find(f => f.name?.includes('Queue Activity'));
      const v = field?.value || '';
      return {
        // Each regex matches the sub-section header format: **{Label} (N)**\n...
        // The capture group extracts N, and _parseStatsNum handles non-matches → 0.
        expired:   plugin._parseStatsNum(/\*\*Expired\s*\((\d+)\)/, v),
        dc:        plugin._parseStatsNum(/\*\*DC'd in Queue\s*\((\d+)\)/, v),
        cancelled: plugin._parseStatsNum(/\*\*Cancelled\s*\((\d+)\)/, v),
        removed:   plugin._parseStatsNum(/\*\*Removed\s*\((\d+)\)/, v),
      };
    };

    /**
     * Compute the median of a numeric array using zero-copy sort.
     * Returns 0 for empty/null input.
     *
     * NOTE: Duplicated from switch-output.js. If the algorithm changes,
     * update both copies.
     *
     * @param {number[]|null} arr — array of millisecond durations
     * @returns {number} median in milliseconds, or 0
     */
    plugin._computeMedianFromMs = function (arr) {
      if (!arr || arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 0) return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      return sorted[mid];
    };

    plugin._handleStatsCommand = async function (message, args) {
      const daysArg = args.find(a => /^\d+$/.test(a));
      const STATS_LOOKBACK_DAYS = daysArg ? parseInt(daysArg, 10) : 60;
      const afterDate = new Date(Date.now() - STATS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      await message.channel.send(`🔍 Scraping switch stats from the last ${STATS_LOOKBACK_DAYS} days...`);

      // ── Aggregate containers ──
      const totals = {
        rounds: 0,
        standardRounds: 0,
        liberalRounds: 0,
        // Summary
        success: 0, failed: 0, denied: 0, toT1: 0, toT2: 0,
        maxQueueSize: 0,
        // Movement types
        instant: 0, queueNormal: 0, queueTeamTrade: 0, queueJoinSwap: 0, queueTimeoutSwitch: 0,
        // Denial reasons
        denialCooldown: 0, denialTimeWindow: 0, denialScrambleLock: 0,
        // Queue outcomes
        outcomeExpired: 0, outcomeDC: 0, outcomeCancelled: 0, outcomeRemoved: 0,
        // All denied from Queue Activity (distinct from denial reasons)
        deniedInQueueActivity: 0,
        // Data quality
        incompleteRounds: 0,
        totalQueueEntries: 0,
        queueDurationsMs: [],
        medianDurationsMs: [],  // per-round medians scraped from embeds
        missingMedian: 0        // rounds without median data (old-format embeds)
      };

      let before = undefined;
      let keepGoing = true;

      try {
        const reportChan = plugin.channel;
        if (!reportChan) {
          await message.channel.send('❌ Reporting channel is not available.');
          return;
        }
        while (keepGoing) {
          const batch = await reportChan.messages.fetch({ limit: 100, before });
          if (batch.size === 0) break;

          for (const msg of batch.values()) {
            if (msg.createdAt < afterDate) { keepGoing = false; break; }

            const embed = msg.embeds.find(e => e.title === 'Switch Round Summary');
            if (!embed) continue;

            totals.rounds++;

            // Determine mode
            const mode = plugin._parseMode(embed);
            if (mode === 'liberal') {
              totals.liberalRounds++;
              continue; // skip liberal rounds from aggregate
            }
            totals.standardRounds++;
            const isOldFormat = !embed.fields?.find(f => f.name && f.name.includes('Stats'))?.value?.includes('**Mode:**');

            // Parse stats field (high-level numbers)
            const statsField = embed.fields?.find(f => f.name && f.name.includes('Stats'));
            if (statsField?.value) {
              const s = plugin._parseRoundStatsField(statsField.value);
              totals.success += s.success;
              totals.failed += s.failed;
              totals.denied += s.denied;
              totals.toT1 += s.toT1;
              totals.toT2 += s.toT2;

              // Extract max queue size
              const mqMatch = statsField.value.match(/\*\*Max Queue Size:\*\*\s*(\d+)/);
              if (mqMatch) {
                const mq = parseInt(mqMatch[1], 10);
                if (mq > totals.maxQueueSize) totals.maxQueueSize = mq;
              }

              // Extract queue wait (new format: mean + median, or old: avg only)
              const newMatch = statsField.value.match(/\*\*Queue Wait:\*\* mean\s*(?:(\d+)m )?(\d+)s, median\s*(?:(\d+)m )?(\d+)s/);
              if (newMatch) {
                const wm = newMatch[1] ? parseInt(newMatch[1], 10) : 0;
                const ws = parseInt(newMatch[2], 10);
                totals.queueDurationsMs.push((wm * 60 + ws) * 1000);
                const mm = newMatch[3] ? parseInt(newMatch[3], 10) : 0;
                const ms = parseInt(newMatch[4], 10);
                totals.medianDurationsMs.push((mm * 60 + ms) * 1000);
              } else {
                // Old format: "**Avg Queue Wait:** 2m 15s"
                const oldMatch = statsField.value.match(/\*\*Avg Queue Wait:\*\*\s*(?:(\d+)m )?(\d+)s/);
                if (oldMatch) {
                  const wm = oldMatch[1] ? parseInt(oldMatch[1], 10) : 0;
                  const ws = parseInt(oldMatch[2], 10);
                  totals.queueDurationsMs.push((wm * 60 + ws) * 1000);
                  totals.missingMedian++;
                }
              }
            }

            // Parse movement types
            const moves = plugin._parseMoveTypes(embed);
            totals.instant += moves.instant;
            totals.queueNormal += moves.queueNormal;
            totals.queueTeamTrade += moves.queueTeamTrade;
            totals.queueJoinSwap += moves.queueJoinSwap;
            totals.queueTimeoutSwitch += moves.queueTimeoutSwitch;

            // Parse denial reasons from stats field
            const denialReasons = plugin._parseDenialReasons(embed);
            totals.denialCooldown += denialReasons.cooldown;
            totals.denialTimeWindow += denialReasons.time_window;
            totals.denialScrambleLock += denialReasons.scramble_lock;

            // Parse queue outcomes
            const outcomes = plugin._parseQueueOutcomes(embed);
            totals.outcomeExpired += outcomes.expired;
            totals.outcomeDC += outcomes.dc;
            totals.outcomeCancelled += outcomes.cancelled;
            totals.outcomeRemoved += outcomes.removed;

            // Total queue entries per round = all movement types with queue + all queue outcomes
            totals.totalQueueEntries += moves.queueNormal + moves.queueTeamTrade + moves.queueJoinSwap + moves.queueTimeoutSwitch
              + outcomes.expired + outcomes.dc + outcomes.cancelled + outcomes.removed;

            // Check for incomplete old-format rounds
            if (isOldFormat) {
              totals.incompleteRounds++;
            }
          }

          before = batch.last()?.id;
          if (batch.size < 100) break;
          await plugin.server?.constructor?.delay ? plugin.server.constructor.delay(300) : new Promise(r => setTimeout(r, 300));
        }
      } catch (err) {
        plugin.verbose(1, `[Switch] Stats scrape failed: ${err.message}`);
        await message.channel.send(`❌ Scrape failed: ${err.message}`);
        return;
      }

      // ── Build embed ──
      const totalRequests = totals.success + totals.failed + totals.denied;
      const attemptedRequests = totals.success + totals.failed;
      const successRate = attemptedRequests > 0 ? ((totals.success / attemptedRequests) * 100).toFixed(1) : 'n/a';
      const failRate = attemptedRequests > 0 ? ((totals.failed / attemptedRequests) * 100).toFixed(1) : 'n/a';
      const denyRate = totalRequests > 0 ? ((totals.denied / totalRequests) * 100).toFixed(1) : 'n/a';
      const successPctOfTotal = totalRequests > 0 ? ((totals.success / totalRequests) * 100).toFixed(1) : '\u2014';
      const deniedPctOfTotal = totalRequests > 0 ? ((totals.denied / totalRequests) * 100).toFixed(1) : '\u2014';
      const failedPctOfTotal = totalRequests > 0 ? ((totals.failed / totalRequests) * 100).toFixed(1) : '\u2014';

      // Average queue wait
      const avgQueueMs = totals.queueDurationsMs.length > 0
        ? totals.queueDurationsMs.reduce((a, b) => a + b, 0) / totals.queueDurationsMs.length
        : 0;
      const avgMin = Math.floor(avgQueueMs / 60000);
      const avgSec = Math.round((avgQueueMs % 60000) / 1000);
      const avgStr = avgMin > 0 ? `${avgMin}m ${avgSec}s` : `${avgSec}s`;

      // Global median queue wait
      const globalMedianMs = plugin._computeMedianFromMs(totals.medianDurationsMs);
      const medMin = Math.floor(globalMedianMs / 60000);
      const medSec = Math.round((globalMedianMs % 60000) / 1000);
      const medStr = medMin > 0 ? `${medMin}m ${medSec}s` : `${medSec}s`;

      // Movement type percentages
      const pct = (n) => totals.standardRounds > 0 && n > 0 ? ` (${((n / totals.success) * 100).toFixed(1)}%)` : '';
      const dpct = (n) => totals.denied > 0 && n > 0 ? ` (${((n / totals.denied) * 100).toFixed(1)}%)` : '';
      const qpct = (n) => totals.totalQueueEntries > 0 && n > 0 ? ` (${((n / totals.totalQueueEntries) * 100).toFixed(1)}%)` : '';

      const fields = [];

      // ── Summary field ──
      const summaryLines = [];
      summaryLines.push(`**Rounds scraped:** ${totals.standardRounds}`);
      if (totals.standardRounds > 0) summaryLines.push(`**Requests/round:** ${(totalRequests / totals.standardRounds).toFixed(1)}`);
      summaryLines.push('');
      summaryLines.push(`**Total requests:** ${totalRequests}`);
      summaryLines.push(`  ✅ Succeeded    ${totals.success}  (${successPctOfTotal}% of total)`);
      summaryLines.push(`  ⛔ Denied         ${totals.denied}  (${deniedPctOfTotal}% of total)`);
      summaryLines.push(`  ❌ Failed           ${totals.failed}  (${failedPctOfTotal}% of total)`);
      summaryLines.push('');
      summaryLines.push(`**Success rate (excl. denials):** ${successRate}%  (${totals.success}/${attemptedRequests})`);
      summaryLines.push('');
      if (totals.success > 0) {
        summaryLines.push(`**Direction:**`);
        const dirPct1 = ` (${((totals.toT1 / totals.success) * 100).toFixed(1)}%)`;
        const dirPct2 = ` (${((totals.toT2 / totals.success) * 100).toFixed(1)}%)`;
        summaryLines.push(`→ T1: ${totals.toT1}${dirPct1}`);
        summaryLines.push(`→ T2: ${totals.toT2}${dirPct2}`);
      }
      summaryLines.push('');
      summaryLines.push(`**Max queue size reached:** ${totals.maxQueueSize}`);
      if (totals.queueDurationsMs.length > 0) {
        const medianPart = totals.medianDurationsMs.length > 0 ? `, median ${medStr}` : '';
        summaryLines.push(`**Queue wait:** mean ${avgStr}${medianPart}`);
      }

      fields.push({ name: '📊 Summary', value: summaryLines.join('\n'), inline: false });

      // ── Movement Types field ──
      if (totals.success > 0) {
        const moveLines = [];
        moveLines.push(`Instant            ${totals.instant}${pct(totals.instant)}`);
        moveLines.push(`Queue Solo         ${totals.queueNormal}${pct(totals.queueNormal)}`);
        moveLines.push(`Queue Pair Trade   ${totals.queueTeamTrade}${pct(totals.queueTeamTrade)}`);
        moveLines.push(`Join Swap          ${totals.queueJoinSwap}${pct(totals.queueJoinSwap)}`);
        moveLines.push(`Timeout Switch     ${totals.queueTimeoutSwitch}${pct(totals.queueTimeoutSwitch)}`);
        fields.push({ name: `🔄 Movement Types (all ${totals.success} successes)`, value: moveLines.join('\n'), inline: false });
      }

      // ── Denial Reasons field ──
      if (totals.denied > 0) {
        const denialLines = [];
        denialLines.push(`Cooldown           ${totals.denialCooldown}${dpct(totals.denialCooldown)}`);
        denialLines.push(`Time Window        ${totals.denialTimeWindow}${dpct(totals.denialTimeWindow)}`);
        denialLines.push(`Scramble Lock     ${totals.denialScrambleLock}${dpct(totals.denialScrambleLock)}`);
        fields.push({ name: `⛔ Denial Reasons (all ${totals.denied} denials)`, value: denialLines.join('\n'), inline: false });
      }

      // ── Queue Outcomes field ──
      if (totals.totalQueueEntries > 0) {
        const outcomeLines = [];
        // Succeeded = all queue-based movement types
        const succeeded = totals.queueNormal + totals.queueTeamTrade + totals.queueJoinSwap + totals.queueTimeoutSwitch;
        outcomeLines.push(`Succeeded          ${succeeded}${qpct(succeeded)}`);
        outcomeLines.push(`Disconnected      ${totals.outcomeDC}${qpct(totals.outcomeDC)}`);
        outcomeLines.push(`Cancelled          ${totals.outcomeCancelled}${qpct(totals.outcomeCancelled)}`);
        outcomeLines.push(`Expired              ${totals.outcomeExpired}${qpct(totals.outcomeExpired)}`);
        outcomeLines.push(`Removed            ${totals.outcomeRemoved}${qpct(totals.outcomeRemoved)}`);

        if (totals.outcomeExpired > 0) {
          outcomeLines.push('');
          outcomeLines.push(`\u2020 Expired entries are from rounds where\n  queueTimeoutSwitchEnabled was off.`);
        }

        fields.push({ name: `📋 Queue Outcomes (all ${totals.totalQueueEntries} queue entries)`, value: outcomeLines.join('\n'), inline: false });
      }

      // ── Data Quality field (conditional) ──
      const qualityLines = [];
      if (totals.liberalRounds > 0) {
        qualityLines.push(`${totals.liberalRounds} liberal-mode rounds excluded`);
      }
      if (totals.incompleteRounds > 0) {
        qualityLines.push(`${totals.incompleteRounds} rounds had incomplete data (pre-v2.2.0 format)`);
      }
      if (totals.missingMedian > 0) {
        qualityLines.push(`${totals.missingMedian} rounds lack median data (pre-median embed format)`);
      }
      if (qualityLines.length > 0) {
        fields.push({ name: '⚠️ Data Quality', value: qualityLines.join('\n'), inline: false });
      }

      if (!fields.length) {
        fields.push({ name: 'No Data', value: 'No switch round summaries found in the lookback period.', inline: false });
      }

      const embed = {
        title: 'Switch Global Stats',
        description: `${STATS_LOOKBACK_DAYS}-day aggregate \u00B7 standard-mode rounds`,
        color: 0x3498DB,
        fields,
        timestamp: new Date(),
        footer: { text: `Switch v${plugin.constructor.version}` }
      };

      await message.channel.send({ embeds: [embed] });
    };

    // ── Discord admin command handler ───────────────────────────

    plugin.onDiscordMessage = async function (message) {
      if (message.author.bot) return;

      // ── Channel gate ──────────────────────────────────────────────
      // Listens for admin !switch commands in adminCommandChannelID
      // (if set) or falls back to channelID (single‑channel mode).
      // Round summaries, scramble notifications, and other automated
      // reports flow independently via sendDiscordMessage() to this.channel
      // (the reporting channel) — that path is untouched here.
      // Admin responses use message.channel.send() / message.reply() so
      // they self‑route to whichever channel the command was received in.
      // ───────────────────────────────────────────────────────────────
      const adminChanId = plugin.options.adminCommandChannelID || plugin.options.channelID;
      if (adminChanId && message.channel.id !== adminChanId) return;

      const content = message.content.trim();
      const args = content.split(' ');
      const command = args[0].toLowerCase();
      const subCommand = args[1] ? args[1].toLowerCase() : null;

      if (command !== '!switch') return;

      if (subCommand === 'status') {
        const embed = await plugin._buildSwitchDiagEmbed();
        await message.channel.send({ embeds: [embed] });
      } else if (subCommand === 'check') {
        const ident = args.slice(2).join(' ');
        if (!ident) {
          await plugin.safeDiscordReply(message, 'Usage: `!switch check <SteamID|Name>`');
          return;
        }
        const result = await plugin.checkPlayer(ident);
        if (!result) {
          await plugin.safeDiscordReply(message, 'Player not found in database.');
        } else if (result === 'multiple') {
          await plugin.safeDiscordReply(message, '⚠️ Ambiguous result: Multiple matches found. Please refine your search string or use a SteamID.');
        } else {
          const now = new Date();
          let desc = `**SteamID:** ${result.steamID}\n**Name:** ${result.playerName || 'Unknown'}\n`;

          if (result.scrambleLockdownExpiry && result.scrambleLockdownExpiry > now) {
            desc += `🔴 **Scramble Lock:** <t:${Math.floor(result.scrambleLockdownExpiry.getTime() / 1000)}:R>\n`;
          } else {
            desc += `🟢 **Scramble Lock:** None\n`;
          }

          if (result.lastSwitchTimestamp) {
            const cooldownDuration = plugin.options.switchCooldownMinutes > 0 ? plugin.options.switchCooldownMinutes * 60 * 1000 : plugin.options.switchCooldownHours * 60 * 60 * 1000;
            const nextSwitch = new Date(result.lastSwitchTimestamp.getTime() + cooldownDuration);
            if (nextSwitch > now) {
              desc += `🔴 **Switch Cooldown:** <t:${Math.floor(nextSwitch.getTime() / 1000)}:R>\n`;
            } else {
              desc += `🟢 **Switch Cooldown:** Ready\n`;
            }
          } else {
            desc += `🟢 **Switch Cooldown:** Ready\n`;
          }

          if (result.firstSeenTimestamp) {
            desc += `⏱️ **Joined:** <t:${Math.floor(new Date(result.firstSeenTimestamp).getTime() / 1000)}:f>\n`;
          }

          await message.channel.send({ embeds: [{ title: '🔍 Player Status', description: desc, color: 0x3498db }] });
        }
      } else if (subCommand === 'clear') {
        const ident = args.slice(2).join(' ');
        if (!ident) {
          await plugin.safeDiscordReply(message, 'Usage: `!switch clear <SteamID|Name>`');
          return;
        }
        const result = await plugin.checkPlayer(ident);
        if (!result || result === 'multiple') {
          await plugin.safeDiscordReply(message, 'Player not found or multiple matches.');
          return;
        }
        const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
        if (PlayerCooldowns) {
          await plugin._withDb(async (t) => {
            await PlayerCooldowns.destroy({ where: { eosID: result.eosID }, transaction: t });
          });
        }
        await plugin.safeDiscordReply(message, `✅ Cleared cooldowns for **${result.playerName || result.steamID}**.`);
      } else if (subCommand === 'clearall') {
        const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
        if (PlayerCooldowns) {
          await plugin._withDb(async (t) => {
            await PlayerCooldowns.destroy({ where: {}, truncate: true, transaction: t });
          });
        }
        await plugin.safeDiscordReply(message, '🗑️ All player cooldowns cleared.');
      } else if (subCommand === 'timelimit' && ['on', 'off'].includes(args[2])) {
        const enabled = args[2] === 'on';
        try {
          await plugin._saveTimeLimitSetting(enabled);
          const status = enabled ? 'enabled' : 'disabled';
          await plugin.safeDiscordReply(message,
            `✅ Switch time limit **${status}**. Players ${enabled ? 'must switch within the first minutes of joining or match start' : 'can switch at any time regardless of join/match time'}.`
          );
        } catch (err) {
          await plugin.safeDiscordReply(message, `❌ Failed to update setting: ${err.message}`);
        }
      } else if (subCommand === 'stats') {
        const args2 = args.slice(2);
        await plugin._handleStatsCommand(message, args2);
      } else if (subCommand === 'help') {
        const embed = {
          title: '📜 Switch Plugin Commands',
          description: 'Available commands:',
          fields: [
            { name: '!switch status', value: 'Show database diagnostics and active locks.' },
            { name: '!switch check <ident>', value: 'Check cooldown status for a player.' },
            { name: '!switch clear <ident>', value: 'Clear cooldowns for a specific player.' },
            { name: '!switch clearall', value: 'Clear all player cooldowns.' },
            { name: '!switch timelimit on|off', value: 'Admin: Toggle join/match time limit for queue entry.' },
            { name: '!switch stats [days]', value: 'Scrape the last N days of round summaries (default 60).' },
            { name: '!switch help', value: 'Show this help message.' }
          ]
        };
        await message.channel.send({ embeds: [embed] });
      } else {
        // Unknown subcommand — show help
        const embed = {
          title: '📜 Switch Plugin Commands',
          description: 'Available commands:',
          fields: [
            { name: '!switch status', value: 'Show database diagnostics and active locks.' },
            { name: '!switch check <ident>', value: 'Check cooldown status for a player.' },
            { name: '!switch clear <ident>', value: 'Clear cooldowns for a specific player.' },
            { name: '!switch clearall', value: 'Clear all player cooldowns.' },
            { name: '!switch timelimit on|off', value: 'Admin: Toggle join/match time limit for queue entry.' },
            { name: '!switch stats [days]', value: 'Scrape the last N days of round summaries (default 60).' },
            { name: '!switch help', value: 'Show this help message.' }
          ]
        };
        await message.channel.send({ embeds: [embed] });
      }
    };
  }
};

export default SwitchCommands;