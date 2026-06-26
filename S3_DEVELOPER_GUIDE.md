# S³ Developer Guide

**Status:** Draft — sections added as workstreams complete.  
**Last reviewed sections:** Subscription callbacks (§3) — 2026-07-26.

---

## §3 — Subscription Callbacks (Opt‑In Data Notification)

### 3.1 Overview

S³ services expose **opt‑in callback registration methods** that fire **after** the service has committed its internal state changes. This guarantees consumers receive fresh data without needing to know *when* to poll, and eliminates the staleness window that can occur when consumers read S³ state on a separate event-handler schedule.

This is **not** a global event bus. Each service owns its notification points. There is no `S3_EVENT` namespace or ambient dispatch.

### 3.2 Registration & Unsubscribe

Every callback registration returns an **unsubscribe function**. Plugins MUST call this during unmount to prevent memory leaks.

```js
// Subscribe — fires after state is committed
const unsubscribe = this._s3.gameState.onGamePhaseChange((data) => {
  console.log(`Phase changed to ${data.phase}`);
});

// Unsubscribe — required during plugin unmount
unsubscribe();
```

### 3.3 Service Callback Reference

#### GameStateService

| Registration Method | Fires When | Payload |
|---|---|---|
| **`onGamePhaseChange(cb)`** | End of `handleNewGame()`, `handleRoundEnded()`, staging→live transition timer, each ENDGAME sub-state advance | `{ phase, prevPhase, subPhase, roundStartTime, matchId, layer }` |
| **`onLayerGameModeChange(cb)`** | End of `resolveLayerInfo()` when layer/game mode actually changed | `{ layerName, gameMode, prevLayer, prevGameMode }` |

**Notes:**
- `onGamePhaseChange` fires on every phase transition including ENDGAME sub-state changes (scoreboard → layerVote → factionVoteTeam1 → factionVoteTeam2 → postVoting).
- `onLayerGameModeChange` captures previous values before resolving and includes them in the payload as `prevLayer` and `prevGameMode`.

#### PlayersService

| Registration Method | Fires When | Payload |
|---|---|---|
| **`onPlayerDataChanged(cb)`** | End of `handleUpdatedPlayerInfo()` after all tick processing, projections, and squad cache are committed | `{ joinCount, leaveCount, teamChangeCount, playerCount, projectionActive, phase }` |
| **`onPlayerConnected(cb)`** | End of `handlePlayerConnected()` after reconnect check, before return | `{ player, isNew, previousTeamID }` |

**Notes:**
- `onPlayerDataChanged` fires only on non-initial-sync ticks (the initial sync branch returns early before notification).
- `onPlayerConnected` fires even for returning players (`isNew=false`).

#### FactionsService

| Registration Method | Fires When | Payload |
|---|---|---|
| **`onFactionsResolved(cb)`** | End of `pollTeamAbbreviations()` when both team abbreviations are first discovered (cache goes from incomplete → complete) | `{ abbreviations: { 1: 'US', 2: 'RUS' } }` |

**Notes:**
- Fires **exactly once per round**, when `_hasBothTeams()` transitions from `false` → `true`.
- Does NOT fire if both teams were already resolved when polling started.
- To detect abbreviation cache clears (NEW_GAME), subscribe to `onGamePhaseChange` on GameStateService instead.

#### DBService & ServerConfigService

No callbacks provided. DBService is a passive SQLite wrapper (no state changes at runtime). ServerConfigService data changes rarely and consumers can query it on‑demand.

### 3.4 Error Isolation

Each callback invocation is wrapped in `try/catch`. If one callback throws, other callbacks still fire, and the service's internal processing is unaffected. Errors are logged at verbosity level 1.

### 3.5 When NOT to Use Callbacks

Callbacks are designed for **timer-based or tick-rate polling patterns**. If your consumer plugin only reads S³ state inside its own SquadJS event handlers (e.g. inside `onChatMessage`, `onPlayerConnected`), the flat property access pattern (`this._s3.gameState.getPhase()`, `this._s3.players.getAllPlayers()`) remains the correct approach:
- S³'s state is already committed in the same event loop tick when the consumer's handler runs.
- There is no staleness window to close for one-shot queries on SquadJS events.

The callback infrastructure exists for **future consumers** with timer‑based polling needs.

### 3.6 Service Implementation Pattern (Reference)

```js
// Inside the service class (e.g. GameStateService)
_onGamePhaseChangeCallbacks = [];

onGamePhaseChange(callback) {
  if (typeof callback !== 'function') {
    throw new Error('onGamePhaseChange requires a function callback.');
  }
  this._onGamePhaseChangeCallbacks.push(callback);
  return () => {
    this._onGamePhaseChangeCallbacks =
      this._onGamePhaseChangeCallbacks.filter(cb => cb !== callback);
  };
}

_notifyGamePhaseChange(prevPhase) {
  const payload = { phase: this.phase, prevPhase, /* ... */ };
  for (const cb of this._onGamePhaseChangeCallbacks) {
    try { cb(payload); } catch (err) { /* log, don't propagate */ }
  }
}
```

Notifications are called at the **end** of the service's event handler, after all state mutations are committed. For async handlers, the notification fires after the await chain completes.

---

## §5 — Integration Checklist (Stable)

### 5.1 Service Mount Order

S³ services must be mounted in this order (enforced by the plugin's `mount()` method):

1. **`serverConfig`** — vote durations, server settings
2. **`db`** — Sequelize connector and model definitions
3. **`gameState`** — phase tracking, layer resolution, ENDGAME timers
4. **`factions`** — faction abbreviation discovery
5. **`clans`** — clan tag detection (optional)
6. **`players`** — player registry, locking, reconnects, refresh

This ordering ensures that `gameState` can read vote durations from `serverConfig` when it enters ENDGAME, that `factions` can query `gameState.isLive()` for phase gating, and that `players` can access `gameState` for phase‑aware projections.

### 5.2 Flat Access Pattern (Stage 5 Standard)

```js
// ✅ Correct — flat direct access via plugin-level getters
this._s3.gameState.getPhase();
this._s3.players.getAllPlayers();

// ❌ Wrong — nested services path (Stage 4 and earlier)
this._s3.services.gameState.getPhase();
```

Guard with `isReady()` when the service might not yet be mounted:

```js
if (this._s3?.gameState?.isReady()) {
  const phase = this._s3.gameState.getPhase();
}
```

### 5.3 Required Plugin Lifecycle

Every consumer plugin that accesses S³ services must:

| Step | Implementation |
|---|---|
| **Mount** | Call `this._s3.getPlugin('slackers-squad-services')` in `constructor` or `onConstruction()`. Access services via `this._s3.gameState`, `this._s3.players`, etc. |
| **Readiness check** | Guard service access with `this._s3.gameState?.isReady()`. S³ services are ready when their `mount()` completes. |
| **Unmount** | Release any callbacks (subscriptions, refresh interests, etc.) in `onUnmount()`. Note: do NOT call service `unmount()` methods — the S³ plugin manages its own lifecycle. |

---

## §6 — Anti-Patterns

*To be documented from stage6-action-plan.md findings.*

---

## §7 — Migration Guide (Historical)

*Pre-S³ → S³ migration path — to be documented.*

---

*This file is seeded by workstream 7.2i and will be expanded by workstream 7.6 (Stage 7.6 — Developer Guide).*