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
 *
 * ─── RUN ONE SUITE AT A TIME ─────────────────────────────────────
 *
 * Do not run this concurrently with switch/testing/run-all-tests.js, or
 * with a second copy of itself.
 *
 * test-i18n.js regenerates s3/locale-templates/ — a fixed, tracked
 * directory, not a temp one — and reads the results back. Two runners
 * doing that at once read each other's half-written output, and
 * test-i18n.js fails with nothing wrong in the code. It reproduces as a
 * clean pass the moment the suites are run one after the other. If you
 * see exactly one failure and it is test-i18n.js, check this first.
 *
 * Two side effects of a normal run, both expected:
 *   - s3/locale-templates/* comes back modified. That is the generator,
 *     not a stray edit.
 *   - MySQL/Postgres cases SKIP when the engines are not up. Read the skip
 *     count; a skip is not a pass.
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
    // Static only — no DB, no server. Sits in category 1 because a broken
    // catalogue makes every downstream plugin's log output nonsense, so it
    // should fail before the slower suites spend four minutes on it.
    'test-i18n.js',
    // The other half of the i18n guarantee: test-i18n.js proves the catalogue
    // is sound, this proves the embeds actually use it. Renders every builder
    // through a bracketing localize() and fails on prose that never went
    // through the catalogue — including literals assigned to intermediate
    // variables, which no static scan of display anchors can see.
    'test-i18n-render.js',
    // Static only — no DB, no server. Sits here for the same reason as
    // test-i18n.js: fails fast, before the slower suites spend minutes on a
    // class of bug this catches in milliseconds.
    'test-identifier-case.js',
    'test-s3-export-import.js',
    'test-s3-commands.js',
    'test-inspection-embeds.js',
    'test-command-standardization.js',
    'test-migration-backup.js',
    'test-auto-migrate.js',
    'test-db-connector-compat.js',
    // Was never listed in any category, so nothing ran it — which is how its
    // migration case sat calling a db.registerMigration() that has never
    // existed on DBService, throwing TypeError, unnoticed.
    'test-db-service.js',
    // The five core services, plus their two supporting cases. These were
    // uncategorized too — the runner listed them under "uncategorized test
    // files" and ran none of them, which is how the two endgame sub-state
    // cases in test-game-state-service.js could sit failing on a poll race.
    'test-game-state-service.js',
    'test-players-service.js',
    'test-clans-service.js',
    'test-factions-service.js',
    'test-server-config-service.js',
    'test-crash-recovery.js',
    'test-sa-per-player-lock.js',
    // SQLite coverage always runs; the MySQL/Postgres cases self-skip when
    // those engines are unreachable, so this stays a Category 1 test.
    'test-dialect-portability.js',
    // The orphan scan folds every identifier it compares, which is only
    // exercisable against an engine that folds. Same self-skip shape.
    'test-db-orphans.js',
    // Export scoping is a WHERE clause built from a declaration, and both
    // halves have to be checked against a real engine. Same self-skip shape.
    'test-export-scope.js',
    // The import half. The overwrite probe is a query and the foreign-key
    // suppression is a session variable, so neither is checkable on logic
    // alone. Same self-skip shape.
    'test-import-scope.js',
    // Same shape: SQLite always runs, MySQL/Postgres self-skip when unreachable.
    'test-migration-bulk-types.js',
    // touches.data post-conditions: same shape again, all three engines.
    'test-migration-data-assertions.js',
    // Drift recovery across the DB states a real server can be in — brand new,
    // behind, drifted, both at once, several plugins — on all three engines.
    'test-drift-recovery-matrix.js',
    // Spawns child processes to assert stdout/stderr separation.
    'test-stderr-diagnostics.js',
    // Also spawns real child processes, and for the same reason: the migration
    // lock's guarantee is cross-process, and two service objects in one process
    // are serialised by the process rather than by the lock. SQLite only, since
    // the lock has no dialect branch.
    'test-multi-process-locking.js',
    // Server identity: how the id every server-scoped row carries is resolved,
    // and what happens to a value that cannot work. Builds one flattened
    // assembly, because the plugin classes only import in the shipped layout.
    'test-server-identity.js',
    // Server registry: who else is writing to this database. Runs on a
    // file-backed SQLite so two DBServices can contest one row — `:memory:`
    // would give each connection a database of its own and there would be
    // nothing to collide over.
    'test-server-registry.js',
    // Which server answers a Discord command, and how many times. Same
    // file-backed SQLite for the same reason, plus one assembly, because
    // TeamBalancer's scope table only imports in the shipped layout.
    'test-discord-routing.js',
    // The two singleton tables whose primary key is the server id. Also
    // file-backed SQLite, and for the same reason: the four boot orders are
    // two DBServices meeting over one legacy row. Builds an assembly, because
    // TeamBalancer's model and wrapper are the shipped ones rather than
    // stand-ins.
    'test-singleton-scoping.js',
    // Third time this file has gained a note like the two above: this one was
    // written, passed by hand, and then listed under "uncategorized test
    // files" — printed on every run and executed on none of them. Adding a
    // test file and adding it to a category are two separate acts, and the
    // runner reports the gap rather than failing on it.
    'test-community-options.js',
    // Replays every plugin's real migrations across DB states, so it is slower
    // than the rest.
    'test-migration-conformance.js',
    // What conformance does not ask: whether the rows that came out of a
    // Class B rename are the rows that went in. Same shape as the suites
    // above — SQLite always runs, MySQL and Postgres self-skip.
    'test-multi-server-scoping.js',
    // A migration whose up() commits real DDL/DML but fails post-commit
    // touches verification must be safely retryable, not crash forever on a
    // raw duplicate-column/duplicate-key driver error. SQLite always runs,
    // MySQL self-skips when unreachable, same shape as the dialect suites above.
    'test-migration-partial-retry.js',
    // The offline CLI had no test and drifted until it could not run: it kept a
    // hand-maintained copy of every plugin's version and migrations, which fell
    // four versions behind across three plugins and lost three others entirely.
    // It now harvests the real registrations, and this asserts it reaches all of
    // them — a plugin missing from its report reads like a plugin with nothing
    // to do. Spawns the real tool; builds an assembly, so it is not instant.
    'test-schema-version-cli.js',
    // Runs the real install.cjs into throwaway directories and asserts the
    // target layout — including that dev-harness/ can never be deployed.
    'test-install-layout.js',
    // Mounts the real DBService/LoggingService against real engines and asserts
    // what they register. SQLite always runs; MySQL self-skips when unreachable.
    'test-export-model-registration.js',
    // Real SQLite, real GameStateService + LoggingService: asserts the
    // resolving-clear rows actually land in S3_GameStateEvents.
    'test-resolving-cleared-logging.js',
    // Parses S3_DEVELOPER_GUIDE.md and checks its command table, option
    // defaults and test catalog against source. No engine, no I/O beyond
    // reading three files.
    'test-developer-guide-accuracy.js',
    // !s3 switches / !s3 karma query layer. Pure-JS section always runs;
    // DB-integration section is SQLite-always, MySQL self-skips like the
    // other dialect-portability tests above.
    'test-s3-switch-reports.js',
    // The Discord-facing embed builders on top of the above — SQLite only,
    // since the logic they format is already dual-dialect-proven there.
    'test-s3-commands-embeds.js'
  ],
  2: [
    'test-join-pipeline.js',
    'test-handshake-flow.js',
    'test-player-session-persistence.js',
    'test-team-change-retry.js',
    'test-request-team-change-eosid.js',
    'test-migration-pipeline.js',
    'test-migrate-flag-safety.js',
    'test-command-routing.js'
  ],
  4: [
    'test-migration-permissions.js',
    // Two real child processes against one MySQL database. Category 4 rather
    // than 1 because there is no SQLite arm to fall back on: the point is the
    // engine the deployment runs, and a run without Docker proves nothing
    // here rather than proving less.
    'test-two-process-isolation.js'
  ]
};

const CATEGORY_DESCRIPTIONS = {
  1: 'Category 1 — Standalone (no server needed)',
  2: 'Category 2 — Mock-based (no live server)',
  3: 'Category 3 — Human-led test plans (listed for reference)',
  4: 'Category 4 — Multi-dialect permission tests (requires Docker)'
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
        // Four minutes, not one. `test-migration-conformance.js` replays every
        // registered migration against SQLite, MySQL and Postgres in turn and
        // takes a little over a minute on its own, so a 60-second cap reported
        // 121 passing assertions as a suite failure — the worst kind of red,
        // because the thing it points at is fine and the runner is not.
        //
        // The cap is here to stop a hung engine connection holding the whole
        // run open, and four minutes still does that. Anything legitimately
        // slower than this belongs in its own file rather than in a longer
        // number here.
        output = execSync(`node "${testPath}"`, {
          cwd: path.resolve(__dirname, '..', '..'),
          timeout: 4 * 60 * 1000,
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