#!/usr/bin/env node
/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  PLUGIN VERSION BUMP / CHECK                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Keeps each plugin's version in sync across the two places that
 * actually matter, and fails loudly when they drift.
 *
 *   1. `static version = 'X.Y.Z'` in the plugin entry point.
 *      This is the SOURCE OF TRUTH — it is the only one with a
 *      runtime consumer (SmartAssign reads Switch's via the
 *      handshake, see smart-assign.js `_handshakeWithSwitch`).
 *   2. The README H1, `# <Name> Plugin vX.Y.Z`.
 *
 * Deliberately NOT tracked:
 *   - Banner headers. They no longer carry versions; they had no
 *     consumer and were pure maintenance cost.
 *   - Inline `// vX.Y.Z:` change tags. `git blame` and `git log -S`
 *     answer "when did this change" accurately and for free.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node tools/bump-version.cjs --check
 *       Verify every plugin's static version matches its README H1.
 *       Writes nothing. Exit 1 on drift — suitable for CI or a
 *       pre-commit hook.
 *
 *   node tools/bump-version.cjs <plugin> <major|minor|patch> ["summary"]
 *       Bump the plugin, update the README H1, and prepend a
 *       changelog line under "### Version Compatibility" when a
 *       summary is given.
 *
 *   node tools/bump-version.cjs <plugin> <X.Y.Z> ["summary"]
 *       Set an explicit version instead of incrementing.
 *
 *   node tools/bump-version.cjs --list
 *       Print current versions.
 *
 * ─── WHEN TO USE WHICH LEVEL ─────────────────────────────────────
 *
 *   major  breaking change to the plugin's public API or config
 *   minor  new feature, new config option, or a DB schema migration
 *   patch  bug fix with no schema or config change
 *
 * A schema migration is a MINOR bump at minimum — consumers and
 * operators need to know a migration will run.
 *
 * Author:
 * Discord: `real_slacker`
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** plugin key -> { entry: plugin entry point, readme: README path } */
const PLUGINS = {
  's3':            { entry: 's3/plugins/slackers-squad-services.js', readme: 's3/README.md' },
  'switch':        { entry: 'switch/plugins/switch.js',              readme: 'switch/README.MD' },
  'smart-assign':  { entry: 'smart-assign/plugins/smart-assign.js',  readme: 'smart-assign/README.md' },
  'elo-tracker':   { entry: 'elo-tracker/plugins/elo-tracker.js',    readme: 'elo-tracker/README.md' },
  'team-balancer': { entry: 'team-balancer/plugins/team-balancer.js',readme: 'team-balancer/README.md' }
};

// Two declaration forms in use across the suite:
//   static version = '2.5.0';                          (switch, SA, elo, TB)
//   static get version() { return '1.2.1'; }           (S³)
const STATIC_RE = /static\s+(?:get\s+)?version\s*(?:=\s*|\(\s*\)\s*\{\s*return\s+)['"](\d+\.\d+\.\d+)['"]/;
// `[ \t]*` rather than `\s*` on both sides of the version: `\s` matches newlines,
// and with the /m flag a greedy `\s*$` consumes the blank line after the heading,
// silently reflowing the document on every bump.
const H1_RE = /^#[ \t]+(.*?)[ \t]*v(\d+\.\d+\.\d+)[ \t]*$/m;

// ── helpers ────────────────────────────────────────────────────────

function readIfExists(p) {
  const full = path.join(ROOT, p);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

/**
 * Reads a plugin's two version strings.
 * Either may be null when the file is missing or carries no version —
 * S³ declares its version differently, so it is reported, not assumed.
 */
function inspect(key) {
  const { entry, readme } = PLUGINS[key];
  const entrySrc = readIfExists(entry);
  const readmeSrc = readIfExists(readme);
  return {
    key,
    entry,
    readme,
    entryMissing: entrySrc === null,
    readmeMissing: readmeSrc === null,
    staticVersion: entrySrc ? (entrySrc.match(STATIC_RE)?.[1] ?? null) : null,
    readmeVersion: readmeSrc ? (readmeSrc.match(H1_RE)?.[2] ?? null) : null
  };
}

function bumpSemver(current, level) {
  if (/^\d+\.\d+\.\d+$/.test(level)) return level;   // explicit version
  const [maj, min, pat] = current.split('.').map(Number);
  if (level === 'major') return `${maj + 1}.0.0`;
  if (level === 'minor') return `${maj}.${min + 1}.0`;
  if (level === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(`Unknown bump level "${level}" — use major, minor, patch, or an explicit X.Y.Z.`);
}

/**
 * Writes with the SAME encoding discipline the repo needs: UTF-8, no BOM,
 * and existing line endings preserved (fs round-trips bytes faithfully,
 * unlike a PowerShell Get-Content/Set-Content pass, which reads UTF-8 as
 * the ANSI codepage and mangles every em dash in the file).
 */
function write(relPath, contents) {
  fs.writeFileSync(path.join(ROOT, relPath), contents, 'utf8');
}

// ── commands ───────────────────────────────────────────────────────

function cmdList() {
  console.log('');
  for (const key of Object.keys(PLUGINS)) {
    const i = inspect(key);
    const sv = i.staticVersion ?? '—';
    const rv = i.readmeVersion ?? '—';
    console.log(`  ${key.padEnd(15)} static ${sv.padEnd(10)} readme ${rv}`);
  }
  console.log('');
}

function cmdCheck() {
  let problems = 0;
  console.log('');
  for (const key of Object.keys(PLUGINS)) {
    const i = inspect(key);

    if (i.entryMissing) {
      console.log(`  ?  ${key.padEnd(15)} entry point not found: ${i.entry}`);
      problems++;
      continue;
    }
    // A plugin with no `static version` is reported, not failed — S³ declares
    // its version through a different mechanism and should not block the check.
    if (i.staticVersion === null) {
      console.log(`  -  ${key.padEnd(15)} no \`static version\` field (skipped)`);
      continue;
    }
    if (i.readmeMissing || i.readmeVersion === null) {
      console.log(`  !  ${key.padEnd(15)} static ${i.staticVersion}, but no versioned H1 in ${i.readme}`);
      problems++;
      continue;
    }
    if (i.staticVersion !== i.readmeVersion) {
      console.log(`  X  ${key.padEnd(15)} DRIFT: static ${i.staticVersion} != readme ${i.readmeVersion}`);
      problems++;
      continue;
    }
    console.log(`  ok ${key.padEnd(15)} ${i.staticVersion}`);
  }
  console.log('');
  if (problems > 0) {
    console.error(`${problems} version problem(s) found.`);
    process.exit(1);
  }
  console.log('All plugin versions are in sync.');
}

function cmdBump(key, level, summary) {
  if (!PLUGINS[key]) {
    console.error(`Unknown plugin "${key}". Known: ${Object.keys(PLUGINS).join(', ')}`);
    process.exit(1);
  }
  const i = inspect(key);
  if (i.entryMissing) {
    console.error(`Entry point not found: ${i.entry}`);
    process.exit(1);
  }
  if (i.staticVersion === null) {
    console.error(`No \`static version\` field in ${i.entry} — nothing to bump.`);
    process.exit(1);
  }

  const next = bumpSemver(i.staticVersion, level);
  if (next === i.staticVersion) {
    console.error(`Version is already ${next}; nothing to do.`);
    process.exit(1);
  }

  // 1. static version (source of truth)
  const entrySrc = readIfExists(i.entry);
  write(i.entry, entrySrc.replace(STATIC_RE, (m) => m.replace(i.staticVersion, next)));

  // 2. README H1 + optional changelog entry
  let readmeTouched = false;
  let changelogTouched = false;
  if (!i.readmeMissing) {
    let readmeSrc = readIfExists(i.readme);

    if (H1_RE.test(readmeSrc)) {
      readmeSrc = readmeSrc.replace(H1_RE, (_m, name) => `# ${name} v${next}`);
      readmeTouched = true;
    }

    if (summary) {
      const line = `- \`static version = '${next}'\` — ${summary}`;
      const anchor = '### Version Compatibility\n\n';
      const at = readmeSrc.indexOf(anchor);
      if (at !== -1) {
        const insertAt = at + anchor.length;
        readmeSrc = readmeSrc.slice(0, insertAt) + line + '\n' + readmeSrc.slice(insertAt);
        changelogTouched = true;
      }
    }

    write(i.readme, readmeSrc);
  }

  console.log('');
  console.log(`  ${key} ${i.staticVersion} -> ${next}`);
  console.log(`  ${'ok'} static version   (${i.entry})`);
  console.log(`  ${readmeTouched ? 'ok' : '--'} README H1        (${i.readme})`);
  console.log(`  ${changelogTouched ? 'ok' : '--'} changelog entry${summary ? '' : '   (no summary given)'}`);
  console.log('');
  console.log('  Banner headers and inline comments intentionally untouched —');
  console.log('  they no longer carry versions. See this file\'s header.');
  console.log('');
}

// ── entry ──────────────────────────────────────────────────────────

const [, , a, b, c] = process.argv;

if (!a || a === '--help' || a === '-h') {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, ''));
  process.exit(0);
}
if (a === '--check') { cmdCheck(); process.exit(0); }
if (a === '--list')  { cmdList(); process.exit(0); }
if (!b) {
  console.error('Usage: node tools/bump-version.cjs <plugin> <major|minor|patch|X.Y.Z> ["summary"]');
  console.error('       node tools/bump-version.cjs --check | --list');
  process.exit(1);
}
cmdBump(a, b, c);
