/**
 * Rated-Player Spread Analysis
 * Cross-references DB backup with JSONL match log.
 *
 * Usage: node analyze-rated-spread.js <backup.json> <matchlog.jsonl>
 */

import readline from 'readline';
import fs from 'fs';

const dbPath    = process.argv[2];
const jsonlPath = process.argv[3];
if (!dbPath || !jsonlPath) {
  console.error('Usage: node analyze-rated-spread.js <backup.json> <matchlog.jsonl>');
  process.exit(1);
}

const MIN_RATED_PER_TEAM = 3;
const RATED_MIN_GAMES    = 5;
const BUCKET_SIZE        = 0.5;

const db = JSON.parse(fs.readFileSync(dbPath));
const playerDB = new Map();
for (const p of db.players) playerDB.set(p.eosID, p);
console.log(`DB loaded: ${playerDB.size} players`);

const bucketsAll    = {}; // full team average
const bucketsRated  = {}; // rated-only average

let totalGames = 0;
let skipped    = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(jsonlPath),
  crlfDelay: Infinity
});

const addToBucket = (store, absDiff, outcome, favored) => {
  const key = Math.floor(absDiff / BUCKET_SIZE) * BUCKET_SIZE;
  if (!store[key]) store[key] = { total: 0, favoredWins: 0 };
  store[key].total++;
  if (outcome === favored) store[key].favoredWins++;
};

rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;

  let match;
  try { match = JSON.parse(line); }
  catch { skipped++; return; }

  const { players, outcome } = match;
  if (!players || !outcome || outcome === 'draw') { skipped++; return; }

  const team1 = players.filter(p => p.teamID === 1);
  const team2 = players.filter(p => p.teamID === 2);
  if (!team1.length || !team2.length) { skipped++; return; }

  totalGames++;

  // --- Full team average spread ---
  const avg = arr => arr.reduce((s, p) => s + p.muBefore, 0) / arr.length;
  const fullDiff  = avg(team1) - avg(team2);
  const fullFavored = fullDiff > 0 ? 'team1win' : 'team2win';
  addToBucket(bucketsAll, Math.abs(fullDiff), outcome, fullFavored);

  // --- Rated-only average spread ---
  const isRated = p => { const d = playerDB.get(p.eosID); return d && d.roundsPlayed >= RATED_MIN_GAMES; };
  const rated1  = team1.filter(isRated);
  const rated2  = team2.filter(isRated);

  if (rated1.length >= MIN_RATED_PER_TEAM && rated2.length >= MIN_RATED_PER_TEAM) {
    const ratedDiff   = avg(rated1) - avg(rated2);
    const ratedFavored = ratedDiff > 0 ? 'team1win' : 'team2win';
    addToBucket(bucketsRated, Math.abs(ratedDiff), outcome, ratedFavored);
  }
});

rl.on('close', () => {
  const printTable = (label, data) => {
    console.log(`\n=== ${label} ===\n`);
    const keys = Object.keys(data).map(Number).sort((a, b) => a - b);
    if (!keys.length) { console.log('No data.'); return; }
    console.log(`${'Spread'.padEnd(12)} ${'Games'.padEnd(8)} ${'FavouredWin%'.padEnd(15)} ${'Bar'}`);
    console.log('─'.repeat(60));
    let signal = 0, total = 0;
    for (const key of keys) {
      const b      = data[key];
      const winPct = (b.favoredWins / b.total * 100).toFixed(1);
      const bar    = '█'.repeat(Math.round(b.favoredWins / b.total * 20));
      const lbl    = `${key}–${key + BUCKET_SIZE}`;
      console.log(`${lbl.padEnd(12)} ${String(b.total).padEnd(8)} ${(winPct + '%').padEnd(15)} ${bar}`);
      total += b.total;
      if (key >= 2) signal += b.total;
    }
    console.log('─'.repeat(60));
    console.log(`Signal ratio (spread >= 2): ${signal} / ${total} (${(signal/total*100).toFixed(1)}%)`);
  };

  console.log(`\nTotal games: ${totalGames} | Skipped: ${skipped}`);
  printTable('Full Team Average Spread', bucketsAll);
  printTable(`Rated-Only Average Spread (≥${RATED_MIN_GAMES} games, ≥${MIN_RATED_PER_TEAM} per team)`, bucketsRated);
});