import Sequelize from 'sequelize';
import S3DiscordPluginBase from './s3-discord-plugin-base.js';
import { setTimeout as delay } from "timers/promises";
const { Op } = Sequelize;

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
 * tracking and attribution. Uses _requestTeamChange() retry/verify
 * from S3DiscordPluginBase, and getSecondsFromJoin() /
 * getSecondsFromMatchStart() for join-time awareness. Supports
 * in-game chat commands and Discord admin commands.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * Switch (default)
 *   Extends S3DiscordPluginBase. Key public methods:
 *     mount()                          — Registers event listeners and initializes state.
 *     unmount()                        — Removes listeners, clears queue, unregisters S³ interest.
 *     switchPlayer(eosID)              — Executes AdminForceTeamChange via RCON for one player.
 *     doubleSwitchPlayer(eosID, forced, senderSteamID) — Swaps a player to the opposite team and back.
 *     switchSquad(number, team)        — Switches all members of a squad to the opposite team.
 *     doubleSwitchSquad(number, team)  — Double-switches all members of a squad.
 *     getDiagnosticInfo()              — Returns DB health, active lock count, and stored player count.
 *     checkPlayer(ident)               — Looks up a player's cooldown/lock state by eosID or name.
 *     cleanup()                        — Purges expired cooldown rows from the database.
 *     getPlayersByUsername(username)   — Fuzzy player search by name substring.
 *     getPlayerBySteamID(steamID)      — Exact player lookup by SteamID.
 *     getPlayerByUsernameOrSteamID(ident) — Combined lookup with ambiguity warnings.
 *     getSecondsFromJoin(eosID)        — Seconds since player joined (via S³).
 *     getSecondsFromMatchStart()       — Seconds since current layer started.
 *     getTeamBalanceDifference()       — Returns signed team-size delta (Team1 − Team2).
 *     getSwitchSlotsPerTeam(teamID, effectiveCap) — Available switch slots for a given team.
 *     addPlayerToMatchendSwitches(p)   — Queues a player for end-of-round team switch.
 *     addSquadToMatchendSwitches(n, t) — Queues an entire squad for end-of-round switch.
 *     onChatMessage(info)              — Handles all in-game !switch / !change / double-switch commands.
 *     onDiscordMessage(message)        — Handles Discord !switch admin commands.
 *     onRoundEnded(info)               — Processes end-of-round switch queue.
 *     onScrambleExecuted(data)         — Applies scramble lockdown to affected players.
 *     onNewGame()                      — Logs new-game transition, starts broadcast timers.
 *     onS3PlayerJoined(data)           — Triggers rejoin auto-switch, queue processing, and join warn.
 *     onS3PlayerLeft(data)             — Removes player from queue, triggers queue processing.
 *     onS3PlayerTeamChanged(data)      — Triggers queue processing on team change.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * S3DiscordPluginBase (./s3-discord-plugin-base.js)
 *   SquadJS base class providing Discord connector, server, options, and S³ lifecycle.
 *
 * ─── S³ INTEGRATION ──────────────────────────────────────────────
 *
 * DB models are managed via S³ MigrationEngine . Tables
 * (SwitchPlugin_PlayerCooldowns, SwitchPlugin_Endmatches) are created
 * through version-tracked migrations on the S³ connector, replacing
 * the old createModel() / sync({alter}) / raw ALTER TABLE pattern.
 * All transactions use s3db.withTransactionWithRetry().
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
 *   - serverConfig: getAllowTeamChanges() — detects whether scoreboard
 *               team changes are disabled.
 *
 * Emitted Events:
 *   - None.
 *
 * Listened Events:
 *   - S3_PLAYER_JOINED: triggers rejoin auto-switch, queue processing, and join warn.
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
 * - DB transaction retry (via s3db.withTransactionWithRetry()) handles
 *   SQLITE_BUSY with retry+jitter.
 * - PlayerCooldowns table is version-tracked via S³ MigrationEngine
 *   — no more sync({alter}) or drop-and-recreate.
 * - Endmatch switch queue persists across restarts via the
 *   SwitchPlugin_Endmatches table; processed on ROUND_ENDED.
 * - Broadcast timers and join-warn timeouts are cleaned up in unmount().
 * - JOIN_WARN_DELAY_MS constant controls the delay before showing
 *   ChangeTeam-disabled warning to joining players (90s default).
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
export default class Switch extends S3DiscordPluginBase {
    static version = '2.0.0';

    static get description() {
        return "Switch plugin with persistent join timers";
    }

    static get defaultEnabled() {
        return true;
    }

    /** Delay in ms before showing ChangeTeam-disabled warning to joining players (90s). */
    static get JOIN_WARN_DELAY_MS() { return 90000; }

    static get optionsSpecification() {
        return {
            ...this.parentOptionsSpecification,
            channelID: {
                required: false,
                description: 'Discord channel ID (mapped from discordChannelID for base class compatibility)',
                default: ''
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
            },
            // ── v2.0.0 Options ─────────────────────────────────────
            broadcastSwitchWindowMessages: {
                required: false,
                description: 'Broadcast switch window open/close/reminder messages to the server.',
                default: true
            },
            switchWindowBroadcastDelaySeconds: {
                required: false,
                description: 'Seconds after match start before the first broadcast.',
                default: 60
            },
            switchWindowBroadcastIntervalMinutes: {
                required: false,
                description: 'Minutes between switch window reminder broadcasts.',
                default: 2
            },
            warnOnJoinChangeTeamDisabled: {
                required: false,
                description: 'Warn joining players that scoreboard team changes are disabled and !switch is the alternative.',
                default: true
            },
            queueEnabled: {
                required: false,
                description: 'Enable the switch queue. When disabled, !switch only works if a balance slot is immediately available.',
                default: true
            },
            roundEndSummaryEnabled: {
                required: false,
                description: 'Post a Discord embed with round-end queue summary showing self-switches, pair trades, handshake swaps, failures, expiries, disconnects, and cancellations.',
                default: true
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
        this.safeDiscordReply = this.safeDiscordReply.bind(this);
        this._checkSwitchEligibility = this._checkSwitchEligibility.bind(this);
        this.onS3PlayerJoined = this.onS3PlayerJoined.bind(this);
        this.onS3PlayerLeft = this.onS3PlayerLeft.bind(this);
        this.onS3PlayerTeamChanged = this.onS3PlayerTeamChanged.bind(this);

        this.recentSwitches = [];
        this.recentDoubleSwitches = [];
        this._switchQueue = {
            t1: [], // players on T1 wanting T2 — ordered FIFO
            t2: []  // players on T2 wanting T1 — ordered FIFO
        };
        this._lastTeamSnapshot = null;      // { t1: number, t2: number } — previous poll's team counts for stability check
        this._switchedOnJoin = new Set();
        this._queueProcessing = false;      // Re-entrancy guard for _processQueue
        this._onPlayerInfoUpdated = this._onPlayerInfoUpdated.bind(this);
        this._periodicProcessingActive = false;  // true while queue non-empty — triggers _processQueue on each S3_PLAYERS_UPDATED
        // _s3 and _s3db are initialized by S3PluginBase — do NOT override here
        
        this._liberalModes = [];

        // Models are now on S³ — accessed via this._s3db.models.SwitchPlugin_PlayerCooldowns etc.

        // v2.0.0: ChangeTeam-disabled flag (queried from S³ serverConfig during _onS3Ready)
        this._changeTeamDisabled = false;

        // v2.0.0: Broadcast timer handles (cleared in _onUnmount)
        this._broadcastTimers = {
            firstBroadcast: null,
            reminderInterval: null,
            closeBroadcast: null,
            genericInfoTimer: null    // v2.0.0: 25-minute generic info broadcast
        };

        // v2.0.0: Map of join-warn timeouts per eosID (cleared on disconnect/cleanup)
        this._joinWarnTimeouts = new Map();

        this._scrambleHappened = false;   // set by onScrambleExecuted, consumed by onNewGame

        this.broadcast = (msg) => { this.server.rcon.broadcast(msg); };
        this.warn = (id, msg) => {
            if (!id) return;
            const player = this.server.players.find(p => p.eosID === id || p.steamID === id);
            const name = player?.name || id;
            this.server.rcon.warn(name, msg);
        };
    }

    async safeDiscordReply(message, content) {
        if (!message || !content) return;
        try {
            await message.reply(content);
        } catch (err) {
            this.verbose(1, `Discord reply failed: ${err.message}`);
        }
    }

    /** ── Round-end summary helpers ──────────────────────────── */

    _initRoundStats() {
        return {
            instantSwitches: [],    // { name, eosID, fromTeam, toTeam }
            deniedSwitches: [],     // { name, eosID, reason }
            queueTeamTrades: [],    // { p1Name, p2Name, queueDurationSeconds }
            queueNormal: [],        // { name, eosID, queueDurationSeconds }
            queueJoinSwaps: [],     // { name, eosID, type ('swap'|'consume'), queueDurationSeconds }
            queueExpiries: [],      // { name, eosID }
            queueDisconnects: [],   // { name, eosID }
            queueCancels: [],       // { name, eosID }
            maxQueueSize: 0,        // peak _getQueueSize() during the round
            queueDurationsMs: [],   // cumulative — used for average wait time
        };
    }

    _updateMaxQueueSize() {
        const current = this._getQueueSize();
        if (current > this._roundStats.maxQueueSize) {
            this._roundStats.maxQueueSize = current;
        }
    }

    async mount() {
        await super.mount();

        // At this point S³ is discovered, ready, _s3db cached, and _onS3Ready() completed.
        // Wire event listeners — business logic, not S³ boilerplate.
        this._liberalModes = (this.options.liberalSwitchGameModes || ['Seed', 'Jensen']).map(m => String(m).toLowerCase());
        this._roundStats = this._initRoundStats();

        this.server.on('CHAT_MESSAGE', this.onChatMessage);
        this.server.on('ROUND_ENDED', this.onRoundEnded);
        this.server.on('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
        this.server.on('NEW_GAME', this.onNewGame.bind(this));
        this.server.on('S3_PLAYER_JOINED', this.onS3PlayerJoined);
        this.server.on('S3_PLAYER_LEFT', this.onS3PlayerLeft);
        this.server.on('S3_PLAYER_TEAM_CHANGED', this.onS3PlayerTeamChanged);
        if (this.options.discordClient) {
            this.options.discordClient.on('message', this.onDiscordMessage);
        }
    }

    /**
     * _onS3Ready — S³ lifecycle hook (called by S3PluginBase.mount() after _s3.ready()).
     * Handles DB model definition, migration registration, refresh interest,
     * and ChangeTeam detection.
     */
    async _onS3Ready() {
        if (!this._s3db?.isReady?.() || !this._s3db.migrationEngine) {
            this.verbose(1, '[S3] S³ DB or migrationEngine not available — cannot register Switch schema. Mounting without DB.');
            return;
        }

        // v2.0.0: Detect whether scoreboard team changes are disabled
        try {
            const sc = this._s3?.serverConfig;
            if (sc?.isReady?.() && typeof sc.getAllowTeamChanges === 'function') {
                this._changeTeamDisabled = !sc.getAllowTeamChanges();
                this.verbose(2, `[S3] ChangeTeam detection: ${this._changeTeamDisabled ? 'DISABLED' : 'enabled'}.`);
            } else {
                this.verbose(2, '[S3] serverConfig not available — assuming ChangeTeam is enabled.');
            }
        } catch (err) {
            this.verbose(1, `[S3] Failed to query ChangeTeam setting: ${err.message}. Assuming enabled.`);
        }

        // Define models on S³ connector (idempotent — defineModel caches)
        this.defineModel('SwitchPlugin_PlayerCooldowns', {
            eosID: {
                type: this._s3db.getDataTypes().STRING,
                primaryKey: true,
                allowNull: false
            },
            steamID: {
                type: this._s3db.getDataTypes().STRING,
                allowNull: true
            },
            playerName: {
                type: this._s3db.getDataTypes().STRING,
                allowNull: true
            },
            lastSwitchTimestamp: {
                type: this._s3db.getDataTypes().DATE,
                allowNull: true
            },
            firstSeenTimestamp: {
                type: this._s3db.getDataTypes().DATE,
                allowNull: true
            },
            scrambleLockdownExpiry: {
                type: this._s3db.getDataTypes().DATE,
                allowNull: true
            }
        }, { timestamps: false });

        this.defineModel('SwitchPlugin_Endmatches', {
            id: {
                type: this._s3db.getDataTypes().INTEGER,
                primaryKey: true,
                autoIncrement: true
            },
            name: {
                type: this._s3db.getDataTypes().STRING
            },
            steamID: {
                type: this._s3db.getDataTypes().STRING
            },
            eosID: {
                type: this._s3db.getDataTypes().STRING
            },
            created_at: {
                type: this._s3db.getDataTypes().DATE,
                defaultValue: this._s3db.getDataTypes().NOW
            }
        }, { timestamps: false });

        // Register expected version + v1 migration
        this.registerExpectedVersion('switch', 1);
        this.registerMigrations('switch', [
            {
                version: 1,
                description: 'Create SwitchPlugin_PlayerCooldowns and SwitchPlugin_Endmatches',
                up: async (qi) => {
                    const existing = await qi.showAllTables();
                    if (!existing.includes('SwitchPlugin_PlayerCooldowns')) {
                        await qi.createTable('SwitchPlugin_PlayerCooldowns', {
                            eosID: { type: qi.DataTypes.STRING, primaryKey: true, allowNull: false },
                            steamID: { type: qi.DataTypes.STRING, allowNull: true },
                            playerName: { type: qi.DataTypes.STRING, allowNull: true },
                            lastSwitchTimestamp: { type: qi.DataTypes.DATE, allowNull: true },
                            firstSeenTimestamp: { type: qi.DataTypes.DATE, allowNull: true },
                            scrambleLockdownExpiry: { type: qi.DataTypes.DATE, allowNull: true }
                        });
                    }
                    if (!existing.includes('SwitchPlugin_Endmatches')) {
                        await qi.createTable('SwitchPlugin_Endmatches', {
                            id: { type: qi.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
                            name: { type: qi.DataTypes.STRING },
                            steamID: { type: qi.DataTypes.STRING },
                            eosID: { type: qi.DataTypes.STRING },
                            created_at: { type: qi.DataTypes.DATE, defaultValue: qi.DataTypes.NOW }
                        });
                    }
                },
                down: async (qi) => {
                    await qi.dropTable('SwitchPlugin_PlayerCooldowns');
                    await qi.dropTable('SwitchPlugin_Endmatches');
                }
            }
        ]);

        // Run any pending migrations
        const result = await this.verifyAndRunMigrations('switch');
        if (result) {
        this.verbose(1, `[S3] Switch v1 migration: applied=${result.applied}, skipped=${result.skipped}.`);
        } else {
            this.verbose(3, '[S3] Switch schema already up to date.');
        }

        // Refresh interest is registered conditionally — only when the queue becomes
        // non-empty (see _enqueuePlayer), and unregistered when the queue empties
        // (see _removePlayerFromQueue). If the queue is disabled, no interest is
        // registered at all. This avoids polling when no one is waiting.
        this.verbose(2, '[S3] Switch refresh interest is conditional (poll only when queue active).');
    }

    async prepareToMount() {
        if (this.options.discordChannelID) {
            this.options.channelID = this.options.discordChannelID;
        }
        await super.prepareToMount();
        // S3: Table sync and ALTER TABLE are removed — handled by S³ MigrationEngine in mount()
    }

    /* ── v2.0.0: Broadcast Helpers ────────────────────────────── */

    /**
     * Start broadcast timers for the switch window.
     * Called from onNewGame().
     */
    _startBroadcastTimers() {
        if (!this.options.broadcastSwitchWindowMessages) return;

        this._clearBroadcastTimers();

        const windowMs = this.options.switchEnabledMinutes * 60 * 1000;
        const delayMs = this.options.switchWindowBroadcastDelaySeconds * 1000;
        const intervalMs = this.options.switchWindowBroadcastIntervalMinutes * 60 * 1000;

        // First broadcast after delay
        this._broadcastTimers.firstBroadcast = setTimeout(() => {
            const remainingMin = Math.floor((windowMs - delayMs) / 60000);
            this.broadcast(`[Switch] Team switching is open. Use '!switch help' for details. Window: ~${remainingMin}m.`);
        }, delayMs);

        // Periodic reminders
        if (intervalMs > 0) {
            this._broadcastTimers.reminderInterval = setInterval(() => {
                const elapsed = Date.now() - this._gameStartTs;
                const remainingMs = windowMs - elapsed;
                if (remainingMs <= 0) {
                    this._clearBroadcastTimers();
                    return;
                }
                const remainingMin = Math.ceil(remainingMs / 60000);
                this.broadcast(`[Switch] ~${remainingMin}m remaining to request a team change. Use '!switch check' to see your eligibility.`);
            }, intervalMs);
        }

        // Window close broadcast
        this._broadcastTimers.closeBroadcast = setTimeout(() => {
            this.broadcast(`[Switch] Team switch window is now closed.`);
            this._clearBroadcastTimers();
        }, windowMs);
    }

    _clearBroadcastTimers() {
        if (this._broadcastTimers.firstBroadcast) {
            clearTimeout(this._broadcastTimers.firstBroadcast);
            this._broadcastTimers.firstBroadcast = null;
        }
        if (this._broadcastTimers.reminderInterval) {
            clearInterval(this._broadcastTimers.reminderInterval);
            this._broadcastTimers.reminderInterval = null;
        }
        if (this._broadcastTimers.closeBroadcast) {
            clearTimeout(this._broadcastTimers.closeBroadcast);
            this._broadcastTimers.closeBroadcast = null;
        }
        if (this._broadcastTimers.genericInfoTimer) {
            clearInterval(this._broadcastTimers.genericInfoTimer);
            this._broadcastTimers.genericInfoTimer = null;
        }
    }

    /**
     * Start periodic liberal-mode (Seed/Jensen) broadcast timer.
     * Runs every 5 minutes while the round is active.
     * Called from onNewGame() when isLiberalMode() is true.
     */
    _startLiberalBroadcastTimers() {
        if (!this.options.broadcastSwitchWindowMessages) return;

        this._clearBroadcastTimers();

        // Hardcoded 5-minute interval as requested
        this._broadcastTimers.reminderInterval = setInterval(() => {
            this.broadcast(`[Switch] No cooldown restrictions on this game mode. Use '!switch' to change teams anytime.`);
        }, 5 * 60 * 1000);
    }

    /**
     * Start post-scramble broadcast timers replacing normal switch window broadcasts.
     * Runs for the full duration of the round — no window close message.
     * Called from onNewGame() when this._scrambleHappened is true.
     */
    _startPostScrambleBroadcastTimers() {
        if (!this.options.broadcastSwitchWindowMessages) return;

        this._clearBroadcastTimers();

        const delayMs = this.options.switchWindowBroadcastDelaySeconds * 1000;
        const intervalMs = this.options.switchWindowBroadcastIntervalMinutes * 60 * 1000;
        const windowMs = this.options.switchEnabledMinutes * 60 * 1000;

        // First broadcast after delay
        this._broadcastTimers.firstBroadcast = setTimeout(() => {
            this.broadcast(`[Switch] A scramble occurred last round. Returning players cannot change teams this round. New arrivals can still switch — use '!switch check'.`);
        }, delayMs);

        // Periodic reminders (closed after switchEnabledMinutes — same as normal broadcast window)
        if (intervalMs > 0) {
            this._broadcastTimers.reminderInterval = setInterval(() => {
                this.broadcast(`[Switch] Scramble lockdown active. Returning players cannot change teams this round. New arrivals can still switch — use '!switch check'.`);
            }, intervalMs);
        }

        // Close broadcasts after the switch window expires — beyond that, new arrivals
        // have no remaining time to use !switch anyway, so no need to keep reminding.
        this._broadcastTimers.closeBroadcast = setTimeout(() => {
            this._clearBroadcastTimers();
        }, windowMs);
    }

    /**
     * Start the 25-minute generic informative broadcast timer.
     * Runs on all round types (normal, liberal, post-scramble) and coexists
     * with other broadcast timers. Called from onNewGame() on all paths.
     */
    _startGenericInfoTimer() {
        // No guard on broadcastSwitchWindowMessages — generic info is independent
        if (this._broadcastTimers.genericInfoTimer) return; // already running

        this._broadcastTimers.genericInfoTimer = setInterval(() => {
            this.broadcast(`[Switch] Want to change teams? Type '!switch' to request a team change. Use '!switch help' to learn more.`);
        }, 25 * 60 * 1000);
    }

    /* ── v2.0.0: Join-warn helpers ────────────────────────────── */

    /**
     * Schedule a delayed warning for a player when ChangeTeam is disabled.
     * Cleared on disconnect via _clearJoinWarnTimeout().
     */
    _scheduleJoinWarn(eosID) {
        if (!this._changeTeamDisabled || !this.options.warnOnJoinChangeTeamDisabled) return;
        if (this._joinWarnTimeouts.has(eosID)) return; // already scheduled

        const timeout = setTimeout(() => {
            this._joinWarnTimeouts.delete(eosID);
            // Verify player is still connected
            const stillHere = this.server.players.find(p => p.eosID === eosID);
            if (stillHere) {
                this.warn(eosID, `[Switch] Scoreboard team changes are disabled on this server. Use '!switch' to change teams. '!switch help' for more info.`);
            }
        }, Switch.JOIN_WARN_DELAY_MS);

        this._joinWarnTimeouts.set(eosID, timeout);
    }

    _clearJoinWarnTimeout(eosID) {
        const timeout = this._joinWarnTimeouts.get(eosID);
        if (timeout) {
            clearTimeout(timeout);
            this._joinWarnTimeouts.delete(eosID);
        }
    }

    /* ────────────────────────────────────── COMMAND HANDLING ────────────────────────────────────── */

    async onChatMessage(info) {
        try {
            const eosID = info.player?.eosID;
            const steamID = info.player?.steamID;
            const playerName = info.player?.name;
            const teamID = info.player?.teamID;
            const message = info.message.toLowerCase();

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
                case 'swap':
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    {
                        const swapArgs = commandSplit.splice(1).join(' ').split(' ');
                        const name1 = swapArgs[0];
                        const name2 = swapArgs[1];
                        const p1 = this.getPlayerByUsernameOrSteamID(steamID, name1);
                        const p2 = this.getPlayerByUsernameOrSteamID(steamID, name2);
                        if (p1 && p2) {
                            await this._taggedSwitchPlayer(p1.eosID, 'Admin-Force');
                            await this._taggedSwitchPlayer(p2.eosID, 'Admin-Force');
                            this.warn(steamID, `Swapped ${p1.name} and ${p2.name}.`);
                        } else {
                            this.warn(steamID, 'One or both players not found.');
                        }
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
                            const eosID = info.player?.eosID;
                            const teamID = info.player?.teamID;
                            if (!eosID || !teamID) {
                                this.warn(eosID, `[Switch] Unable to check eligibility.`);
                                return;
                            }

                            const isLiberal = this.isLiberalMode();
                            const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
                            const cooldownData = PlayerCooldowns ? await PlayerCooldowns.findByPk(eosID) : null;
                            const now = Date.now();

                            const effectiveCap = isLiberal ? this.options.liberalSwitchMaxUnbalancedSlots : null;
                            const availableSwitchSlots = this.getSwitchSlotsPerTeam(teamID, effectiveCap);
                            const balanceOK = availableSwitchSlots > 0;

                            const connectionSeconds = await this.getSecondsFromJoin(eosID);
                            const matchSeconds = this.getSecondsFromMatchStart();
                            const limit = this.options.switchEnabledMinutes;
                            const timeWindowOK = isLiberal || (connectionSeconds / 60 <= limit || matchSeconds / 60 <= limit);
                            let timeWindowMsg = '';
                            if (timeWindowOK) {
                                timeWindowMsg = 'Open';
                            } else {
                                const connMin = Math.ceil(connectionSeconds / 60);
                                const matchMin = Math.ceil(matchSeconds / 60);
                                timeWindowMsg = `Closed (${connMin}m join, ${matchMin}m match)`;
                            }

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
                        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
                        if (PlayerCooldowns) {
                            await this._withDb(async (t) => {
                                await PlayerCooldowns.destroy({ where: { eosID: result.eosID }, transaction: t });
                            });
                        }
                        this.warn(eosID, `Cleared cooldowns for ${result.playerName || result.steamID}`);
                    }
                    break;
                case "clearall":
                    if (!isAdmin) {
                        this.verbose(1, `[Denied] Player ${playerName} (not admin) attempted admin command: ${subCommand}`);
                        return;
                    }
                    this.verbose(1, `[Admin] Command '${subCommand}' accepted from ${playerName}`);
                    {
                        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
                        if (PlayerCooldowns) {
                            await this._withDb(async (t) => {
                                await PlayerCooldowns.destroy({ where: {}, truncate: true, transaction: t });
                            });
                        }
                    }
                    this.warn(eosID, "All player cooldowns cleared.");
                    break;
                case 'cancel':
                    if (!this.options.queueEnabled) {
                        this.warn(eosID, '[Switch Queue] Queue is currently disabled.');
                    } else if (this._removePlayerFromQueue(info.player?.eosID)) {
                        this.warn(eosID, '[Switch Queue] Removed — you left the queue.');
                        if (this._roundStats) {
                            this._roundStats.queueCancels.push({ name: playerName, eosID });
                        }
                        this.verbose(1, `[Queue] ${playerName} cancelled — left the queue.`);
                    } else {
                        this.warn(eosID, '[Switch Queue] You are not currently in the queue.');
                    }
                    break;
                default:
                    // Show invalid-input notice first, then full help 5s later
                    this.warn(eosID, `Unknown subcommand: "${subCommand}". Showing help...`);
                    await delay(5000);
                    this.warn(eosID, `[Switch] Commands\n!switch         | Request a team switch\n!switch check   | Check your eligibility\n!switch explain | How switching works\n!switch cancel  | Leave the queue`);
                    return;
            }
        } else {
            // Use S³'s immediate refresh for a fresh player list instead of raw RCON
            if (this._s3?.players?.refreshNow) {
                await this._s3.players.refreshNow('Switch').catch(() => {});
            } else {
                await this.server.updatePlayerList();
            }

            if (this.s3IsEndgameFactionVote()) {
                this.warn(eosID, '[Switch] Team changes are locked during faction voting. Try again when the next round starts.');
                this.verbose(1, `[Switch] Denied ${playerName}: faction vote in progress.`);
                return;
            }

            const eosID2 = info.player?.eosID;
            const canActPlayers = this._s3.players;
            if (eosID2 && canActPlayers?.isReady?.() && canActPlayers.canAct) {
                if (!canActPlayers.canAct(eosID2, 'Switch')) {
                    this.warn(eosID, '[Switch] You are currently being processed — please try again shortly.');
                    this.verbose(1, `[Switch] Denied ${playerName}: canAct returned false (locked by higher-priority actor).`);
                    return;
                }
            }

            const isLiberal = this.isLiberalMode();
            const effectiveCap = isLiberal ? this.options.liberalSwitchMaxUnbalancedSlots : null;
            const availableSwitchSlots = this.getSwitchSlotsPerTeam(teamID, effectiveCap);

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

            // v2.0.0: Queue-disabled path — deny early if queue is off and no slot
            if (!this.options.queueEnabled) {
                if (availableSwitchSlots <= 0) {
                    this.warn(eosID, '[Switch] Queue is currently disabled and no slots are available. Try again shortly.');
                    return;
                }
                // If queue disabled but slot available, fall through to switch below
            } else {
                // v2.0.0: FIFO check — if players are already waiting, enqueue behind them
                const queueSameTeam = this._switchQueue[teamID === 1 ? 't1' : 't2'].length;
                if (queueSameTeam > 0) {
                    this._enqueuePlayer(info.player, 'Other players are already waiting in the queue.');
                    return;
                }

                if (availableSwitchSlots <= 0) {
                    this._enqueuePlayer(info.player, 'Teams are currently full on that side.');
                    return;
                }
            }

             let switchSuccess = false;
             let preSwitchTeam = teamID;
             try {
                 await this._taggedSwitchPlayer(eosID, 'Player-Self');
                 
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
                            const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
                            if (PlayerCooldowns) {
                                await this._withDb(async (t) => {
                                    await PlayerCooldowns.upsert({ eosID, steamID, playerName, lastSwitchTimestamp: now }, { transaction: t });
                                });
                            }
                            this.verbose(1, `[Switch] Cooldown written successfully for ${playerName}`);
                        }
                    } catch (dbErr) {
                        this.verbose(1, `[Switch] Database update failed: ${dbErr.message}`);
                    }
                }
                
                // Track successful instant switch
                if (this._roundStats) {
                    this._roundStats.instantSwitches.push({
                        name: playerName,
                        eosID,
                        fromTeam: preSwitchTeam,
                        toTeam: teamID === 1 ? 2 : 1
                    });
                    this._updateMaxQueueSize();
                }

                this.verbose(1, `[Switch] Executed for ${playerName}.`);
            } else {
                this.verbose(1, `[Switch] NOT recording cooldown for ${playerName} — switchSuccess=${switchSuccess}`);
            }
        }
        } catch (err) {
            // Track denied switch
            if (this._roundStats) {
                this._roundStats.deniedSwitches.push({
                    name: playerName,
                    eosID,
                    reason: err.message || 'unknown'
                });
            }
            this.verbose(1, `Error in onChatMessage: ${err.stack}`);
        }
    }

     async doSwitchMatchend() {
         try {
             const Endmatches = this._getModel('SwitchPlugin_Endmatches');
             if (!Endmatches) return;
             const players = await Endmatches.findAll();
             if (players.length == 0) return;
             players.forEach((pl) => {
                 this.warn(pl.steamID ? pl.eosID || pl.steamID : pl.eosID, '[Switch] Round ending — you will be switched in 15 seconds.');
             });
             await delay(15 * 1000);
             await Promise.all(players.map(async (pl) => {
                 try {
                     await this._taggedSwitchPlayer(pl.eosID || pl.steamID, 'Admin-Force');
                     return await Endmatches.destroy({
                         where: {
                             id: pl.id
                         }
                     });
                 } catch (innerErr) {
                     this.verbose(1, `[Switch] Matchend switch failed for ${pl.eosID || pl.steamID}: ${innerErr.message || innerErr}`);
                 }
             }));
         } catch (err) {
             this.verbose(1, `[Switch] doSwitchMatchend failed: ${err.message || err}`);
         }
     }

    _buildRoundSummaryEmbed() {
        const s = this._roundStats;
        if (!s) return null;

        const totalSuccess = s.instantSwitches.length + s.queueNormal.length +
            s.queueTeamTrades.length + s.queueJoinSwaps.length;
        const totalFailed = s.queueExpiries.length;
        const totalAttempted = totalSuccess + totalFailed;

        const successPct = totalAttempted > 0 ? Math.round((totalSuccess / totalAttempted) * 100) : 0;
        const failPct = totalAttempted > 0 ? Math.round((totalFailed / totalAttempted) * 100) : 0;

        // Average queue wait (only queue-based successes, not instant)
        const queueDurations = s.queueDurationsMs || [];
        const avgQueueSec = queueDurations.length > 0
            ? Math.round(queueDurations.reduce((a, b) => a + b, 0) / queueDurations.length / 1000)
            : 0;
        const avgMin = Math.floor(avgQueueSec / 60);
        const avgSec = avgQueueSec % 60;
        const avgStr = avgMin > 0 ? `${avgMin}m ${avgSec}s` : `${avgSec}s`;

        // Per-team destination counts (all success types)
        let toT1 = 0, toT2 = 0;
        for (const p of s.instantSwitches) {
            if (p.toTeam === 1) toT1++; else toT2++;
        }
        for (const p of s.queueNormal) {
            if (p.toTeam === 1) toT1++; else toT2++;
        }
        for (const p of s.queueJoinSwaps) {
            if (p.toTeam === 1) toT1++; else toT2++;
        }
        for (const p of s.queueTeamTrades) {
            if (p.p1ToTeam === 1) toT1++; else toT2++;
            if (p.p2ToTeam === 1) toT1++; else toT2++;
        }

        const fields = [];

        // ── Field 1: Stats ──
        const statsLines = [];
        statsLines.push(`**Success:** ${totalSuccess} switch${totalSuccess !== 1 ? 'es' : ''}${totalAttempted > 0 ? ` (${successPct}%)` : ''}`);
        statsLines.push(`**Failed (expired):** ${totalFailed}${totalAttempted > 0 ? ` (${failPct}%)` : ''}`);
        if (s.deniedSwitches.length > 0) statsLines.push(`**Denied:** ${s.deniedSwitches.length}`);
        statsLines.push(`**Max Queue Size:** ${s.maxQueueSize}`);
        if (queueDurations.length > 0) statsLines.push(`**Avg Queue Wait:** ${avgStr}`);
        statsLines.push(`**Team 1 received:** ${toT1}    **Team 2 received:** ${toT2}`);

        fields.push({ name: '📊 Stats', value: statsLines.join('\n'), inline: false });

        // ── Field 2: Switch Methods (successes only) ──
        const methodLines = [];

        if (s.instantSwitches.length) {
            const names = s.instantSwitches.slice(0, 20).map(p => `${p.name} (T${p.fromTeam}→T${p.toTeam})`);
            if (s.instantSwitches.length > 20) names.push(`+ ${s.instantSwitches.length - 20} more...`);
            methodLines.push(`**Instant Switches (${s.instantSwitches.length})**\n${names.join('\n')}`);
        }

        if (s.queueNormal.length) {
            const names = s.queueNormal.slice(0, 10).map(p => {
                const m = Math.floor(p.queueDurationSeconds / 60);
                const sec = p.queueDurationSeconds % 60;
                const dur = m > 0 ? `${m}m ${sec}s` : `${sec}s`;
                return `${p.name} (T${p.currentTeamID || '?'}→T${p.toTeam}, ${dur})`;
            });
            if (s.queueNormal.length > 10) names.push(`+ ${s.queueNormal.length - 10} more...`);
            methodLines.push(`**Queue Normal (${s.queueNormal.length})**\n${names.join('\n')}`);
        }

        if (s.queueTeamTrades.length) {
            const names = s.queueTeamTrades.slice(0, 10).map(p => {
                const m = Math.floor(p.queueDurationSeconds / 60);
                const sec = p.queueDurationSeconds % 60;
                const dur = m > 0 ? `${m}m ${sec}s` : `${sec}s`;
                return `${p.p1Name} ↔ ${p.p2Name} (T1↔T2, ${dur})`;
            });
            if (s.queueTeamTrades.length > 10) names.push(`+ ${s.queueTeamTrades.length - 10} more...`);
            methodLines.push(`**Queue Team Trade (${s.queueTeamTrades.length})**\n${names.join('\n')}`);
        }

        if (s.queueJoinSwaps.length) {
            const names = s.queueJoinSwaps.slice(0, 10).map(p => {
                const m = Math.floor(p.queueDurationSeconds / 60);
                const sec = p.queueDurationSeconds % 60;
                const dur = m > 0 ? `${m}m ${sec}s` : `${sec}s`;
                return `${p.name} (→T${p.toTeam}, ${dur})`;
            });
            if (s.queueJoinSwaps.length > 10) names.push(`+ ${s.queueJoinSwaps.length - 10} more...`);
            methodLines.push(`**Queue Join Swap (${s.queueJoinSwaps.length})**\n${names.join('\n')}`);
        }

        if (methodLines.length > 0) {
            fields.push({ name: '🔄 Switch Methods', value: methodLines.join('\n\n'), inline: false });
        }

        // ── Field 3: Queue Activity (non-success outcomes) ──
        const activityLines = [];

        if (s.queueExpiries.length) {
            const names = s.queueExpiries.slice(0, 20).map(p => p.name);
            if (s.queueExpiries.length > 20) names.push(`+ ${s.queueExpiries.length - 20} more...`);
            activityLines.push(`**Expired (${s.queueExpiries.length})**\n${names.join('\n')}`);
        }

        if (s.deniedSwitches.length) {
            const names = s.deniedSwitches.slice(0, 10).map(p => `${p.name}: ${p.reason}`);
            if (s.deniedSwitches.length > 10) names.push(`+ ${s.deniedSwitches.length - 10} more...`);
            activityLines.push(`**Denied (${s.deniedSwitches.length})**\n${names.join('\n')}`);
        }

        if (s.queueDisconnects.length) {
            const names = s.queueDisconnects.slice(0, 20).map(p => p.name);
            if (s.queueDisconnects.length > 20) names.push(`+ ${s.queueDisconnects.length - 20} more...`);
            activityLines.push(`**DC'd in Queue (${s.queueDisconnects.length})**\n${names.join('\n')}`);
        }

        if (s.queueCancels.length) {
            const names = s.queueCancels.slice(0, 20).map(p => p.name);
            if (s.queueCancels.length > 20) names.push(`+ ${s.queueCancels.length - 20} more...`);
            activityLines.push(`**Cancelled (${s.queueCancels.length})**\n${names.join('\n')}`);
        }

        if (activityLines.length > 0) {
            fields.push({ name: 'ℹ️ Queue Activity', value: activityLines.join('\n\n'), inline: false });
        }

        if (!fields.length) {
            fields.push({ name: 'No Activity', value: 'No switch activity this round.', inline: false });
        }

        return {
            title: 'Switch Round Summary',
            color: 0x3498DB,
            fields,
            timestamp: new Date(),
            footer: { text: `Switch v${Switch.version}` }
        };
    }

    async _postRoundSummary() {
        if (!this.options.roundEndSummaryEnabled) return;
        try {
            const embed = this._buildRoundSummaryEmbed();
            if (!embed) return;
            await this.sendDiscordMessage({ embed });

            const s = this._roundStats;
            this.verbose(1, `[Summary] Round ended: ` +
                `${s.instantSwitches.length} instant, ${s.queueNormal.length} normal, ${s.queueTeamTrades.length} trades, ` +
                `${s.queueJoinSwaps.length} join-swaps, ${s.deniedSwitches.length} denied, ` +
                `${s.queueExpiries.length} expired, ${s.queueDisconnects.length} DC, ${s.queueCancels.length} cancel. ` +
                `Max queue: ${s.maxQueueSize}.`
            );
        } catch (err) {
            this.verbose(1, `[Summary] Failed to post round summary: ${err.message}`);
        }
    }

    async onRoundEnded(dt) {
        this._lastTeamSnapshot = null;
        this._scrambleHappened = false;

        this.verbose(2, `[Queue] Round ended — queue preserved (${this._getQueueSize()} entries remain).`);

        // Run matchend switches only — summary now posts on NEW_GAME
        await this.cleanup();
        try {
            await this.doSwitchMatchend();
        } catch (err) {
            this.verbose(1, `[Switch] onRoundEnded matchend processing failed: ${err.message || err}`);
        }
        this._switchedOnJoin.clear();
    }

    getTeamBalanceDifference() {
        let teamPlayerCount = [ null, 0, 0 ];
        for (let p of this.server.players)
            teamPlayerCount[ +p.teamID ]++;
        const balanceDiff = teamPlayerCount[ 1 ] - teamPlayerCount[ 2 ];

        return balanceDiff;
    }

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

    getDynamicExtraSlots() {
        if (!this.options.dynamicBalanceTolerance) return 0;

        const effectiveCap = this?._s3?.serverConfig?.isReady()
          ? this._s3.serverConfig.getMaxPlayers() - this._s3.serverConfig.getNumReservedSlots()
          : 98;
        const floor = this.options.dynamicBalancePlayerFloor;
        const extra = this.options.dynamicBalanceExtraSlots;

        let totalPlayers = 0;
        for (let p of this.server.players) totalPlayers++;

        if (totalPlayers >= effectiveCap) return 0;
        
        if (totalPlayers <= floor) return extra;
        
        const interpolated = extra * (effectiveCap - totalPlayers) / (effectiveCap - floor);
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
         const maxTeamSize = this?._s3?.serverConfig?.isReady()
           ? Math.floor(this._s3.serverConfig.getMaxPlayers() / 2)
           : 50;
         if ((teamPlayerCount[receivingTeam] || 0) >= maxTeamSize) return 0;

         return 1;
     }

    async _checkSwitchEligibility(player) {
        const eosID = player?.eosID;
        if (!eosID) return { eligible: false, reason: 'missing_eos' };

        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        const cooldownData = PlayerCooldowns ? await PlayerCooldowns.findByPk(eosID) : null;
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
        const refreshPlayers = this._s3.players;
        if (refreshPlayers?.isReady() && refreshPlayers.requestRefresh) {
            refreshPlayers.requestRefresh('Switch', { urgency: 'normal' });
        }
    }

    _enqueuePlayer(player, reason) {
        // v2.0.0: Gate — return early if queue is disabled
        if (!this.options.queueEnabled) {
            this.verbose(2, `[Queue] Queue disabled — refusing enqueue for ${player.name}.`);
            return;
        }

        const { eosID, steamID, name: playerName, teamID } = player;

        if (!eosID || !teamID) {
            this.verbose(1, `[Queue] Cannot enqueue ${playerName}: missing eosID or teamID.`);
            return;
        }

        const windowMs = this.options.switchEnabledMinutes * 60 * 1000;
        const targetTeam = teamID === 1 ? 2 : 1;
        const subQueue = teamID === 1 ? 't1' : 't2';

        if (this._findQueueEntry(eosID)) {
            const existing = this._findQueueEntry(eosID).entry;
            const remaining = (this._getRemainingWindowMs(existing.eosID) / 60000).toFixed(1);
            this.warn(eosID,
                `[Switch Queue]\nYou are already in the queue.\n~${remaining}m remaining | Team ${existing.currentTeamID} → Team ${existing.targetTeamID}\nType !switch cancel to leave.`
            );
            return;
        }

        const queuedAt = Date.now();

        const warnInterval = setInterval(() => {
            const found = this._findQueueEntry(eosID);
            if (!found) { clearInterval(warnInterval); return; }

            const entry = found.entry;
            const remaining = (this._getRemainingWindowMs(entry.eosID) / 60000).toFixed(1);

            const sameTeam = this._switchQueue[entry.currentTeamID === 1 ? 't1' : 't2'];
            const pos = sameTeam.findIndex(e => e.eosID === eosID) + 1;

            this.warn(entry.eosID,
                `[Switch Queue]\nPosition ${pos} in the queue.\n~${remaining}m remaining | Team ${entry.currentTeamID} → Team ${entry.targetTeamID}\nType !switch cancel to leave.`
            );
        }, 30_000);

        const enqueuePos = this._switchQueue[subQueue].length + 1;

        const entry = { eosID, steamID, playerName, currentTeamID: teamID, targetTeamID: targetTeam, queuedAt, warnInterval };
        this._switchQueue[subQueue].push(entry);

        this.warn(eosID,
            `[Switch Queue]\nAdded to position ${enqueuePos} in the queue.\n~${(this._getRemainingWindowMs(eosID) / 60000).toFixed(1)}m remaining | Team ${teamID} → Team ${targetTeam}\n${reason}\nType !switch cancel to leave.`
        );
        this.verbose(1, `[Queue] ${playerName} (T${teamID} → T${targetTeam}) enqueued at position ${enqueuePos}. Queue size: ${this._getQueueSize()}`);

        // Conditional refresh registration: register 5s interest when queue transitions
        // from empty to non-empty, so _processQueue polls frequently while people wait.
        if (this._getQueueSize() === 1) {
            if (this._s3?.players?.registerRefreshInterest) {
                this._s3.players.registerRefreshInterest('Switch', { maxStalenessMs: 5000 });
                this.verbose(2, '[S3] Registered Switch refresh interest (maxStalenessMs=5000) — queue became active.');
            }
            // Also listen to S3_PLAYERS_UPDATED for periodic processing heartbeat
            // while the queue is non-empty. This hooks into S3's existing refresh polling
            // rather than creating a separate timer.
            this.server.on('S3_PLAYERS_UPDATED', this._onPlayerInfoUpdated);
            this._periodicProcessingActive = true;
            this.verbose(2, '[S3] Started periodic queue processing via S3_PLAYERS_UPDATED events.');
        }

        this._requestQueueRefresh();
    }

    _getRemainingWindowMs(eosID) {
        // Compute actual remaining time based on join time and match start time,
        // not on when the player queued. The player's window is the longer of their
        // join-based and match-start-based timers.
        const windowMs = this.options.switchEnabledMinutes * 60 * 1000;
        const limitSeconds = this.options.switchEnabledMinutes * 60;
        const joinSeconds = this.getSecondsFromJoin(eosID);
        const matchSeconds = this.getSecondsFromMatchStart();
        const joinRemainingMs = Math.max(0, (limitSeconds - joinSeconds) * 1000);
        const matchRemainingMs = Math.max(0, (limitSeconds - matchSeconds) * 1000);
        const actualRemainingMs = Math.max(joinRemainingMs, matchRemainingMs);
        // Cap at windowMs — the initial window is the max possible
        return Math.min(actualRemainingMs, windowMs);
    }

    _getQueueSize() {
        return this._switchQueue.t1.length + this._switchQueue.t2.length;
    }

    _clearAllQueueEntries(reason) {
        for (const entry of [...this._switchQueue.t1, ...this._switchQueue.t2]) {
            clearInterval(entry.warnInterval);
        }
        this._switchQueue.t1 = [];
        this._switchQueue.t2 = [];
        this._stopPeriodicProcessing();
        this.verbose(2, `[Queue] All entries cleared: ${reason}`);
    }

    getQueueSnapshot() {
        return {
            t1ToT2: this._switchQueue.t1.map(e => ({ eosID: e.eosID, steamID: e.steamID, playerName: e.playerName, currentTeamID: e.currentTeamID, targetTeamID: e.targetTeamID, queuedAt: e.queuedAt })),
            t2ToT1: this._switchQueue.t2.map(e => ({ eosID: e.eosID, steamID: e.steamID, playerName: e.playerName, currentTeamID: e.currentTeamID, targetTeamID: e.targetTeamID, queuedAt: e.queuedAt }))
        };
    }

    consumeQueueEntry(eosID) {
        const entry = this._removePlayerFromQueue(eosID);
        if (entry) {
            this.verbose(1, `[Queue] ${entry.playerName} consumed externally via handshake. Queue size: ${this._getQueueSize()}`);
            if (this._roundStats) {
                const qDuration = Math.round((Date.now() - entry.queuedAt) / 1000);
                this._roundStats.queueJoinSwaps.push({
                    name: entry.playerName,
                    eosID: entry.eosID,
                    type: 'consume',
                    toTeam: entry.targetTeamID,
                    queueDurationSeconds: qDuration
                });
                this._roundStats.queueDurationsMs.push(qDuration * 1000);
            }
        }
        return entry || null;
    }

    async forceQueueSwap(eosID) {
        const entry = this._removePlayerFromQueue(eosID);
        if (!entry) {
            this.verbose(1, `[Queue] forceQueueSwap: ${eosID} not found in queue (already consumed/cancelled/disconnected).`);
            return false;
        }
        this.verbose(1, `[Queue] forceQueueSwap: Initiating handshake swap for ${entry.playerName}. Queue size: ${this._getQueueSize()}`);

        try {
            await this._taggedSwitchPlayer(eosID, 'Handshake-Swap');
            if (this._roundStats) {
                const qDuration = Math.round((Date.now() - entry.queuedAt) / 1000);
                this._roundStats.queueJoinSwaps.push({
                    name: entry.playerName,
                    eosID: entry.eosID,
                    type: 'swap',
                    toTeam: entry.targetTeamID,
                    queueDurationSeconds: qDuration
                });
                this._roundStats.queueDurationsMs.push(qDuration * 1000);
            }
            this.verbose(1, `[Queue] forceQueueSwap: ${entry.playerName} switched successfully via handshake.`);
            return true;
        } catch (err) {
            this.verbose(1, `[Queue] forceQueueSwap: Switch failed for ${entry.playerName}: ${err.message}. Player was already removed from queue — cooldown may have been applied.`);
            return false;
        }
    }

    async _processQueue() {
        // v2.0.0: Queue-disabled gate
        if (!this.options.queueEnabled) return;

        if (this._queueProcessing) {
            this.verbose(2, `[Queue] Processing already in progress — skipping concurrent invocation.`);
            return;
        }

        // UNIFIED LOCK GATE: If a higher-priority plugin holds a global or per-player lock,
        // defer queue processing. The canAct call on the first queued player acts as a
        // proxy for the global lock check — canAct() checks both global and per-player locks
        // internally. If no queued players, use null to test the global lock alone.
        const queueLockPlayers = this._s3?.players;
        if (queueLockPlayers?.isReady?.()) {
            const anyEosID = this._getQueueSize() > 0
                ? (this._switchQueue.t1[0]?.eosID || this._switchQueue.t2[0]?.eosID)
                : null;
            if (!queueLockPlayers.canAct(anyEosID, 'Switch')) {
                this.verbose(2, `[Queue] Deferred — higher-priority lock held.`);
                return;
            }
        }
        
        this._queueProcessing = true;
        try {
            if (this.s3IsEndgameFactionVote()) {
                if (this._getQueueSize() > 0) {
                    this.verbose(2, `[Queue] Faction vote in progress — skipping queue processing.`);
                }
                return;
            }

            const windowMs = this.options.switchEnabledMinutes * 60 * 1000;
            const nowTs = Date.now();

            for (const subQueue of ['t1', 't2']) {
                const arr = this._switchQueue[subQueue];
                for (let i = arr.length - 1; i >= 0; i--) {
                    const entry = arr[i];
                    if ((nowTs - entry.queuedAt) >= windowMs) {
                        clearInterval(entry.warnInterval);
                        arr.splice(i, 1);
                        if (this._roundStats) {
                            this._roundStats.queueExpiries.push({ name: entry.playerName, eosID: entry.eosID });
                        }
                        this.warn(entry.eosID, `[Switch Queue] Removed — join/match window closed.\nYour ${this.options.switchEnabledMinutes}m window expired while waiting.\nUse !switch explain for details.`);
                        this.verbose(2, `[Queue] ${entry.playerName} expired and removed from queue.`);
                    }
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

            const t1Candidates = [...this._switchQueue.t1];
            const t2Candidates = [...this._switchQueue.t2];
            const pairCount = Math.min(t1Candidates.length, t2Candidates.length);

            for (let i = 0; i < pairCount; i++) {
                const p1 = t1Candidates[i];
                const p2 = t2Candidates[i];

                const live1 = this.server.players.find(p => p.eosID === p1.eosID);
                const live2 = this.server.players.find(p => p.eosID === p2.eosID);

                if (!live1 || live1.teamID !== p1.currentTeamID) {
                    this._removePlayerFromQueue(p1.eosID);
                    this.verbose(1, `[Queue] ${p1.playerName} team changed externally — removed from queue.`);
                    continue;
                }
                if (!live2 || live2.teamID !== p2.currentTeamID) {
                    this._removePlayerFromQueue(p2.eosID);
                    this.verbose(1, `[Queue] ${p2.playerName} team changed externally — removed from queue.`);
                    continue;
                }

                this._removePlayerFromQueue(p1.eosID);
                this._removePlayerFromQueue(p2.eosID);

                this.warn(p1.eosID, '[Switch Queue] Swap partner found — switching now.');
                this.warn(p2.eosID, '[Switch Queue] Swap partner found — switching now.');

                await this._taggedSwitchPlayer(p1.eosID, 'Player-Queue');
                await this._taggedSwitchPlayer(p2.eosID, 'Player-Queue');

                if (!this.isLiberalMode()) {
                    const now = new Date();
                    const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
                    if (PlayerCooldowns) {
                        for (const p of [p1, p2]) {
                            try {
                                await this._withDb(async (t) => {
                                    await PlayerCooldowns.upsert(
                                        { eosID: p.eosID, steamID: p.steamID, playerName: p.playerName, lastSwitchTimestamp: now },
                                        { transaction: t }
                                    );
                                });
                            } catch (dbErr) {
                                this.verbose(1, `[Queue] Cooldown write failed for ${p.playerName}: ${dbErr.message}`);
                            }
                        }
                    }
                }

                // Track completed pair trade
                if (this._roundStats) {
                    const dur1 = Math.round((Date.now() - p1.queuedAt) / 1000);
                    const dur2 = Math.round((Date.now() - p2.queuedAt) / 1000);
                    const avgDuration = Math.round((dur1 + dur2) / 2);
                    this._roundStats.queueTeamTrades.push({
                        p1Name: p1.playerName,
                        p2Name: p2.playerName,
                        p1ToTeam: p1.targetTeamID,
                        p2ToTeam: p2.targetTeamID,
                        queueDurationSeconds: avgDuration
                    });
                    this._roundStats.queueDurationsMs.push(dur1 * 1000, dur2 * 1000);
                }

                this.verbose(1, `[Queue] Swapped pair: ${p1.playerName} (T1) <-> ${p2.playerName} (T2)`);
            }

            const t1Queued = this._switchQueue.t1.length;
            const t2Queued = this._switchQueue.t2.length;

            if (this._getQueueSize() > 0) {
                this.verbose(2, `[Queue] T1: ${t1Queued} queued | T2: ${t2Queued} queued | Teams: ${t1}v${t2} | Diff: ${t1 - t2}`);
            }

            const firstT1 = this._switchQueue.t1[0] || null;
            const firstT2 = this._switchQueue.t2[0] || null;

            for (const entry of [firstT1, firstT2].filter(Boolean)) {
                const live = this.server.players.find(p => p.eosID === entry.eosID);
                if (!live || live.teamID !== entry.currentTeamID) {
                    this._removePlayerFromQueue(entry.eosID);
                    this.verbose(1, `[Queue] ${entry.playerName} team changed externally — removed from queue.`);
                    continue;
                }

                const effectiveCap = this.isLiberalMode() ? this.options.liberalSwitchMaxUnbalancedSlots : null;
                const slots = this.getSwitchSlotsPerTeam(entry.currentTeamID, effectiveCap);
                if (slots > 0) {
                    this._removePlayerFromQueue(entry.eosID);

                    this.warn(entry.eosID, '[Switch Queue] Balance slot opened — switching now.');
                    await this._taggedSwitchPlayer(entry.eosID, 'Player-Queue');

                    if (!this.isLiberalMode()) {
                        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
                        if (PlayerCooldowns) {
                            try {
                                await this._withDb(async (t) => {
                                    await PlayerCooldowns.upsert(
                                        { eosID: entry.eosID, steamID: entry.steamID, playerName: entry.playerName, lastSwitchTimestamp: new Date() },
                                        { transaction: t }
                                    );
                                });
                            } catch (dbErr) {
                                this.verbose(1, `[Queue] Cooldown write failed for ${entry.playerName}: ${dbErr.message}`);
                            }
                        }
                    }

                    // Track completed solo switch
                    if (this._roundStats) {
                        const qDuration = Math.round((Date.now() - entry.queuedAt) / 1000);
                        this._roundStats.queueNormal.push({
                            name: entry.playerName,
                            eosID: entry.eosID,
                            toTeam: entry.currentTeamID === 1 ? 2 : 1,
                            queueDurationSeconds: qDuration
                        });
                        this._roundStats.queueDurationsMs.push(qDuration * 1000);
                    }

                    this.verbose(1, `[Queue] Solo switch fired for ${entry.playerName} (T${entry.currentTeamID})`);

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
        if (!joinPlayers?.isReady()) return 0;
        const joinTime = joinPlayers.getJoinTime(eosID);
        return joinTime ? (Date.now() - joinTime) / 1000 : 0;
    }

    getSecondsFromMatchStart() {
        const roundStartTime = this._s3?.gameState?.getRoundStartTime?.();
        return roundStartTime ? (Date.now() - roundStartTime) / 1000 : 0;
    }

    handlePlayerLeave(eosID, teamID, playerName) {
        // v2.0.0: Clear join-warn timeout on disconnect
        this._clearJoinWarnTimeout(eosID);

        if (this._removePlayerFromQueue(eosID)) {
            this.verbose(2, `[Queue] ${playerName} disconnected — removed from queue.`);
            if (this._roundStats) {
                this._roundStats.queueDisconnects.push({ name: playerName, eosID });
            }
        }
        this.verbose(2, `Player disconnected ${playerName}`);
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
        const Endmatches = this._getModel('SwitchPlugin_Endmatches');
        if (!Endmatches) return;
        for (let p of players) {
            await Endmatches.create({
                name: p.name,
                steamID: p.steamID,
                eosID: p.eosID,
            });
        }
    }

    async addPlayerToMatchendSwitches(player) {
        const Endmatches = this._getModel('SwitchPlugin_Endmatches');
        if (!Endmatches) return;
        await Endmatches.create({
            name: player.name,
            steamID: player.steamID,
            eosID: player.eosID,
        });
    }

    async _taggedSwitchPlayer(eosID, source) {
        // Delegate to the base class method which handles retry/verify/recordMove
        const result = await this._requestTeamChange(eosID, {
            maxAttempts: 3,
            retryIntervalMs: 200,
            timeoutMs: 2000,
            source: source || 'S3PluginBase'
        });

        if (result && result.success) {
            this.verbose(3, `[Switch] RCON SUCCESS: ${result.name} switched to T${result.teamID} (source=${source})`);
            return result;
        }

        if (result === null) {
            this.verbose(1, `[Switch] WARNING: Player with eosID ${eosID} not found in server.players for source=${source}`);
            return null;
        }

        this.verbose(1, `[Switch] ERROR: AdminForceTeamChange failed for ${result?.name || eosID} (source=${source}): all attempts exhausted`);
        throw new Error(`Team change failed for ${eosID} after ${result?.attempts || 3} attempts (source=${source})`);
    }

    switchPlayer(eosID) {
        // Delegate to the base class method
        return this._taggedSwitchPlayer(eosID, 'SwitchPlayer');
    }

    async onNewGame() {
        this.verbose(1, '[NEW_GAME] Round started — null-teamID window handled by S³ players service.');

        // Post summary for the round that just ended, BEFORE resetting stats
        await this._postRoundSummary();

        // v2.0.0: Store game start timestamp for broadcast timing
        this._gameStartTs = Date.now();

        // Reset round stats for the new round
        this._roundStats = this._initRoundStats();

        // v2.0.0: Branch on scramble/liberal/normal broadcast, then start generic info timer on all paths
        if (this._scrambleHappened) {
            this._scrambleHappened = false;
            this._startPostScrambleBroadcastTimers();
        } else if (this.isLiberalMode()) {
            this._startLiberalBroadcastTimers();
        } else {
            this._startBroadcastTimers();
        }

        // Generic informative broadcast runs every 25 minutes regardless of round type
        this._startGenericInfoTimer();
    }

    async onS3PlayerJoined(data) {
        if (!data?.player?.eosID) return;
        const { eosID, name, teamID } = data.player;
        const previousTeamID = data.previousTeamID;

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

        // v2.0.0: Schedule delayed join-warn if ChangeTeam is disabled
        this._scheduleJoinWarn(eosID);

        if (!this.s3IsEndgameFactionVote()) {
            await this._processQueue();
        }
    }

    async onS3PlayerLeft(data) {
        if (!data?.player?.eosID) return;

        // v2.0.0: Clear join-warn timeout on disconnect
        this._clearJoinWarnTimeout(data.player.eosID);

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

    _findQueueEntry(eosID) {
        for (const subQueue of ['t1', 't2']) {
            const idx = this._switchQueue[subQueue].findIndex(e => e.eosID === eosID);
            if (idx !== -1) {
                return { entry: this._switchQueue[subQueue][idx], subQueue, index: idx };
            }
        }
        return null;
    }

    _removePlayerFromQueue(eosID) {
        const found = this._findQueueEntry(eosID);
        if (!found) return null;
        clearInterval(found.entry.warnInterval);
        this._switchQueue[found.subQueue].splice(found.index, 1);
        // Unregister refresh interest when queue becomes empty — no need to poll
        // aggressively if no one is waiting. skip if disableInFlight is true.
        // Also remove the periodic processing listener.
        if (this._getQueueSize() === 0) {
            this._stopPeriodicProcessing();
            this.verbose(2, '[S3] Queue empty — periodic processing stopped.');
        }
        return found.entry;
    }

    /**
     * Periodic queue processing via S³ players-updated heartbeat.
     * Called on each S3_PLAYERS_UPDATED event while the queue is non-empty.
     * Registered when queue transitions 0→1, unregistered when →0.
     */
    _onPlayerInfoUpdated() {
        if (!this._periodicProcessingActive) return;
        if (this._getQueueSize() === 0) return;
        this._processQueue().catch(err => {
            this.verbose(1, `[Queue] Periodic processing error: ${err.message}`);
        });
    }

    /**
     * Cleanup periodic processing listener, refresh interest, and flag.
     * Called from _removePlayerFromQueue (queue→0) and _onUnmount.
     */
    _stopPeriodicProcessing() {
        if (this._s3?.players?.unregisterRefreshInterest) {
            this._s3.players.unregisterRefreshInterest('Switch');
        }
        this.server.removeListener('S3_PLAYERS_UPDATED', this._onPlayerInfoUpdated);
        this._periodicProcessingActive = false;
    }

    /**
     * _onUnmount — S³ lifecycle hook (called by S3PluginBase.unmount()).
     * Cleans up listener registrations, switch queue, broadcast timers,
     * and join-warn timeouts.
     */
    async _onUnmount() {
        this._stopPeriodicProcessing();

        // v2.0.0: Clear broadcast timers
        this._clearBroadcastTimers();

        // v2.0.0: Clear all pending join-warn timeouts
        for (const [eosID, timeout] of this._joinWarnTimeouts) {
            clearTimeout(timeout);
        }
        this._joinWarnTimeouts.clear();

        this._scrambleHappened = false;

        this.server.removeListener('CHAT_MESSAGE', this.onChatMessage);
        this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
        this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
        this.server.removeListener('NEW_GAME', this.onNewGame.bind(this));
        this.server.removeListener('S3_PLAYER_JOINED', this.onS3PlayerJoined);
        this.server.removeListener('S3_PLAYER_LEFT', this.onS3PlayerLeft);
        this.server.removeListener('S3_PLAYER_TEAM_CHANGED', this.onS3PlayerTeamChanged);
        if (this.options.discordClient) this.options.discordClient.removeListener('message', this.onDiscordMessage);
        this._clearAllQueueEntries('Plugin unmount');
        this.verbose(1, 'Switch plugin was un-mounted.');
    }

    async unmount() {
        await super.unmount();
        // _onUnmount() is called by super.unmount() — cleanup happens there
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
        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        if (!PlayerCooldowns) return;

        const switchCooldownMs = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
        const now = new Date();
        const switchCutoff = new Date(now.getTime() - switchCooldownMs);

        try {
            await this._withDb(async (t) => {
                await PlayerCooldowns.destroy({
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
        } catch (err) {
            this.verbose(1, `Cleanup error: ${err.message}`);
        }
    }

    async checkPlayer(ident) {
        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        if (!PlayerCooldowns) return null;
        let record = await PlayerCooldowns.findByPk(ident);
        if (record) return record;

        const records = await PlayerCooldowns.findAll({
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
        
        this._clearAllQueueEntries('Scramble');

        // v2.0.0: Defer post-scramble broadcast to next NEW_GAME
        this._scrambleHappened = true;

        if (!affectedPlayers || affectedPlayers.length === 0) {
            this.verbose(1, `[SCRAMBLE_EVENT] WARNING: affectedPlayers is empty or undefined — queue cleared, but no lockdown records written.`);
            return;
        }

        this.verbose(2, `[SCRAMBLE_EVENT] Processing ${affectedPlayers.length} affected players for lockdown`);
        affectedPlayers.forEach((p, i) => {
            this.verbose(2, `  [${i}] steamID=${p.steamID}, name=${p.name}`);
        });

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
            const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
            if (PlayerCooldowns) {
                await this._withDb(async (t) => {
                    const chunkSize = 10;
                    for (let i = 0; i < records.length; i += chunkSize) {
                        const chunk = records.slice(i, i + chunkSize);
                        this.verbose(2, `[SCRAMBLE_EVENT] Writing chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(records.length / chunkSize)} (${chunk.length} records)`);
                        await PlayerCooldowns.bulkCreate(chunk, {
                            updateOnDuplicate: ['scrambleLockdownExpiry', 'playerName', 'steamID'],
                            transaction: t
                        });
                    }
                });
                this.verbose(1, `[SCRAMBLE_EVENT] ✅ SUCCESS: Switch lockdown active for ${records.length} players until ${expiry.toISOString()}.`);
            }

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
                await this.sendDiscordMessage({ embed });
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
            if (this._s3db?.isReady()) {
                await this._s3db.sequelize.authenticate();
                dbStatus = 'Connected';
            } else {
                dbStatus = 'S³ DB not available';
            }

            const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
            if (PlayerCooldowns) {
                totalStoredPlayers = await PlayerCooldowns.count();
                
                const cooldownDurationMs = this.options.switchCooldownMinutes > 0 ? this.options.switchCooldownMinutes * 60 * 1000 : this.options.switchCooldownHours * 60 * 60 * 1000;
                const cooldownCutoff = new Date(Date.now() - cooldownDurationMs);

                activeLocks = await PlayerCooldowns.count({
                    where: {
                        [Op.or]: [
                            { scrambleLockdownExpiry: { [Op.gt]: new Date() } },
                            { lastSwitchTimestamp: { [Op.gt]: cooldownCutoff } }
                        ]
                    }
                });
            }
        } catch (e) {
            dbStatus = `Error: ${e.message}`;
        }
        return { dbStatus, activeLocks, totalStoredPlayers };
    }

    /**
     * Builds a diagnostics embed for the !switch diag Discord command.
     * Uses the circle emoji status scheme (🟢 ok / 🔴 broken / 🟠 degraded / ⚫ off)
     * established in S³ Stage 8.11a for consistent cross-plugin UX.
     */
    async _buildSwitchDiagEmbed() {
        const VERSION = '2.0.0';

        // ── System health checks ──
        let dbOk = false, dbLabel = 'Unknown';
        let rconOk = false, rconLabel = 'N/A';
        let s3Ok = false, s3Label = 'Not available';

        // DB check
        try {
            if (this._s3db?.isReady()) {
                await this._s3db.sequelize.authenticate();
                dbOk = true;
                dbLabel = 'Connected';
            } else {
                dbLabel = 'S³ DB not available';
            }
        } catch (err) {
            dbLabel = `Error: ${err.message}`;
        }

        // RCON latency check
        try {
            const start = Date.now();
            await this.server.rcon.execute('ListPlayers');
            rconOk = true;
            rconLabel = `${Date.now() - start}ms`;
        } catch (err) {
            rconLabel = `Error: ${err.message}`;
        }

        // S³ integration check (like TB's testS3Integration)
        try {
            if (this.s3?.isReady() && this.s3?.gameState && this.s3?.players?.canAct) {
                s3Ok = true;
                s3Label = 'Ready';
            } else if (this.s3?.isReady()) {
                s3Label = 'Partial';
            }
        } catch (err) {
            s3Label = `Error: ${err.message}`;
        }

        const healthLines = [
            `${dbOk ? '🟢' : '🔴'} Database        ${dbLabel}`,
            `${rconOk ? '🟢' : '🔴'} RCON            ${rconLabel}`,
            `${s3Ok ? '🟢' : s3Label === 'Partial' ? '🟠' : '🔴'} S³ Integration   ${s3Label}`
        ].join('\n');

        // ── Queue status ──
        const t1Count = this._switchQueue?.t1?.length ?? 0;
        const t2Count = this._switchQueue?.t2?.length ?? 0;
        const totalQueued = t1Count + t2Count;

        // Compute oldest wait time across both queues
        let oldestWait = null;
        for (const entry of [...(this._switchQueue?.t1 ?? []), ...(this._switchQueue?.t2 ?? [])]) {
            if (oldestWait === null || entry.queuedAt < oldestWait) oldestWait = entry.queuedAt;
        }
        const waitStr = oldestWait !== null ? `${Math.round((Date.now() - oldestWait) / 1000)}s` : '\u2014';

        const queueLines = [
            `${totalQueued > 0 ? '🟢' : '⚫'} Players in Queue    ${totalQueued > 0 ? `${totalQueued} (t1: ${t1Count}, t2: ${t2Count})` : 'Empty'}`,
            `   Oldest wait: ${waitStr}`
        ].join('\n');

        // ── Cooldown statistics ──
        const now = new Date();
        const cooldownDurationMs = this.options.switchCooldownMinutes > 0
            ? this.options.switchCooldownMinutes * 60 * 1000
            : this.options.switchCooldownHours * 60 * 60 * 1000;
        const cooldownCutoff = new Date(now.getTime() - cooldownDurationMs);

        let standardCooldowns = 0;
        let scrambleLocks = 0;
        let playerList = 'None';

        try {
            const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
            if (PlayerCooldowns) {
                standardCooldowns = await PlayerCooldowns.count({
                    where: { lastSwitchTimestamp: { [Op.gt]: cooldownCutoff } }
                });
                scrambleLocks = await PlayerCooldowns.count({
                    where: { scrambleLockdownExpiry: { [Op.gt]: now } }
                });

                const lockedPlayers = await PlayerCooldowns.findAll({
                    where: {
                        [Op.or]: [
                            { scrambleLockdownExpiry: { [Op.gt]: now } },
                            { lastSwitchTimestamp: { [Op.gt]: cooldownCutoff } }
                        ]
                    },
                    order: [['scrambleLockdownExpiry', 'DESC'], ['lastSwitchTimestamp', 'DESC']],
                    limit: 5
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
            }
        } catch (err) {
            // cooldown stats silently degrade — shown as 0/None
        }

        const cooldownDurationLabel = this.options.switchCooldownMinutes > 0
            ? `${this.options.switchCooldownMinutes} min`
            : `${this.options.switchCooldownHours}h`;

        // ── Color logic ──
        const allOk = dbOk && rconOk && s3Ok;
        const anyBroken = !dbOk || !rconOk;
        const color = allOk ? 0x2ecc71 : anyBroken ? 0xe74c3c : 0xf39c12;

        // ── Build embed ──
        return {
            title: `🩺 Switch Plugin Diagnostics  v${VERSION}`,
            color,
            fields: [
                { name: 'System Health', value: healthLines, inline: false },
                { name: 'Queue Status', value: queueLines, inline: false },
                { name: 'Cooldown Statistics', value: `Standard Cooldowns:  ${standardCooldowns}\t Duration:  ${cooldownDurationLabel}\nScramble Locks:  ${scrambleLocks}`, inline: false },
                { name: 'Active Locks', value: playerList, inline: false }
            ]
        };
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
            const embed = await this._buildSwitchDiagEmbed();
            await message.channel.send({ embeds: [embed] });
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

                await message.channel.send({ embeds: [{ title: '🔍 Player Status', description: desc, color: 0x3498db }] });
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
            const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
            if (PlayerCooldowns) {
                await this._withDb(async (t) => {
                    await PlayerCooldowns.destroy({ where: { eosID: result.eosID }, transaction: t });
                });
            }
            await this.safeDiscordReply(message, `✅ Cleared cooldowns for **${result.playerName || result.steamID}**.`);
        } else if (subCommand === 'clearall') {
            const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
            if (PlayerCooldowns) {
                await this._withDb(async (t) => {
                    await PlayerCooldowns.destroy({ where: {}, truncate: true, transaction: t });
                });
            }
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
            await message.channel.send({ embeds: [embed] });
        } else {
            // Unknown subcommand — show help
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
            await message.channel.send({ embeds: [embed] });
        }
    }
}



