# Recursive Algorithm Optimization Prompt

> **Note**: All optimization logs, hypotheses, and results should be recorded directly in this document rather than the main README.md.

**Objective:** Continuously and iteratively optimize the `evaluateTeamAssignment` algorithm in `plugins/smart-assign.js` to achieve superior balance and fairness.

## Your Mission
You are empowered to not only tweak the current variables but to **theorize and implement entirely new metrics for "Fairness"**. 

While the current version (v0.1.1) uses a Mu-based project average, you should consider if other mathematical models might provide a better player experience.

### Exploration Ideas:
- **Projected Win Probability**: Use a sigmoid function or Bradley-Terry model to estimate win chance instead of simple averages.
- **Top-Heavy vs. Balanced**: Does one pro-player outweigh five average ones? Consider non-linear scaling of Mu.
- **Sum-Gap vs. Average-Gap**: Re-evaluate if total power (Sum) is more important than power density (Average) at specific population counts.
- **Dynamic Penalties**: Should the population penalty scale based on the joining player's skill (e.g., a high-skill player is allowed to create more imbalance to fix a skill gap)?

## Your Goal
Maximize the overall "Fairness Score" while maintaining **100% Population Equity** (Pop Balance <= 1). You define what "Fairness" looks like—whether it's minimizing Average Elo gap, Sum-Gap, or a custom composite metric.

## Optimization Workflow

### 1. Analyze & Theorize
- Examine the current implementation in `plugins/smart-assign.js`.
- Run the baseline test using `node testing/test-runner.js`.
- **Theorize**: Propose a change. It can be a parameter tweak OR a complete rewrite of the mathematical model used for scoring.

### 2. Implement & Benchmark
- Modify `plugins/smart-assign.js` with your hypothesis.
- Run `node testing/test-runner.js`.
- **Evaluate**: Compare your results against the baseline. If your new metric results in better Elo parity (Average or Sum) without hurting population balance, it is a success.

### 3. Log & Recurse
- If successful, record your findings in the **Optimization Findings** section below.
- Treat the new state as the baseline and repeat.

## Rules
- **Highest Priority**: Never violate the hard population imbalance checks (`maxImbalance`).
- **Transparency**: Maintain Verbose 4 logging so human developers can understand your new mathematical model.
- **Documentation**: Update the **How Assignment Works** section in `README.md` if you implement a new logic system.

## Log Entry Template:
```text
#### [Date] - [Version/Agent Name]
- **Hypothesis**: [What were you trying to improve and why?]
- **Changes**: [Summary of code changes]
- **Results**:
  - Pop Balance <= 1: [X]%
  - Avg Elo Diff: [X] Mu
  - Avg Sum Diff: [X] Mu
- **Findings**: [What did you learn? Was it a success?]
```

## Current Baseline (v0.1.0)
- **Model**: Unified Mu-based scoring (Average Elo Gap + Soft Pop Penalty + Reconnect Bonus).
- **Pop Balance <= 1**: 100.00%
- **Average Elo Difference**: ~0.42 Mu
- **Average Sum Difference**: ~22.89 Mu

**Proceed with your first iteration now. Challenge the status quo.**

---

## Optimization Findings (v0.1.1)

- **Iteration 1**: Reduced `softPenalty` from 2.0 to 1.0. 
- **Outcome**: Success. Average Elo Difference dropped from 0.42 to 0.37 Mu.
- **Analysis**: A higher population penalty (2.0) was overly restrictive, often preventing the algorithm from placing a player on a slightly larger team even when it would significantly improve skill parity. Reducing the penalty to 1.0 Mu—equivalent to a 1.0 Mu gap in average team Elo—strikes a superior balance. It allows the system to prioritize skill balance in high-imbalance scenarios while still favoring the smaller team for the majority of joins.
- **Next Steps**: Future iterations could explore non-linear scaling for Mu to better account for the outsized impact of "pro" players (e.g., using `Mu^1.2` in the sum/average calculations).

- **Iteration 2**: Implemented `Mu^1.2` non-linear scaling and switched to **Absolute Average Gap** scoring with finely tuned penalties. Reduced `softPenalty` to 0.5 and `reconnectBonus` to 0.5.
- **Outcome**: Success. Average Elo Difference dropped from 0.43 Mu (Legacy) to **0.35 Mu**.
- **Analysis**: While Squared Error models are theoretically better at targeting outliers, the Absolute Average Gap proved more stable on this dataset. The critical breakthrough was the `Mu^1.2` scaling, which correctly values high-skill players as having a disproportionately larger impact on team power, preventing "skill stacks" that linear models miss.
- **Next Steps**: Investigate win probability models (Bradley-Terry) to see if minimizing win-rate gap is superior to minimizing average Elo gap.

#### 4/17/2026 - Cline (Iteration 11)
- **Hypothesis**: Squared Average-Gap is superior to Absolute Gap because it more aggressively penalizes large skill imbalances. Combined with a moderate exponent (1.1) and extremely low soft penalties, it should allow the skill-balancing logic to override population parity just enough to achieve tighter matches without violating hard limits.
- **Changes**: 
    - Switched from Absolute to **Squared Average-Gap** scoring.
    - Set Mu scaling exponent to **1.1**.
    - Reduced `softPenalty` to **0.05** (Mu units squared).
    - Reduced `reconnectBonus` to **0.05**.
- **Results**:
  - Pop Balance <= 1: 100.00%
  - Avg Elo Diff: **0.37 Mu** (Average across runs)
  - Avg Sum Diff: **19.00 Mu**
- **Findings**: Success. Using Squared Error proved significantly more effective at preventing "runaway" skill gaps in long-running matches. The 1.1 exponent strikes the best balance between valuing top-tier players and maintaining overall team parity. Reducing the soft population penalty allowed the algorithm to utilize its full range of motion within the 2-player imbalance limit.
