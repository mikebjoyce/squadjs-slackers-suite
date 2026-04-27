# SmartAssign — Bug Analysis & Fix Reference

Comparative analysis against **EloTracker** and **TeamBalancer**. Three confirmed bugs, ranked by severity.

---

## Bug 1 — Forced RCON Poll at `NEW_GAME` *(Primary — Architectural)*

### What SmartAssign does

```js
// onNewGame()
await this.server.updatePlayerList();   // forced poll
await this._ensureSnapshot();           // immediate snapshot attempt
```

`onNewGame` forces an RCON poll and immediately tries to snapshot. This is the worst possible moment to read player data. When `NEW_GAME` fires, the engine has just cleared team assignments — RCON reflects a transitional state where most `teamID` values are `null`.

### What EloTracker does instead

```js
// onNewGame() — ET
this._roundStartEmbedPending = Date.now(); // set a timestamp flag, nothing else

// onUpdatedPlayerInfo() — ET
if (this._roundStartEmbedPending !== null &&
    Date.now() - this._roundStartEmbedPending >= this.options.roundStartEmbedDelayMs) {
  this._roundStartEmbedPending = null;
  if (this.eloCache.size > 0 && allPlayers.length > this.options.minPlayersForElo) {
    this.sendDelayedStartEmbed(); // fires only when data is organically stable
  }
}
```

ET **never touches `server.players` at `NEW_GAME` time.** It stamps a pending flag, then waits for a natural `UPDATED_PLAYER_INFORMATION` tick to deliver stable data before acting.

### Observed impact (from production JSONL logs)

| Round | Players Captured | Real Teams | Null teamID |
|---|---|---|---|
| Round 2 | 46 | 13 (28%) | 33 **(72%)** |
| Round 3 | 1 | 1 | 0 |
| Round 4 | 4 | 4 | 0 |
| Round 5 | 25 | 25 | 0 |
| Round 1 | — | — | **No snapshot at all** |

Rounds 3–5 appear correct on the ratio metric but are capturing a near-empty player list (1–25 players), not the full server population. All snapshots are poisoned.

### The fix

Remove the forced poll and immediate snapshot from `onNewGame`. Adopt ET's pending-flag pattern.

**`onNewGame`** — replace the forced poll block with a flag:
```js
// REMOVE:
await this.server.updatePlayerList();
await this._ensureSnapshot();

// ADD:
this._snapshotPendingSince = Date.now();
```

**`onUpdatedPlayerInfo`** — add a resolution-ratio gate before each natural tick:
```js
if (!this._snapshotTaken && this._snapshotPendingSince !== null) {
  const players = this.server.players;
  const withRealTeam = players.filter(p => p.teamID === 1 || p.teamID === 2).length;
  const ratio = players.length > 0 ? withRealTeam / players.length : 0;

  if (ratio >= 0.90) {
    this._snapshotPendingSince = null;
    await this._ensureSnapshot();
  } else {
    Logger.verbose('SmartAssign', 3,
      `[Snapshot] Deferred: ${Math.round(ratio * 100)}% resolved. Waiting for next tick.`
    );
  }
}
```

The snapshot will land within 30 seconds of round start — on the first organic RCON cycle where RCON has stabilised. Accuracy guaranteed.

---

## Bug 2 — `hasRealTeams` Uses `.some()` *(Secondary — Guard)*

### What the code does

```js
// _ensureSnapshot()
const hasRealTeams = this.server.players.some(p => p.teamID === 1 || p.teamID === 2);
```

`.some()` returns `true` the instant **a single player** has a real team. On Round 2, 13 out of 46 players had resolved teams — the guard passed, `_snapshotTaken` was set to `true`, and the snapshot was locked permanently with 72% null `teamID` values.

### Why this is a symptom of Bug 1, not a standalone fix

Even if you tighten the guard to a 90% ratio threshold inside `_ensureSnapshot`, it doesn't help if the data is checked once immediately at `NEW_GAME` and then never retried, because `_snapshotTaken` is set to `true` before the quality check passes. The premature lock is the real issue.

### The fix

After adopting the pending-flag pattern from Bug 1, `_ensureSnapshot` is only ever called when data quality is pre-confirmed by the ratio gate in `onUpdatedPlayerInfo`. The `.some()` guard inside `_ensureSnapshot` becomes redundant and can be removed, simplifying the method.

---

## Bug 3 — Round Timestamp Overlap *(Independent)*

### What the logs show

```
Round 1: start=1776828712430  end=1776837210915  (Sanxian RAAS v2)
Round 2: start=1776832439787  end=1776844488822  (Al Basrah Invasion v2)
  → OVERLAP: Round 2 started 4,771,128ms before Round 1 ended

Round 3: start=1776848780837  end=1776864401117
Round 4: start=1776859010624  end=1776873907252
  → OVERLAP: Round 4 started 5,390,493ms before Round 3 ended

Round 4: start=1776859010624  end=1776873907252
Round 5: start=1776864470438  end=1776876882070
  → OVERLAP: Round 5 started 9,436,814ms before Round 4 ended
```

3 of 4 round transitions produce overlapping time ranges. Round logs are not contiguous.

### Root cause

In `onNewGame`, the sequence is:

```js
await this.finalizeRoundLog();  // writes endTime: Date.now()  ← happens AFTER
// ...
const now = this.server.matchStartTime          // ← this timestamp predates finalization
  ? this.server.matchStartTime.getTime()
  : Date.now();
this.currentRoundStartTime = now;
```

`server.matchStartTime` is set by SquadJS when it detects the `NEW_GAME` log line — **before** SmartAssign's handler runs. By the time `finalizeRoundLog()` completes (DB writes, file I/O), `Date.now()` is always later than `server.matchStartTime`. So the new round's `startTime` is structurally guaranteed to precede the old round's `endTime`.

### The fix

Capture the new round's start timestamp **after** finalization, not from `server.matchStartTime`:

```js
await this.finalizeRoundLog();

// Capture AFTER finalization to guarantee non-overlapping timestamps
const now = Date.now();
await this.db.saveRoundStartTime(now);
this.currentRoundStartTime = now;
```

The tradeoff is that `startTime` reflects when finalization completed rather than the exact `NEW_GAME` moment. This is a few hundred milliseconds of offset — acceptable for a log file, and far preferable to overlapping round windows that break any time-series analysis.

---

## 4-Phase Round Model — Recommendation

### The proposed model
1. `NEW_GAME` → live match begins (round snapshot)
2. `ROUND_ENDED` → match ends, scoreboard/voting phase
3. Map change detected → staging phase
4. `NEW_GAME` → cycle restarts

### Recommendation: defer it

The current `_betweenRounds` boolean collapses phases 2 and 3 into a single flag. This is architecturally imprecise but **not a source of the bugs above**. The snapshot problem exists independently of round phase tracking.

Splitting `_betweenRounds` into a `_roundPhase` enum (`'live'`, `'post'`, `'staging'`) would give cleaner event attribution — joins during the scoreboard screen are semantically different from joins during map load. It would also enable phase-specific suppression logic. However, this requires identifying a reliable SquadJS event or heuristic for the `POST → STAGING` transition (e.g., watching `server.currentLayer.name` change between two consecutive `UPDATED_PLAYER_INFORMATION` ticks during the `_betweenRounds` window).

Fix Bugs 1–3 first. The 4-phase refactor is a follow-on improvement once the lifecycle is stable.

---

## Summary

| # | Bug | Severity | Root Cause | Fix |
|---|---|---|---|---|
| 1 | Forced poll at `NEW_GAME` | **Critical** | Snapshots during RCON's most unstable window | Adopt ET's `_pendingSince` timestamp flag; snapshot on first stable `UPDATED_PLAYER_INFORMATION` tick |
| 2 | `.some()` guard in `_ensureSnapshot` | **High** (symptom of #1) | Premature lock on first real-team player | Remove after Bug 1 fix makes it redundant |
| 3 | Round timestamp overlap | **Medium** | `startTime` from `server.matchStartTime` precedes `endTime` from post-finalization `Date.now()` | Capture `startTime` as `Date.now()` after `finalizeRoundLog()` completes |
| — | 4-phase round model | **Low / Future** | `_betweenRounds` boolean conflates scoreboard and staging phases | Defer; refactor after Bugs 1–3 are resolved |
