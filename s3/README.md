# SlackersSquadServices (S³) Plugin v1.8.0

**Centralised service container for shared state across SquadJS plugins**

## Overview

SlackersSquadServices (S³) is a SquadJS plugin that owns the ground truth for server configuration, game-state lifecycle, player state, faction metadata, clan grouping, database access, logging/audit, and cross-plugin event routing. Instead of each consumer plugin managing its own player registry, game-state cache, or database connector, S³ provides **seven shared services** that consumer plugins discover at runtime.

Consumer plugins extend `S3PluginBase` (or `S3DiscordPluginBase` for plugins that also need a Discord channel) to inherit S³ service discovery, readiness gating, database boilerplate (model definition, migration registration/execution, transactional DB access), flat service accessors, and a standardised `_requestTeamChange()` retry/verify method. Services are accessed via flat getters — `this._s3?.gameState`, `this._s3?.players`, etc. — guarded by `isReady()` checks. S³ must be mounted before any consumer plugin that depends on it.

## Services

| Build Order | Service | File | Purpose |
|-------------:|---------|------|---------|
| 1 | `serverConfig` | `server-config-service.js` | Squad server config parsing and value caching |
| 2 | `db` | `db-service.js` | Centralised Sequelize operations with retry, jitter, **MigrationEngine** for version-ordered schema migrations, `getModelNames()`, export-tier accessors (`getModelTier()`, `getModelsByTier()`), drift detection (`verifyLiveSchema()`, `getLastDriftResult()`) |
| 3 | `gameState` | `game-state-service.js` | Round phase tracking, layer/gamemode resolution, crash recovery via `_transitionRecoveredStateToLive()`, layer name normalisation, `roundStartTime` backfill on recovered-state invalidation |
| 4 | `factions` | `factions-service.js` | Team/faction abbreviation discovery |
| 5 | `clans` | `clans-service.js` | Clan tag extraction, normalisation, caching, and team-assignment helpers |
| 6 | `players` | `players-service.js` | Player registry with move attribution, priority-based locking, **`registerPriority()`** for extensible third-party plugin priority, per-player lock via `lock(eosID, plugin, ttlMs)` / `unlock()` / `canAct()` |
| 7 | `logging` | `logging-service.js` | Audit-trail event logging, backup/export operation history |

## Mount Order

`serverConfig → db → gameState → factions → clans → players → logging`

Services are mounted in this order to satisfy each service's pre-mount dependencies (e.g., `gameState` needs `db` for persistence, `players` needs `gameState` for round-phase awareness). All consumer plugins discover S³ via:
```js
this._s3 = this.server.plugins.find(p => p.constructor.name === 'SlackersSquadServices');
```

## File Placement

In the monorepo (`install.cjs` flattens `plugins/` and `utils/` into the two
target directories — it never creates `s3/` on the server):

```
s3/
├── plugins/
│   ├── slackers-squad-services.js         ← S³ plugin entry point
│   ├── s3-plugin-base.js                  ← S3PluginBase
│   └── s3-discord-plugin-base.js          ← S3DiscordPluginBase
├── utils/
│   ├── server-config-service.js           ← ServerConfigService
│   ├── db-service.js                      ← DBService (Sequelize connector, tier + drift accessors)
│   ├── migration-engine.js                ← MigrationEngine
│   ├── game-state-service.js              ← GameStateService
│   ├── factions-service.js                ← FactionsService
│   ├── clans-service.js                   ← ClansService
│   ├── players-service.js                 ← PlayersService (lock/unlock/canAct/registerPriority)
│   ├── logging-service.js                 ← LoggingService
│   ├── s3-discord.js                      ← Discord infra (command dispatch → s3-commands.js)
│   ├── s3-commands.js                     ← Command handlers (players, clans, db, backup, migrate, switches, karma)
│   ├── s3-switch-reports.js               ← Team-switch/karma query & aggregation layer (no Discord awareness)
│   ├── s3-migration-discord.js            ← Migration prompts and embeds
│   ├── s3-backup.js                       ← Backup/restore orchestration (canBackup, listBackups)
│   ├── s3-export-import.js                ← JSON export/import (connector-agnostic)
│   └── s3-stderr.js                       ← Failure diagnostics on fd 2 (stderr)
├── tools/                                 ← schema-health.js, schema-version.mjs
└── testing/
    ├── run-all-tests.js                   ← Unified test runner (--category 1|2|3|4)
    └── test-*.js                          ← see S3_DEVELOPER_GUIDE.md §11.1 for the current catalog
```

## Consumer Plugins

S³ is a **supporting** plugin — it provides infrastructure to these consumer plugins:

| Plugin | Repository | Base Class | Key Integration |
|--------|-----------|-----------|----------------|
| **SmartAssign** | `squadjs-smart-assign` | `S3PluginBase` | Per-player lock via `players.lock()`, `_saProcessJoin()` pipeline, `_saLogAssignmentEvent()` using base class methods |
| **Switch** | `squadjs-switch-teambalancer-aware` | `S3DiscordPluginBase` | `_processQueue()`, `_requestTeamChange()`, `getSecondsFromJoin()`, `getSecondsFromMatchStart()` |
| **EloTracker** | `squadjs-elo-tracker` | `S3PluginBase` | `Elo_PlayerStats`, `Elo_RoundHistory`, `Elo_RoundPlayers` tables, `registerExpectedVersion()` / `runMigrations()` via MigrationEngine |
| **TeamBalancer** | `squadjs-team-balancer` | `S3PluginBase` | `TB_RoundReport`, `TeamBalancerState`, migrations via MigrationEngine |

All four consumer plugins use the **flat access pattern** (`this._s3?.gameState`, not `this._s3?.services?.`) and guard every service call with `isReady()`.

## Migration Engine

Schema changes are versioned and applied via `MigrationEngine`:

```js
// In consumer plugin mount():
dbService.migrationEngine.registerMigrations('MyPlugin', [
  { version: 1, migration: (sequelize) => sequelize.query('...') },
  { version: 2, migration: (sequelize) => sequelize.query('...') }
]);
await dbService.migrationEngine.runMigrations('MyPlugin', { autoMigrate: true });
```

The engine supports:
- **`registerMigrations(pluginName, migrations)`** — validates version sequence, stores in-memory
- **`runMigrations(pluginName, options)`** — applies pending migrations in ascending order, each in its own transaction
- **`rollbackMigrations(pluginName, targetVersion)`** — reverses to a target version
- **`pendingMigrations(pluginName)`** — what would run, without running it
- **`autoMigrate`** config option — skips the Discord confirmation prompt

JSON export/restore is **not** part of the engine — `exportToFile()` /
`restoreFromFile()` live in `s3-export-import.js`, and `canBackup()` /
`listBackups()` / `restoreBackup()` in `s3-backup.js`. Both are connector-agnostic
and work on SQLite, MySQL and Postgres alike.

> **Writing raw SQL in a migration?** Quote every camelCase identifier via
> `dbService.quoteIdentifier()`. Postgres folds unquoted identifiers to lower
> case while Sequelize creates camelCase columns quoted, so unquoted DDL creates
> a table your models cannot address — invisible on SQLite and MySQL, fatal on
> Postgres. `DBService` also exposes `incrementLiteral()`,
> `caseInsensitiveLikeOp()` and `caseInsensitiveLikeLiteral()` for the common
> cases. See `S3_DEVELOPER_GUIDE.md` §7.10, and
> `testing/test-dialect-portability.js` for real-engine regression cover.

### Failure Diagnostics on stderr

SquadJS's logger writes everything to stdout, so operators who split the streams get an error file containing only Node crashes — nothing any plugin logged. **Off by default**: set `stderrDiagnostics: 'mirror'` to have S³ copy its operational failures to **fd 2** as well, where `2>` redirection picks them up. Leave it alone and nothing about your logs changes.

```bash
node index.js > squadjs.log 2> squadjs.err
grep '\[S3\] \[ERROR\]' squadjs.err
```

```
[2026-08-19T01:57:49.856Z] [S3] [ERROR] [MigrationEngine] "switch" v4 -> v5 failed: qi.bulkUpdate is not a function
    TypeError: qi.bulkUpdate is not a function
    at Object.up (file:///.../switch/utils/switch-db.js:387:22)
```

Covered: migration failures, aborted pre-migration backups, `_withDb` failures, plugin command/event handler catch-alls, and Discord send failures (`ERROR`); schema drift with missing columns or rows (`WARN`). Stack traces are included, which Discord embeds do not carry — they show `err.message` only. Nothing is duplicated onto stdout, and a clean run writes nothing at all.

Repeats are deduplicated so a DB outage — which throws every tick — cannot fill the disk:

```
[...] [S3] [ERROR] [Switch:DB] Error in _withDb: SQLITE_ERROR: no such column: lastActiveTimestamp
[...] [S3] [ERROR] [Switch:DB] (suppressed 499 identical event(s) over 60s) Error in _withDb: SQLITE_ERROR: ...
```

| Option | Default | Effect |
|--------|---------|--------|
| `stderrDiagnostics` | `'off'` | `'off'` = stdout only (no change from before); `'mirror'` = also copy to stderr; `'auto'` = copy unless both streams lead to the same place |
| `stderrDedupeWindowSeconds` | `60` | Identical events inside the window are counted, not written |

**Turn it on with `'mirror'` if you redirect stderr somewhere separate** — `2> squadjs.err`, or pm2's separate error file. Don't turn it on under Docker's default log driver or systemd/journald: both streams end up in one sink there, so every error would appear twice in `docker logs` / `journalctl`. `'auto'` covers the in-between case of one config used both in a console and as a redirected service, though it cannot detect the Docker/journald merge either. The stdout log keeps every occurrence regardless of the setting. See `S3_DEVELOPER_GUIDE.md` §9.9.

## `!s3` Command System

The `!s3` admin command surface is organised across:

| Command | Handler | Description |
|---------|---------|-------------|
| `!s3 players` | `s3-commands.js` | Population overview + one embed per team, broken down by squad. Marks squad leaders (👑), locked squads, and per-player locks. "Unassigned" means not in a squad. |
| `!s3 clans` | `s3-commands.js` | Active clan groups, plus a second embed explaining why every other tag was excluded (below `minSize`, above `maxSize`, on `ignoreList`, unnormalizable) and every Damerau-Levenshtein merge and recruit-suffix strip |
| `!s3 switches [ident] [range]` | `s3-commands.js` | Team-switch leaderboard (no ident — Legacy pre-split Balancer moves fold into Full, since they're definitionally non-micro), or one player's breakdown grouped into Balancer/Scrambles vs. Manual/Switch |
| `!s3 switches export [range] [period] [--json]` | `s3-commands.js` | One row per `daily`/`weekly`/`monthly` period per active player — games played, total switches, and the full source breakdown — as a CSV (default) or JSON file attachment. Players silent all period get no row |
| `!s3 karma <ident> [range]` | `s3-commands.js` | Win-rate of a player's own switch decisions (self/untracked only — excludes balancer and SmartAssign moves) vs. the eventual round winner, with switch frequency context (N switches in G games — P% of rounds) and a directional verdict |
| `!s3 db status` | `s3-commands.js` | Connector, pending migrations, per-plugin schema versions |
| `!s3 db export` | `s3-export-import.js` | JSON export, streamed to `backups/` a row batch at a time and attached to the reply only if the gzipped file fits the Discord server's own upload limit (10 MB unboosted, 50 MB at boost tier 2, 100 MB at tier 3). Over that — or if the upload fails anyway — the file stays on disk and the summary embed names it. Models declare an `exportTier` — `historical` and `logging` are included by default, `ephemeral` is not |
| `!s3 db export --all` | `s3-export-import.js` | Also includes the `ephemeral` tier |
| `!s3 db export --to-file` | `s3-export-import.js` | Same export, no attachment attempt |
| `!s3 db import` | `s3-export-import.js` | Validates `.s3backup.json`, posts confirmation embed. **Writes nothing** |
| `!s3 db import --confirm` | `s3-export-import.js` | Executes upsert import, reports per-table counts |
| `!s3 db import --confirm --dry-run` | `s3-export-import.js` | Validate only, no writes |
| `!s3 backup list` | `s3-backup.js` | List existing backups |
| `!s3 backup create` | `s3-backup.js` | Take a backup now |
| `!s3 backup restore` | `s3-backup.js` | Auto-detects format (JSON or file-copy) |
| `!s3 migrate` | `s3-migration-discord.js` | `pending`, `status`, `preview`, `ddl [plugin]`, `force [--dry-run]`, `verify`, `purge-deprecated`, `adopt-state [--confirm]` |
| `!s3 confirm <token>` | `s3-commands.js` | Confirms a pending destructive operation |
| `!s3 servers` | `s3-commands.js` | The server registry: version, clock skew, community options. See [Several servers, one database](#several-servers-one-database) |
| `!s3 servers alias <server> <alias>` | `s3-commands.js` | Rename a registered server |
| `!s3 servers forget <server>` | `s3-commands.js` | Retire a stopped server from the registry |

Bare `!s3 db`, `!s3 backup` and `!s3 migrate` reply with a usage line rather than
doing anything. The full table, with every flag, is in `S3_DEVELOPER_GUIDE.md` §10.1.

## Several servers, one database

Two or more Squad servers can share one database and one Discord server. Every row that belongs to a particular server carries that server's id; rows that describe a *player* rather than a server stay shared, so a player's Elo and token balance follow them between your servers.

Running it is covered in [MULTI_SERVER.md](MULTI_SERVER.md) — upgrade order, rollback, clocks, aliases, confirmations, and what to hand a DBA who holds the `ALTER` grant you don't. What follows is what the options and commands are.

### Declaring which server this is

S³ takes its id from SquadJS's own `server.id`. Set `overrideServerID` where two installs both ship `"id": 1` and renumbering one would disturb rows other plugins have already written; it overrides the id for S³ alone. Every other plugin, including `db-log`, reads S³'s resolved id rather than declaring an option of its own.

**The id must stay constant for the life of that server.** The registry tracks a server by that declaration and by nothing else, so changing it does not rename a server, it retires one and introduces another. The old id keeps every row it ever wrote and the new one starts empty. Nothing renumbers implicitly, on boot order or row age or an empty registry, because the deciding fact is operator knowledge and it is in no table.

Two processes claiming one id is refused at mount rather than resolved, so the two installs cannot interleave their rows. `forceServerClaim` overrides that refusal for the one case where it is a false positive: a port change plus a restart inside the two-minute freshness window is indistinguishable from a genuine collision. Turn it back off once the server is up.

The one install shape that needs a migration here is a pre-existing single-server install whose `server.id` is **not** 1. `S3_GameState` and `TeamBalancerState` are per-server singletons whose primary key *is* the server id, so an install that has always run `server.id: 3` still holds its round state and win streak in a row numbered 1, written before any of this existed. `!s3 migrate adopt-state` moves those rows onto the declared id. It prints the row it would replace field by field and requires `--confirm` after you have read it. An install declaring id 1, which is every stock config, never needs it and the command says so rather than reporting a successful no-op.

### Commands

| Command | Description |
|---------|-------------|
| `!s3 servers` | Every server registered against this database, with suite version, clock skew, and the community options each one declares |
| `!s3 servers alias <server> <newAlias>` | Rename a registered server. Lowercased and stripped to letters, digits, `-` and `_`; must be at least two edits from every other alias, so `main` and `mains` cannot both exist |
| `!s3 servers forget <server>` | Remove a retired server from the registry. Refuses on a server that is still heartbeating, and on the one you are typing at |

A retired server's row keeps the community in multi-server mode until it is forgotten: selectors stay required and reads keep broadcasting for a server nobody is running.

### `--server` and command scope

Every command carries its own scope, and the scope decides whether a selector is needed. `--server <alias|id>` names the target; the suite never remembers one between commands, and there is no verb that targets all servers at once.

| Scope | Behaviour |
|-------|-----------|
| Reads one server's data | Every server answers, each about itself. Some ask for a selector instead, where one reply per server would flood the channel |
| Changes one server's live state | A selector is required. Exactly one process acts |
| Reads shared data | Exactly one process answers |
| Changes shared data | Exactly one process acts, and the confirmation says how many servers it affects |

**All of this is inert while one server is registered.** The routing gate returns unchanged below two servers, so a single-server install sees no selectors, no tokens and no behaviour change.

### Every process must run the same version

This is enforced. A process that finds a live sibling on a different suite version refuses to mount its server-scoped plugins and says so. A mixed pair writes against a schema one of them does not know about, and a community-wide command answered by the older process runs a superseded handler; neither failure announces itself, so mount time is the only moment either can be caught.

The refusal does not retry, and a stopped server's row stays fresh for up to two minutes. Upgrading therefore means stopping every process, waiting out that window, starting one and watching its migration finish, then starting the rest. [MULTI_SERVER.md](MULTI_SERVER.md) has the full order.

Configuration is not checked the same way, because several ordinary plugin options stop being local policy once a table is shared. `!s3 servers` reports which ones the community disagrees about. Some resolve to one value automatically, some make a write decline until they agree, and some are allowed to differ.

## Per-Player Locking

Consumer plugins coordinate via `PlayersService`:

```js
// Acquire per-player lock (prevents Switch from acting on same player during SA's ~3-6s move window)
if (this.players?.canAct(eosID, 'SmartAssign')) {
  this.players.lock(eosID, 'SmartAssign', 6000);
  // ... execute move ...
  this.players.unlock(eosID, 'SmartAssign');
}

// Lock check in another plugin's onChatMessage handler:
if (!this.players?.canAct(eosID, 'Switch')) {
  // Player is already being moved by another plugin — defer
  return;
}
```

Third-party plugins register custom priorities:
```js
this.players.registerPriority('MyPlugin', 4);  // Above TeamBalancer (default: 3)
```

## Testing

| Category | Scope | How to Run |
|----------|------|------------|
| 1 (Standalone) | Service, migration and dialect suites. No server, no game | `node testing/run-all-tests.js --category 1` |
| 2 (Mock-based) | Cross-plugin pipeline tests against mocks | `node testing/run-all-tests.js --category 2` |
| 3 (Human-led) | Live server validation | Listed, not executed — see `testing/test-plans/` |
| 4 (Permissions) | Multi-dialect grant tests | `node testing/run-all-tests.js --category 4` (needs Docker) |

Deliberately no test counts here — they go stale silently. Run the suite for the
current number.

> **A green run is not proof of database coverage.** The MySQL and Postgres cases
> skip themselves when the engine is unreachable, so a run with no container
> reports all-pass having exercised SQLite only. Check the output says
> `mysql reachable` and `0 skipped`. See `S3_DEVELOPER_GUIDE.md` §11.

## Installation

1. From the repo root, run `node install.cjs --plugin=s3` and copy the resulting
   `out/` into your SquadJS `squad-server/`. Doing it by hand instead: copy
   `s3/plugins/*.js` to `squad-server/plugins/` and `s3/utils/*.js` to
   `squad-server/utils/` — flat, with no `s3/` directory in between
2. (Optional) `--with-testing` / `--with-tools` to bring the suites and tools along
3. Add `SlackersSquadServices` to `config.json` as the **first** entry in the `plugins` array — before any consumer plugin that depends on S³
4. Configure the required connectors (`database`, `discordClient`) in the plugin options

## Configuration Options

| Option | Required | Type | Default | Description |
|--------|----------|------|---------|-------------|
| `language` | no | string | `"en"` | Language for all S³ messages. Available: `en`, `pt`. An unknown code falls back to `en` with a warning |
| `overrideServerID` | no | number | `null` | Declare this server's id for S³ instead of taking SquadJS's `server.id`. See [Several servers, one database](#several-servers-one-database) |
| `forceServerClaim` | no | boolean | `false` | Claim this server id even when another process appears live under it. The escape hatch for a false positive, not a setting to leave on |
| `database` | yes | sequelize | `"sqlite"` | Sequelize connector name |
| `discordClient` | yes | discord | `"discord"` | Discord connector name |
| `channelID` | yes | string | `""` | Discord channel ID for logs |
| `configPath` | no | string | `"./SquadGame/ServerConfig/"` | Path to Squad server config files |
| `ignoredGameModes` | no | array | `["Seed", "Jensen"]` | Game modes excluded from processing |
| `enableClanTagGrouping` | no | boolean | `true` | Enable clan-aware team grouping |
| `minClanGroupSize` | no | number | `2` | Minimum members to group as a clan |
| `maxClanGroupSize` | no | number | `18` | Maximum members to group as a clan |
| `clanTagMaxEditDistance` | no | number | `1` | Damerau-Levenshtein distance for tag merging (adjacent-character transpositions count as 1 edit) |
| `clanTagMinMergeLength` | no | number | `4` | Minimum tag length eligible for Damerau-Levenshtein merging; shorter tags need an exact match |
| `clanTagCaseSensitive` | no | boolean | `false` | Case-insensitive tag normalisation with lookalike mapping |
| `clanTagIgnoreList` | no | array | `[]` | Clan tags excluded from grouping |
| `clanRecruitSuffixes` | no | array | `["r", "-r"]` | Suffixes to strip from clan tags when the base tag (without suffix) exists on other players. Enabled by default for common recruit tags (case-insensitive, so "R" and "-R" are also matched). Set to `[]` to disable. Stripping only occurs when the base tag is present on at least one other player in the data set. |
| `clanGroupingPullEntireSquads` | no | boolean | `true` | Pull non-clan teammates with clan members |
| `enableDatabaseLogging` | no | boolean | `true` | Enable shared S³ logging tables (S3_PlayerEvents, S3_GameStateEvents, S3_PlayerSnapshots). When false, LoggingService runs in no-op mode. |
| `enableFileLogging` | no | boolean | `false` | Enable JSONL file mirror for S³ logging events. Each DB write is also appended as a self-contained JSONL line to the logPath file. |
| `logPath` | no | string | `"./s3-log.jsonl"` | Path to JSONL file for S³ event mirror. Only used when enableFileLogging is true. |
| `autoMigrate` | no | boolean | `false` | If `true`, skips Discord confirmation prompt for migrations |
| `stderrDiagnostics` | no | string | `"off"` | `"off"` leaves logging exactly as before; `"mirror"` also copies failures to stderr for `2>` redirection; `"auto"` copies only when stdout and stderr lead to different places |
| `stderrDedupeWindowSeconds` | no | number | `60` | Identical stderr events inside this window are counted rather than written |

## Author

**Slacker**

Discord: `real_slacker`
GitHub: https://github.com/mikebjoyce

---

*Built for SquadJS — current as of 2026-08-27*
