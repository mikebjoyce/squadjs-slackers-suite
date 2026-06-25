# SlackersSquadServices (S³) Plugin v1.0.0

**Centralised service container for shared state across SquadJS plugins**

## Overview

SlackersSquadServices (S³) is a SquadJS plugin that owns the ground truth for server configuration, game-state lifecycle, player state, faction metadata, clan grouping, database access, and cross-plugin event routing. Instead of each consumer plugin managing its own player registry, game-state cache, or database connector, S³ provides six shared services that consumer plugins discover at runtime.

Consumer plugins access S³ via `this.server.plugins` lookup, then use flat getters (e.g. `this._s3?.gameState`) guarded by `isReady()` checks. S³ must be mounted before any consumer plugin that depends on it.

---

## Core Features

* **Service Container Architecture**: Six independent services (db, gameState, factions, clans, players, serverConfig) constructed and mounted in a specific dependency order.
* **Flat Access Pattern**: Services are accessed via `this._s3?.gameState`, `this._s3?.players`, etc. — no `services` wrapper.
* **`isReady()` Guards**: Every service exposes an `isReady()` method returning a boolean. Consumer code gates service usage with this guard.
* **Database Service**: Centralises retry/jitter/lock handling for Sequelize operations. SQLite connectors get a per-connector promise-chain mutex and WAL PRAGMA bootstrap.
* **Game-State Lifecycle**: Tracks round phases (LIVE → ENDGAME → NEW_GAME), round start times, match IDs, layer/gamemode resolution, and faction vote status. Survives server restarts via DB persistence.
* **Player Registry**: Centralised player state with move attribution, reconnect memory, and priority-based locking.
* **Clan Tag Service**: Extracts and normalises clan tags from player names, with caching and team-assignment helpers.
* **Faction Service**: Resolves team/faction abbreviations for cross-plugin parity.
* **Server Config Service**: Parses Squad server configuration files and caches key values for runtime access.

---

## Compatible / Recommended Plugins

S³ is a **supporting** plugin — it provides infrastructure to the following consumer plugins:

### TeamBalancer

**[squadjs-team-balancer](https://github.com/mikebjoyce/squadjs-team-balancer)**

Consumes `gameState` (round lifecycle, layer/mode detection), `players` (player lists for scramble evaluation), `factions` (team name resolution), and `clans` (clan tag grouping during scrambles).

### SmartAssign

**[squadjs-smart-assign](https://github.com/mikebjoyce/squadjs-smart-assign)**

Consumes `gameState` (round metadata, mode checks), `players` (reconnect memory, move attribution, refresh interest), and `clans` (tag extraction, normalisation, cache).

### Switch (TeamBalancer-Aware Fork)

**[squadjs-switch-teambalancer-aware](https://github.com/mikebjoyce/squadjs-switch-teambalancer-aware)**

Consumes `players` (join-time lookups, move attribution, stale-player polling) and `gameState` (endgame faction vote detection for switch suppression).

### EloTracker

**[squadjs-elo-tracker](https://github.com/mikebjoyce/squadjs-elo-tracker)**

Consumes `gameState` (round start times, match IDs, layer/mode detection) and `players` (player roster for rating calculations).

---

## Installation

### 1. Configuration

Add the following to your SquadJS `config.json`. S³ must appear in the `plugins` array **before** any consumer plugin (TB, SA, Switch, Elo) so it is mounted first.

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
},
"plugins": [
  {
    "plugin": "SlackersSquadServices",
    "enabled": true,
    "database": "sqlite",
    "discordClient": "discord",
    "channelID": "YOUR_CHANNEL_ID",
    "configPath": "./SquadGame/ServerConfig/",
    "ignoredGameModes": ["Seed", "Jensen"],
    "enableClanTagGrouping": false,
    "minClanGroupSize": 2,
    "maxClanGroupSize": 18,
    "clanTagMaxEditDistance": 1,
    "clanTagCaseSensitive": false,
    "clanTagIgnoreList": [],
    "clanGroupingPullEntireSquads": false
  },
  ... consumer plugins follow ...
]
```

### 2. File Placement

```
squad-server/
├── plugins/
│   └── slackers-squad-services.js
├── utils/
│   ├── game-state-service.js
│   ├── server-config-service.js
│   ├── db-service.js
│   ├── factions-service.js
│   ├── clans-service.js
│   └── players-service.js
└── testing/              ← Optional: run `node testing/<file>.js`
    ├── test-server-config-service.js
    ├── test-db-service.js
    ├── test-game-state-service.js
    ├── test-factions-service.js
    ├── test-clans-service.js
    └── test-players-service.js
```

---

## Commands

No in-game or Discord chat commands. S³ is an infrastructure-only plugin with no player-facing interface.

---

## Services

| Build Order | Service | File | Purpose |
|-------------:|---------|------|---------|
| 1 | `serverConfig` | `server-config-service.js` | Squad server config parsing and value caching |
| 2 | `db` | `db-service.js` | Centralised Sequelize operations with retry, jitter, and SQLite mutex |
| 3 | `gameState` | `game-state-service.js` | Round phase tracking, layer/gamemode resolution, crash recovery |
| 4 | `factions` | `factions-service.js` | Team/faction abbreviation discovery |
| 5 | `clans` | `clans-service.js` | Clan tag extraction, normalisation, caching, and team-assignment helpers |
| 6 | `players` | `players-service.js` | Player registry with move attribution and priority-based locking |

---

## Configuration Options

| Option | Required | Type | Default | Description |
|--------|----------|------|---------|-------------|
| `database` | yes | sequelize | `"sqlite"` | Sequelize connector name |
| `discordClient` | yes | discord | `"discord"` | Discord connector name |
| `channelID` | yes | string | `""` | Discord channel ID for logs |
| `configPath` | no | string | `"./SquadGame/ServerConfig/"` | Path to Squad server config files |
| `ignoredGameModes` | no | array | `["Seed", "Jensen"]` | Game modes excluded from processing |
| `enableClanTagGrouping` | no | boolean | `false` | Enable clan-aware team grouping |
| `minClanGroupSize` | no | number | `2` | Minimum members to group as a clan |
| `maxClanGroupSize` | no | number | `18` | Maximum members to group as a clan |
| `clanTagMaxEditDistance` | no | number | `1` | Levenshtein distance for tag merging |
| `clanTagCaseSensitive` | no | boolean | `false` | Case-insensitive tag normalisation with lookalike mapping |
| `clanTagIgnoreList` | no | array | `[]` | Clan tags excluded from grouping |
| `clanGroupingPullEntireSquads` | no | boolean | `false` | Pull non-clan teammates with clan members |

---

## Author

**Slacker**

- **Discord:** `real_slacker`
- **GitHub:** https://github.com/mikebjoyce/squadjs-slackers-squad-services

---

*Built for SquadJS*