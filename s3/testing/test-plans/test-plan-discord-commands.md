# Category 3 — Discord Commands Test Plan

**Date:** 2026-06-28  
**Human Activity Required:** Use Discord bot commands  
**Estimated Duration:** 15–20 minutes

## Purpose

Full Discord command matrix verification: every subcommand path across all plugins returns correct output.

## Pre-requisites

- SquadJS running with all plugins
- Discord admin channel accessible
- At least 1 player on the server

## Command Matrix

### S³ Commands

| Command | Expected Output | Pass/Fail |
|---------|----------------|-----------|
| `!s3` | Help embed listing subcommands | |
| `!s3 status` | System status with services, phase, player count | |
| `!s3 services` | Per-service status (✅/❌) | |
| `!s3 gamestate` | Phase, mode, layer, matchId, roundStartTime | |
| `!s3 factions` | Team 1/2 names, faction IDs | |
| `!s3 players` | Player list with teamID, clan tag | |
| `!s3 clans` | Detected clan groups | |
| `!s3 locks` | Global + per-player lock status | |
| `!s3 config` | Server config values | |
| `!s3 help` | Command reference embed | |
| `!s3 db export` | Attaches .s3backup.json (essential tables) | |
| `!s3 db export --logs` | Includes logging tables | |
| `!s3 db export --all` | Includes all tables | |
| `!s3 backup list` | Lists available backups | |
| `!s3 backup` | Help text for backup subcommands | |
| `!s3 unknown` | Help embed (unknown command fallback) | |

### Elo Commands

| Command | Expected Output | Pass/Fail |
|---------|----------------|-----------|
| `!elo [playername]` | Player Elo rating embed | |
| `!elo help` | Help text | |
| `!elo nonexistent` | "Player not found" (not crash) | |
| `!eloadmin help` | Admin help text | |
| `!eloadmin badcmd` | "Unknown command. Type !eloadmin help" | |

### Switch Commands

| Command | Expected Output | Pass/Fail |
|---------|----------------|-----------|
| `!switch help` | Help embed with subcommands | |
| `!switch badcmd` | Help embed (not silent fail) | |

### TeamBalancer Commands

| Command | Expected Output | Pass/Fail |
|---------|----------------|-----------|
| `!teambalancer status` | Current balance status | |
| `!teambalancer history` | Round history | |
| `!teambalancer` | Help/status | |

---

*Test plan drafted 2026-06-28*