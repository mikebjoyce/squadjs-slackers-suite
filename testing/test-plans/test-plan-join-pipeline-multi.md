# Category 3 — Multi-Player Join Pipeline Test Plan

**Date:** 2026-06-28  
**Human Activity Required:** 3+ players on the server  
**Estimated Duration:** 15–20 minutes

## Purpose

Verify the full player join pipeline functions correctly under multi-player concurrency: multiple players join in quick succession, and all services (serverConfig, gameState, factions, clans, players) process each player without errors or crash loops.

## Pre-requisites

- SquadJS running with all 5 plugins loaded (S³, SA, Switch, Elo, TB)
- Discord admin channel available
- Server is on a normal game layer (not Seed/Training)
- Server is in STAGING or LIVE phase

## Test Steps

### Step 1: Prepare Baseline
1. Note the current player count via Discord: `!s3 status`
2. Verify no active sessions: `!s3 db status`
3. Record the current game phase and layer

### Step 2: First Player Joins
1. Player A joins the server
2. Wait 30 seconds for full processing
3. Run `!s3 status` — verify:
   - Player count increased by 1
   - Session info shows for Player A
4. Run `!s3 players` — verify Player A appears with correct teamID
5. Check SquadJS logs for any errors during join processing

### Step 3: Second Player Joins
1. Player B joins the server (while Player A is still connected)
2. Wait 30 seconds
3. Run `!s3 status` — verify player count increased
4. Run `!s3 players` — verify both players listed with correct teamIDs
5. Run `!sa` commands if available — verify SA correctly assessed team balance

### Step 4: Third Player Joins (Concurrent)
1. Players A, B, and C coordinate to join within 5 seconds of each other
2. Wait 60 seconds for all processing
3. Run `!s3 status` — verify all 3 players are counted
4. Run `!s3 players` — verify all 3 listed with correct teams
5. Check SquadJS logs for any concurrency errors or lock contention messages

### Step 5: Rapid Join/Leave
1. Player D joins and leaves within 10 seconds (3 times)
2. Run `!s3 players` — verify Player D is no longer listed (or shows as disconnected)
3. Run `!s3 status` — verify session count does not include ghost sessions

### Step 6: Verify Service Isolation
1. While players are on the server, run `!s3 services`
2. Verify all 6 services show ✅ status
3. Check that no service shows errors or failed states

## Expected Results

| Step | Expected | Actual | Pass/Fail |
|------|----------|--------|-----------|
| 1 | Baseline recorded | | |
| 2 | Player A appears in all services | | |
| 3 | Both A and B appear correctly | | |
| 4 | All 3 players processed without errors | | |
| 5 | No ghost sessions remaining | | |
| 6 | All services healthy | | |

## Failure Notes

Document any failures here with:
- Error message from SquadJS logs
- `!s3 status` output at time of failure
- Player count and identities

---

*Test plan drafted 2026-06-28*