# SmartAssign Plugin v2.1.1

**Elo-Aware Auto Assignment & Player Lifecycle Logger**

## Overview

This plugin corrects Squad's native team auto-assignment to provide smart, fair, and fast team placements. When a player connects, the plugin evaluates the current Elo distribution and population difference between both teams and assigns the player to whichever team produces the most balanced match. All team changes are executed via RCON using a One-Hit & Verify approach, with a hard 3-second timeout ensuring predictable behaviour.

The core timing challenge — Squad's RCON player list only refreshes every ~30 seconds — is solved by triggering the RCON move command directly from the Log Parser event (which fires within ~100ms of join), and then force-polling the player list after the command lands to verify the result. This approach typically achieves verified join-swaps in 1–2 seconds, with a hard 3-second completion guarantee.

SmartAssign runs on top of S³ (SlackersSquadServices), which must be installed and mounted first. S³ owns the shared player registry, game state, clan services, per-player locking, and reconnect memory — SmartAssign consumes these services via S³'s flat accessor pattern (`this._s3?.players`, `this._s3?.gameState`, `this._s3?.clans`).

Player disconnects are detected by S³'s PlayersService, which emits `S3_PLAYER_LEFT` events that SmartAssign consumes to persist reconnect state and handle cleanup. The delta-diff approach originally described here has been moved into S³'s tick-based player-list diffing — SmartAssign no longer manages its own disconnect detection.

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

## Dependencies

### Optional / Recommended: EloTracker

**[squadjs-elo-tracker](https://github.com/mikebjoyce/squadjs-slackers-suite/tree/master/elo-tracker)**

Tracks per-player TrueSkill ratings (μ/σ) across rounds. SmartAssign automatically detects if EloTracker is active and uses its live ratings to make skill-based routing decisions. Without it, the plugin falls back to pure population balancing.

**Setup**: Install the EloTracker plugin and enable it in your SquadJS config.json. SmartAssign discovers it at runtime — no additional configuration is required.

### Required: SlackersSquadServices (S³)

**[squadjs-slackers-squad-services](https://github.com/mikebjoyce/squadjs-slackers-suite/tree/master/s3)**

S³ is a **required** supporting plugin that provides shared game state, player management, and clan services to all consumer plugins. SmartAssign consumes `gameState` (round metadata, mode checks), `players` (reconnect memory, move attribution, refresh interest), and `clans` (tag extraction, normalisation, cache) services.

**Requires S³ ≥1.0.0.**

**Setup**: Install the SlackersSquadServices plugin and enable it in your SquadJS config.json before SmartAssign. It must appear in the plugins array before SmartAssign so it is mounted first.

---

## Commands

SmartAssign has no in-game or Discord commands of its own — it operates fully autonomously during player joins with no manual intervention required.

Discord admin commands for monitoring and diagnostics (server status, player lists, locks, backups, etc.) are provided by the S³ plugin. See [S³ Command System](../s3/README.md#s3-command-system) for the full command reference.

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

## Switch Handshake (Optional)

The Switch Handshake feature allows SmartAssign to optionally include Switch-queued players in its team balance evaluation. When a joining player's baseline assignment is close to balanced, SmartAssign may swap the joining player with a Switch-queued player, satisfying the Switch player's request while still producing a balanced outcome.

### How It Works

1. **Discovery:** At mount time, SmartAssign detects the Switch plugin via `this.server.plugins.find()`. If found with version ≥2.0.0 and the required public API, the handshake is available.
2. **Frontloading:** When a player joins, SmartAssign fires `getQueueSnapshot()` asynchronously (before the main evaluation), so the snapshot is ready when needed.
3. **Evaluation:** After `evaluateTeamAssignment()` returns a baseline result, SmartAssign checks the relevant sub-queue (players whose target team matches the baseline). If the head candidate passes all filters (F1–F6), virtual scoring is computed.
4. **Decision:** In `eloGated` mode (default), the swap is adopted only if the virtual score is within `handshakeScoreThreshold` of the baseline. In `queueDrain` mode, any candidate passing hard constraints is swapped regardless of score.
5. **Execution:** SmartAssign queues both RCON moves through its own executor and calls `forceQueueSwap()` on the Switch plugin to clean up queue bookkeeping.

### Configuration

| Option | Required | Type | Default | Description |
|--------|----------|------|---------|-------------|
| `handshakeWithSwitch` | no | boolean | `false` | Enable handshake with Switch queue (requires Switch plugin v2.0.0+). |
| `handshakeScoreThreshold` | no | number | `0.5` | How much worse the swap score can be vs baseline before rejecting (lower = stricter, `eloGated` mode only). |
| `handshakeMode` | no | string | `"eloGated"` | `"eloGated"` — scoring gates the swap; `"queueDrain"` — swap if hard constraints pass, ignore scoring. |

### Graceful Degradation

- Switch plugin absent → handshake disabled, verbose-log once at mount, no errors.
- Switch plugin incompatible version → same graceful handling.
- Snapshot fetch fails → fall back to baseline for that join.
- `consumeQueueEntry` / `forceQueueSwap` returns null (race) → joining player move unaffected, Switch player not moved.

### Requirements

- **Switch plugin v2.0.0+** must be installed and enabled in `config.json` before SmartAssign.

---

## Configuration Options

| Option | Required | Type | Default | Description |
|--------|----------|------|---------|-------------|
| `database` | yes | string | `"sqlite"` | Sequelize connector name for reconnect memory storage (SQLite, MySQL, PostgreSQL, etc.) |
| `enableSmartAssign` | no | boolean | `true` | If true, runs the assignment algorithm and moves players. If false, only logs real server events (passive mode). |
| `enableEventLogging` | no | boolean | `true` | Toggle the JSONL lifecycle event logging output entirely |
| `logPath` | no | string | `"./smart-assign-log.jsonl"` | File path for JSONL player lifecycle events |
| `ignoredGameModes` | no | array | `["Seed", "Jensen"]` | Array of layer/gamemode substrings where SmartAssign should not alter teams |
| `enableClanGrouping` | no | boolean | `true` | If true, players in clans will be kept together on the same team if all clan mates are on one team |
| `clanGroupMinSize` | no | number | `2` | Minimum number of players to consider a group as a clan for grouping purposes |
| `clanGroupCaseSensitive` | no | boolean | `false` | If false, clan tags are case-insensitive and diacritics/gamer-character lookalikes are normalised |
| `enableDatabaseLogging` | no | boolean | `false` | If true, mirrors JSONL event data into database tables for querying |

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

Discord: `real_slacker`
GitHub: https://github.com/mikebjoyce

---

*Built for SquadJS*