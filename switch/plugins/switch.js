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

// Post-switch lockout duration — see _checkSwitchEligibility()'s recent_switch
// gate. Not configurable: it exists purely to close a race between S³'s
// registry and the player's client, not a tunable gameplay knob.
const POST_SWITCH_LOCKOUT_MS = 10_000;

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                        SWITCH PLUGIN                          ║
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
 *     players for a configurable duration. Skipped entirely for TeamBalancer's
 *     'EloDiff' micro scramble.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Forked from the original SquadJS Switch plugin by fantinodavide.
 *   Original author credit retained.
 * - Scramble lockdown skips players still within their switch-enabled
 *   window (join or match start) and players who were actively queued
 *   for a switch, since they had no opportunity to exploit pre-scramble
 *   imbalance.
 * - Scramble lockdown is skipped entirely (no rows written, no
 *   _scrambleHappened broadcast armed) when TEAM_BALANCER_SCRAMBLE_EXECUTED
 *   carries scrambleType 'EloDiff' — TeamBalancer's small EloTracker-driven
 *   micro scramble. Disproportionate to lock the whole server down over a
 *   correction that moved a handful of players.
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
 *   !bug / !stuck / !doubleswitch  → Double-switch (swap to opposite team and back).
 *
 * Admin (in-game):
 *   !switch now <name>             → Force immediate team switch for a player.
 *   !switch double <name>          → Force double-switch for a player.
 *   !switch squad <n> <team>       → Switch an entire squad to the opposite team.
 *   !switch doublesquad <n> <team> → Double-switch an entire squad.
 *   !switch swap <name1> <name2>   → Swap two players between teams.
 *   !switch matchend <name>        → Queue a player for switch at end of round.
 *   !switch matchendsquad <n> <t>  → Queue a squad for switch at end of round.
 *   !switch triggermatchend        → Execute the end-of-match switch queue now.
 *   !switch refresh                → Force an RCON player-list refresh.
 *   !switch slots                  → Report current balance slot availability.
 *   !switch check <name/steamID>   → Look up a player's cooldown and lock status.
 *   !switch clear <name/steamID>   → Lift one player's restrictions: top their
 *                                    tokens up to at least full and drop any
 *                                    scramble lock. Never lowers a balance, so
 *                                    earned seed tokens are kept.
 *   !switch clearall               → The same, for every tracked player.
 *                                    Restrictions only — nothing is deleted.
 *   !switch wipe confirm           → Delete every cooldown row. The true reset;
 *                                    an absent row already reads as "full
 *                                    tokens, no locks, no seed progress".
 *                                    Without the word `confirm` it only warns.
 *   !switch status                 → Token/lock summary and who is actually blocked.
 *   !switch help                   → List all admin commands.
 * Admin (Discord):
 *   !switch status                 → Token/lock summary + RCON latency + who is blocked.
 *   !switch check <name/steamID>   → Real-time eligibility lookup with timestamps.
 *   !switch clear <name/steamID>   → Lift one player's restrictions (keeps seed tokens).
 *   !switch clearall               → Lift restrictions for everyone (keeps seed tokens).
 *   !switch wipe confirm           → Delete every cooldown row. `confirm` required.
 *   !switch timelimit on|off       → Toggle the join/match time limit for queue entry.
 *   !switch stats [days]           → Aggregate embed over the last N days of round summaries.
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
    static version = '2.5.6';

    static get description() {
        return "Switch plugin with persistent join timers";
    }

    static get defaultEnabled() {
        return true;
    }

    /** Delay in ms before showing ChangeTeam-disabled warning to joining players (90s). */
    static get JOIN_WARN_DELAY_MS() { return 90000; }

    /**
     * Grace period between warning queued players and switching them at round
     * end (15s). Instances may override via `this._matchendWarnDelayMs` — the
     * seam exists so tests can exercise doSwitchMatchend without sitting
     * through the wait.
     */
    static get MATCHEND_WARN_DELAY_MS() { return 15000; }

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
                description: "Enable interpolated extra imbalance tolerance when server is below full capacity (default: on). Scales from floor to 98 players.",
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
             },
             pruneInactivePlayerDays: {
                 required: false,
                 description: 'Days a player must be unseen before their cooldown row is pruned (tier 2 retention). Rows sitting at exactly maxSwitchTokens with no seed state are pruned after 30 minutes regardless, since they carry no information. Set to 0 to disable row pruning entirely.',
                 default: 3,
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

        this.recentSwitches = [];          // { eosID, datetime } — post-switch lockout, see _recordRecentSwitch()
        this.recentDoubleSwitches = [];
        this._reconnectLockoutClearTimeouts = new Map();

         // v2.3.0 Stage 2: Seed presence tracking
         this._seedPresenceProcessing = false;  // re-entrancy guard for seed bonus checks
         // v2.5.0: _wasSeedMode and _seedAccrualActive removed. The consolation grant
         // no longer keys off a seed-mode layer edge — it fires on the ENDGAME phase
         // transition (see _grantSeedBonusAtEndgame), so neither flag has a reader.
         this._unsubscribePhaseChange = null;   // S³ onGamePhaseChange unsubscribe (ENDGAME hook)

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
        // 1.4.0 — migration v5 declares touches.data, which only S³ 1.4.0 and
        // later validate or verify. An older engine ignores the key silently:
        // registration succeeds, the migration applies, and the operator is left
        // believing the backfill is checked when nothing checks it. That is the
        // exact failure this plugin was patched for, so it fails at mount instead.
        //
        // 1.2.2 — the token grants call _s3db.incrementLiteral() and checkPlayer()
        // calls _s3db.caseInsensitiveLikeOp(), both added in S³ 1.2.2. Against an
        // older S³ these are undefined, so the seed-bonus UPDATE would throw
        // mid-grant rather than failing at mount where it is diagnosable.
        const required = '1.4.0';
        const actual = this._s3?.version;
        if (!this._s3VersionAtLeast(required)) {
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

        // v2.5.0: Subscribe to S³ phase changes for the ENDGAME seed consolation grant.
        // ENDGAME is the correct moment for a connected-only check: everyone is still
        // on the scoreboard, unlike a layer change where the roster is mid-refresh.
        // Sub-state transitions (scoreboard -> layerVote -> ...) deliberately do NOT
        // re-fire this callback, so it lands exactly once per round.
        this._unsubscribePhaseChange = this._s3?.gameState?.onGamePhaseChange?.(({ phase }) => {
            if (phase !== 'ENDGAME') return;
            if (!this._s3?.gameState?.isSeedMode?.()) return;
            this._grantSeedBonusAtEndgame().catch(err => {
                this.verbose(1, `[SeedPresence] ENDGAME consolation grant failed: ${err.message}`);
            });
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

    /**
     * Consumes every queued end-of-match switch request.
     *
     * v2.5.6 — three fixes, all of them about the request being CONSUMED:
     *
     * 1. Rows are deleted whether or not the switch succeeded. Previously the
     *    destroy sat inside the try, so an RCON failure left the row in place
     *    and it fired again at the next round end, and the one after that,
     *    indefinitely. A queued switch is a request for THIS round end; if it
     *    could not be honoured, the player asks again. This also self-clears
     *    rows left behind by a SquadJS restart, which nothing else did.
     *
     * 2. One DELETE for the whole batch instead of one per player, and
     *    Promise.allSettled so a single failure no longer prevents the rest of
     *    the batch from being awaited.
     *
     * 3. `_taggedSwitchPlayer` takes an eosID. The old call passed
     *    `pl.eosID || pl.steamID`, so a row holding only a steamID was handed
     *    to a lookup that cannot match one and silently returned null. The
     *    steamID is now resolved through the roster first.
     */
    async doSwitchMatchend() {
        try {
            const Endmatches = this._getModel('SwitchPlugin_Endmatches');
            if (!Endmatches) return;
            const requests = await Endmatches.findAll();
            if (requests.length === 0) return;

            // Resolve each request to an eosID up front — the roster is still
            // populated at round end, and this is the last moment it is.
            const resolved = requests.map((pl) => {
                let eosID = pl.eosID || null;
                if (!eosID && pl.steamID && Array.isArray(this.server?.players)) {
                    eosID = this.getPlayerBySteamID(pl.steamID)?.eosID || null;
                }
                return { id: pl.id, name: pl.name, eosID, steamID: pl.steamID };
            });

            for (const r of resolved) {
                if (r.eosID) this.warn(r.eosID, '[Switch] Round ending — you will be switched in 15 seconds.');
            }

            const warnMs = Number.isFinite(this._matchendWarnDelayMs)
                ? this._matchendWarnDelayMs
                : Switch.MATCHEND_WARN_DELAY_MS;
            if (warnMs > 0) await delay(warnMs);

            const outcomes = await Promise.allSettled(resolved.map(async (r) => {
                if (!r.eosID) {
                    throw new Error(`no eosID could be resolved (steamID=${r.steamID || 'none'})`);
                }
                return this._taggedSwitchPlayer(r.eosID, 'Admin-Force');
            }));

            let failed = 0;
            outcomes.forEach((o, i) => {
                if (o.status === 'rejected') {
                    failed++;
                    const r = resolved[i];
                    this.verbose(1, `[Switch] Matchend switch failed for ${r.name || r.eosID || r.steamID}: ${o.reason?.message || o.reason}`);
                }
            });

            // Consume the batch unconditionally — see (1) above.
            const ids = resolved.map(r => r.id);
            const cleared = await Endmatches.destroy({ where: { id: { [Op.in]: ids } } });
            this.verbose(1, `[Switch] Matchend: processed ${resolved.length} requests (${failed} failed), cleared ${cleared} rows.`);
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

    /**
     * Records that `eosID` was just switched successfully, for the
     * post-switch lockout enforced by _checkSwitchEligibility(). One entry
     * per player, updated in place — mirrors the recentDoubleSwitches
     * pattern used by doubleSwitchPlayer().
     *
     * @param {string} eosID
     */
    _recordRecentSwitch(eosID) {
        const existing = this.recentSwitches.find(e => e.eosID === eosID);
        if (existing) existing.datetime = new Date();
        else this.recentSwitches.push({ eosID, datetime: new Date() });
    }

    async _checkSwitchEligibility(player) {
        const eosID = player?.eosID;
        if (!eosID) return { eligible: false, reason: 'missing_eos' };

        // Post-switch lockout — independent of liberal/seed mode and checked
        // before any DB lookup. Closes the gap between S³'s registry confirming
        // a team change (recordMove, fired before the RCON round-trip even
        // finishes — see _requestTeamChange in s3-plugin-base.js) and the
        // player's client visually rendering the move. Without this, a player
        // who assumes their first !switch didn't register (because of that
        // render lag) can fire a second one while the registry already shows
        // them on the new team — _requestTeamChange then computes the ORIGINAL
        // team as the new target and switches them straight back, burning two
        // tokens for a net no-op and leaving them stranded on their starting side.
        const recentSwitch = this.recentSwitches.find(e => e.eosID === eosID);
        if (recentSwitch) {
            const elapsedMs = Date.now() - recentSwitch.datetime.getTime();
            if (elapsedMs < POST_SWITCH_LOCKOUT_MS) {
                return { eligible: false, reason: 'recent_switch', remaining: Math.ceil((POST_SWITCH_LOCKOUT_MS - elapsedMs) / 1000) };
            }
        }

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

        // v2.5.6: top up to AT LEAST the cap, never down to it. `tokenBalance:
        // maxTokens` confiscated an earned seed token from anyone sitting above
        // the ordinary cap: this path fires on hadScrambleLock alone, so a
        // seeder at maxSwitchTokens + seedTokenBonusAmount who was caught by a
        // scramble and then reconnected onto the wrong team silently lost the
        // bonus they had just earned. Remediation must never cost the player
        // something. Same fix shape as adminClearPlayer() in switch-db.js.
        const toppedUp = Math.max(row.tokenBalance != null ? row.tokenBalance : maxTokens, maxTokens);

        await this._withDb(async (t) => {
            await PlayerCooldowns.update(
                {
                    lastSwitchTimestamp: null,
                    tokenBalance: toppedUp,
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
     * Uses _s3db.incrementLiteral('tokenBalance') for an atomic increment to avoid
     * TOCTOU races with concurrent grant paths. The helper quotes the identifier so
     * the statement survives Postgres identifier folding — a bare
     * Sequelize.literal('tokenBalance + 1') errors there with
     * `column "tokenbalance" does not exist`. Sets tokenRegenAnchor = null on the
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
                fields.tokenBalance = this._s3db.incrementLiteral('tokenBalance', 1);
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
            // Deduplicate by eosID: a player can only DC from the queue once per round.
            // Without this guard, delayed async cascades (e.g. onChatMessage finishing
            // after the player already left) can record a second queueDisconnects entry
            // for the same disconnect, inflating the count in the round summary.
            if (this._roundStats && queueEntry) {
                if (this._roundStats.queueDisconnects.some(d => d.eosID === eosID)) {
                    this.verbose(2, `[Queue] ${playerName} disconnect already recorded — skipping duplicate.`);
                } else {
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
        }
        this.verbose(2, `Player disconnected ${playerName}`);
        this.recentDoubleSwitches = this.recentDoubleSwitches.filter(p => p.eosID != eosID);
        this.recentSwitches = this.recentSwitches.filter(p => p.eosID != eosID);
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

    /**
     * Queues one player for an end-of-round switch, skipping duplicates.
     *
     * v2.5.6 — both enqueue paths used a bare create(), and the table has no
     * unique constraint on eosID (nor can one be added: the live MySQL user
     * has no DDL grants, so an ALTER would fail at runtime on the deployed
     * server). Queueing the same player twice — "!switch matchend" run again,
     * or a player caught by both a squad add and an individual add — used to
     * insert two rows, and two rows meant two switches at round end, which
     * put the player back where they started.
     *
     * Dedup is therefore a read-then-write. The window is harmless: enqueue is
     * only ever driven by an admin command.
     *
     * @returns {Promise<boolean>} true if a row was inserted, false if the
     *   player was already queued or the model is unavailable.
     */
    async _enqueueMatchendSwitch(player) {
        const Endmatches = this._getModel('SwitchPlugin_Endmatches');
        if (!Endmatches || !player) return false;

        // Match on whichever identifier we actually hold. eosID is the one
        // doSwitchMatchend switches on, so it is the one that matters.
        const match = [];
        if (player.eosID) match.push({ eosID: player.eosID });
        if (player.steamID) match.push({ steamID: player.steamID });
        if (match.length === 0) return false;

        const existing = await Endmatches.findOne({ where: { [Op.or]: match } });
        if (existing) {
            this.verbose(2, `[Switch] Matchend: ${player.name || player.eosID} is already queued — not queueing again.`);
            return false;
        }

        await Endmatches.create({
            name: player.name,
            steamID: player.steamID,
            eosID: player.eosID,
        });
        return true;
    }

    async addSquadToMatchendSwitches(number, team) {
        const players = this.getPlayersFromSquad(number, team);
        if (!players) return 0;
        let queued = 0;
        for (const p of players) {
            if (await this._enqueueMatchendSwitch(p)) queued++;
        }
        return queued;
    }

    async addPlayerToMatchendSwitches(player) {
        return this._enqueueMatchendSwitch(player);
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
            this._recordRecentSwitch(eosID);
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

        // v2.5.6: retire last round's seed state for EVERY row, not just the
        // connected ones. See _sweepStaleSeedState().
        await this._sweepStaleSeedState();
    }

    /**
     * v2.5.6: Retire per-round seed state belonging to any round other than the
     * current one. Runs at NEW_GAME, unscoped by connection.
     *
     * WHY THIS EXISTS. seedPresenceStart and seedBonusTokensEarned are per-ROUND
     * fields, but the only thing that ever cleared them was the ENDGAME sweep in
     * _grantSeedBonusAtEndgame, which is scoped `eosID IN connectedEosIDs`.
     * Anyone who disconnected mid-seed-round therefore kept both fields forever.
     * On the 2026-08-20 production export that was 85 of 378 rows, every one of
     * them last seen at least 10.6 hours earlier — so `!switch status` reported
     * "Seed Accruing: 75" on a server where nobody was accruing anything, and
     * cleanup()'s tier-1 prune (which requires no seed state) matched 0 rows out
     * of 378 instead of the 83 it should have caught.
     *
     * Scoping by ROUND rather than by CONNECTION fixes both, and is strictly
     * more robust: it needs no roster, so it cannot be defeated by the empty-
     * roster case that makes the ENDGAME sweep bail out entirely.
     *
     * ORDERING. This runs at NEW_GAME, once matchId has already advanced to the
     * new round, so `lastSeedBonusRoundID != currentMatchId` matches every row
     * left over from every previous round — including the players still
     * connected from the round that just ended, whom the ENDGAME sweep would
     * have handled only if the roster happened to be readable. It must NOT be
     * moved to ENDGAME: there matchId is still the current round's, so the same
     * condition would match nothing.
     *
     * THREE-VALUED LOGIC. `lastSeedBonusRoundID != 'x'` is UNKNOWN against NULL
     * on SQLite, MySQL and Postgres alike, so a legacy row with a NULL round id
     * would be skipped silently. The NULL arm is spelled out. This is the same
     * trap documented in _checkSeedBonusGrants step 2.
     *
     * The matchId guard mirrors _checkSeedBonusGrants: with no resolved matchId
     * the condition would match every row and wipe the seed state of a round
     * that is legitimately in progress. Skipping is safe — the reconciler's
     * step 2 still resets stale connected rows on its next tick, exactly as it
     * did before this sweep existed.
     */
    async _sweepStaleSeedState() {
        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        if (!PlayerCooldowns) return 0;

        const currentMatchId = this._s3?.gameState?.getMatchId?.() || null;
        if (!currentMatchId) {
            this.verbose(2, '[SeedPresence] NEW_GAME sweep skipped — matchId not resolved yet; the reconciler will catch up.');
            return 0;
        }

        try {
            let swept = 0;
            await this._withDb(async (t) => {
                const [count] = await PlayerCooldowns.update(
                    {
                        seedPresenceStart: null,
                        seedBonusTokensEarned: 0
                    },
                    {
                        where: {
                            [Op.or]: [
                                { lastSeedBonusRoundID: null },
                                { lastSeedBonusRoundID: { [Op.ne]: currentMatchId } }
                            ],
                            // Only touch rows that actually carry stale state, so the
                            // statement is a no-op on a steady-state table rather than
                            // rewriting every row on every map roll.
                            [Op.and]: [{
                                [Op.or]: [
                                    { seedPresenceStart: { [Op.ne]: null } },
                                    { seedBonusTokensEarned: { [Op.ne]: 0 } }
                                ]
                            }]
                        },
                        transaction: t
                    }
                );
                swept = count;
            });

            if (swept > 0) {
                this.verbose(1, `[SeedPresence] NEW_GAME sweep: retired stale seed state on ${swept} rows (round ${currentMatchId}).`);
            }
            return swept;
        } catch (err) {
            this.verbose(1, `[SeedPresence] NEW_GAME sweep failed: ${err.message}`);
            return 0;
        }
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

        // v2.5.0: Update lastActiveTimestamp on every reconnect (Fix 2).
        // Not gated on seed mode — must stay accurate for cleanup() across all rounds.
        // Fire-and-forget: failure is non-critical (cleanup() has a null-safe fallback).
        this._withDb(async (t) => {
            const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
            if (PlayerCooldowns) {
                await PlayerCooldowns.update(
                    { lastActiveTimestamp: new Date() },
                    { where: { eosID }, transaction: t }
                );
            }
        }).catch(err => {
            this.verbose(2, `[LastActive] Failed to update lastActiveTimestamp for ${name || eosID}: ${err.message}`);
        });

        // v2.3.0 Stage 2: If server is in seed mode, set seedPresenceStart for this player
        // so they can earn a seed bonus token. Preserves existing seedPresenceStart
        // (e.g. rejoin during same seed session — cumulative time). Does NOT reset
        // seedBonusTokensEarned — a reconnecting player keeps their pre-disconnect
        // accumulated count for the current seed session.
        //
        // v2.5.0: Defense-in-depth — also sets lastSeedBonusRoundID on create, and
        // resets stale rows whose lastSeedBonusRoundID doesn't match the current round.
        // The per-tick bulk reset in _checkSeedBonusGrants is the primary mechanism;
        // this is a cheap early catch at join time.
        //
        // NOTE: The findByPk + conditional create pattern has a theoretical TOCTOU race:
        // if two S3_PLAYER_JOINED events for the same eosID fire concurrently (e.g. during
        // rapid reconnect), the second create() would throw a Sequelize UniqueConstraintError.
        // This is caught by the outer try/catch and is harmless — the second event is a
        // no-op (the row already exists, and seedPresenceStart was already set by the first).
        // We accept this race rather than introducing a full findOrCreate/try-catch wrapper
        // because the window is extremely narrow and the consequence is a single spurious
        // verbose log line.
        //
        // v2.5.0: The matchId is part of the guard, not something checked inside.
        // Writing seedPresenceStart without a lastSeedBonusRoundID to pair it with
        // produces a row that the per-tick reset cannot match (SQL `!= 'x'` is
        // UNKNOWN against NULL) and the grant cannot match either (it requires
        // equality) — the player then silently accrues nothing for the whole round.
        // Skipping is safe: the reconciler bootstraps them on the first tick after
        // matchId resolves.
        try {
            const currentMatchId = this._s3?.gameState?.getMatchId?.() || null;
            if (this._s3?.gameState?.isSeedMode?.() && this._isSeedAccrualActive() && currentMatchId) {
                const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
                if (PlayerCooldowns) {
                    const row = await PlayerCooldowns.findByPk(eosID);
                    if (!row) {
                        await PlayerCooldowns.create({
                            eosID,
                            steamID: data.player?.steamID || null,
                            playerName: name,
                            tokenBalance: this.options.maxSwitchTokens,
                            seedPresenceStart: new Date(),
                            seedBonusTokensEarned: 0,
                            lastSeedBonusRoundID: currentMatchId,
                            firstSeenTimestamp: new Date(),
                            lastActiveTimestamp: new Date()
                        });
                        this.verbose(2, `[SeedPresence] ${name}: joined during seed mode — created row with seedPresenceStart.`);
                    } else if (row.lastSeedBonusRoundID !== currentMatchId) {
                        // NEW ROUND for this row — reset the whole per-round block.
                        // JS !== treats NULL as different, so this also heals legacy
                        // rows written before the matchId guard above existed.
                        //
                        // v2.5.6: this branch is now tested FIRST. It used to sit
                        // below the seedPresenceStart check, which meant a row with
                        // a stale round id but a null clock took the bootstrap path
                        // and kept the previous round's seedBonusTokensEarned.
                        await PlayerCooldowns.update(
                            {
                                seedPresenceStart: new Date(),
                                seedBonusTokensEarned: 0,
                                lastSeedBonusRoundID: currentMatchId
                            },
                            { where: { eosID } }
                        );
                        this.verbose(2, `[SeedPresence] ${name}: reconnected in new seed round — reset per-round state.`);
                    } else if (!row.seedPresenceStart) {
                        // SAME round, clock not running — the player disconnected
                        // earlier this round and has just come back.
                        //
                        // v2.5.6: restart the CLOCK ONLY. seedBonusTokensEarned is
                        // per-round, not per-connection: zeroing it here handed the
                        // player a fresh seedTokenBonusAmount allowance every time
                        // they reconnected, which became reachable the moment
                        // onS3PlayerLeft started nulling seedPresenceStart on leave.
                        // lastSeedBonusRoundID is already currentMatchId — that is
                        // the branch condition — so it does not need rewriting.
                        await PlayerCooldowns.update(
                            { seedPresenceStart: new Date() },
                            { where: { eosID } }
                        );
                        this.verbose(2, `[SeedPresence] ${name}: rejoined mid seed round — restarted presence clock (bonus counter kept at ${row.seedBonusTokensEarned}).`);
                    }
                    // else: clock already running for this round — leave it alone
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

        // v2.5.0: Stamp lastActiveTimestamp on leave so the field means "last seen",
        // not "last stamped event". Without this it is only written on join and on
        // token spends, so a player connected for days without spending carries a
        // stale value and becomes prunable the instant they disconnect — see
        // cleanup()'s tier-2 retention window in switch-db.js.
        // Fire-and-forget: failure is non-critical (cleanup treats NULL as keep).
        //
        // v2.5.6: the same statement also stops the seed presence clock.
        // seedPresenceStart used to survive a disconnect, and the grant only
        // ever compares it against NOW — so presence time accrued while the
        // player was OFFLINE. With seedTokenBonusMinutes at 20, two minutes of
        // seeding plus a 25-minute absence earned a full bonus token on the
        // first tick after reconnecting. Clearing it here means the clock
        // measures time actually spent on the server.
        //
        // The cost is that a player who drops at minute 19 restarts from zero.
        // That is what the ENDGAME consolation grant exists to cover — it pays
        // anyone connected at round end who never completed a chunk. If flaky
        // connections turn out to cost regulars more than the exploit was
        // worth, deleting `seedPresenceStart: null` from this update reverts
        // just this behaviour; the NEW_GAME sweep keeps the ghost rows fixed
        // either way.
        //
        // seedBonusTokensEarned is deliberately NOT reset here — it belongs to
        // the round, not the connection, and _sweepStaleSeedState() retires it
        // at the next NEW_GAME.
        // v2.5.6: AWAITED, where it used to be fire-and-forget. The write is
        // still non-critical on its own, but leaving it unawaited made the
        // handler resolve before the row had changed, and MySQL is slow enough
        // for that gap to be observable where SQLite was not. A player who
        // reconnects inside the gap is read by onS3PlayerJoined with their old
        // seedPresenceStart still in place, takes the "clock already running"
        // branch, and then has it nulled by this update landing afterwards —
        // leaving them with a stopped clock until the next reconciler tick
        // restarts it. Awaiting costs a few milliseconds on a disconnect and
        // removes the ordering question entirely. Errors are still swallowed.
        await this._withDb(async (t) => {
            const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
            if (PlayerCooldowns) {
                await PlayerCooldowns.update(
                    { lastActiveTimestamp: new Date(), seedPresenceStart: null },
                    { where: { eosID }, transaction: t }
                );
            }
        }).catch(err => {
            this.verbose(2, `[LastActive] Failed to stamp lastActiveTimestamp on leave for ${name || eosID}: ${err.message}`);
        });

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

        // v2.5.0: Unsubscribe from S³ phase change callback (ENDGAME consolation)
        if (this._unsubscribePhaseChange) {
            this._unsubscribePhaseChange();
            this._unsubscribePhaseChange = null;
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

    /**
     * @param {string} warnEosID — who to send the "not found" / "ambiguous"
     *   warning to. v2.5.6: this parameter was named `steamID` and every one of
     *   the five call sites duly passed a steamID, but warn() speaks eosID, so
     *   both failure messages went nowhere. An admin who fat-fingered a name
     *   got silence and assumed the command had worked.
     * @param {string} ident — a SteamID or a (partial) player name.
     * @returns {object|undefined} the matched player, or undefined if the
     *   lookup found zero or more than one. CALLERS MUST NULL-CHECK.
     */
    getPlayerByUsernameOrSteamID(warnEosID, ident) {
        let ret = null;

        ret = this.getPlayerBySteamID(ident);
        if (ret) return ret;

        ret = this.getPlayersByUsername(ident);
        if (ret.length == 0) {
            this.warn(warnEosID, `No player found matching: "${ident}"`);
            return;
        }
        if (ret.length > 1) {
            this.warn(warnEosID, `Multiple players match "${ident}". Use SteamID.`);
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
     * When false, no grants fire and the reconciler does not run. Note that
     * already-accrued presence time is NOT discarded while inactive — if the
     * server dips below seedTokenBonusMinPlayers and recovers, the time spanning
     * the dip still counts. (The v2.4.0 force-reset that discarded it was removed
     * in v2.5.0 along with the accrual-edge trigger.) This only matters when
     * seedTokenBonusMinPlayers > 0; at the default of 0 accrual is always active
     * in seed mode.
     *
     * The self-healing tick in _checkSeedBonusGrants handles bootstrap and
     * round-continuity on every S3_PLAYERS_UPDATED tick while accrual is active.
     */
    _isSeedAccrualActive() {
        if (!this._s3?.gameState?.isSeedMode?.()) return false;
        if (!this._isSeedBonusEnabled()) return false;
        // v2.5.0: No accrual during ENDGAME. The layer does not change until
        // NEW_GAME, so isSeedMode() stays true through the whole scoreboard/voting
        // window and S3_PLAYERS_UPDATED keeps firing. Without this gate the
        // reconciler would re-bootstrap seedPresenceStart for connected players
        // immediately after _grantSeedBonusAtEndgame nulled it, undoing the
        // round-close sweep and carrying presence into the next round — which in
        // turn blocks tier-1 row pruning. It would also let someone who connected
        // during the scoreboard start accruing for a round that is already over.
        if (this._s3?.gameState?.isEnding?.()) return false;
        const minPlayers = this.options.seedTokenBonusMinPlayers ?? 0;
        if (minPlayers === 0) return true;
        return this.server.players.length >= minPlayers;
    }

    /**
     * v2.5.0: Grant the consolation seed bonus token at ENDGAME.
     *
     * Fires once per seed round from the S³ onGamePhaseChange subscription
     * (phase === 'ENDGAME' && isSeedMode()). Replaces the old seed→non-seed
     * layer-edge trigger, which had two problems: it never fired on back-to-back
     * seed rounds, and it ran at the moment the S³ roster is least reliable.
     * At ENDGAME everyone is still on the scoreboard, so the connected-only
     * check is trustworthy.
     *
     * This is the "short seed round" safety net — a player who was present for
     * the round but never accrued a full seedTokenBonusMinutes chunk still gets
     * +1 when the round ends. Someone who left early gets nothing, unless they
     * already earned via the periodic check (which they keep).
     *
     * Qualifies when ALL hold:
     *   - currently connected
     *   - seedPresenceStart IS NOT NULL and predates the ENDGAME transition
     *     (blocks someone who connects during the scoreboard from collecting)
     *   - seedBonusTokensEarned == 0 (no doubling up with the periodic grant)
     *   - tokenBalance below the ceiling (maxSwitchTokens + seedTokenBonusAmount)
     *
     * NOTE: There is deliberately NO lastSeedBonusRoundID condition. At ENDGAME
     * the matchId is still the current round's, and the per-tick reconciler has
     * already stamped every connected row with it — so `lastSeedBonusRoundID !=
     * currentMatchId` would exclude everyone, every time. seedBonusTokensEarned
     * == 0 is the real "not yet granted this round" semantic, and the grant marks
     * itself by incrementing it.
     *
     * Re-firing is harmless: the first pass nulls seedPresenceStart, so a second
     * ENDGAME notification for the same round matches nothing.
     */
    _grantSeedBonusAtEndgame = async function () {
        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        if (!PlayerCooldowns) return;

        const bonusAmount = this.options.seedTokenBonusAmount;
        const bonusMinutes = this.options.seedTokenBonusMinutes;
        const maxTokens = this.options.maxSwitchTokens;
        if (bonusAmount <= 0 || bonusMinutes <= 0) return;

        const currentMatchId = this._s3?.gameState?.getMatchId?.() || null;
        const endgameStartedAt = new Date();

        // ── Connected-player roster (authoritative source) ──────
        const allPlayers = this._s3?.players?.isReady?.()
            ? this._s3.players.getAllPlayers()
            : this.server.players;
        const connectedEosIDs = (allPlayers || [])
            .map(p => p?.eosID)
            .filter(Boolean);

        if (connectedEosIDs.length === 0) {
            // Not silent: an empty roster at ENDGAME means every seeder loses their
            // consolation token, and this path has no retry. Worth a log line.
            this.verbose(1, '[SeedPresence] ENDGAME reached in seed mode but the player roster is empty — no consolation grants issued.');
            return;
        }

        try {
            // Atomic UPDATE as the compare-and-swap defense against a concurrent
            // S3_PLAYERS_UPDATED tick. The periodic grant targets rows with a full
            // threshold of accrued time; this targets rows with none earned. The
            // WHERE clauses are the race defense — no shared re-entrancy guard,
            // which previously caused silent grant loss when a tick happened to be
            // in flight as the round ended.
            //
            // seedPresenceStart is nulled rather than reset to NOW: the round is
            // over, there is no more presence to accrue.
            //
            // Uses _s3db.incrementLiteral for the additive increments — safe
            // (integer, no user input) and identifier-quoted so the camelCase
            // columns survive Postgres identifier folding.
            const whereClause = {
                eosID: { [Op.in]: connectedEosIDs },
                seedPresenceStart: {
                    [Op.ne]: null,
                    [Op.lt]: endgameStartedAt
                },
                seedBonusTokensEarned: 0,
                tokenBalance: { [Op.lt]: maxTokens + bonusAmount }
            };

            // Capture qualifying rows BEFORE the UPDATE so notifications go to
            // exactly the players this grant targets, rather than re-querying by
            // post-UPDATE field values (which can match unrelated rows).
            const qualifying = await PlayerCooldowns.findAll({
                where: whereClause,
                attributes: ['eosID', 'playerName', 'tokenBalance']
            });

            const [grantCount] = await PlayerCooldowns.update(
                {
                    tokenBalance: this._s3db.incrementLiteral('tokenBalance', 1),
                    seedBonusTokensEarned: this._s3db.incrementLiteral('seedBonusTokensEarned', 1),
                    seedPresenceStart: null,
                    lastSeedBonusRoundID: currentMatchId
                },
                { where: whereClause }
            );

            if (grantCount > 0) {
                this.verbose(1, `[SeedPresence] ENDGAME consolation: granted +1 seed bonus token to ${grantCount} players.`);
                // NOTE: The pre-grant findAll runs outside the atomic UPDATE, so a
                // concurrent periodic grant could modify rows between the SELECT and
                // the UPDATE. The consequence is a spurious warn (a duplicate message),
                // never a lost grant. Acceptable.
                try {
                  for (const row of qualifying) {
                    if (row.eosID) {
                      this.warn(row.eosID,
                        `[Switch] Seed bonus — you earned +1 switch token for helping seed (round ended). You now have ${row.tokenBalance + 1} tokens.`
                      );
                    }
                  }
                } catch (notifyErr) {
                  this.verbose(1, `[SeedPresence] Error notifying players of seed bonus: ${notifyErr.message}`);
                }
            } else if (qualifying.length > 0) {
                // Shouldn't happen — the SELECT and UPDATE share a WHERE clause. If it
                // does, something modified the rows in between and it's worth knowing.
                this.verbose(1, `[SeedPresence] ENDGAME consolation: ${qualifying.length} rows qualified but the UPDATE matched none.`);
            }

            // Close the round for every connected player, not only grant recipients.
            // The round is over — nobody should carry presence into the gap. Without
            // this, anyone who earned via the periodic grant keeps seedPresenceStart
            // set forever, which makes their row permanently unprunable and inflates
            // the tracked-player count.
            const [closedCount] = await PlayerCooldowns.update(
                { seedPresenceStart: null },
                {
                    where: {
                        eosID: { [Op.in]: connectedEosIDs },
                        seedPresenceStart: { [Op.ne]: null }
                    }
                }
            );
            if (closedCount > 0) {
                this.verbose(2, `[SeedPresence] ENDGAME: cleared seedPresenceStart for ${closedCount} connected players.`);
            }
        } catch (err) {
            this.verbose(1, `[SeedPresence] Error granting ENDGAME seed bonus: ${err.message}`);
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
     * (see _grantSeedBonusAtEndgame).
     *
     * v2.5.0 SHAPE: this is a three-step reconciler, not a single atomic UPDATE.
     * Step 1 bulk-creates rows for connected players that have none, step 2
     * bulk-resets rows belonging to a previous round, step 3 grants. Steps 1 and 2
     * each have a read-then-write window; both are idempotent and self-heal on the
     * next tick, so a lost race costs at most one tick of accrual.
     *
     * The step-3 UPDATE is still the compare-and-swap defense against the ENDGAME
     * consolation grant (_grantSeedBonusAtEndgame). Both target rows with
     * seedPresenceStart != null, but the atomic WHERE ensures only one can win per
     * row — no double-grant if both fire at once. No shared re-entrancy guard: one
     * was tried and removed because it silently dropped grants when a tick was in
     * flight as the round ended.
     */
    _checkSeedBonusGrants = async function () {
        const PlayerCooldowns = this._getModel('SwitchPlugin_PlayerCooldowns');
        if (!PlayerCooldowns) return;

        const currentMatchId = this._s3?.gameState?.getMatchId?.() || null;
        // Guard: don't run when matchId hasn't resolved yet — otherwise
        // lastSeedBonusRoundID != null would match every row on every tick.
        if (!currentMatchId) return;

        const bonusMinutes = this.options.seedTokenBonusMinutes;
        const bonusCap = this.options.seedTokenBonusAmount;
        const maxTokens = this.options.maxSwitchTokens;
        const thresholdMs = bonusMinutes * 60 * 1000;
        if (bonusCap <= 0 || bonusMinutes <= 0) return;

        const now = Date.now();

        // ── Connected-player roster (authoritative source) ──────
        const allPlayers = this._s3?.players?.isReady?.()
            ? this._s3.players.getAllPlayers()
            : this.server.players;
        const connectedEosIDs = (allPlayers || [])
            .map(p => p?.eosID)
            .filter(Boolean);

        if (connectedEosIDs.length === 0) return;

        try {
            // ═══════════════════════════════════════════════════════════
            // Step 1: Bulk-create rows for connected players with no row.
            // Replaces _initSeedPresenceForAll's per-player create loop.
            // ═══════════════════════════════════════════════════════════
            const existingRows = await PlayerCooldowns.findAll({
                where: { eosID: { [Op.in]: connectedEosIDs } },
                attributes: ['eosID'],
                raw: true
            });
            const existingEosIDs = new Set(existingRows.map(r => r.eosID));
            const missingEosIDs = connectedEosIDs.filter(id => !existingEosIDs.has(id));

            if (missingEosIDs.length > 0) {
                const nowDate = new Date(now);
                const toCreate = missingEosIDs.map(eosID => {
                    const player = (allPlayers || []).find(p => p.eosID === eosID);
                    return {
                        eosID,
                        steamID: player?.steamID || null,
                        playerName: player?.name || null,
                        tokenBalance: maxTokens,
                        seedPresenceStart: nowDate,
                        seedBonusTokensEarned: 0,
                        lastSeedBonusRoundID: currentMatchId,
                        firstSeenTimestamp: nowDate,
                        lastActiveTimestamp: nowDate
                    };
                });
                // ignoreDuplicates: the findAll above and this insert are not atomic.
                // A concurrent join handler or token-spend upsert can create the same
                // eosID in between; without this the resulting UniqueConstraintError
                // would unwind to the outer catch and skip steps 2 and 3 entirely,
                // costing every player a tick of accrual over one duplicate row.
                await PlayerCooldowns.bulkCreate(toCreate, { ignoreDuplicates: true });
                this.verbose(2, `[SeedPresence] Created rows for ${missingEosIDs.length} connected players with no existing row.`);
            }

            // ═══════════════════════════════════════════════════════════
            // Step 2: Idempotent bulk reset — bring stale rows current
            // and bootstrap null-seedPresenceStart rows for the current round.
            // Scoped to connected players only.
            // ═══════════════════════════════════════════════════════════
            // NULL is spelled out deliberately. `lastSeedBonusRoundID != 'abc'`
            // evaluates to UNKNOWN against a NULL column under ANSI three-valued
            // logic — true in SQLite, MySQL and Postgres alike — so a row with
            // presence set and a NULL round id would be skipped here AND skipped by
            // step 3 (which requires equality), stranding the player for the whole
            // round. Never let a WHERE clause depend on three-valued logic.
            //
            // Rows already at the ceiling are excluded: they cannot earn anything
            // this round, so re-stamping them every tick is pure write amplification.
            // They are picked up again by this same clause once they spend down.
            // v2.5.6: split into TWO statements, for the same reason the join
            // handler's branches were split. The single UPDATE below used to
            // write seedBonusTokensEarned: 0 for both arms, which meant the
            // bootstrap arm — "this row's clock isn't running" — silently handed
            // back the player's whole per-round bonus allowance. That is a
            // per-ROUND counter; only a change of round may reset it.
            //
            // Arm A: the row belongs to a previous round. Reset everything.
            // Mostly redundant now that _sweepStaleSeedState() runs at NEW_GAME,
            // but kept as the self-healing path for rows the sweep could not see
            // (matchId unresolved at NEW_GAME, or a row created afterwards by a
            // token spend).
            const staleRoundWhere = {
                eosID: { [Op.in]: connectedEosIDs },
                tokenBalance: { [Op.lt]: maxTokens + bonusCap },
                [Op.or]: [
                    { lastSeedBonusRoundID: null },
                    { lastSeedBonusRoundID: { [Op.ne]: currentMatchId } }
                ]
            };

            const [staleCount] = await PlayerCooldowns.update(
                {
                    seedPresenceStart: new Date(now),
                    seedBonusTokensEarned: 0,
                    lastSeedBonusRoundID: currentMatchId
                },
                { where: staleRoundWhere }
            );

            // Arm B: the row is already stamped with the current round but its
            // clock is not running — the player joined before seed mode began,
            // accrual just activated, or they reconnected after onS3PlayerLeft
            // stopped their clock. Start the clock and touch nothing else.
            const [bootstrapCount] = await PlayerCooldowns.update(
                { seedPresenceStart: new Date(now) },
                {
                    where: {
                        eosID: { [Op.in]: connectedEosIDs },
                        tokenBalance: { [Op.lt]: maxTokens + bonusCap },
                        lastSeedBonusRoundID: currentMatchId,
                        seedPresenceStart: null
                    }
                }
            );

            const resetCount = staleCount + bootstrapCount;
            if (resetCount > 0) {
                this.verbose(2, `[SeedPresence] Round ${currentMatchId}: reset ${staleCount} stale rows, started ${bootstrapCount} presence clocks.`);
            }

            // ═══════════════════════════════════════════════════════════
            // Step 3: Grant bonus tokens to qualifying players.
            // Scoped to connected players, with a tokenBalance ceiling.
            // ═══════════════════════════════════════════════════════════
            const grantWhere = {
                eosID: { [Op.in]: connectedEosIDs },
                seedPresenceStart: {
                    [Op.ne]: null,
                    [Op.lte]: new Date(now - thresholdMs)
                },
                seedBonusTokensEarned: { [Op.lt]: bonusCap },
                // Token ceiling — seed grants intentionally push tokenBalance above
                // maxSwitchTokens, but never past maxSwitchTokens + seedTokenBonusAmount.
                // This is the absolute wallet cap: it, not the per-round counter, is
                // what bounds a player across consecutive seed rounds.
                tokenBalance: { [Op.lt]: maxTokens + bonusCap },
                // Equality is safe because step 2 scopes every connected row that is
                // below the ceiling to currentMatchId. Rows step 2 deliberately skipped
                // (at the ceiling) fail this too — correct, they have nothing to earn.
                lastSeedBonusRoundID: currentMatchId
            };

            // Capture the players who will actually be granted THIS tick, so the
            // notification only fires for just-granted players — not every player
            // who earned a token earlier this round.
            const qualifying = await PlayerCooldowns.findAll({
                where: grantWhere,
                attributes: ['eosID', 'playerName', 'tokenBalance', 'seedBonusTokensEarned']
            });

            // Atomic UPDATE: grants +1 token per qualifying chunk of seed presence time.
            // Each grant increments seedBonusTokensEarned by 1; the WHERE clause
            // ensures we never exceed the per-round cap (seedTokenBonusAmount) or the
            // absolute token ceiling (maxSwitchTokens + bonusCap).
            //
            // seedPresenceStart is reset to NOW (not nulled) so the player can earn
            // another +1 after another thresholdMs of presence — this is the multi-grant
            // mechanic. seedPresenceStart is only set to null on seed→non-seed transition
            // (see _grantSeedBonusAtEndgame).
            //
            // Uses _s3db.incrementLiteral for the additive tokenBalance increment
            // since the addition is safe (integer, no user input); the helper quotes
            // the camelCase identifiers so the statement is Postgres-safe.
            const [grantCount] = await PlayerCooldowns.update(
                {
                    tokenBalance: this._s3db.incrementLiteral('tokenBalance', 1),
                    seedBonusTokensEarned: this._s3db.incrementLiteral('seedBonusTokensEarned', 1),
                    seedPresenceStart: new Date(now),
                    lastSeedBonusRoundID: currentMatchId
                },
                { where: grantWhere }
            );

            if (grantCount > 0) {
                this.verbose(1, `[SeedPresence] Granted +1 seed bonus token to ${grantCount} players via periodic check.`);
                // Notify only the players captured before the UPDATE — these are the
                // exact players who just earned a token. Using the pre-grant snapshot
                // avoids re-warning players who were granted on a previous tick.
                //
                // NOTE: The pre-grant findAll runs outside the atomic UPDATE, so there's
                // a theoretical race where _grantSeedBonusAtEndgame could modify rows
                // between the SELECT and the UPDATE. The consequence is a spurious warn
                // (a player who was transition-granted between the two queries gets warned
                // even though the periodic UPDATE didn't match them) — a duplicate message,
                // not a lost grant. This is acceptable.
                try {
                  for (const row of qualifying) {
                    if (row.eosID) {
                      this.warn(row.eosID,
                        `[Switch] Seed bonus — you earned +1 switch token for helping seed. You now have ${row.tokenBalance + 1} tokens (${row.seedBonusTokensEarned + 1}/${bonusCap} bonus tokens earned this round).`
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
     * scans within this method only. The ENDGAME consolation grant
     * (_grantSeedBonusAtEndgame) runs independently without this guard — the atomic
     * UPDATE WHERE clauses are the actual race defense between the two paths.
     */
    _onSeedPresenceCheck = async () => {
        if (this._seedPresenceProcessing) return;

        if (!this._isSeedAccrualActive()) return;

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
        const { affectedPlayers, failedPlayers, scrambleType } = data;
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

        // Elo-diff micro scramble: no lockdown write. The lockout guard exists to stop players
        // exploiting a just-corrected imbalance after a full reactive scramble — disproportionate
        // here, where the entire premise is "no blowout happened, just a small post-round gap."
        // Queue clear (above) and failed-move remediation (in the loop above) still run
        // unconditionally. _scrambleHappened is also deliberately NOT set here (it's set below,
        // past this return) — that flag drives next round's "returning players cannot switch"
        // broadcast timer via _startPostScrambleBroadcastTimers(), which would be actively false
        // for a scramble that writes no lockdown rows.
        if (scrambleType === 'EloDiff') {
            this.verbose(1, `[SCRAMBLE_EVENT] Elo-diff micro scramble — queue cleared, no lockdown applied (${lockoutPlayers.length} would-be lockout players skipped).`);
            return;
        }

        // v2.0.0: Defer post-scramble broadcast to next NEW_GAME
        this._scrambleHappened = true;

        const lockdownDuration = this.options.scrambleLockdownDurationMinutes * 60 * 1000;
        const expiry = new Date(Date.now() + lockdownDuration);
        this.verbose(2, `[SCRAMBLE_EVENT] Lockdown duration: ${this.options.scrambleLockdownDurationMinutes}min | Expiry: ${expiry.toISOString()}`);

        if (lockoutPlayers.length === 0) {
            this.verbose(1, `[SCRAMBLE_EVENT] All ${affectedPlayers?.length ?? 0} affected players were exempt from lockdown (switch window, queued, or missing eosID) — no lockdown records written.`);
            return;
        }

        // lastActiveTimestamp is stamped here because a player being locked out
        // was, by definition, on the server when the scramble fired.
        //
        // This bulkCreate is a row-creating path: a player who joined outside
        // seed mode and never spent a token has no cooldown row, so the scramble
        // is what creates it. Omitting the column made that row immortal —
        // cleanup() requires lastActiveTimestamp != null before it prunes
        // anything — and, since Switch v5 declares a notNull post-condition on
        // the column that drift detection re-checks on every mount, it would
        // also have re-gated the plugin after any scramble. See the
        // lastActiveTimestamp comment in switch-db.js for the full write-path
        // list this belongs to.
        //
        // Only the create side needs it: updateOnDuplicate below deliberately
        // omits the column, leaving an existing row's value to the join/leave
        // handlers that track it accurately.
        const nowDate = new Date();
        const records = lockoutPlayers
            .map(p => {
                return { eosID: p.eosID, steamID: p.steamID ?? null, playerName: p.name, scrambleLockdownExpiry: expiry, lastActiveTimestamp: nowDate };
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