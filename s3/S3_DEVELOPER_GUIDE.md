# S³ Developer Guide

> **Canonical reference for building SquadJS plugins that consume S³ (Slacker's Squad Services).**
>
> **Last reviewed:** 2026-07-24, verified against source.

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
- **Game-state lifecycle** — round phase tracking (STAGING → LIVE → ENDGAME), layer/gamemode inference, crash recovery
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

**Dialect portability helpers** — use these whenever you write raw SQL. See §7.10.

| Method | Signature | Returns | Notes |
|--------|-----------|---------|-------|
| `getDialect()` | `() => string\|null` | `'sqlite'` / `'mysql'` / `'postgres'` | The **real** dialect. Branch on this, never on `getConnectorName()` |
| `quoteIdentifier(name)` | `(string) => string` | Quoted identifier | `` `col` `` on SQLite/MySQL, `"col"` on Postgres |
| `escapeValue(value)` | `(*) => string` | Quoted SQL literal | For values inlined into a literal instead of bound |
| `incrementLiteral(col, n)` | `(string, number?) => Literal` | Sequelize literal | Portable atomic `col + n` for `Model.update()` |
| `caseInsensitiveLikeOp()` | `() => symbol` | `Op.iLike` / `Op.like` | Case-insensitive substring match on every dialect |
| `caseInsensitiveLikeLiteral(col, term, opts)` | `(string, string, {exact?: boolean}) => Literal` | Sequelize literal | As above, plus a working `ESCAPE` clause and safe value quoting. Pass `{ exact: true }` for a whole-value compare that is still case-insensitive on every dialect — unlike `col = term`, which is case-sensitive on Postgres and on binary-collated MySQL columns |

> **`getConnectorName()` vs `getDialect()`:** `getConnectorName()` returns the connector **label** — the key in the `connectors` map from `config.json`. That's conventionally the dialect name, but a deployment may key its connector `main` or `s3`, in which case the label matches no dialect branch at all. Any code deciding *what SQL to emit* must use `getDialect()`.

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

Tracks round phases (STAGING → LIVE → ENDGAME), infers gamemode/layer from server state, provides round timing and match IDs, and handles crash recovery via persisted state.

**Phase vs. resolving — two separate questions.** The *phase* is where the round is (STAGING mirrors the in-game staging period that keeps players in main). `resolving` is whether team data can be trusted yet, and it is **not** bounded by the phase: it is set at `NEW_GAME` and cleared by the first player-info tick that shows every tracked player on a real team, whatever phase that lands in. `resolvingTimeoutMs` (default 120s) is the escape hatch for a round where that never happens — floored at runtime to 4× PlayersService's effective refresh interval, since the flag can only ever clear on a tick and that interval is dynamic (clamped to [3s, 60s], set by the fastest registrant).

**STAGING duration:** SquadJS gives no "match started" event, so STAGING → LIVE is a timer: `stagingDurationMs` (default 180s), or **5s on seed/training layers**, which have no real staging phase and would otherwise sit in STAGING forever (a seed round never fires another `NEW_GAME`). The shortcut applies **only when the layer was resolved for the current round** — `getLayerName()` falls back to the previous round's layer, and trusting that fallback here once made S³ declare LIVE 5s into a full RAAS staging phase because the round before it was Jensen's Range. When the real layer arrives mid-STAGING (`data.layer` was null, or S³ restarted), `resolveLayerInfo()` re-arms the timer against `lastNewGameAt`, so a late-identified seed round goes LIVE immediately rather than waiting out a second full duration.

**SquadJS events it subscribes to:** `NEW_GAME`, `ROUND_ENDED`, `UPDATED_LAYER_INFORMATION`, `UPDATED_SERVER_INFORMATION`, `UPDATED_PLAYER_INFORMATION`

**Public API:**

| Method | Returns | Notes |
|--------|---------|-------|
| `isReady()` | `boolean` | Mounted, timers initialised, layer resolved |
| `getPhase()` | `string` | `'STAGING'` / `'LIVE'` / `'ENDGAME'` (there is no `'RESOLVING'` phase — see `isResolving()`) |
| `isStaging()` | `boolean` | Phase === `'STAGING'` |
| `isLive()` | `boolean` | Phase === `'LIVE'` |
| `isEnding()` | `boolean` | Phase === `'ENDGAME'` |
| `isResolving()` | `boolean` | Team data not yet trusted for this round — **any phase**, not just STAGING. Don't act on team IDs while true |
| `getGamemode()` | `string\|null` | Inferred game mode (e.g. `'AAS'`, `'RAAS'`, `'Seed'`) |
| `getLayerName()` | `string\|null` | Raw layer name (e.g. `'Sumari AAS v1'`) |
| `isLayerResolved()` | `boolean` | `false` while the two getters above are returning the `'Unknown'` placeholder — use it before trusting a negative `isIgnoredMode()` / `isSeedMode()` |
| `refreshLayer(source?)` | `Promise<boolean>` | Forces `server.updateServerInformation()` (5s cap) and re-resolves, instead of waiting out SquadJS's ~30s poll |
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
| `onGamePhaseChange(callback)` | `Function` (unsubscribe) | Callback: `({ phase, prevPhase, subPhase, roundStartTime, matchId, layer }) => {}` |
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
| `getSquads()` | `object[]` | Squad list from registry — `{ squadID, teamID, squadName, locked, players }`, leaders first. Membership is keyed by team **and** squad number, since squad numbers restart per team. |
| `areTeamsResolved()` | `boolean` | All players on valid teams (1 or 2) |
| `getEffectiveRefreshIntervalMs()` | `number\|null` | Actual registry refresh cadence — `clamp(fastest registrant, 3s, 60s)`. Measure any "wait for team data" budget in these |
| `recordMove(eosID, teamID, source, options?)` | `void` | Record attribution for team change |
| `canAct(eosID, source)` | `boolean` | Check if player can be acted upon (not locked by another plugin) |
| `lock(eosID, source, ttlMs?)` | `boolean` | Acquire per-player lock (returns false if already locked by higher priority) |
| `unlock(eosID, source)` | `boolean` | Release per-player lock (returns false if no lock or wrong source) |
| `lockGlobal(source, ttlMs?)` | `boolean` | Acquire global lock (returns false if already held by higher priority) |
| `unlockGlobal(source)` | `boolean` | Release global lock (returns false if not held) |
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

`name`, `teamID`, `squadID` and `isLeader` are refreshed from `server.players`
on every `UPDATED_PLAYER_INFORMATION` tick, so `isLeader` reflects the player's
leadership *now* — promotions and handovers both land on the next tick. Sources
that carry no leadership field (the `PLAYER_CONNECTED` payload) leave the flag
alone rather than clearing it. `getSquads()` uses this to order each squad's
`players` array leaders-first.

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
| `explainClanGroups(players, opts?)` | `{groups, trace, options}` | Same pipeline as `extractClanGroups()`, plus a trace of every exclusion and merge. Diagnostic only — grouping consumers should call `extractClanGroups()`. |
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

**Lifecycle:** Polling is gated on `gameState.resolving`, **not** round phase. On `NEW_GAME`, `resolving` goes true and polling stops — player roles may still carry stale data from the previous round. Once all players have valid team IDs, `resolving` clears and polling starts, in whatever phase that happens to be. Once both teams are identified, polling stops until the next `NEW_GAME`.

> This gate is why `resolving` had to stop being clamped to STAGING. Seed rounds go LIVE 5s after `NEW_GAME`, and the staging timer used to force `resolving = false` on the way — before the first ~20s player tick. Faction polling therefore started while roles could still be the previous round's, and since polling stops for good once both teams are cached, a bad early read would stick for the whole round.

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
- `prevPhase` correctly reflects the phase being transitioned *from* — all call sites now capture the prior phase before mutating `this.phase`. This was fixed in the source (2026-08-03); earlier code had a bug where `payload.prevPhase` always equalled `payload.phase`.
- `onLayerGameModeChange` captures previous values before resolving and includes them in the payload correctly.

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
| `UPDATED_LAYER_INFORMATION` | gameState | Layer poll completed — **carries no layer**; used only for recovery-timing checks (see §7.11) |
| `UPDATED_SERVER_INFORMATION` | gameState | Server info updated — `info.currentLayer` is S³'s **sole** layer resolution path |
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
| **Per-player lock** | `lock()` / `unlock()` | SmartAssign (during active moves) | Blocks `canAct()` for a specific player; acquired before RCON move, released on success/failure/disconnect |
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

#### Per-Player Lock (SmartAssign)

SmartAssign acquires a per-player lock via `players.lock(playerKey, 'SmartAssign', 5000)` before queueing each RCON move (inside the swap executor's `processRetries()`). This sets a per-player lock that Switch's `canAct()` gate detects, causing Switch to deny `!switch` requests for that player during SA's move window (typically 3–6 seconds).

The lock is released in three places:
- **Move success** (`onMoveSuccess`): released after the move is verified
- **Move failure** (`onMoveFailure`): released when the move is abandoned (max retries exhausted, or preempted)
- **Player disconnect** (`onPlayerDisconnect`): cleaned up if the player leaves while a move is pending

If the lock cannot be acquired (e.g., a higher-priority actor like TeamBalancer already holds a lock), SA aborts the move and rolls back pending assignment counters.

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

### 7.10 — Unquoted camelCase Identifiers in Raw SQL

This one is invisible on SQLite and MySQL and fatal on Postgres, so it survives review and testing indefinitely.

Postgres folds unquoted identifiers to lower case. Sequelize creates camelCase columns **quoted**, so an unquoted reference resolves to a name that does not exist:

```js
// ❌ ANTI-PATTERN — errors on Postgres with: column "tokenbalance" does not exist
await PlayerCooldowns.update(
  { tokenBalance: Sequelize.literal('tokenBalance + 1') },
  { where: { eosID } }
);

// ❌ ANTI-PATTERN — creates s3_playerreconnects(eosid, updatedat) on Postgres,
//    which the Sequelize model (tableName: 'S3_PlayerReconnects') cannot address
await connector.query(`
  CREATE TABLE IF NOT EXISTS S3_PlayerReconnects (
    eosID VARCHAR(64) PRIMARY KEY,
    updatedAt BIGINT NOT NULL
  );
`);
```

**Fix:**

```js
// ✅ CORRECT — portable atomic increment
await PlayerCooldowns.update(
  { tokenBalance: this._s3db.incrementLiteral('tokenBalance', 1) },
  { where: { eosID } }
);

// ✅ CORRECT — quoted DDL
const q = (id) => dbService.quoteIdentifier(id);
await connector.query(`
  CREATE TABLE IF NOT EXISTS ${q('S3_PlayerReconnects')} (
    ${q('eosID')} VARCHAR(64) PRIMARY KEY,
    ${q('updatedAt')} BIGINT NOT NULL
  );
`);
```

**The diagnostic rule:** a raw SQL fragment is Postgres-safe only if every identifier it names is already all-lowercase. EloTracker's `(mu - (3.0 * sigma))` literals are fine for exactly that reason — folding is a no-op on them.

Two related traps in the same family:

- **`LIKE` is case-sensitive on Postgres.** SQLite's `LIKE` is case-insensitive for ASCII and MySQL's default collation is case-insensitive, so a name lookup that works on both silently stops matching on Postgres. Use `caseInsensitiveLikeOp()`. Do **not** reach for `Op.iLike` directly — it is a syntax error on SQLite and MySQL.
- **`LIKE ... ESCAPE '\'` cannot be written portably.** MySQL processes backslash escapes inside string literals and the other two do not, so whichever spelling you pick is a hard error somewhere: `ESCAPE '\\'` fails on SQLite with *"ESCAPE expression must be a single character"*. Use `caseInsensitiveLikeLiteral()`, which escapes with `!` instead.

Regression cover for all of this lives in `s3/testing/test-dialect-portability.js`, which runs each statement against real SQLite, MySQL and Postgres engines. A mock cannot catch this class of defect — it has no dialect to model.

### 7.11 — Reading `server.currentLayer` Instead of S³

```js
// ❌ ANTI-PATTERN — silently empty after a mid-round SquadJS restart
const layer = this.server.currentLayer?.name || 'Unknown';
const mode  = this.server.currentLayer?.gamemode || '';
if (ignoredModes.some(m => layer.toLowerCase().includes(m))) return;

// ✅ CORRECT — S³ GameStateService is the single resolver
const gs = this._s3?.gameState;
if (gs?.isIgnoredMode?.()) return;
const layer = gs?.getLayerName?.() ?? 'Unknown';
```

**Why it fails:** SquadJS never repopulates `server.currentLayer` from RCON when a plugin mounts mid-round (4.2.0 behaviour), and it can read the literal string `"Unknown"` during a restart. The failure is silent in the worst way: the layer string comes out empty, every `includes()` test against it returns `false`, and a gate meant to *skip* seed/training layers instead lets everything through until the next map roll.

**The event trap behind it:** `UPDATED_LAYER_INFORMATION` announces "layer info updated" but carries **no payload** — SquadJS's own docs tell consumers to read `server.currentLayer`, which that event does not populate. The layer actually arrives on `UPDATED_SERVER_INFORMATION` as `info.currentLayer`. S³ handles this asymmetry in one place: `handleServerInfoUpdated()` is the sole resolution path, `handleLayerInfoUpdated()` is deliberately neutered, and `mount()` bootstraps through `server.currentLayer` → forced `refreshLayer()` → `layerHistory[0]` so a restart resolves in seconds rather than waiting out the ~30s poll. Every one of those reads is validated — S³ never caches a layer named `"Unknown"` over a good one.

**Fix:** never read `server.currentLayer`, `server.layerHistory`, or `server.nextLayer` from a consumer plugin. Take `getLayerName()` / `getGamemode()` / `isIgnoredMode()` from `gameState`, subscribe to `onLayerGameModeChange()` if you need to react to changes, and check `isLayerResolved()` before trusting a *negative* answer from a layer-based gate.

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
   this.registerExpectedVersion('my-plugin', 3, {
     models: ['MyPlugin_Table']
   });
   ```
   The third `opts` argument is optional. When provided with a `models` array, it declares which models this plugin owns — used by drift detection to verify columns at runtime. Without it, drift detection still checks tables/columns declared in migration `touches`, but the explicit model list provides an additional cross-check.

2. **Register migration functions:**
   ```js
   this.registerMigrations('my-plugin', [
     { version: 1, description: 'Initial schema',
       touches: { creates: ['MyPlugin_Table'] },
       up: async (qi) => { await qi.createTable('MyPlugin_Table', { ... }); },
       down: async (qi) => { await qi.dropTable('MyPlugin_Table'); } },
     { version: 2, description: 'Add rating column',
       touches: { columns: { MyPlugin_Table: ['rating'] } },
       up: async (qi) => { await qi.addColumn('MyPlugin_Table', 'rating', 'INTEGER'); },
       down: async (qi) => { await qi.removeColumn('MyPlugin_Table', 'rating'); } },
     { version: 3, description: 'Add seed row to Settings table',
       touches: {
         rows: {
           MyPlugin_Settings: [{ key: 'key', value: 'someSetting' }]
         }
       },
       up: async (qi) => {
         const Settings = qi.db.getModel('MyPlugin_Settings');
         if (Settings) {
           await Settings.create(
             { key: 'someSetting', value: 'default' },
             { transaction: qi.transaction }
           );
         }
       },
       down: async (qi) => {
         const Settings = qi.db.getModel('MyPlugin_Settings');
         if (Settings) {
           await Settings.destroy(
             { where: { key: 'someSetting' }, transaction: qi.transaction }
           );
         }
       } }
   ]);
   ```
   Every migration **must** include a `touches` declaration or the engine throws on `registerMigrations()`. Use `touches: {}` for a migration that intentionally makes no schema changes (e.g. a pure data fixup). See [§9.1.1](#911--the-touches-declaration).

3. **Run pending migrations:**
   ```js
   await this.verifyAndRunMigrations('my-plugin');
   ```

#### 9.1.1 — The `touches` Declaration

Every migration **must** declare which tables, columns, seed rows, and data post-conditions it creates or modifies. This enables two verification layers:

- **Post-migration verification** — after each migration commits, `_verifyMigrationResult()` confirms every declared table/column/row actually exists in the live database, and that every declared data post-condition holds. Silent failures (e.g. `ADD COLUMN` that fails silently because the MySQL user lacks `ALTER` privileges) are caught immediately.
- **Ongoing drift detection** — on every S³ mount, the engine aggregates all `touches.rows` via `getExpectedRows()` and all `touches.data` via `getExpectedData()`, then re-checks both. This catches data loss across connector swaps, DB restores, or manual edits.

**Four sub-fields:**

| Field | Format | Purpose |
|-------|--------|---------|
| `creates` | `string[]` — table names that this migration creates | Post-migration verifier checks `showAllTables()` |
| `columns` | `Record<string, string[]>` — table name → column names added to *existing* tables | Post-migration verifier checks `describeTable()` for each column |
| `rows` | `Record<string, Array<{key: string, value: string}>>` — table name → seed row matchers. Each entry: `{ key: '<columnName>', value: '<expectedValue>' }` tells the verifier to find a row where `key` column equals `value` | Verified after migration commits, and on every S³ mount via drift detection |
| `data` | `Record<string, Array<{column: string, notNull: true}>>` — table name → post-conditions on column *values* | Verified after migration commits, and on every S³ mount via drift detection. See [§9.1.3](#913--data-post-conditions-touchesdata) |

**Examples:**

```js
// Create a new table — declare creates + any columns added to that table
{ version: 1,
  touches: {
    creates: ['SwitchPlugin_PlayerCooldowns', 'SwitchPlugin_Endmatches']
  },
  up: async (qi) => { /* createTable() */ },
  down: async (qi) => { /* dropTable() */ } }

// Add columns to an existing table — use columns only
{ version: 2,
  touches: {
    columns: {
      SwitchPlugin_PlayerCooldowns: ['tokenBalance', 'tokenRegenAnchor']
    }
  },
  up: async (qi) => { /* addColumn() */ },
  down: async (qi) => { /* removeColumn() */ } }

// Data-only migration with seed row — use rows
{ version: 3,
  description: 'Insert setting into SwitchPlugin_Settings',
  touches: {
    rows: {
      SwitchPlugin_Settings: [{ key: 'key', value: 'explainMessageId' }]
    }
  },
  up: async (qi) => { /* create row via model */ },
  down: async (qi) => { /* destroy row via model */ } }

// Migration that touches no schema (data fixup, index rename, etc.)
{ version: 4,
  description: 'Recalculate migrated data',
  touches: {},
  up: async (qi) => { /* no DDL changes */ },
  down: async (qi) => { /* no DDL changes */ } }
```

**Backward compatibility:** Existing migrations that predate the `touches` requirement (pre-v1.2.0) should have `touches` added retroactively when their plugin's migration file is next touched. The Switch plugin's migrations demonstrate this pattern — see `switch-db.js` v1 for a real-world example of retroactive `touches` on old migrations.

#### 9.1.2 — Seed Row Drift Detection (`touches.rows`)

The `rows` sub-field of `touches` enables **seed row drift detection**: the ability to detect when expected seed rows (system settings, configuration defaults, etc.) go missing from the database.

**How it works:**
1. When a migration declares `touches.rows`, the engine verifies those rows exist **immediately after the migration commits** (in `_verifyMigrationResult()`).
2. On every S³ mount, `DBService` calls `migrationEngine.getExpectedRows()` to aggregate all `touches.rows` declarations across all plugins.
3. Each expected row is checked against the live database — if a row is missing, it's reported as drift alongside missing columns.

**When to use `touches.rows`:**

- Seed rows inserted at migration time (e.g. `SwitchPlugin_Settings` with `timeLimitEnabled` and `explainMessageId`)
- Default configuration rows that should always exist
- Any row whose absence would indicate silent data loss from a connector swap, manual DB edit, or failed restore

**Format:**
```js
touches: {
  rows: {
    TableName: [
      // Each entry: find a row WHERE keyColumn = expectedValue
      { key: '<columnNameToMatch>', value: '<expectedValue>' }
    ]
  }
}
```

The `key`/`value` pair is used as a `WHERE` clause: `model.findOne({ where: { [key]: value } })`. Multiple pairs = multiple independent rows expected in the table.

#### 9.1.3 — Data Post-Conditions (`touches.data`)

`creates`, `columns` and `rows` all answer *does this thing exist*. None of them answer *did the value actually get written*. `touches.data` closes that gap.

**The failure this exists for.** A migration that adds a column and backfills it can have the backfill do nothing — no rows matched, an early `return`, a guard that skipped the branch — and every existence check still passes. The engine records the version, everything reports green, and the column is empty. This is what shipped as Switch v5 (2026-08-18).

It bites hardest on the servers least able to notice it. A DB user without an `ALTER` grant has its schema applied **by hand**, so by the time `up()` runs the DDL is already satisfied and the data step is the only part the engine actually executes. A silent no-op there is invisible by construction.

**Format:**
```js
touches: {
  columns: { SwitchPlugin_PlayerCooldowns: ['lastActiveTimestamp'] },
  data: {
    SwitchPlugin_PlayerCooldowns: [{ column: 'lastActiveTimestamp', notNull: true }]
  }
}
```

**How it works:**
1. After the migration commits, `_verifyMigrationResult()` runs one `count()` per declaration. Any offending rows produce a composite failure, the error names the count, and **the version is not recorded** — so the next mount sees a pending migration and re-applies the (idempotent) `up()`.
2. On every S³ mount, `DBService.verifyLiveSchema()` re-checks the same assertion via `getExpectedData()`. A violation is reported as `dataViolations` drift, which is treated exactly like a missing column: the plugin's recorded version is rolled back, the migration gate re-opens, and the admin is prompted to run `!s3 migrate force`.

**The vocabulary is deliberately one word long.** `notNull: true` is the only predicate. Every predicate added is another thing that can be subtly wrong in a way nobody tests, and a rich assertion DSL becomes a second, worse migration language. Add `equals` only when a real case demands it — an unknown key is rejected at registration rather than silently ignored, so a typo cannot pass.

> ⚠️ **Only declare a predicate that holds for the lifetime of the table.**
>
> This is re-checked on *every mount*, not just after the migration. If any code path can legitimately write NULL to that column *after* the migration has run, it is not an invariant, and asserting it as one puts the plugin into a rollback-and-re-gate loop on every mount, forever.
>
> Before declaring `notNull`, find every write path to that column and confirm each one populates it. Switch v5 qualifies only because connect, disconnect, all three queue token spends, the admin commands, and the scramble-lockdown `bulkCreate` all stamp `lastActiveTimestamp` — the last of which had to be **fixed** to make the declaration true.

**When there is no invariant.** Declare it explicitly:

```js
touches: { data: { MyPlugin_Table: [] } }
```

An empty array asserts nothing and contributes nothing to drift detection. It exists so "I considered this and there is no invariant" is distinguishable from "I forgot" — the conformance harness (`s3/testing/test-migration-conformance.js`) **fails** any migration whose `up()` calls `qi.bulkUpdate` without declaring `touches.data` either way. `bulkInsert` is exempt (its rows are covered by `touches.rows`) and so is `bulkDelete` (a deletion leaves no value to assert).

That check is a source scan, so it is honest about its limits: it sees `qi.*` calls only. A migration that reaches a model through `qi.db.getModel()` and calls `.update()` on it is invisible to it. It catches the shape that actually shipped broken, not every possible one.

**Tests:** `s3/testing/test-migration-data-assertions.js` covers registration validation, the post-commit failure, the hand-migrated state, the drift path, and the rollback — on SQLite, MySQL and Postgres. It includes a control case asserting that the *same* no-op backfill passes silently when nothing is declared, so the mechanism cannot pass vacuously.

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
| `describeTable(table)` | `(string) => Promise<object>` | Column map for a table |
| `bulkInsert(table, rows, opts?)` | `(string, object[], object?) => Promise` | Insert rows |
| `bulkUpdate(table, values, where?, opts?)` | `(string, object, object?, object?) => Promise` | Set-wide UPDATE (backfills) |
| `bulkDelete(table, where?, opts?)` | `(string, object?, object?) => Promise` | Set-wide DELETE |
| `rawQuery(sql, replacements?)` | `(string, object?) => Promise<*>` | Execute raw SQL |
| `sequelize` | property | Direct Sequelize access |
| `db` | property | DBService instance |
| `transaction` | property | Active Sequelize transaction |
| `DataTypes` | property | Sequelize DataTypes for column defs |

Each `qi` method above is already bound to the migration's transaction, so pass options only for the operation itself. `qi.transaction` is exposed for model calls, which do need it explicitly.

> **Best practice — use model-based access for row-level DML in migrations.** For single-row work (inserts, upserts, destroys) inside migration `up()`/`down()` handlers, use `qi.db.getModel('ModelName')` and call `create()`/`upsert()`/`destroy()` on it. Sequelize then handles identifier quoting (backticks for MySQL, double quotes for PostgreSQL) and type coercion for you. See Switch migration v4 (`switch-db.js`) for a real-world example of model-based seed row insertion.
>
> For **set-wide** work — backfilling a column across every row — use `qi.bulkUpdate()`. It resolves the registered model's attribute types automatically, which matters more than it looks: Sequelize's low-level bulk API escapes values by their JS shape when it has no types, and on SQLite a `Date` then lands in the column as an **integer epoch** rather than the TEXT that `DataTypes.DATE` reads back. Every subsequent read of that row dies with `date.includes is not a function`. MySQL and Postgres escape a `Date` to a datetime literal either way, so this reaches production on SQLite deployments only. If you bypass the wrapper and call `qi.sequelize.getQueryInterface().bulkUpdate()` directly, you must pass `model.rawAttributes` as the fifth argument yourself.

> **Write backfills so they survive a re-run.** Do not nest a backfill inside the `if (!columns.x)` guard that adds the column — the column existing does not prove the data step ran. A DB whose user lacks `ALTER` privileges gets its DDL applied by hand, and an attempt that failed after the `ALTER` leaves the same state: column present, every row NULL. Match on `{ col: { [Op.is]: null } }` instead, outside the guard, so `!s3 migrate force` repairs those rows and leaves rows stamped by live gameplay untouched. `Op.is` generates a real `IS NULL`; a bare `col: null` in a raw where-clause can become the `= NULL` that matches nothing. Switch migration v5 is the reference implementation, and `s3/testing/test-migration-bulk-types.js` locks both behaviours down against real engines.

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

**Post-migration verification:** After each migration's `up()` commits, the engine calls `_verifyMigrationResult()` with a fresh (non-transactional) `qi` to check that every table, column, and row declared in the migration's `touches` actually exists in the live database, and that every `touches.data` post-condition holds. This catches silent failures — such as `ADD COLUMN` that appears to succeed but doesn't take effect because the MySQL user lacks `ALTER` privileges, or a backfill that matched no rows — before the next migration runs. Verification failures produce a composite error listing everything that is missing or unpopulated, and the migration batch is aborted without recording the version.

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

### 9.8 — Runtime Schema-Drift Verification

S³ provides two Discord commands for live schema verification that complement the `touches` system described in §9.1.1:

#### `!s3 migrate verify`

Checks the live database for schema drift — columns and seed rows declared in migration `touches` that are missing from the actual database tables. This catches silent data loss or structure drift that occurs between SquadJS restarts (e.g., from a manual DB edit, connector swap, or failed restore).

The verification runs automatically on every S³ mount (after all consumer plugins register their models) and on demand via `!s3 migrate verify`. Results include:
- Whether the schema is up to date
- A list of missing tables or columns (when `touches.creates` / `touches.columns` declarations don't match the live schema)
- A list of missing seed rows (when `touches.rows` declarations don't match)
- A list of unpopulated columns with offending row counts (when `touches.data` post-conditions no longer hold)
- Remediation suggestions

#### `!s3 diag`

A consolidated read‑only diagnostic command that surfaces:
- Service mount status
- Current game phase, layer, and gamemode
- Faction abbreviations
- Player count and lock state
- **Schema drift status** (same data as `!s3 migrate verify`, folded into the single output)

#### When to Use

| Scenario | Command |
|----------|---------|
| Periodic health check during operation | `!s3 diag` |
| Investigate reported DB issues | `!s3 migrate verify` |
| After a DB restore or connector change | `!s3 migrate verify` |
| Pre‑upgrade schema check | `!s3 migrate verify` |

Both commands require S³'s Discord admin channel to be configured (`channelID` in config).

### 9.9 — Failure Diagnostics on stderr

SquadJS's `Logger` writes everything to stdout. Operators who split the streams —

```bash
node index.js > squadjs.log 2> squadjs.err
```

— therefore saw an empty error file no matter what broke. S³ mirrors its operational failures to **fd 2** so they land in `squadjs.err`:

| Event | Level | Scope |
|-------|-------|-------|
| A migration's `up()` throws | `ERROR` | `MigrationEngine` |
| Pre-migration backup fails (migration aborted) | `ERROR` | `MigrationEngine` |
| Schema drift with missing columns or rows | `WARN` | `SchemaDrift` |
| `_withDb()` transaction fails | `ERROR` | `<Plugin>:DB` |
| A plugin's command/event handler catch-all | `ERROR` | `<Plugin>:Commands` |
| Discord channel fetch or message send fails | `ERROR` | `<Plugin>:Discord` |

```
[2026-08-19T01:57:49.856Z] [S3] [ERROR] [MigrationEngine] "switch" v4 -> v5 failed: qi.bulkUpdate is not a function
    TypeError: qi.bulkUpdate is not a function
    at Object.up (file:///.../switch/utils/switch-db.js:387:22)
    at file:///.../s3/utils/migration-engine.js:608:29
```

The fixed prefix is the point: `grep '\[S3\] \[ERROR\]' squadjs.err` returns S³ events and nothing else. The block also carries the **stack**, which the Discord embed does not — the embed renders `err.message` only, so the failing migration file was previously unidentifiable from Discord alone.

**Reporting from a consumer plugin.** `S3PluginBase.reportError(scope, summary, err, options?)` logs at verbose level 1 *and* mirrors to stderr — use it in place of a bare `this.verbose(1, ...)` for a caught error an operator would want to find afterwards. Pass `{ includeStackInLog: true }` at sites that already logged the stack to stdout, so nothing a stdout-only reader used to see disappears. Services that aren't plugins take an injected reporter instead (see `EloDatabase`, whose owning plugin assigns `db.reportError`), which keeps consumer utils from importing S³ internals — `install.cjs` flattens every plugin's `utils/` into one directory, so a cross-plugin relative import that resolves in `out/` will not resolve in this source tree.

Do **not** route expected conditions or retry-and-recover paths through it. Elo's `_withDb` deliberately skips lock-contention errors: they are normal under concurrency and already retried, so mirroring them would fill the error file with noise the operator can do nothing about.

**Configuration.**

| Option | Default | Effect |
|--------|---------|--------|
| `stderrDiagnostics` | `'off'` | `'off'` = stdout only, identical to pre-1.3.0; `'mirror'` = always copy to stderr; `'auto'` = copy unless fd 1 and fd 2 share a destination |
| `stderrDedupeWindowSeconds` | `60` | Identical events inside the window are counted, not written |

**The default is `'off'`, and that is the point.** Installing or upgrading S³ must not change what appears in anyone's logs. This channel only helps an operator who has already separated their streams — and separating them is a deliberate act, done by someone who will also read a config option. Defaulting to on would have handed duplicated lines to console users and Docker/journald users, and moved errors into a new file for pm2 users, none of whom asked for anything.

`'auto'` exists for a config shared between a console session and a redirected service: it calls `fstat` on fd 1 and fd 2 and suppresses the copy when dev/inode/rdev match, covering a shared file and a shared console device. It cannot see Docker's default log driver or systemd/journald, which hand the process two distinct pipes and merge them downstream — under those, `'auto'` behaves as `'mirror'` and you get doubles.

**Flood control.** Migration failures happen once per restart; runtime errors do not. When the DB goes away, `_withDb` throws every tick, and an unthrottled mirror turns an outage into an error file that fills the disk — a worse failure than the one being reported. Identical events are therefore deduplicated by fingerprint:

```
[...] [S3] [ERROR] [Switch:DB] Error in _withDb: SQLITE_ERROR: no such column: lastActiveTimestamp
[...] [S3] [ERROR] [Switch:DB] (suppressed 499 identical event(s) over 60s) Error in _withDb: SQLITE_ERROR: ...
```

Digit and hex runs are normalised out of the fingerprint, so the same failure for a thousand different players collapses to one entry rather than a thousand. Distinct failures never merge. No timers are involved — a pending tally is flushed by the next event of any kind, and by `flushStderrDiagnostics()` on S³ unmount, so a burst that stops entirely still reports its final count. The stdout log is untouched by any of this: it keeps every occurrence, in sequence.

Three rules for anything added here:

- **Mirror, never replace.** `stderrError()` sits alongside the existing `verbose()` call and Discord embed; it does not swallow the error, and the engine still re-throws so every caller's handling is unchanged.
- **Write, don't throw.** The literal request was to "throw it so the OS picks it up". An uncaught throw in a plugin takes the server down or becomes an unhandled rejection — writing to fd 2 is what actually reaches `2>` redirection while leaving the server running.
- **Stay quiet when nothing is wrong.** A successful migration writes nothing to stderr, and extra-column drift (informational) is deliberately excluded — it would otherwise append to the error file on every mount.

Helpers live in `s3/utils/s3-stderr.js` (`stderrError`, `stderrWarn`); `s3/testing/test-stderr-diagnostics.js` asserts the separation from child processes, since an in-process spy proves only that the function was called.

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
| `!s3 players` | Population overview embed + one embed per team, broken down by squad with squad leaders marked (👑), squad locks, per-player locks, and an "Unassigned" (not in a squad) bucket |
| `!s3 clans` | Active clan groups, plus a second embed explaining every exclusion (size bounds, `ignoreList`, unnormalizable tag) and every Levenshtein merge and recruit-suffix strip |
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
| `test-dialect-portability.js` | Raw SQL against **real** SQLite/MySQL/Postgres engines — see 11.4 |
| `test-migration-bulk-types.js` | `qi.bulkInsert`/`bulkUpdate` value typing and NULL backfills, real engines — see 11.4 |
| `test-stderr-diagnostics.js` | Migration failures and drift reach fd 2, not stdout — see 9.9 |
| `test-migration-permissions.js` | Migration DDL at three permission tiers, per dialect (Docker-gated) |

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

### 11.4 — Testing Raw SQL: Mocks Are Not Enough

Mocks cannot model dialect behaviour — that is a property of the engine, not of the code. Identifier folding, collation, and `ESCAPE` parsing simply do not exist in a hand-written mock, so a mock suite will report green while the statement is broken on a real database. Every defect in `docs/TASK_POSTGRES_PORTABILITY.md` passed the mock suite for its entire lifetime, and one of them (`ESCAPE '\\'` in EloTracker's name search) was broken on **SQLite** — the primary deployment target — the whole time.

**If you touch raw SQL, run it against a real engine.** `s3/testing/test-dialect-portability.js` is set up for this: SQLite runs in-memory with no setup, and MySQL/Postgres skip gracefully when unreachable.

```bash
# Start the engines (ports match test-migration-permissions.js)
docker run -d --name s3-test-postgres -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16-alpine
docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root -p 3307:3306 mysql:8

node s3/testing/test-dialect-portability.js
node s3/testing/test-migration-bulk-types.js

docker rm -f s3-test-postgres s3-test-mysql
```

The same rule covers **values**, not just identifiers. SQLite columns are typeless, so a mis-serialized value is accepted on write and only explodes on read — the Switch v5 backfill (2026-08-18) wrote `lastActiveTimestamp` as an integer epoch through Sequelize's untyped bulk API and every later `findByPk` died with `date.includes is not a function`, on SQLite alone. `test-migration-bulk-types.js` asserts the stored `typeof()` directly, which is the only way to see that failure before a player does.

Two conventions worth copying from that file:

- **Pin the defect, not just the fix.** Each fix has a companion test asserting the *old* form still fails on Postgres and still passes on SQLite/MySQL. That documents why the bug was invisible and fails loudly if an assumption changes.
- **Assert backward compatibility explicitly.** When changing emitted SQL, prove the new statement still works against data an older build created — otherwise the fix is an upgrade hazard for live servers.

> `sqlite3` will not install in the stock `node:*-slim` images (the prebuilt binding needs a newer glibc than they ship). Run the tests on the host, or build `sqlite3` from source in the container.

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

> *Developer Guide — documents the S³ architecture as of 2026-08-12.*
