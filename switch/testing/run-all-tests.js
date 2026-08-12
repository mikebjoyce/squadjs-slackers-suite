/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║         SWITCH — RUN ALL TOKEN SYSTEM TESTS                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Runs all 50 switch token system tests in sequence and reports
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
  'test-token-queue-integration.js'
];

console.log('═'.repeat(50));
console.log('  SWITCH PLUGIN — TOKEN SYSTEM TEST SUITE');
console.log('═'.repeat(50));
console.log(`  ${testFiles.length} test files | 50 total tests\n`);

let totalPassed = 0;
let totalFailed = 0;
let failedFiles = [];

for (const file of testFiles) {
  const filePath = path.join(__dirname, file);
  console.log(`── Running ${file} ──`);
  try {
    const stdout = execSync(`node "${filePath}"`, { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
    // Extract results from output
    console.log(stdout);
    const match = stdout.match(/📊 Results: (\d+)\/(\d+) passed, (\d+) failed/);
    if (match) {
      totalPassed += parseInt(match[1], 10);
      totalFailed += parseInt(match[3], 10);
    }
  } catch (err) {
    // Process still exits with 1 on failure, but we can parse the output
    const output = err.stdout || '';
    console.log(output);
    const match = output.match(/📊 Results: (\d+)\/(\d+) passed, (\d+) failed/);
    if (match) {
      totalPassed += parseInt(match[1], 10);
      totalFailed += parseInt(match[3], 10);
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
console.log(`  Total:   ${totalPassed + totalFailed}`);

if (failedFiles.length > 0) {
  console.log(`  Failed files: ${failedFiles.join(', ')}`);
  process.exit(1);
} else {
  console.log('\n  ✅ All tests passed!');
}