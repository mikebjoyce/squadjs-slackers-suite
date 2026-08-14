import Sequelize from 'sequelize';
const { Op } = Sequelize;
import S3DiscordPluginBase from './s3-discord-plugin-base.js';
import { setTimeout as delay } from "timers/promises";
import SwitchDB from '../utils/switch-db.js';
// ── Utility modules (extracted during refactor) ─────────────────
import SwitchOutput from '../utils/switch-output.js';
import SwitchQueue from '../utils/switch-queue.js';
import SwitchCommands from '../utils/switch-commands.js';
import SwitchExplain from '../utils/switch-explain.js';


/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                    SWITCH PLUGIN v2.4.0                       ║
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
 *     onS3PlayerJoined(data)           — Triggers queue processing and join warn.
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
 * GitHub: https://github.com/mikebjoyce/squadjs-slackers-suite/tree/master/s3
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
 *   - S3_PLAYER_JOINED: triggers queue processing and join warn.
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
 *   window (join or match start) and players who were actively queued
 *   for a switch, since they had no opportunity to exploit pre-scramble
 *   imbalance.
 * - Liberal game modes (default: Seed, Jensen) relax cooldown and time
 *   limits. Configured via liberalSwitchGameModes and
 *   liberalSwitchMaxUnbalancedSlots. Liberal-mode broadcast interval
 *   is configurable via liberalSwitchBroadcastIntervalMinutes
 *   (default: 5 min, set to 0 to disable).
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
 * ─── AUTO-UPDATING EXPLAIN CHANNEL ───────────────────────────────
 *
 * When explainChannelID is set, _initExplainAutoUpdate() is called
 * during _onS3Ready() after DB registration. It posts (or edits) the
 * full explain embed sequence plus a 7-day reliability stats embed to
 * the designated channel. The embed is generated once on SquadJS
 * startup — no periodic refresh. The message ID is persisted in
 * SwitchPlugin_Settings so it survives SquadJS restarts.
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
 *   !switch status                 → Show DB health, active locks, and top-10 locked players.
 *   !switch help                   → List all admin commands.
 * Admin (Discord):
-------
 *   !switch status                 → Database health + RCON latency + top-10 locked players.
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
    static version = '2.4.0';

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
                default: ['!bug', '!stuck', '!doubleswitch'],
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
                default: 1.75
            },
            switchCooldownMinutes: {
                required: false,
                description: "Minutes to wait before using again the !switch command (overrides hours if set)",
                default: 0
            },
            switchEnabledMinutes: {
                required: false,
                description: "Time in minutes in which the switch will be enabled after match start or player join",
                default: 10
            },
            queueTimeoutMinutes: {
                required: false,
                description: "Minutes a player can wait in the switch queue before being removed (separate from the eligibility window)",
                default: 15
            },
            doubleSwitchEnabledMinutes: {
                required: false,
                description: "Time in minutes in which a double switch will be enabled after match start or player join",
                default: 10
            },
            maxUnbalancedSlots: {
                required: false,
                description: "Number of player of difference between the two teams to allow a team switch",
                default: 1
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
                default: 30
            },
            scrambleLockdownMinPlayers: {
                required: false,
                description: "Minimum total players required to apply scramble lockdown. Below this threshold, scrambles clear the queue but do not lock switching.",
                default: 60
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
            liberalSwitchBroadcastIntervalMinutes: {
                required: false,
                description: 'Minutes between liberal-mode (Seed/Jensen) broadcast reminders. Set to 0 to disable.',
                default: 8,
                type: 'number'
            },
            dynamicBalanceTolerance: {
                required: false,
                description: "Enable interpolated extra imbalance tolerance when server is below full capacity (default: off). Scales from floor to 98 players.",
                default: true,
                type: 'boolean'
            },
            dynamicBalancePlayerFloor: {
                required: false,
                description: "Total player count at which maximum extra tolerance kicks in (default 90). Below this, full extra slots apply.",
                default: 85,
                type: 'number'
            },
            dynamicBalanceExtraSlots: {
                required: false,
                description: "Additional allowed imbalance slots at the floor player count (default 2). Linearly interpolated between floor and 98 players.",
                default: 3,
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
                default: 30
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
            },
            adminCommandChannelID: {
                required: false,
                description: 'Discord channel ID for admin commands. If not set, falls back to channelID (single-channel mode).',
                default: ''
            },
            explainChannelID: {
                required: false,
                description: 'Discord channel ID for auto-updating explain messages with 7-day stats. When set, explain embeds are posted to this channel on SquadJS startup.',
                default: ''
            },
            // v2.2.0 Options
            queueTimeoutSwitchEnabled: {
                required: false,
                description: 'When true, players who reach the queue timeout are force-switched instead of removed. When false, they are removed from the queue with an expiry message (legacy behaviour).',
                default: true
            },
            queueTimeoutExtraSlots: {
                required: false,
                description: 'Extra allowed team imbalance slots for timeout-triggered switches. Stacks on top of maxUnbalancedSlots and dynamic balance extras.',
                default: 2
            },
            // ── v2.3.0 Options ─────────────────────────────────────
            maxSwitchTokens: {
                required: false,
                description: 'Maximum number of switch tokens a player can hold. Each switch consumes 1 token; tokens regenerate individually over the cooldown interval. Set to 1 for legacy flat-cooldown behavior.',
                default: 2,
                type: 'number'
            },
             // ── Stage 2: Seed bonus token options ──────────────────
             seedTokenBonusAmount: {
                 required: false,
                 description: 'Maximum bonus tokens a player can earn per seed round. Set to 0 to disable seed bonus tokens entirely. Each qualifying interval grants +1 token (see seedTokenBonusMinutes).',
                 default: 1,
                 type: 'number'
             },
             seedTokenBonusMinutes: {
                 required: false,
                 description: 'Minutes a player must be present in a seed-mode round to earn one bonus token. Set to 0 to disable seed bonus tokens entirely.',
                 default: 20,
                 type: 'number'
             },
             seedTokenBonusMinPlayers: {
                 required: false,
                 description: 'Minimum number of players on the server before seed presence time accrues toward bonus tokens. Set to 0 to disable the minimum (time always accrues in seed mode).',
                 default: 0,
                 type: 'number'
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
        this._reconnectLockoutClearTimeouts = new Map();

         // v2.3.0 Stage 2: Seed presence tracking
         this._seedPresenceProcessing = false;  // re-entrancy guard for seed bonus checks
         this._wasSeedMode = false;             // track seed→non-seed transitions in _onLayerChanged
         this._seedAccrualActive = false;       // v2.4.0: current seed-presence accrual state (seed mode + enabled + min players)

        // ── Explain auto-update state ────────────────────────────
        this._explainMessage = null;       // cached Discord message object for editing
        this._explainMessageID = null;
        this._explainChannelID = null;
        this._cachedExplainMessageData = null; // { channelID, messageID } loaded from DB

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

        // ── Option validation (clamp out-of-range values) ────────
        if (this.options.maxSwitchTokens <= 0) {
            this.verbose(1, `[Config] maxSwitchTokens=${this.options.maxSwitchTokens} is invalid — forcing to 1 (legacy flat-cooldown mode).`);
            this.options.maxSwitchTokens = 1;
        }
         if (this.options.seedTokenBonusAmount < 0) {
             this.verbose(1, `[Config] seedTokenBonusAmount=${this.options.seedTokenBonusAmount} is invalid — forcing to 0 (no seed bonus tokens).`);
             this.options.seedTokenBonusAmount = 0;
         }
         if (this.options.seedTokenBonusMinutes < 0) {
             this.verbose(1, `[Config] seedTokenBonusMinutes=${this.options.seedTokenBonusMinutes} is invalid — forcing to 0 (seed bonus disabled).`);
             this.options.seedTokenBonusMinutes = 0;
         }
         if (this.options.seedTokenBonusMinPlayers < 0) {
             this.verbose(1, `[Config] seedTokenBonusMinPlayers=${this.options.seedTokenBonusMinPlayers} is invalid — forcing to 0 (no minimum).`);
             this.options.seedTokenBonusMinPlayers = 0;
         }

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
        this.server.on('S3_PLAYERS_UPDATED', this._onSeedPresenceCheck);
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
        // ★ Attach public API methods FIRST (synchronous, no awaits)
        //    so other plugins discover them during their _onS3Ready().
        SwitchOutput.register(this);
        SwitchQueue.register(this);
        SwitchCommands.register(this);
        SwitchExplain.register(this);
        // Then do async DB registration (can yield safely now)
        await SwitchDB.register(this);

        // ── Auto-update explain channel ──────────────────────────
        if (this.options.explainChannelID) {
            await this._initExplainAutoUpdate().catch(err => {
                this.verbose(1, `[Explain] Auto-update init failed: ${err.message}`);
            });
        }

        // Refresh interest is registered conditionally — only when the queue becomes
        // non-empty (see _enqueuePlayer), and unregistered when the queue empties
        // (see _removePlayerFromQueue). If the queue is disabled, no interest is
        // registered at all. This avoids polling when no one is waiting.
        this.verbose(2, '[S3] Switch refresh interest is conditional (poll only when queue active).');

        // ── Mid-round restart: backfill _gameStartTs from S³ ──────────
        // onNewGame() sets _gameStartTs during normal NEW_GAME events, but when
        // SquadJS restarts mid-round, NEW_GAME never fires and _gameStartTs
        // stays undefined. The status embed and broadcast timers depend on it
        // for display. Backfill from S³'s authoritative round start time.
        if (!Number.isFinite(this._gameStartTs)) {
            const roundStartTime = this._s3?.gameState?.getRoundStartTime?.();
            if (roundStartTime) {
                this._gameStartTs = roundStartTime;
                this.verbose(2, `[S3] Backfilled _gameStartTs from S³ (mid-round recovery).`);
            }
        }

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

        // ── Dual‑channel setup ──────────────────────────────────────
        // adminCommandChannelID gates the !switch admin command listener
        // (onDiscordMessage). Round summaries, scramble notifications,
        // and other automated reports continue flowing to this.channel
        // (the reporting channel set by channelID/discordChannelID).
        // Admin commands are self‑routing (they reply to message.channel),
        // so no dedicated admin channel reference is stored on the instance.
        // If adminCommandChannelID is not set, both routes converge on the
        // reporting channel — identical to the old single‑channel behaviour.
        // ─────────────────────────────────────────────────────────────
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

        // v2.2.0: Cache liberal mode before round/layer changes
        if (this._roundStats) {
            this._roundStats.wasLiberalMode = this.isLiberalMode();
        }

        this.verbose(2, `[Queue] Round ended — queue preserved (${this._getQueueSize()} entries remain).`);

        // Run matchend switches only — summary now posts on NEW_GAME
        await this.cleanup();
        try {
            await this.doSwitchMatchend();
        } catch (err) {
            this.verbose(1, `[Switch] onRoundEnded matchend processing failed: ${err.message || err}`);
        }
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
        const result = Math.round(interpolated);
        return result === 0 && totalPlayers < effectiveCap ? 1 : result;
    }

    /**
     * Calculate how many switch slots are available for a given team.
     *
     * @param {number} teamID — The team requesting a player to switch to (1 or 2).
     * @param {number|null} effectiveCap — Override for maxUnbalancedSlots (e.g. liberal mode or timeout).
     *   When null, uses this.options.maxUnbalancedSlots + dynamic extras.
     * @param {boolean} skipHardCap — When true, bypasses the 50/50 max team size hard cap.
     *   Used for queue timeout switches where being 2-3 players over is preferable
     *   to removing the player from the queue entirely.
     * @returns {number} — Number of slots available (0 or 1).
     */
     getSwitchSlotsPerTeam(teamID, effectiveCap = null, skipHardCap = false) {
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
          const effectiveMax = this?._s3?.serverConfig?.isReady()
            ? this._s3.serverConfig.getMaxPlayers() - this._s3.serverConfig.getNumReservedSlots()
            : 98;
          const maxTeamSize = Math.floor(effectiveMax / 2);
         if (!skipHardCap && (teamPlayerCount[receivingTeam] || 0) >= maxTeamSize) return 0;

         return 1;
     }

    /**
     * Lazy token regeneration — brings a player's token balance current
     * based on elapsed time since tokenRegenAnchor.
     *
     * Algorithm (§3.1 of switch-token-system-spec):
     *   room = max(0, maxSwitchTokens - tokenBalance)
     *   if room > 0:
     *       elapsedMs = now - tokenRegenAnchor
     *       wholeIntervals = floor(elapsedMs / intervalMs)
     *       regenerated = min(room, wholeIntervals)
     *       if regenerated > 0:
     *           tokenBalance += regenerated
     *           tokenRegenAnchor += regenerated * intervalMs
     *   else:
     *       tokenRegenAnchor = now   # capped — don't accrue regen credit while at/above cap
     *
     * Critical: never clamps tokenBalance downward. Only ever adds, gated by room.
     * This preserves balance sitting above cap from a seeding grant (Stage 2).
     *
     * @param {object} row — DB row with tokenBalance and tokenRegenAnchor (mutated in place)
     * @returns {object} — the same row, mutated
     */
    _regenTokens(row) {
        const maxTokens = this.options.maxSwitchTokens;
        const intervalMs = this.options.switchCooldownMinutes > 0
            ? this.options.switchCooldownMinutes * 60 * 1000
            : this.options.switchCooldownHours * 60 * 60 * 1000;

        // If cooldown is 0 (or negative), the token check in _checkSwitchEligibility()
        // is never reached — it's gated behind `!this.isLiberalMode() && this.timeLimitEnabled`,
        // and with no cooldown the time window check also passes. Tokens are effectively
        // infinite in this configuration, so no regen is needed.
        if (intervalMs <= 0) return row;

        const now = Date.now();
        const balance = row.tokenBalance != null ? row.tokenBalance : maxTokens;
        const anchor = row.tokenRegenAnchor ? new Date(row.tokenRegenAnchor).getTime() : now;

        const room = Math.max(0, maxTokens - balance);
        if (room > 0) {
            const elapsedMs = now - anchor;
            if (elapsedMs > 0) {
                const wholeIntervals = Math.floor(elapsedMs / intervalMs);
                if (wholeIntervals > 0) {
                    const regenerated = Math.min(room, wholeIntervals);
                    row.tokenBalance = balance + regenerated;
                    row.tokenRegenAnchor = new Date(anchor + regenerated * intervalMs);
                }
            }
        } else {
            // At or above cap — don't accrue regen credit
            row.tokenRegenAnchor = new Date(now);
        }

        return row;
    }

    /**
     * Spend one token. Runs _regenTokens() first for anchor correctness,
     * then decrements tokenBalance. If this spend transitions from "at cap"
     * to "below cap", starts the regen clock.
     *
     * The exact-equality check `row.tokenBalance === maxTokens - 1` is intentional:
     *   - We only start the regen clock when this spend brought balance from
     *     exactly-at-cap (balance === maxTokens) to below cap (balance === maxTokens - 1).
     *   - We do NOT use `< maxTokens` because a seeding grant (Stage 2) could push
     *     balance above cap (e.g. balance 3 with maxTokens=2). Spending from 3→2
     *     is still at/above cap, so the anchor should NOT reset — the player still
     *     has their full replenishment rate and shouldn't start a new regen cycle.
     *   - The `else` path (all other cases) leaves tokenRegenAnchor alone because
     *     an existing regen cycle is already running from a previous spend that
     *     did cross the cap boundary.
     *
     * @param {object} row — DB row with tokenBalance and tokenRegenAnchor (mutated in place)
     * @returns {object} — the same row, mutated
     */
    _spendToken(row) {
        this._regenTokens(row);
        const maxTokens = this.options.maxSwitchTokens;
        const balance = row.tokenBalance != null ? row.tokenBalance : maxTokens;

        row.tokenBalance = Math.max(0, balance - 1);

        // If this spend brought balance from "at cap" to "below cap", start regen clock
        if (row.tokenBalance === maxTokens - 1) {
            row.tokenRegenAnchor = new Date(Date.now());
        }
        // Otherwise leave tokenRegenAnchor alone — an existing regen cycle is already running

        return row;
    }

    async _checkSwitchEligibility(player) {
        const eosID = player?.eosID;
        if (!eosID) return { eligible: false, reason: 'missing_eos' };

        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        const cooldownData = PlayerCooldowns ? await PlayerCooldowns.findByPk(eosID) : null;
        const now = Date.now();

        // Liberal/seed mode bypasses all cooldown and lock restrictions.
        // Must be checked BEFORE the scramble lock — otherwise a stale lock
        // from a prior non-seed round blocks switching during seed.
        if (this.isLiberalMode()) {
            return { eligible: true };
        }

        // Scramble lock is an independent override — token availability never overrides it
        if (cooldownData && cooldownData.scrambleLockdownExpiry && new Date(cooldownData.scrambleLockdownExpiry).getTime() > now) {
            const remaining = Math.ceil((new Date(cooldownData.scrambleLockdownExpiry).getTime() - now) / 60000);
            return { eligible: false, reason: 'scramble_lock', remaining };
        }

        if (this.timeLimitEnabled) {
            const connectionSeconds = await this.getSecondsFromJoin(eosID);
            const matchSeconds = this.getSecondsFromMatchStart();
            const limit = this.options.switchEnabledMinutes;

            if (connectionSeconds / 60 > limit && matchSeconds / 60 > limit) {
                return { eligible: false, reason: 'time_window' };
            }

            // ── Token bucket check (replaces flat cooldown comparison) ──
            // Build a plain object (not a Sequelize model instance) and pass it
            // to _regenTokens(). This is safe because _regenTokens() only reads
            // and writes .tokenBalance and .tokenRegenAnchor — it never calls
            // Sequelize methods on the object.
            const row = cooldownData
                ? { tokenBalance: cooldownData.tokenBalance, tokenRegenAnchor: cooldownData.tokenRegenAnchor }
                : { tokenBalance: this.options.maxSwitchTokens, tokenRegenAnchor: null };

            this._regenTokens(row);

            if (row.tokenBalance < 1) {
                const intervalMs = this.options.switchCooldownMinutes > 0
                    ? this.options.switchCooldownMinutes * 60 * 1000
                    : this.options.switchCooldownHours * 60 * 60 * 1000;
                const anchor = row.tokenRegenAnchor ? new Date(row.tokenRegenAnchor).getTime() : now;
                const remaining = Math.ceil((intervalMs - (now - anchor)) / 60000);
                return { eligible: false, reason: 'cooldown', remaining };
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

    /**
     * Clears cooldown and scramble lockdown for a reconnecting player
     * found on the wrong team. Called immediately (no delay) so the
     * player can !switch back without restriction.
     *
     * NOTE: lastSwitchTimestamp is an obsolete column (kept for
     * expand-contract migration safety). All write sites now use
     * tokenBalance/tokenRegenAnchor. The hadCooldown_obsolete check
     * below reads the old column for completeness during the transition
     * period, but post-migration-v3 rows will always have
     * lastSwitchTimestamp === null. The token-aware check using
     * tokenBalance < maxSwitchTokens is the real cooldown indicator.
     */
    async _clearReconnectLockouts(eosID, name, previousTeamID) {
        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        if (!PlayerCooldowns) return;

        const row = await PlayerCooldowns.findByPk(eosID);
        if (!row) return;

        const maxTokens = this.options.maxSwitchTokens;
        const hadCooldown_obsolete = row.lastSwitchTimestamp != null;
        const hasTokenDebt = row.tokenBalance != null && row.tokenBalance < maxTokens;
        const now = Date.now();
        const hadScrambleLock = row.scrambleLockdownExpiry != null
            && new Date(row.scrambleLockdownExpiry).getTime() > now;

        if (!hadCooldown_obsolete && !hasTokenDebt && !hadScrambleLock) return;

        await this._withDb(async (t) => {
            await PlayerCooldowns.update(
                {
                    lastSwitchTimestamp: null,
                    tokenBalance: maxTokens,
                    tokenRegenAnchor: null,
                    scrambleLockdownExpiry: null
                },
                { where: { eosID }, transaction: t }
            );
        });

        // Reset joinTime so the player's switch eligibility window reopens.
        // Without this, a stale joinTime gates !switch even with a full token balance.
        try {
            await this._s3?.players?.resetJoinTime?.(eosID);
        } catch (err) {
            this.verbose(1, `[Reconnect] resetJoinTime failed for ${name || eosID}: ${err.message}`);
        }

        const reasons = [];
        if (hadCooldown_obsolete) reasons.push('legacy cooldown');
        if (hasTokenDebt) reasons.push('token cooldown');
        if (hadScrambleLock) reasons.push('scramble lock');
        this.verbose(1,
            `[Reconnect] ${name || eosID}: cleared ${reasons.join(' and ')} — stranded on current team, previous was T${previousTeamID}`
        );
    }

    /**
     * Clears only the scramble lockdown for a reconnecting player (any team).
     * Lightweight — does NOT touch tokens, cooldowns, or joinTime.
     * Called for ALL reconnects so a player who disconnected before a scramble
     * and reconnects in a later round isn't locked by a scramble they missed.
     *
     * @param {string} eosID — Player's EOS ID
     * @param {string} name — Player name (for logging)
     */
    async _clearReconnectScrambleLock(eosID, name) {
        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        if (!PlayerCooldowns) return;

        const row = await PlayerCooldowns.findByPk(eosID);
        if (!row) return;

        const now = Date.now();
        const hadScrambleLock = row.scrambleLockdownExpiry != null
            && new Date(row.scrambleLockdownExpiry).getTime() > now;

        if (!hadScrambleLock) return;

        await this._withDb(async (t) => {
            await PlayerCooldowns.update(
                { scrambleLockdownExpiry: null },
                { where: { eosID }, transaction: t }
            );
        });

        this.verbose(1, `[Reconnect] ${name || eosID}: cleared stale scramble lock (reconnect).`);
    }

    /**
     * Resets scramble lockdown and ensures the player has at least 1 usable switch token.
     * Used when a player is stranded through no fault of their own:
     *   - Scramble RCON move failed (Phase 3)
     *   - SA couldn't place a reconnecting player on their correct team (Phase 5)
     *
     * The +1 token is granted only when the player is below their token cap
     * (`tokenBalance < maxSwitchTokens`). This keeps the grant bounded — the result
     * never stacks above the normal cap, unlike the seed-bonus grant path which
     * intentionally stacks upward. A player already at cap already has a usable
     * path back via !switch / the queue, so no bonus is handed out.
     *
     * The scramble lock is cleared whenever a row exists and either an active lock
     * or a below-cap balance warrants action.
     *
     * Uses Sequelize.literal('tokenBalance + 1') for an atomic increment to avoid
     * TOCTOU races with concurrent grant paths. Sets tokenRegenAnchor = null on the
     * grant so the regen clock doesn't immediately consume it — at the cost of
     * discarding any accrued mid-regen progress toward the next token.
     *
     * @param {string} eosID — Player's EOS ID
     * @returns {Promise<boolean>} true when a +1 token was granted, false otherwise.
     */
    async _resetPlayerLockouts(eosID) {
        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        if (!PlayerCooldowns) return false;

        const row = await PlayerCooldowns.findByPk(eosID);
        if (!row) {
            this.verbose(2, `[_resetPlayerLockouts] No PlayerCooldowns row for ${eosID} — nothing to reset.`);
            return false;
        }

        const now = Date.now();
        const maxTokens = this.options.maxSwitchTokens;
        const hadScrambleLock = row.scrambleLockdownExpiry != null
            && new Date(row.scrambleLockdownExpiry).getTime() > now;
        const balance = row.tokenBalance != null ? row.tokenBalance : maxTokens;
        const belowCap = balance < maxTokens;

        if (!hadScrambleLock && !belowCap) {
            this.verbose(2, `[_resetPlayerLockouts] ${eosID}: no active scramble lock and at token cap — nothing to do.`);
            return false;
        }

        await this._withDb(async (t) => {
            const fields = { scrambleLockdownExpiry: null };
            if (belowCap) {
                fields.tokenBalance = Sequelize.literal('tokenBalance + 1');
                fields.tokenRegenAnchor = null;
            }
            await PlayerCooldowns.update(fields, { where: { eosID }, transaction: t });
        });

        // Reset joinTime so the player's switch eligibility window reopens.
        // Without this, a stale joinTime gates !switch even with a fresh token.
        try {
            await this._s3?.players?.resetJoinTime?.(eosID);
        } catch (err) {
            this.verbose(1, `[_resetPlayerLockouts] resetJoinTime failed for ${eosID}: ${err.message}`);
        }

        this.verbose(1, `[_resetPlayerLockouts] ${eosID}: cleared scramble lock${belowCap ? ' + granted +1 token' : ''}.`);
        return belowCap;
    }

    handlePlayerLeave(eosID, teamID, playerName) {
        // v2.0.0: Clear join-warn timeout on disconnect
        this._clearJoinWarnTimeout(eosID);

        // v2.0.0: Clear reconnect-lockout-clear message timeout
        const rlTimeout = this._reconnectLockoutClearTimeouts.get(eosID);
        if (rlTimeout) {
            clearTimeout(rlTimeout);
            this._reconnectLockoutClearTimeouts.delete(eosID);
        }

        // v2.1.1: Capture full queue entry data BEFORE removal so the
        // round-summary embed shows team IDs and wait duration instead
        // of falling back to "?" placeholders.  _findQueueEntry returns
        // the live entry while it still exists in the queue; after
        // _removePlayerFromQueue it would already be null.
        const queueEntry = this._findQueueEntry(eosID)?.entry;
        if (this._removePlayerFromQueue(eosID)) {
            this.verbose(2, `[Queue] ${playerName} disconnected — removed from queue.`);
            if (this._roundStats && queueEntry) {
                const queueDurationSeconds = Math.round((Date.now() - queueEntry.queuedAt) / 1000);
                const gamePhase = this._s3?.gameState?.getPhase?.() || 'UNKNOWN';
                this._roundStats.queueDisconnects.push({
                    name: playerName,
                    eosID,
                    currentTeamID: queueEntry.currentTeamID,
                    targetTeamID: queueEntry.targetTeamID,
                    queueDurationSeconds,
                    gamePhase
                });
            }
        }
        this.verbose(2, `Player disconnected ${playerName}`);
        this.recentDoubleSwitches = this.recentDoubleSwitches.filter(p => p.eosID != eosID);
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

        // Clear the queue — round transition invalidates all stored teamIDs
        this._clearAllQueueEntries('New round');
        // Schedule a delayed notification for former queued players
        this._scheduledClearNotification = setTimeout(() => {
            this.verbose(1, '[NEW_GAME] Queue cleared — players notified.');
        }, 30_000);

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

        // ── Reconnect lockout clearing ──────────────────────────────
        // Two-tier reconnect handling:
        //
        // 1. ALL reconnects (any team): clear scrambleLockdownExpiry.
        //    A player who disconnected before a scramble and reconnects
        //    in a later round should not be locked by a scramble they
        //    weren't present for. Token top-up is NOT granted here —
        //    only the lock is cleared.
        //
        // 2. Wrong-team reconnects: full remediation (clear cooldowns,
        //    top up tokens, reset joinTime, show delayed message).
        //    Only fires when both teams are real (1 or 2) — guards
        //    against null-teamID during the staging window.
        const isRealTeam = (t) => t === 1 || t === 2;
        const isReconnect = isRealTeam(previousTeamID) && isRealTeam(teamID);
        const isReconnectOnWrongTeam = isReconnect && teamID !== previousTeamID;

        if (isReconnect) {
            // Tier 1: clear scramble lock for ALL reconnects (fire-and-forget).
            // Uses a lightweight DB update — only touches scrambleLockdownExpiry.
            this._clearReconnectScrambleLock(eosID, name).catch(err => {
                this.verbose(1, `[Reconnect] Scramble lock clear failed for ${name || eosID}: ${err.message}`);
            });
        }

        if (isReconnectOnWrongTeam && !this._reconnectLockoutClearTimeouts.has(eosID)) {
            this._clearReconnectLockouts(eosID, name, previousTeamID).catch(err => {
                this.verbose(1, `[Reconnect] Lockout clear failed for ${name || eosID}: ${err.message}`);
            });

            const msgTimeout = setTimeout(() => {
                this._reconnectLockoutClearTimeouts.delete(eosID);
                const s3p = this._s3?.players?.isReady()
                    ? this._s3.players.getPlayer(eosID) : null;
                if (s3p && s3p.teamID != null && s3p.teamID !== previousTeamID) {
                    this.warn(eosID,
                        `You reconnected to a different team. ` +
                        `Your switch restrictions have been cleared — type !switch to return to your previous team.`
                    );
                }
            }, 30_000);
            this._reconnectLockoutClearTimeouts.set(eosID, msgTimeout);
        }

        // v2.3.0 Stage 2: If server is in seed mode, set seedPresenceStart for this player
        // so they can earn a seed bonus token. Preserves existing seedPresenceStart
        // (e.g. rejoin during same seed session — cumulative time). Does NOT reset
        // seedBonusTokensEarned — a reconnecting player keeps their pre-disconnect
        // accumulated count for the current seed session.
        //
        // NOTE: The findByPk + conditional create pattern has a theoretical TOCTOU race:
        // if two S3_PLAYER_JOINED events for the same eosID fire concurrently (e.g. during
        // rapid reconnect), the second create() would throw a Sequelize UniqueConstraintError.
        // This is caught by the outer try/catch and is harmless — the second event is a
        // no-op (the row already exists, and seedPresenceStart was already set by the first).
        // We accept this race rather than introducing a full findOrCreate/try-catch wrapper
        // because the window is extremely narrow and the consequence is a single spurious
        // verbose log line.
        try {
            if (this._s3?.gameState?.isSeedMode?.() && this._isSeedAccrualActive()) {
                const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
                if (PlayerCooldowns) {
                    const row = await PlayerCooldowns.findByPk(eosID);
                    if (!row) {
                        await PlayerCooldowns.create({
                            eosID,
                            steamID: data.player?.steamID || null,
                            playerName: name,
                            tokenBalance: this.options.maxSwitchTokens,
                            seedPresenceStart: new Date()
                        });
                        this.verbose(2, `[SeedPresence] ${name}: joined during seed mode — created row with seedPresenceStart.`);
                    } else if (!row.seedPresenceStart) {
                        await PlayerCooldowns.update(
                            { seedPresenceStart: new Date() },
                            { where: { eosID } }
                        );
                        this.verbose(2, `[SeedPresence] ${name}: joined during seed mode — set seedPresenceStart.`);
                    }
                    // else: seedPresenceStart already set — cumulative across reconnects
                }
            }
        } catch (err) {
            this.verbose(1, `[SeedPresence] Error setting seedPresenceStart for ${name || eosID}: ${err.message}`);
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
     *
     * NOTE: _onUnmount() is called by S3PluginBase.unmount(), but as of
     * SquadJS v4.2.0 RC1 and earlier, the framework never calls
     * plugin.unmount(). This cleanup is kept for future-proofing — if
     * SquadJS ever implements dynamic mount/unmount, listeners will be
     * cleaned up correctly.
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

        // v2.0.0: Clear all pending reconnect-lockout-clear message timeouts
        for (const [eosID, timeout] of this._reconnectLockoutClearTimeouts) {
            clearTimeout(timeout);
        }
        this._reconnectLockoutClearTimeouts.clear();

        // Clear any pending scheduled notification timer
        if (this._scheduledClearNotification) {
            clearTimeout(this._scheduledClearNotification);
            this._scheduledClearNotification = null;
        }

        // ── Explain auto-update cleanup ──────────────────────────
        this._explainMessage = null;
        this._explainMessageID = null;
        this._explainChannelID = null;

        this._scrambleHappened = false;

        this.server.removeListener('CHAT_MESSAGE', this.onChatMessage);
        this.server.removeListener('ROUND_ENDED', this.onRoundEnded);
        this.server.removeListener('TEAM_BALANCER_SCRAMBLE_EXECUTED', this.onScrambleExecuted);
        this.server.removeListener('NEW_GAME', this.onNewGame);
        this.server.removeListener('S3_PLAYER_JOINED', this.onS3PlayerJoined);
        this.server.removeListener('S3_PLAYER_LEFT', this.onS3PlayerLeft);
        this.server.removeListener('S3_PLAYER_TEAM_CHANGED', this.onS3PlayerTeamChanged);
        this.server.removeListener('S3_PLAYERS_UPDATED', this._onSeedPresenceCheck);
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

    // ── Stage 2: Seed bonus token methods ─────────────────────────

    /**
     * v2.4.0: Whether the seed bonus token feature is enabled at all.
     * Disabled when either seedTokenBonusAmount <= 0 or seedTokenBonusMinutes <= 0.
     * Setting either option to 0 disables seed bonus tokens entirely.
     */
    _isSeedBonusEnabled() {
        return this.options.seedTokenBonusAmount > 0
            && this.options.seedTokenBonusMinutes > 0;
    }

    /**
     * v2.4.0: Whether seed-presence accrual is currently active.
     * True only when the server is in seed mode, the seed bonus is enabled,
     * and the server population meets the minimum-player threshold.
     *
     * When false, seed presence time does NOT count toward bonus tokens and
     * no grants fire. A false→true transition resets all seedPresenceStart
     * timestamps (see _onSeedPresenceCheck → _initSeedPresenceForAll(true)).
     */
    _isSeedAccrualActive() {
        if (!this._s3?.gameState?.isSeedMode?.()) return false;
        if (!this._isSeedBonusEnabled()) return false;
        const minPlayers = this.options.seedTokenBonusMinPlayers ?? 0;
        if (minPlayers === 0) return true;
        return this.server.players.length >= minPlayers;
    }

    /**
     * Initialize seedPresenceStart for all currently connected players.
     * Called when transitioning from non-seed → seed on a layer change (§4.2).
     * Only sets seedPresenceStart if the player doesn't already have one
     * (preserves cumulative tracking across reconnects).
     *
     * Player source: uses S³'s getAllPlayers() when available (authoritative,
     * includes null-teamID entries during staging), falls back to
     * this.server.players. The fallback path is a degraded-mode safety net
     * that may include stale entries or players with teamID === null during
     * the staging window — acceptable because the consequence is setting
     * seedPresenceStart on a temporarily-stale entry, which is harmless
     * (the entry will either resolve to a real player or be cleaned up on
     * disconnect).
     */
    _initSeedPresenceForAll = async function (force = false) {
        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        if (!PlayerCooldowns) return;

        // v2.4.0: Skip entirely when the seed bonus is disabled.
        if (!this._isSeedBonusEnabled()) return;

        const allPlayers = this._s3?.players?.isReady?.()
            ? this._s3.players.getAllPlayers()
            : this.server.players;

        if (!allPlayers || allPlayers.length === 0) return;

        // NOTE: This uses an N+1 query pattern (one findByPk per player) which is
        // acceptable because layer transitions are infrequent (once per round).
        // If it becomes a bottleneck, optimize with a bulk findAll + batch upsert.
        let count = 0;
        for (const p of allPlayers) {
            if (!p.eosID) continue;
            try {
                const row = await PlayerCooldowns.findByPk(p.eosID);
                if (!row) {
                    // New seed session — reset seedBonusTokensEarned counter
                    await PlayerCooldowns.create({
                        eosID: p.eosID,
                        steamID: p.steamID || null,
                        playerName: p.name,
                        tokenBalance: this.options.maxSwitchTokens,
                        seedPresenceStart: new Date(),
                        seedBonusTokensEarned: 0
                    });
                    count++;
                } else if (!row.seedPresenceStart) {
                    // Existing row, no active presence — reset counter for new seed session
                    await PlayerCooldowns.update(
                        { seedPresenceStart: new Date(), seedBonusTokensEarned: 0 },
                        { where: { eosID: p.eosID } }
                    );
                    count++;
                } else if (force) {
                    // v2.4.0: Force reset — accrual just (re)activated (server crossed
                    // above the min-player threshold, or entered seed mode with enough
                    // players). Discard any time accrued below the threshold (or while
                    // disabled) and restart the qualifying clock fresh.
                    //
                    // Reset seedBonusTokensEarned to 0 so the per-round cap starts fresh
                    // for this new seed session. The double-grant defense against granting
                    // the same player twice in one round is handled by the lastSeedBonusRoundID
                    // check in the WHERE clauses of _checkSeedBonusGrants and
                    // _grantSeedBonusOnTransition — NOT by preserving seedBonusTokensEarned.
                    await PlayerCooldowns.update(
                        { seedPresenceStart: new Date(), seedBonusTokensEarned: 0 },
                        { where: { eosID: p.eosID } }
                    );
                    count++;
                }
                // else: seedPresenceStart already set — cumulative tracking, preserve earned count
            } catch (err) {
                this.verbose(1, `[SeedPresence] Error initing seed presence for ${p.name || p.eosID}: ${err.message}`);
            }
        }
        this.verbose(1, `[SeedPresence] Initialized seed presence for ${count} players on seed layer transition.`);
    };

    /**
     * Grant a consolation seed bonus token on seed→non-seed transition.
     * Called when transitioning from seed → non-seed on a layer change (§4.1b).
     * This is the "short seed round" safety net — players who didn't earn any
     * bonus tokens via the periodic check still get +1 when the seed round ends.
     *
     * Consolation-only: only players with seedBonusTokensEarned == 0 qualify.
     * Players who already earned via _checkSeedBonusGrants are excluded — no
     * doubling up. Grants exactly 1 token (not seedTokenBonusAmount, which is
     * the per-round _cap_ on periodic grants, not a lump sum).
     *
     * Sets lastSeedBonusRoundID to the current matchId (preventing repeat grants
     * within the same seed session), nulls seedPresenceStart (round is over).
     *
     * Uses an atomic UPDATE with WHERE clause as the compare-and-swap defense
     * against the race with _checkSeedBonusGrants (§4.1a path). Both methods target
     * the same rows but use different WHERE filters (this method requires
     * seedBonusTokensEarned == 0; the periodic check requires thresholdMs+ of
     * accrued time). The atomic UPDATE ensures only one can win per row — no
     * double-grant even if both fire simultaneously. No shared re-entrancy guard
     * is needed — the transition grant runs independently.
     */
    _grantSeedBonusOnTransition = async function () {
        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        if (!PlayerCooldowns) return;

        const currentMatchId = this._s3?.gameState?.getMatchId?.() || null;
        const bonusAmount = this.options.seedTokenBonusAmount;
        const bonusMinutes = this.options.seedTokenBonusMinutes;
        if (bonusAmount <= 0 || bonusMinutes <= 0) return;

        try {
            // Atomic UPDATE: consolation grant — only players who earned ZERO bonus
            // tokens during the seed round (seedBonusTokensEarned == 0) get the
            // transition grant. Players who already earned via the periodic check
            // are excluded — no doubling up.
            //
            // seedPresenceStart is nulled (not reset to NOW like the periodic check)
            // because the seed round is ending — no more presence time to accrue.
            //
            // Uses Sequelize.literal for the additive tokenBalance increment since
            // the addition is safe (integer, no user input).
            //
            // NOTE: No shared re-entrancy guard with _onSeedPresenceCheck. The atomic
            // UPDATE WHERE clauses are the actual race defense — _checkSeedBonusGrants
            // targets rows with thresholdMs+ accrued time, while this method targets
            // rows with seedBonusTokensEarned == 0 (players not yet granted). They
            // operate on different subsets of rows. The _seedPresenceProcessing guard
            // was removed because it caused silent grant loss when a S3_PLAYERS_UPDATED
            // tick happened to be processing during a seed→non-seed layer transition
            // (see _onLayerChanged in switch-output.js).
            const [grantCount] = await PlayerCooldowns.update(
                {
                    tokenBalance: Sequelize.literal('tokenBalance + 1'),
                    seedBonusTokensEarned: Sequelize.literal('seedBonusTokensEarned + 1'),
                    seedPresenceStart: null,
                    lastSeedBonusRoundID: currentMatchId
                },
                {
                    where: {
                        seedPresenceStart: { [Op.ne]: null },
                        seedBonusTokensEarned: 0,
                        [Op.or]: [
                            { lastSeedBonusRoundID: null },
                            { lastSeedBonusRoundID: { [Op.ne]: currentMatchId || '' } }
                        ]
                    }
                }
            );

            if (grantCount > 0) {
                this.verbose(1, `[SeedPresence] Granted +1 seed bonus token to ${grantCount} players on seed→non-seed transition (consolation).`);
                // Notify players they earned a bonus token.
                // NOTE: The follow-up findAll runs outside the atomic UPDATE, so there's
                // a theoretical race where _checkSeedBonusGrants could modify rows
                // between the UPDATE and this read. The consequence is a missed notification
                // (not a missed grant), which is acceptable.
                try {
                  // NOTE: Filter by seedPresenceStart=null to only find rows this
                  // method (transition grant) actually modified. _checkSeedBonusGrants
                  // sets seedPresenceStart=now (non-null), so including the IS NULL
                  // condition prevents the notification from picking up rows that the
                  // periodic check touched — avoiding duplicate "you earned a token"
                  // spam when both methods happen to share the same matchId.
                  const grantedRows = await PlayerCooldowns.findAll({
                    where: {
                      lastSeedBonusRoundID: currentMatchId,
                      seedPresenceStart: null
                    },
                    attributes: ['eosID', 'playerName', 'tokenBalance']
                  });
                  for (const row of grantedRows) {
                    if (row.eosID) {
                      this.warn(row.eosID,
                        `[Switch] Seed bonus — you earned +1 switch token for helping seed (round ended). You now have ${row.tokenBalance} tokens.`
                      );
                    }
                  }
                } catch (notifyErr) {
                  this.verbose(1, `[SeedPresence] Error notifying players of seed bonus: ${notifyErr.message}`);
                }
            }
        } catch (err) {
            this.verbose(1, `[SeedPresence] Error granting seed bonus on transition: ${err.message}`);
        }
    };

    /**
     * Check for seed mode players who have accumulated enough presence time
     * to qualify for a seed bonus token (§4.1a). Called periodically via
     * _onSeedPresenceCheck from S3_PLAYERS_UPDATED while in seed mode.
     *
     * Grants exactly 1 token per qualifying chunk of presence time. Each grant
     * increments seedBonusTokensEarned; the WHERE `seedBonusTokensEarned < bonusCap`
     * condition prevents exceeding the per-round cap (seedTokenBonusAmount).
     * seedPresenceStart is reset to NOW (not nulled) so the player can earn
     * another +1 after another thresholdMs of presence — this is the multi-grant
     * mechanic. seedPresenceStart is only set to null on seed→non-seed transition
     * (see _grantSeedBonusOnTransition).
     *
     * Uses an atomic UPDATE with WHERE clause as the compare-and-swap defense
     * against the race with _grantSeedBonusOnTransition (§4.1b path). Both methods
     * target the same rows (seedPresenceStart != null) but the atomic WHERE ensures
     * only one can win per row — no double-grant even if both fire simultaneously
     * for the same matchId. No shared re-entrancy guard is needed — the transition
     * grant (_grantSeedBonusOnTransition) operates independently, and the atomic
     * WHERE clauses ensure they target different subsets of rows.
     *
     * The WHERE clause filters to rows where seedPresenceStart IS NOT NULL AND
     * threshold met AND seedBonusTokensEarned < bonusCap AND (lastSeedBonusRoundID
     * IS NULL OR != currentMatchId). This is a single atomic operation — no per-row
     * loop, no separate read-then-write race window.
     */
    _checkSeedBonusGrants = async function () {
        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        if (!PlayerCooldowns) return;

        const currentMatchId = this._s3?.gameState?.getMatchId?.() || null;
        const bonusMinutes = this.options.seedTokenBonusMinutes;
        const bonusCap = this.options.seedTokenBonusAmount;
        const thresholdMs = bonusMinutes * 60 * 1000;
        if (bonusCap <= 0 || bonusMinutes <= 0) return;

        const now = Date.now();

        try {
            // Atomic UPDATE: grants +1 token per qualifying chunk of seed presence time.
            // Each grant increments seedBonusTokensEarned by 1; the WHERE clause
            // ensures we never exceed the per-round cap (seedTokenBonusAmount).
            //
            // seedPresenceStart is reset to NOW (not nulled) so the player can earn
            // another +1 after another thresholdMs of presence — this is the multi-grant
            // mechanic. seedPresenceStart is only set to null on seed→non-seed transition
            // (see _grantSeedBonusOnTransition).
            //
            // Uses Sequelize.literal for the additive tokenBalance increment since
            // the addition is safe (integer, no user input).
            const [grantCount] = await PlayerCooldowns.update(
                {
                    tokenBalance: Sequelize.literal('tokenBalance + 1'),
                    seedBonusTokensEarned: Sequelize.literal('seedBonusTokensEarned + 1'),
                    seedPresenceStart: new Date(now),
                    lastSeedBonusRoundID: currentMatchId
                },
                {
                    where: {
                        seedPresenceStart: {
                            [Op.ne]: null,
                            [Op.lte]: new Date(now - thresholdMs)
                        },
                        seedBonusTokensEarned: { [Op.lt]: bonusCap },
                        [Op.or]: [
                            { lastSeedBonusRoundID: null },
                            { lastSeedBonusRoundID: { [Op.ne]: currentMatchId || '' } }
                        ]
                    }
                }
            );

            if (grantCount > 0) {
                this.verbose(1, `[SeedPresence] Granted +1 seed bonus token to ${grantCount} players via periodic check.`);
                // Notify players they earned a bonus token.
                // NOTE: The follow-up findAll runs outside the atomic UPDATE, so there's
                // a theoretical race where _grantSeedBonusOnTransition could modify rows
                // between the UPDATE and this read. The consequence is a missed notification
                // (not a missed grant), which is acceptable.
                try {
                  // NOTE: Filter by seedPresenceStart IS NOT NULL to only find rows
                  // this method (periodic check) actually modified. _grantSeedBonusOnTransition
                  // sets seedPresenceStart=null, so excluding null rows prevents the
                  // notification from picking up rows that the transition grant touched —
                  // avoiding duplicate "you earned a token" spam.
                  const grantedRows = await PlayerCooldowns.findAll({
                    where: {
                      lastSeedBonusRoundID: currentMatchId,
                      seedPresenceStart: { [Op.ne]: null }
                    },
                    attributes: ['eosID', 'playerName', 'tokenBalance', 'seedBonusTokensEarned']
                  });
                  for (const row of grantedRows) {
                    if (row.eosID) {
                      this.warn(row.eosID,
                        `[Switch] Seed bonus — you earned +1 switch token for helping seed. You now have ${row.tokenBalance} tokens (${row.seedBonusTokensEarned}/${bonusCap} bonus tokens earned this round).`
                      );
                    }
                  }
                } catch (notifyErr) {
                  this.verbose(1, `[SeedPresence] Error notifying players of seed bonus: ${notifyErr.message}`);
                }
            }
        } catch (err) {
            this.verbose(1, `[SeedPresence] Error in seed bonus check: ${err.message}`);
        }
    };

    /**
     * Periodic check wrapper for seed bonus grants.
     * Called from S3_PLAYERS_UPDATED listener (registered unconditionally in mount()).
     *
     * The listener is registered unconditionally (not gated on queue state like the
     * queue's periodic processing) because seed mode can start/stop independently of
     * queue activity. The isSeedMode() guard below makes it a cheap no-op outside
     * seed mode — the handler returns immediately without any DB access.
     *
     * Uses a re-entrancy guard (_seedPresenceProcessing) to prevent concurrent DB
     * scans within this method only. The transition grant (_grantSeedBonusOnTransition)
     * runs independently without this guard — the atomic UPDATE WHERE clauses
     * are the actual race defense against double-grants between the two paths.
     */
    _onSeedPresenceCheck = async () => {
        if (this._seedPresenceProcessing) return;

        const accrualActive = this._isSeedAccrualActive();
        const wasAccrualActive = this._seedAccrualActive;

        // False → true transition: accrual just (re)activated (server crossed
        // above the min-player threshold, or entered seed mode with enough
        // players). Reset all seedPresenceStart timestamps so time accrued
        // below the threshold (or while disabled) is discarded and the
        // qualifying clock restarts fresh.
        if (accrualActive && !wasAccrualActive) {
            this._seedAccrualActive = true;
            this._seedPresenceProcessing = true;
            try {
                await this._initSeedPresenceForAll(true);
            } catch (err) {
                this.verbose(1, `[SeedPresence] Accrual (re)activation reset failed: ${err.message}`);
            } finally {
                this._seedPresenceProcessing = false;
            }
            return;
        }

        this._seedAccrualActive = accrualActive;
        if (!accrualActive) return;

        this._seedPresenceProcessing = true;
        try {
            await this._checkSeedBonusGrants();
        } catch (err) {
            this.verbose(1, `[SeedPresence] Periodic check error: ${err.message}`);
        } finally {
            this._seedPresenceProcessing = false;
        }
    };

    /**
     * Initialize the explain auto-update feature.
     * Posts (or edits) the full explain embed sequence + 7-day stats embed to
     * the configured explain channel. The embed is generated once on SquadJS
     * startup — no periodic refresh.
     *
     * Called from _onS3Ready() when explainChannelID is configured.
     */
    _initExplainAutoUpdate = async function () {
        const explainChannelID = this.options.explainChannelID;
        if (!explainChannelID) return;

        const discordClient = this.options.discordClient;
        if (!discordClient) {
            this.verbose(1, '[Explain] No Discord client available — cannot auto-update explain channel.');
            return;
        }

        // Fetch the channel
        let channel;
        try {
            channel = await discordClient.channels.fetch(explainChannelID);
        } catch (err) {
            this.verbose(1, `[Explain] Could not fetch explain channel ${explainChannelID}: ${err.message}`);
            return;
        }
        if (!channel) return;

        // Build the full embed sequence: 7 explain embeds + optional stats embed
        const buildMessage = async () => {
            const explainEmbeds = this._buildExplainMessages();
            let statsEmbed = null;
            try {
                statsEmbed = await this._buildSevenDayStatsEmbed();
            } catch (err) {
                this.verbose(1, `[Explain] Stats embed generation failed (will be excluded): ${err.message}`);
            }
            const embeds = [...explainEmbeds];
            if (statsEmbed) embeds.push(statsEmbed);
            return embeds;
        };

        // Delete all previously tracked messages (best-effort).
        // Since we send one embed per message, we can't edit the old
        // messages in place. Deleting them keeps the channel clean.
        const storedData = this._cachedExplainMessageData;
        if (storedData && storedData.channelID === explainChannelID && storedData.messageIDs?.length > 0) {
            for (const msgID of storedData.messageIDs) {
                try {
                    await channel.messages.delete(msgID);
                    this.verbose(2, `[Explain] Deleted old explain message ${msgID}.`);
                } catch (_) {
                    // 404 or missing permissions — harmless, continue
                }
            }
        }

        try {
            const embeds = await buildMessage();

            // Send each embed as its own message (one per message) to stay
            // under Discord's 6000-character per-message embed sum limit.
            // This matches the !switch explain command pattern in switch-commands.js.
            const messageIDs = [];
            for (const embed of embeds) {
                const sent = await channel.send({ embeds: [embed] });
                messageIDs.push(sent.id);
                // Small delay between sends to avoid Discord rate limits
                await new Promise(r => setTimeout(r, 250));
            }

            // Track all messages for cleanup on next restart
            if (messageIDs.length > 0) {
                this._explainMessage = null;  // no longer a single message
                this._explainMessageID = messageIDs[0];
                this._explainChannelID = explainChannelID;
                await this._saveExplainMessageId(explainChannelID, messageIDs);
            }

            this.verbose(1, `[Explain] Auto-update initialized. Posted ${embeds.length} explain embed(s) in channel ${explainChannelID}.`);
        } catch (err) {
            this.verbose(1, `[Explain] Failed to post/edit explain message: ${err.message}`);
        }
    };

    /**
     * onScrambleExecuted — Handles TEAM_BALANCER_SCRAMBLE_EXECUTED event.
     *
     * Flow:
     *   1. Snapshot queued player eosIDs (they're exempt from lockdown)
     *   2. Clear the switch queue (team state is invalidated by the scramble)
     *   3. Seed round guard — clear queue but skip lockdown entirely
     *   4. Per-player exemption checks (in order):
     *      a. Missing eosID → skip (can't write lockdown without identifier)
     *      b. Within switch-eligibility window → skip (had no time to exploit imbalance)
     *      c. Was in switch queue before scramble → skip (already waiting, not exploiting)
     *   5. Write scrambleLockdownExpiry records to DB for remaining players
     *   6. Post Discord notification with lockdown summary
     */
    onScrambleExecuted = async (data) => {
        const { affectedPlayers, failedPlayers } = data;
        this.verbose(2, `[SCRAMBLE_EVENT] onScrambleExecuted called with data: ${JSON.stringify(data)}`);

        // Snapshot queued player eosIDs before clearing — these players
        // were already waiting to switch before the scramble and should
        // not receive a scramble lockdown on top of losing their queue spot.
        const queuedEosIDs = new Set([
            ...this._switchQueue.t1.map(e => e.eosID),
            ...this._switchQueue.t2.map(e => e.eosID)
        ]);
        this.verbose(2, `[SCRAMBLE_EVENT] Queued players before scramble: ${queuedEosIDs.size}`);
        
        // Queue is always cleared on scramble regardless of affectedPlayers —
        // team state is invalidated either way, so stored teamIDs are stale.
        this._clearAllQueueEntries('Scramble');

        // v2.0.0: During seed rounds, scramble clears the queue but does NOT
        // apply lockdown or flag _scrambleHappened — normal broadcasts play
        // when the next (non-seed) round starts.
        if (this._s3?.gameState?.isSeedMode?.()) {
            this.verbose(1, `[SCRAMBLE_EVENT] Seed round — queue cleared, no lockdown applied.`);
            return;
        }

        // Low-population guard: don't apply scramble locks when the server is
        // below the configured threshold. Applying locks on a seeding/low-pop
        // server may drive players away and cause the server to die further.
        const totalPlayers = this.server.players.length;
        const minPlayers = this.options.scrambleLockdownMinPlayers ?? 60;
        if (totalPlayers < minPlayers) {
            this.verbose(1, `[SCRAMBLE_EVENT] Server population (${totalPlayers}) below scrambleLockdownMinPlayers (${minPlayers}) — queue cleared, no lockdown applied.`);
            return;
        }

        // v2.0.0: Defer post-scramble broadcast to next NEW_GAME
        this._scrambleHappened = true;

        // ── Lockdown applies to ALL server players, not just those moved ──
        // The scramble invalidates team balance for everyone, so the entire
        // server (minus exemptions below) gets locked from switching.
        // We iterate over S³'s authoritative player list (with server.players
        // fallback) rather than data.affectedPlayers (which is only the subset
        // physically moved by the swap plan).
        const allPlayers = this._s3?.players?.isReady?.()
            ? this._s3.players.getAllPlayers()
            : this.server.players;

        if (!allPlayers || allPlayers.length === 0) {
            this.verbose(1, `[SCRAMBLE_EVENT] No players on server — queue cleared, no lockdown records written.`);
            return;
        }

        this.verbose(2, `[SCRAMBLE_EVENT] Scramble moved ${affectedPlayers?.length ?? 0} players; applying lockdown evaluation to all ${allPlayers.length} server players.`);

        // Players within their switch-eligibility window haven't had time to
        // exploit pre-scramble imbalance, so they're exempt from lockdown.
        const switchWindowMs = this.options.switchEnabledMinutes * 60 * 1000;
        // Build a Set of eosIDs whose RCON move genuinely failed (player was connected
        // but the AdminForceTeamChange command failed). These players are exempt from
        // lockdown and receive a +1 token grant via _resetPlayerLockouts.
        const failedEosIDs = new Set(
            (failedPlayers || []).map(p => p.eosID)
        );
        this.verbose(2, `[SCRAMBLE_EVENT] Failed-to-move players (RCON failure, not disconnected): ${failedEosIDs.size}`);

        const lockoutPlayers = [];
        for (const p of allPlayers) {
            if (!p.eosID) {
                this.verbose(1, `[SCRAMBLE_EVENT] Skipping ${p.name} — missing eosID`);
                continue;
            }
            // Failed-to-move players: skip lockdown, grant +1 token (when below cap)
            // so they can rejoin their group. Await the DB write so we only promise
            // a token that was actually granted.
            if (failedEosIDs.has(p.eosID)) {
                this.verbose(2, `[SCRAMBLE_EVENT] Skipping lockdown for ${p.name} — RCON move failed, remediating.`);
                let granted = false;
                try {
                    granted = await this._resetPlayerLockouts(p.eosID);
                } catch (err) {
                    this.verbose(1, `[SCRAMBLE_EVENT] _resetPlayerLockouts failed for ${p.name || p.eosID}: ${err.message}`);
                }
                this.warn(p.eosID, granted
                    ? `[Switch] Scramble failed to move you — granted +1 switch token to rejoin your group. Use !switch when ready.`
                    : `[Switch] Scramble failed to move you — use !switch to rejoin your group.`
                );
                continue;
            }
            // NOTE: getSecondsFromJoin may hit the DB per player. For large scrambles
            // this is N sequential awaits — acceptable because scrambles are infrequent
            // and player counts are bounded (~100).
            const joinSeconds = await this.getSecondsFromJoin(p.eosID);
            const matchSeconds = this.getSecondsFromMatchStart();
            // Convert joinSeconds/matchSeconds (s) to ms for comparison with switchWindowMs
            const withinWindow = (joinSeconds * 1000) < switchWindowMs || (matchSeconds * 1000) < switchWindowMs;
            if (withinWindow) {
                this.verbose(2, `[SCRAMBLE_EVENT] Skipping lockdown for ${p.name} — within switch window (join: ${joinSeconds.toFixed(1)}s, match: ${matchSeconds.toFixed(1)}s)`);
                continue;
            }
            if (queuedEosIDs.has(p.eosID)) {
                this.verbose(2, `[SCRAMBLE_EVENT] Skipping lockdown for ${p.name} — was in switch queue before scramble.`);
                continue;
            }
            lockoutPlayers.push(p);
        }

        const lockdownDuration = this.options.scrambleLockdownDurationMinutes * 60 * 1000;
        const expiry = new Date(Date.now() + lockdownDuration);
        this.verbose(2, `[SCRAMBLE_EVENT] Lockdown duration: ${this.options.scrambleLockdownDurationMinutes}min | Expiry: ${expiry.toISOString()}`);

        if (lockoutPlayers.length === 0) {
            this.verbose(1, `[SCRAMBLE_EVENT] All ${affectedPlayers?.length ?? 0} affected players were exempt from lockdown (switch window, queued, or missing eosID) — no lockdown records written.`);
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
                    // Write in chunks of 10 to avoid SQLite parameter limits and keep transactions short
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
                        // Discord relative timestamp (e.g. "in 20 minutes")
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