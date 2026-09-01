# Why S³? — Migrating from Standalone Plugins to the Slackers Suite

> **TL;DR:** The S³ suite is the same [EloTracker](https://github.com/mikebjoyce/squadjs-elo-tracker), [TeamBalancer](https://github.com/mikebjoyce/squadjs-team-balancer), [SmartAssign](https://github.com/mikebjoyce/squadjs-smart-assign), and [Switch](https://github.com/mikebjoyce/squadjs-switch-teambalancer-aware) plugins you already use — rebuilt on a shared service layer that eliminates duplicated code, prevents race conditions between plugins, and unlocks features that were architecturally impossible in standalone mode. All features have been ported forward. Nothing has been lost, only gained.

---

## The Problem with Standalone Plugins

The legacy plugins started as independent projects, each solving one problem well. But as the plugin suite grew, so did the cracks:

### Duplicated Systems

Each plugin needed the same foundational logic — and each maintained its own copy:

- **Clan tag detection** was implemented independently in three of the four plugins — EloTracker, TeamBalancer, and SmartAssign each had their own clan-tag parser (`sa-clan-grouper.js`, `tb-clan-grouping.js`, etc.). A bug fix or improvement in one had to be manually ported to the others.
- **Player state tracking** — join times, team assignments, reconnect detection — was rebuilt in each plugin, often with subtle behavioral differences. Both SmartAssign and Switch independently implemented the same delta-diff pattern on `UPDATED_PLAYER_INFORMATION`, each maintaining their own `Map(eosID → state)` and competing for the same SquadJS event.
- **Database access and schema management** was bootstrapped from scratch per plugin, with no shared migration pipeline.
- **Faction and game-state resolution** (which team is which? what round phase are we in?) was duplicated across the codebase.
- **Services like server configuration parsing and centralized logging** were too complex to justify reimplementing per plugin — S³ was the moment to build them once.

The result: a fix in clan detection meant three separate PRs, three test suites to update, and three release cycles. Drift between implementations was inevitable.

### Ad-Hoc Cross-Plugin Communication

Plugins that needed to coordinate did so via raw SquadJS event strings — `TEAM_BALANCER_SCRAMBLE_EXECUTED` — with no type safety and no delivery guarantees. Legacy Switch did listen for this event and applied a time-based scramble lockdown to affected players, so scramble coordination existed in coarse form. But there was no per-player lock and no priority system: a Switch plugin had no way to know whether SmartAssign was mid-move on a *specific* player right now, only whether a scramble had recently happened.

### No Shared Locking

The `teamID` null window at the start of every round (first ~30–90 seconds, where `teamID` is `null` for most players) meant SmartAssign couldn't safely assign players and Switch couldn't process `!switch` commands — neither plugin knew what team anyone was on. Legacy SmartAssign handled this with its own `resolving` phase that waited (up to ~30 seconds, by its own code comments) for 100% team resolution before resuming assignment decisions.

S³ improves on this with **null-teamID projection**: instead of just waiting out the window, `PlayersService` serves best-effort projected team data during it, so plugins don't have to block at all. That, in turn, surfaced a new risk: SmartAssign could now move players during end-game phases where TeamBalancer was scrambling, and both SmartAssign and Switch were independently debouncing `UPDATED_PLAYER_INFORMATION` with their own player-state tracking — two plugins competing on the same SquadJS event, each reinventing the same delta-diff pattern. The solution required a priority-based locking system that didn't exist in the standalone architecture.

### Switch-Only Servers

Server admins who blocked the game's built-in team-switch UI (via server configuration) created a new reality: the `!switch` command was now the **only** way for players to change teams. But legacy Switch had no self-service queue for the ordinary case: if `!switch` was denied because the balance slots were full, the player was just told "Teams would become too unbalanced" and had to retry manually. (Legacy did have an admin-only `matchend`/`matchendsquad` command that registered a player or squad in an `Endmatch` table for a one-time switch applied when the round ended — but that's an admin tool operators used to pre-schedule a switch, not a queue players fell into automatically.) Without an automatic queue, players would spam `!switch` to out-compete each other for the next open slot — hardly fairer than the native team-change UI they'd just disabled.

A queue that reacts mid-match — pairing waiting players and moving them the moment a slot opens, without an admin having to register them first — needs fast, accurate player-state tracking: who just joined, who just left, who just changed teams, within seconds, not the ~30-second RCON poll cycle the legacy plugin polled on its own. S³'s PlayersService provides this: per-tick player diffs, immediate join/leave/team-change events, and reconnect memory. That's what made a genuine self-service switch queue possible. Liberal mode and dynamic balance tolerance already existed standalone and needed no such upgrade — liberal mode now reads layer/gamemode from S³'s GameState service instead of local detection, but dynamic balance tolerance is essentially unchanged.

---

## What S³ Changes

### Centralized Service Container

S³ (SlackersSquadServices) owns the ground truth for all shared state:

| Service | Owns |
|---------|------|
| **gameState** | Round phase tracking, layer/gamemode, crash recovery |
| **players** | Player registry, team-change attribution, reconnect memory, locking |
| **clans** | Clan tag extraction & grouping — implemented once, used by all |
| **factions** | Team/faction identification from kit role strings |
| **serverConfig** | Squad server configuration parsing |
| **db** | Sequelize connector, migration engine, schema versioning |
| **logging** | Centralized player/state event logging |

Consumer plugins read from S³ — they do not maintain duplicate caches. Services mount in dependency order:

```
serverConfig → db → gameState → factions → clans → players → logging
```

A bug fix in clan detection benefits all four plugins simultaneously. A new feature in player tracking is instantly available to every consumer.

### Per-Player Locking with Priority

Every team-change action goes through S³'s `PlayersService` lock system:

| Priority | Plugin | Role |
|----------|--------|------|
| **3** | TeamBalancer | Holds **global lock** during scrambles — blocks all lower-priority `canAct()` |
| **2** | SmartAssign | Acquires **per-player lock** before RCON, releases on success/failure |
| **1** | Switch | Checks `canAct()` before processing any `!switch` command |

- **Global lock**: When TeamBalancer initiates a scramble, it acquires a global lock. SmartAssign and Switch cannot act on any player until the scramble completes.
- **Per-player lock**: SmartAssign locks individual players during active moves. Switch sees the lock and queues or defers.
- **`canAct()` gate**: A non-mutating check available to all plugins. Before touching a player, check if anyone higher-priority has claim.

Race conditions between SmartAssign and Switch are now architecturally impossible. The priority system ensures TeamBalancer always wins, SmartAssign always wins over Switch, and no two plugins can simultaneously move the same player.

### Capabilities Standalone Plugins Couldn't Have

Most of what S³ does is deduplication — one implementation instead of three. But a few things weren't just duplicated pre-S³, they were **out of reach for a standalone plugin no matter how it was written**, because they require a shared source of truth that only a central service can hold:

- **Team-change attribution.** SquadJS's `PLAYER_TEAM_CHANGE` event carries no source flag — there's no way to tell whether a change was a player's own `!switch`, a SmartAssign move, or a TeamBalancer scramble. A standalone plugin could only disambiguate this by having another specific plugin emit its own custom marker event for it to listen for — a pairwise, hand-wired arrangement that doesn't scale and can't include a plugin nobody has written yet. S³'s `players.recordMove()` is a single shared attribution point: every consumer calls the same method, every consumer (including third-party ones) can read the same answer.
- **Third-party lock participation.** Legacy had no locking primitive at all — not even between the four official plugins, let alone for an outside plugin to hook into. S³'s `players.registerPriority('MyPlugin', 4)` lets any plugin join the same coordinated priority system SmartAssign, Switch, and TeamBalancer use. There was nothing standalone architecture could offer here; the primitive didn't exist to extend.
- **Cross-plugin reconnect visibility.** Legacy SmartAssign's reconnect memory was already DB-backed and survived restarts — persistence wasn't the gap. The gap was that it was SmartAssign's alone; TeamBalancer, Switch, and EloTracker had no way to see a reconnect SmartAssign had already recorded. S³'s `players.rememberReconnect()` / `getReconnect()` is shared across every consumer, so one plugin's observation becomes every plugin's knowledge.
- **One believed team during the null-teamID window.** SmartAssign's legacy `resolving` phase shows a single plugin could reason carefully about the post-`NEW_GAME` null-teamID window on its own. But with two plugins each guessing independently, nothing guaranteed they'd guess the *same* thing for the same player — there was no shared answer to check against, only two separate correct-in-isolation guesses that could still disagree. S³'s null-teamID projection gives every consumer the same canonical answer at the same moment, closing a disagreement window that persisted even when each plugin's own logic was sound.

### S³ Event Bus

Typed, documented events replace ad-hoc strings:

| Event | When |
|-------|------|
| `S3_ROUND_LIVE` | STAGING → LIVE transition |
| `S3_PLAYER_JOINED` | New player registered |
| `S3_PLAYER_LEFT` | Player dropped from registry |
| `S3_PLAYER_TEAM_CHANGED` | Team change detected via tick diff |
| `S3_PLAYER_RECONNECTED` | Returning player matched against reconnect memory |
| `S3_PLAYERS_UPDATED` | End of every player-information tick |
| `S3_PLAYER_LOCK_CHANGED` | Per-player lock acquired or expired |
| `S3_GLOBAL_LOCK_CHANGED` | Global lock acquired or cleared |

Plus subscription callbacks on each service (e.g., `onGamePhaseChange`, `onPlayerDataChanged`) with proper unsubscribe lifecycle — no more guessing when to clean up listeners.

### Switch Plugin Changes

Because the server config blocks the game's built-in team-switch UI, `!switch` is the only way for players to change teams. The legacy Switch already had cooldown-based switching, double-switch, an admin-only match-end switch command, liberal mode, and dynamic balance tolerance. The S³ version upgrades these and adds a genuine self-service queue that legacy never had:

- **Switch Queue**: Legacy had no automatic queue for a denied player — `!switch` was simply rejected ("Teams would become too unbalanced") and the player had to retry manually. (Legacy's separate `matchend`/`matchendsquad` commands let an admin register a player or squad for a one-time switch at round end — an admin scheduling tool, not a player-facing queue.) The S³ version is a real queue: players are automatically paired and switched (or given a solo slot) as soon as a slot opens *during* the match, driven by S³'s per-tick `S3_PLAYERS_UPDATED` events, with no admin action required.
- **Liberal Mode**: Existed standalone, detecting Seed/Jensen layers via its own tracking. The S³ version reads layer/gamemode from S³'s GameState service instead of maintaining separate detection logic.
- **Dynamic Balance Tolerance**: Existed standalone already, essentially unchanged — both versions read player count straight from `this.server.players`; nothing about the interpolation math needed S³. The only real delta is the upper-bound player cap, which now comes from S³'s serverConfig (`getMaxPlayers() - getNumReservedSlots()`) instead of a hardcoded 98.

Existing features (double-switch, admin match-end switching) are now S³-aware — team-change attribution goes through `players.recordMove()`, cooldowns are tracked via the shared DB, and all actions check `canAct()` to defer during scrambles and SmartAssign moves. The ad-hoc `_saEvalLocks` / custom event wiring is replaced by a single priority-aware gate.

---

## Feature Comparison

### Legacy vs. S³

| Capability | Legacy (Standalone) | S³ Suite |
|------------|---------------------|----------|
| **Clan tag detection** | 3 independent implementations | 1 shared implementation in S³ ClansService |
| **Cross-plugin locking** | None — race conditions possible | Priority-based global + per-player locks |
| **Scramble coordination** | Ad-hoc event string + time-based lockdown | Global lock blocks SA & Switch during scramble |
| **SmartAssign → Switch handshake** | Not possible | Switch reads SA locks via `canAct()` |
| **Switch queue** | None (denied instantly; admin-only match-end command exists separately) | Live self-service queue driven by S³ player events (`S3_PLAYER_JOINED`/`LEFT`) |
| **Dynamic balance tolerance** | Standalone, identical math | Unchanged, except player cap now sourced from S³ serverConfig |
| **Liberal/Seed mode** | Standalone, local layer detection | Reads layer/gamemode from S³ GameState service |
| **Double-switch** | Standalone cooldown tracking | S³-aware with proper team-change attribution |
| **End-of-match switches** | Admin-only DB-backed command (`matchend`/`matchendsquad`), local `ROUND_ENDED` handling | Same admin command, now reading round/phase state from S³'s GameState service instead of local tracking |
| **Reconnect memory** | Per-plugin | Shared via S³ PlayersService |
| **DB migrations** | Manual per-plugin | Unified MigrationEngine with versioning & rollback |
| **Schema drift protection** | None | Every mount re-checks the live database against what migrations declared, and repairs schema that has gone missing |
| **Plugin/container compatibility** | None | `_checkS3Version()` fails a plugin that needs a newer S³ than is installed, instead of half-working |
| **Plugin mount order** | Ad-hoc | S³-first guarantee with readiness gating |
| **Testing** | Per-plugin | Per-plugin + S³ integration test suite |

### Per-Plugin Changes

**EloTracker** ([readme](elo-tracker/README.md)) — Same TrueSkill engine, now with shared clan detection, shared player reconnect memory, and S³'s migration pipeline for schema changes.

**TeamBalancer** ([readme](team-balancer/README.md)) — Same scramble algorithm, now with global-lock coordination (SA and Switch are properly blocked during scramble execution), shared clan grouping via S³, and unified DB management.

**SmartAssign** ([readme](smart-assign/README.md)) — Same Elo-aware assignment and One-Hit & Verify RCON approach, now with per-player locking that prevents Switch from racing on the same player, S³-driven reconnect memory (no more standalone `sa-database.js`), and shared clan grouping (replacing the legacy `sa-clan-grouper.js`).

**Switch** ([readme](switch/README.md)) — Same cooldown-based switching, double-switch, liberal mode, and dynamic balance tolerance (dynamic balance tolerance is essentially untouched — same math, same local player count), plus a genuine self-service switch queue that legacy never had (legacy just denied `!switch` outright when slots were full; its `matchend` commands were an admin scheduling tool, not a queue). Liberal mode now reads layer/gamemode from S³'s GameState service instead of local detection. Double-switch is now S³-aware with proper team-change attribution. Lock-awareness via `canAct()` replaces the ad-hoc scramble-lockdown event, so Switch automatically defers during TeamBalancer scrambles and SmartAssign moves.

---

## Backward Compatibility

Every feature from the legacy standalone plugins has been ported forward:

- All configuration options are preserved (with additions — nothing removed). For example, if your legacy TeamBalancer config had `"maxWinStreak": 2` and `"scramblePercentage": 0.5`, those same keys work identically in the S³ version.
- Database schemas are compatible; the MigrationEngine works out which upgrades your database needs on first mount and applies them once you confirm in Discord (or immediately, if you set `autoMigrate: true`).
- All Discord commands, RCON broadcasts, and admin workflows continue to work identically.
- The scramble algorithm, TrueSkill engine, and assignment logic are the same battle-tested implementations.
- Plugin-to-plugin integration (TB ↔ Switch, TB ↔ EloTracker, SA ↔ EloTracker) is preserved and strengthened.

There is no regression. The S³ versions are strict supersets of the legacy plugins.

---

## Maintenance Impact

For contributors and server admins who maintain forks or custom configs:

- **One repo instead of four.** All plugins live in a single monorepo. Instead of cloning four separate repos and manually copying `plugins/` and `utils/` directories into your SquadJS installation, a single `node install.cjs --plugin=all` assembles everything with collision detection.
- **Shared services = one fix, four wins.** A bug fix in clan tag detection benefits EloTracker, TeamBalancer, SmartAssign, and Switch simultaneously.
- **Unified migration pipeline.** Schema changes are versioned and reversible, applied in order behind a Discord confirmation, with a backup taken first — no more manual SQL scripts per plugin.
- **Runtime compatibility enforcement.** Every consumer plugin checks its S³ version at mount time and refuses to start if incompatible. No silent degradation, no mystery bugs from version mismatch.
- **Coherent test suite.** S³ integration tests validate cross-plugin locking, event delivery, and mount-order behavior — scenarios that couldn't be tested in the standalone architecture.

---

## Migration Path

### Quick Start

```bash
git clone https://github.com/mikebjoyce/squadjs-slackers-suite.git
cd squadjs-slackers-suite
node install.cjs --plugin=all
```

This produces an `out/` folder with the correct `plugins/` and `utils/` layout. Copy its contents into your SquadJS `squad-server/` folder.

### Mount Order

In your SquadJS `config.json`, S³ **must** appear before any consumer plugin:

```json
{
  "plugins": [
    { "plugin": "SlackersSquadServices", "enabled": true, ... },
    { "plugin": "SmartAssign", "enabled": true, ... },
    { "plugin": "Switch", "enabled": true, ... },
    { "plugin": "EloTracker", "enabled": true, ... },
    { "plugin": "TeamBalancer", "enabled": true, ... }
  ]
}
```

### Configuration

Most config options map 1:1 from the legacy plugins. Check each plugin's README for the full option reference:

- [S³](s3/README.md) — Discord channel, database connector
- [SmartAssign](smart-assign/README.md) — Team selection method, Elo thresholds, clan grouping
- [Switch](switch/README.md) — Cooldowns, queue size, double-switch, liberal mode
- [EloTracker](elo-tracker/README.md) — TrueSkill parameters, leaderboard thresholds
- [TeamBalancer](team-balancer/README.md) — Win streak thresholds, scramble timing, Elo weighting

### Database

On first mount, the MigrationEngine detects your existing schema and works out which upgrades it needs. It posts what it intends to do to your admin channel and waits for `!s3 confirm <token>`; set `autoMigrate: true` in the S³ config if you would rather it just run. Either way it takes a backup before touching anything, and re-checks afterwards that the schema it expected is really there. No hand-written SQL is required. Backups are managed through `!s3 backup list` / `create` / `restore`.

---

## For Plugin Developers

If you're building or maintaining SquadJS plugins, see the **[S³ Developer Guide](s3/S3_DEVELOPER_GUIDE.md)** for the service catalog, access patterns, base classes, event model, subscription callbacks, migration workflow, and integration checklist.

Third-party plugins can register custom locking priorities via `players.registerPriority('MyPlugin', 4)` and participate in the same coordinated locking system as the built-in plugins.

---

*Current as of August 2026 — covering S³ v1.0+, EloTracker v2.x, TeamBalancer v4.x, SmartAssign v2.x, Switch v2.x.*

---

## References

| Plugin | Legacy (Standalone) | S³ Suite |
|--------|---------------------|----------|
| **TeamBalancer** | [squadjs-team-balancer](https://github.com/mikebjoyce/squadjs-team-balancer) (v3.2.2) | [team-balancer/](team-balancer/) (v4.1.0) |
| **Switch** | [squadjs-switch-teambalancer-aware](https://github.com/mikebjoyce/squadjs-switch-teambalancer-aware) | [switch/](switch/) (v2.5.6) |
| **EloTracker** | [squadjs-elo-tracker](https://github.com/mikebjoyce/squadjs-elo-tracker) (v1.3.0) | [elo-tracker/](elo-tracker/) (v2.x) |
| **SmartAssign** | [squadjs-smart-assign](https://github.com/mikebjoyce/squadjs-smart-assign) (v1.1.1) | [smart-assign/](smart-assign/) (v2.x) |
| **S³** | — (no legacy equivalent) | [s3/](s3/) (v1.0+) |

**Suite monorepo:** [github.com/mikebjoyce/squadjs-slackers-suite](https://github.com/mikebjoyce/squadjs-slackers-suite)
