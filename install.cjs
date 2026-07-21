#!/usr/bin/env node
/**
 * SquadJS Slacker's Suite — Install Script (Node.js)
 *
 * Assembles selected plugins into a deployable `out/` folder matching
 * SquadJS's expected `squad-server/` layout.
 *
 * Usage:
 *   node install.cjs --plugin=<name> [--output=<path>] [--with-tools] [--with-testing]
 *
 *   --plugin     s3 | team-balancer | elo-tracker | smart-assign | switch | all
 *                (S3 is always auto-included — every consumer plugin depends on it)
 *   --output     Output directory (default: ./out)
 *   --with-tools      Also copy tools/ directories
 *   --with-testing    Also copy testing/ directories
 *
 * Examples:
 *   node install.cjs --plugin=s3
 *   node install.cjs --plugin=team-balancer
 *   node install.cjs --plugin=all --with-tools
 *   node install.cjs --plugin=switch,smart-assign --output=../my-squadjs/squad-server
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Constants ───────────────────────────────────────────────────────────────

const MONOREPO_ROOT = __dirname;

const ALL_PLUGINS = ['s3', 'team-balancer', 'elo-tracker', 'smart-assign', 'switch'];

// S3 base class files that consumer plugins depend on at runtime.
// These live in s3/plugins/ alongside the main S3 plugin entry point.
const S3_BASE_CLASS_FILES = ['s3-plugin-base.js', 's3-discord-plugin-base.js'];

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

Options:
  --plugin=<name>   Plugin(s) to install: s3, team-balancer, elo-tracker,
                    smart-assign, switch, or all (comma-separated).
                    S3 is always auto-included.
  --output=<path>   Output directory (default: ./out)
  --with-tools      Also copy tools/ directories
  --with-testing    Also copy testing/ directories
  --help, -h        Show this help

Examples:
  node install.cjs --plugin=s3
  node install.cjs --plugin=team-balancer
  node install.cjs --plugin=all --with-tools
  node install.cjs --plugin=switch,smart-assign --output=../my-squadjs/squad-server
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
 * Get the relative path from a plugin subfolder to a file within it.
 * e.g., "s3/plugins/foo.js" → "plugins/foo.js"
 */
function relativeToPlugin(pluginName, filePath) {
  const pluginDir = path.join(MONOREPO_ROOT, pluginName);
  return path.relative(pluginDir, filePath);
}

/**
 * Collect all files to copy for a set of plugins.
 * Returns: Map<relativePath, { source: absolutePath, plugin: pluginName }>
 */
function collectFiles(plugins, opts) {
  const files = new Map(); // relativePath → { source, plugin }

  const dirsToCopy = [...ALWAYS_DIRS];
  if (opts.withTools) dirsToCopy.push('tools');
  if (opts.withTesting) dirsToCopy.push('testing');

  for (const pluginName of plugins) {
    const pluginDir = path.join(MONOREPO_ROOT, pluginName);

    if (!fs.existsSync(pluginDir)) {
      console.error(`Error: Plugin directory not found: ${pluginDir}`);
      process.exit(1);
    }

    for (const dirName of dirsToCopy) {
      const dirPath = path.join(pluginDir, dirName);
      if (!fs.existsSync(dirPath)) continue;

      const allFiles = listFilesRecursive(dirPath);

      for (const filePath of allFiles) {
        const ext = path.extname(filePath).toLowerCase();
        if (!COPY_EXTENSIONS.has(ext)) continue;

        // Skip README files
        const basename = path.basename(filePath).toLowerCase();
        if (basename === 'readme.md' || basename === 'readme.mdx') continue;

        const rel = relativeToPlugin(pluginName, filePath);

        if (files.has(rel)) {
          const existing = files.get(rel);
          console.error(
            `\nCollision detected: "${rel}"\n` +
            `  → ${existing.plugin}/${rel}\n` +
            `  → ${pluginName}/${rel}\n` +
            `\nRename one of the files to resolve the conflict before retrying.`
          );
          process.exit(1);
        }

        files.set(rel, { source: filePath, plugin: pluginName });
      }
    }
  }

  return files;
}

// ─── Copy ────────────────────────────────────────────────────────────────────

function copyFiles(files, outputDir) {
  // Remove existing output directory if present
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
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

  const copied = copyFiles(files, args.output);

  console.log(`Done — ${copied} files written to ${args.output}/`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Copy the contents of ${args.output}/ into your SquadJS squad-server/ directory`);
  console.log('  2. Add the plugins to your config.json (S3 must be first in the plugins array)');
  console.log('  3. Restart SquadJS');
}

main();