/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                          ELO DISCORD                          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Discord interface module for the EloTracker plugin. Provides embed
 * builders for all Discord-facing output, a resilient send helper,
 * and registers the !elo Discord command handler onto the tracker.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * EloDiscord (named)
 *   Object. Key members:
 *     sendDiscordMessage(channel, content, suppressErrors)
 *       Resilient send — normalises embed/embeds, handles 429 with
 *       one automatic retry, and includes a Discord.js v12 fallback.
 *     buildRoundSummaryEmbed(data)      — Post-round results embed.
 *     buildRoundStartEmbed(data, mode)  — Pre-round team balance embed.
 *     buildPlayerStatsEmbed(...)        — Per-player rank and stats embed.
 *     buildLeaderboardEmbed(...)        — Top-N leaderboard embed.
 *     buildAdminConfirmEmbed(...)       — Admin action confirmation embed.
 *     buildErrorEmbed(context, err)     — Error embed with stack trace.
 *     buildRoundSkippedEmbed(...)       — Round-skipped notification embed.
 *     buildClanStatsEmbed(...)          — Per-clan stats and roster embed.
 *     buildClansLeaderboardEmbed(...)   — Top-N clan leaderboard embed.
 *     registerDiscordCommands(tracker)
 *       Attaches onDiscordMessage and _findPlayerByIdentifier onto
 *       the tracker instance.
 *
 *   Calculates and displays a "Conservative Rating" (μ - 3σ) 
 *   as the primary player rank to encourage active play.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Logger (../../core/logger.js)
 *   Verbose logging for send failures and rate-limit events.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - sendDiscordMessage normalises { embed } → { embeds: [embed] }
 *   for Discord.js v13+ compatibility, then falls back to the legacy
 *   { embed } shape on a 'Cannot send an empty message' error.
 * - Rate limit (429) handling reads retryAfter from the error object
 *   or the retry-after header. Only one retry is attempted.
 * - registerDiscordCommands() mutates the tracker instance. It relies
 *   on tracker.db, tracker.session, tracker.eloCache, tracker.options,
 *   tracker.discordAdminChannel, and tracker.discordPublicChannel.
 * - Admin commands (!elo reset, backup, restore, status, roundinfo) are
 *   gated to discordAdminChannelID. Public commands are gated to
 *   discordPublicChannelID. Messages outside both channels are ignored.
 * - !elo reset (full wipe) requires a two-step confirm with a 30s
 *   timeout. Pending state is stored on tracker._resetConfirmPending.
 * - formatDuration is a local helper (not exported).
 *
 *
 * ─── AUTHOR ──────────────────────────────────────────────────────
 *
 * Slacker
 * Discord: real_slacker
 * GitHub:  https://github.com/mikebjoyce/squadjs-elo-tracker
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Logger from '../../core/logger.js';
import EloCalculator from './elo-calculator.js';

const formatDuration = (ms) => {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)));

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
};

const DISPARITY_THRESHOLDS = {
  SEVERE_MU: 2.5,          // Mu delta required for a lone "Severe" rating
  SEVERE_SHARE: 65,       // % of total regulars required for a lone "Severe" rating
  SEVERE_MIXED_MU: 1.5,    // Lower Mu threshold when paired with high reg share
  SEVERE_MIXED_SHARE: 60,  // Lower reg share threshold when paired with moderate Mu delta
  MINOR_MU: 1.0,           // Mu delta for "Minor" imbalance
  MINOR_SHARE: 55,         // Leading team share of regulars for "Minor" imbalance
  LEAD_MU_MIN: 0.75         // Min Mu delta to declare the higher Mu team the overall lead
};

const getVeterancyUI = (veterancy) => {
  const pct = Math.round(veterancy * 100);
  if (veterancy <= 0.3) {
    return { icon: '🔴', label: `Low (${pct}%)`, color: 0xe74c3c };
  } else if (veterancy <= 0.6) {
    return { icon: '🟡', label: `Moderate (${pct}%)`, color: 0xf1c40f };
  } else {
    return { icon: '🟢', label: `High (${pct}%)`, color: 0x2ecc71 };
  }
};

const getRegEmoji = (leadShare) => {
  if (leadShare > DISPARITY_THRESHOLDS.SEVERE_SHARE) return '🔴';
  if (leadShare > DISPARITY_THRESHOLDS.MINOR_SHARE) return '🟡';
  return '🟢';
};
const getEloEmoji = (delta) => delta < 1.0 ? '🟢' : (delta <= 2.5 ? '🟡' : '🔴');

const generateMatrixTable = (t1, t2) => {
  const fmtPct = (v) => (v !== null && v !== undefined) ? `${Math.round(v * 100)}%` : '--%';
  const fmtMu = (v) => (v !== null && v !== undefined) ? `${v.toFixed(1)}μ` : '--μ';
  const fmtCount = (v) => (v !== null && v !== undefined) ? String(v) : '--';

  const row = (v1, label, v2) => {
    const val1 = String(v1).padStart(5).padEnd(5);
    const val2 = String(v2).padStart(5).padEnd(5);
    const mid = label.padStart(12).padEnd(12);
    return ` [${val1}] | ${mid} | [${val2}] `;
  };

  return [
    '```text',
    ' Team 1  |   Category   |  Team 2 ',
    '----------------------------------',
    row(fmtCount(t1.tierStats.vCount), 'Visitors', fmtCount(t2.tierStats.vCount)),
    row(fmtCount(t1.tierStats.pCount), 'Provisional', fmtCount(t2.tierStats.pCount)),
    row(fmtCount(t1.tierStats.rCount), 'Regulars', fmtCount(t2.tierStats.rCount)),
    '----------------------------------',
    row(fmtMu(t1.avgMu), 'Team Avg', fmtMu(t2.avgMu)),
    row(fmtMu(t1.avgRegMu), 'Regs Avg', fmtMu(t2.avgRegMu)),
    row(fmtMu(t1.top15Mu), 'Top 15 Avg', fmtMu(t2.top15Mu)),
    '----------------------------------',
    row(fmtPct(t1.veterancy), 'Veterancy', fmtPct(t2.veterancy)),
    '```'
  ].join('\n');
};

export const EloDiscord = {
  async sendDiscordMessage(channel, content, suppressErrors = true) {
    if (!channel) {
      Logger.verbose('EloTracker', 1, 'Discord send failed: No channel available');
      return false;
    }

    if (!content) {
      Logger.verbose('EloTracker', 1, 'Discord send failed: Content was empty.');
      return false;
    }

    // Standardize Input: Ensure 'embeds' array is used internally for objects
    let payload = content;
    if (typeof content === 'object' && content !== null) {
      payload = { ...content };
      if (payload.embed && !payload.embeds) {
        payload.embeds = [payload.embed];
        delete payload.embed;
      }
    }

    const executeSend = async (data, isRetry = false) => {
      try {
        await channel.send(data);
        return true;
      } catch (err) {
        // Rate Limit Handling (429)
        if (err.status === 429 && !isRetry) {
          let waitTime = 1000;
          if (err.retryAfter) waitTime = err.retryAfter;
          else if (err.headers && err.headers['retry-after']) waitTime = parseFloat(err.headers['retry-after']) * 1000;

          Logger.verbose('EloTracker', 1, `Discord 429 Rate Limit hit. Waiting ${waitTime}ms before retry.`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          return executeSend(data, true);
        }

        // Compatibility: Discord.js v12 Fallback
        if (err.message === 'Cannot send an empty message' && data.embeds && data.embeds.length > 0) {
          const legacyData = { ...data, embed: data.embeds[0] };
          delete legacyData.embeds;
          return executeSend(legacyData, isRetry);
        }

        throw err;
      }
    };

    try {
      await executeSend(payload);
      return true;
    } catch (err) {
      const errMsg = `Discord send failed: ${err.message}`;
      if (!suppressErrors) throw new Error(errMsg);
      Logger.verbose('EloTracker', 1, errMsg);
      return false;
    }
  },

  buildRoundSummaryEmbed(data) {
    const {
      layerName,
      winningTeamID,
      ticketDiff,
      roundDuration,
      totalPlayerCount,
      playersUpdatedCount,
      team1Summary,
      team2Summary,
      liveT1,
      liveT2,
      calculationDuration
    } = data;

    const winnerText = winningTeamID === 1 ? 'Team 1' : (winningTeamID === 2 ? 'Team 2' : 'Draw');
    const durationStr = formatDuration(roundDuration);

    const formatSpread = (spread, teamName) => {
      if (!spread || spread.length === 0) return '';
      const lines = spread.map(m => {
        const deltaSign = m.deltaMu >= 0 ? '+' : '';
        return `${m.label} **${m.name}**: ${deltaSign}${m.deltaMu.toFixed(2)}μ (${m.muBefore.toFixed(1)} → ${m.muAfter.toFixed(1)})`;
      });
      return `**${teamName}**\n${lines.join('\n')}`;
    };

    const spreadText = [
      formatSpread(team1Summary.spreadSnapshot, 'Team 1'),
      formatSpread(team2Summary.spreadSnapshot, 'Team 2')
    ].filter(Boolean).join('\n\n');

    const matchVeterancy = (liveT1.count + liveT2.count) > 0
      ? (liveT1.tierStats.rCount + liveT2.tierStats.rCount) / (liveT1.count + liveT2.count)
      : 0;
    const vUI = getVeterancyUI(matchVeterancy);

    const muDelta = Math.abs(liveT1.avgMu - liveT2.avgMu);
    const top15Delta = Math.abs(liveT1.top15Mu - liveT2.top15Mu);
    const regDelta = Math.abs(liveT1.tierStats.rCount - liveT2.tierStats.rCount);

    const muLeadTeam = liveT1.avgMu >= liveT2.avgMu ? 1 : 2;
    const top15LeadTeam = liveT1.top15Mu >= liveT2.top15Mu ? 1 : 2;
    const vetAdv = liveT1.tierStats.rCount === liveT2.tierStats.rCount ? 'Tie' : `Team ${liveT1.tierStats.rCount > liveT2.tierStats.rCount ? 1 : 2}`;
    
    const totalRegs = liveT1.tierStats.rCount + liveT2.tierStats.rCount;
    const leadRegs = Math.max(liveT1.tierStats.rCount, liveT2.tierStats.rCount);
    const regShare = totalRegs > 0 ? Math.round((leadRegs / totalRegs) * 100) : 0;
    const t1Share = totalRegs > 0 ? Math.round((liveT1.tierStats.rCount / totalRegs) * 100) : 0;
    const t2Share = totalRegs > 0 ? Math.round((liveT2.tierStats.rCount / totalRegs) * 100) : 0;
    const leadShare = Math.max(t1Share, t2Share);
    const vetAdvText = regDelta === 0 ? 'Tie' : `${vetAdv} advantage`;

    const muAdvText = muDelta === 0 ? 'Balanced' : `Team ${muLeadTeam} advantage`;
    const top15AdvText = top15Delta === 0 ? 'Balanced' : `Team ${top15LeadTeam} advantage`;

    const formatRatingChanges = (stats) => {
      const muSign = stats.avgDeltaMu >= 0 ? '+' : '';
      // Format Sigma to 2 decimal places as requested
      const muPart = `**${muSign}${stats.avgDeltaMu.toFixed(2)}μ**`;
      const sigmaPart = `(Uncertainty: **-${stats.avgDeltaSigma.toFixed(2)}σ**)`;
      return `${muPart} ${sigmaPart}`;
    };

    return {
      color: vUI.color,
      title: '🏆 Round Ended',
      description: `**Veterancy: ${vUI.icon} ${vUI.label}**\n*Percentage of established "Regular" players (10+ rounds) in the match.*\n\n${generateMatrixTable(liveT1, liveT2)}`,
      fields: [
        { name: 'Map / Layer', value: layerName || 'Unknown', inline: true },
        { name: 'Winner', value: `${winnerText} (+${ticketDiff} tickets)`, inline: true },
        { name: 'Duration', value: durationStr, inline: true },
        { name: 'Player Count', value: `${totalPlayerCount}`, inline: true },
        { 
          name: 'Disparity', 
          value: [
            `**Skill Balance:** ${getEloEmoji(muDelta)} ${muDelta.toFixed(2)}μ Elo diff (${muAdvText})`,
            `**Top 15 Balance:** ${getEloEmoji(top15Delta)} ${top15Delta.toFixed(2)}μ Elo diff (${top15AdvText})`,
            `**Regular Balance:** ${getRegEmoji(leadShare)} ${regDelta} Reg diff (${t1Share}% vs ${t2Share}% Share | ${vetAdvText})`
          ].join('\n'), 
          inline: false 
        },
        { 
          name: 'Rating Changes', 
          value: `**Team 1:** ${formatRatingChanges(team1Summary)}\n**Team 2:** ${formatRatingChanges(team2Summary)}`, 
          inline: false 
        },
        { name: 'Players Updated', value: playersUpdatedCount.toString(), inline: true },
        { name: 'Processing Time', value: `${calculationDuration}ms`, inline: true },
        { name: 'Rating Spread (Regulars)', value: spreadText || 'No regulars played this round', inline: false }
      ],
      timestamp: new Date().toISOString()
    };
  },

  buildPlayerStatsEmbed(player, rank, totalRanked, totalPlayers, provisional = false, localLeaderboard = null, minRounds = 10) {
    const { name, mu, sigma, wins, losses, roundsPlayed } = player;

    const consRating = mu - (EloCalculator.SIGMA_MULTIPLIER * sigma);

    let topPercent;
    if (!provisional) {
      const rawPercent = ((rank - 1) / (totalRanked > 1 ? totalRanked - 1 : 1)) * 100;
      if (rank === 1) topPercent = '0.1';
      else if (rawPercent < 1) topPercent = Math.max(0.1, rawPercent).toFixed(1);
      else topPercent = Math.round(rawPercent);
    }

    let reliability;
    if (sigma <= 2.5) reliability = 'Highly Calibrated';
    else if (sigma <= 4.5) reliability = 'Calibrated';
    else if (sigma <= 6.5) reliability = 'Establishing';
    else reliability = 'Initial Calibration';

    const totalGames = wins + losses;
    const winRateStr = totalGames > 0 ? `**${((wins / totalGames) * 100).toFixed(1)}% winrate**` : null;
    const matchHistoryValue = [
      `${wins} Wins / ${losses} Losses`,
      winRateStr
    ].filter(Boolean).join(' (').concat(winRateStr ? ')' : '');

    const totalRankedFmt = totalRanked.toLocaleString();
    const totalPlayersFmt = totalPlayers.toLocaleString();

    const description = provisional
      ? `**Provisional** — ${roundsPlayed} rounds played. Rank visible after ${minRounds} rounds. (${totalPlayersFmt} total tracked)`
      : (totalRanked > 0 ? `Rank **#${rank}** of **${totalRankedFmt}** ranked players (${totalPlayersFmt} total).\nTop ${topPercent}% of all players` : 'Unranked');

    const ratingValue = provisional
      ? `**${consRating.toFixed(1)} CSR** (Calibrating | μ - 3σ)`
      : `**${consRating.toFixed(1)} CSR** (μ - 3σ)`;

    const fields = [
      {
        name: 'CSR (Competitive Skill Rank)',
        value: ratingValue,
        inline: false
      },
      {
        name: 'Estimated Skill (μ)',
        value: `**${mu.toFixed(1)} μ**`,
        inline: false
      },
      {
        name: 'System Certainty (σ)',
        value: `${reliability} (**${sigma.toFixed(2)} σ**)`,
        inline: false
      },
      {
        name: 'Match History',
        value: matchHistoryValue,
        inline: false
      },
      {
        name: 'Glossary',
        value: 'μ (Mu) = Estimated Skill | σ (Sigma) = System Certainty',
        inline: false
      }
    ];

    if (localLeaderboard && localLeaderboard.length > 0) {
      const localLines = localLeaderboard.map(p => {
        const pConsRating = p.mu - (EloCalculator.SIGMA_MULTIPLIER * p.sigma);
        const line = `#${p.actualRank.toString().padStart(2, ' ')} ${p.name.trim()}: ${pConsRating.toFixed(1)} ${p.wins}W/${p.losses}L`;
        if (p.eosID === player.eosID) {
          return `${line} <<`;
        }
        return line;
      });
      fields.push({
        name: 'Local Leaderboard',
        value: `\`\`\`text\n${localLines.join('\n')}\n\`\`\``,
        inline: false
      });
    }

    return {
      color: 0x3498db,
      title: `📊 Player Stats for ${name}`,
      description: description,
      fields: fields,
      timestamp: new Date().toISOString()
    };
  },

  buildLeaderboardEmbed(players, limit, startRank = 1, totalRanked = 0, totalPlayers = 0, targetRank = null) {
    const lines = players.slice(0, limit).map((p, i) => {
      const currentRank = startRank + i;
      const paddedRank = currentRank.toString().padStart(2, ' ');
      const consRating = p.mu - (EloCalculator.SIGMA_MULTIPLIER * p.sigma);
      const line = `#${paddedRank} ${p.name.trim()}: ${consRating.toFixed(1)} ${p.wins}W/${p.losses}L`;
      if (targetRank && currentRank === targetRank) {
        return `${line} <<`;
      }
      return line;
    });

    const endRank = startRank + players.length - 1;
    const rankRangeText = players.length > 0 ? `(Ranks ${startRank}-${endRank})` : '(Empty)';
    const totalRankedFmt = totalRanked.toLocaleString();
    const totalPlayersFmt = totalPlayers.toLocaleString();

    return {
      color: 0xf39c12,
      title: `🏆 Leaderboard ${rankRangeText}`,
      description: `Out of **${totalRankedFmt}** ranked players (${totalPlayersFmt} total)\n\`\`\`text\n${lines.join('\n')}\n\`\`\``,
      timestamp: new Date().toISOString()
    };
  },

  buildClanStatsEmbed(displayTag, members, rankedCount, totalWins, totalLosses, avgMu, avgSigma, avgCsr, sortedMembers, minRounds = 10) {
    const wr = (totalWins + totalLosses) > 0 ? ((totalWins / (totalWins + totalLosses)) * 100).toFixed(1) : '—';
    
    // Format roster lines (Top 20)
    const rosterLines = sortedMembers.slice(0, 20).map((p, i) => {
      const pCsr = p.mu - (EloCalculator.SIGMA_MULTIPLIER * p.sigma);
      const prov = p.roundsPlayed < minRounds ? ' [prov]' : '';
      return `${(i + 1).toString().padStart(2)}. ${p.name.padEnd(20)} ${pCsr.toFixed(1).padStart(5)} CSR${prov}`;
    });

    const rosterText = rosterLines.length > 0 
      ? `\`\`\`text\n${rosterTextHeader()}\n${rosterLines.join('\n')}\n\`\`\``
      : 'No members found.';

    function rosterTextHeader() {
      return ' #  Name                 Rating\n' + '-------------------------------';
    }

    return {
      color: 0x3498db,
      title: `🛡️ Clan Stats for ${displayTag}`,
      fields: [
        { name: 'Members', value: `${members.length} (${rankedCount} ranked)`, inline: true },
        { name: 'Winrate', value: `${wr}% (${totalWins}W / ${totalLosses}L)`, inline: true },
        { name: 'Average Rating', value: `CSR: **${avgCsr?.toFixed(1) ?? 'n/a'}**\nμ: ${avgMu.toFixed(1)} | σ: ${avgSigma.toFixed(2)}`, inline: false },
        { name: 'Roster (Top 20)', value: rosterText, inline: false }
      ],
      timestamp: new Date().toISOString()
    };
  },

  buildClansLeaderboardEmbed(clanList, limit, minMembers) {
    const lines = clanList.slice(0, limit).map((c, i) => {
      const rankStr = (i + 1).toString().padStart(2);
      const tagStr = c.displayTag.padEnd(10).substring(0, 10);
      const csrStr = c.avgCsr === -999 ? 'n/a'.padStart(5) : c.avgCsr.toFixed(1).padStart(5);
      const membersStr = `${c.members.length}m`.padStart(4);
      const wrStr = `${c.wr.toFixed(0)}%`.padStart(4);
      
      return `#${rankStr} ${tagStr} ${csrStr} CSR ${membersStr} ${wrStr}`;
    });

    const header = ' #  Clan Tag   Rating    Size   WR\n' + '----------------------------------';
    const body = lines.length > 0 ? lines.join('\n') : 'No clans meet the requirements.';

    return {
      color: 0xf1c40f,
      title: `🛡️ Clan Leaderboard (Top ${limit})`,
      description: `Ranking clans with ≥${minMembers} members by average CSR\n\`\`\`text\n${header}\n${body}\n\`\`\``,
      timestamp: new Date().toISOString()
    };
  },

  buildAdminConfirmEmbed(action, detail) {
    return {
      color: 0x9b59b6,
      title: `🛡️ Admin Action: ${action}`,
      description: detail,
      timestamp: new Date().toISOString()
    };
  },

  buildErrorEmbed(context, error) {
    const embed = {
      color: 0xe74c3c,
      title: `⚠️ Error: ${context}`,
      description: `**${error?.message || error}**`,
      timestamp: new Date().toISOString(),
      fields: []
    };

    if (error?.stack) {
      const stack = error.stack.length > 1000 ? error.stack.substring(0, 1000) + '...' : error.stack;
      embed.fields.push({ name: 'Stack Trace', value: `\`\`\`js\n${stack}\n\`\`\``, inline: false });
    }

    return embed;
  },

  buildRoundSkippedEmbed(reason, playerCount, layerName) {
    return {
      color: 0x95a5a6,
      title: '⏭️ ELO Rating Update Skipped',
      fields: [
        { name: 'Reason', value: reason, inline: true },
        { name: 'Player Count', value: playerCount.toString(), inline: true },
        { name: 'Layer', value: layerName || 'Unknown', inline: true }
      ],
      timestamp: new Date().toISOString()
    };
  },

  buildRoundStartEmbed(data, type = 'auto') {
    if (data.status === 'warming') {
      return {
        color: 0x3498db,
        title: '📊 EloTracker: System Initializing',
        description: 'System is synchronizing with the database. Please wait for player data to cache...',
        timestamp: new Date().toISOString()
      };
    }

    // Handle empty server status
    if (data.status === 'empty' || data.totalPlayerCount === 0) {
      return {
        color: 0x95a5a6,
        title: '🛰️ Live Round Info',
        description: 'The server is currently empty. No active match data to display.',
        timestamp: new Date().toISOString()
      };
    }

    const { layerName, t1, t2, muDelta, top15Delta, regDelta, veteranLead, matchVeterancy, roundStartTime, totalPlayerCount } = data;

    const vUI = getVeterancyUI(matchVeterancy);
    const matrixTable = generateMatrixTable(t1, t2);

    const muLeadTeam = t1.avgMu >= t2.avgMu ? 1 : 2;
    const top15LeadTeam = t1.top15Mu >= t2.top15Mu ? 1 : 2;
    
    const totalRegs = t1.tierStats.rCount + t2.tierStats.rCount;
    const leadRegs = Math.max(t1.tierStats.rCount, t2.tierStats.rCount);
    const regShare = totalRegs > 0 ? Math.round((leadRegs / totalRegs) * 100) : 0;
    const t1Share = totalRegs > 0 ? Math.round((t1.tierStats.rCount / totalRegs) * 100) : 0;
    const t2Share = totalRegs > 0 ? Math.round((t2.tierStats.rCount / totalRegs) * 100) : 0;
    const leadShare = Math.max(t1Share, t2Share);
    const vetAdvText = regDelta === 0 ? 'Tie' : `${veteranLead} advantage`;

    const muAdvText = muDelta === 0 ? 'Balanced' : `Team ${muLeadTeam} advantage`;
    const top15AdvText = top15Delta === 0 ? 'Balanced' : `Team ${top15LeadTeam} advantage`;

    const title = type === 'manual'
      ? `📊 Live Round Info - ${layerName}`
      : `🎬 Round Started - ${layerName}`;
    
    const embed = {
      color: vUI.color,
      title: title,
      description: `**Veterancy: ${vUI.icon} ${vUI.label}**\n*Percentage of established "Regular" players (10+ rounds) in the match.*\n\n${matrixTable}`,
      fields: [
      {
          name: 'Match Health',
          value: [
            `**Skill Balance:** ${getEloEmoji(muDelta)} ${muDelta.toFixed(2)}μ Elo diff (${muAdvText})`,
            `**Top 15 Balance:** ${getEloEmoji(top15Delta)} ${top15Delta.toFixed(2)}μ Elo diff (${top15AdvText})`,
            `**Regular Balance:** ${getRegEmoji(leadShare)} ${regDelta} Reg diff (${t1Share}% vs ${t2Share}% Share | ${vetAdvText})`
          ].join('\n'),
        inline: false
      },
      { name: 'Player Count', value: `${totalPlayerCount}`, inline: true }
      ],
      timestamp: new Date().toISOString()
    };

    if (roundStartTime) {
      embed.fields.push({
        name: 'Round Start',
        value: `<t:${Math.floor(roundStartTime / 1000)}:R>`,
        inline: true
      });
    }

    return embed;
  },

  registerDiscordCommands(tracker) {
    tracker.onDiscordMessage = async function(message) {
      if (!this.ready) return;
      if (message.author.bot) return;

      const content = message.content.trim();
      if (!content.startsWith('!elo')) return;

      const isAdminChannel = this.discordAdminChannel &&
        message.channel.id === this.options.discordAdminChannelID;
      const isPublicChannel = this.discordPublicChannel &&
        message.channel.id === this.options.discordPublicChannelID;

      if (!isAdminChannel && !isPublicChannel) return;

      const args = content.replace(/^!elo\s*/i, '').trim().split(/\s+/).filter(Boolean);
      const sub = args[0]?.toLowerCase();

      // S³ ClansService delegation — uses this._s3 (set by elo-tracker.js mount())
      this._extractRawPrefix = (name) => {
        if (this._s3?.clans?.isReady?.()) {
          return this._s3.clans.extractRawPrefix(name);
        }
        Logger.verbose('EloTracker', 1, 'Clans service unavailable — cannot extract clan prefix');
        return null;
      };
      this._normalizeTag = (raw) => {
        if (this._s3?.clans?.isReady?.()) {
          return this._s3.clans.normalizeTag(raw);
        }
        Logger.verbose('EloTracker', 1, 'Clans service unavailable — cannot normalize clan tag');
        return null;
      };

      const hasAdminRole = (!this.options.discordAdminRoleIDs || this.options.discordAdminRoleIDs.length === 0) || 
        (message.member && this.options.discordAdminRoleIDs.some(roleID => message.member.roles.cache.has(roleID)));

      // --- Admin-only commands (admin channel only, checked first) ---
      if (isAdminChannel) {
        const adminCommands = ['status', 'roundinfo', 'reset', 'backup', 'restore'];
        if (adminCommands.includes(sub) && !hasAdminRole) {
           await message.reply('❌ You do not have permission to use this command.');
           return;
        }

        if (sub === 'status') {
          const sessionCount = this.session.getSessionCount();
          const cacheCount = this.eloCache.size;
          const roundStartStr = this.session.roundStartTime
            ? `<t:${Math.floor(this.session.roundStartTime / 1000)}:R>`
            : 'None';

          const cacheSample = Array.from(this.eloCache.entries())
            .slice(0, 10)
            .map(([id, data]) => {
              const player = this.server.players.find(p => p.eosID === id);
              return `\`${player ? player.name : id}\`: μ ${data.mu.toFixed(2)} σ ${data.sigma.toFixed(2)}`;
            })
            .join('\n');

          const embed = {
            color: 0x3498db,
            title: '📊 EloTracker Status',
            fields: [
              { name: 'Version', value: this.constructor.version, inline: true },
              { name: 'Ready', value: this.ready.toString(), inline: true },
              { name: 'Session Players', value: sessionCount.toString(), inline: true },
              { name: 'ELO Cache Entries', value: cacheCount.toString(), inline: true },
              { name: 'Round Start', value: roundStartStr, inline: true },
              { name: 'Cache Sample (10)', value: cacheSample || 'Empty', inline: false }
            ],
            timestamp: new Date().toISOString()
          };

          await EloDiscord.sendDiscordMessage(message.channel, { embeds: [embed] });
          return;
        }

        if (sub === 'roundinfo') {
          try {
            const data = this.buildRoundStartData(); 
            const embed = EloDiscord.buildRoundStartEmbed(data, 'manual');
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [embed] });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('Round Info', err)] });
          }
          return;
        }

        if (sub === 'reset') {
          const identifier = args.slice(1).join(' ');

          if (!identifier) {
            await message.reply('⚠️ This will wipe ALL ELO ratings and round history. Reply `!elo reset confirm` within 30 seconds to proceed.');
            this._resetConfirmPending = { timestamp: Date.now() };
            return;
          }

          if (identifier === 'confirm') {
            if (!this._resetConfirmPending || Date.now() - this._resetConfirmPending.timestamp > 30000) {
              await message.reply('⚠️ No pending reset confirmation, or confirmation expired.');
              this._resetConfirmPending = null;
              return;
            }
            this._resetConfirmPending = null;
            try {
              // Auto-backup before wiping the database
              try {
                const players = await this.db.exportPlayerStats();
                const payload = JSON.stringify({
                  exportedAt: Date.now(),
                  playerCount: players.length,
                  players
                }, null, 2);
                const buffer = Buffer.from(payload, 'utf-8');
                const filename = `elo-pre-reset-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
                await message.channel.send({
                  content: `📦 Auto-Backup before reset — ${players.length} players saved.`,
                  files: [{ attachment: buffer, name: filename }]
                });
              } catch (backupErr) {
                await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('Auto-Backup Failed', backupErr)] });
                await message.reply('⚠️ Reset aborted because the automatic pre-reset backup failed. Please fix the issue or run `!elo backup` manually.');
                return;
              }

              const _PlayerStats = this.db.getModel('Elo_PlayerStats');
              const _RoundHistory = this.db.getModel('Elo_RoundHistory');
              if (_PlayerStats) await _PlayerStats.destroy({ where: {} });
              if (_RoundHistory) await _RoundHistory.destroy({ where: {} });
              this.eloCache.clear();
              await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildAdminConfirmEmbed('ELO Reset', 'All ratings and round history wiped.')] });
            } catch (err) {
              await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('ELO Reset', err)] });
            }
            return;
          }

          // Single player reset
          const defaults = {
            mu: EloCalculator.MU_DEFAULT,
            sigma: EloCalculator.SIGMA_DEFAULT,
            wins: 0,
            losses: 0,
            roundsPlayed: 0
          };
          try {
            const player = await this._findPlayerByIdentifier(identifier);
            if (!player) {
              await message.reply(`No player found: ${identifier}`);
              return;
            }
            await this.db.upsertPlayerStats(player.eosID, defaults);
            if (this.eloCache.has(player.eosID)) {
              this.eloCache.set(player.eosID, { mu: defaults.mu, sigma: defaults.sigma });
            }
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildAdminConfirmEmbed('Player Reset', `Reset ${player.name} to default rating.`)] });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('Player Reset', err)] });
          }
          return;
        }

        if (sub === 'backup') {
          try {
            const players = await this.db.exportPlayerStats();
            const payload = JSON.stringify({
              exportedAt: Date.now(),
              playerCount: players.length,
              players
            }, null, 2);
            const buffer = Buffer.from(payload, 'utf-8');
            const filename = `elo-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            await message.channel.send({
              content: `📦 ELO Backup — ${players.length} players`,
              files: [{ attachment: buffer, name: filename }]
            });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('Backup', err)] });
          }
          return;
        }

        if (sub === 'restore') {
          if (!message.attachments.size) {
            await message.reply('Please attach a backup JSON file with the !elo restore command.');
            return;
          }
          try {
            const attachment = message.attachments.first();
            const response = await fetch(attachment.url);
            const json = await response.json();
            if (!Array.isArray(json.players)) {
              await message.reply('Invalid backup format: missing players array.');
              return;
            }
            
            // Schema validation to ensure the JSON matches the expected player format
            const isValidSchema = json.players.every(p => 
              typeof p.eosID === 'string' &&
              typeof p.mu === 'number' &&
              typeof p.sigma === 'number' &&
              typeof p.wins === 'number' &&
              typeof p.losses === 'number' &&
              typeof p.roundsPlayed === 'number'
            );
            
             if (!isValidSchema) {
               await message.reply('Invalid backup format: one or more players have a malformed schema.');
               return;
             }
             
             await message.reply(`⏳ Restoring ${json.players.length} players... This may take a moment.`);
             await this.db.importPlayerStats(json.players);
             await EloDiscord.sendDiscordMessage(message.channel, {
               embeds: [EloDiscord.buildAdminConfirmEmbed('Restore Complete', `Restored ${json.players.length} players from backup.`)]
             });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('Restore', err)] });
          }
          return;
        }
      }

      // --- Public commands (available in both channels) ---
      if (sub === 'link') {
        const steamID = args[1];

        if (!steamID || !/^\d{17}$/.test(steamID)) {
          const replyMsg = await message.reply('⚠️ Invalid SteamID. Please provide your 17-digit SteamID. This message will be deleted in 5 seconds.');
          setTimeout(() => {
            message.delete().catch(() => {});
            replyMsg.delete().catch(() => {});
          }, 5000);
          return;
        }

        try {
          const player = await this.db.getModel('Elo_PlayerStats')?.findOne({ where: { steamID } });

          if (!player) {
            const replyMsg = await message.reply('⚠️ No ELO record found for that SteamID. Make sure you have played at least one round on the server. This message will be deleted in 5 seconds.');
            setTimeout(() => {
              message.delete().catch(() => {});
              replyMsg.delete().catch(() => {});
            }, 5000);
            return;
          }

          await player.update({ discordID: message.author.id });

          await EloDiscord.sendDiscordMessage(message.channel, {
            embeds: [EloDiscord.buildAdminConfirmEmbed('Account Linked', `Your Discord account is now successfully linked to the ELO record for **${player.name}**.`)]
          });
          message.delete().catch(() => {});
        } catch (err) {
          await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed('Account Link', err)] });
        }
        return;
      }

      if (sub === 'explain') {
        const initialMu = EloCalculator.MU_DEFAULT;
        const initialSigma = EloCalculator.SIGMA_DEFAULT;
        const explainEmbed = {
          color: 0x3498db,
          title: '📖 How the ELO System Works',
          description: 'This server uses a system based on [TrueSkill](https://en.wikipedia.org/wiki/TrueSkill) to rank players. Here’s a quick breakdown:',
          fields: [
            {
              name: 'TrueSkill Algorithm',
              value: 'A rating system used by major platforms (like Xbox) to track your estimated skill (μ) and system certainty (σ) in team games.'
            },
            {
              name: 'CSR (Competitive Skill Rank)',
              value: 'Your official leaderboard score, calculated conservatively as **μ - 3σ** to encourage active play.'
            },
            {
              name: 'Estimated Skill (μ — "Mu")',
              value: `Your estimated performance level. Everyone starts at ${initialMu}. This number goes up when you win and decreases when you lose based on the strength of your opponents.`
            },
            {
              name: 'System Certainty (σ — "Sigma")',
              value: `This is the system's confidence in your rank. It starts at ${initialSigma} and drops as you play more games, making your rank more stable.`
            },
            {
              name: 'The Calibration Goal',
              value: "Once your Sigma drops below 2.5, you are considered 'Highly Calibrated' and your rank becomes more stable."
            }
          ]
        };
        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [explainEmbed] });
        return;
      }

      if (sub === 'help') {
        const embed = {
          color: 0x3498db,
          title: '📖 EloTracker Command Reference',
          fields: [
            {
              name: '🌐 Public Commands',
              value: [
                '`!elo` or `!elo me` — Look up your own linked ELO rating and local leaderboard',
                '`!elo <name | steamID | eosID>` — Look up another player',
                '`!elo link <SteamID>` — Link your Discord account to your SteamID',
                '`!elo leaderboard [rank]` — Show 25 players, optionally centered around a specific rank',
                '`!elo clans` — Show the top 25 clans by average CSR',
                '`!elo clan <tag>` — Show detailed stats and roster for a clan',
                '`!elo explain` — Explains the ranking algorithm and symbols',
                '`!elo help` — Show this message'
              ].join('\n'),
              inline: false
            },
            ...(isAdminChannel ? [{
              name: '🛡️ Admin Commands (admin channel only)',
              value: [
                '`!elo status` — Plugin status and current round info',
                '`!elo roundinfo` — Live round snapshot: team balance, veterancy, and match health',
                '`!elo clans [n|all]` — Advanced clan leaderboard (n up to 50, "all" for all tags)',
                '`!elo reset` — Wipe ALL ratings and round history (requires confirm)',
                '`!elo reset confirm` — Confirm a pending full reset',
                '`!elo reset <identifier>` — Reset a single player to default rating',
                '`!elo backup` — Export all player stats as a JSON file attachment',
                '`!elo restore` — Restore from a JSON backup (attach file with command)'
              ].join('\n'),
              inline: false
            }] : [])
          ],
          timestamp: new Date().toISOString()
        };
        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [embed] });
        return;
      }

      if (!sub || sub === 'me') {
        const player = await this.db.getModel('Elo_PlayerStats')?.findOne({ where: { discordID: message.author.id } });
        if (!player) {
          await message.reply('No linked ELO record found. Please use `!elo link <Your17DigitSteamID>` to link your account first!');
          return;
        }

        const minRounds = this.options.minRoundsForLeaderboard;
        const provisional = player.roundsPlayed < minRounds;
        const rank = provisional ? null : await this.db.getPlayerRank(player.mu - (EloCalculator.SIGMA_MULTIPLIER * player.sigma), minRounds);
        const totalRanked = await this.db.getTotalRankedPlayers(minRounds);
        const totalPlayers = await this.db.getTotalPlayers();

        let localLeaderboard = null;
        if (!provisional && rank !== null) {
          const limit = 9;
          const offset = Math.max(0, rank - 5);
          const neighborhood = await this.db.getLeaderboard(limit, minRounds, offset);
          localLeaderboard = neighborhood.map((p, i) => ({ ...p, actualRank: offset + 1 + i }));
        }

        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildPlayerStatsEmbed(player, rank, totalRanked, totalPlayers, provisional, localLeaderboard, minRounds)] });
        return;
      }

      if (sub === 'leaderboard') {
        const minRounds = this.options.minRoundsForLeaderboard;
        const totalRanked = await this.db.getTotalRankedPlayers(minRounds);
        const totalPlayers = await this.db.getTotalPlayers();
        
        let targetRank = 1;
        let isCentered = false;
        if (args.length > 1) {
          const parsed = parseInt(args[1], 10);
          if (!isNaN(parsed) && parsed > 0) {
            targetRank = parsed;
            isCentered = true;
          }
        }
        
        if (targetRank > totalRanked && totalRanked > 0) {
          targetRank = totalRanked;
        }
        
        const limit = 25;
        let offset = Math.max(0, targetRank - 13);
        const startRank = offset + 1;
        
        const players = await this.db.getLeaderboard(limit, minRounds, offset);
        const displayTargetRank = isCentered ? targetRank : null;
        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildLeaderboardEmbed(players, limit, startRank, totalRanked, totalPlayers, displayTargetRank)] });
        return;
      }

      if (sub === 'clan') {
        const query = args.slice(1).join(' ');
        if (!query) {
          await message.reply('Please specify a clan tag (e.g. `!elo clan FRWRD`)');
          return;
        }

        const searchNorm = this._normalizeTag(query);
        if (!searchNorm) {
          await message.reply('Invalid clan tag query.');
          return;
        }

        const allPlayers = await this.db.exportPlayerStats();
        const members = allPlayers.filter(p => this._normalizeTag(this._extractRawPrefix(p.name)) === searchNorm);

        if (members.length === 0) {
          await message.reply(`No players found with clan tag matching: "${query}"`);
          return;
        }

        const minRounds = this.options.minRoundsForLeaderboard;
        let totalWins = 0, totalLosses = 0, totalMu = 0, totalSigma = 0, rankedCount = 0, totalCsr = 0;
        const rawCounts = {};

        members.forEach(p => {
          const raw = this._extractRawPrefix(p.name);
          rawCounts[raw] = (rawCounts[raw] || 0) + 1;
          totalWins += p.wins;
          totalLosses += p.losses;
          totalMu += p.mu;
          totalSigma += p.sigma;
          if (p.roundsPlayed >= minRounds) {
            rankedCount++;
            totalCsr += (p.mu - (EloCalculator.SIGMA_MULTIPLIER * p.sigma));
          }
        });

        const displayTag = Object.entries(rawCounts).sort((a, b) => b[1] - a[1])[0][0];
        const avgMu = totalMu / members.length;
        const avgSigma = totalSigma / members.length;
        const avgCsr = rankedCount > 0 ? totalCsr / rankedCount : null;
        const sortedMembers = [...members].sort((a, b) => {
          const csrA = a.mu - (EloCalculator.SIGMA_MULTIPLIER * a.sigma);
          const csrB = b.mu - (EloCalculator.SIGMA_MULTIPLIER * b.sigma);
          return csrB - csrA;
        });

        await EloDiscord.sendDiscordMessage(message.channel, {
          embeds: [EloDiscord.buildClanStatsEmbed(displayTag, members, rankedCount, totalWins, totalLosses, avgMu, avgSigma, avgCsr, sortedMembers, minRounds)]
        });
        return;
      }

      if (sub === 'clans') {
        const arg = args[1]?.toLowerCase();
        const isAll = arg === 'all' && isAdminChannel;
        let limit = 25;
        let minMembers = 3;

        if (isAdminChannel && arg) {
          if (arg === 'all') {
            limit = 50;
            minMembers = 1;
          } else {
            const parsedN = parseInt(arg, 10);
            if (!isNaN(parsedN)) limit = Math.min(Math.max(1, parsedN), 50);
          }
        }

        const allPlayers = await this.db.exportPlayerStats();
        const minRounds = this.options.minRoundsForLeaderboard;
        const clans = {};

        allPlayers.forEach(p => {
          const raw = this._extractRawPrefix(p.name);
          const norm = this._normalizeTag(raw);
          if (!norm) return;

          if (!clans[norm]) {
            clans[norm] = { norm, rawTags: {}, members: [], totalMu: 0, totalCsr: 0, rankedCount: 0, wins: 0, losses: 0 };
          }

          const c = clans[norm];
          c.rawTags[raw] = (c.rawTags[raw] || 0) + 1;
          c.members.push(p);
          c.totalMu += p.mu;
          c.wins += p.wins;
          c.losses += p.losses;
          if (p.roundsPlayed >= minRounds) {
            c.rankedCount++;
            c.totalCsr += (p.mu - (EloCalculator.SIGMA_MULTIPLIER * p.sigma));
          }
        });

        const clanList = Object.values(clans)
          .filter(c => c.members.length >= minMembers)
          .map(c => {
            const displayTag = Object.entries(c.rawTags).sort((a, b) => b[1] - a[1])[0][0];
            return {
              ...c,
              displayTag,
              avgCsr: c.rankedCount > 0 ? c.totalCsr / c.rankedCount : -999,
              wr: (c.wins + c.losses) > 0 ? (c.wins / (c.wins + c.losses)) * 100 : 0
            };
          })
          .sort((a, b) => b.avgCsr - a.avgCsr);

        await EloDiscord.sendDiscordMessage(message.channel, {
          embeds: [EloDiscord.buildClansLeaderboardEmbed(clanList, limit, minMembers)]
        });
        return;
      }

      // !elo <identifier> — look up another player
      const identifier = args.join(' ');
      const player = await this._findPlayerByIdentifier(identifier);
      if (!player) {
        await message.reply(`No ELO record found for: ${identifier}`);
        return;
      }

      const minRounds = this.options.minRoundsForLeaderboard;
      const provisional = player.roundsPlayed < minRounds;
      const rank = provisional ? null : await this.db.getPlayerRank(player.mu - (EloCalculator.SIGMA_MULTIPLIER * player.sigma), minRounds);
      const totalRanked = await this.db.getTotalRankedPlayers(minRounds);
      const totalPlayers = await this.db.getTotalPlayers();

      let localLeaderboard = null;
      if (!provisional && rank !== null) {
        const limit = 9;
        const offset = Math.max(0, rank - 5);
        const neighborhood = await this.db.getLeaderboard(limit, minRounds, offset);
        localLeaderboard = neighborhood.map((p, i) => ({ ...p, actualRank: offset + 1 + i }));
      }

      await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildPlayerStatsEmbed(player, rank, totalRanked, totalPlayers, provisional, localLeaderboard, minRounds)] });
    };

    tracker._findPlayerByIdentifier = async function(identifier) {
      return await this.db.searchPlayer(identifier);
    };
  }
}
