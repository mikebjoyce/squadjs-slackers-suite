# SmartAssign Plugin v0.1.3

**Elo-Aware Auto Assignment & Player Lifecycle Logger**

## Overview

This plugin overrides Squad's native team assignment mechanics to provide smart, fair, and reliable team placements. It perfectly tracks player joins, disconnects, and team changes without relying on buggy game log events, providing highly accurate JSONL lifecycle logs. 

When a player joins the server, the plugin uses a **Logistic Win-Probability Model** to ensure optimal team assignment, weighing competitive parity, player preference, and population equity on a single scale. This approach is optimized for **Real-World Maintenance**, where servers stay at 95+ players with constant churn.

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

SmartAssign uses a hierarchical decision process optimized for competitive parity and real-world stability:

### 1. Hard Population Cap (Dynamic)
The plugin first checks the player counts of both teams. It gradually tightens the population cap as the server fills to allow for better skill-balancing during seeding while ensuring perfect parity when full.
- **Seeding (<70 players)**: Up to 4-player imbalance allowed.
- **Mid-Pop (70-94 players)**: Tightens to 2-3 player difference.
- **Maintenance (95+ players)**: **Strict 1-player parity enforced.**

### 2. Reconnect Memory & Grace (High Priority)
Players rejoining within the same round are given a **+2 player imbalance allowance** (compared to fresh joins) to ensure they can get back to their squad and maintain team cohesion.

### 3. Logistic Win-Probability Scoring
If no reconnect memory is found, the system estimates the "Win Probability" of both teams using a logistic curve.
*   **Mu Scaling (Exponent 1.10)**: Player Elo (Mu) is weighted non-linearly to correctly value the disproportionate impact of high-skill "pro" players on team power.
*   **50/50 Target**: It assigns the player to the team that brings the match closest to a theoretical 50/50 win chance.
*   **Soft Population Penalty**: A small bias (0.01 probability units) favors the smaller team when skill gaps are negligible.

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
