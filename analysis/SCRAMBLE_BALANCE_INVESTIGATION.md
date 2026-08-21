# Scramble & Balance Investigation

**Window analysed:** 2026-05-23 → 2026-08-20 (~88 days)
**Data:** `docs/dataDump/s3-export-2026-08-20T12-58-58.s3backup.json`
**Scope:** RAAS only, full lobbies only. Written 2026-08-21.

Driving question: *the average ticket difference has plateaued — is there strategic
tuning of the scramble that would make games closer?*

Short answer: **not in the scrambler.** It is already saturated. The remaining
levers are how *often* it runs, and one dimension of balance it is currently
blind to.

---

## 1. Read this before trusting any number

Four traps, each of which produced a plausible wrong answer before being caught.

**`Elo_RoundHistory.playerCount` is not population.** It counts *distinct
participants across the whole round* — median ~120 against a 100-slot server —
and correlates **negatively** (r = −0.16) with actual concurrent players, because
a server churning through people accumulates more distinct names. Filtering on it
selects *worse* lobbies while appearing to do the opposite. Use
`sum(participationRatio)` over `Elo_RoundPlayers` instead (r = 0.86 with live
snapshot roster size).

**Elo tables are already population-filtered.** `minPlayersForElo` (default 80,
checked at `ROUND_ENDED` against live connected count) means `Elo_RoundHistory`
contains *only* full lobbies. Applying an 80-player filter on top drops ~10
rounds. TeamBalancer has **no such gate**, so anything joined to Elo is
structurally blind to balancer behaviour below 80 players. `TB_RoundReport` is
the unconditioned universe — written in a `finally` for every `ROUND_ENDED`.

**Join TB to Elo on timestamp, not `matchId`.** `matchId` was cohered between the
two plugins only partway through the window; 540 of 1031 Elo rows carry none.
A `matchId` join silently scores every pre-coherence round as "balancer played it,
Elo ignored it" — inflating the interesting number by ~600. `TB_RoundReport.ts`
and `Elo_RoundHistory.endedAt` agree to **within 1 ms** on cohered pairs, and
consecutive rounds are ≥36 min apart, so a 60 s window is exact and unambiguous.
Sequence-position matching is *unsafe*: some rounds exist in one table and not the
other, which shifts every pair after them.

**Unrated players sit at exactly μ = 25.0, and this fakes balance.** Every unrated
player pulls both team means toward the same point, shrinking the *measured* gap
without changing the real one. This manufactured a spurious finding that roster
turnover *improves* balance (r = −0.177); r(turnover, unrated share) = 0.652, and
restricting to ≤10% unrated collapses it to −0.037. **Any era or cohort comparison
must control for unrated share.** Median unrated share is ~14%.

Also worth knowing: `RAAS` must be matched after normalising `[_-]` to spaces —
`\bRAAS\b` never matches `Yehorivka_RAAS_v2` because `_` is a word character. This
silently dumped 321 of 1031 rounds into "Other".

---

## 2. Established findings

### 2.1 The scrambler is saturated — churn is a dead lever

793 real end-of-round lobbies (`S3PlayerSnapshots` ENDGAME: real squads,
point-in-time ratings rebuilt to avoid look-ahead) replayed through the **actual**
`tb-scrambler.js` at seven churn floors:

| config | players moved | post μ gap (mean/median) | reach Q1 (<0.20) |
|---|---|---|---|
| production | 40.4 | 0.09 / 0.06 | 89.2% |
| no floor | 34.7 | 0.10 / 0.07 | 86.6% |
| floor 20 | 30.6 | 0.10 / 0.07 | 87.1% |
| floor 40 | 48.9 | 0.09 / 0.06 | 89.8% |
| floor 50 | 58.5 | 0.08 / 0.06 | 91.0% |
| floor 60 | 66.2 | 0.11 / 0.07 | 83.4% |

Double the churn, nothing changes. Squad atomicity is **not** the binding
constraint. There is no tuning available in churn, weights, or player count.

### 2.2 The hardcoded 0.4μ churn floor is a no-op

`team-balancer.js:2466` forces a 40–55 player shuffle when the pre-scramble mean-μ
delta is below a hardcoded `0.4`, and imposes no floor above it. The comment calls
this an "edge case"; **0.4 actually sits at percentile 48.9** of its own input
distribution, and the distribution is flat straight through it (106/125/120/114 in
the 0.1-wide bins below the line). It governs half of all scrambles, and it
withholds the floor from precisely the rounds with the largest gaps.

Per 2.1 this costs nothing — production and "no floor" land on the same μ gap. It
is a design oddity, not a defect. **Do not spend time here.**

### 2.3 The scramble works, and by more than first estimated

Matched on provocation (both groups following a ≥150-ticket blowout, controlling
for regression to the mean, since scrambles are *triggered* by blowouts):

| | n | μ gap at round | ticket margin (mean/median) |
|---|---|---|---|
| after a scramble | 152 | 0.25 | 104.5 / **84** |
| after no scramble | 111 | 0.57 | 126.7 / **114** |

**~22 tickets of mean margin, ~30 of median.** An earlier estimate of "2–3 tickets"
was wrong — it came from a cross-sectional quartile slope, attenuated by exactly
the measurement noise already established.

### 2.4 Balance decays 0.09 → 0.25 through roster turnover

The scrambler hands over 0.09μ; rounds are played at 0.25μ. Median **41.7% of each
round's roster was not in the previous round** — ~50 new faces per round.

**Scrambles do not cause this.** Matched on blowout: 41.4% turnover / 47.9 players
lost after a scramble, vs 44.4% / 52.5 after none. Scrambled rounds lose *slightly
fewer* people. The churn is the round boundary itself.

*Consequence:* the "scrambling more often will drive players away" objection is not
supported by the data.

### 2.5 Only 26% of rounds are ever scrambled — the biggest remaining lever

```
RAAS rounds recorded:   1114
scrambled:               288  (25.9%)   → median μ gap 0.25, margin  87
left alone:              826  (74.1%)   → median μ gap 0.53, margin 106
```

Triggers are all *reactive* (blowout margin, consecutive wins, win streak) — they
fire after a bad round. The replay shows the scrambler can take **any** lobby to
0.09μ, so waiting for evidence of imbalance is unnecessary when it can be measured
directly at round end.

**Proposal:** add a *predictive* trigger on the pre-round μ gap. Caveats:
- On lobbies already below 0.4μ, scrambling made the gap **worse 24%** of the time.
  Above 0.4μ it made it worse in **0.2%**. So the threshold should gate *whether to
  scramble*, not how hard.
- Rough ceiling if the effect transfers: median margin ~102 → ~87.

### 2.6 μ predicts direction well, magnitude badly

RAAS, 80+ effective pop, 951 rounds:

| metric | value |
|---|---|
| higher-μ team wins | 62.8% (z = 7.88) |
| Q1 (μ gap 0.001–0.205) | 51.1% — coin flip |
| Q4 (μ gap 0.795–2.885) | 76.7% |
| r(μ gap, ticket diff) | 0.155 → **2.4% of variance** |
| ticket margin | mean 113.3, sd 78.4 |

The ticket-difference KPI is barely responsive to anything the balancer controls.
**Win-rate parity (60/40 → coin flip) is achievable; median ticket margin largely
is not.** Consider re-targeting the KPI.

### 2.7 The experimental branch's objective reweighting: don't port it

master uses `0.6*meanDiff + 0.4*top15Diff`; experimental uses `0.9/0.1`. Swept
against actual outcomes on 951 rounds:

| w(mean) | direction accuracy | r(\|score\|, margin) |
|---|---|---|
| 0.0 | 61.2% | 0.097 |
| 0.6 | 62.0% | 0.117 ← master |
| 0.9 | 62.6% | 0.144 ← experimental |
| 1.0 | **62.8%** | **0.155** |

Direction spread is 2.00 points against a 1.57-point SE — **not separable**. But
the margin correlation is **monotone across all 11 points**, which is much harder
to get from noise. So the experimental branch's *direction* is right and it did not
go far enough: the data says drop top-15 **entirely**. The two terms correlate at
r = 0.828 — largely the same measurement counted twice.

**Still not worth porting:** best case explains 2.4% of margin variance, and per 2.1
the scrambler saturates at 0.09μ under every weighting. If touching that code
anyway, `1.0 * meanDiff` is simpler and mildly better.

### 2.8 SmartAssign: failures are an engine limitation, not a bug

Went live 2026-07-01 (clean activation). 13.5% of attempted moves fail. Located
precisely:

| time after round end | attempts | rate |
|---|---|---|
| 0–30s | 45 | 0.0% |
| 30–60s | 569 | 5.1% |
| 1–2m | 199 | **100.0%** |
| 2–3m | 697 | 98.3% |
| 3–4m | 163 | 93.9% |

**94.6% of all failures** are in this window (z = 62). Within live play the rate
never leaves 0.3–1.7%, including the final 60 seconds.

**Root cause (confirmed by operator, corrects an earlier wrong guess in this
doc): the Squad engine itself blocks team-change requests once the post-round
faction-vote phase starts, as an anti-abuse measure** — not "map travel" or
the level being unloaded, which was this doc's original, incorrect
explanation for the timing. The 1–4 minute window lines up with that vote
phase, which is why the failure rate there is ~94–100% and drops back to
near-zero once live play resumes. This is an engine-level restriction outside
SquadJS's control, not something SmartAssign is doing wrong.

**Decision (operator): accept these failures.** A gate would convert failures into
non-moves — identical outcome, tidier logs. SmartAssign's value is moving people
*invisibly*; a deferred move landing at map start is a visible move, which defeats
the purpose. Not worth building.

*Note:* the schema at `smart-assign.js:342` declares a `MOVE_RETRY` event type with
zero rows ever written.

### 2.9 SmartAssign's contribution is not measurable from this data

The 2026-07-01 activation looks like a natural experiment but does not survive:
- **Bias runs the wrong way.** SA era is **16.1% unrated vs 13.0%** before — so it
  gets an *artificial advantage* on the μ-gap metric (see §1).
- **Controlling for it guts the sample** (n=20 scrambled rounds in the SA era), and
  the filter is itself correlated with era.
- **The metrics disagree**: SA era shows better μ parity (0.47→0.32) but *worse*
  ticket margins (75.8→111.7).

No verdict — not "it doesn't work", but "this cannot resolve it".

### 2.10 Low-population rounds

165 rounds below the Elo threshold, 36 scrambled — 2.5% of all rounds. A different
regime (mean margin 265–285 vs 112). Small enough to ignore for tuning; possibly
worth *gating* scrambles there. The 80% scramble rate in the 40–59 band is reverse
causality: `Single Round Margin` fires *after* a blowout, and low pop causes
blowouts.

---

## 3. Ruled out

| avenue | verdict |
|---|---|
| Churn / `scramblePercentage` / players-moved tuning | Dead — §2.1 |
| The 0.4μ churn-floor threshold | No-op — §2.2 |
| Objective reweighting (mean vs top-15) | ≤2.4% variance ceiling — §2.7 |
| Scrambles driving players off the server | Not supported — §2.4 |
| Gating SmartAssign around map travel | Accepted as-is — §2.8 |
| Balancing around Invasion ticket data | Invalid — different ticket economy |

---

## 4. Open directions, ranked

> **Ranking updated after direction 3's Part 3.** Directions 2, 3, 4 and 5 are all
> resolved — none remain open or in progress. Of the two with a real, positive
> effect (1 and 4), neither is enabled in production; both wait on the same
> ticket-margin translation gap. Current order of expected value: **1 (scramble
> more often) → 4 (clan concentration) → 5 (rated-coverage parity, small residual)
> → 6 (re-target KPI)**. Directions 2 and 3 are closed negative.

**1. Scramble more often** (§2.5). Highest expected value by a wide margin. Add a
predictive pre-round μ-gap trigger; gate on gap ≥ ~0.4–0.6 so already-balanced
lobbies are left alone.

Simulated in `analysis/predictive-trigger-simulate.js`: 430 real rounds, real
LIVE (round-start) roster, real scrambler, no forced floor. Confirms the §2.5
caveat at the correct timing — scrambling a lobby already under 0.4μ makes the
gap *worse* 18.6% of the time (n=161); above 0.4μ, 0.4% of the time (n=269). A
threshold sweep:

| threshold | coverage | mean post-trigger gap | projected mean ticket diff | Δ vs no trigger |
|---|---|---|---|---|
| 0.2μ | 81.6% | 0.103 | 101.5 | -13.5 |
| 0.4μ | 62.6% | 0.142 | 102.5 | -12.5 |
| 0.6μ | 45.3% | 0.207 | 104.2 | -10.9 |
| 1.0μ | 22.3% | 0.363 | 108.2 | -6.9 |

0.4μ is the honest floor for the threshold: below it the "made worse" rate climbs
sharply (18.6%) for one more point of coverage, and the gap-narrowing itself is
small in absolute terms everywhere on this table. Players moved is flat across
thresholds (~35 mean) since it's the same no-floor optimizer either way — the
threshold only gates whether it runs, not how hard.

**The ticket-margin column is a projection through the same weak relationship
flagged in §2.6 and re-confirmed in §7's clan-block-margin test (R²=0.0245,
p=0.001 here) — statistically real but tiny, not a measured outcome.** The one
thing on this table that's exact rather than modeled is the μ-gap column and the
worse-rate check. Recommendation: implement the 0.4μ gate (matches the existing
`CHURN_FLOOR_MU` constant, so it reuses a number already validated for a related
purpose) and watch real ticket margins after shipping — this simulation cannot
tell you whether it will actually close games, only that it won't make gap-level
balance worse.

**2. Squad coordination — the objective is blind to it.** ~~*In progress*~~ **Resolved
and largely negative; see §5.** In-game squad size carries no information beyond μ,
under calibration, nested LRT, and cross-validation alike. The coordination effect is
real but lives in *clans*, not squads — see direction 4, which this promotes rather
than absorbs.

**3. Balance the roster that will still be there.** The scrambler optimises parity
over a lobby that is 42% gone by round end — that is the entire 0.09 → 0.25 decay.
Weight the objective toward players likely to stay (session length so far,
historical round count). Two-part test: is retention predictable at all from
`S3_PlayerSession` / `S3PlayerEvents`, and does parity-among-stayers beat
parity-among-everyone at predicting round-time balance?

**Part 1 — yes, decisively.** `analysis/retention-predictors.js`: 430 rounds, 41,207
player-rounds, leave label from `S3PlayerEvents` mid-round `LEAVE` events (not the
coarser LIVE-vs-ENDGAME roster diff — this is the actual connect/disconnect log).
Session length is reconstructed from the same table's `JOIN` history, since
`S3_PlayerSession` only holds each player's *current* session at export time and
cannot answer this for historical rounds.

Five pre-round features (session minutes, Elo-tracked rounds played, rated/unrated,
squad-assigned, μ) all predict leaving individually (all p<0.001) and together hold
up out of sample: 5-fold CV logLoss 0.6035 → **0.5465**, accuracy 70.9% → **74.5%**.
The standout: **`rated` alone carries ΔlogLik 1738** — an unrated player is far more
likely to leave mid-round than an established one, holding nothing else constant.

The benchmark that matters: adding `onLosingTeam` — the outcome itself, which a
real-time scrambler cannot see at round start — improves CV logLoss only to 0.5435,
barely past the all-pre-round model's 0.5465. **Pre-round information already
captures nearly everything that even knowing the eventual winner would add.** This
is not a small, outcome-diluted residual like direction 5's was — it is most of the
signal.

Part 1 clears the gate. Part 2 — does weighting parity toward the predicted stayers
actually beat parity-among-everyone at predicting *round-time* balance?

**Part 2 — yes, modestly, and it's real.** `analysis/stayer-weighted-balance.js`: 417
rounds with both a LIVE and ENDGAME roster. Ground truth is the ENDGAME roster's mu
gap — the realized team strengths after whatever churn happened, using each player's
real `muBefore` (ratings don't move mid-round, so this is exact). Two pre-round
estimators of that same quantity: **naiveGap** (today's scrambler input — mean mu
diff, everyone counted equally) and **weightedGap** (mean mu diff, each player
weighted by out-of-fold predicted P(stay) from part 1's model — refit per
chronological fold so no round's weight uses a model that saw its own outcome).

| | naive (today) | stayer-weighted |
|---|---|---|
| r(estimate, realized gap) | 0.842 | 0.848 |
| mean absolute error vs realized gap | 0.2544 | **0.2321** |
| median absolute error | 0.1912 | **0.1696** |

Round by round, stayer-weighted lands closer to the realized gap on 237 of 417
rounds vs naive's 180 (sign test z=2.79, p<0.01) — a real, not-coin-flip win. The
correlation gap is small (0.842→0.848) because naive parity was already a decent
proxy — most LIVE-roster players do stay — but the ~9% mean-error reduction is
consistent and statistically real, not noise.

Part 2 found a genuine, if modest, edge for a **pre-round estimator** of the
realized gap. That is not the same claim as "reweighting the scrambler's own
search objective produces a better outcome," because the scrambler doesn't just
evaluate one fixed roster — it searches over swaps, and a weighted objective can
steer the search toward a different swap than an unweighted one would have picked.
Whether that different swap is actually better has to be checked separately.

**Part 3 — implemented and replayed at the time. Verdict: not worth it, and
mildly worse.** [**2026-08-21 correction:** `git grep stayerWeightingEnabled
team-balancer/utils/tb-scrambler.js` now returns nothing — this code was
never actually committed and is gone, same failure mode as the `eloSummary`
regression noted in §10. The result below is preserved as-is because it's
the reason NOT to rebuild this feature, but if anyone needs to re-verify it,
the code needs to be re-implemented first.]
`stayerWeightingEnabled` was added to `tb-scrambler.js` (off by default): when
set, `scoreSwap()`'s mean-mu term is computed as a P(stay)-weighted average
instead of a naive one (top-15 term left unweighted, matching what Part 2 actually
measured). `analysis/scramble-replay.js` fits the same retention model once
(41,207 training rows) and replays it against all 793 eligible historical lobbies,
alongside `production`, scoring every config on the *same naive, everyone-weighted-
equally* post-scramble gap — the only apples-to-apples yardstick, since judging the
weighted config by its own weighted gap would be circular.

| | production | stayer-weighted |
|---|---|---|
| post-scramble mu gap (naive), mean | 0.09 | 0.11 (+0.01) |
| post-scramble mu gap (naive), median | 0.07 | 0.08 |
| players moved, mean | 40.4 | 39.4 |
| lobbies where this config's gap is smaller | 344 | 282 |

Sign test on the 626 decisive (non-tied) lobbies: z = -2.48, p < 0.05 —
**production beats stayer-weighted significantly**, not just by noise.

**Why Part 2's edge didn't survive Part 3.** The most likely explanation: Part 2
measured which *estimator* tracks a fixed roster's realized gap more accurately.
Part 3 lets that estimator drive a *search* over which players to swap, and
steering the search to minimize a P(stay)-weighted gap pulls it away from
minimizing the naive gap the round is actually judged on — a version of Goodhart's
law. The retention signal is real (Part 1), and weighted parity is a slightly
better passive predictor (Part 2), but turning it into an active optimization
target makes the thing production is actually scored on worse, not better.

**Verdict: direction 3 does not clear the bar for production.** `stayerWeightingEnabled`
stays implemented and off-by-default (zero regression confirmed via the full
`team-balancer/testing/run-all-tests.js` suite, 8/8 passed) as a documented dead
end, not a candidate for enabling.

**4. Clan / premade concentration.** ~~Merged into direction 2~~ **Confirmed, and it
is the surviving half of direction 2 — see §5.** Non-house clan blocks of 4+ beat
their rating by 12–23 points; the effect survives rating-confidence controls and
five-fold CV, and is worth ~0.1 μ per member on the team mean. 23% of rounds carry a
block imbalance of 4+. Applies to non-house clans **only** — verified at both team
and squad granularity, including actual house-clan squad stacks, which do not
overperform once rating confidence is controlled. The likely reason is not size but
exposure: the house clan plays here nightly, so its coordination is already priced
into individual μ. ~~**The offset should ultimately scale with how rarely a group
plays together, not how large it is**, which would make the exemption
self-maintaining instead of a hardcoded `ignoreList`.~~ **Tested in §7 and
falsified** — the effect peaks for clans seen 6–25 rounds and is *absent* at both
ends, so a monotone rarity weight is the wrong shape. The house exemption cannot yet
be replaced by a formula.

Re-measured on the **round-start** roster rather than the endgame one (§6), the clan
term does not weaken — it roughly doubles: ΔlogLik 3.48 → **11.26** on top of
controls. Endgame churn was masking it, not manufacturing it. This is now the
best-supported finding in the investigation and the only one measured on the roster
the scrambler actually produces.

**5. Rated-coverage parity.** ~~Untested hypothesis~~ ~~Confirmed, and the largest
single effect in this investigation~~ **Retracted — it was mostly reverse causation
(§6).** The ΔlogLik 23.45 was real but measured on the *endgame* roster, and unrated
share on that roster is largely an outcome: players quit a team that is losing and
the server backfills with late joiners. 93.2% of endgame "unrated" players are
established regulars who joined late, not newcomers. Re-measured on the round-start
roster the effect drops from ΔlogLik 22.78 to **2.20** (p = 0.036) and the
loser-side excess from z = 8.66 to z = 2.90. There is a small genuine residual, but
it is an order of magnitude below what was claimed here and it ranks **below** the
clan term, not above it. The σ-shrinkage question is untouched by this and remains
open.

**6. Re-target the KPI** (§2.6). Ticket margin is 2.4%-explained by everything the
balancer controls. Win-rate parity is reachable; median margin mostly is not.

**Checked directly: no, there is no hidden pre-round lever hiding in population,
duration, or map identity either.** `analysis/ticket-margin-drivers.js`, 951 RAAS
rounds, nested OLS on `|ticket diff|`:

| block | R² | ΔR² | p |
|---|---|---|---|
| \|mu delta\| alone | 0.0241 | — | — |
| + effective population | 0.0399 | 0.0158 | <0.001 |
| + layer identity (10 top maps as dummies) | 0.0469 | 0.0071 | 0.725 (n.s.) |

**Everything knowable before the round starts — mu, population, and which map is
queued — together explains 4.7% of ticket-margin variance, barely above mu alone.**
Layer identity looked real at first pass (ΔR²=0.057, p<0.001) — but only when round
duration was in the model ahead of it. Pulled out and tested alone, layer adds
essentially nothing (ΔR²=0.007, n.s.): its apparent effect was proxying for how long
that map's rounds tend to run, not an independent ticket-economy signal.

Round duration itself does correlate strongly (r=-0.521, ΔR² 0.312 on top of
everything else) but is explicitly **not counted as a driver**: RAAS ends when one
side's tickets hit zero, so a blowout produces both the short duration and the large
margin as joint outputs of the same in-round bleed rate. It cannot be set in advance,
so crediting it would be circular.

**Conclusion: the ~100-ticket mean margin is not a floor this investigation failed to
find a key for — it's close to the actual floor.** 95%+ of ticket-margin variance is
set by something that happens *during* the round (individual play, momentum swings,
admin calls) that isn't visible in any pre-round signal this data contains. Directions
1 and 4 remain the right levers because they're the only two with a measured,
non-circular effect on the balance metric itself (μ-gap) — but neither should be
expected to move the ticket-margin mean by more than the low double digits §2.3
already measured (~22 tickets from scrambling itself). Direction 6 (re-target the KPI
to win-rate parity, not ticket margin) is the practical conclusion, not a fallback.

**Also noted:** `TB_RoundReport.scrambleType` is NULL on all 395 scrambled rounds —
the column records nothing. Separate small bug.

---

## 5. Directions 2, 4 and 5 in detail — squad vs clan coordination

### The hypothesis

`tb-scrambler.js` scores candidates by summing μ and comparing team means. It
preserves squads as atoms but is **indifferent to how talent is distributed across
them**. Two teams can have identical mean μ where one has its nine best players in
one organised squad and the other has them scattered across nine squads. Those are
not equally strong teams and the scrambler cannot tell them apart.

This would also explain the central puzzle: μ predicts *direction* well (62.8%) but
*magnitude* terribly (r = 0.155, §2.6). If coordination is a real multiplier, the
missing variance has an obvious place to live.

> **Read §6 alongside this section.** Every number below is measured on the ENDGAME
> roster, which is downstream of the result. §6 re-runs the decisive tests on the
> round-start roster instead. The clan results survive and strengthen; the in-game
> squad and NL results are unchanged; the unrated-share result is **retracted** —
> it was largely the outcome leaking backwards into a feature.

### Prior art: TrueSkill2 (`docs/trueskill2.pdf`, §6 "Squad offset")

Minka, Cleven & Zaykov (Microsoft Research, 2018) test precisely the assumption our
scorer makes — that a squad's rating is the sum of its players' ratings — and
falsify it on Halo 5. Measured actual vs TrueSkill-predicted win rate by squad size:

| squad size | actual | predicted |
|---|---|---|
| 1 | 47% | 47% |
| 2 | 50% | 50% |
| 9 | **70%** | 54% |
| 10 | **89%** | 67% |

> "We see that the assumption about squads is false. The skill rating of a squad
> should be larger than the sum of its players, and the effect grows with the size
> of the squad."

Solo players are perfectly calibrated; large premades beat prediction by up to 22
points. Their fix is deliberately minimal — an additive offset to skill when
generating performance:

```
perf_i ~ N(skill_i + squadOffset(size of squad), β²)
```

`squadOffset` is an array of tunable parameters, one per squad size, per game mode,
with `squadOffset(1) = 0`.

### The adaptation that matters for us

TrueSkill2's "squad" is a **premade party that queued together** — a social group.
Squad's in-game squad is an **organisational unit that may be composed of
strangers**. These are different things, and separating them is the experiment:

- **In-game squad** (what `tb-scrambler.js` already treats as atomic) — coordination
  via a squad leader, voice comms, but not necessarily a social group.
- **Clan group / premade** (S³ `clans-service.js` tag extraction) — the closer
  analogue to TrueSkill2's squad.

This is why open direction 4 collapses into 2: they are the same mechanism measured
two ways. If the effect is concentrated in clan blocks rather than in-game squads,
the offset belongs on clan groups; if it is present in both, squad *size* itself
carries coordination value.

### Tests to run

1. **Replicate the TrueSkill2 table** — actual vs μ-predicted win rate bucketed by
   the player's squad size, and separately by clan-block size.
2. **Nested model comparison** — does a team-level structure feature (talent
   concentration across squads, largest coherent block, mean squad size) add
   predictive power for the winner *beyond* mean μ diff?
3. **If it holds:** add a squad/clan concentration parity term to the scrambler's
   objective. Unlike the blend weights (§2.7), this is a dimension currently at
   **zero**, not one already saturated.

### Results

`analysis/squad-coordination.js`, n = 451 rounds. Built from deduplicated ENDGAME
`S3PlayerSnapshots` (1099 rows → 708 distinct matches) joined to `Elo_RoundHistory`
by matchId with a 5-minute timestamp fallback, restricted to decided RAAS rounds at
80+ effective population. Tag extraction imports the real `ClansService` rather than
copying its regexes, so it cannot drift from production.

Baseline model — mean μ difference alone — gets **67.4%** of winners right.

#### The headline: it is clans, not squads

In-game squad size carries **nothing** beyond μ. Every bucket sits inside ±2 SE,
there is no monotone trend, and the largest gap (−2.2 points, for both unassigned
players and squads of 8) points the wrong way for a coordination story:

| in-game squad size | players | actual | μ-predicted | gap | ±2SE |
|---|---|---|---|---|---|
| 1 (unassigned) | 2762 | 47.5% | 49.7% | −2.2 | 4.7 |
| 3 | 2070 | 53.0% | 52.1% | +1.0 | 5.3 |
| 6–7 | 5172 | 49.1% | 49.5% | −0.4 | 5.2 |
| 8 | 8072 | 47.3% | 49.5% | −2.2 | 4.9 |
| 9 | 20385 | 51.6% | 50.3% | +1.3 | 4.7 |

Non-house clan blocks are a completely different picture — a clean dose-response
that is hard to explain any other way:

| clan block (no NL) | players | rounds | actual | μ-predicted | gap | ±2SE |
|---|---|---|---|---|---|---|
| 1 (none/solo) | 41719 | 451 | 49.7% | 49.9% | −0.2 | 4.7 |
| 2 | 986 | 299 | 50.7% | 50.2% | +0.5 | 5.8 |
| 3 | 516 | 141 | 51.7% | 53.0% | −1.3 | 8.4 |
| **4–5** | 461 | 95 | **67.9%** | 56.2% | **+11.7** | 9.6 |
| **6–8** | 229 | 35 | **80.3%** | 56.9% | **+23.4** | 13.4 |

This is TrueSkill2's Halo 5 table reproduced on a Squad server. Solo players are
calibrated to within a fifth of a point — exactly the control the paper predicts —
and the deviation grows with group size. The threshold is notable: blocks of 2–3 do
nothing, and the effect switches on at 4.

Standard errors use the number of contributing **rounds**, not player-rounds.
Players inside a round share one outcome, so treating them as independent would
overstate precision by roughly √(players per round).

#### The confound that had to be ruled out

Clan members are regulars with well-estimated μ. Transients are unrated and default
to **exactly μ = 25.0**, so the model scores them as precisely average. If they are
in fact below average, a team full of them is over-rated and its clan-heavy opponent
appears to "beat its rating" without coordinating at all.

That confound is real, and it is **larger than the clan effect**:

| feature added to meanMuDiff | ΔlogLik | χ² p |
|---|---|---|
| unrated share | 23.45 | <0.001 |
| mean σ | 5.90 | <0.001 |

Rating confidence alone lifts held-out accuracy from 67.4% to 70.1%. So every
structure feature was re-tested *on top of* both controls. The clan effect survives;
the squad effect does not:

| feature added to the control model | ΔlogLik | χ² p | verdict |
|---|---|---|---|
| players in squads ≥6 | 0.00 | 0.952 | dead |
| mean squad size | 0.42 | 0.361 | dead |
| μ concentrated in big squads | 0.00 | 0.982 | dead |
| **largest clan block (no NL)** | **6.11** | **<0.001** | survives |
| **μ concentrated in clan blocks** | **4.65** | **0.002** | survives |
| **clan-blocked ≥3 (no NL)** | **3.44** | **0.009** | survives |
| NL headcount | 0.00 | 1.000 | dead |

#### The house clan should *not* get a coordination bonus

NL is excluded from clan *grouping* in production for good reason — hundreds of
members, so grouping them would cause the stacking the balancer exists to prevent.
The separate question is whether NL should still be weighted above the sum of its
parts for *balance* purposes. The answer from this data is **no**.

NL headcount looks significant on its own (ΔlogLik 2.24, p = 0.034), and the raw
imbalance table looks alarming — when one side is 10+ NL ahead it wins 74.3% against
a 58.1% prediction. But the entire effect is the rating-confidence artefact:

- Under the controls, NL headcount contributes **exactly zero** (ΔlogLik 0.00, p = 1.000).
- Out of sample it makes the model **worse** (log-loss +0.0013).
- A hinge term testing the extreme tail specifically fails at every threshold
  (|diff| > 6, 8, 10, 12 → p = 0.380, 0.269, 0.384, 0.549).

The mechanism is straightforward: NL members are rated regulars, so a side stacked
with them is also a side whose opponents are disproportionately unrated transients
scored at exactly 25.0. Control for that and the coordination premium vanishes. NL
blocks of 13–16 do show +10.5, but at ±16.9 over 32 rounds, and the 17+ row is six
rounds and should be ignored entirely.

**A coordination offset applied to NL would be double-counting a rating artefact,
and would push teams apart rather than together.**

##### Checked again at squad granularity

The test above measures NL *headcount on the team*, which is the wrong unit for
the obvious objection: surely nine NL stacked in one squad are worth something?
For a six-person clan "on my team" and "in my squad" are the same thing — if
they are here at all they are together. For NL they diverge completely: twelve
on a team might be one 9-stack plus stragglers, or twelve people in eleven
different squads full of strangers. The team-level count averages over that.

Re-measured as clanmates sharing a squad:

| NL in same squad | rounds | actual | μ-predicted | gap | ±2SE |
|---|---|---|---|---|---|
| 2 | 283 | 47.5% | 50.2% | −2.8 | 5.9 |
| 3 | 180 | 53.3% | 50.8% | +2.5 | 7.4 |
| 4–5 | 166 | 51.3% | 49.5% | +1.8 | 7.8 |
| 6–7 | 104 | 62.4% | 53.4% | **+9.0** | 9.5 |
| 8+ | 31 | 58.5% | 54.5% | +4.0 | 17.7 |

There is a hint at 6–7, but +9.0 against ±9.5 sits exactly on the noise floor
and nothing downstream supports it:

| feature | raw p | under controls | CV Δ |
|---|---|---|---|
| squad-clan ≥4, NL only | 0.066 | **0.924** | **+0.0015** (worse) |
| largest NL squad-stack | 0.094 | **0.622** | **+0.0005** (worse) |
| squad-clan ≥4, no NL | <0.001 | **0.003** | **−0.0088** (better) |
| largest squad-stack, no NL | <0.001 | **0.007** | — |

So the division is not team-level vs squad-level — for non-house clans the two
views are near-identical measurements, as expected, and both survive. The
division is NL vs everyone else, and it holds under the sharper unit.

##### Why this is probably real, not an artefact of the test

Two mechanisms, the second more likely:

1. **NL is a community, not a team.** Hundreds of members at every skill level.
   Sharing the tag does not imply practising together, so a 9-stack is often
   nine regulars who happen to share a tag, where a 6-block of a 20-person clan
   is likely an organised group.

2. **NL's coordination is already priced into their μ.** Ratings are estimated
   from games on this server, and NL plays here constantly, usually together.
   Whatever their coordination is worth, the Elo model has been observing it for
   months and has folded it into individual ratings. An offset only earns its
   keep for value *not* captured in individual μ. A visiting clan that appears
   twice a week has its μ diluted across games where its members were scattered,
   so for them the "we are together tonight" premium is real and unpriced.

Mechanism 2 predicts the observed pattern exactly, and it generalises into a
better rule than the one currently proposed: **the offset should scale with how
rarely a group plays together, not with how large it is.** Testable against
`S3_PlayerSession` if the clan term ever ships.

*Design consequence:* the exemption is not "NL is the house clan". It is "NL's
coordination is already in their ratings". If another large clan starts playing
here nightly the same logic should exempt them automatically, which argues for
driving the exemption off games-played-together rather than off a hardcoded
`ignoreList`.

#### Out-of-sample validation

All ΔlogLik figures above are in-sample. Five-fold CV over contiguous (roughly
chronological) blocks, held-out log-loss, lower is better:

| model | logLoss | held-out acc | Δ vs control |
|---|---|---|---|
| intercept only | 0.6946 | 52.1% | |
| meanMuDiff | 0.6198 | 67.4% | |
| + rating-confidence controls | 0.5669 | 70.1% | — |
| **+ largest clan block (no NL)** | **0.5568** | **71.8%** | **−0.0101** |
| + clan-blocked ≥3 (no NL) | 0.5611 | 71.6% | −0.0057 |
| + mean squad size *(negative control)* | 0.5667 | 71.0% | −0.0002 |
| + NL headcount *(negative control)* | 0.5682 | 70.1% | +0.0013 |

Both negative controls behave as they should — squad size is noise, NL headcount is
actively harmful. The clan features generalise.

#### Effect size, in the units the scrambler uses

Converting the logistic coefficients to μ (ratio of raw weights; `meanMuDiff` is a
difference of means, so multiply by team size for total team strength):

| feature | μ of team mean, per unit | μ of team strength |
|---|---|---|
| largest clan block (no NL) | 0.208 | 10.2 |
| clan-blocked ≥3 (no NL) | 0.097 | 4.8 |
| players in squads ≥6 | 0.001 | 0.05 |
| NL headcount | 0.000 | 0.00 |

Roughly: **a non-house clan block is worth about 0.1 μ per member on the team mean
once it reaches 4**, and the largest single block on a team is worth about 0.2 μ per
additional member. For scale, the median |mean μ difference| the scrambler fights
over is **0.47**, and §2.1 showed it can already drive that to 0.09. A single
unbalanced 6-man clan block is therefore comparable in size to the entire quantity
the scrambler currently optimises.

#### Is there headroom? Yes, in about a quarter of rounds

An effect only matters if the quantity is actually imbalanced in play. Most rounds
are already fine — |clan-blocked diff| (no NL) has median 0.0, mean 2.1, p95 7.0,
max 17 — which is why this never showed up in aggregate. The damage is concentrated:

| imbalance | rounds | heavy-side win | μ-predicted | gap |
|---|---|---|---|---|
| even (0–1) | 248 | 46.0% | 47.7% | −1.7 |
| 2–3 ahead | 99 | 50.5% | 53.5% | −3.0 |
| **4–6 ahead** | 75 | **73.3%** | 56.0% | **+17.3** |
| **7+ ahead** | 29 | **82.8%** | 62.2% | **+20.5** |

**104 of 451 rounds (23%)** have a clan-block imbalance of 4+, and in those rounds
the clan-heavy side wins ~17–20 points more often than its rating says it should.
That is the headroom, and unlike the objective blend weights (§2.7) it is a
dimension currently sitting at exactly **zero** — the scrambler does not measure
this at all.

Note the ceiling, though: only **3.0%** of players are in a non-NL block of 3+
(5.3% in a block of 2+). This is a small population with a large per-capita effect,
not a broad one.

### Conclusions

1. **Direction 4 does not collapse into Direction 2 — it replaces it.** The
   mechanism is social (clan), not organisational (in-game squad). In-game squad
   size is dead across every test: calibration, nested LRT, and CV.
2. **`tb-scrambler.js` keeping squads atomic is correct but incidental.** It
   preserves cohesion for gameplay reasons; it buys nothing measurable in balance.
3. **The actionable change is a clan-block parity term**, not a squad one, applied
   to non-house clans only, with a threshold at 4 and roughly 0.1 μ/member.
4. ~~**A bigger and cheaper win may be the rating-confidence control itself.**~~
   **Retracted in §6.** Unrated share added ΔlogLik 23.45 here, and this section
   read that as a predictor. It is mostly an outcome — losing teams shed players and
   get backfilled with late joiners, so a high unrated share at *endgame* is largely
   a record of having already lost. On the round-start roster the same feature adds
   2.20. The scrambler still should not score an unrated player as exactly 25.0, but
   that is a small correction, not the headline, and it does **not** outrank the clan
   term. Everything above this point in §5 is measured on endgame rosters too and is
   re-tested in §6; the clan results survive and strengthen, the squad results stay
   dead, and only this item changes sign.

### Follow-on work this opens

- ~~**Direction 5, now confirmed and probably ahead of the clan term.**~~ **See §6 —
  this was mostly reverse causation.** What survives is narrow: σ is already recorded
  (`sigmaBefore`) and already carried in `Elo_RoundPlayers`, so a σ-aware estimate is
  available without new plumbing, and it is still wrong to score an unrated player as
  exactly average. But the effect is ΔlogLik 2.20 at round start, not 23.45, and the
  population it applies to is much smaller than it looked: at scramble time there are
  no late joiners at all. ~~**The σ-shrinkage question is open.**~~ **Closed — see §6a.**
- **Quantify in tickets.** Everything here is in win probability. §2.6 established
  that μ predicts direction well and magnitude badly, so the ticket-margin payoff of
  a clan term needs measuring separately before it justifies shipping. Still open —
  see §7's caveat.
- ~~**Replay it.**~~ **Done — see §7.** `clanBlockPenaltyEnabled` was added to
  `tb-scrambler.js` (off by default) and replayed against all 793 eligible real
  lobbies: zero-imbalance lobbies 47.5% → 58.0%, improves 96, worsens 2, for +0.01
  mean μ gap.
- **Watch the sample size.** 451 rounds, 3.0% of players in a qualifying block, and
  the 6–8 bucket rests on 35 rounds. The direction is consistent across calibration,
  LRT, CV, and two negative controls, but the magnitude is not yet pinned down.

---

## 6. Reverse-causation re-test — measuring structure before the outcome exists

`analysis/reverse-causation-check.js` · 431 paired rounds

### Why this section exists

Everything in §5 measures team features on the **ENDGAME** roster and uses them to
predict the round that roster just finished. That is backwards in principle, and it
turned out to be backwards in fact for one of the headline results.

The trigger was a check on what "unrated" actually means. The Elo tracker only rates
players who clear `minParticipationRatio: 0.15`, so "unrated" was being read as
"newcomer". Splitting unrated endgame players by whether Elo has *ever* scored them:

```
unrated player-observations: 2507
  known to Elo from other rounds (regulars who joined late):  2336   93.2%
  never rated in any round (genuine newcomers):                171    6.8%
```

93.2% are established players who joined late. And the losing side carries 1.216 more
of them (z = 8.71), with a clean dose-response against blowout size. That is the
signature of an outcome, not a cause.

### The fix: LIVE snapshots

`S3PlayerSnapshots` writes a **LIVE** row a median **3.0 minutes** after round start
(p95 3.0), median roster 96 against ENDGAME's 97. That is the post-scramble,
pre-outcome team — and it is also the only roster a scrambler change could ever act
on. 431 rounds have a LIVE roster, an ENDGAME roster, and a rated outcome, so every
comparison below is on the *same matches* and the only thing that varies is when the
measurement was taken.

Structure is already formed at 3 minutes, which is what makes the timing usable:

| roster | mean squad | unassigned | in squads ≥6 | mean largest clan block |
|---|---|---|---|---|
| LIVE | 7.21 | 8.9% | 72.3% | 2.15 |
| ENDGAME | 7.04 | 6.3% | 76.4% | 2.30 |

### Roster churn confirms the mechanism

| ticket margin | rounds | winner keeps | loser keeps | gap |
|---|---|---|---|---|
| 0–50 | 99 | 69.1% | 66.7% | 2.4pp |
| 50–100 | 102 | 73.2% | 67.6% | 5.6pp |
| 100–150 | 99 | 73.6% | 66.2% | 7.3pp |
| 150–250 | 107 | 79.1% | 65.4% | 13.6pp |
| 250+ | 24 | 83.3% | 66.6% | 16.7pp |

The loser's retention is flat at ~66% regardless of margin. The **winner's** rises
from 69% to 83%. Blowouts do not make losers quit faster than close games do — they
make winners *stay*. Either way the endgame rosters of the two teams are drawn from
different processes, which is exactly the condition under which endgame features
cannot be trusted as predictors.

### Feature by feature, round start vs round end

Added on top of mean-μ-diff **and** both rating-confidence controls, ΔlogLik:

| feature | LIVE | p | ENDGAME | p | verdict |
|---|---|---|---|---|---|
| clan-blocked ≥3, no NL | **11.26** | <0.001 | 3.48 | 0.008 | strengthens |
| largest clan block, no NL | **10.28** | <0.001 | 5.97 | <0.001 | strengthens |
| squad-clan ≥4, no NL | **8.97** | <0.001 | 3.93 | 0.005 | strengthens |
| μ concentrated in clan blocks | 3.55 | 0.008 | 5.10 | 0.001 | holds |
| clan-blocked ≥3 (all clans) | 2.89 | 0.016 | 1.80 | 0.057 | holds |
| players in squads ≥6 | 0.01 | 0.896 | 0.04 | 0.779 | dead at both |
| mean squad size | 0.26 | 0.470 | 0.47 | 0.333 | dead at both |
| NL headcount on team | 0.45 | 0.344 | 0.00 | 0.937 | dead at both |
| squad-clan ≥4, NL only | 0.02 | 0.847 | 0.01 | 0.883 | dead at both |
| largest NL squad-stack | 0.13 | 0.610 | 0.18 | 0.552 | dead at both |

And the control that started this, added to mean-μ-diff alone:

| feature | LIVE | p | ENDGAME | p |
|---|---|---|---|---|
| unrated share | 2.20 | 0.036 | **22.78** | <0.001 |
| mean sigma | 4.99 | 0.002 | 5.39 | 0.001 |

Loser-side unrated excess: **z = 2.90** at LIVE against **z = 8.66** at ENDGAME. At
round start, unrated players are 26.8% genuine newcomers; at round end, 6.8%.

### What this changes

1. **Direction 5 is retracted as a headline.** Roughly 90% of the unrated-share
   effect was the round's own outcome leaking backwards. A residual survives at
   p = 0.036 and it is still true that scoring an unrated player as exactly 25.0 is
   wrong, but it is a minor correction and it ranks below the clan term. The
   population is also smaller than it looked: **at scramble time there are no late
   joiners at all**, so the scrambler's unrated players are close to the genuine
   newcomers only.
2. **The clan finding is not damaged — it is reinforced.** Every non-house clan term
   gets *stronger* at round start, roughly doubling. Endgame churn was diluting it.
   This is the reassuring direction: a confound that manufactured the effect would
   have made it collapse.
3. **`unratedShare` should not have been a control.** Conditioning on a variable
   downstream of the outcome is over-control, and it was suppressing the clan
   coefficients in §5. Those numbers are therefore conservative, not inflated.
   `sigmaBefore` is fine — it is genuinely pre-round.
4. **In-game squad size is dead at both timings.** §5's conclusion 1 stands
   unchanged, now with a second independent measurement behind it.
5. **NL remains irrelevant at both timings**, including actual squad stacks. §5's
   answer to that question survives the re-test.

### Caveats

- The LIVE baseline is weaker (64.0% accuracy, logLik −280.7) than the ENDGAME
  baseline (67.3%, −265.1), because endgame μ is measured on the roster that actually
  finished. Part of the larger ΔlogLik at LIVE is therefore a lower bar. The
  qualitative flip — unrated share collapsing while clan terms grow — is not
  explainable that way, but the exact magnitudes should not be over-read.
- LIVE effect sizes come out large (largest clan block ≈ 21 μ of team strength per
  unit) and the clan features are strongly collinear with one another. Pick one for
  any scorer change; do not sum them.
- 431 rounds, and 169 matches were dropped for having no Elo round — the known
  2026-07-03..08 gap plus Elo's 80+ player RAAS filter, not a broken join.

---

## 6a. Is the unrated-share residual just σ in disguise?

`analysis/sigma-shrinkage-check.js` · 430 LIVE rounds

The residual from §6 (unrated share, ΔlogLik 2.20 at round start) was left open with
a specific question: `sigmaBefore` is already recorded, already pre-round-clean, and
is TrueSkill's own answer to "how much do I trust this rating" — so is unrated share
predicting anything sigma doesn't already capture, or was it riding on sigma the
whole time?

**Nested test, added to mean-μ-diff:**

| feature | ΔlogLik added alone | ΔlogLik added on top of the other |
|---|---|---|
| mean σ | 4.70 (p=0.002) | 3.65 (p=0.007) ← survives |
| unrated share | 2.18 (p=0.037) | 1.12 (p=0.134) — absorbed |

**Closed: unrated share adds nothing once mean σ is already in the model.** The
residual was σ wearing a binary disguise — a team with more unrated players has
higher mean σ almost by construction, and σ is the more informative version of the
same fact. Sigma survives the reverse check; unrated share does not. No separate
unrated-share correction is needed in the scorer.

**A secondary question, weaker evidence:** if σ matters, TrueSkill's own
conservative-estimate convention is `μ - k·σ`, not raw μ. Swept `k` against
out-of-sample win prediction (5-fold chronological CV, single feature = signed team
conservative-mean diff):

| k | CV logLoss | CV acc |
|---|---|---|
| 0 (raw μ, today) | 0.6582 | 62.6% |
| 1.0 | 0.6478 | 62.6% |
| 2.0 (best logLoss) | 0.6443 | 61.6% |
| 3.0 | 0.6448 | 62.3% |

logLoss improves mildly and roughly monotonically toward k≈2, but accuracy does not
move cleanly with it (61.6–63.5% across the whole sweep, no trend) — this is a soft,
noisy signal on 430 rounds, not the clean result the nested test above gave. **Not
recommended to act on without more data.** If revisited, the change would be a
one-line substitution (`μ - k·σ` in place of raw μ-mean in `scoreSwap()`, since σ is
already carried per player) — cheap to try, but the evidence here doesn't clear the
bar on its own.

---

## 7. Learned co-play affinity — groups the tag rules cannot see

`analysis/coplay-affinity.js` · 430 scoring rounds, 753 matches of history

### The idea

A clan tag is a *declared* group and a lossy proxy for the thing that matters: people
who have played together enough to have habits. It misses the regular who squads with
the same four people nightly under no tag, and over-counts the tag-wearer who happens
to be online but squads with strangers.

That underlying variable is observable. `S3PlayerSnapshots` records `squadID` per
player, so co-squad history can be accumulated and the question asked directly.

Worth being precise that this is **more than TrueSkill2 does**. Its squad offset
(`docs/trueskill2.pdf` §6) is a function of premade party *size* — a lobby-time fact
the matchmaker gets for free. It never learns who plays well with whom. That is only
available here because this server sees the same population repeatedly.

Every feature is built from **strictly prior** rounds: matches are walked in
chronological order, features computed, and only then is history updated. Structure
is read from LIVE snapshots, never ENDGAME (§6).

### It finds real groups

147,099 distinct co-squad pairs over 14,243 players. Top pairings are recognisable
recurring squads, and the connected-component pass at ≥15 shared rounds finds 7
groups of 3+, including a 7-player one that is exactly the "Slacker and his squad"
case that motivated the test.

**Of 81 players in recurring groups, 62 wear a clan tag — 23.5% do not.** Those are
groups no tag-based rule can see, and they are the reason to prefer a learned measure.

### Calibration: familiarity beats the rating

Win rate by strongest bond with a *current* squadmate, against what a μ-only model
predicts for their team:

| prior rounds w/ squadmate | players | actual | predicted | gap | ±2SE |
|---|---|---|---|---|---|
| 0 (all strangers) | 23091 | 48.5% | 49.5% | −1.0 | 4.8 |
| 1–2 | 10663 | 51.1% | 50.4% | +0.7 | 4.8 |
| 3–5 | 2753 | 50.4% | 50.6% | −0.2 | 5.0 |
| 6–10 | 1682 | 56.3% | 50.9% | **+5.4** | 5.1 |
| 11–20 | 1562 | 53.1% | 51.5% | +1.7 | 5.2 |
| 21–40 | 1090 | 56.0% | 51.7% | +4.2 | 5.9 |
| 41+ | 384 | 57.8% | 52.4% | +5.5 | 8.3 |

Strangers are calibrated; familiar players beat their rating. Same shape TrueSkill2
reports for premades, on a variable the paper never measures.

### But the clan tag is still the stronger feature

On top of μ + σ + mean experience (experience is essential — co-play is mechanically
bounded by playtime):

| feature | ΔlogLik | p | CV logLoss gain |
|---|---|---|---|
| clan-blocked ≥3, no house | **11.60** | <0.001 | **+0.0239** |
| largest clan block, no house | 10.57 | <0.001 | +0.0223 |
| players with 2+ known squadmates | 5.46 | <0.001 | +0.0124 |
| squad affinity, normalised | 5.11 | 0.001 | +0.0061 |
| strong pairs in squads (≥3) | 3.70 | 0.006 | +0.0095 |
| largest connected group in a squad | 1.65 | 0.069 | +0.0029 |
| team-wide affinity | 0.70 | 0.235 | −0.0061 |

Head to head: clan added on top of affinity **+7.52** (p<0.001); affinity added on top
of clan **+2.41** (p = 0.028). CV logLoss: control 0.6539 → affinity 0.6415 → clan
0.6316 → **both 0.6264**.

They are complementary, and clan wins. The likely reason is cold start: affinity is
built from 753 matches of history that begins empty, so early rounds contribute
almost no signal, while a tag is legible the moment a clan arrives. Affinity should
strengthen with more history; the tag will not.

### The exposure hypothesis is falsified

§4 direction 4 proposed that the offset should scale with how *rarely* a group plays
here, making the house exemption self-maintaining. Measured as a curve rather than a
median split (the median non-house tag appears 3 times, so the split was meaningless):

| tag exposure | tags | rounds w/ imbalance 2+ | ΔlogLik | p | CV gain |
|---|---|---|---|---|---|
| 1–5 rounds (one-off) | 31 | 36 | 3.21 → **0.94** | 0.171 | +0.0041 |
| 6–25 rounds (occasional) | 10 | 70 | **5.77** | <0.001 | +0.0126 |
| 26–100 rounds (regular) | 4 | 107 | 1.84 | 0.055 | +0.0012 |
| 101+ rounds | 0 | 0 | — | — | — |
| NL (house, 602 rounds) | 1 | 330 | 0.39 | 0.377 | −0.0035 |

Not monotone in rarity. The effect sits in the middle of the curve. The one-off band's
apparent result collapses once three clan-raid rounds are excluded (see below), so
what survives is a single band: **clans seen 6–25 times**.

**This also kills the low-variance explanation for the house clan.** NL has by far the
largest imbalances — mean |imbalance| 4.16, mean larger block 7.18, max 16, and 330 of
430 rounds carry an imbalance of 2+. There is ample power. NL blocks simply do not
predict. Why remains unexplained; the exemption stays empirical, not derived.

### Raid nights are out of scope, by policy

The one-off band is largely clan raid nights — `((DS))` fielding 26, `《GOL》` 19,
`『PHNTM』` 14. **The balancer is switched off by hand for these**, deliberately:
scrambling a visiting clan apart is worse than the resulting imbalance. So those
rounds record a policy decision, not a scrambler decision, and excluding them is
correct rather than merely conservative. Only 3 scoring rounds carry a non-house
block >10, and dropping them changes nothing else:

| feature | full (n=430) | excl. raids (n=427) |
|---|---|---|
| 1–5 rounds band | 3.21 (p 0.011) | **0.94 (p 0.171)** |
| 6–25 rounds band | 4.91 | 5.77 |
| largest clan block, no house | 10.57 | 8.01 |
| players with 2+ known squadmates | 5.46 | 5.37 |

Production runs `maxSize: 25`, not the 18 default, so a block of 25 is still held
whole by the hard constraint — only a 26+ turnout is released.

### It holds on the scrambler's own output

`TB_RoundReport.scrambled` marks the round that **triggered** a scramble, not the
round one produced — flagged rounds average 167.8 ticket margin against 108.8, the
"Single Round Margin" trigger averages 268.8, and the following round drops to 120.2.
Read the flag the naive way and the subset looks 87.6% predictable, which is just
blowouts being easy to call. The scrambler's output is the round *after* a flagged
one.

| feature | post-scramble (n=132) | organic (n=297) |
|---|---|---|
| clan-blocked ≥3, no house | **6.27** (p<0.001) | 6.09 (p<0.001) |
| largest clan block, no house | 3.78 (p 0.006) | 6.68 (p<0.001) |
| players with 2+ known squadmates | 3.13 (p 0.012) | 2.63 (p 0.022) |
| largest house block | 0.86 (p 0.190) | 0.00 (p 0.970) |

This is the result that makes the finding actionable. On teams **the scrambler itself
built**, having enforced clan cohesion as a hard constraint, the clan-heavy side still
beats its rating. The scrambler is paying the cohesion cost and not pricing the
strength it creates.

### What to build

1. **Price clan blocks in `scoreSwap()`.** `clan-blocked ≥3, no house` is the pick:
   best ΔlogLik, best CV gain, holds post-scramble. Effect size ≈ 13.9 μ of team
   strength per member, ~0.29 μ on the team mean. The features are strongly
   collinear — **pick one, do not sum them**.
2. **Do not replace the `ignoreList` with a rarity formula.** Falsified above.
3. **Consider affinity as a second term later**, not now. It adds +2.41 over clan and
   catches the 23.5% of recurring groups that wear no tag, but it needs a co-play
   table maintained in the DB and it has a cold-start problem. Revisit once there is
   more history.
4. **Raid nights need no change.** Turning the balancer off is already the right call
   and the data cannot say otherwise.

### Implemented and replayed (at the time — see 2026-08-21 correction below)

Item 1 is now real code: `clanBlockPenaltyEnabled` in `tb-scrambler.js`, **off by
default**, gated so production behaviour is byte-identical when unset (all 8 suites
in `team-balancer/testing/run-all-tests.js` pass unchanged). It converts the
clan-block headcount imbalance to an equivalent μ-of-team-mean diff using the 13.93
effect size above, and runs it through the same `getPenalty()` curve as the existing
μ term — no new scoring language, just a new input to the one that already exists.
`clanGroups` comes straight from `extractClanGroups()`, which already excludes the
house tag via `ignoreList`, so no tag logic was duplicated.

**2026-08-21 correction: this code is no longer in `tb-scrambler.js`, confirmed
both by inspection and by re-running the replay.** `git grep
clanBlockPenaltyEnabled team-balancer/utils/tb-scrambler.js` returns nothing —
only `clanGroups`-driven virtual-squad grouping (keeping a clan together as one
atomic unit while shuffling) remains; the scoring penalty described above was
never actually committed and is gone, the same failure mode as the
`eloSummary` regression documented in §10. Re-running `analysis/scramble-replay.js`
against the current code proves the flag is now a silent no-op: `clan-priced`
comes out statistically identical to `production` (zero-imbalance lobbies
47.3% vs 47.5%, improves 16/worsens 18 of 400 sampled lobbies — noise, not the
58.0%/"improves 96, worsens 2" result quoted below). Whoever wants to act on
this needs to re-implement `clanBlockPenaltyEnabled` from this description
first and re-run `scramble-replay.js` to confirm a real effect returns before
shipping — the table below is a target to reproduce, not a current result.

`analysis/scramble-replay.js` now replays it against all 793 eligible real lobbies,
with churn held identical to production (`clan-priced` config = production's floor
logic + the new term):

| | production | clan-priced |
|---|---|---|
| post-scramble clan-block imbalance, mean | 0.61 | **0.42** |
| lobbies with zero imbalance | 47.5% | **58.0%** |
| mu gap after scramble, mean | 0.09 | 0.10 |
| players moved, mean | 40.3 | 40.3 |

Lobby by lobby: **improves on 96, worsens on 2, unchanged on 695** (of 793). The 2
regressions are consistent with search noise (2000 random attempts per scramble) and
not a directional problem.

This is close to a free lunch: a 10-point swing in how often clan blocks come out
even, for +0.01 mean μ gap and +0.1 extra player moved on average. It has **not**
been enabled — `clanBlockPenaltyEnabled` defaults to `false` and needs a real
decision to flip, plus the ticket-margin caveat below.

### Caveats

- 430 scoring rounds; the 6–25 exposure band rests on 70 rounds with a real imbalance.
- Affinity history starts empty and covers 753 matches, so every affinity number here
  is attenuated by cold start and is a lower bound.
- Normalised affinity's effect size (926 μ) is a unit artifact — the feature is tiny
  in magnitude. Do not quote it.
- The replay numbers above are in μ and clan-block-imbalance units, **not tickets**.
  §2.6 already established that μ predicts win *direction* well but *margin* badly
  (r = 0.155) — that gap was checked directly for clan-block imbalance in
  `analysis/clan-block-margin.js` (430 LIVE-roster rounds, same pairing as §6):
  `r(clan-block imbalance, |ticket diff|) = 0.076`, and adding it to an OLS model on
  top of `|mu delta|` moves R² from 0.0245 to 0.0283 (ΔLRT χ²(1) = 1.66, p = 0.197) —
  **not distinguishable from noise**. The quartile table climbs (113 → 114 → 142 → 217
  mean ticket diff as imbalance goes 0→1→2→3) but the top band is 2 rounds; it is not
  a finding. **The replay's imbalance-count win (47.5%→58.0% zero-imbalance) cannot
  currently be translated into a ticket-margin claim** — there may be a real but
  small effect this sample can't resolve, or the effect may genuinely wash out once
  other factors (map, pop, admin activity) that move margin are accounted for. Either
  way, `clanBlockPenaltyEnabled` should stay off pending more data or a model that
  controls for those other margin drivers, not be turned on on the strength of §7 alone.

---

## 8. Script index

All repo-root only — `install.cjs` copies from the five plugin directories, so
nothing here is ever deployed.

| script | purpose |
|---|---|
| `analysis/load-export.js` | Shared loader, stats helpers, mode/population filters |
| `analysis/mu-predicts-margin.js` | Direction & magnitude of μ vs outcome (§2.6) |
| `analysis/elo-confidence.js` | σ distributions, lobby coverage, noise floor |
| `analysis/balancer-vs-elo-coverage.js` | What the balancer sees that Elo discards (§1, §2.10) |
| `analysis/churn-floor-threshold.js` | Where the hardcoded 0.4μ lands (§2.2) |
| `analysis/scramble-replay.js` | Offline replay through the real scrambler (§2.1); also replays `clanBlockPenaltyEnabled` (§7) and `stayerWeightingEnabled` (§4 direction 3, part 3) |
| `analysis/scramble-decay.js` | 0.09 → 0.25 decay, turnover, intervention rate (§2.3–2.5) |
| `analysis/smartassign-era.js` | Post-scramble churn, SA natural experiment (§2.4, §2.9) |
| `analysis/smartassign-failures.js` | Failure localisation by round phase (§2.8) |
| `analysis/objective-formulation.js` | mean vs top-15 blend sweep (§2.7) |
| `analysis/squad-coordination.js` | Squad vs clan coordination, TrueSkill2 replication, rating-confidence controls (§5, directions 2/4/5) |
| `analysis/reverse-causation-check.js` | Re-tests §5 on round-start rosters; retracts direction 5 (§6) |
| `analysis/sigma-shrinkage-check.js` | Nested test: is unrated share just σ in disguise? (§6a) — result: yes |
| `analysis/retention-predictors.js` | Does pre-round info predict mid-round leaving? (§4 direction 3, part 1) — result: yes |
| `analysis/stayer-weighted-balance.js` | Does stayer-weighted parity predict realized balance better than naive parity? (§4 direction 3, part 2) — result: yes, modestly |
| `analysis/coplay-affinity.js` | Learned co-play affinity vs clan tag; raid-night sensitivity; scrambled-flag fix (§7) |
| `analysis/clan-block-margin.js` | Does clan-block imbalance predict ticket margin, not just win direction (§7 caveats) — result: no |
| `analysis/ticket-margin-drivers.js` | Does population, round duration, or map identity explain ticket margin beyond mu (§4 direction 6) — result: no, 95%+ stays unexplained by anything pre-round |
| `analysis/predictive-trigger-simulate.js` | Simulates a predictive pre-round μ-gap trigger on real rounds (§4 direction 1) |
| `analysis/coplay-affinity.js` | Learned co-play groups vs clan tags, exposure curve, post-scramble subset (§7) |
| `analysis/reactive-threshold-sweep.js` | Would lowering the reactive Consecutive-Wins/Single-Round-Margin/Dominant-Win thresholds fire more often, and what would the real scrambler do to the newly-triggered rounds? (§10) |
| `analysis/elo-margin-weighting-test.js` | Does scaling Elo rating updates by each round's own ticket margin improve win prediction or ticket-margin predictability? (§4 direction 6 confirmation) — result: win-prediction yes (modestly), ticket-margin no |

Run with `node --max-old-space-size=4096` — the exports are ~200 MB.

### Related plugin changes made during this work

- `team-balancer/utils/tb-scramble-export.js` — `!teambalancer scrambles [N|all]`,
  gzipped NDJSON bundler (Discord 10 MB ceiling).
- `tb-scrambler.js` — per-attempt instrumentation (`attempts`, `bestAttemptIndex`,
  `eloSummary` with point-in-time ratings stamped, since `Elo_PlayerStats` mutates
  every round and is not reconstructible later).
- `test-scramble-instrumentation.js` — fixture built squads with `squadID` instead
  of `id`. The scrambler dedupes on `s.id`, so every squad collided on `undefined`
  and was rejected: the suite passed while only ever shuffling unassigned players.
  Fixed, plus a regression test.

---

## 9. Implementation checklist

Two directions cleared the bar for production (real, positive, measured effect on
μ-gap): **1** and **4**. Everything else is either already shipped-off-by-default
with no case to flip it (3), a reporting change (6), or informational (5, 2).
Ordered by expected value per §4's ranking.

### 1. Direct skill-gap scramble trigger (direction 1 — highest EV)

- [ ] Add a fourth trigger condition in `team-balancer/plugins/team-balancer.js`
      alongside the existing three (`Consecutive Wins`, `Single Round Margin`, `Win
      Streak Threshold` — around line 1800–2032), evaluated at the same point and
      in the same way those already are: fire when the team μ-gap itself
      (computed the same way `scoreSwap()` does) is **≥ 0.4μ**. Below 0.4μ, do not
      scramble on this condition — §2.5/`predictive-trigger-simulate.js` showed
      scrambling an already-close lobby makes the gap worse 18.6–24% of the time.
      This is not a new execution window; it's a fourth independent condition
      checked at the same point the other three already are.
- [ ] Reuse the existing `CHURN_FLOOR_MU`-equivalent constant rather than a new
      magic number — same 0.4 already validated for the reactive floor logic, so
      this is one threshold with two call sites, not two threshold decisions.
- [ ] Record the new trigger's `scrambleCondition` distinctly (e.g. `'Predictive
      Pre-Round Gap'`) so post-ship analysis can separate its rounds from the
      reactive triggers' — this is the only way to close the ticket-margin
      question below.
- [ ] Decide interaction with existing reactive triggers: does a predictive fire
      pre-empt a same-round reactive one, or can both apply? (They fire at
      different times in the round lifecycle, so likely no conflict, but confirm.)
- [ ] Ship behind a config flag, off by default, same pattern as
      `clanBlockPenaltyEnabled`/`stayerWeightingEnabled`.
- [ ] **Post-ship watch, not just offline validation** (this is the one thing
      simulation structurally cannot answer — §4 direction 1's ticket-margin
      column is a projection through a weak r=0.155 relationship, not a
      measurement): track mean/median ticket margin on predictive-triggered
      rounds vs. the historical baseline (§2.6: mean 113.3, sd 78.4) for a few
      weeks before calling it a win.

### 2. Clan-block penalty (direction 4 — second highest EV)

- [ ] **Correction (2026-08-21): `clanBlockPenaltyEnabled` no longer exists in
      `tb-scrambler.js` — re-implement it** per §7's description (converts
      clan-block headcount imbalance to an equivalent μ-of-team-mean diff via
      the 13.93 effect size, run through the existing `getPenalty()` curve).
      The 793-lobby replay result quoted below (zero-clan-block-imbalance
      lobbies 47.5%→58.0%, cost +0.01 mean μ gap, +0.1 players moved, worsens
      only 2 of 793 lobbies) is from a past session where the code did exist
      — treat it as a target to reproduce, not a guarantee, and re-run
      `scramble-replay.js` after rebuilding it.
- [ ] `clanGroups` already flows from `ClansService.extractClanGroups()` with
      the house tag excluded via `ignoreList`, same as production's existing
      clan logic — that part doesn't need rebuilding.
- [ ] **Post-ship watch**: same caveat as direction 1 — §7's caveats section
      found no significant ticket-margin effect for clan-block imbalance
      specifically (`clan-block-margin.js`: R² 0.0245→0.0283, p=0.197). Watch
      whether zero-imbalance rounds trend toward closer games in practice; don't
      assume it from the offline replay alone.
- [ ] Consider affinity as a second term later (§7 "What to build" item 3) — not
      now, needs a co-play table and has a cold-start problem.

### 3. Stayer-weighted balance (direction 3) — no action

- [x] Implemented (`stayerWeightingEnabled` in `tb-scrambler.js`) and replayed
      against all 793 lobbies. **Verdict: makes production worse** (mean μ gap
      0.09→0.11, production wins 344/626 decisive lobbies vs 282, p<0.05). Leave
      off. Nothing to do here except not re-litigate it without new evidence.

### 4. Rated-coverage parity (direction 5) — informational only

- [ ] No scorer change proposed — the retracted-then-shrunk effect (ΔlogLik
      22.78→2.20) ranks below the clan term and isn't worth its own scoring term
      on current evidence. Revisit only if direction 4 ships and coverage still
      looks like it's carrying signal on top of it.

### 5. Re-target the KPI (direction 6)

- [ ] Stop reporting/optimizing toward mean ticket margin as the primary balance
      KPI — §2.6 and `ticket-margin-drivers.js` (§4) together show 95%+ of its
      variance is set by in-round factors (individual play, momentum, admin
      calls) invisible to any pre-round signal. It is not a lever.
- [ ] Report win-rate parity instead (share of rounds within a "close" win-prob
      band, or the higher-μ-team win rate against the Q1–Q4 table in §2.6) as the
      headline balance metric going forward. This is the metric directions 1 and
      4 actually move.
- [ ] Optional, separate small bug: `TB_RoundReport.scrambleType` is NULL on all
      395 scrambled rounds recorded — the column records nothing. Worth a
      one-line fix whenever someone's in that code path; not blocking anything
      above.

---

## 10. Reactive threshold sweep — tech-chat proposal (Fiercer/Slacker)

Prompted by a tech-chat proposal to lower the REACTIVE trigger thresholds
(`minTicketsToCountAsDominantWin`, `singleRoundScrambleThreshold`,
`maxConsecutiveWinsWithoutThreshold`) rather than adding the predictive
pre-round trigger (direction 1). Fiercer's own objection is correct: a full
season can't be replayed under a different policy from history, since a
scramble that fires changes who's on the server for the next round's streak
counters. `analysis/reactive-threshold-sweep.js` answers the two things that
*can* be answered honestly instead: (1) a from-scratch port of the reactive
state machine, replayed chronologically over the real `(winner, margin)`
sequence — including non-RAAS rounds, since the real consecutive-win/win-streak
counters are fed by every non-ignored-mode round, not just RAAS — giving how
much more often each config would have fired; (2) for only the newly-triggered
rounds, the real `Scrambler` run against the real historical ENDGAME roster.

Validation: the ported state machine reproduces 262 of the real 288 RAAS
scrambled-round total under production's own thresholds (91%, within the 10%
tolerance) — condition-by-condition it skews slightly toward Single Round
Margin (161 sim vs 141 recorded) and under toward Consecutive Wins (96 vs 138),
most plausibly because production doesn't reset the streak counters until the
scramble actually *executes* (`resetStreak()` fires from "Post-scramble
cleanup", not the instant a trigger condition is met), which this replay
approximates as instantaneous. Good enough to trust the totals and the
marginal-round set, not exact enough to trust the condition breakdown to the
round.

**Two candidate configs swept:**

| config | total fires | new rounds vs the simulated production baseline (262) |
|---|---|---|
| A: dominant 150→100, single-round 200→150 | 403 (36.2% of RAAS rounds) | +164 |
| B: dominant gate removed, single-round 200→150, consecutive 3→2 | 521 (46.8%) | +317 |

On just the newly-triggered rounds, replayed through the real `Scrambler`
against their actual ENDGAME rosters (85/164 and 154/317 had a usable
snapshot — coverage starts 2026-07-02, so earlier rounds can't be replayed):

| config | pre-scramble mean μ gap | post-scramble mean μ gap | mean players moved |
|---|---|---|---|
| A | 0.97 | 0.06 | 35.0 |
| B | 0.89 | 0.07 | 35.9 |

Both configs would meaningfully **raise the scramble rate** (from today's 26%
of RAAS rounds to 36–47% — roughly 1.4–1.8x, not the "triple" this doc
originally and incorrectly claimed) and the scrambler does close the gap hard
on the newly-caught
rounds. But this is exactly the same lever as direction 1 (predictive pre-round
trigger, §9 item 1) — already validated earlier in this investigation with a
cleaner mechanism, and for a good structural reason Fiercer's own objection
points at: a reactive threshold can only fire *after* a round has already gone
lopsided, so lowering it trades "wait for a worse stomp" for "wait for a
smaller stomp" — it never prevents the bad round from happening, it only
reduces the pain reactively. The predictive trigger fires on the pre-round
gap before either team has played a hand, so it doesn't require a bad result
to already exist. Recommendation: don't tune these reactive thresholds — ship
direction 1 instead, which structurally subsumes what this proposal is trying
to do.

**Regression found in the process, unrelated to the sweep itself — now fixed.**
This replay (and independently, `scramble-replay.js`) both call
`Scrambler.scrambleTeamsPreservingSquads(...).eloSummary` — that property had
never actually been committed to `team-balancer/utils/tb-scrambler.js` on
*any* branch (`git log -S"eloSummary" --all` across the whole repo comes up
empty), despite §8's "related plugin changes" entry documenting it as added —
it was written in a past session's working tree and lost before ever being
committed, the same failure mode as the previously-known-lost
`clanBlockPenaltyEnabled`/`stayerWeightingEnabled` features. Re-implemented
fresh on the current `tb-scrambler.js` (which already correctly had both
master's virtual-squad features and this branch's elo-tuning calibration —
nothing else was actually lost in the merge). `reactive-threshold-sweep.js`
still computes the gap from the plan's own move list rather than relying on
it, but `scramble-replay.js` now gets real, non-NaN `eloSummary` output again
(re-validated by running it after the fix).
