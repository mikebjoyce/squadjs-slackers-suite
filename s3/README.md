# SlackersSquadServices (S³) Plugin v1.0.0

**Centralised service container for shared state across SquadJS plugins**

## Overview

SlackersSquadServices (S³) is a SquadJS plugin that owns the ground truth for server configuration, game-state lifecycle, player state, faction metadata, clan grouping, database access, logging/audit, and cross-plugin event routing. Instead of each consumer plugin managing its own player registry, game-state cache, or database connector, S³ provides **seven shared services** that consumer plugins discover at runtime.

Consumer plugins extend `S3PluginBase` (or `S3DiscordPluginBase` for plugins that also need a Discord channel) to inherit S³ service discovery, readiness gating, database boilerplate (model definition, migration registration/execution, transactional DB access), flat service accessors, and a standardised `_requestTeamChange()` retry/verify method. Services are accessed via flat getters — `this._s3?.gameState`, `this._s3?.players`, etc. — guarded by `isReady()` checks. S³ must be mounted before any consumer plugin that depends on it.

## Services

| Build Order | Service | File | Purpose |
|-------------:|---------|------|---------|
| 1 | `serverConfig` | `server-config-service.js` | Squad server config parsing and value caching |
| 2 | `db` | `db-service.js` | Centralised Sequelize operations with retry, jitter, **MigrationEngine** for version-ordered schema migrations, `getModelNames()`, `canBackup()` |
| 3 | `gameState` | `game-state-service.js` | Round phase tracking, layer/gamemode resolution, crash recovery via `_transitionRecoveredStateToLive()`, layer name normalisation, `roundStartTime` backfill on recovered-state invalidation |
| 4 | `factions` | `factions-service.js` | Team/faction abbreviation discovery |
| 5 | `clans` | `clans-service.js` | Clan tag extraction, normalisation, caching, and team-assignment helpers |
| 6 | `players` | `players-service.js` | Player registry with move attribution, priority-based locking, **`registerPriority()`** for extensible third-party plugin priority, per-player lock via `lock(eosID, plugin, ttlMs)` / `unlock()` / `canAct()` |
| 7 | `logging` | `logging-service.js` | Audit-trail event logging, backup/export operation history |

## Mount Order

`serverConfig → db → gameState → factions → clans → players → logging`

Services are mounted in this order to satisfy each service's pre-mount dependencies (e.g., `gameState` needs `db` for persistence, `players` needs `gameState` for round-phase awareness). All consumer plugins discover S³ via:
```js
this._s3 = this.server.plugins.find(p => p.plugin.name === 'SlackersSquadServices');
```

## File Placement

```
SlackersSquadServices/
├── plugins/
│   └── slackers-squad-services.js          ← S³ plugin entry point
├── utils/
│   ├── game-state-service.js               ← GameStateService
│   ├── server-config-service.js            ← ServerConfigService
│   ├── db-service.js                       ← DBService (Sequelize connector + MigrationEngine)
│   ├── factions-service.js                 ← FactionsService
│   ├── clans-service.js                   ← ClansService
│   ├── players-service.js                 ← PlayersService (lock/unlock/canAct/registerPriority)
│   ├── logging-service.js                 ← LoggingService
│   ├── s3-discord.js                      ← Discord infra (command dispatch → s3-commands.js)
│   ├── s3-commands.js                     ← Command handlers (backup, export, import, db)
│   ├── s3-backup.js                       ← Backup/restore orchestration
│   └── s3-export-import.js               ← JSON export/import (connector-agnostic)
├── testing/
│   ├── test-server-config-service.js
│   ├── test-db-service.js
│   ├── test-game-state-service.js
│   ├── test-factions-service.js
│   ├── test-clans-service.js
│   └── test-players-service.js
│   └── run-all-tests.js                  ← Unified test runner (--category 1|2|3)
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
- **`exportToFile()` / `restoreFromFile()`** — connector-agnostic JSON file backup/restore (works on SQLite, Postgres, MySQL)
- **`autoMigrate`** config option — skips the Discord confirmation prompt

## `!s3` Command System

The `!s3` admin command surface is organised across:

| Command | Handler | Description |
|---------|---------|-------------|
| `!s3 db` | `s3-commands.js` | Database operations: `export`, `import`, `backup`, `restore` |
| `!s3 db export` | `s3-export-import.js` | JSON export (three-tier: essential, logging, all) |
| `!s3 db export --all` | `s3-export-import.js` | Includes ephemeral tables |
| `!s3 db import` | `s3-export-import.js` | Validates `.s3backup.json`, posts confirmation embed |
| `!s3 db import --confirm` | `s3-export-import.js` | Executes upsert import, reports per-table counts |
| `!s3 db import --confirm --dry-run` | `s3-export-import.js` | Validate only, no writes |
| `!s3 backup` | `s3-backup.js` | SQLite file-copy backup (legacy) |
| `!s3 backup restore` | `s3-backup.js` | Auto-detects format (JSON or file-copy) |

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
| 1 (Unit) | Individual service tests | `node testing/test-*.js` (9 scripts, 60 tests) |
| 2 (Integration) | Cross-plugin pipeline tests | `node testing/run-all-tests.js --category 2` (6 scripts, 52 tests) |
| 3 (Human-led) | Live server validation | Manual — run on a live server |

## Installation

1. Copy `SlackersSquadServices/plugins/*.js` to your SquadJS `squad-server/plugins/`
2. Copy `SlackersSquadServices/utils/*.js` to your SquadJS `squad-server/utils/`
3. (Optional) Copy `SlackersSquadServices/testing/` to your SquadJS `squad-server/testing/` to run the test suite
4. Add `SlackersSquadServices` to `config.json` as the **first** entry in the `plugins` array — before any consumer plugin that depends on S³
5. Configure the required connectors (`database`, `discordClient`) in the plugin options

## Configuration Options

| Option | Required | Type | Default | Description |
|--------|----------|------|---------|-------------|
| `database` | yes | sequelize | `"sqlite"` | Sequelize connector name |
| `discordClient` | yes | discord | `"discord"` | Discord connector name |
| `channelID` | yes | string | `""` | Discord channel ID for logs |
| `configPath` | no | string | `"./SquadGame/ServerConfig/"` | Path to Squad server config files |
| `ignoredGameModes` | no | array | `["Seed", "Jensen"]` | Game modes excluded from processing |
| `enableClanTagGrouping` | no | boolean | `false` | Enable clan-aware team grouping |
| `minClanGroupSize` | no | number | `2` | Minimum members to group as a clan |
| `maxClanGroupSize` | no | number | `18` | Maximum members to group as a clan |
| `clanTagMaxEditDistance` | no | number | `1` | Levenshtein distance for tag merging |
| `clanTagCaseSensitive` | no | boolean | `false` | Case-insensitive tag normalisation with lookalike mapping |
| `clanTagIgnoreList` | no | array | `[]` | Clan tags excluded from grouping |
| `clanGroupingPullEntireSquads` | no | boolean | `false` | Pull non-clan teammates with clan members |
| `autoMigrate` | no | boolean | `false` | If `true`, skips Discord confirmation prompt for migrations |

## Author

**Slacker**

Discord: `real_slacker`
GitHub: https://github.com/mikebjoyce

---

*Built for SquadJS — current as of 2026-06-29*