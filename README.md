# SmartAssign Plugin v1.0.0

**Elo-Aware Auto Assignment & Player Lifecycle Logger**

## Overview

This plugin overrides Squad's native team assignment mechanics to provide smart, fair, and reliable team placements. It perfectly tracks player joins, disconnects, and team changes without relying on buggy game log events, providing highly accurate JSONL lifecycle logs. 

When a player joins the server, the plugin uses a hierarchical logic system to ensure the best possible team assignment:
1. **Strict Imbalance Checks**: Enforces population caps to prevent lopsided team numbers.
2. **Reconnect Memory**: Places recently disconnected players back onto their original team (so long as it doesn't violate strict imbalance rules).
3. **Elo Balancing**: Uses live data from the `EloTracker` plugin to calculate and minimize the skill gap between teams.

Additionally, it executes all team changes via a background retry-queue to ensure the swap applies successfully as soon as the engine allows it.

---

## Core Features

* **Strict Population Balance**: Respects configurable imbalance margins, and features a "High Pop Threshold" mode that enforces a strict 1-player max difference when the server is near capacity (protecting admin slots and ensuring perfect parity for full servers).
* **Reconnect Memory**: Stores player disconnect states in a persistent SQLite database. If a player crashes or disconnects, they are automatically placed back on their previous team upon reconnecting.
* **Elo-Aware Routing**: Integrates with the `EloTracker` plugin to dynamically route new players to the team that will most closely equalize the overall average Elo ratings of both sides.
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

The plugin evaluates which team a player should join in the following order:

1. **Strict Imbalance Checks (Highest Priority)**
   The plugin first checks the difference in player counts between Team 1 and Team 2. 
   - It respects the `maxImbalance` setting.
   - **High Population Override:** If the server total population reaches the `highPopThreshold`, the allowed imbalance strictly becomes **1 player**.
   - If placing a player on a specific team would exceed the allowed imbalance limit, they are immediately forced onto the team with fewer players, ignoring all other rules.

2. **Reconnect Preference**
   If a player recently disconnected and is reconnecting to the server, the plugin checks its database for their previous team. 
   - The player will be placed back onto their original team.
   - *Exception:* This rule is skipped if putting them back on their old team would violate the strict imbalance rules from Step 1.

3. **Elo Metrics (Skill-based Balancing)**
   If the player isn't forced by imbalance and isn't reconnecting, the plugin looks for an active `EloTracker` plugin to balance the teams by skill.
   - It calculates what the new average Elo would be for Team 1 if the player joined them, and does the same for Team 2.
   - It compares the potential averages and assigns the player to the team that minimizes the skill gap.

4. **Final Safety Check & Fallback**
   - If the team chosen by the Elo system would violate the maximum allowed player imbalance, the Elo decision is discarded.
   - If the EloTracker isn't available or fails, it defaults to placing the player on the team with fewer players.

## Author

**Slacker**
```
Discord: `real_slacker`
GitHub:  https://github.com/mikebjoyce
```
---

*Built for SquadJS*