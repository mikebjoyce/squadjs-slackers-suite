/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                        ELO CALCULATOR                         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Pure math module implementing the TrueSkill rating algorithm for
 * team-based games. Computes per-player mu/sigma deltas for win,
 * loss, and draw outcomes. No external dependencies.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * EloCalculator (default)
 *   Static-only class. All methods and constants are static.
 *     computeTeamUpdate(team1, team2, outcome)
 *       Core update method — returns raw deltaMu/deltaSigma per player,
 *       normalising effective team sizes to prevent variance inflation.
 *     getDefaultRating()
 *       Returns the default { mu, sigma } for a new player.
 *     BETA, DRAW_PROBABILITY
 *       Configurable static constants exposed for external tuning.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * None.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - erf uses Abramowitz & Stegun 7.1.26; erfInv uses the Winitzki
 *   approximation. Both are fast and accurate enough for TrueSkill.
 * - computeTeamUpdate() returns RAW deltas. The caller must scale by
 *   participationRatio before writing to the database.
 * - deltaSigma is a REDUCTION value, applied as:
 *     newSigma = sigma - deltaSigma
   *   Do NOT change the subtraction to addition.
   * - c === 0 guard prevents divide-by-zero when all players have zero
   *   sigma and BETA is also zero (edge case; should not occur in practice).
   * - teamMu is computed as the SUM across players, weighted by their
   *   participationRatio. This prevents transient players from artificially
   *   inflating or deflating the team's perceived strength.
   * - The MU_DEFAULT, SIGMA_DEFAULT, BETA, and TAU constants form a mathematically
   *   interdependent set. If you wish to change the scale of the system,
   *   you must update all constants proportionally.
   *
   * ─── AUTHOR ──────────────────────────────────────────────────────
   *
   * Slacker
   * Discord: real_slacker
   * GitHub:  https://github.com/mikebjoyce/squadjs-elo-tracker
   *
 * ═══════════════════════════════════════════════════════════════
 */

export default class EloCalculator {
  // --- ELO Scale Constants ---
  // WARNING: These constants form an interdependent mathematical set. 
  // The system is designed around a 0-50 skill scale (with 25.0 as the midpoint).
  // If you change ONE of these values, you MUST change all others proportionally.
  // For example, to double the scale to 0-100, multiply ALL of these by 2.
  static MU_DEFAULT = 25.0;              // Base skill estimate for new players
  static SIGMA_DEFAULT = 25.0 / 3.0;     // Initial uncertainty (mu / 3)
  static TAU = 25.0 / 100.0;             // Dynamic uncertainty floor (mu / 100)
  
  static SIGMA_MULTIPLIER = 3.0; // Used for CSR (Competitive Skill Rank) calculation: CSR = mu - 3 * sigma

  // Configurable constants (exposed as static properties)
  // Note: These are immutable for the math engine. Changing these requires 
  // proportional changes to all related constants.
  static BETA = 25.0 / 6.0;              // Skill chain distance (mu / 6). Affects how fast ratings shift.
  static DRAW_PROBABILITY = 0.01;        // Probability of a draw. (1%)

  /**
   * Calculates the probability density function (PDF) of the standard normal distribution.
   * @param {number} x
   * @returns {number}
   */
  static _pdf(x) {
    return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
  }

  /**
   * Calculates the cumulative distribution function (CDF) of the standard normal distribution.
   * Uses the error function approximation.
   * @param {number} x
   * @returns {number}
   */
  static _cdf(x) {
    return 0.5 * (1 + this._erf(x / Math.SQRT2));
  }

  /**
   * Error function (erf) approximation.
   * Source: Abramowitz & Stegun 7.1.26
   * @param {number} x
   * @returns {number}
   */
  static _erf(x) {
    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);

    // Constants for approximation
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const t = 1.0 / (1.0 + p * absX);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

    return sign * y;
  }

  /**
   * Inverse error function (erfInv) approximation.
   * Source: Winitzki approximation
   * @param {number} x
   * @returns {number}
   */
  static _erfInv(x) {
    const a = 0.147; // Constant for Winitzki approximation
    const lnTerm = Math.log(1 - x * x);
    const term1 = 2 / (Math.PI * a) + lnTerm / 2;
    const term2 = lnTerm / a;
    const sign = x < 0 ? -1 : 1;

    return sign * Math.sqrt(Math.sqrt(term1 * term1 - term2) - term1);
  }

  /**
   * Win correction factor (V).
   * @param {number} t
   * @param {number} e Epsilon (draw margin)
   * @returns {number}
   */
  static _v(t, e) {
    const denom = this._cdf(t - e);
    if (denom === 0) return 0; // Prevent division by zero
    return this._pdf(t - e) / denom;
  }

  /**
   * Win variance factor (W).
   * @param {number} t
   * @param {number} e Epsilon (draw margin)
   * @returns {number}
   */
  static _w(t, e) {
    const v = this._v(t, e);
    return v * (v + t - e);
  }

  /**
   * Draw correction factor (V_draw).
   * @param {number} t
   * @param {number} e Epsilon (draw margin)
   * @returns {number}
   */
  static _vDraw(t, e) {
    const absDiff = this._cdf(e - t) - this._cdf(-e - t);
    if (absDiff === 0) return 0;
    return (this._pdf(-e - t) - this._pdf(e - t)) / absDiff;
  }

  /**
   * Draw variance factor (W_draw).
   * @param {number} t
   * @param {number} e Epsilon (draw margin)
   * @returns {number}
   */
  static _wDraw(t, e) {
    const vDraw = this._vDraw(t, e);
    const absDiff = this._cdf(e - t) - this._cdf(-e - t);
    if (absDiff === 0) return vDraw * vDraw;
    
    const term = ((e - t) * this._pdf(e - t) - (-e - t) * this._pdf(-e - t)) / absDiff;
    return vDraw * vDraw + term;
  }

  /**
   * Computes the TrueSkill update for two teams.
   * 
   * @param {Array<{mu: number, sigma: number}>} team1 
   * @param {Array<{mu: number, sigma: number}>} team2 
   * @param {'team1win' | 'team2win' | 'draw'} outcome 
   * @returns {{
   *   team1Updates: Array<{deltaMu: number, deltaSigma: number}>,
   *   team2Updates: Array<{deltaMu: number, deltaSigma: number}>
   * }}
   */
  static computeTeamUpdate(team1, team2, outcome) {
    // Handle edge case: empty teams
    if (team1.length === 0 && team2.length === 0) {
      return { team1Updates: [], team2Updates: [] };
    }

    const getRatio = (p) => p.participationRatio ?? 1.0;

    // NOTE: Design nuance regarding participation ratio weighting:
    // `teamSigmaSq` uses a player's `participationRatio` to scale their contribution to `c`.
    // However, down in the player loop, `deltaMu` is calculated via `(sigmaSq / c) * vVal`,
    // using the player's full `sigmaSq` against the heavily scaled `c`. This effectively
    // gives players with low participation a larger raw TrueSkill update relative to their
    // contribution to `c`. 
    // This is not a critical mathematical flaw since `deltaMu` is scaled down *again* by
    // `participationRatio` in the calling function before writing to the database, meaning
    // the final rating change is still suppressed correctly for transient players.
    // The current implementation is empirically stable and provides smooth convergence, 
    // but developers should be aware of this disparity between `c` and `deltaMu` bases 
    // if attempting to aggressively retune the BETA/TAU constants.

    // Use effective headcount (sum of participation ratios) instead of raw player count
    let effectiveN1 = team1.reduce((sum, p) => sum + getRatio(p), 0);
    let effectiveN2 = team2.reduce((sum, p) => sum + getRatio(p), 0);

    // Normalize effective N to 50 max to prevent disconnected "ghost" players from inflating variance
    // and diluting the TrueSkill reward for active players.
    const scale1 = effectiveN1 > 50.0 ? 50.0 / effectiveN1 : 1.0;
    const scale2 = effectiveN2 > 50.0 ? 50.0 / effectiveN2 : 1.0;

    effectiveN1 *= scale1;
    effectiveN2 *= scale2;

    // Step 1: Team summary stats
    // teamMu = sum of all fractional player mu values (scaled to max 50 slots)
    const teamMu1 = team1.reduce((sum, p) => sum + (p.mu * getRatio(p)), 0) * scale1;
    const teamMu2 = team2.reduce((sum, p) => sum + (p.mu * getRatio(p)), 0) * scale2;

    // teamSigmaSq = sum of all fractional player variances (scaled to max 50 slots)
    const teamSigmaSq1 = team1.reduce((sum, p) => sum + ((p.sigma * p.sigma + this.BETA * this.BETA) * getRatio(p)), 0) * scale1;
    const teamSigmaSq2 = team2.reduce((sum, p) => sum + ((p.sigma * p.sigma + this.BETA * this.BETA) * getRatio(p)), 0) * scale2;

    // Step 2: Performance delta
    const c = Math.sqrt(teamSigmaSq1 + teamSigmaSq2);

    if (c === 0) {
      // Should not happen if teams have players with non-zero sigma or beta
      return {
        team1Updates: team1.map(() => ({ deltaMu: 0, deltaSigma: 0, vVal: 0, wVal: 0 })),
        team2Updates: team2.map(() => ({ deltaMu: 0, deltaSigma: 0, vVal: 0, wVal: 0 }))
      };
    }

    // Epsilon (draw margin).
    const nTotal = effectiveN1 + effectiveN2;
    const epsilon = Math.sqrt(nTotal) * this.BETA * Math.sqrt(2) * this._erfInv(this.DRAW_PROBABILITY);

    // t = (teamMu_winner - teamMu_loser) / c
    // We calculate t relative to team1 vs team2, then adjust signs based on outcome.
    // tRaw = (Mu1 - Mu2) / c
    const tRaw = (teamMu1 - teamMu2) / c;

    // Helper to compute per-player update
    const computePlayerUpdate = (player, isTeam1) => {
      const sigmaSq = player.sigma * player.sigma;
      const betaSq = this.BETA * this.BETA;

      let vVal, wVal;
      let isWinner;

      if (outcome === 'draw') {
        // Draw: vDraw handles sign internally.
        // t for team1 is tRaw. t for team2 is -tRaw.
        const t = isTeam1 ? tRaw : -tRaw;
        vVal = this._vDraw(t, epsilon / c);
        wVal = this._wDraw(t, epsilon / c);
        isWinner = null; // not applicable for draws
      } else {
        // For win/loss: compute t from the WINNER's perspective only.
        // Both winner and loser use the same vVal and wVal.
        // The loser's deltaMu is negated afterward via isWinner flag.
        let tWinner;
        if (outcome === 'team1win') {
          tWinner = tRaw; // tRaw = (Mu1 - Mu2) / c, positive if team1 stronger
          isWinner = isTeam1;
        } else {
          tWinner = -tRaw; // flip: (Mu2 - Mu1) / c, positive if team2 stronger
          isWinner = !isTeam1;
        }
        vVal = this._v(tWinner, epsilon / c);
        wVal = this._w(tWinner, epsilon / c);
      }

      // deltaMu:
      // Win/loss: same v(t_winner) magnitude for both teams. Sign flipped for loser.
      // Draw: vDraw(t) handles sign internally — negative for higher-ranked team.
      let deltaMu = (sigmaSq / c) * vVal;

      if (outcome !== 'draw') {
        // Winner gets +deltaMu, loser gets -deltaMu.
        // vVal is always positive for win/loss outcomes.
        if (!isWinner) deltaMu = -deltaMu;
      }
      // For draws: vDraw returns negative for higher-ranked team automatically.
      // No manual sign flip needed.

      // deltaSigma (factor) = (sigma_i²) / c² * w(t, epsilon/c)
      const deltaSigmaFactor = (sigmaSq / (c * c)) * wVal;
      // Clamp to prevent negative value inside sqrt if wVal is unexpectedly large.
      const safeDeltaSigmaFactor = Math.min(deltaSigmaFactor, 1 - 1e-10);

      // newSigma_i = sqrt( (sigma_i²) * (1 - deltaSigma) + tau² )
      const newSigma = Math.sqrt(sigmaSq * (1 - safeDeltaSigmaFactor) + this.TAU * this.TAU);

      // Return raw deltas (unscaled — caller applies participationRatio before writing to DB).
      // Positive deltaMu = rating increase.
      // deltaSigma = player.sigma - newSigma.
      //   Positive value means sigma DECREASED (more confident).
      //   Applied in elo-tracker.js as:
      //     const scaledDeltaSigma = deltaSigma * participationRatio;
      //     const newSigma = Math.max(rating.sigma - scaledDeltaSigma, 0.5);
      //   Subtraction is intentional — do NOT change to addition.
      return {
        deltaMu: deltaMu,
        deltaSigma: player.sigma - newSigma,
        vVal: vVal,
        wVal: wVal
      };
    };

    const team1Updates = team1.map(p => computePlayerUpdate(p, true));
    const team2Updates = team2.map(p => computePlayerUpdate(p, false));
    
    // Grab the first vVal / wVal just for diagnostic debug output
    const vVal = team1Updates.length > 0 ? team1Updates[0].vVal : 0;
    const wVal = team1Updates.length > 0 ? team1Updates[0].wVal : 0;

    return { 
      team1Updates, 
      team2Updates,
      debug: {
        teamMu1, teamMu2,
        teamSigmaSq1, teamSigmaSq2,
        c,
        effectiveN1, effectiveN2,
        nTotal,
        epsilon,
        tRaw,
        vVal,
        wVal
      }
    };
  }

  /**
   * Returns the default rating for a new player.
   * @returns {{mu: number, sigma: number}}
   */
  static getDefaultRating() {
    return {
      mu: this.MU_DEFAULT,
      sigma: this.SIGMA_DEFAULT
    };
  }
}