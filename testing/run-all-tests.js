/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          UNIFIED TEST RUNNER                                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Discovers and executes all test scripts in this directory,
 * printing a pass/fail summary with per-test timing.
 *
 * Usage:
 *   node SlackersSquadServices/testing/run-all-tests.js
 *   node SlackersSquadServices/testing/run-all-tests.js --category 1
 *   node SlackersSquadServices/testing/run-all-tests.js --category 2
 *
 * Category 1 = standalone (no server/game)
 * Category 2 = mock-based (no live server)
 * Category 3 = test plans (informational listing only)
 *
 * Exit code: 0 = all pass, 1 = any failure
 */

'use strict';

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Category definitions
// ---------------------------------------------------------------------------

const CATEGORY_TESTS = {
  1: [
    'test-s3-plugin-base-lifecycle.js',
    'test-s3-plugin-base-db.js',
    'test-s3-discord-plugin-base.js',
    'test-s3-export-import.js',
    'test-s3-commands.js',
    'test-command-standardization.js',
    'test-migration-backup.js',
    'test-auto-migrate.js',
    'test-db-connector-compat.js'
  ],
  2: [
    'test-join-pipeline.js',
    'test-handshake-flow.js',
    'test-player-session-persistence.js',
    'test-team-change-retry.js',
    'test-migration-pipeline.js',
    'test-command-routing.js'
  ]
};

const CATEGORY_DESCRIPTIONS = {
  1: 'Category 1 — Standalone (no server needed)',
  2: 'Category 2 — Mock-based (no live server)',
  3: 'Category 3 — Human-led test plans (listed for reference)'
};

const CATEGORY_3_PLANS = [
  'test-plan-join-pipeline-multi.md',
  'test-plan-round-flow.md',
  'test-plan-team-switching.md',
  'test-plan-discord-commands.md',
  'test-plan-performance-profile.md'
];

// ---------------------------------------------------------------------------
// Parse --category argument
// Supports: --category=1, --category 1 (from node arg split)
// ---------------------------------------------------------------------------

let categoryFilter = null;
for (let i = 0; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--category=')) {
    categoryFilter = parseInt(arg.split('=')[1], 10);
    break;
  }
  if (arg === '--category' && i + 1 < process.argv.length) {
    categoryFilter = parseInt(process.argv[i + 1], 10);
    break;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          S³ INTEGRATION TEST SUITE                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const categoriesToRun = categoryFilter ? [categoryFilter] : [1, 2, 3];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalTests = 0;

  for (const cat of categoriesToRun) {
    console.log(`\n${'='.repeat(65)}`);
    console.log(`  ${CATEGORY_DESCRIPTIONS[cat] || `Category ${cat}`}`);
    console.log(`${'='.repeat(65)}\n`);

    if (cat === 3) {
      console.log('  Test plans (manual/human-led):');
      for (const plan of CATEGORY_3_PLANS) {
        const planPath = path.join(__dirname, 'test-plans', plan);
        if (fs.existsSync(planPath)) {
          console.log(`    📋 ${plan}`);
        } else {
          console.log(`    ⚠ ${plan} (not found — expected at test-plans/${plan})`);
        }
      }
      console.log('');
      console.log('  These tests require human interaction on a live server.');
      console.log('  See each test plan document for step-by-step instructions.');
      continue;
    }

    const testFiles = CATEGORY_TESTS[cat] || [];
    let catPassed = 0;
    let catFailed = 0;

    for (const testFile of testFiles) {
      const testPath = path.join(__dirname, testFile);

      if (!fs.existsSync(testPath)) {
        console.log(`  ⚠ ${testFile} — file not found, skipping`);
        continue;
      }

      const start = Date.now();
      let exitCode = 0;
      let output = '';

      try {
        output = execSync(`node "${testPath}"`, {
          cwd: path.resolve(__dirname, '..', '..'),
          timeout: 60000,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe']
        });

        // Check exit code by looking for pass/fail pattern
        const resultsMatch = output.match(/Results: (\d+) passed, (\d+) failed/);
        if (resultsMatch) {
          const p = parseInt(resultsMatch[1], 10);
          const f = parseInt(resultsMatch[2], 10);
          exitCode = f > 0 ? 1 : 0;
        }
      } catch (err) {
        exitCode = 1;
        output = err.stdout || '';
        if (err.stderr) output += '\n' + err.stderr;
      }

      const elapsed = Date.now() - start;

      // Extract test count from output
      const resultsMatch = output.match(/Results: (\d+) passed, (\d+) failed, (\d+) total/);
      const testCount = resultsMatch ? parseInt(resultsMatch[3], 10) : '?';

      if (exitCode === 0) {
        console.log(`  ✅ ${testFile} — ${testCount} tests (${elapsed}ms)`);
        catPassed++;
      } else {
        console.log(`  ❌ ${testFile} — ${testCount} tests (${elapsed}ms)`);
        catFailed++;

        // Show first failure lines from output
        const failLines = output.split('\n')
          .filter(line => line.includes('✗') || line.includes('✘'))
          .slice(0, 3);
        if (failLines.length > 0) {
          console.log(`     ${failLines[0].trim()}`);
        }
      }
    }

    console.log('');
    console.log(`  Category ${cat}: ${catPassed} passed, ${catFailed} failed`);

    if (cat === 1) {
      totalPassed += catPassed;
      totalFailed += catFailed;
    } else if (cat === 2) {
      totalPassed += catPassed;
      totalFailed += catFailed;
    }
  }

  // Show any additional standalone test files not in a category
  const extraFiles = fs.readdirSync(__dirname)
    .filter(f => f.startsWith('test-') && f.endsWith('.js') && f !== 'run-all-tests.js')
    .filter(f => !Object.values(CATEGORY_TESTS).flat().includes(f));

  if (extraFiles.length > 0) {
    console.log(`\n${'─'.repeat(65)}`);
    console.log('  Uncategorized test files (not in Category 1 or 2):');
    for (const f of extraFiles) {
      console.log(`    📄 ${f}`);
    }
  }

  // Summary
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    FINAL SUMMARY                            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const grandTotal = totalPassed + totalFailed;
  if (grandTotal > 0) {
    console.log(`  Total script files: ${totalPassed + totalFailed}`);
    console.log(`  Passed: ${totalPassed}`);
    console.log(`  Failed: ${totalFailed}`);
    console.log(`  Status: ${totalFailed === 0 ? '✅ ALL PASSING' : '❌ HAS FAILURES'}`);
  } else {
    console.log('  No automated tests were selected to run.');
  }

  console.log('');

  if (totalFailed > 0) process.exitCode = 1;
}

await main();