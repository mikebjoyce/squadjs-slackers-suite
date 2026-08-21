# Balance/Scramble Tuning — Handoff for Implementation

**Branch:** `experimental` · **Written:** 2026-08-21
**For:** whoever picks this up to actually ship changes. Full raw investigation,
with all methodology, caveats, and dead ends, lives in
`analysis/SCRAMBLE_BALANCE_INVESTIGATION.md` (§ references below point there).
This doc is the condensed, decision-focused version — read it first, go to the
full doc only when you need the "why," the exact numbers, or to sanity-check
a script before trusting it.

---

## TL;DR

Average ticket margin (~100-130 tickets) has a hard ceiling: **95%+ of its
variance is set by things that happen during the round** (individual play,
momentum, admin calls), invisible to any pre-round signal this data contains.
That was tested from every angle available — rating math, population, map,
duration, margin-weighted Elo — and it doesn't move. Two changes *do* have a
real, measured, currently-unshipped effect on the balance metric the scrambler
actually controls (pre-round μ-gap): scramble more often, and price clan
blocks. Ship those, and retarget the reported KPI from ticket margin to
win-rate parity, which those two changes actually move.

**Ship, in order of expected value:**
1. A new "raw skill-gap too big" scramble trigger, alongside the existing three (new)
2. Build and enable clan-block pricing in `tb-scrambler.js` (**not currently in the code — see correction below**)
3. Report win-rate parity as the headline balance KPI instead of ticket margin

**Do not:**
- Tune the reactive trigger thresholds (dominant-win/single-round/consecutive-wins) — same lever as #1, structurally worse (reacts to a blowout instead of preventing it)
- Build/enable stayer-weighted balancing (weighting the objective toward players predicted to stay the round) — tested previously, replay showed it makes production worse
- Touch the scrambler's mean/top-15 objective blend weights — already saturated
- Add margin-of-victory weighting to the Elo/TrueSkill rating engine — tested this session, real but small win-prediction benefit, zero ticket-margin benefit
- Replace the house-clan exemption with a rarity formula — tested, falsified

**Correction to a claim in the original investigation doc:** `§7` and `§9`
of `SCRAMBLE_BALANCE_INVESTIGATION.md` state that `clanBlockPenaltyEnabled`
and `stayerWeightingEnabled` are "implemented in `tb-scrambler.js`, off by
default." **This is false as of the current codebase, confirmed both by
inspection and by re-running the numbers.** `git grep` for both names in
`tb-scrambler.js` returns nothing; the file only has `clanGroups` support for
keeping a clan together as one atomic unit during shuffling (no scoring
bonus/penalty from it). Re-running `analysis/scramble-replay.js` against the
current code proves the flag is now a silent no-op: `clan-priced` comes out
statistically identical to `production` (zero-imbalance lobbies 47.3% vs
47.5%, improves 16/worsens 18 of 400 sampled lobbies — noise, not the
originally-claimed 58.0%/"improves 96, worsens 2"). This is the same failure
mode as the `eloSummary` regression documented elsewhere in this doc: a past
session built and replayed these features, but the code was never actually
committed and is now gone. The **original replay numbers** came from a
session where the code did exist, so they're plausible evidence that the
*idea* works, not proof about code that exists today. Before doing anything
with recommendation 2, whoever picks this up needs to rebuild
`clanBlockPenaltyEnabled` from the description in §7 (it converts clan-block
headcount imbalance to an equivalent μ-of-team-mean diff using a 13.93 effect
size, run through the existing `getPenalty()` curve) and re-run the replay to
confirm a real effect returns, not trust the old numbers blind.

---

## 1. What to build

### 1.1 Direct skill-gap scramble trigger — highest EV

**Problem:** only 26% of RAAS rounds are ever scrambled today (§2.5). All
three existing triggers check for indirect evidence of imbalance —
Consecutive Wins, Single Round Margin (a blowout), Win Streak — but **none
of them just directly check "is the team skill gap itself too big?"** The
scrambler can take any lobby to 0.09μ gap (§2.1), and a 0.4μ+ gap is already
known to predict a lopsided round (§2.6) — there's no need to wait for one
of the three indirect symptoms to show up when the underlying number is
already computable.

**What to add:** a fourth trigger condition in
`team-balancer/plugins/team-balancer.js` (alongside the existing three,
~line 1800-2032), evaluated at the exact same point and in the exact same
way the existing triggers already are — no new execution window, no change
to when scrambles happen. It simply adds: if the team μ-gap itself is
**≥ 0.4μ**, scramble — independent of whether a blowout or win-streak was
also observed. Reuse the existing `CHURN_FLOOR_MU`-equivalent constant
rather than inventing a new number — 0.4 is already validated for the
reactive floor logic (§2.2), so this is one threshold, two call sites.

**Why 0.4 specifically:** `analysis/predictive-trigger-simulate.js` (430 real
rounds, real LIVE roster, real scrambler) showed scrambling a lobby already
under 0.4μ makes the gap *worse* 18.6% of the time; above 0.4μ, only 0.2% of
the time. Below the line, threshold should gate *whether* to scramble, not
how hard.

**Checklist:**
- [ ] Compute the μ-gap the same way `scoreSwap()` already does, on whatever roster the existing reactive triggers use at the same evaluation point
- [ ] Record the trigger reason distinctly (e.g. `'Direct Skill Gap'`) — needed to separate its rounds from the other three in post-ship analysis
- [ ] Decide interaction with the existing three triggers (they're independent conditions checked at the same point, so likely just "any condition met → scramble" — but confirm no double-firing)
- [ ] Ship behind a config flag, off by default, same pattern as the other feature flags in this codebase
- [ ] **Post-ship watch is mandatory, not optional.** The ticket-margin column in every simulation is a projection through a weak r=0.155 relationship (§2.6), not a measurement. Track real mean/median ticket margin on predictive-triggered rounds vs. baseline (mean 113.3, sd 78.4) for a few weeks before calling it a win.

Do **not** instead tune the reactive thresholds (`minTicketsToCountAsDominantWin`,
`singleRoundScrambleThreshold`, `maxConsecutiveWinsWithoutThreshold`) — this was
proposed in tech-chat and tested directly (`analysis/reactive-threshold-sweep.js`,
§10). It raises the scramble rate by a similar amount (36-47% vs today's 26% —
roughly 1.4-1.8x, not triple) but is structurally worse: it can only fire
*after* a round has already gone lopsided, trading "wait for a worse stomp"
for "wait for a smaller stomp." It never prevents the bad round. The
predictive trigger subsumes what this proposal is trying to do.

### 1.2 Clan-block penalty — second highest EV, needs to be (re)built

**Problem:** non-house clan blocks of 4+ players beat their rating by
12-23 win-probability points (§5, §7) — survives rating-confidence controls,
5-fold CV, and a reverse-causation re-test on the round-start (not endgame)
roster, where the effect actually *doubles*. This holds even on teams the
scrambler itself already built, keeping squads atomic — the scrambler pays
the cohesion cost and doesn't price the strength it creates. 23% of rounds
carry a clan-block imbalance of 4+, concentrated in a small population
(~3% of players) with a large per-capita effect.

**What to do — corrected:** the plan was to flip `clanBlockPenaltyEnabled: true`
in the team-balancer's scrambler call on the assumption it was already coded.
**It is not.** `git grep clanBlockPenaltyEnabled team-balancer/utils/tb-scrambler.js`
returns nothing — the file only has `extractClanGroups()`-fed `clanGroups`
support for keeping a clan together as one atomic unit while shuffling, with
no scoring bonus/penalty derived from it. A past session built and replayed
the penalty version, but it was never committed and is now gone (same
failure mode as the `eloSummary` regression noted elsewhere in this doc).
**This needs to be written before it can ship.** From the description
preserved in `SCRAMBLE_BALANCE_INVESTIGATION.md` §7: convert clan-block
headcount imbalance into an equivalent μ-of-team-mean diff using an effect
size of 13.93 (calibrated there), and run it through the same penalty curve
`scoreSwap()` already applies to the μ term. `extractClanGroups()` already
excludes the house tag via `ignoreList`, same source as production's existing
clan logic, so that part doesn't need rebuilding.

**Replay validation, from the session where the code existed** (793 real
lobbies, `analysis/scramble-replay.js`) — treat as a target to reproduce,
not a guarantee:

| | production | clan-priced |
|---|---|---|
| post-scramble clan-block imbalance, mean | 0.61 | **0.42** |
| lobbies with zero imbalance | 47.5% | **58.0%** |
| mu gap after scramble, mean | 0.09 | 0.10 |
| players moved, mean | 40.3 | 40.3 |

Lobby by lobby: improved 96, worsened 2, unchanged 695 — the 2 regressions
looked like search noise (2000 random attempts per scramble), not a
directional problem.

Re-running the replay against today's code (where the flag is a no-op)
confirms the above numbers are not currently reproducible: `clan-priced`
comes out statistically identical to `production` (47.3% vs 47.5%
zero-imbalance, improves 16/worsens 18 of 400 sampled lobbies — noise). This
is expected and is exactly why the code needs rebuilding, not evidence
against the underlying idea.

**Checklist:**
- [ ] Re-implement `clanBlockPenaltyEnabled` in `tb-scrambler.js` per the description above, gated off by default
- [ ] Re-run `analysis/scramble-replay.js` against it and confirm the table above still roughly holds before shipping — don't ship on the strength of the old numbers alone
- [ ] **Post-ship watch, same caveat as 1.1** — `analysis/clan-block-margin.js` found no significant ticket-margin effect for clan-block imbalance specifically (R² 0.0245→0.0283, p=0.197, not distinguishable from noise). Watch whether zero-imbalance rounds trend toward closer real games; don't assume it from the offline replay.
- [ ] Consider learned co-play affinity as a *second* term later (§7) — not now. Real signal (23.5% of recurring groups wear no clan tag), but needs a maintained co-play table and has a cold-start problem. Clan tag alone beats it head-to-head today because of that cold start.

### 1.3 Retarget the KPI

Stop reporting/optimizing mean ticket margin as the primary balance KPI.
`ticket-margin-drivers.js` (nested OLS, 951 RAAS rounds) shows everything
knowable before a round starts — μ-gap, population, which map is queued —
together explains only 4.7% of ticket-margin variance. It is not a lever,
by anyone's algorithm, tested three separate ways this investigation (see
§2 below). Report win-rate parity instead (share of rounds within a "close"
win-probability band, or the higher-μ-team win rate against the Q1-Q4 table
in §2.6 of the full doc) — this is the metric 1.1 and 1.2 actually move.

Small unrelated bug worth a one-line fix whenever someone's in that code
path: `TB_RoundReport.scrambleType` is NULL on all 395 scrambled rounds
recorded — the column records nothing.

---

## 2. Confirmed dead ends (don't re-litigate without new evidence)

| avenue | verdict | evidence |
|---|---|---|
| Churn floor / players-moved tuning | Scrambler saturates at 0.09μ regardless — doubling churn changes nothing | §2.1 |
| Objective reweighting (mean vs top-15 blend) | Best case explains 2.4% of margin variance; already near-saturated | §2.7 |
| Reactive threshold tuning (lower the blowout/streak triggers) | Same lever as 1.1, structurally worse — reacts instead of prevents | §10 |
| Stayer-weighted balance | Built and replayed against 793 lobbies in a past session (code no longer present in `tb-scrambler.js` — same lost-code issue as clan pricing, see §1.2 correction above) — **made production worse** (mean μ gap 0.09→0.11, p<0.05). Real retention signal exists, but turning it into a search objective steers away from the metric production is judged on (Goodhart's law). Don't rebuild this one — the answer was no | §4 direction 3 |
| Rated-coverage parity (unrated share as a scorer input) | Mostly reverse causation — losing teams shed players and get backfilled with late-joiners. Genuine residual is tiny (ΔlogLik 2.20) and fully absorbed by σ once σ is in the model | §6, §6a |
| House-clan exemption as a rarity formula | Falsified — effect isn't monotone in how rarely a clan plays here; sits in a middle band only. Exemption stays empirical (an `ignoreList`), not derivable | §7 |
| Margin-of-victory-weighted Elo (**tested this session**) | Modestly improves win-prediction log-loss (0.6075→0.6027 as MOV weight increases) — separate, real benefit for win-rate parity. **Zero effect on ticket-margin predictability** (R² stays flat ~0.005 across every weight tested) | see §3 below |

---

## 3. This session's specific work (context for the repo diff)

- **Reverted `elo-tracker/utils/elo-calculator.js`'s `TAU`/`BETA` constants to
  the master-branch baseline** (`TAU = 25.0/100.0`, `BETA = 25.0/6.0`).
  Experimental had these overridden to `TAU=0.27`/`BETA=4.85` from a
  2026-07-30 calibration exercise — but that calibration was never meant to
  replace the constants every historical game was actually rated/played under,
  and should not go live without a deliberate decision to do so. **The
  calibration itself (methodology, tooling, findings) is untouched** —
  `elo-tracker/tools/elo-calibrate.js` and the 2026-07-30 findings stay in the
  repo for posterity/future reference, only the two live constants moved back.
- **Tested margin-of-victory-weighted Elo directly**
  (`analysis/elo-margin-weighting-test.js`, not yet in the doc's script index
  — add it, category §4 direction 6 / ticket-margin ceiling confirmation).
  Scaling each round's rating update by its own ticket margin was proposed as
  a way to hit the ticket-margin KPI. Result: real, monotonic win-prediction
  improvement (log-loss 0.6075→0.6027 across MOV strengths 0→1.5), but the
  mu-gap-to-realized-ticket-margin correlation stays flat (R² 0.0049-0.0056,
  no trend) regardless of strength. Third independent confirmation of the
  same ceiling as §2.6 and `ticket-margin-drivers.js` — expected, not a
  modeling failure. **Caveat for whoever re-runs this:** the script's baseline
  R² isn't directly comparable to `ticket-margin-drivers.js`'s R²=0.0241,
  because this replay applies today's fixed BETA/TAU across the whole
  history while production ran under different constants before 2026-07-30 —
  only the relative comparison *across* MOV strengths within this script is
  apples-to-apples.
- **Fixed a real regression**: `Scrambler.scrambleTeamsPreservingSquads(...).eloSummary`
  had never actually been committed to `tb-scrambler.js` on any branch (proven
  via `git log -S"eloSummary" --all`) — lost in a past session before ever
  being committed, not lost in the master merge as first suspected. Re-added
  fresh; `scramble-replay.js` now produces real (non-NaN) output again.
- **Built and validated `analysis/reactive-threshold-sweep.js`** answering a
  tech-chat proposal to lower reactive trigger thresholds — see §1.1 above
  and the full doc's §10 for the validation methodology (91% reproduction of
  real scrambled-round totals via a from-scratch port of the trigger state
  machine).

Everything above is uncommitted in the working tree (staged files: the
investigation doc, `reactive-threshold-sweep.js`, `tb-scrambler.js`'s
`eloSummary` fix; unstaged: `elo-calculator.js`'s constant revert;
untracked: `elo-margin-weighting-test.js`) — nothing has been committed
this session per the no-git-writes convention on this repo.

---

## 4. Script index (for re-running anything)

See `analysis/SCRAMBLE_BALANCE_INVESTIGATION.md` §8 for the full index with
one-line descriptions of all ~20 scripts. All run via
`node --max-old-space-size=4096 analysis/<script>.js` — the exports are
~200MB. `analysis/load-export.js` is the shared loader/stats-helper module
every other script depends on.
