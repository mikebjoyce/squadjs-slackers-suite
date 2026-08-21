/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      SUITE-WIDE TEST RUNNER                                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Runs every plugin's own test runner, in one command, from the repo root.
 *
 * Until this existed there was no single place that answered "is the suite
 * green?", and the absence of that answer is part of why three consumer
 * plugins went untested long enough for their tests to rot: team-balancer's
 * plugin-logic-test-runner.js and elo-tracker's test-elo-tracker.js both
 * threw ERR_MODULE_NOT_FOUND on load, and nothing was watching.
 *
 * Each per-plugin runner owns its own suite list; this file only aggregates
 * their exit codes. Exit 0 means every runner exited 0 — no inference from
 * stdout, no quiet skips.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/run-all-tests.js
 *   node testing/run-all-tests.js --fast          # skip the slow suites
 *   node testing/run-all-tests.js --plugin=s3     # one plugin (repeatable)
 *
 * Exit code: 0 = every runner passed, 1 = any runner failed.
 *
 * ─── WHY IT LIVES IN A ROOT-LEVEL testing/ ───────────────────────
 *
 * It has to sit outside all five plugin directories, because install.cjs
 * assembles a deployment by copying plugins/, utils/, testing/ and tools/ out
 * of s3/, team-balancer/, elo-tracker/, smart-assign/ and switch/ — anything
 * inside one of those is a candidate for shipping to a live server, and a
 * runner that spawns the other four plugins' suites is not. Nothing at the
 * repo root is ever copied, so root/testing/ is safe for the same reason
 * root/core/ and root/tools/ are.
 *
 * Naming it testing/run-all-tests.js rather than leaving it loose at the root
 * also keeps it consistent with the five it delegates to, each of which is its
 * own plugin's testing/run-all-tests.js. It does NOT collide with them:
 * install.cjs computes its clash set over the plugin directories only, and
 * this file is not in one.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - The suites themselves are monorepo-only regardless — the consumer plugin
 *   tests build a throwaway install.cjs assembly and reach into ../../s3/.
 * - --fast is forwarded to every runner; only team-balancer currently marks
 *   anything slow (its ~4 minute randomised scrambler sweep).
 *
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// One level up from testing/ — the plugin directories are siblings of it.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// s3 first: everything else gates on its version and borrows its test
// helpers, so a broken s3 explains most downstream failures.
const PLUGINS = ['s3', 'team-balancer', 'elo-tracker', 'smart-assign', 'switch'];

const FAST = process.argv.includes('--fast');
const selected = process.argv
  .filter((a) => a.startsWith('--plugin='))
  .map((a) => a.slice('--plugin='.length));

for (const name of selected) {
  if (!PLUGINS.includes(name)) {
    console.error(`Unknown plugin "${name}". Valid: ${PLUGINS.join(', ')}`);
    process.exit(1);
  }
}

const toRun = selected.length > 0 ? selected : PLUGINS;

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║          SLACKERS SUITE — FULL TEST RUN                     ║');
console.log('╚══════════════════════════════════════════════════════════════╝');

const results = [];

for (const plugin of toRun) {
  const runner = path.join(ROOT, plugin, 'testing', 'run-all-tests.js');

  if (!fs.existsSync(runner)) {
    // Not a skip: every plugin in PLUGINS is expected to carry a runner.
    console.log(`\n❌ ${plugin} — no testing/run-all-tests.js`);
    results.push({ plugin, ok: false });
    continue;
  }

  const start = Date.now();
  const run = spawnSync(process.execPath, [runner, ...(FAST ? ['--fast'] : [])], {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: 'inherit',
    timeout: 1800000
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  results.push({ plugin, ok: run.status === 0, elapsed });
}

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║                       FINAL SUMMARY                         ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

for (const r of results) {
  const mark = r.ok ? '✅' : '❌';
  console.log(`  ${mark} ${r.plugin.padEnd(16)}${r.elapsed ? `${r.elapsed}s` : ''}`);
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n  ${passed}/${results.length} plugin runners passed.\n`);

if (passed !== results.length) process.exitCode = 1;
