# SquadJS Slackers Suite

**Monorepo for S³ (SlackersSquadServices) and its consumer plugins — SmartAssign, Switch, EloTracker, and TeamBalancer.**

## Overview

This repository contains a suite of SquadJS plugins built around **S³ (SlackersSquadServices)**, a centralized service container that owns the ground truth for server configuration, game-state lifecycle, player state, faction metadata, clan grouping, database access, logging, and cross-plugin event routing.

The four consumer plugins — **SmartAssign**, **Switch**, **EloTracker**, and **TeamBalancer** — all depend on S³ and coordinate through its shared services rather than duplicating state or communicating directly.

| Plugin | Directory | Description |
|--------|-----------|-------------|
| **S³ (SlackersSquadServices)** | [`s3/`](s3/) | Centralized service container — required by all other plugins |
| **SmartAssign** | [`smart-assign/`](smart-assign/) | Automatic team assignment with clan-aware balancing |
| **Switch** | [`switch/`](switch/) | Team-change management with cooldowns, queues, and scramble lockout |
| **EloTracker** | [`elo-tracker/`](elo-tracker/) | Player rating tracking with round history |
| **TeamBalancer** | [`team-balancer/`](team-balancer/) | Scramble-based team balancing with clan grouping |

## Mount Order

S³ **must** be mounted before any consumer plugin. In your SquadJS `config.json`, place `SlackersSquadServices` as the first entry in the `plugins` array:

```json
{
  "plugins": [
    { "plugin": "SlackersSquadServices", "enabled": true,
      "options": { "database": "sqlite", "discordClient": "discord", "channelID": "..." } },
    { "plugin": "SmartAssign", "enabled": true, "options": { ... } },
    { "plugin": "Switch", "enabled": true, "options": { ... } },
    { "plugin": "EloTracker", "enabled": true, "options": { ... } },
    { "plugin": "TeamBalancer", "enabled": true, "options": { ... } }
  ]
}
```

Internally, S³ services mount in this order to satisfy dependency chains:

```
serverConfig → db → gameState → factions → clans → players → logging
```

Consumer plugins discover S³ at runtime and access services through flat getters (`this._s3?.gameState`, `this._s3?.players`, etc.) guarded by `isReady()` checks.

## S³ Version Compatibility

**Compatibility floor: S³ ≥ 1.0.0**

All four consumer plugins enforce this at runtime via `_checkS3Version()`, which throws on mismatch. There is no silent degradation — if the S³ version is incompatible, the consumer plugin will fail to mount.

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

# Bash (Linux/macOS/WSL)
./install.sh --plugin=all
```

This produces an `out/` folder with the correct `plugins/` and `utils/` layout. Supported flags:

| Flag | Description |
|---|---|
| `--plugin=<name>` | Plugin(s) to install: `s3`, `team-balancer`, `elo-tracker`, `smart-assign`, `switch`, or `all` (comma-separated). S3 is always auto-included. |
| `--output=<path>` | Output directory (default: `./out`) |
| `--with-tools` | Also copy `tools/` directories |
| `--with-testing` | Also copy `testing/` directories |

Examples:
```bash
node install.cjs --plugin=team-balancer                      # TeamBalancer + S3
node install.cjs --plugin=switch,smart-assign                # Switch + SmartAssign + S3
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
│   └── team-balancer.js              (from team-balancer/plugins/)
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

2. **Configure connectors** — Add `database` and `discordClient` connectors to your `config.json`:

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

3. **Add plugins to `config.json`** — Follow the mount order above. S³ must be first.

4. **Configure plugin options** — Each plugin has its own options. See the individual plugin READMEs for details:
   - [S³ Configuration](s3/README.md#configuration-options)
   - [SmartAssign](smart-assign/README.md)
   - [Switch](switch/README.MD#configuration-options)
   - [EloTracker](elo-tracker/README.md)
   - [TeamBalancer](team-balancer/README.md)

## For Plugin Developers

If you're building a new plugin that consumes S³, see the **[S³ Developer Guide](s3/S3_DEVELOPER_GUIDE.md)** — it covers the service catalog, access patterns, base classes (`S3PluginBase` / `S3DiscordPluginBase`), migration workflow, event model, and integration checklist.

## Testing

Each plugin includes its own test suite. See individual plugin READMEs for test commands. S³'s test suite can be run via:

```bash
cd s3/testing
node run-all-tests.js --category 1    # Unit tests
node run-all-tests.js --category 2    # Integration tests
```

## Author

**Slacker** — Discord: `real_slacker`

---

*Built for SquadJS — current as of 2026-07-20*