#!/usr/bin/env node
/**
 * SquadJS Slacker's Suite — Install Script (Node.js)
 *
 * Assembles selected plugins into a deployable `out/` folder matching
 * SquadJS's expected `squad-server/` layout.
 *
 * Usage:
 *   node install.cjs --plugin=<name> [--output=<path>] [--with-tools] [--with-testing]
 *                    [--clean] [--force]
 *
 *   --plugin     s3 | team-balancer | elo-tracker | smart-assign | switch | db-log | all
 *                (S3 is always auto-included — every consumer plugin depends on it)
 *                `db-log` and other core-plugin upgrades live flat in `core-plugins/`
 *                (as `<name>.js`) but are selected by their bare name, same as any
 *                other plugin.
 *   --output     Output directory (default: ./out)
 *   --with-tools      Also copy tools/ directories
 *   --with-testing    Also copy testing/ directories
 *   --clean           Wipe output directory before copying (destructive — use with care)
 *   --force, -f       Skip overwrite confirmation prompt
 *
 * Examples:
 *   node install.cjs --plugin=s3
 *   node install.cjs --plugin=team-balancer
 *   node install.cjs --plugin=all --with-tools
 *   node install.cjs --plugin=switch,smart-assign --output=../my-squadjs/squad-server --force
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Constants ───────────────────────────────────────────────────────────────

const MONOREPO_ROOT = __dirname;

const ALL_PLUGINS = ['s3', 'team-balancer', 'elo-tracker', 'smart-assign', 'switch', 'db-log'];

// core-plugins/ holds S3-backed drop-in replacements for stock SquadJS core
// plugins (same class/file name as the original, so installing one
// overwrites rather than running alongside it — see the docblock in
// core-plugins/db-log.js). Unlike the other plugins, which keep <name>/plugins/
// and <name>/utils/ subfolders, these are single-file drop-ins with no utils
// of their own, so every core-plugin's files sit flat in core-plugins/,
// namespaced by filename prefix: <name>.js (+ <name>-test.js once tests
// exist). Selected by the same bare name as any other plugin
// (`--plugin=db-log`); only the source layout differs.
const CORE_PLUGINS_DIR = path.join(MONOREPO_ROOT, 'core-plugins');
const CORE_PLUGIN_NAMES = new Set(['db-log']);

function pluginSourceExists(pluginName) {
  if (CORE_PLUGIN_NAMES.has(pluginName)) return fs.existsSync(CORE_PLUGINS_DIR);
  return fs.existsSync(path.join(MONOREPO_ROOT, pluginName));
}

/**
 * Every file a plugin contributes to a given target subdirectory (`plugins`,
 * `utils`, `testing`, or `tools`), as { abs, sourceRel } pairs. `sourceRel`
 * mirrors what the flattened target path will be (e.g. "plugins/db-log.js")
 * and is what clash-detection and namespacing key off of below.
 */
function pluginFilesInDir(pluginName, dirName) {
  if (CORE_PLUGIN_NAMES.has(pluginName)) {
    let abs;
    if (dirName === 'plugins') abs = path.join(CORE_PLUGINS_DIR, `${pluginName}.js`);
    else if (dirName === 'testing') abs = path.join(CORE_PLUGINS_DIR, `${pluginName}-test.js`);
    else return []; // no utils/ or tools/ for core-plugin upgrades

    if (!fs.existsSync(abs)) return [];
    return [{ abs, sourceRel: path.join(dirName, path.basename(abs)) }];
  }

  const dirPath = path.join(MONOREPO_ROOT, pluginName, dirName);
  return listFilesRecursive(dirPath).map(abs => ({
    abs,
    sourceRel: path.join(dirName, path.relative(dirPath, abs))
  }));
}

// Directories to copy per plugin (testing and tools are opt-in).
const ALWAYS_DIRS = ['plugins', 'utils'];
const OPT_IN_DIRS = ['testing', 'tools'];

// File extensions to copy.
const COPY_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json']);

// ─── Argument Parsing ────────────────────────────────────────────────────────

function parseArgs() {
  const args = {
    plugins: [],
    output: path.join(MONOREPO_ROOT, 'out'),
    withTools: false,
    withTesting: false,
    clean: false,
    force: false,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--plugin=')) {
      const raw = arg.slice('--plugin='.length);
      args.plugins = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    } else if (arg.startsWith('--output=')) {
      args.output = path.resolve(arg.slice('--output='.length));
    } else if (arg === '--with-tools') {
      args.withTools = true;
    } else if (arg === '--with-testing') {
      args.withTesting = true;
    } else if (arg === '--clean') {
      args.clean = true;
    } else if (arg === '--force' || arg === '-f') {
      args.force = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
SquadJS Slacker's Suite — Install Script

Usage:
  node install.cjs --plugin=<name> [--output=<path>] [--with-tools] [--with-testing]
                   [--clean] [--force]

Options:
  --plugin=<name>   Plugin(s) to install: s3, team-balancer, elo-tracker,
                    smart-assign, switch, db-log, or all (comma-separated).
                    S3 is always auto-included.
  --output=<path>   Output directory (default: ./out)
  --with-tools      Also copy tools/ directories
  --with-testing    Also copy testing/ directories
  --clean           Wipe output directory before copying.
                    WARNING: This deletes ALL files in the output directory,
                    including non-Slacker files. Only use with a dedicated
                    output directory, NOT a live SquadJS install.
  --force, -f       Skip the overwrite confirmation prompt. Required when
                    the output directory already contains files that would
                    be overwritten.
  --help, -h        Show this help

Examples:
  node install.cjs --plugin=s3
  node install.cjs --plugin=team-balancer
  node install.cjs --plugin=all --with-tools
  node install.cjs --plugin=switch,smart-assign --output=../my-squadjs/squad-server --force
`);
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validatePlugins(requested) {
  if (requested.length === 0) {
    console.error('Error: --plugin is required.');
    printHelp();
    process.exit(1);
  }

  const resolved = new Set();

  for (const name of requested) {
    if (name === 'all') {
      ALL_PLUGINS.forEach(p => resolved.add(p));
    } else if (ALL_PLUGINS.includes(name)) {
      resolved.add(name);
    } else {
      console.error(`Error: Unknown plugin "${name}". Valid options: ${ALL_PLUGINS.join(', ')}, all`);
      process.exit(1);
    }
  }

  // S3 is always included — every consumer plugin depends on it.
  resolved.add('s3');

  return [...resolved].sort((a, b) => {
    // s3 always first
    if (a === 's3') return -1;
    if (b === 's3') return 1;
    return a.localeCompare(b);
  });
}

// ─── File Discovery ──────────────────────────────────────────────────────────

/**
 * Recursively list all files in a directory.
 */
function listFilesRecursive(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Is this a file the installer copies at all?
 */
function isCopyable(filePath) {
  if (!COPY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  const basename = path.basename(filePath).toLowerCase();
  return basename !== 'readme.md' && basename !== 'readme.mdx';
}

/**
 * Find the files in `testing/` and `tools/` whose relative path is claimed by
 * more than one plugin — today only `testing/run-all-tests.js`, which all five
 * plugins own a copy of.
 *
 * Computed over ALL_PLUGINS rather than the plugins being installed, so a file's
 * target name never depends on which plugins a given install happens to select.
 */
function findOptInClashes() {
  const owners = new Map(); // relativePath → Set<pluginName>

  for (const pluginName of ALL_PLUGINS) {
    for (const dirName of OPT_IN_DIRS) {
      for (const { abs, sourceRel } of pluginFilesInDir(pluginName, dirName)) {
        if (!isCopyable(abs)) continue;
        if (!owners.has(sourceRel)) owners.set(sourceRel, new Set());
        owners.get(sourceRel).add(pluginName);
      }
    }
  }

  const clashes = new Set();
  for (const [rel, plugins] of owners) {
    if (plugins.size > 1) clashes.add(rel);
  }
  return clashes;
}

/**
 * Suffix a clashing file with its owning plugin, keeping it in the same
 * directory: "testing/run-all-tests.js" → "testing/run-all-tests-s3.js".
 */
function namespaceRel(rel, pluginName) {
  const ext = path.extname(rel);
  return `${rel.slice(0, rel.length - ext.length)}-${pluginName}${ext}`;
}

/**
 * Every file the installer can see, for the import scan below.
 */
function allSuiteFiles() {
  const results = [];
  for (const pluginName of ALL_PLUGINS) {
    for (const dirName of [...ALWAYS_DIRS, ...OPT_IN_DIRS]) {
      results.push(...pluginFilesInDir(pluginName, dirName).map(e => e.abs));
    }
  }
  return results.filter(isCopyable);
}

/**
 * Renaming a file at the target is only safe if it is an entry point. If
 * anything in the suite imports it by name, the rename would break that import
 * silently at the target, so fail loudly and let a human rename it in the repo
 * instead.
 */
function assertClashingFilesAreEntryPoints(clashes) {
  if (clashes.size === 0) return;

  const clashingBasenames = new Set([...clashes].map(rel => path.basename(rel)));
  const specifier = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  const offenders = [];

  for (const filePath of allSuiteFiles()) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(specifier)) {
      const spec = match[1];
      if (!spec.startsWith('.')) continue;
      const base = path.basename(spec);
      if (clashingBasenames.has(base)) {
        offenders.push(`  ${path.relative(MONOREPO_ROOT, filePath)} imports "${spec}"`);
      }
    }
  }

  if (offenders.length > 0) {
    console.error(
      `\nCannot namespace clashing file(s) — they are imported by name:\n` +
      `${offenders.join('\n')}\n` +
      `\nFiles that share a name across plugins are renamed at the target, which` +
      `\nwould break these imports. Rename the file in the repository instead.`
    );
    process.exit(1);
  }
}

/**
 * Collect all files to copy for a set of plugins.
 * Returns: Map<relativePath, { source: absolutePath, plugin: pluginName }>
 *
 * All four source directories flatten into one namespace at the target:
 * `s3/plugins/x.js` and `switch/utils/y.js` become `plugins/x.js` and
 * `utils/y.js`. That is not cosmetic — the suite reaches sideways with fixed
 * relative paths (`../utils/db-service.js`, `../plugins/base-plugin.js`,
 * `../core/logger.js`), and flattening is precisely what makes those resolve at
 * the target as well as in the monorepo. Moving `testing/` into per-plugin
 * subdirectories would break roughly sixty files' imports to fix one filename
 * clash, so the clashing *filename* is namespaced instead.
 *
 * For `plugins/` and `utils/` a clash is a genuine bug — two plugins shipping
 * the same util name would overwrite each other in production — so those stay a
 * hard error.
 */
function collectFiles(plugins, opts) {
  const files = new Map(); // relativePath → { source, plugin }

  const dirsToCopy = [...ALWAYS_DIRS];
  if (opts.withTools) dirsToCopy.push('tools');
  if (opts.withTesting) dirsToCopy.push('testing');

  const optInClashes = dirsToCopy.some(d => OPT_IN_DIRS.includes(d))
    ? findOptInClashes()
    : new Set();
  assertClashingFilesAreEntryPoints(optInClashes);

  for (const pluginName of plugins) {
    if (!pluginSourceExists(pluginName)) {
      console.error(`Error: Plugin source not found for "${pluginName}"`);
      process.exit(1);
    }

    for (const dirName of dirsToCopy) {
      for (const { abs, sourceRel } of pluginFilesInDir(pluginName, dirName)) {
        if (!isCopyable(abs)) continue;

        const rel = optInClashes.has(sourceRel)
          ? namespaceRel(sourceRel, pluginName)
          : sourceRel;

        if (files.has(rel)) {
          const existing = files.get(rel);
          console.error(
            `\nCollision detected: "${rel}"\n` +
            `  → ${existing.plugin}/${sourceRel}\n` +
            `  → ${pluginName}/${sourceRel}\n` +
            `\nRename one of the files to resolve the conflict before retrying.`
          );
          process.exit(1);
        }

        files.set(rel, { source: abs, plugin: pluginName });
      }
    }
  }

  return files;
}

// ─── Copy ────────────────────────────────────────────────────────────────────

/**
 * Check which files would be overwritten in the output directory.
 * Returns an array of relative paths that already exist at the destination.
 */
function findOverwrites(files, outputDir) {
  const overwrites = [];
  for (const [relPath] of files) {
    const dest = path.join(outputDir, relPath);
    if (fs.existsSync(dest)) {
      overwrites.push(relPath);
    }
  }
  return overwrites;
}

/**
 * Copy files to the output directory.
 *
 * @param {Map} files - Map of relativePath → { source, plugin }
 * @param {string} outputDir - Destination directory
 * @param {object} opts - { clean, force }
 * @returns {number} Number of files copied
 */
function copyFiles(files, outputDir, opts) {
  // --clean mode: wipe the entire output directory first (opt-in destructive)
  if (opts.clean && fs.existsSync(outputDir)) {
    console.log('--clean specified: removing existing output directory...');
    fs.rmSync(outputDir, { recursive: true, force: true });
  }

  // Check for files that would be overwritten (only if not using --clean,
  // since --clean already removed everything)
  if (!opts.clean) {
    const overwrites = findOverwrites(files, outputDir);

    if (overwrites.length > 0) {
      console.log(`The following ${overwrites.length} existing file(s) will be overwritten in ${outputDir}/:`);
      overwrites.forEach(f => console.log(`  ${f}`));
      console.log('');

      if (!opts.force) {
        console.log('To proceed, re-run with --force to overwrite these files,');
        console.log('or use --clean to wipe the output directory first.');
        console.log('');
        console.log('WARNING: --clean will delete ALL files in the output directory,');
        console.log('including non-Slacker files. Do NOT use --clean when pointing at');
        console.log('a live SquadJS install.');
        process.exit(1);
      }

      console.log('--force specified: proceeding with overwrite...');
      console.log('');
    }
  }

  let copied = 0;
  for (const [relPath, { source }] of files) {
    const dest = path.join(outputDir, relPath);
    const destDir = path.dirname(dest);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(source, dest);
    copied++;
  }

  return copied;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs();
  const plugins = validatePlugins(args.plugins);

  console.log(`Plugins selected: ${plugins.join(', ')}`);
  console.log(`Output directory: ${args.output}`);
  if (args.withTools) console.log('  (including tools/)');
  if (args.withTesting) console.log('  (including testing/)');
  console.log('');

  const files = collectFiles(plugins, args);

  if (files.size === 0) {
    console.log('No files to copy.');
    process.exit(0);
  }

  const copied = copyFiles(files, args.output, { clean: args.clean, force: args.force });

  console.log(`Done — ${copied} files written to ${args.output}/`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Copy the contents of ${args.output}/ into your SquadJS squad-server/ directory`);
  console.log('  2. Add the plugins to your config.json (S3 must be first in the plugins array)');
  console.log('  3. Restart SquadJS');
}

main();