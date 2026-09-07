# S³ Developer Guide

> **Canonical reference for building SquadJS plugins that consume S³ (Slacker's Squad Services).**
>
> **Last reviewed:** 2026-08-20, verified against source.

---

## Table of Contents

1. [Overview — What is S³?](#1--overview--what-is-s)
2. [Service Catalog](#2--service-catalog)
3. [Access Patterns & Discovery](#3--access-patterns--discovery)
4. [Subscription Callbacks](#4--subscription-callbacks)
5. [Event Model](#5--event-model)
6. [Integration Checklist](#6--integration-checklist)
7. [Anti-Patterns](#7--anti-patterns)
8. [S³ Plugin Base Class Guide](#8--s-plugin-base-class-guide)
9. [Migration Workflow Guide](#9--migration-workflow-guide)
10. [Discord Commands & Backup/Import](#10--discord-commands--backupimport)
11. [Testing Patterns](#11--testing-patterns)
12. [Deployment & Configuration](#12--deployment--configuration)

**Appendices:**
- [A — Service Readiness Summary](#a-service-readiness-summary)
- [B — Quick Reference — S³ Access Templates](#b-quick-reference--s-access-templates)
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

Consumer plugins discover S³ at runtime and access services through **flat getters** guarded by `isReady()` checks. `S3PluginBase` and `S3DiscordPluginBase` are optional base classes that automate discovery, readiness gating, database boilerplate, and team-change RCON retry, eliminating ~50 lines of repetitive mount() logic per plugin. See [§8](#8--s-plugin-base-class-guide).

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
| `executeWithRetry(fn, opts?)` | `(Function, object?) => Promise<*>` | Function result | With retry + jitter (all connectors). `opts.totalTimeoutMs` — see note below |
| `withTransaction(fn)` | `(Function) => Promise<*>` | Function result | Within a Sequelize transaction |
| `withTransactionWithRetry(fn, opts?)` | `(Function, object?) => Promise<*>` | Function result | Transaction + retry combined. `opts.totalTimeoutMs` — see note below |
| `getDatabasePath()` | `() => string\|null` | File path or null | SQLite only |
| `models` | property | `object` | All defined models, keyed by name. Direct property, not a getter method. |

**Export tier & drift** — see §10.2 and §9.8.

| Method | Signature | Returns | Notes |
|--------|-----------|---------|-------|
| `getModelTier(name)` | `(string) => string\|null` | Declared tier | `null` if the model declared none |
| `getEffectiveModelTier(name)` | `(string) => string` | Declared tier, or the default | What the exporter actually reads |
| `getModelsByTier(tier)` | `(string) => string[]` | Model names in that tier | Effective tiers, so undeclared models appear under the default |
| `getUndeclaredModelNames()` | `() => string[]` | Models with no `exportTier` | Each also warned by name at mount |
| `verifyLiveSchema()` | `() => Promise<Array>` | Drift entries (empty = clean) | Runs the live check **and** refreshes the `getLastDriftResult()` cache |
| `getLastDriftResult()` | `() => Array\|null` | Last drift result | Cached — `null` until the first check. `!s3 diag` reads this |

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

> **`totalTimeoutMs` (opt-in, default: no cap):** bounds the whole retry loop's wall-clock
> time, not each attempt — a single attempt's own timeout (e.g. Sequelize's connection-pool
> `acquire` timeout, commonly 60s and configured outside this repo) can itself run long
> under pool exhaustion, and 5 retries at that cost compound to minutes. Pass it on any
> call sitting on a hot path where a caller must not be blocked for that long (e.g. a
> round-end handler another plugin's scramble/trigger decision depends on). The abandoned
> attempt keeps running in the background after the budget trips — it isn't cancelled,
> so a slow-but-eventually-successful write can still land after the caller has already
> moved on with `null`. A budget-exceeded rejection is classified as a network error, so
> it engages the same `_networkErrorBackoffMs` (30s default) as a real connection failure
> — since that backoff lives on the shared `DBService` instance, tripping the budget once
> pauses *every* plugin's DB calls on that connector for the cooldown window, not just the
> caller that opted in. Pick a value comfortably above normal-load latency for that call.
>
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

**STAGING duration:** SquadJS gives no "match started" event, so STAGING → LIVE is a timer, and its length is a **property of the gamemode, not a config option** — there is no config key for it. The value comes from a measured per-gamemode table (RAAS/AAS 250s, Invasion and Territory Control 300s; anything unmeasured falls back rather than being guessed at), keyed on the short mode key rather than the spelled-out mode name, so a mode SquadJS writes out in full still matches its table entry. Or **5s on seed/training layers**, which have no real staging phase and would otherwise sit in STAGING forever (a seed round never fires another `NEW_GAME`). The shortcut applies **only when the layer was resolved for the current round** — `getLayerName()` falls back to the previous round's layer, and trusting that fallback here once made S³ declare LIVE 5s into a full RAAS staging phase because the round before it was Jensen's Range. When the real layer arrives mid-STAGING (`data.layer` was null, or S³ restarted), `resolveLayerInfo()` re-arms the timer against `lastNewGameAt`, so a late-identified seed round goes LIVE immediately rather than waiting out a second full duration.

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
| `getGamemode()` | `string\|null` | The game mode as SquadJS spells it (e.g. `'AAS'`, `'RAAS'`, `'Seed'`, `'Territory Control'`). Use for display, storage and operator-configured needles |
| `getGamemodeKey()` | `string\|null` | The same mode as a short, stable key (`'TC'` for Territory Control). **Branch and key lookup tables on this**, not on `getGamemode()` — same canonical/display split as the two layer getters below |
| `getLayerName()` | `string\|null` | **Canonical** layer name — the SquadJS classname (e.g. `'Sumari_Seed_v1'`). Use for storage and comparisons; see §7.12 |
| `getLayerDisplayName()` | `string\|null` | The same layer as a human reads it (e.g. `'Sumari Bala Seed v1'`). Falls back to the canonical name |
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
| `onLayerGameModeChange(callback)` | `Function` (unsubscribe) | Callback: `({ layerName, layerDisplayName, gameMode, gameModeKey, prevLayer, prevGameMode }) => {}` — **one object argument**, not several positional ones |
| `onResolvingChange(callback)` | `Function` (unsubscribe) | Callback: `({ resolving, reason, durationMs, phase, matchId, layer }) => {}`. `reason` is one of `PLAYERS_RESOLVED` / `ROSTER_FALLBACK` / `BUDGET_EXPIRED` / `ROUND_ENDED` / `RECOVERY_STALE` / `RECOVERY_INVALIDATED`; `durationMs` measures from `lastNewGameAt` |

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
| `areTeamsResolved()` | `boolean` | All players on valid teams (1 or 2), ignoring stuck clients |
| `getStuckPlayerKeys()` | `Set<string>` | Players wedged at teamID N/A, excluded from the gate above |
| `isPlayerStuck(key)` | `boolean` | Whether one player is currently quarantined |
| `getEffectiveRefreshIntervalMs()` | `number\|null` | Actual registry refresh cadence — `clamp(fastest registrant, 3s, 60s)`. Measure any "wait for team data" budget in these |
| `recordMove(eosID, teamID, source, options?)` | `boolean` | Record attribution for team change. Returns `false` only when the identifier is unusable — it does **not** check `isReady()` |
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
| `damerauLevenshteinDistance(a, b)` | `number` | Edit distance for fuzzy matching (adjacent-character transposition counts as 1 edit, not 2) |
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
| `getFactionId(faction)` | `number\|null` | Reverse of `getTeamName()`: maps a faction abbreviation (`'US'`, case-insensitive) **or** a team number to its teamID (`1`/`2`). Falls back to scanning live player role strings when the abbreviation is not yet cached. Returns `null` if unresolvable |
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
| `getServerName()` | `string\|null` | Server.cfg `ServerName`. Available at mount, before RCON fills `server.serverName` |
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

**With base class:** If using `S3PluginBase`, discovery is handled automatically by `_resolveS3()` in `prepareToMount()`. See [§8](#8--s-plugin-base-class-guide).

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

Unmount order is **not** the exact reverse. It runs:

```
logging  →  players  →  clans  →  db  →  factions  →  gameState  →  serverConfig
```

`db` tears down fourth rather than sixth. Nothing depends on that today —
`gameState.unmount()` only clears timers, and `db.unmount()` drops the migration
engine without closing the Sequelize connection — but **do not add a database
write to `factions`, `gameState` or `serverConfig` teardown** on the assumption
that `db` is still mounted. If you need one, move the `db` unmount to last first.

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
| `onLayerGameModeChange(cb)` | End of `resolveLayerInfo()` when layer/game mode changed | `{ layerName, layerDisplayName, gameMode, gameModeKey, prevLayer, prevGameMode }` |
| `onResolvingChange(cb)` | `resolving` is set at `NEW_GAME` or cleared by `_clearResolving()` | `{ resolving, reason, durationMs, phase, matchId, layer }` |

**Notes:**
- **Every one of these callbacks receives a single object.** None of them are positional. A subscriber written as `(layer, gamemode) => …` binds `layer` to the whole payload and `gamemode` to `undefined`, and nothing throws.
- `onGamePhaseChange` fires on every phase transition including ENDGAME sub-state changes (scoreboard → layerVote → factionVoteTeam1 → factionVoteTeam2 → postVoting).
- `onResolvingChange` is the subscription to use when your plugin must wait for trustworthy team data. `reason` distinguishes the healthy exit (`PLAYERS_RESOLVED`) from the timeout (`BUDGET_EXPIRED`) — which matters, because a consumer that treats a budget expiry as "teams are ready" is acting on the data the flag exists to distrust.
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

### 6.7 — Multi-Server Scoping

Skip none of these on the grounds that you only run one server. Every item is inert with one server registered, and each one is silent rather than loud when it is wrong.

- [ ] Every model declares `scopeKind` at `defineModel()` — `'server-column'`, `'server-key'` or `'global'`. There is no default worth guessing
- [ ] A `server-column` model has a `serverID` column, and every write stamps it
- [ ] Every read of a scoped table carries the scope in its `where` clause (see 7.13)
- [ ] A `server-key` singleton keys on the server id itself and has no `serverID` column, so a scope check written against the columns reads it as community-wide
- [ ] Index names are prefixed with the table name — MySQL folds table names on some installs but never index names, so two tables sharing a bare index name collide
- [ ] Discord handlers call `routeDiscordCommand()` between the channel check and the verb dispatch, with the right `COMMAND_SCOPE` (see 8.2.2)
- [ ] Mutations arm through `armConfirmation()` and execute through `takeConfirmation()`, so the process that minted a token is the process that acts on it (see 8.2.3)
- [ ] Any option that steers a shared table is listed in `COMMUNITY_OPTION_GROUPS` and read through the accessor for its kind (see 8.2.4)
- [ ] Read-modify-write against a community-wide row takes a row lock, and a locked read over several rows is ordered so two overlapping sets queue rather than deadlock
- [ ] The plugin's S³ version floor is checked at mount. Against an older S³ the multi-server calls do not fail loudly: `getServerID` resolves to null or 1, so rows are stamped for nobody or for everybody

### 6.8 — Discarded / Legacy (Do Not Use)

- [ ] ❌ `this.roundStartTime` — use `gameState.getRoundStartTime()`
- [ ] ❌ `this.matchId` — use `gameState.getMatchId()`
- [ ] ❌ Self-managed clan cache — use `clans` service
- [ ] ❌ `this._s3?.services?.anything` — use flat getters

### 6.9 — Documentation

- [ ] Plugin top comment includes an `S³ INTEGRATION` section
- [ ] JSDoc accurately describes guard logic (not stale — verify actual code matches the doc)
- [ ] README mentions S³ integration (if applicable)
- [ ] Plugin top comment says which of its tables are per-server and which are the community's, and what an older S³ would do to them

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

**Fix:** Let the callee handle it:

```js
// ✅ ACCEPTABLE — recordMove is null-safe and cannot throw
this._s3?.players?.recordMove(playerKey, team, 'SmartAssign');
```

Be precise about what "already guards" means here: `recordMove()` validates the
identifier and returns `false` if it is unusable. It does **not** check
`isReady()`, and it will happily record attribution into a service that has not
finished mounting. That is harmless for attribution — the entry simply expires —
but do not generalise the pattern to a method whose readiness actually matters.

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

- **Reserved words are the mirror image of the camelCase trap, and they fail on a different engine.** `KEY`, `ORDER`, `GROUP`, `RANK` and friends are reserved on MySQL but merely keywords on SQLite and Postgres, so an unquoted reference to a column named `key` succeeds on two of the three engines and is `ERROR 1064` on MySQL. Verified on all three:

  | Statement | MySQL 8 | SQLite | Postgres |
  |---|---|---|---|
  | `CREATE TABLE t (key VARCHAR(64) PRIMARY KEY, …)` | `ERROR 1064` | succeeds | succeeds |
  | `SELECT key FROM t` | `ERROR 1064` | succeeds | succeeds |
  | `INSERT … SELECT` naming `key` unquoted | `ER_PARSE_ERROR` | succeeds | succeeds |
  | any of them with the identifier quoted | succeeds | succeeds | succeeds |

  Note the asymmetry against the camelCase trap above: that one is invisible on two engines and fatal on Postgres, this one is invisible on two engines and fatal on MySQL. There is no single engine you can develop against that catches both — which is what `test-dialect-portability.js` is for.

  A reserved word is therefore a perfectly legal column name *provided every reference is quoted*, which is why `SwitchPlugin_Settings.key` has always worked: it is only ever reached through Sequelize, which quotes unconditionally. The danger appears the first time raw SQL touches such a column. Note that the diagnostic rule above ("safe only if every identifier is already all-lowercase") does **not** catch this: `key` is already lowercase and still fails. Quote every identifier in raw SQL, not merely the mixed-case ones. When naming a *new* column, prefer a non-reserved word outright (`lockKey` over `key`) so the hazard cannot be reintroduced by a future call site.

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

### 7.12 — Comparing Layer Names With `===`

```js
// ❌ ANTI-PATTERN — the same layer under two names is not the same string
if (storedLayer === gs.getLayerName()) return;      // fires on an unchanged layer
embed.addField('Layer', gs.getLayerName());          // shows "Sumari_Seed_v1" to a human

// ✅ CORRECT
if (gs._layerNamesMatch(storedLayer, gs.getLayerName())) return;
embed.addField('Layer', gs.getLayerDisplayName());   // "Sumari Bala Seed v1"
```

**Why it fails:** SquadJS delivers one layer under two conventions — the pretty name on `NEW_GAME` (`data.layer.name`, "Sumari Bala Seed v1") and the classname on `UPDATED_SERVER_INFORMATION` (`info.currentLayer`, "Sumari_Seed_v1"). They differ by punctuation on most layers and by a whole **word** on some, so no amount of string-stripping makes them equal in general.

**What S³ does about it:** `resolveLayerInfo()` canonicalises every source onto the **classname** — the format `AdminChangeLayer` accepts, the format the DB already holds, and the format the always-fires event delivers. Every object-shaped source is a SquadJS `Layer` carrying both names, so this is a field read, not a guess.

| Method | Returns | Use for |
|--------|---------|---------|
| `getLayerName()` | canonical classname | storage, comparisons, RCON replay |
| `getLayerDisplayName()` | pretty name (falls back to canonical) | anything a human reads |
| `_layerNamesMatch(a, b)` | boolean | comparing two layer names from any source |

`_layerNamesMatch()` is punctuation-insensitive (`Fool's Road RAAS v1` == `FoolsRoad_RAAS_v1` — both are real production values), alias-aware, and tolerant of a map-name word the classname drops (`Sumari Bala Seed v1` == `Sumari_Seed_v1`). It is deliberately **not** tolerant past the gamemode token, so `Yehorivka_RAAS_v2` and `Yehorivka_AAS_v2` stay distinct — a same-map gamemode switch read as "no change" once left the layer stale for an entire round.

### 7.13 — Reading a Scoped Table Without a Scope Predicate

```js
// ✗ WRONG — every server's rows, on a database that has more than one
const rows = await this._getModel('SwitchPlugin_PlayerCooldowns').findAll({
  where: { tokenBalance: { [Op.lt]: 1 } }
});

// ✓ RIGHT — the declaration, turned into a predicate
const scope = this.s3db.scopePredicateFor('SwitchPlugin_PlayerCooldowns');
const rows = await this._getModel('SwitchPlugin_PlayerCooldowns').findAll({
  where: { ...(scope ? { [scope.column]: scope.value } : {}), tokenBalance: { [Op.lt]: 1 } }
});
```

**The rule: a read of a scoped model needs a predicate, and the predicate comes from the declaration rather than from the query author.** Every model says what it is scoped by once, at `defineModel()`, through `scopeKind` (see 10.2.2). `DBService.scopePredicateFor(name)` is the single place that declaration becomes a `{column, value}`, and it **throws** for a model that declared nothing rather than guessing.

Going through it instead of writing `where: { serverID: this.serverID }` by hand buys three things. It returns `null` for a `global` model, so the same call site is correct for a table that is deliberately community-wide. It handles `server-key`, where there is no `serverID` column because the primary key *is* the server id — hand-written attribute checks get those backwards, and the two tables holding live round state are both of that kind. And it is one place to change when a model's scope changes, which has already happened once per table in this suite.

This is the anti-pattern with the least visible symptom in the guide. On a single-server database the wrong query and the right query return identical rows forever, every test passes, and the defect appears only on the day a second server registers — at which point it presents as another server's data appearing in this server's reports, which reads as a data-integrity bug rather than as a missing `WHERE`.

Writes have the same rule and a sharper failure. An unscoped `destroy({ where: {} })` on a shared table is every server's rows, and `!switch wipe` is exactly that operation, which is why it is classified `community-mutating` and names the registered servers in its confirmation.

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

**Source file:** `s3/plugins/s3-plugin-base.js`

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

**User-facing text** (inherited, not overridden):

| Member | Purpose |
|--------|---------|
| `localize(key, vars?)` | Look up a message in the configured language. Unknown key returns the key; missing translation falls back to English. Never throws. |
| `lang` | The language S³ is configured with, or `en` before S³ is discovered. Read-only — plugins never set it. |
| `applyServerLabel(payload)` | Appends this server's short name to the footer of every embed in a Discord payload. A no-op on a single-server install, where S³ publishes no label. |

Every string a player or admin reads goes through `localize()`. Values written
to the database (round-report columns, JSON report fields) stay in English —
they are data, not display. See `s3/LOCALIZATION.md`.

`applyServerLabel()` is already applied by `S3DiscordPluginBase`, so a plugin
sending through that base class needs to do nothing. A plugin that sends
through its own helper object instead hands the function down at
construction — `EloDiscord.applyServerLabel = (payload) =>
this.applyServerLabel(payload);` — because a `utils/` helper cannot import the
label module by any specifier that resolves both in this repository and in the
flattened layout `install.cjs` produces.

**DB convenience** (call from `_onS3Ready()`):

| Method | Purpose |
|--------|---------|
| `defineModel(name, schema, opts?)` | Define Sequelize model on S³'s connector. **Always pass `opts.exportTier`** — see 10.2 |
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

### 8.2.1 — Multi-Server Helpers

Several installs of the suite can share one database and one Discord server. These inherited methods are what make a plugin behave correctly when they do, and **every one of them is inert while only one server is registered** — so a consumer calls them unconditionally and never counts servers itself.

They live on the base class for the same reason `applyServerLabel()` does: `install.cjs` flattens `s3/utils/` and `<plugin>/utils/` into one directory, and no import specifier written in a consumer's `utils/` file resolves both in this repository and at the target. A plugin that sends through its own helper object hands the function down at construction rather than importing it.

| Method | Purpose |
|--------|---------|
| `isMultiServer()` | Whether more than one server is **registered**. Registered, not live: a server that is down still owns its rows and still answers to its selector. |
| `serverDescriptor()` | How to name this server to an admin — the label, else the alias, else `#<id>`. `null` on a single-server install, and that null is what makes the callers below no-ops. |
| `routeDiscordCommand(opts)` | The routing gate. Decides act / drop / refuse for one Discord command, and strips the `--server` selector. See 8.2.2. |
| `buildRoutingRefusalEmbed(verdict)` | Renders a `refuse` verdict as an embed, localized through this plugin's `localize()`. |
| `applyServerLabel(payload)` | Server label in the **footer** of every embed in a payload. For reads. |
| `titleWithServer(title)` | Server in the **title**, ahead of the text. For mutations — see 8.2.3. Returns the title unchanged when there is one server. |
| `serverFileTag()` | A filename-safe `-slug` for this server, `''` when there is one. Two commands answer with a file rather than an embed, so the filename is the only place the answer can say where it came from. |
| `recordChannelBinding(name, id)` | Declare which Discord channel this server uses for a named purpose. Stored in the shared `communityOptions` blob. |
| `channelSharers(name, id)` | The other registered servers pointing that same purpose at that same channel. Empty on a single-server install, which is what makes every shared-channel guard inert there. |

A command whose output would be wrong or misleading when two servers write into one channel checks `channelSharers()` and refuses rather than filtering: `!switch backfill` does this, because a backfill reads the channel's whole history and cannot tell which server's rounds it is looking at.

### 8.2.2 — Command Scopes

`routeDiscordCommand()` needs to be told what sort of command it is guarding, because the answer differs. The scopes are `COMMAND_SCOPE` values from `s3/utils/s3-discord-routing.js`:

| Scope | What it means | Gate behaviour |
|-------|---------------|----------------|
| `server-read` | Reads one server's data | Broadcast: every server answers, each taking its own scoped claim. Pass `selectorRequired: true` where one reply per server would flood the channel. |
| `server-mutating` | Changes one server's live state | A selector is required. Exactly one process acts. |
| `community-read` | Reads data the whole community shares | Exactly one process answers. |
| `community-mutating` | Changes data the whole community shares | Exactly one process acts, and the confirmation says so. |
| `token-confirm` | The second half of a two-step confirmation | **No claim is taken** — the token is the routing, and only the process holding it can act on it. See `claimConfirmReply()`. |

The verdict is `act`, `drop` (another server owns this, say nothing) or `refuse` (the operator has to say which server they meant). A refusal carries a reason and, where it helps, the candidate servers.

**There is no sticky target and no `!s3 all`.** An earlier design had both, and neither survived contact with what the gate actually needs to guarantee. A remembered target makes the meaning of a command depend on scrollback nobody re-reads, so the same text typed twice does two different things and the second one is a surprise. A broadcast verb is worse: it is a single keystroke that turns a server mutation into every server's mutation, sitting next to the selector that was supposed to prevent exactly that. Every command therefore says which server it means, every time, or is answered by whichever process claims it. A reader arriving from the superseded design should not go looking for either.

`routeDiscordCommand()` returns unchanged when one server is registered, so every routing decision above is inert on a single-server install and no consumer needs to branch on it.

### 8.2.3 — Two-Step Confirmations

A command that moves live players or wipes shared data arms, prints a token, and executes when a later message carries that token back. On a single-server install the token is skipped entirely and the confirm stays the bare word it has always been.

| Method | Purpose |
|--------|---------|
| `armConfirmation({kind, payload, command, ttlMs, radius})` | Arm an action and get back `{armed, token, lines, refusal}`. `lines` are ready to append to the plugin's own prompt. |
| `takeConfirmation(kind, token?)` | Execute-side lookup. With a token it finds that entry; without one it takes the newest of that kind, which is what the in-game and single-server paths want. |
| `cancelConfirmations(kind)` | Drop every armed action of a kind. What a `cancel` verb does. |
| `hasConfirmation(kind)` | Whether anything of that kind is armed and still inside its window. |
| `PENDING` | The reasons a take can fail: `ok`, `unknown`, `expired`, `none`. Four answers because an admin's next move differs between them. |
| `claimConfirmReply(messageID, matched)` | Whether this process should reply to a token confirm it did or did not match. |

**Radius.** `radius: 'server'` (the default) confirms against this server's live round — the map, the phase, the player count — so an admin about to scramble sees what they are about to scramble. If that context cannot be read the arm is **refused**, because a mutation confirmed against nothing is a mutation confirmed against the wrong server.

`radius: 'community'` is for commands that touch every server's data, such as an Elo reset. It names the registered server count instead and does not read the round at all: one server's round is not what the command touches, and an unreadable round is no reason to refuse a community-wide wipe.

**Which process replies.** A token confirm takes no claim in the gate, so every process sees it and looks the token up. The one that holds it claims `discord:<messageID>` and replies. A process that does not hold it waits a short grace period and then attempts the same claim, staying silent if it loses — so a token nobody holds is still answered exactly once, and a token that is held costs the common case nothing.

```js
// Arming
const arm = this.armConfirmation({ kind: 'scramble', payload: args, command: '!scramble', ttlMs: this.options.scrambleConfirmationTimeout * 1000 });
if (arm.refusal) return message.reply(arm.refusal);
lines.push(...arm.lines);            // empty on a single-server install

// Confirming
const taken = this.takeConfirmation('scramble', token);
if (token && !(await this.claimConfirmReply(message.id, taken.status === this.PENDING.OK))) return;
if (taken.status !== this.PENDING.OK) return message.reply(/* localized for taken.status */);
```

### 8.2.4 — Community-Affecting Options

Every process in a community runs the same suite version, which is checked at mount and refused on. Nothing checks that they run the same *configuration*, and once a table is shared several ordinary plugin options stop being local policy. `maxSwitchTokens` used to describe one server's token bucket; it now describes a bucket every server reads and writes.

The list of which options those are lives in `s3/utils/community-options.js` as `COMMUNITY_OPTION_GROUPS`, not in the plugins that declare them, because "is this option community-affecting" is a property of the schema layout that S³ owns. **A plugin author adding an option that writes a shared table adds it there.** Splitting the list across plugins is how one of them gets forgotten.

Groups rather than keys, because two of these only mean anything together: `switchCooldownMinutes` and `switchCooldownHours` resolve as a pair, since taking the lowest of each separately invents an interval nobody configured.

| Kind | What the plugin does about it | Accessor |
|------|-------------------------------|----------|
| `RESOLVED` | Read the community's value instead of your own config. Lowest registered value wins. | `resolvedCommunityOption(group, key, fallback)` |
| `MUST_AGREE` | Decline the write while they disagree, and say so. | `communityOptionRefusal(group)` |
| `MUST_AGREE`, on a **read** | Answer with the strictest registered value, because a read has to answer. | `strictestCommunityOption(group, key, fallback)` |
| `MAY_DIFFER` | Nothing. Reported by `!s3 servers`, never enforced. | none |

The kind is chosen by blast radius, and the third row is the one that catches people. A write that would apply one server's retention window to everybody's rows should decline; a read cannot, because answering out of `this.options` makes the same command in the same channel return a different list depending on which process won the claim — a wrong answer with nothing visibly wrong about it. So reads take the strictest candidate, which is the same number on every process and never shows a player a placement one of the community's own servers would call unearned.

`communityOptionRefusal()` is only ever non-null for a `MUST_AGREE` group. Naming a `MAY_DIFFER` one returns null rather than quietly starting to enforce agreement on something two admins are entitled to disagree about.

**Record post-validation values, not what the operator typed.** Each plugin calls `recordCommunityOptions(values)` with the keys it owns. Switch clamps a non-positive `maxSwitchTokens` to 1 at mount, so recording the raw config value would report agreement where there is none and disagreement where there is none. A row missing a key contributes no candidate for it, which is what makes a community where only one server runs Switch resolve to that server's values rather than to nothing.

**Resolution runs over registered rows, not live ones** — the opposite of the version check, deliberately. A stopped server is not running an old schema against the database, so its version is irrelevant; its configuration still describes what this community's policy is, and it is coming back. Resolving over live rows would also make the cap in force flap every time a neighbour restarted.

How a disagreement surfaces: `!s3 servers` reports all three kinds with a line each, and a `MUST_AGREE` write declines at the point of writing. There is no generic mount-time config comparison — the registry embed is the report and the refusal is the enforcement. Where a must-agree write happens to run *during* mount, as EloTracker’s stale-entry prune does, decline with a log line rather than by failing the mount: two admins disagreeing about a leaderboard threshold is not a reason to take Elo tracking down on a live game.

### 8.3 — S3DiscordPluginBase API

**Source file:** `s3/plugins/s3-discord-plugin-base.js`

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
    // 1. Define models (if DB-backed).
    //    exportTier is not optional in practice — omit it and the model is
    //    exported at the default tier and warns by name at mount. See 10.2/11.5.
    this.defineModel('MyPlugin_Table', {
      id: { type: 'INTEGER', primaryKey: true, autoIncrement: true },
      // ...
    }, {
      exportTier: 'historical'   // 'historical' | 'logging' | 'ephemeral'
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

**Five sub-fields:**

| Field | Format | Purpose |
|-------|--------|---------|
| `creates` | `string[]` — table names that this migration creates | Post-migration verifier checks `showAllTables()` |
| `columns` | `Record<string, string[]>` — table name → column names added to *existing* tables | Post-migration verifier checks `describeTable()` for each column |
| `rows` | `Record<string, Array<{key: string, value: string}>>` — table name → seed row matchers. Each entry: `{ key: '<columnName>', value: '<expectedValue>' }` tells the verifier to find a row where `key` column equals `value` | Verified after migration commits, and on every S³ mount via drift detection |
| `data` | `Record<string, Array<{column: string, notNull: true}>>` — table name → post-conditions on column *values* | Verified after migration commits, and on every S³ mount via drift detection. See [§9.1.3](#913--data-post-conditions-touchesdata) |
| `abandoned` | `string[]` — tables this migration names that no model backs, on purpose | Exempts them from the backup-coverage check below. Only correct for a table the suite replaced rather than altered |

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

#### `touches` also decides what gets backed up

Before running pending migrations, the engine takes a JSON backup scoped to
what those migrations declare. Only `columns` and `rows` pull a table into it.

`creates` deliberately does not. A table a migration creates is the one category
that provably cannot lose data: either it does not exist yet, or it already
exists and the idempotent existence guard means the migration leaves it alone.
Backing it up buys nothing and costs its full size in memory.

That distinction is a regression guard, not a micro-optimisation. db-log's
migration is a pure idempotent `createTable` and it declared `creates` for its
eight `dblog_*` tables. When `creates` counted towards the backup scope, mounting
on a server holding ~900MB of stats exported all of it into memory and the
process was OOM-killed (exit 137) before any SQL ran. `test-migration-backup.js`
asserts each category's behaviour.

Neither does a table that is not in the database yet. A model resolves whether
or not its table exists, so a rename that repoints a model at the table the
same run creates would otherwise put an empty table in scope, get an incomplete
envelope back, and abort a migration that had nothing to lose.

The mirror image of that is `abandoned`. A table named in `columns` or `rows`
that no mounted plugin models normally aborts the run — that is the signature
of a plugin installed but not mounted, whose tables the migration is about to
change with nothing exporting them. A Class B rename produces the same shape
for the opposite reason: the model moved to the replacement table and the old
one was left standing, while the migration that seeds it stays registered
forever because a recorded version is a contract. Declaring `abandoned` says
which of the two this is. Do not reach for it to quiet a warning about a table
that still has an owner.

A migration whose declaration resolves to no data-bearing table — `creates` only,
or `touches: {}` — takes no JSON backup at all. Setting `backup: false` states
the same intent explicitly and is worth adding when a reader would otherwise
wonder; it is what db-log does. On SQLite the whole-file binary copy still runs
either way, since it is disk-bound rather than memory-bound.

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
| `addIndex(table, cols, opts?)` | `(string, string[], object?) => Promise` | Create index — **ALTER-based**; rejected under a CREATE-but-not-ALTER grant, even on a table created in the same migration. See §11.5. |
| `removeIndex(table, name, opts?)` | `(string, string, object?) => Promise` | Drop index |
| `createTable(name, attrs, opts?)` | `(string, object, object?) => Promise` | Create table |
| `dropTable(name, opts?)` | `(string, object?) => Promise` | Drop table |
| `showAllTables()` | `() => Promise<string[]>` | List all tables |
| `describeTable(table)` | `(string) => Promise<object>` | Column map for a table |
| `bulkInsert(table, rows, opts?)` | `(string, object[], object?) => Promise` | Insert rows |
| `bulkUpdate(table, values, where?, opts?)` | `(string, object, object?, object?) => Promise` | Set-wide UPDATE (backfills) |
| `bulkDelete(table, where?, opts?)` | `(string, object?, object?) => Promise` | Set-wide DELETE |
| `rawQuery(sql, replacements?)` | `(string, object?) => Promise<*>` | Execute raw SQL |
| `modelForTable(table)` | `(string) => object\|null` | Resolve a model by **table** name — catches the cases `db.getModel()` misses, where model name ≠ table name (`Elo_RoundHistory` → `Elo_RoundHistories`). Not used for `touches` verification: that reads the named table directly, because a model whose `tableName` was repointed would otherwise send the check at a different table |
| `sequelize` | property | Direct Sequelize access |
| `db` | property | DBService instance |
| `transaction` | property | Active Sequelize transaction |
| `DataTypes` | property | Sequelize DataTypes for column defs |
| `isReapply` | property (`boolean`) | `true` when this `up()` is being **re-applied to repair drift** rather than applied for the first time. Guard any one-time destructive step on it — see the warning below |

Each `qi` method above is already bound to the migration's transaction, so pass options only for the operation itself. `qi.transaction` is exposed for model calls, which do need it explicitly.

> **Best practice — use model-based access for row-level DML in migrations.** For single-row work (inserts, upserts, destroys) inside migration `up()`/`down()` handlers, use `qi.db.getModel('ModelName')` and call `create()`/`upsert()`/`destroy()` on it. Sequelize then handles identifier quoting (backticks for MySQL, double quotes for PostgreSQL) and type coercion for you. See Switch migration v4 (`switch-db.js`) for a real-world example of model-based seed row insertion.
>
> For **set-wide** work — backfilling a column across every row — use `qi.bulkUpdate()`. It resolves the registered model's attribute types automatically, which matters more than it looks: Sequelize's low-level bulk API escapes values by their JS shape when it has no types, and on SQLite a `Date` then lands in the column as an **integer epoch** rather than the TEXT that `DataTypes.DATE` reads back. Every subsequent read of that row dies with `date.includes is not a function`. MySQL and Postgres escape a `Date` to a datetime literal either way, so this reaches production on SQLite deployments only. If you bypass the wrapper and call `qi.sequelize.getQueryInterface().bulkUpdate()` directly, you must pass `model.rawAttributes` as the fifth argument yourself.

> **Guard one-time destructive steps on `qi.isReapply`.** Drift recovery deliberately re-runs a migration that has *already been applied* (see §9.8). That is safe for `addColumn`, `createTable` and null-matched backfills, which are idempotent. It is **not** safe for a step that resets state — truncating a table, zeroing balances, seeding over rows players have since edited. On the repair pass, such a step destroys exactly the live data the operator ran `!s3 migrate force` to preserve.
>
> ```js
> // Truncate on first install only — never while repairing drift.
> if (!qi.isReapply) {
>   await qi.bulkDelete('SwitchPlugin_PlayerCooldowns', {});
> }
> ```
>
> Version tracking alone does not protect you here: it stops an *ordinary* re-run, but recovery rolls the recorded version backwards on purpose, so the migration genuinely is pending again. Switch v3 is the reference case — it adds five token columns and then truncates the cooldown table. The columns re-add harmlessly; the truncate would have wiped every player's token balance, seed-bonus progress and scramble lockdown. The flag is `false` for a first-time apply and cleared after the repair run, so a later ordinary migration still gets its one-time step. `s3/testing/test-migration-data-assertions.js` asserts the `[false, true, false]` sequence across all three engines.
>
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

**Upgrading several servers that share one database: stop all of them first.** There is no rolling upgrade. A migration that adds a column runs once, from whichever process reaches it first, and the moment it commits, the other processes are running code that does not know the column exists. While the column stays nullable their inserts still succeed and simply leave it NULL — rows nothing can later attribute to a server. Once a follow-up migration makes it `NOT NULL`, their inserts fail outright, and the plugin that was writing them logs a rejected write on every event until it is restarted. The supported sequence is stop every process, migrate, then start them again.

**On a grant that can `CREATE` but not `ALTER`, adding a non-null column is three steps, not one.** `ADD COLUMN … NOT NULL` against a populated table is rejected: the engine has no value for the existing rows. So the column is added nullable, the rows are backfilled, and only then is it tightened — which is two hand-applied `ALTER` statements with a backfill between them, in two separate migrations. `!s3 migrate ddl` emits the statements for the pending migration only, so run it again after each step rather than expecting one paste to cover all three.

**Do not declare a `touches.data { notNull }` post-condition in the same migration that adds the column.** `touches.data` is re-checked on every mount, forever, not once at migration time. A predicate that is true when it is written but that some write path can still violate turns the first violating row into a permanent rollback-and-re-gate loop: the plugin re-runs the migration, verification fails again, and it gates itself off on every boot. Ship the column nullable, prove every write path stamps it, and add the predicate in a later version.

### 9.5 — S³ Schema Versions Table

The `S3_SchemaVersions` table tracks which version each plugin is at. It is populated by:
- `registerExpectedVersion()` — declares what version the code expects
- Migration execution — updates the actual version after successful migration
- `verifySchemaVersions()` — compares expected vs actual

### 9.6 — Offline CLI Migration Tool

A standalone CLI tool (`s3/tools/schema-version.mjs`) can check, preview, and run migrations without booting SquadJS. Useful when the game server is offline and Discord confirmation isn't available.

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

> **Fixed 2026-08-20 — previously unusable.** This tool carried a "do not rely on
> its output" disclaimer for two defects, and the disclaimer understated the first
> of them. It was written as CommonJS (`require('path')`) with a `.js` extension
> under a `"type": "module"` package, so it threw `ReferenceError: require is not
> defined` at load and **never ran at all** — the documented symptom (every table
> reported `❌ missing`) was unreachable. Underneath that sat the real second bug:
> `sequelize.query(sql, { type: QueryTypes.SELECT })` resolves to a row array, not
> a `[rows, metadata]` tuple, and both call sites destructured it as one, taking
> the first *row* and failing the `Array.isArray` guard. Both are now fixed and the
> tool is verified against a real `squad-server.sqlite`, in text and `--json` modes,
> with orphan detection working.
>
> Note its expected-table list is a hand-maintained constant dating from
> `stage7.4-db-schema-rework.md`, **not** read from `dbService.getModelNames()`.
> It will drift from the models as they change; treat a `⚠️`/`❌` as a prompt to
> check, not as proof. `!s3 migrate verify` reads the live registry and is the
> authority.

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
- **Schema drift status** — the *cached* result from `getLastDriftResult()`, not a fresh check. The cache is written by every `verifyLiveSchema()` call: the automatic one at mount, and any `!s3 migrate verify`. So `diag` reports the state as of the last check, which on a freshly-started server means mount time. If something has changed the database since — a restore, a hand-applied `ALTER` — run `!s3 migrate verify` to re-check; `diag` alone will keep showing the stale verdict until you do.

#### When to Use

| Scenario | Command |
|----------|---------|
| Periodic health check during operation | `!s3 diag` |
| Investigate reported DB issues | `!s3 migrate verify` |
| After a DB restore or connector change | `!s3 migrate verify` |
| Pre‑upgrade schema check | `!s3 migrate verify` |

Both commands require S³'s Discord admin channel to be configured (`channelID` in config).

#### What recovery actually does

Detecting drift is only half of it. When the check confirms that schema a migration already applied has gone missing, S³ rolls the plugin's recorded version **back below the migration that owns the missing schema**, which makes that migration pending again so `!s3 migrate force` re-applies it.

Ownership comes from `touches`: the engine finds the lowest-versioned migration whose `creates`/`columns`/`rows` declares the missing item, and rolls back to one below it. Rolling back a fixed single version is not enough — a table that has lost columns owned by v3 *and* v5 would re-apply only v5, drift again on v3's, and roll back again on the next mount, forever. Matching is case-insensitive, because MySQL with `lower_case_table_names=1` reports identifiers folded while `touches` declares them as written.

Because recovery re-applies an already-applied migration, `up()` must be idempotent — see the `qi.isReapply` warning in §9.2.

#### Drift alongside pending migrations

The check runs even when a plugin has migrations waiting, so a server that is **both behind and drifted** is repaired in a single confirmation rather than needing one run to reveal the drift and a second to fix it.

This is only safe because the two cases are told apart before anything is rolled back. A plugin that is legitimately behind is *also* missing the columns its unapplied migrations add, and treating that as drift would fire a false alarm on every routine upgrade and roll versions backwards. So each missing item is attributed to its owning migration and discarded when that migration has not run yet; plugins with no recorded version at all — a brand-new install, where nothing exists — are dropped wholesale.

An item no migration declares (a column created inline by `createTable`, covered by `touches.creates` rather than `touches.columns`) cannot be attributed, and is treated as drift. That fails safe: a real loss is reported rather than silently ignored.

The verbose log shows both views, and they are expected to differ:

```
[DB] DRIFT: ... missing columns: tokenBalance, seedBonusTokensEarned, lastActiveTimestamp   ← raw
[DB] CONFIRMED DRIFT: ... missing columns: tokenBalance, seedBonusTokensEarned              ← after attribution
```

`lastActiveTimestamp` is absent from the confirmed set because the migration that adds it simply has not run yet. Only the confirmed set drives rollback and reaches the stderr `SchemaDrift` warning.

**Extra** columns are informational only — they never trigger rollback, and are excluded from stderr so they don't append to the error file on every mount.

`s3/testing/test-drift-recovery-matrix.js` covers all of this across SQLite, MySQL and Postgres: brand-new, behind, drifted, behind *and* drifted, undeclared-column loss, multi-plugin, and repeated cycles converging.

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
| `!s3 clans` | Active clan groups, plus a second embed explaining every exclusion (size bounds, `ignoreList`, unnormalizable tag) and every Damerau-Levenshtein merge and recruit-suffix strip |
| `!s3 locks` | Global lock + per-player locks |
| `!s3 servers` | Every server registered against this database — alias, id, name, live/stale with the age of the last heartbeat, suite version, address, measured clock skew against the database clock, and the community-affecting option values behind that row. Registered and live are both reported because they answer different questions: the count is what the `--server` selectors use, and a stale row is still a server the community owns |
| `!s3 servers alias <server> <newAlias>` | Rename a registered server. `<server>` is an existing alias or a numeric id. The new alias is lowercased and stripped to `[a-z0-9_-]`, must be unique, and must be at least two edits from every *other* alias — the row being renamed is exempt from its own check, or `main` could never become `mains` |
| `!s3 servers forget <server>` | Deregister a retired server. Refused while the row is still heartbeating, and refused outright for the server running the command. Historical rows are untouched; only the registration goes |
| `!s3 config` | Server config values |
| `!s3 switches [range]` | Team-switch leaderboard across all players (Legacy pre-split Balancer moves fold into Full — both are full scrambles, just from before Full/Micro were tracked separately) |
| `!s3 switches <ident> [range]` | One player's switch breakdown, grouped into Balancer/Scrambles vs. Manual/Switch |
| `!s3 switches export [range] [period] [--json]` | One row per period (`daily`/`weekly`/`monthly`) per player active that period — games played, total switches, and the full source breakdown — as a CSV (default) or JSON file attachment. Players silent all period get no row, not a padded zero |
| `!s3 karma <ident> [range]` | Win-rate of a player's self/untracked switches vs. the eventual round winner, with switch frequency context (N switches in G games — P% of rounds) and a directional verdict (excludes balancer/SmartAssign moves — those aren't the player's choice) |
| `!s3 watch <service>` | Relay verbose logs for a service to Discord |
| `!s3 unwatch` | Stop all active watches |
| `!s3 diag` | Consolidated diagnostic — mounts, phase, factions, players, locks in one pass |
| `!s3 help` | Command reference |
| `!s3 db export [--logs\|--all] [--all-servers]` | Stream the export to `backups/`, then attach it to the reply if the gzipped file fits the guild's own upload limit (10 MB unboosted, 50 MB at boost tier 2, 100 MB at tier 3 — read from `guild.premiumTier`, falling back to the 10 MB floor when the tier is unknown). If it doesn't fit, or the upload fails anyway, the file stays on disk. Either way the summary embed names it |
| `!s3 db export --to-file [--all]` | Same export, no attachment attempt |
| `!s3 db import [--confirm] [--dry-run] [--all-servers\|--remap-server]` | Import from attached JSON (two-step). Writes this server's rows and adopts rows carrying no server at all; a sibling's rows are skipped unless widened. See §10.2.2 |
| `!s3 db status` | Connector name, pending-migration state, and schema version per registered plugin |
| `!s3 db orphans` | Tables carrying a suite prefix that no registered model points at, with row counts. Read-only — S³ never drops a table. Most are deliberate: a table whose primary key changed was replaced rather than altered, because neither SQLite nor a restricted MySQL grant can alter one in place |
| `!s3 backup list` | List backups in **this server's** backup directory. Every process keeps its own, so on a multi-server install this broadcasts and each server answers for its own disk |
| `!s3 backup create` | Take a backup now, on the server named by `--server`. The file holds every server's rows; the disk it lands on is one server's |
| `!s3 backup restore [--confirm] <filename>` | Restore from a backup file on the server named by `--server` (auto-detects SQLite vs JSON). Community-wide in effect — see §10.4 |
| `!s3 confirm <token>` | Confirm a pending migration using the token from the startup prompt |
| `!s3 migrate pending` | List pending migrations |
| `!s3 migrate status` | Schema version per plugin, with how far behind each is |
| `!s3 migrate preview` | Pending migration descriptions and their `touches` |
| `!s3 migrate force [--dry-run]` | Run pending migrations, bypassing the confirmation token |
| `!s3 migrate verify` | Re-run drift detection against the live database now (see §9.8) |
| `!s3 migrate ddl [plugin]` | Emit the exact DDL for the pending migrations, rendered for the connected dialect. For a database user that can CREATE but not ALTER, this is the only way to apply a column-adding migration: run the output by hand as a user that holds the grant, then `!s3 migrate force` to record the versions. Only genuinely missing objects are emitted, so it is safe to re-run. |
| `!s3 migrate purge-deprecated [--confirm]` | Scan for, and optionally drop, `_deprecated_*` tables and columns |
| `!s3 migrate adopt-state [--confirm]` | Move the legacy `id = 1` row of each per-server singleton table onto this server’s declared `serverID`. Only for an install that has always run a non-1 `server.id` and wrote its round state and win streak to the singleton before the key meant anything; a server declaring `serverID: 1` is told there is nothing to adopt. Without `--confirm` it prints the row it would keep and the row it would replace, field by field. |

`!s3 migrate`, `!s3 backup` and `!s3 db` with no subcommand each reply with their
usage line rather than performing a default action. `!s3 servers` is the
exception: with no subcommand it lists the registry, because listing is what an
operator wants often enough that a usage line would be an obstacle rather than a
guard. An *unrecognised* subcommand still gets the usage line — a typo must never
fall through to a default action.

### 10.2 — Export/Import System

**Three-tier classification.** Each model declares its own tier where it is
defined — S³ owns no central list of what belongs where:

```js
this.defineModel('TB_RoundReport', schema, {
  tableName: 'TB_RoundReport',
  timestamps: false,
  exportTier: 'historical'      // 'historical' | 'logging' | 'ephemeral'
});
```

A **third-party S³ consumer plugin therefore classifies its own tables without
editing S³**. The exporter reads the declarations back via
`dbService.getEffectiveModelTier()`.

Two rules make forgetting survivable:

- **An undeclared model is exported at the default (`historical`) tier**, and
  `defineModel()` warns by name at mount. Over-exporting fails visibly and
  recoverably (the export lands on disk and the reply says it was too big to
  attach); under-exporting fails silently and permanently. The fallback picks
  the recoverable direction.
- **An invalid tier string throws at definition time**, on the author's own
  server at startup — not at restore time months later.

Plugins classify *into* these three tiers and cannot mint new ones: the tiers are
an operator-facing CLI surface (`--logs`, `--all`), and a dynamic tier list would
depend on which plugins happen to be loaded.

⚠️ The keys of the export JSON — and of `tiers` below — hold **model names**, not
table names. Several deliberately differ (model `S3GameStateEvents` → table
`S3_GameStateEvents`); see 11.5.

| Tier | Flag | Models included |
|------|------|-----------------|
| Historical | (default) | `S3SchemaVersions`, `S3Servers`, `Elo_PlayerStats`, `Elo_RoundHistory`, `Elo_RoundPlayers`, `SA_AssignmentLog`, `TB_RoundReport`, `SwitchPlugin_Settings`, `SwitchPlugin_RoundStats` |
| Logging | `--logs` | Above + `S3PlayerEvents`, `S3GameStateEvents`, `S3PlayerSnapshots` |
| All | `--all` | Above + all auto-recoverable state: `S3GameState`, `S3Locks`, `S3_PlayerSession`, `S3PlayerReconnect`, `SwitchPlugin_PlayerCooldowns`, `SwitchPlugin_PlayerServerState`, `SwitchPlugin_Endmatches`, `TeamBalancerState` |

The table above is the *current* classification, and it is enforced rather than
descriptive: `TIER_SETS` in `s3-export-import.js` retains it as the expected
classification, and `test-export-model-registration.js` asserts every model's
declared `exportTier` equals its entry there. Moving a table between tiers is
therefore a deliberate two-file edit — the definition site and the fixture — not
a one-word change that quietly alters what lands in every operator's backup.

`--all` still returns every registered model unconditionally, so it is a superset
of the tier logic rather than a path around it.

**A tier is not a promise that a restore writes the table.** `S3Locks` is
`ephemeral`, so its rows are in an `--all` backup — a snapshot should be able to
say which process held the migration lock when it was taken — but the importer
passes the table over rather than writing those rows back. Every process that
held a lock at backup time is gone by restore time, and `acquireLock()` steals a
row only once its `expiresAt` has passed, so a restored migration lock would
stall every process's migration until a deadline set on a different day went by.
The list lives in `IMPORT_SKIPPED_MODELS` (`s3-export-import.js`), separate from
the tier sets because it answers a separate question. Both importers honour it,
and a skipped table is reported as `status: 'skipped'` — not as an error, and
not as `ok` with zero rows, which would read as a table that happened to be
empty.

**Export format:**

```json
{
  "s3ExportVersion": 1,
  "s3StreamFormat": 1,
  "exportedAt": 1719547200000,
  "connector": "sqlite",
  "tier": "historical",
  "tiers": { "ModelName": "historical" },
  "tables": {
    "ModelName": [
{ "...": "row" },
{ "...": "row" }
    ]
  },
  "rowCounts": { "ModelName": 42 },
  "results": { "ModelName": { "status": "ok", "rows": 42 } }
}
```

`tier` and `tiers` make a backup self-describing — a restore can tell an operator
"this file was taken at the default tier, so ephemeral state is not in it" rather
than leaving them to infer it from absence. Both are **additive**, so the format
stays version 1 and every backup written before they existed still imports; the
importer must keep tolerating their absence.

`s3StreamFormat` marks a file written by the streaming exporter. Its one visible
consequence is the layout above: **one row per line**, unindented, inside each
table array. That is not cosmetic — it is what lets `restoreFromFile()` import a
file larger than the heap by reading it a line at a time. The document is
ordinary JSON either way, so anything that could read an older export still can.
Files without the marker are legacy pretty-printed exports and take the
in-memory path; above 256MB they are refused rather than allowed to OOM.

### 10.2.1 — Memory: Which Functions Stream and Which Do Not

`s3-export-import.js` is split down the middle and the halves are not
interchangeable:

| Function | Memory | Use for |
|----------|--------|---------|
| `exportToFile()` | One row batch + a ~256KB buffer | Any database, any size |
| `importFromStreamFile()` | One chunk of rows | Any file the exporter wrote |
| `gzipFileForAttachment()` | Stream buffers, then the result only if it fits | Turning an export into an attachment |
| `exportToJSON()` | The whole database | Tests, validation, datasets known to be small |
| `importFromJSON()` | The whole file | Same |
| `serializeForAttachment()` | The whole database, twice | Same |

This is a live-outage boundary, not a style preference. A production db-log
dataset is roughly 900MB. V8 caps a single string at about 512MB on Node 18 —
the version SquadJS ships on — so `JSON.stringify()` of that data cannot produce
a string at all, and the attempt OOM-killed the SquadJS process (exit 137)
during pre-migration backup, before any SQL ran. If you add a code path that
touches every row, it belongs in the top half of that table.

Two implementation details are load-bearing and easy to undo by accident:

- **Backpressure.** The writer awaits `'drain'` whenever `stream.write()`
  returns false. Ignoring that return value turns "streaming" back into
  "buffer the whole database in memory", with no visible difference until the
  data is big enough to kill the process.
- **Keyset pagination.** Row batches are fetched with `WHERE pk > :last ORDER BY
  pk LIMIT :n`, not `LIMIT ... OFFSET`. MySQL re-walks and discards every
  skipped row for an OFFSET, so paging a multi-million-row table that way is
  quadratic — slower than the naive full load it replaced. Models with a
  composite or absent primary key fall back to OFFSET.

**Import workflow:** Two-step — `!s3 db import` (with attachment) → review embed → `!s3 db import --confirm` → execute.

**Constraints:**
- No deletes on import (upsert only)
- FK checks disabled during the transaction
- Per-table try-catch (a failed table does not roll back others)

### 10.2.2 — Which Server's Rows

Every model declares its scope once, at `defineModel()`: a discriminator column, a primary key that *is* the server id, or global. Export and import both turn that one declaration into a query through `DBService.scopePredicateFor()`, and a model that declares nothing is refused rather than guessed at. An attribute check would get the second kind wrong in the worst possible direction — `S3_GameState` and `TeamBalancerState` have no `serverID` column because their key is the server id, so "does it have a serverID column?" answers *global* for the two tables holding live round state.

**Export.** `!s3 db export` writes this server's rows; `--all-servers` writes everyone's. On an install with one registered server the scope is not applied at all, because the only rows it would remove are ones whose `serverID` is still NULL, and quietly shrinking the backup on a single-server install is the worse trade. The envelope records what it holds: `serverID`, `scope`, and `containedServerIDs` (capped at 64 — past that the field is a fingerprint, not a list, and `containedServerIDsTruncated` says so).

**Import.** Each row gets one of five outcomes, and the confirmation states which, per table, before anything is written:

| Outcome | When |
|---|---|
| **write** | The row names this server |
| **adopt** | The row names no server at all — every backup taken before the suite was multi-server. Adopted by the importing server, whatever the flags say |
| **skip** | The row names a different server. This is the default |
| **remap** | `--remap-server`: the row is claimed for this server |
| **write back** | `--all-servers`: the row is written to the server it names |

Adoption is not optional because the alternative is worse than it looks. Filtering on "serverID matches me" imports **zero rows** from every pre-multi-server backup while reporting a tick per table — and that backup is the most likely thing anyone ever restores.

**A multi-server dump restored into a single-server install** is the case worth reading twice, because the two widening flags fail in opposite directions and neither is an error:

- **Default (neither flag).** The other servers' rows are skipped. The summary names the servers whose rows were left behind, so the count you get is smaller than the file and you can see why.
- **`--remap-server`.** Every row is claimed for this server. Two servers' histories are **merged** — sessions, switches, Elo events and round reports from both now read as one server's. There is no undo short of restoring an older backup; re-importing does not separate them again.
- **`--all-servers`.** Every row is written back to the server it names, including ids this database has no `S3_Servers` row for. Those rows are not lost and not visible: nothing queries them until that server registers, at which point they reappear as its history.

The two flags are opposite intentions rather than degrees of one, so passing both is refused rather than resolved. Both take a second `--confirm`: the first renders the plan and writes nothing.

**Overwrite counting.** `model.upsert()` matches on the primary key, and for the tables keyed on an autoincrement `id` that key says nothing about ownership — an envelope from a pre-multi-server database can silently replace a sibling's rows. Before the transaction opens, the importer probes each table in chunks of 200 and reports both how many existing rows will be replaced **and which servers they currently belong to**. A table whose probe fails reports the count as unknown, never as zero: zero reads as "nothing of yours is at risk".

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

**Backups are community-wide, in both formats, and a file copy has no scoped form.** A `.sqlite` backup is the database file — every server's rows, by construction, with no filter available at any point. A `.json` backup is written community-wide on purpose: the pre-migration backup is its first caller, a shared schema migrates for everyone at once, and a backup holding one server's rows would be no use to the restore that needs it. Restore matches: `!s3 backup restore` writes every server's rows back where they belong, which is the opposite default to `!s3 db import` and for the opposite reason — an import takes a file an operator chose, a restore puts back a file this suite wrote.

**A `.sqlite` restore is refused while another server process is live.** It is `fs.copyFileSync()` over the database file, and a sibling holds that same file open with its own page cache and write-ahead log. Replacing it underneath a running process does not roll that process back; it leaves it reading pages that no longer belong to the file it opened, and the damage surfaces minutes later as unreadable rows rather than as an error anyone connects to this command. Stop the other servers and the refusal lifts itself once their heartbeats lapse, or restore from a `.json` backup, which writes through the database instead of around it.

**A `.json` restore is not atomic.** The streaming importer commits per chunk and isolates each table, so a failure partway through leaves the database part old and part new, and the result that comes back is a success object with error entries inside it rather than an exception. The confirmation says so before you agree, and a run with any failed table reports as **partly restored** — amber, naming the tables that did not land — rather than as a green tick. Making it atomic means restoring into staging tables and swapping, which is a larger piece of work than the honesty is.

---

## §11 — Testing Patterns

### 11.1 — Test File Conventions

S³'s tests are in `s3/testing/`; every other plugin has a `testing/` directory of
its own. Most use mock infrastructure and need no live SquadJS or game server —
but see 11.4 for the cases where a mock is actively misleading.

**Running everything, from the monorepo root:**

```bash
node testing/run-all-tests.js              # all five plugins
node testing/run-all-tests.js --fast       # skip the slow randomised sweeps
node testing/run-all-tests.js --plugin=s3  # one plugin
```

**Running one test:**

```bash
node s3/testing/test-game-state-service.js
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
| `test-i18n.js` | Catalogue parity, call-site keys and vars, language resolution |
| `test-i18n-render.js` | Renders every embed builder through a pseudo-locale; fails on prose that never reached the catalogue |
| `test-identifier-case.js` | Static scan: every file that asks a database what tables it holds is inside the scanned directories, and none of them compares a `showAllTables()` result by equality — MySQL with `lower_case_table_names=1` folds table names, and an exact match reads a live table as missing |
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
| `test-export-scope.js` | `DBService.scopePredicateFor()` and the two exporters, against all three engines. That each scope kind resolves to the clause it declared — the declared column, the primary key for a `server-key` model, nothing for a global one — and that an undeclared model throws rather than answering; that a declared column the table does not have yet is not a predicate, which is the ordinary state between a classification landing and its migration; that a scoped export holds only this server's rows while global tables stay community-wide; and that the streaming exporter's keyset cursor cannot cancel the scope when both name the same column |
| `test-import-scope.js` | `!s3 db import`'s row policy against all three engines. That a sibling's rows are skipped by default and the skip names the server they belong to; that a row carrying no server id is ADOPTED rather than skipped, which is the difference between a pre-multi-server backup restoring and one reporting success having written nothing; that `--all-servers` and `--remap-server` do opposite things and are refused together; that the overwrite probe counts rows as they will be WRITTEN, so a remap is followed rather than the envelope; and that the foreign-key suppression does not outlive the import, checked on a pool of exactly one connection so the session read back is the session that was changed |
| `test-db-orphans.js` | `!s3 db orphans` driven through the shipped handler against all three engines. That a live model's table is never listed — the case MySQL decides, since `lower_case_table_names=1` hands back a folded name and a comparison that does not fold reports the entire schema as orphaned; that a real abandoned table is found, counted and shown with what replaced it; that a table outside the suite's prefixes is never named, because the list is what an operator with the DROP grant acts on; and that the raw `COUNT(*)` is quoted per dialect |
| `test-migration-bulk-types.js` | `qi.bulkInsert`/`bulkUpdate` value typing and NULL backfills, real engines — see 11.4 |
| `test-stderr-diagnostics.js` | Migration failures and drift reach fd 2, not stdout — see 9.9 |
| `test-migration-permissions.js` | Migration DDL at four permission tiers, per dialect (Docker-gated) — see 11.4 |
| `test-export-model-registration.js` | Real services register every model; each declares an `exportTier` matching the fixture; a third-party model reaches the default export without editing S³ — see 11.5 |
| `test-resolving-cleared-logging.js` | `RESOLVING_CLEARED` rows and `S3_GameStateEvents` shape, on **SQLite and MySQL** |
| `test-install-layout.js` | `install.cjs` output layout: flattening, per-plugin runners, no collisions |
| `test-migration-pipeline.js` | End-to-end migration run: ordering, backup, version bump |
| `test-migration-conformance.js` | Migration definitions match the expected shape/contract |
| `test-migration-partial-retry.js` | A migration whose `up()` commits real DDL/DML but fails post-commit `touches` verification is safely retryable — `addColumn`/`bulkInsert` don't crash on a raw duplicate-column/duplicate-key error, real engines |
| `test-migration-data-assertions.js` | Migrations' data effects are asserted, not assumed — see `TASK_MIGRATION_DATA_ASSERTIONS.md` |
| `test-drift-recovery-matrix.js` | Drift recovery across every DB state a server can be in — brand new, behind, drifted, behind *and* drifted, multi-plugin — on SQLite, MySQL and Postgres |
| `test-multi-process-locking.js` | The migration lock across **real child processes** on one SQLite file: the body runs once, the loser re-checks and comes up clean, the lock is released rather than left to expire, and drift found while another process holds the lock does not roll `S3_SchemaVersions` back |
| `test-two-process-isolation.js` | Two **real child processes** against one **MySQL** database, which is the arrangement every other multi-server suite here simulates with two objects in one process. Each server reads back its own `S3_GameState` row and win streak; two rounds starting in the same millisecond get different `matchId`s; reconnect memory and scramble lockdowns stay per-server while the token bucket stays community-wide; a scoped export carries the exporting server's rows and the community-wide ones and none of its sibling's; two processes migrating at once run the body once between them; a released lock is acquirable immediately rather than after a TTL; one Discord message is claimed by exactly one process; reaping an expired claim leaves a held migration lock alone; a connector named for the community rather than its dialect still takes a real lock; fifty round-ends split across the two processes against one community-wide Elo row land as fifty increments rather than twenty-five; and a process on a different suite version than a live sibling refuses, then stops refusing once that sibling's row goes stale |
| `test-server-identity.js` | How the server id every server-scoped row carries is resolved — override over SquadJS `id` over the single-server default — and that an unusable one is refused at mount rather than truncated or substituted, against the real plugin classes in their shipped layout |
| `test-server-registry.js` | The `S3_Servers` claim at mount: a first boot creates the row, a moved server reclaims a stale one, and a second live process under the same id is refused without a byte being written. Covers the first-boot race, where the primary key decides and the loser reads back, and the consumer-plugin gate that a refusal opens. Also the two-step confirmations built on the registry — that a single-server install mints no token, changes no title and tags no filename; that an unreadable round refuses a server-radius arm while a community-radius arm proceeds without reading one; that a token finds only its own kind and is not displaced by a later arm; and that a rejection reaches the channel once rather than once per process |
| `test-singleton-scoping.js` | `S3_GameState` and `TeamBalancerState`, whose primary key **is** the server id. Both models refuse an id-less create, which on SQLite would otherwise mint a server identity out of the rowid; all four boot orders of a new server and an incumbent declaring 1 or non-1 leave the incumbent’s round state and win streak intact; nothing renumbers a legacy row implicitly; and `!s3 migrate adopt-state` previews without writing, then moves both singletons under `--confirm` |
| `test-multi-server-scoping.js` | The three tables whose primary key had to change, so each is a new table beside an abandoned one. Switch v9’s copy is checked by row count **and** by content on SQLite, MySQL and Postgres; re-applying it copies nothing twice and puts no old value back over a newer one; `key` is proved safe quoted and rejected unquoted on MySQL alone; two servers’ rows coexist and each server reads its own; a backup taken **before** the rename restores into the new table under the importing server’s id while one that names its servers keeps them; and reconnect memory survives being read, which it did not when the database branch went untested |
| `test-discord-routing.js` | Which server answers a Discord command when several share one Discord server. Selector parsing — including the whole-flag match that keeps `--all-servers` and `--remap-server` intact beside a real `--server` in one line — the zero-delta guarantee that one registered server takes no claim and refuses nothing, the bare-versus-scoped claim keys that make a community reply arrive once and a per-server read arrive once each, refusals that reach the channel once rather than once per process, a claim that fails **open** on a database error and `lost` only on a duplicate key, a reaper that works off each row's own expiry and so cannot delete a live migration lock, and that every scope the four surfaces' tables can return is a `COMMAND_SCOPE` value |
| `test-community-options.js` | D15's three levers over the `communityOptions` blob: which plugin options resolve to one community value (lowest registered wins, and the cooldown pair resolves as a pair rather than key by key), which refuse the write while the servers disagree, and which are reported and deliberately not enforced. Covers the recording side too — post-validation, merged across plugins, and self-cleaning when a plugin is uninstalled |
| `test-migrate-flag-safety.js` | A destructive command whose safety flag is misspelled — `[--dry-run]`, brackets and all, as copied from a usage line — refuses instead of taking its destructive default, and a dry run leaves no trace, including an armed confirmation gate |
| `test-command-routing.js` | `!s3` subcommand dispatch and argument parsing |
| `test-inspection-embeds.js` | Inspection/embed builders render without throwing on sparse data |
| `test-sa-per-player-lock.js` | Per-player lock acquisition/release under contention |
| `test-team-change-retry.js` | Team-change retry loop and give-up conditions |
| `test-request-team-change-eosid.js` | `_requestTeamChange()` sends RCON `switchTeam(eosID)` — a single unambiguous arg, never playerName or a second targetTeamID arg |
| `test-developer-guide-accuracy.js` | This guide's command table, option defaults and test catalog still match the source — see 11.8 |
| `test-s3-switch-reports.js` | `!s3 switches`/`!s3 karma`/`!s3 switches export` query layer: range/period parsing, player resolution, source bucketing, games-played, karma, and periodic aggregation, on **SQLite and MySQL** |
| `test-s3-commands-embeds.js` | `buildSwitchesEmbed`/`buildKarmaEmbed` Discord formatting layer: the TeamBalancer-own-logging-off gap warning (hard-block in karma, soft note in switches), on **SQLite** |

The harness's own suite lives outside `s3/`: `dev-harness/testing/test-dev-rcon-harness.js`
(16 tests, fully mocked). See 11.7.

### 11.2 — Mock Patterns

These are for exercising *logic* — lifecycle, branching, event flow. They prove
nothing about SQL, because `MockSequelize.query()` accepts and discards whatever
it is given. Anything that depends on the engine goes through 11.4 instead.

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

Mocks cannot model dialect behaviour — that is a property of the engine, not of the code. Identifier folding, collation, and `ESCAPE` parsing simply do not exist in a hand-written mock, so a mock suite will report green while the statement is broken on a real database. Every defect found during the Postgres portability pass passed the mock suite for its entire lifetime, and one of them (`ESCAPE '\\'` in EloTracker's name search) was broken on **SQLite** — the primary deployment target — the whole time.

**If you touch raw SQL, run it against a real engine.** `s3/testing/test-dialect-portability.js` is set up for this: SQLite runs in-memory with no setup, and MySQL/Postgres skip gracefully when unreachable.

```bash
# Start the engines (ports match test-migration-permissions.js)
docker run -d --name s3-test-postgres -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16-alpine
docker run -d --name s3-test-mysql -e MYSQL_ROOT_PASSWORD=root -p 3307:3306 mysql:8

node s3/testing/test-dialect-portability.js
node s3/testing/test-migration-bulk-types.js

docker rm -f s3-test-postgres s3-test-mysql
```

**A green run does not mean the dialect was tested.** These suites probe the engine and *skip* when it is unreachable, so with no container running they report all-pass having exercised SQLite alone — a confident green result for code that never touched the dialect your users deploy. Read the output: it must print `mysql reachable on 127.0.0.1:3307` and end with `0 skipped`. Any new dialect-parameterised suite must count skips separately from passes and print them distinctly (`⊘ … (skipped — engine unreachable)`); one that folds a skip into its pass count is broken as a test, whatever it claims to cover.

Quoting is the other half of this. MySQL parses `"double quotes"` as a **string literal**, not an identifier, so `SELECT * FROM "S3_GameStateEvents"` runs on SQLite and is unparseable on MySQL. Use `dbService.quoteIdentifier()` for every camelCase or mixed-case identifier in raw SQL — including inside test files, where this exact bug has already hidden.

The same rule covers **values**, not just identifiers. SQLite columns are typeless, so a mis-serialized value is accepted on write and only explodes on read — the Switch v5 backfill (2026-08-18) wrote `lastActiveTimestamp` as an integer epoch through Sequelize's untyped bulk API and every later `findByPk` died with `date.includes is not a function`, on SQLite alone. `test-migration-bulk-types.js` asserts the stored `typeof()` directly, which is the only way to see that failure before a player does.

Two conventions worth copying from that file:

- **Pin the defect, not just the fix.** Each fix has a companion test asserting the *old* form still fails on Postgres and still passes on SQLite/MySQL. That documents why the bug was invisible and fails loudly if an assumption changes.
- **Assert backward compatibility explicitly.** When changing emitted SQL, prove the new statement still works against data an older build created — otherwise the fix is an upgrade hazard for live servers.

> `sqlite3` will not install in the stock `node:*-slim` images (the prebuilt binding needs a newer glibc than they ship). Run the tests on the host, or build `sqlite3` from source in the container.

#### Permission-tier testing: a real engine still isn't enough

Running a real engine proves the SQL is valid. It does not prove the suite's chosen DB user can actually execute it — and `CREATE TABLE`/`ALTER TABLE`/`DROP` are gated by *different* MySQL privileges, so `CREATE`-but-not-`ALTER` is a normal least-privilege grant a DBA or shared host can hand an application, not a hypothetical. Code proven only under a fully-privileged (root/admin) connection is unproven for every operator running the tighter profile.

`test-migration-permissions.js` is the canonical home for this and owns four grant tiers, created idempotently on first use:

| Tier | Grant | Dialects | Expected outcome |
|---|---|---|---|
| `admin` | Full/root | SQLite, MySQL, Postgres | Everything succeeds |
| `readonly` | `SELECT` only | SQLite (Unix only — Windows can't express file-level read-only to SQLite), MySQL, Postgres | `CREATE TABLE` rejected |
| `no-ddl` | `SELECT/INSERT/UPDATE/DELETE` | MySQL, Postgres | `CREATE TABLE` rejected |
| `create-only` | `SELECT/INSERT/UPDATE/DELETE/CREATE/INDEX`, no `ALTER`/`DROP` | **MySQL only** | `CREATE TABLE` resolves; a bare `CREATE INDEX` resolves; `qi.addIndex()` (ALTER-based) is rejected |

`create-only` is the tier that matters most: `admin` has everything, `no-ddl` has no `CREATE` at all, and `readonly` has neither — none of the other three reproduces a restricted, CREATE-but-not-ALTER grant, which is a normal MySQL deployment shape. There is no Postgres `create-only` tier — confirmed empirically that a Postgres role granted only `CREATE` on a schema can still freely `ALTER`/`CREATE INDEX` on a table it just created, because ownership grants full DDL on owned objects independent of schema-level grants. That asymmetry is a property of MySQL's global per-user privilege model, not a general SQL one.

The practical fallout of the `create-only` tier is the §11.5 `Model.sync()`/`qi.addIndex()` trap below — a migration or model-sync path that only ever ran against `admin` or SQLite will pass every existing test and still fail to mount, every restart, on a server whose DB user is provisioned this way.

### 11.5 — Model Definition Traps

These are failure modes with no symptom at runtime — the code logs success and the data quietly goes missing.

- **Always use `defineModel()`, never `sequelize.define()` directly.** Only `defineModel()` registers the model into `dbService.models`, which is what `getModelNames()` returns, which is what the exporter enumerates. A raw-defined model works perfectly for reads and writes and is invisible to *every* export tier, including `--all`. Four tables were missing from production backups for months for exactly this reason.
- **`defineModel()` injects `freezeTableName: true`.** The **model** name becomes the table name unless you pass an explicit `tableName`. Model `S3GameStateEvents` reaching table `S3_GameStateEvents` only works because `tableName` says so. **Eleven models in this suite have a model name and a table name that are different strings, and the two are not interchangeable: `models:` in a migration registration takes the model name, `touches`/`creates` take the table name.** Writing either one in the other's place fails silently — a migration that `touches` a model name guards on a table that does not exist, so it either always runs or never does.

| Model name | Table name | Scope |
|---|---|---|
| `Elo_RoundHistory` | `Elo_RoundHistories` | `server-column` |
| `S3GameState` | `S3_GameState` | `server-key` |
| `S3GameStateEvents` | `S3_GameStateEvents` | `server-column` |
| `S3Locks` | `S3_Locks` | `global` |
| `S3PlayerEvents` | `S3_PlayerEvents` | `server-column` |
| `S3PlayerReconnect` | `S3_ServerReconnects` | `server-column` |
| `S3PlayerSnapshots` | `S3_PlayerSnapshots` | `server-column` |
| `S3SchemaVersions` | `S3_SchemaVersions` | `global` |
| `S3Servers` | `S3_Servers` | `global` |
| `S3_PlayerSession` | `S3_ServerSessions` | `server-column` |
| `SwitchPlugin_Settings` | `SwitchPlugin_ServerSettings` | `server-column` |

  The bottom three are the Phase-4 renames, where a primary key had to change and neither SQLite nor a grant without `ALTER` can alter one in place. The model name stayed put on purpose: it is what the export envelope and the import loop key on, so moving it would have orphaned every existing backup. The table moved because the DDL had to. Both halves are load-bearing and they point in opposite directions.
- **Declare `exportTier` on every model you define.** Classification lives at the definition site, not in `s3-export-import.js` — see 10.2. A model that declares nothing is exported at the default tier and warns by name at mount; an invalid tier throws immediately. The tier sets that remain in `s3-export-import.js` are the *expected classification fixture*, not the allowlist: `s3/testing/test-export-model-registration.js` asserts each model's declared tier equals its entry there, so adding a model means editing both, which is intended. Those sets hold **model names**, not table names — a table name written there matches nothing.
- **`Model.sync()` emits no DDL for an existing table without `alter`.** A newly added column then exists in the model and nowhere in the database. On a live server with no DDL grants the operator applies schema by hand, so a migration's *data* step must not be nested inside an `addColumn` guard — otherwise the data step is skipped on exactly the servers where the column already exists.
- **`Model.sync()` and `qi.addIndex()` both index a table via `ALTER TABLE ... ADD INDEX` — even a table they just created.** A MySQL grant with `CREATE`/`INDEX` but no `ALTER` (the `create-only` tier — see 11.4) accepts the `CREATE TABLE` and then throws on the first index, aborting model initialization before later tables are even attempted. This is not the same trap as the bullet above: that one is about existing tables missing a *column*; this one breaks on the very first mount of a brand-new table. Confirmed empirically 2026-08-28 against LoggingService (`s3/utils/logging-service.js`): create tables with `qi.createTable()`, then create each index with a bare `CREATE INDEX ... ON ...` statement (never `ALTER TABLE`/`addIndex()`) — `_ensureIndexes()` in that file is the reference pattern. Regression cover: `s3/testing/test-migration-permissions.js`'s `create-only` tier.
- **There is no CLS transaction context.** `withTransactionWithRetry(async (t) => …)` does not propagate `t` implicitly; every model call inside must receive `{ transaction: t }`. Miss one and SQLite's single-connection pool throws "cannot start a transaction within a transaction", usually into a catch that logs and continues.

### 11.6 — Pre-Push Checklist for Database Changes

A change that touches Sequelize, raw SQL, a model, a migration, or an export tier is not finished until all of these have actually been run:

1. `node --check` on every edited file.
2. `node testing/run-all-tests.js` (full, not `--fast`) — all five plugins green.
3. Both Docker engines up; dialect suites report `mysql reachable` and `0 skipped`.
4. The affected data read **back out of MySQL**, not only SQLite.
5. Table and column names resolved from a live `dbService` and confirmed to exist — the live MySQL user cannot create what is missing.
6. Ranking, query, and lifecycle changes replayed against a real production export rather than a fixture, so the shape of the data is the deployed one.
7. Deployed to a test server via `install.cjs` and the effect confirmed **in the database itself**, not in a log line claiming success. The `dev-harness` plugin drives the server for this — see [§11.7](#117--the-dev-harness-driving-a-real-server).

### 11.7 — The Dev Harness: Driving a Real Server

Step 7 of the §11.6 checklist says to confirm the effect on a running server. This
is the thing that does it, and it is the only way an agent (or anyone without the
game open) gets there — the standing rule is that nobody starts SquadJS or a Squad
server to test; the harness works against one already running.

`dev-harness/plugins/dev-rcon-harness.js` is **not part of the suite**. It is
deliberately absent from `install.cjs`'s plugin list, so `--plugin=all` can never
sweep it into a deploy; you install it by copying the one file into
`squad-server/plugins/` and adding a `DevRconHarness` block to `config.json`. Full
protocol in `dev-harness/README.md` — what follows is only what you need to reach
for it.

It watches a directory and gives back structured state:

```
dev-harness/
  inbox/       *.json   requests you write
  outbox/      *.json   results, same filename
  processed/   *.json   requests after they were claimed (audit)
  tape.jsonl            NEW_GAME / ROUND_ENDED / UPDATED_* timeline
```

**Stage, then rename.** Write `inbox/.stage-1.json` and rename it to `inbox/1.json`
— dot-prefixed files are skipped by the scanner, so the plugin can never read a
half-written request. The inbox is polled rather than `fs.watch`ed, because watch
drops and duplicates events on Windows.

```json
{
  "token": "<the token in config.json>",
  "commands": ["AdminChangeLayer Fallujah_RAAS_v2"],
  "discord": ["gamestate"],
  "snapshot": true
}
```

Three things worth knowing before you use it:

- **`"discord"` runs `!s3` subcommands against the live plugin with a capturing
  sender** — the embed lands in the result file and is never posted to a channel.
  The default allowlist is `status`, `services`, `gamestate`, `factions`,
  `players`. Mutating subcommands are deliberately excluded: they need a
  `watchManager`/`stagedImportRef` that the stub context cannot supply, which is
  also why `!s3 db import` staging has no harness coverage and is unit-tested
  instead.
- **`readOnly: true` makes it safe on the live server.** The tape still records;
  no code path from disk to RCON exists. This matters because `resolving` clears
  on a player-info tick, so its real timing only exists at real population — the
  tape captures the `NEW_GAME → tick → resolving:false` ordering as structured
  JSON, which verbose logs do not.
- **Omit `commands` entirely for a pure read** — a snapshot with no RCON traffic.

`AdminBan` and `AdminKick` are **not** in the default `allowedCommands`. A map
roll takes roughly a minute; poll the tape rather than assuming an immediate
result. And the harness cannot conjure players — anything gated on a populated
roster still needs bodies, which is what tape-only mode on the live server is for.

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
| `overrideServerID` | number | `null` | Overrides the SquadJS server `id` for S³ only. The escape hatch for two installs that both ship `"id": 1` and cannot be renumbered without disturbing rows other plugins wrote. Refused at mount if it is not a whole number of 1 or more, or is wider than 11 characters — round keys are written as `<serverID>-<8 characters>` into a 20-character column |
| `forceServerClaim` | boolean | `false` | Claim this server id even when another process appears to be live under it. The escape hatch for a false positive: a legitimate port change plus a restart inside the two-minute freshness window is indistinguishable from a second install writing under the same id, and without this the suite refuses to come up until the window passes. Turn it back off once the server is up — while it is set, nothing stops two communities interleaving their data |
| `discordClient` | connector | `'discord'` | Discord connector (null to disable) |
| `channelID` | string | `''` | Admin channel for `!s3` commands |
| `configPath` | string | `'./SquadGame/ServerConfig/'` | Server.cfg directory |
| `ignoredGameModes` | string[] | `['Seed', 'Jensen']` | Modes gated by `isIgnoredMode()` |
| `enableClanTagGrouping` | boolean | `true` | Enable clan grouping |
| `minClanGroupSize` | number | `2` | Minimum clan group size |
| `maxClanGroupSize` | number | `18` | Maximum clan group size |
| `clanTagMaxEditDistance` | number | `1` | Damerau-Levenshtein distance for merging similar tags (adjacent-character transpositions count as 1 edit) |
| `clanTagMinMergeLength` | number | `4` | Minimum normalized tag length eligible for Damerau-Levenshtein merging; shorter tags require an exact match |
| `clanTagCaseSensitive` | boolean | `false` | If false, tags are normalised before grouping |
| `clanTagIgnoreList` | array | `[]` | Tags excluded from grouping |
| `clanRecruitSuffixes` | array | `["r", "-r"]` | Suffixes to strip from clan tags when the base tag (without suffix) exists on other players. Enabled by default for common recruit tags (case-insensitive, so "R" and "-R" are also matched). Set to `[]` to disable. Stripping only occurs when the base tag is present on at least one other player in the data set. |
| `clanGroupingPullEntireSquads` | boolean | `true` | Pull full squads when preserving clan groups |
| `enableDatabaseLogging` | boolean | `true` | Enable `S3_PlayerEvents`/`S3_GameStateEvents`/`S3_PlayerSnapshots` tables. `false` → LoggingService runs no-op. |
| `enableFileLogging` | boolean | `false` | Mirror each DB log write as a JSONL line at `logPath` |
| `logPath` | string | `'./s3-log.jsonl'` | JSONL mirror path, used only when `enableFileLogging` is true |
| `autoMigrate` | boolean | `false` | Auto-apply migrations without Discord confirmation |
| `language` | string | `'en'` | Language for all S³ plugin messages. Available: `en`, and `pt` as a partial catalogue — untranslated keys fall back to `en` individually, so a partial language renders as a mix. Set here only — every consumer plugin inherits it and none has a `language` option of its own. Unknown codes fall back to `en` with a warning. See `s3/LOCALIZATION.md` |
| `stderrDiagnostics` | string | `'off'` | `'off'` / `'mirror'` / `'auto'` — mirror S³ failures to fd 2. See §9.9 |
| `stderrDedupeWindowSeconds` | number | `60` | Identical stderr events inside the window are counted, not written. See §9.9 |

### 12.4 — File Placement

Do not hand-copy. `install.cjs` assembles the selected plugins into an `out/`
folder matching SquadJS's `squad-server/` layout:

```powershell
node install.cjs --plugin=all --output="<path>\SquadJS\squad-server" --force
```

It **flattens** every plugin's `plugins/` and `utils/` into two directories, so
`s3/utils/db-service.js` and `elo-tracker/utils/elo-database.js` end up siblings.
Never pass `--clean` at a real SquadJS install — it wipes the target, including
SquadJS's own core plugins.

**Import path rule:** Always use sibling relative imports (`'./s3-plugin-base.js'`),
never a path with directory depth (`'../s3/plugins/...'`). Depth that resolves in
this source tree will not resolve in the flattened output, and vice versa — which
is also why a consumer plugin's utils must not import S³ internals directly.

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

Each plugin lives at `<plugin-name>/plugins/<plugin-name>.js` in this repo — e.g.
`smart-assign/plugins/smart-assign.js`, `elo-tracker/plugins/elo-tracker.js`.

---

> *Developer Guide — documents the S³ architecture as of 2026-08-20.*
