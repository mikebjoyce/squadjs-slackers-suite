# SquadJS Event Architecture & Anomaly Patterns

This document details critical findings regarding how SquadJS 4.1.0 handles core player lifecycle events (Joins, Disconnects, Team Changes, Squad Changes). It serves as a blueprint for refactoring and architecting resilient SquadJS plugins (such as EloTracker and TeamBalancer).

---

## 1. The Core Conflict: Periodic vs. Reactive Systems

SquadJS tracks player state using two entirely different, concurrent systems:

1. **Reactive Log Parsers (`PLAYER_CONNECTED`, `PLAYER_DISCONNECTED`):** 
   These rely on parsing the live `SquadGame.log` file using Regex. They are supposed to fire instantaneously when the server engine writes the log.
2. **Periodic RCON Polling (`UPDATED_PLAYER_INFORMATION`, `PLAYER_TEAM_CHANGE`, `PLAYER_SQUAD_CHANGE`):** 
   SquadJS queries the server via RCON every 30 seconds for the full list of players. It diffs this array against its previous cache to emit "Change" events and the global "Updated" event.

**The Problem:** Because these two systems run independently, they frequently clash and generate out-of-order events. If a plugin trusts the strict timeline of one system over the other, it will inevitably corrupt its internal state.

---

## 2. The 3ms Race Condition (The "Ghost Join" Fallacy)

It is highly common for the periodic 30-second RCON poll to execute a few milliseconds *before* the Reactive Log Parser catches the join log.

**Observed Pattern in Production:**
* `07:52:08.274Z` - `UPDATED_PLAYER_INFORMATION` fires. The new player is listed in the array.
* `07:52:08.277Z` - `PLAYER_CONNECTED` fires (3ms *later*).

If a plugin assumes that `PLAYER_CONNECTED` MUST precede `UPDATED_PLAYER_INFORMATION`, it will view the new player in the array as a "Ghost" (a player who magically appeared without joining). The plugin might try to register them twice or drop them entirely.

**Rule 1: Never assume `PLAYER_CONNECTED` will fire first. Plugins must tolerate discovering a new player via `UPDATED_PLAYER_INFORMATION` before receiving the explicit join event.**

---

## 3. The `PLAYER_DISCONNECTED` Total Failure

In modern versions of Squad/SquadJS, the `PLAYER_DISCONNECTED` reactive log parser is completely broken. When a player leaves the server, the `UChannel::Close` or `UNetConnection` log lines either do not exist or no longer match the SquadJS Regex.

**Observed Pattern in Production:**
* Player leaves the server.
* `UPDATED_PLAYER_INFORMATION` fires. The player is correctly removed from the array.
* `PLAYER_DISCONNECTED` **never fires.**

**Rule 2: Plugins cannot rely on `PLAYER_DISCONNECTED` to manage player teardown or session closures. Disconnects MUST be inferred by a player disappearing from `UPDATED_PLAYER_INFORMATION`.**

---

## 4. Flawless Event Detection (`PLAYER_TEAM_CHANGE` & `PLAYER_SQUAD_CHANGE`)

Unlike connects and disconnects, Team and Squad changes are generated entirely by the Periodic RCON Polling system. Because they rely on the same internal diffing mechanism as `UPDATED_PLAYER_INFORMATION`, they are flawlessly synced.

**Observed Pattern in Production:**
* The player switches teams.
* Next RCON Poll triggers.
* `PLAYER_TEAM_CHANGE` fires perfectly.
* `PLAYER_SQUAD_CHANGE` fires perfectly (if applicable).
* `UPDATED_PLAYER_INFORMATION` fires, reflecting the new state.

**Rule 3: Team and Squad changes are highly reliable. However, because they fire simultaneously with the main player info update, plugins should process them idempotently.**

---

## 5. The Blueprint for Resilient Plugins: "The State-Machine Pattern"

To build bulletproof plugins (especially for sensitive logic like Elo or Team Balancing), you must abandon strict event sequencing. Instead, rely on a "Pending Expectations" State Machine driven primarily by `UPDATED_PLAYER_INFORMATION`.

### The Architecture

1. **Source of Truth:** 
   Treat `UPDATED_PLAYER_INFORMATION` (and the `server.players` array) as the absolute source of truth. If a player is in the array, they are in the game. If they are not, they are gone.
   
2. **State Tracking Map:** 
   Maintain an internal `Map` of known players keyed by `eosID` (or `steamID`). Track their current `teamID` and `squadID`.

3. **Delta Diffing on Update:**
   When `UPDATED_PLAYER_INFORMATION` fires:
   * **Missing from internal Map?** It's a Join. (Do not wait for `PLAYER_CONNECTED`).
   * **Present in internal Map, but missing from Update?** It's a Disconnect. (Trigger your session teardown here, as `PLAYER_DISCONNECTED` will never arrive).
   * **Team/Squad Mismatch?** Update your internal state immediately.

4. **Handling the Explicit Events:**
   If `PLAYER_CONNECTED` or `PLAYER_TEAM_CHANGE` *do* happen to fire, treat them as redundant confirmations. Update the internal map, but do not trigger heavy logic if the State Tracker already caught the delta during the periodic update.

### Why this works for EloTracker
EloTracker needs precise session durations. If it waits for `PLAYER_DISCONNECTED` to log the end time, it will bleed sessions infinitely and never save them. By hooking teardown directly into the delta-diff of `UPDATED_PLAYER_INFORMATION`, EloTracker guarantees that sessions close within 30 seconds of a player leaving the server.

### Why this works for TeamBalancer
TeamBalancer relies on knowing exactly how many players are on each team. If it relies on explicit connect/disconnect events to maintain a headcount, it will quickly desync due to the dropped disconnects. Relying on `UPDATED_PLAYER_INFORMATION` as the sole authority ensures TeamBalancer always acts on reality.
