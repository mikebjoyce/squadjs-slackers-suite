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
const args = process.argv.slice(2);

if (args.length < 2) {
  console.error('Usage: node merge-match-logs.js <fileA> <fileB> [...moreFiles] [output]');
  console.error('   or: node merge-match-logs.js <dir> [output]');
  process.exit(1);
}

// If first arg is a directory, read all .jsonl files from it
let files;
let outFile;

if (args.length === 2 && !args[0].endsWith('.jsonl') && !args[1].endsWith('.jsonl')) {
  // Could be a directory + output
  const { statSync, readdirSync } = await import('fs');
  try {
    if (statSync(args[0]).isDirectory()) {
      const dir = args[0];
      files = readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .map(f => `${dir}/${f}`);
      outFile = args[1];
    }
  } catch {
    // Not a directory, fall through to file list
  }
}

if (!files) {
  // If last arg doesn't end with .jsonl, it's the output path
  // If there are >= 3 args and last ends with .jsonl, it's likely the output file
  const last = args[args.length - 1];
  if (!last.endsWith('.jsonl')) {
    outFile = last;
    files = args.slice(0, -1);
  } else if (args.length >= 3) {
    // 3+ args, last is .jsonl → treat as output file
    outFile = last;
    files = args.slice(0, -1);
  } else {
    outFile = 'merged-match-log.jsonl';
    files = args;
  }
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

let totalInput = 0;
const seen = new Map();

for (const file of files) {
  const entries = parseJsonl(file);
  totalInput += entries.length;
  for (const entry of entries) {
    if (!seen.has(entry.matchId)) seen.set(entry.matchId, entry);
  }
}

// --- Sort by endedAt ascending ---
const merged = [...seen.values()].sort((a, b) => a.endedAt - b.endedAt);

// --- Write ---
const output = merged.map(e => JSON.stringify(e)).join('\n') + '\n';
writeFileSync(outFile, output, 'utf8');

console.log(`Merged ${files.length} files (${totalInput} total entries)`);
console.log(`Duplicates removed: ${totalInput - merged.length}`);
console.log(`Output: ${merged.length} records → ${outFile}`);
