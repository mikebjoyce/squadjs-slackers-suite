/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                      ELO CALIBRATOR                           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Calibrates TrueSkill parameters (BETA, TAU) against historical
 * match data via grid search, minimising weighted log-loss.
 *
 * Usage: node elo-calibrate.js <matchlog.jsonl> <db-backup.json>
 */

import readline from 'readline';
import fs from 'fs';
import EloCalculator from '../utils/elo-calculator.js';

const jsonlPath = process.argv[2];
const dbPath    = process.argv[3];

if (!jsonlPath || !dbPath) {
  console.error('Usage: node elo-calibrate.js <matchlog.jsonl> <db-backup.json>');
  process.exit(1);
}

// --- Constants ---
const RATED_MIN_GAMES    = 5;
const MIN_RATED_PER_TEAM = 3;

// Grid resolution
const BETA_MIN  = 0.5;
const BETA_MAX  = 30.0;
const BETA_STEP = 0.5;   // coarser on wide pass — refine once we see the plateau
const TAU_MIN   = 0.01;
const TAU_MAX   = 0.50;
const TAU_STEP  = 0.02;  // coarser too — same reason

// Calibration regularisation
// Penalises low prediction variance — counteracts BETA exploiting noisy data by
// collapsing all predictions toward 0.5 (which reduces log-loss mechanically).
// A model predicting 0.5 for everything has zero variance → maximum penalty.
// penalty = LAMBDA / (variance(pTeam1) + EPSILON)
// LAMBDA scales the penalty magnitude; EPSILON prevents division by zero.
const CALIBRATION_LAMBDA  = 200;
const CALIBRATION_EPSILON = 1e-6;

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
function replayMatches(matches, BETA, TAU) {
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

  const avgP         = games.reduce((s, g) => s + g.pTeam1, 0) / games.length;
  const varP         = games.reduce((s, g) => s + Math.pow(g.pTeam1 - avgP, 2), 0) / games.length;
  const calibPenalty = CALIBRATION_LAMBDA / (varP + CALIBRATION_EPSILON);
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

// --- Grid search ---
function gridSearch(matches) {
  const betas = [];
  const taus  = [];

  for (let b = BETA_MIN; b <= BETA_MAX + 1e-9; b += BETA_STEP) betas.push(parseFloat(b.toFixed(2)));
  for (let t = TAU_MIN;  t <= TAU_MAX  + 1e-9; t += TAU_STEP)  taus.push(parseFloat(t.toFixed(4)));

  const total   = betas.length * taus.length;
  const results = [];
  let   n       = 0;

  for (const BETA of betas) {
    for (const TAU of taus) {
      n++;
      process.stdout.write(`\rTesting BETA=${BETA.toFixed(2)} TAU=${TAU.toFixed(4)} (${n}/${total})...`);
      const { totalLoss, adjustedLoss, calibPenalty, games } = replayMatches(matches, BETA, TAU);
      results.push({ BETA, TAU, totalLoss, adjustedLoss, calibPenalty, games });
    }
  }

  process.stdout.write('\n');
  results.sort((a, b) => a.adjustedLoss - b.adjustedLoss);
  return results.slice(0, 10);
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

// --- Main ---
rl.on('close', () => {
  matches.sort((a, b) => a.endedAt - b.endedAt);

  for (const match of matches) {
    const rated1 = match.team1.filter(p => { const d = playerDB.get(p.eosID); return d && d.roundsPlayed >= RATED_MIN_GAMES; });
    const rated2 = match.team2.filter(p => { const d = playerDB.get(p.eosID); return d && d.roundsPlayed >= RATED_MIN_GAMES; });
    match.weight = (rated1.length >= MIN_RATED_PER_TEAM && rated2.length >= MIN_RATED_PER_TEAM) ? 3 : 1;
  }

  const weightedCount = matches.filter(m => m.weight === 3).length;
  console.log(`Loaded ${matches.length} matches, ${playerDB.size} players in DB`);
  console.log(`Weighted: ${weightedCount} rated games (weight=3), ${matches.length - weightedCount} unrated (weight=1)`);

  // Smoke test
  const { totalLoss: smokeLoss, adjustedLoss: smokeAdjLoss, games: smokeGames } = replayMatches(matches, 25 / 6, 25 / 300);
  const smokeAcc = (smokeGames.filter(g => g.correct).length / smokeGames.length * 100).toFixed(1);
  console.log(`\nSmoke test (default params): loss=${smokeLoss.toFixed(4)}, accuracy=${smokeAcc}%`);

  // Grid search
  const numBetas = Math.round((BETA_MAX - BETA_MIN) / BETA_STEP) + 1;
  const numTaus  = Math.round((TAU_MAX  - TAU_MIN)  / TAU_STEP)  + 1;
  console.log(`\nStarting grid search (${numBetas} × ${numTaus} = ${numBetas * numTaus} candidates)...\n`);
  const start   = Date.now();
  const top10   = gridSearch(matches);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nGrid search complete in ${elapsed}s`);

  console.log(`\n=== TOP 10 PARAMETER SETS (sorted by adjusted loss) ===\n`);
  console.log(`${'Rank'.padEnd(6)} ${'BETA'.padEnd(8)} ${'TAU'.padEnd(8)} ${'RawLoss'.padEnd(12)} ${'Penalty'.padEnd(12)} ${'AdjLoss'.padEnd(12)} ${'WtGames'}`);
  console.log('─'.repeat(68));
  for (let i = 0; i < top10.length; i++) {
    const r             = top10[i];
    const weightedGames = r.games.reduce((s, g) => s + g.weight, 0);
    console.log(
      `${String(i + 1).padEnd(6)} ${r.BETA.toFixed(2).padEnd(8)} ${r.TAU.toFixed(4).padEnd(8)} ` +
      `${r.totalLoss.toFixed(2).padEnd(12)} ${r.calibPenalty.toFixed(2).padEnd(12)} ` +
      `${r.adjustedLoss.toFixed(2).padEnd(12)} ${weightedGames}`
    );
  }
  console.log(`\nDefault params: BETA=4.17 TAU=0.0833 → rawLoss=${smokeLoss.toFixed(2)} adjLoss=${smokeAdjLoss.toFixed(2)}`);
  console.log(`Calibration lambda: ${CALIBRATION_LAMBDA}  (penalty = lambda / (variance(pTeam1) + ε))\n`);

  console.log(`\n=== DIAGNOSTIC: Prediction Distribution (Top 1 vs Default) ===\n`);
  diagBuckets(top10[0].games, `#1 BETA=${top10[0].BETA} TAU=${top10[0].TAU} (adj=${top10[0].adjustedLoss.toFixed(2)})`);
  diagBuckets(smokeGames,     `Default BETA=4.17 TAU=0.0833 (adj=${smokeAdjLoss.toFixed(2)})`);

  // Prediction curves — both full-team and rated-only per parameter set
  const printBoth = (games, tag) => {
    printPredictionCurve(games, 'fullSpread',  `  [Full team avg] ${tag}`);
    printPredictionCurve(games, 'ratedSpread', `  [Rated only]    ${tag}`);
  };

  console.log(`\n=== PREDICTION CURVES ===`);
  printBoth(smokeGames, `Default BETA=4.17 TAU=0.0833 (adj=${smokeAdjLoss.toFixed(2)})`);
  for (let i = 0; i < top10.length; i++) {
    const r = top10[i];
    printBoth(r.games, `#${i + 1} BETA=${r.BETA} TAU=${r.TAU} (adj=${r.adjustedLoss.toFixed(2)})`);
  }
});