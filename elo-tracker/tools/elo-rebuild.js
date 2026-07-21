#!/usr/bin/env node
/**
 * elo-rebuild.js
 *
 * Replays all recorded matches from scratch using the corrected
 * team-size-neutral TrueSkill formula. Outputs a restore-compatible
 * JSON backup.
 *
 * Usage:
 *   node elo-rebuild.js <matchlog.jsonl> <backup.json> [output.json]
 *
 * - matchlog.jsonl  Source of truth for all match outcomes + participants
 * - backup.json     Existing backup — used only to preserve steamID/discordID
 * - output.json     Output path (default: elo-rebuilt-<timestamp>.json)
 *
 * The output is drop-in compatible with !elo restore.
 */

import fs from 'fs';
import * as readline from 'readline';
import EloCalculator from '../utils/elo-calculator.js';

// ─── Main ───────────────────────────────────────────────────────────────────

async function loadMatches(jsonlPath) {
  return new Promise((resolve, reject) => {
    const matches = [];
    const stream  = fs.createReadStream(jsonlPath, 'utf8');
    const reader  = readline.createInterface({ input: stream, crlfDelay: Infinity });
    reader.on('line', line => { if (line.trim()) matches.push(JSON.parse(line)); });
    reader.on('close', () => resolve(matches));
    reader.on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const matchlogPath = args[0];
  const backupPath = args[1];
  const outputArg = args[2];

  if (!matchlogPath || !backupPath) {
    console.error('Usage: node elo-rebuild.js <matchlog.jsonl> <backup.json> [output.json]');
    process.exit(1);
  }

  const outputPath = outputArg ?? `elo-rebuilt-${Date.now()}.json`;

  // Load inputs
  const matches = await loadMatches(matchlogPath);
  const backup  = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

  // Build steamID/discordID lookup from existing backup
  const metaLookup = new Map(); // eosID → { steamID, discordID }
  const backupPlayers = Array.isArray(backup) ? backup : backup.players ?? Object.values(backup);
  for (const p of backupPlayers) {
    metaLookup.set(p.eosID ?? p.eos_id, { steamID: p.steamID ?? null, discordID: p.discordID ?? null });
  }

  // Sort matches chronologically
  matches.sort((a, b) => a.endedAt - b.endedAt);

  // Player state — Map<eosID, { mu, sigma, wins, losses, roundsPlayed, lastSeen, name, steamID, discordID }>
  const players = new Map();

  const getOrInit = (eosID, name, endedAt) => {
    if (!players.has(eosID)) {
      const meta = metaLookup.get(eosID) ?? { steamID: null, discordID: null };
      players.set(eosID, {
        eosID,
        steamID:      meta.steamID,
        discordID:    meta.discordID,
        name,
        mu:           EloCalculator.MU_DEFAULT,
        sigma:        EloCalculator.SIGMA_DEFAULT,
        wins:         0,
        losses:       0,
        roundsPlayed: 0,
        lastSeen:     endedAt
      });
    }
    return players.get(eosID);
  };

  let processed = 0;
  let skipped   = 0;

  for (const match of matches) {
    const team1Players = match.players.filter(p => p.teamID === 1);
    const team2Players = match.players.filter(p => p.teamID === 2);

    if (team1Players.length === 0 || team2Players.length === 0) {
      skipped++;
      continue;
    }

    // Ensure all players exist in state map
    for (const p of match.players) getOrInit(p.eosID, p.name, match.endedAt);

    // Build rating arrays for calculator
    const toRating = p => ({
      eosID: p.eosID,
      mu: players.get(p.eosID).mu,
      sigma: players.get(p.eosID).sigma,
      participationRatio: p.participationRatio
    });
    
    const t1Ratings = team1Players.map(toRating);
    const t2Ratings = team2Players.map(toRating);

    const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(t1Ratings, t2Ratings, match.outcome);

    const isTeam1Winner = match.outcome === 'team1win';
    const isTeam2Winner = match.outcome === 'team2win';

    // Apply scaled updates
    const applyUpdates = (matchPlayers, updates, isWinner, isLoser) => {
      matchPlayers.forEach((mp, i) => {
        const state = players.get(mp.eosID);
        const { deltaMu, deltaSigma } = updates[i];
        const scaled_dMu    = deltaMu    * mp.participationRatio;
        const scaled_dSigma = deltaSigma * mp.participationRatio;

        state.mu           = state.mu + scaled_dMu;
        state.sigma        = Math.max(state.sigma - scaled_dSigma, 0.5);
        state.roundsPlayed += 1;
        state.wins         += isWinner ? 1 : 0;
        state.losses       += isLoser  ? 1 : 0;
        state.lastSeen     = match.endedAt;
        state.name         = mp.name; // keep most recent name
      });
    };

    applyUpdates(team1Players, team1Updates, isTeam1Winner, isTeam2Winner);
    applyUpdates(team2Players, team2Updates, isTeam2Winner, isTeam1Winner);

    processed++;
    process.stdout.write(`\rReplaying match ${processed} / ${matches.length}...`);
  }

  console.log(`\nDone. Processed: ${processed}, Skipped: ${skipped}`);

  // Build output in backup schema
  const output = {
    exportedAt:  Date.now(),
    playerCount: players.size,
    params: {
      MU_DEFAULT: EloCalculator.MU_DEFAULT,
      SIGMA_DEFAULT: EloCalculator.SIGMA_DEFAULT,
      BETA: EloCalculator.BETA,
      TAU: EloCalculator.TAU,
      DRAW_PROBABILITY: EloCalculator.DRAW_PROBABILITY,
      note: 'Rebuilt from match log using normalized TrueSkill formula.'
    },
    players: Array.from(players.values())
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Written to: ${outputPath}`);
  console.log(`Total players: ${players.size}`);

  // Quick sanity summary
  const muValues = Array.from(players.values()).map(p => p.mu);
  const mean = muValues.reduce((s, v) => s + v, 0) / muValues.length;
  const diverged = muValues.filter(m => Math.abs(m - EloCalculator.MU_DEFAULT) > 0.5).length;
  console.log(`Avg mu: ${mean.toFixed(3)}  |  Players with |mu-${EloCalculator.MU_DEFAULT}| > 0.5: ${diverged} / ${players.size} (${(diverged/players.size*100).toFixed(1)}%)`);
}

main().catch(err => { console.error(err); process.exit(1); });
