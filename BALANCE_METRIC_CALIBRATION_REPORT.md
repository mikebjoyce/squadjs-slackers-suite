# Scrambler ELO Weight Calibration Report

**Date:** 2026-08-05  
**Tool:** `team-balancer/tools/calibrate-elo-weights.js` (v2.2)  
**Data:** 1,192 historical rounds (joined from `elo-match-log (7).jsonl` + `team-balancer-reports (6).jsonl`)

## Process

1. Built a calibration tool that replays the scrambler's `eloBalancePenalty` formula against historical match data
2. Joined match log entries (per-player `muBefore` ratings) to round reports (ticket margins) by timestamp proximity
3. Grid-searched 5,346 parameter combinations across four dimensions:
   - `meanWeight` / `top15Weight` blend ratio (0.1–0.9)
   - Cross-advantage max reduction (0.00–0.50)
   - Significance threshold (0.05–0.30)
   - Veteran penalty weight (100–500)
4. Scored each combination by Spearman rank correlation between computed penalty and actual ticket margin
5. **v2.1:** Added out-of-sample validation (5-fold CV + chronological 70/30 split) and univariate predictiveness analysis
6. **v2.2:** Added `--rating-source=backup` mode (uses ELO backup's final trained μ instead of per-round μBefore), plus landscape analysis: plateau size, response surface slices, parameter robustness ranges, multi-modality clustering, and ρ distribution histogram

## Rating Source Comparison

| Metric | matchlog (μBefore) | backup (trained μ) | Δ |
|---|---|---|---|
| Default ρ | 0.0857 | 0.1315 | +53% |
| Best in-sample ρ | 0.1070 | 0.1373 | +28% |
| ρ(meanDiff, margin) | 0.0835 | 0.1221 | +46% |
| ρ(top15Diff, margin) | 0.0609 | 0.1123 | +84% |
| Predictiveness ratio | 1.37× | 1.09× | collapsed |
| Best meanWeight | 0.9 | 0.8 | shifted |
| CV mean held-out ρ | 0.1016 | 0.1272 | +25% |
| Chrono held-out ρ | 0.1005 | 0.0837 | −17% |

**Key insight:** The backup's final trained μ is a substantially stronger predictor of ticket margin than point-in-time μBefore — univariate correlations nearly doubled. However, this comes with look-ahead bias: the backup-mode weights do not generalize out-of-sample (CV held-out ρ 0.1272 < default in-sample ρ 0.1315; chrono held-out ρ 0.0837 < default 0.1315). The tool's own auto-verdict correctly gates this: "⚠ Defaults already optimal or near-optimal. No changes recommended."

**Matchlog mode** (μBefore — what the scrambler actually sees at decision time) is the only mode whose calibrated weights pass both validation gates (CV: 0.1016 > 0.0857 ✓; chrono: 0.1005 > 0.0857 ✓) with 4/5 fold consensus on meanWeight=0.9. **Backup mode is retained as a diagnostic ceiling** — it confirms crossAdvantageMaxReduction=0 and vetW=500 are robust across both sources, but its blend weights should not drive production parameter selection.

With trained ratings, meanDiff and top15Diff are nearly equally predictive (ratio 1.09× vs 1.37×), which shifts the preferred blend from 0.9/0.1 toward 0.8/0.2 — but this shift reflects the changed noise characteristics of the input data, not a more accurate blend for production use.

## In-Sample Findings (Backup Ratings)

| Parameter | Before | After | Notes |
|---|---|---|---|
| `meanWeight` | 0.6 | **0.8** | Grid-search prefers 0.8 with trained ratings (backup mode only; matchlog mode prefers 0.9 — see Recommendation) |
| `top15Weight` | 0.4 | **0.2** | Derived (1.0 − meanWeight); matchlog mode: 0.1 |
| Cross-advantage bonus | 0.30 max | **Removed** | Every positive reduction *lowered* correlation |
| `veteranPenaltyWeight` | 300 | **500** | Veteran imbalance matters more than previously weighted |

**In-sample correlation:** ρ = 0.1315 → 0.1373 (+4.4% relative improvement)

The top 6 parameter sets all had `crossAdvantageMaxReduction=0.00` with `meanWeight=0.8` and `vetW=500`. Since `crossAdvantageMaxReduction=0`, the `significanceThreshold` parameter has zero effect on the formula (it multiplies a term that's already zeroed), so those 6 rows represent one effective configuration duplicated across an inert parameter. Ranks 7–15 are the same config with `meanWeight=0.7`, which achieves ρ=0.1370 — only 0.0003 below the best.

### Top 20 In-Sample Configurations

| Rank | MeanW | Top15W | CrossRed | SigThr | VetW | ρ |
|---|---|---|---|---|---|---|
| 1–6 | 0.8 | 0.2 | 0.00 | 0.05–0.30 | 500 | 0.1373 |
| 7–9 | 0.8 | 0.2 | 0.05 | 0.20–0.30 | 500 | 0.1370 |
| 10–15 | 0.7 | 0.3 | 0.00 | 0.05–0.30 | 500 | 0.1370 |
| 16–18 | 0.8 | 0.2 | 0.05 | 0.05–0.15 | 500 | 0.1369 |
| 19–20 | 0.7 | 0.3 | 0.00 | 0.05–0.10 | 450 | 0.1368 |

**Spread across top 20: 0.0005.** The "best" configuration is nearly indistinguishable from 19 others.

## Out-of-Sample Validation

### 5-Fold Cross-Validation

| Fold | Train ρ | Held-out ρ | Best meanW | Best crossRed | Best vetW |
|---|---|---|---|---|---|
| 1 | 0.1046 | 0.2720 | 0.8 | 0.00 | 500 |
| 2 | 0.1663 | 0.0117 | 0.9 | 0.00 | 500 |
| 3 | 0.1527 | 0.0699 | 0.6 | 0.00 | 500 |
| 4 | 0.1423 | 0.1121 | 0.7 | 0.00 | 300 |
| 5 | 0.1274 | 0.1702 | 0.9 | 0.20 | 500 |

- **Mean held-out ρ:** 0.1272
- **Stdev held-out ρ:** 0.0996
- **Param consensus:** None — all 5 folds chose different configurations. No single param set won more than 1/5 folds.

The held-out ρ stdev (0.0996) is enormous relative to the mean (0.1272). The optimum is extremely poorly identified — consistent with collinear predictors and a flat search surface.

### Chronological 70/30 Split

- Train: 834 rounds (earliest 70%), Test: 358 rounds (most recent 30%)
- In-sample best ρ: 0.1538
- **Held-out test ρ: 0.0837**
- Best params: meanW=0.9, crossRed=0.00, vetW=500

The calibrated weights do NOT generalize to future data in backup mode — look-ahead bias is real. (In matchlog mode, held-out ρ was 0.1005 > default 0.0857, so the effect direction was still positive there.)

## Univariate Predictiveness

| Metric | matchlog | backup |
|---|---|---|
| ρ(meanDiff, ticketMargin) | 0.0835 | 0.1221 |
| ρ(top15Diff, ticketMargin) | 0.0609 | 0.1123 |
| Predictiveness ratio | 1.37× | 1.09× |
| Collinearity ρ(mean, top15) | 0.59 | 0.60 |
| Noise floor SE(ρ) ≈ | 0.029 | 0.029 |

With trained ratings, the two metrics are nearly equally informative. The old 1.37× ratio was partly an artifact of μBefore noise affecting top15 more than mean (top15 is more sensitive to individual rating errors). The 0.9/0.1 composite-weight ratio from the original calibration was a blend tuning, not a predictiveness measure — and with cleaner ratings, even the blend tuning prefers 0.8/0.2.

## Landscape Analysis

### Plateau Size

Configurations within ε of the best ρ (0.1373):

| ε | Count | % of grid |
|---|---|---|
| 0.0005 | 24 | 0.4% |
| 0.0010 | 79 | 1.5% |
| 0.0020 | 313 | 5.9% |
| 0.0050 | 1,541 | 28.8% |
| 0.0100 | 3,160 | 59.1% |

**1,541 configurations (28.8% of the entire grid) achieve ρ within 0.005 of the best.** Over half the grid (59.1%) is within 0.01. The "optimum" is not a peak — it's a vast, flat mesa.

### Response Surface Slices

Fixing three parameters at their best values and sweeping the fourth:

**meanWeight (crossRed=0.00, sigThr=0.05, vetW=500):**
```
0.1    0.1234 █
0.2    0.1258 ███████
0.3    0.1283 ██████████████
0.4    0.1304 ████████████████████
0.5    0.1326 ███████████████████████████
0.6    0.1350 █████████████████████████████████
0.7    0.1370 ███████████████████████████████████████
0.8    0.1373 ████████████████████████████████████████ ← max
0.9    0.1364 █████████████████████████████████████
```
Smooth, monotonic increase peaking at 0.8 with a slight dip at 0.9. No local minima. The 0.8/0.2 blend is clearly best but 0.7/0.3 is nearly indistinguishable.

**crossAdvantageMaxReduction (meanW=0.8, sigThr=0.05, vetW=500):**
```
0.00   0.1373 ████████████████████████████████████████ ← max
0.05   0.1369 ███████████████████████████████████
0.10   0.1367 ███████████████████████████████
0.15   0.1365 █████████████████████████████
0.20   0.1363 █████████████████████████
0.25   0.1360 ██████████████████████
0.30   0.1355 ███████████████
0.35   0.1353 ███████████
0.40   0.1349 ██████
0.45   0.1347 ███
0.50   0.1345 █
```
Strictly monotonic decreasing. **Zero is unambiguously best.** Every positive cross-advantage reduction lowers ρ. This finding is robust across both rating sources and all validation methods.

**significanceThreshold (meanW=0.8, crossRed=0.00, vetW=500):**
```
0.05   0.1373 ████████████████████████████████████████ ← max
0.10   0.1373 ████████████████████████████████████████ ← max
0.15   0.1373 ████████████████████████████████████████ ← max
0.20   0.1373 ████████████████████████████████████████ ← max
0.25   0.1373 ████████████████████████████████████████ ← max
0.30   0.1373 ████████████████████████████████████████ ← max
```
**Completely flat.** Every value produces identical ρ. This parameter is 100% inert when `crossAdvantageMaxReduction=0.00` because it only controls whether the cross-advantage reduction activates — and with the reduction removed, the threshold multiplies zero.

**veteranPenaltyWeight (meanW=0.8, crossRed=0.00, sigThr=0.05):**
```
100     0.1312 █
150     0.1323 ███████
200     0.1335 ███████████████
250     0.1344 █████████████████████
300     0.1352 ██████████████████████████
350     0.1358 ██████████████████████████████
400     0.1363 █████████████████████████████████
450     0.1367 ████████████████████████████████████
500     0.1373 ████████████████████████████████████████ ← max
```
Smooth, monotonic increase. Every step up in vetW improves ρ. The grid search hits the ceiling at 500 — the true optimum may be higher, or the relationship may plateau beyond 500.

### Parameter Robustness

Values that keep max achievable ρ within 1% and 0.5% of the best (0.1373):

| Parameter | Threshold | Viable values | Range |
|---|---|---|---|
| meanWeight | 1.0% | 3 of 9 | 0.7–0.9 |
| meanWeight | 0.5% | 2 of 9 | 0.7–0.8 |
| crossAdvantageMaxReduction | 1.0% | 6 of 11 | 0.00–0.25 |
| crossAdvantageMaxReduction | 0.5% | 3 of 11 | 0.00–0.10 |
| significanceThreshold | 1.0% | 6 of 6 | 0.05–0.30 |
| significanceThreshold | 0.5% | 6 of 6 | 0.05–0.30 |
| veteranPenaltyWeight | 1.0% | 3 of 9 | 400–500 |
| veteranPenaltyWeight | 0.5% | 2 of 9 | 450–500 |

**significanceThreshold is completely unconstrained** — all 6 values are viable at both thresholds because the parameter is inert when crossRed=0. **crossRed is the most forgiving** (0.00–0.25 at 1%), meaning you can leave some cross-advantage reduction in without meaningful harm. **meanWeight and vetW are the tightest** — only 2 of 9 values survive the 0.5% threshold.

### Multi-Modality Check

Clustering the top 54 configurations (~1% of grid) by normalized Euclidean distance in parameter space:

- **Clusters found: 1**
- **Multi-modal: NO**

The top 1% of configs form a single contiguous cluster. There are no distinct "strategies" or alternative parameter regimes that achieve comparable ρ. The landscape has one broad plateau, not multiple peaks.

### ρ Distribution

```
Range: [0.1173, 0.1373]  Span: 0.0200
0.1173–0.1183    64 █
0.1183–0.1193    66 █
0.1193–0.1203   132 ██
0.1203–0.1213   148 ███
0.1213–0.1223   281 █████
0.1223–0.1233   350 ███████
0.1233–0.1243   295 ██████
0.1243–0.1253   266 █████
0.1253–0.1263   282 █████
0.1263–0.1273   304 ██████
0.1273–0.1283   319 ██████
0.1283–0.1293   294 █████
0.1293–0.1303   322 ██████
0.1303–0.1313   344 ██████
0.1313–0.1323   338 ██████
0.1323–0.1333   396 ███████
0.1333–0.1343   445 ████████
0.1343–0.1353   387 ███████
0.1353–0.1363   234 ████
0.1363–0.1373    79 █
```

Roughly bell-shaped, slightly right-skewed, spanning only 0.02 ρ units. The narrow range confirms that parameter choice has limited impact — even the worst configuration is only 0.02 below the best. The distribution is unimodal with no evidence of multiple populations.

## Interpretation

1. **The trained-μ signal is real and substantially stronger.** Switching from μBefore to backup μ nearly doubled the univariate correlations (0.0835→0.1221 for meanDiff, 0.0609→0.1123 for top15Diff). The backup's final trained rating filters out per-round noise. However, this comes with look-ahead bias — the chronological holdout suggests the signal doesn't fully generalize forward in time.

2. **The blend optimum depends on rating source.** With backup ratings (cleaner signal), meanDiff and top15Diff are nearly equally predictive (ratio 1.09×), so the grid search prefers 0.8/0.2. With matchlog ratings (μBefore — what the scrambler actually sees at decision time), top15Diff is noisier (ratio 1.37×) and the grid search prefers 0.9/0.1. The matchlog-mode weights are the ones that generalize out-of-sample (CV held-out ρ 0.1016 > default 0.0857; chrono held-out ρ 0.1005 > default 0.0857) and are the recommended production values. Backup mode serves as a diagnostic ceiling — it confirms crossAdvantageMaxReduction=0 and vetW=500 are robust, but its blend weights don't generalize (CV held-out ρ 0.1272 < default 0.1315; chrono held-out ρ 0.0837 < default 0.1315) and the tool's own auto-verdict gates this correctly ("⚠ Defaults already optimal or near-optimal. No changes recommended.").

3. **The fitness landscape is a vast, flat mesa, not a peak.** 28.8% of all configurations achieve ρ within 0.005 of the best. 59.1% are within 0.01. The response surface slices show smooth, monotonic trends with no local minima, no multi-modality, and one completely inert parameter (significanceThreshold when crossRed=0). There is no "optimum" to discover — there is a broad region of near-equivalent configurations.

4. **The cross-advantage bonus was empirically rejected.** Every positive reduction lowered correlation. This finding is robust across both rating sources, all validation methods, and the full response surface. The cross-advantage code path in `tb-scrambler.js` should be removed or gated behind a config flag set to off.

5. **Veteran penalty wants to be as high as possible.** The grid search hits the ceiling at 500 — the true optimum may be higher. Every step up in vetW improved ρ monotonically.

6. **CV fold agreement collapsed with backup ratings.** In matchlog mode, 4/5 folds agreed on mw=0.9. In backup mode, all 5 folds chose different configurations. The larger signal from trained ratings actually makes the optimum *harder* to identify because the plateau is even flatter relative to the noise.

7. **Overall predictive power remains weak.** Even the "improved" formula only reaches ρ² ≈ 1–2% of rank-variance explained. ELO diff is a weak predictor of ticket margin overall, tuned or not. Don't expect parameter changes to meaningfully move real balance outcomes.

## Recommendation

**Use meanWeight=0.9, crossAdvantageMaxReduction=0.00, veteranPenaltyWeight=500.** The `significanceThreshold` is irrelevant when crossRed=0.00 and can be left at any value.

These are the matchlog-mode weights — the only mode whose calibrated weights pass both validation gates (CV held-out ρ 0.1016 > default 0.0857; chrono held-out ρ 0.1005 > default 0.0857) with 4/5 fold consensus. The backup mode (final trained μ) was consulted as a diagnostic ceiling and confirms crossAdvantageMaxReduction=0 and vetW=500 are robust across both rating sources, but its blend weights (0.8/0.2) do not generalize out-of-sample and fail the tool's own auto-verdict ("⚠ Defaults already optimal or near-optimal. No changes recommended."). Backup mode should be treated as answering "how predictable is margin with perfect information," not "what weights should the scrambler use in production."

These settings represent a point on the broad plateau — they are slightly better than the old defaults (0.6/0.4, crossRed=0.30, vetW=300) but the improvement is small (ρ +0.0213 in-sample for matchlog mode). The key actionable finding is removing the cross-advantage bonus, which is unambiguously harmful.

**Treat the calibrated weights as "demonstrably not worse than defaults," not as a precisely calibrated optimum.** The landscape analysis confirms there is no meaningful optimum to find.

## Files Changed

- `team-balancer/utils/tb-scrambler.js` — Three numeric constants in `scoreSwap()` ELO scoring
- `team-balancer/tools/calibrate-elo-weights.js` — v2.2: added `--rating-source=backup` flag, plateau analysis, response surface slices, parameter robustness ranges, multi-modality clustering, ρ distribution histogram
- `smart-assign/utils/sa-team-evaluator.js` — `computeScore()` and inline `getScore()` weights cohered with TeamBalancer
- `smart-assign/plugins/smart-assign.js` — Header comment updated

## Future Work

- **Test vetW values above 500.** The grid search hit the ceiling — the true optimum may be at 600, 800, or higher.
- **Rolling-origin backtest.** Train on rounds up to time T, test on the next block, repeat. This would provide the most realistic estimate of generalization performance and properly penalize look-ahead bias.
- **Explore non-linear ELO diff transformations.** The current formula uses a piecewise-linear penalty on composite diff. Alternative transformations (log, square root, squared) might extract more signal from the weak predictor.