# SquadJS Slackers Suite

**Monorepo for S³ (SlackersSquadServices), its consumer plugins — SmartAssign, Switch, EloTracker, and TeamBalancer — and S³-backed upgrades of stock SquadJS core plugins (`core-plugins/`).**

## Overview

This repository contains a suite of SquadJS plugins built around **S³ (SlackersSquadServices)**, a centralized service container that owns the ground truth for server configuration, game-state lifecycle, player state, faction metadata, clan grouping, database access, logging, and cross-plugin event routing.

The four consumer plugins — **SmartAssign**, **Switch**, **EloTracker**, and **TeamBalancer** — all depend on S³ and coordinate through its shared services rather than duplicating state or communicating directly.

`core-plugins/` holds a second category: S³-backed drop-in replacements for
*stock SquadJS core* plugins — same class/file name as the original, safety
and robustness fixes only, no new features or config surface. Installing one
overwrites the original file in place rather than adding a second,
differently-named plugin alongside it. Files sit flat in `core-plugins/` as
`<name>.js` (no per-plugin subfolder) since these are single-file drop-ins
with no `utils/` of their own; each plugin's full writeup lives in its own
top-of-file docblock rather than a separate README.

For the design rationale and architectural decisions behind S³, see **[WHY_S3.md](WHY_S3.md)**.

| Plugin | Directory | Description |
|--------|-----------|-------------|
| **S³ (SlackersSquadServices)** | [`s3/`](s3/) | Centralized service container — required by all other plugins |
| **SmartAssign** | [`smart-assign/`](smart-assign/) | Automatic team assignment with clan-aware balancing |
| **Switch** | [`switch/`](switch/) | Team-change management with cooldowns, queues, and scramble lockout — [behaviour reference](switch/SWITCH_BEHAVIOUR.md) |
| **EloTracker** | [`elo-tracker/`](elo-tracker/) | Player rating tracking with round history |
| **TeamBalancer** | [`team-balancer/`](team-balancer/) | Scramble-based team balancing with clan grouping |
| **DBLog** *(core upgrade)* | [`core-plugins/db-log.js`](core-plugins/db-log.js) | Drop-in, DB-outage-safe replacement for core's `db-log.js` stats logger |

## Mount Order

S³ **must** be mounted before any consumer plugin. In your SquadJS `config.json`, place `SlackersSquadServices` as the first entry in the `plugins` array:

```json
{
  "plugins": [
    {
      "plugin": "SlackersSquadServices",
      "enabled": true,
      "database": "sqlite",
      "discordClient": "discord",
      "channelID": ""
    },
    {
      "plugin": "SmartAssign",
      "enabled": true,
      "enableSmartAssign": true,
      "enableEventLogging": false,
      "logPath": "./smart-assign-log.jsonl",
      "handshakeWithSwitch": true,
      "handshakeScoreThreshold": 0.5,
      "handshakeMode": "queueDrain"
    },
    {
      "plugin": "Switch",
      "enabled": true,
      "database": "sqlite",
      "discordClient": "discord",
      "channelID": "",
      "switchCooldownHours": 1.75,
      "switchCooldownMinutes": 0,
      "switchEnabledMinutes": 10,
      "maxUnbalancedSlots": 1,
      "scrambleLockdownDurationMinutes": 30,
      "broadcastSwitchWindowMessages": true,
      "queueEnabled": true,
      "discordChannelID": ""
    },
    {
      "plugin": "EloTracker",
      "enabled": true,
      "discordClient": "discord",
      "discordPublicChannelID": "",
      "discordAdminChannelID": "",
      "minPlayersForElo": 80,
      "minRoundsForLeaderboard": 10,
      "enablePublicIngameCommands": false
    },
    {
      "plugin": "TeamBalancer",
      "enabled": true,
      "discordClient": "discord",
      "enableWinStreakTracking": true,
      "enableSeedAutoScramble": true,
      "maxWinStreak": 2,
      "scrambleAnnouncementDelay": 25,
      "scramblePercentage": 0.5,
      "useEloForBalance": true,
      "discordAdminChannelID": ""
    }
  ]
}
```

Internally, S³ services mount in this order to satisfy dependency chains:

```
serverConfig → db → gameState → factions → clans → players → logging
```

Consumer plugins discover S³ at runtime and access services through flat getters (`this._s3?.gameState`, `this._s3?.players`, etc.) guarded by `isReady()` checks.

## S³ Version Compatibility

S³ is currently **v1.5.0**. Each consumer plugin declares its own floor — they are
not all the same, so pinning S³ to the lowest one will stop the others mounting:

| Consumer | Requires S³ ≥ | Why |
|---|---|---|
| SmartAssign | 1.0.0 | Baseline service container |
| TeamBalancer | 1.0.0 | Baseline service container |
| DBLog *(core upgrade)* | 1.0.0 | Baseline service container |
| EloTracker | 1.2.4 | |
| Switch | 1.4.0 | Seed-bonus grants need accessors added in 1.4.0; on an older S³ they are `undefined` and the UPDATE throws mid-grant |

Each plugin enforces its floor at runtime via `_checkS3Version()`, which throws on
mismatch. There is no silent degradation — an incompatible S³ means the consumer
plugin fails to mount.

## Installation

### Prerequisites

- A running [SquadJS](https://github.com/Team-Silver-Sphere/SquadJS) server
- A Sequelize-compatible database connector (SQLite, PostgreSQL, or MySQL)
- A Discord bot token (for Discord-enabled plugins)

### Quick Start

**Recommended:** Use the install script to assemble only the plugins you need. S³ is always auto-included since every consumer plugin depends on it.

```bash
# Node.js (cross-platform)
node install.cjs --plugin=all

# Bash (Linux/macOS/WSL) — a thin wrapper that forwards to install.cjs,
# so both take exactly the same flags and behave identically.
./install.sh --plugin=all
```

This produces an `out/` folder with the correct `plugins/` and `utils/` layout. Supported flags:

| Flag | Description |
|---|---|
| `--plugin=<name>` | Plugin(s) to install: `s3`, `team-balancer`, `elo-tracker`, `smart-assign`, `switch`, `db-log`, or `all` (comma-separated). S3 is always auto-included. |
| `--output=<path>` | Output directory (default: `./out`) |
| `--with-tools` | Also copy `tools/` directories |
| `--with-testing` | Also copy `testing/` directories |
| `--force`, `-f` | Skip the overwrite confirmation prompt. Required when the output directory already holds files that would be overwritten. |
| `--clean` | **Destructive.** Wipes the output directory before copying — *all* of it, including files that have nothing to do with this suite. Only ever point it at a dedicated output directory, never at a live SquadJS install. |
| `--help`, `-h` | Print usage and exit |

Examples:
```bash
node install.cjs --plugin=team-balancer                      # TeamBalancer + S3
node install.cjs --plugin=switch,smart-assign                # Switch + SmartAssign + S3
node install.cjs --plugin=db-log                             # DBLog (core-plugins/db-log.js) + S3
node install.cjs --plugin=all --with-tools                   # Everything including tools
node install.cjs --plugin=all --output=../squadjs/squad-server  # Write directly to SquadJS
```

Then copy the contents of `out/` (or your custom output directory) into your SquadJS `squad-server/` folder.

**Manual installation** (if you prefer to copy files by hand):

For each plugin you want to install, copy its `plugins/` and `utils/` directories into your SquadJS `squad-server/` folder:

```
squad-server/
├── plugins/
│   ├── slackers-squad-services.js    (from s3/plugins/)
│   ├── s3-plugin-base.js             (from s3/plugins/)
│   ├── s3-discord-plugin-base.js     (from s3/plugins/)
│   ├── smart-assign.js               (from smart-assign/plugins/)
│   ├── switch.js                     (from switch/plugins/)
│   ├── elo-tracker.js                (from elo-tracker/plugins/)
│   ├── team-balancer.js              (from team-balancer/plugins/)
│   └── db-log.js                     (from core-plugins/ — overwrites core's file of the same name)
└── utils/
    ├── game-state-service.js         (from s3/utils/)
    ├── db-service.js                 (from s3/utils/)
    ├── players-service.js            (from s3/utils/)
    ├── clans-service.js              (from s3/utils/)
    ├── factions-service.js           (from s3/utils/)
    ├── server-config-service.js      (from s3/utils/)
    ├── logging-service.js            (from s3/utils/)
    └── ...                           (other S³ utils)
```

### Then, whichever path you took

1. **Configure connectors** — Add `database` and `discordClient` connectors to your `config.json`:

   ```json
   "connectors": {
     "sqlite": {
       "dialect": "sqlite",
       "storage": "squad-server.sqlite"
     },
     "discord": {
       "connector": "discord",
       "token": "YOUR_BOT_TOKEN"
     }
   }
   ```

2. **Add plugins to `config.json`** — Follow the mount order above. S³ must be first.

3. **Configure plugin options** — Each plugin has its own options. See the individual plugin READMEs for details:
   - [S³ Configuration](s3/README.md#configuration-options)
   - [SmartAssign](smart-assign/README.md#configuration-options)
   - [Switch](switch/README.md#configuration-options) — [Behaviour Reference](switch/SWITCH_BEHAVIOUR.md)
   - [EloTracker](elo-tracker/README.md#configuration-options)
   - [TeamBalancer](team-balancer/README.md#configuration-options)
   - [DBLog (core upgrade)](core-plugins/db-log.js) — see its top-of-file docblock; no config changes needed if you already run core's `db-log.js`

### Logging

S³, SmartAssign, TeamBalancer, and EloTracker each ship an `enableDatabaseLogging`
option, and it's **on by default** on all of them. S³ writes its shared event/snapshot
tables (`S3_PlayerEvents`, `S3_GameStateEvents`, `S3_PlayerSnapshots`); each consumer
plugin writes its own history table alongside that (SmartAssign's `SA_AssignmentLog`,
TeamBalancer's `TB_RoundReport`, EloTracker's round history).

This isn't just bookkeeping — S³'s `!s3 switches` and `!s3 karma` Discord commands read
directly from S³'s tables, and TeamBalancer's own games-played/round-outcome accounting
reads from `TB_RoundReport`. Turning either toggle off independently is handled
gracefully — both commands detect the gap and say so instead of showing a false zero.

If you don't want the DB writes on a given plugin — smaller database, or you only want
the JSONL/file output — set `enableDatabaseLogging: false` on that plugin's config
block. JSONL/file logging is a separate set of options per plugin (e.g. SmartAssign's
`enableEventLogging` + `logPath`, S³'s `enableFileLogging`) and is unaffected either way.

## For Plugin Developers

If you're building a new plugin that consumes S³, see the **[S³ Developer Guide](s3/S3_DEVELOPER_GUIDE.md)** — it covers the service catalog, access patterns, base classes (`S3PluginBase` / `S3DiscordPluginBase`), migration workflow, event model, and integration checklist.

## Testing

Every plugin carries its own suite. To run all of them in one command:

```bash
node testing/run-all-tests.js                 # the whole suite
node testing/run-all-tests.js --fast          # skip the slow randomised sweeps
node testing/run-all-tests.js --plugin=s3     # one plugin
```

Exit code 0 means every plugin's runner exited 0. Individual suites can still be
run directly — see each plugin's README — and S³'s own runner takes categories:

```bash
node s3/testing/run-all-tests.js --category 1    # Standalone — no server, no game
node s3/testing/run-all-tests.js --category 2    # Mock-based — no live server
node s3/testing/run-all-tests.js --category 4    # Multi-dialect permissions (needs Docker)
```

Category 3 is the human-led test plans; the runner lists them rather than
executing them. Passing no `--category` runs 1, 2 and 3.

### Database changes: a green run is not enough

These plugins persist to SQLite or MySQL on live game servers, and the suites that
exercise a real database **skip themselves when the engine is unreachable** — so a
run with no MySQL container reports all-pass having tested SQLite only.

Start the engines before touching anything that reads or writes the database:

```bash
docker run -d --name s3-test-mysql    -e MYSQL_ROOT_PASSWORD=root   -p 3307:3306 mysql:8
docker run -d --name s3-test-postgres -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:16-alpine
```

Then check the output says `mysql reachable` and `0 skipped`, not just that the
exit code was 0. Ports are overridable via `S3_TEST_MYSQL_HOST` / `_PORT` /
`_ROOT_USER` / `_ROOT_PASSWORD` / `_DATABASE`. Postgres is supported but not
deployed anywhere — SQLite and MySQL are the ones that matter.

Mocks cannot prove SQL correctness: identifier quoting, type coercion and collation
are properties of the engine. Assert by reading rows back out of a real database.
Full rules and the pre-push checklist are in `s3/S3_DEVELOPER_GUIDE.md` §11.

### Verifying on a real server

`dev-harness/` is a test-only SquadJS plugin (never installed by `install.cjs`)
that executes RCON commands and `!s3` subcommands dropped into a watched directory
as JSON, and writes the results — plus an S³ state snapshot and a round-lifecycle
tape — back to disk. It is how a change gets confirmed against a running Squad
server rather than against a mock. See `dev-harness/README.md`.

## Author

**Slacker**

Discord: `real_slacker`

GitHub: https://github.com/mikebjoyce

## Thanks

- **Davide Fantino** ([fantinodavide](https://github.com/fantinodavide)) — For the open-source Switch plugin that the v2 Switch is based on.
- **Hans-Vader** ([Hans-Vader](https://github.com/Hans-Vader)) — For contributions to the Team Balancer plugin.

---

*Built for SquadJS — current as of 2026-08-20*
