# SquadJS Switch Plugin

**Team-change management with database persistence and TeamBalancer integration.**

## Overview

Manages player team-change requests with cooldown enforcement and admin restrictions. Survives server restarts via any Sequelize-compatible database (SQLite, MySQL, PostgreSQL, etc.). Responds to team scrambles by locking all players from switching.

## Features

* **Persistent cooldowns** — stored in configured database, survive restarts
* **Multi-database support** — works with SQLite, MySQL, PostgreSQL, and any Sequelize-compatible backend
* **Scramble lockout** — blocks all players from switching for configurable duration after scramble
* **Admin controls** — in-game chat and Discord

## Commands

### User
* `!switch` — request team change (checks balance, cooldowns, locks)
* `!switch help` — in-game warning popup explaining eligibility

### Admin (Discord & In-Game)
* `!switch diag` — database health + top 10 players by remaining lock time
* `!switch check <Name/SteamID>` — real-time eligibility lookup
* `!switch clear <Name/SteamID>` — remove cooldowns/locks for player
* `!switch clearall` — wipe entire cooldown database
* `!switch help` — list all admin commands

## Configuration

```json
{
    "plugin": "Switch",
    "enabled": true,
    "commandPrefix": ["!switch", "!change"],
    "discordClient": "discord",
    "discordChannelID": "YOUR_ADMIN_CHANNEL_ID",
    "database": "sqlite",
    "switchCooldownHours": 3,
    "switchCooldownMinutes": 0,
    "switchEnabledMinutes": 5,
    "doubleSwitchCommands": ["!bug", "!stuck", "!doubleswitch"],
    "doubleSwitchCooldownHours": 0.5,
    "doubleSwitchDelaySeconds": 1,
    "doubleSwitchEnabledMinutes": 5,
    "endMatchSwitchSlots": 3,
    "maxUnbalancedSlots": 5,
    "switchToOldTeamAfterRejoin": false,
    "scrambleLockdownDurationMinutes": 20
}
```

**Configuration Options:**

**Required:**
- `plugin` — must be `"Switch"`
- `enabled` — `true` to enable plugin
- `database` — Sequelize connector (typically `"sqlite"`)

**Optional:**
- `commandPrefix` — command(s) to trigger switch (string or array). Default: `["!switch", "!change"]`
- `discordClient` — Discord connector name for Discord commands. Default: none
- `discordChannelID` — Discord channel ID for admin commands and logs. Default: none

**Switch Behavior:**
- `switchCooldownHours` — hours before player can switch again. Default: `3`
- `switchCooldownMinutes` — overrides `switchCooldownHours` if set. Default: `0` (which causes `switchCooldownHours` to be used)
- `switchEnabledMinutes` — time window after match start or player join to allow switches. Default: `5`
- `maxUnbalancedSlots` — max player difference between teams to allow switch. Default: `3`

**Double Switch:**
- `doubleSwitchCommands` — commands that swap player to opposite team and back (fixes bugs without changing teams). Default: `[]`
- `doubleSwitchCooldownHours` — cooldown for double switch commands. Default: `0.5`
- `doubleSwitchDelaySeconds` — delay between first and second swap. Default: `1`
- `doubleSwitchEnabledMinutes` — time window for double switch. Default: `5`

**Advanced:**
- `endMatchSwitchSlots` — queue size for end-of-round switches. Default: `3`
- `switchToOldTeamAfterRejoin` — auto-switch rejoining players to their pre-disconnect team. Default: `false`
- `scrambleLockdownDurationMinutes` — blocks all players from switching after scramble. Default: `20`

## TeamBalancer Integration

Works with **[Slacker's Team Balancer Plugin](https://github.com/mikebjoyce/squadjs-team-balancer)**:
- Listens for `TEAM_BALANCER_SCRAMBLE_EXECUTED` event
- Adds scrambled players to database with `scrambleLockdownExpiry` timestamp
- Prevents players from changing teams immediately following a team balancer scramble

---

## Credits

**Original Author:** [fantinodavide](https://github.com/fantinodavide)  
**Modified by:** [Slacker](https://github.com/mikebjoyce) (Discord: `real_slacker`)

This plugin is a modified fork with added persistence, TeamBalancer integration, and expanded admin controls.