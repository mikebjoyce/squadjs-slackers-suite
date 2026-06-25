import Sequelize from 'sequelize';
import DiscordBasePlugin from './discord-base-plugin.js';
import { setTimeout as delay } from "timers/promises";
const { DataTypes, Op } = Sequelize;

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                    SWITCH PLUGIN v2.0.0                       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Manages player team-change requests with cooldown enforcement,
 * scramble-aware lockout, and persistent join-timer tracking across
 * server restarts. Integrates with TeamBalancer to lock switching
 * after scrambles and with SlackersSquadServices for player state
 * tracking and attribution. Supports in-game chat commands and
 * Discord admin commands.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * Switch (default)
 *   Extends DiscordBasePlugin. Key public methods:
 *     mount()                          — Registers event listeners, discovers S³, initialises DB.
 *     unmount()                        — Removes listeners, clears queue, unregisters S³ interest.
 *     prepareToMount()                 — Migrates DB schema, syncs models before mount.
 *     createModel(name, schema)        — Defines a Sequelize model on the plugin's DB connector.
 *     safeTransaction(logicFn)         — Retry wrapper for SQLite-busy DB transactions.
 *     safeDiscordReply(message, text)  — Guarded Discord message reply with error suppression.
 *     switchPlayer(eosID)              — Executes AdminForceTeamChange via RCON for one player.
 *     doubleSwitchPlayer(eosID, forced, senderSteamID) — Swaps a player to the opposite team and back.
 *     switchSquad(number, team)        — Switches all members of a squad to the opposite team.
 *     doubleSwitchSquad(number, team)  — Double-switches all members of a squad.
 *     getDiagnosticInfo()              — Returns DB health, active lock count, and stored player count.
 *     checkPlayer(ident)               — Looks up a player's cooldown/lock state by eosID or name.
 *     cleanup()                        — Purges expired cooldown rows and stale disconnection records.
 *     getPlayersByUsername(username)   — Fuzzy player search by name substring.
 *     getPlayerBySteamID(steamID)      — Exact player lookup by SteamID.
 *     getPlayerByUsernameOrSteamID(steamID, ident) — Combined lookup with ambiguity warnings.
 *     getSecondsFromJoin(eosID)        — Seconds since player joined (via S³ or fallback).
 *     getSecondsFromMatchStart()       — Seconds since current layer started.
 *     getTeamBalanceDifference()       — Returns signed team-size delta (Team1 − Team2).
 *     getSwitchSlotsPerTeam(teamID, effectiveCap) — Available switch slots for a given team.
 *     addPlayerToMatchendSwitches(p)   — Queues a player for end-of-round team switch.
 *     addSquadToMatchendSwitches(n, t) — Queues an entire squad for end-of-round switch.
 *     onChatMessage(info)              — Handles all in-game !switch / !change / double-switch commands.
 *     onDiscordMessage(message)        — Handles Discord !switch admin commands.
 *     onRoundEnded(info)               — Processes end-of-round switch queue.
 *     onScrambleExecuted(data)         — Applies scramble lockdown to affected players.
 *     onNewGame()                      — Logs new-game transition.
 *     onS3PlayerJoined(data)           — Triggers rejoin auto-switch and queue processing.
 *     onS3PlayerLeft(data)             — Removes player from queue, triggers queue processing.
 *     onS3PlayerTeamChanged(data)      — Triggers queue processing on team change.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * DiscordBasePlugin (./discord-base-plugin.js)
 *   SquadJS base class providing Discord connector, server, and options.
 *
 * ─── S³ INTEGRATION ──────────────────────────────────────────────
 *
 * S³ (Slacker's Squad Services) is the centralised service container
 * for shared state across Slacker's Squad plugins.  It owns the
 * ground truth for server configuration, game-state lifecycle,
 * player state, faction metadata, clan grouping, database access,
 * and cross-plugin event routing.  Consumer plugins discover S³ at
 * runtime via this.server.plugins and access services through flat
 * getters (e.g. this._s3?.gameState) guarded by isReady() checks.
 *
 * GitHub: https://github.com/mikebjoyce/squadjs-slackers-squad-services
 *
 * Consumed Services:
 *   - players:  registerRefreshInterest(), unregisterRefreshInterest(),
 *               getPlayer(), recordMove(), canAct(), requestRefresh() —
 *               player join-time resolution, move attribution,
 *               concurrency gating, and stale-data refresh polling.
 *   - gameState: getLayerName(), isEndgameFactionVote() — liberal-mode
 *               detection and faction-vote queue suppression.
 *
 * Emitted Events:
 *   - None.
 *
 * Listened Events:
 *   - S3_PLAYER_JOINED: triggers rejoin auto-switch and queue processing.
 *   - S3_PLAYER_LEFT: stores disconnection state; removes player from switch queue.
 *   - S3_PLAYER_TEAM_CHANGED: triggers queue re-evaluation.
 *   - TEAM_BALANCER_SCRAMBLE_EXECUTED: applies scramble lockdown to affected
 *     players for a configurable duration.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Forked from the original SquadJS Switch plugin by fantinodavide.
 *   Original author credit retained.
 * - Scramble lockdown skips players still within their switch-enabled
 *   window (join or match start), since they had no time to exploit
 *   pre-scramble imbalance.
 * - Liberal game modes (default: Seed, Jensen) relax cooldown and time
 *   limits. Configured via liberalSwitchGameModes and
 *   liberalSwitchMaxUnbalancedSlots.
 * - Dynamic balance tolerance scales extra imbalance slots linearly
 *   from dynamicBalancePlayerFloor (default 90) up to 98 players.
 * - Switch queue uses a stability gate: solo switches are only
 *   processed when team counts are stable across two consecutive polls.
 * - RCON identifier cascade: player name is the only universally
 *   reliable RCON identifier. eosID/steamID are NOT valid for RCON.
 * - DB transaction retry (safeTransaction) handles SQLITE_BUSY with
 *   up to 5 retries and exponential backoff.
 * - PlayerCooldowns table is auto-migrated on mount; schema mismatch
 *   triggers a drop-and-recreate.
 * - Endmatch switch queue persists across restarts via the Endmatch
 *   model; processed on ROUND_ENDED.
 *
 * ─── COMMANDS ────────────────────────────────────────────────────
 *
 * Public (all players):
 *   !switch                        → Request a team change (checks balance, cooldowns, locks).
 *   !switch help                   → In-game warning popup explaining eligibility rules.
 *   !switch explain                → Detailed breakdown of why you can or cannot switch.
 *   !switch cancel                 → Leave the switch queue.
 *   !switch prefer <team>          → Set team preference for end-of-match switch queue.
 *   !bug / !stuck / !doubleswitch  → Double-switch (swap to opposite team and back).
 *
 * Admin (in-game):
 *   !switch now <name>             → Force immediate team switch for a player.
 *   !switch double <name>          → Force double-switch for a player.
 *   !switch squad <n> <team>       → Switch an entire squad to the opposite team.
 *   !switch swap <name1> <name2>   → Swap two players between teams.
 *   !switch check <name/steamID>   → Look up a player's cooldown and lock status.
 *   !switch clear <name/steamID>   → Remove all cooldowns and locks for a player.
 *   !switch clearall               → Wipe the entire cooldown database.
 *   !switch diag                   → Show DB health, active locks, and top-10 locked players.
 *   !switch help                   → List all admin commands.
 *
 * Admin (Discord):
 *   !switch diag                   → Database health + RCON latency + top-10 locked players.
 *   !switch check <name/steamID>   → Real-time eligibility lookup with timestamps.
 *   !switch clear <name/steamID>   → Remove cooldowns/locks for a player.
 *   !switch clearall               → Wipe entire cooldown database.
 *   !switch help                   → List all Discord admin commands.
 *
 * ─── AUTHOR ──────────────────────────────────────────────────────
 *
 * Original Author: fantinodavide (https://github.com/fantinodavide)
 * Modified by:     Slacker
 * Discord:         `real_slacker`
 * GitHub:          https://github.com/mikebjoyce/squadjs-switch-teambalancer-aware
 *
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
        this.switchPlayer = this.switchPlayer.bind(this);
        this.getPlayersByUsername = this.getPlayersByUsername.bind(this);
        this.getPlayerBySteamID = this.getPlayerBySteamID.bind(this);
        this.getPlayerByUsernameOrSteamID = this.getPlayerByUsernameOrSteamID.bind(this);
        this.doubleSwitchPlayer = this.doubleSwitchPlayer.bind(this);
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
        this.onS3PlayerJoined = this.onS3PlayerJoined.bind(this);
        this.onS3PlayerLeft = this.onS3PlayerLeft.bind(this);
        this.onS3PlayerTeamChanged = this.onS3PlayerTeamChanged.bind(this);

        this.recentSwitches = [];
        this.recentDoubleSwitches = [];
        // recentDisconnections removed in Stage 6.2b — replaced by S3_PLAYER_JOINED's
        // previousTeamID payload and S³ reconnect data.
        this._switchQueue = new Map();      // eosID → { eosID, steamID, playerName, teamID, queuedAt, warnInterval }
        this._lastTeamSnapshot = null;      // { t1: number, t2: number } — previous poll's team counts for stability check
        this._switchedOnJoin = new Set();
        this._queueProcessing = false;      // Re-entrancy guard for _processQueue
        this._s3 = null;                    // Reference to SlackersSquadServices (runtime discovery)
        
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
            eosID: {
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
        // warn() now resolves player name from server.players before calling rcon.warn.
        // Per RCON_IDENTIFIER_FINDINGS: eosID/steamID are NOT valid RCON identifiers.
        // Player name is the only universally reliable RCON identifier.
        this.warn = (id, msg) => {
            if (!id) return;
            const player = this.server.players.find(p => p.eosID === id || p.steamID === id);
            const name = player?.name || id; // fallback to raw id if player not found
            this.server.rcon.warn(name, msg);
        };
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

    async _syncPlayerCooldowns() {
        try {
            await this.models.PlayerCooldowns.sync({ alter: true });
        } catch (err) {
            if (err?.name === 'SequelizeDatabaseError' &&
                err?.parent?.code === 'SQLITE_ERROR' &&
                err?.parent?.sql && err.parent.sql.includes('PRIMARY KEY')) {
                this.verbose(1, '[Switch] Table schema mismatch detected, recreating PlayerCooldowns table...');
                await this.models.PlayerCooldowns.drop();
                await this.models.PlayerCooldowns.sync({ alter: true });
            } else {
                throw err;
            }
        }
    }

    _resolveS3() {
        if (!this.server.plugins) {
            throw new Error('[S3] server.plugins not available — cannot discover SlackersSquadServices. Ensure it is installed and loaded before Switch.');
        }
        const s3 = this.server.plugins.find(p => p.constructor.name === 'SlackersSquadServices');
        if (!s3) {
            throw new Error('[S3] SlackersSquadServices is required for Switch to function. Ensure it is in config.json before Switch and restart.');
        }
        this._s3 = s3;
        this.verbose(1, '[S3] Discovered SlackersSquadServices for Switch.');
    }

    async mount() {
        this._resolveS3();
        await this._syncPlayerCooldowns();

        // Register refresh interest with S³ PlayersService for queue processing
        const mountPlayers = this._s3.players;
        if (mountPlayers?.isReady() && mountPlayers.registerRefreshInterest) {
            mountPlayers.registerRefreshInterest('Switch', { maxStalenessMs: 10000 });
            this.verbose(1, '[S3] Registered Switch refresh interest (maxStalenessMs=10000).');
        }

        this._liberalModes = (this.options.liberalSwitchGameModes || ['Seed', 'Jensen']).map(m => String(m).toLowerCase());

        this.server.on('CHAT_MESSAGE', this.onChatMessage);
        this.server.on('ROUND_ENDED', this.onRoundEnded)
        this.server.on('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
        this.server.on('NEW_GAME', this.onNewGame.bind(this));
        this.server.on('S3_PLAYER_JOINED', this.onS3PlayerJoined);
        this.server.on('S3_PLAYER_LEFT', this.onS3PlayerLeft);
        this.server.on('S3_PLAYER_TEAM_CHANGED', this.onS3PlayerTeamChanged);
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

        // Migration: ensure eosID column exists on existing Endmatch tables
        // (sync() only CREATE TABLE IF NOT EXISTS — it does not alter existing tables)
        try {
            await this.options.database.getQueryInterface().sequelize.query(
                'ALTER TABLE `SwitchPlugin_Endmatches` ADD COLUMN `eosID` VARCHAR(255);'
            );
            this.verbose(1, '[Switch] Endmatch table migrated: added eosID column.');
        } catch (err) {
            // SQLite throws if column already exists — idempotent, ignore
            if (!err.message.includes('duplicate column') && !err.message.includes('already exists')) {
                // Log unexpected errors but don't block mount
                this.verbose(1, `[Switch] Endmatch migration note: ${err.message}`);
            }
        }

        await this._syncPlayerCooldowns();
    }

    createModel(name, schema) {
        this.models[ name ] = this.options.database.define(`SwitchPlugin_${name}`, schema, {
            timestamps: false
        });
    }

    async onChatMessage(info) {
        try {
            // Use eosID as primary identifier (always present per SquadJS spec)
            // steamID is the fallback — see .agents/skills/creating-squadjs-plugins/SKILL.md
            const eosID = info.player?.eosID;
            const steamID = info.player?.steamID;
            const playerName = info.player?.name;
            const teamID = info.player?.teamID;
            const message = info.message.toLowerCase();

            // Guard: both IDs unavailable — can't execute RCON, abort
            if (!eosID && !steamID) {
                this.verbose(1, `[Switch] Aborting onChatMessage: player ${playerName} has no eosID or steamID`);
                return;
            }

            if (this.options.doubleSwitchCommands.find(c => c.toLowerCase() == message))
                this.doubleSwitchPlayer(eosID);

            const commandPrefixInUse = typeof this.options.commandPrefix === 'string' ? this.options.commandPrefix : this.options.commandPrefix.find(c => message.startsWith(c.toLowerCase()));

            if ((typeof this.options.commandPrefix === 'string' && !message.startsWith(this.options.commandPrefix)) || (typeof this.options.commandPrefix === 'object' && this.options.commandPrefix.length >= 1 && !this.options.commandPrefix.find(c => message.startsWith(c.toLowerCase())))) return;

            const connectionSeconds = await this.getSecondsFromJoin(eosID);
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
                        this._taggedSwitchPlayer(pl.eosID, 'Admin-Force').catch(err => {
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
                        await this.doubleSwitchPlayer(pl.eosID, true);
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
                    this.warn(eosID, `Players and squads refreshed.`);
                    break;
                case 'slots':
                    await this.server.updateSquadList();
                    await this.server.updatePlayerList();
                    this.warn(eosID, `Switch Slots:\nTeam 1: ${this.getSwitchSlotsPerTeam(1)}\nTeam 2: ${this.getSwitchSlotsPerTeam(2)}`);
                    break;
                case "matchend":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    await this.server.updatePlayerList();
                    pl = this.getPlayerByUsernameOrSteamID(steamID, commandSplit.splice(1).join(' '));
                    this.warn(eosID, `Player "${pl.name}" queued for switch at match end.`);
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
                    this.warn(eosID, `Squad ${commandSplit[ 1 ]} (${commandSplit[ 2 ]}) queued for switch at match end.`);
                    await this.addSquadToMatchendSwitches(+commandSplit[ 1 ], commandSplit[ 2 ]);
                    break;
                case "triggermatchend":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    this.warn(eosID, 'Triggering match-end switch sequence...');
                    await this.doSwitchMatchend();
                    this.warn(eosID, 'Match-end switch sequence complete.');
                    break;
                case "test":
                    this.warn(eosID, 'Test 1');
                    await delay(2000);
                    this.warn(eosID, 'Test 2');
                    setTimeout(() => {
                        this.warn(eosID, 'Test 3');
                    }, 2000);
                    break;
                case "help":
                    if (isAdmin) {
                        this.warn(eosID, "Admin Controls\nPlayer: now, double, matchend, check, clear\nSquad: squad, doublesquad, matchendsquad");
                    } else {
                        this.warn(eosID, `[Switch] Commands\n!switch         | Request a team switch\n!switch check   | Check your eligibility\n!switch explain | How switching works\n!switch cancel  | Leave the queue`);
                    }
                    break;
                case "explain":
                    {
                        const cooldownHours = this.options.switchCooldownMinutes > 0 
                            ? (this.options.switchCooldownMinutes / 60).toFixed(1) 
                            : this.options.switchCooldownHours;
                        this.warn(eosID, `[Switch] How It Works (1/4)\nSwitching is allowed in the first ${this.options.switchEnabledMinutes}m after joining or after match start — whichever gives you more time.`);
                        await delay(5000);
                        this.warn(eosID, `[Switch] How It Works (2/4)\nIf teams are uneven, you are queued until a slot opens or a swap partner on the other team is found.`);
                        await delay(5000);
                        this.warn(eosID, `[Switch] How It Works (3/4)\nAfter switching, there is a ${cooldownHours}h cooldown before you can switch again.`);
                        await delay(5000);
                        this.warn(eosID, `[Switch] How It Works (4/4)\nAfter a scramble, switches are locked for ${this.options.scrambleLockdownDurationMinutes}m.\nUse !switch check to see your current status.`);
                    }
                    break;
                case "check":
                    {
                        const ident = commandSplit.splice(1).join(' ');
                        if (ident) {
                            // Admin-only: check another player
                            if (!isAdmin) {
                                this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                                this.warn(eosID, 'Only admins can check other players. Use !switch check with no name to see your own status.');
                                return;
                            }
                            this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                            const result = await this.checkPlayer(ident);
                            if (!result) this.warn(eosID, 'Player not found.');
                            else if (result === 'multiple') this.warn(eosID, 'Multiple players found. Please use SteamID.');
                            else {
                                const now = new Date();
                                const locked = result.scrambleLockdownExpiry && result.scrambleLockdownExpiry > now;
                                const cooldownDuration = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
                                const cooldown = result.lastSwitchTimestamp && (new Date(result.lastSwitchTimestamp.getTime() + cooldownDuration) > now);
                                this.warn(eosID, `Status: ${result.playerName || result.steamID} | Locked: ${locked ? 'Yes' : 'No'} | Cooldown: ${cooldown ? 'Yes' : 'No'}`);
                                this.verbose(1, `[Check] Admin check result: player=${result.playerName || result.steamID}, locked=${locked}, cooldown=${cooldown}`);
                            }
                        } else {
                            // Any player: check their own eligibility (show all 4 conditions)
                            const eosID = info.player?.eosID;
                            const teamID = info.player?.teamID;
                            if (!eosID || !teamID) {
                                this.warn(eosID, `[Switch] Unable to check eligibility.`);
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

                            this.warn(eosID, statusMsg);
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
                            this.warn(eosID, 'Player not found or multiple matches.');
                            return;
                        }
                        await this.safeTransaction(async (t) => {
                            await this.models.PlayerCooldowns.destroy({ where: { eosID: result.eosID }, transaction: t });
                        });
                        this.warn(eosID, `Cleared cooldowns for ${result.playerName || result.steamID}`);
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
                    this.warn(eosID, "All player cooldowns cleared.");
                    break;
                case 'cancel':
                    if (this._switchQueue.has(info.player?.eosID)) {
                        const entry = this._switchQueue.get(info.player.eosID);
                        clearInterval(entry.warnInterval);
                        this._switchQueue.delete(info.player.eosID);
                        this.warn(eosID, '[Switch Queue] Removed — you left the queue.');
                        this.verbose(1, `[Queue] ${playerName} cancelled — left the queue.`);
                    } else {
                        this.warn(eosID, '[Switch Queue] You are not currently in the queue.');
                    }
                    break;
                default:
                    await this.warn(eosID, [
                        `Unknown subcommand: "${subCommand}"`,
                        '',
                        '=== Switch Commands ===',
                        '!switch — Request team switch',
                        '!switch check — Show your eligibility status',
                        '!switch explain — Explain the rules',
                        '!switch status <player> — (Admin) Check a player',
                        '!switch clear <player> — (Admin) Clear player cooldown',
                        '!switch clearall — (Admin) Clear all cooldowns',
                        '!switch cancel — Leave the switch queue'
                    ].join('\n'));
                    return;
            }
        } else {
            await this.server.updateSquadList();
            await this.server.updatePlayerList();

            // Phase gate: engine-level team changes are impossible during faction voting
            if (this.s3IsEndgameFactionVote()) {
                this.warn(eosID, '[Switch] Team changes are locked during faction voting. Try again when the next round starts.');
                this.verbose(1, `[Switch] Denied ${playerName}: faction vote in progress.`);
                return;
            }

            // S³ lock gate: check if this player is being processed by a higher-priority actor
            const eosID2 = info.player?.eosID;
            const canActPlayers = this._s3.players;
            if (eosID2 && canActPlayers?.isReady && canActPlayers.canAct) {
                if (!canActPlayers.canAct(eosID2, 'Switch')) {
                    this.warn(eosID, '[Switch] You are currently being processed — please try again shortly.');
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
                    this.warn(eosID, `[Switch] Scramble lock active — expires in ${eligibility.remaining}m.\nYour switch window may close before this expires.\nUse !switch check to see your full status.`);
                    this.verbose(1, `[Switch] Denied ${playerName}: Scramble lockdown active.`);
                } else if (eligibility.reason === 'time_window') {
                    this.warn(eosID, `[Switch] Join/match window closed.\nSwitching is only allowed in the first ${this.options.switchEnabledMinutes}m after joining or after\nmatch start — whichever gives you more time.\nUse !switch explain for details.`);
                    this.verbose(1, `[Switch] Denied ${playerName}: Match time limit exceeded.`);
                } else if (eligibility.reason === 'cooldown') {
                    this.warn(eosID, `[Switch] On cooldown — available in ${eligibility.remaining}m.\nUse !switch check to see your full status.`);
                    this.verbose(1, `[Switch] Denied ${playerName}: Cooldown active.`);
                }
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
             let preSwitchTeam = teamID;
             try {
                 await this._taggedSwitchPlayer(eosID, 'Player-Self');
                 
                 // VERIFY: After RCON returns success, check the player actually moved teams.
                 // AdminForceTeamChange can return SUCCESS from the RCON layer even when the game
                 // engine silently rejects the move (e.g., 1v0 edge case, team-locked state).
                 // We do a follow-up poll and verify teamID changed before marking switchSuccess=true.
                 await delay(1000);
                 await this.server.updatePlayerList();
                 const postSwitchPlayer = this.server.players.find(p => p.eosID === eosID);
                 const postSwitchTeam = postSwitchPlayer?.teamID;
                 
                 if (postSwitchTeam !== undefined && postSwitchTeam !== null && String(postSwitchTeam) !== String(preSwitchTeam)) {
                     this.verbose(1, `[Switch] RCON SUCCESS + VERIFIED: ${playerName} moved from T${preSwitchTeam} to T${postSwitchTeam}`);
                     switchSuccess = true;
                 } else {
                     this.verbose(1, `[Switch] RCON returned success but team DID NOT CHANGE for ${playerName} (was T${preSwitchTeam}, still T${postSwitchTeam || '??'}). Not recording cooldown.`);
                     this.warn(eosID, `[Switch] The server could not complete the team change. Try again later.`);
                 }
             } catch (err) {
                this.verbose(1, `[Switch] RCON exception for ${playerName}: ${err.message}`);
                
                if (err.message && (err.message.toLowerCase().includes('timeout') || err.message.toLowerCase().includes('timed out'))) {
                    this.verbose(1, `[Switch] RCON timeout for ${playerName}, verifying switch status...`);
                    await delay(3000);
                    await this.server.updatePlayerList();
                    const currentPlayer = this.server.players.find(p => p.eosID === eosID);

                    if (currentPlayer && String(currentPlayer.teamID) !== String(preSwitchTeam)) {
                        this.verbose(1, `[Switch] Verified after timeout: ${playerName} switched from Team ${preSwitchTeam} to Team ${currentPlayer.teamID}`);
                        switchSuccess = true;
                    } else {
                        this.verbose(1, `[Switch] Verified after timeout: ${playerName} switch failed (${currentPlayer ? `still on Team ${preSwitchTeam}` : 'player disconnected'})`);
                        this.warn(eosID, "[Switch] Switch failed — please try again or contact an admin.");
                    }
                } else {
                    this.verbose(1, `Error executing switch: ${err.message}`);
                    this.warn(eosID, "[Switch] Switch failed — please try again or contact an admin.");
                }
            }

            if (switchSuccess) {
                this.verbose(1, `[Switch] Cooldown decision: liberalMode=${isLiberal}, writing cooldown=${!isLiberal}`);
                if (!isLiberal) {
                    try {
                        const eosID = info.player?.eosID;
                        if (!eosID) {
                            this.verbose(1, `[PlayerCooldowns] Missing eosID for player ${playerName}, skipping cooldown write`);
                        } else {
                            const now = new Date();
                            this.verbose(1, `[Switch] Writing cooldown for ${playerName} (eosID=${eosID}) at ${now.toISOString()}`);
                            await this.safeTransaction(async (t) => {
                                await this.models.PlayerCooldowns.upsert({ eosID, steamID, playerName, lastSwitchTimestamp: now }, { transaction: t });
                            });
                            this.verbose(1, `[Switch] Cooldown written successfully for ${playerName}`);
                        }
                    } catch (dbErr) {
                        this.verbose(1, `[Switch] Database update failed: ${dbErr.message}`);
                    }
                }
                
                this.verbose(1, `[Switch] Executed for ${playerName}.`);
            } else {
                this.verbose(1, `[Switch] NOT recording cooldown for ${playerName} — switchSuccess=${switchSuccess}`);
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
             this.warn(pl.steamID ? pl.eosID || pl.steamID : pl.eosID, '[Switch] Round ending — you will be switched in 15 seconds.');
         });
         await delay(15 * 1000);
         await Promise.all(players.map(async (pl) => {
             await this._taggedSwitchPlayer(pl.eosID || pl.steamID, 'Admin-Force');
             return await this.models.Endmatch.destroy({
                 where: {
                     id: pl.id
                 }
             });
         }));
     }

    async onRoundEnded(dt) {
        for (const entry of this._switchQueue.values()) {
            clearInterval(entry.warnInterval);
        }
        this._switchQueue.clear();
        this._lastTeamSnapshot = null;
        this.verbose(2, '[Queue] Switch queue cleared on round end.');
        await this.cleanup();
        await this.doSwitchMatchend();
        this._switchedOnJoin.clear();
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
        const gs = this._s3.gameState;
        const layerName = (gs?.getLayerName?.() || '').toLowerCase();
        const gamemode = (gs?.getGamemode?.() || '').toLowerCase();
        return this._liberalModes.some(m => layerName.includes(m) || gamemode.includes(m));
    }

    s3IsEndgameFactionVote() {
        const gs = this._s3.gameState;
        return gs?.isEndgameFactionVote?.() === true;
    }

    /**
     * HELPER: Compute dynamic extra tolerance slots based on current player count.
     */
    getDynamicExtraSlots() {
        if (!this.options.dynamicBalanceTolerance) return 0;

        const UPPER_BOUND = 98;
        const floor = this.options.dynamicBalancePlayerFloor;
        const extra = this.options.dynamicBalanceExtraSlots;

        let totalPlayers = 0;
        for (let p of this.server.players) totalPlayers++;

        if (totalPlayers >= UPPER_BOUND) return 0;
        
        if (totalPlayers <= floor) return extra;
        
        const interpolated = extra * (UPPER_BOUND - totalPlayers) / (UPPER_BOUND - floor);
        return Math.round(interpolated);
    }

     getSwitchSlotsPerTeam(teamID, effectiveCap = null) {
         const balanceDifference = this.getTeamBalanceDifference();

         let cap = effectiveCap !== null ? effectiveCap : this.options.maxUnbalancedSlots;

         const dynamicExtra = this.getDynamicExtraSlots();
         if (dynamicExtra > 0) {
             cap += dynamicExtra;
             this.verbose(2, `[Dynamic Balance] Extra slots: +${dynamicExtra} | Effective cap: ${cap}`);
         }

         const postSwitchDiff = teamID === 1
             ? balanceDifference - 2
             : balanceDifference + 2;

         if (Math.abs(postSwitchDiff) > cap) {
             return 0;
         }

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

        if (cooldownData && cooldownData.scrambleLockdownExpiry && new Date(cooldownData.scrambleLockdownExpiry).getTime() > now) {
            const remaining = Math.ceil((new Date(cooldownData.scrambleLockdownExpiry).getTime() - now) / 60000);
            return { eligible: false, reason: 'scramble_lock', remaining };
        }

        if (!this.isLiberalMode()) {
            const connectionSeconds = await this.getSecondsFromJoin(eosID);
            const matchSeconds = this.getSecondsFromMatchStart();
            const limit = this.options.switchEnabledMinutes;

            if (connectionSeconds / 60 > limit && matchSeconds / 60 > limit) {
                return { eligible: false, reason: 'time_window' };
            }

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

    _requestQueueRefresh() {
        // Trigger player list refresh via S³ PlayersService when queue is active.
        // S³ handles coalescing, rate-limiting, and natural-tick cancellation.
        const refreshPlayers = this._s3.players;
        if (refreshPlayers?.isReady() && refreshPlayers.requestRefresh) {
            refreshPlayers.requestRefresh('Switch', { urgency: 'normal' });
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
            this.warn(eosID,
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

            this.warn(entry.eosID,
                `[Switch Queue]\nPosition ${pos} in the queue.\n~${remaining}m remaining | Team ${entry.teamID} → Team ${targetTeam}\nType !switch cancel to leave.`
            );
        }, 30_000);

        const sameTeamAtEnqueue = [...this._switchQueue.values()]
            .filter(e => e.teamID === teamID);
        const enqueuePos = sameTeamAtEnqueue.length + 1;
        const targetTeam = teamID === 1 ? 2 : 1;
        const remainingAtEnqueue = (windowMs / 60000).toFixed(1);

        this._switchQueue.set(eosID, { eosID, steamID, playerName, teamID, queuedAt, warnInterval });

        this.warn(eosID,
            `[Switch Queue]\nAdded to position ${enqueuePos} in the queue.\n~${remainingAtEnqueue}m remaining | Team ${teamID} → Team ${targetTeam}\n${reason}\nType !switch cancel to leave.`
        );
        this.verbose(1, `[Queue] ${playerName} (T${teamID}) enqueued at position ${enqueuePos}. Queue size: ${this._switchQueue.size}`);

        this._requestQueueRefresh();
    }

    async _processQueue() {
        if (this._queueProcessing) {
            this.verbose(2, `[Queue] Processing already in progress — skipping concurrent invocation.`);
            return;
        }
        
        this._queueProcessing = true;
        try {
            if (this.s3IsEndgameFactionVote()) {
                if (this._switchQueue.size > 0) {
                    this.verbose(2, `[Queue] Faction vote in progress — skipping queue processing.`);
                }
                return;
            }

            const windowMs = this.options.switchEnabledMinutes * 60 * 1000;
            const now = Date.now();

            for (const [eosID, entry] of this._switchQueue.entries()) {
                if ((now - entry.queuedAt) >= windowMs) {
                    clearInterval(entry.warnInterval);
                    this._switchQueue.delete(eosID);
                    this.warn(entry.eosID, `[Switch Queue] Removed — join/match window closed.\nYour ${this.options.switchEnabledMinutes}m window expired while waiting.\nUse !switch explain for details.`);
                    this.verbose(2, `[Queue] ${entry.playerName} expired and removed from queue.`);
                }
            }

            let t1 = 0, t2 = 0;
            for (const p of this.server.players) {
                if (p.teamID === 1) t1++;
                else if (p.teamID === 2) t2++;
            }
            const prevSnapshot = this._lastTeamSnapshot;
            const stable = prevSnapshot !== null
                && prevSnapshot.t1 === t1
                && prevSnapshot.t2 === t2;
            this._lastTeamSnapshot = { t1, t2 };

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

                clearInterval(p1.warnInterval);
                this._switchQueue.delete(p1.eosID);
                clearInterval(p2.warnInterval);
                this._switchQueue.delete(p2.eosID);

                this.warn(p1.eosID, '[Switch Queue] Swap partner found — switching now.');
                this.warn(p2.eosID, '[Switch Queue] Swap partner found — switching now.');

                await this._taggedSwitchPlayer(p1.eosID, 'Player-Queue');
                await this._taggedSwitchPlayer(p2.eosID, 'Player-Queue');

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

            const t1Queued = remaining.filter(e => e.teamID === 1).length;
            const t2Queued = remaining.filter(e => e.teamID === 2).length;

            if (this._switchQueue.size > 0) {
                this.verbose(2, `[Queue] T1: ${t1Queued} queued | T2: ${t2Queued} queued | Teams: ${t1}v${t2} | Diff: ${t1 - t2}`);
            }

            const firstT1 = remaining.find(e => e.teamID === 1);
            const firstT2 = remaining.find(e => e.teamID === 2);

            for (const entry of [firstT1, firstT2].filter(Boolean)) {
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

                    this.warn(entry.eosID, '[Switch Queue] Balance slot opened — switching now.');
                    await this._taggedSwitchPlayer(entry.eosID, 'Player-Queue');

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

                    break;
                }
            }

        } catch (err) {
            this.verbose(1, `[Queue] _processQueue error: ${err.message}`);
        } finally {
            this._queueProcessing = false;
        }
    }

    async getSecondsFromJoin(eosID) {
        const joinPlayers = this._s3.players;
        const player = joinPlayers?.isReady() && joinPlayers.getPlayer(eosID);
        return player?.joinTime ? (Date.now() - player.joinTime) / 1000 : 0;
    }

    getSecondsFromMatchStart() {
        return (Date.now() - +this.server.layerHistory[ 0 ].time) / 1000 || 0;
    }

    handlePlayerLeave(eosID, teamID, playerName) {
        if (this._switchQueue.has(eosID)) {
            const entry = this._switchQueue.get(eosID);
            clearInterval(entry.warnInterval);
            this._switchQueue.delete(eosID);
            this.verbose(2, `[Queue] ${playerName} disconnected — removed from queue.`);
        }
        this.verbose(2, `Player disconnected ${playerName}`);
        // Clean up double-switch tracking — use eosID as the canonical key
        this.recentDoubleSwitches = this.recentDoubleSwitches.filter(p => p.eosID != eosID);
    }

    async switchToPreDisconnectionTeam(info) {
        if (!this.options.switchToOldTeamAfterRejoin) return;

        const eosID = info.player?.eosID;
        if (!info.player || !eosID) return;
        const playerName = info.player?.name;
        const teamID = info.player?.teamID;
        const previousTeamID = info.previousTeamID;

        if (previousTeamID == null) return;

        const needSwitch = teamID != previousTeamID;
        this.verbose(2, `${playerName}: Switching to old team: ${needSwitch}`);

         if (needSwitch) {
             setTimeout(() => {
                 this._taggedSwitchPlayer(eosID, 'Switch-Rejoin').catch(err => {
                     this.verbose(1, `Error auto-switching ${playerName} to old team: ${err.message}`);
                 });
             }, 5000)
         }
    }

      async doubleSwitchPlayer(eosID, forced = false, senderSteamID) {
          const playerObj = eosID ? this.server.players.find(p => p.eosID === eosID) : null;
          const playerEosID = playerObj?.eosID || eosID;

          const recentSwitch = this.recentDoubleSwitches.find(e => e.eosID == playerEosID);
          const cooldownHoursLeft = (Date.now() - +recentSwitch?.datetime) / (60 * 60 * 1000);

          if (!forced) {
              const joinSeconds = await this.getSecondsFromJoin(playerEosID);
             if (joinSeconds / 60 > this.options.doubleSwitchEnabledMinutes && this.getSecondsFromMatchStart() / 60 > this.options.doubleSwitchEnabledMinutes) {
                 this.warn(playerEosID, `Time Limit: Double switch allowed only in first ${this.options.doubleSwitchEnabledMinutes}m of join/match.`);
                 return;
             }

             if (recentSwitch && cooldownHoursLeft < this.options.doubleSwitchCooldownHours) {
                 this.warn(playerEosID, `Cooldown: Double switch used recently. Wait ${this.options.doubleSwitchCooldownHours}h.`);
                 return;
             }

              if (recentSwitch)
                  recentSwitch.datetime = new Date();
              else
                  this.recentDoubleSwitches.push({ eosID: playerEosID, datetime: new Date() });
         }

         try {
             await this._taggedSwitchPlayer(playerEosID, 'Switch-Double-Swap');
             await delay(this.options.doubleSwitchDelaySeconds * 1000);
             await this._taggedSwitchPlayer(playerEosID, 'Switch-Double-Swap');

             if (forced && senderSteamID) this.warn(senderSteamID, `Player has been double-switched.`);
         } catch (err) {
             this.verbose(1, `Double switch failed for ${playerEosID}: ${err.message}`);
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
                 await this._taggedSwitchPlayer(p.eosID, 'Admin-Force');
             } catch (err) {
                 this.verbose(1, `Failed to switch squad member ${p.name}: ${err.message}`);
             }
         }
     }

    getPlayersFromSquad(number, team) {
        const team_id = +team;
        if (!(team_id >= 0)) {
            this.verbose(1, "Invalid team ID for getPlayersFromSquad:", team);
            return;
        }
        return this.server.players.filter((p) => p.teamID == team_id && p.squadID == number)
    }

     async doubleSwitchSquad(number, team) {
         const players = this.getPlayersFromSquad(number, team);
         if (!players) return;
         
         for (let p of players) {
             try {
                 await this._taggedSwitchPlayer(p.eosID, 'Switch-Double-Swap');
             } catch (err) {
                 this.verbose(1, `First double-switch hop failed for ${p.name}: ${err.message}`);
             }
         }
         
         await delay(this.options.doubleSwitchDelaySeconds * 1000);
         
         for (let p of players) {
             try {
                 await this._taggedSwitchPlayer(p.eosID, 'Switch-Double-Swap');
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
                eosID: p.eosID,
            });
        }
    }

    async addPlayerToMatchendSwitches(player) {
        await this.models.Endmatch.create({
            name: player.name,
            steamID: player.steamID,
            eosID: player.eosID,
        });
    }

    /**
     * Records the source of a player switch and emits attribution event BEFORE RCON execution.
     * Automatically computes the target team (opposite of current team).
     * Sources: 'Player-Self', 'Admin-Force', 'Switch-Double-Swap', 'Switch-Rejoin'
     * 
     * CRITICAL: Event is emitted BEFORE RCON fires to ensure SmartAssign's _externalMoveMap
     * is populated before UPDATED_PLAYER_INFORMATION polling detects the team change.
     */
    async _taggedSwitchPlayer(eosID, source) {
        const executionTimestamp = Date.now();
        
        // Resolve player by eosID (primary identifier per SquadJS spec)
        const player = this.server.players.find(p => p.eosID === eosID);
        if (!player) {
          this.verbose(1, `[Switch] WARNING: Player with eosID ${eosID} not found in server.players for source=${source}`);
          return null;
        }
        
        const currentTeam = player?.teamID;
        const currentTeamNum = Number(currentTeam);
        const targetTeam = currentTeamNum === 1 ? 2 : currentTeamNum === 2 ? 1 : null;
        const steamID = player.steamID;
        
        this.verbose(2, `[Switch] EXECUTING: player=${player.name} (eosID=${eosID}, steamID=${steamID}), source=${source}, currentTeam=${currentTeam}, targetTeam=${targetTeam}, timestamp=${executionTimestamp}`);
        
        // Guard against null team ID
        if (targetTeam === null) {
          this.verbose(1, `[Switch] ERROR: Cannot switch player ${player.name} - currentTeam is null or invalid (value=${currentTeam})`);
          return null;
        }
        
        // S³ attribution: Record the move so S3_PLAYER_TEAM_CHANGED fires with the correct source
        const attributionPlayers = this._s3.players;
        if (attributionPlayers?.isReady() && attributionPlayers.recordMove && eosID) {
          attributionPlayers.recordMove(eosID, targetTeam, source);
          this.verbose(2, `[Switch] S³ recordMove registered: source=${source}, targetTeam=${targetTeam}`);
        }

        try {
            // Per RCON_IDENTIFIER_FINDINGS: eosID is NOT a valid RCON identifier.
            // Player name is the only universally reliable RCON identifier.
            const result = await this.server.rcon.execute(`AdminForceTeamChange "${player.name}"`);
            this.verbose(3, `[Switch] RCON SUCCESS: AdminForceTeamChange returned for ${player.name}`);
            return result;
        } catch (err) {
            this.verbose(1, `[Switch] ERROR: AdminForceTeamChange failed for ${player.name} (eosID=${eosID}): ${err.message}`);
            throw err;
        }
    }

    switchPlayer(eosID) {
        // Per RCON_IDENTIFIER_FINDINGS: eosID is NOT a valid RCON identifier.
        // Player name is the only universally reliable RCON identifier.
        const player = this.server.players.find(p => p.eosID === eosID);
        if (!player) {
            this.verbose(1, `[Switch] switchPlayer: Player with eosID ${eosID} not found`);
            return null;
        }
        return this.server.rcon.execute(`AdminForceTeamChange "${player.name}"`);
    }

    onNewGame() {
        this.verbose(1, '[NEW_GAME] Round started — null-teamID window handled by S³ players service.');
    }

    async onS3PlayerJoined(data) {
        if (!data?.player?.eosID) return;
        const { eosID, name, teamID } = data.player;
        const previousTeamID = data.previousTeamID;

        // Rejoin auto-switch — uses previousTeamID from S³'s reconnect memory
        // (enriched via S3_PLAYER_JOINED payload), not a local cache.
        if (!this._switchedOnJoin.has(eosID)) {
            this._switchedOnJoin.add(eosID);
            if (this.options.switchToOldTeamAfterRejoin && previousTeamID != null) {
                setTimeout(() => {
                    this.switchToPreDisconnectionTeam({ player: { eosID, name, teamID }, previousTeamID }).catch(err => {
                        this.verbose(1, `Error auto-switching ${name} to old team: ${err.message}`);
                    });
                }, 5000);
            }
        }

        // Trigger queue processing if not in faction vote
        if (!this.s3IsEndgameFactionVote()) {
            await this._processQueue();
        }
    }

    async onS3PlayerLeft(data) {
        if (!data?.player?.eosID) return;
        this._removePlayerFromQueue(data.player.eosID);
        if (!this.s3IsEndgameFactionVote()) {
            await this._processQueue();
        }
    }

    async onS3PlayerTeamChanged(data) {
        if (!data?.player?.eosID) return;
        if (!this.s3IsEndgameFactionVote()) {
            await this._processQueue();
        }
    }

    _removePlayerFromQueue(eosID) {
        if (this._switchQueue.has(eosID)) {
            const entry = this._switchQueue.get(eosID);
            clearInterval(entry.warnInterval);
            this._switchQueue.delete(eosID);
        }
    }

    async unmount() {
        // Unregister S³ refresh interest
        const unmountPlayers = this._s3.players;
        if (unmountPlayers?.isReady() && unmountPlayers.unregisterRefreshInterest) {
            unmountPlayers.unregisterRefreshInterest('Switch');
        }

        this.server.removeListener('CHAT_MESSAGE', this.onChatMessage);
        this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
        this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
        this.server.removeListener('NEW_GAME', this.onNewGame.bind(this));
        this.server.removeListener('S3_PLAYER_JOINED', this.onS3PlayerJoined);
        this.server.removeListener('S3_PLAYER_LEFT', this.onS3PlayerLeft);
        this.server.removeListener('S3_PLAYER_TEAM_CHANGED', this.onS3PlayerTeamChanged);
        if (this.options.discordClient) this.options.discordClient.removeListener('message', this.onDiscordMessage);
        for (const entry of this._switchQueue.values()) {
            clearInterval(entry.warnInterval);
        }
        this._switchQueue.clear();
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
                            {
                                [Op.or]: [
                                    { firstSeenTimestamp: null },
                                    { firstSeenTimestamp: { [Op.lt]: new Date(now.getTime() - (24 * 60 * 60 * 1000)) } }
                                ]
                            }
                        ]
                    },
                    transaction: t
                });
            });
            // recentDisconnections cleanup removed in Stage 6.2b — S³ reconnect memory
            // handles disconnect tracking with DB-backed persistence and periodic pruning.
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

        // Filter: only lock players who are OUTSIDE the switch time window.
        // Players who recently joined or are in a short round should not be locked,
        // because they had no time to exploit the pre-scramble imbalance.
        const switchWindowMs = this.options.switchEnabledMinutes * 60 * 1000;
        const lockoutPlayers = [];
        for (const p of affectedPlayers) {
            if (!p.eosID) {
                this.verbose(1, `[SCRAMBLE_EVENT] Skipping ${p.name} — missing eosID`);
                continue;
            }
            const joinSeconds = await this.getSecondsFromJoin(p.eosID);
            const matchSeconds = this.getSecondsFromMatchStart();
            const withinWindow = (joinSeconds * 1000) < switchWindowMs || (matchSeconds * 1000) < switchWindowMs;
            if (withinWindow) {
                this.verbose(2, `[SCRAMBLE_EVENT] Skipping lockdown for ${p.name} — within switch window (join: ${joinSeconds.toFixed(1)}s, match: ${matchSeconds.toFixed(1)}s)`);
                continue;
            }
            lockoutPlayers.push(p);
        }

        const lockdownDuration = this.options.scrambleLockdownDurationMinutes * 60 * 1000;
        const expiry = new Date(Date.now() + lockdownDuration);
        this.verbose(2, `[SCRAMBLE_EVENT] Lockdown duration: ${this.options.scrambleLockdownDurationMinutes}min | Expiry: ${expiry.toISOString()}`);

        if (lockoutPlayers.length === 0) {
            this.verbose(1, `[SCRAMBLE_EVENT] All ${affectedPlayers.length} affected players are within the switch window — no lockdown records written.`);
            return;
        }

         const records = lockoutPlayers
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

            try {
                const embed = {
                    title: '🌪️ Scramble Lockdown Initiated',
                    color: 0xff9800,
                    description: `${records.length} players have been locked from switching for the next ${this.options.scrambleLockdownDurationMinutes} minutes.`,
                    fields: [
                        { name: 'Lockdown Duration', value: `${this.options.scrambleLockdownDurationMinutes} minutes`, inline: true },
                        { name: 'Expires At', value: `<t:${Math.floor(expiry.getTime() / 1000)}:R>`, inline: true },
                        { name: 'Players Affected', value: String(records.length), inline: true }
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