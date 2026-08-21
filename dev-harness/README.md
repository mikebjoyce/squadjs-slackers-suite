# Dev RCON Harness

A file-drop command channel and lifecycle event recorder for SquadJS.

Lets someone without in-game access — a human at a shell, or an AI agent with
filesystem access — trigger round-lifecycle RCON commands and read back both the
RCON response and the resulting S³ state.

**This is not part of the Slacker's Suite.** It is deliberately absent from
`install.cjs`'s plugin list, so `--plugin=all` can never sweep it into a deploy.
Install it by copying one file.

---

## Install

```
cp dev-harness/plugins/dev-rcon-harness.js <squadjs>/squad-server/plugins/
```

Then add to `config.json` under `plugins`:

```json
{
  "plugin": "DevRconHarness",
  "enabled": true,
  "token": "pick-something-long",
  "dataDir": "./dev-harness"
}
```

`dataDir` resolves against the SquadJS working directory, giving you:

```
dev-harness/
  inbox/       *.json   requests you write
  outbox/      *.json   results the plugin writes
  processed/   *.json   requests, after they were claimed
  tape.jsonl            lifecycle event timeline
```

---

## Two modes

| Mode | Config | What it does | Where to run it |
|---|---|---|---|
| **Full** | `enabled: true`, real `token` | Watches the inbox, executes commands, records the tape | Test server only |
| **Tape-only** | `enabled: true`, `readOnly: true` | Records the tape. No inbox is watched, no code path reaches RCON | Safe on the live server |

The inbox opens only when `readOnly` is false **and** `token` has been changed
from `CHANGE_ME`. A copy of this plugin dropped into a config without being
configured cannot accept commands.

---

## Sending a command

Write a JSON file into `inbox/`. Stage it under a temp name and rename, so the
plugin never reads a half-written file (it retries unparseable files three times
before giving up, but renaming avoids the question).

```json
{
  "token": "pick-something-long",
  "commands": ["AdminChangeLayer Gorodok_RAAS_v1"],
  "note": "checking layer resolution after a roll"
}
```

A result appears at `outbox/<same-name>.json`:

```json
{
  "id": "roll.json",
  "note": "checking layer resolution after a roll",
  "receivedAt": "2026-08-19T15:40:02.114Z",
  "completedAt": "2026-08-19T15:40:02.398Z",
  "ok": true,
  "results": [{ "command": "AdminChangeLayer Gorodok_RAAS_v1", "ok": true, "response": "..." }],
  "snapshot": { "...": "see below" }
}
```

Omit `commands` entirely for a **pure read** — a snapshot with no RCON traffic.

### Running `!s3` subcommands

A `discord` field runs S³'s own Discord handlers against a **capturing sender**:
the embed is serialised into the result file and never sent to Discord. This is
the fastest way to see what `!s3` would report on a live server.

```json
{
  "token": "pick-something-long",
  "discord": ["gamestate", "players"]
}
```

`discordCommands` defaults to `['status', 'services', 'gamestate',
'factions', 'players']` — the read-only ones. Mutating subcommands are
deliberately excluded: they need a `watchManager` / `stagedImportRef` that a stub
context cannot supply. `discord` works in full mode alongside `commands`, or on
its own for a read.

Results come back under `discord`, alongside `results` for any RCON commands —
one entry per subcommand, each with the captured embed:

```json
"discord": [{ "command": "gamestate", "ok": true, "embed": { "...": "" } }]
```

### Snapshot

```json
{
  "ts": "2026-08-19T15:40:02.398Z",
  "server": {
    "currentLayer": "Gorodok_RAAS_v1",
    "nextLayer": "Yehorivka_AAS_v1",
    "layerHistoryTop": ["Gorodok_RAAS_v1", "Narva_RAAS_v1"],
    "playerCount": 62, "a2sPlayerCount": 62, "squadCount": 14
  },
  "s3": {
    "present": true, "ready": true,
    "gameState": {
      "phase": "STAGING", "resolving": true, "layerResolved": true,
      "layerName": "Gorodok_RAAS_v1", "gamemode": "RAAS",
      "seedMode": false, "trainingMode": false, "lastNewGameAt": 1755617999000
    },
    "players": { "ready": true, "count": 62, "teamsResolved": false, "refreshIntervalMs": 20000 },
    "factions": { "abbreviations": { "1": "US", "2": "MEA" } }
  }
}
```

S³ is looked up fresh on every snapshot rather than cached at mount — the
harness exists partly to debug S³, so it has to keep working when S³ is broken,
absent, or reloaded underneath it. A throwing accessor shows up as
`"<error: ...>"` in its field instead of aborting the read.

---

## The tape

Every `NEW_GAME`, `ROUND_ENDED`, `UPDATED_SERVER_INFORMATION`,
`UPDATED_LAYER_INFORMATION` and `UPDATED_PLAYER_INFORMATION` appends one JSONL
line carrying a snapshot taken at that instant.

This is the part worth running on the live server. `resolving` clears on a
player-info tick, so its real timing only exists at real population — and the
tape records the `NEW_GAME → tick → resolving:false` ordering as structured
JSON, which verbose logs do not.

```sh
# how long did resolving take, and did the STAGING timer beat it?
grep -E '"(NEW_GAME|UPDATED_PLAYER_INFORMATION)"' tape.jsonl \
  | jq -c '{ts, event, phase: .s3.gameState.phase, resolving: .s3.gameState.resolving}'

# did NEW_GAME arrive without a layer?
jq -c 'select(.event=="NEW_GAME") | {ts, eventLayer, currentLayer: .server.currentLayer,
        resolved: .s3.gameState.layerResolved}' tape.jsonl
```

`tapeMaxLines` (default 5000) truncates to the most recent half when exceeded.

---

## Safety

Arbitrary Squad admin commands, executed on behalf of anything that can write a
file into `inbox/`. That is the point, and also the hazard.

- `enabled` defaults to false.
- Commands are matched against `allowedCommands` by case-insensitive prefix.
  **`AdminBan` and `AdminKick` are not in the default set** — add them
  deliberately, or set `allowAnyCommand: true`, if you actually need them.
- Requests are claimed (moved to `processed/`) *before* execution, so a crash
  mid-command loses the result rather than replaying `AdminChangeLayer` on the
  next scan.
- Every executed command is logged at verbose 1, making `run.log` an audit trail
  independent of `processed/`.
- The inbox is polled, not `fs.watch`ed — watch drops and duplicates events on
  Windows.

To kill the channel: delete `inbox/`, or flip `enabled` to false and reload.

---

## Limits

It cannot conjure players. Anything gated on a populated roster — team
resolution, faction abbreviations, balance maths — still needs bodies on the
server. An empty test server resolves teams trivially and will not reproduce
those bugs; use tape-only mode on the live server for those.

---

## Tests

```sh
node testing/test-dev-rcon-harness.js
```

19 tests, mocked server/RCON/S³, no running SquadJS needed. They cover the
harness's own logic only — they say nothing about whether real RCON accepts a
given command.
