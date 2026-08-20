# EloTracker Plugin v2.1.6

**SquadJS Plugin for Skill-Based Player Rating**

## Overview

Tracks player skill across rounds using a **TrueSkill-based** rating system. Each player is assigned a **μ (mu)** skill estimate and a **σ (sigma)** uncertainty value that converge toward a stable rating over time. Ratings update after every round based on team outcome, team strength, and how long each player participated.

Designed for Squad servers to surface skill data, reward consistent players, and provide server admins and players with transparent, fair ratings grounded in a proven algorithm.

---

## Core Features

* **TrueSkill Rating Engine:** Implements the full TrueSkill algorithm with team-based win, loss, and draw outcomes.
* **Participation Weighting:** Rating changes are scaled by how long a player was actually on their team. Late joiners and early leavers receive proportionally smaller adjustments.
* **Team-Switch Tracking:** Segment-based session tracking detects mid-round team switches. Players are assigned to the team they spent the most time on.
* **Match Health Metrics:** Live tracking of skill balance, regular player parity, and Top 15 player averages to assess team fairness.
* **Discord Integration:** Full-featured Discord bot interface for player lookups, leaderboards, and account linking.
* **In-Game Commands:** Players can check their own rating and view the leaderboard directly from the in-game chat.
* **Persistent Storage:** Multi-database support via Sequelize (SQLite, MySQL, PostgreSQL, etc.). Round history, player stats, and plugin state survive server restarts.
* **Provisional Ratings:** Players are marked provisional until they reach a configurable minimum round count.
* **Backup & Restore:** Full player stat export to JSON and restore via Discord file attachment.
* **Database Logging:** Optional logging of round outcome data into database tables for querying and cross-plugin integration.

---

## TrueSkill Rating System

EloTracker uses a TrueSkill-derived algorithm — the same family of systems used by Xbox Live — adapted for Squad's team format.

### Key Concepts

| Symbol | Name | Meaning |
|---|---|---|
| **CSR** | Competitive Skill Rank | Your visible score on the leaderboard. Calculated as **μ - 3.0σ** to encourage active play. |
| **μ (mu)** | Base Skill | Your estimated true performance level. Starts at **25.0**. |
| **σ (sigma)** | Uncertainty | The system's confidence in your rating. Starts at **~8.33** and decreases as you play. |
| **τ (tau)** | Dynamic Floor | Prevents uncertainty from reaching zero, ensuring ratings can always adjust to future performance changes. Starts at **0.25**. |

### Calibration Stages

Sigma communicates how stable a player's rating is:

| Sigma Range | Status |
|---|---|
| σ ≤ 2.5 | Highly Calibrated |
| σ ≤ 4.5 | Calibrated |
| σ ≤ 6.5 | Establishing |
| σ > 6.5 | Initial Calibration |

A dynamic uncertainty floor (τ/tau) prevents sigma from reaching zero, ensuring ratings can always respond to future performance.

---

## Compatible Plugins

### TeamBalancer

**[squadjs-team-balancer](https://github.com/mikebjoyce/squadjs-slackers-suite/tree/master/team-balancer)**

When `useEloForBalance: true` is set in TeamBalancer, its scoring function switches to an ELO-weighted branch. It pulls live mu ratings and regular player counts from EloTracker at scramble time, evaluating mu difference, regular parity, and numerical balance (replacing its standard heuristic penalties). This prevents skill stacks from reforming after a scramble.

No additional configuration is needed on the EloTracker side. TeamBalancer finds the EloTracker instance automatically at runtime and falls back to pure numerical balance silently if EloTracker data is unavailable.

---

### S³ (Slacker's Squad Services)

**[squadjs-slackers-squad-services](https://github.com/mikebjoyce/squadjs-slackers-suite/tree/master/s3)**

S³ is the centralised service container for shared state across Slacker's Squad plugins. EloTracker uses it as the primary data source for game-state metadata — round start time, layer name, gamemode, and ignored-mode detection.

**Requires S³ ≥1.2.4.**

**Why this matters**: Rather than maintaining its own round-time tracking, EloTracker reads ground-truth data from S³'s `gameState` service — `getRoundStartTime()`, `getLayerName()`, `getGamemode()`, and `isIgnoredMode()`. This ensures cross-plugin consistency: SA and TB refer to the same roundStartTime and matchId during team assignment and balancing. EloTracker also listens for `TEAM_BALANCER_SCRAMBLE_EXECUTED` to capture a team-balance snapshot post-scramble for Discord reporting.

**Setup**: Install S³ in `config.json` **before** EloTracker, so it mounts first. S³ is auto-discovered at runtime via `this.server.plugins`.

S³ is **required, not optional** — there is no fallback path. `S3PluginBase._resolveS3()` throws if it cannot find SlackersSquadServices, and `_checkS3Version()` throws if the version is below the floor. Either way EloTracker fails to mount rather than degrading quietly.

---

## Installation

### 1. Configuration

Add the following to your `config.json`:

```json
"connectors": {
  "sqlite": {
    "dialect": "sqlite",
    "storage": "squad-server.sqlite"
  },
  //"mysql": {
  //  "dialect": "mysql",
  //  "host": "localhost",
  //  "port": 3306,
  //  "username": "squad",
  //  "password": "password",
  //  "database": "squad_db"
  //},
  //"postgres": {
  //  "dialect": "postgres",
  //  "host": "localhost",
  //  "port": 5432,
  //  "username": "squad",
  //  "password": "password",
  //  "database": "squad_db"
  //},
  "discord": {
    "connector": "discord",
    "token": "YOUR_BOT_TOKEN"
  }
},
"plugins": [
  {
    "plugin": "EloTracker",
    "enabled": true,
    "discordClient": "discord",
    "discordPublicChannelID": "YOUR_CHANNEL_ID",
    "discordAdminChannelID": "YOUR_ADMIN_CHANNEL_ID",
    "discordReportChannelID": "",
    "discordAdminRoleIDs": [],
    "eloLogPath": "./elo-match-log.jsonl",
    "minParticipationRatio": 0.15,
    "minPlayersForElo": 80,
    "minRoundsForLeaderboard": 10,
    "roundStartEmbedDelayMs": 180000,
    "enablePublicIngameCommands": true,
    "enableDatabaseLogging": true
  }
]
```

**Database:** EloTracker has no `database` option and never opens a connector of its own. It defines its models on S³'s connector, so the engine is whatever `database` is set to on the **SlackersSquadServices** plugin — SQLite, MySQL, Postgres, or any Sequelize-compatible backend. The commented-out connectors above are there so you can point S³ at one.

### 2. File Placement

Move the project files into your SquadJS directory:

```
squad-server/
├── plugins/
│   └── elo-tracker.js
├── utils/
│   ├── elo-calculator.js
│   ├── elo-commands.js
│   ├── elo-database.js
│   ├── elo-discord.js
│   └── elo-session-manager.js
├── testing/ (optional)
│   ├── run-all-tests.js
│   ├── test-clan-grouping.js
│   ├── test-elo-calculator.js
│   ├── test-elo-database.js
│   ├── test-elo-session-manager.js
│   ├── test-elo-simulation.js
│   └── test-elo-tracker.js
└── tools/
    ├── analyze-spread.js
    ├── elo-calibrate.js
    ├── elo-clan-grouping.js
    ├── elo-clans-audit.js
    ├── elo-inspect.js
    ├── elo-rebuild.js
    ├── merge-match-logs.js
    └── TOOLS_README.md
```

---

## Configuration Options

| Option | Required | Type | Default | Description |
|--------|----------|------|---------|-------------|
| `discordClient` | no | string | `"discord"` | Discord connector name for Discord integration |
| `discordPublicChannelID` | no | string | `""` | Discord channel ID for public commands (`!elo`, `!elo leaderboard`, etc.) |
| `discordAdminChannelID` | no | string | `""` | Discord channel ID for admin commands (`!elo status`, `!elo backup`, etc.) |
| `discordReportChannelID` | no | string | `""` | Discord channel ID for automated round reports (defaults to admin channel if unset) |
| `discordAdminRoleIDs` | no | array | `[]` | Array of Discord role IDs required for admin commands (empty = all in channel) |
| `eloLogPath` | no | string | `"./elo-match-log.jsonl"` | File path for JSONL match log output |
| `minParticipationRatio` | no | number | `0.15` | Minimum participation ratio (0.0–1.0) for a player to receive rating changes |
| `minPlayersForElo` | no | number | `80` | Minimum connected players required to calculate ELO updates |
| `minRoundsForLeaderboard` | no | number | `10` | Minimum rounds played before a player appears on the leaderboard |
| `roundStartEmbedDelayMs` | no | number | `180000` | Delay in ms before posting the round-start Discord embed (default: 3 minutes) |
| `enablePublicIngameCommands` | no | boolean | `false` | Enable public in-game commands (`!elo`, `!elo leaderboard`) |
| `enableDatabaseLogging` | no | boolean | `true` | If true, round outcome data is also written to database tables |

---

## Commands

### Tools & Scripts

- `node tools/elo-clans-audit.js [path/to/db.json]` — Generates a report (`tools/clan-audit.txt`) testing the tag extraction and normalization logic against a database export. Useful for finding unhandled clan tag variations.
- `node tools/elo-inspect.js <rebuilt.json>` — Interactive CLI tool mimicking Discord commands for local testing and DB inspection.

### In-Game Commands

**Public (all players):**

- `!elo` — View your current ELO rating and record.
- `!elo <name | steamID>` — Look up another player's rating.
- `!elo leaderboard` — Top 10 players by CSR.
- `!elo help` — Show available commands.

**Admin (ChatAdmin channel only):**

- `!eloadmin status` — Plugin status, session count, and round info.
- `!eloadmin reset <name | steamID>` — Reset a player to default rating. Requires an **exact** identifier (see [Name Lookup](#name-lookup)); a partial name is refused with the list of candidates.

### Discord Commands

**Public:**

- `!elo` — Look up your own linked stats, including a personal local leaderboard.
- `!elo <name | steamID | eosID>` — Look up another player.
- `!elo link <SteamID>` — Link Discord to SteamID (auto-deletes for privacy).
- `!elo leaderboard [rank]` — Show 25 players, optionally centered around a specific rank.
- `!elo clans` — Show the top 25 clans ranked by average CSR.
- `!elo clan <tag>` — Show detailed roster and stats for a specific clan.
- `!elo explain` — Explains the algorithm and symbols.

**Admin (admin channel only):**

- `!elo status` — Plugin diagnostics and cache state.
- `!elo roundinfo` — Live snapshot of team balance.
- `!elo clans [n|all]` — Advanced clan leaderboard (n up to 50, "all" for all tags).
- `!elo backup` — Export player stats as JSON.
- `!elo restore` — Restore from an attached JSON backup.
- `!elo reset confirm` — Wipe **ALL** database ratings.
- `!elo reset <name | steamID>` — Reset one player. Like the in-game form, requires an exact identifier.

---

## Name Lookup

Every `!elo <identifier>` path — in game and in Discord — resolves the term
through one ranked search, so all of them pick the same player.

Candidates fall into tiers, and the best tier present wins outright:

| Tier | Match |
|------|-------|
| 0 | Exact `eosID` or `steamID` |
| 1 | Exact name, case-insensitive — either as stored (compared against `TRIM(name)`, since Squad stores most names with a leading space) or once clan tags are stripped (`[NL] Cerv` → `Cerv`) |
| 2 | Prefix of the raw or tag-stripped name |
| 3 | Substring anywhere in the name |

Ties **within** a tier are broken by: currently on the server, then most rounds
played, then most recently seen. Online never beats a better tier.

A clan tag is treated as decoration, not identity, so a stored name and a
tag-stripped one compete on equal footing and rounds played decides. `!elo hunty`
returns the 384-round `[✦NL✦] Hunty`, not the 12-round ` Hunty` that happens to
hold the bare string. The trade-off: an account whose stored name equals another
player's tag-stripped name can no longer be reached by name — use its SteamID, or
bare `!elo` if it is your own. On the production data set 51 names of 11,484 are
affected.

When the result was a guess — the top tier is a prefix or substring hit, or two
players tie at the best tier — the reply names the runners-up
(`Also matched: Hunty (12 rds)…`) rather than silently resolving to one of them.
A unique exact match shows no such line. Searches are case-insensitive on every
supported database engine.

Destructive commands (`!eloadmin reset`, `!elo reset <identifier>`) require an
**unambiguous** match: tier 0–1 **and** nobody else matching at that same tier.
So `reset cerv` works when one player strips to `Cerv`, but is refused when both
`[NL] Cerv` and `[US] Cerv` exist — otherwise it would silently wipe whichever
had more rounds. Anything less lists the candidates and changes nothing.

On the production data set this refuses roughly 3% of full-name resets: mostly
genuine duplicate names (23 players are named `Reaper`), plus the 41 rows where a
stored name ties a tag-stripped one. Use a SteamID for those.

> Before this was ranked, the lookup was an unordered `findOne`: any substring
> hit could win depending on row order, so `!elo cerv` could return a 2-round
> `Cerveira` instead of the 267-round `[NL] Cerv`.

---

## Technical Logic

### Participation Ratio

A player's rating change is scaled by their time in the round:

- **Full round:** 100% of calculated delta.
- **Half round:** ~50% of calculated delta.
- **Team switching:** Player is assigned to the team they spent the majority of the round on.

### Leaderboard & Ranking

- **Eligibility:** Players must reach `minRoundsForLeaderboard` to receive an official rank.
- **Sorting:** Ranked by **Competitive Skill Rank (CSR) (μ - 3.0σ)**. This ensures that leaderboard scores require both high skill and low uncertainty, encouraging active play.
- **Provisional:** Players below the threshold are visible but unranked.

## Author

**Slacker**

- **Discord:** `real_slacker`
- **GitHub:** https://github.com/mikebjoyce

---

*Built for SquadJS*