/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║      README ACCURACY — OPTION DEFAULTS CHECKED AGAINST CODE   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Same rationale as smart-assign/testing/test-readme-accuracy.js: a
 * documented default that silently disagrees with optionsSpecification has
 * no runtime to fail it, and team-balancer's own enableDatabaseLogging
 * default flipped in the same 2026-08-28 session that motivated this file.
 * Gives README.md's "Configuration" option table a runtime.
 *
 * Built on the shared parser in s3/testing/doc-table-parser.js.
 *
 * ─── WHAT IS DELIBERATELY NOT COVERED ────────────────────────────
 *
 * Prose, and anything not expressed as an `| Option | ... | Default | ... |`
 * row. team-balancer's README also has a "Setting | Value" comparison table
 * (native-vote-timing vs. scramble-timing) — its header doesn't name an
 * "Option"/"Default" column pair, so the parser correctly ignores it.
 *
 * Usage: node team-balancer/testing/test-readme-accuracy.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOptionDefaultsFromSource, parseMarkdownOptionTables, normaliseDefault } from '../../s3/testing/doc-table-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..');

const PLUGIN_SRC = fs.readFileSync(path.join(PLUGIN_DIR, 'plugins', 'team-balancer.js'), 'utf8');
const README = fs.readFileSync(path.join(PLUGIN_DIR, 'README.md'), 'utf8');

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

const declared = parseOptionDefaultsFromSource(PLUGIN_SRC);
const documented = parseMarkdownOptionTables(README);

runTest('optionsSpecification parsed a plausible number of options', () => {
  assert.ok(declared.size >= 10, `Parsed only ${declared.size} options — the parser has probably broken`);
});

runTest('README option table parsed a plausible number of rows', () => {
  assert.ok(documented.size >= 10, `Parsed only ${documented.size} rows — the parser has probably broken`);
});

runTest('README option defaults match optionsSpecification', () => {
  const mismatches = [];
  for (const [name, docDefault] of documented) {
    if (!declared.has(name)) continue; // covered by the next test
    const srcDefault = declared.get(name);
    if (normaliseDefault(docDefault) !== normaliseDefault(srcDefault)) {
      mismatches.push(`${name}: README says ${docDefault}, source says ${srcDefault}`);
    }
  }
  assert.deepEqual(mismatches, [], `Documented defaults disagree with source:\n   ${mismatches.join('\n   ')}`);
});

runTest('README documents every option the plugin declares', () => {
  const missing = [...declared.keys()].filter((n) => !documented.has(n));
  assert.deepEqual(missing, [],
    `Declared in optionsSpecification but absent from README's option table: ${missing.join(', ')}`);
});

runTest('README documents no option the plugin does not declare', () => {
  const bogus = [...documented.keys()].filter((n) => !declared.has(n));
  assert.deepEqual(bogus, [],
    `Documented in README but not declared by optionsSpecification: ${bogus.join(', ')}`);
});

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
