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
        this._checkSwitchEligibility = this._checkSwitchEligibility.bind(this);
        this.onSAEvalStart = this.onSAEvalStart.bind(this);
        this.onSAEvalEnd = this.onSAEvalEnd.bind(this);

        this.playersConnectionTime = {};
        this.recentSwitches = [];
        this.recentDoubleSwitches = [];
        this.recentDisconnections = {};
        this._knownConnectedPlayers = new Map(); // eosID → { teamID, name, steamID }
        this._switchQueue = new Map();      // eosID → { eosID, steamID, playerName, teamID, queuedAt, warnInterval }
        this._lastTeamSnapshot = null;      // { t1: number, t2: number } — previous poll's team counts for stability check
        this._switchedOnJoin = new Set();
        this._nullTeamIDWindowActive = false;
        this._nullTeamIDWindowTimeout = null;
        this._saEvalLocks = new Map();
        this._queuePollInterval = null;     // Fast-poll interval for queue processing
        this._lastQueuePollTime = 0;        // Track last poll time for debounce
        this._queueProcessing = false;      // Re-entrancy guard for _processQueue
        this._s3 = null;                    // Reference to SlackersSquadServices (runtime discovery)
        
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
            eosID: {
                type: DataTypes.STRING,
                primaryKey: true,
                allowNull: false
            },
            steamID: {
                type: DataTypes.STRING,
                allowNull: true
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

    _resolveS3() {
        if (!this.server.plugins) {
            this.verbose(1, '[S3] server.plugins not available — S³ discovery deferred.');
            return;
        }
        const s3 = this.server.plugins.find(p => p.constructor.name === 'SlackersSquadServices');
        if (s3) {
            // Runtime discovery matches the TB→EloTracker pattern
            // (ReferenceScripts/squadjs-team-balancer/plugins/team-balancer.js uses
            //  this.server.plugins.find(p => p.constructor.name === 'EloTracker'))
            this._s3 = s3;
            this.verbose(1, '[S3] Discovered SlackersSquadServices for Switch.');
        } else {
            this._s3 = null;
            this.verbose(1, '[S3] SlackersSquadServices not found — using fallback implementations.');
        }
    }

    async mount() {
        this._resolveS3();
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
        this.server.on('SMART_ASSIGN_EVAL_START', this.onSAEvalStart);
        this.server.on('SMART_ASSIGN_EVAL_END', this.onSAEvalEnd);
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
            const connectionSeconds = await this.getSecondsFromJoin(info.player?.eosID);
            const connectionLog = connectionSeconds > 0 ? `${connectionSeconds.toFixed(1)}s` : "0s (New Join/Plugin Reload)";
            this.verbose(2, `${playerName}:\n > Connection: ${connectionLog}\n > Match Start: ${this.getSecondsFromMatchStart().toFixed(1)}s`);
            this.verbose(2, `[Command] Player ${playerName} sent: ${info.message}`);

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
                        this.warn(steamID, "Admin Controls\nPlayer: now, double, matchend, check, clear\nSquad: squad, doublesquad, matchendsquad");
                    } else {
                        this.warn(steamID, `[Switch] Commands\n!switch         | Request a team switch\n!switch check   | Check your eligibility\n!switch explain | How switching works\n!switch cancel  | Leave the queue`);
                    }
                    break;
                case "explain":
                    {
                        const cooldownHours = this.options.switchCooldownMinutes > 0 
                            ? (this.options.switchCooldownMinutes / 60).toFixed(1) 
                            : this.options.switchCooldownHours;
                        this.warn(steamID, `[Switch] How It Works (1/4)\nSwitching is allowed in the first ${this.options.switchEnabledMinutes}m after joining or after match start — whichever gives you more time.`);
                        await delay(5000);
                        this.warn(steamID, `[Switch] How It Works (2/4)\nIf teams are uneven, you are queued until a slot opens or a swap partner on the other team is found.`);
                        await delay(5000);
                        this.warn(steamID, `[Switch] How It Works (3/4)\nAfter switching, there is a ${cooldownHours}h cooldown before you can switch again.`);
                        await delay(5000);
                        this.warn(steamID, `[Switch] How It Works (4/4)\nAfter a scramble, switches are locked for ${this.options.scrambleLockdownDurationMinutes}m.\nUse !switch check to see your current status.`);
                    }
                    break;
                case "check":
                    {
                        const ident = commandSplit.splice(1).join(' ');
                        if (ident) {
                            // Admin-only: check another player
                            if (!isAdmin) {
                                this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                                return;
                            }
                            this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
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
                        } else {
                            // Any player: check their own eligibility (show all 4 conditions)
                            const eosID = info.player?.eosID;
                            const teamID = info.player?.teamID;
                            if (!eosID || !teamID) {
                                this.warn(steamID, `[Switch] Unable to check eligibility.`);
                                return;
                            }

                            const isLiberal = this.isLiberalMode();
                            const cooldownData = await this.models.PlayerCooldowns.findByPk(eosID);
                            const now = Date.now();

                            // 1. Balance check
                            const effectiveCap = isLiberal ? this.options.liberalSwitchMaxUnbalancedSlots : null;
                            const availableSwitchSlots = this.getSwitchSlotsPerTeam(teamID, effectiveCap);
                            const balanceOK = availableSwitchSlots > 0;

                            // 2. Time window check
                            const connectionSeconds = await this.getSecondsFromJoin(eosID);
                            const matchSeconds = this.getSecondsFromMatchStart();
                            const limit = this.options.switchEnabledMinutes;
                            const timeWindowOK = isLiberal || (connectionSeconds / 60 <= limit && matchSeconds / 60 <= limit);
                            let timeWindowMsg = '';
                            if (timeWindowOK) {
                                timeWindowMsg = 'Open';
                            } else {
                                const connMin = Math.ceil(connectionSeconds / 60);
                                const matchMin = Math.ceil(matchSeconds / 60);
                                timeWindowMsg = `Closed (${connMin}m join, ${matchMin}m match)`;
                            }

                            // 3. Cooldown check
                            const cooldownDuration = this.options.switchCooldownMinutes > 0
                                ? this.options.switchCooldownMinutes * 60 * 1000
                                : this.options.switchCooldownHours * 60 * 60 * 1000;
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

                            // 4. Scramble lock check
                            let scrambleOK = true;
                            let scrambleMsg = 'Not active';
                            if (cooldownData && cooldownData.scrambleLockdownExpiry && new Date(cooldownData.scrambleLockdownExpiry).getTime() > now) {
                                scrambleOK = false;
                                const remaining = Math.ceil((new Date(cooldownData.scrambleLockdownExpiry).getTime() - now) / 60000);
                                scrambleMsg = `${remaining}m remaining`;
                            }

                            // Build status message
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

                            this.warn(steamID, statusMsg);
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
                            await this.models.PlayerCooldowns.destroy({ where: { eosID: result.eosID }, transaction: t });
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
                case 'cancel':
                    if (this._switchQueue.has(info.player?.eosID)) {
                        const entry = this._switchQueue.get(info.player.eosID);
                        clearInterval(entry.warnInterval);
                        this._switchQueue.delete(info.player.eosID);
                        this.warn(steamID, '[Switch Queue] Removed — you left the queue.');
                        this.verbose(1, `[Queue] ${playerName} cancelled — left the queue.`);
                    } else {
                        this.warn(steamID, '[Switch Queue] You are not currently in the queue.');
                    }
                    break;
                default:
                    await this.warn(steamID, `Unknown subcommand: "${subCommand}"`);
                    return;
            }
        } else {
            if (this._nullTeamIDWindowActive) {
                const eosID = info.player?.eosID;
                if (!eosID) return;

                const eligibility = await this._checkSwitchEligibility(info.player);
                if (!eligibility.eligible) {
                    if (eligibility.reason === 'scramble_lock') {
                        this.warn(steamID, `[Switch] Scramble lock active — expires in ${eligibility.remaining}m.\nYour switch window may close before this expires.\nUse !switch check to see your full status.`);
                        this.verbose(1, `[Queue] Denied ${playerName} during transition: Scramble lockdown active.`);
                    } else if (eligibility.reason === 'time_window') {
                        this.warn(steamID, `[Switch] Join/match window closed.\nSwitching is only allowed in the first ${this.options.switchEnabledMinutes}m after joining or after\nmatch start — whichever gives you more time.\nUse !switch explain for details.`);
                        this.verbose(1, `[Queue] Denied ${playerName} during transition: Match time limit exceeded.`);
                    } else if (eligibility.reason === 'cooldown') {
                        this.warn(steamID, `[Switch] On cooldown — available in ${eligibility.remaining}m.\nUse !switch check to see your full status.`);
                        this.verbose(1, `[Queue] Denied ${playerName} during transition: Cooldown active.`);
                    }
                    return;
                }

                this._enqueuePlayer(info.player, 'Server is mid-transition — team assignments are still resolving.');
                return;
            }

            await this.server.updateSquadList();
            await this.server.updatePlayerList();

            // Phase gate: engine-level team changes are impossible during faction voting
            if (this.s3IsEndgameFactionVote()) {
                this.warn(steamID, '[Switch] Team changes are locked during faction voting. Try again when the next round starts.');
                this.verbose(1, `[Switch] Denied ${playerName}: faction vote in progress.`);
                return;
            }

            // S³ lock gate: check if this player is being processed by a higher-priority actor
            const eosID2 = info.player?.eosID;
            if (eosID2 && this._s3?.services?.players) {
                if (!this._s3.services.players.canAct(eosID2, 'Switch')) {
                    this.warn(steamID, '[Switch] You are currently being processed — please try again shortly.');
                    this.verbose(1, `[Switch] Denied ${playerName}: canAct returned false (locked by higher-priority actor).`);
                    return;
                }
            }

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

            this.verbose(2, `[Switch Request] ${playerName} (T${teamID} -> T${targetTeam})`);
            this.verbose(2, `[Team Counts] Team 1: ${teamPlayerCount[1]} | Team 2: ${teamPlayerCount[2]} | Balance Diff: ${balanceDiff}`);
            this.verbose(2, `[Switch Slots] Max Unbalance Cap: ${effectiveMaxSlots} | Available Slots: ${availableSwitchSlots}`);
            if (isLiberal) {
                this.verbose(2, `[Liberal Mode] ${playerName} - relaxed switch restrictions active (Seed/Jensen).`);
            }

             const eosID = info.player?.eosID;
             if (!eosID) {
                 this.verbose(1, `[PlayerCooldowns] Missing eosID for player ${playerName}, skipping switch validation`);
                 return;
             }

            const eligibility = await this._checkSwitchEligibility(info.player);
            if (!eligibility.eligible) {
                if (eligibility.reason === 'scramble_lock') {
                    this.warn(steamID, `[Switch] Scramble lock active — expires in ${eligibility.remaining}m.\nYour switch window may close before this expires.\nUse !switch check to see your full status.`);
                    this.verbose(1, `[Switch] Denied ${playerName}: Scramble lockdown active.`);
                } else if (eligibility.reason === 'time_window') {
                    this.warn(steamID, `[Switch] Join/match window closed.\nSwitching is only allowed in the first ${this.options.switchEnabledMinutes}m after joining or after\nmatch start — whichever gives you more time.\nUse !switch explain for details.`);
                    this.verbose(1, `[Switch] Denied ${playerName}: Match time limit exceeded.`);
                } else if (eligibility.reason === 'cooldown') {
                    this.warn(steamID, `[Switch] On cooldown — available in ${eligibility.remaining}m.\nUse !switch check to see your full status.`);
                    this.verbose(1, `[Switch] Denied ${playerName}: Cooldown active.`);
                }
                return;
            }

            if (this.isSABalancingActive) {
                this.warn(steamID, '[Switch Queue]\nServer is currently balancing joins.\nYou have been added to the queue.');
                this._enqueuePlayer(info.player, 'Server balancing in progress.');
                return;
            }

            const queueSameTeam = [...this._switchQueue.values()].filter(e => e.teamID === teamID).length;
            if (queueSameTeam > 0) {
                this._enqueuePlayer(info.player, 'Other players are already waiting in the queue.');
                return;
            }

            if (availableSwitchSlots <= 0) {
                this._enqueuePlayer(info.player, 'Teams are currently full on that side.');
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
                        this.warn(steamID, "[Switch] Switch failed — please try again or contact an admin.");
                    }
                } else {
                    this.verbose(1, `Error executing switch: ${err.message}`);
                    this.warn(steamID, "[Switch] Switch failed — please try again or contact an admin.");
                }
            }

            if (switchSuccess) {
                // In liberal mode, don't write cooldown timestamp (no cooldown enforcement)
                // In normal mode, write cooldown timestamp for next switch throttling
                if (!isLiberal) {
                    try {
                        const eosID = info.player?.eosID;
                        if (!eosID) {
                            this.verbose(1, `[PlayerCooldowns] Missing eosID for player ${playerName}, skipping cooldown write`);
                        } else {
                            await this.safeTransaction(async (t) => {
                                await this.models.PlayerCooldowns.upsert({ eosID, steamID, playerName, lastSwitchTimestamp: new Date() }, { transaction: t });
                            });
                        }
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
             this.warn(pl.steamID, '[Switch] Round ending — you will be switched in 15 seconds.');
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
        // Clear switch queue — all time windows are now void
        for (const entry of this._switchQueue.values()) {
            clearInterval(entry.warnInterval);
        }
        this._switchQueue.clear();
        this._lastTeamSnapshot = null;
        this.verbose(2, '[Queue] Switch queue cleared on round end.');
        this._stopQueuePolling();
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

        return balanceDiff;
    }

    /**
     * HELPER: Detect if we're in a liberal switching mode (Seed/Jensen).
     * Checks both cached layer name and gamemode against the liberal modes list.
     */
    isLiberalMode() {
        // Prefer S³ gameState when available (single source of truth for layer/gamemode)
        const layerName = this.s3GameStateLayer() ?? this.currentLayerName;
        const gamemode = this.s3GameStateGamemode() ?? this.currentGamemode;
        const checkLayer = (layerName || '').toLowerCase();
        const checkMode = (gamemode || '').toLowerCase();
        return this._liberalModes.some(m => checkLayer.includes(m) || checkMode.includes(m));
    }

    // S³ gameState helpers (null-safe, return null when S³ not available)
    s3GameStateLayer() {
        return this._s3?.services?.gameState?.getLayerName?.() ?? null;
    }
    s3GameStateGamemode() {
        return this._s3?.services?.gameState?.getGamemode?.() ?? null;
    }
    s3IsEndgameFactionVote() {
        return this._s3?.services?.gameState?.isEndgameFactionVote?.() === true;
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

         const dynamicExtra = this.getDynamicExtraSlots();
         if (dynamicExtra > 0) {
             cap += dynamicExtra;
             this.verbose(2, `[Dynamic Balance] Extra slots: +${dynamicExtra} | Effective cap: ${cap}`);
         }

         // Simulate post-switch diff: moving one player swings diff by 2
         const postSwitchDiff = teamID === 1
             ? balanceDifference - 2
             : balanceDifference + 2;

         if (Math.abs(postSwitchDiff) > cap) {
             return 0;
         }

         // 50v50 ceiling: receiving team must not exceed 50
         let teamPlayerCount = [null, 0, 0];
         for (let p of this.server.players)
             teamPlayerCount[+p.teamID]++;

         const receivingTeam = teamID === 1 ? 2 : 1;
         if ((teamPlayerCount[receivingTeam] || 0) >= 50) return 0;

         return 1;
     }

    async _checkSwitchEligibility(player) {
        const eosID = player?.eosID;
        if (!eosID) return { eligible: false, reason: 'missing_eos' };

        const cooldownData = await this.models.PlayerCooldowns.findByPk(eosID);
        const now = Date.now();

        // Scramble lock check (Always enforced)
        if (cooldownData && cooldownData.scrambleLockdownExpiry && new Date(cooldownData.scrambleLockdownExpiry).getTime() > now) {
            const remaining = Math.ceil((new Date(cooldownData.scrambleLockdownExpiry).getTime() - now) / 60000);
            return { eligible: false, reason: 'scramble_lock', remaining };
        }

        if (!this.isLiberalMode()) {
            const connectionSeconds = await this.getSecondsFromJoin(eosID);
            const matchSeconds = this.getSecondsFromMatchStart();
            const limit = this.options.switchEnabledMinutes;

            // Time window check
            if (connectionSeconds / 60 > limit && matchSeconds / 60 > limit) {
                return { eligible: false, reason: 'time_window' };
            }

            // Cooldown check
            const cooldownDuration = this.options.switchCooldownMinutes > 0
                ? this.options.switchCooldownMinutes * 60 * 1000
                : this.options.switchCooldownHours * 60 * 60 * 1000;

            if (cooldownData && cooldownData.lastSwitchTimestamp) {
                const lastSwitchTime = new Date(cooldownData.lastSwitchTimestamp).getTime();
                if (now - lastSwitchTime < cooldownDuration) {
                    const remaining = Math.ceil((cooldownDuration - (now - lastSwitchTime)) / 60000);
                    return { eligible: false, reason: 'cooldown', remaining };
                }
            }
        }

        return { eligible: true };
    }

    _startQueuePolling() {
         if (this._queuePollInterval !== null) return; // Already running

         this._queuePollInterval = setInterval(async () => {
             // Debounce: skip if last poll was less than 10s ago
             if (Date.now() - this._lastQueuePollTime < 10_000) {
                 return;
             }

             // Stop if queue is now empty
             if (this._switchQueue.size === 0) {
                 this._stopQueuePolling();
                 return;
             }

             this._lastQueuePollTime = Date.now();
             try {
                 await this.server.updatePlayerList();
                 // UPDATED_PLAYER_INFORMATION event will trigger _processQueue()
             } catch (err) {
                 this.verbose(1, `[Queue Poll] updatePlayerList failed: ${err.message}`);
             }
         }, 10_000); // 10-second fast poll

         if (this._switchQueue.size > 0) {
             this.verbose(2, `[Queue Poll] Fast-poll interval started.`);
         }
     }

    _stopQueuePolling() {
        if (this._queuePollInterval !== null) {
            clearInterval(this._queuePollInterval);
            this._queuePollInterval = null;
            if (this._switchQueue.size > 0) {
                this.verbose(2, `[Queue Poll] Fast-poll interval stopped.`);
            }
        }
    }

    _enqueuePlayer(player, reason) {
        const { eosID, steamID, name: playerName, teamID } = player;

        if (!eosID || !teamID) {
            this.verbose(1, `[Queue] Cannot enqueue ${playerName}: missing eosID or teamID.`);
            return;
        }

        const windowMs = this.options.switchEnabledMinutes * 60 * 1000;

        if (this._switchQueue.has(eosID)) {
            const existing = this._switchQueue.get(eosID);
            const elapsed = Date.now() - existing.queuedAt;
            const remaining = ((windowMs - elapsed) / 60000).toFixed(1);
            const targetTeam = existing.teamID === 1 ? 2 : 1;
            this.warn(steamID,
                `[Switch Queue]\nYou are already in the queue.\n~${remaining}m remaining | Team ${existing.teamID} → Team ${targetTeam}\nType !switch cancel to leave.`
            );
            return;
        }

        const queuedAt = Date.now();

        const warnInterval = setInterval(() => {
            const entry = this._switchQueue.get(eosID);
            if (!entry) { clearInterval(warnInterval); return; }

            const elapsed = Date.now() - entry.queuedAt;
            const remaining = ((windowMs - elapsed) / 60000).toFixed(1);

            const sameTeam = [...this._switchQueue.values()]
                .filter(e => e.teamID === entry.teamID)
                .sort((a, b) => a.queuedAt - b.queuedAt);
            const pos = sameTeam.findIndex(e => e.eosID === eosID) + 1;
            const targetTeam = entry.teamID === 1 ? 2 : 1;

            this.warn(entry.steamID,
                `[Switch Queue]\nPosition ${pos} in the queue.\n~${remaining}m remaining | Team ${entry.teamID} → Team ${targetTeam}\nType !switch cancel to leave.`
            );
        }, 30_000); // Changed from 60_000 to 30_000 for 30-second warnings

        // Compute enqueue position within same-team candidates
        const sameTeamAtEnqueue = [...this._switchQueue.values()]
            .filter(e => e.teamID === teamID);
        const enqueuePos = sameTeamAtEnqueue.length + 1; // +1 because entry not yet added to map
        const targetTeam = teamID === 1 ? 2 : 1;
        const remainingAtEnqueue = (windowMs / 60000).toFixed(1);

        this._switchQueue.set(eosID, { eosID, steamID, playerName, teamID, queuedAt, warnInterval });

        this.warn(steamID,
            `[Switch Queue]\nAdded to position ${enqueuePos} in the queue.\n~${remainingAtEnqueue}m remaining | Team ${teamID} → Team ${targetTeam}\n${reason}\nType !switch cancel to leave.`
        );
        this.verbose(1, `[Queue] ${playerName} (T${teamID}) enqueued at position ${enqueuePos}. Queue size: ${this._switchQueue.size}`);

        // Start fast-poll for queue processing
        this._startQueuePolling();
    }

    async _processQueue() {
        // RE-ENTRANCY GUARD: Prevent concurrent queue processing
        if (this._queueProcessing) {
            this.verbose(2, `[Queue] Processing already in progress — skipping concurrent invocation.`);
            return;
        }
        
        this._queueProcessing = true;
        try {
            // Phase gate: don't attempt switches during faction voting (engine-level block)
            if (this.s3IsEndgameFactionVote()) {
                if (this._switchQueue.size > 0) {
                    this.verbose(2, `[Queue] Faction vote in progress — skipping queue processing.`);
                }
                return;
            }

            if (this.isSABalancingActive) {
                this.verbose(2, `[Queue] Processing suspended — SmartAssign is currently evaluating joins.`);
                return;
            }
            const windowMs = this.options.switchEnabledMinutes * 60 * 1000;
            const now = Date.now();

            // STEP 1 — EXPIRE: remove players whose time window has closed
            for (const [eosID, entry] of this._switchQueue.entries()) {
                if ((now - entry.queuedAt) >= windowMs) {
                    clearInterval(entry.warnInterval);
                    this._switchQueue.delete(eosID);
                    this.warn(entry.steamID, `[Switch Queue] Removed — join/match window closed.\nYour ${this.options.switchEnabledMinutes}m window expired while waiting.\nUse !switch explain for details.`);
                    this.verbose(2, `[Queue] ${entry.playerName} expired and removed from queue.`);
                }
            }

            // STEP 2 — STABILITY CHECK (solo only): compute current team counts
            // Pair trades are exempt — net team counts are preserved by a swap.
            // Solo switches only fire when two consecutive UPDATED_PLAYER_INFORMATION polls
            // show identical team counts, indicating SmartAssign's in-flight moves have settled.
            let t1 = 0, t2 = 0;
            for (const p of this.server.players) {
                if (p.teamID === 1) t1++;
                else if (p.teamID === 2) t2++;
                // null teamID players excluded intentionally
            }
            const prevSnapshot = this._lastTeamSnapshot;
            const stable = prevSnapshot !== null
                && prevSnapshot.t1 === t1
                && prevSnapshot.t2 === t2;
            this._lastTeamSnapshot = { t1, t2 };

            // STEP 3 — PAIR MATCHING: exempt from stability check
            // Match oldest T1 candidate with oldest T2 candidate, FIFO.
            const t1Candidates = [...this._switchQueue.values()]
                .filter(e => e.teamID === 1)
                .sort((a, b) => a.queuedAt - b.queuedAt);
            const t2Candidates = [...this._switchQueue.values()]
                .filter(e => e.teamID === 2)
                .sort((a, b) => a.queuedAt - b.queuedAt);

            const pairCount = Math.min(t1Candidates.length, t2Candidates.length);

            for (let i = 0; i < pairCount; i++) {
                const p1 = t1Candidates[i];
                const p2 = t2Candidates[i];

                // Stale-team guard: verify each player's current team still matches their queue entry
                const live1 = this.server.players.find(p => p.eosID === p1.eosID);
                const live2 = this.server.players.find(p => p.eosID === p2.eosID);

                if (!live1 || live1.teamID !== p1.teamID) {
                    clearInterval(p1.warnInterval);
                    this._switchQueue.delete(p1.eosID);
                    this.verbose(1, `[Queue] ${p1.playerName} team changed externally — removed from queue.`);
                    continue;
                }
                if (!live2 || live2.teamID !== p2.teamID) {
                    clearInterval(p2.warnInterval);
                    this._switchQueue.delete(p2.eosID);
                    this.verbose(1, `[Queue] ${p2.playerName} team changed externally — removed from queue.`);
                    continue;
                }

                // Remove BEFORE firing switches
                clearInterval(p1.warnInterval);
                this._switchQueue.delete(p1.eosID);
                clearInterval(p2.warnInterval);
                this._switchQueue.delete(p2.eosID);

                this.warn(p1.steamID, '[Switch Queue] Swap partner found — switching now.');
                this.warn(p2.steamID, '[Switch Queue] Swap partner found — switching now.');

                await this._taggedSwitchPlayer(p1.steamID, 'Player-Queue');
                await this._taggedSwitchPlayer(p2.steamID, 'Player-Queue');

                if (!this.isLiberalMode()) {
                    const now = new Date();
                    for (const p of [p1, p2]) {
                        try {
                            await this.safeTransaction(async (t) => {
                                await this.models.PlayerCooldowns.upsert(
                                    { eosID: p.eosID, steamID: p.steamID, playerName: p.playerName, lastSwitchTimestamp: now },
                                    { transaction: t }
                                );
                            });
                        } catch (dbErr) {
                            this.verbose(1, `[Queue] Cooldown write failed for ${p.playerName}: ${dbErr.message}`);
                        }
                    }
                }

                this.verbose(1, `[Queue] Swapped pair: ${p1.playerName} (T1) <-> ${p2.playerName} (T2)`);
            }

            // STEP 4 — SOLO BALANCE CHECK: only fires when team counts are stable
            if (!stable) {
                if (this._switchQueue.size > 0) {
                    this.verbose(2, `[Queue] Team counts changed (${prevSnapshot?.t1 ?? '?'}v${prevSnapshot?.t2 ?? '?'} → ${t1}v${t2}) — skipping solo processing this tick.`);
                }
                return;
            }

            const remaining = [...this._switchQueue.values()]
                .sort((a, b) => a.queuedAt - b.queuedAt);

            const isLiberal = this.isLiberalMode();
            const effectiveCap = isLiberal ? this.options.liberalSwitchMaxUnbalancedSlots : null;

            // Count queued players per team
            const t1Queued = remaining.filter(e => e.teamID === 1).length;
            const t2Queued = remaining.filter(e => e.teamID === 2).length;

            // Log queue summary
            if (this._switchQueue.size > 0) {
                this.verbose(2, `[Queue] T1: ${t1Queued} queued | T2: ${t2Queued} queued | Teams: ${t1}v${t2} | Diff: ${t1 - t2}`);
            }

            // Only check the first (oldest) person in each team's queue
            const firstT1 = remaining.find(e => e.teamID === 1);
            const firstT2 = remaining.find(e => e.teamID === 2);

            for (const entry of [firstT1, firstT2].filter(Boolean)) {
                // Stale-team guard
                const live = this.server.players.find(p => p.eosID === entry.eosID);
                if (!live || live.teamID !== entry.teamID) {
                    clearInterval(entry.warnInterval);
                    this._switchQueue.delete(entry.eosID);
                    this.verbose(1, `[Queue] ${entry.playerName} team changed externally — removed from queue.`);
                    continue;
                }

                const slots = this.getSwitchSlotsPerTeam(entry.teamID, effectiveCap);
                if (slots > 0) {
                    clearInterval(entry.warnInterval);
                    this._switchQueue.delete(entry.eosID);

                    this.warn(entry.steamID, '[Switch Queue] Balance slot opened — switching now.');
                    await this._taggedSwitchPlayer(entry.steamID, 'Player-Queue');

                    if (!this.isLiberalMode()) {
                        try {
                            await this.safeTransaction(async (t) => {
                                await this.models.PlayerCooldowns.upsert(
                                    { eosID: entry.eosID, steamID: entry.steamID, playerName: entry.playerName, lastSwitchTimestamp: new Date() },
                                    { transaction: t }
                                );
                            });
                        } catch (dbErr) {
                            this.verbose(1, `[Queue] Cooldown write failed for ${entry.playerName}: ${dbErr.message}`);
                        }
                    }

                    this.verbose(1, `[Queue] Solo switch fired for ${entry.playerName} (T${entry.teamID})`);

                    // Limit to one solo switch per tick to maintain balance stability.
                    break;
                }
                // else: leave in queue, will retry next tick
            }

        } catch (err) {
            this.verbose(1, `[Queue] _processQueue error: ${err.message}`);
        } finally {
            this._queueProcessing = false;
        }
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
            this.verbose(2, `[Layer] Updated layer cache: ${name} (${mode})`);
        }
    }

    get isSABalancingActive() {
        return this._saEvalLocks.size > 0;
    }

    onSAEvalStart(data) {
        const key = data.eosID || data.steamID;
        if (!key) return;

        // Clear existing timeout to prevent memory leaks if events overlap
        if (this._saEvalLocks.has(key)) {
            clearTimeout(this._saEvalLocks.get(key));
        }

        // 3-second TTL fallback.
        // This matches SmartAssign's target completion window for RCON moves.
        // Shortening this ensures the Switch queue isn't locked indefinitely if an END event is missed.
        const timeout = setTimeout(() => {
            if (this._saEvalLocks.has(key)) {
                this._saEvalLocks.delete(key);
                this.verbose(1, `[Switch Lock] Fallback TTL (3s) expired; dropping lock for ${key}`);
            }
        }, 3000);

        this.verbose(2, `[Switch Lock] Lock acquired for ${key}`);
        this._saEvalLocks.set(key, timeout);
    }

    onSAEvalEnd(data) {
        const key = data.eosID || data.steamID;
        if (this._saEvalLocks.has(key)) {
            clearTimeout(this._saEvalLocks.get(key));
            this._saEvalLocks.delete(key);
            this.verbose(2, `[Switch Lock] Lock released for ${key}`);
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
                    this.verbose(2, `[Layer] Updated from server info: ${incomingName}`);
                }
            }
        } catch (err) {
            this.verbose(1, `[onServerInfoUpdated] Error resolving layer: ${err?.message}`);
        }
    }

    async getSecondsFromJoin(eosID) {
        // 1. Check in-memory first
        let joinTime = this.playersConnectionTime[eosID];

        // 2. Check DB if memory is empty (e.g. after restart)
        // Note: This method receives eosID and queries by eosID field
        if (!joinTime) {
            const records = await this.models.PlayerCooldowns.findAll({
                where: { eosID: eosID },
                limit: 1
            });
            if (records.length > 0 && records[0].firstSeenTimestamp) {
                joinTime = new Date(records[0].firstSeenTimestamp).getTime();
                this.playersConnectionTime[eosID] = joinTime; // Hydrate memory
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
        
        const currentEosIDs = new Set(this.server.players.map(p => p.eosID).filter(Boolean));

        for (const p of this.server.players) {
            if (!p.eosID) continue;
            if (!this._knownConnectedPlayers.has(p.eosID)) {
                // NEW PLAYER DETECTED — perform first-seen registration
                const now = Date.now();
                if (!this.playersConnectionTime[p.eosID]) {
                    this.playersConnectionTime[p.eosID] = now;
                    try {
                        await this.safeTransaction(async (t) => {
                            await this.models.PlayerCooldowns.upsert({
                                eosID: p.eosID,
                                steamID: p.steamID,
                                playerName: p.name,
                                firstSeenTimestamp: new Date(now)
                            }, { transaction: t });
                        });
                    } catch (err) {
                        this.verbose(1, `Failed to persist join time for ${p.name} (detected via UPDATED_PLAYER_INFORMATION): ${err.message}`);
                    }

                    if (!this._switchedOnJoin.has(p.eosID)) {
                        this._switchedOnJoin.add(p.eosID);
                        if (this.options.switchToOldTeamAfterRejoin) {
                            const preDisconnectionData = this.recentDisconnections[p.steamID];
                            if (preDisconnectionData) {
                                setTimeout(() => {
                                    this.switchToPreDisconnectionTeam({ player: p });
                                }, 100);
                            }
                        }
                    }
                }
                this._knownConnectedPlayers.set(p.eosID, { teamID: p.teamID, name: p.name, steamID: p.steamID });
            } else {
                const existing = this._knownConnectedPlayers.get(p.eosID);
                if (p.teamID !== null) {
                    existing.teamID = p.teamID;
                    existing.name = p.name;
                }
            }
        }

        // Detect leaves
        for (const [eosID, data] of this._knownConnectedPlayers.entries()) {
            if (!currentEosIDs.has(eosID)) {
                this._knownConnectedPlayers.delete(eosID);
                this.handlePlayerLeave(eosID, data.teamID, data.name, data.steamID);
            }
        }

        if (!this._nullTeamIDWindowActive) {
            await this._processQueue();
        }
    }

    handlePlayerLeave(eosID, teamID, playerName, steamID) {
        if (this._switchQueue.has(eosID)) {
            const entry = this._switchQueue.get(eosID);
            clearInterval(entry.warnInterval);
            this._switchQueue.delete(eosID);
            this.verbose(2, `[Queue] ${playerName} disconnected — removed from queue.`);
        }
        this.verbose(2, `Player disconnected ${playerName}`);
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
        const eosID = info.player?.eosID;
        const playerName = info.player.name;
        const teamID = info.player.teamID;

        this.verbose(2, `Player connected ${playerName}`);
        const now = Date.now();

        // Issue 5: Guard against double-registration if onUpdatedPlayerInfo already processed
        // onUpdatedPlayerInfo may have already registered this player and called switchToPreDisconnectionTeam
        const alreadyRegistered = this.playersConnectionTime[eosID] && this._switchedOnJoin.has(eosID);
        if (alreadyRegistered) {
            this.verbose(1, `[Rejoin] ${playerName} already registered via UPDATED_PLAYER_INFORMATION, skipping double-registration.`);
            return;
        }

        // Check for exploit-resistant rejoin logic
        const preDisconnectionData = this.recentDisconnections[steamID];
        const disconnectionValid = preDisconnectionData && (Date.now() - preDisconnectionData.time.getTime()) < (20 * 60 * 1000);

        if (disconnectionValid) {
            // Retain join time across any short-term disconnection, regardless of team assignment
            const eosID = info.player?.eosID;
            if (!eosID) {
                this.verbose(1, `[Rejoin] Missing eosID for player ${playerName}, resetting join time`);
                this.playersConnectionTime[eosID] = now;
            } else if (!this.playersConnectionTime[eosID]) {
                try {
                    const records = await this.models.PlayerCooldowns.findAll({
                        where: { eosID: eosID },
                        limit: 1
                    });
                    if (records.length > 0 && records[0].firstSeenTimestamp) {
                        this.playersConnectionTime[eosID] = new Date(records[0].firstSeenTimestamp).getTime();
                        this.verbose(2, `[Rejoin] ${playerName} retained join time from pre-disconnection.`);
                    } else {
                        this.playersConnectionTime[eosID] = now;
                    }
                } catch (err) {
                    this.verbose(2, `Failed to hydrate join time for ${playerName}: ${err.message}`);
                    this.playersConnectionTime[eosID] = now;
                }
            }
            // Do NOT overwrite firstSeenTimestamp in the database here
        } else {
            // Reset join time (completely new session or 20 minutes expired)
            const eosID = info.player?.eosID;
            if (eosID) {
                this.playersConnectionTime[eosID] = now;
            }
            
            try {
                const eosID = info.player?.eosID;
                if (!eosID) {
                    this.verbose(1, `[PlayerCooldowns] Missing eosID for player ${playerName}, skipping DB write`);
                } else {
                    await this.safeTransaction(async (t) => {
                        await this.models.PlayerCooldowns.upsert({
                            eosID,
                            steamID,
                            playerName,
                            firstSeenTimestamp: new Date(now)
                        }, { transaction: t });
                    });
                }
            } catch (err) {
                this.verbose(1, `Failed to persist join time for ${playerName}: ${err.message}`);
            }
        }

        // Mark that we've handled switchToPreDisconnectionTeam for this player
        if (!this._switchedOnJoin.has(eosID)) {
            this._switchedOnJoin.add(eosID);
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
        this.verbose(2, `${playerName}: Switching to old team: ${needSwitch}`);

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
          const playerObj = this.server.players.find(p => p.steamID === steamID);
          const eosID = playerObj?.eosID;

          const recentSwitch = this.recentDoubleSwitches.find(e => e.steamID == steamID);
          const cooldownHoursLeft = (Date.now() - +recentSwitch?.datetime) / (60 * 60 * 1000);

          if (!forced) {
              const joinSeconds = await this.getSecondsFromJoin(eosID);
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
        // Delegate to S³ factions service when available; fallback to legacy scan
        if (this._s3?.services?.factions) {
            return this._s3.services.factions.getFactionId(team);
        }

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
        this.server.removeListener('SMART_ASSIGN_EVAL_START', this.onSAEvalStart);
        this.server.removeListener('SMART_ASSIGN_EVAL_END', this.onSAEvalEnd);
        if (this.options.discordClient) this.options.discordClient.removeListener('message', this.onDiscordMessage);
        clearTimeout(this._nullTeamIDWindowTimeout);
        for (const entry of this._switchQueue.values()) {
            clearInterval(entry.warnInterval);
        }
        this._switchQueue.clear();
        for (const timeout of this._saEvalLocks.values()) {
            clearTimeout(timeout);
        }
        this._saEvalLocks.clear();
        this._s3 = null;
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

            const currentEosIDs = new Set(this.server.players.map(p => p.eosID).filter(Boolean));
            for (const eosID in this.playersConnectionTime) {
                if (!currentEosIDs.has(eosID)) {
                    delete this.playersConnectionTime[eosID];
                }
            }

            const currentSteamIDs = this.server.players.map(p => p.steamID);
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
        this.verbose(2, `[SCRAMBLE_EVENT] onScrambleExecuted called with data: ${JSON.stringify(data)}`);
        
        if (!affectedPlayers || affectedPlayers.length === 0) {
            this.verbose(1, `[SCRAMBLE_EVENT] WARNING: affectedPlayers is empty or undefined!`);
            return;
        }

        this.verbose(2, `[SCRAMBLE_EVENT] Processing ${affectedPlayers.length} affected players for lockdown`);
        affectedPlayers.forEach((p, i) => {
            this.verbose(2, `  [${i}] steamID=${p.steamID}, name=${p.name}`);
        });

        const lockdownDuration = this.options.scrambleLockdownDurationMinutes * 60 * 1000;
        const expiry = new Date(Date.now() + lockdownDuration);
        this.verbose(2, `[SCRAMBLE_EVENT] Lockdown duration: ${this.options.scrambleLockdownDurationMinutes}min | Expiry: ${expiry.toISOString()}`);

         const records = affectedPlayers
             .filter(p => {
                 if (!p.eosID) {
                     this.verbose(1, `[SCRAMBLE_EVENT] Skipping player ${p.name} — missing eosID`);
                     return false;
                 }
                 return true;
             })
             .map(p => {
                 return { eosID: p.eosID, steamID: p.steamID ?? null, playerName: p.name, scrambleLockdownExpiry: expiry };
             });

        this.verbose(3, `[SCRAMBLE_EVENT] Created ${records.length} lockdown records for DB write`);

        try {
            this.verbose(2, `[SCRAMBLE_EVENT] Starting DB transaction to write scramble locks...`);
            await this.safeTransaction(async (t) => {
                const chunkSize = 10;
                for (let i = 0; i < records.length; i += chunkSize) {
                    const chunk = records.slice(i, i + chunkSize);
                    this.verbose(2, `[SCRAMBLE_EVENT] Writing chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(records.length / chunkSize)} (${chunk.length} records)`);
                    await this.models.PlayerCooldowns.bulkCreate(chunk, {
                        updateOnDuplicate: ['scrambleLockdownExpiry', 'playerName', 'steamID'],
                        transaction: t
                    });
                }
            });
            this.verbose(1, `[SCRAMBLE_EVENT] ✅ SUCCESS: Switch lockdown active for ${records.length} players until ${expiry.toISOString()}.`);

            // Send Discord notification
            try {
                const embed = {
                    title: '🌪️ Scramble Lockdown Initiated',
                    color: 0xff9800,
                    description: `${affectedPlayers.length} players have been locked from switching for the next ${this.options.scrambleLockdownDurationMinutes} minutes.`,
                    fields: [
                        { name: 'Lockdown Duration', value: `${this.options.scrambleLockdownDurationMinutes} minutes`, inline: true },
                        { name: 'Expires At', value: `<t:${Math.floor(expiry.getTime() / 1000)}:R>`, inline: true },
                        { name: 'Players Affected', value: String(affectedPlayers.length), inline: true }
                    ],
                    timestamp: new Date().toISOString()
                };
                await this.sendDiscordMessage({ channel: this.discordChannel, embed });
            } catch (discordErr) {
                this.verbose(1, `[SCRAMBLE_EVENT] Warning: Failed to send Discord notification: ${discordErr.message}`);
            }
        } catch (err) {
            this.verbose(1, `[SCRAMBLE_EVENT] ❌ ERROR updating scramble lockdown: ${err.message}`);
            this.verbose(1, `[SCRAMBLE_EVENT] Stack trace: ${err.stack}`);
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
                await this.models.PlayerCooldowns.destroy({ where: { eosID: result.eosID }, transaction: t });
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