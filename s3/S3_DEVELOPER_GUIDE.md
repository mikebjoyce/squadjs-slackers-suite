# S³ Developer Guide

> **Canonical reference for building SquadJS plugins that consume S³ (Slacker's Squad Services).**
>
> **Last reviewed:** 2026-07-01, verified against source.

---

## Table of Contents

1. [Overview — What is S³?](#1-overview--what-is-s%C2%B3)
2. [Service Catalog](#2-service-catalog)
3. [Access Patterns & Discovery](#3-access-patterns--discovery)
4. [Subscription Callbacks](#4-subscription-callbacks)
5. [Event Model](#5-event-model)
6. [Integration Checklist](#6-integration-checklist)
7. [Anti-Patterns](#7-anti-patterns)
8. [S³ Plugin Base Class Guide](#8-s%C2%B3-plugin-base-class-guide)
9. [Migration Workflow Guide](#9-migration-workflow-guide)
10. [Discord Commands & Backup/Import](#10-discord-commands--backupimport)
11. [Testing Patterns](#11-testing-patterns)
12. [Deployment & Configuration](#12-deployment--configuration)

**Appendices:**
- [A — Service Readiness Summary](#a-service-readiness-summary)
- [B — Quick Reference — S³ Access Templates](#b-quick-reference--s%C2%B3-access-templates)
- [C — Reference Implementations](#c-reference-implementations)

---

## §1 — Overview — What is S³?

S³ (Slacker's Squad Services) is the centralised service container for shared state across SquadJS plugins. It owns the ground truth for:

- **Server configuration** — map configs, layer rotation, community settings
- **Database access** — SQLite (or Postgres/MySQL via Sequelize), schema versioning, migration pipeline
- **Game-state lifecycle** — round phase tracking (STAGING → LIVE → ENDGAME → RESOLVING), layer/gamemode inference, crash recovery
- **Player state** — team-change attribution, reconnect tracking, per-player and global locks
- **Faction metadata** — team/faction identification from player kit role strings (e.g., `US_Rifleman` → team abbreviation `US`)
- **Clan grouping** — tag-based clan detection and grouping utilities
- **Logging** — centralised player/state events to DB and/or JSONL files

### Architecture at a Glance

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│                        SquadJS Server                          │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                                                          │  │
│  │                S³ Plugin (SlackersSquadServices)         │  │
│  │                                                          │  │
│  │   ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │  │
│  │   │          │  │          │  │                       │  │  │
│  │   │ gameState│  │  clans   │  │ players               │  │  │
│  │   │          │  │          │  │                       │  │  │
│  │   │ .isReady │  │ .isReady │  │ .isReady              │  │  │
│  │   │          │  │          │  │                       │  │  │
│  │   └──────────┘  └──────────┘  └───────────────────────┘  │  │
│  │                                                          │  │
│  │   ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │  │
│  │   │          │  │          │  │                       │  │  │
│  │   │    db    │  │ factions │  │ serverConfig          │  │  │
│  │   │          │  │          │  │                       │  │  │
│  │   │ .isReady │  │ .isReady │  │ .isReady              │  │  │
│  │   │          │  │          │  │                       │  │  │
│  │   └──────────┘  └──────────┘  └───────────────────────┘  │  │
│  │                                                          │  │
│  │   ┌──────────────────────┐                               │  │
│  │   │                      │                               │  │
│  │   │      logging         │                               │  │
│  │   │                      │                               │  │
│  │   │ .isReady()           │                               │  │
│  │   │                      │                               │  │
│  │   └──────────────────────┘                               │  │
│  │                                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│    ┌─────────────────┐  ┌────────────┐  ┌────────────────┐     │
│    │                 │  │            │  │                │     │
│    │ Smart Assign    │  │   Switch   │  │  Team Balancer │     │
│    │                 │  │            │  │                │     │
│    └─────────────────┘  └────────────┘  └────────────────┘     │
│                                                                │
│    ┌─────────────────┐                                         │
│    │                 │                                         │
│    │ Elo Tracker     │   ...consumer plugins                   │
│    │                 │                                         │
│    └─────────────────┘                                         │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

Consumer plugins discover S³ at runtime and access services through **flat getters** guarded by `isReady()` checks. `S3PluginBase` and `S3DiscordPluginBase` are optional base classes that automate discovery, readiness gating, database boilerplate, and team-change RCON retry, eliminating ~50 lines of repetitive mount() logic per plugin. See [§8](#8-s%C2%B3-plugin-base-class-guide).

---

## §2 — Service Catalog

### 2.1 — DBService

**Source file:** `utils/db-service.js`

Centralises Sequelize connector management, schema version tracking, and migration execution. Provides both connector-agnostic and SQLite-specific features:

**Connector-agnostic (works on SQLite, Postgres, MySQL):**
- Retry loop with exponential backoff + random jitter for handling transient failures
- `withTransaction()` / `withTransactionWithRetry()` for safe transactional access
- Model definition via `defineModel()` — works on any Sequelize-supported dialect
- Multi-plugin schema version tracking via `S3_SchemaVersions` table
- Migration engine for version-ordered schema migrations

**SQLite-specific:**
- WAL (Write-Ahead Log) pragma enforcement at connection time
- Mutex serialisation via `withSqliteMutex()` to prevent concurrent write corruption
- `getDatabasePath()` — returns the SQLite file path for file-copy backups

**Public API:**

| Method | Signature | Returns | Notes |
|--------|-----------|---------|-------|
| `isReady()` | `() => boolean` | `boolean` | True after Sequelize connected + schema verified |
| `getConnector()` | `() => object` | Sequelize instance | The underlying Sequelize connector |
| `getConnectorName()` | `() => string` | Connector name | e.g. `'sqlite'`, `'postgres'`, `'mysql'` |
| `getDataTypes()` | `() => object` | Sequelize DataTypes | For model definitions |
| `getModel(name)` | `(string) => object\|null` | Sequelize model or null | Case-sensitive lookup |
| `getModelNames()` | `() => string[]` | All registered model names | e.g. `['Elo_PlayerStats', 'S3_SchemaVersions', ...]` |
| `defineModel(name, schema, opts)` | `(string, object, object?) => object\|null` | Sequelize model or null | Defines model on S³'s connector |
| `registerExpectedVersion(plugin, version)` | `(string, number) => void` | void | Declares expected schema version |
| `verifySchemaVersions()` | `() => Promise<{upToDate, pluginVersions}>` | Verification result | Compares expected vs actual |
| `getPendingMigrations()` | `() => Array<{pluginName, currentVersion, expectedVersion}>` | Pending list | Used by startup prompt |
| `waitForMigrations()` | `() => Promise<void>` | void | Resolves after migrations complete or skipped |
| `migrationEngine` | getter | `MigrationEngine` instance | Direct access to the engine |
| `executeWithRetry(fn)` | `(Function) => Promise<*>` | Function result | With retry + jitter (all connectors) |
| `withTransaction(fn)` | `(Function) => Promise<*>` | Function result | Within a Sequelize transaction |
| `withTransactionWithRetry(fn)` | `(Function) => Promise<*>` | Function result | Transaction + retry combined |
| `getDatabasePath()` | `() => string\|null` | File path or null | SQLite only |
| `models` | property | `object` | All defined models, keyed by name. Direct property, not a getter method. |

> **Note:** `canBackup(connector)` is **not** a `DBService` method — it's a standalone export from `s3-backup.js` that always returns `true` (all Sequelize dialects get JSON-export fallback; the SQLite-only gate was removed). If you need this on a `DBService` instance, import it separately: `import { canBackup } from './s3-backup.js'`.

**Static methods (for advanced use):**
- `DBService.isSqlite(connector)` — detect dialect
- `DBService.resolveConnector(options)` — resolve Sequelize from SquadJS connectors
- `DBService.executeWithRetry(connector, fn)` — bare connector, no instance
- `DBService.withTransaction(connector, fn)` — bare connector, no instance
- `DBService.withSqliteMutex(connector, fn)` — SQLite-specific mutex lock
- `DBService.isLockError(err)` — detect SQLITE_BUSY / locking errors

---

### 2.2 — GameStateService

**Source file:** `utils/game-state-service.js`

Tracks round phases (STAGING → LIVE → ENDGAME → RESOLVING), infers gamemode/layer from server state, provides round timing and match IDs, and handles crash recovery via persisted state.

**SquadJS events it subscribes to:** `NEW_GAME`, `ROUND_ENDED`, `UPDATED_LAYER_INFORMATION`, `UPDATED_SERVER_INFORMATION`, `UPDATED_PLAYER_INFORMATION`

**Public API:**

| Method | Returns | Notes |
|--------|---------|-------|
| `isReady()` | `boolean` | Mounted, timers initialised, layer resolved |
| `getPhase()` | `string` | `'STAGING'` / `'LIVE'` / `'ENDGAME'` / `'RESOLVING'` |
| `isStaging()` | `boolean` | Phase === `'STAGING'` |
| `isLive()` | `boolean` | Phase === `'LIVE'` |
| `isEnding()` | `boolean` | Phase === `'ENDGAME'` |
| `isResolving()` | `boolean` | Phase === `'RESOLVING'` |
| `getGamemode()` | `string\|null` | Inferred game mode (e.g. `'AAS'`, `'RAAS'`, `'Seed'`) |
| `getLayerName()` | `string\|null` | Raw layer name (e.g. `'Sumari AAS v1'`) |
| `getRoundStartTime()` | `number\|null` | Epoch MS of round START or LIVE transition |
| `getMatchId()` | `string\|null` | Layer hash + match counter |
| `isIgnoredMode()` | `boolean` | Gamemode in ignored list (seed/training/event) |
| `isSeedMode()` | `boolean` | Game mode contains `'Seed'` |
| `isTrainingMode()` | `boolean` | Layer or game mode name contains `'Jensen'` |
| `getEndgameSubState()` | `string\|null` | `'SCOREBOARD'` / `'LAYER_VOTE'` / `'FACTION_VOTE_T1'` / `'FACTION_VOTE_T2'` / `'POST_VOTING'` |
| `isEndgameScoreboard()` | `boolean` | In scoreboard phase |
| `isEndgameLayerVote()` | `boolean` | In layer vote phase |
| `isEndgameFactionVote()` | `boolean` | Either team's faction vote |
| `isEndgameFactionVoteTeam1()` | `boolean` | Specific team faction vote |
| `isEndgameFactionVoteTeam2()` | `boolean` | Specific team faction vote |
| `isEndgamePostVoting()` | `boolean` | Votes concluded, next game loading |
| `isEndgameVotingComplete()` | `boolean` | All voting finished |
| `setIgnoredGameModes(modes)` | `void` | Configures which modes to skip |
| `onGamePhaseChange(callback)` | `Function` (unsubscribe) | Callback: `(newPhase, prevPhase) => {}` |
| `onLayerGameModeChange(callback)` | `Function` (unsubscribe) | Callback: `(layer, gamemode, prevLayer, prevGamemode) => {}` |

---

### 2.3 — PlayersService

**Source file:** `utils/players-service.js`

Tracks player state (name, team, squad, join time), manages per-player and global locks for coordination between plugins, supports reconnect detection, and provides refresh control for the player list projection.

**Public API:**

| Method | Returns | Notes |
|--------|---------|-------|
| `isReady()` | `boolean` | Mounted, player list projection active |
| `getPlayer(eosID\|steamID)` | `object\|null` | Player state including name, teamID, squad, joinTime |
| `hasPlayer(eosID\|steamID)` | `boolean` | Existence check |
| `getAllPlayers()` | `object[]` | All tracked player states |
| `getJoinTime(eosID\|steamID)` | `number\|null` | Epoch MS player joined |
| `getSquads()` | `object[]` | Squad list from registry |
| `areTeamsResolved()` | `boolean` | All players on valid teams (1 or 2) |
| `recordMove(eosID, teamID, source, options?)` | `void` | Record attribution for team change |
| `canAct(eosID, source)` | `boolean` | Check if player can be acted upon (not locked by another plugin) |
| `lock(eosID, source, ttlMs?)` | `Promise<boolean>` | Acquire per-player lock |
| `unlock(eosID, source)` | `void` | Release per-player lock |
| `lockGlobal(source, ttlMs?)` | `Promise<boolean>` | Acquire global lock |
| `unlockGlobal(source)` | `void` | Release global lock |
| `isLockedBy(eosID)` | `string\|null` | Who holds the lock |
| `isGloballyLockedBy()` | `string\|null` | Who holds the global lock |
| `registerRefreshInterest(source, opts?)` | `void` | Register for periodic player list refresh |
| `unregisterRefreshInterest(source)` | `void` | Remove refresh interest |
| `requestRefresh(source, opts?)` | `void` | Request an async refresh |
| `refreshNow(source)` | `Promise<void>` | Immediate refresh (debounced) |
| `registerPriority(source, priority)` | `void` | Register a custom priority level for lock preemption (see §5.4) |
| `rememberReconnect(eosID, payload?)` | `Promise<void>` | Record reconnect expectation |
| `getReconnect(eosID)` | `Promise<object\|null>` | Check pending reconnect |
| `clearReconnects()` | `Promise<void>` | Clear all reconnect records |
| `peekReconnect(eosID)` | `Promise<object\|null>` | Non-destructive reconnect check |
| `onPlayerDataChanged(callback)` | `Function` (unsubscribe) | Fires when any player property changes |
| `onPlayerConnected(callback)` | `Function` (unsubscribe) | Fires when a player connects |

**Key player state shape:**
```js
{
  eosID, steamID, name, teamID, squadID, squadName,
  isLeader, role, joinTime, isAlive,
  isInWaitingForRespawn, wasKilled, deathTime,
  isDisconnected, disconnectTime
}
```

---

### 2.4 — ClansService

**Source file:** `utils/clans-service.js`

Detects clan tags from player names, normalises them for comparison, and groups players by clan for downstream consumer logic.

This service provides **building blocks** for clan-aware plugin behaviour (team balancing, stacking detection, squad assignment). The actual stacking-prevention decisions are made by consumer plugins using the outputs of `getClanTeamForPlayer()` and `extractClanGroups()`.

**No combined extract+normalise call exists.** Get a usable tag with two calls: `service.normalizeTag(service.extractRawPrefix(name))`.

**Public API:**

| Method | Returns | Notes |
|--------|---------|-------|
| `isReady()` | `boolean` | |
| `isEnabled()` | `boolean` | Clan grouping enabled in config |
| `extractRawPrefix(name)` | `string\|null` | Extract clan tag from player name |
| `normalizeTag(raw)` | `string` | Normalise for comparison (case, special chars) |
| `levenshteinDistance(a, b)` | `number` | Edit distance for fuzzy matching |
| `extractClanGroups(players, opts?)` | `object[]` | Grouped clans with members |
| `buildPlayerTagCache(players, opts?)` | `Map<eosID, tag>` | Pre-computed tag map |
| `getClanTeamForPlayer(player, tagCache, serverPlayers, opts?)` | `number\|null` | Target team for clan stacking prevention |
| `getPlayerTag(eosID)` | `string\|null` | Cached tag for player |
| `addPlayerToCache(eosID, name)` | `void` | |
| `removePlayerFromCache(eosID)` | `void` | |
| `clearPlayerTagCache()` | `void` | |
| `getPlayerTagCache()` | `Map` | |
| `rebuildFromAllPlayers(players)` | `void` | Full cache rebuild |

---

### 2.5 — FactionsService

**Source file:** `utils/factions-service.js`

Identifies which team factions are in play by extracting abbreviation prefixes from player kit role strings.

**Data source:** The service applies the regex `/^([A-Z]{2,6})_/` to each player's role string (from `player.roles[0]`) to extract a 2–6 character uppercase faction abbreviation. Examples:

| Role String | Extracted Abbreviation | Faction |
|-------------|----------------------|---------|
| `US_Rifleman` | `US` | United States |
| `RUS_SL_02` | `RUS` | Russia |
| `GB_Crewman` | `GB` | Great Britain |
| `CAF_Medic` | `CAF` | Canadian Armed Forces |
| `MEA_Sniper` | `MEA` | Middle Eastern Alliance |

When both teams have been identified, the cache looks like:
```js
{ 1: 'US', 2: 'RUS' }
```

**Lifecycle:** Polling is gated on `gameState.resolving`, **not** round phase. On `NEW_GAME`, `resolving` goes true and polling stops — player roles may still carry stale data from the previous round. Once all players have valid team IDs, `resolving` clears and polling starts, running in **either** STAGING or LIVE. This is why seed-mode rounds (which never reach LIVE) still resolve faction abbreviations. Once both teams are identified, polling stops until the next `NEW_GAME`.

**Public API:**

| Method | Returns | Notes |
|--------|---------|-------|
| `isReady()` | `boolean` | |
| `isEnabled()` | `boolean` | |
| `getTeamName(teamID, opts?)` | `string\|null` | Resolve team 1/2 abbreviation (e.g. `'US'`, `'RUS'`) |
| `getCachedAbbreviations()` | `object` | Current team abbreviation cache: `{ 1: 'US', 2: 'RUS' }` |
| `onFactionsResolved(callback)` | `Function` (unsubscribe) | Called when both teams identified |
| `pollTeamAbbreviations()` | `void` | Begin polling for team names |
| `stopPollingTeamAbbreviations()` | `void` | Stop polling |

---

### 2.6 — ServerConfigService

**Source file:** `utils/server-config-service.js`

Reads and parses the Squad server's `ServerConfig/` directory, provides typed accessors for commonly-used config values.

**Public API:**

| Method | Returns | Notes |
|--------|---------|-------|
| `isReady()` | `boolean` | |
| `isLoadedSuccessfully()` | `boolean` | Config parsed without errors |
| `getConfigPath()` | `string` | Path to ServerConfig directory |
| `getConfig()` | `object\|null` | Raw config key/value pairs |
| `getAllowTeamChanges()` | `boolean` | |
| `getMaxPlayers()` | `number` | |
| `getNumReservedSlots()` | `number` | |
| `getTimeBetweenMatches()` | `number` | MS |
| `getTimeBeforeVote()` | `number` | MS |
| `getTeamVoteDuration()` | `number` | MS |
| `getLayerVoteDuration()` | `number` | MS |

---

### 2.7 — LoggingService

**Source file:** `utils/logging-service.js`

Records player events, game-state transitions, and periodic snapshots to the database and/or JSONL log files.

**Public API:**

| Method | Returns | Notes |
|--------|---------|-------|
| `isReady()` | `boolean` | |
| `logPlayerEvent(eventType, player, metadata?)` | `Promise<void>` | Record player event to DB + JSONL |
| `logGameStateEvent(eventType, oldPhase?, newPhase?, metadata?)` | `Promise<void>` | Record state transition |
| `snapshot(matchId, trigger, players?)` | `Promise<void>` | Momentary player state snapshot |

---

## §3 — Access Patterns & Discovery

Consumer plugins access S³ services through a **flat access pattern** with **per-service `isReady()` guards**.

### 3.1 — Discovery

**Without base class:** Find S³ at mount time (constructor is too early — S³ may not be constructed yet):

```js
mount() {
  const s3 = this.server.plugins.find(
    (p) => p.constructor.name === 'SlackersSquadServices'
  );
  if (!s3) {
    throw new Error('[S3] SlackersSquadServices is required but was not found.');
  }
  this._s3 = s3;
  // ... rest of mount logic
}
```

Store the reference as `this._s3` (convention used by all consumer plugins).

**With base class:** If using `S3PluginBase`, discovery is handled automatically by `_resolveS3()` in `prepareToMount()`. See [§8](#8-s%C2%B3-plugin-base-class-guide).

### 3.2 — Flat Access (Not Nested)

Services are accessed via flat getters on the S³ plugin instance. **Never** use `this._s3?.services?.gameState` — the nested path is an internal implementation detail.

```js
// ✅ CORRECT — flat access via S³ getters
const gs = this._s3?.gameState;
const clans = this._s3?.clans;
const players = this._s3?.players;
const db = this._s3?.db;
const factions = this._s3?.factions;
const serverConfig = this._s3?.serverConfig;

// ❌ WRONG — do not access services via nested path
// const gs = this._s3?.services?.gameState;
```

### 3.3 — Always Guard with `isReady()`

Every service exposes an `isReady()` method that returns `true` once the service is fully mounted and operational. Guard every service access:

```js
// ✅ CORRECT — guard with isReady() before accessing service data
const gs = this._s3?.gameState;
if (!gs?.isReady()) return;

const roundStartTime = gs.getRoundStartTime();
const matchId = gs.getMatchId();
```

The `?` (optional chaining) handles the case where `this._s3` itself is `null` (before discovery or during teardown).

### 3.4 — Service Mount Order

Services mount in this order, which affects when each is available to consumers:

```
serverConfig  →  db  →  gameState  →  factions  →  clans  →  players  →  logging
```

Unmount order is the reverse (logging first, serverConfig last) so logging can capture final teardown activity.

### 3.5 — Base Class Accessor Pattern

If using `S3PluginBase`, the base class provides direct service accessors that wrap `this._s3`:

| Getter | Returns | Available After |
|--------|---------|----------------|
| `this.s3` | S³ plugin reference | `prepareToMount()` |
| `this.s3db` | S³ DBService (cached) | `_onS3Ready()` |
| `this.gameState` | GameStateService | `_onS3Ready()` |
| `this.players` | PlayersService | `_onS3Ready()` |
| `this.clans` | ClansService | `_onS3Ready()` |
| `this.factions` | FactionsService | `_onS3Ready()` |
| `this.serverConfig` | ServerConfigService | `_onS3Ready()` |

Usage in `_onS3Ready()` or later:

```js
// ✅ CORRECT — base class accessors
const gs = this.gameState;
if (!gs?.isReady()) return;
const phase = gs.getPhase();
```

---

## §4 — Subscription Callbacks

S³ services expose opt‑in callback registration methods that fire **after** the service has committed its internal state changes. This guarantees consumers receive fresh data without needing to know *when* to poll, and eliminates the staleness window that can occur when consumers read S³ state on a separate event-handler schedule.

This is **not** a global event bus. Each service owns its notification points.

### 4.1 — Registration & Unsubscribe

Every callback registration returns an **unsubscribe function**. Plugins MUST call this during unmount to prevent memory leaks.

```js
// Subscribe — fires after state is committed
const unsubscribe = this.gameState.onGamePhaseChange((data) => {
  this.verbose(2, `Phase changed to ${data.phase}`);
});

// Unsubscribe — required during plugin unmount
unsubscribe();
```

### 4.2 — Service Callback Reference

#### GameStateService

| Method | Fires When | Payload |
|--------|-----------|---------|
| `onGamePhaseChange(cb)` | End of `handleNewGame()`, `handleRoundEnded()`, staging→live transition timer, each ENDGAME sub-state advance | `{ phase, prevPhase, subPhase, roundStartTime, matchId, layer }` |
| `onLayerGameModeChange(cb)` | End of `resolveLayerInfo()` when layer/game mode changed | `{ layerName, gameMode, prevLayer, prevGameMode }` |

**Notes:**
- `onGamePhaseChange` fires on every phase transition including ENDGAME sub-state changes (scoreboard → layerVote → factionVoteTeam1 → factionVoteTeam2 → postVoting).
- **`prevPhase` in the payload is not reliable.** Every call site sets `this.phase` to the new value *before* calling `_notifyGamePhaseChange(newPhaseString)` — the argument passed is the new phase, not the actual prior one, so `payload.prevPhase` always equals `payload.phase`. This looks like a source bug (parameter name implies a real "previous phase" that never materializes), not intended behavior. Don't rely on `prevPhase` to detect what phase you're transitioning *from* — track it yourself across calls if you need that.
- `onLayerGameModeChange` captures previous values before resolving and includes them in the payload correctly (this one is not affected by the bug above).

#### PlayersService

| Method | Fires When | Payload |
|--------|-----------|---------|
| `onPlayerDataChanged(cb)` | End of tick processing after all projections and squad cache committed | `{ joinCount, leaveCount, teamChangeCount, playerCount, projectionActive, phase }` |
| `onPlayerConnected(cb)` | End of `handlePlayerConnected()` after reconnect check | `{ player, isNew, previousTeamID }` |

**Notes:**
- **`onPlayerDataChanged` fires on every tick, including the initial-sync tick** — there is no gate on `isInitialSync` at the call site. During initial sync, `joinCount`/`leaveCount`/`teamChangeCount` will read `0` (the underlying `S3_PLAYER_JOINED`/`LEFT`/`TEAM_CHANGED` events are suppressed then), but the callback still fires. Don't assume the first invocation reflects a real tick's worth of activity.
- `onPlayerConnected` fires even for returning players (`isNew=false`).

#### FactionsService

| Method | Fires When | Payload |
|--------|-----------|---------|
| `onFactionsResolved(cb)` | When both team abbreviations are first discovered | `{ abbreviations: { 1: 'US', 2: 'RUS' } }` |

**Notes:**
- Fires once per round, when `_hasBothTeams()` transitions from false → true.
- Does NOT fire if both teams were already resolved when polling started.

#### DBService & ServerConfigService

No callbacks provided. DBService is a passive SQLite wrapper (no state changes at runtime). ServerConfigService data changes rarely and consumers can query it on‑demand.

### 4.3 — Error Isolation

Each callback invocation is wrapped in `try/catch`. If one callback throws, other callbacks still fire, and the service's internal processing is unaffected.

### 4.4 — When NOT to Use Callbacks

Callbacks are designed for **timer-based or tick-rate polling patterns**. If your consumer plugin only reads S³ state inside its own SquadJS event handlers (e.g., inside `onChatMessage`, `onPlayerConnected`), the flat property access pattern remains the correct approach:
- S³'s state is already committed in the same event loop tick when the consumer's handler runs.
- There is no staleness window to close for one-shot queries on SquadJS events.

---

## §5 — Event Model

### 5.1 — SquadJS Events Owned by S³

S³ subscribes to these SquadJS events and delegates them to the appropriate services:

| Event | Delegated To | When Fires |
|-------|-------------|------------|
| `NEW_GAME` | gameState, factions | Server starts a new game |
| `ROUND_ENDED` | gameState, factions | Round finishes |
| `UPDATED_LAYER_INFORMATION` | gameState | Layer info received from server |
| `UPDATED_SERVER_INFORMATION` | gameState | Server info (name, map, etc.) updated |
| `UPDATED_PLAYER_INFORMATION` | gameState, factions, players | Player list refresh tick |
| `PLAYER_CONNECTED` | players | Player connects to server |

### 5.2 — S³-Emitted Events

S³ emits application-level events that consumer plugins can listen on via `this.server.on()`:

| Event | Emitted By | Payload | When |
|-------|-----------|---------|------|
| `S3_ROUND_LIVE` | gameState | `{ roundStartTime, matchId, layerName, gamemode }` | STAGING → LIVE phase transition, when the staging timer elapses |
| `S3_PLAYER_JOINED` | players | `{ player, previousTeamID, source }` | New player registered on a tick (suppressed during initial sync) |
| `S3_PLAYER_LEFT` | players | `{ player, source }` | Player dropped from registry (present in previous tick, absent in current) |
| `S3_PLAYER_TEAM_CHANGED` | players | `{ player, previousTeamID, teamID, source }` | Team change detected via tick diff (suppressed during initial sync) |
| `S3_PLAYER_RECONNECTED` | players | `{ player, previousTeamID, disconnectedAt, reconnectedAt }` | Returning player matched against reconnect memory |
| `S3_PLAYERS_UPDATED` | players | `{ joinCount, leaveCount, teamChangeCount, playerCount, isInitialSync, projectionActive, source }` | End of **every** `UPDATED_PLAYER_INFORMATION` tick, including the initial-sync tick |
| `S3_PLAYER_LOCK_CHANGED` | players | `{ key, source, locked, expiresAt }` | Per-player lock acquired or expired |
| `S3_GLOBAL_LOCK_CHANGED` | players | `{ source, locked, expiresAt }` | Global lock (Team Balancer) acquired or cleared |

> **⚠️ Not emitted on mid-round mount.** `S3_ROUND_LIVE` has a single emit site in `game-state-service.js`, inside the STAGING timer callback. If S³ mounts mid-round (the `roundStartTime` backfill path in `mount()`), no `S3_ROUND_LIVE` event fires for that round — a plugin restarted mid-round and relying on this event for its initial snapshot will miss it until the *next* round. Confirm this is intended before depending on it for anything that must run once per round.

Listen in `_onS3Ready()` or `mount()`:

```js
this.server.on('S3_ROUND_LIVE', (data) => {
  this.verbose(2, `Round live: ${data.layerName} (${data.gamemode})`);
});
```

### 5.3 — Player Lifecycle Events

PlayersService fires events via `onPlayerDataChanged()` and `onPlayerConnected()` callbacks (see §4). Subscribe in `_onS3Ready()` and store the unsubscribe function for cleanup in `_onUnmount()`.

### 5.4 — Cross-Plugin Coordination

Smart Assign, Switch, and Team Balancer coordinate through S³'s PlayersService lock system rather than direct inter-plugin messaging. All three use the shared `_requestTeamChange()` base-class method, which records move attribution via `players.recordMove()` before issuing RCON commands.

#### Priority System

PlayersService ships with a default priority hierarchy (`PlayersService.PRIORITY`):

```
TeamBalancer(3)  >  SmartAssign(2)  >  Switch(1)
```

A higher-priority actor can always preempt a lower-priority one. Equal-priority actors from the same source are allowed; equal-priority actors from different sources are blocked. Any source not in the default map resolves to priority `0`.

**Third-party plugins register their own priority level** via `players.registerPriority(source, priority)` — no core-file edits required:

```js
this.players.registerPriority('MyPlugin', 4);  // preempts TeamBalancer
```

Custom registrations only apply to sources not already hardcoded in `PRIORITY` — you cannot override `TeamBalancer`, `SmartAssign`, or `Switch`'s built-in levels this way.

#### Lock Types

| Lock Type | API | Currently Used By | Effect |
|-----------|-----|-------------------|--------|
| **Global lock** | `lockGlobal()` / `unlockGlobal()` | Team Balancer (scramble) | Blocks all `canAct()` checks across all players while held |
| **Per-player lock** | `lock()` / `unlock()` | **Not currently acquired** | Blocks `canAct()` for a specific player; available but unused |
| **canAct() gate** | `canAct(eosID, source)` | SA (retry loop), Switch (command gate) | Non-mutating check; returns `false` if a higher-priority lock blocks the player |

#### Global Lock (Team Balancer)

During a scramble, Team Balancer acquires the global lock before moving any players:

```js
this._s3.players.lockGlobal('TeamBalancer', maxScrambleTime + 5000);
```

The global lock is released in a `finally` block when the scramble completes (or fails). While held, `canAct()` returns `false` for all lower-priority callers (both SA and Switch), regardless of which specific player is being targeted. If another actor already holds the global lock, TB aborts the scramble entirely.

#### canAct() Gates (Smart Assign & Switch)

- **Smart Assign** checks `canAct(eosID, 'SmartAssign')` inside its retry loop (in `SASwapExecutor.processRetries()`). On each RCON retry attempt, if `canAct()` returns `false` (because TB holds the global lock), SA aborts that player's move with reason `'PreemptedByLock'` and the player is reassigned.

- **Switch** checks `canAct(eosID, 'Switch')` at the `!switch` chat command gate, before any eligibility checks. If `canAct()` returns `false`, Switch tells the player *"You are currently being processed — please try again shortly"* and returns immediately — no queue, no balance check, no processing.

#### ⚠️ Known Issue: Smart Assign Does Not Acquire a Per-Player Lock

**What should happen:** When SA begins moving a player (inside the swap executor's retry loop), it should acquire a per-player lock via `players.lock(eosID, 'SmartAssign', ttlMs)`. This would set a per-player lock that Switch's `canAct()` gate would detect, causing Switch to deny `!switch` requests for that player during SA's move window (typically 3–6 seconds).

**What actually happens:** SA currently only *checks* `canAct()` defensively (to detect preemption by TB's global lock) but never *acquires* a per-player lock via `lock()`. As a result, Switch's `canAct()` check sees no lock for the player and allows the `!switch` command to proceed, even when SA is actively trying to swap that player.

**Impact:** A player can type `!switch` while SA's swap executor is retrying to move them. Since SA holds no lock, Switch passes the `canAct()` gate and proceeds with its own team-change logic, potentially conflicting with SA's ongoing move.

**Status:** Open. SmartAssign needs to call `players.lock(eosID, 'SmartAssign', ttlMs)` when it begins a move, not just check `canAct()`.

#### move Attribution

All three plugins use `_requestTeamChange()`, which internally calls `players.recordMove(eosID, targetTeamID, source)` before the first RCON attempt. The `source` parameter identifies the calling plugin (`'SmartAssign'`, `'TeamBalancer'`, or `'Switch'`). This attribution is logged to the DB for audit purposes and is queryable via the `!s3 players` command.

#### Full Flow During a TB Scramble

1. TB calls `lockGlobal('TeamBalancer')` → succeeds.
2. SA's retry loop calls `canAct(player, 'SmartAssign')` → global lock check: `TeamBalancer > SmartAssign` → returns `false` → SA aborts that move as `'PreemptedByLock'`.
3. A player types `!switch` → Switch calls `canAct(player, 'Switch')` → global lock check: `TeamBalancer > Switch` → returns `false` → Switch denies the request.
4. TB scramble completes → `unlockGlobal('TeamBalancer')` in `finally` → SA and Switch resume normal operation.
5. Per-player locks would work the same way: if SA acquired a lock on player X, Switch's `canAct('X', 'Switch')` would see `SmartAssign(2) > Switch(1)` and deny the request.

---

## §6 — Integration Checklist

Use this checklist when integrating a new consumer plugin with S³ or reviewing an existing one.

### 6.1 — Discovery & Storage

- [ ] S³ discovered at mount time via `this.server.plugins.find()`
- [ ] Reference stored as `this._s3`
- [ ] S³ is treated as required (throws if not found)

### 6.2 — Access Pattern

- [ ] Flat access only: `this._s3?.gameState` — never `this._s3?.services?.gameState`
- [ ] `isReady()` guard on every service access
- [ ] `this._s3` optional-chained (`?.`) to handle null
- [ ] No redundant `isReady()` checks on methods that already guard internally

### 6.3 — Game State Lifecycle

- [ ] `isIgnoredMode()` checked before processing a round (if your plugin cares about seed/training/event layers)
- [ ] Phase-appropriate logic: actions gated on `isLive()` / `isStaging()` as appropriate
- [ ] Round timing uses `getRoundStartTime()` / `getMatchId()` from S³ gameState
- [ ] Crash recovery respected: mount-time gameState check

### 6.4 — Player Attribution

- [ ] Team changes recorded via `players.recordMove(playerKey, targetTeam, source)`
- [ ] `recordMove` called from all relevant plugins
- [ ] `source` parameter identifies the calling plugin (e.g., `'SmartAssign'`, `'TeamBalancer'`)

### 6.5 — Clan Grouping

- [ ] Clan prefix extraction via `clans.extractRawPrefix(player.name)`
- [ ] Clan grouping config sourced from S³ (single source of truth)
- [ ] No duplicate clan-caching — S³ is the authority

### 6.6 — Base Class Adoption

- [ ] Plugin extends `S3PluginBase` or `S3DiscordPluginBase` instead of manually discovering S³
- [ ] `_onS3Ready()` used instead of `mount()` for S³-dependent logic
- [ ] Model definition uses `this.defineModel()` (not `s3db.defineModel()`)
- [ ] Migration registration uses `this.registerMigrations()` / `this.verifyAndRunMigrations()`
- [ ] Team changes use `this._requestTeamChange()` (not hand-rolled RCON + verify)
- [ ] DB access uses `this._withDb()` or `this._getModel()`
- [ ] Service access via base class getters (`this.gameState`, `this.players`, etc.)

### 6.7 — Discarded / Legacy (Do Not Use)

- [ ] ❌ `this.roundStartTime` — use `gameState.getRoundStartTime()`
- [ ] ❌ `this.matchId` — use `gameState.getMatchId()`
- [ ] ❌ Self-managed clan cache — use `clans` service
- [ ] ❌ `this._s3?.services?.anything` — use flat getters

### 6.8 — Documentation

- [ ] Plugin top comment includes an `S³ INTEGRATION` section
- [ ] JSDoc accurately describes guard logic (not stale — verify actual code matches the doc)
- [ ] README mentions S³ integration (if applicable)

---

## §7 — Anti-Patterns

Avoid these patterns in new code and clean them up in existing code.

### 7.1 — Missing `isReady()` on Decision-Gate Methods

**Problem:** A method that gates plugin behaviour checks for the service's existence but not its readiness.

```js
// ❌ ANTI-PATTERN — checks existence only
_isIgnoredMatch() {
  const gs = this._s3?.gameState;
  if (!gs) return false;           // Doesn't check readiness
  return gs.isIgnoredMode();
}
```

**Fix:** Check readiness alongside existence:

```js
// ✅ CORRECT — checks readiness
_isIgnoredMatch() {
  const gs = this._s3?.gameState;
  if (!gs?.isReady()) return false;
  return gs.isIgnoredMode();
}
```

### 7.2 — Existence Check Instead of Readiness Check at Mount Time

```js
// ❌ ANTI-PATTERN — mount-time existence check
if (this.ready && this._s3?.gameState) {     // Exists but may not be ready
  const recovering = this._s3.gameState.getRoundStartTime();
}
```

**Fix:** Use `isReady()`:

```js
// ✅ CORRECT — mount-time readiness check
if (this.ready && this._s3?.gameState?.isReady()) {
  const recovering = this._s3.gameState.getRoundStartTime();
}
```

### 7.3 — Stale JSDoc Claiming Guards That Don't Exist

**Problem:** JSDoc describes a guard pattern that the actual code does not implement.

```js
// ❌ ANTI-PATTERN — JSDoc claims isReady() guard, but code doesn't have one
/**
 * NOTE: Caller MUST check guards before calling.
 */
_isClanGroupingEnabled() {
  return this._s3?.serverConfig?.options?.enableClanTagGrouping ?? false;
}
```

**Fix:** Align JSDoc with reality — either add the guard or remove the misleading claim.

### 7.4 — Redundant Guards on Internally-Guarded Methods

```js
// ❌ ANTI-PATTERN — redundant guard
const players = this._s3?.players;
if (players?.isReady() && playerKey) {
  players.recordMove(playerKey, team, 'SmartAssign');  // recordMove already guards
}
```

**Fix:** Let the callee handle readiness:

```js
// ✅ ACCEPTABLE — callee handles guard internally
this._s3?.players?.recordMove(playerKey, team, 'SmartAssign');
```

### 7.5 — Duplicated/Stale State Instead of S³ Ground Truth

```js
// ❌ ANTI-PATTERN — duplicated state
constructor() {
  this.clanPrefixes = {};           // S³ clans service is the authority
  this.roundStartTime = null;       // Use gameState.getRoundStartTime()
  this._currentLayer = null;        // Use gameState.getLayerName()
}
```

**Fix:** Remove the duplicate state and use S³ service APIs.

### 7.6 — Manually Discovering S³ Instead of Extending Base Class

```js
// ❌ ANTI-PATTERN — manual S³ discovery in every plugin
async mount() {
  await super.mount();
  const s3 = this.server.plugins.find(p => p.constructor.name === 'SlackersSquadServices');
  if (!s3) throw new Error('S³ required');
  this._s3 = s3;
  await this._s3.ready();
  this._s3db = this._s3.db;
  // ... more boilerplate ...
}
```

**Fix:**

```js
// ✅ CORRECT — extend S3PluginBase
export default class MyPlugin extends S3PluginBase {
  async _onS3Ready() {
    // S³ is ready, this.s3db is cached
  }
}
```

### 7.7 — Hand-Rolling RCON Team Change Instead of `_requestTeamChange()`

```js
// ❌ ANTI-PATTERN — manual RCON + stale server.players verify
await this.server.rcon.switchTeam(name, team);
const player = this.server.players.find(p => p.name === name);
```

**Fix:** Use the base class method with S³-based verification:

```js
// ✅ CORRECT — base class handles retry + S³ verification
const result = await this._requestTeamChange(eosID, {
  maxAttempts: 5,
  source: 'MyPlugin'
});
```

### 7.8 — Accessing Models Directly Instead of `_getModel()`

```js
// ❌ ANTI-PATTERN — direct access with no null safety
this._s3.db.models.Elo_PlayerStats.findAll();
```

**Fix:**

```js
// ✅ CORRECT — null-safe model access
const Model = this._getModel('Elo_PlayerStats');
if (!Model) return;
await Model.findAll();
```

### 7.9 — Scattered Migration Steps Instead of Single `verifyAndRunMigrations()` Pattern

```js
// ❌ ANTI-PATTERN — manual migration steps
this._s3db.registerExpectedVersion('my-plugin', 2);
this._s3db.migrationEngine.registerMigrations('my-plugin', [...]);
const check = await this._s3db.verifySchemaVersions();
if (!check.upToDate) {
  await this._s3db.migrationEngine.runMigrations('my-plugin');
}
```

**Fix:**

```js
// ✅ CORRECT — single-call pattern
this.registerExpectedVersion('my-plugin', 2);
this.registerMigrations('my-plugin', [...]);
await this.verifyAndRunMigrations('my-plugin');
```

---

## §8 — S³ Plugin Base Class Guide

### 8.1 — When to Use Which

| Scenario | Base Class |
|----------|-----------|
| Plugin needs S³ services + database | `S3PluginBase` |
| Plugin needs S³ services + database + a single Discord channel | `S3DiscordPluginBase` |
| Plugin needs S³ services + database + multiple Discord channels | `S3PluginBase` (manage channels yourself) |
| Plugin doesn't need S³ at all | SquadJS `BasePlugin` (not covered here) |

> **Note:** `S3DiscordPluginBase` inherits everything from `S3PluginBase` — database convenience methods, service accessors, and `_requestTeamChange()`. The only addition is Discord channel setup and `sendDiscordMessage()`.

### 8.2 — S3PluginBase API

**Source file:** `SlackersSquadServices/plugins/s3-plugin-base.js`

**Lifecycle hooks** (subclasses override these — **not** `mount()`/`unmount()`):

| Hook | When Called | Purpose |
|------|-------------|---------|
| `_onS3Ready()` | After S³ fully mounts, `_s3db` cached | Setup models, migrations, listeners, refresh interests |
| `_onUnmount()` | During unmount, before `_s3db` cleared | Cleanup: unregister listeners, clear state, remove refresh interests |

**S³ discovery** (inherited, not overridden):

| Method | Purpose |
|--------|---------|
| `_resolveS3()` | Finds S³ by constructor name. Called in `prepareToMount()`. |
| `_awaitS3Ready(timeoutMs?)` | Waits for S³ readiness. Fast path + fallback poll. |

**DB convenience** (call from `_onS3Ready()`):

| Method | Purpose |
|--------|---------|
| `defineModel(name, schema, opts?)` | Define Sequelize model on S³'s connector |
| `registerExpectedVersion(plugin, version)` | Declare expected schema version |
| `registerMigrations(plugin, migrations)` | Register migration functions |
| `verifyAndRunMigrations(plugin)` | Check + run pending migrations (single call) |
| `_getModel(name)` | Access defined model (null-safe) |
| `_withDb(fn)` | Run fn in transaction with retry (null-safe) |

**Service accessors** (available after `_onS3Ready()`):

| Getter | Returns |
|--------|---------|
| `this.s3` | S³ plugin reference |
| `this.s3db` | S³ DBService (cached) |
| `this.gameState` | GameStateService |
| `this.players` | PlayersService |
| `this.clans` | ClansService |
| `this.factions` | FactionsService |
| `this.serverConfig` | ServerConfigService |

**Team change:**

| Method | Returns |
|--------|---------|
| `_requestTeamChange(eosID, options?)` | `Promise<{success, eosID, teamID, attempts, name, source}\|null>` |

Options:
```js
{
  maxAttempts: 5,       // RCON send retry count
  warnPlayer: false,    // Send rcon.warn on success
  warnMessage: 'You have been scrambled',
  source: 'S3PluginBase' // Source identifier
}
```

After each RCON attempt, the method calls `players.refreshNow(source)` to force a fresh player-list read before checking whether the move landed — verification queries S³'s player registry, not SquadJS's `server.players` cache, eliminating stale-cache false failures.

### 8.3 — S3DiscordPluginBase API

**Source file:** `SlackersSquadServices/plugins/s3-discord-plugin-base.js`

Extends `S3PluginBase` with Discord channel setup and message sending, mirroring SquadJS's `DiscordBasePlugin` but on top of the S³ service layer.

**Adds over S3PluginBase:**
- `optionsSpecification`: adds `discordClient` connector (required, default: `'discord'`)
- `parentOptionsSpecification`: static getter for subclass spread pattern: `...this.parentOptionsSpecification`
- `prepareToMount()`: also fetches `this.options.channelID` → `this.channel`
- `sendDiscordMessage(message)`: sends text or embed to configured channel. Handles `embed`→`embeds` conversion, footer, hex colors.

**IMPORTANT:** `channelID` is NOT declared in the base class's `optionsSpecification`. Each subclass must declare its own `channelID` option. The base class reads `this.options.channelID` during `prepareToMount()`.

### 8.4 — Consumer Plugin Template (Minimal)

```js
import S3PluginBase from './s3-plugin-base.js';

export default class MyPlugin extends S3PluginBase {
  static get description() { return 'My S³ consumer plugin'; }
  static get defaultEnabled() { return false; }

  static get optionsSpecification() {
    return {
      // Plugin-specific options only — no S³ options needed
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);
    // Plugin-specific state
  }

  async _onS3Ready() {
    // 1. Define models (if DB-backed)
    this.defineModel('MyPlugin_Table', {
      id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
      // ...
    });

    // 2. Register migrations
    this.registerExpectedVersion('my-plugin', 1);
    this.registerMigrations('my-plugin', [
      { version: 1, description: 'Initial schema',
        up: async (qi) => { /* ... */ },
        down: async (qi) => { /* ... */ } }
    ]);
    await this.verifyAndRunMigrations('my-plugin');

    // 3. Register event handlers
    this.server.on('NEW_GAME', (...args) => this.handleNewGame(...args));

    // 4. Register refresh interest for player list
    this.players?.registerRefreshInterest('MyPlugin');
  }

  async _onUnmount() {
    // Cleanup
    this.players?.unregisterRefreshInterest('MyPlugin');
  }
}
```

**Discord variant:**

```js
import S3DiscordPluginBase from './s3-discord-plugin-base.js';

export default class MyDiscordPlugin extends S3DiscordPluginBase {
  static get optionsSpecification() {
    return {
      ...this.parentOptionsSpecification,
      channelID: { required: true, description: 'Discord channel ID', default: '' }
    };
  }
  async _onS3Ready() {
    // S³ is ready, Discord channel is available via this.channel
  }
}
```

---

## §9 — Migration Workflow Guide

### 9.1 — Registration Pattern

Inside `_onS3Ready()`:

1. **Declare expected version:**
   ```js
   this.registerExpectedVersion('my-plugin', 3);
   ```

2. **Register migration functions:**
   ```js
   this.registerMigrations('my-plugin', [
     { version: 1, description: 'Initial schema',
       up: async (qi) => { await qi.createTable('MyPlugin_Table', { ... }); },
       down: async (qi) => { await qi.dropTable('MyPlugin_Table'); } },
     { version: 2, description: 'Add rating column',
       up: async (qi) => { await qi.addColumn('MyPlugin_Table', 'rating', 'INTEGER'); },
       down: async (qi) => { await qi.removeColumn('MyPlugin_Table', 'rating'); } },
     { version: 3, description: 'Add index on playerID',
       up: async (qi) => { await qi.addIndex('MyPlugin_Table', ['playerID']); },
       down: async (qi) => { await qi.removeIndex('MyPlugin_Table', 'my_plugin_table_player_id'); } }
   ]);
   ```

3. **Run pending migrations:**
   ```js
   await this.verifyAndRunMigrations('my-plugin');
   ```

### 9.2 — Query Interface (qi) API

The `qi` (QueryInterface) object passed to each migration function provides these methods:

| Method | Signature | Purpose |
|--------|-----------|---------|
| `addColumn(table, col, def)` | `(string, string, string\|object) => Promise` | Add column |
| `removeColumn(table, col)` | `(string, string) => Promise` | Remove column |
| `changeColumn(table, col, def)` | `(string, string, object) => Promise` | Modify column |
| `addIndex(table, cols, opts?)` | `(string, string[], object?) => Promise` | Create index |
| `removeIndex(table, name, opts?)` | `(string, string, object?) => Promise` | Drop index |
| `createTable(name, attrs, opts?)` | `(string, object, object?) => Promise` | Create table |
| `dropTable(name, opts?)` | `(string, object?) => Promise` | Drop table |
| `showAllTables()` | `() => Promise<string[]>` | List all tables |
| `rawQuery(sql, replacements?)` | `(string, object?) => Promise<*>` | Execute raw SQL |
| `sequelize` | property | Direct Sequelize access |
| `db` | property | DBService instance |
| `transaction` | property | Active Sequelize transaction |

### 9.3 — Version Numbering

- Start at **1** for initial schema
- Increment by **1** for each schema change — this is convention, **not enforced** by the engine
- Never reuse a version number
- If multiple plugins share a table, coordinate version numbers across plugins

**What `registerMigrations()` actually validates:** each version is a positive integer, no duplicate version within one call, and a subsequent `registerMigrations()` call for the same plugin must start above the previous call's max version (`newMin > existingMax`). It does **not** check that versions are contiguous — `[1, 2, 5]` in a single call passes validation with no error or warning. Gaps are a convention worth keeping (makes `behind` counts in migration-status embeds meaningful), but nothing in the code stops you from breaking it.

### 9.4 — Migration Execution Model

- Migrations run in **ascending version order**
- Each migration runs in its **own transaction** — a failure at v3 does not roll back v2
- The startup confirmation flow gates execution (unless `autoMigrate: true` in S³ config)
- Pre-migration backup runs **two tiers**: SQLite file-copy backup only when a `dbPath` is available (SQLite connector), and JSON export **always**, regardless of dialect. Migration aborts only if *both* tiers fail — a Postgres/MySQL deployment with a healthy JSON export still proceeds even though it has no file copy.
- The `verifyAndRunMigrations()` single-call pattern checks schema versions first, runs only pending migrations, and returns the result

### 9.5 — S³ Schema Versions Table

The `S3_SchemaVersions` table tracks which version each plugin is at. It is populated by:
- `registerExpectedVersion()` — declares what version the code expects
- Migration execution — updates the actual version after successful migration
- `verifySchemaVersions()` — compares expected vs actual

### 9.6 — Offline CLI Migration Tool

A standalone CLI tool (`SlackersSquadServices/tools/schema-version.mjs`) can check, preview, and run migrations without booting SquadJS. Useful when the game server is offline and Discord confirmation isn't available.

```
node tools/schema-version.mjs check              # Version status per plugin
node tools/schema-version.mjs pending            # Preview pending migrations
node tools/schema-version.mjs migrate            # Apply pending migrations
node tools/schema-version.mjs migrate --dry-run  # Preview without writing
node tools/schema-version.mjs migrate --force    # Skip confirmation prompt
node tools/schema-version.mjs migrate --plugin smart-assign  # Single plugin only
node tools/schema-version.mjs check --db-path ./custom.sqlite  # Custom DB path
```

The tool uses the same `DBService` + `MigrationEngine` infrastructure as the live S³ plugin, bootstrapping a Sequelize connection directly to the database file. It mirrors the migration manifest that each consumer plugin registers at runtime.

### 9.7 — Offline Schema Health Checker

A second, separate CLI tool — `tools/schema-health.js` — checks column-level table health and detects orphan tables (S³-prefixed tables present in the DB but not expected), independent of version tracking:

```
node tools/schema-health.js
node tools/schema-health.js --db-path ./custom-path.sqlite
node tools/schema-health.js --json
```

Unlike `schema-version.mjs`, it does not consult `build/config.json` for the DB path — only `--db-path` or the hardcoded project-root default.

> **⚠️ Known bug — do not rely on this tool's output yet.** `schema-health.js` currently reports every table as `❌ missing` regardless of actual DB state. `sequelize.query(sql, { type: QueryTypes.SELECT })` returns rows directly, not a `[rows, metadata]` tuple, but the tool destructures it as one (`const [allTablesRaw] = await sequelize.query(...)`). This silently pulls the first row instead of the row array, fails an `Array.isArray` check, and falls back to an empty table list. Fix before use: replace the destructuring with a direct assignment (`const allTablesRaw = await sequelize.query(...)`) in both query call sites. The tool's own failure message also points to a stale path (`build/schema-version.cjs`) — should be `tools/schema-version.mjs`.

---

## §10 — Discord Commands & Backup/Import

### 10.1 — `!s3` Admin Commands

All commands in the configured `channelID` Discord channel:

| Command | Description |
|---------|-------------|
| `!s3 status` | Overview: service mount status, game phase, player count |
| `!s3 services` | Per-service detail with ready state |
| `!s3 gamestate` | Phase, mode, layer, sub-state, round timing |
| `!s3 factions` | Team 1/2 abbreviations, faction IDs |
| `!s3 players` | Full player list with teamID, clan tag, join time |
| `!s3 clans` | Detected clan groups |
| `!s3 locks` | Global lock + per-player locks |
| `!s3 config` | Server config values |
| `!s3 watch <service>` | Relay verbose logs for a service to Discord |
| `!s3 unwatch` | Stop all active watches |
| `!s3 diag` | Consolidated diagnostic — mounts, phase, factions, players, locks in one pass |
| `!s3 help` | Command reference |
| `!s3 db export [--logs\|--all]` | Export DB as JSON attachment |
| `!s3 db export --to-file [--all]` | Export to server filesystem backup dir |
| `!s3 db import [--confirm] [--dry-run]` | Import from attached JSON (two-step) |
| `!s3 backup` | List backups in the backup directory |
| `!s3 backup restore <filename>` | Restore from backup file (auto-detects SQLite vs JSON) |
| `!s3 migrate` | Check pending migrations (if Discord configured + not `autoMigrate`) |

### 10.2 — Export/Import System

**Three-tier classification:**

| Tier | Flag | Tables included |
|------|------|-----------------|
| Historical | (default) | `S3_SchemaVersions`, `Elo_PlayerStats`, `Elo_RoundHistory`, `Elo_RoundPlayers`, `SA_AssignmentLog`, `TB_RoundReport` |
| Logging | `--logs` | Above + `S3_PlayerEvents`, `S3_GameStateEvents`, `S3_PlayerSnapshots` |
| All | `--all` | Above + all auto-recoverable tables |

**Export format:**

```json
{
  "s3ExportVersion": 1,
  "exportedAt": 1719547200000,
  "connector": "sqlite",
  "tables": {
    "TableName": [ { ... row ... } ]
  },
  "rowCounts": { "TableName": 42 },
  "results": { "TableName": { "status": "ok", "rows": 42 } }
}
```

**Import workflow:** Two-step — `!s3 db import` (with attachment) → review embed → `!s3 db import --confirm` → execute.

**Constraints:**
- No deletes on import (upsert only)
- FK checks disabled during the transaction
- Per-table try-catch (a failed table does not roll back others)

### 10.3 — Plugin-Level Exports

| Plugin | Export Command | Format | Target |
|--------|---------------|--------|--------|
| Elo | `!elo backup` / `!elo restore` | Targeted rating export | Discord DM |
| Team Balancer | `!teambalancer export` | JSONL log export | File / attachment |

These are separate from and orthogonal to the S³-wide export/import system.

### 10.4 — Backup Format Auto-Detection

The `!s3 backup restore` command auto-detects whether a backup file is:
- **SQLite file copy** (`.sqlite` extension) — restores by direct file copy
- **JSON export** (`.json` extension) — restores via the connector-agnostic import pipeline

Both backup formats are always produced during pre-migration backup when SQLite mode is active.

---

## §11 — Testing Patterns

### 11.1 — Test File Conventions

All tests are in `SlackersSquadServices/testing/`. They use mock infrastructure — no live SquadJS or game server required.

**Running a test:**

```bash
cd SlackersSquadServices
node testing/test-game-state-service.js
```

**Test file catalog:**

| File | What It Tests |
|------|--------------|
| `test-game-state-service.js` | Phase transitions, matchId/roundStartTime, stale recovery, ENDGAME timer chain |
| `test-db-service.js` | Model registration, migration workflow, schema versioning |
| `test-players-service.js` | Player tracking, reconnect detection, locks, team change attribution |
| `test-clans-service.js` | Tag extraction, normalisation, grouping, clan team detection |
| `test-factions-service.js` | Team abbreviation resolution, faction caching |
| `test-server-config-service.js` | Config parsing, accessor accuracy |
| `test-crash-recovery.js` | Persisted state, recovery transitions |
| `test-s3-plugin-base-lifecycle.js` | S3PluginBase discovery, mount/unmount hooks |
| `test-s3-plugin-base-db.js` | Base class DB: model definition, migration flow |
| `test-s3-discord-plugin-base.js` | Discord channel setup, `sendDiscordMessage()` |
| `test-s3-export-import.js` | Three-tier export/import, JSON format, validation |
| `test-s3-commands.js` | All `!s3` command paths, embed builders |
| `test-command-standardization.js` | Elo lookup helper, Switch help fallback |
| `test-migration-backup.js` | Pre-migration backup flow |
| `test-auto-migrate.js` | `autoMigrate: true` startup mode |
| `test-db-connector-compat.js` | Model registration across SQLite/Postgres/MySQL |
| `test-handshake-flow.js` | Cross-plugin coordination tests |
| `test-join-pipeline.js` | Player join sequence with handshake active |
| `test-player-session-persistence.js` | Session recovery on mount |

### 11.2 — Mock Patterns

```js
class MockServer extends EventEmitter {
  constructor() {
    super();
    this.players = [];
    this.currentLayer = null;
  }
}

class MockSequelize {
  constructor() { /* in-memory row store */ }
  define(name) { /* returns mock model with sync/upsert/findByPk */ }
}
```

### 11.3 — Writing New Tests

1. Import the service from `../utils/<service>.js`
2. Create mock `Server`, mock `Sequelize` (if needed)
3. Instantiate service with `{ parent, server, verboseLogger, ... }`
4. Call `await service.mount()` then exercise methods with `assert.strictEqual()`
5. Call `await service.unmount()` for cleanup

For base-class tests, instantiate a stub subclass:

```js
class TestPlugin extends S3PluginBase {
  async _onS3Ready() {
    this._readyCalled = true;
    this._dbReady = !!this.s3db;
  }
}
```

---

## §12 — Deployment & Configuration

### 12.1 — Plugin Ordering in `config.json`

S³ must appear **before** consumer plugins:

```json
{
  "plugins": [
    { "plugin": "SlackersSquadServices", "enabled": true,
      "database": "sqlite", "channelID": "..." },
    { "plugin": "SmartAssign", "enabled": true, "teamSelectionMethod": "elo", "minTeamSize": 4, "maxTeamSize": 8, "scrambleCooldown": 300, "autoBalanceDelay": 30, "maxEloDifference": 200, "stagingTimeLimit": 180, "enableTrueSkill": true, "enableScramble": true, "enableAutoBalance": false },
    { "plugin": "Switch", "enabled": true, "database": "sqlite", "discordClient": "discord", "switchCooldown": 300, "scrambleLockoutDuration": 600, "maxQueueSize": 10, "discordChannelID": "...", "enableDiscordNotifications": true },
    { "plugin": "EloTracker", "enabled": true, "database": "sqlite", "discordClient": "discord", "discordPublicChannelID": "...", "discordAdminChannelID": "...", "minPlayersForElo": 80, "minRoundsForLeaderboard": 10, "enablePublicIngameCommands": true },
    { "plugin": "TeamBalancer", "enabled": true, "database": "sqlite", "discordClient": "discord", "minPlayersForScramble": 20, "imbalanceThreshold": 3, "scrambleCooldown": 900, "useEloForBalance": true, "enableAutoScramble": false }
  ]
}
```

### 12.2 — Required Connectors

| Connector | Config Key | Notes |
|-----------|------------|-------|
| `database` | `database` | Sequelize connector (SQLite, Postgres, MySQL). Required. |
| `discordClient` | `discordClient` | Discord connector. Set to `null` to disable Discord commands. |

### 12.3 — Key S³ Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `database` | connector | `'sqlite'` | Sequelize connector |
| `discordClient` | connector | `'discord'` | Discord connector (null to disable) |
| `channelID` | string | `''` | Admin channel for `!s3` commands |
| `configPath` | string | `'./SquadGame/ServerConfig/'` | Server.cfg directory |
| `ignoredGameModes` | string[] | `['Seed', 'Jensen']` | Modes gated by `isIgnoredMode()` |
| `enableClanTagGrouping` | boolean | `false` | Enable clan grouping |
| `minClanGroupSize` | number | `2` | Minimum clan group size |
| `maxClanGroupSize` | number | `18` | Maximum clan group size |
| `clanTagMaxEditDistance` | number | `1` | Levenshtein distance for merging similar tags |
| `clanTagCaseSensitive` | boolean | `false` | If false, tags are normalised before grouping |
| `clanTagIgnoreList` | array | `[]` | Tags excluded from grouping |
| `clanRecruitSuffixes` | array | `["r", "-r"]` | Suffixes to strip from clan tags when the base tag (without suffix) exists on other players. Enabled by default for common recruit tags (case-insensitive, so "R" and "-R" are also matched). Set to `[]` to disable. Stripping only occurs when the base tag is present on at least one other player in the data set. |
| `clanGroupingPullEntireSquads` | boolean | `false` | Pull full squads when preserving clan groups |
| `enableDatabaseLogging` | boolean | `false` | Enable `S3_PlayerEvents`/`S3_GameStateEvents`/`S3_PlayerSnapshots` tables. `false` → LoggingService runs no-op. |
| `enableFileLogging` | boolean | `false` | Mirror each DB log write as a JSONL line at `logPath` |
| `logPath` | string | `'./s3-log.jsonl'` | JSONL mirror path, used only when `enableFileLogging` is true |
| `autoMigrate` | boolean | `false` | Auto-apply migrations without Discord confirmation |

### 12.4 — File Placement

1. Copy `SlackersSquadServices/plugins/*.js` to your SquadJS `squad-server/plugins/`
2. Copy `SlackersSquadServices/utils/*.js` to your SquadJS `squad-server/utils/`

**Import path rule:** Always use sibling relative imports (`'./s3-plugin-base.js'`), not deep relative paths (`'../../SlackersSquadServices/plugins/...'`).

### 12.5 — Base Class Never Enabled

`S3PluginBase` and `S3DiscordPluginBase` are **never enabled in `config.json`**. They exist purely as inheritance targets for consumer plugins. SquadJS will never try to mount them directly.

---

## Appendices

### A. Service Readiness Summary

| Service | `isReady()` Returns `true` When |
|---------|--------------------------------|
| `gameState` | Mounted, timers initialised, layer resolved |
| `clans` | Mounted, clan config loaded |
| `players` | Mounted, player list projection active |
| `db` | Sequelize connected, schema verified |
| `serverConfig` | Config file loaded and parsed |
| `factions` | Faction data loaded, polling active |
| `logging` | Mounted, event subscriptions active |

**Base class readiness:**

| Base Class | Ready When |
|------------|-----------|
| `S3PluginBase` | `_onS3Ready()` is called (S³ fully mounted + DB cached) |
| `S3DiscordPluginBase` | `_onS3Ready()` is called (Discord channel also available via `this.channel`) |

### B. Quick Reference — S³ Access Templates

**Template A — With base class (preferred):**

```js
import S3PluginBase from './s3-plugin-base.js';

export default class MyPlugin extends S3PluginBase {
  async _onS3Ready() {
    // S³ is ready — access services directly
    const gs = this.gameState;
    if (!gs?.isReady()) return;
    if (gs.isIgnoredMode()) return;

    // Register event listeners
    this.server.on('NEW_GAME', (...args) => this.handleNewGame(...args));

    // Register refresh interest
    this.players?.registerRefreshInterest('MyPlugin');

    this.verbose(1, 'MyPlugin mounted with S³ base class.');
  }

  handleNewGame() {
    const gs = this.gameState;
    if (!gs?.isReady()) return;
    // ... handler logic ...
  }

  async _onUnmount() {
    this.players?.unregisterRefreshInterest('MyPlugin');
  }
}
```

**Template B — Without base class (legacy):**

```js
export default class MyPlugin extends BasePlugin {
  async mount() {
    await super.mount();

    // 1. Discover S³
    const s3 = this.server.plugins.find(
      (p) => p.constructor.name === 'SlackersSquadServices'
    );
    if (!s3) throw new Error('S³ required');
    this._s3 = s3;

    // 2. Await S³ readiness
    await this._s3.ready();

    // 3. Register listeners
    this.server.on('NEW_GAME', (...args) => this.handleNewGame(...args));

    this.verbose(1, 'MyPlugin mounted with S³ integration.');
  }

  handleNewGame() {
    const gs = this._s3?.gameState;
    if (!gs?.isReady()) return;
    if (gs.isIgnoredMode()) return;
    // ... handler logic ...
  }
}
```

### C. Reference Implementations

The following consumer plugins serve as working examples of S³ integration:

| Plugin | Base Class | Key Features Demonstrated |
|--------|-----------|--------------------------|
| **Smart Assign** | `S3PluginBase` | DB-backed models, migration registration, `_requestTeamChange()` with retry, player locking via `canAct()`, `registerRefreshInterest()` |
| **Switch** | `S3DiscordPluginBase` | Discord channel setup, `_requestTeamChange()` with source attribution, player lock coordination |
| **Team Balancer** | `S3PluginBase` | DB-backed state, migration registration, `_requestTeamChange()`, clan-grouped team assignment |
| **Elo Tracker** | `S3PluginBase` | DB-backed models (`Elo_PlayerStats`, `Elo_RoundHistory`, `Elo_RoundPlayers`), migration pipeline, `isIgnoredMode()` gating |

Each plugin is in `ReferenceScripts/<plugin-name>/plugins/` in the repository.

---

> *Developer Guide — documents the S³ architecture as of 2026-07-01.*