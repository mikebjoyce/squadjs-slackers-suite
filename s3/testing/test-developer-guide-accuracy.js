/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   DEVELOPER GUIDE ACCURACY — DOCS CHECKED AGAINST SOURCE      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * S3_DEVELOPER_GUIDE.md is the canonical reference, and it had drifted from the
 * code in ways a reader could not detect. A 2026-08-20 audit found, among
 * others:
 *
 *   - §12.3 documented `enableClanTagGrouping` and
 *     `clanGroupingPullEntireSquads` as defaulting to false. Both default to
 *     TRUE. Anyone reasoning about a default install got clan grouping exactly
 *     backwards.
 *   - §10.1's command table listed one `!s3 migrate` row. Six subcommands
 *     exist, along with `!s3 confirm`, `!s3 db status` and `!s3 backup create`.
 *   - §2.2 gave `onLayerGameModeChange` a four-positional-argument signature.
 *     It takes a single object, so a consumer written from the doc binds the
 *     whole payload to `layer` and gets undefined for the rest — silently.
 *
 * Every one of those is mechanically checkable, and none of them would ever
 * fail a normal test run, because documentation has no runtime. This file gives
 * the doc a runtime.
 *
 * ─── WHAT IS COVERED ─────────────────────────────────────────────
 *
 *   1. Every `!s3 …` command the guide documents is dispatchable, and every
 *      registered top-level handler is documented.
 *   2. Every subcommand the guide documents for migrate/db/backup is branched
 *      on in the source, and vice versa.
 *   3. Every option default in §12.3's table equals the plugin's declared
 *      default, and every declared option appears in the table.
 *   4. §11.1's test-file catalog matches the files on disk.
 *
 * ─── WHAT IS DELIBERATELY NOT COVERED ────────────────────────────
 *
 * Prose. This cannot tell you a paragraph is wrong, only that a name, a
 * default, or a filename disagrees with the source. The audit findings it
 * would NOT have caught — the wrong callback signature, an unmount order
 * described as "the reverse" when it is not — still need a human reading the
 * code. Do not mistake a green run here for a reviewed document.
 *
 * Usage: node s3/testing/test-developer-guide-accuracy.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const S3_DIR = path.resolve(__dirname, '..');

const GUIDE = fs.readFileSync(path.join(S3_DIR, 'S3_DEVELOPER_GUIDE.md'), 'utf8');
const COMMANDS_SRC = fs.readFileSync(path.join(S3_DIR, 'utils', 's3-commands.js'), 'utf8');
const PLUGIN_SRC = fs.readFileSync(path.join(S3_DIR, 'plugins', 'slackers-squad-services.js'), 'utf8');

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log('✅ ' + name);
    passed++;
  } catch (err) {
    console.error('❌ ' + name);
    console.error('   ' + err.message);
    failed++;
  }
}

/**
 * Extract the §10.1 command table's first column.
 *
 * Only the §10.1 table counts. `!s3 …` appears all over the guide in prose and
 * in remediation hints, and treating those as documentation would make the test
 * pass for the wrong reason — a command mentioned in passing in §9.8 is not a
 * command the reference documents.
 */
function documentedCommands() {
  const start = GUIDE.indexOf('### 10.1 —');
  assert.ok(start > -1, 'Could not locate §10.1 in the guide');
  const end = GUIDE.indexOf('### 10.2 —', start);
  assert.ok(end > start, 'Could not locate the end of §10.1');
  const section = GUIDE.slice(start, end);

  const out = [];
  for (const line of section.split('\n')) {
    // Table rows only: | `!s3 something` | description |
    const m = /^\|\s*`!s3 ([^`]+)`/.exec(line.trim());
    if (m) out.push(m[1].trim());
  }
  assert.ok(out.length > 5, `Parsed only ${out.length} rows from §10.1 — the parser has probably broken`);
  return out;
}

/** Top-level handler names actually registered in s3-commands.js. */
function registeredHandlers() {
  return [...COMMANDS_SRC.matchAll(/handlers\.set\('([a-z-]+)'/g)].map((m) => m[1]);
}

/** Subcommand values branched on for a given `<x>Sub` variable. */
function registeredSubcommands(variable) {
  const re = new RegExp(`${variable} === '([a-z-]+)'`, 'g');
  return [...new Set([...COMMANDS_SRC.matchAll(re)].map((m) => m[1]))];
}

/** Option name → default, parsed from the plugin's optionsSpecification. */
function declaredOptionDefaults() {
  const start = PLUGIN_SRC.indexOf('static get optionsSpecification()');
  assert.ok(start > -1, 'Could not locate optionsSpecification');
  // Stop at the constructor, which follows the spec block.
  const end = PLUGIN_SRC.indexOf('constructor(', start);
  const block = PLUGIN_SRC.slice(start, end);

  const defaults = new Map();
  // Six-space indent is the option-name level inside the returned object.
  const optionRe = /^ {6}([a-zA-Z][a-zA-Z0-9_]*): \{$/gm;
  let m;
  while ((m = optionRe.exec(block)) !== null) {
    const name = m[1];
    const rest = block.slice(m.index);
    const defMatch = /^\s*default: (.+?),?$/m.exec(rest);
    if (defMatch) defaults.set(name, defMatch[1].trim().replace(/,$/, ''));
  }
  assert.ok(defaults.size > 10, `Parsed only ${defaults.size} options — the parser has probably broken`);
  return defaults;
}

/** Option name → documented default string, from §12.3's table. */
function documentedOptionDefaults() {
  const start = GUIDE.indexOf('### 12.3 —');
  assert.ok(start > -1, 'Could not locate §12.3');
  const end = GUIDE.indexOf('### 12.4 —', start);
  const section = GUIDE.slice(start, end);

  const out = new Map();
  for (const line of section.split('\n')) {
    // | `option` | type | `default` | description |
    const m = /^\|\s*`([a-zA-Z][a-zA-Z0-9_]*)`\s*\|[^|]*\|\s*`([^`]*)`\s*\|/.exec(line.trim());
    if (m) out.set(m[1], m[2].trim());
  }
  assert.ok(out.size > 10, `Parsed only ${out.size} rows from §12.3 — the parser has probably broken`);
  return out;
}

/**
 * Compare a documented default against the source literal.
 *
 * The two spellings legitimately differ — the source says `["r", "-r"]` and the
 * guide may say `["r", "-r"]` or `['r', '-r']` — so normalise quotes and
 * whitespace rather than demanding a byte match. Anything that still differs
 * after that is a real disagreement about the value.
 */
function normaliseDefault(v) {
  return String(v).replace(/['"]/g, '').replace(/\s+/g, '').toLowerCase();
}

// ─── 1. Top-level commands ────────────────────────────────────────

runTest('§10.1 documents every registered !s3 handler', () => {
  const documented = new Set(documentedCommands().map((c) => c.split(/\s+/)[0]));
  const registered = registeredHandlers();

  const undocumented = registered.filter((h) => !documented.has(h));
  assert.deepEqual(undocumented, [],
    `Registered but absent from the §10.1 table: ${undocumented.join(', ')}`);
});

runTest('§10.1 documents no command that does not exist', () => {
  const registered = new Set(registeredHandlers());
  const bogus = [...new Set(documentedCommands().map((c) => c.split(/\s+/)[0]))]
    .filter((c) => !registered.has(c));

  assert.deepEqual(bogus, [],
    `Documented in §10.1 but no handler is registered: ${bogus.join(', ')}`);
});

// ─── 2. Subcommands ───────────────────────────────────────────────

for (const [parent, variable] of [['migrate', 'migrateSub'], ['db', 'dbSub'], ['backup', 'backupSub']]) {
  runTest(`§10.1 covers every !s3 ${parent} subcommand`, () => {
    const documented = new Set(
      documentedCommands()
        .filter((c) => c.startsWith(`${parent} `))
        .map((c) => c.split(/\s+/)[1])
    );
    const registered = registeredSubcommands(variable);

    const missing = registered.filter((s) => !documented.has(s));
    assert.deepEqual(missing, [],
      `!s3 ${parent} ${missing.join(', ')} exist(s) in source but are not in the §10.1 table`);
  });

  runTest(`§10.1 invents no !s3 ${parent} subcommand`, () => {
    const registered = new Set(registeredSubcommands(variable));
    const bogus = [...new Set(
      documentedCommands()
        .filter((c) => c.startsWith(`${parent} `))
        .map((c) => c.split(/\s+/)[1])
    )].filter((s) => s && !registered.has(s));

    assert.deepEqual(bogus, [],
      `§10.1 documents !s3 ${parent} ${bogus.join(', ')}, which the handler never branches on`);
  });
}

// ─── 3. Option defaults ───────────────────────────────────────────

runTest('§12.3 option defaults match optionsSpecification', () => {
  const declared = declaredOptionDefaults();
  const documented = documentedOptionDefaults();

  const mismatches = [];
  for (const [name, docDefault] of documented) {
    if (!declared.has(name)) continue; // covered by the next test
    const srcDefault = declared.get(name);
    if (normaliseDefault(docDefault) !== normaliseDefault(srcDefault)) {
      mismatches.push(`${name}: guide says ${docDefault}, source says ${srcDefault}`);
    }
  }

  assert.deepEqual(mismatches, [], `Documented defaults disagree with source:\n   ${mismatches.join('\n   ')}`);
});

runTest('§12.3 documents every option the plugin declares', () => {
  const declared = declaredOptionDefaults();
  const documented = documentedOptionDefaults();

  const missing = [...declared.keys()].filter((n) => !documented.has(n));
  assert.deepEqual(missing, [],
    `Declared in optionsSpecification but absent from the §12.3 table: ${missing.join(', ')}`);
});

runTest('§12.3 documents no option the plugin does not declare', () => {
  const declared = declaredOptionDefaults();
  const documented = documentedOptionDefaults();

  const bogus = [...documented.keys()].filter((n) => !declared.has(n));
  assert.deepEqual(bogus, [],
    `Documented in §12.3 but not declared by the plugin: ${bogus.join(', ')}`);
});

// ─── 4. Test catalog ──────────────────────────────────────────────

runTest('§11.1 test catalog matches s3/testing/ on disk', () => {
  const start = GUIDE.indexOf('**Test file catalog:**');
  assert.ok(start > -1, 'Could not locate the §11.1 test catalog');
  const end = GUIDE.indexOf('### 11.2 —', start);
  const section = GUIDE.slice(start, end);

  const documented = new Set(
    [...section.matchAll(/^\|\s*`(test-[a-z0-9-]+\.js)`/gm)].map((m) => m[1])
  );

  const onDisk = new Set(
    fs.readdirSync(path.join(S3_DIR, 'testing'))
      .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
  );

  const missing = [...onDisk].filter((f) => !documented.has(f)).sort();
  const stale = [...documented].filter((f) => !onDisk.has(f)).sort();

  assert.deepEqual(missing, [], `Test files on disk but absent from the §11.1 catalog: ${missing.join(', ')}`);
  assert.deepEqual(stale, [], `Listed in the §11.1 catalog but not on disk: ${stale.join(', ')}`);
});

// ─── Results ──────────────────────────────────────────────────────

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
