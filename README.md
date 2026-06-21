# SlackersSquadServices

This directory contains the Slacker's Squad Services (S³) plugin implementation.

## Structure

- `plugins/slackers-squad-services.js` — SquadJS plugin composition root
- `utils/` — shared service modules
  - `clans-service.js`
  - `db-service.js`
  - `factions-service.js`
  - `game-state-service.js`
  - `players-service.js`
  - `server-config-service.js`
  - `README.md`
- `testing/` — service tests
  - `test-clans-service.js`
  - `test-db-service.js`
  - `test-factions-service.js`
  - `test-game-state-service.js`
  - `test-players-service.js`
  - `test-server-config-service.js`

## Plugin Class + File

- **Class name:** `SlackersSquadServices`
- **File name:** `slackers-squad-services.js`

In SquadJS config, the plugin block `plugin` value must match the class name exactly.

## Services

All six services are constructed and mounted in `slackers-squad-services.js`:

| Build Order | Service | Purpose | Status |
|-------------:|---------|---------|--------|
| 1 | `db` | Centralize retry+jitter lock handling for sequelize operations. | wired |
| 2 | `gameState` | Centralizes round phase tracking and layer/gamemode resolution. | wired |
| 3 | `factions` | Centralize team/faction abbreviation discovery (TB + Switch parity). | wired |
| 4 | `clans` | Extracts and groups player clan tags from names, with caching and team-assignment helpers. | wired |
| 5 | `players` | Centralized player registry with move attribution and priority-based locking. | wired |
| 6 | `serverConfig` | Parses Squad server configuration files and caches key values for runtime access. | wired |

## Declared Connector Options

| Option | Required | Type/Connector | Default |
|--------|----------|----------------|---------|
| `database` | yes | sequelize | `sqlite` |
| `discordClient` | yes | discord | `discord` |
| `channelID` | yes | string | `""` |
| `configPath` | no | string | `"./SquadGame/ServerConfig/"` |
| `ignoredGameModes` | no | array | `["Seed", "Jensen"]` |
| `enableClanTagGrouping` | no | boolean | `false` |
| `minClanGroupSize` | no | number | `2` |
| `maxClanGroupSize` | no | number | `18` |
| `clanTagMaxEditDistance` | no | number | `1` |
| `clanTagCaseSensitive` | no | boolean | `false` |
| `clanTagIgnoreList` | no | array | `[]` |
| `clanGroupingPullEntireSquads` | no | boolean | `false` |

## Example `config.json` plugin block

```json
{
  "plugin": "SlackersSquadServices",
  "database": "sqlite",
  "discordClient": "discord",
  "channelID": "667741905228136459"
}
```

## Stage Status

All six services (`gameState`, `factions`, `clans`, `db`, `players`, `serverConfig`) are fully wired in `prepareToMount()` and `mount()`. However, consumer plugins (TeamBalancer, SmartAssign, Switch, EloTracker) are **not constructed or referenced** anywhere in `slackers-squad-services.js` — they remain planned for future integration.