/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               TEST RUNNER: ALL TESTS                          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Unified test runner that discovers and executes all test suites
 * in the testing/ directory. Provides a runTest helper with pass/fail
 * logging and aggregates results from every suite.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/run-all-tests.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - No live SquadJS server is required. test-elo-database.js runs its full
 *   battery against real SQLite (always) and real MySQL (opportunistically,
 *   127.0.0.1:3307 — see s3/S3_DEVELOPER_GUIDE.md §11.4). This runner passes
 *   suites a `runSkip` helper alongside `runTest` so MySQL cases can report
 *   as skipped, not passed, when the container is down — see the Skipped
 *   line in the summary below, and never call a run "green" without reading it.
 *
 * ─── A SUITE THAT FAILS TO LOAD IS A FAILURE ─────────────────────
 *
 * This runner used to catch ERR_MODULE_NOT_FOUND, print "Skipped", and exit
 * 0. Two of five suites had been silently skipped that way for some time —
 * test-elo-tracker.js could not resolve './s3-plugin-base.js' and
 * test-clan-grouping.js pointed at the wrong directory — while the runner
 * reported a clean run. That is worse than no runner at all, because it
 * actively asserts coverage that does not exist.
 *
 * A suite that cannot be loaded is now counted as a failure and sets a
 * non-zero exit code, same as an assertion that throws. If a suite genuinely
 * needs to opt out of a run, it must say so itself, per-case, in its own
 * output — never by failing to import.
 *
 */

import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const COLORS = {
  RESET: '\x1b[0m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m'
};

/**
 * Helper to execute a test case with logging.
 * @param {string} name - The name of the test case.
 * @param {Function} fn - The async test function.
 */
export async function runTest(name, fn) {
  process.stdout.write(`  • ${name}... `);
  try {
    await fn();
    console.log(`${COLORS.GREEN}[PASS]${COLORS.RESET}`);
    return { passed: true, error: null };
  } catch (err) {
    console.log(`${COLORS.RED}[FAIL]${COLORS.RESET}`);
    console.error(err.stack || err);
    return { passed: false, error: err.message || String(err) };
  }
}

/**
 * Companion to runTest for a case that cannot run at all (e.g. an engine
 * that isn't reachable) rather than one that ran and failed. Must never be
 * folded into the passed count — a suite that does that reports a green
 * run having never actually exercised the unreachable engine.
 */
export async function runSkip(name, reason) {
  console.log(`  ⊘ ${name}... ${COLORS.YELLOW}[SKIP]${COLORS.RESET} (${reason})`);
  return { skipped: true, reason };
}

/**
 * Main runner that executes all defined test suites.
 */
export async function runAll() {
  console.log(`${COLORS.CYAN}=== EloTracker Test Runner ===${COLORS.RESET}\n`);

  const suites = [
    { name: 'EloCalculator', file: './test-elo-calculator.js' },
    { name: 'EloSessionManager', file: './test-elo-session-manager.js' },
    { name: 'EloClanGrouping', file: './test-clan-grouping.js' },
    { name: 'EloDatabase', file: './test-elo-database.js' },
    { name: 'EloTracker', file: './test-elo-tracker.js' },
    { name: 'EloRatingsCommitted', file: './test-ratings-committed.js' },
    { name: 'EloSimulation', file: './test-elo-simulation.js', iterations: 20 }
  ];

  const results = {};
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  const brokenSuites = [];

  for (const suite of suites) {
    results[suite.name] = [];
    const iterations = suite.iterations || 1;

    for (let i = 0; i < iterations; i++) {
      const runLabel = iterations > 1 ? `${suite.name} (Run ${i + 1}/${iterations})` : suite.name;
      console.log(`${COLORS.YELLOW}Running Suite: ${runLabel}${COLORS.RESET}`);

      const suiteRunData = {
        iteration: i + 1,
        timestamp: new Date().toISOString(),
        tests: []
      };

      const capturingRunTest = async (name, fn) => {
        const result = await runTest(name, fn);
        suiteRunData.tests.push({ name, passed: result.passed, error: result.error });
        if (result.passed) totalPassed++;
        else totalFailed++;
        return result.passed;
      };

      const capturingRunSkip = async (name, reason) => {
        await runSkip(name, reason);
        suiteRunData.tests.push({ name, passed: null, skipped: true, error: null, reason });
        totalSkipped++;
        return true;
      };

      try {
        const modulePath = new URL(suite.file, import.meta.url).href;
        const module = await import(modulePath);

        // Expecting default export to be a function accepting (runTest, runSkip)
        if (module.default && typeof module.default === 'function') {
          await module.default(capturingRunTest, capturingRunSkip);
        } else {
          throw new Error(`no default export function in ${suite.file}`);
        }
      } catch (err) {
        // A suite that cannot load contributes zero assertions, so counting it
        // as anything but a failure lets coverage silently evaporate.
        const why = err.code === 'ERR_MODULE_NOT_FOUND'
          ? `cannot resolve an import — ${err.message.split('\n')[0]}`
          : (err.stack || err.message || String(err));
        console.error(`${COLORS.RED}  [BROKEN SUITE] ${suite.name}: ${why}${COLORS.RESET}`);
        suiteRunData.tests.push({ name: `${suite.name} (suite load)`, passed: false, error: why });
        brokenSuites.push(suite.name);
        totalFailed++;
      }
      results[suite.name].push(suiteRunData);
      console.log('');
    }
  }

  console.log(`${COLORS.CYAN}=== EloTracker Summary ===${COLORS.RESET}`);
  console.log(`  Passed:  ${totalPassed}`);
  console.log(`  Failed:  ${totalFailed}`);
  console.log(`  Skipped: ${totalSkipped}`);
  if (brokenSuites.length > 0) {
    console.log(`${COLORS.RED}  Suites that failed to load: ${brokenSuites.join(', ')}${COLORS.RESET}`);
  }
  console.log(
    totalFailed === 0
      ? `${COLORS.GREEN}  Status: ALL PASSING${COLORS.RESET}`
      : `${COLORS.RED}  Status: HAS FAILURES${COLORS.RESET}`
  );

  try {
    // Next to this file, not in the CWD — the runner is invoked from the repo
    // root as often as from testing/, and a results file whose location depends
    // on the caller ends up committed twice or not at all.
    fs.writeFileSync(path.join(HERE, 'test-results.json'), JSON.stringify(results, null, 2));
  } catch (err) {
    console.error(`${COLORS.RED}Failed to save results:${COLORS.RESET}`, err);
  }

  if (totalFailed > 0) process.exitCode = 1;
  return { passed: totalPassed, failed: totalFailed, skipped: totalSkipped };
}

// Execute if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runAll();
}