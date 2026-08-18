# Switch Plugin v2.5.1

**Team-change management with database persistence, TeamBalancer integration, and S³-aware player tracking.**

## Overview

Manages player team-change requests with cooldown enforcement, scramble-aware lockout, and persistent join-timer tracking across server restarts. Integrates with TeamBalancer to lock switching after scrambles and with SlackersSquadServices (S³) for player state tracking, attribution, and queue processing.

Survives server restarts via any Sequelize-compatible database (SQLite, MySQL, PostgreSQL, etc.). Supports in-game chat commands and Discord admin commands with real-time eligibility diagnostics.

> 📖 **Behaviour Reference** — For a detailed explanation of how team switching works (mirroring the `!switch explain` command and Discord explain channel content), see [`SWITCH_BEHAVIOUR.md`](SWITCH_BEHAVIOUR.md).

---

## Core Features

* **Persistent Cooldowns** — stored in configured database, survive restarts
* **Multi-Database Support** — works with SQLite, MySQL, PostgreSQL, and any Sequelize-compatible backend
* **Scramble Lockout** — blocks affected players from switching for a configurable duration after a TeamBalancer scramble
* **Switch Queue** — players waiting for a balance slot are queued and automatically switched when a partner or slot opens
* **Queue Timeout → Force Switch** — players who reach the queue timeout wait limit are force-switched (with a relaxed balance gate and bypass of the 50/50 hard cap) instead of being removed from the queue. Controlled by `queueTimeoutSwitchEnabled` and `queueTimeoutExtraSlots`.
* **End-of-Match Switches** — queue players for automatic team switching at round end
* **Double-Switch** — swap to opposite team and back to fix game bugs without changing teams
* **Liberal Mode Support** — relaxed switching rules during Seed/Jensen rounds
* **Token Bucket Cooldown** — players hold up to `maxSwitchTokens` (default 2) with individual per-token regeneration; set to 1 for legacy flat-cooldown behavior. Token-aware messaging adapts automatically based on the configured token count.
 * **Seed Bonus Tokens** — players earn bonus switch tokens for time spent in seed-mode rounds, stacking above the normal cap up to an absolute ceiling of `maxSwitchTokens + seedTokenBonusAmount`. Players still present when the round ends receive a consolation token even if they never accrued a full interval. Configurable minimum player threshold (`seedTokenBonusMinPlayers`) gates time accrual so low-population servers don't hand out tokens at 2 AM. Set either `seedTokenBonusAmount` or `seedTokenBonusMinutes` to 0 to disable seed bonus tokens entirely.
 * **Row Retention** — cooldown rows are pruned automatically: immediately once a row carries no information (exactly `maxSwitchTokens`, no seed state), and after `pruneInactivePlayerDays` for everything else. Keeps the table bounded on long-running servers.
* **Dynamic Balance Tolerance** — interpolated extra imbalance slots when server is below full capacity
* **Auto-Updating Explain Channel** — When `explainChannelID` is configured, the full `!switch explain` embed sequence plus a 7-day reliability stats embed is posted to the designated channel on mount and periodically refreshed in-place (every 30 minutes). Players always see current information without manual `!switch explain` re-runs.
* **Enhanced `!switch stats`** — Discord aggregate embed with per-move-type counts, denial reason breakdowns, queue outcomes, liberal-mode filtering, and data quality warnings
* **In-Game & Discord Admin Commands** — full admin controls via chat or Discord

---

## Compatible / Recommended Plugins

### TeamBalancer

**[squadjs-team-balancer](https://github.com/mikebjoyce/squadjs-slackers-suite/tree/master/team-balancer)**

Provides squad-preserving scramble functionality. When a scramble is executed, TeamBalancer fires the `TEAM_BALANCER_SCRAMBLE_EXECUTED` event. The Switch plugin listens for this event and automatically locks affected players from switching teams for a configurable duration (default: 20 minutes).

**Why this matters**: Without this plugin, players moved during a scramble can immediately switch back to their original team, defeating the purpose of team balancing.

**Setup**: Install TeamBalancer alongside Switch. No additional configuration needed — the event integration is automatic.

---

### SlackersSquadServices (S³)

**[SlackersSquadServices](https://github.com/mikebjoyce/squadjs-slackers-suite/tree/master/s3)**

S³ is a **required** supporting plugin that provides centralised shared state across Slacker's Squad plugins. Switch discovers S³ at mount time and uses it for:

- **Player state tracking** (`players.getPlayer` for join-time lookups, `players.recordMove` for team-change attribution, `players.registerRefreshInterest` for stale-player polling)
- **Game-state queries** (`gameState.isEndgameFactionVote` to suppress switching during faction votes, `gameState.getLayerName` / `gameState.getGamemode` for liberal-mode detection)
- **S³ events** (`S3_PLAYER_JOINED`, `S3_PLAYER_LEFT`, `S3_PLAYER_TEAM_CHANGED`) to drive queue processing and rejoin auto-switch logic

Switch will fail to mount if S³ is absent — there is no fallback path.

**Requires S³ ≥1.0.0.**

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
    "adminCommandChannelID": "",
    "discordChannelID": "",
    "database": "sqlite",
    "commandPrefix": ["!switch", "!change"],
    "switchCooldownHours": 1.75,
    "switchCooldownMinutes": 0,
    "switchEnabledMinutes": 10,
    "queueTimeoutMinutes": 15,
    "doubleSwitchCommands": ["!bug", "!stuck", "!doubleswitch"],
    "doubleSwitchCooldownHours": 0.5,
    "doubleSwitchDelaySeconds": 1,
    "doubleSwitchEnabledMinutes": 10,
    "endMatchSwitchSlots": 3,
    "maxUnbalancedSlots": 1,
    "scrambleLockdownDurationMinutes": 30,
    "liberalSwitchGameModes": ["Seed", "Jensen"],
    "liberalSwitchMaxUnbalancedSlots": 6,
    "liberalSwitchBroadcastIntervalMinutes": 8,
    "dynamicBalanceTolerance": true,
    "dynamicBalancePlayerFloor": 85,
    "dynamicBalanceExtraSlots": 3,
    "queueTimeoutSwitchEnabled": true,
    "queueTimeoutExtraSlots": 2,
    "maxSwitchTokens": 2,
    "seedTokenBonusAmount": 1,
    "seedTokenBonusMinutes": 20,
    "seedTokenBonusMinPlayers": 0,
    "pruneInactivePlayerDays": 3
  }
]
```

### 2. File Placement

Move the project files into your SquadJS directory:

```
squad-server/
├── plugins/
│   └── switch.js
├── utils/
│   ├── switch-db.js
│   ├── switch-output.js
│   ├── switch-queue.js
│   └── switch-commands.js
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
| `!switch status` | Show DB health, active locks, and top-5 locked players |
| `!switch help` | List all admin commands |

### Discord Commands

**Admin:**

| Command | Description |
|---------|-------------|
| `!switch status` | Database health + RCON latency + top-5 locked players |
| `!switch check <name/steamID>` | Real-time eligibility lookup with Discord timestamps |
| `!switch clear <name/steamID>` | Remove cooldowns/locks for a player |
| `!switch clearall` | Wipe entire cooldown database |
| `!switch timelimit on|off` | Toggle the join/match time limit for queue entry |
| `!switch stats [days]` | Scrape the last N days of round summaries and show an aggregate embed with movement types, denial reasons, queue outcomes, and data quality info |
| `!switch help` | List all Discord admin commands |

When `explainChannelID` is set, the full explain embed sequence plus a 7-day reliability stats embed is auto-posted to that channel on mount and refreshed in-place every 30 minutes — admins do not need to manually run `!switch explain` to keep it current.

---

## Handshake Integration

The Switch plugin exposes a public API for external consumers (such as SmartAssign) to read and consume queue entries. This is used by the **SA-Switch Handshake** feature: when SmartAssign evaluates a joining player, it may swap them with a Switch-queued player for a more balanced outcome that also satisfies the Switch player's request.

### Public API

| Method | Signature | Description |
|--------|-----------|-------------|
| `getQueueSnapshot()` | `() → { t1ToT2: Array, t2ToT1: Array }` | Returns shallow copies of both directional sub-queues. Read-only — no side effects. Each entry exposes `{ eosID, steamID, playerName, currentTeamID, targetTeamID, queuedAt }`. `warnInterval` is NOT exposed. |
| `forceQueueSwap(eosID)` | `(String) → boolean` | Removes the player from the queue, clears warn intervals, and executes the RCON switch. Returns `true` on success, `false` if player was already consumed/cancelled/disconnected. |
| `consumeQueueEntry(eosID)` | `(String) → Entry | null` | _(Alternative)_ Removes queue bookkeeping only — does NOT execute RCON. Returns the entry or null. |

### Version Compatibility

- `static version = '2.5.0'` — seed bonus reworked around round identity rather than layer edges, absolute wallet ceiling, ENDGAME consolation grant, and two-tier row retention (schema v5, adds `lastActiveTimestamp`).
- `static version = '2.4.0'` — seed bonus min-player threshold, seed bonus disable (0-value options), and end-game seed completion grants on top of the v2.3.2 feature set.
- Consumers should check `plugin.constructor.version` (wrapped in try/catch) and require `>= 2.0.0` before using the API.

### Consumer Discovery

External plugins discover Switch at runtime via `this.server.plugins.find(p => p.constructor.name === 'Switch')`. The consumer verifies the version and method existence before enabling handshake features.

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
| `switchCooldownHours` | Hours per-token refill interval. Each token regenerates individually after this duration. | `1.75` |
| `switchCooldownMinutes` | Minutes per-token refill interval (overrides hours if > 0). Set to 0 to use hours only. | `0` |
| `switchEnabledMinutes` | Time window (minutes) after join/match start to request a switch | `10` |
| `queueTimeoutMinutes` | Minutes a player can wait in the switch queue before removal | `15` |
| `maxUnbalancedSlots` | Max player difference between teams to allow a switch | `1` |
| `scrambleLockdownDurationMinutes` | Duration to block switching after a scramble | `30` |
| `scrambleLockdownMinPlayers` | Minimum total players required to apply scramble lockdown. Below this threshold, scrambles clear the queue but do not lock switching. | `60` |

### Token System (v2.3.0, seed bonuses enhanced in v2.4.0, reworked in v2.5.0)

| Option | Description | Default |
|--------|-------------|---------|
| `maxSwitchTokens` | Maximum number of switch tokens a player can hold. Each switch consumes 1 token; tokens regenerate individually over the cooldown interval. Set to 1 for legacy flat-cooldown behavior. | `2` |
| `seedTokenBonusAmount` | Maximum bonus tokens a player can earn per seed round. Each qualifying interval grants +1 token. Also sets the absolute wallet ceiling — see below. Set to 0 to disable seed bonus tokens entirely. | `1` |
| `seedTokenBonusMinutes` | Minutes a player must be present in a seed-mode round to earn one bonus token. Set to 0 to disable seed bonus tokens entirely. | `20` |
| `seedTokenBonusMinPlayers` | Minimum number of players on the server before seed presence time accrues toward bonus tokens. Set to 0 to disable the minimum (time always accrues in seed mode). | `0` |
| `pruneInactivePlayerDays` | Days a player must be unseen before their cooldown row is pruned. Rows sitting at exactly `maxSwitchTokens` with no seed state are pruned after 30 minutes regardless, since they carry no information. Set to 0 to disable pruning entirely. | `3` |

#### Seed bonus: the wallet ceiling

`seedTokenBonusAmount` is a **per-round earning cap and an absolute wallet ceiling
at the same time**. A player can never hold more than
`maxSwitchTokens + seedTokenBonusAmount` — 3 with the defaults above.

Consequently, across consecutive seed rounds the ceiling is what actually binds:
someone who earns their bonus in the first seed round and does not spend it will
keep accruing presence in later rounds without receiving anything, because they are
already at the ceiling. They start earning again once they spend back below it.
This is deliberate — it stops bonus tokens stacking without limit over a long
seeding session.

Two grants exist:

- **Periodic** — +1 for every `seedTokenBonusMinutes` of presence in the round.
- **Consolation** — +1 at round end (the ENDGAME phase) for players who were
  present but never accrued a full interval. Only players **still connected** at
  round end qualify, and only if their presence began before ENDGAME. A player who
  leaves early keeps anything the periodic grant already gave them, but receives no
  consolation.

### Queue Timeout Switch (v2.2.0)

| Option | Description | Default |
|--------|-------------|---------|
| `queueTimeoutSwitchEnabled` | When `true`, players who reach the queue timeout are force-switched instead of removed. When `false`, they are removed from the queue with an expiry message (legacy behaviour). | `true` |
| `queueTimeoutExtraSlots` | Extra allowed team imbalance slots for timeout-triggered switches. Stacks on top of `maxUnbalancedSlots`, dynamic balance extras, and bypasses the 50/50 hard cap. | `2` |

### Double-Switch

| Option | Description | Default |
|--------|-------------|---------|
| `doubleSwitchCommands` | Array of commands that trigger a double-switch | `['!bug', '!stuck', '!doubleswitch']` |
| `doubleSwitchCooldownHours` | Hours before same player can double-switch again | `0.5` |
| `doubleSwitchDelaySeconds` | Delay between first and second team switch | `1` |
| `doubleSwitchEnabledMinutes` | Time window for double-switch after join/match start | `10` |

### End-of-Match

| Option | Description | Default |
|--------|-------------|---------|
| `endMatchSwitchSlots` | Number of end-of-match switch slots | `3` |

### Liberal Mode (Seed/Jensen)

| Option | Description | Default |
|--------|-------------|---------|
| `liberalSwitchGameModes` | Substrings for layers/modes with relaxed switching | `["Seed", "Jensen"]` |
| `liberalSwitchMaxUnbalancedSlots` | Balance cap during liberal modes | `6` |
| `liberalSwitchBroadcastIntervalMinutes` | Minutes between liberal-mode broadcast reminders. Set to 0 to disable. | `8` |

### Dynamic Balance Tolerance

| Option | Description | Default |
|--------|-------------|---------|
| `dynamicBalanceTolerance` | Enable interpolated extra tolerance below full capacity | `true` |
| `dynamicBalancePlayerFloor` | Player count at which max extra slots apply | `85` |
| `dynamicBalanceExtraSlots` | Additional imbalance slots at floor player count | `3` |

### Discord

The Switch plugin supports splitting Discord traffic across two channels. Round summaries, scramble notifications, and other automated reports always flow to `discordChannelID`. Admin commands (`!switch status/check/clear/clearall/timelimit/stats/help`) are gated to `adminCommandChannelID` when set.

| Option | Description | Default |
|--------|-------------|---------|
| `discordChannelID` | Discord channel ID for automated reports (round summaries, scramble lockdown notifications). | `""` |
| `adminCommandChannelID` | Discord channel ID for admin !switch commands. If not set, all traffic goes through `discordChannelID` (single-channel mode). | `""` |
| `explainChannelID` | Discord channel ID for auto-updating explain messages with 7-day stats. When set, the full explain embed sequence plus reliability stats are posted to this channel on mount and refreshed every 30 minutes. | `""` |

### v2.0.0 Features

| Option | Description | Default |
|--------|-------------|---------|
| `broadcastSwitchWindowMessages` | Broadcast switch window open/close/reminder messages to the server. | `true` |
| `switchWindowBroadcastDelaySeconds` | Seconds after match start before the first broadcast. | `30` |
| `switchWindowBroadcastIntervalMinutes` | Minutes between switch window reminder broadcasts. | `2` |
| `warnOnJoinChangeTeamDisabled` | Warn joining players that scoreboard team changes are disabled and !switch is the alternative. | `true` |
| `queueEnabled` | Enable the switch queue. When disabled, !switch only works if a balance slot is immediately available. | `true` |
| `roundEndSummaryEnabled` | Post a Discord embed with round-end queue summary showing self-switches, pair trades, handshake swaps, failures, expiries, disconnects, and cancellations. | `true` |

---

## Tools

The Switch plugin ships with utility scripts in `switch/tools/`.

### Behaviour Documentation Generator

The `generate-behaviour-doc.cjs` script produces an informative markdown document describing how team switching works. The generated text mirrors the `!switch explain` in-game command and Discord explain channel content.

Config values are read from a companion JSON file — edit it to experiment with different settings and see how the behaviour description changes.

**Usage:**

```bash
# Default (uses switch/tools/behaviour-config.json, writes switch/SWITCH_BEHAVIOUR.md)
node switch/tools/generate-behaviour-doc.cjs

# Custom config file
node switch/tools/generate-behaviour-doc.cjs --config my-config.json

# Custom output path
node switch/tools/generate-behaviour-doc.cjs --output docs/custom-behaviour.md

# Both
node switch/tools/generate-behaviour-doc.cjs --config my-config.json --output out.md

# Help
node switch/tools/generate-behaviour-doc.cjs --help
```

The default config (`behaviour-config.json`) mirrors the plugin's own default values. Create a copy, tweak the numbers, and re-run to preview how the documentation (and thus the player-facing rules) would change.

---

## Author

**Original Author:** [fantinodavide](https://github.com/fantinodavide)  
**Modified by:** Slacker  
**Discord:** `real_slacker`  
**GitHub:** https://github.com/mikebjoyce

---

*Built for SquadJS*