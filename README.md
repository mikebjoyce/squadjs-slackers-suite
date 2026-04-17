# SmartAssign Plugin v0.1.3

**Elo-Aware Auto Assignment & Player Lifecycle Logger**

## Overview

This plugin overrides Squad's native team assignment mechanics to provide smart, fair, and reliable team placements. It perfectly tracks player joins, disconnects, and team changes without relying on buggy game log events, providing highly accurate JSONL lifecycle logs. 

When a player joins the server, the plugin uses a **Unified Scoring System** to ensure optimal team assignment, weighing competitive parity, player preference, and population equity on a single scale.

Additionally, it executes all team changes via a background retry-queue to ensure the swap applies successfully as soon as the engine allows it.

---

## Core Features

* **Strict Population Balance**: Respects configurable imbalance margins, and features a "High Pop Threshold" mode that enforces a strict 1-player max difference when the server is near capacity (protecting admin slots and ensuring perfect parity for full servers).
* **Reconnect Memory**: Stores player disconnect states in a persistent SQLite database. If a player crashes or disconnects, they are automatically placed back on their previous team upon reconnecting.
* **Elo-Aware Routing**: Integrates with the `EloTracker` plugin to dynamically route new players to the team that will most closely equalize the overall power of both sides.
* **Reliable Swap Execution**: Squad's RCON can occasionally fail to move players if they are still loading in. This plugin uses a dedicated background queue that retries failed team switches until successful.
* **Lifecycle Event Logging**: Dumps precise `JOIN`, `LEAVE`, and `TEAM_CHANGE` events (including whether a move was manual, executed by SmartAssign, or a TeamBalancer scramble) into an easily ingestible JSONL file.

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
  "maxImbalance": 2,
  "highPopThreshold": 96
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
database              - (Required) A valid Sequelize connector (e.g. "sqlite") used to store the reconnect memory so it survives SquadJS restarts.
logPath               - (Optional) File path to save the JSONL lifecycle logs (Joins, Leaves, Team Changes). Defaults to './auto-assign-log.jsonl'.
maxImbalance          - (Optional) The maximum player imbalance allowed before the plugin strictly forces players to the smaller team regardless of Elo metrics or Reconnect Memory. Defaults to 2.
highPopThreshold      - (Optional) Total player count at which the plugin goes into "Strict Equity Mode", mathematically forcing maxImbalance to 1 (overriding Elo/Reconnect preferences) to protect near-full servers. Defaults to 96.
```

---

## How Assignment Works

The plugin evaluates which team a player should join using a hierarchical decision process:

### 1. Strict Population Cap (Highest Priority)
The plugin first checks the player counts of both teams. If the difference already meets or exceeds the `maxImbalance` limit, the player is immediately assigned to the smaller team.
*   **High Population Override**: When total players >= `highPopThreshold` (default 96), the plugin enforces a strict **1-player max imbalance**.

### 2. Unified Scoring System (Elo-Aware)
If the hard population cap isn't triggered, the plugin calculates a "cost score" for each team. The player is assigned to the team with the lower score.

*   **Squared Average Elo Gap (Non-Linear)**: The base score is the **squared difference** between the teams' average Elo ratings (using `Mu^1.1` non-linear scaling) if the player were to join that team. The squared error ensures that large skill gaps are penalized much more heavily than small ones, leading to more stable balancing. The `^1.1` scaling ensures that high-skill players are weighted more accurately, recognizing their outsized impact on match flow.
*   **Soft Population Penalty**: A penalty of **0.05 units** (in squared-Mu space) is added to a team's score for every player they are ahead of the other team. This favors the smaller team while allowing for better skill equalization within the allowed population margins.
*   **Reconnect Bonus**: If a player was previously on a team during the current round, that team receives a **0.05 bonus** (score reduction).

### 3. Final Safety Check & Fallback
*   If the scoring system selects a team that would violate the hard population cap, the decision is overridden to maintain balance.
*   If the `EloTracker` plugin is inactive, the system defaults to pure population balancing (favoring the smaller team).

## Author

**Slacker**
```
Discord: `real_slacker`
GitHub:  https://github.com/mikebjoyce
```
---

*Built for SquadJS*
