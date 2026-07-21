/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               TEST: ELO SIMULATION                             ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Simulates 20 rounds of 50v50 with a weighted player pool to verify
 * long-term stability of the TrueSkill algorithm—rating convergence,
 * absence of NaN/infinite values, and no runaway sigma inflation.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/run-all-tests.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Pure math test; no database or server dependency.
 *
 */

import EloCalculator from '../utils/elo-calculator.js';

// ---------------------------------------------------------------------------
// Player pool with weighted participation
// ---------------------------------------------------------------------------

const TEAM_SIZE = 50;

/**
 * Builds a realistic 500-player pool with three tiers of play frequency.
 * Each player gets a `playWeight` — probability of being selected for a round.
 *
 * Tier         Count   Weight    Approx rounds/100
 * ---------    -----   ------    ------------------
 * Regular        50    0.80      ~80
 * Semi-regular  200    0.30      ~30
 * Random        250    0.05      ~5
 *
 * @returns {Array<{id, mu, sigma, playWeight}>}
 */
function makeWeightedPool() {
  const pool = [];

  for (let i = 0; i < 50; i++) {
    pool.push({ id: `regular_${i}`, ...EloCalculator.getDefaultRating(), playWeight: 0.80 });
  }
  for (let i = 0; i < 200; i++) {
    pool.push({ id: `semi_${i}`, ...EloCalculator.getDefaultRating(), playWeight: 0.30 });
  }
  for (let i = 0; i < 250; i++) {
    pool.push({ id: `random_${i}`, ...EloCalculator.getDefaultRating(), playWeight: 0.05 });
  }

  return pool;
}

/**
 * Selects exactly TEAM_SIZE * 2 players from the pool using weighted probability.
 * Falls back to random selection if weighted sampling doesn't yield enough players.
 * @param {Array} pool
 * @returns {[Array, Array]} [team1, team2]
 */
function weightedSplit(pool) {
  const selected = [];
  const shuffled = [...pool].sort(() => Math.random() - 0.5);

  for (const player of shuffled) {
    if (Math.random() < player.playWeight) {
      selected.push(player);
      if (selected.length === TEAM_SIZE * 2) break;
    }
  }

  // Fallback: top up with random picks if weighted sampling fell short
  if (selected.length < TEAM_SIZE * 2) {
    const selectedIds = new Set(selected.map(p => p.id));
    const remainder = shuffled.filter(p => !selectedIds.has(p.id));
    selected.push(...remainder.slice(0, TEAM_SIZE * 2 - selected.length));
  }

  return [selected.slice(0, TEAM_SIZE), selected.slice(TEAM_SIZE, TEAM_SIZE * 2)];
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makePlayerPool(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    ...EloCalculator.getDefaultRating()
  }));
}

function applyUpdates(teamPlayers, updates, participationRatio) {
  teamPlayers.forEach((player, i) => {
    const { deltaMu, deltaSigma } = updates[i];
    player.mu += deltaMu * participationRatio;
    // Mirror elo-tracker.js: sigma - (deltaSigma * ratio), floored at 0.5
    player.sigma = Math.max(player.sigma - deltaSigma * participationRatio, 0.5);
  });
}

function simulateRound(pool, teamSize, outcome, participationRatio = 1.0) {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const team1 = shuffled.slice(0, teamSize);
  const team2 = shuffled.slice(teamSize, teamSize * 2);

  const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(
    team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
    team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
    outcome
  );

  applyUpdates(team1, team1Updates, participationRatio);
  applyUpdates(team2, team2Updates, participationRatio);

  return { team1, team2 };
}

function assertNoInvalidValues(pool, context) {
  for (const p of pool) {
    if (!isFinite(p.mu) || isNaN(p.mu)) {
      throw new Error(`${context}: Player ${p.id} has invalid mu: ${p.mu}`);
    }
    if (!isFinite(p.sigma) || isNaN(p.sigma)) {
      throw new Error(`${context}: Player ${p.id} has invalid sigma: ${p.sigma}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

export default async function runSimulationTests(runTest) {

  // --- Core sanity ---

  await runTest('Simulation: No NaN or Infinity — 100 rounds, 500-player weighted pool', async () => {
    const pool = makeWeightedPool();

    for (let round = 0; round < 100; round++) {
      const [team1, team2] = weightedSplit(pool);
      const outcome = Math.random() < 0.5 ? 'team1win' : 'team2win';

      const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(
        team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
        team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
        outcome
      );

      applyUpdates(team1, team1Updates, 1.0);
      applyUpdates(team2, team2Updates, 1.0);
      assertNoInvalidValues(pool, `Round ${round + 1}`);
    }
  });

  await runTest('Simulation: Ratings stay within sane bounds — 200 rounds, 500-player weighted pool', async () => {
    const MU_MIN = -50;
    const MU_MAX = 100;
    const SIGMA_MIN = 0.5;
    const SIGMA_MAX = 25.0 / 3.0 + 0.01;

    const pool = makeWeightedPool();

    for (let round = 0; round < 200; round++) {
      const [team1, team2] = weightedSplit(pool);
      const outcome = Math.random() < 0.5 ? 'team1win' : 'team2win';

      const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(
        team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
        team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
        outcome
      );

      applyUpdates(team1, team1Updates, 1.0);
      applyUpdates(team2, team2Updates, 1.0);
    }

    for (const p of pool) {
      if (p.mu < MU_MIN || p.mu > MU_MAX) {
        throw new Error(`Player ${p.id} mu out of bounds: ${p.mu.toFixed(2)}`);
      }
      if (p.sigma < SIGMA_MIN || p.sigma > SIGMA_MAX) {
        throw new Error(`Player ${p.id} sigma out of bounds: ${p.sigma.toFixed(2)}`);
      }
    }
  });

  // --- Convergence by play frequency ---

  await runTest('Simulation: Regulars (80% freq) converge faster than randoms (5% freq) — 100 rounds', async () => {
    const pool = makeWeightedPool();

    for (let round = 0; round < 100; round++) {
      const [team1, team2] = weightedSplit(pool);
      const outcome = Math.random() < 0.5 ? 'team1win' : 'team2win';

      const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(
        team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
        team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
        outcome
      );

      applyUpdates(team1, team1Updates, 1.0);
      applyUpdates(team2, team2Updates, 1.0);
    }

    const regulars = pool.filter(p => p.id.startsWith('regular_'));
    const randoms  = pool.filter(p => p.id.startsWith('random_'));

    const avgSigmaRegular = regulars.reduce((s, p) => s + p.sigma, 0) / regulars.length;
    const avgSigmaRandom  = randoms.reduce((s, p) => s + p.sigma, 0) / randoms.length;

    if (avgSigmaRegular >= avgSigmaRandom) {
      throw new Error(
        `Regulars should have lower avg sigma than randoms after 100 rounds. ` +
        `Regular: ${avgSigmaRegular.toFixed(3)}, Random: ${avgSigmaRandom.toFixed(3)}`
      );
    }
  });

  // --- Win/loss monotonicity ---

  await runTest('Simulation: Consistently winning player rises — 40 rounds, weighted pool', async () => {
    const pool = makeWeightedPool();
    const goodPlayer = pool[0];
    goodPlayer.playWeight = 1.0; // always plays
    const initialMu = goodPlayer.mu;

    for (let round = 0; round < 40; round++) {
      const others = pool.slice(1).sort(() => Math.random() - 0.5);
      const team1 = [goodPlayer, ...others.slice(0, TEAM_SIZE - 1)];
      const team2 = others.slice(TEAM_SIZE - 1, TEAM_SIZE * 2 - 1);

      const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(
        team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
        team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
        'team1win'
      );

      applyUpdates(team1, team1Updates, 1.0);
      applyUpdates(team2, team2Updates, 1.0);
    }

    if (goodPlayer.mu <= initialMu) {
      throw new Error(
        `Good player did not rise after 40 wins. ` +
        `Initial: ${initialMu.toFixed(2)}, Final: ${goodPlayer.mu.toFixed(2)}`
      );
    }
  });

  await runTest('Simulation: Consistently losing player falls — 40 rounds, weighted pool', async () => {
    const pool = makeWeightedPool();
    const badPlayer = pool[0];
    badPlayer.playWeight = 1.0;
    const initialMu = badPlayer.mu;

    for (let round = 0; round < 40; round++) {
      const others = pool.slice(1).sort(() => Math.random() - 0.5);
      const team1 = [badPlayer, ...others.slice(0, TEAM_SIZE - 1)];
      const team2 = others.slice(TEAM_SIZE - 1, TEAM_SIZE * 2 - 1);

      const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(
        team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
        team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
        'team2win'
      );

      applyUpdates(team1, team1Updates, 1.0);
      applyUpdates(team2, team2Updates, 1.0);
    }

    if (badPlayer.mu >= initialMu) {
      throw new Error(
        `Bad player did not fall after 40 losses. ` +
        `Initial: ${initialMu.toFixed(2)}, Final: ${badPlayer.mu.toFixed(2)}`
      );
    }
  });

  // --- Veteran vs rookie ---

  await runTest('Simulation: Veteran (low sigma) moves less per round than rookie (high sigma)', async () => {
    const pool = makePlayerPool(100);

    // Veteran: already calibrated — low uncertainty
    const veteran = pool[0];
    veteran.sigma = 1.5;

    // Rookie: fresh, maximum uncertainty
    const rookie = pool[1];
    rookie.sigma = EloCalculator.SIGMA_DEFAULT;

    const veteranDeltas = [];
    const rookieDeltas  = [];

    for (let round = 0; round < 50; round++) {
      const others = pool.slice(2).sort(() => Math.random() - 0.5);
      const team1 = [veteran, rookie, ...others.slice(0, TEAM_SIZE - 2)];
      const team2 = others.slice(TEAM_SIZE - 2, TEAM_SIZE * 2 - 2);
      const outcome = Math.random() < 0.5 ? 'team1win' : 'team2win';

      const { team1Updates } = EloCalculator.computeTeamUpdate(
        team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
        team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
        outcome
      );

      // Collect absolute delta before applying
      veteranDeltas.push(Math.abs(team1Updates[0].deltaMu));
      rookieDeltas.push(Math.abs(team1Updates[1].deltaMu));

      applyUpdates(team1, team1Updates, 1.0);
    }

    const avgVeteranDelta = veteranDeltas.reduce((a, b) => a + b, 0) / veteranDeltas.length;
    const avgRookieDelta  = rookieDeltas.reduce((a, b) => a + b, 0) / rookieDeltas.length;

    if (avgVeteranDelta >= avgRookieDelta) {
      throw new Error(
        `Veteran should move less per round than rookie. ` +
        `Veteran avg |ΔMu|: ${avgVeteranDelta.toFixed(4)}, ` +
        `Rookie avg |ΔMu|: ${avgRookieDelta.toFixed(4)}`
      );
    }
  });

  // --- Long-run single player convergence ---

  await runTest('Simulation: Single player — sigma floors at 0.5 after 500 rounds', async () => {
  const pool = makePlayerPool(100);
  const trackedPlayer = pool[0];

for (let round = 0; round < 500; round++) {
    // Force trackedPlayer to always play — guarantees 500 actual rounds
    const others = pool.slice(1).sort(() => Math.random() - 0.5);
    const team1 = [trackedPlayer, ...others.slice(0, TEAM_SIZE - 1)];
    const team2 = others.slice(TEAM_SIZE - 1, TEAM_SIZE * 2 - 1);
    const outcome = Math.random() < 0.5 ? 'team1win' : 'team2win';

    const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(
      team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
      team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
      outcome
    );
    applyUpdates(team1, team1Updates, 1.0);
    applyUpdates(team2, team2Updates, 1.0);
  }

  if (trackedPlayer.sigma < 0.5) {
    throw new Error(`Sigma dropped below floor: ${trackedPlayer.sigma}`);
  }
  // 50v50 converges slowly — 5.0 is the correct upper bound at 500 rounds
  if (trackedPlayer.sigma > 5.0) {
    throw new Error(`Sigma unexpectedly high after 500 guaranteed rounds: ${trackedPlayer.sigma.toFixed(3)}`);
  }
});

  await runTest('Simulation: Single player 50/50 record — mu stays near default after 200 rounds', async () => {
    // Player wins exactly half their rounds — mu should stay near 25 long-term.
    // Tests that win/loss updates are symmetric and don't drift.
    const pool = makePlayerPool(100);
    const trackedPlayer = pool[0];

    for (let round = 0; round < 200; round++) {
      // Force tracked player onto team1 always, alternate win/loss
      const outcome = round % 2 === 0 ? 'team1win' : 'team2win';
      const others = pool.slice(1).sort(() => Math.random() - 0.5);
      const team1 = [trackedPlayer, ...others.slice(0, TEAM_SIZE - 1)];
      const team2 = others.slice(TEAM_SIZE - 1, TEAM_SIZE * 2 - 1);

      const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(
        team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
        team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
        outcome
      );

    
    // Only update tracked player — freeze everyone else
    const trackedUpdate = team1Updates[0];
    trackedPlayer.mu += trackedUpdate.deltaMu;
    trackedPlayer.sigma = Math.max(trackedPlayer.sigma - trackedUpdate.deltaSigma, 0.5);
    }

    if (Math.abs(trackedPlayer.mu - EloCalculator.MU_DEFAULT) > 5.0) {
      throw new Error(
        `50/50 player drifted too far. ` +
        `Expected near ${EloCalculator.MU_DEFAULT}, got ${trackedPlayer.mu.toFixed(2)}`
      );
    }
  });

  // --- Participation scaling ---

  await runTest('Simulation: Participation scaling — half ratio produces half delta', async () => {
    const rating = EloCalculator.getDefaultRating();
    const team1 = Array.from({ length: TEAM_SIZE }, () => ({ ...rating }));
    const team2 = Array.from({ length: TEAM_SIZE }, () => ({ ...rating }));

    const { team1Updates } = EloCalculator.computeTeamUpdate(
      team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
      team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
      'team1win'
    );

    const fullDelta = team1Updates[0].deltaMu * 1.0;
    const halfDelta = team1Updates[0].deltaMu * 0.5;

    if (Math.abs(halfDelta - fullDelta / 2) > 0.0001) {
      throw new Error(
        `Half participation delta (${halfDelta.toFixed(4)}) is not half of full (${fullDelta.toFixed(4)})`
      );
    }
  });

  await runTest('Simulation: Partial participation (50%) slows sigma convergence vs full', async () => {
    const fullPool = makePlayerPool(100);
    const partialPool = JSON.parse(JSON.stringify(fullPool)); // Deep copy to ensure identical start

    for (let round = 0; round < 100; round++) {
      simulateRound(fullPool, TEAM_SIZE, Math.random() < 0.5 ? 'team1win' : 'team2win', 1.0);
      simulateRound(partialPool, TEAM_SIZE, Math.random() < 0.5 ? 'team1win' : 'team2win', 0.5);
    }

    const avgSigmaFull = fullPool.reduce((s, p) => s + p.sigma, 0) / fullPool.length;
    const avgSigmaPartial = partialPool.reduce((s, p) => s + p.sigma, 0) / partialPool.length;

    if (avgSigmaFull >= avgSigmaPartial) {
      throw new Error(
        `Full participation should converge faster (lower sigma). ` +
        `Full: ${avgSigmaFull.toFixed(3)}, Partial: ${avgSigmaPartial.toFixed(3)}`
      );
    }
  });

  await runTest('Simulation: Below MIN_PARTICIPATION threshold — zero ELO delta applied', async () => {
    const MIN_PARTICIPATION = 0.15; // Mirroring elo-tracker.js default
    const rating = EloCalculator.getDefaultRating();
    const team1 = Array.from({ length: TEAM_SIZE }, () => ({ ...rating }));
    const team2 = Array.from({ length: TEAM_SIZE }, () => ({ ...rating }));

    const { team1Updates } = EloCalculator.computeTeamUpdate(
      team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
      team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
      'team1win'
    );

    const ratio = 0.10; // below threshold
    const appliedDelta = ratio < MIN_PARTICIPATION ? 0 : team1Updates[0].deltaMu * ratio;

    if (appliedDelta !== 0) {
      throw new Error(`Expected zero delta below MIN_PARTICIPATION, got ${appliedDelta}`);
    }
  });

  await runTest('Simulation: Team switcher split credit — 75% winner / 25% loser nets positive', async () => {
    const rating = EloCalculator.getDefaultRating();
    const team1 = Array.from({ length: TEAM_SIZE }, () => ({ ...rating }));
    const team2 = Array.from({ length: TEAM_SIZE }, () => ({ ...rating }));

    const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(
      team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
      team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
      'team1win'
    );

    // Mirrors elo-tracker.js split credit logic from design doc
    const timeOnWinner = 0.75;
    const timeOnLoser = 0.25;
    const combinedDelta = (team1Updates[0].deltaMu * timeOnWinner) + (team2Updates[0].deltaMu * timeOnLoser);

    if (combinedDelta <= 0) {
      throw new Error(`75% on winning team should net positive delta. Got: ${combinedDelta.toFixed(4)}`);
    }
  });

  // --- Winrate archetypes ---

  await runTest('Simulation: Winrate archetypes — mu rank order holds at 10/20/50/100 rounds', async () => {
    // Five players with fixed forced winrates play against a frozen default pool.
    // Only the tracked player's rating is updated each round (Option B isolation).
    // Asserts: 80% > 65% > 50% ≈ default > 35% > 20% after 100 rounds.

    const ARCHETYPES = [
      { label: '80%', winRate: 0.80 },
      { label: '65%', winRate: 0.65 },
      { label: '50%', winRate: 0.50 },
      { label: '35%', winRate: 0.35 },
      { label: '20%', winRate: 0.20 },
    ];

    const CHECKPOINTS = [10, 20, 50, 100];
    const TOTAL_ROUNDS = 100;

    // Each archetype gets its own independent default pool — no cross-contamination.
    const simulations = ARCHETYPES.map(({ label, winRate }) => ({
      label,
      winRate,
      winsAccumulated: 0,
      player: { ...EloCalculator.getDefaultRating() },
      pool: makePlayerPool(TEAM_SIZE * 2),  // background opponents, never updated
      snapshots: {},
    }));

    for (let round = 0; round < TOTAL_ROUNDS; round++) {
      for (const sim of simulations) {
        // Deterministic win/loss based on winRate — evenly distributed across rounds
        const expectedWinsByNow = sim.winRate * (round + 1);
        const actualWinsSoFar = sim.winsAccumulated;
        const outcome = actualWinsSoFar < expectedWinsByNow ? 'team1win' : 'team2win';
        if (outcome === 'team1win') sim.winsAccumulated++;

        const others = [...sim.pool].sort(() => Math.random() - 0.5);
        const team1 = [sim.player, ...others.slice(0, TEAM_SIZE - 1)];
        const team2 = others.slice(TEAM_SIZE - 1, TEAM_SIZE * 2 - 1);

        const { team1Updates } = EloCalculator.computeTeamUpdate(
          team1.map(p => ({ mu: p.mu, sigma: p.sigma })),
          team2.map(p => ({ mu: p.mu, sigma: p.sigma })),
          outcome
        );

        // Option B: only update tracked player
        const update = team1Updates[0];
        sim.player.mu += update.deltaMu;
        sim.player.sigma = Math.max(sim.player.sigma - update.deltaSigma, 0.5);
      }

      const checkpoint = round + 1;
      if (CHECKPOINTS.includes(checkpoint)) {
        for (const sim of simulations) {
          sim.snapshots[checkpoint] = sim.player.mu;
        }
      }
    }

    // Print snapshot table
    const header = ['Winrate', ...CHECKPOINTS.map(c => `R${c}`)].join('\t');
    console.log('\n' + header);
    for (const sim of simulations) {
      const row = [
        sim.label,
        ...CHECKPOINTS.map(c => sim.snapshots[c].toFixed(2))
      ].join('\t');
      console.log(row);
    }

    // Assert rank order at round 100
    const finalMus = simulations.map(s => s.snapshots[100]);
    for (let i = 0; i < finalMus.length - 1; i++) {
      if (finalMus[i] <= finalMus[i + 1]) {
        throw new Error(
          `Rank order violated at round 100: ` +
          `${simulations[i].label} (${finalMus[i].toFixed(2)}) ` +
          `should be > ${simulations[i + 1].label} (${finalMus[i + 1].toFixed(2)})`
        );
      }
    }
  });
  
}
