#!/usr/bin/env node
/**
 * elo-inspect.js
 *
 * Interactive CLI mirroring the !elo and !elo leaderboard Discord output.
 * Optionally accepts a second (before) DB for side-by-side comparison.
 *
 * Usage:
 *   node elo-inspect.js <rebuilt.json>
 *   node elo-inspect.js <rebuilt.json> <old-backup.json>
 *
 * Commands (once running):
 *   !elo <name>           Player stats + local leaderboard
 *   !elo leaderboard      Top 25 by CSR
 *   !elo leaderboard <n>  25 players centred around rank n
 *   !elo top              Top 25 by raw mu (useful for debugging)
 *   !elo spread           Distribution stats (sigma, mu, CSR)
 *   !elo pogue            Quick asymmetry check for any player by name fragment
 *   exit / quit           Exit
 */

import { readFileSync } from 'fs';
import * as readline from 'readline';
import EloCalculator from '../utils/elo-calculator.js';
import { extractRawPrefix, normalizeTag } from '../testing/elo-clan-grouping.js';

// ─── Constants (mirror elo-discord.js) ───────────────────────────────────────

const SIGMA_MULTIPLIER = 3;
const MIN_ROUNDS_RANKED = 10;
const LEADERBOARD_SIZE = 25;
const LOCAL_NEIGHBORHOOD = 9;

// ─── Load DB ─────────────────────────────────────────────────────────────────

function loadDB(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const players = Array.isArray(raw) ? raw : raw.players ?? Object.values(raw);
  // Normalise field names — backup uses camelCase, rebuilt may vary
  return players.map(p => ({
    eosID:        p.eosID       ?? p.eos_id ?? '',
    name:         p.name        ?? '(unknown)',
    mu:           Number(p.mu   ?? 25),
    sigma:        Number(p.sigma ?? 8.333),
    wins:         Number(p.wins ?? 0),
    losses:       Number(p.losses ?? 0),
    roundsPlayed: Number(p.roundsPlayed ?? p.rounds_played ?? 0),
  }));
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node elo-inspect.js <rebuilt.json> [old-backup.json] [matchlog.jsonl]');
  process.exit(1);
}

const dbPath = args[0];
const oldPath = args.length >= 2 && !args[1].endsWith('.jsonl') ? args[1] : null;
const matchlogPath = args.find(a => a.endsWith('.jsonl'));

const dbNew = loadDB(dbPath);
const dbOld = oldPath ? loadDB(oldPath) : null;

console.log(`\nLoaded: ${dbNew.length} players (new)`);
if (dbOld) console.log(`Loaded: ${dbOld.length} players (old / before)`);

let matchlog = null;
if (matchlogPath) {
  try {
    const raw = readFileSync(matchlogPath, 'utf8');
    matchlog = raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
    console.log(`Loaded: ${matchlog.length} matches (log)`);
  } catch(e) {
    console.log(`Failed to load matchlog: ${e.message}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const csr = p => p.mu - SIGMA_MULTIPLIER * p.sigma;

function reliability(sigma) {
  if (sigma <= 2.5) return 'Highly Calibrated';
  if (sigma <= 4.5) return 'Calibrated';
  if (sigma <= 6.5) return 'Establishing';
  return 'Initial Calibration';
}

function ranked(db) {
  return db.filter(p => p.roundsPlayed >= MIN_ROUNDS_RANKED);
}

function leaderboard(db) {
  return ranked(db).sort((a, b) => csr(b) - csr(a));
}

function findPlayer(db, query) {
  const q = query.toLowerCase();
  // Exact name match first
  let hit = db.find(p => p.name.toLowerCase() === q);
  if (!hit) hit = db.find(p => p.name.toLowerCase().includes(q));
  if (!hit) hit = db.find(p => p.eosID === query || p.steamID === query);
  return hit ?? null;
}


function rankOf(board, player) {
  const idx = board.findIndex(p => p.eosID === player.eosID);
  return idx === -1 ? null : idx + 1;
}

function topPercent(rank, total) {
  if (rank === 1) return '0.1';
  const raw = ((rank - 1) / (total - 1)) * 100;
  return raw < 1 ? Math.max(0.1, raw).toFixed(1) : Math.round(raw);
}

// ─── Formatters ──────────────────────────────────────────────────────────────

const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const CYAN   = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const BLUE   = '\x1b[34m';
const MAGENTA= '\x1b[35m';

const b  = s => `${BOLD}${s}${RESET}`;
const c  = s => `${CYAN}${s}${RESET}`;
const y  = s => `${YELLOW}${s}${RESET}`;
const g  = s => `${GREEN}${s}${RESET}`;
const r  = s => `${RED}${s}${RESET}`;
const d  = s => `${DIM}${s}${RESET}`;
const m  = s => `${MAGENTA}${s}${RESET}`;

function hr(char = '─', len = 56) { return char.repeat(len); }

function deltaStr(val, decimals = 2) {
  if (val === null || val === undefined) return d('n/a');
  const sign = val >= 0 ? '+' : '';
  const str = `${sign}${val.toFixed(decimals)}`;
  return val > 0 ? g(str) : val < 0 ? r(str) : d(str);
}

// ─── !elo <player> ────────────────────────────────────────────────────────────

function cmdPlayer(query, db, dbPrev) {
  const player = findPlayer(db, query);
  if (!player) {
    console.log(r(`  No player found matching: "${query}"`));
    return;
  }

  const board   = leaderboard(db);
  const total   = ranked(db).length;
  const totAll  = db.length;
  const prov    = player.roundsPlayed < MIN_ROUNDS_RANKED;
  const rank    = prov ? null : rankOf(board, player);
  const pCsr    = csr(player);
  const wins    = player.wins;
  const losses  = player.losses;
  const games   = wins + losses;
  const wr      = games > 0 ? ((wins / games) * 100).toFixed(1) : '—';

  // Before stats
  let prev = null;
  if (dbPrev) {
    prev = findPlayer(dbPrev, player.name) ?? findPlayer(dbPrev, player.eosID);
  }
  const prevBoard = dbPrev ? leaderboard(dbPrev) : null;

  console.log();
  console.log(b(c(`📊 Player Stats for ${player.name}`)));
  console.log(hr());

  // Rank line
  if (prov) {
    console.log(`  ${y('Provisional')} — ${player.roundsPlayed} rounds played. Rank visible after ${MIN_ROUNDS_RANKED} rounds.`);
    console.log(`  ${d(`(${totAll.toLocaleString()} total tracked)`)}`);
  } else {
    const pct = topPercent(rank, total);
    console.log(`  Rank ${b(`#${rank}`)} of ${b(total.toLocaleString())} ranked players (${totAll.toLocaleString()} total)`);
    console.log(`  Top ${b(pct + '%')} of all players`);
  }
  console.log();

  // CSR
  const csrDiff = prev ? pCsr - csr(prev) : null;
  console.log(`  ${b('CSR (Competitive Skill Rank)')}:`);
  console.log(`    ${b(pCsr.toFixed(1))} CSR  ${d('(μ - 3σ)')}  ${csrDiff !== null ? deltaStr(csrDiff) : ''}`);
  console.log();

  // Mu
  const muDiff = prev ? player.mu - prev.mu : null;
  console.log(`  ${b('Estimated Skill (μ)')}:`);
  console.log(`    ${b(player.mu.toFixed(2))} μ  ${muDiff !== null ? deltaStr(muDiff) : ''}`);
  console.log();

  // Sigma
  const sigDiff = prev ? player.sigma - prev.sigma : null;
  console.log(`  ${b('System Certainty (σ)')}:`);
  console.log(`    ${reliability(player.sigma)}  (${b(player.sigma.toFixed(2))} σ)  ${sigDiff !== null ? deltaStr(sigDiff) : ''}`);
  console.log();

  // Match history
  console.log(`  ${b('Match History')}:`);
  console.log(`    ${wins}W / ${losses}L  (${wr}% winrate)`);
  console.log();

  // Before / after rank comparison
  if (prev && prevBoard) {
    const prevProv = prev.roundsPlayed < MIN_ROUNDS_RANKED;
    const prevRank = prevProv ? null : rankOf(prevBoard, prev);
    const prevCsr  = csr(prev);
    console.log(`  ${b('Before → After')}:`);
    console.log(`    CSR:   ${prevCsr.toFixed(1)} → ${pCsr.toFixed(1)}  (${deltaStr(pCsr - prevCsr)})`);
    console.log(`    μ:     ${prev.mu.toFixed(2)} → ${player.mu.toFixed(2)}  (${deltaStr(player.mu - prev.mu)})`);
    console.log(`    σ:     ${prev.sigma.toFixed(2)} → ${player.sigma.toFixed(2)}  (${deltaStr(player.sigma - prev.sigma)})`);
    if (prevRank && rank) {
      const rankDelta = prevRank - rank; // positive = moved up
      console.log(`    Rank:  #${prevRank} → #${rank}  (${deltaStr(rankDelta, 0)} places)`);
    }
    console.log();
  }

  // Local leaderboard
  if (!prov && rank !== null) {
    const offset = Math.max(0, rank - 5);
    const slice  = board.slice(offset, offset + LOCAL_NEIGHBORHOOD);
    console.log(`  ${b('Local Leaderboard')}:`);
    console.log(`  ${'─'.repeat(48)}`);
    slice.forEach((lp, i) => {
      const lRank  = offset + 1 + i;
      const lpCsr  = csr(lp);
      const isMe   = lp.eosID === player.eosID;
      const marker = isMe ? y('<<') : '  ';
      const rankFmt = `#${lRank.toString().padStart(2)}`;
      const line   = `  ${rankFmt} ${lp.name} — ${lpCsr.toFixed(1)} (${lp.wins}W/${lp.losses}L) ${marker}`;
      console.log(isMe ? b(line) : line);
    });
    console.log();
  }
}

// ─── !elo clan <tag> ─────────────────────────────────────────────────────────

function cmdClan(query, db, dbPrev) {
  if (!query) {
    console.log(r(`  Please specify a clan tag (e.g. !elo clan FRWRD)`));
    return;
  }

  const searchNorm = normalizeTag(query);
  if (!searchNorm) {
    console.log(r(`  Invalid clan tag query.`));
    return;
  }

  // Find all players with a matching normalized clan tag
  const members = db.filter(p => {
    const raw = extractRawPrefix(p.name);
    return normalizeTag(raw) === searchNorm;
  });

  if (members.length === 0) {
    console.log(r(`  No players found with clan tag matching: "${query}"`));
    return;
  }

  // Calculate aggregates
  let totalWins = 0;
  let totalLosses = 0;
  let totalMu = 0;
  let totalSigma = 0;
  let rankedCount = 0;
  let totalCsr = 0;

  // Determine best display name (most common raw tag)
  const rawCounts = {};
  members.forEach(p => {
    const raw = extractRawPrefix(p.name);
    rawCounts[raw] = (rawCounts[raw] || 0) + 1;

    totalWins += p.wins;
    totalLosses += p.losses;
    totalMu += p.mu;
    totalSigma += p.sigma;
    if (p.roundsPlayed >= MIN_ROUNDS_RANKED) {
      rankedCount++;
      totalCsr += csr(p);
    }
  });

  const displayTag = Object.entries(rawCounts).sort((a,b) => b[1] - a[1])[0][0];
  const count = members.length;
  const avgMu = totalMu / count;
  const avgSigma = totalSigma / count;
  const avgCsr = rankedCount > 0 ? totalCsr / rankedCount : null;
  const games = totalWins + totalLosses;
  const wr = games > 0 ? ((totalWins / games) * 100).toFixed(1) : '—';

  console.log();
  console.log(b(c(`🛡️ Clan Stats for ${displayTag}`)));
  console.log(hr());
  console.log(`  ${b('Members')}:       ${count} (${rankedCount} ranked)`);
  console.log(`  ${b('Match History')}: ${totalWins}W / ${totalLosses}L  (${wr}% winrate)`);
  console.log(`  ${b('Average μ')}:     ${avgMu.toFixed(2)}`);
  console.log(`  ${b('Average σ')}:     ${avgSigma.toFixed(2)}`);
  if (avgCsr !== null) {
    console.log(`  ${b('Average CSR')}:   ${avgCsr.toFixed(1)}`);
  }
  console.log();

  // Sort members by CSR
  const sortedMembers = [...members].sort((a, b) => csr(b) - csr(a));

  console.log(b('  Roster'));
  console.log(`  ${'─'.repeat(48)}`);
  sortedMembers.forEach((p, i) => {
    const pCsr = csr(p);
    const prov = p.roundsPlayed < MIN_ROUNDS_RANKED ? y(' [prov]') : '';
    const line = `  ${(i + 1).toString().padStart(2)}. ${p.name.padEnd(24)} ${b(pCsr.toFixed(1))} CSR  ${d(`${p.wins}W/${p.losses}L`)}${prov}`;
    console.log(line);
  });
  console.log();
}

// ─── !elo clans ──────────────────────────────────────────────────────────────

function cmdClans(db, arg) {
  const clans = {};
  const showAll = arg === 'all';
  const limit = showAll ? Infinity : (parseInt(arg, 10) || LEADERBOARD_SIZE);
  const minMembers = showAll ? 1 : 3;

  db.forEach(p => {
    const raw = extractRawPrefix(p.name);
    const norm = normalizeTag(raw);
    if (!norm) return;

    if (!clans[norm]) {
      clans[norm] = {
        norm,
        rawTags: {},
        members: [],
        totalMu: 0,
        totalCsr: 0,
        rankedCount: 0,
        wins: 0,
        losses: 0
      };
    }

    const c = clans[norm];
    c.rawTags[raw] = (c.rawTags[raw] || 0) + 1;
    c.members.push(p);
    c.totalMu += p.mu;
    c.wins += p.wins;
    c.losses += p.losses;
    if (p.roundsPlayed >= MIN_ROUNDS_RANKED) {
      c.rankedCount++;
      c.totalCsr += csr(p);
    }
  });

  const clanList = Object.values(clans)
    .filter(c => c.members.length >= minMembers)
    .map(c => {
      const displayTag = Object.entries(c.rawTags).sort((a,b) => b[1] - a[1])[0][0];
      return {
        ...c,
        displayTag,
        avgCsr: c.rankedCount > 0 ? c.totalCsr / c.rankedCount : -999,
        avgMu: c.totalMu / c.members.length,
        wr: (c.wins + c.losses) > 0 ? (c.wins / (c.wins + c.losses)) * 100 : 0
      };
    })
    .sort((a, b) => b.avgCsr - a.avgCsr);

  const displayLimit = Math.min(limit, clanList.length);
  console.log();
  console.log(b(y(`🛡️ Clan Leaderboard (Top ${displayLimit === Infinity ? 'All' : displayLimit})`)));
  console.log(`   Ranking clans with ≥${minMembers} members by average CSR`);
  console.log(hr());

  clanList.slice(0, limit).forEach((c, i) => {
    const rankStr = `#${(i + 1).toString().padStart(2)}`;
    const csrStr = c.avgCsr === -999 ? d('  n/a') : b(c.avgCsr.toFixed(1).padStart(5));
    const membersStr = `${c.members.length} members`.padEnd(12);
    const wrStr = `${c.wr.toFixed(1)}% WR`.padStart(8);

    console.log(`  ${y(rankStr)} ${c.displayTag.padEnd(20)} ${csrStr} CSR  ${d(membersStr)} ${d(wrStr)}`);
  });
  console.log();
}

// ─── !elo leaderboard [n] ─────────────────────────────────────────────────────

function cmdLeaderboard(targetRank, db, dbPrev) {
  const board     = leaderboard(db);
  const totalRank = board.length;
  const totalAll  = db.length;
  const prevBoard = dbPrev ? leaderboard(dbPrev) : null;

  const clampedTarget = Math.min(Math.max(1, targetRank), totalRank);
  const offset   = Math.max(0, clampedTarget - 13);
  const slice    = board.slice(offset, offset + LEADERBOARD_SIZE);
  const startRk  = offset + 1;
  const endRk    = offset + slice.length;

  console.log();
  console.log(b(y(`🏆 Leaderboard (Ranks ${startRk}–${endRk})`)));
  console.log(`   Out of ${b(totalRank.toLocaleString())} ranked players (${totalAll.toLocaleString()} total)`);
  console.log(hr());

  const rankW = endRk.toString().length + 1;

  slice.forEach((p, i) => {
    const rank   = offset + 1 + i;
    const pCsr   = csr(p);
    const isTarget = rank === clampedTarget && targetRank !== 1;

    let prev = null;
    let prevRank = null;
    if (prevBoard) {
      prev = findPlayer(dbPrev, p.name) ?? findPlayer(dbPrev, p.eosID);
      if (prev && prev.roundsPlayed >= MIN_ROUNDS_RANKED) {
        prevRank = rankOf(prevBoard, prev);
      }
    }

    const rankStr  = `#${rank.toString().padStart(rankW)}`;
    const csrStr   = pCsr.toFixed(1).padStart(6);
    const wlStr    = `${p.wins}W/${p.losses}L`;
    const sigStr   = d(`σ${p.sigma.toFixed(1)}`);

    let diffStr = '';
    if (prev) {
      const prevCsr = csr(prev);
      const csrD   = pCsr - prevCsr;
      diffStr = `  ${deltaStr(csrD)}`;
    }
    let rankDiffStr = '';
    if (prevRank) {
      const rd = prevRank - rank;
      if (rd > 0)      rankDiffStr = g(` ↑${rd}`);
      else if (rd < 0) rankDiffStr = r(` ↓${Math.abs(rd)}`);
      else             rankDiffStr = d(' →');
    }

    const marker = isTarget ? y(' <<') : '';
    const line = `  ${c(rankStr)} ${p.name.padEnd(32)} ${b(csrStr)}  ${d(wlStr)}  ${sigStr}${diffStr}${rankDiffStr}${marker}`;
    console.log(line);
  });
  console.log();
}

// ─── !elo top (by raw mu) ────────────────────────────────────────────────────

function cmdTop(db) {
  const sorted = [...db].sort((a, b) => b.mu - a.mu).slice(0, LEADERBOARD_SIZE);
  console.log();
  console.log(b(m('🔬 Top 25 by Raw μ')));
  console.log(hr());
  sorted.forEach((p, i) => {
    const sigStr = d(`σ${p.sigma.toFixed(2)}`);
    const prov   = p.roundsPlayed < MIN_ROUNDS_RANKED ? y(' [provisional]') : '';
    console.log(`  ${c('#' + (i + 1).toString().padStart(2))} ${p.name.padEnd(32)} ${b(p.mu.toFixed(2) + 'μ')}  ${sigStr}  ${d(p.wins + 'W/' + p.losses + 'L')}${prov}`);
  });
  console.log();
}

// ─── !elo spread ─────────────────────────────────────────────────────────────

function cmdSpread(db, dbPrev) {
  const percentile = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor((p / 100) * sorted.length);
    return sorted[Math.min(idx, sorted.length - 1)];
  };

  const muArr    = db.map(p => p.mu);
  const sigArr   = db.map(p => p.sigma);
  const csrArr   = ranked(db).map(csr);

  console.log();
  console.log(b(m('📈 Distribution Stats')));
  console.log(hr());

  const stat = (label, arr, unit = '') => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mean   = arr.reduce((s, v) => s + v, 0) / arr.length;
    const p10 = percentile(arr, 10);
    const p50 = percentile(arr, 50);
    const p90 = percentile(arr, 90);
    console.log(`  ${b(label.padEnd(12))}  mean=${b(mean.toFixed(2) + unit)}  p10=${p10.toFixed(2) + unit}  p50=${p50.toFixed(2) + unit}  p90=${p90.toFixed(2) + unit}  min=${sorted[0].toFixed(2) + unit}  max=${sorted[sorted.length-1].toFixed(2) + unit}`);
  };

  stat('μ (all)',  muArr,  'μ');
  stat('σ (all)',  sigArr, 'σ');
  stat('CSR',      csrArr, '');

  // Sigma buckets
  const buckets = { 'Highly Calibrated (≤2.5)': 0, 'Calibrated (2.5–4.5)': 0, 'Establishing (4.5–6.5)': 0, 'Initial (>6.5)': 0 };
  db.forEach(p => {
    if (p.sigma <= 2.5)      buckets['Highly Calibrated (≤2.5)']++;
    else if (p.sigma <= 4.5) buckets['Calibrated (2.5–4.5)']++;
    else if (p.sigma <= 6.5) buckets['Establishing (4.5–6.5)']++;
    else                      buckets['Initial (>6.5)']++;
  });
  console.log();
  console.log(`  ${b('Sigma distribution')} (${db.length} players):`);
  Object.entries(buckets).forEach(([k, v]) => {
    const pct = ((v / db.length) * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(v / db.length * 40));
    console.log(`    ${k.padEnd(28)} ${v.toString().padStart(5)}  ${pct.padStart(5)}%  ${g(bar)}`);
  });

  // Asymmetry check across all players with enough games
  const elig = db.filter(p => p.wins + p.losses >= 20);
  if (elig.length > 0) {
    console.log();
    console.log(`  ${b('Win/loss delta asymmetry')} (players with ≥20 games, n=${elig.length}):`);
    console.log(`  ${d('If CSR tracks win rate well, high-WR players should have proportionally high CSR.')}`);
    // Bin by winrate
    const bins = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0];
    for (let i = 0; i < bins.length - 1; i++) {
      const lo = bins[i], hi = bins[i+1];
      const cohort = elig.filter(p => {
        const wr = p.wins / (p.wins + p.losses);
        return wr >= lo && wr < hi;
      });
      if (cohort.length === 0) continue;
      const avgCsr = cohort.reduce((s, p) => s + csr(p), 0) / cohort.length;
      const avgMu  = cohort.reduce((s, p) => s + p.mu, 0) / cohort.length;
      console.log(`    WR ${(lo*100).toFixed(0)}–${(hi*100).toFixed(0)}%  n=${cohort.length.toString().padStart(4)}  avgCSR=${avgCsr.toFixed(1).padStart(6)}  avgμ=${avgMu.toFixed(1).padStart(6)}`);
    }
  }

  console.log();
}

// ─── !elo round [id|random] ──────────────────────────────────────────────────

function cmdRound(targetId, db, mlog) {
  if (!mlog) {
    console.log(r('  No matchlog loaded. Pass a .jsonl file as the third argument.'));
    return;
  }

  let match = null;
  if (!targetId || targetId === 'random') {
    match = mlog[Math.floor(Math.random() * mlog.length)];
  } else {
    match = mlog.find(m => String(m.matchId) === String(targetId));
  }

  if (!match) {
    console.log(r(`  Match not found: ${targetId}`));
    return;
  }

  const getMatchMetrics = (players) => {
    let vCount = 0, pCount = 0, rCount = 0;
    let totalMu = 0, totalRegMu = 0;
    const allMus = [];

    for (const p of players) {
      const mu = p.mu;
      const rounds = p.roundsPlayed ?? 0;
      totalMu += mu;
      allMus.push(mu);
      if (rounds >= MIN_ROUNDS_RANKED) {
        rCount++;
        totalRegMu += mu;
      } else if (rounds > 3) {
        pCount++;
      } else {
        vCount++;
      }
    }

    const count = players.length;
    const veterancy = count > 0 ? rCount / count : 0;

    const top15Slice = [...allMus].sort((a, b) => b - a).slice(0, 15);
    const top15Mu = top15Slice.length > 0
      ? top15Slice.reduce((s, v) => s + v, 0) / top15Slice.length
      : 25.0;

    return {
      count,
      tierStats: { vCount, pCount, rCount },
      tierString: `${vCount} Visitors | ${pCount} Prov. | ${rCount} Regs`,
      avgMu: count > 0 ? totalMu / count : 25.0,
      avgRegMu: rCount > 0 ? totalRegMu / rCount : null,
      top15Mu,
      veterancy
    };
  };

  const matchPlayers = match.players.map(mp => {
    const dbPlayer = db.find(p => p.eosID === mp.eosID) ?? { mu: 25.0, sigma: 8.333, roundsPlayed: 0 };
    return {
      eosID: mp.eosID,
      name: mp.name,
      teamID: mp.teamID,
      participationRatio: mp.participationRatio ?? 1.0,
      mu: dbPlayer.mu,
      sigma: dbPlayer.sigma,
      roundsPlayed: dbPlayer.roundsPlayed
    };
  });

  const team1 = matchPlayers.filter(p => p.teamID === 1);
  const team2 = matchPlayers.filter(p => p.teamID === 2);

  const { team1Updates, team2Updates, debug } = EloCalculator.computeTeamUpdate(team1, team2, match.outcome);

  const processTeam = (players, updates) => {
    const metrics = getMatchMetrics(players);
    let totalDeltaMu = 0;
    let totalDeltaSigma = 0;
    const teamRegulars = [];

    players.forEach((player, i) => {
      const { deltaMu, deltaSigma } = updates[i];
      const scaledDeltaMu = deltaMu * player.participationRatio;
      const scaledDeltaSigma = deltaSigma * player.participationRatio;

      totalDeltaMu += scaledDeltaMu;
      totalDeltaSigma += Math.abs(scaledDeltaSigma);

      const newMu = player.mu + scaledDeltaMu;

      if (player.roundsPlayed >= MIN_ROUNDS_RANKED) {
        teamRegulars.push({
          name: player.name,
          muBefore: player.mu,
          muAfter: newMu,
          deltaMu: scaledDeltaMu
        });
      }
    });

    teamRegulars.sort((a, b) => b.muBefore - a.muBefore);
    let spreadSnapshot = [];
    if (teamRegulars.length <= 5) {
      spreadSnapshot = teamRegulars.map((r, i) => ({ ...r, label: `${i + 1}.` }));
    } else {
      const midIndex = Math.floor(teamRegulars.length / 2);
      spreadSnapshot = [
        { ...teamRegulars[0], label: 'Top:' },
        { ...teamRegulars[1], label: 'Top:' },
        { ...teamRegulars[midIndex], label: 'Mid:' },
        { ...teamRegulars[teamRegulars.length - 2], label: 'Bot:' },
        { ...teamRegulars[teamRegulars.length - 1], label: 'Bot:' }
      ];
    }

    return {
      ...metrics,
      avgDeltaMu: players.length > 0 ? totalDeltaMu / players.length : 0,
      avgDeltaSigma: players.length > 0 ? totalDeltaSigma / players.length : 0,
      spreadSnapshot
    };
  };

  const t1 = processTeam(team1, team1Updates);
  const t2 = processTeam(team2, team2Updates);

  const muDelta = Math.abs(t1.avgMu - t2.avgMu);
  const top15Delta = Math.abs(t1.top15Mu - t2.top15Mu);
  const regDelta = Math.abs(t1.tierStats.rCount - t2.tierStats.rCount);

  const muLeadTeam = t1.avgMu >= t2.avgMu ? 1 : 2;
  const top15LeadTeam = t1.top15Mu >= t2.top15Mu ? 1 : 2;
  const vetAdv = t1.tierStats.rCount === t2.tierStats.rCount ? 'Tie' : `Team ${t1.tierStats.rCount > t2.tierStats.rCount ? 1 : 2}`;

  const totalRegs = t1.tierStats.rCount + t2.tierStats.rCount;
  const leadRegs = Math.max(t1.tierStats.rCount, t2.tierStats.rCount);
  const t1Share = totalRegs > 0 ? Math.round((t1.tierStats.rCount / totalRegs) * 100) : 0;
  const t2Share = totalRegs > 0 ? Math.round((t2.tierStats.rCount / totalRegs) * 100) : 0;
  const leadShare = Math.max(t1Share, t2Share);
  const vetAdvText = regDelta === 0 ? 'Tie' : `${vetAdv} advantage`;
  const muAdvText = muDelta === 0 ? 'Balanced' : `Team ${muLeadTeam} advantage`;
  const top15AdvText = top15Delta === 0 ? 'Balanced' : `Team ${top15LeadTeam} advantage`;
  const matchVeterancy = (t1.count + t2.count) > 0 ? totalRegs / (t1.count + t2.count) : 0;

  console.log();
  console.log(b(m(`🏆 Round Ended — Match ${match.matchId}`)));
  console.log(hr());
  console.log(`  Map/Layer: ${b(match.layerName || 'Unknown')}`);
  console.log(`  Outcome:   ${b(match.outcome)}`);
  console.log(`  Players:   ${b(matchPlayers.length)}`);
  console.log();
  console.log(b('  Match Health'));

  const muColor = muDelta < 1.0 ? g : (muDelta <= 2.5 ? y : r);
  const top15Color = top15Delta < 1.0 ? g : (top15Delta <= 2.5 ? y : r);
  const regColor = leadShare > 65 ? r : (leadShare > 55 ? y : g);

  console.log(`  Skill Balance:   ${muColor(muDelta.toFixed(2) + 'μ Elo diff')} (${muAdvText})`);
  console.log(`  Top 15 Balance:  ${top15Color(top15Delta.toFixed(2) + 'μ Elo diff')} (${top15AdvText})`);
  console.log(`  Regular Balance: ${regColor(regDelta + ' Reg diff')} (${t1Share}% vs ${t2Share}% Share | ${vetAdvText})`);
  console.log(`  Veterancy:       ${(matchVeterancy * 100).toFixed(0)}%`);
  console.log();

  const fmtPct = (v) => (v !== null && v !== undefined) ? `${Math.round(v * 100)}%` : '--%';
  const fmtMu = (v) => (v !== null && v !== undefined) ? `${v.toFixed(1)}μ` : '--μ';
  const fmtCount = (v) => (v !== null && v !== undefined) ? String(v) : '--';
  const row = (v1, label, v2) => {
    const val1 = String(v1).padStart(5).padEnd(5);
    const val2 = String(v2).padStart(5).padEnd(5);
    const mid = label.padStart(12).padEnd(12);
    return `    [${val1}] | ${mid} | [${val2}] `;
  };

  console.log(d('     Team 1  |   Category   |  Team 2 '));
  console.log(d('   -----------------------------------'));
  console.log(row(fmtCount(t1.tierStats.vCount), 'Visitors', fmtCount(t2.tierStats.vCount)));
  console.log(row(fmtCount(t1.tierStats.pCount), 'Provisional', fmtCount(t2.tierStats.pCount)));
  console.log(row(fmtCount(t1.tierStats.rCount), 'Regulars', fmtCount(t2.tierStats.rCount)));
  console.log(d('   -----------------------------------'));
  console.log(row(fmtMu(t1.avgMu), 'Team Avg', fmtMu(t2.avgMu)));
  console.log(row(fmtMu(t1.avgRegMu), 'Regs Avg', fmtMu(t2.avgRegMu)));
  console.log(row(fmtMu(t1.top15Mu), 'Top 15 Avg', fmtMu(t2.top15Mu)));
  console.log(d('   -----------------------------------'));
  console.log(row(fmtPct(t1.veterancy), 'Veterancy', fmtPct(t2.veterancy)));

  console.log();
  console.log(b('  Rating Changes'));
  const t1MuSign = t1.avgDeltaMu >= 0 ? '+' : '';
  const t2MuSign = t2.avgDeltaMu >= 0 ? '+' : '';
  console.log(`  Team 1: ${b(t1MuSign + t1.avgDeltaMu.toFixed(2) + 'μ')}  (Uncertainty: -${t1.avgDeltaSigma.toFixed(2)}σ)`);
  console.log(`  Team 2: ${b(t2MuSign + t2.avgDeltaMu.toFixed(2) + 'μ')}  (Uncertainty: -${t2.avgDeltaSigma.toFixed(2)}σ)`);
  console.log();

  console.log(b('  Rating Spread (Regulars)'));

  const printSpread = (summary, teamName) => {
    console.log(`  ${c(teamName)}`);
    if (summary.spreadSnapshot.length === 0) {
      console.log(d('    No regulars played this round.'));
    } else {
      summary.spreadSnapshot.forEach(m => {
        const deltaSign = m.deltaMu >= 0 ? '+' : '';
        const color = m.deltaMu > 0 ? g : (m.deltaMu < 0 ? r : d);
        console.log(`    ${m.label.padEnd(4)} ${m.name.padEnd(20)} ${color(deltaSign + m.deltaMu.toFixed(2) + 'μ')} ${d(`(${m.muBefore.toFixed(1)} → ${m.muAfter.toFixed(1)})`)}`);
      });
    }
  };

  printSpread(t1, 'Team 1');
  console.log();
  printSpread(t2, 'Team 2');
  console.log();

  if (debug) {
    console.log(b(m('  Math Debug / TrueSkill Internals')));
    console.log(`  Effective N:   T1=${debug.effectiveN1.toFixed(1)} | T2=${debug.effectiveN2.toFixed(1)}`);
    console.log(`  Team Sum μ:    T1=${debug.teamMu1.toFixed(1)} | T2=${debug.teamMu2.toFixed(1)}`);
    console.log(`  Team Sum σ²:   T1=${debug.teamSigmaSq1.toFixed(1)} | T2=${debug.teamSigmaSq2.toFixed(1)}`);
    console.log(`  c (Variance):  ${debug.c.toFixed(2)}`);
    console.log(`  tRaw (Perf):   ${debug.tRaw.toFixed(2)}`);
    console.log(`  vVal (μ mult): ${debug.vVal.toFixed(4)}`);
    console.log(`  wVal (σ mult): ${debug.wVal.toFixed(4)}`);
    console.log();
  }
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log();
  console.log(b('Available commands:'));
  console.log(`  ${c('!elo <name>')}              Player stats + local leaderboard`);
  console.log(`  ${c('!elo leaderboard')}          Top ${LEADERBOARD_SIZE} by CSR`);
  console.log(`  ${c('!elo leaderboard <n>')}      ${LEADERBOARD_SIZE} players centred around rank n`);
  console.log(`  ${c('!elo top')}                  Top 25 by raw μ (debug view)`);
  console.log(`  ${c('!elo spread')}               Distribution stats + sigma buckets`);
  console.log(`  ${c('!elo clan <tag>')}           Clan aggregate stats and roster`);
  console.log(`  ${c('!elo clans [all|n]')}        Leaderboard of top clans`);
  console.log(`  ${c('!elo round [id|random]')}    Simulate round end embed for a match in the log`);
  console.log(`  ${c('exit')} / ${c('quit')}               Exit`);
  console.log();
  if (dbOld) console.log(g('  Before/after diff enabled — comparisons shown automatically.'));
  else       console.log(d('  No before DB loaded. Pass a second JSON file for before/after diff.'));
  console.log();
}

// ─── REPL ─────────────────────────────────────────────────────────────────────

function dispatch(input) {
  const trimmed = input.trim();
  if (!trimmed) return;
  if (trimmed === 'exit' || trimmed === 'quit') {
    console.log(d('Bye.'));
    process.exit(0);
  }
  if (!trimmed.startsWith('!elo')) {
    console.log(d(`  Unknown command. Type ${c('!elo help')} for options.`));
    return;
  }

  const parts = trimmed.slice(4).trim().split(/\s+/);
  const sub   = parts[0]?.toLowerCase() ?? '';

  if (!sub || sub === 'help') {
    cmdHelp();
    return;
  }

  if (sub === 'leaderboard') {
    const n = parts[1] ? parseInt(parts[1], 10) : 1;
    cmdLeaderboard(isNaN(n) ? 1 : n, dbNew, dbOld);
    return;
  }

  if (sub === 'top') {
    cmdTop(dbNew);
    return;
  }

  if (sub === 'spread') {
    cmdSpread(dbNew, dbOld);
    return;
  }

  if (sub === 'round') {
    const id = parts[1] || 'random';
    cmdRound(id, dbNew, matchlog);
    return;
  }

  if (sub === 'clan') {
    const query = parts.slice(1).join(' ');
    cmdClan(query, dbNew, dbOld);
    return;
  }

  if (sub === 'clans') {
    const arg = parts[1]?.toLowerCase();
    cmdClans(dbNew, arg);
    return;
  }

  // Otherwise treat remainder as a player name
  const query = trimmed.slice(4).trim();
  cmdPlayer(query, dbNew, dbOld);
}

// ─── Entry ────────────────────────────────────────────────────────────────────

cmdHelp();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const prompt = () => rl.question(`${CYAN}elo>${RESET} `, line => { dispatch(line); prompt(); });
rl.on('close', () => { console.log(d('\nBye.')); process.exit(0); });
prompt();
