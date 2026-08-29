/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      SMART ASSIGN — TEST RUNNER                               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Runs every automated smart-assign suite in one command.
 *
 * A suite counts as passing only if its process exits 0. Nothing is
 * inferred from stdout, and a suite that fails to load counts as a
 * failure rather than a skip — a runner that reports green for tests it
 * never ran certifies coverage that does not exist.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/run-all-tests.js
 *
 * Exit code: 0 = every suite passed, 1 = any suite failed.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Monorepo-only. test-smart-assign-plugin.js loads smart-assign.js out of
 *   a throwaway install.cjs assembly (see s3/testing/plugin-assembly.js) and
 *   reaches into ../../s3/, which does not resolve at a deployed target.
 * - Not run here, and why:
 *     join-swap-tester.js       — a live-server diagnostic PLUGIN, not a test:
 *                                 it is loaded by SquadJS from config.json and
 *                                 profiles one named player's join/swap timing.
 *     clan-tag-timing-tester.js — same shape, and additionally imports
 *                                 utils/sa-clan-grouper.js, which was deleted
 *                                 when clan grouping moved to S³ ClansService.
 *     optimize-params.js        — a parameter-tuning tool over a JSONL export;
 *                                 marked DEPRECATED in its own header for the
 *                                 same deleted-grouper reason.
 *     unified-test-runner.js    — superseded. It predates S³ and imports the
 *                                 deleted sa-clan-grouper.js, so it cannot run
 *                                 in either layout. Kept for reference only.
 *   Those four are listed rather than silently omitted so the gap between
 *   "files in testing/" and "files under test" stays visible.
 *
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const SUITES = [
  { file: 'test-smart-assign-plugin.js', desc: 'plugin lifecycle, S³ gate, refresh interest' },
  { file: 'test-sa-team-evaluator.js', desc: 'assignment scoring and verdicts' },
  { file: 'test-handshake-integration.js', desc: 'join handshake integration' },
  { file: 'test-sa-assignment-log-indexes.js', desc: 'SA_AssignmentLog indexes actually get created' },
  { file: 'test-readme-accuracy.js', desc: 'README option tables match optionsSpecification' }
];

const results = [];
let failed = 0;

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  SMART ASSIGN TEST SUITE');
console.log('══════════════════════════════════════════════════════════════\n');

for (const suite of SUITES) {
  const testPath = path.join(HERE, suite.file);

  if (!fs.existsSync(testPath)) {
    console.log(`  ❌ ${suite.file} — FILE NOT FOUND`);
    results.push({ file: suite.file, ok: false });
    failed++;
    continue;
  }

  const start = Date.now();
  const run = spawnSync(process.execPath, [testPath], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
    timeout: 300000
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

const passed = results.filter((r) => r.ok).length;

console.log('\n──────────────────────────────────────────────────────────────');
console.log(`  ${passed}/${results.length} suites passed`);
console.log('──────────────────────────────────────────────────────────────\n');

if (failed > 0) process.exitCode = 1;
