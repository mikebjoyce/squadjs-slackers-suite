# Category 3 — Performance Profiling Test Plan

**Date:** 2026-06-28  
**Human Activity Required:** Run profiling scripts, record timings  
**Estimated Duration:** 20–30 minutes

## Purpose

Measure performance of the join pipeline, handshake latency, migration runtime, and export/import timing.

## Pre-requisites

- SquadJS running with all plugins
- Ability to view SquadJS logs with timestamps
- A populated database (≥10 rounds of play data)

## Scenarios

### 1. Join Pipeline Latency
1. Enable timestamp logging on SquadJS (or add `console.time()` markers)
2. Player joins server
3. Measure time from PLAYER_CONNECTED event to complete processing (session, SA, Switch, Elo)
4. Repeat 3 times, record min/avg/max

**Expected:** < 5 seconds single join, < 15 seconds for 3 simultaneous joins

### 2. Handshake Latency
1. Player joins server
2. Measure time from SA assignment decision to Switch receiving the event
3. Record any retries

**Expected:** < 2 seconds handshake completion

### 3. Migration Runtime
1. Run `!s3 db migrate` (or startup migration)
2. Record total time for all plugins
3. Note per-plugin timing

**Expected:** < 5 seconds for all migrations combined

### 4. Export/Import Timing
1. Run `!s3 db export` — note response time
2. Run `!s3 db export --all` with populated DB — note time
3. Run `!s3 db import --confirm --dry-run` — note validation time
4. Check exported JSON file size

**Expected:** < 2 seconds for 10K rows, < 10 seconds for 100K rows

## Results Table

| Scenario | Run 1 | Run 2 | Run 3 | Avg | Expected | Pass/Fail |
|----------|-------|-------|-------|-----|----------|-----------|
| Single join (ms) | | | | | < 5000 | |
| 3x join (ms) | | | | | < 15000 | |
| Handshake (ms) | | | | | < 2000 | |
| Migration (ms) | | | | | < 5000 | |
| Export (ms) | | | | | < 2000 | |
| Import dry-run (ms) | | | | | < 2000 | |
| Export file size (KB) | | | | | < 8192 | |

## Notes

- Remove `console.time()` markers after profiling
- Test on the same hardware as production for representative numbers
- Run each scenario 3 times and take the median if variance is high

---

*Test plan drafted 2026-06-28*