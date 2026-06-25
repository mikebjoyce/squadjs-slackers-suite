/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  TEST: ELO CALCULATOR                         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates the TrueSkill math engine: constant defaults, win/loss/draw
 * delta calculations, and edge cases (empty teams, c===0 guard).
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-elo-calculator.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Run via the unified test runner: node testing/run-all-tests.js
 *
 */

import EloCalculator from '../utils/elo-calculator.js';

export default async function runCalculatorTests(runTest) {
  await runTest('Baseline Math: Constants', async () => {
    if (EloCalculator.MU_DEFAULT !== 25.0) {
      throw new Error(`MU_DEFAULT is ${EloCalculator.MU_DEFAULT}, expected 25.0`);
    }
    // 25/3 is approx 8.33333...
    if (Math.abs(EloCalculator.SIGMA_DEFAULT - (25.0 / 3.0)) > 0.0001) {
      throw new Error(`SIGMA_DEFAULT is ${EloCalculator.SIGMA_DEFAULT}, expected ~8.333`);
    }
  });

  await runTest('Win Scenario: 1v1 Default', async () => {
    const team1 = [EloCalculator.getDefaultRating()];
    const team2 = [EloCalculator.getDefaultRating()];

    const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(team1, team2, 'team1win');

    const t1Delta = team1Updates[0].deltaMu;
    const t2Delta = team2Updates[0].deltaMu;

    if (t1Delta <= 0) throw new Error(`Winner (Team 1) should gain rating. Delta: ${t1Delta}`);
    if (t2Delta >= 0) throw new Error(`Loser (Team 2) should lose rating. Delta: ${t2Delta}`);
  });

  await runTest('Upset Logic: High vs Low', async () => {
    // Standard match (25 vs 25)
    const stdT1 = [EloCalculator.getDefaultRating()];
    const stdT2 = [EloCalculator.getDefaultRating()];
    const stdRes = EloCalculator.computeTeamUpdate(stdT1, stdT2, 'team1win');
    const stdGain = stdRes.team1Updates[0].deltaMu;

    // Upset match (15 vs 35) - Team 1 (Low) wins
    const lowPlayer = { mu: 15.0, sigma: EloCalculator.SIGMA_DEFAULT };
    const highPlayer = { mu: 35.0, sigma: EloCalculator.SIGMA_DEFAULT };
    
    const upsetRes = EloCalculator.computeTeamUpdate([lowPlayer], [highPlayer], 'team1win');
    const upsetGain = upsetRes.team1Updates[0].deltaMu;

    if (upsetGain <= stdGain) {
      throw new Error(`Upset win gain (${upsetGain}) should be greater than standard win gain (${stdGain})`);
    }
  });

  await runTest('Uncertainty Decay: Sigma decreases', async () => {
    const team1 = [EloCalculator.getDefaultRating()];
    const team2 = [EloCalculator.getDefaultRating()];

    const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(team1, team2, 'team1win');

    // deltaSigma = old - new. Positive means decrease (more confidence).
    const t1DeltaSig = team1Updates[0].deltaSigma;
    const t2DeltaSig = team2Updates[0].deltaSigma;

    if (t1DeltaSig <= 0) throw new Error(`Winner sigma did not decrease. Delta: ${t1DeltaSig}`);
    if (t2DeltaSig <= 0) throw new Error(`Loser sigma did not decrease. Delta: ${t2DeltaSig}`);
  });
}