# SmartAssign Plugin v2.0.0

**Elo-Aware Auto Assignment & Player Lifecycle Logger**

## Overview

This plugin overrides Squad's native team assignment mechanics to provide smart, fair, and fast team placements. When a player connects, the plugin evaluates the current Elo distribution and population difference between both teams and assigns the player to whichever team produces the most balanced match. All team changes are executed via RCON using a One-Hit & Verify approach, with a hard 3-second timeout ensuring predictable behaviour.

The core timing challenge — Squad's RCON player list only refreshes every ~30 seconds — is solved by triggering the RCON move command directly from the Log Parser event (which fires within ~100ms of join), and then force-polling the player list after the command lands to verify the result. This approach typically achieves verified join-swaps in 1–2 seconds, with a hard 3-second completion guarantee.

Disconnect detection works via delta-diff: every time any player joins and triggers a forced RCON refresh, the player list is compared against the known state, which catches departures from other players as a side-effect — effectively solving disconnect lag without relying on the unreliable `PLAYER_DISCONNECTED` log event.

---

## Core Features

* **Sub-2s Verified Join Swaps**: Uses Log-Driven triggering + One-Hit & Verify to move players within ~1s of joining, verified against a fresh RCON poll.
* **Strict Population Balance**: Dynamically adjusts the allowed team population difference based on total player count, enforcing a strict 1-player max difference at high population.
* **Reconnect Memory**: Player disconnect states are stored in a fast in-memory Map for instant lookups on rejoin. The database serves as a crash-recovery backing store, written asynchronously on disconnect and re-hydrated into memory when the plugin restarts within the same round.
* **Clan Grouping**: Detects clan tags in player names and keeps clan members together on the same team when joining. Delegates tag extraction and normalisation to S³ ClansService.
* **Elo-Aware Routing**: Integrates with the `EloTracker` plugin to route new players to the team that will most closely equalise the average skill of both sides.
* **Passive Mode**: Set `enableSmartAssign: false` to observe real server events only (`JOIN`, `LEAVE`, `TEAM_CHANGE`). The assignment algorithm does not run, and no `ASSIGNMENT` events are logged.
* **Lifecycle Event Logging**: Dumps precise `JOIN`, `LEAVE`, `TEAM_CHANGE`, `ASSIGNMENT`, `MOVE_SUCCESS`, and `MOVE_FAILED` events into an easily ingestible JSONL file, with global team populations (`t1`, `t2`) embedded on every event.
* **High-Performance Logging**: Events are batched in-memory and flushed periodically to minimise disk I/O overhead during large player waves.
* **Round Snapshots**: Automatically takes a full snapshot of connected players at the start of each round, logged as a `ROUND_SNAPSHOT` event.
* **Crash Recovery**: On restart, the plugin detects whether the current round matches a persisted round start time and resumes from the temp log.
* **Mode Ignorance**: Automatically bypasses auto-assignment during "Seed" or "Jensen" layers (configurable).

---

## Compatible / Recommended Plugins

### EloTracker

**[squadjs-elo-tracker](https://github.com/mikebjoyce/squadjs-elo-tracker)**

Tracks per-player TrueSkill ratings (μ/σ) across rounds. SmartAssign automatically detects if EloTracker is active and uses its live ratings to make skill-based routing decisions. Without it, the plugin falls back to pure population balancing.

**Setup**: Install the EloTracker plugin and enable it in your SquadJS config.json. SmartAssign discovers it at runtime — no additional configuration is required.

### SlackersSquadServices (S³)

**[squadjs-smart-assign](https://github.com/mikebjoyce/squadjs-smart-assign)**

S³ is a **required** supporting plugin that provides shared game state, player management, and clan services to all consumer plugins. SmartAssign consumes `gameState` (round metadata, mode checks), `players` (reconnect memory, move attribution, refresh interest), and `clans` (tag extraction, normalisation, cache) services.

**Setup**: Install the SlackersSquadServices plugin and enable it in your SquadJS config.json before SmartAssign. It must appear in the plugins array before SmartAssign so it is mounted first.

---

## Commands

No in-game chat commands. SmartAssign operates automatically during player joins with no manual intervention required.

---

## Installation

### 1. Configuration

Add the following to your `config.json`:

```json
"connectors": {
  "sqlite": {
    "dialect": "sqlite",
    "storage": "squad-server.sqlite"
  }
},
"plugins": [
  {
    "plugin": "SlackersSquadServices",
    "enabled": true,
    ...
  },
  {
    "plugin": "EloTracker",
    "enabled": true,
    ...
  },
  {
    "plugin": "SmartAssign",
    "enabled": true,
    "database": "sqlite",
    "logPath": "./smart-assign-log.jsonl",
    "enableSmartAssign": true,
    "enableEventLogging": true,
    "enableClanGrouping": true,
    "clanGroupMinSize": 2,
    "clanGroupCaseSensitive": false,
    "enableDatabaseLogging": false
  }
]
```

**Database Options:** The `"database"` option should match a connector name from the connectors block. Use `"sqlite"` for file-based storage (default), `"mysql"` for MySQL, or `"postgres"` for PostgreSQL. Any Sequelize-compatible backend is supported.

### 2. File Placement

Move the project files into your SquadJS directory's squad-server folder:

```
squad-server/
├── plugins/
│   └── smart-assign.js
├── utils/
│   ├── sa-database.js
│   ├── sa-swap-executor.js
│   ├── sa-event-logger.js
│   └── sa-team-evaluator.js
├── testing/                    ← Optional: diagnostic tools only
│   ├── clan-tag-timing-tester.js
│   ├── join-swap-tester.js
│   ├── unified-test-runner.js
│   └── optimize-params.js
```

⚠️ **IMPORTANT**: Do NOT deploy the `testing/` folder to production servers. The `testing/` directory contains diagnostic and simulation tools intended only for development and validation. Production deployments should include only the `plugins/` and `utils/` directories.

---

## Configuration Options

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `database` | string | Yes | `"sqlite"` | A valid Sequelize connector name (e.g. `"sqlite"`, `"mysql"`, `"postgres"`) for reconnect memory storage. |
| `enableSmartAssign` | boolean | No | `true` | If true, runs the assignment algorithm and moves players. If false, only logs real server events (passive mode). |
| `enableEventLogging` | boolean | No | `true` | Toggle the JSONL lifecycle event logging output entirely. |
| `logPath` | string | No | `"./auto-assign-log.jsonl"` | File path for JSONL player lifecycle events. |
| `ignoredGameModes` | array | No | `["Seed", "Jensen"]` | Array of layer/gamemode substrings where SmartAssign should not alter teams. |
| `enableClanGrouping` | boolean | No | `true` | If true, players in clans will be kept together on the same team if all clan mates are on one team. |
| `clanGroupMinSize` | number | No | `2` | Minimum number of players to consider a group as a clan for grouping purposes. |
| `clanGroupCaseSensitive` | boolean | No | `false` | If false, clan tags are case-insensitive and diacritics/gamer-character lookalikes are normalised. |
| `enableDatabaseLogging` | boolean | No | `false` | If true, mirrors JSONL event data into database tables for querying. |

---

## How Assignment Works

SmartAssign uses a hierarchical decision process optimised for competitive parity and real-world stability:

### 1. Hard Population Cap (Dynamic)

The hard cap is a safety net that prevents extreme imbalance regardless of the Elo scoring outcome:

| Server Population | Max Allowed Difference |
|---|---|
| < 82 players | 4 players |
| 82–89 players | 3 players |
| 90–95 players | 2 players |
| 96+ players | **1 player (strict parity)** |

### 2. Physical Server Cap (Hard Limit)

A hard cap preventing any single team from exceeding 50 players. If both teams reach 50, the server is considered full and the plugin returns no assignment (Squad's native join handling takes over).

### 3. Reconnect Memory (High Priority)

If the joining player has a record in the reconnect database from the current round, they are routed directly back to their previous team — **before** Clan Grouping or Elo scoring is evaluated. Reconnecting players are granted an additional **+1 imbalance grace allowance** on top of the base.

If the reconnect target would violate the hard cap even with the grace allowance, the player falls through to Clan Grouping and Elo scoring with a small bias toward their previous team.

### 3.5. Clan Grouping (High Priority)

If the joining player is part of a clan and **all** their clan mates are currently on the same team, the player is routed to that team — provided the population cap allows it. Clan members are granted the same **+1 imbalance grace allowance** as reconnecting players.

### 4. Elo Scoring & Skill Balancing

If neither reconnect memory nor clan grouping routes the player, the algorithm evaluates both teams with a **3-Metric Composite Scoring System** aligned with TeamBalancer:

1. **Mean ELO Difference (0.6× weight)**: Average skill (Mu) difference between teams.
2. **Top-15 ELO Difference (0.4× weight)**: Average skill of the 15 highest-rated players on each team.
3. **Veteran Parity Penalty (300× multiplier)**: Ratio of veteran players (10+ rounds) on each team.

The player is assigned to whichever team produces the lower combined penalty score.

If the reconnect target would violate the hard cap, reconnecting players receive a **0.25-point score reduction** (reconnect bias) toward their previous team to tip near-ties.

### 5. Fallback

- If `EloTracker` is unavailable, the algorithm falls back to pure population balancing (smaller team wins).
- If both teams are at the 50-player physical cap, the plugin returns no assignment (server is full).

---

## Diagnostic Tool: JoinSwapTester

⚠️ **DEV-ONLY WARNING**: `join-swap-tester.js` is a development diagnostic plugin intended for testing and validation only. Do not deploy to production servers.

It targets a specific player by EOSID and runs a full lifecycle profile:

- On join: immediately swaps them to the opposite team and reports the total verified swap time.
- On disconnect: reports the RCON detection delay and whether the engine-level `UNetConnection::Close` log was captured.

```json
{
  "plugin": "JoinSwapTester",
  "enabled": true,
  "targetEOSID": "your-eos-id-here"
}
```

---

## Author

**Slacker**

- **Discord:** `real_slacker`
- **GitHub:** https://github.com/mikebjoyce/squadjs-smart-assign

---

*Built for SquadJS*