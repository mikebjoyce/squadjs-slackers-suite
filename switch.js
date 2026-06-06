import Sequelize from 'sequelize';
import DiscordBasePlugin from './discord-base-plugin.js';
import { setTimeout as delay } from "timers/promises";
const { DataTypes, Op } = Sequelize;

/**
 * SquadJS Switch Plugin - Persistent Join Time
 * @author Slacker
 */

export default class Switch extends DiscordBasePlugin {
    static get description() {
        return "Switch plugin with persistent join timers";
    }

    static get defaultEnabled() {
        return true;
    }

    static get optionsSpecification() {
        return {
            discordClient: {
                required: true,
                description: 'Discord connector name.',
                connector: 'discord',
                default: 'discord'
            },
            commandPrefix: {
                required: false,
                description: "Prefix of every switch command, can be an array",
                default: [ "!switch", "!change" ]
            },
            doubleSwitchCommands: {
                required: false,
                description: 'Array of commands that can be sent in every chat to request a double switch',
                default: [],
                example: [ '!bug', '!stuck', '!doubleswitch' ]
            },
            doubleSwitchCooldownHours: {
                required: false,
                description: "Hours to wait before using again one of the double switch commands",
                default: 0.5
            },
            doubleSwitchDelaySeconds: {
                required: false,
                description: "Delay between the first and second team switch",
                default: 1
            },
            endMatchSwitchSlots: {
                required: false,
                description: "Number of switch slots, players will be put in a queue and switched at the end of the match",
                default: 3
            },
            switchCooldownHours: {
                required: false,
                description: "Hours to wait before using again the !switch command",
                default: 3
            },
            switchCooldownMinutes: {
                required: false,
                description: "Minutes to wait before using again the !switch command (overrides hours if set)",
                default: 0
            },
            switchEnabledMinutes: {
                required: false,
                description: "Time in minutes in which the switch will be enabled after match start or player join",
                default: 5
            },
            doubleSwitchEnabledMinutes: {
                required: false,
                description: "Time in minutes in which a double switch will be enabled after match start or player join",
                default: 5
            },
            maxUnbalancedSlots: {
                required: false,
                description: "Number of player of difference between the two teams to allow a team switch",
                default: 3
            },
            switchToOldTeamAfterRejoin: {
                required: false,
                description: "The team of a disconnecting player will be stored and after a new connection, the player will be switched to his old team",
                default: false
            },
            discordChannelID: {
                required: false,
                description: "Discord channel ID for logs.",
                default: ''
            },
            database: {
                required: true,
                connector: 'sequelize',
                description: 'The Sequelize connector to log server information to.',
                default: 'sqlite'
            },
            scrambleLockdownDurationMinutes: {
                required: false,
                description: "Duration in minutes to block switching after a scramble.",
                default: 20
            },
            liberalSwitchGameModes: {
                required: false,
                description: "Substrings for layer/gamemode names where switching rules are relaxed (no time/cooldown limits).",
                default: ['Seed', 'Jensen'],
                type: 'array'
            },
            liberalSwitchMaxUnbalancedSlots: {
                required: false,
                description: "Balance cap during liberal modes (e.g., Seed/Jensen). Allows more permissive switching up to a ceiling of 50v50.",
                default: 6,
                type: 'number'
            },
            dynamicBalanceTolerance: {
                required: false,
                description: "Enable interpolated extra imbalance tolerance when server is below full capacity (default: off). Scales from floor to 98 players.",
                default: false,
                type: 'boolean'
            },
            dynamicBalancePlayerFloor: {
                required: false,
                description: "Total player count at which maximum extra tolerance kicks in (default 90). Below this, full extra slots apply.",
                default: 90,
                type: 'number'
            },
            dynamicBalanceExtraSlots: {
                required: false,
                description: "Additional allowed imbalance slots at the floor player count (default 2). Linearly interpolated between floor and 98 players.",
                default: 2,
                type: 'number'
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.onChatMessage = this.onChatMessage.bind(this);
        this.onPlayerConnected = this.onPlayerConnected.bind(this);
        this.onUpdatedPlayerInfo = this.onUpdatedPlayerInfo.bind(this);
        this.switchPlayer = this.switchPlayer.bind(this);
        this.getPlayersByUsername = this.getPlayersByUsername.bind(this);
        this.getPlayerBySteamID = this.getPlayerBySteamID.bind(this);
        this.getPlayerByUsernameOrSteamID = this.getPlayerByUsernameOrSteamID.bind(this);
        this.doubleSwitchPlayer = this.doubleSwitchPlayer.bind(this);
        this.getFactionId = this.getFactionId.bind(this);
        this.switchSquad = this.switchSquad.bind(this);
        this.getSecondsFromJoin = this.getSecondsFromJoin.bind(this);
        this.getSecondsFromMatchStart = this.getSecondsFromMatchStart.bind(this);
        this.getTeamBalanceDifference = this.getTeamBalanceDifference.bind(this);
        this.switchToPreDisconnectionTeam = this.switchToPreDisconnectionTeam.bind(this);
        this.getSwitchSlotsPerTeam = this.getSwitchSlotsPerTeam.bind(this);
        this.onRoundEnded = this.onRoundEnded.bind(this);
        this.addPlayerToMatchendSwitches = this.addPlayerToMatchendSwitches.bind(this);
        this.doSwitchMatchend = this.doSwitchMatchend.bind(this);
        this.cleanup = this.cleanup.bind(this);
        this.onScrambleExecuted = this.onScrambleExecuted.bind(this);
        this.checkPlayer = this.checkPlayer.bind(this);
        this.onDiscordMessage = this.onDiscordMessage.bind(this);
        this.getDiagnosticInfo = this.getDiagnosticInfo.bind(this);
        this.safeTransaction = this.safeTransaction.bind(this);
        this.safeDiscordReply = this.safeDiscordReply.bind(this);

        this.playersConnectionTime = {};
        this.recentSwitches = [];
        this.recentDoubleSwitches = [];
        this.recentDisconnections = {};
        this._knownConnectedPlayers = new Map();
        this._switchedOnJoin = new Set();
        this._nullTeamIDWindowActive = false;
        this._nullTeamIDWindowTimeout = null;

        // Layer tracking for liberal mode detection
        this.currentLayerName = null;
        this.currentGamemode = null;
        this._liberalModes = [];

        this.models = {};

        this.createModel('Endmatch', {
            id: {
                type: DataTypes.INTEGER,
                primaryKey: true,
                autoIncrement: true
            },
            name: {
                type: DataTypes.STRING
            },
            steamID: {
                type: DataTypes.STRING
            },
            created_at: {
                type: DataTypes.DATE,
                defaultValue: DataTypes.NOW
            }
        });

        this.createModel('PlayerCooldowns', {
            steamID: {
                type: DataTypes.STRING,
                primaryKey: true
            },
            playerName: {
                type: DataTypes.STRING,
                allowNull: true
            },
            lastSwitchTimestamp: {
                type: DataTypes.DATE,
                allowNull: true
            },
            firstSeenTimestamp: {
                type: DataTypes.DATE,
                allowNull: true
            },
            scrambleLockdownExpiry: {
                type: DataTypes.DATE,
                allowNull: true
            }
        });

        this.broadcast = (msg) => { this.server.rcon.broadcast(msg); };
        this.warn = (steamid, msg) => { this.server.rcon.warn(steamid, msg) };
    }

    async safeTransaction(logicFn) {
        const maxRetries = 5;
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await this.options.database.transaction(logicFn);
            } catch (err) {
                const isLocked = err.message && (
                    err.message.includes('SQLITE_BUSY') ||
                    err.message.includes('database is locked') ||
                    err.name === 'SequelizeTimeoutError'
                );
                if (isLocked && i < maxRetries - 1) {
                    await delay(Math.random() * 500 + 200);
                } else {
                    throw err;
                }
            }
        }
    }

    async safeDiscordReply(message, content) {
        if (!message || !content) return;
        try {
            await message.reply(content);
        } catch (err) {
            this.verbose(1, `Discord reply failed: ${err.message}`);
        }
    }

    async mount() {
        await this.models.PlayerCooldowns.sync({ alter: true });

        // Initialize liberal mode substring list (lowercased for comparison)
        this._liberalModes = (this.options.liberalSwitchGameModes || ['Seed', 'Jensen']).map(m => String(m).toLowerCase());

        // Bootstrap layer info from server state at mount time
        if (this.server.currentLayer?.name) {
            this.currentLayerName = this.server.currentLayer.name;
            this.currentGamemode = this.server.currentLayer.gamemode || null;
            this.verbose(1, `[Layer] Bootstrapped from server.currentLayer at mount: ${this.currentLayerName} (${this.currentGamemode})`);
        }

        this.server.on('CHAT_MESSAGE', this.onChatMessage);
        this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
        this.server.on('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
        this.server.on('ROUND_ENDED', this.onRoundEnded)
        this.server.on('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
        this.server.on('NEW_GAME', this.onNewGame.bind(this));
        this.server.on('UPDATED_LAYER_INFORMATION', this.onUpdatedLayerInfo.bind(this));
        this.server.on('UPDATED_SERVER_INFORMATION', this.onServerInfoUpdated.bind(this));
        if (this.options.discordClient) {
            this.options.discordClient.on('message', this.onDiscordMessage);
        }
    }

    async prepareToMount() {
        if (this.options.discordChannelID) {
            this.options.channelID = this.options.discordChannelID;
        }
        await super.prepareToMount();
        await this.models.Endmatch.sync();
        await this.models.PlayerCooldowns.sync({ alter: true });
    }

    createModel(name, schema) {
        this.models[ name ] = this.options.database.define(`SwitchPlugin_${name}`, schema, {
            timestamps: false
        });
    }

    async onChatMessage(info) {
        try {
            const steamID = info.player?.steamID;
            const playerName = info.player?.name;
            const teamID = info.player?.teamID;
            const message = info.message.toLowerCase();

            if (this.options.doubleSwitchCommands.find(c => c.toLowerCase() == message))
                this.doubleSwitchPlayer(steamID);

            const commandPrefixInUse = typeof this.options.commandPrefix === 'string' ? this.options.commandPrefix : this.options.commandPrefix.find(c => message.startsWith(c.toLowerCase()));

            if ((typeof this.options.commandPrefix === 'string' && !message.startsWith(this.options.commandPrefix)) || (typeof this.options.commandPrefix === 'object' && this.options.commandPrefix.length >= 1 && !this.options.commandPrefix.find(c => message.startsWith(c.toLowerCase())))) return;

            // Updated join time to be async
            const connectionSeconds = await this.getSecondsFromJoin(steamID);
            const connectionLog = connectionSeconds > 0 ? `${connectionSeconds.toFixed(1)}s` : "0s (New Join/Plugin Reload)";
            this.verbose(1, `${playerName}:\n > Connection: ${connectionLog}\n > Match Start: ${this.getSecondsFromMatchStart().toFixed(1)}s`);
            this.verbose(1, `[Command] Player ${playerName} sent: ${info.message}`);

            const commandSplit = message.substring(commandPrefixInUse.length).trim().split(' ').filter(Boolean);
            const subCommand = commandSplit[ 0 ];

            const isAdmin = info.chat === "ChatAdmin" || (this.server.admins && Object.prototype.hasOwnProperty.call(this.server.admins, steamID));
            if (subCommand && subCommand != '') {
                let pl;
                switch (subCommand) {
                case 'now':
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    pl = this.getPlayerByUsernameOrSteamID(steamID, commandSplit.splice(1).join(' '))
                    if (pl) {
                        this._taggedSwitchPlayer(pl.steamID, 'Admin-Force').catch(err => {
                            this.verbose(1, `Admin switch now failed: ${err.message}`);
                        });
                    }
                    break;
                case 'double':
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    pl = this.getPlayerByUsernameOrSteamID(steamID, commandSplit.splice(1).join(' '))
                    if (pl) {
                        await this.doubleSwitchPlayer(pl.steamID, true);
                    }
                    break;
                case 'squad':
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    await this.switchSquad(+commandSplit[ 1 ], commandSplit[ 2 ]);
                    break;
                case 'refresh':
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    this.warn(steamID, `Players and squads refreshed.`);
                    break;
                case 'slots':
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    this.warn(steamID, `Switch Slots:\nTeam 1: ${this.getSwitchSlotsPerTeam(1)}\nTeam 2: ${this.getSwitchSlotsPerTeam(2)}`);
                    break;
                case "matchend":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    await this.server.updatePlayerList();
                    pl = this.getPlayerByUsernameOrSteamID(steamID, commandSplit.splice(1).join(' '));
                    this.warn(steamID, `Player "${pl.name}" queued for switch at match end.`);
                    this.addPlayerToMatchendSwitches(pl);
                    break;
                case "doublesquad":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    await this.doubleSwitchSquad(+commandSplit[ 1 ], commandSplit[ 2 ]);
                    break;
                case "matchendsquad":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    this.warn(steamID, `Squad ${commandSplit[ 1 ]} (${commandSplit[ 2 ]}) queued for switch at match end.`);
                    await this.addSquadToMatchendSwitches(+commandSplit[ 1 ], commandSplit[ 2 ]);
                    break;
                case "triggermatchend":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    this.warn(steamID, 'Triggering match-end switch sequence...');
                    await this.doSwitchMatchend();
                    this.warn(steamID, 'Match-end switch sequence complete.');
                    break;
                case "test":
                    this.warn(steamID, 'Test 1');
                    await delay(2000);
                    this.warn(steamID, 'Test 2');
                    setTimeout(() => {
                        this.warn(steamID, 'Test 3');
                    }, 2000);
                    break;
                case "help":
                    if (isAdmin) {
                        this.warn(steamID, "--- Admin Controls --- \n Player: now, double, matchend, check, clear \n Squad: squad, doublesquad, matchendsquad");
                    } else {
                        const liberalMode = this.isLiberalMode();
                        if (liberalMode) {
                            this.warn(steamID, `Usage: !switch | Seed/Jensen mode active: no time or cooldown limits. Switch freely (balance rules still apply).`);
                        } else {
                            this.warn(steamID, `Usage: !switch | Available first ${this.options.switchEnabledMinutes} mins of match/join.`);
                        }
                    }
                    break;
                case "check":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    {
                        const ident = commandSplit.splice(1).join(' ');
                        if (!ident) {
                            this.warn(steamID, "Usage: !switch check <SteamID|Name>");
                            return;
                        }
                        const result = await this.checkPlayer(ident);
                        if (!result) this.warn(steamID, 'Player not found.');
                        else if (result === 'multiple') this.warn(steamID, 'Multiple players found. Please use SteamID.');
                        else {
                            const now = new Date();
                            const locked = result.scrambleLockdownExpiry && result.scrambleLockdownExpiry > now;
                            const cooldownDuration = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
                            const cooldown = result.lastSwitchTimestamp && (new Date(result.lastSwitchTimestamp.getTime() + cooldownDuration) > now);
                            this.warn(steamID, `Status: ${result.playerName || result.steamID} | Locked: ${locked ? 'Yes' : 'No'} | Cooldown: ${cooldown ? 'Yes' : 'No'}`);
                        }
                    }
                    break;
                case "clear":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    {
                        const ident = commandSplit.splice(1).join(' ');
                        const result = await this.checkPlayer(ident);
                        if (!result || result === 'multiple') {
                            this.warn(steamID, 'Player not found or multiple matches.');
                            return;
                        }
                        await this.safeTransaction(async (t) => {
                            await this.models.PlayerCooldowns.destroy({ where: { steamID: result.steamID }, transaction: t });
                        });
                        this.warn(steamID, `Cleared cooldowns for ${result.playerName || result.steamID}`);
                    }
                    break;
                case "clearall":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    await this.safeTransaction(async (t) => {
                        await this.models.PlayerCooldowns.destroy({ where: {}, truncate: true, transaction: t });
                    });
                    this.warn(steamID, "All player cooldowns cleared.");
                    break;
                default:
                    await this.warn(steamID, `Unknown subcommand: "${subCommand}"`);
                    return;
            }
        } else {
            // Issue 7: Gate !switch commands during null-teamID window (per §3 of reference doc)
            if (this._nullTeamIDWindowActive) {
                this.warn(steamID, 'Server is transitioning between rounds. Team assignments are still resolving. Please try again in a moment.');
                this.verbose(1, `[Switch] Denied ${playerName}: Null-teamID window active.`);
                return;
            }

            await this.server.updateSquadList();
            await this.server.updatePlayerList();

            // Detect liberal mode
            const isLiberal = this.isLiberalMode();
            const effectiveCap = isLiberal ? this.options.liberalSwitchMaxUnbalancedSlots : null;
            const availableSwitchSlots = this.getSwitchSlotsPerTeam(teamID, effectiveCap);

            // Enhanced logging: show current team and target team
            const targetTeam = teamID === 1 ? 2 : 1;
            let teamPlayerCount = [null, 0, 0];
            for (let p of this.server.players) {
                teamPlayerCount[+p.teamID]++;
            }
            const balanceDiff = teamPlayerCount[1] - teamPlayerCount[2];
            const effectiveMaxSlots = effectiveCap !== null ? effectiveCap : this.options.maxUnbalancedSlots;

            this.verbose(1, playerName, 'requested a switch');
            this.verbose(1, `[Current Team] ${playerName} is on Team ${teamID}, switching to Team ${targetTeam}`);
            this.verbose(1, `[Team Counts] Team 1: ${teamPlayerCount[1]} | Team 2: ${teamPlayerCount[2]} | Balance Diff: ${balanceDiff}`);
            this.verbose(1, `[Switch Slots] Max Unbalance Cap: ${effectiveMaxSlots} | Available Slots: ${availableSwitchSlots}`);
            if (isLiberal) {
                this.verbose(1, `[Liberal Mode] ${playerName} - relaxed switch restrictions active (Seed/Jensen).`);
            }

            const cooldownData = await this.models.PlayerCooldowns.findByPk(steamID);

            // Scramble lockdown is ALWAYS enforced, regardless of mode
            if (cooldownData && cooldownData.scrambleLockdownExpiry && new Date() < cooldownData.scrambleLockdownExpiry) {
                const remaining = Math.ceil((cooldownData.scrambleLockdownExpiry - Date.now()) / 60000);
                this.warn(steamID, `Scramble Lock: Cannot switch for ${remaining}m.`);
                this.verbose(1, `[Switch] Denied ${playerName}: Scramble lockdown active.`);
                return;
            }

            // Time window check - SKIPPED in liberal mode
            if (!isLiberal) {
                if (connectionSeconds / 60 > this.options.switchEnabledMinutes && this.getSecondsFromMatchStart() / 60 > this.options.switchEnabledMinutes) {
                    this.warn(steamID, `Time Limit: Switch allowed only in first ${this.options.switchEnabledMinutes}m of join/match.`);
                    this.verbose(1, `[Switch] Denied ${playerName}: Match time limit exceeded.`);
                    return;
                }
            }

            // Cooldown check - SKIPPED in liberal mode
            if (!isLiberal) {
                const cooldownDuration = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;

                if (cooldownData && cooldownData.lastSwitchTimestamp &&
                    (Date.now() - new Date(cooldownData.lastSwitchTimestamp).getTime()) < cooldownDuration) {
                    const remaining = Math.ceil((cooldownDuration - (Date.now() - new Date(cooldownData.lastSwitchTimestamp).getTime())) / 60000);
                    this.warn(steamID, `Cooldown: Please wait ${remaining}m.`);
                    this.verbose(1, `[Switch] Denied ${playerName}: Cooldown active.`);
                    return;
                }
            }

            // Balance check (applies to both modes, but uses different cap)
            if (availableSwitchSlots <= 0) {
                this.warn(steamID, `Balance Limit: Teams would become too unbalanced.`);
                this.verbose(1, `[Switch] Denied ${playerName}: Teams unbalanced.`);
                return;
            }

             let switchSuccess = false;
             try {
                 await this._taggedSwitchPlayer(steamID, 'Player-Self');
                 switchSuccess = true;
             } catch (err) {
                if (err.message && (err.message.toLowerCase().includes('timeout') || err.message.toLowerCase().includes('timed out'))) {
                    this.verbose(1, `[Switch] RCON timeout for ${playerName}, verifying switch status...`);
                    await delay(3000);
                    await this.server.updatePlayerList();
                    const currentPlayer = this.server.players.find(p => p.steamID === steamID);

                    if (currentPlayer && currentPlayer.teamID !== teamID) {
                        this.verbose(1, `[Switch] Verified: ${playerName} switched from Team ${teamID} to Team ${currentPlayer.teamID}`);
                        switchSuccess = true;
                    } else {
                        this.verbose(1, `[Switch] Verified: ${playerName} switch failed (${currentPlayer ? `still on Team ${teamID}` : 'player disconnected'})`);
                        this.warn(steamID, "Team switch failed. Please try again or contact an admin.");
                    }
                } else {
                    this.verbose(1, `Error executing switch: ${err.message}`);
                    this.warn(steamID, "Team switch failed. Please try again or contact an admin.");
                }
            }

            if (switchSuccess) {
                // In liberal mode, don't write cooldown timestamp (no cooldown enforcement)
                // In normal mode, write cooldown timestamp for next switch throttling
                if (!isLiberal) {
                    try {
                        await this.safeTransaction(async (t) => {
                            await this.models.PlayerCooldowns.upsert({ steamID, playerName, lastSwitchTimestamp: new Date() }, { transaction: t });
                        });
                    } catch (dbErr) {
                        this.verbose(1, `[Switch] Database update failed: ${dbErr.message}`);
                    }
                }
                
                this.verbose(1, `[Switch] Executed for ${playerName}.`);
            }
        }
        } catch (err) {
            this.verbose(1, `Error in onChatMessage: ${err.stack}`);
        }
    }

     async doSwitchMatchend() {
         const players = await this.models.Endmatch.findAll();
         if (players.length == 0) return;
         players.forEach((pl) => {
             this.warn(pl.steamID, 'Match End: You will be switched in 15 seconds.');
         });
         await delay(15 * 1000);
         await Promise.all(players.map(async (pl) => {
             await this._taggedSwitchPlayer(pl.steamID, 'Admin-Force');
             return await this.models.Endmatch.destroy({
                 where: {
                     id: pl.id
                 }
             });
         }));
     }

    async onRoundEnded(dt) {
        await this.cleanup();
        await this.doSwitchMatchend();
        // Clear trackers to prevent cross-match exploits (but keep _knownConnectedPlayers for continuity)
        this.recentDisconnections = {};
        this._switchedOnJoin.clear();
        // Do NOT clear _knownConnectedPlayers — keep state across rounds per §5 resilient pattern
        // Do NOT manually flip teamID — trust UPDATED_PLAYER_INFORMATION + PLAYER_TEAM_CHANGE
    }

    getTeamBalanceDifference() {
        let teamPlayerCount = [ null, 0, 0 ];
        for (let p of this.server.players)
            teamPlayerCount[ +p.teamID ]++;
        const balanceDiff = teamPlayerCount[ 1 ] - teamPlayerCount[ 2 ];

        this.verbose(1, `Balance diff: ${balanceDiff}`, teamPlayerCount);
        return balanceDiff;
    }

    /**
     * HELPER: Detect if we're in a liberal switching mode (Seed/Jensen).
     * Checks both cached layer name and gamemode against the liberal modes list.
     */
    isLiberalMode() {
        const checkLayer = (this.currentLayerName || '').toLowerCase();
        const checkMode = (this.currentGamemode || '').toLowerCase();
        return this._liberalModes.some(m => checkLayer.includes(m) || checkMode.includes(m));
    }

    /**
     * HELPER: Compute dynamic extra tolerance slots based on current player count.
     * Interpolates linearly between floor (full extra slots) and 98 players (no extra slots).
     * Uses Math.round for smooth transitions.
     */
    getDynamicExtraSlots() {
        if (!this.options.dynamicBalanceTolerance) return 0;

        const UPPER_BOUND = 98;
        const floor = this.options.dynamicBalancePlayerFloor;
        const extra = this.options.dynamicBalanceExtraSlots;

        let totalPlayers = 0;
        for (let p of this.server.players) totalPlayers++;

        // At or above upper bound: no extra tolerance
        if (totalPlayers >= UPPER_BOUND) return 0;
        
        // At or below floor: full extra tolerance
        if (totalPlayers <= floor) return extra;
        
        // Between floor and upper bound: linearly interpolate with Math.round
        const interpolated = extra * (UPPER_BOUND - totalPlayers) / (UPPER_BOUND - floor);
        return Math.round(interpolated);
    }

     /**
      * UPDATED: getSwitchSlotsPerTeam with optional cap parameter.
      * If effectiveCap is provided, uses it instead of maxUnbalancedSlots.
      * Applies dynamic balance tolerance if enabled (interpolated extra slots).
      * Also respects the 50v50 ceiling: never lets a team exceed 50 players.
      */
     getSwitchSlotsPerTeam(teamID, effectiveCap = null) {
         const balanceDifference = this.getTeamBalanceDifference();
         let cap = effectiveCap !== null ? effectiveCap : this.options.maxUnbalancedSlots;
         
         // Apply dynamic extra tolerance if enabled
         const dynamicExtra = this.getDynamicExtraSlots();
         if (dynamicExtra > 0) {
             cap += dynamicExtra;
             this.verbose(2, `[Dynamic Balance] Total players: ${this.server.players.length} | Extra slots: +${dynamicExtra} | Effective cap: ${cap}`);
         }
         
         let slots = cap - (teamID == 1 ? -balanceDifference : balanceDifference);

         // Apply 50v50 ceiling: if receiving team would exceed 50, clamp slots to prevent it
         let teamPlayerCount = [null, 0, 0];
         for (let p of this.server.players)
             teamPlayerCount[+p.teamID]++;

         const receivingTeamSize = teamPlayerCount[teamID == 1 ? 2 : 1] || 0;
         if (receivingTeamSize + slots > 50) {
             slots = Math.max(0, 50 - receivingTeamSize);
         }

         return slots;
     }

    /**
     * EVENT: UPDATED_LAYER_INFORMATION (Layer Sync)
     * Maintains currentLayerName and currentGamemode for liberal mode detection.
     */
    async onUpdatedLayerInfo() {
        const name = this.server.currentLayer?.name || null;
        const mode = this.server.currentLayer?.gamemode || null;

        if (name) {
            this.currentLayerName = name;
            this.currentGamemode = mode;
            this.verbose(1, `[Layer] Updated layer cache: ${name} (${mode})`);
        }
    }

    /**
     * EVENT: UPDATED_SERVER_INFORMATION (Secondary Layer Resolution)
     * Provides a backup path if UPDATED_LAYER_INFORMATION misses the update.
     */
    async onServerInfoUpdated(info) {
        try {
            if (info && info.currentLayer) {
                const incomingName = typeof info.currentLayer === 'string'
                    ? info.currentLayer
                    : info.currentLayer?.name;

                if (incomingName) {
                    this.currentLayerName = incomingName;
                    if (typeof info.currentLayer === 'object' && info.currentLayer.gamemode) {
                        this.currentGamemode = info.currentLayer.gamemode;
                    }
                    this.verbose(1, `[Layer] Updated from server info: ${incomingName}`);
                }
            }
        } catch (err) {
            this.verbose(1, `[onServerInfoUpdated] Error resolving layer: ${err?.message}`);
        }
    }

    async getSecondsFromJoin(steamID) {
        // 1. Check in-memory first
        let joinTime = this.playersConnectionTime[steamID];

        // 2. Check DB if memory is empty (e.g. after restart)
        if (!joinTime) {
            const record = await this.models.PlayerCooldowns.findByPk(steamID);
            if (record && record.firstSeenTimestamp) {
                joinTime = new Date(record.firstSeenTimestamp).getTime();
                this.playersConnectionTime[steamID] = joinTime; // Hydrate memory
            }
        }

        return joinTime ? (Date.now() - joinTime) / 1000 : 0;
    }

    getSecondsFromMatchStart() {
        return (Date.now() - +this.server.layerHistory[ 0 ].time) / 1000 || 0;
    }

    async onUpdatedPlayerInfo(info) {
        if (!this.server.players) return;
        
        // Skip processing if null-teamID window is active (per §3 of reference doc)
        if (this._nullTeamIDWindowActive) {
            const anyNull = this.server.players.some(p => p.teamID === null);
            if (anyNull) return; // Still in transition, skip this poll
            // Window is over, clear flag and proceed
            this._nullTeamIDWindowActive = false;
            clearTimeout(this._nullTeamIDWindowTimeout);
        }
        
        const currentSteamIDs = new Set(this.server.players.map(p => p.steamID).filter(Boolean));
        
        // Add new players to known map & perform first-seen registration (Issue 1b)
        for (const p of this.server.players) {
            if (p.steamID && !this._knownConnectedPlayers.has(p.steamID)) {
                // NEW PLAYER DETECTED — perform first-seen registration
                const now = Date.now();
                if (!this.playersConnectionTime[p.steamID]) {
                    this.playersConnectionTime[p.steamID] = now;
                    // Persist to DB
                    try {
                        await this.safeTransaction(async (t) => {
                            await this.models.PlayerCooldowns.upsert({
                                steamID: p.steamID,
                                playerName: p.name,
                                firstSeenTimestamp: new Date(now)
                            }, { transaction: t });
                        });
                    } catch (err) {
                        this.verbose(1, `Failed to persist join time for ${p.name} (detected via UPDATED_PLAYER_INFORMATION): ${err.message}`);
                    }
                    
                    // Mark that we've triggered switchToPreDisconnectionTeam for this player
                    if (!this._switchedOnJoin.has(p.steamID)) {
                        this._switchedOnJoin.add(p.steamID);
                        // Trigger switchToPreDisconnectionTeam if applicable
                        if (this.options.switchToOldTeamAfterRejoin) {
                            const preDisconnectionData = this.recentDisconnections[p.steamID];
                            if (preDisconnectionData) {
                                // Schedule it for later to avoid race with onPlayerConnected
                                setTimeout(() => {
                                    this.switchToPreDisconnectionTeam({ player: p });
                                }, 100);
                            }
                        }
                    }
                }
                this._knownConnectedPlayers.set(p.steamID, { teamID: p.teamID, name: p.name });
            } else if (p.steamID) {
                // UPDATE — only update teamID if it's NOT null (per §3, skip null-teamID updates)
                const existing = this._knownConnectedPlayers.get(p.steamID);
                if (p.teamID !== null) {
                    existing.teamID = p.teamID;
                    existing.name = p.name;
                }
            }
        }

        // Detect leaves
        for (const [steamID, data] of this._knownConnectedPlayers.entries()) {
            if (!currentSteamIDs.has(steamID)) {
                this._knownConnectedPlayers.delete(steamID);
                this.handlePlayerLeave(steamID, data.teamID, data.name);
            }
        }
    }

    handlePlayerLeave(steamID, teamID, playerName) {
        this.verbose(1, `Player disconnected ${playerName}`);
        this.recentDisconnections[steamID] = { teamID: teamID, time: new Date() };
        
        const cutoff = Date.now() - (20 * 60 * 1000); // 20-minute retention
        for (const key in this.recentDisconnections) {
            if (this.recentDisconnections[key].time.getTime() < cutoff) delete this.recentDisconnections[key];
        }
        this.recentDoubleSwitches = this.recentDoubleSwitches.filter(p => p.steamID != steamID);
    }

    async onPlayerConnected(info) {
        if (!info?.player?.steamID) return; // Early return guard
        
        const steamID = info.player.steamID;
        const playerName = info.player.name;
        const teamID = info.player.teamID;

        this.verbose(1, `Player connected ${playerName}`);
        const now = Date.now();

        // Issue 5: Guard against double-registration if onUpdatedPlayerInfo already processed
        // onUpdatedPlayerInfo may have already registered this player and called switchToPreDisconnectionTeam
        const alreadyRegistered = this.playersConnectionTime[steamID] && this._switchedOnJoin.has(steamID);
        if (alreadyRegistered) {
            this.verbose(1, `[Rejoin] ${playerName} already registered via UPDATED_PLAYER_INFORMATION, skipping double-registration.`);
            return;
        }

        // Check for exploit-resistant rejoin logic
        const preDisconnectionData = this.recentDisconnections[steamID];
        const disconnectionValid = preDisconnectionData && (Date.now() - preDisconnectionData.time.getTime()) < (20 * 60 * 1000);

        if (disconnectionValid) {
            // Retain join time across any short-term disconnection, regardless of team assignment
            if (!this.playersConnectionTime[steamID]) {
                try {
                    const record = await this.models.PlayerCooldowns.findByPk(steamID);
                    if (record && record.firstSeenTimestamp) {
                        this.playersConnectionTime[steamID] = new Date(record.firstSeenTimestamp).getTime();
                        this.verbose(1, `[Rejoin] ${playerName} retained join time from pre-disconnection.`);
                    } else {
                        this.playersConnectionTime[steamID] = now;
                    }
                } catch (err) {
                    this.verbose(1, `Failed to hydrate join time for ${playerName}: ${err.message}`);
                    this.playersConnectionTime[steamID] = now;
                }
            }
            // Do NOT overwrite firstSeenTimestamp in the database here
        } else {
            // Reset join time (completely new session or 20 minutes expired)
            this.playersConnectionTime[steamID] = now;
            
            try {
                await this.safeTransaction(async (t) => {
                    await this.models.PlayerCooldowns.upsert({
                        steamID,
                        playerName,
                        firstSeenTimestamp: new Date(now)
                    }, { transaction: t });
                });
            } catch (err) {
                this.verbose(1, `Failed to persist join time for ${playerName}: ${err.message}`);
            }
        }

        // Mark that we've handled switchToPreDisconnectionTeam for this player
        if (!this._switchedOnJoin.has(steamID)) {
            this._switchedOnJoin.add(steamID);
            this.switchToPreDisconnectionTeam(info);
        }
    }

    async switchToPreDisconnectionTeam(info) {
        if (!this.options.switchToOldTeamAfterRejoin) return;

        const steamID = info.player?.steamID;
        if (!info.player) return;
        const playerName = info.player?.name;
        const teamID = info.player?.teamID;

        const preDisconnectionData = this.recentDisconnections[ steamID ];
        if (!preDisconnectionData) return;

        const needSwitch = teamID != preDisconnectionData.teamID;
        this.verbose(1, `${playerName}: Switching to old team: ${needSwitch}`);

        if (Date.now() - preDisconnectionData.time > 60 * 60 * 1000) return;

         if (needSwitch) {
             setTimeout(() => {
                 this._taggedSwitchPlayer(steamID, 'Switch-Rejoin').catch(err => {
                     this.verbose(1, `Error auto-switching ${playerName} to old team: ${err.message}`);
                 });
             }, 5000)
         }
    }

     async doubleSwitchPlayer(steamID, forced = false, senderSteamID) {
         const recentSwitch = this.recentDoubleSwitches.find(e => e.steamID == steamID);
         const cooldownHoursLeft = (Date.now() - +recentSwitch?.datetime) / (60 * 60 * 1000);

         if (!forced) {
             const joinSeconds = await this.getSecondsFromJoin(steamID);
             if (joinSeconds / 60 > this.options.doubleSwitchEnabledMinutes && this.getSecondsFromMatchStart() / 60 > this.options.doubleSwitchEnabledMinutes) {
                 this.warn(steamID, `Time Limit: Double switch allowed only in first ${this.options.doubleSwitchEnabledMinutes}m of join/match.`);
                 return;
             }

             if (recentSwitch && cooldownHoursLeft < this.options.doubleSwitchCooldownHours) {
                 this.warn(steamID, `Cooldown: Double switch used recently. Wait ${this.options.doubleSwitchCooldownHours}h.`);
                 return;
             }

             if (recentSwitch)
                 recentSwitch.datetime = new Date();
             else
                 this.recentDoubleSwitches.push({ steamID: steamID, datetime: new Date() });
         }

         try {
             await this._taggedSwitchPlayer(steamID, 'Switch-Double-Swap');
             await delay(this.options.doubleSwitchDelaySeconds * 1000);
             await this._taggedSwitchPlayer(steamID, 'Switch-Double-Swap');

             if (forced && senderSteamID) this.warn(senderSteamID, `Player has been double-switched.`);
         } catch (err) {
             this.verbose(1, `Double switch failed for ${steamID}: ${err.message}`);
             if (forced && senderSteamID) {
                 this.warn(senderSteamID, `Double switch failed: ${err.message}`);
             }
         }
     }

     async switchSquad(number, team) {
         const players = this.getPlayersFromSquad(number, team);
         if (!players) return;
         for (let p of players) {
             try {
                 await this._taggedSwitchPlayer(p.steamID, 'Admin-Force');
             } catch (err) {
                 this.verbose(1, `Failed to switch squad member ${p.name}: ${err.message}`);
             }
         }
     }

    getPlayersFromSquad(number, team) {
        let team_id = null;

        if (+team >= 0) team_id = +team;
        else team_id = this.getFactionId(team);

        if (!team_id) {
            this.verbose(1, "Could not find a faction from:", team);
            return;
        }
        return this.server.players.filter((p) => p.teamID == team_id && p.squadID == number)
    }

     async doubleSwitchSquad(number, team) {
         const players = this.getPlayersFromSquad(number, team);
         if (!players) return;
         
         for (let p of players) {
             try {
                 await this._taggedSwitchPlayer(p.steamID, 'Switch-Double-Swap');
             } catch (err) {
                 this.verbose(1, `First double-switch hop failed for ${p.name}: ${err.message}`);
             }
         }
         
         await delay(this.options.doubleSwitchDelaySeconds * 1000);
         
         for (let p of players) {
             try {
                 await this._taggedSwitchPlayer(p.steamID, 'Switch-Double-Swap');
             } catch (err) {
                 this.verbose(1, `Second double-switch hop failed for ${p.name}: ${err.message}`);
             }
         }
     }

    async addSquadToMatchendSwitches(number, team) {
        const players = this.getPlayersFromSquad(number, team);
        if (!players) return;
        for (let p of players) {
            await this.models.Endmatch.create({
                name: p.name,
                steamID: p.steamID,
            });
        }
    }

    async addPlayerToMatchendSwitches(player) {
        await this.models.Endmatch.create({
            name: player.name,
            steamID: player.steamID,
        });
    }

    getFactionId(team) {
        const firstPlayer = this.server.players.find(p => p.role.toLowerCase().startsWith(team.toLowerCase()));
        if (firstPlayer) return firstPlayer.teamID;

        return null;
    }

    /**
     * Records the source of a player switch and emits attribution event BEFORE RCON execution.
     * Automatically computes the target team (opposite of current team).
     * Sources: 'Player-Self', 'Admin-Force', 'Switch-Double-Swap', 'Switch-Rejoin'
     * 
     * CRITICAL: Event is emitted BEFORE RCON fires to ensure SmartAssign's _externalMoveMap
     * is populated before UPDATED_PLAYER_INFORMATION polling detects the team change.
     */
    async _taggedSwitchPlayer(steamID, source) {
        const executionTimestamp = Date.now();
        
        // Compute target team (opposite of current)
        const player = this.server.players.find(p => p.steamID === steamID);
        if (!player) {
          this.verbose(1, `[Switch] WARNING: Player with steamID ${steamID} not found in server.players for source=${source}`);
          return null;
        }
        
        const currentTeam = player?.teamID;
        const currentTeamNum = Number(currentTeam);
        const targetTeam = currentTeamNum === 1 ? 2 : currentTeamNum === 2 ? 1 : null;
        
        this.verbose(2, `[Switch] EXECUTING: player=${player.name} (${steamID}), source=${source}, currentTeam=${currentTeam}, targetTeam=${targetTeam}, timestamp=${executionTimestamp}`);
        
        // Guard against null team ID
        if (targetTeam === null) {
          this.verbose(1, `[Switch] ERROR: Cannot switch player ${player.name} - currentTeam is null or invalid (value=${currentTeam})`);
          return null;
        }
        
        // ═════════════════════════════════════════════════════════════════════════════
        // EMIT BEFORE RCON: Attribution event must reach SmartAssign's _externalMoveMap
        // BEFORE the team change is detected by UPDATED_PLAYER_INFORMATION polling.
        // ═════════════════════════════════════════════════════════════════════════════
        this.verbose(1, `[Attribution] SWITCH emitting PLAYER_MOVED_BY_PLUGIN: player=${player.name} (${steamID}), sourceTeam=${currentTeam}, targetTeam=${targetTeam}, source='${source}'`);
        this.server.emit('PLAYER_MOVED_BY_PLUGIN', {
            eosID: player.eosID,
            steamID,
            name: player.name,
            sourceTeamID: currentTeam,
            targetTeamID: targetTeam,
            source: source,
            timestamp: executionTimestamp
        });
        this.verbose(2, `[Switch] EVENT EMITTED: PLAYER_MOVED_BY_PLUGIN registered for attribution (TTL=30s)`);
        
        try {
            const result = await this.server.rcon.execute(`AdminForceTeamChange ${steamID}`);
            this.verbose(3, `[Switch] RCON SUCCESS: AdminForceTeamChange returned for ${steamID}`);
            return result;
        } catch (err) {
            this.verbose(1, `[Switch] ERROR: AdminForceTeamChange failed for ${player.name} (${steamID}): ${err.message}`);
            throw err;
        }
    }

    switchPlayer(steamID) {
        return this.server.rcon.execute(`AdminForceTeamChange ${steamID}`);
    }

    onNewGame() {
        // Issue 6: Set null-teamID window flag at NEW_GAME (per §3 of reference doc)
        this._nullTeamIDWindowActive = true;
        clearTimeout(this._nullTeamIDWindowTimeout);
        // Set safety fallback: clear flag after 60 seconds if not cleared by UPDATED_PLAYER_INFORMATION
        this._nullTeamIDWindowTimeout = setTimeout(() => {
            this._nullTeamIDWindowActive = false;
            this.verbose(1, '[NEW_GAME] Null-teamID window safety timeout triggered.');
        }, 60_000);
        
        // Clear layer cache for new round (will be populated by UPDATED_LAYER_INFORMATION)
        this.currentLayerName = null;
        this.currentGamemode = null;
        
        this.verbose(1, '[NEW_GAME] Null-teamID window opened (players may have null teamID for up to 30s).');
    }

    async unmount() {
        this.server.removeListener('CHAT_MESSAGE', this.onChatMessage);
        this.server.removeListener('PLAYER_CONNECTED', this.onPlayerConnected);
        this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo);
        this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
        this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
        this.server.removeListener('NEW_GAME', this.onNewGame.bind(this));
        this.server.removeListener('UPDATED_LAYER_INFORMATION', this.onUpdatedLayerInfo.bind(this));
        this.server.removeListener('UPDATED_SERVER_INFORMATION', this.onServerInfoUpdated.bind(this));
        if (this.options.discordClient) this.options.discordClient.removeListener('message', this.onDiscordMessage);
        clearTimeout(this._nullTeamIDWindowTimeout);
        this.verbose(1, 'Switch plugin was un-mounted.');
    }

    getPlayersByUsername(username) {
        return this.server.players.filter(p =>
            p.name.toLowerCase().includes(username.toLowerCase())
        );
    }
    getPlayerBySteamID(steamID) {
        return this.server.players.find(p => p.steamID == steamID);
    }

    getPlayerByUsernameOrSteamID(steamID, ident) {
        let ret = null;

        ret = this.getPlayerBySteamID(ident);
        if (ret) return ret;

        ret = this.getPlayersByUsername(ident);
        if (ret.length == 0) {
            this.warn(steamID, `No player found matching: "${ident}"`);
            return;
        }
        if (ret.length > 1) {
            this.warn(steamID, `Multiple players match "${ident}". Use SteamID.`);
            return;
        }

        return ret[ 0 ];
    }

    async cleanup() {
        const switchCooldownMs = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
        const now = new Date();
        const switchCutoff = new Date(now.getTime() - switchCooldownMs);

        try {
            await this.safeTransaction(async (t) => {
                await this.models.PlayerCooldowns.destroy({
                    where: {
                        [Op.and]: [
                            { 
                                [Op.or]: [
                                    { scrambleLockdownExpiry: null },
                                    { scrambleLockdownExpiry: { [Op.lt]: now } }
                                ]
                            },
                            {
                                [Op.or]: [
                                    { lastSwitchTimestamp: null },
                                    { lastSwitchTimestamp: { [Op.lt]: switchCutoff } }
                                ]
                            },
                            // IMPORTANT: Keep join time if player is still likely on server or joined recently
                            {
                                [Op.or]: [
                                    { firstSeenTimestamp: null },
                                    { firstSeenTimestamp: { [Op.lt]: new Date(now.getTime() - (24 * 60 * 60 * 1000)) } } // Delete if older than 24h
                                ]
                            }
                        ]
                    },
                    transaction: t
                });
            });

            const currentSteamIDs = this.server.players.map(p => p.steamID);
    
            for (const steamID in this.playersConnectionTime) {
                if (!currentSteamIDs.includes(steamID)) {
                    delete this.playersConnectionTime[steamID];
                }
            }

            for (const steamID in this.recentDisconnections) {
                if (!currentSteamIDs.includes(steamID)) {
                    // Only delete if they've been gone beyond 20-minute retention
                    if (Date.now() - this.recentDisconnections[steamID].time > 20 * 60 * 1000) {
                        delete this.recentDisconnections[steamID];
                    }
                }
            }
        } catch (err) {
            this.verbose(1, `Cleanup error: ${err.message}`);
        }
    }

    async checkPlayer(ident) {
        let record = await this.models.PlayerCooldowns.findByPk(ident);
        if (record) return record;

        const records = await this.models.PlayerCooldowns.findAll({
            where: {
                playerName: { [Op.like]: `%${ident}%` }
            }
        });

        if (records.length === 0) return null;
        if (records.length > 1) return 'multiple';
        return records[0];
    }

    async onScrambleExecuted(data) {
        const { affectedPlayers } = data;
        if (!affectedPlayers || affectedPlayers.length === 0) return;

        const lockdownDuration = this.options.scrambleLockdownDurationMinutes * 60 * 1000;
        const expiry = new Date(Date.now() + lockdownDuration);

        const records = affectedPlayers.map(p => {
            if (typeof p === 'string') return { steamID: p, scrambleLockdownExpiry: expiry };
            return { steamID: p.steamID, playerName: p.name, scrambleLockdownExpiry: expiry };
        });

        try {
            await this.safeTransaction(async (t) => {
                const chunkSize = 10;
                for (let i = 0; i < records.length; i += chunkSize) {
                    await this.models.PlayerCooldowns.bulkCreate(records.slice(i, i + chunkSize), {
                        updateOnDuplicate: ['scrambleLockdownExpiry', 'playerName'],
                        transaction: t
                    });
                }
            });
            this.verbose(1, `Switch lockdown active for ${records.length} players until ${expiry.toISOString()}.`);
        } catch (err) {
            this.verbose(1, `Error updating scramble lockdown: ${err.message}`);
        }
    }

    async getDiagnosticInfo() {
        let dbStatus = 'Error';
        let activeLocks = 0;
        let totalStoredPlayers = 0;

        try {
            await this.options.database.authenticate();
            dbStatus = 'Connected';
            totalStoredPlayers = await this.models.PlayerCooldowns.count();
            
            const cooldownDurationMs = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
            const cooldownCutoff = new Date(Date.now() - cooldownDurationMs);

            activeLocks = await this.models.PlayerCooldowns.count({
                where: {
                    [Op.or]: [
                        { scrambleLockdownExpiry: { [Op.gt]: new Date() } },
                        { lastSwitchTimestamp: { [Op.gt]: cooldownCutoff } }
                    ]
                }
            });
        } catch (e) {
            dbStatus = `Error: ${e.message}`;
        }
        return { dbStatus, activeLocks, totalStoredPlayers };
    }

    async onDiscordMessage(message) {
        if (message.author.bot) return;
        if (this.options.channelID && message.channel.id !== this.options.channelID) return;
        
        const content = message.content.trim();
        const args = content.split(' ');
        const command = args[0].toLowerCase();
        const subCommand = args[1] ? args[1].toLowerCase() : null;

        if (command !== '!switch') return;

        if (subCommand === 'diag') {
            let dbStatus = 'Error';
            let rconLatency = 'N/A';
            let standardCooldowns = 0;
            let scrambleLocks = 0;
            let playerList = 'None';

            try {
                await this.options.database.authenticate();
                dbStatus = 'Connected';

                const start = Date.now();
                await this.server.rcon.execute('ListPlayers');
                rconLatency = `${Date.now() - start}ms`;

                const now = new Date();
                const cooldownDurationMs = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
                const cooldownCutoff = new Date(now.getTime() - cooldownDurationMs);

                standardCooldowns = await this.models.PlayerCooldowns.count({
                    where: {
                        lastSwitchTimestamp: { [Op.gt]: cooldownCutoff }
                    }
                });

                scrambleLocks = await this.models.PlayerCooldowns.count({
                    where: {
                        scrambleLockdownExpiry: { [Op.gt]: now }
                    }
                });

                const lockedPlayers = await this.models.PlayerCooldowns.findAll({
                    where: {
                        [Op.or]: [
                            { scrambleLockdownExpiry: { [Op.gt]: now } },
                            { lastSwitchTimestamp: { [Op.gt]: cooldownCutoff } }
                        ]
                    },
                    order: [['scrambleLockdownExpiry', 'DESC'], ['lastSwitchTimestamp', 'DESC']],
                    limit: 10
                });

                if (lockedPlayers.length > 0) {
                    playerList = lockedPlayers.map(p => {
                        const parts = [];
                        if (p.scrambleLockdownExpiry && p.scrambleLockdownExpiry > now) {
                            parts.push(`🌪️ <t:${Math.floor(p.scrambleLockdownExpiry.getTime() / 1000)}:R>`);
                        }
                        if (p.lastSwitchTimestamp && new Date(p.lastSwitchTimestamp.getTime() + cooldownDurationMs) > now) {
                            const expiry = new Date(p.lastSwitchTimestamp.getTime() + cooldownDurationMs);
                            parts.push(`⏳ <t:${Math.floor(expiry.getTime() / 1000)}:R>`);
                        }
                        return `**${p.playerName || p.steamID}**: ${parts.join(' ')}`;
                    }).join('\n');
                }
            } catch (err) {
                dbStatus = `Error: ${err.message}`;
            }

            const embed = {
                title: '🖥️ Switch Plugin System Diagnostics',
                color: 0x3498db,
                fields: [
                    { name: 'System Health', value: `**Database:** ${dbStatus}\n**RCON Latency:** ${rconLatency}`, inline: false },
                    { name: 'Cooldown Statistics', value: `**Standard Cooldowns:** ${standardCooldowns}\n**Scramble Locks:** ${scrambleLocks}`, inline: false },
                    { name: 'Active Locks (Top 10)', value: playerList, inline: false }
                ]
            };
            await this.sendDiscordMessage({ channel: message.channel, embed });
        } else if (subCommand === 'check') {
            const ident = args.slice(2).join(' ');
            if (!ident) {
                await this.safeDiscordReply(message, 'Usage: `!switch check <SteamID|Name>`');
                return;
            }
            const result = await this.checkPlayer(ident);
            if (!result) {
                await this.safeDiscordReply(message, 'Player not found in database.');
            } else if (result === 'multiple') {
                await this.safeDiscordReply(message, '⚠️ Ambiguous result: Multiple matches found. Please refine your search string or use a SteamID.');
            } else {
                const now = new Date();
                let desc = `**SteamID:** ${result.steamID}\n**Name:** ${result.playerName || 'Unknown'}\n`;
                
                if (result.scrambleLockdownExpiry && result.scrambleLockdownExpiry > now) {
                    desc += `🔴 **Scramble Lock:** <t:${Math.floor(result.scrambleLockdownExpiry.getTime()/1000)}:R>\n`;
                } else {
                    desc += `🟢 **Scramble Lock:** None\n`;
                }

                if (result.lastSwitchTimestamp) {
                    const cooldownDuration = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
                    const nextSwitch = new Date(result.lastSwitchTimestamp.getTime() + cooldownDuration);
                    if (nextSwitch > now) {
                        desc += `🔴 **Switch Cooldown:** <t:${Math.floor(nextSwitch.getTime()/1000)}:R>\n`;
                    } else {
                        desc += `🟢 **Switch Cooldown:** Ready\n`;
                    }
                } else {
                    desc += `🟢 **Switch Cooldown:** Ready\n`;
                } 
            
                // Add First Seen to Discord check
                if (result.firstSeenTimestamp) {
                    desc += `⏱️ **Joined:** <t:${Math.floor(new Date(result.firstSeenTimestamp).getTime()/1000)}:f>\n`;
                }

                await this.sendDiscordMessage({ channel: message.channel, embed: { title: '🔍 Player Status', description: desc, color: 0x3498db } });
            }
        } else if (subCommand === 'clear') {
            const ident = args.slice(2).join(' ');
            if (!ident) {
                await this.safeDiscordReply(message, 'Usage: `!switch clear <SteamID|Name>`');
                return;
            }
            const result = await this.checkPlayer(ident);
            if (!result || result === 'multiple') {
                await this.safeDiscordReply(message, 'Player not found or multiple matches.');
                return;
            }
            await this.safeTransaction(async (t) => {
                await this.models.PlayerCooldowns.destroy({ where: { steamID: result.steamID }, transaction: t });
            });
            await this.safeDiscordReply(message, `✅ Cleared cooldowns for **${result.playerName || result.steamID}**.`);
        } else if (subCommand === 'clearall') {
            await this.safeTransaction(async (t) => {
                await this.models.PlayerCooldowns.destroy({ where: {}, truncate: true, transaction: t });
            });
            await this.safeDiscordReply(message, '🗑️ All player cooldowns cleared.');
        } else if (subCommand === 'help') {
            const embed = {
                title: '📜 Switch Plugin Commands',
                description: 'Available commands:',
                fields: [
                    { name: '!switch diag', value: 'Show database diagnostics and active locks.' },
                    { name: '!switch check <ident>', value: 'Check cooldown status for a player.' },
                    { name: '!switch clear <ident>', value: 'Clear cooldowns for a specific player.' },
                    { name: '!switch clearall', value: 'Clear all player cooldowns.' },
                    { name: '!switch help', value: 'Show this help message.' }
                ]
            };
            await this.sendDiscordMessage({ channel: message.channel, embed });
        }
    }
}