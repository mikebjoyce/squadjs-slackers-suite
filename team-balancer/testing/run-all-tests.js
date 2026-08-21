/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      TEAM BALANCER — TEST RUNNER                              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Runs every automated team-balancer suite in one command. Until this
 * existed, each file had to be remembered and invoked by hand, which is
 * how plugin-logic-test-runner.js managed to sit dead (it threw
 * ERR_MODULE_NOT_FOUND on load) without anyone noticing.
 *
 * The contract here is deliberately blunt: a suite counts as passing only
 * if its process exits 0. Nothing is inferred from stdout, nothing is
 * skipped quietly, and a suite that fails to load is a failure — not a
 * "skip". A runner that reports green for tests it never ran is worse
 * than no runner, because it actively certifies coverage that does not
 * exist.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/run-all-tests.js
 *   node testing/run-all-tests.js --fast    # skip the slow suites
 *
 * Exit code: 0 = every suite passed, 1 = any suite failed.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Monorepo-only. The plugin suites load team-balancer.js out of a
 *   throwaway install.cjs assembly (see s3/testing/plugin-assembly.js) and
 *   reach into ../../s3/, which does not resolve at a deployed target where
 *   every plugin shares one flat directory.
 * - Not run here, and why:
 *     historical-scramble-test.js      — requires <elodb.json> [merged.jsonl]
 *     historical-elo-backbone-test.js  — requires <elodb.json>
 *       Both are replay tools over a real ELO export (docs/dataDump), not
 *       self-contained tests; they print usage and exit 1 with no argument.
 *     mock-data-generator.js           — a fixture generator, not a test.
 *
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const FAST = process.argv.includes('--fast');

const SUITES = [
  { file: 'test-team-balancer-plugin.js', desc: 'plugin lifecycle + layer mirror' },
  { file: 'plugin-logic-test-runner.js', desc: 'streak tracking, scramble triggers, mode detection' },
  { file: 'test-tb-elo-scramble.js', desc: 'ELO-weighted scramble, squad atomicity' },
  { file: 'test-cross-clan-squad-collision.js', desc: 'cross-clan squad collisions' },
  { file: 'embed-format-test.js', desc: 'Discord embed chunking' },
  // ~4 minutes: thousands of randomised scrambles looking for cohesion
  // failures. Real coverage, but too slow for a tight edit loop — hence --fast.
  { file: 'scrambler-test-runner.js', desc: 'randomised scrambler sweep', slow: true }
];

const results = [];
let failed = 0;

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  TEAM BALANCER TEST SUITE');
console.log('══════════════════════════════════════════════════════════════\n');

for (const suite of SUITES) {
  const testPath = path.join(HERE, suite.file);

  if (!fs.existsSync(testPath)) {
    // A missing file is a failure, not a skip: the list above is the
    // declaration of what this plugin's coverage is supposed to be.
    console.log(`  ❌ ${suite.file} — FILE NOT FOUND`);
    results.push({ file: suite.file, ok: false });
    failed++;
    continue;
  }

  if (FAST && suite.slow) {
    console.log(`  ⏭  ${suite.file} — skipped (--fast)`);
    results.push({ file: suite.file, skipped: true });
    continue;
  }

  const start = Date.now();
  const run = spawnSync(process.execPath, [testPath], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 600000
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  const ok = run.status === 0;
  if (ok) {
    console.log(`  ✅ ${suite.file} — ${suite.desc} (${elapsed}s)`);
  } else {
    failed++;
    console.log(`  ❌ ${suite.file} — ${suite.desc} (${elapsed}s)`);
    const output = `${run.stdout || ''}\n${run.stderr || ''}`;
    const notable = output
      .split('\n')
      .filter((l) => /FAIL|❌|Error|AssertionError/.test(l))
      .slice(0, 5);
    for (const line of notable) console.log(`       ${line.trim()}`);
    if (notable.length === 0 && run.error) console.log(`       ${run.error.message}`);
  }
  results.push({ file: suite.file, ok });
}

const ran = results.filter((r) => !r.skipped);
const passed = ran.filter((r) => r.ok).length;
const skipped = results.filter((r) => r.skipped).length;

console.log('\n──────────────────────────────────────────────────────────────');
console.log(`  ${passed}/${ran.length} suites passed${skipped ? `, ${skipped} skipped (--fast)` : ''}`);
console.log('──────────────────────────────────────────────────────────────\n');

if (failed > 0) process.exitCode = 1;
