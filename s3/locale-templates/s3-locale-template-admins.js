/**
 * ─────────────────────────────────────────────────────────────────
 *  ADMIN-FACING TRANSLATION TEMPLATE — 1158 strings
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
 *  ─── WORTH DOING, AFTER THE PLAYER TIER ─────────────────────────
 *
 *  Strings only your staff can reach: replies to admin-gated commands, the
 *  scramble and diagnostic reports in your staff channel, and the admin half
 *  of !elo. 1158 strings — the bulk of what an admin reads day to day,
 *  but read by a handful of people who opted into running the thing, so a
 *  missed one costs far less than a missed broadcast.
 *
 *  Most of these render in Discord, so **bold** and `code` markup in the
 *  English is real formatting: keep it, and keep the emoji, which act as
 *  icons. The in-game ones are AdminWarn popups and have a hard length limit.
 * ─────────────────────────────────────────────────────────────────
 */

export const MESSAGES = {
  s3DiscordPluginBase: {
    errors: {
      // EN: Could not fetch Discord channel with channelID "{channelID}". Error: {error}
      channelFetchFailed: '',
      // EN: Failed to send Discord message: {error}
      sendFailed: '',
      // EN: Failed to send Discord message after retry: {error}
      sendFailedRetry: '',
    },
    defaults: {
      // EN: Slackers Squad Services
      embedFooter: '',
    },
  },
  s3PluginBase: {
    errors: {
      // EN: [S3] server.plugins not available. Cannot discover SlackersSquadServices.
      pluginsNotAvailable: '',
      // EN: [S3] SlackersSquadServices is required for this plugin. Ensure it is in config.json before this plugin and restart.
      servicesRequired: '',
      // EN: [S3] S³ not discovered. Call _resolveS3() or ensure prepareToMount() ran.
      notDiscovered: '',
      // EN: [S3] S³ not ready after {timeoutMs}ms timeout. Check that SlackersSquadServices is mounted and not crashing.
      readyTimeout: '',
    },
  },
  slackersSquadServices: {
    labels: {
      // EN: N/A
      notAvailable: '',
    },
    drift: {
      // EN: ⚠️ Schema Drift Detected
      embedTitle: '',
      // EN: S³ Schema Verification
      footer: '',
      // EN: Schema or data drift detected — expected state is missing from the live database.\nUse `!s3 migrate force` to re-apply.\n\n{parts}
      descriptionSummary: '',
      // EN: Schema drift detected — use `!s3 migrate verify` for details.
      descriptionFallback: '',
    },
    status: {
      // EN: 📋 Services
      services: '',
      // EN: 🎮 Game
      game: '',
      // EN: 👥 Players & Locks
      playersLocks: '',
      // EN: 🛡️ Clans
      clans: '',
      // EN: 🟢 Enabled (min {minSize}, max {maxSize})
      enabledMinMax: '',
      // EN: 📊 S³ Status
      sStatus: '',
      // EN: Phase: {phase} **{phase2}**{subState}
      phaseAndSubstate: '',
      // EN: Layer: **{layer}**
      layerLayer: '',
      // EN: Resolving: 🟡 Yes
      resolvingYes: '',
      // EN: Players: **{playerCount}**
      players: '',
      // EN: Teams: {team1Name} vs {team2Name}
      teamNames: '',
      // EN: Teams Resolved: 🟢 Yes
      teamsResolvedYes: '',
      // EN: Teams Resolved: 🟡 No
      teamsResolvedNo: '',
      // EN: Mode: **{mode}**
      mode: '',
      // EN: MatchId: `{matchId}`
      matchId: '',
      // EN: Round Start: {roundStart}
      roundStart: '',
      // EN: Global Lock: {state}
      globalLock: '',
      // EN: 🔒 {owner}
      globalLockOwner: '',
      // EN: 🟢 None
      globalLockNone: '',
    },
    services: {
      // EN: 🔧 S³ Service Status
      sServiceStatus: '',
      // EN: ⚪ **{service}** — not mounted
      notMounted: '',
      // EN: {emoji} **ServerConfig** — {state}
      serverConfig: '',
      // EN: loaded
      serverConfigLoaded: '',
      // EN: mounted, no config found
      serverConfigNoConfig: '',
      // EN:    Path: `{path}`
      path: '',
      // EN:    MaxPlayers: {maxPlayers} | AllowTeamChanges: {allowTeamChanges}
      maxPlayersLine: '',
      // EN: 🟢 **DB** — {connector}
      db: '',
      // EN: ⚫ No connector
      noConnector: '',
      // EN: 🟢 {connector} — No schema drift
      noSchemaDrift: '',
      // EN: 🔴 {connector} — Cannot verify schema
      cannotVerifySchema: '',
      // EN: 🟠 {connector} — Schema drift: {parts}
      schemaDrift: '',
      // EN: {count} table(s) missing columns
      driftMissingColumns: '',
      // EN: {count} table(s) with extra columns
      driftExtraColumns: '',
      // EN:    Migrations: {state}
      migrations: '',
      // EN: 🟠 Pending
      migrationsPending: '',
      // EN: 🟢 All current
      migrationsAllCurrent: '',
      // EN:    Schema versions registered: {count}
      schemaVersions: '',
      // EN: {emoji} **GameState** — Phase: {phase}{resolving}
      gameState: '',
      // EN:  (resolving)
      resolvingSuffix: '',
      // EN:    MatchId: `{matchId}` | RoundStart: {roundStart}
      matchIdRoundStart: '',
      // EN:    Mode: {mode} | Layer: {layer}
      modeLayer: '',
      // EN: {emoji} **Factions** — {state}
      factions: '',
      // EN: Both teams resolved
      factionsBothResolved: '',
      // EN: Resolving...
      factionsResolving: '',
      // EN:    {team1} vs {team2}
      teamsVs: '',
      // EN:    Polling: {state}
      polling: '',
      // EN: 🟢 Running
      pollingRunning: '',
      // EN: ⚫ Stopped
      pollingStopped: '',
      // EN: 🟢 **Clans** — {count} group(s) found (min {min}, max {max})
      clans: '',
      // EN: ⚫ **Clans** — disabled in config
      clansDisabled: '',
      // EN: {emoji} **Players** — {count} tracked
      players: '',
      // EN:    Initial Sync: {sync} | Teams: {teams}
      initialSyncTeams: '',
      // EN: 🟢 Complete
      syncComplete: '',
      // EN: 🟡 Pending
      syncPending: '',
      // EN: 🟢 Resolved
      teamsResolvedState: '',
      // EN: 🟡 Resolving
      teamsResolvingState: '',
      // EN:    Projection: {state}
      projection: '',
      // EN: 🟡 Active
      projectionActive: '',
      // EN: ⚫ None
      projectionNone: '',
      // EN:    Global Lock: {state}
      globalLock: '',
      // EN: 🔒 {owner}
      globalLockOwner: '',
      // EN: 🟢 None
      globalLockNone: '',
    },
    gameState: {
      // EN: 🔴 GameState Service Not Available
      gamestateServiceNotAvailable: '',
      // EN: Round Start
      roundStart: '',
      // EN: Staging Timer
      stagingTimer: '',
      // EN: 🟡 Pending
      pending: '',
      // EN: ENDGAME Sub-State
      endgameSubState: '',
      // EN: Last NEW_GAME
      lastNewGame: '',
      // EN: Last ROUND_ENDED
      lastRoundEnded: '',
      // EN: 🎮 Game State
      gameState: '',
      // EN: Resolving
      resolving: '',
      // EN: Gamemode
      gamemode: '',
      // EN: 🟡 Yes
      yes: '',
      // EN: ⚫ No
      no: '',
      // EN: ⚫ None
      none: '',
      // EN: Phase
      phase: '',
      // EN: Layer
      layer: '',
    },
    factions: {
      // EN: 🔴 Factions Service Not Available
      factionsServiceNotAvailable: '',
      // EN: 🎖️ Factions
      factions: '',
      // EN: Resolving Gate
      resolvingGate: '',
      // EN: Cached Abbreviations
      cachedAbbreviations: '',
      // EN: Resolution
      resolution: '',
      // EN: Polling
      polling: '',
      // EN: Both teams resolved
      bothTeamsResolved: '',
      // EN: Resolving...
      resolvingEllipsis: '',
      // EN: Active
      active: '',
      // EN: Stopped
      stopped: '',
      // EN: 🟡 Polling gated (resolving flag active)
      pollingGated: '',
      // EN: 🟢 Free to poll
      freeToPoll: '',
    },
    playersEmbeds: {
      // EN: 🔴 Players Service Not Available
      playersServiceNotAvailable: '',
      // EN: 👥 Population
      population: '',
      // EN: **{allCount}** tracked
      tracked: '',
      // EN: **{team1Count}** in {count} squad(s)
      team1CountAndSquads: '',
      // EN: **{team2Count}** in {count} squad(s)
      team2CountAndSquads: '',
      // EN: Teams Resolved
      teamsResolved: '',
      // EN: Initial Sync
      initialSync: '',
      // EN: 🟢 Complete
      complete: '',
      // EN: 🟡 Active
      active: '',
      // EN: 🔒 Locks
      locks: '',
      // EN: ⚠️ Squad Data Pending
      squadDataPending: '',
      // EN: S³ has not snapshotted `server.squads` yet — it only does so on a tick
      sHasNotSnapshotted: '',
      // EN: where every player has a resolved teamID. Rosters below are flat until then.
      whereEveryPlayerHas: '',
      // EN: ⚠️ Team Unresolved ({awaitingCount})
      teamUnresolved: '',
      // EN: S³ has no teamID for these players yet — initial sync or the
      sHasNoTeamid: '',
      // EN: post-`NEW_GAME` null window. Not a game state; it should clear on its own.
      postNewGameNull: '',
      // EN: 🩹 Stuck Client ({stuckCount})
      stuckClient: '',
      // EN: These players have reported no teamID for far longer than a round
      thesePlayersHaveReported: '',
      // EN: transition takes, so S³ has stopped counting them towards team resolution —
      transitionTakesSoS: '',
      // EN: the rest of the lobby is unaffected. This clears when they reconnect.
      theRestOfThe: '',
      // EN: 👥 Players — Overview
      playersOverview: '',
      // EN: Phase **{phase} {phase2}** · Layer `{layer}`
      phasePhasePhase2Layer: '',
      // EN: Balance
      balance: '',
      // EN: Unassigned
      unassigned: '',
      // EN: ⚪ Unknown
      unknown: '',
      // EN: Projection
      projection: '',
      // EN: Global: 🔒 **{globalOwner}**
      global: '',
      // EN: {count} not in a squad
      notInASquad: '',
      // EN: 🟢 Yes
      yes: '',
      // EN: 🟡 No
      no: '',
      // EN: 🟡 Pending
      pending: '',
      // EN: ⚫ None
      none: '',
      // EN: Global: 🟢 None
      globalNone: '',
      // EN: ⚖️ Even
      even: '',
      // EN: {team} +{count}
      delta: '',
      // EN: Per-player: {count} active
      perPlayer: '',
    },
    team: {
      // EN: *No players on this team.*
      noPlayersOnThis: '',
      // EN: *{trimmedCount} more field(s) omitted — Discord embed limit.*
      moreFields: '',
      // EN: {emoji} {truncate} — {teamPlayersCount} player(s), {teamSquadsCount} squad(s)
      teamHeader: '',
      // EN: Roster
      roster: '',
      // EN: Truncated
      truncated: '',
      // EN: Team 1
      team1: '',
      // EN: Team 2
      team2: '',
      // EN: Team {teamID}
      teamN: '',
      // EN: Roster ({count}) — squad data pending
      rosterSquadDataPending: '',
      // EN: Unassigned ({count})
      unassignedCount: '',
    },
    clansEmbeds: {
      // EN: 🔴 Clans Service Not Available
      clansServiceNotAvailable: '',
      // EN: 🛡️ Clans — ⚫ Disabled
      clansDisabled: '',
      // EN: Clan tag grouping is not enabled in S³ configuration.
      clanTagGroupingIs: '',
      // EN: 🔴 Clans Service Outdated
      clansServiceOutdated: '',
      // EN: This S³ build predates `explainClanGroups()` — cannot render exclusion detail.
      thisSBuildPredates: '',
      // EN: Players Scanned
      playersScanned: '',
      // EN: Groups Active
      groupsActive: '',
      // EN: Tags Excluded
      tagsExcluded: '',
      // EN: Players Grouped
      playersGrouped: '',
      // EN: No Tag Detected
      noTagDetected: '',
      // EN: Tags Merged
      tagsMerged: '',
      // EN: ⚙️ Grouping Config
      groupingConfig: '',
      // EN: 🛡️ Active Clan Groups
      activeClanGroups: '',
      // EN: *None survived the grouping pipeline.*
      noneSurvivedTheGrouping: '',
      // EN: 🛡️ Clan Groups
      clanGroups: '',
      // EN: Pipeline order: extract → strip recruit suffix → normalize →
      pipelineOrderExtractStrip: '',
      // EN: corroboration gate → ignoreList → Damerau-Levenshtein merge → size bounds.\n
      corroborationGateIgnorelistDamerau: '',
      // EN: *Markers: ✓ confirmed · • high-confidence · ◦ corroborated*
      markersConfirmedHighConfidence: '',
      // EN: ⚫ No Tag Detected ({noTagCount})
      noTagDetectedNotagcount: '',
      // EN: ⚠️ Skipped (missing name or eosID)
      skippedMissingNameOr: '',
      // EN: {skippedCount} record(s) — these never reach clan grouping.
      skippedRecords: '',
      // EN: 🔍 Clan Grouping — Exclusions & Merges
      clanGroupingExclusionsMerges: '',
      // EN: Confirmed
      confirmed: '',
      // EN: minSize: `{minSize}` · maxSize: `{maxSize}`
      minsizeMinsizeMaxsizeMaxsize: '',
      // EN: maxEditDistance: `{maxEditDistance}` · minMergeLength: `{minMergeLength}` · caseSensitive: `{caseSensitive}`
      matchingOptions: '',
      // EN: recruitSuffixes: `{options}`
      recruitsuffixesOptions: '',
      // EN: ignoreList: `{options}`
      ignorelistOptions: '',
    },
    locks: {
      // EN: 🔴 Players Service Not Available
      playersServiceNotAvailable: '',
      // EN: Global Lock
      globalLock: '',
      // EN: 🔒 **{globalOwner}** (expires {expiresAt})
      expires: '',
      // EN: Per-Player Locks ({activeLocksCount})
      perPlayerLocksActivelockscount: '',
      // EN: **{name}**: {source} (exp {expiresAt})
      playerLockLine: '',
      // EN: Per-Player Locks
      perPlayerLocks: '',
      // EN: 🟢 None active
      noneActive: '',
      // EN: Lock Priority Order
      lockPriorityOrder: '',
      // EN: 🔒 Lock State
      lockState: '',
      // EN: 🟢 None
      none: '',
    },
    config: {
      // EN: 🔴 ServerConfig Service Not Available
      serverconfigServiceNotAvailable: '',
      // EN: Config Path
      configPath: '',
      // EN: ⚙️ Server Configuration
      serverConfiguration: '',
      // EN: Loaded
      loaded: '',
      // EN: 🟢 Yes
      yes: '',
      // EN: 🟡 No (mounted but parsing may have failed)
      noMountedButParsing: '',
    },
    switches: {
      // EN: ❌ Invalid Range
      invalidRange: '',
      // EN: 🔀 Team-Switch Leaderboard
      teamSwitchLeaderboard: '',
      // EN: No Switches
      noSwitches: '',
      // EN: No TEAM_CHANGE events in this range.
      noTeamChangeEvents: '',
      // EN: 🔀 Team-Switch Leaderboard ({i}/{chunksCount})
      teamSwitchLeaderboardI: '',
      // EN: 🔀 Team Switches — {name}
      teamSwitchesName: '',
      // EN: Total Switches: **{total}** | Games Played: **{games}**
      totalSwitchesTotalGames: '',
      // EN: ⚖️ Balancer / Scrambles
      balancerScrambles: '',
      // EN: 🔀 Manual / Switch
      manualSwitch: '',
      // EN: ❌ Export Failed
      exportFailed: '',
      // EN: Summary
      summary: '',
    },
    karma: {
      // EN: ❌ Invalid Range
      invalidRange: '',
      // EN: ❌ Missing Player
      missingPlayer: '',
      // EN: Usage: `!s3 karma <ident> [range]`
      usageS3KarmaIdent: '',
      // EN: 🟠 Round Outcome Data Unavailable
      roundOutcomeDataUnavailable: '',
      // EN: The `TB_RoundReport` table does not exist — TeamBalancer must be installed and mounted to compute karma (round winners are its data).
      theTbRoundreportTable: '',
      // EN: 🟠 No Round Outcome Data Logged In This Range
      noRoundOutcomeData: '',
      // EN: 🍀 Karma — {name}
      karmaName: '',
      // EN: No Qualifying Switches
      noQualifyingSwitches: '',
      // EN: No self/untracked team switches in this range ({games} games played) — admin-forced and balancer/SmartAssign-driven switches are excluded, karma is about the player's own choices.
      noSelfUntrackedTeam: '',
      // EN: Switches: **{totalSwitches}** ({gamesSummary}) | Known Outcome: **{decided}**
      switchesAndOutcome: '',
      // EN: 🎯 Switch Karma
      switchKarma: '',
      // EN: By Source
      bySource: '',
      // EN: in **{games}** games — **{pct}%** of rounds
      gamesRate: '',
      // EN: Games Played: **{games}**
      gamesPlayed: '',
      // EN: {label}: {wins}/{decided} decided ({total} total)
      bySourceLine: '',
      // EN: No `TB_RoundReport` rows exist anywhere in the requested date range, even though TeamBalancer is installed.
      noTbRoundreportRows: '',
      // EN: This almost always means TeamBalancer's own `enableDatabaseLogging` was off for the whole window, not that no rounds were played — check the TeamBalancer config before trusting karma numbers from this range.
      thisAlmostAlwaysMeans: '',
      // EN: Summary
      summary: '',
    },
    switchesExport: {
      // EN: 📊 Switch Report Export ({period})
      switchReportExportPeriod: '',
      // EN: Periods
      periods: '',
      // EN: Format
      format: '',
      // EN: Rows
      rows: '',
      // EN: Unknown period "{period}". Use "daily", "weekly", or "monthly".
      unknownPeriod: '',
      // EN: The S³ database service is not mounted, or the `S3_PlayerEvents` table does not exist yet.
      dbNotReady: '',
      // EN: No `S3_PlayerEvents` rows exist anywhere in the requested date range — check `enableDatabaseLogging` before trusting this export.
      noEventRows: '',
      // EN: The S³ database service is not mounted.
      dbNotMounted: '',
    },
    runDiagnostic: {
      // EN: DB schema drift
      dbSchemaDrift: '',
      // EN: Game phase readable
      gamePhaseReadable: '',
      // EN: Gamemode resolved
      gamemodeResolved: '',
      // EN: Layer name resolved
      layerNameResolved: '',
      // EN: Team 1 name resolved
      teamNameResolved: '',
      // EN: Team 2 name resolved
      teamNameResolved2: '',
      // EN: Player registry populated
      playerRegistryPopulated: '',
      // EN: Teams resolved
      teamsResolved: '',
      // EN: Lock system functional
      lockSystemFunctional: '',
      // EN: 🟢 All Checks Passed
      allChecksPassed: '',
      // EN: S³ services appear healthy.
      sServicesAppearHealthy: '',
      // EN: 🩺 S³ Diagnostic
      sDiagnostic: '',
      // EN: Consolidated service health check (read-only).\n🟢 OK  🟡 Resolving  ⚫ Disabled  🟠 Degraded  🔴 Broken  ⚪ Unknown
      consolidatedServiceHealthCheck: '',
      // EN: OK
      detailOk: '',
      // EN: Not Mounted
      detailNotMounted: '',
      // EN: {label} mounted
      labelMounted: '',
      // EN: Mounted but disabled in config
      detailDisabledInConfig: '',
      // EN: No drift detected
      detailNoDrift: '',
      // EN: Cannot verify — describeTable failed
      detailDriftUnverifiable: '',
      // EN: {issueCount} table(s) with drift ({missingCount} missing cols, {extraCount} extra cols)
      detailDriftBoth: '',
      // EN: {issueCount} table(s) with missing columns
      detailDriftMissing: '',
      // EN: {issueCount} table(s) with extra columns
      detailDriftExtra: '',
      // EN: Phase: {phase}
      detailPhase: '',
      // EN: Mode: {mode}
      detailMode: '',
      // EN: Layer: {layer}
      detailLayer: '',
      // EN: {count} players tracked
      detailPlayersTracked: '',
      // EN: All have teamID 1 or 2
      detailAllResolved: '',
      // EN: Some still resolving
      detailSomeResolving: '',
      // EN: lock/canAct/unlock APIs available
      detailLockApisAvailable: '',
      // EN: Lock APIs missing
      detailLockApisMissing: '',
      // EN: ⚠️ {passed}/{total} Passed
      someChecksPassed: '',
      // EN: {count} check(s) with non-green status. Review the results above.
      nonGreenSummary: '',
    },
    args: {
      // EN: ❌ Unrecognised Argument
      unrecognisedArgument: '',
      // EN: Did not understand {args}, so nothing was run.\n\n{accepts}\n\nFlags must be typed exactly. Copying a usage line brings its `[ ]` or `< >` along, and a wrapped flag is not that flag.
      nothingWasRun: '',
      // EN: This subcommand accepts: {known}
      acceptsFlags: '',
      // EN: This subcommand takes no flags.
      acceptsNoFlags: '',
    },
    migrate: {
      // EN: ✅ No Pending Migrations
      noPendingMigrations: '',
      // EN: All plugin schema versions are up to date.
      allPluginSchemaVersions: '',
      // EN: ❌ DB Service Not Available
      dbServiceNotAvailable: '',
      // EN: The database service has not been initialised.
      theDatabaseServiceHas: '',
      // EN: 📋 Schema Status — All Current
      schemaStatusAllCurrent: '',
      // EN: Nothing to force-migrate.
      nothingToForceMigrate: '',
      // EN: 📋 Dry Run Complete
      dryRunComplete: '',
      // EN: No preview data available — pending migrations exist but lack description/touches metadata.
      noPreviewDataAvailable: '',
      // EN: \nRun without `--dry-run` to execute {totalSkipped} migration(s).
      runWithoutDryRun: '',
      // EN: 📋 Migration Preview
      migrationPreview: '',
      // EN: 🟢 Schema Verification — No Drift Detected
      schemaVerificationNoDrift: '',
      // EN: All registered models match the live database schema.
      allRegisteredModelsMatch: '',
      // EN: 🔍 Schema Verification — Drift Detected
      schemaVerificationDriftDetected: '',
      // EN: ❌ Scan Failed
      scanFailed: '',
      // EN: Could not list tables: {message}
      couldNotListTables: '',
      // EN: 🧹 No Deprecated Objects
      noDeprecatedObjects: '',
      // EN: No deprecated tables or columns found.
      noDeprecatedTablesOr: '',
      // EN: 🧹 Deprecated Objects Found ({totalDeprecated})
      deprecatedObjectsFound: '',
      // EN: Usage: `!s3 migrate <pending|status|force [--dry-run]|preview|verify|purge-deprecated>`
      usageS3MigratePending: '',
      // EN: Token: `{token}`
      tokenLine: '',
      // EN: 📋 Schema Status — Pending Migrations
      schemaStatusPendingMigrations: '',
      // EN: 🟠 v{current} → v{expected} ({behind} behind)
      pluginVersionBehind: '',
      // EN: 🟢 v{current} (current)
      pluginVersionCurrent: '',
      // EN: **{pluginName}**: {status}
      pluginVersionLine: '',
      // EN: No plugins have registered schema versions.
      noPluginsRegistered: '',
      // EN:     ↳ Creates table: `{table}`
      createsTable: '',
      // EN:     ↳ Columns: {columns}
      columnsList: '',
      // EN:     ↳ Columns (`{table}`): {columns}
      columnsForTable: '',
      // EN: **❌ Errors**
      errorsHeading: '',
      // EN: **🗑️ Missing Columns**
      missingColumnsHeading: '',
      // EN: **🧩 Missing Rows**
      missingRowsHeading: '',
      // EN: **🕳️ Unpopulated Data**
      unpopulatedDataHeading: '',
      // EN: **📦 Extra Columns**
      extraColumnsHeading: '',
      // EN: {offenders} row(s) with empty `{column}`
      rowsWithEmpty: '',
      // EN: **📦 Deprecated Tables ({count})**
      deprecatedTablesHeading: '',
      // EN: **📦 Deprecated Columns ({count})**
      deprecatedColumnsHeading: '',
      // EN: Type `!s3 migrate purge-deprecated --confirm` to permanently delete {count} deprecated object(s).
      typeToPurge: '',
      // EN: Table `{table}`: {error}
      errorTable: '',
      // EN: Column `{table}`.`{column}`: {error}
      errorColumn: '',
      // EN: Dropped {count} deprecated table(s).
      droppedTables: '',
      // EN: Dropped {count} deprecated column(s).
      droppedColumns: '',
      // EN: **⚠️ Errors ({count})**
      errorsCountHeading: '',
    },
    confirm: {
      // EN: Usage: `!s3 confirm <token>` — token shown in the startup migration prompt.
      usageS3ConfirmToken: '',
      // EN: Check `!s3 migrate status` to see if migrations are pending.
      checkS3MigrateStatus: '',
      // EN: ❌ Migration Engine Not Available
      migrationEngineNotAvailable: '',
      // EN: The database service or migration engine has not been initialised.
      theDatabaseServiceOr: '',
      // EN: ❌ Invalid or Expired Token
      invalidOrExpiredToken: '',
      // EN: The token did not match the latest migration prompt, or the 5-minute window expired.
      theTokenDidNot: '',
      // EN: Check `!s3 migrate status` for pending migrations and use `!s3 migrate force` to bypass the confirmation flow.
      checkS3MigrateStatus2: '',
      // EN: ✅ No Pending Migrations
      noPendingMigrations: '',
      // EN: Token accepted, but no migrations are pending. All plugin schema versions are up to date.
      tokenAcceptedButNo: '',
    },
    backup: {
      // EN: 📦 No Backups Found
      noBackupsFound: '',
      // EN: No database backups have been created yet. Use `!s3 backup create` to create one now, or run a migration with `!s3 migrate force` to trigger a backup first.
      noDatabaseBackupsHave: '',
      // EN: 📦 Database Backups ({backupsCount})
      databaseBackups: '',
      // EN: 📄 Format Legend
      formatLegend: '',
      // EN: 🗄️ SQLite file copy | 📄 JSON (connector-agnostic)
      sqliteFileCopyJson: '',
      // EN: ⚠️ Restore
      restore: '',
      // EN: To restore a backup: `!s3 backup restore <filename>`\nThis will **restore** the database from the backup. Use with extreme caution.
      toRestoreABackup: '',
      // EN: \nGet the filename from `!s3 backup list`.
      getTheFilenameFrom: '',
      // EN: ❌ Backup Not Found
      backupNotFound: '',
      // EN: No backup named `{filename}` exists. Use `!s3 backup list` to see available backups.
      noBackupNamedFilename: '',
      // EN: ⚠️ Confirm Database Restore
      confirmDatabaseRestore: '',
      // EN: This will **restore** the database from backup `{filename}` ({sizeFormatted}, {age}).
      thisWillRestoreThe: '',
      // EN: JSON (connector-agnostic)
      jsonConnectorAgnostic: '',
      // EN: To proceed, use:\n`!s3 backup restore --confirm
      toProceedUseS3: '',
      // EN: ⏳ Restoring Database…
      restoringDatabase: '',
      // EN: Reading `{filename}` and upserting rows. This can take several minutes on a large backup — the result will be posted here when it finishes. **Do not re-run this command in the meantime.**
      readingFilenameAndUpserting: '',
      // EN: ✅ Database Restored
      databaseRestored: '',
      // EN: Successfully restored `{filename}`. {summary}\nRestart SquadJS for changes to be fully picked up by in-memory caches.
      successfullyRestoredFilenameSummary: '',
      // EN: ❌ Restore Failed
      restoreFailed: '',
      // EN: ❌ DB Service Not Ready
      dbServiceNotReady: '',
      // EN: The database service is not mounted.
      theDatabaseServiceIs: '',
      // EN: ⏳ Creating Backup…
      creatingBackup: '',
      // EN: Exporting all tables to JSON. This can take a while on a large database — the result will be posted here when it finishes.
      exportingAllTablesTo: '',
      // EN: ❌ Backup Failed
      backupFailed: '',
      // EN: Could not create backup. Check disk space and permissions.
      couldNotCreateBackup: '',
      // EN: ✅ Backup Created
      backupCreated: '',
      // EN: Saved `{filename}` ({sizeBytes}) to `backups/` directory.
      savedTo: '',
      // EN: Use `!s3 backup list` to see all available backups.
      useS3BackupList: '',
      // EN: Usage: `!s3 backup <create|list|restore [--confirm] <filename>>`
      usageS3BackupCreate: '',
      // EN: Source
      source: '',
      // EN: Target
      target: '',
      // EN: Format
      format: '',
      // EN: Instructions
      instructions: '',
      // EN: SQLite file copy
      sqliteFileCopy: '',
    },
    db: {
      // EN: 💾 Database Commands
      databaseCommands: '',
      // EN: 🔴 DB Service Not Ready
      dbServiceNotReady: '',
      // EN: The database service is not mounted.
      theDatabaseServiceIs: '',
      // EN: 💾 DB Status — {statusEmoji} {statusText}
      dbStatus: '',
      // EN: Schema Versions
      schemaVersions: '',
      // EN: No plugins have registered schema versions.
      noRegisteredSchemaVersions: '',
      // EN: {okCount} table(s) exported successfully.
      exportTruncatedSummary: '',
      // EN: 🟢 {expectedCount} registered
      registered: '',
      // EN: Migrations Engine
      migrationsEngine: '',
      // EN: 🟢 Available
      available: '',
      // EN: ⚪ N/A
      notAvailable: '',
      // EN: Per-Plugin Versions
      perPluginVersions: '',
      // EN: ❌ DB Service Not Ready
      dbServiceNotReady2: '',
      // EN: ⏳ Exporting ({tier})…
      exportingTier: '',
      // EN: Streaming tables to a backup file. This can take a while on a large database — the summary will be posted here when it finishes.
      streamingTablesToA: '',
      // EN: ❌ Export Failed
      exportFailed: '',
      // EN: Could not write the export file. Check disk space and permissions on the `backups/` directory.
      couldNotWriteThe: '',
      // EN: 📄 File
      file: '',
      // EN: `backups/{filename}` ({sizeBytes}, {totalRows} rows)
      backupsFilename: '',
      // EN: Connector: `{connector}`
      connectorConnector: '',
      // EN: 📎 No attachment
      noAttachment: '',
      // EN: {reason}. The full export is on the server at `backups/{filename}`.
      reasonTheFullExport: '',
      // EN: ✅ Export Complete ({tier})
      exportCompleteTier: '',
      // EN: Discord rejected the upload ({message}). The full export is on the server at `backups/{filename}`.
      discordRejectedTheUpload: '',
      // EN: ⚠️ No Staged Import
      noStagedImport: '',
      // EN: No import has been staged. First attach a `.s3backup.json` file: `!s3 db import` (with attachment).
      noImportHasBeen: '',
      // EN: 📋 Dry Run Complete
      dryRunComplete: '',
      // EN: ⚠️ Warnings
      warnings: '',
      // EN: ❌ Import Failed
      importFailed: '',
      // EN: ⚠️ No Import File
      noImportFile: '',
      // EN: Attach a `.s3backup.json` or `.json` file to this command.\n\nUsage: `!s3 db import` (with file attached) → review confirmation embed → `!s3 db import --confirm` to execute.
      attachAS3backupJson: '',
      // EN: ❌ Invalid Import File
      invalidImportFile: '',
      // EN: 📋 Import Preview — nothing has been imported
      importPreviewNothingHas: '',
      // EN: ❌ Import Parse Failed
      importParseFailed: '',
      // EN: Usage: `!s3 db <status|export [--logs|--all] | import [--confirm] [--dry-run]>`
      usageS3DbStatus: '',
      // EN: `!s3 db status` — Connector type, schema version status per plugin
      s3DbStatusConnector: '',
      // EN: `!s3 db export` — Export essential (historical) tables as JSON
      s3DbExportExport: '',
      // EN: `!s3 db export --logs` — Include event log tables (player/game-state events)
      s3DbExportLogs: '',
      // EN: `!s3 db export --all` — Include all tables (incl. auto-recoverable state)
      s3DbExportAll: '',
      // EN: `!s3 db export --to-file` — Skip the attachment; leave it in backups/ only
      s3DbExportTo: '',
      // EN: Every export is written to `backups/` first and attached here only if the
      everyExportIsWritten: '',
      // EN: compressed file fits under Discord's 25MB limit — the summary always names it.
      compressedFileFitsUnder: '',
      // EN: `!s3 db import` — Import from attached .s3backup.json
      s3DbImportImport: '',
      // EN: `!s3 db import --confirm [--dry-run]` — Execute or validate staged import
      s3DbImportConfirm: '',
      // EN: Existing plugin commands (not replaced):
      existingPluginCommandsNot: '',
      // EN: `!elo backup / !elo restore` — Elo-only rating export
      eloBackupEloRestore: '',
      // EN: `!teambalancer export` — Round reports JSONL export
      teambalancerExportRoundReports: '',
      // EN: Connector
      connector: '',
      // EN: Read and validated the attached file. **No data has been written.**
      readAndValidatedThe: '',
      // EN: **{tableCount} tables**, ~{totalRows} total rows
      tablesAndRows: '',
      // EN: **To import for real:** `!s3 db import --confirm`
      toImportForReal: '',
      // EN: `--confirm --dry-run` re-reports these counts without writing; it does **not** check them against the live schema.
      confirmDryRunRe: '',
      // EN: Rows are upserted by primary key. No existing rows are deleted.
      rowsAreUpsertedBy: '',
      // EN: ✅ Import Complete
      importComplete: '',
      // EN: Import data is not a valid JSON object.
      importNotJsonObject: '',
      // EN: Unsupported export format version: {version}. Expected 1.
      importUnsupportedVersion: '',
      // EN: Import data has no "tables" object.
      importNoTablesObject: '',
      // EN: Table "{table}" is not a known model — will be skipped during import.
      importUnknownTableSkipped: '',
      // EN: Table "{table}" is not a known model — skipped.
      importUnknownTableSkippedStream: '',
    },
    onDiscordMessage: {
      // EN: ⚠️ Error: !s3 {sub}
      errorS3Sub: '',
    },
    pushLineField: {
      // EN: {name} (cont.)
      nameCont: '',
      // EN: *…and {droppedLines} more (output truncated).*
      andMoreOutput: '',
    },
    availabilityWarning: {
      // EN: 🔴 Database Not Ready
      databaseNotReady: '',
      // EN: The S³ database service is not mounted, or the `S3_PlayerEvents` table does not exist yet.
      theSDatabaseService: '',
      // EN: 🟠 No Event Data Logged In This Range
      noEventDataLogged: '',
      // EN: No `S3_PlayerEvents` rows exist anywhere in the requested date range.
      noS3PlayereventsRows: '',
      // EN: This almost always means `enableDatabaseLogging` was off for the whole window, not that nothing happened — check the S³ config before trusting a "0" result.
      thisAlmostAlwaysMeans: '',
    },
    ambiguousPlayer: {
      // EN: 🟠 Ambiguous Player
      ambiguousPlayer: '',
      // EN: Multiple players match `{identifier}`. Retry with a full eosID/steamID:
      multiplePlayersMatchIdentifier: '',
      // EN: Candidates
      candidates: '',
    },
    playerNotFound: {
      // EN: ❌ Player Not Found
      playerNotFound: '',
      // EN: No player matching `{identifier}` was found in the switch-event log.
      noPlayerMatchingIdentifier: '',
    },
    help: {
      // EN: 📖 S³ Command Reference
      sCommandReference: '',
      // EN: 🔍 Inspection
      inspection: '',
      // EN: `!s3 status` — Overview: services, phase, players, locks
      s3StatusOverviewServices: '',
      // EN: `!s3 services` — Per-service mount status with detail
      s3ServicesPerService: '',
      // EN: `!s3 gamestate` — Detailed game state (phase, matchId, timer)
      s3GamestateDetailedGame: '',
      // EN: `!s3 factions` — Team names, abbreviations, polling status
      s3FactionsTeamNames: '',
      // EN: `!s3 players` — Population overview + per-team squad rosters
      s3PlayersPopulationOverview: '',
      // EN: `!s3 clans` — Clan groups, plus why tags were excluded or merged
      s3ClansClanGroups: '',
      // EN: `!s3 locks` — Global and per-player locks
      s3LocksGlobalAnd: '',
      // EN: `!s3 config` — Server configuration values
      s3ConfigServerConfiguration: '',
      // EN: 📊 Reports
      reports: '',
      // EN: `!s3 switches [range]` — Team-switch leaderboard, all players (Legacy pre-split Balancer moves fold into Full)
      s3SwitchesRangeTeam: '',
      // EN: `!s3 switches <ident> [range]` — One player's switch breakdown by source
      s3SwitchesIdentRange: '',
      // EN: `!s3 switches export [range] [period] [--json]` — One row per period per active player — games played, total switches, and source breakdown — as a file attachment
      s3SwitchesExportRange: '',
      // EN: `!s3 karma <ident> [range]` — Win-rate of a player's own switch decisions (self/untracked, not balancer/SmartAssign) vs. round outcome, with switch frequency (N switches in G games)
      s3KarmaIdentRange: '',
      // EN: `range`: `7d`, `30d` (default), `2w`, or `YYYY-MM-DD..YYYY-MM-DD` (max 180 days)
      range7d30dDefault: '',
      // EN: `period`: `daily`, `weekly` (default), or `monthly` — `--json` switches the attachment from CSV to JSON
      periodDailyWeeklyDefault: '',
      // EN: 🔬 Debug
      debug: '',
      // EN: *(No debug commands available)*
      noDebugCommandsAvailable: '',
      // EN: 💾 Database
      database: '',
      // EN: `!s3 db status` — Connector type, schema version status per plugin
      s3DbStatusConnector: '',
      // EN: `!s3 db export` — Export essential tables as JSON
      s3DbExportExport: '',
      // EN: `!s3 db export --logs` — Include event log tables
      s3DbExportLogs: '',
      // EN: `!s3 db export --all` — Include all tables (incl. ephemeral)
      s3DbExportAll: '',
      // EN: `!s3 db export --to-file` — Skip the attachment; leave it in backups/ only
      s3DbExportTo: '',
      // EN: `!s3 db import` — Import from attached .s3backup.json
      s3DbImportImport: '',
      // EN: `!s3 db import --confirm [--dry-run]` — Execute or validate import
      s3DbImportConfirm: '',
      // EN: ⚙️ Maintenance
      maintenance: '',
      // EN: `!s3 migrate pending` — Show pending schema migrations
      s3MigratePendingShow: '',
      // EN: `!s3 migrate status` — Show schema version status per plugin
      s3MigrateStatusShow: '',
      // EN: `!s3 confirm <token>` — Confirm and run pending migrations from startup prompt
      s3ConfirmTokenConfirm: '',
      // EN: `!s3 migrate force [--dry-run]` — Run pending migrations
      s3MigrateForceDry: '',
      // EN: `!s3 migrate preview` — Preview pending migration descriptions/touches
      s3MigratePreviewPreview: '',
      // EN: `!s3 migrate verify` — Run on-demand schema drift check
      s3MigrateVerifyRun: '',
      // EN: `!s3 migrate purge-deprecated` — Clean up deprecated tables/columns
      s3MigratePurgeDeprecated: '',
      // EN: `!s3 backup create` — Create a backup now (JSON, connector-agnostic)
      s3BackupCreateCreate: '',
      // EN: `!s3 backup list` — List backups (SQLite + JSON)
      s3BackupListList: '',
      // EN: `!s3 backup restore <filename>` — Restore from file backup (auto-detects format)
      s3BackupRestoreFilename: '',
      // EN: 🧪 Diagnostic
      diagnostic: '',
      // EN: `!s3 diag` — Run all service checks (mounts, phase, factions, players, locks)
      s3DiagRunAll: '',
      // EN: ℹ️ Cross-Ref: Existing Plugin Commands
      crossRefExistingPlugin: '',
      // EN: `!elo backup / !elo restore` — Elo-only rating export
      eloBackupEloRestore: '',
      // EN: `!teambalancer export` — Round reports JSONL export
      teambalancerExportRoundReports: '',
    },
    migration: {
      // EN: ⚠️ S³ Migration Required
      sMigrationRequired: '',
      // EN: 🔄 S³ Migration In Progress
      sMigrationInProgress: '',
      // EN: ✅ S³ Migration Complete
      sMigrationComplete: '',
      // EN: ❌ S³ Migration Failed
      sMigrationFailed: '',
      // EN: ⏹️ S³ Migration Cancelled
      sMigrationCancelled: '',
      // EN: ⏰ S³ Migration Auto-Cancelled
      sMigrationAutoCancelled: '',
      // EN: (new)
      versionNew: '',
      // EN:   {pluginName}: {fromVer} → v{toVer} ({behind} pending)
      lineWithPending: '',
      // EN:   {pluginName}: {fromVer} → v{toVer}
      line: '',
      // EN: Type `!s3 confirm <token>` to run migrations.
      typeConfirmToRun: '',
      // EN: Type `!s3 migrate force` to bypass confirmation.
      typeForceToBypass: '',
      // EN: Auto-cancels after 5 minutes if no response.
      autoCancelsAfterMinutes: '',
      // EN: > **Note:** If cancelled, migrations remain pending.
      noteIfCancelledPending: '',
      // EN: > Use `!s3 migrate force` to run them later.
      noteUseForceLater: '',
      // EN: Applied: **{totalApplied}** | Skipped: **{totalSkipped}**
      appliedSkipped: '',
      // EN: Unknown error
      unknownError: '',
      // EN: **Error:** {errorMsg}
      errorLine: '',
      // EN: Migrations have been deferred. The pending state will persist until the next restart or `!s3 migrate force`.
      deferredUntilRestart: '',
    },
    watch: {
      // EN: ⏰ Watch Expired
      watchExpired: '',
      // EN: Watch for `{services}` automatically stopped after {duration}.
      watchForServicesAutomatically: '',
      // EN: 🔬 Watch Started
      watchStarted: '',
      // EN: Relaying verbose logs for `{target}` to this channel for {duration}. Use `!s3 unwatch` to stop early.
      relayingVerboseLogs: '',
      // EN: 🛑 Watch Stopped
      watchStopped: '',
      // EN: Stopped {count} active watch(es): {list}
      stoppedActiveWatches: '',
      // EN: No active watches to stop.
      noActiveWatches: '',
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
      // EN: Invalid range "{arg}" — must be a positive number of days/weeks.
      rangeInvalidNumber: '',
      // EN: Invalid date range "{arg}".
      rangeInvalidDates: '',
      // EN: Could not parse range "{arg}". Use "30d", "2w", or "YYYY-MM-DD..YYYY-MM-DD".
      rangeUnparseable: '',
      // EN: **{rank}.** {name} — {total} switches ({games} games) · {fullStr} · Micro: {micro} · Self: {self}{otherStr}
      leaderboardRow: '',
      // EN: Full: {full}
      leaderboardFull: '',
      // EN: Full: {full} ({legacy} legacy)
      leaderboardFullWithLegacy: '',
      // EN:  · Other: {other}
      leaderboardOther: '',
    },
  },
  switch: {
    warn: {
      // EN: Swapped {name} and {name2}.
      swapped: '',
      // EN: One or both players not found.
      oneBothPlayersNot: '',
      // EN: Player "{name}" queued for switch at match end.
      playerQueuedSwitchMatch: '',
      // EN: Failed to queue "{name}": {err}
      failedQueue: '',
      // EN: Squad {commandSplit1} ({commandSplit2}): {queuedCount} player(s) queued for switch at match end.
      squadPlayerSQueued: '',
      // EN: Failed to queue squad {commandSplit1}: {err}
      failedQueueSquad: '',
      // EN: Triggering match-end switch sequence...
      triggeringMatchEndSwitch: '',
      // EN: Match-end switch sequence complete.
      matchEndSwitchSequence: '',
      // EN: Player not found.
      playerNotFound: '',
      // EN: Multiple players found. Please use SteamID.
      multiplePlayersFoundPlease: '',
      // EN: Status: {player} | Locked: {locked} | {cooldownMsg}
      statusLocked: '',
      // EN: Player not found or multiple matches.
      playerNotFoundMultiple: '',
      // EN: Cleared restrictions for {player} (seed tokens kept).
      clearedRestrictionsSeedTokens: '',
      // EN: Clear failed: {message}
      clearFailed: '',
      // EN: Restrictions cleared — {toppedUp} topped up, {locksCleared} scramble locks lifted. Seed tokens kept. Use !switch wipe confirm to delete all rows.
      restrictionsClearedToppedUp: '',
      // EN: Clear all failed: {message}
      clearAllFailed: '',
      // EN: Wipe DELETES every cooldown row, including earned seed tokens. This cannot be undone.
      wipeDeletesEveryCooldown: '',
      // EN: Type !switch wipe confirm to proceed, or !switch clearall to lift restrictions without deleting anything.
      typeSwitchWipeConfirm: '',
      // EN: Wiped {deleted} cooldown rows — every player is back to a clean default.
      wipedCooldownRowsEvery: '',
      // EN: Wipe failed: {message}
      wipeFailed: '',
    },
    errors: {
      // EN: [Switch] Incompatible S³ version: got {{actual}}, need >={{required}}. Please update SlackersSquadServices.
      incompatibleS3Version: '',
      // EN: no eosID could be resolved (steamID={{steamID}})
      noEosIDResolved: '',
      // EN: Team change failed for {{eosID}} after {{attempts}} attempts (source={{source}})
      teamChangeFailed: '',
    },
    discord: {
      // EN: 🌪️ Scramble Lockdown Initiated
      scrambleEmbedTitle: '',
      // EN: {{count}} players have been locked from switching for the next {{minutes}} minutes.
      scrambleEmbedDescription: '',
      // EN: Lockdown Duration
      scrambleFieldDurationName: '',
      // EN: {{minutes}} minutes
      scrambleFieldDurationValue: '',
      // EN: Expires At
      scrambleFieldExpiresName: '',
      // EN: Players Affected
      scrambleFieldPlayersName: '',
      // EN: Usage: `!switch check <SteamID|Name>`
      usageSwitchCheckSteamid: '',
      // EN: Player not found in database.
      playerNotFoundDatabase: '',
      // EN: ⚠️ Ambiguous result: Multiple matches found. Please refine your search string or use a SteamID.
      ambiguousResultMultipleMatches: '',
      // EN: Usage: `!switch clear <SteamID|Name>`
      usageSwitchClearSteamid: '',
      // EN: Player not found or multiple matches.
      playerNotFoundMultiple: '',
      // EN: ✅ Cleared restrictions for **{player}** ({detail}). Seed tokens kept.
      clearedRestrictionsSeedTokens: '',
      // EN: ❌ Clear failed: {message}
      clearFailed: '',
      // EN: ✅ Restrictions cleared — **{toppedUp}** topped up to {maxSwitchTokens}, **{locksCleared}** scramble locks lifted. Earned seed tokens kept; use `!switch wipe confirm` to delete every row.
      restrictionsClearedToppedUp: '',
      // EN: ❌ Clear all failed: {message}
      clearAllFailed: '',
      // EN: ⚠️ `!switch wipe` **deletes every cooldown row**, including earned seed tokens. This cannot be undone.\n
      switchWipeDeletesEvery: '',
      // EN: Run `!switch wipe confirm` to proceed, or `!switch clearall` to lift restrictions without deleting anything.
      runSwitchWipeConfirm: '',
      // EN: 🗑️ Wiped **{deleted}** cooldown rows — every player is back to a clean default.
      wipedCooldownRowsEvery: '',
      // EN: ❌ Wipe failed: {message}
      wipeFailed: '',
      // EN: ✅ Switch time limit **{status}**. Players {detail}.
      switchTimeLimitPlayers: '',
      // EN: ❌ Failed to update setting: {message}
      failedUpdateSetting: '',
      // EN: Could not generate explain content at this time.
      couldNotGenerateExplain: '',
      // EN: Failed to generate explain output: {message}
      failedGenerateExplainOutput: '',
    },
    labels: {
      // EN: Tokens: 0/{maxSwitchTokens}, next in {remaining}m
      tokensEmptyNextIn: '',
      // EN: Tokens: {tokenBalance}/{maxSwitchTokens}
      tokensBalance: '',
      // EN: Cooldown: {state}
      cooldownState: '',
      // EN: Yes
      yes: '',
      // EN: No
      no: '',
      // EN: {tokensBefore} → {tokensAfter} tokens{lockNote}
      clearDetail: '',
      // EN: , scramble lock lifted
      scrambleLockLifted: '',
      // EN: no row found — already unrestricted
      clearDetailNoRow: '',
      // EN: enabled
      enabled: '',
      // EN: disabled
      disabled: '',
      // EN: must switch within the first minutes of joining or match start
      timeLimitOnDetail: '',
      // EN: can switch at any time regardless of join/match time
      timeLimitOffDetail: '',
      // EN: Your request has been queued.
      queueReasonQueued: '',
      // EN: Other players are already waiting in the queue.
      queueReasonOthersWaiting: '',
      // EN: Teams are currently full on that side.
      queueReasonTeamsFull: '',
      // EN: none
      none: '',
      // EN: Liberal (Seed/Jensen)
      modeLiberal: '',
      // EN: Standard
      modeStandard: '',
    },
    explain: {
      // EN: All population levels
      allPopulationLevels: '',
      // EN: Dynamic tolerance is disabled. The base limit applies at all player counts.
      dynamicToleranceDisabledBase: '',
      // EN: Squad's native team change command is disabled on this server. **`'!switch'`** is how you change teams. The plugin enforces balance rules to keep teams fair while still allowing you to play with your friends.
      squadSNativeTeam: '',
      // EN: **`'!switch'`** is an alternative way to change teams. The plugin enforces balance rules to keep teams fair while still allowing you to play with your friends.
      switchAlternativeWayChange: '',
      // EN: **`'!switch'`**        Request a team change
      switchRequestTeamChange: '',
      // EN: **`'!switch check'`**  See your eligibility and token balance
      switchCheckSeeEligibility: '',
      // EN: **`'!switch cancel'`** Leave the switch queue
      switchCancelLeaveSwitch: '',
      // EN: Switching from the bigger team to the smaller team is usually allowed.
      switchingFromBiggerTeam: '',
      // EN: Switching from the smaller team to the bigger team is only allowed if the gap stays within the balance limit (see below).
      switchingFromSmallerTeam: '',
      // EN: How Team Switching Works
      howTeamSwitchingWorks: '',
      // EN: \n*All three commands are typed in all, team or squad chat.*
      allThreeCommandsTyped: '',
      // EN: Key Rule
      keyRule: '',
      // EN: The **gap** is the difference in player count between the two teams.
      gapDifferencePlayerCount: '',
      // EN: Example: Team **1** has **42** players, Team **2** has **38**. The gap is **4**.
      exampleTeam1Has: '',
      // EN: **Tolerance** is how much extra gap the server allows beyond the base limit of **{cap}**. At low population, more tolerance is given so switches are easier. As the server fills up, tolerance shrinks to keep teams fair when it matters most.
      toleranceHowMuchExtra: '',
      // EN: Players       Extra Tolerance   Max Allowed Gap
      playersExtraToleranceMax: '',
      // EN: Example: With **{range}** population, the max allowed gap is **{gap}**.
      exampleWithPopulationMax: '',
      // EN: If the bigger team leads by **{gap}**, a switch from the bigger team is allowed (gap shrinks to **{value}**).
      ifBiggerTeamLeads: '',
      // EN: A switch from the smaller team is not allowed (gap would grow to **{value}**, exceeding the max of **{gap}**).
      switchFromSmallerTeam: '',
      // EN: Each team can hold at most **{maxTeamSize}** players (half of **{maxPlayers}** total slots, including **{reserved}** reserved).
      eachTeamCanHold: '',
      // EN: You cannot switch to a team that is already at **{maxTeamSize}**.
      cannotSwitchTeamAlready: '',
      // EN: Balance Rules
      balanceRules: '',
      // EN: A switch is allowed if it does not make the teams too lopsided. The rules depend on how many players are on the server.
      switchAllowedIfDoes: '',
      // EN: What the numbers mean
      whatNumbersMean: '',
      // EN: Tolerance Table
      toleranceTable: '',
      // EN: Hard Cap
      hardCap: '',
      // EN: Maximum tokens: **{maxTokens}**
      maximumTokens: '',
      // EN: Refill time: **{cooldownStr}** per token
      refillTimePerToken: '',
      // EN: Tokens refill one at a time, independently. With **{maxTokens}** tokens saved, you can switch {value} before waiting for a refill. This gives you flexibility without allowing unlimited switching.
      tokensRefillOneTime: '',
      // EN: up to {maxTokens} times
      upToNTimes: '',
      // EN: once
      onceOnly: '',
      // EN:  (only while **{seedBonusMinPlayers}+** players are online)
      onlyWhilePlayersOnline: '',
      // EN: During seed rounds, you earn **+1** bonus token for every **{seedBonusMinutes}** minutes you are present{minNote}.
      duringSeedRoundsEarn: '',
      // EN: If the round ends before you have banked a full **{seedBonusMinutes}** minutes, you still get **+1** — as long as you are still on the server when it ends.
      ifRoundEndsBefore: '',
      // EN: Bonus tokens stack above your normal cap of **{maxTokens}**, up to a hard ceiling of **{seedBonusAmount}**. At the ceiling you stop earning until you spend one.
      bonusTokensStackAbove: '',
      // EN: Seed Bonus
      seedBonus: '',
      // EN: Token Pool
      tokenPool: '',
      // EN: How It Works
      howWorks: '',
      // EN: Checking Your Balance
      checkingBalance: '',
      // EN: Use **`'!switch check'`** to see your current token balance and when your next token refills.
      useSwitchCheckSee: '',
      // EN: Switch Tokens
      switchTokens: '',
      // EN: Each **`'!switch'`** costs **1** token. Tokens refill automatically over time. You are not locked out for a full cooldown after a single switch.
      eachSwitchCosts1: '',
      // EN: Switch Cooldown
      switchCooldown: '',
      // EN: After using **`'!switch'`**, you must wait before switching again.
      afterUsingSwitchMust: '',
      // EN: Cooldown: **{cooldownStr}**\n\nYou cannot switch again until the cooldown expires. Use **`'!switch check'`** to see your remaining cooldown time.
      cooldownCannotSwitchAgain: '',
      // EN: You have **{switchWindow} minutes** after joining the server
      haveMinutesAfterJoining: '',
      // EN: **OR** after the match starts, whichever gives you more time.
      afterMatchStartsWhichever: '',
      // EN: If you join mid-match, your personal time window starts when you joined.
      ifJoinMidMatch: '',
      // EN: Once both windows close, **`'!switch'`** is unavailable for the rest of the match.
      onceBothWindowsClose: '',
      // EN: If no switch slot is immediately available, you are placed in a queue.
      ifNoSwitchSlot: '',
      // EN: The queue holds your spot and processes switches as soon as a slot opens.
      queueHoldsSpotProcesses: '',
      // EN: For example, when someone on the other team also types **`'!switch'`**, that creates room for you to move.
      exampleWhenSomeoneOther: '',
      // EN: The queue checks for available slots every few seconds as the server updates its player counts. It will not act on incomplete or stale data.
      queueChecksAvailableSlots: '',
      // EN: Note: the in-game scoreboard can be slow to update. The queue uses its own player count tracking and is more reliable than the scoreboard.
      noteGameScoreboardCan: '',
      // EN: You have **{queueTimeout} minutes** in the queue before your request expires.
      haveMinutesQueueBefore: '',
      // EN: If your queue request reaches the **{queueTimeout}-minute** time limit without a normal slot opening, the system will force-switch you with a slightly relaxed balance limit. This is a fallback so you are not left stranded. The normal balance rules are your best path.
      ifQueueRequestReaches: '',
      // EN: When a queued switch expires, you are removed from the queue.
      whenQueuedSwitchExpires: '',
      // EN: Use **`'!switch cancel'`** to leave the queue at any time.
      useSwitchCancelLeave: '',
      // EN: The queue is currently disabled.
      queueCurrentlyDisabled: '',
      // EN: If no slot is available when you request a switch, you will need to try again later.
      ifNoSlotAvailable: '',
      // EN: Use **`'!switch check'`** to see if a slot is available.
      useSwitchCheckSee2: '',
      // EN: Time Window & Queue
      timeWindowQueue: '',
      // EN: You can only use **`'!switch'`** during a limited window.{value}
      canOnlyUseSwitch: '',
      // EN: Time Window
      timeWindow: '',
      // EN: The Queue
      queue: '',
      // EN: Queue Status
      queueStatus: '',
      // EN: The scrambler keeps squads and clans together. Your squad and clan group will not be split up.
      scramblerKeepsSquadsClans: '',
      // EN: When a clan group is kept together, the rest of their squad is pulled along with them. No one gets left behind.
      whenClanGroupKept: '',
      // EN: Team balancing configuration was not available at the time this was generated. Check with an admin for scramble details.
      teamBalancingConfigurationWas: '',
      // EN: After a scramble, **`'!switch'`** is locked for all players for **{lockdownMinutes} minutes**.
      afterScrambleSwitchLocked: '',
      // EN: This prevents players from undoing the scramble by switching back.
      preventsPlayersFromUndoing: '',
      // EN: The system is designed to help you play with your friends, even when things go wrong. If a scramble fails to move you, or you reconnect to the wrong team, your restrictions are cleared so you can fix it yourself.
      systemDesignedHelpPlay: '',
      // EN: You are **NOT** locked after a scramble if:
      notLockedAfterScramble: '',
      // EN: - You are still within your **{value}-minute** join/match window.
      stillWithinMinuteJoin: '',
      // EN: - You were already in the switch queue before the scramble fired.
      wereAlreadySwitchQueue: '',
      // EN: - The scramble **failed to move you** (RCON error). Your scramble lock is cleared and you may receive a **+1 switch token** so you can use `!switch` immediately to rejoin your group.
      scrambleFailedMoveRcon: '',
      // EN: - The scramble failed to keep your squad or clan together. In this case, you are given extra leniency to switch back to your group when your join/match window opens.
      scrambleFailedKeepSquad: '',
      // EN: - The scramble was a small Elo-correction ("micro scramble") rather than a full rebalance — those move too few players to warrant a lockout, so **no one is locked**.
      scrambleWasSmallElo: '',
      // EN: If you disconnect and reconnect to a different team after a scramble,
      ifDisconnectReconnectDifferent: '',
      // EN: your switch restrictions (including the scramble lockout) are cleared.
      switchRestrictionsIncludingScramble: '',
      // EN: You can use **`'!switch'`** immediately to return to your previous team.
      canUseSwitchImmediately: '',
      // EN: If you reconnect during a faction vote, an ignored game mode, or passive mode,
      ifReconnectDuringFaction: '',
      // EN: your scramble lock is still cleared so you are not stranded. Use `!switch` when the round starts.
      scrambleLockStillCleared: '',
      // EN: Scrambles & Switching
      scramblesSwitching: '',
      // EN: A scramble is when the server shuffles players to rebalance teams after one-sided rounds. After a scramble, switching is temporarily locked.
      scrambleWhenServerShuffles: '',
      // EN: What a Scramble Does
      whatScrambleDoes: '',
      // EN: Post-Scramble Lockout
      postScrambleLockout: '',
      // EN: Lockout Exceptions
      lockoutExceptions: '',
      // EN: Reconnecting After a Scramble
      reconnectingAfterScramble: '',
      // EN: During **{value}** rounds, switching is relaxed:
      duringRoundsSwitchingRelaxed: '',
      // EN: - No time window limit. Switch at any point during the round.
      noTimeWindowLimit: '',
      // EN: - No token cost. Switches do not consume tokens.
      noTokenCostSwitches: '',
      // EN: - More permissive balance limit. Up to **{liberalCap}** players difference is allowed instead of the normal tolerance.
      morePermissiveBalanceLimit: '',
      // EN: During the faction vote screen between rounds, **`'!switch'`** is unavailable.
      duringFactionVoteScreen: '',
      // EN: The queue is paused. When the next round begins, the queue is cleared.
      queuePausedWhenNext: '',
      // EN: You will need to re-queue if you still want to switch.
      willNeedReQueue: '',
      // EN: Special Cases
      specialCases: '',
      // EN: Some game modes and situations change how the normal rules apply.
      someGameModesSituations: '',
      // EN: Faction Vote (Between Rounds)
      factionVoteBetweenRounds: '',
      // EN: **1. Switch early.** Your **{switchWindow}-minute** window starts when you join. Do not wait until the last minute.
      '1SwitchEarlyMinute': '',
      // EN: **2. Save a token.** With **{maxTokens}** tokens, you can switch more than once before waiting for a refill. This gives you flexibility if you need to switch multiple times in a session.
      '2SaveTokenWith': '',
      // EN: **2. Plan your switch.** After switching, you must wait through the full cooldown before switching again. Make every switch count.
      '2PlanSwitchAfter': '',
      // EN: **3. Use seed rounds.** Seed and Jensen rounds have no token cost and no time limit. Use this time to position yourself on the right team for free.
      '3UseSeedRounds': '',
      // EN: **4. Check before you act.** **`'!switch check'`** tells you exactly what is blocking you: time window, tokens, scramble lock, or balance. This helps you make an informed decision.
      '4CheckBeforeAct': '',
      // EN: **5. Squads and clans stay together.** The scrambler preserves squads and clan groups. Even if a scramble fires, your group will not be split up.
      '5SquadsClansStay': '',
      // EN: **6. The system has your back.** Even when things go wrong (a scramble fails to move you, or you reconnect to the wrong team), your restrictions are cleared and you may receive bonus tokens so you can fix it yourself. You are never permanently stranded.
      '6SystemHasBack': '',
      // EN: Tips for Playing With Friends
      tipsPlayingWithFriends: '',
      // EN: The system is designed to help you end up on the same team as your friends. Here is how to make the most of it.
      systemDesignedHelpEnd: '',
      // EN: Best Practices
      bestPractices: '',
      // EN: about {avgSec} seconds
      aboutSeconds: '',
      // EN: {secs} seconds
      durationSeconds: '',
      // EN: N/A
      statNotAvailable: '',
      // EN: **{value}%** of attempted switches succeed.
      attemptedSwitchesSucceed: '',
      // EN: **{value}%** of attempted switches succeed, most requests go through.
      attemptedSwitchesSucceedMost: '',
      // EN: Eligible switches only, requests denied at the eligibility gate (cooldown, time window, etc.) are not counted as attempts.
      eligibleSwitchesOnlyRequests: '',
      // EN: Most switches happen instantly — **{value}%** go through the moment you type `!switch`, with no waiting at all.
      mostSwitchesHappenInstantly: '',
      // EN: **{value}%** of switches happen instantly, the rest use the queue.
      switchesHappenInstantlyRest: '',
      // EN: Switches typically use the queue system.
      switchesTypicallyUseQueue: '',
      // EN: When a queue wait is needed, the typical wait is **{medianStr}**. The average is **{avgStr}**.
      whenQueueWaitNeeded: '',
      // EN: 📊 !switch Reliability — Last 7 Days
      switchReliabilityLast7: '',
      // EN: Switch v{version} · updated
      switchVUpdated: '',
      // EN: {hours} hour
      durationHour: '',
      // EN: {hours} hours
      durationHours: '',
      // EN: {hours} {minutes}
      durationHoursMinutes: '',
      // EN: {mins} minute
      durationMinute: '',
      // EN: {mins} minutes
      durationMinutes: '',
      // EN: You can earn up to **{seedBonusAmount}** bonus token per seed round.
      seedBonusTokenPerRound: '',
      // EN: You can earn up to **{seedBonusAmount}** bonus tokens per seed round.
      seedBonusTokensPerRound: '',
      // EN: about {mins} minute
      aboutMinute: '',
      // EN: about {mins} minutes
      aboutMinutes: '',
      // EN: Based on {switches} {rounds}.
      basedOnSwitchesRounds: '',
      // EN: **{totalSwitches}** successful switch
      successfulSwitch: '',
      // EN: **{totalSwitches}** successful switches
      successfulSwitches: '',
      // EN: across **{rounds}** round
      acrossRound: '',
      // EN: across **{rounds}** rounds
      acrossRounds: '',
      // EN:  If teams are currently full, you will be placed in a queue.
      ifTeamsAreCurrently: '',
      // EN: Commands
      commands: '',
      // EN: Example
      example: '',
      // EN: Cooldown
      cooldown: '',
      // EN: {liberalModes} Rounds
      modeRounds: '',
    },
    backfill: {
      // EN: ❌ No reporting channel configured — there is nothing to read.
      noReportingChannel: '',
      // EN: 🔍 Reading round summaries from the last {days} days...
      starting: '',
      // EN: ❌ Backfill failed: {message}
      failed: '',
      // EN: No round summaries found in the last {days} days.
      nothingFound: '',
      // EN: ✅ Backfill complete — {scanned} summaries read, {inserted} rounds added, {skipped} already stored.
      done: '',
    },
    handleStatsCommand: {
      // EN: ❌ Round stats are not available — the database is still starting up.
      statsDbUnavailable: '',
      // EN: 📊 Summary
      summary: '',
      // EN: 🔄 Movement Types (all {success} successes)
      movementTypesAllSuccess: '',
      // EN: ⛔ Denial Reasons (all {denied} denials)
      denialReasonsAllDenied: '',
      // EN: 📋 Queue Outcomes (all {totalQueueEntries} queue entries)
      queueOutcomesAll: '',
      // EN: ⚠️ Data Quality
      dataQuality: '',
      // EN: No Data
      noData: '',
      // EN: No rounds recorded in this period. Rounds are stored as they end — if the plugin was updated recently, use `!switch backfill` to recover older ones from the round summaries already in the reporting channel.
      noSwitchRoundSummaries: '',
      // EN: Switch Global Stats
      switchGlobalStats: '',
      // EN: {STATS_LOOKBACK_DAYS}-day aggregate · standard-mode rounds
      statsLookbackDaysDay: '',
      // EN: Switch v{version}
      switchVVersion: '',
      // EN: **Rounds:** {count}
      roundsRecorded: '',
      // EN: **Requests/round:** {value}
      requestsPerRound: '',
      // EN: **Total requests:** {count}
      totalRequests: '',
      // EN:   ✅ Succeeded    {count}  ({pct}% of total)
      succeededLine: '',
      // EN:   ⛔ Denied         {count}  ({pct}% of total)
      deniedLine: '',
      // EN:   ❌ Failed           {count}  ({pct}% of total)
      failedLine: '',
      // EN: **Success rate (excl. denials):** {rate}%  ({success}/{attempted})
      successRateLine: '',
      // EN: **Direction:**
      direction: '',
      // EN: **Max queue size reached:** {size}
      maxQueueSizeReached: '',
      // EN: **Queue wait:** mean {mean}{medianPart}
      queueWait: '',
      // EN: , median {median}
      medianPart: '',
      // EN: Instant            {count}{pct}
      moveInstant: '',
      // EN: Queue Solo         {count}{pct}
      moveQueueSolo: '',
      // EN: Queue Pair Trade   {count}{pct}
      moveQueuePairTrade: '',
      // EN: Join Swap          {count}{pct}
      moveJoinSwap: '',
      // EN: Timeout Switch     {count}{pct}
      moveTimeoutSwitch: '',
      // EN: Cooldown           {count}{pct}
      denialCooldown: '',
      // EN: Time Window        {count}{pct}
      denialTimeWindow: '',
      // EN: Scramble Lock     {count}{pct}
      denialScrambleLock: '',
      // EN: Recent Switch     {count}{pct}
      denialRecentSwitch: '',
      // EN: Other                 {count}{pct}
      denialOther: '',
      // EN: Succeeded          {count}{pct}
      outcomeSucceeded: '',
      // EN: Disconnected      {count}{pct}
      outcomeDisconnected: '',
      // EN: Cancelled          {count}{pct}
      outcomeCancelled: '',
      // EN: Expired              {count}{pct}
      outcomeExpired: '',
      // EN: Removed            {count}{pct}
      outcomeRemoved: '',
      // EN: † Expired entries are from rounds where\n  queueTimeoutSwitchEnabled was off.
      expiredFootnote: '',
      // EN: {count} liberal-mode rounds excluded
      liberalRoundsExcluded: '',
      // EN: {count} rounds had incomplete data (pre-v2.2.0 format)
      incompleteRounds: '',
      // EN: {count} rounds lack median data (pre-median embed format)
      missingMedian: '',
      // EN: {count} rounds recovered from history — durations rounded to the second
      backfilledRounds: '',
      // EN: Capped at the most recent {count} rounds — narrow the day range for the full picture
      roundsTruncated: '',
    },
    onDiscordMessage: {
      // EN: 🔍 Player Status
      playerStatus: '',
      // EN: 📜 Switch Plugin Commands
      switchPluginCommands: '',
      // EN: Available commands:
      availableCommands: '',
      // EN: Show database diagnostics and active locks.
      showDatabaseDiagnosticsAnd: '',
      // EN: Check cooldown status for a player.
      checkCooldownStatusFor: '',
      // EN: Lift one player's restrictions (keeps earned seed tokens).
      liftOnePlayerS: '',
      // EN: Lift restrictions for everyone (keeps earned seed tokens).
      liftRestrictionsForEveryone: '',
      // EN: Delete every cooldown row — a full reset, seed tokens included. The word `confirm` is required.
      deleteEveryCooldownRow: '',
      // EN: Admin: Toggle join/match time limit for queue entry.
      adminToggleJoinMatch: '',
      // EN: Aggregate the last N days of recorded rounds (default 60).
      aggregateTheLastN: '',
      // EN: One-shot: recover rounds from older summaries in the reporting channel (default 90 days).
      recoverRoundsFromHistory: '',
      // EN: Generate a detailed explanation of how team switching works.
      generateADetailedExplanation: '',
      // EN: Show this help message.
      showThisHelpMessage: '',
    },
    switchDiag: {
      // EN: 🩺 Switch Plugin Diagnostics  v{VERSION}
      switchPluginDiagnosticsV: '',
      // EN: System Health
      systemHealth: '',
      // EN: 📋 Config
      config: '',
      // EN: 👥 Queue ({totalQueued})
      queueTotalqueued: '',
      // EN: 🕐 Token & Lock Summary
      tokenLockSummary: '',
      // EN: 🔒 Currently Blocked ({blockedCount})
      currentlyBlocked: '',
      // EN: **Switching:** Closed
      switchingClosed: '',
      // EN: **Switching:** Open (~{remaining}m remaining)
      switchingOpen: '',
      // EN: **Switching:** Limit enabled (not yet started)
      switchingLimitNotStarted: '',
      // EN: **Switching:** No time limit
      switchingNoTimeLimit: '',
      // EN: **Mode:** {mode}
      mode: '',
      // EN: **Scramble Lockdown:** {minutes} min per player
      scrambleLockdown: '',
      // EN: **Switch Tokens:** {max}
      switchTokens: '',
      // EN: {minutes} min
      cooldownMinutes: '',
      // EN: {hours}h
      cooldownHours: '',
      // EN: **Token Refill:** {label} per token
      tokenRefill: '',
      // EN: **AllowTeamChanges:** {state}
      allowTeamChanges: '',
      // EN: On
      on: '',
      // EN: Off
      off: '',
      // EN: **Queue Timeout:** {minutes}m
      queueTimeout: '',
      // EN: ⚫ Empty
      queueEmpty: '',
      // EN: ... and {count} more
      andMore: '',
      // EN: ⚫ Nobody is blocked from switching
      nobodyBlocked: '',
      // EN: Unavailable — database not ready
      unavailableDbNotReady: '',
      // EN: ⚫ Unavailable
      unavailable: '',
      // EN: Out of Tokens:         {count}
      outOfTokens: '',
      // EN: Scramble Locked:       {count}
      scrambleLocked: '',
      // EN: Holding <{max} tokens:    {count}
      holdingTokens: '',
      // EN: Seed Accruing (online): {count}{rosterNote}
      seedAccruing: '',
      // EN:  (roster unavailable)
      rosterUnavailable: '',
      // EN: Rows ({days}d retention):  {count}
      rowsRetention: '',
      // EN: 🎫 0/{max}, next <t:{nextAt}:R>
      tokenNext: '',
      // EN: Unknown
      healthUnknown: '',
      // EN: N/A
      healthNotApplicable: '',
      // EN: Not available
      healthNotAvailable: '',
      // EN: Connected
      healthConnected: '',
      // EN: S³ DB not available
      healthS3DbNotAvailable: '',
      // EN: Ready
      healthReady: '',
      // EN: Partial
      healthPartial: '',
      // EN: Error: {message}
      healthError: '',
      // EN: {ms}ms
      healthLatency: '',
      // EN: {emoji} Database        {label}
      healthDatabase: '',
      // EN: {emoji} RCON            {label}
      healthRcon: '',
      // EN: {emoji} S³ Integration   {label}
      healthS3Integration: '',
      // EN: 🔓 Currently Blocked
      currentlyBlockedNone: '',
    },
    roundSummary: {
      // EN: ⚠️ Notice
      notice: '',
      // EN: SquadJS was restarted during this round — switch data may be incomplete.
      restartedNotice: '',
      // EN: {count} other
      otherDenials: '',
      // EN: **Mode:** {mode}
      mode: '',
      // EN: **Requests:** {total} ({succeeded} succeeded, {denied} denied, {failed} failed)
      requests: '',
      // EN: **Success Rate:** {rate}%
      successRate: '',
      // EN: **Denied:** {count} player ({breakdown})
      deniedPlayers: '',
      // EN: **Denied:** {count} players ({breakdown})
      deniedPlayersPlural: '',
      // EN: **Denial Rate:** {rate}%
      denialRate: '',
      // EN: **Fail Rate:** {rate}% ({expired} expired)
      failRate: '',
      // EN: **Max Queue Size:** {size}
      maxQueueSize: '',
      // EN: **Queue Wait:** mean {mean}, median {median}
      queueWait: '',
      // EN: {mins}m {secs}s
      durationMinutesSeconds: '',
      // EN: {secs}s
      durationSeconds: '',
      // EN: **Direction:**
      direction: '',
      // EN: 📊 Stats
      statsField: '',
      // EN: 🔄 Switch Methods
      switchMethodsField: '',
      // EN: ℹ️ Queue Activity
      queueActivityField: '',
      // EN: No Activity
      noActivityField: '',
      // EN: No switch activity this round.
      noActivityValue: '',
      // EN: Switch Round Summary
      title: '',
      // EN: Switch v{version}
      footer: '',
      // EN: + {count} more...
      moreEllipsis: '',
      // EN: **Instant Switches ({count})**
      instantSwitchesHeading: '',
      // EN: **Queue Normal ({count})**
      queueNormalHeading: '',
      // EN: **Queue Team Trade ({count})**
      queueTeamTradeHeading: '',
      // EN: **Queue Join Swap ({count})**
      queueJoinSwapHeading: '',
      // EN: **Queue Timeout Switch ({count})**
      queueTimeoutSwitchHeading: '',
      // EN: **Expired ({count})**
      expiredHeading: '',
      // EN: **Denied ({count} unique players)**
      deniedHeading: '',
      // EN: **DC'd in Queue ({count})**
      dcdInQueueHeading: '',
      // EN: **Cancelled ({count})**
      cancelledHeading: '',
      // EN: **Removed ({count})**
      removedHeading: '',
      // EN: {name} {phase} (waited {duration})
      expiredEntry: '',
    },
  },
  teamBalancer: {
    discord: {
      commands: {
        // EN: 🔄 Running diagnostics... please wait.
        diagRunning: '',
        // EN: Invalid command. Use: `status`, `diag`, `on`, `off`, `export`, `clear`, `help` or `!scramble <now|dry|cancel>`.
        invalidCommand: '',
      },
      export: {
        // EN: 📄 Here is the TeamBalancer round reports export:
        successContent: '',
        // EN: ❌ The round reports log file does not exist yet or cannot be accessed.
        fileNotFound: '',
      },
      clear: {
        // EN: ✅ The round reports log file has been cleared.
        success: '',
        // EN: ❌ Failed to clear the round reports log file: {error}
        failed: '',
      },
      scramble: {
        // EN: ❌ Unknown argument "{badArg}". Usage: `!scramble [now|dry|matchend|cancel|confirm|elo]`
        unknownArg: '',
        // EN: ⚠️ No pending scramble confirmation found.
        noPendingConfirmation: '',
        // EN: ⚠️ Scramble confirmation expired.
        confirmationExpired: '',
        // EN: ❌ "!scramble matchend" cannot be combined with "now" or "dry".
        matchEndIncompatible: '',
        // EN: ⚠️ A match-end scramble is already scheduled. It will fire when this round ends. Use `!scramble cancel` to cancel it.
        matchEndAlreadyScheduled: '',
        // EN: ✅ Scramble scheduled for the end of this round. It will fire automatically when the round ends. Use `!scramble cancel` to cancel it.
        matchEndScheduled: '',
        // EN: ✅ Micro scramble scheduled for the end of this round. It will fire automatically when the round ends. Use `!scramble cancel` to cancel it.
        matchEndScheduledMicro: '',
        // EN: ✅ Pending scramble cancelled.
        cancelSuccess: '',
        // EN: ⚠️ Cannot cancel scramble - it is already executing.
        cannotCancelExecuting: '',
        // EN: ⚠️ No pending scramble to cancel.
        noPendingToCancel: '',
        // EN: ⚠️ Scramble already {status}. Use `!scramble cancel` to cancel.
        alreadyActive: '',
        // EN: immediately, with no countdown
        timingImmediate: '',
        // EN: in {delay}s, after a countdown broadcast
        timingCountdown: '',
        // EN: ⚠️ Confirming will execute a {scrambleKind} scramble {timing}. Type `!scramble confirm` within {timeoutSec}s to proceed.
        confirmPrompt: '',
        // EN: dry run {microLabel}scramble (immediate)
        actionDryRun: '',
        // EN: immediate {microLabel}scramble
        actionImmediate: '',
        // EN: {microLabel}scramble with countdown
        actionCountdown: '',
        // EN: 🔄 Initiating {actionDesc}...
        initiating: '',
        // EN: ⏳ Countdown: {delay}s\n📢 Broadcast sent to server.
        initiatingCountdownSuffix: '',
        // EN: ❌ Failed to initiate scramble.
        initiateFailed: '',
      },
      toggle: {
        // EN: ✅ Win streak tracking is already enabled.
        alreadyEnabled: '',
        // EN: ✅ Win streak tracking is already disabled.
        alreadyDisabled: '',
        // EN: ✅ Win streak tracking disabled.
        disabledSuccess: '',
      },
      help: {
        // EN: 📚 TeamBalancer Command Reference
        title: '',
        // EN: Available commands for Discord admins:
        description: '',
        fields: {
          pluginCommands: {
            // EN: Plugin Commands
            name: '',
            // EN: `!teambalancer status` - Show current state & win streak\n`!teambalancer diag` - Run diagnostics & dry run\n`!teambalancer on` - Enable win streak tracking\n`!teambalancer off` - Disable win streak tracking\n`!teambalancer export` - Export the round reports JSONL file\n`!teambalancer clear` - Clear the round reports log file
            value: '',
          },
          scrambleCommands: {
            // EN: Scramble Commands
            name: '',
            // EN: `!scramble` - Trigger scramble (with countdown)\n`!scramble now` - Trigger immediate scramble\n`!scramble dry` - Run simulation (dry run)\n`!scramble matchend` - Schedule scramble at end of round\n`!scramble cancel` - Cancel pending countdown
            value: '',
          },
        },
      },
      embeds: {
        // EN: Win streak threshold reached
        winStreakThresholdReached: '',
      },
    },
    errors: {
      // EN: ❌ You do not have permission to use this command.
      discordPermissionDenied: '',
      // EN: [TeamBalancer] Incompatible S³ version: got {actual}, need >={required}. Please update SlackersSquadServices.
      s3VersionIncompatible: '',
    },
    broadcasts: {
      // EN: ⚠️ Scheduled end-of-round scramble (armed by **{admin}**) was discarded — {reason}.
      discordMatchEndDiscarded: '',
    },
    labels: {
      // EN: admin {steamID}
      adminSteamID: '',
      // EN: system
      system: '',
      // EN: Scramble Execution
      scrambleExecution: '',
      // EN: automatically
      cancelReasonAutomatic: '',
      // EN: by admin {adminName}
      cancelReasonAdmin: '',
      // EN: Off
      off: '',
      // EN: Never
      never: '',
      // EN: None
      none: '',
      // EN: Yes
      yes: '',
      // EN: No
      no: '',
      // EN: standard
      standard: '',
      // EN: N/A
      notAvailable: '',
      // EN: Unknown
      unknown: '',
    },
    embeds: {
      // EN: No valid swap solution found.
      noValidSwapSolutionFound: '',
      // EN: 📢 **Server Broadcast**\n{message}
      discordServerBroadcastDescription: '',
      // EN: DISABLED (manual)
      disabledManual: '',
      // EN: DISABLED (config)
      disabledConfig: '',
      // EN: None (Threshold: {maxStreak} wins)
      noneThresholdWins: '',
      // EN: None (Threshold: {value})
      noneThreshold: '',
      // EN: 📊 TeamBalancer Status
      teambalancerStatus: '',
      // EN: Plugin Status
      pluginStatus: '',
      // EN: Elo Integration
      eloIntegration: '',
      // EN: Dominant Streak
      dominantStreak: '',
      // EN: Consecutive Streak
      consecutiveStreak: '',
      // EN: Seed Auto Scramble
      seedAutoScramble: '',
      // EN: Last Scramble
      lastScramble: '',
      // EN: Player Count
      playerCount: '',
      // EN: Total: {value} | T1: {t1Count} | T2: {t2Count}
      totalT1T2: '',
      // EN: {size} pending moves
      pendingMoves: '',
      // EN: 🩺 TeamBalancer Diagnostics
      teambalancerDiagnostics: '',
      // EN: **Plugin Status:** {dISABLED}
      pluginStatus2: '',
      // EN: Scramble Pending
      scramblePending: '',
      // EN: Scramble Active
      scrambleActive: '',
      // EN: Pending Moves
      pendingMoves2: '',
      // EN: Total Players
      totalPlayers: '',
      // EN: Team 1 | Team 2
      team1Team2: '',
      // EN: Total Squads
      totalSquads: '',
      // EN: Squad Split
      squadSplit: '',
      // EN: Max Win Threshold
      maxWinThreshold: '',
      // EN: Dominant Threshold
      dominantThreshold: '',
      // EN: Scramble Delay / Max
      scrambleDelayMax: '',
      // EN: {scrambleAnnouncementDelay}s (Seed: {seedScrambleAnnouncementDelay}s) / {maxScrambleCompletionTime}ms
      sSeedSMs: '',
      // EN: Single Round Scramble
      singleRoundScramble: '',
      // EN: ON (> {singleRoundScrambleThreshold} tix)
      tix: '',
      // EN: Invasion Thresholds
      invasionThresholds: '',
      // EN: Atk: {invasionAttackTeamThreshold} | Def: {invasionDefenceTeamThreshold}
      atkDef: '',
      // EN: TC Thresholds
      tcThresholds: '',
      // EN: Dom: {value} | Mercy: {value2}
      domMercy: '',
      // EN: Discord Options
      discordOptions: '',
      // EN: Mirror: {value} | Details: {value2}
      mirrorDetails: '',
      // EN: 🔍 Diagnostic Results (Part {pageNum})
      diagnosticResultsPart: '',
      // EN: 🔍 Diagnostic Results
      diagnosticResults: '',
      // EN: **Population:** Team 1 ({f1}): {currentT1} ➔ {projT1} | Team 2 ({f2}): {currentT2} ➔ {projT2}
      populationTeam1Team: '',
      // EN: \n**Global ELO Avg:** Team 1: {avgT1}μ ➔ {pAvgT1}μ | Team 2: {avgT2}μ ➔ {pAvgT2}μ
      globalEloAvgTeam: '',
      // EN: \n**Top 15 ELO Avg:** Team 1: {top15T1}μ ➔ {pTop15T1}μ | Team 2: {top15T2}μ ➔ {pTop15T2}μ
      top15EloAvg: '',
      // EN: \n**Regulars:** Team 1: {t1Regs} ➔ {projT1Regs} | Team 2: {t2Regs} ➔ {projT2Regs}
      regularsTeam1Team: '',
      // EN: 🧪 Dry Run Scramble Plan
      dryRunScramblePlan: '',
      // EN: 🔀 Scramble Execution Plan
      scrambleExecutionPlan: '',
      // EN: **Total players affected:** {value}\n**Calculation Time:** {value2}ms
      totalPlayersAffectedCalculation: '',
      // EN: Balance Projection
      balanceProjection: '',
      // EN: Virtual Squad: {tags} {value}p · Ø{avgMu}μ
      virtualSquadP: '',
      // EN: 🔗 Team {srcID} ({srcFaction}) ➔ Team {tgtID} ({tgtFaction}) Clan Grouping (Virtual Squads)
      teamTeamClanGrouping: '',
      // EN: Team {srcID} ({srcFaction}) ➔ Team {tgtID} ({tgtFaction})
      teamTeam: '',
      // EN: {skippedLines} further lines omitted to stay within Discord's embed size limit.
      furtherLinesOmittedStay: '',
      // EN: regular (10+ rounds)
      regular10Rounds: '',
      // EN: clan member (virtual squad)
      clanMemberVirtualSquad: '',
      // EN: pulled with squad
      pulledWithSquad: '',
      // EN: anchor squad
      anchorSquad: '',
      // EN: scramble calculation
      scrambleCalculation: '',
      // EN: The {action} resulted in no player moves. This is expected behavior on low-population servers.
      resultedNoPlayerMoves: '',
      // EN: 🔥 Dominant Win Streak
      dominantWinStreak: '',
      // EN: 📊 Win Recorded
      winRecorded: '',
      // EN: Winning Team
      winningTeam: '',
      // EN: Streak Progress
      streakProgress: '',
      // EN: Ticket Margin
      ticketMargin: '',
      // EN: 🚨 **Scramble Threshold Reached**\nTeams will be scrambled shortly to restore balance.
      scrambleThresholdReachedTeams: '',
      // EN: **Dominance Detected**\nIf this team wins dominantly **{remaining}** more time(s), a scramble will be triggered.
      dominanceDetectedIfTeam: '',
      // EN: 🚨 Scramble Triggered
      scrambleTriggered: '',
      // EN: Dominant Team
      dominantTeam: '',
      // EN: Win Streak
      winStreak: '',
      // EN: ✅ Scramble Completed
      scrambleCompleted: '',
      // EN: Total Moves
      totalMoves: '',
      // EN: Moved Successfully
      movedSuccessfully: '',
      // EN: Success Rate
      successRate: '',
      // EN: Failed Players ({value})
      failedPlayers: '',
      // EN: ⚠️ Some players could not be moved. Check logs for details.
      somePlayersCouldNot: '',
      // EN: ❌ Scramble Failed
      scrambleFailed: '',
      // EN: Calculation Time
      calculationTime: '',
      // EN: Server State
      serverState: '',
      // EN: **Total:** {value}\n**T1:** {t1Count} | **T2:** {t2Count}
      totalT1T22: '',
      // EN: ☠️ Fatal Plugin Error
      fatalPluginError: '',
      // EN: **Context:** {context}\n**Error:** {error}
      contextError: '',
      // EN: Stack Trace
      stackTrace: '',
      // EN: INITIALIZING
      initializing: '',
      // EN: ENABLED
      enabled: '',
      // EN: {team}: {count} / {maxStreak} wins
      streakOfWins: '',
      // EN: {team}: {count} / {max}
      consecutiveOf: '',
      // EN: ✅ Active
      eloActive: '',
      // EN: ❌ Unavailable
      eloUnavailable: '',
      // EN: ⏹️ Disabled
      eloDisabled: '',
      // EN: Version
      version: '',
      // EN: {value} wins
      winsUnit: '',
      // EN: {value} tickets
      ticketsUnit: '',
      // EN: Scramble %
      scramblePercent: '',
      // EN: OFF
      singleRoundOff: '',
      // EN: Squad {squadID}
      squadNumber: '',
      // EN:  (divided!)
      dividedSuffix: '',
      // EN: [{value} players]
      playersSuffix: '',
      // EN: UNASSIGNED
      unassignedSquad: '',
      // EN: [{squadName} - {squadAvgMu}μ | {squadRegs} Regs]
      squadHeaderElo: '',
      // EN: ⚠️ Truncated
      truncated: '',
      // EN: Unknown ({value}...)
      unknownPlayer: '',
      // EN: moved
      movedRow: '',
      // EN: stay
      stayRow: '',
      // EN: {baseName} (Cont.)
      fieldContinued: '',
      // EN: {teamName} (Team {teamID})
      winningTeamValue: '',
      // EN: **{streakCount}** / {maxStreak} wins
      streakProgressValue: '',
      // EN: **Reason:** {reason}
      reasonLine: '',
      // EN: Countdown
      countdown: '',
      // EN: {delay} seconds
      secondsUnit: '',
      // EN: Disconnected
      disconnected: '',
      // EN: Failed
      failed: '',
      // EN: Duration
      duration: '',
      // EN: \n+ {value} more...
      moreNamesOmitted: '',
      // EN: No budget-sized swap reached the parity target.
      noBudgetSizedSwap: '',
      // EN: simulation
      simulation: '',
    },
    warn: {
      // EN: Win streak tracking disabled.{seedScrambleOffNote}
      winStreakTrackingDisabled: '',
      // EN: Running diagnostics... please wait.
      runningDiagnosticsPleaseWait: '',
      // EN: Pending scramble cancelled.
      pendingScrambleCancelled: '',
    },
    status: {
      // EN: Manually disabled
      manuallyDisabled: '',
      // EN: Disabled in config
      disabledConfig: '',
      // EN: {teamName} has {winStreakCount} dominant win(s)
      hasDominantWinS: '',
      // EN: No current win streak
      noCurrentWinStreak: '',
      // EN: 🎮 In-Game Command: !teambalancer on
      gameCommandTeambalancer: '',
      // EN: Executed by **{adminName}**
      executedBy: '',
      // EN: 🎮 In-Game Command: !teambalancer off
      gameCommandTeambalancerOff: '',
      // EN: Win streak tracking disabled.{seedScrambleOffNote}
      winStreakTrackingDisabled: '',
      // EN: DISABLED (manual)
      disabledManual: '',
      // EN: DISABLED (config)
      disabledConfig2: '',
      // EN: None (Threshold: {maxStreak} wins)
      noneThresholdWins: '',
      // EN: None (Threshold: {maxConsec} wins)
      noneThresholdWins2: '',
      // EN: {hours}h {value}m ago
      hMAgo: '',
      // EN: {mins}m ago
      mAgo: '',
      // EN: --- TeamBalancer Status ---
      teambalancerStatus: '',
      // EN: Plugin Status: {effectiveStatus}
      pluginStatus: '',
      // EN: Win Streak: {winStreakText}
      winStreak: '',
      // EN: Consecutive Wins: {consecText}
      consecutiveWins: '',
      // EN: Seed Auto Scramble: {seedAutoScrambleStatus}
      seedAutoScramble: '',
      // EN: Players: {value} (T1: {t1Count} | T2: {t2Count})
      playersT1T2: '',
      // EN: S³ Integration
      sIntegration: '',
      // EN: Live Scramble Test
      liveScrambleTest: '',
      // EN: --- [TB Diag] ---
      tbDiag: '',
      // EN: Scramble Pending: {value}
      scramblePending: '',
      // EN: Scramble Active: {value}
      scrambleActive: '',
      // EN: Plyrs: {value} (T1: {value2} | T2: {value3})
      plyrsT1T2: '',
      // EN: Squads: {value} (T1: {value2} | T2: {value3})
      squadsT1T2: '',
      // EN: Thresholds: {maxWinStreak} wins / {value} tix
      thresholdsWinsTix: '',
      // EN: Scramble: {value}% | {scrambleAnnouncementDelay}s (Seed: {seedScrambleAnnouncementDelay}s) | {maxScrambleCompletionTime}ms
      scrambleSSeedS: '',
      // EN: Invasion: Atk {invasionAttackTeamThreshold} | Def {invasionDefenceTeamThreshold}
      invasionAtkDef: '',
      // EN: TC: Dom {value} | Mercy {value2}
      tcDomMercy: '',
      // EN: Executed by **{adminName}** (In-Game)\n{description}
      executedByGame: '',
      // EN: Micro scramble scheduled for the end of this round. It will fire automatically when the round ends. Use "!scramble cancel" to cancel it.
      microScrambleScheduledEnd: '',
      // EN: Scramble scheduled for the end of this round. It will fire automatically when the round ends. Use "!scramble cancel" to cancel it.
      scrambleScheduledEndRound: '',
      // EN: 🎮 In-Game Command: !scramble matchend{value}
      gameCommandScrambleMatchend: '',
      // EN: 🎮 In-Game Command: !scramble cancel
      gameCommandScrambleCancel: '',
      // EN: Pending scramble cancelled.
      pendingScrambleCancelled: '',
      // EN: immediately, with no countdown
      immediatelyWithNoCountdown: '',
      // EN: in {scrambleAnnouncementDelay}s, after a countdown broadcast
      sAfterCountdownBroadcast: '',
      // EN: Initiating dry run {value}scramble (immediate)...
      initiatingDryRunScramble: '',
      // EN: Initiating immediate {value}scramble...
      initiatingImmediateScramble: '',
      // EN: Initiating {value}scramble with countdown...
      initiatingScrambleWithCountdown: '',
      // EN: 🎮 In-Game Command: !scramble {value} {value2} {value3}
      gameCommandScramble: '',
      // EN: {hours} hour ago
      hourAgo: '',
      // EN: {hours} hours ago
      hoursAgo: '',
      // EN: {minutes} minute ago
      minuteAgo: '',
      // EN: {minutes} minutes ago
      minutesAgo: '',
      // EN: Response
      response: '',
      // EN: Scramble: {message}
      diagScramble: '',
      // EN: State: {value}
      diagState: '',
      // EN: Layer: {layerName} / {gameMode}
      diagLayer: '',
      // EN: Teams: {team1Name} | {team2Name}
      diagTeams: '',
      // EN: 1-Round: {value}
      diagSingleRound: '',
      // EN: INITIALIZING
      initializing: '',
      // EN: ENABLED
      enabled: '',
      // EN: DISABLED
      disabledUpper: '',
      // EN: Disabled
      disabled: '',
      // EN: {teamName}: {count} / {threshold} wins
      teamWinsOfThreshold: '',
      // EN: Unknown
      unknownLayer: '',
      // EN: N/A
      notApplicable: '',
      // EN: Active
      eloActive: '',
      // EN: Unavailable
      eloUnavailable: '',
      // EN: Layer: {layerName}
      statusLayer: '',
      // EN: S³: {value}
      diagS3: '',
      // EN: PASS
      resultPass: '',
      // EN: FAIL
      resultFail: '',
      // EN: Yes
      yes: '',
      // EN: No
      no: '',
      // EN: ON (> {value} tix)
      singleRoundOn: '',
      // EN: OFF
      singleRoundOff: '',
      // EN: Initializing...
      initializingEllipsis: '',
      // EN: std
      thresholdStandard: '',
    },
    onRoundEnded: {
      // EN: Round End Processing
      roundEndProcessing: '',
    },
  },
  eloTracker: {
    embeds: {
      // EN: 🔀 Post-Scramble Team Balance - {layerName}
      postScrambleTitle: '',
      // EN: Initial Calibration
      initialCalibration: '',
      // EN: **Provisional** — {roundsPlayed} rounds played. Rank visible after {minRounds} rounds. ({totalPlayersFmt} total tracked)
      provisionalRoundsPlayedRank: '',
      // EN: Rank **#{rank}** of **{totalRankedFmt}** ranked players ({totalPlayersFmt} total).\nTop {topPercent}% of all players
      rankRankedPlayersTotal: '',
      // EN: **{value} CSR** (Calibrating | μ - 3σ)
      csrCalibrating3: '',
      // EN: No members found.
      noMembersFound: '',
      // EN:  #  Name                 Rating\n
      nameRating: '',
      // EN:  #  Clan Tag   Rating    Size   WR\n
      clanTagRatingSize: '',
      // EN: No clans meet the requirements.
      noClansMeetRequirements: '',
      // EN: 📊 Live Round Info - {layerName}
      liveRoundInfo2: '',
      // EN: 🎬 Round Started - {layerName}
      roundStarted: '',
      // EN: ❌ You do not have permission to use this command.
      doNotHavePermission: '',
      // EN: 📊 EloTracker Status
      elotrackerStatus: '',
      // EN: Session Players
      sessionPlayers: '',
      // EN: ELO Cache Entries
      eloCacheEntries: '',
      // EN: Cache Sample (10)
      cacheSample10: '',
      // EN: Round Info
      roundInfo: '',
      // EN: ⚠️ This will wipe ALL ELO ratings and round history. Reply `!elo reset confirm` within 30 seconds to proceed.
      willWipeAllElo: '',
      // EN: ⚠️ No pending reset confirmation, or confirmation expired.
      noPendingResetConfirmation: '',
      // EN: 📦 Auto-Backup before reset — {value} players saved.
      autoBackupBeforeReset: '',
      // EN: Auto-Backup Failed
      autoBackupFailed: '',
      // EN: ⚠️ Reset aborted because the automatic pre-reset backup failed. Please fix the issue or run `!elo backup` manually.
      resetAbortedBecauseAutomatic: '',
      // EN: ELO Reset
      eloReset: '',
      // EN: All ratings and round history wiped.
      allRatingsRoundHistory: '',
      // EN: No player found: {identifier}
      noPlayerFound: '',
      // EN: Ambiguous: `{identifier}` is not an exact match — nothing was reset.
      ambiguousNotExactMatch: '',
      // EN: Re-run with the full name or a SteamID/EOS ID.
      reRunWithFull: '',
      // EN: Player Reset
      playerReset: '',
      // EN: Reset {name} to default rating.
      resetDefaultRating: '',
      // EN: 📦 ELO Backup — {value} players
      eloBackupPlayers: '',
      // EN: Backup
      backup: '',
      // EN: Please attach a backup JSON file with the !elo restore command.
      pleaseAttachBackupJson: '',
      // EN: Invalid backup format: missing players array.
      invalidBackupFormatMissing: '',
      // EN: Invalid backup format: one or more players have a malformed schema.
      invalidBackupFormatOne: '',
      // EN: ⏳ Restoring {value} players... This may take a moment.
      restoringPlayersMayTake: '',
      // EN: Restore Complete
      restoreComplete: '',
      // EN: Restored {value} players from backup.
      restoredPlayersFromBackup: '',
      // EN: Restore
      restore: '',
      // EN: 🛡️ Admin Commands (admin channel only)
      adminCommandsAdminChannel: '',
      // EN: `!elo status` — Plugin status and current round info
      eloStatusPluginStatus: '',
      // EN: `!elo roundinfo` — Live round snapshot: team balance, veterancy, and match health
      eloRoundinfoLiveRound: '',
      // EN: `!elo clans [n|all]` — Advanced clan leaderboard (n up to 50, "all" for all tags)
      eloClansNAll: '',
      // EN: `!elo reset` — Wipe ALL ratings and round history (requires confirm)
      eloResetWipeAll: '',
      // EN: `!elo reset confirm` — Confirm a pending full reset
      eloResetConfirmConfirm: '',
      // EN: `!elo reset <identifier>` — Reset a single player to default rating
      eloResetIdentifierReset: '',
      // EN: `!elo backup` — Export all player stats as a JSON file attachment
      eloBackupExportAll: '',
      // EN: `!elo restore` — Restore from a JSON backup (attach file with command)
      eloRestoreRestoreFrom: '',
      // EN: {hours}h
      durationHours: '',
      // EN: {minutes}m
      durationMinutes: '',
      // EN: {seconds}s
      durationSeconds: '',
      // EN: Team 1
      team1: '',
      // EN: Team 2
      team2: '',
      // EN: Draw
      draw: '',
      // EN: Tie
      tie: '',
      // EN: Team {team} advantage
      teamNumberAdvantage: '',
      // EN: (Uncertainty: **-{sigma}σ**)
      uncertainty: '',
      // EN: Version
      fieldVersion: '',
      // EN: Ready
      fieldReady: '',
      // EN: **{value} CSR** (μ - 3σ)
      csrValue: '',
      // EN: Unranked
      unranked: '',
      // EN: (Ranks {startRank}-{endRank})
      rankRange: '',
      // EN: (Empty)
      rankRangeEmpty: '',
      // EN: None
      statusNone: '',
      // EN: Empty
      cacheEmpty: '',
    },
    errors: {
      // EN: [EloTracker] Incompatible S³ version: got {actual}, need >={required}. Please update SlackersSquadServices.
      incompatibleS3Version: '',
    },
    onDiscordMessage: {
      // EN: Matched: {names}
      matchedNames: '',
    },
  },
};

// Key paths whose translation was machine-written and has NOT been reviewed by
// a fluent speaker. Add a key here in the same commit that adds an unreviewed
// string; delete it once someone who reads the language has checked it. An
// empty array means this catalogue is fully reviewed.
export const UNVERIFIED = [];
