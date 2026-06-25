# Switch Plugin v2.0.0

**Team-change management with database persistence, TeamBalancer integration, and S³-aware player tracking.**

## Overview

Manages player team-change requests with cooldown enforcement, scramble-aware lockout, and persistent join-timer tracking across server restarts. Integrates with TeamBalancer to lock switching after scrambles and with SlackersSquadServices (S³) for player state tracking, attribution, and queue processing.

Survives server restarts via any Sequelize-compatible database (SQLite, MySQL, PostgreSQL, etc.). Supports in-game chat commands and Discord admin commands with real-time eligibility diagnostics.

---

## Core Features

* **Persistent Cooldowns** — stored in configured database, survive restarts
* **Multi-Database Support** — works with SQLite, MySQL, PostgreSQL, and any Sequelize-compatible backend
* **Scramble Lockout** — blocks affected players from switching for a configurable duration after a TeamBalancer scramble
* **Switch Queue** — players waiting for a balance slot are queued and automatically switched when a partner or slot opens
* **End-of-Match Switches** — queue players for automatic team switching at round end
* **Double-Switch** — swap to opposite team and back to fix game bugs without changing teams
* **Liberał Mode Support** — relaxed switching rules during Seed/Jensen rounds
* **Dynamic Balance Tolerance** — interpolated extra imbalance slots when server is below full capacity
* **In-Game & Discord Admin Commands** — full admin controls via chat or Discord

---

## Compatible / Recommended Plugins

### TeamBalancer

**[squadjs-team-balancer](https://github.com/mikebjoyce/squadjs-team-balancer)**

Provides squad-preserving scramble functionality. When a scramble is executed, TeamBalancer fires the `TEAM_BALANCER_SCRAMBLE_EXECUTED` event. The Switch plugin listens for this event and automatically locks affected players from switching teams for a configurable duration (default: 20 minutes).

**Why this matters**: Without this plugin, players moved during a scramble can immediately switch back to their original team, defeating the purpose of team balancing.

**Setup**: Install TeamBalancer alongside Switch. No additional configuration needed — the event integration is automatic.

---

### SlackersSquadServices (S³)

**[SlackersSquadServices](https://github.com/mikebjoyce/SlackersSquadServices)**

S³ is a **required** supporting plugin that provides centralised shared state across Slacker's Squad plugins. Switch discovers S³ at mount time and uses it for:

- **Player state tracking** (`players.getPlayer` for join-time lookups, `players.recordMove` for team-change attribution, `players.registerRefreshInterest` for stale-player polling)
- **Game-state queries** (`gameState.isEndgameFactionVote` to suppress switching during faction votes, `gameState.getLayerName` / `gameState.getGamemode` for liberal-mode detection)
- **S³ events** (`S3_PLAYER_JOINED`, `S3_PLAYER_LEFT`, `S3_PLAYER_TEAM_CHANGED`) to drive queue processing and rejoin auto-switch logic

Switch will fail to mount if S³ is absent — there is no fallback path.

**Setup**: Install S³ in `config.json` before Switch. It must appear in the plugins array before Switch so it is mounted first. No manual configuration beyond installation is needed.

---

## Installation

### 1. Configuration

Add the following to your SquadJS `config.json`:

```json
"connectors": {
  "sqlite": {
    "dialect": "sqlite",
    "storage": "squad-server.sqlite"
  },
  "discord": {
    "connector": "discord",
    "token": "YOUR_BOT_TOKEN"
  },
  ...
},
"plugins": [
  {
    "plugin": "Switch",
    "enabled": true,
    "discordClient": "discord",
    "discordChannelID": "",
    "database": "sqlite",
    "commandPrefix": ["!switch", "!change"],
    "switchCooldownHours": 3,
    "switchCooldownMinutes": 0,
    "switchEnabledMinutes": 5,
    "doubleSwitchCommands": ["!bug", "!stuck", "!doubleswitch"],
    "doubleSwitchCooldownHours": 0.5,
    "doubleSwitchDelaySeconds": 1,
    "doubleSwitchEnabledMinutes": 5,
    "endMatchSwitchSlots": 3,
    "maxUnbalancedSlots": 3,
    "switchToOldTeamAfterRejoin": false,
    "scrambleLockdownDurationMinutes": 20,
    "liberalSwitchGameModes": ["Seed", "Jensen"],
    "liberalSwitchMaxUnbalancedSlots": 6,
    "dynamicBalanceTolerance": false,
    "dynamicBalancePlayerFloor": 90,
    "dynamicBalanceExtraSlots": 2
  }
]
```

### 2. File Placement

Move the project files into your SquadJS directory:

```
squad-server/
├── plugins/
│   └── discord-base-plugin.js      (if not already present)
├── squadjs-switch-teambalancer-aware/
│   └── switch.js
```

Or, if placing directly in the plugins directory:

```
squad-server/
└── plugins/
    └── switch.js
```

---

## Commands

### In-Game Commands

**Public (all players):**

| Command | Description |
|---------|-------------|
| `!switch` | Request a team change (checks balance, cooldowns, scramble locks) |
| `!switch help` | In-game warning popup explaining eligibility rules |
| `!switch explain` | Detailed multi-part breakdown of how switching works |
| `!switch check` | Show your full eligibility status (balance, time, cooldown, scramble) |
| `!switch cancel` | Leave the switch queue |
| `!bug` / `!stuck` / `!doubleswitch` | Double-switch: swap to opposite team and back (fixes bugs) |

**Admin (in-game):**

| Command | Description |
|---------|-------------|
| `!switch now <name>` | Force immediate team switch for a player |
| `!switch double <name>` | Force double-switch for a player |
| `!switch squad <n> <team>` | Switch an entire squad to the opposite team |
| `!switch doublesquad <n> <team>` | Double-switch an entire squad |
| `!switch swap <name1> <name2>` | Swap two players between teams |
| `!switch matchend <name>` | Queue a player for switch at end of round |
| `!switch matchendsquad <n> <team>` | Queue a squad for switch at end of round |
| `!switch check <name/steamID>` | Look up another player's cooldown and lock status |
| `!switch clear <name/steamID>` | Remove all cooldowns and locks for a player |
| `!switch clearall` | Wipe the entire cooldown database |
| `!switch diag` | Show DB health, active locks, and top-10 locked players |
| `!switch help` | List all admin commands |

### Discord Commands

**Admin:**

| Command | Description |
|---------|-------------|
| `!switch diag` | Database health + RCON latency + top-10 locked players |
| `!switch check <name/steamID>` | Real-time eligibility lookup with Discord timestamps |
| `!switch clear <name/steamID>` | Remove cooldowns/locks for a player |
| `!switch clearall` | Wipe entire cooldown database |
| `!switch help` | List all Discord admin commands |

---

## Configuration Options

### Required

| Option | Description | Default |
|--------|-------------|---------|
| `database` | Sequelize connector name for persistence | `"sqlite"` |
| `discordClient` | Discord connector name | `"discord"` |

### Core Switch Behavior

| Option | Description | Default |
|--------|-------------|---------|
| `commandPrefix` | Command prefix(es) to trigger switch | `["!switch", "!change"]` |
| `switchCooldownHours` | Hours before player can switch again | `3` |
| `switchCooldownMinutes` | Minutes before player can switch again (overrides hours if > 0) | `0` |
| `switchEnabledMinutes` | Time window (minutes) after join/match start for switching | `5` |
| `maxUnbalancedSlots` | Max player difference between teams to allow a switch | `3` |
| `switchToOldTeamAfterRejoin` | Auto-switch rejoining players to pre-disconnect team | `false` |
| `scrambleLockdownDurationMinutes` | Duration to block switching after a scramble | `20` |

### Double-Switch

| Option | Description | Default |
|--------|-------------|---------|
| `doubleSwitchCommands` | Array of commands that trigger a double-switch | `[]` |
| `doubleSwitchCooldownHours` | Hours before same player can double-switch again | `0.5` |
| `doubleSwitchDelaySeconds` | Delay between first and second team switch | `1` |
| `doubleSwitchEnabledMinutes` | Time window for double-switch after join/match start | `5` |

### End-of-Match

| Option | Description | Default |
|--------|-------------|---------|
| `endMatchSwitchSlots` | Number of end-of-match switch slots | `3` |

### Liberal Mode (Seed/Jensen)

| Option | Description | Default |
|--------|-------------|---------|
| `liberalSwitchGameModes` | Substrings for layers/modes with relaxed switching | `["Seed", "Jensen"]` |
| `liberalSwitchMaxUnbalancedSlots` | Balance cap during liberal modes | `6` |

### Dynamic Balance Tolerance

| Option | Description | Default |
|--------|-------------|---------|
| `dynamicBalanceTolerance` | Enable interpolated extra tolerance below full capacity | `false` |
| `dynamicBalancePlayerFloor` | Player count at which max extra slots apply | `90` |
| `dynamicBalanceExtraSlots` | Additional imbalance slots at floor player count | `2` |

### Discord

| Option | Description | Default |
|--------|-------------|---------|
| `discordChannelID` | Discord channel ID for admin commands and logs | `""` |

---

## Author

**Original Author:** [fantinodavide](https://github.com/fantinodavide)  
**Modified by:** Slacker  
**Discord:** `real_slacker`  
**GitHub:** [squadjs-switch-teambalancer-aware](https://github.com/mikebjoyce/squadjs-switch-teambalancer-aware)

This plugin is a modified fork with added persistence, TeamBalancer integration, S³ support, and expanded admin controls.

---

*Built for SquadJS*