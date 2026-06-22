#!/usr/bin/env node
/**
 * elo-clans-audit.js
 *
 * Utility script to test and verify clan tag extraction and normalization logic.
 * Reads player names from a database export (e.g. tools/rebuilt.json) and
 * outputs a report of all detected clan groupings and orphaned names.
 *
 * Usage:
 *   node tools/elo-clans-audit.js [path/to/db.json]
 */

import { readFileSync, writeFileSync } from 'fs';
import { extractRawPrefix, normalizeTag } from '../testing/elo-clan-grouping.js';


const args = process.argv.slice(2);
const dbPath = args[0] || 'tools/rebuilt.json';

// Ensure the db exists
let rawData;
try {
  rawData = JSON.parse(readFileSync(dbPath, 'utf8'));
} catch (e) {
  console.error(`Could not read ${dbPath}:`, e.message);
  process.exit(1);
}

const players = Array.isArray(rawData) ? rawData : rawData.players ?? Object.values(rawData);

const clanGroups = new Map();
let unassigned = [];

players.forEach(p => {
  const rawPrefix = extractRawPrefix(p.name);
  const normalized = normalizeTag(rawPrefix);

  if (normalized) {
    if (!clanGroups.has(normalized)) {
      clanGroups.set(normalized, []);
    }
    clanGroups.get(normalized).push({ name: p.name, rawPrefix });
  } else {
    // Collect some unassigned names to spot missed tags
    if (unassigned.length < 500) {
      unassigned.push(p.name);
    }
  }
});

// Sort groups by size
const sortedGroups = Array.from(clanGroups.entries())
  .filter(([_, members]) => members.length > 0)
  .sort((a, b) => b[1].length - a[1].length);

let output = '=== CLAN GROUPINGS (All) ===\n\n';

sortedGroups.forEach(([norm, members]) => {
  output += `[${norm}] - ${members.length} members\n`;
  // Show unique raw prefixes that mapped to this group
  const uniqueRaw = [...new Set(members.map(m => m.rawPrefix))];
  output += `  Raw Variations: ${uniqueRaw.join(', ')}\n`;
  // Show up to 5 member names as examples
  output += `  Examples: ${members.slice(0, 5).map(m => m.name).join(', ')}\n\n`;
});

output += '=== SAMPLE UNASSIGNED NAMES (First 200) ===\n';
output += unassigned.slice(0, 200).join('\n');

const outPath = 'tools/clan-audit.txt';
writeFileSync(outPath, output);
console.log(`Audit complete. Processed ${players.length} players.`);
console.log(`Found ${sortedGroups.length} unique clan groupings.`);
console.log(`Results saved to ${outPath}`);
