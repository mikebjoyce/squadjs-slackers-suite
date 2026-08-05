/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║            SCRAMBLER ELO WEIGHT CALIBRATOR                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Grid-searches the scrambler's ELO scoring parameters against
 * historical match data to find weights that best predict game
 * closeness (ticket margin). Replays the exact eloBalancePenalty
 * formula from tb-scrambler.js scoreSwap() against each historical
 * round and measures Spearman rank correlation with actual margins.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node team-balancer/tools/calibrate-elo-weights.js
 *
 * Requires these files in CWD (hardcoded for this calibration run):
 *   - elo-backup-2026-08-05T04-25-23-184Z.json
 *   - elo-match-log (7).jsonl
 *   - team-balancer-reports (6).jsonl
 *
 * ─── PARAMETERS SEARCHED ─────────────────────────────────────────
 *
 *   meanWeight           — weight of mean ELO diff in compositeDiff
 *   top15Weight          — derived: 1.0 - meanWeight
 *   crossAdvantageMaxRed — max reduction when advantages split
 *   significanceThreshold — min μ diff to consider meaningful
 *   veteranPenaltyWeight — multiplier for veteran imbalance penalty
 *
 * ─── METRIC ──────────────────────────────────────────────────────
 *
 *   Spearman rank correlation between computed eloBalancePenalty
 *   and actual ticketMargin. Higher = better predictive power.
 *
 * ─── VALIDATION METHODOLOGY ──────────────────────────────────────
 *
 *   v2.1 — Added out-of-sample validation to address overfitting
 *   concerns with the original in-sample-only grid search:
 *
 *   1. k-fold cross-validation (5-fold): grid-search on 4 folds,
 *      evaluate best params on held-out fold. Reports mean held-out
 *      ρ and fold-to-fold param stability.
 *   2. Chronological 70/30 split: train on earlier 70% of rounds,
 *      test on most recent 30%. Tests temporal generalization.
 *   3. Univariate correlations: raw ρ(meanDiff, ticketMargin) and
 *      ρ(top15Diff, ticketMargin) — direct predictiveness measures
 *      that replace the old "~9× more predictive" overclaim with
 *      measured ratios.
 *
 * ═══════════════════════════════════════════════════════════════
 */

import { readFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';

// ─── CLI flags ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const RATING_SOURCE = args.includes('--rating-source=backup') ? 'backup' : 'matchlog';
// 'matchlog' = prefer muBefore from match log, fall back to backup (current behavior)
// 'backup'   = use backup mu exclusively (final trained rating for all rounds)

// ─── File paths ──────────────────────────────────────────────────
const ELO_BACKUP   = 'elo-backup-2026-08-05T04-25-23-184Z.json';
const MATCH_LOG    = 'elo-match-log (7).jsonl';
const ROUND_REPORTS = 'team-balancer-reports (6).jsonl';

for (const f of [ELO_BACKUP, MATCH_LOG, ROUND_REPORTS]) {
  if (!existsSync(f)) {
    console.error(`ERROR: Missing required file: ${f}`);
    process.exit(1);
  }
}

// ─── Constants ───────────────────────────────────────────────────
const JOIN_TOLERANCE_MS = 30_000;      // 30s window for timestamp join
const RATED_MIN_ROUNDS  = 10;          // matches scrambler's REGULAR_MIN_ROUNDS
const MIN_PLAYERS_TEAM  = 10;          // require ≥10 rated players per team
const DEFAULT_MU         = 25.0;

// ─── Load ELO backup ─────────────────────────────────────────────
console.error('Loading ELO backup...');
const backupRaw = JSON.parse(readFileSync(ELO_BACKUP, 'utf8'));
const playerDB = new Map();
for (const p of backupRaw.players) {
  playerDB.set(p.eosID, p);
}
console.error(`  ${playerDB.size} players loaded`);

// ─── Load match log (per-match per-player muBefore) ──────────────
console.error('Loading match log...');
const matchLog = [];
const matchLogRaw = readFileSync(MATCH_LOG, 'utf8').trim().split('\n');
for (const line of matchLogRaw) {
  if (!line.trim()) continue;
  try {
    const m = JSON.parse(line);
    if (!m.players || !m.outcome || m.outcome === 'draw') continue;
    if (!m.endedAt) continue;
    matchLog.push(m);
  } catch {}
}
console.error(`  ${matchLog.length} matches loaded`);

// ─── Load round reports ──────────────────────────────────────────
console.error('Loading round reports...');
const roundReports = [];
const reportLines = readFileSync(ROUND_REPORTS, 'utf8').trim().split('\n');
for (const line of reportLines) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line);
    if (!r.ts) continue;
    // Skip draws, seed/jensen rounds, and rounds with no ticket data
    if (r.winner === 'Draw') continue;
    if (r.ticketMargin === undefined || r.ticketMargin === null) continue;
    if (r.playerCount < 20) continue; // skip very low-pop rounds
    roundReports.push(r);
  } catch {}
}
console.error(`  ${roundReports.length} round reports loaded`);

// ─── Join: match log ↔ round reports by closest timestamp ────────
console.error('Joining match log to round reports...');
const joined = [];

for (const report of roundReports) {
  // Find closest match log entry within tolerance
  let bestMatch = null;
  let bestDelta = Infinity;
  for (const m of matchLog) {
    const delta = Math.abs(m.endedAt - report.ts);
    if (delta < bestDelta && delta <= JOIN_TOLERANCE_MS) {
      bestDelta = delta;
      bestMatch = m;
    }
  }
  if (!bestMatch) continue;

  joined.push({ report, match: bestMatch, deltaMs: bestDelta });
}
console.error(`  ${joined.length} rounds joined`);

// ─── Compute per-round metrics from match log muBefore ───────────
console.error('Computing per-round ELO metrics...');

const rounds = [];

for (const { report, match } of joined) {
  const players = match.players;
  const t1Players = players.filter(p => p.teamID === 1);
  const t2Players = players.filter(p => p.teamID === 2);

  // Must have enough rated players
  const ratedT1 = t1Players.filter(p => {
    const db = playerDB.get(p.eosID);
    return db && db.roundsPlayed >= RATED_MIN_ROUNDS;
  });
  const ratedT2 = t2Players.filter(p => {
    const db = playerDB.get(p.eosID);
    return db && db.roundsPlayed >= RATED_MIN_ROUNDS;
  });

  if (ratedT1.length < MIN_PLAYERS_TEAM || ratedT2.length < MIN_PLAYERS_TEAM) continue;

  // Get player rating based on --rating-source flag
  const getMu = (p) => {
    if (RATING_SOURCE === 'backup') {
      // Use backup mu exclusively — final trained rating for all rounds
      const db = playerDB.get(p.eosID);
      return db ? db.mu : DEFAULT_MU;
    }
    // Default (matchlog): prefer muBefore (rating at time of round), fall back to backup
    if (typeof p.muBefore === 'number') return p.muBefore;
    const db = playerDB.get(p.eosID);
    return db ? db.mu : DEFAULT_MU;
  };

  const getRoundsPlayed = (p) => {
    const db = playerDB.get(p.eosID);
    return db ? db.roundsPlayed : 0;
  };

  // Team ELO arrays (all players, not just rated — scrambler uses all)
  const t1Elos = t1Players.map(p => getMu(p));
  const t2Elos = t2Players.map(p => getMu(p));

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : DEFAULT_MU;
  const top15Avg = (arr) => {
    if (!arr.length) return DEFAULT_MU;
    const sorted = [...arr].sort((a, b) => b - a);
    const slice = sorted.slice(0, 15);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  };

  const meanT1 = avg(t1Elos);
  const meanT2 = avg(t2Elos);
  const top15T1 = top15Avg(t1Elos);
  const top15T2 = top15Avg(t2Elos);

  const meanDiff = Math.abs(meanT1 - meanT2);
  const top15Diff = Math.abs(top15T1 - top15T2);
  const meanAdvT1 = meanT1 - meanT2;
  const top15AdvT1 = top15T1 - top15T2;

  // Veteran ratios (players with ≥ RATED_MIN_ROUNDS)
  const vet1 = t1Players.filter(p => getRoundsPlayed(p) >= RATED_MIN_ROUNDS).length / t1Players.length;
  const vet2 = t2Players.filter(p => getRoundsPlayed(p) >= RATED_MIN_ROUNDS).length / t2Players.length;
  const vetDiff = Math.abs(vet1 - vet2);

  rounds.push({
    report,
    ts: report.ts,  // timestamp for chronological split
    t1Count: t1Players.length,
    t2Count: t2Players.length,
    ratedT1Count: ratedT1.length,
    ratedT2Count: ratedT2.length,
    meanT1, meanT2, meanDiff, meanAdvT1,
    top15T1, top15T2, top15Diff, top15AdvT1,
    vet1, vet2, vetDiff,
    ticketMargin: report.ticketMargin,
    winnerID: report.winningTeamID || (report.winner === 'Team 1' ? 1 : 2)
  });
}

console.error(`  ${rounds.length} rounds with sufficient rated players\n`);

// ─── Penalty function (mirrors tb-scrambler.js exactly) ──────────
function getPenalty(diff) {
  if (diff <= 0.1) return diff * 20;
  if (diff <= 0.3) return 2.0 + (diff - 0.1) * 40;
  if (diff <= 0.6) return 10.0 + (diff - 0.3) * 80;
  return 34.0 + (diff - 0.6) * 150;
}

// ─── Compute eloBalancePenalty for a given param set ─────────────
function computePenalty(round, params) {
  const {
    meanWeight,
    significanceThreshold,
    crossAdvantageMaxReduction,
    veteranPenaltyWeight
  } = params;

  const top15Weight = 1.0 - meanWeight;

  let compositeDiff = meanWeight * round.meanDiff + top15Weight * round.top15Diff;

  // Cross-team advantage reduction
  const meanSignificant = Math.abs(round.meanAdvT1) > significanceThreshold;
  const top15Significant = Math.abs(round.top15AdvT1) > significanceThreshold;

  if (meanSignificant && top15Significant) {
    const sameDirection = (round.meanAdvT1 > 0) === (round.top15AdvT1 > 0);
    if (!sameDirection) {
      const meanMag = Math.abs(round.meanAdvT1);
      const top15Mag = Math.abs(round.top15AdvT1);
      const splitBalance = Math.min(meanMag, top15Mag) / Math.max(meanMag, top15Mag);
      const reductionRatio = crossAdvantageMaxReduction * splitBalance;
      compositeDiff *= (1.0 - reductionRatio);
    }
  }

  const eloBalancePenalty = Math.min(getPenalty(compositeDiff), 480);

  // Veteran penalty
  const veteranPenalty = round.vetDiff * veteranPenaltyWeight;

  return eloBalancePenalty + veteranPenalty;
}

// ─── Spearman rank correlation ──────────────────────────────────
function spearmanRho(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;

  // Rank x
  const rankX = new Array(n);
  {
    const indexed = xs.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    for (let i = 0; i < n; i++) rankX[indexed[i].i] = i + 1;
  }

  // Rank y
  const rankY = new Array(n);
  {
    const indexed = ys.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    for (let i = 0; i < n; i++) rankY[indexed[i].i] = i + 1;
  }

  // Handle ties: average ranks for equal values
  const avgRank = (arr, vals) => {
    const result = [...arr];
    const unique = [...new Set(vals)].sort((a, b) => a - b);
    for (const val of unique) {
      const indices = [];
      vals.forEach((v, i) => { if (v === val) indices.push(i); });
      if (indices.length > 1) {
        const avgR = indices.reduce((s, i) => s + result[i], 0) / indices.length;
        for (const i of indices) result[i] = avgR;
      }
    }
    return result;
  };

  const rx = avgRank(rankX, xs);
  const ry = avgRank(rankY, ys);

  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    sumD2 += Math.pow(rx[i] - ry[i], 2);
  }

  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

// ─── Fisher-Yates shuffle (in-place) ────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── Grid search (refactored to accept rounds parameter) ─────────
function gridSearch(roundsArray, label) {
  const meanWeights = [];
  for (let w = 0.1; w <= 0.9; w += 0.1) meanWeights.push(parseFloat(w.toFixed(1)));

  const crossReductions = [];
  for (let r = 0.0; r <= 0.5; r += 0.05) crossReductions.push(parseFloat(r.toFixed(2)));

  const thresholds = [];
  for (let t = 0.05; t <= 0.30; t += 0.05) thresholds.push(parseFloat(t.toFixed(2)));

  const vetWeights = [];
  for (let v = 100; v <= 500; v += 50) vetWeights.push(v);

  const total = meanWeights.length * crossReductions.length * thresholds.length * vetWeights.length;
  const labelStr = label ? ` [${label}]` : '';

  const results = [];
  let n = 0;

  for (const meanWeight of meanWeights) {
    for (const crossAdvantageMaxReduction of crossReductions) {
      for (const significanceThreshold of thresholds) {
        for (const veteranPenaltyWeight of vetWeights) {
          n++;
          if (n % 1000 === 0 && label) {
            process.stderr.write(`\r  ${label}: ${n}/${total} (${(n / total * 100).toFixed(1)}%)...`);
          }

          const params = {
            meanWeight,
            significanceThreshold,
            crossAdvantageMaxReduction,
            veteranPenaltyWeight
          };

          const penalties = roundsArray.map(r => computePenalty(r, params));
          const margins  = roundsArray.map(r => r.ticketMargin);
          const rho = spearmanRho(penalties, margins);

          results.push({ ...params, top15Weight: 1.0 - meanWeight, rho });
        }
      }
    }
  }

  if (label) process.stderr.write(`\r  ${label}: ${total}/${total} (100.0%)... done.\n`);
  results.sort((a, b) => b.rho - a.rho);
  return results;
}

// ─── k-fold cross-validation ─────────────────────────────────────
function kFoldCrossValidation(roundsArray, k = 5) {
  console.error(`\n=== ${k}-FOLD CROSS-VALIDATION ===`);
  console.error(`Shuffling ${roundsArray.length} rounds...`);

  const indices = [...Array(roundsArray.length).keys()];
  shuffle(indices);

  const foldSize = Math.floor(roundsArray.length / k);
  const folds = [];
  for (let i = 0; i < k; i++) {
    const start = i * foldSize;
    const end = i === k - 1 ? roundsArray.length : start + foldSize;
    folds.push(indices.slice(start, end).map(idx => roundsArray[idx]));
  }

  const foldResults = [];
  const bestParamVotes = {};

  for (let i = 0; i < k; i++) {
    console.error(`\n  Fold ${i + 1}/${k}:`);
    // Train on all folds except i
    const train = [];
    for (let j = 0; j < k; j++) {
      if (j !== i) train.push(...folds[j]);
    }
    const test = folds[i];

    console.error(`    Training on ${train.length} rounds, testing on ${test.length} rounds`);

    const results = gridSearch(train, `fold${i + 1}-train`);
    const best = results[0];

    // Evaluate best params on held-out test fold
    const testPenalties = test.map(r => computePenalty(r, best));
    const testMargins = test.map(r => r.ticketMargin);
    const heldOutRho = spearmanRho(testPenalties, testMargins);

    // Track param votes
    const paramKey = `mw${best.meanWeight.toFixed(1)}_cr${best.crossAdvantageMaxReduction.toFixed(2)}_st${best.significanceThreshold.toFixed(2)}_vw${best.veteranPenaltyWeight}`;
    bestParamVotes[paramKey] = (bestParamVotes[paramKey] || 0) + 1;

    foldResults.push({
      fold: i + 1,
      trainRho: best.rho,
      heldOutRho,
      bestMeanWeight: best.meanWeight,
      bestTop15Weight: best.top15Weight,
      bestCrossRed: best.crossAdvantageMaxReduction,
      bestSigThr: best.significanceThreshold,
      bestVetW: best.veteranPenaltyWeight
    });

    console.error(`    In-sample best ρ: ${best.rho.toFixed(4)}  |  Held-out ρ: ${heldOutRho.toFixed(4)}`);
  }

  // Aggregate stats
  const heldOutRhos = foldResults.map(f => f.heldOutRho);
  const meanHeldOut = heldOutRhos.reduce((a, b) => a + b, 0) / heldOutRhos.length;
  const stdevHeldOut = Math.sqrt(
    heldOutRhos.reduce((s, v) => s + Math.pow(v - meanHeldOut, 2), 0) / (heldOutRhos.length - 1)
  );

  // Find consensus params (most common winner across folds)
  const sortedVotes = Object.entries(bestParamVotes)
    .sort((a, b) => b[1] - a[1]);

  return {
    k,
    folds: foldResults,
    heldOutRhos,
    meanHeldOut,
    stdevHeldOut,
    paramVotes: sortedVotes,
    consensusParams: sortedVotes[0],
    foldTrainedSets: folds
  };
}

// ─── Chronological split validation ──────────────────────────────
function chronologicalSplit(roundsArray, trainRatio = 0.7) {
  console.error(`\n=== CHRONOLOGICAL 70/30 SPLIT ===`);

  // Sort by timestamp
  const sorted = [...roundsArray].sort((a, b) => a.ts - b.ts);
  const splitIdx = Math.floor(sorted.length * trainRatio);
  const train = sorted.slice(0, splitIdx);
  const test = sorted.slice(splitIdx);

  console.error(`  Train: ${train.length} rounds (earliest ${trainRatio * 100}%)`);
  console.error(`  Test:  ${test.length} rounds (most recent ${(1 - trainRatio) * 100}%)`);

  const results = gridSearch(train, 'chrono-train');
  const best = results[0];

  const testPenalties = test.map(r => computePenalty(r, best));
  const testMargins = test.map(r => r.ticketMargin);
  const heldOutRho = spearmanRho(testPenalties, testMargins);

  console.error(`  In-sample best ρ:  ${best.rho.toFixed(4)}`);
  console.error(`  Held-out test ρ:   ${heldOutRho.toFixed(4)}`);

  return {
    trainSize: train.length,
    testSize: test.length,
    inSampleRho: best.rho,
    heldOutRho,
    bestMeanWeight: best.meanWeight,
    bestTop15Weight: best.top15Weight,
    bestCrossRed: best.crossAdvantageMaxReduction,
    bestSigThr: best.significanceThreshold,
    bestVetW: best.veteranPenaltyWeight
  };
}

// ─── Univariate correlations ─────────────────────────────────────
function univariateAnalysis(roundsArray) {
  console.error(`\n=== UNIVARIATE CORRELATIONS (Direct Predictiveness) ===`);

  const meanDiffs = roundsArray.map(r => r.meanDiff);
  const top15Diffs = roundsArray.map(r => r.top15Diff);
  const margins = roundsArray.map(r => r.ticketMargin);

  const rhoMean = spearmanRho(meanDiffs, margins);
  const rhoTop15 = spearmanRho(top15Diffs, margins);
  const ratio = rhoMean / rhoTop15;

  console.error(`  ρ(meanDiff,  ticketMargin) = ${rhoMean.toFixed(4)}`);
  console.error(`  ρ(top15Diff, ticketMargin) = ${rhoTop15.toFixed(4)}`);
  console.error(`  Predictiveness ratio (mean / top15) = ${ratio.toFixed(2)}×`);
  console.error(`  Correlation between meanDiff and top15Diff: ρ = ${spearmanRho(meanDiffs, top15Diffs).toFixed(2)} (collinearity)`);

  // Noise floor
  const n = roundsArray.length;
  const approxSE = 1 / Math.sqrt(n - 1);
  console.error(`  Approx SE(ρ) ≈ 1/√(n−1) = ${approxSE.toFixed(3)} (n=${n})`);

  return { rhoMean, rhoTop15, ratio, n, approxSE };
}

// ─── Response surface slices ─────────────────────────────────────
function responseSurfaceSlices(allResults, bestParams) {
  // For each parameter, fix the other 3 at best, sweep this one
  const paramDefs = [
    { name: 'meanWeight', values: [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9] },
    { name: 'crossAdvantageMaxReduction', values: [0.00,0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45,0.50] },
    { name: 'significanceThreshold', values: [0.05,0.10,0.15,0.20,0.25,0.30] },
    { name: 'veteranPenaltyWeight', values: [100,150,200,250,300,350,400,450,500] }
  ];

  const slices = [];
  for (const def of paramDefs) {
    const points = [];
    for (const val of def.values) {
      // Find the best ρ among all configs with this param=val and others at best
      const candidates = allResults.filter(r => {
        for (const d of paramDefs) {
          if (d.name === def.name) {
            if (r[d.name] !== val) return false;
          } else {
            if (r[d.name] !== bestParams[d.name]) return false;
          }
        }
        return true;
      });
      const bestRho = candidates.length > 0 ? candidates[0].rho : null;
      points.push({ value: val, rho: bestRho, count: candidates.length });
    }
    slices.push({ parameter: def.name, points });
  }
  return slices;
}

// ─── Plateau size ─────────────────────────────────────────────────
function plateauAnalysis(allResults, bestRho) {
  const epsilons = [0.0005, 0.001, 0.002, 0.005, 0.01];
  const results = [];
  for (const eps of epsilons) {
    const count = allResults.filter(r => r.rho >= bestRho - eps).length;
    const pct = (count / allResults.length * 100).toFixed(1);
    results.push({ epsilon: eps, count, pct });
  }
  return results;
}

// ─── Parameter robustness ranges ──────────────────────────────────
function parameterRobustness(allResults, bestRho) {
  const paramDefs = [
    { name: 'meanWeight', values: [0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9] },
    { name: 'crossAdvantageMaxReduction', values: [0.00,0.05,0.10,0.15,0.20,0.25,0.30,0.35,0.40,0.45,0.50] },
    { name: 'significanceThreshold', values: [0.05,0.10,0.15,0.20,0.25,0.30] },
    { name: 'veteranPenaltyWeight', values: [100,150,200,250,300,350,400,450,500] }
  ];

  const thresholds = [0.01, 0.005]; // 1% and 0.5% of best ρ
  const results = [];

  for (const def of paramDefs) {
    for (const thresh of thresholds) {
      const cutoff = bestRho * (1 - thresh);
      // For each value of this param, what's the max ρ achievable (other params free)?
      const maxRhoPerValue = new Map();
      for (const val of def.values) {
        let maxRho = -Infinity;
        for (const r of allResults) {
          if (r[def.name] === val && r.rho > maxRho) maxRho = r.rho;
        }
        maxRhoPerValue.set(val, maxRho);
      }
      // Which values keep max ρ within threshold of best?
      const viable = def.values.filter(v => maxRhoPerValue.get(v) >= cutoff);
      const rangeStr = viable.length > 0
        ? `${viable[0]}–${viable[viable.length - 1]}`
        : 'none';
      results.push({
        parameter: def.name,
        threshold: thresh,
        cutoff,
        viableCount: viable.length,
        viableValues: viable,
        range: rangeStr
      });
    }
  }
  return results;
}

// ─── Multi-modality cluster check ─────────────────────────────────
function multiModalityCheck(allResults, bestRho) {
  // Take top 1% of configs
  const topN = Math.max(10, Math.ceil(allResults.length * 0.01));
  const topConfigs = allResults.slice(0, topN);

  // Normalize each parameter to [0,1]
  const ranges = {
    meanWeight: [0.1, 0.9],
    crossAdvantageMaxReduction: [0.0, 0.5],
    significanceThreshold: [0.05, 0.30],
    veteranPenaltyWeight: [100, 500]
  };

  const normalize = (r) => ({
    mw: (r.meanWeight - ranges.meanWeight[0]) / (ranges.meanWeight[1] - ranges.meanWeight[0]),
    cr: (r.crossAdvantageMaxReduction - ranges.crossAdvantageMaxReduction[0]) / (ranges.crossAdvantageMaxReduction[1] - ranges.crossAdvantageMaxReduction[0]),
    st: (r.significanceThreshold - ranges.significanceThreshold[0]) / (ranges.significanceThreshold[1] - ranges.significanceThreshold[0]),
    vw: (r.veteranPenaltyWeight - ranges.veteranPenaltyWeight[0]) / (ranges.veteranPenaltyWeight[1] - ranges.veteranPenaltyWeight[0])
  });

  const dist = (a, b) => Math.sqrt(
    Math.pow(a.mw - b.mw, 2) + Math.pow(a.cr - b.cr, 2) +
    Math.pow(a.st - b.st, 2) + Math.pow(a.vw - b.vw, 2)
  );

  // Single-linkage clustering with threshold
  const threshold = 0.3; // max normalized distance to be in same cluster
  const normalized = topConfigs.map(r => ({ ...normalize(r), orig: r }));
  const visited = new Array(normalized.length).fill(false);
  const clusters = [];

  for (let i = 0; i < normalized.length; i++) {
    if (visited[i]) continue;
    const cluster = [normalized[i]];
    visited[i] = true;
    // BFS to find all connected
    let head = 0;
    while (head < cluster.length) {
      for (let j = 0; j < normalized.length; j++) {
        if (visited[j]) continue;
        if (dist(cluster[head], normalized[j]) <= threshold) {
          cluster.push(normalized[j]);
          visited[j] = true;
        }
      }
      head++;
    }
    clusters.push(cluster);
  }

  // Summarize each cluster
  const summaries = clusters.map(cluster => {
    const configs = cluster.map(c => c.orig);
    const avgMw = configs.reduce((s, c) => s + c.meanWeight, 0) / configs.length;
    const avgCr = configs.reduce((s, c) => s + c.crossAdvantageMaxReduction, 0) / configs.length;
    const avgSt = configs.reduce((s, c) => s + c.significanceThreshold, 0) / configs.length;
    const avgVw = configs.reduce((s, c) => s + c.veteranPenaltyWeight, 0) / configs.length;
    const minRho = Math.min(...configs.map(c => c.rho));
    const maxRho = Math.max(...configs.map(c => c.rho));
    return {
      size: configs.length,
      avgMeanW: avgMw,
      avgCrossRed: avgCr,
      avgSigThr: avgSt,
      avgVetW: avgVw,
      minRho,
      maxRho,
      sampleConfigs: configs.slice(0, 3)
    };
  });

  summaries.sort((a, b) => b.size - a.size);

  return {
    topN,
    threshold,
    clusterCount: clusters.length,
    clusters: summaries,
    isMultiModal: clusters.length > 1
  };
}

// ─── ρ distribution histogram ─────────────────────────────────────
function rhoHistogram(allResults, buckets = 20) {
  const rhos = allResults.map(r => r.rho);
  const minRho = Math.min(...rhos);
  const maxRho = Math.max(...rhos);
  const bucketWidth = (maxRho - minRho) / buckets;

  const histogram = [];
  for (let i = 0; i < buckets; i++) {
    const low = minRho + i * bucketWidth;
    const high = low + bucketWidth;
    const count = rhos.filter(r => r >= low && (i === buckets - 1 ? r <= high : r < high)).length;
    histogram.push({ low, high, count, bar: '█'.repeat(Math.max(1, Math.round(count / allResults.length * 100))) });
  }
  return { minRho, maxRho, bucketWidth, buckets, histogram };
}

// ─── Main ────────────────────────────────────────────────────────
console.error(`Rounds for calibration: ${rounds.length}\n`);
console.error(`Grid size: 9 mean × 11 crossRed × 6 thresh × 9 vet = ${9 * 11 * 6 * 9} candidates\n`);
console.error('═══════════════════════════════════════════════');
console.error('  PHASE 1: In-sample grid search (full data)');
console.error('═══════════════════════════════════════════════\n');

const start = Date.now();
const allResults = gridSearch(rounds, 'full');
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.error(`\nFull grid search complete in ${elapsed}s\n`);

const top20 = allResults.slice(0, 20);

// Current defaults
const defaultParams = {
  meanWeight: 0.6,
  top15Weight: 0.4,
  crossAdvantageMaxReduction: 0.30,
  significanceThreshold: 0.1,
  veteranPenaltyWeight: 300
};
const defaultPenalties = rounds.map(r => computePenalty(r, defaultParams));
const defaultMargins  = rounds.map(r => r.ticketMargin);
const defaultRho = spearmanRho(defaultPenalties, defaultMargins);

// ─── Run validation ──────────────────────────────────────────────
console.error('═══════════════════════════════════════════════');
console.error('  PHASE 2: Out-of-sample validation');
console.error('═══════════════════════════════════════════════');

const cvResults = kFoldCrossValidation(rounds, 5);
const chronoResults = chronologicalSplit(rounds, 0.7);

console.error('\n═══════════════════════════════════════════════');
console.error('  PHASE 3: Univariate predictiveness');
console.error('═══════════════════════════════════════════════');

const univariate = univariateAnalysis(rounds);

// ─── Output ──────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║     SCRAMBLER ELO WEIGHT CALIBRATION RESULTS (v2.1)          ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log(`\nRating source: ${RATING_SOURCE === 'backup' ? 'ELO backup (final trained mu)' : 'match log (muBefore, fallback to backup)'}`);
console.log(`Rounds analyzed: ${rounds.length}`);
console.log(`Grid candidates: ${allResults.length}\n`);

console.log('=== IN-SAMPLE TOP 20 (Spearman ρ with ticket margin) ===\n');
console.log(`${'Rank'.padEnd(6)} ${'MeanW'.padEnd(7)} ${'Top15W'.padEnd(8)} ${'CrossRed'.padEnd(9)} ${'SigThr'.padEnd(8)} ${'VetW'.padEnd(6)} ${'ρ'.padEnd(8)}`);
console.log('─'.repeat(60));

for (let i = 0; i < top20.length; i++) {
  const r = top20[i];
  console.log(
    `${String(i + 1).padEnd(6)} ${r.meanWeight.toFixed(1).padEnd(7)} ${r.top15Weight.toFixed(1).padEnd(8)} ` +
    `${r.crossAdvantageMaxReduction.toFixed(2).padEnd(9)} ${r.significanceThreshold.toFixed(2).padEnd(8)} ` +
    `${r.veteranPenaltyWeight.toString().padEnd(6)} ${r.rho.toFixed(4).padEnd(8)}`
  );
}

console.log(`\n--- Current defaults ---`);
console.log(`  meanWeight=0.6  top15Weight=0.4  crossRed=0.30  sigThr=0.10  vetW=300`);
console.log(`  ρ = ${defaultRho.toFixed(4)}`);
console.log(`  Rank among all candidates: ${allResults.findIndex(r => r.rho <= defaultRho) + 1} / ${allResults.length}`);

// ─── In-sample distribution stats ────────────────────────────────
console.log(`\n=== IN-SAMPLE DISTRIBUTION STATS ===`);
const rhos = allResults.map(r => r.rho);
rhos.sort((a, b) => b - a);
console.log(`  Best ρ:    ${rhos[0].toFixed(4)}`);
console.log(`  Median ρ:  ${rhos[Math.floor(rhos.length / 2)].toFixed(4)}`);
console.log(`  Worst ρ:   ${rhos[rhos.length - 1].toFixed(4)}`);
console.log(`  Default ρ: ${defaultRho.toFixed(4)} (percentile: ${(allResults.filter(r => r.rho < defaultRho).length / allResults.length * 100).toFixed(1)}%)`);

// ─── Cross-validation results ────────────────────────────────────
console.log(`\n=== ${cvResults.k}-FOLD CROSS-VALIDATION ===`);
console.log(`  Mean held-out ρ:   ${cvResults.meanHeldOut.toFixed(4)}`);
console.log(`  Stdev held-out ρ:  ${cvResults.stdevHeldOut.toFixed(4)}`);
console.log(`  Default in-sample ρ: ${defaultRho.toFixed(4)} (for reference)`);
console.log(`\n  Per-fold results:`);
console.log(`  ${'Fold'.padEnd(6)} ${'Train ρ'.padEnd(9)} ${'Held-out ρ'.padEnd(11)} ${'MeanW'.padEnd(7)} ${'CrossRed'.padEnd(9)} ${'VetW'.padEnd(6)}`);
console.log(`  ${'─'.repeat(55)}`);
for (const f of cvResults.folds) {
  console.log(`  ${String(f.fold).padEnd(6)} ${f.trainRho.toFixed(4).padEnd(9)} ${f.heldOutRho.toFixed(4).padEnd(11)} ${f.bestMeanWeight.toFixed(1).padEnd(7)} ${f.bestCrossRed.toFixed(2).padEnd(9)} ${String(f.bestVetW).padEnd(6)}`);
}

console.log(`\n  Param vote distribution (how many folds chose each config):`);
for (const [key, count] of cvResults.paramVotes) {
  console.log(`    ${key}: ${count}/${cvResults.k} folds`);
}

// ─── Chronological split results ─────────────────────────────────
console.log(`\n=== CHRONOLOGICAL 70/30 SPLIT ===`);
console.log(`  Train rounds:     ${chronoResults.trainSize}`);
console.log(`  Test rounds:      ${chronoResults.testSize}`);
console.log(`  In-sample best ρ:  ${chronoResults.inSampleRho.toFixed(4)}`);
console.log(`  Held-out test ρ:   ${chronoResults.heldOutRho.toFixed(4)}`);
console.log(`  Best params:        meanW=${chronoResults.bestMeanWeight.toFixed(1)}, crossRed=${chronoResults.bestCrossRed.toFixed(2)}, vetW=${chronoResults.bestVetW}`);

// ─── Univariate results ──────────────────────────────────────────
console.log(`\n=== UNIVARIATE PREDICTIVENESS (Direct Metrics) ===`);
console.log(`  ρ(meanDiff,  ticketMargin) = ${univariate.rhoMean.toFixed(4)}`);
console.log(`  ρ(top15Diff, ticketMargin) = ${univariate.rhoTop15.toFixed(4)}`);
console.log(`  Predictiveness ratio        = ${univariate.ratio.toFixed(2)}×`);
console.log(`  Collinearity ρ(mean, top15)  = ${spearmanRho(rounds.map(r => r.meanDiff), rounds.map(r => r.top15Diff)).toFixed(2)}`);
console.log(`  Approx SE(ρ) ≈ ${univariate.approxSE.toFixed(3)} (n=${univariate.n})`);

// ─── Landscape analysis ──────────────────────────────────────────
console.error('\n═══════════════════════════════════════════════');
console.error('  PHASE 4: Landscape analysis');
console.error('═══════════════════════════════════════════════');

const best = top20[0];
const bestParams = {
  meanWeight: best.meanWeight,
  crossAdvantageMaxReduction: best.crossAdvantageMaxReduction,
  significanceThreshold: best.significanceThreshold,
  veteranPenaltyWeight: best.veteranPenaltyWeight
};

// Plateau size
const plateau = plateauAnalysis(allResults, best.rho);

// Response surface slices
const slices = responseSurfaceSlices(allResults, bestParams);

// Parameter robustness
const robustness = parameterRobustness(allResults, best.rho);

// Multi-modality check
const modality = multiModalityCheck(allResults, best.rho);

// ρ distribution histogram
const histogram = rhoHistogram(allResults, 20);

// ─── Output landscape analysis ───────────────────────────────────
console.log(`\n=== PLATEAU SIZE (configs within ε of best ρ = ${best.rho.toFixed(4)}) ===`);
console.log(`  ${'ε'.padEnd(10)} ${'Count'.padEnd(8)} ${'% of grid'.padEnd(10)}`);
console.log(`  ${'─'.repeat(30)}`);
for (const p of plateau) {
  console.log(`  ${p.epsilon.toFixed(4).padEnd(10)} ${String(p.count).padEnd(8)} ${p.pct.padEnd(10)}`);
}

console.log(`\n=== RESPONSE SURFACE SLICES (other params fixed at best) ===`);
for (const slice of slices) {
  console.log(`\n  ── ${slice.parameter} ──`);
  const validPoints = slice.points.filter(p => p.rho !== null);
  if (validPoints.length === 0) {
    console.log(`    (no matching configs — best params may be at edge of grid)`);
    continue;
  }
  const maxRho = Math.max(...validPoints.map(p => p.rho));
  const minRho = Math.min(...validPoints.map(p => p.rho));
  const range = maxRho - minRho;
  for (const pt of slice.points) {
    if (pt.rho === null) {
      console.log(`    ${String(pt.value).padEnd(8)} (no match)`);
    } else {
      const barLen = range > 0 ? Math.max(1, Math.round((pt.rho - minRho) / range * 40)) : 40;
      const bar = '█'.repeat(barLen);
      const marker = pt.rho === maxRho ? ' ← max' : '';
      console.log(`    ${String(pt.value).padEnd(8)} ${pt.rho.toFixed(4)} ${bar}${marker}`);
    }
  }
}

console.log(`\n=== PARAMETER ROBUSTNESS RANGES ===`);
console.log(`  (Values that keep max achievable ρ within threshold of best ρ = ${best.rho.toFixed(4)})`);
console.log(`  ${'Parameter'.padEnd(28)} ${'Threshold'.padEnd(10)} ${'Viable'.padEnd(8)} ${'Range'}`);
console.log(`  ${'─'.repeat(60)}`);
for (const r of robustness) {
  console.log(`  ${r.parameter.padEnd(28)} ${(r.threshold * 100).toFixed(1).padEnd(9)}% ${String(r.viableCount).padEnd(8)} ${r.range}`);
}

console.log(`\n=== MULTI-MODALITY CHECK (top ${modality.topN} configs, ~1% of grid) ===`);
console.log(`  Cluster threshold (normalized distance): ${modality.threshold}`);
console.log(`  Clusters found: ${modality.clusterCount}`);
console.log(`  Multi-modal: ${modality.isMultiModal ? 'YES — distinct parameter regimes achieve similar ρ' : 'NO — single plateau'}`);
if (modality.clusters.length > 1) {
  console.log(`\n  Cluster summaries:`);
  for (let i = 0; i < modality.clusters.length; i++) {
    const c = modality.clusters[i];
    console.log(`    Cluster ${i + 1}: ${c.size} configs, ρ range [${c.minRho.toFixed(4)}, ${c.maxRho.toFixed(4)}]`);
    console.log(`      Avg params: meanW=${c.avgMeanW.toFixed(2)}, crossRed=${c.avgCrossRed.toFixed(2)}, sigThr=${c.avgSigThr.toFixed(2)}, vetW=${c.avgVetW.toFixed(0)}`);
    console.log(`      Sample: ${c.sampleConfigs.map(r => `mw${r.meanWeight.toFixed(1)}_cr${r.crossAdvantageMaxReduction.toFixed(2)}_vw${r.veteranPenaltyWeight}`).join(', ')}`);
  }
}

console.log(`\n=== ρ DISTRIBUTION HISTOGRAM (${histogram.buckets} buckets) ===`);
console.log(`  Range: [${histogram.minRho.toFixed(4)}, ${histogram.maxRho.toFixed(4)}]  Bucket width: ${histogram.bucketWidth.toFixed(4)}`);
for (const b of histogram.histogram) {
  console.log(`  ${b.low.toFixed(4)}–${b.high.toFixed(4)} ${String(b.count).padStart(5)} ${b.bar}`);
}

// ─── Interpretation ──────────────────────────────────────────────
console.log(`\n=== INTERPRETATION ===`);

if (univariate.ratio < 3.0) {
  console.log(`  ⚠ The meanDiff and top15Diff metrics are weakly predictive of ticket`);
  console.log(`    margin (univariate ρ² < 1%). The predictiveness ratio is ${univariate.ratio.toFixed(2)}×,`);
  console.log(`    not the 9× implied by the composite weight ratio (0.9/0.1).`);
  console.log(`    The weight ratio is a blend tuning, not a predictiveness measure.`);
}

if (cvResults.meanHeldOut > defaultRho) {
  console.log(`\n  ✓ Cross-validated held-out ρ (${cvResults.meanHeldOut.toFixed(4)}) > default in-sample ρ (${defaultRho.toFixed(4)}).`);
  console.log(`    Calibrated weights outperform defaults out-of-sample.`);
} else {
  console.log(`\n  ⚠ Cross-validated held-out ρ (${cvResults.meanHeldOut.toFixed(4)}) ≤ default in-sample ρ (${defaultRho.toFixed(4)}).`);
  console.log(`    Calibrated weights may not generalize.`);
}

if (cvResults.stdevHeldOut > 0.015) {
  console.log(`  ⚠ Held-out ρ stdev (${cvResults.stdevHeldOut.toFixed(4)}) is large relative to the`);
  console.log(`    mean (${cvResults.meanHeldOut.toFixed(4)}). The optimum is poorly identified —`);
  console.log(`    consistent with collinear predictors and a flat search surface.`);
  console.log(`    cf. audit finding: SE(ρ) ≈ 0.029 > measured lift of 0.0213`);
}

// ─── Recommendation ──────────────────────────────────────────────
console.log(`\n=== RECOMMENDATION ===`);
console.log(`Best in-sample params: meanWeight=${best.meanWeight.toFixed(1)}, top15Weight=${best.top15Weight.toFixed(1)}, crossAdvantageMaxReduction=${best.crossAdvantageMaxReduction.toFixed(2)}, significanceThreshold=${best.significanceThreshold.toFixed(2)}, veteranPenaltyWeight=${best.veteranPenaltyWeight}`);
console.log(`In-sample ρ = ${best.rho.toFixed(4)} vs default ρ = ${defaultRho.toFixed(4)} (Δ = ${(best.rho - defaultRho).toFixed(4)})`);
console.log(`Mean held-out ρ (${cvResults.k}-fold CV): ${cvResults.meanHeldOut.toFixed(4)}`);

if (best.rho > defaultRho && cvResults.meanHeldOut > defaultRho) {
  console.log(`\n✓ Calibrated weights outperform defaults both in-sample and held-out.`);
  console.log(`  Direction is robust but effect is small — treat as "slightly better", not "calibrated to optimum".`);
  if (Math.abs(best.meanWeight - 0.6) > 0.01) {
    console.log(`  compositeDiff = ${best.meanWeight.toFixed(1)} * meanDiff + ${best.top15Weight.toFixed(1)} * top15Diff`);
  }
  if (Math.abs(best.crossAdvantageMaxReduction - 0.30) > 0.005) {
    console.log(`  crossAdvantageMaxReduction: 0.30 → ${best.crossAdvantageMaxReduction.toFixed(2)}`);
  }
  if (Math.abs(best.significanceThreshold - 0.1) > 0.005) {
    console.log(`  SIGNIFICANCE_THRESHOLD: 0.1 → ${best.significanceThreshold.toFixed(2)}`);
  }
  if (best.veteranPenaltyWeight !== 300) {
    console.log(`  veteranPenaltyWeight: 300 → ${best.veteranPenaltyWeight}`);
  }
} else {
  console.log(`\n⚠ Defaults already optimal or near-optimal. No changes recommended.`);
}