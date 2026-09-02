/**
 * ─────────────────────────────────────────────────────────────────
 *  PLAYER-FACING TRANSLATION TEMPLATE — 266 strings
 * ─────────────────────────────────────────────────────────────────
 *
 *  GENERATED FILE — do not edit in place.
 *  Regenerate with:  node tools/make-locale-templates.mjs
 *
 *  ─── HOW TO USE ─────────────────────────────────────────────────
 *
 *  1. Copy this file to  s3/utils/s3-locale-<code>.js  (e.g. s3-locale-de.js).
 *  2. Fill in the '' values. The English original is on the line above each.
 *  3. Delete any line you do not translate — or leave it '', which falls back
 *     to English just the same. Both are safe; neither renders blank.
 *  4. Keep every {placeholder} exactly as it appears in the English.
 *  5. List machine-translated keys in UNVERIFIED at the bottom.
 *  6. Register the catalogue in s3/utils/s3-i18n.js (one import, one entry).
 *
 *  ─── ADDING A SECOND TIER LATER ─────────────────────────────────
 *
 *  All three templates fill the SAME s3-locale-<code>.js. They are disjoint
 *  slices of one key tree, but several branches (teamBalancer, switch) appear
 *  in more than one tier — so pasting a second template into the same object
 *  literal would silently drop the first copy of that branch, with no error
 *  and no clue beyond a tier quietly falling back to English. Merge instead:
 *
 *    import mergeMessages from './s3-locale-merge.js';
 *
 *    export const MESSAGES = mergeMessages(
 *      { ...paste this template's object here... },
 *      { ...paste the next template's object here... }
 *    );
 *
 *  One tier on its own needs none of that — keep the plain export below.
 *
 *  See s3/LOCALIZATION.md for the full contribution guide.
 *
 *  ─── THIS IS THE ONE THAT MATTERS ───────────────────────────────
 *
 *  Every string here can be read by any player, whether or not they asked to
 *  be: broadcasts the whole server sees at once, AdminWarn popups a single
 *  player reads mid-round, and the public Discord replies anyone in the
 *  channel gets from !elo stats or the leaderboard. 266 strings —
 *  the smallest tier, and the only one where an untranslated string lands in
 *  front of someone who never chose the server's language.
 *
 *  Register matters. A broadcast interrupts everyone, so keep it short and
 *  plain; an AdminWarn popup is read once, mid-firefight, and should be
 *  shorter still. The Discord ones have room to breathe, and **bold** and
 *  `code` markup in them is real formatting — keep it, and keep the emoji.
 * ─────────────────────────────────────────────────────────────────
 */

export const MESSAGES = {
  s3PluginBase: {
    teamChange: {
      defaults: {
        // EN: You have been scrambled
        warnMessage: '',
      },
    },
  },
  slackersSquadServices: {
    driftViolations: {
      // EN: {offenders} row(s) with empty `{column}`
      emptyRows: '',
    },
    sourceGroups: {
      // EN: Full Scramble
      fullScramble: '',
      // EN: Micro (Elo-Diff)
      microEloDiff: '',
      // EN: Team-Balancer (Legacy)
      teamBalancerLegacy: '',
      // EN: SmartAssign
      smartAssign: '',
      // EN: Switch (Self)
      switchSelf: '',
      // EN: Admin-Forced
      adminForced: '',
      // EN: In-Game / Untracked
      inGameUntracked: '',
      // EN: Other
      other: '',
    },
    reports: {
      // EN: ⚪ Not enough decided self/untracked switches yet to judge ({decided} so far, need {minSample}+).
      karmaNotEnough: '',
      // EN: 🟠 Strongly favors the winning team — landed on the winner **{pct}%** of the time after a self/untracked switch.
      karmaStrongWinner: '',
      // EN: 🟡 Leans toward the winning team (**{pct}%**).
      karmaLeansWinner: '',
      // EN: ⚪ Neutral — no clear pattern (**{pct}%**).
      karmaNeutral: '',
      // EN: 🟢 Leans toward the losing team (**{pct}%**).
      karmaLeansLoser: '',
      // EN: 🟢🟢 Strongly favors the losing team (**{pct}%**).
      karmaStrongLoser: '',
      // EN: *(capped at 180 days)*
      rangeCapped: '',
      // EN: *Excludes {modes} rounds.*
      excludesModes: '',
      // EN: ⚠️ *No TeamBalancer round data logged in this range — games-played counts below may read 0 even for active players. Check TeamBalancer's `enableDatabaseLogging`.*
      noRoundDataNote: '',
      // EN: Full = Full Scramble (legacy = pre-split Balancer moves, before Full/Micro were tracked separately — still full scrambles) · Micro = Elo-Diff Scramble · Self = player-initiated switch (self-serve, queued, handshake, or double-swap) · Other = SmartAssign, admin-forced, or untracked in-game switches
      leaderboardLegend: '',
      // EN: *(none)*
      none: '',
    },
  },
  switch: {
    warn: {
      // EN: [Switch] Round ending — you will be switched in 15 seconds.
      matchendWarning: '',
      // EN: Time Limit: Double switch allowed only in first {{minutes}}m of join/match.
      doubleSwitchTimeLimit: '',
      // EN: Cooldown: Double switch used recently. Wait {{hours}}h.
      doubleSwitchCooldown: '',
      // EN: Player has been double-switched.
      playerDoubleSwitched: '',
      // EN: Double switch failed: {{message}}
      doubleSwitchFailedSender: '',
      // EN: You reconnected to a different team. Your switch restrictions have been cleared — type !switch to return to your previous team.
      reconnectWrongTeam: '',
      // EN: No player found matching: "{{ident}}"
      noPlayerFoundMatching: '',
      // EN: Multiple players match "{{ident}}". Use SteamID.
      multiplePlayersMatching: '',
      // EN: [Switch] Seed bonus — you earned +1 switch token for helping seed (round ended). You now have {{count}} tokens.
      seedBonusEndgame: '',
      // EN: [Switch] Seed bonus — you earned +1 switch token for helping seed. You now have {{count}} tokens ({{earned}}/{{cap}} bonus tokens earned this round).
      seedBonusPeriodic: '',
      // EN: [Switch] Scramble failed to move you — granted +1 switch token to rejoin your group. Use !switch when ready.
      scrambleMoveFailedTokenGranted: '',
      // EN: [Switch] Scramble failed to move you — use !switch to rejoin your group.
      scrambleMoveFailed: '',
      // EN: Players and squads refreshed.
      playersSquadsRefreshed: '',
      // EN: Switch Slots:\nTeam 1: {switchSlotsPerTeam}\nTeam 2: {switchSlotsPerTeam2}
      switchSlotsTeam1: '',
      // EN: Player "{name}" was already queued for match end — no change.
      playerWasAlreadyQueued: '',
      // EN: Squad {commandSplit1} ({commandSplit2}): nobody queued (empty squad, or all members already queued).
      squadNobodyQueuedEmpty: '',
      // EN: Admin Controls\nPlayer: now, double, matchend, check, clear\nSquad: squad, doublesquad, matchendsquad
      adminControlsPlayerNow: '',
      // EN: [Switch] Commands\n!switch         | Request a team switch\n!switch check   | Check your eligibility\n!switch explain | How switching works\n!switch cancel  | Leave the queue
      switchCommandsSwitchRequest: '',
      // EN: [Switch] How It Works (1/{totalSteps})\nYou can request a switch in the first {switchEnabledMinutes}m after joining or after match start — whichever gives you more time.
      switchHowWorks1: '',
      // EN: [Switch] How It Works (2/{totalSteps})\nIf teams are uneven, you are queued until a slot opens or a swap partner on the other team is found.
      switchHowWorks2: '',
      // EN: [Switch] How It Works (3/{totalSteps})\nOnce in the queue, you have {queueTimeoutMinutes}m before your request expires. Use !switch check to see your status.
      switchHowWorks3: '',
      // EN: [Switch] How It Works (4/6)\nEach switch costs 1 token. You hold up to {maxSwitchTokens} tokens, and each refills individually every {cooldownHours}h. Use !switch check to see your balance.
      switchHowWorks4: '',
      // EN: [Switch] How It Works (5/6)\nDuring seed rounds, you earn +1 bonus switch token for every {seedTokenBonusMinutes} minutes of presence{seedMinNote} (up to {seedTokenBonusAmount} per round). Bonus tokens stack above your normal {maxSwitchTokens}-token cap.
      switchHowWorks5: '',
      // EN: [Switch] How It Works (5/6)\nSeed bonus tokens are disabled on this server.
      switchHowWorks52: '',
      // EN: [Switch] How It Works (6/6)\nAfter a scramble, switches are locked for {scrambleLockdownDurationMinutes}m.\nUse !switch check to see your current status.
      switchHowWorks6: '',
      // EN: [Switch] How It Works (4/5)\nAfter switching, there is a {cooldownHours}h cooldown before you can switch again.
      switchHowWorks42: '',
      // EN: [Switch] How It Works (5/5)\nAfter a scramble, switches are locked for {scrambleLockdownDurationMinutes}m.\nUse !switch check to see your current status.
      switchHowWorks53: '',
      // EN: Only admins can check other players. Use !switch check with no name to see your own status.
      onlyAdminsCanCheck: '',
      // EN: [Switch Queue] Queue is currently disabled.
      switchQueueQueueCurrently: '',
      // EN: [Switch Queue] Removed — you left the queue.
      switchQueueRemovedLeft: '',
      // EN: [Switch Queue] You are not currently in the queue.
      switchQueueNotCurrently: '',
      // EN: Unknown subcommand: "{subCommand}". Showing help...
      unknownSubcommandShowingHelp: '',
      // EN: [Switch] Team changes are locked during faction voting. Try again when the next round starts.
      switchTeamChangesLocked: '',
      // EN: [Switch] You just switched — wait {remaining}s before switching again.
      switchJustSwitchedWait: '',
      // EN: [Switch] Scramble lock active — expires in {remaining}m.\nYour switch window may close before this expires.\nUse !switch check to see your full status.
      switchScrambleLockActive: '',
      // EN: [Switch] Eligibility window closed.\nYou can only request a switch in the first {switchEnabledMinutes}m after joining or after\nmatch start — whichever gives you more time.\nUse !switch explain for details.
      switchEligibilityWindowClosed: '',
      // EN: [Switch] Out of switch tokens — next one in {remaining}m.\nUse !switch check to see your full status.
      switchOutSwitchTokens: '',
      // EN: [Switch] On cooldown — available in {remaining}m.\nUse !switch check to see your full status.
      switchCooldownAvailableM: '',
      // EN: [Switch] Please try again shortly.
      switchPleaseTryAgain: '',
      // EN: [Switch] Queue is currently disabled and no slots are available. Try again shortly.
      switchQueueCurrentlyDisabled: '',
      // EN: [Switch] The server could not complete the team change. Try again later.
      switchServerCouldNot: '',
      // EN: [Switch] Switch failed — please try again or contact an admin.
      switchSwitchFailedPlease: '',
      // EN: [Switch] Switched! {balance}/{maxSwitchTokens} tokens remaining.
      switchSwitchedTokensRemaining: '',
      // EN: [Switch] Switched! You're out of tokens — next one in ~{remaining}m.
      switchSwitchedReOut: '',
      // EN: [Switch Queue]\nYou are already in the queue.\n~{remaining}m auto-expiry | Team {currentTeamID} → Team {targetTeamID}\nType !switch cancel to leave.
      switchQueueAlreadyQueue: '',
      // EN: [Switch Queue]\nPosition {pos} in the queue.\n~{remaining}m remaining | Team {currentTeamID} → Team {targetTeamID}\nType !switch cancel to leave.
      switchQueuePositionQueue: '',
      // EN: [Switch Queue]\nAdded to position {enqueuePos} in the queue.\n~{remainingQueueMs}m auto-expiry | Team {teamID} → Team {targetTeam}\n{reason}\nType !switch cancel to leave.
      switchQueueAddedPosition: '',
      // EN: [Switch Queue] Swap partner found — switching now.
      switchQueueSwapPartner: '',
      // EN: [Switch Queue] Removed — queue timeout reached.\nYour {queueTimeoutMinutes}m queue timeout expired while waiting.\nUse !switch explain for details.
      switchQueueRemovedQueue: '',
      // EN: [Switch Queue] You are now on team {teamID}.\nYour switch request is complete.
      switchQueueNowTeam: '',
      // EN: [Switch Queue] Queue timeout — switching now.
      switchQueueQueueTimeout: '',
      // EN: [Switch Queue] Balance slot opened — switching now.
      switchQueueBalanceSlot: '',
      // EN: [Switch] Team switching is open. Use '!switch help' for details. Window: ~{remainingMin}m.
      switchTeamSwitchingOpen: '',
      // EN: [Switch] ~{remainingMin}m remaining to request a team change. Use '!switch check' to see your eligibility.
      switchMRemainingRequest: '',
      // EN: [Switch] Team switch window is now closed.
      switchTeamSwitchWindow: '',
      // EN: [Switch] Seed mode — switches are free (no token cost). You earn +1 bonus switch token for every {seedTokenBonusMinutes}m of helping seed{minNote}, up to {bonusAmount} per round — or stay until the round ends and get it anyway. Use '!switch check' to see your balance.
      switchSeedModeSwitches: '',
      // EN: [Switch] Seed mode — switches are free (no token cost). Use '!switch' to change teams anytime.
      switchSeedModeSwitches2: '',
      // EN: [Switch] No cooldown restrictions on this game mode. Use '!switch' to change teams anytime.
      switchNoCooldownRestrictions: '',
      // EN: [Switch] A scramble occurred last round. Returning players cannot change teams this round. New arrivals can still switch — use '!switch check'.
      switchScrambleOccurredLast: '',
      // EN: [Switch] Scramble lockdown active. Returning players cannot change teams this round. New arrivals can still switch — use '!switch check'.
      switchScrambleLockdownActive: '',
      // EN: [Switch] Want to change teams? Type '!switch' to request a team change. Use '!switch help' to learn more.
      switchWantChangeTeams: '',
      // EN: [Switch] Scoreboard team changes are disabled on this server. Use '!switch' to change teams. '!switch help' for more info.
      switchScoreboardTeamChanges: '',
    },
  },
  teamBalancer: {
    rcon: {
      // EN: Scramble cancelled by admin.
      scrambleCancelledByAdmin: '',
    },
    rconMessages: {
      // EN: Round ended in a Draw!
      draw: '',
      nonDominant: {
        // EN: {team} ended {loser}'s domination streak | ({margin} tickets)
        streakBroken: '',
        // EN: {team} defeated defenders | ({margin} tickets)
        invasionAttackWin: '',
        // EN: {team} held off attackers | ({margin} tickets)
        invasionDefendWin: '',
        // EN: {team} narrowly defeated {loser} | ({margin} tickets)
        narrowVictory: '',
        // EN: {team} gained ground on {loser} | ({margin} tickets)
        marginalVictory: '',
        // EN: {team} pushed through {loser} | ({margin} tickets)
        tacticalAdvantage: '',
        // EN: {team} outmaneuvered {loser} | ({margin} tickets)
        operationalSuperiority: '',
      },
      dominant: {
        // EN: {team} steamrolled {loser} | ({margin} tickets)
        steamrolled: '',
        // EN: {team} stomped {loser} | ({margin} tickets)
        stomped: '',
        // EN: {team} dominated {loser} | ({margin} tickets)
        dominantVictory: '',
        // EN: {team} crushed defenders with force | ({margin} tickets)
        invasionAttackStomp: '',
        // EN: {team} decisively repelled attackers | ({margin} tickets)
        invasionDefendStomp: '',
      },
      // EN: {team} has reached {count} dominant wins ({margin} tickets) | Scrambling in {delay}s...
      scrambleAnnouncement: '',
      // EN: {team} has won {count} consecutive rounds | Scrambling in {delay}s...
      consecutiveWinsScramble: '',
      // EN: Extreme ticket difference detected ({margin} tickets) | Scrambling in {delay}s...
      singleRoundScramble: '',
      // EN: Manual team balance triggered by admin | Scrambling in {delay}s...
      manualScrambleAnnouncement: '',
      // EN: Manual team balance triggered by admin | Scrambling teams...
      immediateManualScramble: '',
      // EN: Manual micro scramble triggered by admin | Scrambling in {delay}s...
      manualMicroScrambleAnnouncement: '',
      // EN: Manual micro scramble triggered by admin | Scrambling teams...
      immediateManualMicroScramble: '',
      // EN: Executing scramble...
      executeScrambleMessage: '',
      // EN: Dry Run: Simulating scramble...
      executeDryRunMessage: '',
      // EN: Balance has been restored.
      scrambleCompleteMessage: '',
      // EN: Scramble failed! No valid solution found.
      scrambleFailedMessage: '',
      // EN: You've been scrambled.
      playerScrambledWarning: '',
      // EN: Seed match complete! Scrambling teams in {delay}s...
      seedScrambleAnnouncement: '',
      // EN: Team imbalance detected ({margin}-ticket margin) | Micro scramble in {delay}s...
      microScrambleAnnouncement: '',
      // EN: Balance has been restored. (Micro scramble)
      microScrambleCompleteMessage: '',
      // EN: No balance change needed. (Micro scramble)
      microScrambleFailedMessage: '',
      system: {
        // EN: Team Balancer has been enabled.
        trackingEnabled: '',
        // EN: Team Balancer has been disabled.
        trackingDisabled: '',
      },
    },
    broadcasts: {
      // EN: Your scheduled end-of-round scramble was discarded because {reason}. Re-issue "!scramble matchend" during the round if still needed.
      warnAdminMatchEndDiscarded: '',
      // EN:  | A scramble countdown is already running — use !scramble cancel to stop it
      seedScrambleOffPendingScramble: '',
      // EN:  | Seed auto-scramble is off too while disabled
      seedScrambleOffDisabled: '',
      // EN: Win streak tracking enabled.
      enableConfirmationStreakOn: '',
      // EN: Plugin enabled — win streak tracking stays off in config.
      enableConfirmationStreakOff: '',
      // EN:  | Seed auto-scramble re-armed
      enableConfirmationSeedRearmed: '',
      // EN: OFF (config)
      seedStatusConfigOff: '',
      // EN: OFF (plugin disabled)
      seedStatusPluginDisabled: '',
      // EN: ON (at Seed round end)
      seedStatusActive: '',
      // EN: a server restart carried it past the round it was armed for
      armDiscardedRestartReason: '',
      // EN: a new round started before the scheduled scramble could fire
      armDiscardedNewGameReason: '',
    },
    warn: {
      // EN: TeamBalancer is still initializing, please try again in a moment.
      teambalancerStillInitializingPlease: '',
      // EN: Win streak tracking is already enabled.
      winStreakTrackingAlready: '',
      // EN: Win streak tracking is already disabled.
      winStreakTrackingAlready2: '',
      // EN: Win streak tracking disabled.{seedScrambleOffNote}
      winStreakTrackingDisabled: '',
      // EN: Invalid command. Usage: !teambalancer [status|diag|on|off|help] or !scramble [now|dry|matchend|cancel]
      invalidCommandUsageTeambalancer: '',
      // EN: Error processing command: {message}
      errorProcessingCommand: '',
      // EN: Unknown argument "{badArg}". Usage: !scramble [now|dry|matchend|cancel|confirm|elo]
      unknownArgumentUsageScramble: '',
      // EN: No pending scramble confirmation found.
      noPendingScrambleConfirmation: '',
      // EN: Scramble confirmation expired.
      scrambleConfirmationExpired: '',
      // EN: "!scramble matchend" cannot be combined with "now" or "dry".
      scrambleMatchendCannotCombined: '',
      // EN: A match-end scramble is already scheduled. It will fire when this round ends. Use "!scramble cancel" to cancel it.
      matchEndScrambleAlready: '',
      // EN: Pending scramble cancelled.
      pendingScrambleCancelled: '',
      // EN: Cannot cancel scramble - it is already executing.
      cannotCancelScrambleAlready: '',
      // EN: No pending scramble to cancel.
      noPendingScrambleCancel: '',
      // EN: [WARNING] Scramble already {status}. Use "!scramble cancel" to cancel pending scrambles.
      warningScrambleAlreadyUse: '',
      // EN: Confirming will execute a {scrambleKind} scramble {timing}. Type "!scramble confirm" within {timeoutSec}s to proceed.
      confirmingWillExecuteScramble: '',
      // EN: Failed to initiate scramble - another scramble may be in progress.
      failedInitiateScrambleAnother: '',
    },
    diagnostics: {
      // EN: Test not run
      notRun: '',
      // EN: FAIL: {error}
      fail: '',
      // EN: S³ DB not reachable
      s3NotReachable: '',
      // EN: No TeamBalancer models found on S³ connector
      noTbModels: '',
      // EN: PASS (S³ connected, {tableCount} TB table)
      s3PassOneTable: '',
      // EN: PASS (S³ connected, {tableCount} TB tables)
      s3PassTables: '',
      // EN: SKIPPED ({value} players — need ≥ 10)
      skippedTooFewPlayers: '',
      // EN: SUCCESS ({value} moves calculated)
      scramblerSuccess: '',
      // EN: Scrambler did not return a valid swap plan.
      noValidSwapPlan: '',
    },
  },
  eloTracker: {
    embeds: {
      roundSkipped: {
        // EN: Plugin not ready at round end
        pluginNotReady: '',
        // EN: Player count below threshold (Gamemode: {gameMode})
        playerCountBelow: '',
        // EN: Ignored match type: {reason}
        ignoredMatchType: '',
        // EN: No eligible participants (0 players met minParticipationRatio of {ratio})
        noEligible: '',
        // EN: One or both teams had no eligible participants (Gamemode: {gameMode})
        oneOrBothIneligible: '',
      },
      // EN: 🏆 Round Ended
      roundEnded: '',
      // EN: **Veterancy: {icon} {label}**\n*Percentage of established "Regular" players (10+ rounds) in the match.*\n\n{generateMatrixTable}
      veterancyPercentageEstablishedRegular: '',
      // EN: Map / Layer
      mapLayer: '',
      // EN: Player Count
      playerCount: '',
      // EN: Rating Changes
      ratingChanges: '',
      // EN: **Team 1:** {ratingChanges}\n**Team 2:** {ratingChanges2}
      team1Team2: '',
      // EN: Players Updated
      playersUpdated: '',
      // EN: Processing Time
      processingTime: '',
      // EN: Rating Spread (Regulars)
      ratingSpreadRegulars: '',
      // EN: No regulars played this round
      noRegularsPlayedRound: '',
      // EN: CSR (Competitive Skill Rank)
      csrCompetitiveSkillRank: '',
      // EN: Estimated Skill (μ)
      estimatedSkill: '',
      // EN: System Certainty (σ)
      systemCertainty: '',
      // EN: Match History
      matchHistory: '',
      // EN: μ (Mu) = Estimated Skill | σ (Sigma) = System Certainty
      muEstimatedSkillSigma: '',
      // EN: Local Leaderboard
      localLeaderboard: '',
      // EN: 📊 Player Stats for {name}
      playerStats: '',
      // EN: Out of **{totalRankedFmt}** ranked players ({totalPlayersFmt} total)\n```text\n{value}\n```
      outRankedPlayersTotal: '',
      // EN: 🛡️ Clan Stats for {displayTag}
      clanStats: '',
      // EN: Average Rating
      averageRating: '',
      // EN: Roster (Top 20)
      rosterTop20: '',
      // EN: 🛡️ Clan Leaderboard (Top {limit})
      clanLeaderboardTop: '',
      // EN: Ranking clans with ≥{minMembers} members by average CSR\n```text\n{header}\n{body}\n```
      rankingClansWithMembers: '',
      // EN: 🛡️ Admin Action: {action}
      adminAction: '',
      // EN: Stack Trace
      stackTrace: '',
      // EN: ⏭️ ELO Rating Update Skipped
      eloRatingUpdateSkipped: '',
      // EN: 📊 EloTracker: System Initializing
      elotrackerSystemInitializing: '',
      // EN: System is synchronizing with the database. Please wait for player data to cache...
      systemSynchronizingWithDatabase: '',
      // EN: 🛰️ Live Round Info
      liveRoundInfo: '',
      // EN: The server is currently empty. No active match data to display.
      serverCurrentlyEmptyNo: '',
      // EN: **Veterancy: {icon} {label}**\n*Percentage of established "Regular" players (10+ rounds) in the match.*\n\n{matrixTable}
      veterancyPercentageEstablishedRegular2: '',
      // EN: Match Health
      matchHealth: '',
      // EN: Round Start
      roundStart: '',
      // EN: ⚠️ Invalid SteamID. Please provide your 17-digit SteamID. This message will be deleted in 5 seconds.
      invalidSteamidPleaseProvide: '',
      // EN: ⚠️ No ELO record found for that SteamID. Make sure you have played at least one round on the server. This message will be deleted in 5 seconds.
      noEloRecordFound: '',
      // EN: Account Linked
      accountLinked: '',
      // EN: Your Discord account is now successfully linked to the ELO record for **{name}**.
      discordAccountNowSuccessfully: '',
      // EN: Account Link
      accountLink: '',
      // EN: 📖 How the ELO System Works
      howEloSystemWorks: '',
      // EN: This server uses a system based on [TrueSkill](https://en.wikipedia.org/wiki/TrueSkill) to rank players. Here’s a quick breakdown:
      serverUsesSystemBased: '',
      // EN: TrueSkill Algorithm
      trueskillAlgorithm: '',
      // EN: A rating system used by major platforms (like Xbox) to track your estimated skill (μ) and system certainty (σ) in team games.
      ratingSystemUsedBy: '',
      // EN: Your official leaderboard score, calculated conservatively as **μ - 3σ** to encourage active play.
      officialLeaderboardScoreCalculated: '',
      // EN: Estimated Skill (μ — "Mu")
      estimatedSkillMu: '',
      // EN: Your estimated performance level. Everyone starts at {value}. This number goes up when you win and decreases when you lose based on the strength of your opponents.
      estimatedPerformanceLevelEveryone: '',
      // EN: System Certainty (σ — "Sigma")
      systemCertaintySigma: '',
      // EN: This is the system's confidence in your rank. It starts at {value} and drops as you play more games, making your rank more stable.
      systemSConfidenceRank: '',
      // EN: The Calibration Goal
      calibrationGoal: '',
      // EN: Once your Sigma drops below 2.5, you are considered 'Highly Calibrated' and your rank becomes more stable.
      onceSigmaDropsBelow: '',
      // EN: 📖 EloTracker Command Reference
      elotrackerCommandReference: '',
      // EN: 🌐 Public Commands
      publicCommands: '',
      // EN: No linked ELO record found. Please use `!elo link <Your17DigitSteamID>` to link your account first!
      noLinkedEloRecord: '',
      // EN: ELO Lookup
      eloLookup: '',
      // EN: Please specify a clan tag (e.g. `!elo clan FRWRD`)
      pleaseSpecifyClanTag: '',
      // EN: Invalid clan tag query.
      invalidClanTagQuery: '',
      // EN: No players found with clan tag matching: "{query}"
      noPlayersFoundWith: '',
      // EN: No ELO record found for: {identifier}
      noEloRecordFound2: '',
      // EN: Low ({pct}%)
      veterancyLow: '',
      // EN: Moderate ({pct}%)
      veterancyModerate: '',
      // EN: High ({pct}%)
      veterancyHigh: '',
      // EN: {winnerText} (+{ticketDiff} tickets)
      winnerTickets: '',
      // EN: Winner
      fieldWinner: '',
      // EN: Duration
      fieldDuration: '',
      // EN: Disparity
      fieldDisparity: '',
      // EN: Reason
      fieldReason: '',
      // EN: Layer
      fieldLayer: '',
      // EN: Members
      fieldMembers: '',
      // EN: Winrate
      fieldWinrate: '',
      // EN: Glossary
      fieldGlossary: '',
      // EN: Unknown
      unknownLayer: '',
      // EN: **{value} μ**
      muValue: '',
      // EN: {reliability} (**{sigma} σ**)
      certaintyValue: '',
      // EN: 🏆 Leaderboard {rankRange}
      leaderboardTitle: '',
      // EN: {members} ({rankedCount} ranked)
      clanMembersValue: '',
      // EN: {wr}% ({wins}W / {losses}L)
      clanWinrateValue: '',
      // EN: ⚠️ Error: {context}
      errorTitle: '',
    },
    onEloCommand: {
      // EN: No leaderboard data yet.
      noLeaderboardDataYet: '',
      // EN: Failed to retrieve leaderboard.
      failedToRetrieveLeaderboard: '',
      // EN: Failed to retrieve player stats.
      failedToRetrievePlayer: '',
      // EN: === EloTracker Commands ===
      elotrackerCommands: '',
      // EN: !elo — Show your current rating and rank
      eloShowYourCurrent: '',
      // EN: !elo <name | steamID> — Look up another player
      eloNameSteamidLook: '',
      // EN: !elo leaderboard — Top 10 players by rating
      eloLeaderboardTopPlayers: '',
      // EN: !elo help — Show this message
      eloHelpShowThis: '',
      // EN: === ELO Leaderboard ===
      eloLeaderboard: '',
    },
    onEloAdminCommand: {
      // EN: Usage: !eloadmin reset <name | steamID | eosID>
      usageEloadminResetName: '',
      // EN: No player found: {identifier}
      noPlayerFoundIdentifier: '',
      // EN: Reset {name} to default rating (μ {mu}).
      resetNameToDefault: '',
      // EN: Failed to reset player: {message}
      failedToResetPlayer: '',
      // EN: Unknown command. Type !eloadmin help for options.
      unknownCommandTypeEloadmin: '',
      // EN: === EloTracker Admin Commands ===
      elotrackerAdminCommands: '',
      // EN: !eloadmin reset <name|steamID|eosID> — Reset a player to default rating
      eloadminResetNameSteamid: '',
      // EN: !eloadmin status — Plugin status and current round info
      eloadminStatusPluginStatus: '',
      // EN: !eloadmin help — Show this message
      eloadminHelpShowThis: '',
      // EN: === EloTracker Status ===
      elotrackerStatus: '',
      // EN: Version: {version}
      versionVersion: '',
      // EN: Ready: {ready}
      readyReady: '',
      // EN: Session players: {sessionCount}
      sessionPlayersSessioncount: '',
      // EN: ELO cache entries: {cacheCount}
      eloCacheEntriesCachecount: '',
      // EN: Round start: {value}
      roundStartValue: '',
      // EN: Ambiguous: "{identifier}" is not an exact match.
      ambiguousIdentifierIsNot: '',
      // EN: Matched: {names}
      matchedNames: '',
      // EN: Re-run with the full name or a SteamID/EOS ID.
      reRunWithThe: '',
    },
    clanStats: {
      // EN: CSR: **{avgCsr}**\nμ: {avgMu} | σ: {avgSigma}
      csrAndSpread: '',
    },
    lookupAndRespond: {
      // EN: No ELO record found for: {identifier}
      noEloRecordFound: '',
      // EN: Type !elo help for available commands.
      typeEloHelpFor: '',
      // EN: CSR: {consRating} (μ - 3.0σ)
      csr: '',
      // EN: Estimated Skill: {record} μ | Certainty: {record2} σ
      estimatedSkillRecordCertainty: '',
      // EN: Record: {wins}W / {losses}L ({roundsPlayed} rounds)
      recordWinsWLosses: '',
    },
  },
};

// Key paths whose translation was machine-written and has NOT been reviewed by
// a fluent speaker. Add a key here in the same commit that adds an unreviewed
// string; delete it once someone who reads the language has checked it. An
// empty array means this catalogue is fully reviewed.
export const UNVERIFIED = [];
