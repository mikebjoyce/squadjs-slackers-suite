/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     CATEGORY 1 — IDENTIFIER CASE SCAN                         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Static scan. Fails the build when source compares a showAllTables()
 * result by equality.
 *
 * MySQL initialized with lower_case_table_names=1 stores every table name
 * folded to lowercase and reports the folded name back from showAllTables(),
 * while createTable, describeTable and every query that *names* the table keep
 * working — the server folds those identifiers too. showAllTables() is the one
 * place the difference is observable, which is why an exact-match comparison
 * there survives every other test and then reads a healthy live table as
 * missing.
 *
 * Measured across the four configurations the suite runs (2026-09-03),
 * declaring `MixedCase_Matrix`:
 *
 *   mysql lctn=0   MixedCase_Matrix   declared == stored
 *   mysql lctn=1   mixedcase_matrix   declared != stored   ← production
 *   postgres       MixedCase_Matrix   declared == stored
 *   sqlite         MixedCase_Matrix   declared == stored
 *
 * One configuration in four diverges, and it is the one production runs. The
 * setting cannot be changed on a live server: it is read-only at runtime, and
 * MySQL 8 refuses to start when it disagrees with the data dictionary it was
 * initialized against. So the convention has to be enforced here, in the code,
 * rather than on the server.
 *
 * The rule: never compare showAllTables() output with === or Array.includes().
 * Use qi.tableExists() inside a migration, hasTable() in the engine, or fold
 * both sides yourself. Folding the array first is fine and passes this scan —
 * the taint is not carried through .map(), because a mapped array is normally
 * a deliberate normalisation.
 *
 * Category: 1 (static — no DB, no server)
 * Run:    node s3/testing/test-identifier-case.js
 */

'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SCAN_DIRS = [
  'core-plugins',
  'elo-tracker/plugins', 'elo-tracker/utils', 'elo-tracker/testing',
  'smart-assign/plugins', 'smart-assign/utils', 'smart-assign/testing',
  'switch/plugins', 'switch/utils', 'switch/testing',
  'team-balancer/plugins', 'team-balancer/utils', 'team-balancer/testing',
  's3/plugins', 's3/utils', 's3/testing',
  'tools'
];

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// This file's own test fixtures are string literals containing the exact
// banned shapes, on purpose, to prove the scan can fail. Scanning this file
// would flag its own fixtures.
const EXCLUDE_FILES = new Set(['s3/testing/test-identifier-case.js']);

function collectSourceFiles() {
  const files = [];
  for (const rel of SCAN_DIRS) {
    const dir = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relPath = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
      if (EXCLUDE_FILES.has(relPath)) continue;
      files.push(full);
    }
  }
  return files;
}

/**
 * Find equality comparisons against a showAllTables() result.
 *
 * Two shapes are flagged:
 *   const t = await qi.showAllTables();  … later …  t.includes(x)
 *   (await qi.showAllTables()).includes(x)
 *
 * A binding assigned from a chained call — `(await qi.showAllTables()).map(…)`
 * — is not tainted, so the correct fold-then-compare idiom passes. Comment
 * lines are skipped so prose describing the rule does not trip it.
 *
 * A line carrying (or immediately preceded by) a `case-fold-scan:allow`
 * comment is never flagged. The only legitimate use is a test that asserts
 * the exact-case name is ABSENT, to prove folding actually happened — see
 * test-migration-pipeline.js's case-folding regression tests. That escape
 * hatch is explicit and requires a marker rather than working by omission,
 * so a real bug can't hide behind it silently.
 *
 * @param {string} source
 * @returns {Array<{line: number, text: string, why: string}>}
 */
function findCaseSensitiveComparisons(source) {
  const lines = source.split('\n');
  const isComment = (l) => {
    const t = l.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
  };
  // A marker on the flagged line itself always applies. A marker on the
  // previous line only applies if that line is a standalone comment — a
  // trailing marker on a line of real code must not bleed forward onto the
  // next line, or one allowed offense would silently shield an unrelated one.
  const isAllowed = (i) =>
    /case-fold-scan:allow/.test(lines[i]) ||
    (i > 0 && isComment(lines[i - 1]) && /case-fold-scan:allow/.test(lines[i - 1]));

  const offenders = [];
  const tainted = new Set();

  // Pass 1 — bindings taken straight from showAllTables(), no chained call after.
  const bindRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*await\s+[^;\n]*?showAllTables\s*\([^)]*\)\s*\)?\s*;/;
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    const m = line.match(bindRe);
    if (m) tainted.add(m[1]);
    void i;
  });

  // Pass 2 — the comparisons themselves.
  lines.forEach((line, i) => {
    if (isComment(line) || isAllowed(i)) return;

    if (/await\s+[^;\n]*?showAllTables\s*\([^)]*\)\s*\)?\s*\.includes\s*\(/.test(line)) {
      offenders.push({ line: i + 1, text: line.trim(), why: 'showAllTables().includes(…)' });
      return;
    }

    for (const name of tainted) {
      const includesRe = new RegExp(`\\b${name}\\.includes\\s*\\(`);
      if (includesRe.test(line)) {
        offenders.push({ line: i + 1, text: line.trim(), why: `${name}.includes(…) — ${name} holds showAllTables() output` });
      }
    }
  });

  return offenders;
}

test('the scan can fail — it detects both banned shapes and clears the correct one', () => {
  const bad1 = "const tables = await qi.showAllTables();\nif (tables.includes('T')) { }";
  const bad2 = "if ((await qi.showAllTables()).includes('T')) { }";
  const good1 = "const t = (await qi.showAllTables()).map((x) => x.toLowerCase());\nif (t.includes('t')) { }";
  const good2 = "if (await qi.tableExists('T')) { }";
  const good3 = "// never write existing.includes('T') here";
  const good4 = "if ((await qi.showAllTables()).includes('T')) { } // case-fold-scan:allow — testing the marker";
  const good5 = "// case-fold-scan:allow — testing the marker\nif ((await qi.showAllTables()).includes('T')) { }";

  assert.equal(findCaseSensitiveComparisons(bad1).length, 1, 'missed the tainted-binding shape');
  assert.equal(findCaseSensitiveComparisons(bad2).length, 1, 'missed the inline shape');
  assert.equal(findCaseSensitiveComparisons(good1).length, 0, 'flagged the correct fold-then-compare idiom');
  assert.equal(findCaseSensitiveComparisons(good2).length, 0, 'flagged qi.tableExists()');
  assert.equal(findCaseSensitiveComparisons(good3).length, 0, 'flagged a comment');
  assert.equal(findCaseSensitiveComparisons(good4).length, 0, 'ignored a trailing case-fold-scan:allow marker');
  assert.equal(findCaseSensitiveComparisons(good5).length, 0, 'ignored a leading case-fold-scan:allow marker');

  // The marker is an escape hatch, not a suppressor with no cost: it must not
  // blind the scan to an offense on an unrelated line nearby.
  const stillCaught =
    "if ((await qi.showAllTables()).includes('T')) { } // case-fold-scan:allow — testing the marker\n" +
    "if ((await qi.showAllTables()).includes('U')) { }";
  assert.equal(findCaseSensitiveComparisons(stillCaught).length, 1, 'marker suppressed an unmarked line too');
});

test('no source file compares showAllTables() output by equality', () => {
  const offenders = [];
  let inspected = 0;

  for (const file of collectSourceFiles()) {
    inspected++;
    const source = fs.readFileSync(file, 'utf8');
    for (const o of findCaseSensitiveComparisons(source)) {
      offenders.push(`${path.relative(REPO_ROOT, file).replace(/\\/g, '/')}:${o.line} — ${o.why}\n      ${o.text}`);
    }
  }

  assert.ok(inspected > 40, `scan inspected only ${inspected} files — the directory list is probably wrong`);

  assert.deepEqual(
    offenders,
    [],
    'showAllTables() output compared by equality — folds to lowercase on MySQL with\n' +
    '  lower_case_table_names=1, so these read a live table as missing. Use\n' +
    '  qi.tableExists(name) in a migration, hasTable() in the engine, or lowercase\n' +
    '  both sides before comparing:\n\n    ' + offenders.join('\n    ') + '\n'
  );
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

console.log('='.repeat(65));
console.log('Identifier Case Scan  (static)');
console.log('='.repeat(65));
console.log('');

for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${t.name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

console.log('');
console.log('─'.repeat(65));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('─'.repeat(65));

process.exit(failed > 0 ? 1 : 0);
