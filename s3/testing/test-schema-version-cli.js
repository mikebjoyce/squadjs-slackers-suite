/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   SCHEMA VERSION CLI — REAL TOOL, REAL DATABASE, END TO END    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── WHY THIS FILE EXISTS ────────────────────────────────────────
 *
 * `s3/tools/schema-version.mjs` had no test at all, and it drifted until it
 * could not run. It carried a hand-maintained copy of every plugin's expected
 * version and migrations — a mirror of the runtime registrations, updated by
 * remembering to. By the time anyone ran it, it was four versions behind across
 * three plugins, had lost `switch`, `s3-players` and `db-log` entirely, and
 * carried a `smart-assign` v2 that did something different from the real v2
 * under the same version number. `check` crashed. `migrate` would have recorded
 * v2 as applied while the real v2 never ran.
 *
 * The mirror is gone: the tool now drives each plugin's real registration path.
 * Version drift is therefore impossible by construction, and this file does not
 * assert version numbers — restating them here would rebuild the same mirror in
 * a new place.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   1. `check` reaches every plugin that registers a schema version. This is
 *      the failure the harvest cannot rule out on its own: an adapter whose
 *      plugin moved its registration registers nothing, and a plugin missing
 *      from the report reads exactly like a plugin with nothing to do.
 *   2. `migrate --force` actually migrates. The CLI's own `--force` used to
 *      skip only its terminal prompt while the engine's confirmation gate
 *      still refused, so `migrate` could not migrate under any flag.
 *   3. `check` after `migrate` reports every plugin current, and exits 0.
 *
 * ─── WHAT IS NOT COVERED ─────────────────────────────────────────
 *
 * Data preservation across the migrations — that is
 * `test-migration-conformance.js` and `test-multi-server-scoping.js`, which
 * replay the same registrations across three engines. This file asks only
 * whether the CLI reaches them and can run them.
 *
 * MySQL and Postgres, because the tool is SQLite-only by construction.
 *
 * Run: node --test s3/testing/test-schema-version-cli.js
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(MONOREPO_ROOT, 's3', 'tools', 'schema-version.mjs');

// In source layout the CLI builds a throwaway assembly with install.cjs. An
// installed copy of this file sits in a deployed `squad-server/testing/`, where
// there is no monorepo to build from.
const AVAILABLE = fs.existsSync(CLI) && fs.existsSync(path.join(MONOREPO_ROOT, 'install.cjs'));

/**
 * Every plugin name that registers an expected schema version.
 *
 * A list of NAMES, deliberately, not of versions. The thing that broke was
 * plugins going missing from the tool's view, and that is what this pins.
 * Adding a plugin that registers a version should fail this test until an
 * adapter for it is added to the CLI — that failure is the point.
 */
const EXPECTED_PLUGINS = [
  'db-log',
  'elo-tracker',
  's3-core',
  's3-gamestate',
  's3-logging',
  's3-players',
  'smart-assign',
  'switch',
  'team-balancer'
];

const tempDirs = [];

function makeEmptyDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-cli-test-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'test.sqlite');
  // A zero-byte file is a valid empty SQLite database, and the CLI refuses to
  // run against a path that does not exist.
  fs.writeFileSync(dbPath, '');
  return dbPath;
}

function runCli(args, dbPath) {
  return spawnSync(process.execPath, [CLI, ...args, '--db-path', dbPath], {
    cwd: MONOREPO_ROOT,
    encoding: 'utf8',
    timeout: 240000
  });
}

/** Plugin names as `check` renders them: "  ✅ name   v1 (current)". */
function pluginsInReport(stdout) {
  const names = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s+(?:✅|⚠️)\s+([a-z0-9-]+)\s+v\d/);
    if (m) names.push(m[1]);
  }
  return names.sort();
}

after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('schema-version CLI', { skip: AVAILABLE ? false : 'source tree not available' }, () => {
  test('check reaches every plugin that registers a version', () => {
    const dbPath = makeEmptyDb();
    const res = runCli(['check'], dbPath);

    assert.ok(
      !/Fatal error/.test(res.stdout + res.stderr),
      `check failed:\n${res.stdout}\n${res.stderr}`
    );

    const found = pluginsInReport(res.stdout);
    assert.deepEqual(
      found,
      EXPECTED_PLUGINS,
      'check must report exactly the plugins that register a schema version. ' +
      'A missing name means that plugin\'s adapter in schema-version.mjs no longer ' +
      'reaches its registration, and the tool would under-report rather than fail.'
    );
  });

  test('migrate --force applies migrations without a Discord confirmation', () => {
    const dbPath = makeEmptyDb();
    const res = runCli(['migrate', '--force'], dbPath);

    assert.ok(
      !/not confirmed/.test(res.stdout + res.stderr),
      'the CLI must hand the engine its own confirmation — --force used to skip ' +
      `only the terminal prompt:\n${res.stdout}\n${res.stderr}`
    );

    const applied = res.stdout.match(/(\d+) migration\(s\) applied/);
    assert.ok(applied, `no migration summary in output:\n${res.stdout}`);
    assert.ok(
      Number(applied[1]) > 0,
      `migrate reported ${applied[1]} migrations applied against an empty database`
    );
  });

  test('check after migrate reports every plugin current and exits 0', () => {
    const dbPath = makeEmptyDb();

    const migrated = runCli(['migrate', '--force'], dbPath);
    assert.ok(/migration\(s\) applied/.test(migrated.stdout), 'migrate did not run');

    const res = runCli(['check'], dbPath);
    assert.equal(res.status, 0, `check should exit 0 when up to date:\n${res.stdout}`);
    assert.match(res.stdout, /All plugins up to date/);
    assert.deepEqual(pluginsInReport(res.stdout), EXPECTED_PLUGINS);
    assert.ok(
      !/⚠️/.test(res.stdout.split('Schema Version Status')[1] || ''),
      `no plugin should be behind after a full migrate:\n${res.stdout}`
    );
  });

  test('the temporary assembly is not left in the repo root', () => {
    const stray = fs.readdirSync(MONOREPO_ROOT).filter((n) => n.startsWith('.tmp-schema-version'));
    assert.deepEqual(
      stray,
      [],
      'a leftover flattened assembly in the repo root is picked up by the locale ' +
      'tooling and fakes a tier flip, so the CLI must remove its own'
    );
  });
});
