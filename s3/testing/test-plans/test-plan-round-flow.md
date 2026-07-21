# Category 3 — Round Flow Test Plan

**Date:** 2026-06-28  
**Human Activity Required:** Play through a full round (2+ players)  
**Estimated Duration:** 30–45 minutes

## Purpose

Verify the complete round lifecycle: NEW_GAME → STAGING → LIVE → ROUND_ENDED → ENDGAME → next NEW_GAME. Checks all services maintain correct state throughout, Elo tracker records ratings, TB generates round reports, SA logs assignments.

## Pre-requisites

- SquadJS running with all 5 plugins loaded
- 2+ players on the server
- Discord admin channel available

## Test Steps

### Step 1: Round Start
1. Note phase via `!s3 status` — should show STAGING or LIVE
2. Note match ID: `!s3 gamestate`
3. Verify `roundStartTime` is non-null

### Step 2: During Play
1. Play for 5–10 minutes
2. Run `!s3 status` periodically — verify phase stays LIVE
3. If players switch teams, note that SA handles re-assignment

### Step 3: Round End
1. When round ends, immediately run `!s3 status`
2. Verify phase transitions to ENDGAME
3. Verify `roundEndTime` is populated
4. Check !elo stats for Elo changes

### Step 4: ENDGAME Sub-States
1. During voting, run `!s3 gamestate` to check ENDGAME sub-state
2. Verify the sub-state progresses through scoreboard → voting → postVoting

### Step 5: Next Round
1. When NEW_GAME fires, verify phase → STAGING(resolving=true) → STAGING(resolving=false) → LIVE
2. Verify `matchId` changes (new round)
3. Verify `roundStartTime` is reset for the new round

## Expected Results

| Check | Expected | Actual | Pass/Fail |
|-------|----------|--------|-----------|
| Phase transitions | staging → live → endgame → staging | | |
| roundStartTime | Non-null during LIVE | | |
| matchId | Changes per round | | |
| Elo recorded | Players have updated ratings | | |
| TB round report | Generated after ROUND_ENDED | | |
| ENDGAME sub-states | Progress correctly | | |

---

*Test plan drafted 2026-06-28*