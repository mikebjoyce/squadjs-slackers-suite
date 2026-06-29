# Category 3 — Team Switching Test Plan

**Date:** 2026-06-28  
**Human Activity Required:** 2+ players, one switches teams  
**Estimated Duration:** 20–30 minutes

## Purpose

Verify team switching works correctly across all paths: `!switch` admin command, `!t1`/`!t6` RCON commands, and auto-balance via TeamBalancer.

## Pre-requisites

- SquadJS running with S³, SA, Switch, TB, Elo loaded
- 2+ players on different teams
- Discord admin channel available

## Test Steps

### Step 1: Discord !switch Command
1. Player A on Team 1, Player B on Team 2
2. Admin runs `!switch <PlayerB>` in Discord
3. Verify Player B moves to Team 1
4. Run `!s3 players` — verify team change reflected
5. Check SquadJS logs for move attribution

### Step 2: Cooldown Enforcement
1. Immediately re-run `!switch <PlayerB>` 
2. Verify cooldown message appears
3. Wait for cooldown to expire
4. Re-run switch — should succeed

### Step 3: In-Game !t1 / !t6 Commands
1. Run `!t1` in game chat — verify player moves to Team 1
2. Run `!t6` in game chat — verify player moves to Team 2
3. Verify S³ logs the team change

### Step 4: Auto-Balance (TB Scramble)
1. Have 3+ players on one team, 1 on the other
2. Admin runs `!teambalancer scramble` in Discord
3. Verify players are redistributed
4. Verify cooldowns are respected

### Step 5: SA Re-Assignment
1. After a scramble, a new player joins
2. Verify SA assigns them based on Elo balance
3. Verify the assignment triggers the SA↔Switch handshake correctly

## Expected Results

| Check | Expected | Actual | Pass/Fail |
|-------|----------|--------|-----------|
| !switch moves player | Team changes correctly | | |
| Cooldown enforced | Blocked within cooldown | | |
| !t1/!t6 work | Team 1/2 assignment | | |
| TB scramble balanced | Teams within 1 player | | |
| SA re-assignment | New player assigned by Elo | | |

---

*Test plan drafted 2026-06-28*