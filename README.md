# SmartAssign Plugin v0.2.4

**Elo-Aware Auto Assignment & Player Lifecycle Logger**

## Overview

This plugin overrides Squad's native team assignment mechanics to provide smart, fair, and fast team placements. When a player connects, the plugin evaluates the current Elo distribution and population difference between both teams and assigns the player to whichever team produces the most balanced match. All team changes are executed via a background swap queue that achieves verified swaps in under 2 seconds.

The core timing challenge — Squad's RCON player list only refreshes every ~30 seconds — is solved by triggering the RCON move command directly from the Log Parser event (which fires within ~100ms of join), and then force-polling the player list after the command lands to verify the result. This approach consistently achieves verified join-swaps in 1–2 seconds.

Disconnect detection works via delta-diff: every time any player joins and triggers a forced RCON refresh, the player list is compared against the known state, which catches departures from other players as a side-effect — effectively solving disconnect lag without relying on the unreliable `PLAYER_DISCONNECTED` log event.

---

## Core Features

* **Sub-2s Verified Join Swaps**: Uses Log-Driven triggering + One-Hit & Verify to move players within ~1s of joining, verified against a fresh RCON poll.
* **Strict Population Balance**: Dynamically adjusts the allowed team population difference based on total player count, enforcing a strict 1-player max difference at high population.
* **Reconnect Memory**: Stores player disconnect states in a persistent SQLite database. If a player crashes or disconnects, they are automatically placed back on their previous team upon reconnecting (with a +2 imbalance grace allowance).
* **Elo-Aware Routing**: Integrates with the `EloTracker` plugin to route new players to the team that will most closely equalize the average skill of both sides.
* **Passive Mode**: Set `enableSmartAssign: false` to observe real server events only (`JOIN`, `LEAVE`, `TEAM_CHANGE`). The assignment algorithm does not run, and no `ASSIGNMENT` events are logged—this mode is useful for monitoring server activity without any intervention.
* **Lifecycle Event Logging**: Dumps precise `JOIN`, `LEAVE`, `TEAM_CHANGE`, `ASSIGNMENT`, `MOVE_SUCCESS`, and `MOVE_FAILED` events into an easily ingestible JSONL file, with global team populations (`t1`, `t2`) embedded on every event.
* **High-Performance Logging**: Events are batched in-memory and flushed periodically to minimize disk I/O overhead during large player waves.
* **Round Snapshots**: Automatically takes a full snapshot of connected players at the start of each round, logged as a `ROUND_SNAPSHOT` event for historical tracking and log replay.
* **Crash Recovery**: On restart, the plugin detects whether the current round matches a persisted round start time and resumes from the temp log rather than starting fresh.
* **Mode Ignorance**: Automatically bypasses auto-assignment during "Seed" or "Jensen" layers (configurable).

---

## Recommended Plugins

### EloTracker

**[squadjs-elo-tracker](https://github.com/mikebjoyce/squadjs-elo-tracker)**

Tracks per-player TrueSkill ratings (μ/σ) across rounds. SmartAssign automatically detects if EloTracker is active and uses its live ratings to make skill-based routing decisions. Without it, the plugin falls back to pure population balancing.

---

## Installation

Add this to your `config.json` inside the `plugins` array.

```json
"connectors": {
  "sqlite": {
    "dialect": "sqlite",
    "storage": "squad-server.sqlite"
  }
},

{
  "plugin": "SmartAssign",
  "enabled": true,
  "database": "sqlite",
  "logPath": "./smart-assign-log.jsonl",
  "enableSmartAssign": true,
  "enableEventLogging": true
}
```

**File Placement**: Move the project files into your SquadJS directory's squad-server folder.

```
squad-server/
├── plugins/
│   └── smart-assign.js
├── utils/
│   ├── sa-database.js
│   └── sa-swap-executor.js
├── testing/                    ← Optional: diagnostic tools only
│   ├── join-swap-tester.js
│   └── unified-test-runner.js
```

⚠️ **IMPORTANT**: Do NOT deploy the `testing/` folder to production servers. The `testing/` directory contains diagnostic and simulation tools intended only for development and validation. Production deployments should include only the `plugins/` and `utils/` directories.

---

## Configuration Options

```text
Core Settings:
database              - (Required) A valid Sequelize connector (e.g. "sqlite") for reconnect memory storage.
logPath               - (Optional) File path for JSONL lifecycle logs. Defaults to './auto-assign-log.jsonl'.
enableSmartAssign     - (Optional) Defaults to true. Set false for passive/dry-run mode (logs only, no moves).
enableEventLogging    - (Optional) Defaults to true. Toggles JSONL lifecycle logging entirely.
ignoredGameModes      - (Optional) Array of layer/gamemode substrings to skip. Defaults to ['Seed', 'Jensen'].
```

---

## How Assignment Works

SmartAssign uses a hierarchical decision process optimised for competitive parity and real-world stability:

### 1. Hard Population Cap (Dynamic)

The hard cap is a safety net that prevents extreme imbalance regardless of the Elo scoring outcome:

| Server Population | Max Allowed Difference |
|---|---|
| < 80 players | 4 players |
| 80–87 players | 3 players |
| 88–93 players | 2 players |
| 94+ players | **1 player (strict parity)** |

### 2. Reconnect Memory (High Priority)

If the joining player has a record in the reconnect database from the current round, they are routed directly back to their previous team — **before** Elo scoring is evaluated. Reconnecting players are granted an additional +1 or +2 imbalance grace allowance on top of the base to allow them back to their squad.

If the reconnect target would violate the hard cap even with the grace allowance, the player falls through to Elo scoring with a small bias toward their previous team.

### 3. Elo Scoring & Skill Balancing

If no reconnect memory applies, the algorithm evaluates both teams with a **Mu-based Unified Scoring System**:

- **Average Gap (3.0×)**: Measures how much the average skill of the two teams would diverge after placing the player on each side.
- **Sum Gap (1.5× / dynamic)**: Measures the total skill gap, scaled down as population grows (at full 100-player servers, the sum term becomes negligible and average gap dominates).

The player is assigned to whichever team produces the lower combined score — i.e., the placement that brings the match closest to a balanced skill split.

### 4. Fallback

- If `EloTracker` is unavailable, the algorithm falls back to pure population balancing (smaller team wins).
- If both teams are at the 50-player physical cap, the move is skipped and the game handles placement natively.

---

## Diagnostic Tool: JoinSwapTester

`join-swap-tester.js` is a development/telemetry plugin included in this repo. It targets a specific player by EOSID and runs a full lifecycle profile:

- On join: immediately swaps them to the opposite team and reports the total verified swap time.
- On disconnect: reports the RCON detection delay and whether the engine-level `UNetConnection::Close` log was captured.

It was used to prove the 1s verified swap and to validate disconnect detection behaviour. It is safe to leave deployed alongside SmartAssign for ongoing telemetry.

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
```
Discord: `real_slacker`
GitHub:  https://github.com/mikebjoyce
```
---

*Built for SquadJS*
