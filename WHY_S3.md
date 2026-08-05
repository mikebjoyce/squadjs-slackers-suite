# Why S³? — Migrating from Standalone Plugins to the Slackers Suite

> **TL;DR:** The S³ suite is the same [EloTracker](https://github.com/mikebjoyce/squadjs-elo-tracker), [TeamBalancer](https://github.com/mikebjoyce/squadjs-team-balancer), [SmartAssign](https://github.com/mikebjoyce/squadjs-smart-assign), and [Switch](https://github.com/mikebjoyce/squadjs-switch-teambalancer-aware) plugins you already use — rebuilt on a shared service layer that eliminates duplicated code, prevents race conditions between plugins, and unlocks features that were architecturally impossible in standalone mode. All features have been ported forward. Nothing has been lost, only gained.

---

## The Problem with Standalone Plugins

The legacy plugins started as independent projects, each solving one problem well. But as the plugin suite grew, so did the cracks:

### Duplicated Systems Everywhere

Each plugin needed the same foundational logic — and each maintained its own copy:

- **Clan tag detection** was implemented independently in three of the four plugins — EloTracker, TeamBalancer, and SmartAssign each had their own clan-tag parser (`sa-clan-grouper.js`, `tb-clan-grouping.js`, etc.). A bug fix or improvement in one had to be manually ported to the others.
- **Player state tracking** — join times, team assignments, reconnect detection — was rebuilt in each plugin, often with subtle behavioral differences. Both SmartAssign and Switch independently implemented the same delta-diff pattern on `UPDATED_PLAYER_INFORMATION`, each maintaining their own `Map(eosID → state)` and competing for the same SquadJS event.
- **Database access and schema management** was bootstrapped from scratch per plugin, with no shared migration pipeline.
- **Faction and game-state resolution** (which team is which? what round phase are we in?) was duplicated across the codebase.
- **Services like server configuration parsing and centralized logging** were too complex to justify reimplementing per plugin — S³ was the moment to build them once.

The result: a fix in clan detection meant three separate PRs, three test suites to update, and three release cycles. Drift between implementations was inevitable.

### Ad-Hoc Cross-Plugin Communication

Plugins that needed to coordinate did so via raw SquadJS event strings — `TEAM_BALANCER_SCRAMBLE_EXECUTED` — with no type safety, no delivery guarantees, and no concept of priority or locking. A Switch plugin listening for a scramble event had no way to know whether SmartAssign was mid-move on the same player. There was no mechanism to say "wait your turn."

### No Shared Locking — Operation Windows Were Artificially Narrow

The `teamID` null window at the start of every round (first ~30–90 seconds, where `teamID` is `null` for most players) meant SmartAssign couldn't safely assign players and Switch couldn't process `!switch` commands — neither plugin knew what team anyone was on. The legacy answer was to simply block all team changes during this window, forcing players to wait minutes while the server filled.

S³'s PlayersService resolved the null window, but that created new risks: SmartAssign could now move players during end-game phases where TeamBalancer was scrambling, and both SmartAssign and Switch were independently debouncing `UPDATED_PLAYER_INFORMATION` with their own player-state tracking — two plugins competing on the same SquadJS event, each reinventing the same delta-diff pattern. The solution required a priority-based locking system that didn't exist in the standalone architecture.

### The Server Config Change That Changed Everything

Server admins who blocked the game's built-in team-switch UI (via server configuration) created a new reality: the `!switch` command was now the **only** way for players to change teams. Without a queue, players would spam `!switch` to out-compete each other — hardly fairer than the native team-change UI they'd just disabled. A **switch queue** that automatically paired players with partners and moved them when a slot opened was the only fair alternative. They also needed **liberal mode** for seed/training layers where normal restrictions didn't apply, and **dynamic balance tolerance** so the server wasn't locked down at low population.

Building a queue-based switch plugin requires fast, accurate player-state tracking — you need to know who just joined, who just left, and who just changed teams within seconds, not the ~30-second RCON poll cycle that the legacy plugins relied on. S³'s PlayersService provides this: per-tick player diffs, immediate join/leave/team-change events, and reconnect memory. The queue, liberal mode, and dynamic balance features simply couldn't function reliably without it.

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

### The Switch Plugin Leveled Up

Because the server config blocks the game's built-in team-switch UI, `!switch` is the only way for players to change teams. The legacy Switch provided basic cooldown-based switching and double-switch for bug fixes. The S³ version adds features that only became possible with shared player-state tracking:

- **Switch Queue**: When a balance slot isn't immediately available, players queue and are automatically switched when a partner or slot opens. This required S³'s fast per-tick player diffs — the ~30-second RCON poll cycle in the legacy architecture was too slow to drive a responsive queue.
- **Liberal Mode**: Relaxed switching rules during Seed/Jensen rounds. Reads layer/gamemode from S³'s GameState service rather than maintaining its own detection.
- **Dynamic Balance Tolerance**: Interpolated extra imbalance slots when the server is below full capacity. Driven by S³'s live player counts.

Existing features (double-switch, end-of-match switching) are now S³-aware — team-change attribution goes through `players.recordMove()`, cooldowns are tracked via the shared DB, and all actions check `canAct()` to defer during scrambles and SmartAssign moves. The ad-hoc `_saEvalLocks` / custom event wiring is replaced by a single priority-aware gate.

---

## What You Gain

### Feature Comparison at a Glance

| Capability | Legacy (Standalone) | S³ Suite |
|------------|---------------------|----------|
| **Clan tag detection** | 3 independent implementations | 1 shared implementation in S³ ClansService |
| **Cross-plugin locking** | None — race conditions possible | Priority-based global + per-player locks |
| **Scramble coordination** | Ad-hoc event string | Global lock blocks SA & Switch during scramble |
| **SmartAssign → Switch handshake** | Not possible | Switch reads SA locks via `canAct()` |
| **Switch queue** | Not available | Queue driven by S³ player events (`S3_PLAYER_JOINED`/`LEFT`) |
| **Dynamic balance tolerance** | Not available | Interpolated extra slots via S³ live player counts |
| **Liberal/Seed mode** | Not available | Reads layer/gamemode from S³ GameState service |
| **Double-switch** | Standalone cooldown tracking | S³-aware with proper team-change attribution |
| **End-of-match switches** | Basic slot count | Queue driven by S³ round-phase awareness |
| **Reconnect memory** | Per-plugin | Shared via S³ PlayersService |
| **DB migrations** | Manual per-plugin | Unified MigrationEngine with versioning & rollback |
| **Schema drift protection** | None | `_checkS3Version()` enforces compatibility at mount |
| **Plugin mount order** | Ad-hoc | S³-first guarantee with readiness gating |
| **Testing** | Per-plugin | Per-plugin + S³ integration test suite |

### Plugin-Specific Gains

**EloTracker** ([readme](elo-tracker/README.md)) — Same TrueSkill engine, now with shared clan detection, shared player reconnect memory, and S³'s migration pipeline for schema changes.

**TeamBalancer** ([readme](team-balancer/README.md)) — Same scramble algorithm, now with global-lock coordination (SA and Switch are properly blocked during scramble execution), shared clan grouping via S³, and unified DB management.

**SmartAssign** ([readme](smart-assign/README.md)) — Same Elo-aware assignment and One-Hit & Verify RCON approach, now with per-player locking that prevents Switch from racing on the same player, S³-driven reconnect memory (no more standalone `sa-database.js`), and shared clan grouping (replacing the legacy `sa-clan-grouper.js`).

**Switch** ([readme](switch/README.MD)) — Expanded from the legacy version with switch queue, liberal mode, and dynamic balance tolerance — features that required S³'s fast per-tick player-state tracking. Double-switch is now S³-aware with proper team-change attribution. Lock-awareness via `canAct()` replaces ad-hoc SA eval events, so Switch automatically defers during TeamBalancer scrambles and SmartAssign moves.

---

## What You Don't Lose

Every feature from the legacy standalone plugins has been ported forward:

- All configuration options are preserved (with additions — nothing removed). For example, if your legacy TeamBalancer config had `"maxWinStreak": 2` and `"scramblePercentage": 0.5`, those same keys work identically in the S³ version.
- Database schemas are compatible; the MigrationEngine handles upgrades automatically on first mount.
- All Discord commands, RCON broadcasts, and admin workflows continue to work identically.
- The scramble algorithm, TrueSkill engine, and assignment logic are the same battle-tested implementations.
- Plugin-to-plugin integration (TB ↔ Switch, TB ↔ EloTracker, SA ↔ EloTracker) is preserved and strengthened.

There is no regression. The S³ versions are strict supersets of the legacy plugins.

---

## The Maintenance Story

For contributors and server admins who maintain forks or custom configs:

- **One repo instead of four.** All plugins live in a single monorepo. Instead of cloning four separate repos and manually copying `plugins/` and `utils/` directories into your SquadJS installation, a single `node install.cjs --plugin=all` assembles everything with collision detection.
- **Shared services = one fix, four wins.** A bug fix in clan tag detection benefits EloTracker, TeamBalancer, SmartAssign, and Switch simultaneously.
- **Unified migration pipeline.** Schema changes are versioned, reversible, and applied automatically — no more manual SQL scripts per plugin.
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
- [Switch](switch/README.MD) — Cooldowns, queue size, double-switch, liberal mode
- [EloTracker](elo-tracker/README.md) — TrueSkill parameters, leaderboard thresholds
- [TeamBalancer](team-balancer/README.md) — Win streak thresholds, scramble timing, Elo weighting

### Database

On first mount, the MigrationEngine automatically detects your existing schema and applies any needed upgrades. No manual migration steps are required. Backups are handled through S³'s built-in backup/restore system (`!s3 backup`, `!s3 restore`).

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
| **TeamBalancer** | [squadjs-team-balancer](https://github.com/mikebjoyce/squadjs-team-balancer) (v3.2.0) | [team-balancer/](team-balancer/) (v4.0.3) |
| **Switch** | [squadjs-switch-teambalancer-aware](https://github.com/mikebjoyce/squadjs-switch-teambalancer-aware) | [switch/](switch/) (v2.1.3) |
| **EloTracker** | [squadjs-elo-tracker](https://github.com/mikebjoyce/squadjs-elo-tracker) (v1.3.0) | [elo-tracker/](elo-tracker/) (v2.x) |
| **SmartAssign** | [squadjs-smart-assign](https://github.com/mikebjoyce/squadjs-smart-assign) (v1.1.1) | [smart-assign/](smart-assign/) (v2.x) |
| **S³** | — (no legacy equivalent) | [s3/](s3/) (v1.0+) |

**Suite monorepo:** [github.com/mikebjoyce/squadjs-slackers-suite](https://github.com/mikebjoyce/squadjs-slackers-suite)
