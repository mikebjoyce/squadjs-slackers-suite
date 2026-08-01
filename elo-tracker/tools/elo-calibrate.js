/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                      ELO CALIBRATOR                           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Calibrates TrueSkill parameters (BETA, TAU) against historical
 * match data via two-pass grid search, minimising weighted log-loss.
 *
 * Usage: node elo-calibrate.js <matchlog.jsonl> <db-backup.json> [--lambda=50,100,200]
 *
 * --lambda: comma-separated list of calibration penalty strengths (default: 200)
 *           Higher = more penalty for low prediction variance.
 */

import readline from 'readline';
import fs from 'fs';
import EloCalculator from '../utils/elo-calculator.js';

const jsonlPath = process.argv[2];
const dbPath    = process.argv[3];

if (!jsonlPath || !dbPath) {
  console.error('Usage: node elo-calibrate.js <matchlog.jsonl> <db-backup.json> [--lambda=50,100,200]');
  process.exit(1);
}

// Parse --lambda argument
const lambdaArg = process.argv.find(a => a.startsWith('--lambda='));
const LAMBDAS   = lambdaArg
  ? lambdaArg.split('=')[1].split(',').map(Number)
  : [200];

// --- Constants ---
const RATED_MIN_GAMES     = 5;
const MIN_RATED_PER_TEAM  = 3;
const CALIBRATION_EPSILON = 1e-6;

// Pass 1: wide bounds, coarse steps
const PASS1_BETA_MIN  = 0.1;
const PASS1_BETA_MAX  = 50.0;
const PASS1_BETA_STEP = 1.0;
const PASS1_TAU_MIN   = 0.01;
const PASS1_TAU_MAX   = 2.0;
const PASS1_TAU_STEP  = 0.1;

// Pass 2: narrow around top-3, finer steps
const PASS2_BETA_STEP = 0.25;
const PASS2_TAU_STEP  = 0.02;
const PASS2_BETA_MARGIN = 0.5;  // small for BETA (~0.1 range)
const PASS2_TAU_MARGIN  = 3.0;  // larger for TAU (~2.0 range)

// --- Load DB synchronously ---
const db = JSON.parse(fs.readFileSync(dbPath));
const playerDB = new Map();
for (const p of db.players) playerDB.set(p.eosID, p);

// --- Stream and parse match log ---
const matches = [];

const rl = readline.createInterface({
  input: fs.createReadStream(jsonlPath),
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;

  let match;
  try { match = JSON.parse(line); }
  catch { return; }

  const { players, outcome, endedAt, matchId } = match;

  if (!players || !outcome || outcome === 'draw') return;
  const team1 = players.filter(p => p.teamID === 1);
  const team2 = players.filter(p => p.teamID === 2);
  if (!team1.length || !team2.length) return;

  matches.push({ matchId, endedAt, outcome, players, team1, team2 });
});

// --- Win probability ---
function winProbability(team1, team2, BETA) {
  const getRatio = (p) => p.participationRatio ?? 1.0;
  
  let effectiveN1  = team1.reduce((s, p) => s + getRatio(p), 0);
  let effectiveN2  = team2.reduce((s, p) => s + getRatio(p), 0);

  const scale1 = effectiveN1 > 50.0 ? 50.0 / effectiveN1 : 1.0;
  const scale2 = effectiveN2 > 50.0 ? 50.0 / effectiveN2 : 1.0;

  effectiveN1 *= scale1;
  effectiveN2 *= scale2;

  const teamMu1      = team1.reduce((s, p) => s + p.mu * getRatio(p), 0) * scale1;
  const teamMu2      = team2.reduce((s, p) => s + p.mu * getRatio(p), 0) * scale2;
  
  const teamSigmaSq1 = team1.reduce((s, p) => s + (p.sigma * p.sigma + BETA * BETA) * getRatio(p), 0) * scale1;
  const teamSigmaSq2 = team2.reduce((s, p) => s + (p.sigma * p.sigma + BETA * BETA) * getRatio(p), 0) * scale2;
  const c            = Math.sqrt(teamSigmaSq1 + teamSigmaSq2);
  
  const nTotal       = effectiveN1 + effectiveN2;
  const epsilon      = Math.sqrt(nTotal) * BETA * Math.SQRT2 * EloCalculator._erfInv(0.01);
  const t            = (teamMu1 - teamMu2) / c;
  return EloCalculator._cdf(t - epsilon / c);
}

// --- Replay ---
function replayMatches(matches, BETA, TAU, lambda = 200) {
  EloCalculator.BETA = BETA;
  EloCalculator.TAU  = TAU;

  const ratings   = new Map();
  const getRating = (eosID) => {
    if (!ratings.has(eosID)) ratings.set(eosID, EloCalculator.getDefaultRating());
    return ratings.get(eosID);
  };

  let totalLoss = 0;
  const games   = [];

  for (const match of matches) {
    const { matchId, outcome, weight, team1, team2 } = match;

    const t1ratings = team1.map(p => ({ eosID: p.eosID, ...getRating(p.eosID) }));
    const t2ratings = team2.map(p => ({ eosID: p.eosID, ...getRating(p.eosID) }));

    const pTeam1 = Math.min(0.999, Math.max(0.001, winProbability(t1ratings, t2ratings, BETA)));
    const p      = outcome === 'team1win' ? pTeam1 : 1 - pTeam1;
    totalLoss   += -Math.log(p) * weight;

    const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(t1ratings, t2ratings, outcome);

    const applyUpdates = (players, updates) => {
      for (let i = 0; i < players.length; i++) {
        const matchPlayer = match.players.find(p => p.eosID === players[i].eosID);
        const ratio       = matchPlayer?.participationRatio ?? 1;
        const rating      = getRating(players[i].eosID);
        rating.mu        += updates[i].deltaMu    * ratio;
        rating.sigma      = Math.max(rating.sigma - updates[i].deltaSigma * ratio, 0.5);
      }
    };

    applyUpdates(t1ratings, team1Updates);
    applyUpdates(t2ratings, team2Updates);

    // Post-update spreads
    const avgMu      = arr => arr.reduce((s, p) => s + getRating(p.eosID).mu, 0) / arr.length;
    const isRated    = eosID => { const d = playerDB.get(eosID); return d && d.roundsPlayed >= RATED_MIN_GAMES; };

    const rated1     = t1ratings.filter(p => isRated(p.eosID));
    const rated2     = t2ratings.filter(p => isRated(p.eosID));
    const ratedSpread = (rated1.length >= 1 && rated2.length >= 1)
      ? avgMu(rated1) - avgMu(rated2)
      : null;

    const fullSpread = avgMu(t1ratings) - avgMu(t2ratings);

    games.push({
      matchId, outcome, weight, pTeam1,
      ratedSpread,
      fullSpread,
      correct: (pTeam1 >= 0.5) === (outcome === 'team1win')
    });
  }

  // Calibration-error penalty: MSE between predicted and actual win rates
  // across probability buckets. Directly penalizes miscalibration.
  const N_BUCKETS = 10;
  const buckets = new Array(N_BUCKETS).fill(null).map(() => ({ count: 0, predSum: 0, actualWins: 0 }));
  
  for (const g of games) {
    const bin = Math.min(N_BUCKETS - 1, Math.floor(g.pTeam1 * N_BUCKETS));
    buckets[bin].count++;
    buckets[bin].predSum += g.pTeam1;
    if (g.outcome === 'team1win') buckets[bin].actualWins++;
  }
  
  let calibMSE = 0;
  let bucketsWithData = 0;
  for (const b of buckets) {
    if (b.count === 0) continue;
    bucketsWithData++;
    const avgPred = b.predSum / b.count;
    const actualRate = b.actualWins / b.count;
    calibMSE += Math.pow(avgPred - actualRate, 2);
  }
  calibMSE = bucketsWithData > 0 ? calibMSE / bucketsWithData : 0;
  
  const calibPenalty = lambda * calibMSE * games.length;
  const adjustedLoss = totalLoss + calibPenalty;

  return { totalLoss, adjustedLoss, calibPenalty, games };
}

// --- Prediction curve printer ---
function printPredictionCurve(games, spreadKey, label) {
  const BUCKET_SIZE = 0.1;
  const buckets = {};

  for (const g of games) {
    const spread = g[spreadKey];
    if (spread === null || spread === undefined) continue;
    const absDiff = Math.abs(spread);
    const key     = parseFloat((Math.floor(absDiff / BUCKET_SIZE) * BUCKET_SIZE).toFixed(2));
    const favored = spread > 0 ? 'team1win' : 'team2win';
    if (!buckets[key]) buckets[key] = { total: 0, favoredWins: 0 };
    buckets[key].total++;
    if (g.outcome === favored) buckets[key].favoredWins++;
  }

  const keys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  if (!keys.length) { console.log(`${label}\n  No spread data.\n`); return; }

  console.log(`\n${label}`);
  console.log(`${'Spread'.padEnd(12)} ${'Games'.padEnd(8)} ${'FavouredWin%'.padEnd(15)} ${'Bar'}`);
  console.log('─'.repeat(60));

  let signal = 0, total = 0;
  for (const key of keys) {
    const b      = buckets[key];
    const winPct = (b.favoredWins / b.total * 100).toFixed(1);
    const bar    = '█'.repeat(Math.round(b.favoredWins / b.total * 20));
    const lbl    = `${key.toFixed(1)}–${(key + BUCKET_SIZE).toFixed(1)}`;
    console.log(`${lbl.padEnd(12)} ${String(b.total).padEnd(8)} ${(winPct + '%').padEnd(15)} ${bar}`);
    total += b.total;
    if (key >= 0.5) signal += b.total;
  }

  console.log('─'.repeat(60));
  console.log(`Signal ratio (spread >= 0.5): ${signal} / ${total} (${(signal / total * 100).toFixed(1)}%)`);
}

// --- Grid search (single pass, lambda-aware) ---
function runGrid(matches, betaMin, betaMax, betaStep, tauMin, tauMax, tauStep, lambda) {
  const betas = [];
  const taus  = [];

  for (let b = betaMin; b <= betaMax + 1e-9; b += betaStep) betas.push(parseFloat(b.toFixed(2)));
  for (let t = tauMin;  t <= tauMax  + 1e-9; t += tauStep)  taus.push(parseFloat(t.toFixed(4)));

  const total   = betas.length * taus.length;
  const results = [];
  let   n       = 0;

  for (const BETA of betas) {
    for (const TAU of taus) {
      n++;
      process.stdout.write(`\r  Testing BETA=${BETA.toFixed(2)} TAU=${TAU.toFixed(4)} (${n}/${total})...`);
      const { totalLoss, adjustedLoss, calibPenalty, games } = replayMatches(matches, BETA, TAU, lambda);
      results.push({ BETA, TAU, totalLoss, adjustedLoss, calibPenalty, games });
    }
  }

  process.stdout.write('\n');
  results.sort((a, b) => a.adjustedLoss - b.adjustedLoss);
  return results;
}

// --- Diagnostic ---
function diagBuckets(games, label) {
  const bands = [
    [0.000, 0.500],
    [0.500, 0.550],
    [0.550, 0.650],
    [0.650, 0.750],
    [0.750, 1.001],
  ];
  console.log(`${label}`);
  console.log(`${'P(team1 wins)'.padEnd(18)} ${'Games'.padEnd(8)} ${'Actual T1 Win%'}`);
  console.log('─'.repeat(44));
  for (const [lo, hi] of bands) {
    const subset = games.filter(g => g.pTeam1 >= lo && g.pTeam1 < hi);
    if (!subset.length) continue;
    const actualWinRate = (subset.filter(g => g.outcome === 'team1win').length / subset.length * 100).toFixed(1);
    const lbl = `${lo.toFixed(3)}–${hi.toFixed(3)}`;
    console.log(`${lbl.padEnd(18)} ${String(subset.length).padEnd(8)} ${actualWinRate}%`);
  }
  const avgP = (games.reduce((s, g) => s + g.pTeam1, 0) / games.length).toFixed(4);
  console.log(`Avg predicted P(team1): ${avgP}\n`);
}

// --- Run calibration for each lambda ---
function runAll() {
  matches.sort((a, b) => a.endedAt - b.endedAt);

  for (const match of matches) {
    const rated1 = match.team1.filter(p => { const d = playerDB.get(p.eosID); return d && d.roundsPlayed >= RATED_MIN_GAMES; });
    const rated2 = match.team2.filter(p => { const d = playerDB.get(p.eosID); return d && d.roundsPlayed >= RATED_MIN_GAMES; });
    match.weight = (rated1.length >= MIN_RATED_PER_TEAM && rated2.length >= MIN_RATED_PER_TEAM) ? 3 : 1;
  }

  const weightedCount = matches.filter(m => m.weight === 3).length;
  console.log(`Loaded ${matches.length} matches, ${playerDB.size} players in DB`);
  console.log(`Weighted: ${weightedCount} rated games (weight=3), ${matches.length - weightedCount} unrated (weight=1)`);

  // Smoke test (always uses default lambda=200 for consistency)
  const { totalLoss: smokeLoss, adjustedLoss: smokeAdjLoss, games: smokeGames } = replayMatches(matches, 25 / 6, 25 / 300);
  const smokeAcc = (smokeGames.filter(g => g.correct).length / smokeGames.length * 100).toFixed(1);
  console.log(`\nSmoke test (default params): loss=${smokeLoss.toFixed(4)}, accuracy=${smokeAcc}%`);

  // Run for each lambda
  for (const LAMBDA of LAMBDAS) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  LAMBDA = ${LAMBDA}`);
    console.log(`${'═'.repeat(70)}`);

    const start = Date.now();

    // --- Pass 1: wide bounds, coarse ---
    console.log(`\n--- Pass 1: Wide search (BETA ${PASS1_BETA_MIN}–${PASS1_BETA_MAX} step ${PASS1_BETA_STEP}, TAU ${PASS1_TAU_MIN}–${PASS1_TAU_MAX} step ${PASS1_TAU_STEP}) ---`);
    const pass1Results = runGrid(matches, PASS1_BETA_MIN, PASS1_BETA_MAX, PASS1_BETA_STEP, PASS1_TAU_MIN, PASS1_TAU_MAX, PASS1_TAU_STEP, LAMBDA);
    const top3 = pass1Results.slice(0, 3);

    console.log(`\n  Pass 1 top 3:`);
    for (let i = 0; i < top3.length; i++) {
      console.log(`    #${i + 1}: BETA=${top3[i].BETA.toFixed(2)} TAU=${top3[i].TAU.toFixed(4)} adjLoss=${top3[i].adjustedLoss.toFixed(2)}`);
    }

    // --- Pass 2: narrow around top-3, finer ---
    const allPass2 = [];
    for (const best of top3) {
      const bMin = Math.max(PASS1_BETA_MIN, best.BETA - PASS2_BETA_MARGIN);
      const bMax = Math.min(PASS1_BETA_MAX, best.BETA + PASS2_BETA_MARGIN);
      const tMin = Math.max(PASS1_TAU_MIN, best.TAU - PASS2_TAU_MARGIN);
      const tMax = Math.min(PASS1_TAU_MAX, best.TAU + PASS2_TAU_MARGIN);

      console.log(`\n--- Pass 2: Fine search around #${top3.indexOf(best) + 1} (BETA ${bMin.toFixed(1)}–${bMax.toFixed(1)} step ${PASS2_BETA_STEP}, TAU ${tMin.toFixed(2)}–${tMax.toFixed(2)} step ${PASS2_TAU_STEP}) ---`);
      const pass2Results = runGrid(matches, bMin, bMax, PASS2_BETA_STEP, tMin, tMax, PASS2_TAU_STEP, LAMBDA);
      allPass2.push(...pass2Results);
    }

    allPass2.sort((a, b) => a.adjustedLoss - b.adjustedLoss);
    const top10 = allPass2.slice(0, 10);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n  Two-pass search complete in ${elapsed}s`);

    // --- Results ---
    console.log(`\n  === TOP 10 (lambda=${LAMBDA}) ===\n`);
    console.log(`  ${'Rank'.padEnd(6)} ${'BETA'.padEnd(8)} ${'TAU'.padEnd(8)} ${'RawLoss'.padEnd(12)} ${'Penalty'.padEnd(12)} ${'AdjLoss'.padEnd(12)} ${'WtGames'}`);
    console.log(`  ${'─'.repeat(68)}`);
    for (let i = 0; i < top10.length; i++) {
      const r             = top10[i];
      const weightedGames = r.games.reduce((s, g) => s + g.weight, 0);
      console.log(
        `  ${String(i + 1).padEnd(6)} ${r.BETA.toFixed(2).padEnd(8)} ${r.TAU.toFixed(4).padEnd(8)} ` +
        `${r.totalLoss.toFixed(2).padEnd(12)} ${r.calibPenalty.toFixed(2).padEnd(12)} ` +
        `${r.adjustedLoss.toFixed(2).padEnd(12)} ${weightedGames}`
      );
    }
    console.log(`\n  Default params: BETA=4.17 TAU=0.0833 → rawLoss=${smokeLoss.toFixed(2)} adjLoss=${smokeAdjLoss.toFixed(2)}`);

    // Diagnostics for top 1
    console.log(`\n  === DIAGNOSTIC: Prediction Distribution (Top 1) ===\n`);
    diagBuckets(top10[0].games, `  #1 BETA=${top10[0].BETA} TAU=${top10[0].TAU} (adj=${top10[0].adjustedLoss.toFixed(2)})`);

    // Prediction curves for top 1
    const printBoth = (games, tag) => {
      printPredictionCurve(games, 'fullSpread',  `  [Full team avg] ${tag}`);
      printPredictionCurve(games, 'ratedSpread', `  [Rated only]    ${tag}`);
    };
    console.log(`\n  === PREDICTION CURVES (Top 1) ===`);
    printBoth(top10[0].games, `#1 BETA=${top10[0].BETA} TAU=${top10[0].TAU} (adj=${top10[0].adjustedLoss.toFixed(2)})`);
  }
}

// --- Start ---
rl.on('close', () => runAll());