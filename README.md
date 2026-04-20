# SmartAssign Plugin v0.2.2

**Elo-Aware Auto Assignment & Player Lifecycle Logger**

## Overview

This plugin overrides Squad's native team assignment mechanics to provide smart, fair, and reliable team placements. It accurately tracks player joins, disconnects, and team changes to maintain a detailed history of the server population.

When a player joins the server, the plugin calculates a team assignment score based on the current Elo distribution and population difference between the two teams. It evaluates these metrics to ensure that skill levels remain balanced while keeping the team sizes as equal as possible, especially during high-population gameplay.

Additionally, it executes all team changes via a background retry-queue to ensure the swap applies successfully as soon as the engine allows it.

---

## Core Features

* **Strict Population Balance**: Dynamically adjusts the allowed team population difference based on the current total player count, enforcing a strict 1-player max difference when the server is near capacity.
* **Reconnect Memory**: Stores player disconnect states in a persistent SQLite database. If a player crashes or disconnects, they are automatically placed back on their previous team upon reconnecting.
* **Elo-Aware Routing**: Integrates with the `EloTracker` plugin to dynamically route new players to the team that will most closely equalize the overall power of both sides.
* **Reliable Swap Execution**: Squad's RCON can occasionally fail to move players (for example, during faction voting or other transition states). This plugin uses a dedicated background queue that retries failed team switches.
* **Lifecycle Event Logging**: Dumps precise `JOIN`, `LEAVE`, and `TEAM_CHANGE` events (including whether a move was manual, executed by SmartAssign, or a TeamBalancer scramble) into an easily ingestible JSONL file, now tracking global team populations (`t1`, `t2`) on every event.
* **High-Performance Logging**: Events are batched in-memory and flushed periodically to significantly reduce disk I/O overhead during massive player waves.
* **Round Snapshots**: Automatically takes a snapshot of all currently connected players at the start of a new round, logging them as a `ROUND_SNAPSHOT` event for full historical tracking.
* **Mode Ignorance**: Automatically bypasses auto-assignment logic during "Seed" or "Jensen" layers, allowing players to join freely and reducing administrative overhead.

---

## Recommended Plugins

### EloTracker

**[squadjs-elo-tracker](https://github.com/mikebjoyce/squadjs-elo-tracker)**

Tracks per-player TrueSkill ratings (μ/σ) across rounds. SmartAssign automatically detects if EloTracker is active and uses its live data to make skill-based routing decisions when assigning new players to teams.

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
```

---

## Configuration Options

```text
Core Settings:
database              - (Required) A valid Sequelize connector (e.g. "sqlite") used to store the reconnect memory.
logPath               - (Optional) File path to save the JSONL lifecycle logs. Defaults to './auto-assign-log.jsonl'.
enableSmartAssign     - (Optional) Defaults to true. If false, the plugin runs in passive data-collection mode (logging only, no player moves).
enableEventLogging    - (Optional) Defaults to true. Toggles the JSONL lifecycle logging.
ignoredGameModes      - (Optional) Array of layer/gamemode substrings where auto-assignment should be disabled. Defaults to ['Seed', 'Jensen'].
```

---

## How Assignment Works

SmartAssign uses a hierarchical decision process optimized for competitive parity and real-world stability:

### 1. Hard Population Cap (Dynamic)
The plugin first checks the player counts of both teams. Because the Elo scoring logic natively creates a soft penalty for lopsided teams, the hard bounds act purely as a safety net:
- **Low/Mid-Pop (< 95 players)**: Strict 2-player difference allowed.
- **Full Server (95+ players)**: **Strict 1-player parity enforced.**

### 2. Reconnect Memory & Grace (High Priority)
Players rejoining within the same round are granted an **additional +2 player imbalance allowance** on top of the base allowance to ensure they can get back to their squad and maintain team cohesion.
- **Low/Mid-Pop (< 95 players)**: Up to **4-player difference allowed**.
- **Full Server (95+ players)**: Hard capped back down to a **2-player difference**.

### 3. Team Scoring & Skill Balancing
If no reconnect memory is found, the system evaluates which team the player should join based on skill distribution and population.
*   **Mu Balancing**: The algorithm balances competitive parity by weighing the average skill gap (3.0x multiplier) against a dynamically scaled sum gap (1.5x multiplier).
*   **Balancing Target**: It assigns the player to the team that brings the match closest to an even skill split between both sides.
*   **Internal Tuning**: Balances the desire for even skill distribution against strict population limits, ensuring that the algorithm doesn't create lopsided teams just to match Elo numbers.

### 4. Final Safety Check & Fallback
*   If the scoring system selects a team that would violate the hard population cap, the decision is overridden.
*   If the `EloTracker` plugin is inactive, the system defaults to pure population balancing.

## Author

**Slacker**
```
Discord: `real_slacker`
GitHub:  https://github.com/mikebjoyce
```
---

*Built for SquadJS*
