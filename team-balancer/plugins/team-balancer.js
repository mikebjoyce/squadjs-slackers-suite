/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                     TEAM BALANCER PLUGIN                      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Main SquadJS plugin entry point for TeamBalancer. Tracks dominant
 * and consecutive win streaks, triggers squad-preserving scrambles,
 * and coordinates all sub-modules across the round lifecycle. Extends
 * S3PluginBase for S³ service discovery, DB convenience, and readiness
 * gating. Schema versioning via MigrationEngine with TB_RoundReport
 * and TeamBalancerState tables.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * TeamBalancer (default)
 *   Extends S3PluginBase. Key public methods:
 *     mount()                          — Initialises DB, listeners, and Discord channels. (via _onS3Ready)
 *     unmount()                        — Removes all listeners and clears state. (via _onUnmount)
 *     executeScramble(isSimulated)     — Runs the scramble algorithm and applies moves.
 *     cancelPendingScramble(...)       — Cancels a pending scramble countdown.
 *     resetStreak(reason)              — Resets win streak state and persists to DB.
 *     transformSquadJSData(squads, players) — Normalises SquadJS data for the Scrambler.
 *     buildRoundStartData()            — Snapshot of current teams (unused by TB directly).
 *     formatMessage(template, values)    — Replaces {key} placeholders in templates.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * S3PluginBase (./s3-plugin-base.js)
 *   S³ plugin base class providing S³ discovery, readiness gating, DB convenience methods,
 *   and flat service accessors. Extends SquadJS BasePlugin under the hood.
 * Logger (../../core/logger.js)
 *   Verbose logging throughout all event handlers.
 * S³ DBService (via _buildS3DbWrapper() compatibility layer)
 *   Sequelize persistence for win streak state and last scramble timestamp, accessed
 *   through S³'s version-tracked migration engine and withTransactionWithRetry().
 * Scrambler (../utils/tb-scrambler.js)
 *   Squad-preserving scramble algorithm. Returns a swap plan.
 * SwapExecutor (../utils/tb-swap-executor.js)
 *   Executes swap plans via RCON with retry logic and timeout protection.
 * CommandHandlers (../utils/tb-commands.js)
 *   In-game and Discord command registration (!teambalancer, !scramble).
 * DiscordHelpers (../utils/tb-discord-helpers.js)
 *   Embed builders and Discord send helper.
 * TBDiagnostics (../utils/tb-diagnostics.js)
 *   Self-diagnostics: DB integrity check and live scramble simulation.
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
 * GitHub: https://github.com/mikebjoyce/squadjs-slackers-suite/tree/master/s3
 *
 * Consumed Services:
 *   - gameState: isIgnoredMode(), getGamemode(), getLayerName(),
 *               getRoundStartTime() — match/mode/round identification.
 *   - factions:  isEnabled(), getTeamName(teamID) — faction name lookup.
 *   - players:   getAllPlayers(), getSquads(), lockGlobal(),
 *               unlockGlobal() — player data
 *               and concurrency control during scrambles.
 *   - clans:     isEnabled(), extractClanGroups(),
 *               options.pullEntireSquads — clan tag grouping for scrambles.
 *
 * Emitted Events:
 *   - TEAM_BALANCER_SCRAMBLE_EXECUTED — Fired after all RCON moves complete and are verified,
 *     not before. Payload: { affectedPlayers: Array<{ eosID, steamID, name }>,
 *     failedPlayers: Array<{ eosID, steamID, name }>, scrambleType }. scrambleType is 'EloDiff'
 *     for a micro scramble, null for a normal one — Switch skips its lockdown for 'EloDiff'.
 *     The Switch plugin listens for this to lock team-switching post-scramble.
 *
 * Listened Events:
 *   - None.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Two independent streak trackers run simultaneously:
 *     winStreakTeam/winStreakCount  — dominant wins (ticket threshold met).
 *     consecutiveWinsTeam/Count    — any consecutive wins regardless of margin.
 *   Either can trigger a scramble. Resets are independent.
 * - Ignored game modes for win-streak tracking are delegated to S³'s
 *   GameStateService (configured via S³'s ignoredGameModes option).
 * - enableSeedAutoScramble: scrambles automatically when any Seed round
 *   ends, regardless of ignored game mode settings. Jensen/Training
 *   rounds are excluded (isSeedMode() returns false). Independent of
 *   streak logic.
 * - useEloForBalance: pulls mu ratings from a running EloTracker instance
 *   at scramble time. Gracefully falls back to pure numerical balance if
 *   EloTracker is absent or the cache is empty.
 * - enableEloDiffScramble: an independent, opt-in "micro scramble" trigger — moves a small,
 *   escalating-budget number of players (capped by microScrambleMaxMovePercent) when the
 *   post-round average mu gap (measured from the round that just ended) meets
 *   eloDiffScrambleThreshold, stopping once
 *   microScrambleParityTarget is reached. Requires EloTracker. Lowest-precedence of all
 *   triggers: it only arms if the other three haven't already claimed the scramble slot for
 *   this round. Can also be triggered manually via "!scramble elo" regardless of this option.
 * - TEAM_BALANCER_SCRAMBLE_EXECUTED event is emitted after all RCON moves complete and are
 *   verified, not before. The Switch plugin listens for this to lock team-switching
 *   post-scramble — except for an 'EloDiff' scrambleType, which Switch does not lock.
 * - requireScrambleConfirmation: manual scrambles require !scramble confirm
 *   within scrambleConfirmationTimeout seconds. "!scramble matchend" is the one exception —
 *   it arms immediately without confirmation, since it can be undone anytime with
 *   "!scramble cancel" before it fires. Auto-scrambles also bypass confirmation entirely.
 *
 * ─── COMMANDS ────────────────────────────────────────────────────
 *
 * Public (all players):
 *   !teambalancer                  → View current win streak and status.
 *
 * Admin:
 *   !teambalancer status           → Win streak and plugin status.
 *   !teambalancer diag             → Run self-diagnostics (DB check + live scramble sim).
 *   !teambalancer on               → Enable win streak tracking.
 *   !teambalancer off              → Disable win streak tracking.
 *   !teambalancer export           → Export the round reports JSONL file.
 *   !teambalancer clear            → Clear the round reports log file.
 *   !teambalancer help             → List available commands.
 *
 *   !scramble                      → Manually trigger scramble with countdown.
 *   !scramble now                  → Immediate scramble (no countdown).
 *   !scramble dry                  → Dry-run scramble (simulation only).
 *   !scramble matchend             → Arm a scramble to fire when the current round ends
 *                                    (bypasses confirmation; use "!scramble cancel" to undo).
 *   !scramble confirm              → Confirm a pending scramble request.
 *   !scramble cancel               → Cancel a pending scramble countdown, or an armed
 *                                    matchend scramble.
 *   !scramble elo                  → Composable with the above ("!scramble elo now",
 *                                    "!scramble elo matchend", etc.) — runs the small
 *                                    EloTracker-driven micro scramble instead of a full one.
 *
 * ─── CONFIGURATION ───────────────────────────────────────────────
 *
 * Core:
 *   database                           - Sequelize/SQLite connector.
 *   enableWinStreakTracking             - Enable automatic win streak tracking.
 *   enableSeedAutoScramble             - Auto-scramble at end of Seed.
 *
 * Win Streak:
 *   maxWinStreak                       - Dominant wins to trigger scramble (default: 2).
 *   maxConsecutiveWinsWithoutThreshold - Any consecutive wins to trigger scramble; 0 = disabled (default: 3).
 *   minTicketsToCountAsDominantWin     - Ticket threshold for Standard modes (default: 150).
 *   invasionAttackTeamThreshold        - Ticket threshold for Invasion attackers (default: 300).
 *   invasionDefenceTeamThreshold       - Ticket threshold for Invasion defenders (default: 500).
 *   enableSingleRoundScramble          - Scramble on a single massive margin round (default: true).
 *   singleRoundScrambleThreshold       - Ticket margin for single-round trigger (default: 200).
 *
 * Scramble Execution:
 *   scrambleAnnouncementDelay          - Seconds before scramble executes (default: 25).
 *   seedScrambleAnnouncementDelay      - Countdown for the seed auto-scramble only (default: 5, min 3).
 *                                        Separate from scrambleAnnouncementDelay: the window
 *                                        before the map change is much shorter after a Seed round.
 *   scramblePercentage                 - Fraction of players to move (default: 0.5).
 *   changeTeamRetryInterval            - RCON retry interval in ms (default: 100).
 *   maxScrambleCompletionTime          - Max execution time in ms (default: 15000).
 *   warnOnSwap                         - RCON warn players when swapped.
 *   requireScrambleConfirmation        - Require !scramble confirm for manual scrambles.
 *   scrambleConfirmationTimeout        - Seconds to wait for confirm (default: 60).
 *
 * Clan Tag Grouping (managed by S³):
 *   (All clan tag options are configured on S³'s clans service, not on TeamBalancer.)
 *
 * Messaging:
 *   showWinStreakMessages              - Broadcast win streak updates.
 *   useGenericTeamNamesInBroadcasts    - Use "Team 1/2" instead of faction names.
 *
 * Discord:
 *   discordClient                      - Discord connector name.
 *   discordAdminChannelID              - Channel for admin commands.
 *   discordReportChannelID             - Channel for automated reports (win streaks, scramble plans, errors). Defaults to admin channel if unset.
 *   discordAdminRoleIDs                - Array of Role IDs required for Discord admin commands (empty = all in channel).
 *   mirrorRconBroadcasts               - Mirror RCON broadcasts to Discord.
 *   postScrambleDetails                - Post detailed swap plan to Discord after scramble.
 *
 * Advanced:
 *   useEloForBalance                   - Weight scrambles by EloTracker mu ratings (default: true).
 *   enableEloDiffScramble              - Opt-in Elo-diff micro scramble trigger, independent of
 *                                        the three win-streak triggers (default: false).
 *   eloDiffScrambleThreshold           - Average mu gap that arms the micro scramble (default: 1.2).
 *   microScrambleParityTarget          - Post-swap mu gap the micro scramble's search stops
 *                                        at once reached (default: 0.05).
 *   microScrambleMaxMovePercent        - Safety ceiling: max fraction of the round's population
 *                                        the micro scramble may move (default: 0.10).
 *
 * Dev:
 *   devMode                            - Allow commands from any player regardless of admin status.
 *   reportLogPath                      - Path to the JSONL log file for round reports.
 *   enableDatabaseLogging              - If true, round reports are also written to the database in addition to the JSONL log (default: false).
 *   scrambleReportPath                 - Directory for per-scramble JSON reports (default: "TeamBalancerScrambleReports/").
 *
 * IMPORTANT: The "database" option specifies which Sequelize connector to use for persistence.
 * Set it to the name of your configured connector (default: "sqlite"). Examples:
 *   - "database": "sqlite"  (uses connectors.sqlite)
 *   - "database": "mysql"   (uses connectors.mysql)
 *   - "database": "postgres" (uses connectors.postgres)
 * The plugin will gracefully degrade if the connector is unavailable.
 *
 * Example SquadJS server config:
 * "connectors": {
 *   "sqlite": { "dialect": "sqlite", "storage": "squad-server.sqlite" },
 *   "mysql": { "dialect": "mysql", "host": "localhost", "user": "squad", "password": "...", "database": "squad_db" },
 *   "discord": { "connector": "discord", "token": "YOUR_BOT_TOKEN" }
 * },
 * {
 *   "plugin": "TeamBalancer",
 *   "enabled": true,
 *   "database": "sqlite",
 *   "enableWinStreakTracking": true,
 *   "enableSeedAutoScramble": true,
 *   "maxWinStreak": 2,
 *   "maxConsecutiveWinsWithoutThreshold": 3,
 *   "enableSingleRoundScramble": true,
 *   "singleRoundScrambleThreshold": 200,
 *   "minTicketsToCountAsDominantWin": 150,
 *   "invasionAttackTeamThreshold": 300,
 *   "invasionDefenceTeamThreshold": 500,
 *   "scrambleAnnouncementDelay": 25,
 *   "seedScrambleAnnouncementDelay": 5,
 *   "scramblePercentage": 0.5,
 *   "changeTeamRetryInterval": 100,
 *   "maxScrambleCompletionTime": 15000,
 *   "showWinStreakMessages": true,
 *   "warnOnSwap": true,
 *   "useGenericTeamNamesInBroadcasts": false,
 *   "requireScrambleConfirmation": true,
 *   "scrambleConfirmationTimeout": 60,
 *   "discordClient": "discord",
 *   "discordAdminChannelID": "",
 *   "discordReportChannelID": "",
 *   "discordAdminRoleIDs": [],
 *   "mirrorRconBroadcasts": true,
 *   "postScrambleDetails": true,
 *   "useEloForBalance": true,
 *   "enableEloDiffScramble": false,
 *   "eloDiffScrambleThreshold": 1.2,
 *   "microScrambleParityTarget": 0.05,
 *   "microScrambleMaxMovePercent": 0.10,
 *   "devMode": false,
 *   "reportLogPath": "team-balancer-reports.jsonl",
 *   "enableDatabaseLogging": false
 * }
 *
 * ─── AUTHOR ──────────────────────────────────────────────────────
 *
 * Slacker
 * Discord: `real_slacker`
 * GitHub:  https://github.com/mikebjoyce/squadjs-team-balancer
 *
 * ═══════════════════════════════════════════════════════════════
 */


import S3PluginBase from './s3-plugin-base.js';
import { DiscordHelpers } from '../utils/tb-discord-helpers.js';
import Scrambler from '../utils/tb-scrambler.js';
import SwapExecutor from '../utils/tb-swap-executor.js';
import CommandHandlers from '../utils/tb-commands.js';
import Logger from '../../core/logger.js';
import { TBDiagnostics } from '../utils/tb-diagnostics.js';
import fs from 'fs';
import path from 'path';

export default class TeamBalancer extends S3PluginBase {
  static version = '4.0.6';

  static get description() {
    return 'Tracks dominant wins by team ID and scrambles teams if one team wins too many rounds.';
  }

  static get defaultEnabled() {
    return true;
  }

  static get optionsSpecification() {
    return {
      enableWinStreakTracking: {
        default: true,
        type: 'boolean'
      },
      enableSeedAutoScramble: {
        default: true,
        type: 'boolean',
        description: 'Automatically scramble teams when a Seed match ends (independent of enableWinStreakTracking; stopped by !teambalancer off).'
      },
      maxWinStreak: {
        default: 2,
        type: 'number'
      },      
      maxConsecutiveWinsWithoutThreshold: {
        default: 3,
        type: 'number',
        description: 'Trigger scramble after X consecutive wins, ignoring ticket thresholds. Set to 0 to disable.'
      },
      enableSingleRoundScramble: {
        default: true,
        type: 'boolean'
      },
      singleRoundScrambleThreshold: {
        default: 200,
        type: 'number'
      },
      minTicketsToCountAsDominantWin: {
        default: 150,
        type: 'number'
      },      
      invasionAttackTeamThreshold: {
        default: 300,
        type: 'number'
      },      
      invasionDefenceTeamThreshold: {
        default: 500,
        type: 'number'
      },
      scrambleAnnouncementDelay: {
        default: 25,
        type: 'number'
      },
      seedScrambleAnnouncementDelay: {
        default: 5,
        type: 'number',
        description: 'Seconds between the seed auto-scramble announcement and its execution (default: 5). Independent from scrambleAnnouncementDelay — a countdown still running at NEW_GAME is discarded and the scramble never happens.'
      },
      scramblePercentage: {
        default: 0.5,
        type: 'number'
      },
        changeTeamRetryInterval: {
         default: 100,
         type: 'number'
       },
      maxScrambleCompletionTime: {
        default: 15000,
        type: 'number'
      },      
      showWinStreakMessages: {
        default: true,
        type: 'boolean'
      },      
      warnOnSwap: {
        default: true,
        type: 'boolean'
      },      
      useGenericTeamNamesInBroadcasts: {
        default: false,
        type: 'boolean'
      },      
      discordClient: {
        required: false,
        connector: 'discord',
        description: 'Discord connector for admin commands and event logging.',
        default: 'discord'
      },
      discordAdminChannelID: {
        required: false,
        description: 'Discord channel ID for admin commands. Falls back to discordChannelID if unset.',
        default: ''
      },
      discordReportChannelID: {
        required: false,
        description: 'Discord channel ID for automated reports (win streaks, scramble plans, errors). Defaults to admin channel if unset.',
        default: ''
      },
      discordAdminRoleIDs: {
        required: false,
        type: 'array',
        description: 'List of Discord role IDs that have admin permissions. Leave empty to allow all users in the admin channel.',
        default: []
      },
      mirrorRconBroadcasts: {
        default: true,
        type: 'boolean',
        description: 'Mirror RCON broadcasts to Discord.'
      },
      postScrambleDetails: {
        default: true,
        type: 'boolean',
        description: 'Post detailed scramble swap plans to Discord.'
      },      
      requireScrambleConfirmation: {
        default: true,
        type: 'boolean',
        description: 'Require !scramble confirm before executing a scramble.'
      },
      scrambleConfirmationTimeout: {
        default: 60,
        type: 'number',
        description: 'Time in seconds to wait for scramble confirmation.'
      },
      useEloForBalance: {
        default: true,
        type: 'boolean',
        description: 'Use EloTracker ratings to influence team balance during scrambles. Requires EloTracker plugin to be active.'
      },
      enableEloDiffScramble: {
        default: false,
        type: 'boolean',
        description: 'Trigger a small "micro scramble" when the average Elo (mu) gap between teams from the round that just ended meets eloDiffScrambleThreshold, independent of the three reactive triggers. Opt-in — requires EloTracker to be active.'
      },
      eloDiffScrambleThreshold: {
        default: 1.2,
        type: 'number',
        description: 'Average mu gap between teams (abs value) that arms the Elo-diff micro scramble. Calibrated against real round history to target roughly the top quartile of real imbalance rather than firing on nearly every round.'
      },
      microScrambleParityTarget: {
        default: 0.05,
        type: 'number',
        description: 'Post-swap average mu gap the Elo-diff micro scramble\'s escalating search stops at once reached.'
      },
      microScrambleMaxMovePercent: {
        default: 0.10,
        type: 'number',
        description: 'Safety ceiling for the Elo-diff micro scramble: max fraction of the current round\'s total population (both teams combined) that may be moved.'
      },
      devMode: {
        default: false,
        type: 'boolean'
      },
       reportLogPath: {
         default: 'team-balancer-reports.jsonl',
         type: 'string',
         description: 'Path to a JSONL file where round reports will be logged.'
       },
       enableDatabaseLogging: {
         required: false,
         default: false,
         type: 'boolean',
         description: 'If true, round reports are also written to the database in addition to the JSONL log.'
       },
       scrambleReportPath: {
         required: false,
         default: 'TeamBalancerScrambleReports/',
         type: 'string',
         description: 'Directory for per-scramble JSON reports. Leave empty to disable. Relative to CWD.'
       }
     };
   }

  validateOptions() {
    // Backwards compatibility for older configs
    if (!this.options.discordAdminChannelID && this.options.discordChannelID) {
      this.options.discordAdminChannelID = this.options.discordChannelID;
    }
    if (!this.options.discordReportChannelID) {
      this.options.discordReportChannelID = this.options.discordAdminChannelID;
    }
    if ((!this.options.discordAdminRoleIDs || this.options.discordAdminRoleIDs.length === 0) && this.options.discordAdminRoleID) {
      this.options.discordAdminRoleIDs = [this.options.discordAdminRoleID];
    }

    if (this.options.scrambleAnnouncementDelay < 10) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.scrambleDelayTooLow, { delay: this.options.scrambleAnnouncementDelay }));
      this.options.scrambleAnnouncementDelay = 10;
    }
    // Its own floor, well below the global 10s: the whole point of the option is that a Seed
    // round's post-round window is shorter than that minimum. 3s still leaves the announcement
    // time to reach players before the swaps start.
    if (this.options.seedScrambleAnnouncementDelay < 3) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.seedScrambleDelayTooLow, { delay: this.options.seedScrambleAnnouncementDelay }));
      this.options.seedScrambleAnnouncementDelay = 3;
    }
    if (this.options.changeTeamRetryInterval < 50) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.changeTeamRetryTooLow, { interval: this.options.changeTeamRetryInterval }));
      this.options.changeTeamRetryInterval = 50;
    }
    if (this.options.maxScrambleCompletionTime < 5000) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.maxScrambleTimeTooLow, { time: this.options.maxScrambleCompletionTime }));
      this.options.maxScrambleCompletionTime = 5000;
    }
    if (this.options.scramblePercentage < 0.0 || this.options.scramblePercentage > 1.0) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.scramblePercentageInvalid, { percentage: this.options.scramblePercentage }));
      this.options.scramblePercentage = 0.5;
    }
    if (this.options.singleRoundScrambleThreshold <= this.options.minTicketsToCountAsDominantWin) {
      const newThreshold = this.options.minTicketsToCountAsDominantWin + 50;
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.singleRoundThresholdTooLow, { 
        threshold: this.options.singleRoundScrambleThreshold, 
        minTickets: this.options.minTicketsToCountAsDominantWin, 
        newThreshold 
      }));
      this.options.singleRoundScrambleThreshold = newThreshold;
    }
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    CommandHandlers.register(this);

    // Initialize executor immediately so commands (like status) can access pendingPlayerMoves without crashing
    this.swapExecutor = new SwapExecutor(this.server, this.options, this.RconMessages, this, this._requestTeamChange?.bind(this));
    this.db = null;  // 7.4m: Set in _onS3Ready() via S³ MigrationEngine, or stays null if S³ unavailable
    this.winStreakTeam = null;
    this.winStreakCount = 0;
    this.consecutiveWinsTeam = null;
    this.consecutiveWinsCount = 0;
    this.lastSyncTimestamp = null;
    this.manuallyDisabled = false;
    this._roundEndInFlight = false;
    this.scrambleConfirmation = null;
    this.ready = false;

    this._isMounted = false;
    this._scramblePending = false;
    // Set only on the paths in initiateScramble() that actually arm a scramble, and captured
    // (then cleared) at the top of executeScramble() — never leaks into a later, unrelated
    // scramble if a given attempt is rejected by the concurrency guard above.
    this._pendingScrambleType = null;
    // "!scramble matchend" arm. Persisted to the DB (see _setScrambleArm), stamped with S3's
    // matchId, so it survives a SquadJS restart mid-round: restored in _onS3Ready(), and in
    // onRoundEnded it fires only if the current round's matchId matches the stamp — a
    // restart that crosses a round boundary discards the stale arm instead of scrambling the wrong round.
    this._scrambleOnRoundEnd = false;
    this._scrambleOnRoundEndBy = null; // { name, eosID, matchId, scrambleType } — arming admin + round fingerprint, for the gate + discard notices. scrambleType is 'EloDiff' for "!scramble elo matchend", null otherwise.
    this._scrambleTimeout = null;
    this._scrambleCountdownTimeout = null;
    this._flippedAfterScramble = false;
    this.lastScrambleTime = null;

    this._scrambleInProgress = false;
    this.listeners = {};
    this.listeners.onRoundEnded = this.onRoundEnded.bind(this);
    this.listeners.onNewGame = this.onNewGame.bind(this);
    this.listeners.onChatCommand = this.onChatCommand.bind(this);
    this.listeners.onScrambleCommand = this.onScrambleCommand.bind(this);
    this.listeners.onChatMessage = this.onChatMessage.bind(this);
    this.listeners.onDiscordMessage = this.onDiscordMessage.bind(this);
    this.discordChannel = null;
    this.discordReportChannel = null;
    
  }

  isIgnoredMatch() {
    const gs = this._s3?.gameState;
    if (!gs?.isReady()) return false;
    return gs.isIgnoredMode?.() || false;
  }

  // Single funnel for arming/disarming the "!scramble matchend" state: updates the in-memory
  // flags AND persists to the DB so the arm survives a restart. Pass the { name, eosID } of the
  // arming admin to arm, or null to disarm. Persistence is best-effort (a DB failure is logged,
  // not thrown) so the in-memory behaviour is never blocked by the database.
  async _setScrambleArm(armedBy) {
    if (armedBy) {
      // Stamp the arm with S3's matchId. onRoundEnded uses it to detect an arm that
      // a restart carried into a LATER round and discard it instead of scrambling the wrong round.
      armedBy = { ...armedBy, matchId: this._s3?.gameState?.getMatchId?.() ?? null };
    }
    this._scrambleOnRoundEnd = !!armedBy;
    this._scrambleOnRoundEndBy = armedBy;
    if (this.db?.saveScrambleArm) {
      try {
        await this.db.saveScrambleArm(armedBy);
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbArmPersistFailed, { error: err.message }));
      }
    }
  }

  // Tell the arming admin (RCON warn) and Discord that their scheduled match-end scramble was dropped.
  // `reason` completes "…was discarded because <reason>." — keep it a fragment, no trailing period.
  async _notifyScrambleDiscarded(armedBy, reason) {
    if (armedBy?.name) {
      try {
        const warnMsg = this.formatMessage(this.messages.system.broadcasts.warnAdminMatchEndDiscarded, { reason });
        await this.server.rcon.warn(armedBy.name, `${this.RconMessages.prefix} ${warnMsg}`);
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.warnAdminArmFailed, { error: err.message }));
      }
    }
    if (this.discordChannel) {
      const discordMsg = this.formatMessage(this.messages.system.broadcasts.discordMatchEndDiscarded, { 
        admin: armedBy?.name || 'unknown', 
        reason 
      });
      DiscordHelpers.sendDiscordMessage(this.discordChannel, {
        content: discordMsg
      });
    }
  }

  // 7.4m: Build a compatibility wrapper around S³ DB that matches TBDatabase's API surface.
  // Used by call sites throughout team-balancer.js and tb-commands.js.
  _buildS3DbWrapper(s3db) {
    if (!s3db || !s3db.isReady()) {
      Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.dbNotReady);
      return null;
    }

    // DBService stores models in this.models[name] — no getModel() method exists
    const TeamBalancerStateModel = s3db.models?.['TeamBalancerState'];
    const TBRoundReportModel = s3db.models?.['TB_RoundReport'];

    if (!TeamBalancerStateModel) {
      Logger.verbose('TeamBalancer', 1, this.messages.system.errors.dbModelNotFound);
      return null;
    }

    const STALE_CUTOFF_MS = 2.5 * 60 * 60 * 1000;

    return {
      // TBDatabase-compatible initDB() — returns { winStreakTeam, winStreakCount, ... isStale }
      initDB: async () => {
        try {
          // The transaction handle MUST be threaded into every model call below.
          // Sequelize's managed transaction does not propagate implicitly (S³ does
          // not enable CLS), so a bare findOrCreate() opens a transaction of its
          // own — which on SQLite, where the pool is a single connection, throws
          // "cannot start a transaction within a transaction" and sent initDB
          // down its catch, losing the win streak on every restart.
          return await s3db.withTransactionWithRetry(async (t) => {
            const [record] = await TeamBalancerStateModel.findOrCreate({
              where: { id: 1 },
              defaults: {
                winStreakTeam: null,
                winStreakCount: 0,
                lastSyncTimestamp: Date.now(),
                lastScrambleTime: null,
                consecutiveWinsTeam: null,
                consecutiveWinsCount: 0,
                manuallyDisabled: false
              },
              transaction: t
            });

            const isStale = !record.lastSyncTimestamp || Date.now() - record.lastSyncTimestamp > STALE_CUTOFF_MS;

            // The transaction-threading fix is only observable by its absence:
            // before it, this line was never reached on SQLite because
            // findOrCreate() threw "cannot start a transaction within a
            // transaction" and initDB returned its zeroed fallback instead. A
            // real winStreakCount here after a restart IS the proof.
            Logger.verbose(
              'TeamBalancer',
              2,
              this.formatMessage(this.messages.system.verbose.dbStateRead, {
                winStreakTeam: record.winStreakTeam,
                winStreakCount: record.winStreakCount,
                isStale
              })
            );

            if (!isStale) {
              Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.dbStateRestored, {
                winStreakTeam: record.winStreakTeam,
                winStreakCount: record.winStreakCount
              }));
            } else {
              Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.dbStateStale);
              record.winStreakTeam = null;
              record.winStreakCount = 0;
              record.lastSyncTimestamp = Date.now();
              record.consecutiveWinsTeam = null;
              record.consecutiveWinsCount = 0;
              await record.save({ transaction: t });
            }

            return {
              winStreakTeam: record.winStreakTeam,
              winStreakCount: record.winStreakCount,
              lastSyncTimestamp: record.lastSyncTimestamp,
              lastScrambleTime: record.lastScrambleTime,
              isStale,
              consecutiveWinsTeam: record.consecutiveWinsTeam,
              consecutiveWinsCount: record.consecutiveWinsCount,
              manuallyDisabled: record.manuallyDisabled || false,
              scrambleOnRoundEndBy: record.scrambleOnRoundEndBy || null
            };
          });
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbInitFailed, { error: err.message }));
          return {
            winStreakTeam: null, winStreakCount: 0, lastSyncTimestamp: null,
            lastScrambleTime: null, isStale: true,
            consecutiveWinsTeam: null, consecutiveWinsCount: 0, manuallyDisabled: false,
            scrambleOnRoundEndBy: null
          };
        }
      },

      saveState: async (team, count, conTeam, conCount) => {
        try {
          return await s3db.withTransactionWithRetry(async (t) => {
            const record = await TeamBalancerStateModel.findByPk(1, { transaction: t });
            if (!record) return null;
            record.winStreakTeam = team;
            record.winStreakCount = count;
            record.lastSyncTimestamp = Date.now();
            record.consecutiveWinsTeam = conTeam ?? null;
            record.consecutiveWinsCount = conCount ?? 0;
            await record.save({ transaction: t });
            return {
              winStreakTeam: record.winStreakTeam,
              winStreakCount: record.winStreakCount,
              lastSyncTimestamp: record.lastSyncTimestamp,
              lastScrambleTime: record.lastScrambleTime,
              consecutiveWinsTeam: record.consecutiveWinsTeam,
              consecutiveWinsCount: record.consecutiveWinsCount
            };
          });
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbSaveStateFailed, { error: err.message }));
          return null;
        }
      },

      incrementStreak: async (winnerID, conTeam, conCount) => {
        try {
          return await s3db.withTransactionWithRetry(async (t) => {
            const record = await TeamBalancerStateModel.findByPk(1, { transaction: t });
            if (!record) return null;
            if (record.winStreakTeam === winnerID) {
              record.winStreakCount += 1;
            } else {
              record.winStreakTeam = winnerID;
              record.winStreakCount = 1;
            }
            record.lastSyncTimestamp = Date.now();
            record.consecutiveWinsTeam = conTeam ?? null;
            record.consecutiveWinsCount = conCount ?? 0;
            await record.save({ transaction: t });
            return {
              winStreakTeam: record.winStreakTeam,
              winStreakCount: record.winStreakCount,
              lastSyncTimestamp: record.lastSyncTimestamp,
              consecutiveWinsTeam: record.consecutiveWinsTeam,
              consecutiveWinsCount: record.consecutiveWinsCount
            };
          });
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbIncrementStreakFailed, { error: err.message }));
          return null;
        }
      },

      saveScrambleTime: async (timestamp) => {
        try {
          return await s3db.withTransactionWithRetry(async (t) => {
            const record = await TeamBalancerStateModel.findByPk(1, { transaction: t });
            if (!record) return null;
            record.lastScrambleTime = timestamp;
            await record.save({ transaction: t });
            return { lastScrambleTime: record.lastScrambleTime };
          });
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbSaveScrambleTimeFailed, { error: err.message }));
          return null;
        }
      },

      saveManuallyDisabledState: async (disabled) => {
        try {
          return await s3db.withTransactionWithRetry(async (t) => {
            const record = await TeamBalancerStateModel.findByPk(1, { transaction: t });
            if (!record) return null;
            record.manuallyDisabled = disabled;
            await record.save({ transaction: t });
            return { manuallyDisabled: record.manuallyDisabled };
          });
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbSaveManuallyDisabledStateFailed, { error: err.message }));
          return null;
        }
      },

      saveScrambleArm: async (armedBy) => {
        try {
          return await s3db.withTransactionWithRetry(async (t) => {
            const record = await TeamBalancerStateModel.findByPk(1, { transaction: t });
            if (!record) return null;
            record.scrambleOnRoundEndBy = armedBy || null;
            await record.save({ transaction: t });
            return { scrambleOnRoundEndBy: record.scrambleOnRoundEndBy };
          });
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbSaveScrambleArmFailed, { error: err.message }));
          return null;
        }
      },

      insertRoundReport: async (data) => {
        if (!TBRoundReportModel) return null;
        try {
          return await s3db.withTransactionWithRetry(async (t) => {
            const record = await TBRoundReportModel.create({
              matchId: data.matchId || null,
              roundStartTime: data.roundStartTime || null,
              ts: data.ts,
              layerName: data.layerName,
              gameMode: data.gameMode,
              playerCount: data.playerCount,
              winningTeamID: data.winningTeamID,
              winnerName: data.winnerName,
              loserName: data.loserName,
              winnerTickets: data.winnerTickets,
              loserTickets: data.loserTickets,
              ticketMargin: data.ticketMargin,
              isDominantWin: data.isDominantWin,
              winStreakTeam: data.winStreakTeam,
              winStreakCount: data.winStreakCount,
              consecutiveWinsTeam: data.consecutiveWinsTeam,
              consecutiveWinsCount: data.consecutiveWinsCount,
              scrambled: data.scrambled,
              scrambleCondition: data.scrambleCondition,
              scrambleType: data.scrambleType
            }, { transaction: t });
            return record.toJSON();
          });
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbInsertRoundReportFailed, { error: err.message }));
          return null;
        }
      },

      runConcurrencyTest: async () => {
        // TBDatabase.runConcurrencyTest() was a diagnostic for the old custom mutex.
        // S³'s withTransactionWithRetry handles serialization natively.
        Logger.verbose('TeamBalancer', 1, this.messages.system.verbose.dbConcurrencyTestSkipped);
        return { success: true, message: 'SKIP (S³ handles concurrency)' };
      }
    };
  }

 // isSeedMatch() removed in Stage 6.4b — seed detection delegated to S³ GameStateService.isSeedMode()
  // Training/Jensen detection also available via S³ GameStateService.isTrainingMode()

  /**
   * Suffix for the "!teambalancer off" confirmations. The toggle stops the seed auto-scramble
   * along with streak tracking, so a bare "Win streak tracking disabled." under-reports what the
   * admin just did. One wording, so the confirmations can't drift apart.
   * Only used where there is no room for a full line: the status and diag surfaces render
   * seedAutoScrambleStatus() as their own field instead, and appending both duplicates it.
   * Not appended to player broadcasts either: it is admin-only detail.
   */
  seedScrambleOffNote() {
    // An already-ticking countdown is NOT stopped by the toggle — cancelPendingScramble is the
    // only thing that reaches it. Warn about that first and name the command that works: an admin
    // types "off" precisely to head off a scramble they can see coming, and telling them it
    // stopped would send them away from the one thing that would have. Not seed-specific on
    // purpose — the countdown could equally be a streak scramble, and the advice is the same.
    if (this._scramblePending || this._scrambleInProgress) {
      return this.messages.system.broadcasts.seedScrambleOffPendingScramble;
    }
    // The seed auto-scramble trigger fires on any Seed round end (isSeedMode()) regardless of
    // ignored game mode settings. "off while disabled" is true for any configuration.
    return this.options.enableSeedAutoScramble ? this.messages.system.broadcasts.seedScrambleOffDisabled : '';
  }

  /**
   * Full confirmation text for "!teambalancer on" — the mirror of seedScrambleOffNote().
   * Not a bare literal for two reasons: "Win streak tracking enabled." is false on a server
   * running enableWinStreakTracking: false (the toggle clears the manual disable, it does not
   * override the config flag), and "on" re-arms the seed trigger, which is a real side effect an
   * admin should not have to discover from the next round's broadcast.
   */
  enableConfirmationText() {
    const base = this.options.enableWinStreakTracking
      ? this.messages.system.broadcasts.enableConfirmationStreakOn
      : this.messages.system.broadcasts.enableConfirmationStreakOff;
    return `${base}${this.options.enableSeedAutoScramble ? this.messages.system.broadcasts.enableConfirmationSeedRearmed : ''}`;
  }

  /**
   * Seed auto-scramble state as one line, for the status and diag surfaces.
   * Config blockers are reported BEFORE the manual toggle: both of them need a config edit plus a
   * restart, and naming the runtime-fixable reason first sends an admin to "!teambalancer on" for
   * a trigger that will still not fire afterwards.
   */
  seedAutoScrambleStatus() {
    if (!this.options.enableSeedAutoScramble) return this.messages.system.broadcasts.seedStatusConfigOff;
    if (this.manuallyDisabled) return this.messages.system.broadcasts.seedStatusPluginDisabled;
    return this.messages.system.broadcasts.seedStatusActive;
  }

  /**
   * Parses a ROUND_ENDED payload into the round report and hands the values back to the caller.
   * Runs once per round, before any early-returning path, so an armed match-end scramble and a
   * seed auto-scramble log the same winner/ticket data the win-streak path does. Each field is
   * written only when it parsed; the returned values may be NaN, which callers that need a
   * complete outcome check for themselves.
   */
  _parseRoundOutcome(data, roundReport) {
    const winnerID = parseInt(data?.winner?.team);
    const winnerTickets = parseInt(data?.winner?.tickets);
    const loserTickets = parseInt(data?.loser?.tickets);
    const margin = winnerTickets - loserTickets;

    if (!isNaN(winnerTickets) && !isNaN(loserTickets)) {
      roundReport.winnerTickets = winnerTickets;
      roundReport.loserTickets = loserTickets;
      roundReport.ticketMargin = margin;
    }

    let winnerName = null;
    let loserName = null;
    if (!isNaN(winnerID)) {
      winnerName = (this.options.useGenericTeamNamesInBroadcasts ? `Team ${winnerID}` : this.getTeamName(winnerID)) || `Team ${winnerID}`;
      loserName = (this.options.useGenericTeamNamesInBroadcasts ? `Team ${3 - winnerID}` : this.getTeamName(3 - winnerID)) || `Team ${3 - winnerID}`;
      roundReport.winnerName = winnerName;
      roundReport.loserName = loserName;
    }

    return { winnerID, winnerTickets, loserTickets, margin, winnerName, loserName };
  }

  /**
   * Substitutes the last layer that resolved when this round's own layer never did.
   * lastKnownGoodLayer is not cleared by onNewGame, so the substitute can be the PREVIOUS round's
   * layer — good enough to guess ticket thresholds and label the report, too weak to decide on a
   * team shuffle. Hence it runs only on the paths that need it, never before the seed decision.
   */
  _applyLayerFallback(roundReport) {
    if (this.gameModeCached !== null || this.layerNameCached !== null || this.lastKnownGoodLayer === null) return;
    Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.layerInfoMissingFallback, {
      gamemode: this.lastKnownGoodLayer.gamemode,
      name: this.lastKnownGoodLayer.name
    }));
    this.gameModeCached = this.lastKnownGoodLayer.gamemode;
    this.layerNameCached = this.lastKnownGoodLayer.name;
    roundReport.gameMode = this.gameModeCached;
    roundReport.layerName = this.layerNameCached;
    // Provenance for the JSONL log: otherwise a round skipped because the layer was unknown is
    // indistinguishable from one where the trigger was simply switched off.
    roundReport.layerFallback = true;
  }

  /// S3PluginBase lifecycle hooks

  _checkS3Version() {
    const required = '1.0.0';
    const actual = this._s3?.version;
    if (!this._s3VersionAtLeast(required)) {
      throw new Error(
        this.formatMessage(this.messages.system.errors.s3VersionIncompatible, {
          actual: actual || 'unknown',
          required
        })
      );
    }
    Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.s3VersionPassed, { actual, required }));
  }

  async _onS3Ready() {
    this._checkS3Version();
    if (this._isMounted) {
      Logger.verbose('TeamBalancer', 1, this.messages.system.verbose.alreadyMounted);
      return;
    }
    this.ready = false;
    Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.mountingPlugin);
    this.validateOptions();
    
    if (this.options.devMode) {
      Logger.verbose('TeamBalancer', 1, this.messages.system.verbose.devModeWarning);
    }

    // ─────────────────────────────────────────────────────────────────
    // 7.4m: SCHEMA MIGRATION — Define models + register team-balancer v1
    // ─────────────────────────────────────────────────────────────────
    // S³ already discovered by base class — this._s3 and this._s3db are ready

    if (this.s3db?.isReady() && this.s3db.migrationEngine) {
      // Define models on S³ connector
      this.defineModel('TeamBalancerState', {
        id: { type: this.s3db.getDataTypes().INTEGER, primaryKey: true, autoIncrement: false, defaultValue: 1 },
        winStreakTeam: { type: this.s3db.getDataTypes().INTEGER, allowNull: true },
        winStreakCount: { type: this.s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
        lastSyncTimestamp: { type: this.s3db.getDataTypes().BIGINT, allowNull: true },
        lastScrambleTime: { type: this.s3db.getDataTypes().BIGINT, allowNull: true },
        consecutiveWinsTeam: { type: this.s3db.getDataTypes().INTEGER, allowNull: true },
        consecutiveWinsCount: { type: this.s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
        manuallyDisabled: { type: this.s3db.getDataTypes().BOOLEAN, allowNull: false, defaultValue: false },
        scrambleOnRoundEndBy: { type: this.s3db.getDataTypes().JSON, allowNull: true }
      }, { timestamps: false, tableName: 'TeamBalancerState', exportTier: 'ephemeral' });

      this.defineModel('TB_RoundReport', {
        id: { type: this.s3db.getDataTypes().INTEGER, primaryKey: true, autoIncrement: true },
        matchId: { type: this.s3db.getDataTypes().STRING(20), allowNull: true },
        roundStartTime: { type: this.s3db.getDataTypes().BIGINT, allowNull: true },
        ts: { type: this.s3db.getDataTypes().BIGINT, allowNull: false },
        layerName: { type: this.s3db.getDataTypes().STRING(255), allowNull: true },
        gameMode: { type: this.s3db.getDataTypes().STRING(100), allowNull: true },
        playerCount: { type: this.s3db.getDataTypes().INTEGER, allowNull: true },
        winningTeamID: { type: this.s3db.getDataTypes().INTEGER, allowNull: true },
        winnerName: { type: this.s3db.getDataTypes().STRING(255), allowNull: true },
        loserName: { type: this.s3db.getDataTypes().STRING(255), allowNull: true },
        winnerTickets: { type: this.s3db.getDataTypes().INTEGER, allowNull: true },
        loserTickets: { type: this.s3db.getDataTypes().INTEGER, allowNull: true },
        ticketMargin: { type: this.s3db.getDataTypes().INTEGER, allowNull: true },
        isDominantWin: { type: this.s3db.getDataTypes().BOOLEAN, allowNull: false, defaultValue: false },
        winStreakTeam: { type: this.s3db.getDataTypes().INTEGER, allowNull: true },
        winStreakCount: { type: this.s3db.getDataTypes().INTEGER, allowNull: true },
        consecutiveWinsTeam: { type: this.s3db.getDataTypes().INTEGER, allowNull: true },
        consecutiveWinsCount: { type: this.s3db.getDataTypes().INTEGER, allowNull: true },
        scrambled: { type: this.s3db.getDataTypes().BOOLEAN, allowNull: false, defaultValue: false },
        scrambleCondition: { type: this.s3db.getDataTypes().STRING(100), allowNull: true },
        scrambleType: { type: this.s3db.getDataTypes().STRING(100), allowNull: true }
      }, { timestamps: false, tableName: 'TB_RoundReport', exportTier: 'historical' });

      // Register expected version + v1 + v2 migrations
      this.registerExpectedVersion('team-balancer', 2, {
        models: ['TeamBalancerState', 'TB_RoundReport']
      });
      this.registerMigrations('team-balancer', [
        {
          version: 1,
          description: 'Create TeamBalancerState and TB_RoundReport',
          touches: {
            creates: ['TeamBalancerState', 'TB_RoundReport']
          },
          // NOTE: v1 is the baseline migration for new installs. It MUST include ALL columns
          // that the current code expects — including columns added in later delta migrations
          // (like scrambleOnRoundEndBy from v2). If you add a column in a future vN migration,
          // also add it here so new installs get the full schema from day one. Delta migrations
          // should guard with describeTable() checks so they are safe no-ops on new installs.
          up: async (qi) => {
            const existing = await qi.showAllTables();

            if (!existing.includes('TeamBalancerState')) {
              await qi.createTable('TeamBalancerState', {
                id: { type: qi.DataTypes.INTEGER, primaryKey: true, autoIncrement: false, defaultValue: 1 },
                winStreakTeam: { type: qi.DataTypes.INTEGER, allowNull: true },
                winStreakCount: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
                lastSyncTimestamp: { type: qi.DataTypes.BIGINT, allowNull: true },
                lastScrambleTime: { type: qi.DataTypes.BIGINT, allowNull: true },
                consecutiveWinsTeam: { type: qi.DataTypes.INTEGER, allowNull: true },
                consecutiveWinsCount: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
                manuallyDisabled: { type: qi.DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
                scrambleOnRoundEndBy: { type: qi.DataTypes.JSON, allowNull: true }
              });
            }

            if (!existing.includes('TB_RoundReport')) {
              await qi.createTable('TB_RoundReport', {
                id: { type: qi.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
                matchId: { type: qi.DataTypes.STRING(20), allowNull: true },
                roundStartTime: { type: qi.DataTypes.BIGINT, allowNull: true },
                ts: { type: qi.DataTypes.BIGINT, allowNull: false },
                layerName: { type: qi.DataTypes.STRING(255), allowNull: true },
                gameMode: { type: qi.DataTypes.STRING(100), allowNull: true },
                playerCount: { type: qi.DataTypes.INTEGER, allowNull: true },
                winningTeamID: { type: qi.DataTypes.INTEGER, allowNull: true },
                winnerName: { type: qi.DataTypes.STRING(255), allowNull: true },
                loserName: { type: qi.DataTypes.STRING(255), allowNull: true },
                winnerTickets: { type: qi.DataTypes.INTEGER, allowNull: true },
                loserTickets: { type: qi.DataTypes.INTEGER, allowNull: true },
                ticketMargin: { type: qi.DataTypes.INTEGER, allowNull: true },
                isDominantWin: { type: qi.DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
                winStreakTeam: { type: qi.DataTypes.INTEGER, allowNull: true },
                winStreakCount: { type: qi.DataTypes.INTEGER, allowNull: true },
                consecutiveWinsTeam: { type: qi.DataTypes.INTEGER, allowNull: true },
                consecutiveWinsCount: { type: qi.DataTypes.INTEGER, allowNull: true },
                scrambled: { type: qi.DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
                scrambleCondition: { type: qi.DataTypes.STRING(100), allowNull: true },
                scrambleType: { type: qi.DataTypes.STRING(100), allowNull: true }
              });
            }
          },
          down: async (qi) => {
            await qi.dropTable('TeamBalancerState');
            await qi.dropTable('TB_RoundReport');
          }
        },
        {
          version: 2,
          description: 'Add scrambleOnRoundEndBy JSON column to TeamBalancerState for !scramble matchend persistence',
          touches: {
            columns: {
              TeamBalancerState: ['scrambleOnRoundEndBy']
            }
          },
          // NOTE: This is a delta migration for existing installs that only have the v1 schema.
          // New installs get this column from v1's createTable, so we guard with describeTable()
          // to make this a safe no-op when the column already exists.
          up: async (qi) => {
            const existing = await qi.showAllTables();
            if (existing.includes('TeamBalancerState')) {
              const cols = await qi.describeTable('TeamBalancerState');
              if (!cols.scrambleOnRoundEndBy) {
                await qi.addColumn('TeamBalancerState', 'scrambleOnRoundEndBy', {
                  type: qi.DataTypes.JSON,
                  allowNull: true
                });
              }
            }
          },
          down: async (qi) => {
            const existing = await qi.showAllTables();
            if (existing.includes('TeamBalancerState')) {
              await qi.removeColumn('TeamBalancerState', 'scrambleOnRoundEndBy');
            }
          }
        }
      ]);

      // Run pending migrations
      await this.verifyAndRunMigrations('team-balancer');

      // Build compatibility wrapper and load initial state
      this.db = this._buildS3DbWrapper(this.s3db);
      try {
        const dbState = await this.db.initDB();
        if (dbState && !dbState.isStale) {
          this.winStreakTeam = dbState.winStreakTeam;
          this.winStreakCount = dbState.winStreakCount;
          this.consecutiveWinsTeam = dbState.consecutiveWinsTeam;
          this.consecutiveWinsCount = dbState.consecutiveWinsCount;
          this.lastSyncTimestamp = dbState.lastSyncTimestamp;
          this.lastScrambleTime = dbState.lastScrambleTime;
          this.manuallyDisabled = dbState.manuallyDisabled || false;

          // Restore "!scramble matchend" arm if it survived a restart. Compare the stored
          // matchId against S3's current matchId — if they match, the arm is still valid
          // (same round). If they differ, the restart crossed a round boundary and the arm
          // is stale — discard it so we don't scramble the wrong round.
          if (dbState.scrambleOnRoundEndBy) {
            const currentMatchId = this._s3?.gameState?.getMatchId?.();
            if (currentMatchId && dbState.scrambleOnRoundEndBy.matchId === currentMatchId) {
              this._scrambleOnRoundEnd = true;
              this._scrambleOnRoundEndBy = dbState.scrambleOnRoundEndBy;
              Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.restoredMatchEndArm, {
                name: dbState.scrambleOnRoundEndBy.name || 'unknown',
                currentMatchId
              }));
            } else {
              Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.discardedStaleMatchEndArm, {
                storedMatchId: dbState.scrambleOnRoundEndBy.matchId,
                currentMatchId
              }));
              await this._setScrambleArm(null);
              await this._notifyScrambleDiscarded(dbState.scrambleOnRoundEndBy, this.messages.system.broadcasts.armDiscardedRestartReason);
            }
          }

          Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.restoredState, {
            winStreakTeam: this.winStreakTeam,
            winStreakCount: this.winStreakCount,
            manuallyDisabled: this.manuallyDisabled
          }));
        } else if (dbState) {
          Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.stateStaleReset);
          this.lastScrambleTime = dbState.lastScrambleTime;
          this.manuallyDisabled = dbState.manuallyDisabled || false;
          await this.db.saveState(null, 0);
        }
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbInitFailed, { error: err.message }));
      }
    } else {
      Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.dbNotAvailable);
      this.db = null;
    }

    if (this.options.discordClient) {
      Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.discordClientAvailable);

      // Register listener BEFORE channel fetch (fix: if fetch fails, listener is still active)
      this.options.discordClient.on('message', this.listeners.onDiscordMessage);
      Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.discordListenerRegistered);

      if (this.options.discordAdminChannelID) {
        try {
          this.discordChannel = await this.options.discordClient.channels.fetch(this.options.discordAdminChannelID);
          Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.discordAdminChannelFetched, {
            channelName: this.discordChannel?.name ?? 'unknown',
            channelId: this.options.discordAdminChannelID
          }));
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.discordAdminChannelFetchFailed, {
            channelId: this.options.discordAdminChannelID,
            error: err.message
          }));
        }
      } else {
        Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.discordAdminChannelNotSet);
      }

      if (this.options.discordReportChannelID) {
        try {
          this.discordReportChannel = await this.options.discordClient.channels.fetch(this.options.discordReportChannelID);
          Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.discordReportChannelFetched, {
            channelName: this.discordReportChannel?.name ?? 'unknown'
          }));
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.discordReportChannelFetchFailed, { error: err.message }));
        }
      } else {
        Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.discordReportChannelNotSet);
      }
    } else {
      Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.discordNotSet);
    }

    const listenerCounts = {
      ROUND_ENDED: this.server.listenerCount('ROUND_ENDED'),
      NEW_GAME: this.server.listenerCount('NEW_GAME'),
      UPDATED_LAYER_INFORMATION: this.server.listenerCount('UPDATED_LAYER_INFORMATION'),
      UPDATED_SERVER_INFORMATION: this.server.listenerCount('UPDATED_SERVER_INFORMATION'),
      'CHAT_COMMAND:teambalancer': this.server.listenerCount('CHAT_COMMAND:teambalancer'),
      'CHAT_COMMAND:scramble': this.server.listenerCount('CHAT_COMMAND:scramble'),
      CHAT_MESSAGE: this.server.listenerCount('CHAT_MESSAGE')
    };
    Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.listenerCountsBefore, {
      counts: JSON.stringify(listenerCounts)
    }));

    this.server.on('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.on('NEW_GAME', this.listeners.onNewGame);
    this.server.on('CHAT_COMMAND:teambalancer', this.listeners.onChatCommand);
    this.server.on('CHAT_COMMAND:scramble', this.listeners.onScrambleCommand);
    this.server.on('CHAT_MESSAGE', this.listeners.onChatMessage);

    // S³ gameState and service availability is already checked in the 7.4m block above.
    // Layer info always served from S³ gameState
    if (this._s3?.gameState?.isReady()) {
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.s3GameStateAvailable, {
        gamemode: this._s3.gameState.getGamemode(),
        layerName: this._s3.gameState.getLayerName()
      }));
    }

    // Subscribe to S³ layer change callbacks to keep gameModeCached/layerNameCached in sync.
    // S³ fires this after handleNewGame/handleLayerInfoUpdated/handleServerInfoUpdated has
    // resolved and committed new layer state — no polling or SquadJS listener required.
    this._unsubscribeLayerChange = this._s3?.gameState?.onLayerGameModeChange?.(({ layerName, gameMode }) => {
      this.gameModeCached = gameMode;
      this.layerNameCached = layerName;
      this.lastKnownGoodLayer = { gamemode: gameMode, name: layerName };
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.s3LayerUpdated, { gameMode, layerName }));
    }) || null;

    this._isMounted = true;
    this.ready = true;

    if (this.options.useEloForBalance) {
      Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.eloTrackerEnabled);
    } else {
      Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.eloTrackerDisabled);
    }
    
    Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.pluginFullyReady);
  }

  /**
   * NOTE: _onUnmount() is called by S3PluginBase.unmount(), but as of
   * SquadJS v4.2.0 RC1 and earlier, the framework never calls
   * plugin.unmount(). This cleanup is kept for future-proofing — if
   * SquadJS ever implements dynamic mount/unmount, listeners will be
   * cleaned up correctly.
   */
  async _onUnmount() {
    if (!this._isMounted) {
      Logger.verbose('TeamBalancer', 1, this.messages.system.verbose.notMountedSkippingUnmount);
      return;
    }
    Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.unmountingPlugin);
    this.server.removeListener('ROUND_ENDED', this.listeners.onRoundEnded);
    this.server.removeListener('NEW_GAME', this.listeners.onNewGame);
    this.server.removeListener('CHAT_COMMAND:teambalancer', this.listeners.onChatCommand);
    this.server.removeListener('CHAT_COMMAND:scramble', this.listeners.onScrambleCommand);
    this.server.removeListener('CHAT_MESSAGE', this.listeners.onChatMessage);

    if (this.options.discordClient && this.listeners.onDiscordMessage) {
      this.options.discordClient.removeListener('message', this.listeners.onDiscordMessage);
    }

    if (this._unsubscribeLayerChange) {
      this._unsubscribeLayerChange();
      this._unsubscribeLayerChange = null;
    }
    if (this._scrambleTimeout) clearTimeout(this._scrambleTimeout);
    this._clearPendingScrambleCountdown();
    this.cleanupScrambleTracking();
    // Removed: stopPollingTeamAbbreviations() and the _abbreviationPollStartTimeout
    // guard. Both belonged to the local abbreviation poller deleted along with the
    // rest of the duplicated layer stack — the method no longer exists, so this
    // line threw TypeError and aborted unmount before ready/_isMounted were
    // cleared. Abbreviations now come from this._s3.factions, which needs no
    // teardown here. See test-team-balancer-plugin.js.
    this._scrambleInProgress = false;
    this._scrambleOnRoundEnd = false;
    this._scrambleOnRoundEndBy = null;
    this.ready = false;
    this._isMounted = false;
  }

  // ╔═══════════════════════════════════════╗
  // ║          LAYER INFO — S³ OWNED        ║
  // ╚═══════════════════════════════════════╝
  //
  // TeamBalancer used to carry its own copy of S³'s layer stack:
  // inferGameMode(), resolveLayerInfo(), onLayerInfoUpdated(),
  // onServerInfoUpdated() and a 10s startPollingGameInfo() fallback loop.
  // All of it was removed — it had already been orphaned (mount() stopped
  // binding UPDATED_LAYER_INFORMATION / UPDATED_SERVER_INFORMATION and
  // nothing called startPollingGameInfo), and two of those methods read
  // this.server.currentLayer, which is null after a mid-round SquadJS
  // restart and would have re-introduced "Unknown" layers here.
  //
  // gameModeCached / layerNameCached / lastKnownGoodLayer are now a pure
  // mirror of S³, fed by the gameState.onLayerGameModeChange() subscription
  // registered in mount(). Read S³ directly for live values —
  // this._s3.gameState.getLayerName() / getGamemode() — and DO NOT re-add a
  // local resolver or a server.currentLayer read.

  getTeamName(teamID) {
    if (this.options.useGenericTeamNamesInBroadcasts) {
      return `Team ${teamID}`;
    }
    // Prefer S³ factions service, fall back to generic name
    if (this._s3?.factions?.isReady()) {
      return this._s3.factions.getTeamName(teamID);
    }
    return `Team ${teamID}`;
  }

  
  // ╔═══════════════════════════════════════╗
  // ║          COMMAND HANDLERS             ║
  // ╚═══════════════════════════════════════╝

  async onDiscordMessage(message) {
    if (!this.ready) {
      Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.discordNotReadyDropped);
      return;
    }
    if (message.author.bot) {
      //Logger.verbose('TeamBalancer', 4, `[Discord] Ignored bot message from ${message.author.id}.`);
      return;
    }
    if (message.channel.id !== this.options.discordAdminChannelID) {
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.discordWrongChannelDropped, {
        gotId: message.channel.id,
        expectedId: this.options.discordAdminChannelID
      }));
      return;
    }

    const content = message.content.trim();
    if (!content.startsWith('!teambalancer') && !content.startsWith('!scramble')) {
      //Logger.verbose('TeamBalancer', 4, `[Discord] Message "${content.substring(0, 40)}..." does not match TB commands. Dropping.`);
      return;
    }

    Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.discordCommandReceived, {
      content: content.substring(0, 80),
      authorTag: message.author.tag,
      authorId: message.author.id
    }));

    if (!this.checkDiscordAdminPermission(message.member)) {
      await message.reply(this.messages.system.errors.discordPermissionDenied);
      return;
    }

    if (content.startsWith('!teambalancer')) {
      await this.handleDiscordTeamBalancerCommand(message);
    } else if (content.startsWith('!scramble')) {
      await this.handleDiscordScrambleCommand(message);
    }
  }

  checkDiscordAdminPermission(member) {
    if (!this.options.discordAdminRoleIDs || this.options.discordAdminRoleIDs.length === 0) return true;
    return this.options.discordAdminRoleIDs.some(roleID => member.roles.cache.has(roleID));
  }

  async handleDiscordTeamBalancerCommand(message) {
    const args = message.content.replace(/^!teambalancer\s*/i, '').trim().split(/\s+/);
    const subcommand = args[0]?.toLowerCase();

    switch (subcommand) {
      case 'status':
        DiscordHelpers.sendDiscordMessage(message.channel, { embeds: [DiscordHelpers.buildStatusEmbed(this)] });
        break;
      case 'diag': {
        await message.channel.send(this.messages.discord.commands.diagRunning);
        const diagnostics = new TBDiagnostics(this);
        const results = await diagnostics.runAll();

        const embeds = DiscordHelpers.buildDiagEmbeds(this, results);
        for (const embed of embeds) {
          await DiscordHelpers.sendDiscordMessage(message.channel, { embeds: [embed] });
        }

        break;
      }
      case 'on':
      case 'off':
        await this.discordCommandToggle(message, subcommand);
        break;
      case 'export':
        await this.discordCommandExport(message);
        break;
      case 'clear':
        await this.discordCommandClear(message);
        break;
      case 'help': {
        const helpEmbed = {
          color: 0x3498db,
          title: this.messages.discord.help.title,
          description: this.messages.discord.help.description,
          fields: [
            { 
              name: this.messages.discord.help.fields.pluginCommands.name, 
              value: this.messages.discord.help.fields.pluginCommands.value 
            },
            { 
              name: this.messages.discord.help.fields.scrambleCommands.name, 
              value: this.messages.discord.help.fields.scrambleCommands.value 
            }
          ]
        };
        DiscordHelpers.sendDiscordMessage(message.channel, { embeds: [helpEmbed] });
        break;
      }
      default:
        await message.reply(this.messages.discord.commands.invalidCommand);
    }
  }

  async discordCommandExport(message) {
    try {
      const logPath = path.resolve(process.cwd(), this.options.reportLogPath || 'team-balancer-reports.jsonl');
      await fs.promises.access(logPath);
      await message.reply({
        content: this.messages.discord.export.successContent,
        files: [{ attachment: logPath, name: 'team-balancer-reports.jsonl' }]
      });
    } catch (err) {
      await message.reply(this.messages.discord.export.fileNotFound);
    }
  }

  async discordCommandClear(message) {
    try {
      const logPath = path.resolve(process.cwd(), this.options.reportLogPath || 'team-balancer-reports.jsonl');
      await fs.promises.writeFile(logPath, '');
      await message.reply(this.messages.discord.clear.success);
    } catch (err) {
      await message.reply(this.formatMessage(this.messages.discord.clear.failed, { error: err.message }));
    }
  }

  async handleDiscordScrambleCommand(message) {
    let args = message.content.replace(/^!scramble\s*/i, '').trim().toLowerCase().split(/\s+/).filter(a => a);

    // ─── Unknown arg guard ──────────────────────────────────────────────
    // Reject any argument that isn't in the whitelist BEFORE touching
    // scrambleConfirmation state. A typo (e.g. "!scramble confiirm") would
    // otherwise fall through to the bare-scramble path, overwriting a
    // pending confirmation and triggering a live broadcast.
    const VALID_SCRAMBLE_ARGS = ['now', 'dry', 'matchend', 'cancel', 'confirm', 'elo'];
    const badArg = args.find(a => !VALID_SCRAMBLE_ARGS.includes(a));
    if (badArg) {
      await message.reply(this.formatMessage(this.messages.discord.scramble.unknownArg, { badArg }));
      return;
    }

    const isConfirm = args.includes('confirm');

    if (isConfirm) {
      if (!this.scrambleConfirmation) {
        await message.reply(this.messages.discord.scramble.noPendingConfirmation);
        return;
      }
      const timeoutMs = (this.options.scrambleConfirmationTimeout || 60) * 1000;
      if (Date.now() - this.scrambleConfirmation.timestamp > timeoutMs) {
        this.scrambleConfirmation = null;
        await message.reply(this.messages.discord.scramble.confirmationExpired);
        return;
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

    if (isMatchEnd) {
      if (hasNow || hasDry) {
        await message.reply(this.messages.discord.scramble.matchEndIncompatible);
        return;
      }
      if (this._scrambleOnRoundEnd) {
        await message.reply(this.messages.discord.scramble.matchEndAlreadyScheduled);
        return;
      }
      const adminName = message.author?.username || 'unknown';
      await this._setScrambleArm({ name: adminName, eosID: null, scrambleType });
      Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.matchEndArmedDiscord, {
        scrambleKind: hasElo ? 'micro ' : '',
        adminName
      }));
      await message.reply(hasElo
        ? this.messages.discord.scramble.matchEndScheduledMicro
        : this.messages.discord.scramble.matchEndScheduled);
      return;
    }

    if (isCancel) {
      this.scrambleConfirmation = null;
      const cancelled = await this.cancelPendingScramble(null, null, false);
      if (cancelled) await message.reply(this.messages.discord.scramble.cancelSuccess);
      else if (this._scrambleInProgress) await message.reply(this.messages.discord.scramble.cannotCancelExecuting);
      else await message.reply(this.messages.discord.scramble.noPendingToCancel);
    } else {
      if (this._scramblePending || this._scrambleInProgress) {
        const status = this._scrambleInProgress ? 'executing' : 'pending';
        await message.reply(this.formatMessage(this.messages.discord.scramble.alreadyActive, { status }));
        return;
      }

      if (this.options.requireScrambleConfirmation && !hasDry && !isConfirm) {
        this.scrambleConfirmation = { timestamp: Date.now(), args: args };
        const scrambleKind = hasElo ? 'micro' : 'full';
        const timing = hasNow
          ? this.messages.discord.scramble.timingImmediate
          : this.formatMessage(this.messages.discord.scramble.timingCountdown, { delay: this.options.scrambleAnnouncementDelay });
        const timeoutSec = this.options.scrambleConfirmationTimeout || 60;
        await message.reply(this.formatMessage(this.messages.discord.scramble.confirmPrompt, {
          scrambleKind,
          timing,
          timeoutSec
        }));
        return;
      }

      if (!hasDry) {
        const immediateMsgKey = hasElo ? 'immediateManualMicroScramble' : 'immediateManualScramble';
        const announcementMsgKey = hasElo ? 'manualMicroScrambleAnnouncement' : 'manualScrambleAnnouncement';
        const broadcastMsg = hasNow
          ? `${this.RconMessages.prefix} ${this.RconMessages[immediateMsgKey]}`
          : `${this.RconMessages.prefix} ${this.formatMessage(
              this.RconMessages[announcementMsgKey],
              { delay: this.options.scrambleAnnouncementDelay }
            )}`;
        try {
          await this.server.rcon.broadcast(broadcastMsg);
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastError, {
            error: err?.message || err
          }));
        }
      }

      const microLabel = hasElo ? 'micro ' : '';
      const actionDesc = hasDry 
        ? this.formatMessage(this.messages.discord.scramble.actionDryRun, { microLabel })
        : hasNow 
          ? this.formatMessage(this.messages.discord.scramble.actionImmediate, { microLabel })
          : this.formatMessage(this.messages.discord.scramble.actionCountdown, { microLabel });
      
      let replyMsg = this.formatMessage(this.messages.discord.scramble.initiating, { actionDesc });
      if (!hasDry && !hasNow) {
        replyMsg += `\n${this.formatMessage(this.messages.discord.scramble.initiatingCountdownSuffix, {
          delay: this.options.scrambleAnnouncementDelay
        })}`;
      }
      await message.reply(replyMsg);
      const success = await this.initiateScramble(hasDry, hasDry || hasNow, null, null, null, scrambleType);
      if (!success) await message.reply(this.messages.discord.scramble.initiateFailed);
    }
  }

  async discordCommandToggle(message, state) {
    if (state === 'on') {
      if (!this.manuallyDisabled) return message.reply(this.messages.discord.toggle.alreadyEnabled);
      this.manuallyDisabled = false;
      if (this.db) {
        try {
          await this.db.saveManuallyDisabledState(false);
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbPersistEnabledFailed, { error: err.message }));
        }
      }
      await message.reply(`✅ ${this.enableConfirmationText()}`);
      await this.server.rcon.broadcast(`${this.RconMessages.prefix} ${this.RconMessages.system.trackingEnabled}`);
      this.mirrorRconToDiscord(this.RconMessages.system.trackingEnabled, 'info');
    } else {
      if (this.manuallyDisabled) return message.reply(this.messages.discord.toggle.alreadyDisabled);
      this.manuallyDisabled = true;
      if (this.db) {
        try {
          await this.db.saveManuallyDisabledState(true);
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbPersistDisabledFailed, { error: err.message }));
        }
      }
      await message.reply(`${this.messages.discord.toggle.disabledSuccess}${this.seedScrambleOffNote()}`);
      await this.resetStreak(this.messages.system.reasons.manualDisableDiscord);
      await this.server.rcon.broadcast(`${this.RconMessages.prefix} ${this.RconMessages.system.trackingDisabled}`);
      this.mirrorRconToDiscord(this.RconMessages.system.trackingDisabled, 'info');
    }
  }

  // ╔═══════════════════════════════════════╗
  // ║         ROUND EVENT HANDLERS          ║
  // ╚═══════════════════════════════════════╝


  /**
   * Triggered when the new map finishes loading and staging begins (NOT when staging ends).
   * Per SquadJS plugin dev reference: NEW_GAME fires ~260 seconds before "Live" combat actually starts.
   * At this moment, players' teamIDs may be null (unresolved by RCON). Wait ~30s before relying on team state.
   */
  async onNewGame(data) {
    if (!this.ready) return;
    try {
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.onNewGameTriggered, {
        data: JSON.stringify(data)
      }));
      
      // Layer info always served from S³ gameState; standalone polling removed in Stage 4.
      // Reset cached mode/layer so a stale value doesn't bleed into the next round's isInvasion check.
      this.gameModeCached = null;
      this.layerNameCached = null;
      this._scrambleInProgress = false;
      // A countdown armed in the previous round must not fire into this one: teams are freshly assigned
      // at NEW_GAME (teamIDs stay null for 30-60s), so it would scramble the wrong round. Driven off the
      // timer handle, not _scramblePending — resetStreak() clears that flag while the timer still runs.
      // Level 1, not 2: players were already told a scramble was coming and it silently is not. That
      // is the one signal an operator has to tune the announcement delays against, so it belongs in
      // the default log output — a too-long delay does not postpone the scramble, it cancels it.
      if (this._clearPendingScrambleCountdown()) {
        Logger.verbose('TeamBalancer', 1, this.messages.system.verbose.discardedPendingScrambleNewGame);
      }

      // Discard any armed "!scramble matchend" — a new round has started without consuming it.
      if (this._scrambleOnRoundEnd) {
        const armedBy = this._scrambleOnRoundEndBy;
        Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.discardedMatchEndArmNewGame, {
          name: armedBy?.name || 'unknown'
        }));
        await this._setScrambleArm(null);
        await this._notifyScrambleDiscarded(armedBy, this.messages.system.broadcasts.armDiscardedNewGameReason);
      }

      try {
        const flippedTeam = this.winStreakTeam === 1 ? 2 : this.winStreakTeam === 2 ? 1 : null;
        const flippedConTeam = this.consecutiveWinsTeam === 1 ? 2 : this.consecutiveWinsTeam === 2 ? 1 : null;
        const dbRes = await this.db.saveState(flippedTeam, this.winStreakCount, flippedConTeam, this.consecutiveWinsCount);
        if (dbRes) {
          this.winStreakTeam = dbRes.winStreakTeam;
          this.winStreakCount = dbRes.winStreakCount;
          this.consecutiveWinsTeam = dbRes.consecutiveWinsTeam;
          this.consecutiveWinsCount = dbRes.consecutiveWinsCount;
          this.lastSyncTimestamp = dbRes.lastSyncTimestamp;
        }
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.onNewGameSaveStateFailed, { error: err.message }));
      }
    } catch (err) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.onNewGameError, { error: err.message }));
      this.winStreakTeam = null;
      this.winStreakCount = 0;
      try {
        const dbRes = await this.db.saveState(null, 0);
        this.winStreakTeam = null;
        this.winStreakCount = 0;
        this.consecutiveWinsTeam = null;
        this.consecutiveWinsCount = 0;
        if (dbRes) this.lastSyncTimestamp = dbRes.lastSyncTimestamp;
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.onNewGameFallbackSaveStateFailed, { error: err.message }));
      }
      this._scrambleInProgress = false;
      this._clearPendingScrambleCountdown();
      this.cleanupScrambleTracking();
    }
  }

  /**
   * Triggered immediately when a team hits zero tickets or the victory condition is met.
   * Note: This occurs before the AAR (After Action Report) scoreboard and voting screens.
   */
  async onRoundEnded(data) {
    if (!this.ready) return;

    // Re-entrancy guard. Every branch below awaits RCON/DB calls before it claims the round, so a
    // second ROUND_ENDED for the same round (a re-emitted log line, a log-reader reconnect) used to
    // slip into those windows and arm a second scramble — or arm the seed trigger while the
    // match-end path was still parked on its broadcast. Claiming synchronously here closes all of
    // those at once, which is why the individual blocks can keep the natural announce-then-arm order.
    if (this._roundEndInFlight) {
      Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.duplicateRoundEndedIgnored);
      return;
    }

    // Note: roundReport is initialized early to capture state. It is always written by the
    // finally block, even when the method returns early (draw, tracking disabled, ignored
    // mode) — those rounds are logged with the fields that were filled in before the return.
    const s3Players = this._s3?.players?.getAllPlayers?.();
    const s3PlayersCount = s3Players ? s3Players.length : 0;
    const gs = this._s3?.gameState;
    let roundReport = {
      ts: Date.now(),
      gameMode: gs?.getGamemode?.() || this.messages.system.labels.unknown,
      layerName: gs?.getLayerName?.() || this.messages.system.labels.unknown,
      playerCount: s3PlayersCount,
      winner: data && data.winner ? `Team ${data.winner.team}` : this.messages.system.labels.draw,
      scrambled: false,
      scrambleCondition: this.messages.system.labels.none
    };

    let winnerID = null;
    let isDominant = false;
    let isStomp = false;

    // Claimed here, not at the guard above: only the finally below releases it, so a throw in the
    // prologue would latch it forever and drop every later ROUND_ENDED. Nothing awaits between the
    // guard and this line, so the check-and-claim is still atomic.
    this._roundEndInFlight = true;

    try {
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.roundEndedEventReceived, {
        data: JSON.stringify(data)
      }));

      // Parse the outcome once, before any early-returning path below, so the finally block logs
      // the winner and tickets for EVERY round — an armed match-end scramble and a seed
      // auto-scramble return before the win-streak evaluation but are still reported in full.
      const outcome = this._parseRoundOutcome(data, roundReport);
      if (!isNaN(outcome.winnerID)) winnerID = outcome.winnerID;

      // ── "!scramble matchend" stale-arm guard + execution ──────────
      // Consumed FIRST, before any win-streak/disabled/ignored checks, so it fires
      // regardless of tracking state, match outcome (incl. draws), or ignored/seed modes.
      // The arm is stamped with S3's matchId at arm time; compare against the current
      // round's matchId to detect a restart that crossed a round boundary.
      if (this._scrambleOnRoundEnd) {
        const armedBy = this._scrambleOnRoundEndBy;
        const currentMatchId = this._s3?.gameState?.getMatchId?.();
        const armedMatchId = armedBy?.matchId ?? null;

        if (currentMatchId && armedMatchId && armedMatchId !== currentMatchId) {
          // Restart crossed a round boundary — the arm is stale. Discard it and fall
          // through so THIS round is evaluated normally by the win-streak path below.
          Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.discardedStaleMatchEndArmRoundEnded, {
            armedMatchId,
            currentMatchId
          }));
          await this._setScrambleArm(null);
          await this._notifyScrambleDiscarded(armedBy, this.messages.system.broadcasts.armDiscardedRestartReason);
        } else {
          // Same round — fire the deferred scramble.
          await this._setScrambleArm(null);
          const isMicro = armedBy?.scrambleType === 'EloDiff';

          // The early return below skips the main path, but the finally block still logs this
          // round — give the report a layer even when this round's own never resolved.
          this._applyLayerFallback(roundReport);
          roundReport.scrambled = true;
          roundReport.scrambleCondition = isMicro ? 'Match End (Manual Micro)' : 'Match End (Manual)';
          if (isMicro) roundReport.scrambleType = 'EloDiff';

          Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.firingMatchEndScramble, {
            microLabel: isMicro ? 'micro ' : '',
            name: armedBy?.name || 'unknown'
          }));
          const msg = isMicro
            ? `${this.RconMessages.prefix} ${this.formatMessage(this.RconMessages.manualMicroScrambleAnnouncement, {
                delay: this.options.scrambleAnnouncementDelay
              })}`
            : `${this.RconMessages.prefix} ${this.formatMessage(this.RconMessages.scrambleAnnouncement, {
                team: 'Match End',
                count: 0,
                margin: 0,
                delay: this.options.scrambleAnnouncementDelay
              })}`;
          try {
            await this.server.rcon.broadcast(msg);
          } catch (err) {
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastMatchEndAnnouncementFailed, {
              error: err.message
            }));
          }
          this.mirrorRconToDiscord(msg, 'warning');
          this.initiateScramble(false, false, null, null, null, isMicro ? 'EloDiff' : null).catch(err =>
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.initiateScrambleUnhandledError, {
              error: err.message
            }))
          );
          return; // Early return — the finally block still logs this round.
        }
      }

      // Seed auto-scramble: fires on any Seed round end, independent of win-streak tracking or
      // ignored mode settings. isSeedMode() excludes Jensen/Training rounds naturally. Consumed
      // after the armed match-end scramble so an admin's explicit command wins.
      // Gated on manuallyDisabled: "!teambalancer off" is the admin kill switch. Note the
      // asymmetry — enableWinStreakTracking is about STREAKS and never governed seeding.
      // The layer fallback has deliberately NOT run yet — a round whose own layer never resolved
      // must not be shuffled on the strength of the previous round's layer.
      if (this._s3?.gameState?.isSeedMode?.() && this.options.enableSeedAutoScramble && !this.manuallyDisabled) {
        // Don't announce or claim attribution for a scramble initiateScramble would refuse — but a
        // Seed round still never feeds the streak, so clear it on the way out.
        if (this._scramblePending || this._scrambleInProgress) {
          Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.seedAutoScrambleSkipped);
          await this.resetStreak(this.messages.system.reasons.seedEndedPendingScramble);
          return;
        }
        roundReport.scrambled = true;
        roundReport.scrambleCondition = 'Seed Auto Scramble';
        Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.seedMatchEndedScrambling, {
          count: this.server.players.length
        }));
        // Bound once and used for the announcement AND the countdown — the text must never quote a
        // delay the timer does not actually run on.
        const seedDelay = this.options.seedScrambleAnnouncementDelay;
        const msg = `${this.RconMessages.prefix} ${this.formatMessage(this.RconMessages.seedScrambleAnnouncement, { delay: seedDelay })}`;
        try {
          await this.server.rcon.broadcast(msg);
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastSeedScrambleFailed, {
            error: err.message
          }));
        }
        this.mirrorRconToDiscord(msg, 'warning');
        this.initiateScramble(false, false, null, null, seedDelay).catch(err =>
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.initiateScrambleUnhandledError, {
            error: err.message
          }))
        );
        // Seed rounds never feed the streak, so clear it here rather than leaving it to
        // executeScramble — that reset is skipped when the scrambler returns an empty plan.
        await this.resetStreak(this.messages.system.reasons.seedEnded);
        return;
      }

      if (!this.options.enableWinStreakTracking || this.manuallyDisabled) {
        Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.winStreakTrackingDisabledSkipping);
        return;
      }

      // Layer reads are served from S³ gameState (standalone polling removed in Stage 4)
      // Only now: everything below reads the layer for thresholds, ignored-mode matching and the
      // report, all of which tolerate the previous round's layer as a guess.
      this._applyLayerFallback(roundReport);

      // Check for Draw (Winner is null)
      if (!data || !data.winner) {
        Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.roundEndedDraw);
        const msg = `${this.RconMessages.prefix} ${this.RconMessages.draw}`;
        try {
          await this.server.rcon.broadcast(msg);
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastDrawFailed, {
            error: err.message
          }));
        }
        this.mirrorRconToDiscord(msg, 'info');
        return await this.resetStreak(this.messages.system.reasons.draw);
      }

      // Already parsed into the report above; the win-streak evaluation needs it complete.
      const { winnerTickets, loserTickets, margin, winnerName, loserName } = outcome;
      if (isNaN(outcome.winnerID) || isNaN(winnerTickets) || isNaN(loserTickets)) {
        Logger.verbose('TeamBalancer', 1, this.messages.system.errors.parseRoundEndDataFailed);
        return;
      }

      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.parsedRoundOutcome, {
        winnerID,
        winnerTickets,
        loserTickets,
        margin
      }));

      const gameMode = this._s3?.gameState?.getGamemode?.()?.toLowerCase() || '';

      if (this.isIgnoredMatch()) {
        Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.ignoredMatchEnded, {
          gamemode: this.gameModeCached,
          layerName: this.layerNameCached
        }));

        // Reached only when no seed auto-scramble fired — that path returned above.
        let broadcastWinnerName = winnerName;
        let broadcastLoserName = loserName;
        if (!this.options.useGenericTeamNamesInBroadcasts) {
          if (!/^The\s+/i.test(winnerName) && !winnerName.startsWith('Team ')) broadcastWinnerName = 'The ' + winnerName;
          if (!/^The\s+/i.test(loserName) && !loserName.startsWith('Team ')) broadcastLoserName = 'The ' + loserName;
        }
        const msg = `${this.RconMessages.prefix} ${broadcastWinnerName} defeated ${broadcastLoserName} | (${margin} tickets)`;
        try {
          await this.server.rcon.broadcast(msg);
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastStandardSeedWinFailed, {
            error: err.message
          }));
        }
        this.mirrorRconToDiscord(msg, 'info');

        await this.resetStreak(this.messages.system.reasons.ignoredMatchEnded);
        return;
      }

      // ── Consecutive Wins Tracking ──────────────────────────────
      // Track every non-ignored win regardless of margin.
      if (this.consecutiveWinsTeam === winnerID) {
        this.consecutiveWinsCount++;
      } else {
        this.consecutiveWinsTeam = winnerID;
        this.consecutiveWinsCount = 1;
      }
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.consecutiveWinsUpdated, {
        team: this.consecutiveWinsTeam,
        count: this.consecutiveWinsCount
      }));

      // Persist consecutive state immediately so it survives a crash before the
      // dominant path commits.
      try {
        const dbRes = await this.db.saveState(this.winStreakTeam, this.winStreakCount, this.consecutiveWinsTeam, this.consecutiveWinsCount);
        if (dbRes) {
          this.consecutiveWinsTeam = dbRes.consecutiveWinsTeam;
          this.consecutiveWinsCount = dbRes.consecutiveWinsCount;
        }
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.consecutiveSaveStateFailed, {
          error: err.message
        }));
      }

      // ── Consecutive Wins Scramble Check ────────────────────────
      if (!this._scramblePending && !this._scrambleInProgress) {
        if (this.options.maxConsecutiveWinsWithoutThreshold > 0 && this.consecutiveWinsCount >= this.options.maxConsecutiveWinsWithoutThreshold) {
          roundReport.scrambled = true;
          roundReport.scrambleCondition = 'Consecutive Wins';
          Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.consecutiveWinsTriggered, {
            count: this.consecutiveWinsCount,
            threshold: this.options.maxConsecutiveWinsWithoutThreshold
          }));
          const msg = `${this.RconMessages.prefix} ${this.formatMessage(this.RconMessages.consecutiveWinsScramble, {
            team: this.getTeamName(winnerID),
            count: this.consecutiveWinsCount,
            delay: this.options.scrambleAnnouncementDelay
          })}`;
          try {
            await this.server.rcon.broadcast(msg);
          } catch (broadcastErr) {
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastConsecutiveWinsFailed, {
              error: broadcastErr.message
            }));
          }
          this.mirrorRconToDiscord(msg, 'warning');
          this.initiateScramble(false, false).catch(err =>
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.initiateScrambleUnhandledError, {
              error: err.message
            }))
          );
          return; // Scramble triggered — skip dominant/non-dominant evaluation
        }
      }

      let broadcastWinnerName = winnerName;
      let broadcastLoserName = loserName;
      if (!this.options.useGenericTeamNamesInBroadcasts) {
        if (!/^The\s+/i.test(winnerName) && !winnerName.startsWith('Team ')) {
          broadcastWinnerName = 'The ' + winnerName;
        }
        if (!/^The\s+/i.test(loserName) && !loserName.startsWith('Team ')) {
          broadcastLoserName = 'The ' + loserName;
        }
      }

      const isInvasion = gameMode.includes('invasion');

      // ── Single Round Scramble Check ────────────────────────────
      // Triggers on a single massive-margin round regardless of streak.
      if (!this._scramblePending && !this._scrambleInProgress) {
        if (this.options.enableSingleRoundScramble && !isInvasion && margin >= this.options.singleRoundScrambleThreshold) {
          roundReport.scrambled = true;
          roundReport.scrambleCondition = 'Single Round Margin';
          Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.singleRoundScrambleTriggered, {
            margin,
            threshold: this.options.singleRoundScrambleThreshold
          }));
          const msg = `${this.RconMessages.prefix} ${this.formatMessage(this.RconMessages.singleRoundScramble, {
            margin,
            delay: this.options.scrambleAnnouncementDelay
          })}`;
          try {
            await this.server.rcon.broadcast(msg);
          } catch (broadcastErr) {
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastSingleRoundFailed, {
              error: broadcastErr.message
            }));
          }
          this.mirrorRconToDiscord(msg, 'warning');
          this.initiateScramble(false, false).catch(err =>
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.initiateScrambleUnhandledError, {
              error: err.message
            }))
          );
          return; // Scramble triggered — skip dominant/non-dominant evaluation
        }
      }

      // ── Elo-Diff Scramble Check ─────────────────────────────────
      // Scheduled here — before the dominant/non-dominant fork, unconditional on isDominant —
      // so it stays reachable on both forks: the non-dominant branch returns before the
      // win-streak check ever runs (below), and non-dominant wins are exactly the rounds this
      // trigger needs to catch. The actual scramble decision is deferred to
      // _evaluateEloDiffTrigger(), once EloTracker's per-round ratings-committed promise
      // resolves — nothing here decides anything synchronously, and a same-round win-streak
      // scramble racing ahead of that resolution is exactly what makes this trigger lowest
      // effective precedence — the other three arm synchronously within this same call and
      // will already hold _scramblePending/_scrambleInProgress by the time this one resolves.
      // isSeedMode() is checked explicitly here, independent of enableSeedAutoScramble — this
      // trigger must never fire on a Seed round regardless of that option.
      if (this.options.enableEloDiffScramble && !this._s3?.gameState?.isSeedMode?.()) {
        const eloTrackerPlugin = this.server.plugins?.find(p => p.constructor.name === 'EloTracker');
        if (eloTrackerPlugin?.awaitRatingsCommitted) {
          const currentPlayers = this._s3?.players?.getAllPlayers?.() ?? this.server.players ?? [];
          const team1EosIDs = currentPlayers.filter(p => String(p.teamID) === '1').map(p => p.eosID);
          const team2EosIDs = currentPlayers.filter(p => String(p.teamID) === '2').map(p => p.eosID);
          const ticketMargin = margin;
          eloTrackerPlugin.awaitRatingsCommitted().then(({ snapshot }) =>
            this._evaluateEloDiffTrigger({ team1EosIDs, team2EosIDs, ticketMargin, snapshot })
          ).catch(err =>
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.eloDiffUnhandledError, {
              error: err.message
            }))
          );
        }
      }

      // ── Dominant Win Detection ─────────────────────────────────
      // Determine whether the ticket margin crosses the dominant threshold.
      const dominantThreshold = this.options.minTicketsToCountAsDominantWin ?? 175;
      const stompThreshold = Math.floor(dominantThreshold * 1.5);

      if (isInvasion) {
        const invasionAttackThreshold = this.options.invasionAttackTeamThreshold ?? 300;
        const invasionDefenceThreshold = this.options.invasionDefenceTeamThreshold ?? 650;
        if (
          (winnerID === 1 && margin >= invasionAttackThreshold) ||
          (winnerID === 2 && margin >= invasionDefenceThreshold)
        ) {
          isDominant = true;
          isStomp = true; // Treat invasion dominant as stomp for messaging
        }
      } else {
        isDominant = margin >= dominantThreshold;
        isStomp = margin >= stompThreshold;
      }
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.dominanceState, {
        isDominant,
        isStomp
      }));

      const teamNames = { winnerName: broadcastWinnerName, loserName: broadcastLoserName };
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.finalTeamNamesBroadcast, {
        winnerName: teamNames.winnerName,
        loserName: teamNames.loserName
      }));

      if (!isDominant) {
        Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.handlingNonDominantBranch);
        if (this.options.showWinStreakMessages) {
          let template;

          if (this.winStreakTeam && this.winStreakTeam !== winnerID) {
            template = this.RconMessages.nonDominant.streakBroken;
          } else if (isInvasion) {
            template =
              winnerID === 1
                ? this.RconMessages.nonDominant.invasionAttackWin
                : this.RconMessages.nonDominant.invasionDefendWin;
          } else {
            const threshold = this.options.minTicketsToCountAsDominantWin ?? 175;

            const veryCloseCutoff = Math.floor(threshold * 0.11);
            const closeCutoff = Math.floor(threshold * 0.45);
            const tacticalCutoff = Math.floor(threshold * 0.68);

            if (margin < veryCloseCutoff) {
              template = this.RconMessages.nonDominant.narrowVictory;
            } else if (margin < closeCutoff) {
              template = this.RconMessages.nonDominant.marginalVictory;
            } else if (margin < tacticalCutoff) {
              template = this.RconMessages.nonDominant.tacticalAdvantage;
            } else {
              template = this.RconMessages.nonDominant.operationalSuperiority;
            }
          }
          Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.usingTemplateNonDominant, { template }));

          const message = `${this.RconMessages.prefix} ${this.formatMessage(template, {
            team: teamNames.winnerName,
            loser: teamNames.loserName,
            margin
          })}`;
          Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.broadcastingNonDominantMessage, { message }));
          try {
            await this.server.rcon.broadcast(message);
          } catch (broadcastErr) {
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastNonDominantFailed, {
              error: broadcastErr.message
            }));
          }
          this.mirrorRconToDiscord(message, 'info');
        }
        return await this.resetStreak(this.formatMessage(this.messages.system.reasons.nonDominantWin, { winnerID }), false);
      }

      Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.dominantWinDetectedStandard);
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.currentStreakState, {
        winStreakTeam: this.winStreakTeam,
        winStreakCount: this.winStreakCount
      }));

      const streakBroken = this.winStreakTeam && this.winStreakTeam !== winnerID;
      if (streakBroken) {
        Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.streakBrokenPreviousTeam, {
          team: this.winStreakTeam
        }));
        await this.resetStreak(this.messages.system.reasons.streakBrokenOpposing, false);
      }

      try {
        const dbRes = await this.db.incrementStreak(winnerID, this.consecutiveWinsTeam, this.consecutiveWinsCount);
        if (dbRes) {
          this.winStreakTeam = dbRes.winStreakTeam;
          this.winStreakCount = dbRes.winStreakCount;
          this.consecutiveWinsTeam = dbRes.consecutiveWinsTeam;
          this.consecutiveWinsCount = dbRes.consecutiveWinsCount;
          this.lastSyncTimestamp = dbRes.lastSyncTimestamp;
        } else {
          // Fallback if DB fails
          this.winStreakTeam = winnerID;
          this.winStreakCount++;
        }
        Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.newWinStreakStarted, {
          team: this.winStreakTeam,
          count: this.winStreakCount
        }));
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.incrementStreakFailed, {
          error: err.message
        }));
      }

      const targetReportChannel = this.discordReportChannel || this.discordChannel;
      if (targetReportChannel && isDominant) {
        DiscordHelpers.sendDiscordMessage(targetReportChannel, {
          embeds: [DiscordHelpers.buildWinStreakEmbed(
            teamNames.winnerName,
            winnerID,
            this.winStreakCount,
            this.options.maxWinStreak,
            margin,
            true
          )]
        });
      }

      const scrambleComing = this.winStreakCount >= this.options.maxWinStreak;
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.scrambleCheckStreak, {
        count: this.winStreakCount,
        max: this.options.maxWinStreak,
        scrambleComing
      }));

      if (this.options.showWinStreakMessages && !scrambleComing) {
        let template;

        if (isInvasion) {
          template =
            winnerID === 1
              ? this.RconMessages.dominant.invasionAttackStomp
              : this.RconMessages.dominant.invasionDefendStomp;
        } else if (isStomp) {
          template = this.RconMessages.dominant.stomped;
        } else {
          template = this.RconMessages.dominant.steamrolled;
        }
        Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.usingTemplateDominant, { template }));

        const message = `${this.RconMessages.prefix} ${this.formatMessage(template, {
          team: teamNames.winnerName,
          loser: teamNames.loserName,
          margin
        })}`;
        Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.broadcastingDominantMessage, { message }));
        try {
          await this.server.rcon.broadcast(message);
        } catch (broadcastErr) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastDominantFailed, {
            error: broadcastErr.message
          }));
        }
        this.mirrorRconToDiscord(message, 'info');
      }

      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.evaluatingScrambleTrigger, {
        count: this.winStreakCount,
        team: this.winStreakTeam,
        margin
      }));
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.scramblePendingState, {
        pending: this._scramblePending,
        inProgress: this._scrambleInProgress
      }));

      if (this._scramblePending || this._scrambleInProgress) return;

      if (this.winStreakCount >= this.options.maxWinStreak) {
        roundReport.scrambled = true;
        roundReport.scrambleCondition = 'Win Streak Threshold';
        Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.scrambleConditionMetPreparingAnnouncement);
        const message = this.formatMessage(this.RconMessages.scrambleAnnouncement, {
          team: teamNames.winnerName,
          count: this.winStreakCount,
          margin,
          delay: this.options.scrambleAnnouncementDelay
        });
        Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.scrambleAnnouncementMessage, { message }));
        try {
          await this.server.rcon.broadcast(`${this.RconMessages.prefix} ${message}`);
        } catch (broadcastErr) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastScrambleAnnouncementFailed, {
            error: broadcastErr.message
          }));
        }
        this.mirrorRconToDiscord(`${this.RconMessages.prefix} ${message}`, 'warning');
        const targetReportChannel = this.discordReportChannel || this.discordChannel;
        if (targetReportChannel) {
          DiscordHelpers.sendDiscordMessage(targetReportChannel, { 
            embeds: [DiscordHelpers.buildScrambleTriggeredEmbed(
              this.messages.discord.embeds.winStreakThresholdReached, 
              teamNames.winnerName, 
              this.winStreakCount, 
              this.options.scrambleAnnouncementDelay
            )] 
          });
        }
        this.initiateScramble(false, false).catch(err =>
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.initiateScrambleUnhandledError, {
            error: err.message
          }))
        );
      }
    } catch (err) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.onRoundEndedError, {
        error: err.message
      }));      
      
      const targetReportChannel = this.discordReportChannel || this.discordChannel;
      if (targetReportChannel) {
        const embed = DiscordHelpers.buildFatalErrorEmbed(err, 'Round End Processing', this);
        DiscordHelpers.sendDiscordMessage(targetReportChannel, { embeds: [embed] });
      }

      this.winStreakTeam = null;
      this.winStreakCount = 0;
      this._scrambleInProgress = false;
      this._clearPendingScrambleCountdown();
      this.cleanupScrambleTracking();
    } finally {
      this._roundEndInFlight = false;
      roundReport.isDominantWin = isDominant ?? null;
      roundReport.winStreak = this.winStreakCount;
      roundReport.consecutiveWins = this.consecutiveWinsCount;

      let eloLogString = '';
      try {
        const eloTrackerPlugin = this.server.plugins?.find(p => p.constructor.name === 'EloTracker');
        if (eloTrackerPlugin) {
          let eloMap = eloTrackerPlugin.lastRoundSnapshot;
          if (!eloMap || eloMap.size === 0) {
            if (eloTrackerPlugin.eloCache && eloTrackerPlugin.eloCache.size > 0) {
              eloMap = eloTrackerPlugin.eloCache;
            } else if (typeof eloTrackerPlugin.getRatingsByEosIDs === 'function') {
              const eosIDs = this.server.players.map(p => p.eosID);
              eloMap = await eloTrackerPlugin.getRatingsByEosIDs(eosIDs);
            }
          }

          if (eloMap) {
            let t1Mu = 0, t2Mu = 0, t1Regs = 0, t2Regs = 0;
            let t1Count = 0, t2Count = 0;
            const threshold = eloTrackerPlugin.thresholds?.regularMinGames || 10;
            const defaultMu = eloTrackerPlugin.options?.defaultMu || 25.0;

            for (const p of this.server.players) {
              const rating = eloMap.get(p.eosID);
              const mu = rating ? rating.mu : defaultMu;
              const roundsPlayed = rating ? (rating.roundsPlayed || 0) : 0;
              const isReg = roundsPlayed >= threshold;

              if (String(p.teamID) === '1') {
                t1Mu += mu;
                t1Count++;
                if (isReg) t1Regs++;
              } else if (String(p.teamID) === '2') {
                t2Mu += mu;
                t2Count++;
                if (isReg) t2Regs++;
              }
            }

            roundReport.team1AvgMu = t1Count > 0 ? (t1Mu / t1Count) : defaultMu;
            roundReport.team2AvgMu = t2Count > 0 ? (t2Mu / t2Count) : defaultMu;
            roundReport.team1Regs = t1Regs;
            roundReport.team2Regs = t2Regs;
            roundReport.muDelta = Math.abs(roundReport.team1AvgMu - roundReport.team2AvgMu);
            roundReport.regDelta = Math.abs(t1Regs - t2Regs);
            
            eloLogString = this.formatMessage(this.messages.system.verbose.eloLogString, {
              muDelta: roundReport.muDelta.toFixed(2),
              regDelta: roundReport.regDelta
            });
          }
        }
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.appendEloDataFailed, {
          error: err.message
        }));
      }

      // Log to console
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.roundReportConsole, {
        layerName: roundReport.layerName,
        gameMode: roundReport.gameMode,
        playerCount: roundReport.playerCount,
        winner: roundReport.winnerName || roundReport.winner,
        winnerTickets: roundReport.winnerTickets,
        loserTickets: roundReport.loserTickets,
        ticketMargin: roundReport.ticketMargin,
        scrambled: roundReport.scrambled,
        scrambleCondition: roundReport.scrambleCondition,
        winStreak: roundReport.winStreak,
        eloLogString
      }));

      // Log to JSONL
      try {
        const logPath = path.resolve(process.cwd(), this.options.reportLogPath || 'team-balancer-reports.jsonl');
        await fs.promises.appendFile(logPath, JSON.stringify(roundReport) + '\n');
      } catch (logErr) {
        Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.writeJsonlReportFailed, {
          error: logErr.message
        }));
      }

      // Log to database
      if (this.options.enableDatabaseLogging) {
        // Read matchId and roundStartTime from S³ GameStateService
        const gs = this._s3?.gameState;
        const roundStartTime = gs?.isReady() ? (gs.getRoundStartTime?.() ?? null) : null;
        const matchId = gs?.isReady() ? gs.getMatchId?.() : undefined;

        this.db.insertRoundReport({
          ts: roundReport.ts,
          matchId: matchId,
          roundStartTime: roundStartTime,
          layerName: roundReport.layerName,
          gameMode: roundReport.gameMode,
          playerCount: roundReport.playerCount,
          winningTeamID: winnerID ?? null,
          winnerName: roundReport.winnerName ?? null,
          loserName: roundReport.loserName ?? null,
          winnerTickets: roundReport.winnerTickets ?? null,
          loserTickets: roundReport.loserTickets ?? null,
          ticketMargin: roundReport.ticketMargin ?? null,
          isDominantWin: roundReport.isDominantWin ?? null,
          winStreakTeam: this.winStreakTeam,
          winStreakCount: this.winStreakCount,
          consecutiveWinsTeam: this.consecutiveWinsTeam,
          consecutiveWinsCount: this.consecutiveWinsCount,
          scrambled: roundReport.scrambled ?? false,
          scrambleCondition: roundReport.scrambleCondition ?? null,
          scrambleType: roundReport.scrambleType ?? null
        }).catch(err =>
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbInsertRoundReportFailed, {
            error: err.message
          }))
        );
      }
    }
  }

  async resetStreak(reason = 'unspecified', resetConsecutive = true) {
    Logger.verbose('TeamBalancer', 4, `Resetting streak: ${reason}`);
    try {
      const dbRes = await this.db.saveState(
        null, 
        0, 
        resetConsecutive ? null : this.consecutiveWinsTeam, 
        resetConsecutive ? 0 : this.consecutiveWinsCount
      );
      this.winStreakTeam = null;
      this.winStreakCount = 0;
      if (resetConsecutive) {
        this.consecutiveWinsTeam = null;
        this.consecutiveWinsCount = 0;
      }
      if (dbRes) this.lastSyncTimestamp = dbRes.lastSyncTimestamp;
    } catch (err) {
      Logger.verbose('TeamBalancer', 1, `[DB] resetStreak saveState failed: ${err.message}`);
    }
  }

  /**
   * Resolves the Elo-diff micro-scramble trigger once EloTracker's per-round ratings-committed
   * promise resolves. Computes the average mu gap between the rosters captured at scheduling
   * time (in onRoundEnded()) against the resolved snapshot, and arms a 'EloDiff'-typed scramble
   * if the gap clears eloDiffScrambleThreshold. The armed-gate on the announcement broadcast is
   * deliberate: broadcasting before initiateScramble() resolves would show a phantom
   * announcement whenever this trigger loses the race to a same-round win-streak scramble,
   * which is the designed (not rare) outcome of this trigger's precedence.
   */
  async _evaluateEloDiffTrigger({ team1EosIDs, team2EosIDs, ticketMargin, snapshot }) {
    const defaultMu = 25.0;
    const avgMu = (eosIDs) => {
      if (!eosIDs || eosIDs.length === 0) return defaultMu;
      let total = 0;
      for (const eosID of eosIDs) {
        const rating = snapshot?.get?.(eosID);
        total += rating ? rating.mu : defaultMu;
      }
      return total / eosIDs.length;
    };

    const avgTeam1Mu = avgMu(team1EosIDs);
    const avgTeam2Mu = avgMu(team2EosIDs);
    const diff = Math.abs(avgTeam1Mu - avgTeam2Mu);

    Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.eloDiffEvaluated, {
      avgTeam1Mu: avgTeam1Mu.toFixed(2),
      avgTeam2Mu: avgTeam2Mu.toFixed(2),
      diff: diff.toFixed(2),
      threshold: this.options.eloDiffScrambleThreshold
    }));

    if (diff < this.options.eloDiffScrambleThreshold) return;

    Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.eloDiffTriggered, {
      diff: diff.toFixed(2),
      threshold: this.options.eloDiffScrambleThreshold
    }));

    // No separate _scramblePending/_scrambleInProgress pre-check — initiateScramble() already
    // re-checks that guard at the moment it matters, and its return value IS the check.
    const armed = await this.initiateScramble(false, false, null, null, null, 'EloDiff');
    if (!armed) {
      Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.eloDiffScrambleNotArmedCompetitor);
      return;
    }

    const msg = `${this.RconMessages.prefix} ${this.formatMessage(this.RconMessages.microScrambleAnnouncement, {
      margin: ticketMargin,
      delay: this.options.scrambleAnnouncementDelay
    })}`;
    try {
      await this.server.rcon.broadcast(msg);
    } catch (err) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastMicroScrambleFailed, {
        error: err.message
      }));
    }
    this.mirrorRconToDiscord(msg, 'warning');
  }

  // ╔═══════════════════════════════════════╗
  // ║        SCRAMBLE EXECUTION FLOW        ║
  // ╚═══════════════════════════════════════╝

  async initiateScramble(isSimulated = false, immediate = false, steamID = null, player = null, delaySeconds = null, scrambleType = null) {
    if (this._scramblePending || this._scrambleInProgress) {
      Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.scrambleInitiationBlocked);
      return false;
    }
    const adminName = player?.name || (steamID ? this.formatMessage(this.messages.system.labels.adminSteamID, { steamID }) : this.messages.system.labels.system);

    if (isSimulated) {
      Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.simulatingScrambleInitiated, { adminName }));
      this._pendingScrambleType = scrambleType;
      await this.executeScramble(true, steamID, player);
      return true;
    }

    if (!immediate) {
      this._scramblePending = true;
      this._pendingScrambleType = scrambleType;
      // Callers with a timing window of their own pass it in — the seed auto-scramble does, because
      // the gap between a Seed round ending and the map change is far shorter than the global delay
      // (and a countdown still armed at NEW_GAME is discarded, i.e. the scramble never happens).
      // ?? not ||, so a deliberately small delay is not thrown away as falsy.
      const delay = delaySeconds ?? this.options.scrambleAnnouncementDelay;
      this._scrambleCountdownTimeout = setTimeout(async () => {
        // Drop the handle first: a non-null handle must mean "a countdown is still armed", which is
        // what NEW_GAME/unmount/cancel check before tearing it down.
        this._scrambleCountdownTimeout = null;
        Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.scrambleCountdownFinished);
        await this.executeScramble(false, steamID, player);
      }, delay * 1000);
      return true;
    } else {
      Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.immediateLiveScrambleInitiated, { adminName }));
      this._pendingScrambleType = scrambleType;
      await this.executeScramble(false, steamID, player);
      return true;
    }
  }

  transformSquadJSData(squads, players) {
    Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.transformingSquadJSData);
    
    const normalizedSquads = (squads || []).filter(
      (squad) =>
        squad &&
        squad.squadID &&
        squad.teamID &&
        typeof squad.squadID !== 'undefined' &&
        typeof squad.teamID !== 'undefined'
    );

    // NOTE: Per SquadJS Plugin Dev Reference §3 (Null-TeamID Lifecycle):
    // At NEW_GAME, players' teamIDs can be null (unresolved by RCON) for 30-60 seconds.
    // On full servers (93+ players), this can affect up to 94+ players simultaneously.
    // We filter them out here (they cannot be moved without a valid teamID anyway).
    // If significant numbers are dropped, log a warning — this usually indicates
    // a manual scramble triggered shortly after NEW_GAME before RCON state resolved.
    const allValidPlayers = (players || []).filter(
      (player) =>
        player &&
        player.eosID &&
        typeof player.eosID === 'string' &&
        typeof player.teamID !== 'undefined'
    );

    const normalizedPlayers = allValidPlayers.filter((player) => player.teamID !== null);
    const droppedNullTeamPlayers = allValidPlayers.filter((player) => player.teamID === null);

    if (droppedNullTeamPlayers.length > 0) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.droppedNullTeamPlayersWarning, {
        count: droppedNullTeamPlayers.length
      }));
    }

    Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.transformInputValidation, {
      validSquads: normalizedSquads.length,
      validPlayers: normalizedPlayers.length,
      droppedClause: droppedNullTeamPlayers.length > 0 
        ? this.formatMessage(this.messages.system.verbose.droppedNullClause, { count: droppedNullTeamPlayers.length })
        : ''
    }));
    
    const squadPlayerMap = new Map();

    for (const player of normalizedPlayers) {
      if (player.squadID) {
        const squadKey = `T${player.teamID}-S${player.squadID}`;
        if (!squadPlayerMap.has(squadKey)) {
          squadPlayerMap.set(squadKey, []);
        }
        squadPlayerMap.get(squadKey).push(player.eosID);
      }
    }

    Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.squadPlayerMappingCreated, {
      count: squadPlayerMap.size
    }));
    
    const transformedSquads = normalizedSquads.map((squad) => {
      const squadKey = `T${squad.teamID}-S${squad.squadID}`;
      const playersInSquad = squadPlayerMap.get(squadKey) || [];

      const transformed = {
        id: squadKey, // Now unique (e.g., T1-S5)
        teamID: String(squad.teamID), // Ensure string format
        players: playersInSquad,
        locked: squad.locked === 'True' || squad.locked === true // Handle both string and boolean
      };

      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.transformedSquadDetail, {
        squadKey,
        count: playersInSquad.length,
        teamID: transformed.teamID,
        locked: transformed.locked
      }));

      return transformed;
    });
    
    const transformedPlayers = normalizedPlayers.map((player) => ({
      eosID: player.eosID,
      teamID: String(player.teamID), // Ensure string format
      squadID: player.squadID ? `T${player.teamID}-S${player.squadID}` : null
    }));

    Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.transformationComplete, {
      squadsCount: transformedSquads.length,
      playersCount: transformedPlayers.length
    }));
    
    if (transformedSquads.length > 0) {
      Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.sampleTransformedSquad, JSON.stringify(transformedSquads[0], null, 2));
    }
    if (transformedPlayers.length > 0) {
      Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.sampleTransformedPlayer, JSON.stringify(transformedPlayers[0], null, 2));
    }

    return {
      squads: transformedSquads,
      players: transformedPlayers
    };
  }

  /**
   * Average mu gap between teams after applying a candidate swap plan on top of transformedPlayers'
   * current teamID. Missing ratings fall back to defaultMu 25.0, same as the forced-churn hack.
   */
  _computePostSwapMuDiff(transformedPlayers, swapPlan, eloMap) {
    const defaultMu = 25.0;
    const moveMap = new Map((swapPlan || []).map(m => [m.eosID, m.targetTeamID]));
    let t1Mu = 0, t2Mu = 0, t1Count = 0, t2Count = 0;
    for (const p of transformedPlayers) {
      const finalTeamID = moveMap.get(p.eosID) ?? p.teamID;
      const rating = eloMap?.get?.(p.eosID);
      const mu = rating ? rating.mu : defaultMu;
      if (finalTeamID === '1') { t1Mu += mu; t1Count++; }
      else if (finalTeamID === '2') { t2Mu += mu; t2Count++; }
    }
    const avgT1 = t1Count > 0 ? t1Mu / t1Count : defaultMu;
    const avgT2 = t2Count > 0 ? t2Mu / t2Count : defaultMu;
    return Math.abs(avgT1 - avgT2);
  }

  /**
   * Escalating search for the Elo-diff micro scramble: starts at a 2-player move budget and
   * steps up by 2, calling the unmodified scrambler at each step and keeping the lowest post-swap
   * mu-diff plan found, stopping early once microScrambleParityTarget is reached. Capped at
   * microScrambleMaxMovePercent of the current round's population (both teams combined) — the
   * safety ceiling that stops the search climbing indefinitely against an unreachable target
   * (e.g. clan-cohesion constraints blocking every candidate swap). That cap is enforced on the
   * scrambler's actual return, not just the budget requested from it — squad atomicity
   * (SQUAD_FIT_GRACE, pullEntireSquads) can hand back more players than asked for, and any plan
   * that overshoots the ceiling is discarded rather than accepted.
   */
  async _runEloDiffMicroScrambleSearch({ transformedSquads, transformedPlayers, eloMap, clanGroups }) {
    // No ratings, no micro scramble — must never silently fall back to the default
    // scramblePercentage budget (a near-full scramble), which is exactly what this feature
    // exists to avoid. See "Second high-risk finding".
    if (!eloMap || eloMap.size === 0) {
      Logger.verbose('TeamBalancer', 1, this.messages.system.verbose.eloDiffNoRatingsSkipping);
      return [];
    }

    const population = transformedPlayers.length;
    const maxBudget = Math.ceil(this.options.microScrambleMaxMovePercent * population);
    const parityTarget = this.options.microScrambleParityTarget;

    let bestPlan = null;
    let bestDiff = Infinity;

    for (let budget = 2; budget <= maxBudget; budget += 2) {
      const plan = await Scrambler.scrambleTeamsPreservingSquads({
        squads: transformedSquads,
        players: transformedPlayers,
        winStreakTeam: this.winStreakTeam,
        scramblePercentage: this.options.scramblePercentage,
        debug: this.options.debugLogs,
        eloMap,
        minPlayersToMove: budget,
        maxPlayersToMove: budget,
        clanGroups,
        pullEntireSquads: this._s3?.clans?.options?.pullEntireSquads || false
      });

      // Squad atomicity (SQUAD_FIT_GRACE, pullEntireSquads) can hand back a plan larger than the
      // budget requested — the scrambler treats minPlayersToMove/maxPlayersToMove as a target it
      // tries to hit, not a hard cap. microScrambleMaxMovePercent is a safety ceiling on the
      // ACTUAL number of players moved, so an oversized plan is rejected outright rather than
      // accepted just because it happened to also reach parity.
      if (plan && plan.length > maxBudget) {
        Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.eloDiffBudgetExceededCeiling, {
          budget,
          planLength: plan.length,
          maxBudget
        }));
        continue;
      }

      const diff = this._computePostSwapMuDiff(transformedPlayers, plan, eloMap);
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.eloDiffBudgetPostSwapDiff, {
        budget,
        diff: diff.toFixed(3),
        planSize: plan?.length ?? 0
      }));

      if (plan && plan.length > 0 && diff < bestDiff) {
        bestDiff = diff;
        bestPlan = plan;
      }

      if (plan && plan.length > 0 && diff <= parityTarget) {
        return plan;
      }
    }

    return bestPlan || [];
  }

  async executeScramble(isSimulated = false, steamID = null, player = null) {
    // Captured then cleared immediately — same capture-then-clear pattern as EloTracker's
    // resolveRatingsCommitted, so a rejected/unrelated future scramble never inherits this value.
    const scrambleType = this._pendingScrambleType;
    this._pendingScrambleType = null;

    if (this._scrambleInProgress) {
      Logger.verbose('TeamBalancer', 1, this.messages.system.verbose.scrambleAlreadyInProgress);
      return false;
    }

    // Acquire S³ global lock before scramble (prevents SA from acting during TB scramble).
    //
    // IMPORTANT — use lockGlobal() directly, NOT isGloballyLockedBy() as a gate:
    //
    //   isGloballyLockedBy() returns truthy for ANY held lock regardless of priority,
    //   so a lower-priority transient lock (SmartAssign priority 2, e.g. a 5s join
    //   processing lock) would veto TeamBalancer (priority 3) outright. That is
    //   never acceptable — a scramble is the highest-priority operation.
    //
    //   lockGlobal() implements priority-based preemption: it returns true when
    //   the caller has priority >= any existing holder, which for TeamBalancer at
    //   priority 3 means it can always preempt SmartAssign or Switch. It only
    //   returns false when something of equal-or-higher priority already holds the
    //   lock (i.e. another TeamBalancer scramble). That is the only condition that
    //   should prevent a scramble from executing.
    let globalLockAcquired = false;
    if (this._s3?.players?.isReady() && !isSimulated) {
      const locked = this._s3.players.lockGlobal('TeamBalancer', this.options.maxScrambleCompletionTime + 5000);
      if (!locked) {
        Logger.verbose('TeamBalancer', 1, this.messages.system.verbose.globalLockDeniedEqualOrHigher);
        return false;
      }
      globalLockAcquired = true;
      Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.globalLockAcquired);
    }

    this._scrambleInProgress = true;    
    const adminName = player?.name || (steamID ? this.formatMessage(this.messages.system.labels.adminSteamID, { steamID }) : this.messages.system.labels.system);
    Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.scrambleStartedBy, { adminName }));

    let swapPlan = null;
    let preScrambleState = null;
    try {
      let broadcastMessage;
      if (isSimulated) {
        broadcastMessage = `${this.RconMessages.prefix} ${this.RconMessages.executeDryRunMessage.trim()}`;
        Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.simulatingScrambleInitiated, { adminName }));
      } else {
        broadcastMessage = `${this.RconMessages.prefix} ${this.RconMessages.executeScrambleMessage.trim()}`;
        Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.executingScrambleInitiated, { adminName }));
      }

      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.broadcastingMessage, { message: broadcastMessage }));      
      if (!isSimulated) {
        try {
          await this.server.rcon.broadcast(broadcastMessage);
        } catch (broadcastErr) {          
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastExecutionFailed, { error: broadcastErr.message }));
        }
        this.mirrorRconToDiscord(broadcastMessage, 'scramble');
      }

      // Scrambler input: prefer S³ players + squads, fall back to raw SquadJS data
      const hasS3Players = !!(this._s3?.players?.getAllPlayers);
      const scrambleInputPlayers = hasS3Players
        ? this._s3?.players.getAllPlayers()
        : this.server.players;
      const scrambleInputSquads = hasS3Players
        ? this._s3?.players.getSquads()
        : this.server.squads;
      const { squads: transformedSquads, players: transformedPlayers } = this.transformSquadJSData(
        scrambleInputSquads,
        scrambleInputPlayers
      );

      // Helper to build player info object
      const buildPlayerInfo = (eosID) => {
        const p = this.server.players.find(pl => pl.eosID === eosID);
        return {
          eosID,
          name: p?.name ?? this.messages.system.labels.unknownPlayer,
          steamID: p?.steamID ?? null
        };
      };

      // Capture pre-scramble state for JSON report (includes player names + eosIDs per squad)
      preScrambleState = {
        t1Squads: (scrambleInputSquads || [])
          .filter(s => String(s.teamID) === '1')
          .map(squad => ({
            squadID: squad.squadID,
            locked: squad.locked === 'True' || squad.locked === true,
            players: (squad.players || []).map(buildPlayerInfo)
          })),
        t2Squads: (scrambleInputSquads || [])
          .filter(s => String(s.teamID) === '2')
          .map(squad => ({
            squadID: squad.squadID,
            locked: squad.locked === 'True' || squad.locked === true,
            players: (squad.players || []).map(buildPlayerInfo)
          })),
        // Include players not in any squad (unassigned)
        t1Unassigned: (scrambleInputPlayers || [])
          .filter(p => String(p.teamID) === '1' && !p.squadID)
          .map(p => buildPlayerInfo(p.eosID)),
        t2Unassigned: (scrambleInputPlayers || [])
          .filter(p => String(p.teamID) === '2' && !p.squadID)
          .map(p => buildPlayerInfo(p.eosID)),
        unassigned: (scrambleInputPlayers || [])
          .filter(p => p.teamID === null || p.teamID === undefined)
          .map(p => buildPlayerInfo(p.eosID))
      };

      let eloMap = null;
      let minPlayersToMove = 0;
      let maxPlayersToMove = 0;

      // The Elo lookup for the 'EloDiff' micro-scramble path runs unconditionally, independent
      // of useEloForBalance — that option only governs whether the *existing three* triggers'
      // scrambles use Elo to steer swaps, and this execution mode is meaningless without
      // per-player ratings.
      if (scrambleType === 'EloDiff' || this.options.useEloForBalance) {
        const eloTrackerPlugin = this.server.plugins?.find(p => p.constructor.name === 'EloTracker');
        if (eloTrackerPlugin) {
          try {
            const snapshot = eloTrackerPlugin.lastRoundSnapshot;
            if (snapshot && snapshot.size > 0) {
              eloMap = snapshot;
              Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.eloUsingRoundSnapshot, { count: eloMap.size }));
            } else {
              const eosIDs = transformedPlayers.map(p => p.eosID);
              eloMap = await eloTrackerPlugin.getRatingsByEosIDs(eosIDs);
              Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.eloFallbackToDB, { count: eloMap.size }));
            }

            // --- Enforce 40-55 Person Scramble for Edge Cases ---
            // If teams are already extremely close in ELO (diff < 0.4), the scrambler
            // has no mathematical incentive to move players. To ensure a fresh match
            // feeling, we forcefully increase the churn bounds to a minimum of 40
            // and maximum of 55 players.
            // Skipped outright for scrambleType === 'EloDiff' by the guard below — that path
            // already confirmed diff >= eloDiffScrambleThreshold before arming, so recomputing
            // muDelta here to compare against this unrelated hack's own fixed 0.4 cutoff would
            // be redundant, not a correctness requirement.
            if (scrambleType !== 'EloDiff') {
              let t1Mu = 0, t2Mu = 0, t1Count = 0, t2Count = 0;
              const defaultMu = 25.0;
              for (const p of transformedPlayers) {
                const rating = eloMap.get(p.eosID);
                const mu = rating ? rating.mu : defaultMu;
                if (p.teamID === '1') { t1Mu += mu; t1Count++; }
                else if (p.teamID === '2') { t2Mu += mu; t2Count++; }
              }
              const avgT1 = t1Count > 0 ? (t1Mu / t1Count) : defaultMu;
              const avgT2 = t2Count > 0 ? (t2Mu / t2Count) : defaultMu;
              const muDelta = Math.abs(avgT1 - avgT2);

              if (muDelta < 0.4) {
                Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.eloSmallDiffEnforcingChurn, { muDelta: muDelta.toFixed(2) }));
                minPlayersToMove = 40;
                maxPlayersToMove = 55;
              }
            }

          } catch (err) {
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.eloFetchFailed, { error: err.message }));
            eloMap = null;
          }
        } else {
          Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.eloTrackerNotFound);
        }
      }

      let clanGroups = null;
      if (this._s3?.clans?.isEnabled?.()) {
        try {
          const playersForClans = this._s3?.players?.getAllPlayers
            ? this._s3?.players.getAllPlayers()
            : this.server.players;
          clanGroups = this._s3?.clans.extractClanGroups(playersForClans);
          // extractClanGroups uses getGroupingOptions() internally — no overrides needed
          const tagCount = Object.keys(clanGroups).length;
          if (tagCount > 0) {
            Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.clanGroupingExtracted, { count: tagCount }));
          } else {
            Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.clanGroupingNoQualifying);
          }
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.clanExtractionFailed, { error: err.message }));
          clanGroups = null;
        }
      }

      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.callingScramblerWithData, {
        squadsCount: transformedSquads.length,
        playersCount: transformedPlayers.length
      }));

      if (scrambleType === 'EloDiff') {
        // Micro scramble: an escalating search for the smallest move-count budget that reaches
        // parity, run live (against the current roster/squad state) rather than as an earlier
        // preview.
        swapPlan = await this._runEloDiffMicroScrambleSearch({
          transformedSquads,
          transformedPlayers,
          eloMap,
          clanGroups
        });
      } else {
        swapPlan = await Scrambler.scrambleTeamsPreservingSquads({
          squads: transformedSquads,
          players: transformedPlayers,
          winStreakTeam: this.winStreakTeam,
          scramblePercentage: this.options.scramblePercentage,
          debug: this.options.debugLogs,
          eloMap,
          minPlayersToMove,
          maxPlayersToMove,
          clanGroups,
          pullEntireSquads: this._s3?.clans?.options?.pullEntireSquads || false
        });
      }

      const targetReportChannel = this.discordReportChannel || this.discordChannel;
      // Dry runs (isSimulated=true) post to the admin command channel (this.discordChannel)
      // so the admin sees the plan inline with their !scramble dry command.
      // Live scrambles post to the report channel (targetReportChannel) for archival.
      const postChannel = isSimulated ? this.discordChannel : targetReportChannel;
      if (postChannel && this.options.postScrambleDetails) {
        const embed = await DiscordHelpers.createScrambleDetailsMessage(swapPlan, isSimulated, this, eloMap);
        DiscordHelpers.sendDiscordMessage(postChannel, { embeds: [embed] });
      }

      if (swapPlan && swapPlan.length > 0) {
        Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.dryRunMovesReturned, {
          count: swapPlan.length,
          calculationTime: swapPlan.calculationTime
        }));

        if (!isSimulated) {
          for (const move of swapPlan) {
            const player = this.server.players.find(p => p.eosID === move.eosID);
            if (!player) {
              Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.executePlayerNotFound, { eosID: move.eosID }));
              continue;
            }
            
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.attributionRecordMove, {
              name: player.name,
              steamID: player.steamID,
              sourceTeam: player.teamID,
              targetTeam: move.targetTeamID
            }));
            this._s3?.players?.recordMove(move.eosID, move.targetTeamID, 'Team-Balancer');
            
            await this.reliablePlayerMove(move.eosID, move.targetTeamID, isSimulated);
          }
          await this.waitForScrambleToFinish(this.options.maxScrambleCompletionTime);

          // ── Post-scramble lockdown (moved here from pre-execution) ──
          // The TEAM_BALANCER_SCRAMBLE_EXECUTED event is emitted AFTER all
          // moves complete rather than before, so we can verify which players
          // actually moved and exclude failures. The SwapExecutor's verifyMoves()
          // step identifies two categories:
          //   • Disconnected players — still locked (dodge prevention)
          //   • RCON-genuinely-failed players (on server, wrong team) — excluded
          // Only the latter appear in failedEosIDs; disconnected players
          // retain their lockdown via Switch's existing PlayerCooldowns row.
          const sessionReport = this.swapExecutor?.getLastSessionReport?.();
          const failedEosIDs = new Set(sessionReport?.failedEosIDs || []);
          const affectedPlayers = [];
          const failedPlayers = [];
          for (const move of swapPlan) {
            const player = this.server.players.find(p => p.eosID === move.eosID);
            if (!player) continue;
            if (failedEosIDs.has(move.eosID)) {
              failedPlayers.push({ eosID: player.eosID, steamID: player.steamID ?? null, name: player.name });
            } else {
              affectedPlayers.push({ eosID: player.eosID, steamID: player.steamID ?? null, name: player.name });
            }
          }
          // Emit when either list is non-empty. If every move fails, affectedPlayers
          // is empty but failedPlayers is not — Switch still needs to remediate.
          // Disconnected players are handled via S³ reconnect memory overwrite in
          // tb-swap-executor.js — no need to emit them here.
          if (affectedPlayers.length > 0 || failedPlayers.length > 0) {
            this.server.emit('TEAM_BALANCER_SCRAMBLE_EXECUTED', {
              affectedPlayers,
              failedPlayers,
              scrambleType
            });
          }

          const completeMessage = scrambleType === 'EloDiff'
            ? this.RconMessages.microScrambleCompleteMessage
            : this.RconMessages.scrambleCompleteMessage;
          const msg = `${this.RconMessages.prefix} ${completeMessage.trim()}`;
          Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.broadcastingMessage, { message: msg }));
          try {
            await this.server.rcon.broadcast(msg);
          } catch (broadcastErr) {
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastCompleteFailed, { error: broadcastErr.message }));
          }
          this.mirrorRconToDiscord(msg, 'success');
          const scrambleTimestamp = Date.now();
          this.lastScrambleTime = scrambleTimestamp;
          try {
            const res = await this.db.saveScrambleTime(scrambleTimestamp);
            if (res && res.lastScrambleTime) this.lastScrambleTime = res.lastScrambleTime;
          } catch (err) {
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.dbSaveScrambleTimeFailed, { error: err.message }));
          }
          // Do NOT reset win-streak state for the Elo-diff micro scramble — it moves a
          // deliberately small number of players and isn't trying to guarantee full parity, so a
          // persistent streak across rounds is still real signal for the existing triggers to
          // escalate on.
          if (scrambleType !== 'EloDiff') {
            await this.resetStreak(this.messages.system.reasons.postScrambleCleanup);
          }
        } else {
          Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.dryRunWouldHaveQueued, { count: swapPlan.length }));
          for (const move of swapPlan) {
            Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.dryRunMoveDetail, {
              eosID: move.eosID,
              targetTeamID: move.targetTeamID
            }));
          }
          Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.dryRunSuccessfulNoPlayersHarmed);
          Logger.verbose('TeamBalancer', 2, `${this.RconMessages.prefix} ${this.RconMessages.scrambleCompleteMessage.trim()}`);
        }
      } else {
        Logger.verbose('TeamBalancer', 2, this.messages.system.verbose.scramblerReturnedNoMoves);
        
        if (!isSimulated) {
          const msg = `${this.RconMessages.prefix} ${this.RconMessages.scrambleFailedMessage.trim()}`;
          Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.broadcastingMessage, { message: msg }));
          try {
            await this.server.rcon.broadcast(msg);
          } catch (broadcastErr) {
            Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastFailedMessageError, { error: broadcastErr.message }));
          }
          this.mirrorRconToDiscord(msg, 'warning');
          const targetReportChannel = this.discordReportChannel || this.discordChannel;
          // Same routing as the success path: dry run failures go to the admin command channel
          // (this.discordChannel), live scramble failures go to the report channel (targetReportChannel).
          const failChannel = isSimulated ? this.discordChannel : targetReportChannel;
          if (failChannel) {
            const embed = DiscordHelpers.buildScrambleFailedEmbed(
              this.messages.system.embeds.noValidSwapSolutionFound,
              swapPlan?.calculationTime || 0,
              this
            );
            DiscordHelpers.sendDiscordMessage(failChannel, { embeds: [embed] });
          }
          // Note: We do NOT reset the streak here, as the imbalance likely persists.
        } else {
          Logger.verbose('TeamBalancer', 2, `${this.RconMessages.prefix} ${this.RconMessages.scrambleFailedMessage.trim()}`);
        }
      }

      return true;
    } catch (error) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.criticalErrorDuringScrambleExecution, { error: error?.message || error }));      
      Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.squadDataAtError, JSON.stringify(this.server.squads, null, 2));
      Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.playerDataAtError, JSON.stringify(this.server.players, null, 2));      
      
      const targetReportChannel = this.discordReportChannel || this.discordChannel;
      if (targetReportChannel) {
        const embed = DiscordHelpers.buildFatalErrorEmbed(error, this.messages.system.labels.scrambleExecution, this);
        DiscordHelpers.sendDiscordMessage(targetReportChannel, { embeds: [embed] });
      }

      this.cleanupScrambleTracking();
      await this.resetStreak(this.messages.system.reasons.scrambleExecutionFailed);
      return false;
    } finally {
      if (globalLockAcquired) {
        try {
          this._s3?.players.unlockGlobal('TeamBalancer');
          Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.globalLockReleased);
        } catch (err) {
          Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.failedToReleaseGlobalLock, { error: err.message }));
        }
      }
      // Write scramble report JSON (includes swap plan and execution results)
      if (swapPlan) {
        this._writeScrambleReport(swapPlan, swapPlan.calculationTime || 0, isSimulated, preScrambleState);
      }
      // The countdown that armed this run is consumed by now, whatever the outcome (moves made,
      // empty swap plan, or a throw) — so the pending flag ends here, not in resetStreak. Same
      // helper the other teardown paths use, so "no countdown outstanding" has one meaning.
      this._clearPendingScrambleCountdown();
      this._scrambleInProgress = false;
      Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.scrambleFinished);
    }
  }

  async cancelPendingScramble(steamID, player = null, isAutomatic = false) {
    if (!this._scramblePending) {
      return false;
    }

    if (this._scrambleInProgress) {
      if (!isAutomatic) {
        const adminName = player?.name || steamID;
        Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.adminAttemptedCancelAlreadyExecuting, { adminName }));
      }
      return false;
    }

    this._clearPendingScrambleCountdown();

    const adminName = player?.name || steamID; // Prioritize player name
    const cancelReason = isAutomatic 
      ? this.messages.system.labels.cancelReasonAutomatic 
      : this.formatMessage(this.messages.system.labels.cancelReasonAdmin, { adminName });

    Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.scrambleCountdownCancelled, { cancelReason }));

    if (!isAutomatic) {
      const msg = `${this.RconMessages.prefix} ${this.messages.system.rcon.scrambleCancelledByAdmin}`;
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.broadcastingMessage, { message: msg }));
      try {
        await this.server.rcon.broadcast(msg);
      } catch (err) {
        Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.broadcastCancellationFailed, { error: err.message }));
      }
      this.mirrorRconToDiscord(msg, 'info');
    }

    return true;
  }

  async waitForScrambleToFinish(timeoutMs = 10000, intervalMs = 100) {
    if (this.swapExecutor) {
      await this.swapExecutor.waitForCompletion(timeoutMs, intervalMs);
    } else {
      Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.noSwapExecutorPresent);
    }
    Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.allMovesProcessedOrTimeout);
  }
  
  async reliablePlayerMove(eosID, targetTeamID, isSimulated = false) {
    if (isSimulated) {
      Logger.verbose('TeamBalancer', 4, this.formatMessage(this.messages.system.verbose.dryRunWouldQueueMove, { eosID, targetTeamID }));
      return;
    }

    return this.swapExecutor.queueMove(eosID, targetTeamID, isSimulated);
  }

  cleanupScrambleTracking() {
    if (this.swapExecutor) {
      this.swapExecutor.cleanup();
    }
    this._scrambleInProgress = false;
  }

  /**
   * Tears down an armed scramble countdown. The timer handle and _scramblePending are one unit —
   * clearing the flag alone leaves the timer running, and it then fires into a round it was never
   * armed for. Returns true if a countdown was actually still armed.
   */
  _clearPendingScrambleCountdown() {
    const wasArmed = !!this._scrambleCountdownTimeout;
    if (wasArmed) {
      clearTimeout(this._scrambleCountdownTimeout);
      this._scrambleCountdownTimeout = null;
    }
    this._scramblePending = false;
    return wasArmed;
  }

  /**
   * Writes a structured JSON scramble report to disk for post-scramble review.
   * Captures swap plan metadata, execution results, timestamps, team state,
   * and all scramble attempts with their scores.
   * Written to the scrambleReportPath directory (default: TeamBalancerScrambleReports/).
   */
  async _writeScrambleReport(swapPlan, calculationTime, isSimulated, preScrambleState, attempts) {
    try {
      const reportDirOpt = this.options.scrambleReportPath;
      if (!reportDirOpt) {
        Logger.verbose('TeamBalancer', 4, this.messages.system.verbose.scrambleReportDisabledPathEmpty);
        return;
      }
      const logDir = path.resolve(process.cwd(), reportDirOpt);
      await fs.promises.mkdir(logDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const reportPath = path.join(logDir, `scramble-report-${timestamp}.json`);

      const gs = this._s3?.gameState;
      const sessionReport = this.swapExecutor?.getLastSessionReport?.() || null;

      const report = {
        type: isSimulated ? 'dry-run' : 'live',
        timestamp: Date.now(),
        isoTimestamp: new Date().toISOString(),
        matchId: gs?.isReady() ? (gs.getMatchId?.() ?? null) : null,
        layerName: gs?.isReady() ? (gs.getLayerName?.() ?? this.messages.system.labels.unknownLayer) : this.messages.system.labels.unknownLayer,
        gamemode: gs?.isReady() ? (gs.getGamemode?.() ?? this.messages.system.labels.unknownGamemode) : this.messages.system.labels.unknownGamemode,
        calculationTime,
        totalMovesInPlan: swapPlan?.length || 0,
        plan: (swapPlan || []).map(m => ({
          eosID: m.eosID,
          targetTeamID: m.targetTeamID
        })),
        execution: sessionReport ? {
          totalMoves: sessionReport.totalMoves,
          movedSuccessfully: sessionReport.movedSuccessfully,
          failedToMove: sessionReport.failedToMove,
          failedNames: sessionReport.failedNames || [],
          disconnected: sessionReport.disconnected,
          duration: sessionReport.duration,
          successRate: sessionReport.successRate
        } : null,
        preScrambleState: preScrambleState || {
          winStreakTeam: this.winStreakTeam,
          winStreakCount: this.winStreakCount
        },
        scrambleAttempts: attempts || []
      };

      await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2));
      Logger.verbose('TeamBalancer', 2, this.formatMessage(this.messages.system.verbose.scrambleReportWritten, { reportPath }));
    } catch (err) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.scrambleReportWriteFailed, { error: err.message }));
    }
  }

  async mirrorRconToDiscord(message, type = 'info') {
    const targetReportChannel = this.discordReportChannel || this.discordChannel;
    if (!targetReportChannel || !this.options.mirrorRconBroadcasts) return;

    if (!message || typeof message !== 'string' || message.trim() === '') {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.verbose.discordMirrorEmptyMessage, { message }));
      return;
    }

    const colors = {
      info: '#3498db',
      success: '#2ecc71',
      warning: '#f39c12',
      error: '#e74c3c',
      scramble: '#9b59b6'
    };

    try {
      const embed = {
        color: parseInt((colors[type] || colors.info).replace('#', ''), 16),
        description: this.formatMessage(this.messages.system.embeds.discordServerBroadcastDescription, { message }),
        timestamp: new Date().toISOString()
      };
      DiscordHelpers.sendDiscordMessage(targetReportChannel, { embeds: [embed] });
    } catch (err) {
      Logger.verbose('TeamBalancer', 1, this.formatMessage(this.messages.system.errors.discordMirrorFailed, { error: err.message }));
    }
  }
}