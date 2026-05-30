# EloTracker Plugin v1.3.0

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

**[squadjs-team-balancer](https://github.com/mikebjoyce/squadjs-team-balancer)**

When `useEloForBalance: true` is set in TeamBalancer, its scoring function switches to an ELO-weighted branch. It pulls live mu ratings and regular player counts from EloTracker at scramble time, evaluating mu difference, regular parity, and numerical balance (replacing its standard heuristic penalties). This prevents skill stacks from reforming after a scramble.

No additional configuration is needed on the EloTracker side. TeamBalancer finds the EloTracker instance automatically at runtime and falls back to pure numerical balance silently if EloTracker data is unavailable.

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
    "database": "sqlite",
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
    "ignoredGameModes": ["Seed", "Jensen"],
    "enablePublicIngameCommands": true,
    "enableDatabaseLogging": false
  }
]
```

**Database Options:** The `"database"` option should match a connector name from above. Use `"sqlite"` for file-based storage (default), `"mysql"` for MySQL, or `"postgres"` for PostgreSQL. Any Sequelize-compatible backend is supported.

### 2. File Placement

Move the project files into your SquadJS directory:

```
squad-server/
├── plugins/
│   └── elo-tracker.js
└── utils/
    ├── elo-calculator.js
    ├── elo-commands.js
    ├── elo-database.js
    ├── elo-discord.js
    └── elo-session-manager.js
```

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
- `!eloadmin reset <name | steamID>` — Reset a player to default rating.

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

---

## ⚠️ Critical Notes

### deltaSigma Direction

The `deltaSigma` returned by the calculator is a **reduction value**, applied as:

```
newSigma = sigma - deltaSigma
```

This is intentional. **Do not change this to addition.**

### bulkIncrementPlayerStats Is Incremental

`bulkIncrementPlayerStats()` **adds** to existing `wins`, `losses`, and `roundsPlayed` counts. It does **not** overwrite them. Do not pass cumulative totals — pass only the delta for the current round.

---

## Author

**Slacker**

- **Discord:** `real_slacker`
- **GitHub:** https://github.com/mikebjoyce

---

*Built for SquadJS*
