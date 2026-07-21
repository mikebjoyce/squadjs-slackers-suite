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
        const teamID = info.player?.teamID;
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
                plugin.warn(eosID, `[Switch] How It Works (1/4)\nSwitching is allowed in the first ${plugin.options.switchEnabledMinutes}m after joining or after match start — whichever gives you more time.`);
                await delay(5000);
                plugin.warn(eosID, `[Switch] How It Works (2/4)\nIf teams are uneven, you are queued until a slot opens or a swap partner on the other team is found.`);
                await delay(5000);
                plugin.warn(eosID, `[Switch] How It Works (3/4)\nAfter switching, there is a ${cooldownHours}h cooldown before you can switch again.`);
                await delay(5000);
                plugin.warn(eosID, `[Switch] How It Works (4/4)\nAfter a scramble, switches are locked for ${plugin.options.scrambleLockdownDurationMinutes}m.\nUse !switch check to see your current status.`);
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
              } else if (plugin._removePlayerFromQueue(info.player?.eosID)) {
                plugin.warn(eosID, '[Switch Queue] Removed — you left the queue.');
                if (plugin._roundStats) {
                  plugin._roundStats.queueCancels.push({ name: playerName, eosID });
                }
                plugin.verbose(1, `[Queue] ${playerName} cancelled — left the queue.`);
              } else {
                plugin.warn(eosID, '[Switch Queue] You are not currently in the queue.');
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

          const eosID2 = info.player?.eosID;
          const canActPlayers = plugin._s3.players;
          if (eosID2 && canActPlayers?.isReady?.() && canActPlayers.canAct) {
            if (!canActPlayers.canAct(eosID2, 'Switch')) {
              plugin.warn(eosID, '[Switch] You are currently being processed — please try again shortly.');
              plugin.verbose(1, `[Switch] Denied ${playerName}: canAct returned false (locked by higher-priority actor).`);
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
              plugin.warn(eosID, `[Switch] Join/match window closed.\nSwitching is only allowed in the first ${plugin.options.switchEnabledMinutes}m after joining or after\nmatch start — whichever gives you more time.\nUse !switch explain for details.`);
              plugin.verbose(1, `[Switch] Denied ${playerName}: Match time limit exceeded.`);
              plugin._trackDenial(eosID, playerName, 'time_window');
            } else if (eligibility.reason === 'cooldown') {
              plugin.warn(eosID, `[Switch] On cooldown — available in ${eligibility.remaining}m.\nUse !switch check to see your full status.`);
              plugin.verbose(1, `[Switch] Denied ${playerName}: Cooldown active.`);
              plugin._trackDenial(eosID, playerName, 'cooldown');
            }
            return;
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

    plugin._handleStatsCommand = async function (message, args) {
      const daysArg = args.find(a => /^\d+$/.test(a));
      const STATS_LOOKBACK_DAYS = daysArg ? parseInt(daysArg, 10) : 60;
      const afterDate = new Date(Date.now() - STATS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

      await message.channel.send(`🔍 Scraping switch stats from the last ${STATS_LOOKBACK_DAYS} days...`);

      const totals = { rounds: 0, success: 0, failed: 0, denied: 0, toT1: 0, toT2: 0 };
      let before = message.id;
      let keepGoing = true;

      try {
        while (keepGoing) {
          const batch = await message.channel.messages.fetch({ limit: 100, before });
          if (batch.size === 0) break;

          for (const msg of batch.values()) {
            if (msg.createdAt < afterDate) { keepGoing = false; break; }

            const embed = msg.embeds.find(e => e.title === 'Switch Round Summary');
            if (embed) {
              const statsField = embed.fields?.find(f => f.name.includes('Stats'));
              if (statsField) {
                const s = plugin._parseRoundStatsField(statsField.value);
                totals.rounds++;
                totals.success += s.success;
                totals.failed += s.failed;
                totals.denied += s.denied;
                totals.toT1 += s.toT1;
                totals.toT2 += s.toT2;
              }
            }
          }

          before = batch.last()?.id;
          if (batch.size < 100) break;
          await delay(300);
        }
      } catch (err) {
        plugin.verbose(1, `[Switch] Stats scrape failed: ${err.message}`);
        await message.channel.send(`❌ Scrape failed: ${err.message}`);
        return;
      }

      const totalRequests = totals.success + totals.failed + totals.denied;
      const attemptedRequests = totals.success + totals.failed;
      const successRate = attemptedRequests > 0 ? ((totals.success / attemptedRequests) * 100).toFixed(1) : 'n/a';
      const failRate = attemptedRequests > 0 ? ((totals.failed / attemptedRequests) * 100).toFixed(1) : 'n/a';
      const denyRate = totalRequests > 0 ? ((totals.denied / totalRequests) * 100).toFixed(1) : 'n/a';

      const embed = {
        title: 'Switch Global Stats',
        color: 0x3498DB,
        fields: [{
          name: '📊 Aggregate',
          value:
            `**Rounds Scraped:** ${totals.rounds}\n` +
            `**Requests:** ${totalRequests} (${totals.success} succeeded, ${totals.denied} denied, ${totals.failed} failed)\n` +
            `**Success Rate:** ${successRate}%\n` +
            `**Denial Rate:** ${denyRate}%\n` +
            `**Fail Rate:** ${failRate}%\n` +
            `**To T1 / To T2:** ${totals.toT1} / ${totals.toT2}`,
          inline: false
        }],
        timestamp: new Date(),
        footer: { text: `Switch v${plugin.constructor.version}` }
      };

      await message.channel.send({ embeds: [embed] });
    };

    // ── Discord admin command handler ───────────────────────────

    plugin.onDiscordMessage = async function (message) {
      if (message.author.bot) return;
      if (plugin.options.channelID && message.channel.id !== plugin.options.channelID) return;

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