# SmartAssign Replay & Optimizer Design

## Overview

This document covers the replay tooling built to validate SmartAssign's assignment algorithm against real server data, and the design of a parameter optimizer to find the assignment configuration that minimizes Elo difference between teams.

---

## 1. Log Format

SmartAssign writes one JSON object per completed round to a `.jsonl` file. Each entry contains:

- `startTime` / `endTime` — Unix ms timestamps
- `layerName` — map name, reliable (cached at snapshot time)
- `gamemode` — the round's game mode
- `smartAssignActive` — whether SA was running in active or passive mode
- `events` — ordered array of player lifecycle events

### Event Types

| Type | Description |
|---|---|
| `ROUND_SNAPSHOT` | Player list captured mid-round at the 90% population gate. Seed state for simulation. Includes full player array with `steamID`, `teamID`. |
| `JOIN` | Player connected. Includes `steamID`, `name`, `teamID` they landed on, `t1`/`t2` team counts at time of event. |
| `LEAVE` | Player disconnected. Includes `steamID`, `teamID` they were on. |
| `TEAM_CHANGE` | Player or admin changed a player's team. Includes `steamID`, `newTeam`. |
| `ASSIGNMENT` | SA issued a move command. |
| `MOVE_SUCCESS` | Server confirmed the move. |

### Known Event Ordering Issue

JOIN and LEAVE events recorded at the same timestamp are unreliable in order. A LEAVE at the same timestamp as a JOIN was discovered *by* that JOIN's RCON poll — meaning the leave physically preceded the join. The replay tool sorts same-timestamp events with LEAVE before JOIN as the most physically plausible ordering.

---

## 2. Replay Tool (`replay-round.js`)

### Purpose

Replays a round's event stream through a local reimplementation of the SmartAssign algorithm. Compares the simulated outcome against ground truth (`Actual`) recorded in the log.

### Two Tracks

**Actual** — ground truth. The `t1`/`t2` fields embedded in each event reflect real server state at the moment the event fired. No simulation.

**SA Sim** — the SmartAssign algorithm replayed against the same event stream. Population caps, reconnect memory, and skill balancing all active. This is the counterfactual: *what would SA have done if it had been running for this entire round?*

The meaningful comparison is **Actual vs SA Sim**. Actual is the real baseline — what the server naturally produces. SA Sim shows whether the algorithm improves on that.

### Metrics Per Round

- Average Mu gap between teams across all events
- Max Mu gap observed
- Percentage of events where teams were unbalanced (gap > 1)
- Total assignment moves issued by SA Sim
- Reconnect honour rate (reconnecting players returned to prior team)

### Usage

```bash
# Last round (default)
node replay-round.js smart-assign-log.jsonl

# Specific round with full event timeline
node replay-round.js smart-assign-log.jsonl --round 22

# All rounds + aggregate summary
node replay-round.js smart-assign-log.jsonl --all

# With real Elo data
node replay-round.js smart-assign-log.jsonl --all --elo elo-backup.json
```

### Elo Data

Without `--elo`, all players default to `mu = 25.0`. This collapses skill balancing to population-only. Pass an EloTracker backup JSON to use real Mu values. The backup is keyed by `steamID` — any player not found defaults to 25.0.

---

## 3. Algorithm (Extracted from `smart-assign.js`)

The core assignment decision runs on every JOIN event. Steps in order:

### Step 1 — Seed mode check
If `gamemode === 'Seed'`, skip. Let the server handle it natively.

### Step 2 — Server full check
If both teams are at 50, take no action.

### Step 3 — Population cap enforcement
Hard limits on team size difference based on total server population:

| Total players | Max allowed gap |
|---|---|
| 94+ | 1 |
| 88–93 | 2 |
| 80–87 | 3 |
| < 80 | 4 |

If assigning to a player's natural team would violate the cap, force them to the other team.

### Step 4 — Reconnect memory
If the player has a prior team in reconnect memory, return them there — unless doing so would violate the population cap. Reconnect grace allowance extends the cap by +1 (high pop >= 90) or +2 (low pop < 90) to prioritise squad continuity over strict balance.

### Step 5 — Skill balancing
Assign the player to whichever team produces the lower combined score:

```
score = avgWeight * |avg_mu_if_join - opponent_avg_mu|
      + sumWeight * |sum_mu_if_join/n - opponent_sum_mu/n|
```

The avg term captures per-player skill parity. The sum term captures total skill stockpile. Both terms are independently weighted — tunable parameters.

---

## 4. Optimizer Design

### Objective

**Minimize mean Mu gap between teams across all events, across all rounds.**

Population parity is a hard constraint already enforced by the algorithm's cap logic — it is not a scored term. The optimizer tunes the cap thresholds and skill weighting, not whether to enforce them.

Reconnect honour rate is tracked as a diagnostic. It is never a scored term — see Policy-Pinned Parameters below.

### Scoring Function

```
round_score = mean(|sum_mu(t1) - sum_mu(t2)|) across all events in round
total_score = mean(round_score) across all rounds
```

Lower is better. The optimizer finds the parameter set with the lowest `total_score`.

Per-round scores are reported individually so parameter sets that win by exploiting one anomalous round are visible.

### Parameters

#### Optimizer-Tunable

| Parameter | Current value | Search range |
|---|---|---|
| Pop cap tier 1 (94+ players) | 3 | 1–3 |
| Pop cap tier 2 (88–93 players) | 3 | 1–4 |
| Pop cap tier 3 (80–87 players) | 3 | 2–5 |
| Pop cap tier 4 (< 80 players) | 3 | 3–6 |
| Avg Mu term weight | 0.50 | 0.25–2.0 |
| Sum Mu term weight | 1.75 | 0.25–2.0 |

#### Policy-Pinned (Not Optimizer-Tunable)

| Parameter | Pinned value | Reason |
|---|---|---|
| Reconnect grace (high pop >= 90) | +1 | Policy decision — see below |
| Reconnect grace (low pop < 90) | +2 | Policy decision — see below |

**Why grace is pinned:** Run 2 found that grace=0/0 minimises Mu gap. This is technically correct but practically wrong. A player who crashes and lands on the wrong team will request a manual switch at the earliest opportunity, or idle until they can. The optimizer has no model of player agency — it assumes assignments stick. Eliminating reconnect grace produces an illusory Mu improvement that downstream player behaviour erases. Grace is a squad-continuity policy decision, not a tunable parameter.

The optimizer exposes a `--pin` flag for parameters excluded from search on policy grounds:

```bash
node optimize-params.js log.jsonl --elo elo-backup.json --pin graceHigh=1 graceLow=2
```

### Search Strategy

Grid search, coarse-to-fine:

1. Coarse pass — wide step sizes across all tunable parameters, identify promising regions
2. Fine pass — narrow step sizes around the top N candidates from the coarse pass
3. No gradient descent until the dataset is large enough to trust it

---

## 5. Optimizer Findings (Run 2 — Elo-Based, April 27 2026)

### Dataset

- 32 rounds, ~2,400 events
- ~90% Elo coverage (12,323 players from EloTracker backup)
- Coarse pass: 25,920 valid combinations evaluated

### Result

| Metric | Baseline | Winner | Delta |
|---|---|---|---|
| Mean score | 52.870 | 46.114 | -12.8% |
| Rounds improved | — | 25/32 (78%) | — |
| Rounds regressed | — | 6/32 (19%) | — |
| Overfitting warnings | — | 0 | ✓ |

**Winning parameters:** `caps=3/3/3/3 | grace=pinned(1/2) | avgW=0.50 | sumW=1.75`

### Key Findings

**Uniform cap (3/3/3/3).** The optimizer found no value in the tiered approach — a flat 3-player max gap across all server sizes outperformed the original 1/2/3/4 tiers. This may mean the tiers are genuinely unnecessary, or that 32 rounds is insufficient to differentiate them. To be re-evaluated as data accumulates.

**Sum Mu weight (1.75) dominates avg (0.50).** Total skill stockpile is a better predictor of team advantage than per-player average. This makes intuitive sense: a team with more total skill wins even if the average looks close.

**Run 1 (population-only) was misleading.** Without real Elo data all players default to mu=25.0, eliminating skill variance. The optimizer converged to tight caps (1/1/2/3) as the only available lever, producing a marginal 0.74% improvement. Run 1 findings are obsolete — never trust population-only optimization.

### Regressions to Investigate

Rounds 14 (Mestia RAAS v1, -6.6%), 19 (Mutaha RAAS v1, -3.8%), and 27 regressed under the winner configuration. Before deploying, drill into these with `replay-round.js --round N` to determine whether there is a shared structural cause.

---

## 6. Known Limitations

**Small dataset.** 32 rounds is adequate for grid search but thin for statistical inference. Re-run the optimizer as logs accumulate. Confidence thresholds:
- 100+ rounds: strong confidence in recommendations
- 300+ rounds: supports per-map sub-optimization
- 1000+ rounds: can detect subtle parameter interactions

**Sparse Elo coverage.** Players not in the EloTracker backup default to `mu = 25.0`. Evaluate parameter sets on high-coverage rounds separately to validate they generalise.

**Event ordering noise.** Same-timestamp JOIN/LEAVE events are heuristically ordered (LEAVE first). Unavoidable without log schema changes. The coarse grid search averages over this noise — winners are stable despite it.

**No lookahead.** The algorithm is greedy — per-player decisions at join time with no anticipation of future joins. The optimizer can only tune the greedy baseline. A cluster of high-Mu players joining in sequence will always cause transient imbalance regardless of parameters.

**No model of player agency.** The optimizer assumes assignments stick. It cannot model manual team switches, idle players, or admin interventions that follow a bad assignment. Parameters that appear optimal in simulation may underperform in production if they produce assignments players actively resist.

---

## 7. Files

| File | Purpose |
|---|---|
| `replay-round.js` | Round replay and comparison tool |
| `optimize-params.js` | Coarse-to-fine grid search optimizer |
| `repair-gamemode.js` | One-time utility to fix gamemode field in existing logs |
| `smart-assign-log__2_.jsonl` | Current clean log (32 rounds post-trim) |
| `elo-backup-2026-04-11.json` | EloTracker export (14,985 players, ~90% Mu coverage) |
