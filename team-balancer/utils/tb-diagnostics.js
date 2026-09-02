/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                   SELF-DIAGNOSTICS SUITE                      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Runs integrity checks against the live plugin instance. Verifies
 * S³ database connectivity (reachability + table count) and performs
 * a live dry-run scramble simulation against the current server
 * population.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 * 
 * TBDiagnostics (named)
 *   Class. Instantiate with a TeamBalancer instance.
 *     runAll()              — Runs all tests; returns Array<{ name, pass, message }>.
 *     testS3Integration()   — S³ DB reachability + model count check.
 *     testScrambler()       — Live scramble dry-run against current server state.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Logger (../../core/logger.js)
 *   Verbose logging for test failures.
 * Scrambler (./tb-scrambler.js)
 *   Invoked directly for the dry-run scramble test.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - testS3Integration() replaces the old testDatabase() (which tried
 *   to access a non-existent model path on the S³ compatibility wrapper)
 *   and the synthetic concurrency test (which was always skipped).
 * - testScrambler() is skipped (not failed) if server population
 *   is below 10 players. Result message reflects the skip reason.
 * - Triggered by !teambalancer diag in-game or via Discord.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Logger from '../../core/logger.js';
import Scrambler from './tb-scrambler.js';

export class TBDiagnostics {
  constructor(teamBalancer) {
    this.tb = teamBalancer;
    this.results = [];
  }

  async runAll() {
    await this.testS3Integration();
    await this.testScrambler();
    return this.results;
  }

  async testS3Integration() {
    const result = {
      // Stable across languages: tb-commands.js picks this result out of the
      // array by id. Matching on the localized name broke the moment the name
      // was translated and the comparison was not.
      id: 's3Integration',
      name: this.tb.localize('teamBalancer.status.sIntegration'),
      pass: false,
      message: this.tb.localize('teamBalancer.diagnostics.notRun')
    };
    try {
      const s3db = this.tb.s3db;
      if (!s3db || !s3db.isReady()) {
        throw new Error(this.tb.localize('teamBalancer.diagnostics.s3NotReachable'));
      }

      // Quick connectivity check — query the model count
      const modelNames = Object.keys(s3db.models || {});
      const tbModelNames = modelNames.filter(n => n.startsWith('TeamBalancer') || n.startsWith('TB_'));

      // Verify at least one TB model exists
      if (!tbModelNames.length) {
        throw new Error(this.tb.localize('teamBalancer.diagnostics.noTbModels'));
      }

      // Spot-check: query TeamBalancerState to confirm read works
      const stateModel = s3db.models['TeamBalancerState'];
      if (stateModel) {
        const count = await s3db.withTransactionWithRetry(async () => {
          return await stateModel.count();
        });
      }

      const tableCount = tbModelNames.length;
      result.pass = true;
      result.message = this.tb.localize(
        tableCount === 1 ? 'teamBalancer.diagnostics.s3PassOneTable' : 'teamBalancer.diagnostics.s3PassTables',
        { tableCount }
      );
    } catch (err) {
      result.pass = false;
      result.message = this.tb.localize('teamBalancer.diagnostics.fail', { error: err.message });
      Logger.verbose('TeamBalancer', 1, `[Diagnostics] S³ Integration test failed: ${err.message}`);
    }
    this.results.push(result);
  }

  async testScrambler() {
    const result = {
      id: 'scrambler',
      name: this.tb.localize('teamBalancer.status.liveScrambleTest'),
      pass: false,
      message: this.tb.localize('teamBalancer.diagnostics.notRun')
    };
    try {
      const { squads, players } = this.tb.transformSquadJSData(
        this.tb.server.squads,
        this.tb.server.players
      );

      if (players.length < 10) {
        result.pass = true; // Not a failure, just not enough players
        result.message = this.tb.localize('teamBalancer.diagnostics.skippedTooFewPlayers', { value: players.length });
        this.results.push(result);
        return;
      }

      const swapPlan = await Scrambler.scrambleTeamsPreservingSquads({
        squads,
        players,
        winStreakTeam: this.tb.winStreakTeam,
        scramblePercentage: this.tb.options.scramblePercentage,
      });

      if (swapPlan && Array.isArray(swapPlan)) {
        result.pass = true;
        result.message = this.tb.localize('teamBalancer.diagnostics.scramblerSuccess', { value: swapPlan.length });
      } else {
        throw new Error(this.tb.localize('teamBalancer.diagnostics.noValidSwapPlan'));
      }
    } catch (err) {
      result.pass = false;
      result.message = this.tb.localize('teamBalancer.diagnostics.fail', { error: err.message });
      Logger.verbose('TeamBalancer', 1, `[Diagnostics] Scrambler test failed: ${err.message}`);
    }
    this.results.push(result);
  }
}