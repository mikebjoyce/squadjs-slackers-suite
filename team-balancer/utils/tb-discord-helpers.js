/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  DISCORD MESSAGING UTILITY                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Static embed builders and send helper for all TeamBalancer Discord
 * output. Handles status reports, diagnostic results, scramble plans,
 * win streak notifications, and error reporting.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * DiscordHelpers (named)
 *   Object. Key members:
 *     sendDiscordMessage(channel, content)            — Resilient send with 429 retry.
 *     buildStatusEmbed(tb)                            — Win streak and plugin state embed.
 *     buildDiagnosticsEmbed(results, tb)              — Diagnostic test results embed.
 *     createScrambleDetailsMessage(plan, isDry, tb)   — Swap plan detail embed.
 *     buildScrambleCompletedEmbed(...)                — Post-execution summary embed.
 *     buildScrambleFailedEmbed(reason, time, tb)      — Failure notification embed.
 *     buildFatalErrorEmbed(err, context, tb)          — Critical error embed with stack.
 *     buildWinStreakEmbed(tb, message)                — Win streak broadcast embed.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Logger (../../core/logger.js)
 *   Verbose logging for send failures and rate-limit events.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Uses raw JS embed objects (not Discord.js MessageEmbed) to remain
 *   compatible across Discord.js v12 and v13+ without importing the library.
 * - sendDiscordMessage handles 429 rate limits with one automatic retry
 *   using the retryAfter value from the error or response header.
 * - All embed builders accept the TeamBalancer instance (tb) to read
 *   live server state and options. No internal state is stored.
 * - Everything built here goes to the TeamBalancer channel, which is a staff
 *   channel: scramble plans, diagnostics and win-streak reports are read by
 *   admins, never by players. Nothing on this surface is player-facing, which
 *   is what puts all of it in the admin translation tier.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */
import Logger from '../../core/logger.js';

export const DiscordHelpers = {
  buildStatusEmbed(tb) {
    // Defensive checks
    const effectiveStatus = !tb.ready
      ? tb.localize('teamBalancer.embeds.initializing')
      : tb.manuallyDisabled
      ? tb.localize('teamBalancer.embeds.disabledManual')
      : tb.options?.enableWinStreakTracking
      ? tb.localize('teamBalancer.embeds.enabled')
      : tb.localize('teamBalancer.embeds.disabledConfig');

    const maxStreak = tb.options?.maxWinStreak || 2;
    const winStreakText = tb.winStreakTeam
      ? tb.localize('teamBalancer.embeds.streakOfWins', { team: tb.getTeamName(tb.winStreakTeam), count: tb.winStreakCount, maxStreak })
      : tb.localize('teamBalancer.embeds.noneThresholdWins', { maxStreak });

    const maxConsecutive = tb.options?.maxConsecutiveWinsWithoutThreshold || 0;
    const consecutiveLimit = maxConsecutive > 0 ? maxConsecutive : tb.localize('teamBalancer.labels.off');
    const consecutiveText = tb.consecutiveWinsTeam
      ? tb.localize('teamBalancer.embeds.consecutiveOf', { team: tb.getTeamName(tb.consecutiveWinsTeam), count: tb.consecutiveWinsCount, max: consecutiveLimit })
      : tb.localize('teamBalancer.embeds.noneThreshold', { value: consecutiveLimit });

    let lastScrambleText = tb.localize('teamBalancer.labels.never');
    if (tb.lastScrambleTime) {
      const unixTime = Math.floor(tb.lastScrambleTime / 1000);
      // Discord timestamp: f = short date time, R = relative time
      lastScrambleText = `<t:${unixTime}:f> (<t:${unixTime}:R>)`;
    }

    const players = tb.server.players;
    const t1Count = players.filter((p) => p.teamID === 1).length;
    const t2Count = players.filter((p) => p.teamID === 2).length;

    const eloTrackerPlugin = tb.server.plugins?.find(p => p.constructor.name === 'EloTracker');
    const eloStatus = tb.options?.useEloForBalance
      ? (eloTrackerPlugin ? tb.localize('teamBalancer.embeds.eloActive') : tb.localize('teamBalancer.embeds.eloUnavailable'))
      : tb.localize('teamBalancer.embeds.eloDisabled');

    const embed = {
      color: 0x3498db,
      title: tb.localize('teamBalancer.embeds.teambalancerStatus'),
      fields: [
        { name: tb.localize('teamBalancer.embeds.version'), value: tb.constructor.version || tb.localize('teamBalancer.labels.unknown'), inline: true },
        { name: tb.localize('teamBalancer.embeds.pluginStatus'), value: effectiveStatus, inline: true },
        { name: tb.localize('teamBalancer.embeds.eloIntegration'), value: eloStatus, inline: true },
        { name: tb.localize('teamBalancer.embeds.dominantStreak'), value: winStreakText, inline: true },
        { name: tb.localize('teamBalancer.embeds.consecutiveStreak'), value: consecutiveText, inline: true },
        { name: tb.localize('teamBalancer.embeds.seedAutoScramble'), value: tb.seedAutoScrambleStatus(), inline: true },
        { name: tb.localize('teamBalancer.embeds.lastScramble'), value: lastScrambleText, inline: false },
        { name: tb.localize('teamBalancer.embeds.playerCount'), value: tb.localize('teamBalancer.embeds.totalT1T2', { value: players.length, t1Count, t2Count }), inline: false }
      ],
      timestamp: new Date().toISOString()
    };

    return embed;
  },

  buildDiagEmbeds(tb, diagnosticResults = null) {
    const players = tb.server.players;
    const squads = tb.server.squads;
    const t1Players = players.filter((p) => p.teamID === 1);
    const t2Players = players.filter((p) => p.teamID === 2);
    const t1Squads = squads.filter((s) => s.teamID === 1);
    const t2Squads = squads.filter((s) => s.teamID === 2);

    const scrambleInfo = tb.swapExecutor?.pendingPlayerMoves?.size > 0
      ? tb.localize('teamBalancer.embeds.pendingMoves', { size: tb.swapExecutor.pendingPlayerMoves.size })
      : tb.localize('teamBalancer.labels.none');

    // Determine color based on diagnostics if present
    let color = 0x3498db;
    if (diagnosticResults) {
      color = diagnosticResults.every((r) => r.pass) ? 0x2ecc71 : 0xe74c3c;
    }

    // Embed 1: Consolidated runtime state + config (diag-specific fields only)
    const embed1 = {
      color: color,
      title: tb.localize('teamBalancer.embeds.teambalancerDiagnostics'),
      description: tb.localize('teamBalancer.embeds.pluginStatus2', { dISABLED: !tb.ready
          ? tb.localize('teamBalancer.embeds.initializing')
          : tb.manuallyDisabled
          ? tb.localize('teamBalancer.embeds.disabledManual')
          : tb.options?.enableWinStreakTracking
          ? tb.localize('teamBalancer.embeds.enabled')
          : tb.localize('teamBalancer.embeds.disabledConfig') }),
      fields: [
        // Runtime state (what diag tells you that status doesn't)
        { name: tb.localize('teamBalancer.embeds.scramblePending'), value: tb.localize(tb._scramblePending ? 'teamBalancer.labels.yes' : 'teamBalancer.labels.no'), inline: true },
        { name: tb.localize('teamBalancer.embeds.scrambleActive'), value: tb.localize(tb._scrambleInProgress ? 'teamBalancer.labels.yes' : 'teamBalancer.labels.no'), inline: true },
        { name: tb.localize('teamBalancer.embeds.pendingMoves2'), value: scrambleInfo, inline: true },
        { name: tb.localize('teamBalancer.embeds.totalPlayers'), value: `${players.length}`, inline: true },
        { name: tb.localize('teamBalancer.embeds.team1Team2'), value: `${t1Players.length} | ${t2Players.length}`, inline: true },
        { name: tb.localize('teamBalancer.embeds.totalSquads'), value: `${squads.length}`, inline: true },
        { name: tb.localize('teamBalancer.embeds.squadSplit'), value: `T1: ${t1Squads.length} | T2: ${t2Squads.length}`, inline: true },
        // Key thresholds (what matters for debugging)
        { name: tb.localize('teamBalancer.embeds.maxWinThreshold'), value: tb.localize('teamBalancer.embeds.winsUnit', { value: tb.options?.maxWinStreak || 2 }), inline: true },
        { name: tb.localize('teamBalancer.embeds.dominantThreshold'), value: tb.localize('teamBalancer.embeds.ticketsUnit', { value: tb.options?.minTicketsToCountAsDominantWin || 150 }), inline: true },
        { name: tb.localize('teamBalancer.embeds.seedAutoScramble'), value: tb.seedAutoScrambleStatus(), inline: true },
        { name: tb.localize('teamBalancer.embeds.scramblePercent'), value: `${(tb.options?.scramblePercentage || 0.5) * 100}%`, inline: true },
        { name: tb.localize('teamBalancer.embeds.scrambleDelayMax'), value: tb.localize('teamBalancer.embeds.sSeedSMs', { scrambleAnnouncementDelay: tb.options?.scrambleAnnouncementDelay, seedScrambleAnnouncementDelay: tb.options?.seedScrambleAnnouncementDelay, maxScrambleCompletionTime: tb.options?.maxScrambleCompletionTime }), inline: false },
        { name: tb.localize('teamBalancer.embeds.singleRoundScramble'), value: tb.options?.enableSingleRoundScramble ? tb.localize('teamBalancer.embeds.tix', { singleRoundScrambleThreshold: tb.options?.singleRoundScrambleThreshold }) : tb.localize('teamBalancer.embeds.singleRoundOff'), inline: true },
        { name: tb.localize('teamBalancer.embeds.invasionThresholds'), value: tb.localize('teamBalancer.embeds.atkDef', { invasionAttackTeamThreshold: tb.options?.invasionAttackTeamThreshold, invasionDefenceTeamThreshold: tb.options?.invasionDefenceTeamThreshold }), inline: true },
        // Reads "standard" rather than repeating the number when unset, so the
        // embed shows whether TC is tuned, not just what it currently resolves to.
        { name: tb.localize('teamBalancer.embeds.tcThresholds'), value: tb.localize('teamBalancer.embeds.domMercy', { value: tb.options?.tcDominantThreshold ?? tb.localize('teamBalancer.labels.standard'), value2: tb.options?.tcSingleRoundScrambleThreshold ?? tb.localize('teamBalancer.labels.standard') }), inline: true },
        { name: tb.localize('teamBalancer.embeds.discordOptions'), value: tb.localize('teamBalancer.embeds.mirrorDetails', { value: tb.localize(tb.options?.mirrorRconBroadcasts ? 'teamBalancer.labels.yes' : 'teamBalancer.labels.no'), value2: tb.localize(tb.options?.postScrambleDetails ? 'teamBalancer.labels.yes' : 'teamBalancer.labels.no') }), inline: false },
      ],
      timestamp: new Date().toISOString(),
    };

    const embeds = [embed1];

    // Embed 2: Diagnostic test results (if tests ran)
    if (diagnosticResults) {
      const resultsEmbeds = this.buildDiagnosticResultsEmbeds(tb, diagnosticResults, color);
      embeds.push(...resultsEmbeds);
    }

    return embeds;
  },

  buildDiagnosticResultsEmbeds(tb, diagnosticResults, color) {
    const embeds = [];
    const formatMessage = (msg) => (msg.length > 1000 ? msg.substring(0, 997) + '...' : msg);
    const maxFieldsPerEmbed = 25; // Discord limit
    const totalPages = Math.ceil(diagnosticResults.length / maxFieldsPerEmbed);

    let currentEmbed = null;

    for (let i = 0; i < diagnosticResults.length; i++) {
      if (i % maxFieldsPerEmbed === 0) {
        const pageNum = Math.floor(i / maxFieldsPerEmbed) + 1;
        const title = totalPages > 1 ? tb.localize('teamBalancer.embeds.diagnosticResultsPart', { pageNum }) : tb.localize('teamBalancer.embeds.diagnosticResults');
        currentEmbed = {
          color: color,
          title: title,
          fields: [],
          timestamp: new Date().toISOString(),
        };
        embeds.push(currentEmbed);
      }
      currentEmbed.fields.push({ name: `**${diagnosticResults[i].name}:**`, value: formatMessage(diagnosticResults[i].message), inline: false });
    }

    return embeds;
  },

  async createScrambleDetailsMessage(swapPlan, isSimulated, tb, eloMap = null) {
    const players = tb.server.players;
    const squads = tb.server.squads;
    const currentT1 = players.filter(p => p.teamID == 1).length;
    const currentT2 = players.filter(p => p.teamID == 2).length;

    const f1 = tb.getTeamName(1);
    const f2 = tb.getTeamName(2);

    // Build lookup maps.
    // Raw SquadJS squad objects do not have a `.players` property (see API ref §7);
    // we derive the squad → player relationship from the player side instead.
    // Each player already carries a squadID, so we index squads by (teamID, squadID)
    // and then walk the player list to populate squadByEos.
    const playerByEos = new Map(players.map(p => [p.eosID, p]));
    const squadByEos = new Map();
    const squadById = new Map();
    for (const s of squads) {
      squadById.set(`${s.teamID}-${s.squadID}`, s);
    }
    for (const p of players) {
      if (p.squadID != null) {
        const s = squadById.get(`${p.teamID}-${p.squadID}`);
        if (s) squadByEos.set(p.eosID, s);
      }
    }

    // Present only when clan grouping actually built virtual squads this round. The scrambler
    // emits one entry per unit it moves, so the rosters are disjoint — a flat set is enough to
    // keep those players out of the regular squad blocks. ◆/◇ is decided per block instead of
    // globally: a player is a clan member *of the block being rendered*, and a merged unit
    // carries several tags.
    const virtualSquads = swapPlan.virtualSquads || [];
    const virtualRosterIDs = new Set();
    for (const vs of virtualSquads) {
      for (const id of vs.members) virtualRosterIDs.add(id);
      for (const id of vs.pulled) virtualRosterIDs.add(id);
    }

    // Build move lookup
    const moveByEos = new Map(swapPlan.map(m => [m.eosID, m]));

    // Group moves by direction
    const moveData = {
      '1to2': { srcID: 1, tgtID: 2, srcFaction: f1, tgtFaction: f2, playersTotal: 0, squads: {}, virtual: [] },
      '2to1': { srcID: 2, tgtID: 1, srcFaction: f2, tgtFaction: f1, playersTotal: 0, squads: {}, virtual: [] }
    };

    for (const move of swapPlan) {
      const player = playerByEos.get(move.eosID);
      if (!player) continue;

      const srcID = String(player.teamID);
      const tgtID = String(move.targetTeamID);
      const dirKey = `${srcID}to${tgtID}`;

      if (!moveData[dirKey]) continue;
      moveData[dirKey].playersTotal++;

      if (virtualRosterIDs.has(move.eosID)) {
        moveData[dirKey].virtual.push(move.eosID);
      } else {
        const sID = player.squadID || 'UNASSIGNED';
        if (!moveData[dirKey].squads[sID]) moveData[dirKey].squads[sID] = [];
        moveData[dirKey].squads[sID].push(move.eosID);
      }
    }

    // Compute listedTotal for each direction (non-virtual players)
    for (const dir of ['1to2', '2to1']) {
      const data = moveData[dir];
      data.listedTotal = Object.values(data.squads).reduce((n, ids) => n + ids.length, 0);
    }

    const movesToT1 = moveData['2to1'].playersTotal;
    const movesToT2 = moveData['1to2'].playersTotal;
    const projT1 = currentT1 + movesToT1 - movesToT2;
    const projT2 = currentT2 + movesToT2 - movesToT1;

    let balanceProjectionValue = tb.localize('teamBalancer.embeds.populationTeam1Team', { f1, currentT1, projT1, f2, currentT2, projT2 });

    if (eloMap) {
      let t1Mu = 0, t2Mu = 0, t1Regs = 0, t2Regs = 0;
      let t1Count = 0, t2Count = 0;
      
      let projT1Mu = 0, projT2Mu = 0, projT1Regs = 0, projT2Regs = 0;
      let projT1Count = 0, projT2Count = 0;

      const t1Elos = [];
      const t2Elos = [];
      const projT1Elos = [];
      const projT2Elos = [];

      for (const p of players) {
        const rating = eloMap.get(p.eosID);
        const mu = rating ? rating.mu : 25.0;
        const isReg = rating && (rating.roundsPlayed || 0) >= 10;

        // Baseline logic
        if (String(p.teamID) === '1') {
          t1Mu += mu; t1Count++;
          t1Elos.push(mu);
          if (isReg) t1Regs++;
        } else if (String(p.teamID) === '2') {
          t2Mu += mu; t2Count++;
          t2Elos.push(mu);
          if (isReg) t2Regs++;
        }

        // Projected logic (simulate the move)
        const plannedMove = swapPlan.find(m => m.eosID === p.eosID);
        const projectedTeam = plannedMove ? String(plannedMove.targetTeamID) : String(p.teamID);
        
        if (projectedTeam === '1') {
          projT1Mu += mu; projT1Count++;
          projT1Elos.push(mu);
          if (isReg) projT1Regs++;
        } else if (projectedTeam === '2') {
          projT2Mu += mu; projT2Count++;
          projT2Elos.push(mu);
          if (isReg) projT2Regs++;
        }
      }

      const getTop15Avg = (arr) => {
        if (!arr.length) return 25.0;
        const sorted = [...arr].sort((a, b) => b - a);
        const slice = sorted.slice(0, 15);
        return slice.reduce((a, b) => a + b, 0) / slice.length;
      };

      const avgT1 = t1Count > 0 ? (t1Mu / t1Count).toFixed(1) : '25.0';
      const avgT2 = t2Count > 0 ? (t2Mu / t2Count).toFixed(1) : '25.0';
      const pAvgT1 = projT1Count > 0 ? (projT1Mu / projT1Count).toFixed(1) : '25.0';
      const pAvgT2 = projT2Count > 0 ? (projT2Mu / projT2Count).toFixed(1) : '25.0';

      const top15T1 = getTop15Avg(t1Elos).toFixed(1);
      const top15T2 = getTop15Avg(t2Elos).toFixed(1);
      const pTop15T1 = getTop15Avg(projT1Elos).toFixed(1);
      const pTop15T2 = getTop15Avg(projT2Elos).toFixed(1);

      balanceProjectionValue += tb.localize('teamBalancer.embeds.globalEloAvgTeam', { avgT1, pAvgT1, avgT2, pAvgT2 });
      balanceProjectionValue += tb.localize('teamBalancer.embeds.top15EloAvg', { top15T1, pTop15T1, top15T2, pTop15T2 });
      balanceProjectionValue += tb.localize('teamBalancer.embeds.regularsTeam1Team', { t1Regs, projT1Regs, t2Regs, projT2Regs });
    }

    const embed = {
      color: isSimulated ? 0x9b59b6 : 0x2ecc71,
      title: isSimulated ? tb.localize('teamBalancer.embeds.dryRunScramblePlan') : tb.localize('teamBalancer.embeds.scrambleExecutionPlan'),
      description: tb.localize('teamBalancer.embeds.totalPlayersAffectedCalculation', { value: swapPlan.length, value2: swapPlan.calculationTime || tb.localize('teamBalancer.labels.notAvailable') }),
      fields: [
        { 
          name: tb.localize('teamBalancer.embeds.balanceProjection'), 
          value: balanceProjectionValue, 
          inline: false 
        }
      ],
      timestamp: new Date().toISOString()
    };

    // Hoisted: the anchor lookup in a virtual squad header needs it too, not just the rows.
    const squadLabelOf = (eosID) => {
      const sq = squadByEos.get(eosID);
      return sq ? sq.squadName || tb.localize('teamBalancer.embeds.squadNumber', { squadID: sq.squadID }) : '—';
    };

    let skippedLines = 0;
    for (const dir of ['1to2', '2to1']) {
      const data = moveData[dir];
      if (data.playersTotal === 0) continue;

      // ─── Virtual squad blocks (Clan Grouping) ─────────────────────
      // Only groups the plan actually touched — an untouched virtual squad is the common case,
      // and listing every one in full would bury the handful of players that do move.
      const teamVirtual = virtualSquads
        .filter(vs => String(vs.teamID) === String(data.srcID))
        .map(vs => ({ vs, roster: [...vs.members, ...vs.pulled] }))
        .filter(({ roster }) => roster.some(id => moveByEos.has(id)));

      if (teamVirtual.length > 0) {
        const blocks = teamVirtual.map(({ vs, roster }) => {
          // "divided" is about the virtual squad itself ending up on two teams — the thing the
          // grouping exists to prevent. Moving as a unit is the norm, so it goes unlabelled.
          const divided = roster.some(id => !moveByEos.has(id));
          const memberSet = new Set(vs.members);

          // Compute average mu for the roster
          let muSum = 0, muCount = 0;
          for (const id of roster) {
            const rating = eloMap ? eloMap.get(id) : null;
            if (rating) { muSum += rating.mu; muCount++; }
          }
          const avgMu = muCount > 0 ? (muSum / muCount).toFixed(1) : '—';

          let header = tb.localize('teamBalancer.embeds.virtualSquadP', { tags: this.formatTags(vs), value: roster.length, avgMu });
          // The anchor is the squad the unit was built around; it only tells the reader
          // anything when the unit actually spans several in-game squads.
          const squadCount = new Set(roster.map(id => squadLabelOf(id))).size;
          if (vs.anchorEosID && squadCount > 1) header += ` · ⚓${squadLabelOf(vs.anchorEosID)}`;
          if (divided) header += tb.localize('teamBalancer.embeds.dividedSuffix');

          return [header, ...this.buildPlayerRows(tb, roster, playerByEos, eloMap, memberSet, {
            movedOf: divided ? (id => (moveByEos.has(id) ? 'moved' : 'stay')) : null,
            squadLabelOf
          })];
        });

        // Counts players who actually change team, same as the regular fields — a divided squad
        // keeps its stayers visible but they are not part of the move. Per-squad roster sizes
        // are in the block headers.
        const movers = teamVirtual.reduce(
          (n, { roster }) => n + roster.filter(id => moveByEos.has(id)).length, 0);

        skippedLines += this.pushChunkedFields(tb, embed, blocks,
          tb.localize('teamBalancer.embeds.teamTeamClanGrouping', { srcID: data.srcID, srcFaction: data.srcFaction, tgtID: data.tgtID, tgtFaction: data.tgtFaction }),
          tb.localize('teamBalancer.embeds.playersSuffix', { value: movers }));
      }

      // ─── Regular squad blocks ─────────────────────────────────────
      if (data.listedTotal === 0) continue;

      const blocks = Object.entries(data.squads).map(([sID, playerIDs]) => {
        const squadName = sID === 'UNASSIGNED'
          ? tb.localize('teamBalancer.embeds.unassignedSquad')
          : (squadByEos.get(playerIDs[0])?.squadName || tb.localize('teamBalancer.embeds.squadNumber', { squadID: sID }));

        let squadMuTotal = 0;
        let squadRegs = 0;
        if (eloMap) {
          for (const eosID of playerIDs) {
            const rating = eloMap.get(eosID);
            if (rating) {
              squadMuTotal += rating.mu;
              if ((rating.roundsPlayed || 0) >= 10) squadRegs++;
            } else {
              squadMuTotal += 25.0;
            }
          }
        }
        const squadAvgMu = playerIDs.length > 0 ? (squadMuTotal / playerIDs.length).toFixed(1) : '25.0';

        const header = eloMap
          ? tb.localize('teamBalancer.embeds.squadHeaderElo', { squadName, squadAvgMu, squadRegs })
          : `[${squadName}]`;

        return [
          header.padEnd(16) + ` ${playerIDs.length}p`,
          ...this.buildPlayerRows(tb, playerIDs, playerByEos, eloMap, null)
        ];
      });

      skippedLines += this.pushChunkedFields(tb, embed, blocks,
        tb.localize('teamBalancer.embeds.teamTeam', { srcID: data.srcID, srcFaction: data.srcFaction, tgtID: data.tgtID, tgtFaction: data.tgtFaction }),
        tb.localize('teamBalancer.embeds.playersSuffix', { value: data.listedTotal }));
    }

    // One notice for the whole report, and last so the reader sees it after the lists. The
    // push deliberately ignores the size budget, which is why `reserve` sets aside room for
    // exactly one of these.
    if (skippedLines) {
      embed.fields.push({
        name: tb.localize('teamBalancer.embeds.truncated'),
        value: tb.localize('teamBalancer.embeds.furtherLinesOmittedStay', { skippedLines }),
        inline: false
      });
    }

    // Each entry appears only if its symbol actually made it into the report — no legend for
    // markers nobody can see (a plan without ELO has no ★, one without clans has no ◆/◇).
    const body = embed.fields.map(f => f.value).join('\n');
    const legend = [
      ['★', tb.localize('teamBalancer.embeds.regular10Rounds')],
      ['◆', tb.localize('teamBalancer.embeds.clanMemberVirtualSquad')],
      ['◇', tb.localize('teamBalancer.embeds.pulledWithSquad')],
      ['⚓', tb.localize('teamBalancer.embeds.anchorSquad')]
    ].filter(([symbol]) => body.includes(symbol)).map(([symbol, text]) => `${symbol} ${text}`);

    if (legend.length) embed.footer = { text: legend.join(' · ') };

    if (swapPlan.length === 0) {
      const action = tb.localize(isSimulated ? 'teamBalancer.embeds.simulation' : 'teamBalancer.embeds.scrambleCalculation');
      embed.footer = { text: tb.localize('teamBalancer.embeds.resultedNoPlayerMoves', { action }) };
    }

    return embed;
  },

  // Every clan tag bound into one virtual squad. Clans that ended up in the same unit move
  // together and are reported as one block, so the header has to name all of them. Long
  // pile-ups are cut short — the header competes with the roster for the same 1024 characters.
  formatTags(vs) {
    const tags = vs.tags?.length ? vs.tags : [vs.tag];
    const shown = tags.slice(0, 3).map(t => `[${t}]`).join(' + ');
    return tags.length > 3 ? `${shown} +${tags.length - 3}` : shown;
  },

  // One player per line, ELO first: the fixed-width columns stay aligned in Discord's monospace
  // block because the only variable-width part (the name) sits last — player names routinely
  // contain Unicode that would otherwise wreck a right-aligned layout.
  //
  // Optional columns, each only rendered where it carries information:
  //   movedOf(eosID)     — 'moved'/'stay'; used for a virtual squad the plan tore apart
  //   squadLabelOf(eosID) — the real in-game squad; a virtual squad spans several of them
  // memberSet turns on the clan marker column: ◆ for the players carrying one of the block's
  // clan tags, ◇ for everyone the unit pulled along. Pass null outside a virtual squad block.
  buildPlayerRows(tb, eosIDs, playerByEos, eloMap, memberSet, { movedOf = null, squadLabelOf = null } = {}) {
    const showMarker = !!memberSet;

    const rows = eosIDs.map(eosID => {
      const player = playerByEos.get(eosID);
      const rating = eloMap ? eloMap.get(eosID) : null;
      return {
        eosID,
        name: player ? player.name : tb.localize('teamBalancer.embeds.unknownPlayer', { value: eosID.slice(0, 8) }),
        mu: eloMap ? (rating ? rating.mu : 25.0) : null,
        isReg: !!rating && (rating.roundsPlayed || 0) >= 10,
        marker: !showMarker ? ' ' : memberSet.has(eosID) ? '◆' : '◇',
        moved: movedOf ? movedOf(eosID) : null
      };
    });

    rows.sort((a, b) => {
      if (movedOf && a.moved !== b.moved) return a.moved === 'moved' ? -1 : 1;
      return eloMap ? b.mu - a.mu : 0;
    });

    const fit = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

    return rows.map(r => {
      let line = '  ';
      if (movedOf) line += `${tb.localize(r.moved === 'moved' ? 'teamBalancer.embeds.movedRow' : 'teamBalancer.embeds.stayRow').padEnd(5)}  `;
      if (eloMap) line += `${r.mu.toFixed(1).padStart(4)}${r.isReg ? '★' : ' '}  `;
      if (showMarker) line += `${r.marker} `;
      if (squadLabelOf) line += `${fit(squadLabelOf(r.eosID), 9)} `;
      return line + r.name;
    });
  },

  // Packs blocks (a header plus its player rows) into embed fields, keeping each block whole in
  // one field so a squad is never cut in half across two ```text``` blocks. A block that cannot
  // fit a field on its own — a big clan, or UNASSIGNED collecting every squadless player — is
  // the one case that falls back to splitting line by line, since Discord caps a field value at
  // 1024 characters no matter what.
  //
  // The per-field cap alone is not enough: Discord also rejects the entire message when title +
  // description + every field name and value + footer exceed 6000 characters, and a clan-heavy
  // plan produces enough fields to get there (divided virtual squads list their stayers on top
  // of the movers). So chunks are only pushed while the embed can still afford them, and what
  // did not fit is returned — a shortened report beats a 400 that drops the report entirely.
  // Reporting the shortfall is the caller's job: an embed takes up to four calls (both
  // directions × virtual and regular squads) and gets exactly one truncation notice.
  pushChunkedFields(tb, embed, blocks, baseName, suffix = '') {
    const codeBlockWrapLen = 13; // ```text\n ... \n```
    const embedCharLimit = 6000;
    // Room for the title, the description, the legend footer and the one truncation notice —
    // none of which are in embed.fields yet (or at all) while this runs.
    const reserve = 320;
    const used = () => embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    const nameFor = (part) => (part === 1 ? (suffix ? `${baseName} ${suffix}` : baseName) : tb.localize('teamBalancer.embeds.fieldContinued', { baseName }));

    const chunks = [];
    const addLine = (line) => {
      const current = chunks[chunks.length - 1];
      if (current && current.value.length + line.length + 1 + codeBlockWrapLen <= 1024) {
        current.value += '\n' + line;
        current.lines++;
      } else {
        chunks.push({ value: line, lines: 1 });
      }
    };

    const costOf = (arr) => arr.reduce((n, l) => n + l.length + 1, 0);
    for (const block of blocks) {
      if (!block.length) continue;
      const current = chunks[chunks.length - 1];
      // Blocks stay separated by a blank line, exactly as before.
      if (current && current.value.length + costOf(['', ...block]) + codeBlockWrapLen <= 1024) {
        current.value += '\n\n' + block.join('\n');
        current.lines += block.length;
      } else if (costOf(block) + codeBlockWrapLen <= 1024) {
        chunks.push({ value: block.join('\n'), lines: block.length });
      } else {
        if (current) addLine('');
        block.forEach(addLine);
      }
    }

    let skipped = 0;
    chunks.forEach((chunk, i) => {
      const name = nameFor(i + 1);
      const cost = name.length + chunk.value.length + codeBlockWrapLen;
      // Once one chunk is dropped the rest go too, so the report never jumps over a gap.
      if (skipped || used() + cost + reserve > embedCharLimit) {
        skipped += chunk.lines;
        return;
      }
      embed.fields.push({ name, value: `\`\`\`text\n${chunk.value}\n\`\`\``, inline: false });
    });

    return skipped;
  },

  buildWinStreakEmbed(tb, teamName, teamID, streakCount, maxStreak, margin, isDominant) {
    const embed = {
      color: isDominant ? 0xf39c12 : 0x3498db,
      title: isDominant ? tb.localize('teamBalancer.embeds.dominantWinStreak') : tb.localize('teamBalancer.embeds.winRecorded'),
      fields: [
        { name: tb.localize('teamBalancer.embeds.winningTeam'), value: tb.localize('teamBalancer.embeds.winningTeamValue', { teamName, teamID }), inline: true },
        { name: tb.localize('teamBalancer.embeds.streakProgress'), value: tb.localize('teamBalancer.embeds.streakProgressValue', { streakCount, maxStreak }), inline: true },
        { name: tb.localize('teamBalancer.embeds.ticketMargin'), value: `+${margin}`, inline: true }
      ],
      timestamp: new Date().toISOString()
    };

    if (isDominant) {
      const remaining = maxStreak - streakCount;
      if (remaining <= 0) {
        embed.description = tb.localize('teamBalancer.embeds.scrambleThresholdReachedTeams');
      } else {
        embed.description = tb.localize('teamBalancer.embeds.dominanceDetectedIfTeam', { remaining });
      }
    }

    return embed;
  },

  buildScrambleTriggeredEmbed(tb, reason, teamName, count, delay) {
    const embed = {
      color: 0xf39c12,
      title: tb.localize('teamBalancer.embeds.scrambleTriggered'),
      description: tb.localize('teamBalancer.embeds.reasonLine', { reason }),
      fields: [
        { name: tb.localize('teamBalancer.embeds.dominantTeam'), value: teamName || tb.localize('teamBalancer.labels.notAvailable'), inline: true },
        { name: tb.localize('teamBalancer.embeds.winStreak'), value: count ? tb.localize('teamBalancer.embeds.winsUnit', { value: count }) : tb.localize('teamBalancer.labels.notAvailable'), inline: true },
        { name: tb.localize('teamBalancer.embeds.countdown'), value: tb.localize('teamBalancer.embeds.secondsUnit', { delay }), inline: true }
      ],
      timestamp: new Date().toISOString()
    };

    return embed;
  },

  buildScrambleCompletedEmbed(tb, totalMoves, movedSuccessfully, failedToMove, disconnected, duration, failedNames = []) {
    const successRate = totalMoves > 0 ? Math.round((movedSuccessfully / totalMoves) * 100) : 100;

    const embed = {
      color: failedToMove > 0 ? 0xf39c12 : 0x2ecc71,
      title: tb.localize('teamBalancer.embeds.scrambleCompleted'),
      fields: [
        { name: tb.localize('teamBalancer.embeds.totalMoves'), value: `${totalMoves}`, inline: true },
        { name: tb.localize('teamBalancer.embeds.movedSuccessfully'), value: `${movedSuccessfully}`, inline: true },
        { name: tb.localize('teamBalancer.embeds.disconnected'), value: `${disconnected}`, inline: true },
        { name: tb.localize('teamBalancer.embeds.failed'), value: `${failedToMove}`, inline: true },
        { name: tb.localize('teamBalancer.embeds.successRate'), value: `${successRate}%`, inline: true },
        { name: tb.localize('teamBalancer.embeds.duration'), value: `${duration}ms`, inline: true }
      ],
      timestamp: new Date().toISOString()
    };

    if (failedToMove > 0) {
      if (failedNames && failedNames.length > 0) {
        const nameList = failedNames.slice(0, 20).join('\n');
        const trailer = failedNames.length > 20 ? tb.localize('teamBalancer.embeds.moreNamesOmitted', { value: failedNames.length - 20 }) : '';
        embed.fields.push({
          name: tb.localize('teamBalancer.embeds.failedPlayers', { value: failedNames.length }),
          value: `\`\`\`text\n${nameList}${trailer}\n\`\`\``,
          inline: false
        });
      }
      embed.description = tb.localize('teamBalancer.embeds.somePlayersCouldNot');
    }

    return embed;
  },

  buildScrambleFailedEmbed(reason, duration, tb) {
    const players = tb?.server?.players || [];
    const t1Count = players.filter((p) => p.teamID == 1).length;
    const t2Count = players.filter((p) => p.teamID == 2).length;

    const embed = {
      color: 0xe74c3c,
      title: tb.localize('teamBalancer.embeds.scrambleFailed'),
      description: tb.localize('teamBalancer.embeds.reasonLine', { reason }),
      fields: [
        { name: tb.localize('teamBalancer.embeds.calculationTime'), value: `${duration}ms`, inline: true },
        { name: tb.localize('teamBalancer.embeds.serverState'), value: tb.localize('teamBalancer.embeds.totalT1T22', { value: players.length, t1Count, t2Count }), inline: true }
      ],
      timestamp: new Date().toISOString()
    };
    return embed;
  },

  buildFatalErrorEmbed(error, context, tb) {
    const players = tb?.server?.players || [];
    const t1Count = players.filter((p) => p.teamID == 1).length;
    const t2Count = players.filter((p) => p.teamID == 2).length;

    const embed = {
      color: 0x992d22,
      title: tb.localize('teamBalancer.embeds.fatalPluginError'),
      description: tb.localize('teamBalancer.embeds.contextError', { context, error: error?.message || error }),
      fields: [
        { name: tb.localize('teamBalancer.embeds.serverState'), value: tb.localize('teamBalancer.embeds.totalT1T22', { value: players.length, t1Count, t2Count }), inline: true },
        { name: tb.localize('teamBalancer.embeds.version'), value: tb?.constructor?.version || tb.localize('teamBalancer.labels.unknown'), inline: true }
      ],
      timestamp: new Date().toISOString()
    };

    if (error?.stack) {
      const stack = error.stack.length > 1000 ? error.stack.substring(0, 1000) + '...' : error.stack;
      embed.fields.push({ name: tb.localize('teamBalancer.embeds.stackTrace'), value: `\`\`\`js\n${stack}\n\`\`\``, inline: false });
    }

    return embed;
  },

  async sendDiscordMessage(channel, content, suppressErrors = true) {
    if (!channel) {
      Logger.verbose('TeamBalancer', 1, 'Discord send failed: No channel available');
      return false;
    }

    if (!content) {
      Logger.verbose('TeamBalancer', 1, 'Discord send failed: Content was empty.');
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

          Logger.verbose('TeamBalancer', 1, `Discord 429 Rate Limit hit. Waiting ${waitTime}ms before retry.`);
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
      Logger.verbose('TeamBalancer', 1, errMsg);
      return false;
    }
  }
};