/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║         SWITCH — RUN ALL TOKEN SYSTEM TESTS                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Runs every switch token system test in sequence and reports
 * aggregate results.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/run-all-tests.js
 *
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const testFiles = [
  'test-token-bucket.js',
  'test-eligibility-check.js',
  'test-token-messaging.js',
  'test-admin-clear.js',
  'test-seed-bonus.js',
  'test-token-queue-integration.js',
  'test-dialect-literals.js',
  // Builds a flattened assembly via install.cjs so a real Switch instance can
  // be constructed — slower than the mock-harness suites, and the only one
  // that runs an event handler end to end into a real database.
  'test-scramble-lockdown.js',
  // Same approach, no DB: exercises the real _taggedSwitchPlayer/
  // _checkSwitchEligibility/handlePlayerLeave post-switch lockout gate,
  // whose mock-harness copy in mock-harness.js is hand-maintained and can
  // drift from the production code it mirrors.
  'test-post-switch-lockout.js',
  // Same approach, run against SQLite AND MySQL. These two are where the
  // v2.5.6 admin/seed behaviour is actually pinned; the mock-harness suites
  // above cannot see permission errors or three-valued logic. MySQL cases
  // report as SKIPPED when the engine is not up on 127.0.0.1:3307 — read the
  // skip count, because a skip is not a pass.
  'test-admin-mutations.js',
  'test-seed-token-lifecycle.js'
];

console.log('═'.repeat(50));
console.log('  SWITCH PLUGIN — TOKEN SYSTEM TEST SUITE');
console.log('═'.repeat(50));
console.log(`  ${testFiles.length} test files\n`);

let totalPassed = 0;
let totalFailed = 0;
let totalSkipped = 0;
let failedFiles = [];

// Skipped tests are reported separately and must never be folded into the
// passed count or silently dropped from the aggregate — a suite that does
// that reports green having never actually exercised the unreachable engine.
const resultLine = /📊 Results: (\d+)\/(\d+) passed, (\d+) failed(?:, (\d+) skipped)?/;

for (const file of testFiles) {
  const filePath = path.join(__dirname, file);
  console.log(`── Running ${file} ──`);
  try {
    const stdout = execSync(`node "${filePath}"`, { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
    // Extract results from output
    console.log(stdout);
    const match = stdout.match(resultLine);
    if (match) {
      totalPassed += parseInt(match[1], 10);
      totalFailed += parseInt(match[3], 10);
      totalSkipped += parseInt(match[4] || '0', 10);
    }
  } catch (err) {
    // Process still exits with 1 on failure, but we can parse the output
    const output = err.stdout || '';
    console.log(output);
    const match = output.match(resultLine);
    if (match) {
      totalPassed += parseInt(match[1], 10);
      totalFailed += parseInt(match[3], 10);
      totalSkipped += parseInt(match[4] || '0', 10);
    } else {
      totalFailed++;
    }
    failedFiles.push(file);
  }
}

console.log('═'.repeat(50));
console.log('  AGGREGATE RESULTS');
console.log('═'.repeat(50));
console.log(`  Passed:  ${totalPassed}`);
console.log(`  Failed:  ${totalFailed}`);
console.log(`  Skipped: ${totalSkipped}`);
console.log(`  Total:   ${totalPassed + totalFailed + totalSkipped}`);

if (failedFiles.length > 0) {
  console.log(`  Failed files: ${failedFiles.join(', ')}`);
  process.exit(1);
} else {
  console.log('\n  ✅ All tests passed!');
}