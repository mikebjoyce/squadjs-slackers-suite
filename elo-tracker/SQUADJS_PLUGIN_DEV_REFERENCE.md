# SquadJS Plugin Developer Reference

**Version:** SquadJS 4.1.0 / Squad (current as of April 2026)  
**Purpose:** Ground-truth reference for plugin authors. Covers event reliability, known breakage, timing quirks, and resilient architecture patterns — validated against production logs.

---

## 1. The Core Architectural Problem

SquadJS tracks server state using **two completely independent, concurrent systems**:

| System | Events | Mechanism | Reliability |
|---|---|---|---|
| **Reactive Log Parser** | `PLAYER_CONNECTED`, `PLAYER_DISCONNECTED` | Regex on live `SquadGame.log` | Partially broken |
| **Periodic RCON Polling** | `UPDATED_PLAYER_INFORMATION`, `PLAYER_TEAM_CHANGE`, `PLAYER_SQUAD_CHANGE` | RCON `ListPlayers` diff every ~30s | Authoritative |

These systems run independently and **do not synchronize**. Events from one system will regularly appear before, after, or instead of their counterpart in the other. Any plugin that assumes strict ordering between these two systems will corrupt its internal state.

**The practical consequence:** `UPDATED_PLAYER_INFORMATION` (periodic) is the only fully reliable signal. Build everything around it.

---

## 2. Event-by-Event Reference

### 2.1 `UPDATED_PLAYER_INFORMATION` — The Source of Truth

Fires at the end of every `updatePlayerList()` call. The `server.players` array at this moment reflects current RCON state.

**Treat this as the authoritative source.** If a player is in `server.players`, they are on the server. If they are not, they are gone — regardless of what any other event says.

**Burst behavior:** In production, 3–6 duplicate `UPDATED_PLAYER_INFORMATION` events fire within milliseconds of each other. This is **not a bug** and not your plugin's fault. There are three independent sources of `updatePlayerList()` calls:

1. **30-second periodic timer** — the baseline heartbeat
2. **`getPlayerByCondition()` cache-miss retry** — automatically fires `updatePlayerList()` when a player lookup fails. Triggered by `PLAYER_CONNECTED`, `PLAYER_WOUNDED`, `PLAYER_DIED`, chat messages, etc.
3. **Explicit plugin calls** — any plugin directly calling `server.updatePlayerList()`

During rapid join phases (server filling up), sources 1 and 2 overlap constantly — producing short bursts. The timer rearms from the *last* call, so it cannot spiral. Process these events idempotently.

---

### 2.2 `PLAYER_CONNECTED` — Race Condition, Not Sequenced

**Do not assume this fires before `UPDATED_PLAYER_INFORMATION`.**

Observed production timing:
```
07:52:08.274Z — UPDATED_PLAYER_INFORMATION fires. New player already in array.
07:52:08.277Z — PLAYER_CONNECTED fires (3ms later).
```

The RCON poll can complete before the log parser catches the join log. A new player may appear in `server.players` before `PLAYER_CONNECTED` fires. Treating this as a "ghost" (unregistered player) is a common bug.

**Rule:** If you discover a new player via `UPDATED_PLAYER_INFORMATION` before `PLAYER_CONNECTED`, that is normal. Register them immediately. When `PLAYER_CONNECTED` subsequently fires, treat it as a redundant confirmation.

---

### 2.3 `PLAYER_DISCONNECTED` — Broken, Do Not Use

In current Squad/SquadJS, **`PLAYER_DISCONNECTED` does not fire**. The `UChannel::Close` / `UNetConnection` log lines either no longer exist or no longer match the SquadJS regex.

Observed production behavior:
```
Player leaves the server.
UPDATED_PLAYER_INFORMATION fires — player is absent from array.
PLAYER_DISCONNECTED → never arrives.
```

**Rule:** Never use `PLAYER_DISCONNECTED` for session teardown, headcount tracking, or any stateful cleanup. All disconnect logic must be inferred from a player disappearing from `UPDATED_PLAYER_INFORMATION`.

---

### 2.4 `PLAYER_TEAM_CHANGE` & `PLAYER_SQUAD_CHANGE` — Reliable

These events are generated entirely by the RCON polling system's internal diff. Because they share the same underlying mechanism as `UPDATED_PLAYER_INFORMATION`, they are **reliably synced** with it.

Observed production behavior:
```
Player switches teams.
Next RCON poll:
  PLAYER_TEAM_CHANGE fires correctly.
  PLAYER_SQUAD_CHANGE fires correctly (if applicable).
  UPDATED_PLAYER_INFORMATION fires, reflecting new state.
```

**Caveat:** All three fire in the same poll cycle. Process them idempotently — your state update from one of these events should not break when the others arrive milliseconds later with the same data.

---

### 2.5 `ROUND_ENDED`, `NEW_GAME`, `LAYER_CHANGED` — Phase Lifecycle

#### The Correct Phase Model

Only **two phases exist** that SquadJS can reliably distinguish:

| Phase | Starts | Ends | Contains |
|---|---|---|---|
| `active` | `NEW_GAME` | `ROUND_ENDED` | Staging (~260s) + live play. **Indistinguishable from each other via RCON.** |
| `between_rounds` | `ROUND_ENDED` | `NEW_GAME` | Map transition, team scramble, loading |

```javascript
// Correct phase state machine
onRoundEnded() { this.phase = 'between_rounds'; }
onNewGame()    { this.phase = 'active'; }
onLayerChanged() { /* do NOT change phase here */ }
```

#### Critical: `NEW_GAME` ≠ Game Is Live

`NEW_GAME` fires when the new map finishes loading and staging begins — **not** when staging ends. Squad staging lasts approximately 260 seconds. SquadJS has **no event for staging completion**. There is no RCON signal to distinguish mid-staging from mid-active play.

Any plugin that relies on `NEW_GAME` to mean "game is now live" will execute 260 seconds too early.

**Workarounds:**
- Use a wall-clock timer: `setTimeout(() => { /* post-staging */ }, 280_000)` from `NEW_GAME`
- Accept that staging and active play are indistinguishable and design around that constraint

#### `LAYER_CHANGED` vs `NEW_GAME` Ordering Is Non-Deterministic

Both events are emitted during the same transition, but via different polling cycles. Either can fire first:

```
# Observed ordering A:
NEW_GAME      → 1777529667268
LAYER_CHANGED → 1777529679393

# Observed ordering B (same server, different transition):
LAYER_CHANGED → 1777537048585
NEW_GAME      → 1777537050051
```

**Rule:** Never hardcode assumptions about which arrives first. Handle both orderings. Use `LAYER_CHANGED` as a diagnostic/swap-detection signal only — not as a phase driver.

---

## 3. Null-TeamID Lifecycle

Players can have `teamID = null` in `server.players`. This is expected and transient — not a SquadJS bug.

### When It Occurs

| Scenario | Null-teamID? |
|---|---|
| Stable active play | **Never** |
| Seeding / population growth (1→50+ players) | **Never** |
| Player joins mid-round | **Never** |
| Player leaves mid-round | **Never** |
| `between_rounds` phase | **Never** |
| `NEW_GAME` transition moment | **Yes — transient** |

Null-teamID occurs exclusively at the `NEW_GAME` moment: the server has loaded the new map but RCON hasn't fully resolved team assignments yet. Players mid-load-screen are the primary cause.

### Resolution Timeline

**Small-scale (Data1–Data3):**
- Data1 (81 players, 4 nulls): All resolved within **3 polls (~14.5 seconds)**; fastest 2 polls (~3.3 seconds)
- Data2 (1 player, 1 null): Resolved in 1 poll (~30 seconds)

**Full-server scale (Data4 — production, 93–99 players):**
- Transition 2 (95 players): 43 null-teamIDs at NEW_GAME
  - 51 players resolved by poll #3 (~4.8 seconds)
  - Additional 29 players resolved by poll #7 (~19.6 seconds)
  - Stragglers resolved over remaining 12 polls (~35 seconds maximum)
- Transition 3 (93 players): 64 null-teamIDs at NEW_GAME — similar resolution pattern
- **Critical finding:** Full-server transitions produce mass-simultaneous nulling (94/94 players null at single NEW_GAME moment), but all resolve successfully via idempotent polling
- Edge case: One NULL_PERMANENT player (steamID 76561198194821459) remained unresolved for 114 seconds, then left the server — algorithm correctly excluded from accuracy calculation

**Rule:** When reading team data at `NEW_GAME`, expect null-teamID. At full-server scale (93–99 players), expect bulk nulling affecting the entire roster. Poll for 30–60 seconds minimum before trusting null as authoritative. The algorithm is robust to long-tail resolution times.

### Handling In Code

```javascript
onNewGame() {
  const nullPlayers = server.players.filter(p => p.teamID === null);
  // Don't act on null players yet. They will appear in the next poll
  // with valid teamIDs. Track them in a deferred set and resolve on
  // the next UPDATED_PLAYER_INFORMATION event.
}
```

---

## 4. Server Restart Behavior

When SquadJS reconnects to a server post-restart, `server.currentLayer` is unavailable. This manifests as layer metadata reading as `"Unknown"` for the entire recovery period — through seeding, through `LAYER_CHANGED`, sometimes through `NEW_GAME`.

This is **not** an optional-chaining bug in your plugin. It is a RCON state initialization artifact in SquadJS itself.

**Detection pattern:** Player count drops to 0 AND `layerName` becomes `"Unknown"` simultaneously — indicates server restart. This combination is reliable and does not occur in normal operation.

**Recommendation:** Implement a fallback for `layerName === "Unknown"` in any logic that gates on map metadata.

---

## 5. The Resilient Plugin Pattern

Given the above, the correct architecture for any plugin tracking player state is a **delta-diff state machine** driven by `UPDATED_PLAYER_INFORMATION`.

### Core Design

```javascript
class MyPlugin extends SquadPlugin {
  constructor(server, options) {
    super(server, options);
    // Internal map is the source of truth — not server.players directly
    this.playerMap = new Map(); // eosID → { teamID, squadID, ... }
  }

  async mount() {
    this.server.on('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInfo.bind(this));
    // Treat PLAYER_CONNECTED, PLAYER_TEAM_CHANGE as secondary confirmations only
    this.server.on('PLAYER_TEAM_CHANGE', this.onTeamChange.bind(this));
  }

  async onUpdatedPlayerInfo() {
    const current = new Set(this.server.players.map(p => p.eosID));
    const known = new Set(this.playerMap.keys());

    for (const player of this.server.players) {
      if (!known.has(player.eosID)) {
        // JOIN — player appeared in RCON before or without PLAYER_CONNECTED
        this.onPlayerJoin(player);
      } else {
        // UPDATE — check for team/squad changes
        const prev = this.playerMap.get(player.eosID);
        if (prev.teamID !== player.teamID) this.onTeamChange(player, prev.teamID);
        this.playerMap.set(player.eosID, { teamID: player.teamID, squadID: player.squadID });
      }
    }

    for (const eosID of known) {
      if (!current.has(eosID)) {
        // DISCONNECT — player is gone. PLAYER_DISCONNECTED will never arrive.
        this.onPlayerLeave(eosID);
        this.playerMap.delete(eosID);
      }
    }
  }

  onTeamChange(player, prevTeamID) {
    // Called from both UPDATED_PLAYER_INFORMATION delta AND PLAYER_TEAM_CHANGE
    // Must be idempotent — may fire for the same change from both sources
    this.playerMap.set(player.eosID, {
      ...this.playerMap.get(player.eosID),
      teamID: player.teamID
    });
  }
}
```

### Key Rules

1. **`server.players` is truth.** If a player is there, they are on the server. If not, they are gone.
2. **Never wait for `PLAYER_DISCONNECTED`.** It will not come. Teardown on RCON delta.
3. **Never assume `PLAYER_CONNECTED` precedes `UPDATED_PLAYER_INFORMATION`.** Handle new players from either source.
4. **Treat explicit events as confirmations, not triggers.** Your state machine catches everything through `UPDATED_PLAYER_INFORMATION`. Other events can supplement but must not be required.
5. **All handlers must be idempotent.** The same state change may arrive from multiple sources within milliseconds.

---

## 6. Known Timing / Ordering Gotchas Summary

| Assumption | Reality |
|---|---|
| `PLAYER_CONNECTED` fires before `UPDATED_PLAYER_INFORMATION` | **False.** RCON poll often arrives first. |
| `PLAYER_DISCONNECTED` fires when a player leaves | **False.** It doesn't fire at all in current Squad. |
| `LAYER_CHANGED` fires before `NEW_GAME` | **Non-deterministic.** Either order is possible. |
| `NEW_GAME` fires once | **True.** Confirmed via probe — fires exactly once per round transition. |
| `NEW_GAME` means the game is live / staging is over | **False.** It means staging is beginning. |
| `teamID` is always valid immediately after `NEW_GAME` | **False.** Expect null for some players for up to ~30s. |
| Duplicate `UPDATED_PLAYER_INFORMATION` within 200ms indicates a bug | **False.** Normal behavior during join bursts. |
| Layer metadata recovers automatically after server restart | **Not reliably.** May stay `"Unknown"` through the full recovery. |

---

## 7. Validated Findings Summary

| Finding | Validated By | Confidence |
|---|---|---|
| `PLAYER_DISCONNECTED` never fires | Data1, Data2, Data3 (0 events across 1,000+ polls) | High |
| `PLAYER_CONNECTED` race with `UPDATED_PLAYER_INFORMATION` | SQUADJS_EVENT_ARCHITECTURE | High |
| Null-teamID exclusive to NEW_GAME transition | Data1 (4 nulls), Data2 (1 null), Data3 (0 nulls across 1,000 polls) | High |
| Null-teamID resolves within ~30s | Data1 (~14s), Data2 (~30s) | High |
| Persistent map accuracy: 100% | Data1 (81 players), Data2 (2×1 player), Data3 (3 players), Data4 (93–99 players, 3 transitions) | High |
| Duplicate UPDATED_PLAYER_INFORMATION bursts explained | duplicated-UPDATED-PLAYER-INFORMATION.md | High |
| `NEW_GAME` fires once per round transition | NewGameProbe (production) | High |
| Layer metadata stays "Unknown" post-restart | Data3 | High |
| Two-phase model (active/between_rounds) is correct | Data2 | High |
| Staging end is undetectable via RCON | Data2 | High |

---

*Last updated: April 30, 2026*
