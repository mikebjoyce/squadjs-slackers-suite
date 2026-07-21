/**
 * ⚠️ DEPRECATED
 * This file is preserved for backward compatibility with existing
 * CLI tooling and standalone workflows. It is NOT used by the S³
 * plugin runtime.
 *
 * Superseded by: S³ backup/export system (s3-export-import.js)
 * See: SlackersSquadServices/utils/s3-export-import.js
 *
 * To be removed: Stage 9
 */

import { readFileSync, writeFileSync } from 'fs';

// --- Config ---
const FILE_A   = process.argv[2];
const FILE_B   = process.argv[3];
const OUT_FILE = process.argv[4] ?? 'merged-match-log.jsonl';

if (!FILE_A || !FILE_B) {
  console.error('Usage: node merge-match-logs.mjs <fileA> <fileB> [output]');
  process.exit(1);
}

// --- Parse ---
function parseJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map((line, i) => {
      try { return JSON.parse(line); }
      catch { console.warn(`Skipping malformed line ${i + 1} in ${path}`); return null; }
    })
    .filter(Boolean);
}

const entriesA = parseJsonl(FILE_A);
const entriesB = parseJsonl(FILE_B);

// --- Deduplicate by matchId, FILE_A wins on conflict ---
const seen = new Map();
for (const entry of [...entriesA, ...entriesB]) {
  if (!seen.has(entry.matchId)) seen.set(entry.matchId, entry);
}

// --- Sort by endedAt ascending ---
const merged = [...seen.values()].sort((a, b) => a.endedAt - b.endedAt);

// --- Write ---
const output = merged.map(e => JSON.stringify(e)).join('\n') + '\n';
writeFileSync(OUT_FILE, output, 'utf8');

console.log(`Merged ${entriesA.length} + ${entriesB.length} entries`);
console.log(`Duplicates removed: ${entriesA.length + entriesB.length - merged.length}`);
console.log(`Output: ${merged.length} records → ${OUT_FILE}`);
