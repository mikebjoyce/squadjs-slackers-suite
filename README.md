# SlackersSquadServices (Stage 1 Scaffold)

This directory contains the initial scaffold for Slacker's Squad Services (S³).

## Structure

- `plugins/slackers-squad-services.js` — base SquadJS plugin scaffold
- `utils/` — shared service/helper modules (now includes `game-state-service.js`)
- `testing/` — service tests (Stage 1 uses standalone Node test files)

## Plugin Class + File

- **Class name:** `SlackersSquadServices`
- **File name:** `slackers-squad-services.js`

In SquadJS config, the plugin block `plugin` value must match the class name exactly.

## Declared Connector Options

The base scaffold plugin declares:

- `database` (`connector: "sequelize"`)
- `discordClient` (`connector: "discord"`)
- `channelID` (Discord admin channel ID)

## Example `config.json` plugin block

```json
{
  "plugin": "SlackersSquadServices",
  "database": "sqlite",
  "discordClient": "discord",
  "channelID": "667741905228136459"
}
```

> Stage 1 note: `gameState` is now implemented as a shared service module.
> Remaining modules (`factions`, `clans`, `db`, `players`) are intentionally not implemented yet.
