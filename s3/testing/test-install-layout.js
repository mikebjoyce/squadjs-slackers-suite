/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   INSTALL LAYOUT — REAL install.cjs, REAL OUTPUT DIRECTORIES   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * `node install.cjs --plugin=all --with-testing` used to abort: every plugin
 * owns a `testing/run-all-tests.js`, and they all flatten onto the same target
 * path. The flag was unusable for a full install.
 *
 * The fix namespaces the clashing FILENAME (`run-all-tests-s3.js`) rather than
 * moving the files into per-plugin subdirectories. That choice is the thing
 * this file guards, because the obvious-looking alternative is silently wrong:
 *
 * ─── WHY DEPTH IS THE INVARIANT ──────────────────────────────────
 *
 * The suite reaches sideways with fixed relative paths — `../utils/db-service.js`,
 * `../plugins/base-plugin.js`, `../../core/logger.js`. The last one is the
 * clearest case: the repo root mirrors the SquadJS install root, so that
 * specifier finds the repo's test shim in the monorepo and the real SquadJS
 * Logger at the target. (The shim itself is never copied — `install.cjs` walks
 * only per-plugin directories, and overwriting SquadJS's logger with a no-op
 * would be catastrophic.) Flattening every plugin's
 * `plugins/`, `utils/`, `testing/` and `tools/` into ONE namespace is precisely
 * what makes those resolve at the target as well as in the monorepo. Moving
 * `s3/testing/x.js` to `testing/s3/x.js` would turn `../utils/` into
 * `testing/utils/` and break roughly sixty files at once — a breakage no import
 * would report until someone ran the file.
 *
 * So the assertions below are not about filenames for their own sake. The
 * load-bearing one is that **the directory depth of every copied file is
 * unchanged**. Everything else is a corollary.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   1. A production deploy (no opt-in flags) emits only verbatim source paths —
 *      the namespacing must never touch `plugins/` or `utils/`.
 *   2. `--with-testing --with-tools` emits every plugin's runner, distinctly.
 *   3. Depth is preserved for every copied file, opt-in dirs included.
 *   4. A file whose name is unique across plugins keeps that name exactly.
 *   5. Namespaced names do not depend on which plugins were selected.
 *   6. `dev-harness/` is unreachable from the installer by any route.
 *
 * ─── WHY (6) IS HERE ─────────────────────────────────────────────
 *
 * The dev harness drives RCON directly. It is a development instrument, not a
 * plugin, and shipping it to a live server would let it act on real games. It
 * stays out of ALL_PLUGINS today, but that is a convention a future edit could
 * undo without anything complaining — so it is asserted, from the outside,
 * against real installer output.
 *
 * ─── WHAT IS NOT COVERED ─────────────────────────────────────────
 *
 * The `assertClashingFilesAreEntryPoints()` guard — which refuses to rename a
 * clashing file that something imports by name — has no negative case here.
 * Exercising it needs a source tree with such an import, and `install.cjs`
 * resolves its monorepo root from `__dirname`, so it cannot be pointed at a
 * fixture. It runs (and passes) on every `--with-testing` invocation below.
 *
 * Run: node --test s3/testing/test-install-layout.js
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MONOREPO_ROOT = path.resolve(__dirname, '..', '..');
const INSTALL_SCRIPT = path.join(MONOREPO_ROOT, 'install.cjs');

// Installed copies of this file sit in a deployed `squad-server/testing/`, where
// there is no monorepo to install from. Nothing to assert there.
const AVAILABLE = fs.existsSync(INSTALL_SCRIPT);

const OPT_IN_DIRS = ['testing', 'tools'];

const tempDirs = [];

/**
 * Read ALL_PLUGINS out of install.cjs rather than restating it, so adding a
 * plugin cannot leave this file quietly testing a subset.
 */
function readAllPlugins() {
  const source = fs.readFileSync(INSTALL_SCRIPT, 'utf8');
  const match = source.match(/const ALL_PLUGINS = \[([^\]]*)\]/);
  assert.ok(match, 'install.cjs must declare ALL_PLUGINS as an array literal');
  return match[1]
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function listRelative(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRelative(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Run a real install into a throwaway directory and return its relative paths.
 */
function install(args) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-install-'));
  tempDirs.push(outputDir);

  const result = spawnSync(
    process.execPath,
    [INSTALL_SCRIPT, ...args, `--output=${outputDir}`, '--force'],
    { encoding: 'utf8' }
  );

  assert.equal(
    result.status,
    0,
    `install.cjs ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`
  );

  return { outputDir, files: listRelative(outputDir) };
}

/**
 * Every copyable file in the monorepo, keyed by its path relative to its plugin.
 * Returns Map<'testing/run-all-tests.js', string[] /* owning plugins *\/>.
 */
function sourceIndex(plugins, dirs) {
  const index = new Map();
  for (const plugin of plugins) {
    for (const dirName of dirs) {
      const dirPath = path.join(MONOREPO_ROOT, plugin, dirName);
      for (const rel of listRelative(dirPath, path.join(MONOREPO_ROOT, plugin))) {
        const base = path.basename(rel).toLowerCase();
        if (base === 'readme.md' || base === 'readme.mdx') continue;
        if (!['.js', '.mjs', '.cjs', '.json'].includes(path.extname(rel).toLowerCase())) continue;
        if (!index.has(rel)) index.set(rel, []);
        index.get(rel).push(plugin);
      }
    }
  }
  return index;
}

describe('install.cjs target layout', { skip: AVAILABLE ? false : 'no monorepo to install from' }, () => {
  let allPlugins;

  before(() => {
    allPlugins = readAllPlugins();
  });

  after(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a production deploy emits only verbatim source paths', () => {
    const { files } = install(['--plugin=all']);
    const sources = sourceIndex(allPlugins, ['plugins', 'utils']);

    assert.ok(files.length > 0, 'a full install must copy something');

    for (const rel of files) {
      assert.ok(
        sources.has(rel),
        `production deploy emitted "${rel}", which no plugin owns at that path — ` +
        `namespacing must never touch plugins/ or utils/`
      );
    }

    // Every source file made it: a production deploy is lossless.
    assert.equal(files.length, sources.size);

    // And nothing testing-related leaked in without the flag.
    assert.equal(files.filter(f => f.startsWith('testing/') || f.startsWith('tools/')).length, 0);
  });

  test('--with-testing emits every plugin\'s runner, distinctly', () => {
    const { outputDir, files } = install(['--plugin=all', '--with-testing', '--with-tools']);

    const owners = sourceIndex(allPlugins, OPT_IN_DIRS).get('testing/run-all-tests.js') ?? [];
    assert.ok(owners.length > 1, 'fixture assumption: more than one plugin owns testing/run-all-tests.js');

    for (const plugin of owners) {
      const expected = `testing/run-all-tests-${plugin}.js`;
      assert.ok(files.includes(expected), `expected ${expected} at the target`);

      // Distinct content, not the same file copied under several names.
      const source = fs.readFileSync(path.join(MONOREPO_ROOT, plugin, 'testing', 'run-all-tests.js'));
      const target = fs.readFileSync(path.join(outputDir, expected));
      assert.ok(source.equals(target), `${expected} must be ${plugin}'s own runner`);
    }

    // The un-namespaced name must not survive — whichever plugin won it would be
    // ambiguous, which is the bug this replaced.
    assert.ok(!files.includes('testing/run-all-tests.js'));
  });

  test('directory depth is preserved for every copied file', () => {
    const { files } = install(['--plugin=all', '--with-testing', '--with-tools']);
    const sources = sourceIndex(allPlugins, ['plugins', 'utils', ...OPT_IN_DIRS]);

    const sourceDirs = new Set([...sources.keys()].map(rel => path.posix.dirname(rel)));

    for (const rel of files) {
      assert.ok(
        sourceDirs.has(path.posix.dirname(rel)),
        `"${rel}" sits in a directory no source file does — a deeper target path ` +
        `breaks ../utils/ and ../core/ imports in every file beneath it`
      );
    }
  });

  test('a uniquely-named file keeps its name exactly', () => {
    const { files } = install(['--plugin=all', '--with-testing', '--with-tools']);
    const sources = sourceIndex(allPlugins, ['plugins', 'utils', ...OPT_IN_DIRS]);

    const emitted = new Set(files);
    let checked = 0;

    for (const [rel, owners] of sources) {
      if (owners.length > 1) continue;
      assert.ok(emitted.has(rel), `"${rel}" is unique to ${owners[0]} and must be copied unrenamed`);
      checked++;
    }

    assert.ok(checked > 50, `expected the bulk of the suite to be uniquely named, saw ${checked}`);
  });

  test('a namespaced name does not depend on which plugins were selected', () => {
    // s3 is auto-included, so this is the narrowest install that still contains
    // two owners of run-all-tests.js.
    const { files } = install(['--plugin=switch', '--with-testing']);

    assert.ok(files.includes('testing/run-all-tests-switch.js'));
    assert.ok(files.includes('testing/run-all-tests-s3.js'));
    assert.ok(
      !files.includes('testing/run-all-tests.js'),
      'a file must land at the same target path regardless of the selection — ' +
      'otherwise an incremental install leaves two copies under different names'
    );
    assert.ok(!files.some(f => f.includes('elo-tracker')), 'unselected plugins must not be copied');
  });

  test('the core/logger.js test shim is never copied', () => {
    // `<repo>/core/logger.js` is a `{ verbose() {} }` no-op that exists so the
    // suite's `../../core/logger.js` imports resolve when tests run outside a
    // SquadJS install. At a target that same specifier must find SquadJS's REAL
    // Logger — shipping the shim would silently swallow every plugin's logging.
    // It sits outside every plugin directory, so the installer cannot see it;
    // this asserts that stays true.
    assert.ok(fs.existsSync(path.join(MONOREPO_ROOT, 'core', 'logger.js')));

    const { files } = install(['--plugin=all', '--with-testing', '--with-tools']);

    for (const rel of files) {
      assert.ok(!rel.startsWith('core/'), `installer emitted "${rel}" into core/`);
      assert.notEqual(path.posix.basename(rel), 'logger.js', `installer emitted "${rel}"`);
    }
  });

  test('the dev harness cannot be installed by any route', () => {
    assert.ok(
      fs.existsSync(path.join(MONOREPO_ROOT, 'dev-harness')),
      'fixture assumption: dev-harness/ exists in the monorepo'
    );

    // Not a member of the set `all` expands to.
    assert.ok(!allPlugins.includes('dev-harness'));

    // Not requestable by name either — an unknown plugin is a hard error, so a
    // typo cannot quietly deploy an RCON driver to a live server.
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-install-'));
    tempDirs.push(outputDir);
    const rejected = spawnSync(
      process.execPath,
      [INSTALL_SCRIPT, '--plugin=dev-harness', `--output=${outputDir}`, '--force'],
      { encoding: 'utf8' }
    );
    assert.notEqual(rejected.status, 0, 'install.cjs must refuse --plugin=dev-harness');
    assert.match(rejected.stderr, /Unknown plugin "dev-harness"/);

    // And nothing the harness owns reaches the target on the widest install.
    const harnessFiles = new Set(
      listRelative(path.join(MONOREPO_ROOT, 'dev-harness')).map(rel => path.posix.basename(rel))
    );
    const { files } = install(['--plugin=all', '--with-testing', '--with-tools']);

    for (const rel of files) {
      assert.ok(
        !harnessFiles.has(path.posix.basename(rel)),
        `"${rel}" shares a filename with dev-harness/ — the harness must never ship`
      );
    }
  });
});
