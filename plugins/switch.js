import S3DiscordPluginBase from './s3-discord-plugin-base.js';
import { setTimeout as delay } from "timers/promises";
import SwitchDB from '../utils/switch-db.js';
// ── Utility modules (extracted during refactor) ─────────────────
import SwitchOutput from '../utils/switch-output.js';
import SwitchQueue from '../utils/switch-queue.js';
import SwitchCommands from '../utils/switch-commands.js';


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

        // _s3 and _s3db are initialized by S3PluginBase — do NOT override here

        this._liberalModes = [];

        // v2.0.0: ChangeTeam-disabled flag (queried from S³ serverConfig during _onS3Ready)
        this._changeTeamDisabled = false;

        this._scrambleHappened = false;   // set by onScrambleExecuted, consumed by onNewGame

        // Time limit toggle — loaded from DB in _onS3Ready(), defaults to true.
        this.timeLimitEnabled = true;

        this.recentSwitches = [];
        this.recentDoubleSwitches = [];
        this._switchedOnJoin = new Set();

        this.broadcast = (msg) => { this.server.rcon.broadcast(msg); };
        this.warn = (id, msg) => {
            if (!id) return;
            const player = this.server.players.find(p => p.eosID === id || p.steamID === id);
            const name = player?.name || id;
            this.server.rcon.warn(name, msg);
        };
    }

    async mount() {
        await super.mount();

        // At this point S³ is discovered, ready, _s3db cached, and _onS3Ready() completed.
        // Wire event listeners — business logic, not S³ boilerplate.
        this._liberalModes = (this.options.liberalSwitchGameModes || ['Seed', 'Jensen']).map(m => String(m).toLowerCase());
        this._roundStats = this._initRoundStats();
        this._restartedThisRound = true;

        this.server.on('CHAT_MESSAGE', this.onChatMessage);
        this.server.on('ROUND_ENDED', this.onRoundEnded);
        this.server.on('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
        this.server.on('NEW_GAME', this.onNewGame);
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
    _checkS3Version() {
        const required = '1.0.0';
        const actual = this._s3?.version;
        if (!actual || actual < required) {
            throw new Error(
                `[Switch] Incompatible S³ version: got ${actual || 'unknown'}, need >=${required}. ` +
                'Please update SlackersSquadServices.'
            );
        }
        this.verbose(2, `[S3] Version check passed: S³ v${actual} >= required v${required}`);
    }

    async _onS3Ready() {
        this._checkS3Version();
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

        // ── Utility registration (extracted during refactor) ──────────
        await SwitchDB.register(this);
        SwitchOutput.register(this);
        SwitchQueue.register(this);
        SwitchCommands.register(this);


        // Refresh interest is registered conditionally — only when the queue becomes
        // non-empty (see _enqueuePlayer), and unregistered when the queue empties
        // (see _removePlayerFromQueue). If the queue is disabled, no interest is
        // registered at all. This avoids polling when no one is waiting.
        this.verbose(2, '[S3] Switch refresh interest is conditional (poll only when queue active).');

        // Subscribe to S³ layer changes for broadcast timer management.
        // The callback fires AFTER resolveLayerInfo() commits the new layer —
        // avoiding the race where onNewGame() reads the stale seed layer name.
        this._unsubscribeLayerChange = this._s3?.gameState?.onLayerGameModeChange?.(({ layerName, gameMode }) => {
            this._onLayerChanged(layerName, gameMode);
        }) || null;
    }

    async prepareToMount() {
        if (this.options.discordChannelID) {
            this.options.channelID = this.options.discordChannelID;
        }
        await super.prepareToMount();
        // S3: Table sync and ALTER TABLE are removed — handled by S³ MigrationEngine in mount()
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

    onRoundEnded = async (dt) => {
        this._clearBroadcastTimers();
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

        if (!this.isLiberalMode() && this.timeLimitEnabled) {
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

    onNewGame = async () => {
        this.verbose(1, '[NEW_GAME] Round started — null-teamID window handled by S³ players service.');

        // Post summary for the round that just ended, BEFORE resetting stats
        await this._postRoundSummary();

        // v2.0.0: Store game start timestamp for broadcast timing
        this._gameStartTs = Date.now();

        // Clear restart flag — we're now in a fresh round
        this._restartedThisRound = false;

        // Reset round stats for the new round
        this._roundStats = this._initRoundStats();

        // ── Broadcast timer startup (dual-path) ──────────────────────
        //
        // Broadcasts are started via TWO paths to cover all scenarios:
        //
        // 1. DIRECT CALL (below): Calls _onLayerChanged() immediately using
        //    the current S³ gameState layer/gamemode. This covers:
        //    - Normal NEW_GAME events (SquadJS fires NEW_GAME → we start timers)
        //    - Mid-round SquadJS restarts (S³ has already resolved the layer
        //      during mount, so getLayerName()/getGamemode() return valid data
        //      immediately — no need to wait for a subscription to fire)
        //    - Seed rounds (perpetual rounds that never end; without this call,
        //      broadcasts would never start after a restart since no future
        //      NEW_GAME or layer change would trigger the subscription)
        //
        // 2. SUBSCRIPTION (registered in _onS3Ready): The onLayerGameModeChange
        //    callback handles mid-round layer transitions (e.g. seed→live map
        //    change). When the layer changes mid-round, the subscription fires
        //    and restarts the appropriate broadcast timers for the new layer.
        //
        // Both paths call _onLayerChanged(), which is idempotent — it calls
        // _clearBroadcastTimers() before starting new ones, so if both fire
        // for the same layer, the second call is a harmless clear+restart.
        this._onLayerChanged(
            this._s3?.gameState?.getLayerName?.() || '',
            this._s3?.gameState?.getGamemode?.() || ''
        );
    }

    onS3PlayerJoined = async (data) => {
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

    onS3PlayerLeft = async (data) => {
        if (!data?.player?.eosID) return;

        const { eosID, name, teamID } = data.player;
        // Delegate to handlePlayerLeave — clears join-warn, removes from queue,
        // and records queueDisconnects in _roundStats (preserved across refactor).
        this.handlePlayerLeave(eosID, teamID, name);

        if (!this.s3IsEndgameFactionVote()) {
            await this._processQueue();
        }
    }

    onS3PlayerTeamChanged = async (data) => {
        if (!data?.player?.eosID) return;
        if (!this.s3IsEndgameFactionVote()) {
            await this._processQueue();
        }
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

        // Unsubscribe from S³ layer change callback
        if (this._unsubscribeLayerChange) {
            this._unsubscribeLayerChange();
            this._unsubscribeLayerChange = null;
        }

        // v2.0.0: Clear all pending join-warn timeouts
        for (const [eosID, timeout] of this._joinWarnTimeouts) {
            clearTimeout(timeout);
        }
        this._joinWarnTimeouts.clear();

        this._scrambleHappened = false;

        this.server.removeListener('CHAT_MESSAGE', this.onChatMessage);
        this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
        this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
        this.server.removeListener('NEW_GAME', this.onNewGame);
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

    onScrambleExecuted = async (data) => {
        const { affectedPlayers } = data;
        this.verbose(2, `[SCRAMBLE_EVENT] onScrambleExecuted called with data: ${JSON.stringify(data)}`);
        
        this._clearAllQueueEntries('Scramble');

        // v2.0.0: During seed rounds, scramble clears the queue but does NOT
        // apply lockdown or flag _scrambleHappened — normal broadcasts play
        // when the next (non-seed) round starts.
        if (this._s3?.gameState?.isSeedMode?.()) {
            this.verbose(1, `[SCRAMBLE_EVENT] Seed round — queue cleared, no lockdown applied.`);
            return;
        }

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

}



