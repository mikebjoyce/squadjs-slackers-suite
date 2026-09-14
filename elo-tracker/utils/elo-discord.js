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
 *   Object. Key members. Every embed builder takes the EloTracker instance
 *   (tracker) as its first argument, to reach localize():
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
 *       Attaches onDiscordMessage, _findPlayerCandidates,
 *       _findPlayerByIdentifier and _getOnlinePlayerIDs onto the
 *       tracker instance. The two finders are shared with the in-game
 *       commands in elo-commands.js so every lookup path resolves a
 *       name identically.
 *
 *   Calculates and displays a "Conservative Rating" (μ - 3σ)
 *   as the primary player rank to encourage active play.
 *
 * ─── ROUTING (v2.2.0, multi-server) ──────────────────────────────
 *
 * Ratings are community-wide — one player, one rating, however many
 * servers they play on — so most of what this file builds is the
 * same answer whichever process renders it. That is exactly why the
 * routing matters: without a gate, three processes would each post
 * an identical leaderboard to the same channel.
 *
 * registerDiscordCommands() routes through
 * tracker.routeDiscordCommand?.() before dispatch, and the two
 * admin mutations arm through tracker.armConfirmation?.() so the
 * process that mints a confirmation token is the process that acts
 * on it. Both are optional-chained, so against an older S³ they do
 * not throw — the commands simply never run. EloTracker's S³ floor
 * is a hard 1.8.0 for that reason: silent inaction is a worse
 * failure than a refusal, so the version check is what has to catch
 * it.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Logger (../../core/logger.js)
 *   Verbose logging for send failures and rate-limit events.
 * EloDatabase (./elo-database.js)
 *   Static formatOtherMatches() for the ambiguous-lookup footer.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - The !elo prefix test is case-insensitive and word-bounded, so
 *   `!Elo`/`!ELO` work (matching in-game, where SquadJS lowercases the
 *   command before emitting CHAT_COMMAND:*) while `!elophant` does not.
 * - Name lookups are ranked, not first-hit — see searchPlayers() in
 *   elo-database.js. `!elo reset <identifier>` additionally requires an
 *   unambiguous match (EloDatabase.isUnambiguous), since it is destructive.
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

/**
 * Sticky once discovered: this discord.js only understands the singular
 * `embed` key, so a multi-embed payload has to be sent one message at a time.
 *
 * Stock SquadJS 4.1.0 pins discord.js 12.5.3, which has no `embeds` key —
 * an embeds-only payload reads as empty to it and the API says so. Forks
 * and manual bumps run v13/v14, and the suite installs into whichever the
 * host already has, so the shape is discovered rather than version-sniffed.
 *
 * This replaced a fallback that retried as `{ embed: data.embeds[0] }` and
 * returned success — on a v12 host every multi-embed report silently lost
 * all but its first embed, and nothing logged it.
 */
let legacyEmbedMode = false;
import EloCalculator from './elo-calculator.js';
import EloDatabase from './elo-database.js';

/**
 * Which server answers `!elo <verb>`.
 *
 * The split follows what the verb reads rather than the channel the command
 * arrived in: a rating belongs to a player and not to a server, so `me`, `leaderboard`,
 * `clan`, `clans`, `link` and `explain` all read community-wide data and one
 * process answering is the correct answer, not a compromise.
 *
 * **A community read must resolve its options from the registry, not from
 * `this.options`.** `leaderboard` is the case that makes it concrete: with
 * `minRoundsForLeaderboard` set differently on two servers, the same command
 * in the same channel returns a different leaderboard depending on which
 * process happened to win the claim — a wrong answer with nothing wrong
 * about it on the page. The community option summary is what settles it, and
 * it is resolved at the call site rather than here.
 *
 * `status` and `roundinfo` are the exceptions and are genuinely per-server:
 * one reports this process's session cache and rating cache, the other the
 * round this server is currently playing.
 *
 * `reset` is community-wide and destructive — it wipes `Elo_PlayerStats` for
 * every server at once. Its bare-word `confirm` is tagged with it rather than
 * as a token confirm, because there is no token yet: requiring `--server`
 * routes the confirm to the process that armed it, which is the guarantee a
 * token will give and the one available now.
 *
 * `restore` downloads an attachment and imports it into community-wide
 * tables. Ungated, every process imports the same file concurrently.
 *
 * @param {string} sub
 * @returns {{scope: string, selectorRequired: boolean}}
 *
 * The scope values are literal strings rather than the COMMAND_SCOPE
 * constants because this file cannot import an S³ util — the suite ships
 * flattened, and no single specifier resolves both here and at the target.
 * `test-discord-routing.js` asserts every value this returns is one
 * COMMAND_SCOPE declares, which is what importing them would have bought.
 */
export function scopeForEloCommand(sub, args = []) {
  // Everything but `reset` is decided by the verb alone, so the argument
  // list is optional and a caller with only a verb still gets the right
  // answer for every other command on this surface.
  const rest = (Array.isArray(args) ? args.slice(1) : []).map((a) => String(a).toLowerCase());

  switch (String(sub ?? '').toLowerCase()) {
    case 'status':
    case 'roundinfo':
      return { scope: 'server-read', selectorRequired: false };

    case 'reset':
      // A confirm carrying a token minted at arm time routes itself: the
      // arm lives in one process's memory, and a claim would hand the
      // message to an arbitrary process that would reject a token it
      // never minted. A bare `reset confirm` on a single-server install
      // never gets here with a token and stays a community mutation.
      if (rest.includes('confirm') && rest.some((a) => /^[0-9a-f]{4}$/.test(a))) {
        return { scope: 'token-confirm', selectorRequired: false };
      }
      return { scope: 'community-mutating', selectorRequired: false };

    case 'restore':
      // Same shape as `reset` above: the token minted at arm time is the
      // routing, so the confirm must reach every process rather than an
      // elected one. Without a token this is the ordinary community
      // mutation it has always been.
      if (rest.includes('confirm') && rest.some((a) => /^[0-9a-f]{4}$/.test(a))) {
        return { scope: 'token-confirm', selectorRequired: false };
      }
      return { scope: 'community-mutating', selectorRequired: false };

    // `backup`, `me`, `leaderboard`, `clan`, `clans`, `link`, `explain`,
    // `help`, and a bare `!elo`, which is `me`.
    default:
      return { scope: 'community-read', selectorRequired: false };
  }
}

/**
 * How long `!elo reset` stays armed. Read by both the arm and the confirm,
 * which spent a while as two copies of the same literal.
 */
export const ELO_RESET_CONFIRM_MS = 30000;

/**
 * Download a backup attachment and check it is one.
 *
 * Separated from the import so the same validation runs at arm time and at
 * confirm time. A file that passed once and fails the second time is not a
 * case worth trusting: Discord attachment URLs expire, and an admin should
 * hear that rather than watch a restore report success over nothing.
 *
 * @param {string} url
 * @returns {Promise<{players: object[]}|{errorKey: string}>}
 */
async function fetchBackupPlayers(url) {
  const response = await fetch(url);
  const json = await response.json();

  if (!Array.isArray(json.players)) {
    return { errorKey: 'eloTracker.embeds.invalidBackupFormatMissing' };
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

  if (!isValidSchema) return { errorKey: 'eloTracker.embeds.invalidBackupFormatOne' };

  return { players: json.players };
}

const formatDuration = (tracker, ms) => {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor((ms / (1000 * 60 * 60)));

  const parts = [];
  if (hours > 0) parts.push(tracker.localize('eloTracker.embeds.durationHours', { hours }));
  if (minutes > 0) parts.push(tracker.localize('eloTracker.embeds.durationMinutes', { minutes }));
  parts.push(tracker.localize('eloTracker.embeds.durationSeconds', { seconds }));

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

const getVeterancyUI = (tracker, veterancy) => {
  const pct = Math.round(veterancy * 100);
  if (veterancy <= 0.3) {
    return { icon: '🔴', label: tracker.localize('eloTracker.embeds.veterancyLow', { pct }), color: 0xe74c3c };
  } else if (veterancy <= 0.6) {
    return { icon: '🟡', label: tracker.localize('eloTracker.embeds.veterancyModerate', { pct }), color: 0xf1c40f };
  } else {
    return { icon: '🟢', label: tracker.localize('eloTracker.embeds.veterancyHigh', { pct }), color: 0x2ecc71 };
  }
};

const getRegEmoji = (leadShare) => {
  if (leadShare > DISPARITY_THRESHOLDS.SEVERE_SHARE) return '🔴';
  if (leadShare > DISPARITY_THRESHOLDS.MINOR_SHARE) return '🟡';
  return '🟢';
};
const getEloEmoji = (delta) => delta < 1.0 ? '🟢' : (delta <= 2.5 ? '🟡' : '🔴');

const generateMatrixTable = (tracker, t1, t2) => {
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
    tracker.localize('eloTracker.embeds.team1CategoryTeam'),
    '----------------------------------',
    row(fmtCount(t1.tierStats.vCount), tracker.localize('eloTracker.embeds.matrixVisitors'), fmtCount(t2.tierStats.vCount)),
    row(fmtCount(t1.tierStats.pCount), tracker.localize('eloTracker.embeds.matrixProvisional'), fmtCount(t2.tierStats.pCount)),
    row(fmtCount(t1.tierStats.rCount), tracker.localize('eloTracker.embeds.matrixRegulars'), fmtCount(t2.tierStats.rCount)),
    '----------------------------------',
    row(fmtMu(t1.avgMu), tracker.localize('eloTracker.embeds.teamAvg'), fmtMu(t2.avgMu)),
    row(fmtMu(t1.avgRegMu), tracker.localize('eloTracker.embeds.regsAvg'), fmtMu(t2.avgRegMu)),
    row(fmtMu(t1.top15Mu), tracker.localize('eloTracker.embeds.top15Avg'), fmtMu(t2.top15Mu)),
    '----------------------------------',
    row(fmtPct(t1.veterancy), tracker.localize('eloTracker.embeds.matrixVeterancy'), fmtPct(t2.veterancy)),
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

    // Which server this came from, when there is more than one. `this` is
    // EloDiscord, and EloTracker sets the function on it at mount — this
    // file cannot import it, because the module lives in `s3/utils/` in the
    // source tree and beside this one in the layout install.cjs produces.
    // Absent, on a single-server install, or before mount: no label.
    payload = this.applyServerLabel?.(payload) ?? payload;

    const channelId = channel?.id || 'unknown';
    const channelName = channel?.name || 'unknown';

    const sendOnce = async (data, isRetry = false) => {
      try {
        await channel.send(data);
        return true;
      } catch (err) {
        // Rate Limit Handling (429)
        if (err.status === 429) {
          // Extract retry-after: Discord.js v13+ puts it on err.retryAfter (ms),
          // v12 puts it on err.headers['retry-after'] (seconds). Default to 5s if unreadable.
          let waitTime = 5000;
          if (typeof err.retryAfter === 'number' && err.retryAfter > 0) {
            waitTime = err.retryAfter;
          } else if (err.headers) {
            // Discord.js v12: headers is an object with a .get() method or direct properties
            const raw = typeof err.headers.get === 'function'
              ? err.headers.get('retry-after')
              : err.headers['retry-after'];
            if (raw) {
              const parsed = parseFloat(raw);
              waitTime = parsed > 0 ? parsed * 1000 : 5000;
            }
          }

          // Detect global vs per-route rate limit
          const isGlobal = err.headers
            ? (typeof err.headers.get === 'function'
                ? err.headers.get('X-RateLimit-Global')
                : err.headers['X-RateLimit-Global'] || err.headers['x-ratelimit-global'])
            : false;
          const scope = isGlobal ? 'GLOBAL' : 'per-route';

          if (!isRetry) {
            Logger.verbose('EloTracker', 1,
              `Discord 429 Rate Limit (${scope}) on #${channelName} (${channelId}). Waiting ${waitTime}ms before retry.`);
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            return sendOnce(data, true);
          }

          // Retry also hit a 429 — the rate limit is still active
          Logger.verbose('EloTracker', 1,
            `Discord 429 Rate Limit (${scope}) on #${channelName} (${channelId}) — retry also failed after ${waitTime}ms wait. Giving up.`);
          throw err;
        }

        throw err;
      }
    };

    // One embed per message, because that is all discord.js v12 will take.
    // Content and files ride on the first; the rest follow in order.
    const sendOnePerMessage = async (data) => {
      const embeds = data.embeds || [];
      const rest = { ...data };
      delete rest.embeds;
      delete rest.embed;

      if (embeds.length === 0) return sendOnce(rest);

      let allSent = true;
      for (let i = 0; i < embeds.length; i++) {
        const part = i === 0 ? { ...rest, embed: embeds[i] } : { embed: embeds[i] };
        try {
          await sendOnce(part);
        } catch (err) {
          // Losing embed 2 is no reason to also lose embed 3.
          allSent = false;
          Logger.verbose('EloTracker', 1, `Discord embed ${i + 1}/${embeds.length} failed on #${channelName} (${channelId}): ${err.message}`);
        }
      }
      return allSent;
    };

    try {
      if (legacyEmbedMode && Array.isArray(payload.embeds)) return await sendOnePerMessage(payload);

      try {
        await sendOnce(payload);
        return true;
      } catch (err) {
        // The v12 tell: it has no `embeds` key, so an embeds-only payload
        // looks empty to it. Discovered rather than version-sniffed.
        const looksLegacy = err.message === 'Cannot send an empty message'
          && Array.isArray(payload.embeds) && payload.embeds.length > 0;
        if (!looksLegacy) throw err;

        legacyEmbedMode = true;
        Logger.verbose('EloTracker', 1, 'discord.js rejected an embeds array; switching to one embed per message for the rest of this process.');
        return await sendOnePerMessage(payload);
      }
    } catch (err) {
      const errMsg = `Discord send failed on #${channelName} (${channelId}): ${err.message}`;
      if (!suppressErrors) throw new Error(errMsg);
      Logger.verbose('EloTracker', 1, errMsg);
      return false;
    }
  },

  buildRoundSummaryEmbed(tracker, data) {
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

    const winnerText = winningTeamID === 1 ? tracker.localize('eloTracker.embeds.team1') : (winningTeamID === 2 ? tracker.localize('eloTracker.embeds.team2') : tracker.localize('eloTracker.embeds.draw'));
    const durationStr = formatDuration(tracker, roundDuration);

    const formatSpread = (spread, teamName) => {
      if (!spread || spread.length === 0) return '';
      const lines = spread.map(m => {
        const deltaSign = m.deltaMu >= 0 ? '+' : '';
        return `${m.label} **${m.name}**: ${deltaSign}${m.deltaMu.toFixed(2)}μ (${m.muBefore.toFixed(1)} → ${m.muAfter.toFixed(1)})`;
      });
      return `**${teamName}**\n${lines.join('\n')}`;
    };

    const spreadText = [
      formatSpread(team1Summary.spreadSnapshot, tracker.localize('eloTracker.embeds.team1')),
      formatSpread(team2Summary.spreadSnapshot, tracker.localize('eloTracker.embeds.team2'))
    ].filter(Boolean).join('\n\n');

    const matchVeterancy = (liveT1.count + liveT2.count) > 0
      ? (liveT1.tierStats.rCount + liveT2.tierStats.rCount) / (liveT1.count + liveT2.count)
      : 0;
    const vUI = getVeterancyUI(tracker, matchVeterancy);

    const muDelta = Math.abs(liveT1.avgMu - liveT2.avgMu);
    const top15Delta = Math.abs(liveT1.top15Mu - liveT2.top15Mu);
    const regDelta = Math.abs(liveT1.tierStats.rCount - liveT2.tierStats.rCount);

    const muLeadTeam = liveT1.avgMu >= liveT2.avgMu ? 1 : 2;
    const top15LeadTeam = liveT1.top15Mu >= liveT2.top15Mu ? 1 : 2;

    const totalRegs = liveT1.tierStats.rCount + liveT2.tierStats.rCount;
    const leadRegs = Math.max(liveT1.tierStats.rCount, liveT2.tierStats.rCount);
    const regShare = totalRegs > 0 ? Math.round((leadRegs / totalRegs) * 100) : 0;
    const t1Share = totalRegs > 0 ? Math.round((liveT1.tierStats.rCount / totalRegs) * 100) : 0;
    const t2Share = totalRegs > 0 ? Math.round((liveT2.tierStats.rCount / totalRegs) * 100) : 0;
    const leadShare = Math.max(t1Share, t2Share);
    const vetAdvText = regDelta === 0
      ? tracker.localize('eloTracker.embeds.tie')
      : tracker.localize('eloTracker.embeds.teamNumberAdvantage', { team: liveT1.tierStats.rCount > liveT2.tierStats.rCount ? 1 : 2 });

    const muAdvText = muDelta === 0 ? tracker.localize('eloTracker.embeds.balanced') : tracker.localize('eloTracker.embeds.teamAdvantage', { muLeadTeam });
    const top15AdvText = top15Delta === 0 ? tracker.localize('eloTracker.embeds.balanced') : tracker.localize('eloTracker.embeds.teamAdvantage2', { top15LeadTeam });

    const formatRatingChanges = (stats) => {
      const muSign = stats.avgDeltaMu >= 0 ? '+' : '';
      // Format Sigma to 2 decimal places as requested
      const muPart = `**${muSign}${stats.avgDeltaMu.toFixed(2)}μ**`;
      const sigmaPart = tracker.localize('eloTracker.embeds.uncertainty', { sigma: stats.avgDeltaSigma.toFixed(2) });
      return `${muPart} ${sigmaPart}`;
    };

    return {
      color: vUI.color,
      title: tracker.localize('eloTracker.embeds.roundEnded'),
      description: tracker.localize('eloTracker.embeds.veterancyPercentageEstablishedRegular', { icon: vUI.icon, label: vUI.label, generateMatrixTable: generateMatrixTable(tracker, liveT1, liveT2) }),
      fields: [
        { name: tracker.localize('eloTracker.embeds.mapLayer'), value: layerName || tracker.localize('eloTracker.embeds.unknownLayer'), inline: true },
        { name: tracker.localize('eloTracker.embeds.fieldWinner'), value: tracker.localize('eloTracker.embeds.winnerTickets', { winnerText, ticketDiff }), inline: true },
        { name: tracker.localize('eloTracker.embeds.fieldDuration'), value: durationStr, inline: true },
        { name: tracker.localize('eloTracker.embeds.playerCount'), value: `${totalPlayerCount}`, inline: true },
        {
          name: tracker.localize('eloTracker.embeds.fieldDisparity'),
          value: [
            tracker.localize('eloTracker.embeds.skillBalanceEloDiff', { eloEmoji: getEloEmoji(muDelta), value: muDelta.toFixed(2), muAdvText }),
            tracker.localize('eloTracker.embeds.top15BalanceElo', { eloEmoji: getEloEmoji(top15Delta), value: top15Delta.toFixed(2), top15AdvText }),
            tracker.localize('eloTracker.embeds.regularBalanceRegDiff', { regEmoji: getRegEmoji(leadShare), regDelta, t1Share, t2Share, vetAdvText })
          ].join('\n'),
          inline: false
        },
        {
          name: tracker.localize('eloTracker.embeds.ratingChanges'),
          value: tracker.localize('eloTracker.embeds.team1Team2', { ratingChanges: formatRatingChanges(team1Summary), ratingChanges2: formatRatingChanges(team2Summary) }),
          inline: false
        },
        { name: tracker.localize('eloTracker.embeds.playersUpdated'), value: playersUpdatedCount.toString(), inline: true },
        { name: tracker.localize('eloTracker.embeds.processingTime'), value: `${calculationDuration}ms`, inline: true },
        { name: tracker.localize('eloTracker.embeds.ratingSpreadRegulars'), value: spreadText || tracker.localize('eloTracker.embeds.noRegularsPlayedRound'), inline: false }
      ],
      timestamp: new Date().toISOString()
    };
  },

  /**
   * @param {?string} otherMatches - Optional "Also matched: …" line from
   *        EloDatabase.formatOtherMatches(), rendered as the embed footer.
   *        Only supplied by the name-lookup path; self-lookups pass nothing
   *        because there is no search term to be ambiguous about.
   */
  buildPlayerStatsEmbed(tracker, player, rank, totalRanked, totalPlayers, provisional = false, localLeaderboard = null, minRounds = 10, otherMatches = null) {
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
    if (sigma <= 2.5) reliability = tracker.localize('eloTracker.embeds.highlyCalibrated');
    else if (sigma <= 4.5) reliability = tracker.localize('eloTracker.embeds.calibrated');
    else if (sigma <= 6.5) reliability = tracker.localize('eloTracker.embeds.establishing');
    else reliability = tracker.localize('eloTracker.embeds.initialCalibration');

    const totalGames = wins + losses;
    const winRateStr = totalGames > 0 ? tracker.localize('eloTracker.embeds.winrateBold', { pct: ((wins / totalGames) * 100).toFixed(1) }) : null;
    const matchHistoryValue = [
      tracker.localize('eloTracker.embeds.winsLosses', { wins, losses }),
      winRateStr
    ].filter(Boolean).join(' (').concat(winRateStr ? ')' : '');

    const totalRankedFmt = totalRanked.toLocaleString();
    const totalPlayersFmt = totalPlayers.toLocaleString();

    const description = provisional
      ? tracker.localize('eloTracker.embeds.provisionalRoundsPlayedRank', { roundsPlayed, minRounds, totalPlayersFmt })
      : (totalRanked > 0 ? tracker.localize('eloTracker.embeds.rankRankedPlayersTotal', { rank, totalRankedFmt, totalPlayersFmt, topPercent }) : tracker.localize('eloTracker.embeds.unranked'));

    const ratingValue = provisional
      ? tracker.localize('eloTracker.embeds.csrCalibrating3', { value: consRating.toFixed(1) })
      : tracker.localize('eloTracker.embeds.csrValue', { value: consRating.toFixed(1) });

    const fields = [
      {
        name: tracker.localize('eloTracker.embeds.csrCompetitiveSkillRank'),
        value: ratingValue,
        inline: false
      },
      {
        name: tracker.localize('eloTracker.embeds.estimatedSkill'),
        value: tracker.localize('eloTracker.embeds.muValue', { value: mu.toFixed(1) }),
        inline: false
      },
      {
        name: tracker.localize('eloTracker.embeds.systemCertainty'),
        value: tracker.localize('eloTracker.embeds.certaintyValue', { reliability, sigma: sigma.toFixed(2) }),
        inline: false
      },
      {
        name: tracker.localize('eloTracker.embeds.matchHistory'),
        value: matchHistoryValue,
        inline: false
      },
      {
        name: tracker.localize('eloTracker.embeds.fieldGlossary'),
        value: tracker.localize('eloTracker.embeds.muEstimatedSkillSigma'),
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
        name: tracker.localize('eloTracker.embeds.localLeaderboard'),
        value: `\`\`\`text\n${localLines.join('\n')}\n\`\`\``,
        inline: false
      });
    }

    return {
      color: 0x3498db,
      title: tracker.localize('eloTracker.embeds.playerStats', { name }),
      description: description,
      fields: fields,
      ...(otherMatches ? { footer: { text: otherMatches } } : {}),
      timestamp: new Date().toISOString()
    };
  },

  buildLeaderboardEmbed(tracker, players, limit, startRank = 1, totalRanked = 0, totalPlayers = 0, targetRank = null) {
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
    const rankRangeText = players.length > 0
      ? tracker.localize('eloTracker.embeds.rankRange', { startRank, endRank })
      : tracker.localize('eloTracker.embeds.rankRangeEmpty');
    const totalRankedFmt = totalRanked.toLocaleString();
    const totalPlayersFmt = totalPlayers.toLocaleString();

    return {
      color: 0xf39c12,
      title: tracker.localize('eloTracker.embeds.leaderboardTitle', { rankRange: rankRangeText }),
      description: tracker.localize('eloTracker.embeds.outRankedPlayersTotal', { totalRankedFmt, totalPlayersFmt, value: lines.join('\n') }),
      timestamp: new Date().toISOString()
    };
  },

  buildClanStatsEmbed(tracker, displayTag, members, rankedCount, totalWins, totalLosses, avgMu, avgSigma, avgCsr, sortedMembers, minRounds = 10) {
    const wr = (totalWins + totalLosses) > 0 ? ((totalWins / (totalWins + totalLosses)) * 100).toFixed(1) : '—';

    // Format roster lines (Top 20)
    const rosterLines = sortedMembers.slice(0, 20).map((p, i) => {
      const pCsr = p.mu - (EloCalculator.SIGMA_MULTIPLIER * p.sigma);
      const prov = p.roundsPlayed < minRounds ? ' [prov]' : '';
      return `${(i + 1).toString().padStart(2)}. ${p.name.padEnd(20)} ${pCsr.toFixed(1).padStart(5)} CSR${prov}`;
    });

    const rosterText = rosterLines.length > 0
      ? `\`\`\`text\n${rosterTextHeader()}\n${rosterLines.join('\n')}\n\`\`\``
      : tracker.localize('eloTracker.embeds.noMembersFound');

    function rosterTextHeader() {
      return tracker.localize('eloTracker.embeds.nameRating') + '-------------------------------';
    }

    return {
      color: 0x3498db,
      title: tracker.localize('eloTracker.embeds.clanStats', { displayTag }),
      fields: [
        { name: tracker.localize('eloTracker.embeds.fieldMembers'), value: tracker.localize('eloTracker.embeds.clanMembersValue', { members: members.length, rankedCount }), inline: true },
        { name: tracker.localize('eloTracker.embeds.fieldWinrate'), value: tracker.localize('eloTracker.embeds.clanWinrateValue', { wr, wins: totalWins, losses: totalLosses }), inline: true },
        { name: tracker.localize('eloTracker.embeds.averageRating'), value: tracker.localize('eloTracker.clanStats.csrAndSpread', { avgCsr: avgCsr?.toFixed(1) ?? 'n/a', avgMu: avgMu.toFixed(1), avgSigma: avgSigma.toFixed(2) }), inline: false },
        { name: tracker.localize('eloTracker.embeds.rosterTop20'), value: rosterText, inline: false }
      ],
      timestamp: new Date().toISOString()
    };
  },

  buildClansLeaderboardEmbed(tracker, clanList, limit, minMembers) {
    const lines = clanList.slice(0, limit).map((c, i) => {
      const rankStr = (i + 1).toString().padStart(2);
      const tagStr = c.displayTag.padEnd(10).substring(0, 10);
      const csrStr = c.avgCsr === -999 ? 'n/a'.padStart(5) : c.avgCsr.toFixed(1).padStart(5);
      const membersStr = `${c.members.length}m`.padStart(4);
      const wrStr = `${c.wr.toFixed(0)}%`.padStart(4);

      return `#${rankStr} ${tagStr} ${csrStr} CSR ${membersStr} ${wrStr}`;
    });

    const header = tracker.localize('eloTracker.embeds.clanTagRatingSize') + '----------------------------------';
    const body = lines.length > 0 ? lines.join('\n') : tracker.localize('eloTracker.embeds.noClansMeetRequirements');

    return {
      color: 0xf1c40f,
      title: tracker.localize('eloTracker.embeds.clanLeaderboardTop', { limit }),
      description: tracker.localize('eloTracker.embeds.rankingClansWithMembers', { minMembers, header, body }),
      timestamp: new Date().toISOString()
    };
  },

  buildAdminConfirmEmbed(tracker, action, detail) {
    return {
      color: 0x9b59b6,
      title: tracker.localize('eloTracker.embeds.adminAction', { action }),
      description: detail,
      timestamp: new Date().toISOString()
    };
  },

  buildErrorEmbed(tracker, context, error) {
    const embed = {
      color: 0xe74c3c,
      title: tracker.localize('eloTracker.embeds.errorTitle', { context }),
      description: `**${error?.message || error}**`,
      timestamp: new Date().toISOString(),
      fields: []
    };

    if (error?.stack) {
      const stack = error.stack.length > 1000 ? error.stack.substring(0, 1000) + '...' : error.stack;
      embed.fields.push({ name: tracker.localize('eloTracker.embeds.stackTrace'), value: `\`\`\`js\n${stack}\n\`\`\``, inline: false });
    }

    return embed;
  },

  buildRoundSkippedEmbed(tracker, reason, playerCount, layerName) {
    return {
      color: 0x95a5a6,
      title: tracker.localize('eloTracker.embeds.eloRatingUpdateSkipped'),
      fields: [
        { name: tracker.localize('eloTracker.embeds.fieldReason'), value: reason, inline: true },
        { name: tracker.localize('eloTracker.embeds.playerCount'), value: playerCount.toString(), inline: true },
        { name: tracker.localize('eloTracker.embeds.fieldLayer'), value: layerName || tracker.localize('eloTracker.embeds.unknownLayer'), inline: true }
      ],
      timestamp: new Date().toISOString()
    };
  },

  buildRoundStartEmbed(tracker, data, type = 'auto') {
    if (data.status === 'warming') {
      return {
        color: 0x3498db,
        title: tracker.localize('eloTracker.embeds.elotrackerSystemInitializing'),
        description: tracker.localize('eloTracker.embeds.systemSynchronizingWithDatabase'),
        timestamp: new Date().toISOString()
      };
    }

    // Handle empty server status
    if (data.status === 'empty' || data.totalPlayerCount === 0) {
      return {
        color: 0x95a5a6,
        title: tracker.localize('eloTracker.embeds.liveRoundInfo'),
        description: tracker.localize('eloTracker.embeds.serverCurrentlyEmptyNo'),
        timestamp: new Date().toISOString()
      };
    }

    const { layerName, t1, t2, muDelta, top15Delta, regDelta, matchVeterancy, roundStartTime, totalPlayerCount } = data;

    const vUI = getVeterancyUI(tracker, matchVeterancy);
    const matrixTable = generateMatrixTable(tracker, t1, t2);

    const muLeadTeam = t1.avgMu >= t2.avgMu ? 1 : 2;
    const top15LeadTeam = t1.top15Mu >= t2.top15Mu ? 1 : 2;

    const totalRegs = t1.tierStats.rCount + t2.tierStats.rCount;
    const leadRegs = Math.max(t1.tierStats.rCount, t2.tierStats.rCount);
    const regShare = totalRegs > 0 ? Math.round((leadRegs / totalRegs) * 100) : 0;
    const t1Share = totalRegs > 0 ? Math.round((t1.tierStats.rCount / totalRegs) * 100) : 0;
    const t2Share = totalRegs > 0 ? Math.round((t2.tierStats.rCount / totalRegs) * 100) : 0;
    const leadShare = Math.max(t1Share, t2Share);
    const vetAdvText = regDelta === 0
      ? tracker.localize('eloTracker.embeds.tie')
      : tracker.localize('eloTracker.embeds.teamNumberAdvantage', { team: t1.tierStats.rCount > t2.tierStats.rCount ? 1 : 2 });

    const muAdvText = muDelta === 0 ? tracker.localize('eloTracker.embeds.balanced') : tracker.localize('eloTracker.embeds.teamAdvantage', { muLeadTeam });
    const top15AdvText = top15Delta === 0 ? tracker.localize('eloTracker.embeds.balanced') : tracker.localize('eloTracker.embeds.teamAdvantage2', { top15LeadTeam });

    const title = type === 'manual'
      ? tracker.localize('eloTracker.embeds.liveRoundInfo2', { layerName })
      : tracker.localize('eloTracker.embeds.roundStarted', { layerName });

    const embed = {
      color: vUI.color,
      title: title,
      description: tracker.localize('eloTracker.embeds.veterancyPercentageEstablishedRegular2', { icon: vUI.icon, label: vUI.label, matrixTable }),
      fields: [
      {
          name: tracker.localize('eloTracker.embeds.matchHealth'),
          value: [
            tracker.localize('eloTracker.embeds.skillBalanceEloDiff', { eloEmoji: getEloEmoji(muDelta), value: muDelta.toFixed(2), muAdvText }),
            tracker.localize('eloTracker.embeds.top15BalanceElo', { eloEmoji: getEloEmoji(top15Delta), value: top15Delta.toFixed(2), top15AdvText }),
            tracker.localize('eloTracker.embeds.regularBalanceRegDiff', { regEmoji: getRegEmoji(leadShare), regDelta, t1Share, t2Share, vetAdvText })
          ].join('\n'),
        inline: false
      },
      { name: tracker.localize('eloTracker.embeds.playerCount'), value: `${totalPlayerCount}`, inline: true }
      ],
      timestamp: new Date().toISOString()
    };

    if (roundStartTime) {
      embed.fields.push({
        name: tracker.localize('eloTracker.embeds.roundStart'),
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
      // Case-insensitive, unlike the plain startsWith('!elo') this replaces:
      // `!Elo` and `!ELO` were silently ignored in Discord, while the same
      // typing works in game (SquadJS lowercases the command before emitting
      // CHAT_COMMAND:*). The trailing (\s|$) also stops unrelated commands that
      // merely begin with the four letters — `!elophant` used to fall through
      // to the name lookup and search for a player called "phant".
      if (!/^!elo(\s|$)/i.test(content)) return;

      const isAdminChannel = this.discordAdminChannel &&
        message.channel.id === this.options.discordAdminChannelID;
      const isPublicChannel = this.discordPublicChannel &&
        message.channel.id === this.options.discordPublicChannelID;

      if (!isAdminChannel && !isPublicChannel) return;

      const rawArgs = content.replace(/^!elo\s*/i, '').trim().split(/\s+/).filter(Boolean);

      // ── Routing gate ──────────────────────────────────────────
      // After the channel gate and before the verb dispatch. Inert on a
      // single-server install, and it strips the selector so the name
      // lookups below never search for a player called `--server`.
      const { scope, selectorRequired } = scopeForEloCommand(rawArgs[0], rawArgs);
      const verdict = (await this.routeDiscordCommand?.({
        scope,
        selectorRequired,
        args: rawArgs,
        messageID: message.id,
        command: `!elo ${rawArgs[0] || ''}`.trim()
      })) ?? { routing: 'act', args: rawArgs };

      if (verdict.routing === 'drop') return;
      if (verdict.routing === 'refuse') {
        await message.channel.send({
          embeds: [this.buildRoutingRefusalEmbed(verdict)]
        });
        return;
      }

      const args = verdict.args;
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
        /**
         * Re-read a backup and import it, announcing both ends.
         *
         * A closure inside the admin gate rather than a module-scope
         * function, and that placement is load-bearing:
         * `make-locale-templates.mjs` classifies a string by the gate it
         * sits behind, and EloTracker's Discord channel is a PUBLIC one
         * with an admin block inside it. Lifted out of this block, three
         * admin-only strings read as player-facing and land in the
         * translation tier that every player sees.
         *
         * @param {string} url
         */
        const runEloRestore = async (url) => {
          try {
            const parsed = await fetchBackupPlayers(url);
            if (parsed.errorKey) {
              await message.reply(tracker.localize(parsed.errorKey));
              return;
            }

            await message.reply(tracker.localize('eloTracker.embeds.restoringPlayersMayTake', { value: parsed.players.length }));
            await this.db.importPlayerStats(parsed.players);
            const doneTitle = tracker.localize('eloTracker.embeds.restoreComplete');
            await EloDiscord.sendDiscordMessage(message.channel, {
              embeds: [EloDiscord.buildAdminConfirmEmbed(
                tracker,
                this.titleWithServer?.(doneTitle) ?? doneTitle,
                tracker.localize('eloTracker.embeds.restoredPlayersFromBackup', { value: parsed.players.length })
              )]
            });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed(tracker, tracker.localize('eloTracker.embeds.restore'), err)] });
          }
        };

        const adminCommands = ['status', 'roundinfo', 'reset', 'backup', 'restore'];
        if (adminCommands.includes(sub) && !hasAdminRole) {
           await message.reply(tracker.localize('eloTracker.embeds.doNotHavePermission'));
           return;
        }

        if (sub === 'status') {
          const sessionCount = this.session.getSessionCount();
          const cacheCount = this.eloCache.size;
          const roundStartStr = this.session.roundStartTime
            ? `<t:${Math.floor(this.session.roundStartTime / 1000)}:R>`
            : tracker.localize('eloTracker.embeds.statusNone');

          const cacheSample = Array.from(this.eloCache.entries())
            .slice(0, 10)
            .map(([id, data]) => {
              const player = this.server.players.find(p => p.eosID === id);
              return `\`${player ? player.name : id}\`: μ ${data.mu.toFixed(2)} σ ${data.sigma.toFixed(2)}`;
            })
            .join('\n');

          const embed = {
            color: 0x3498db,
            title: tracker.localize('eloTracker.embeds.elotrackerStatus'),
            fields: [
              { name: tracker.localize('eloTracker.embeds.fieldVersion'), value: this.constructor.version, inline: true },
              { name: tracker.localize('eloTracker.embeds.fieldReady'), value: this.ready.toString(), inline: true },
              { name: tracker.localize('eloTracker.embeds.sessionPlayers'), value: sessionCount.toString(), inline: true },
              { name: tracker.localize('eloTracker.embeds.eloCacheEntries'), value: cacheCount.toString(), inline: true },
              { name: tracker.localize('eloTracker.embeds.roundStart'), value: roundStartStr, inline: true },
              { name: tracker.localize('eloTracker.embeds.cacheSample10'), value: cacheSample || tracker.localize('eloTracker.embeds.cacheEmpty'), inline: false }
            ],
            timestamp: new Date().toISOString()
          };

          await EloDiscord.sendDiscordMessage(message.channel, { embeds: [embed] });
          return;
        }

        if (sub === 'roundinfo') {
          try {
            const data = this.buildRoundStartData();
            const embed = EloDiscord.buildRoundStartEmbed(tracker, data, 'manual');
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [embed] });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed(tracker, tracker.localize('eloTracker.embeds.roundInfo'), err)] });
          }
          return;
        }

        if (sub === 'reset') {
          const resetArgs = args.slice(1);

          // The token only exists alongside `confirm`, and it is only
          // pulled out of the arguments there. Four hex characters is a
          // perfectly ordinary in-game name — `cafe`, `dead`, `beef` — so
          // stripping the shape unconditionally would make
          // `!elo reset beef` a confirm instead of a player reset.
          const wantsConfirm = resetArgs.some((a) => String(a).toLowerCase() === 'confirm');
          const resetToken = wantsConfirm
            ? (resetArgs.find((a) => /^[0-9a-f]{4}$/.test(String(a).toLowerCase())) ?? null)
            : null;
          const identifier = resetArgs.filter((a) => a !== resetToken).join(' ');

          if (!identifier) {
            const arm = this.armConfirmation?.({
              kind: 'eloReset',
              payload: true,
              command: '!elo reset confirm',
              ttlMs: ELO_RESET_CONFIRM_MS,
              radius: 'community'
            }) ?? { armed: true, lines: [], refusal: null };
            if (!arm.armed) {
              await message.reply(arm.refusal);
              return;
            }
            const warning = tracker.localize('eloTracker.embeds.willWipeAllElo');
            await message.reply(arm.lines.length ? `${warning}\n${arm.lines.join('\n')}` : warning);
            this._resetConfirmPending = { timestamp: Date.now() };
            return;
          }

          // Case-insensitive: `!elo reset Confirm` used to miss this branch and
          // fall through to the single-player reset below, where it searched for
          // a player literally named "Confirm" — leaving the admin thinking the
          // wipe had been declined when it was simply never matched.
          if (identifier.toLowerCase() === 'confirm') {
            const held = this._takeEloReset(resetToken);

            // A token confirm is inspected by every process, so the one
            // that does not hold it must not be the one that answers. The
            // claim inside decides which single process says so when no
            // process holds it at all.
            if (resetToken && !(await (this.claimConfirmReply?.(message.id, held) ?? true))) return;

            if (!held) {
              await message.reply(tracker.localize('eloTracker.embeds.noPendingResetConfirmation'));
              this._resetConfirmPending = null;
              this.cancelConfirmations?.('eloReset');
              return;
            }
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
                const filename = `elo-pre-reset-backup${this.serverFileTag?.() || ''}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
                await message.channel.send({
                  content: tracker.localize('eloTracker.embeds.autoBackupBeforeReset', { value: players.length }),
                  files: [{ attachment: buffer, name: filename }]
                });
              } catch (backupErr) {
                await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed(tracker, tracker.localize('eloTracker.embeds.autoBackupFailed'), backupErr)] });
                await message.reply(tracker.localize('eloTracker.embeds.resetAbortedBecauseAutomatic'));
                return;
              }

              // Both unscoped, and both deliberately. Ratings are
              // community-wide by design — one player, one rating, whichever
              // server they played on — so a reset that spared the neighbour's
              // round history would leave a log of rounds behind ratings that
              // no longer exist. Elo_RoundHistories is server-column scoped,
              // so this is the case where the predicate is the wrong answer
              // rather than a forgotten one.
              const _PlayerStats = this.db.getModel('Elo_PlayerStats');
              const _RoundHistory = this.db.getModel('Elo_RoundHistory');
              if (_PlayerStats) await _PlayerStats.destroy({ where: {} });
              if (_RoundHistory) await _RoundHistory.destroy({ where: {} });
              this.eloCache.clear();
              const doneTitle = tracker.localize('eloTracker.embeds.eloReset');
              await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildAdminConfirmEmbed(tracker, this.titleWithServer?.(doneTitle) ?? doneTitle, tracker.localize('eloTracker.embeds.allRatingsRoundHistory'))] });
            } catch (err) {
              await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed(tracker, tracker.localize('eloTracker.embeds.eloReset'), err)] });
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
            // Same strict gate as the in-game !eloadmin reset: destructive and
            // irreversible, so anything short of an unambiguous match reports
            // the candidates instead of resetting whichever one ranked highest.
            const candidates = await this._findPlayerCandidates(identifier);
            const player = candidates.length ? candidates[0] : null;
            if (!player) {
              await message.reply(tracker.localize('eloTracker.embeds.noPlayerFound', { identifier }));
              return;
            }
            if (!EloDatabase.isUnambiguous(candidates)) {
              const names = candidates.slice(0, 5)
                .map((p) => `${String(p.name || '?').trim()} (${p.roundsPlayed || 0} rds)`);
              await message.reply([
                tracker.localize('eloTracker.embeds.ambiguousNotExactMatch', { identifier }),
                tracker.localize('eloTracker.onDiscordMessage.matchedNames', { names: names.join(', ') }),
                tracker.localize('eloTracker.embeds.reRunWithFull')
              ].join('\n'));
              return;
            }
            await this.db.upsertPlayerStats(player.eosID, defaults);
            if (this.eloCache.has(player.eosID)) {
              this.eloCache.set(player.eosID, { mu: defaults.mu, sigma: defaults.sigma });
            }
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildAdminConfirmEmbed(tracker, tracker.localize('eloTracker.embeds.playerReset'), tracker.localize('eloTracker.embeds.resetDefaultRating', { name: player.name }))] });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed(tracker, tracker.localize('eloTracker.embeds.playerReset'), err)] });
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
            const filename = `elo-backup${this.serverFileTag?.() || ''}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            await message.channel.send({
              content: tracker.localize('eloTracker.embeds.eloBackupPlayers', { value: players.length }),
              files: [{ attachment: buffer, name: filename }]
            });
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed(tracker, tracker.localize('eloTracker.embeds.backup'), err)] });
          }
          return;
        }

        if (sub === 'restore') {
          // ── The confirm half ────────────────────────────────────
          // Only on a multi-server install, and only there. A community
          // of one restores exactly the way it always has: attach the
          // file, and the import runs.
          const restoreArgs = args.slice(1);
          const wantsConfirm = restoreArgs.some((a) => String(a).toLowerCase() === 'confirm');
          const restoreToken = wantsConfirm
            ? (restoreArgs.find((a) => /^[0-9a-f]{4}$/.test(String(a).toLowerCase())) ?? null)
            : null;

          if (wantsConfirm && this.isMultiServer?.()) {
            const taken = this.takeConfirmation('eloRestore', restoreToken);
            const held = taken.status === 'ok';
            if (restoreToken && !(await this.claimConfirmReply(message.id, held))) return;
            if (!held) {
              await message.reply(tracker.localize('eloTracker.embeds.noPendingRestoreConfirmation'));
              return;
            }
            await runEloRestore(taken.payload);
            return;
          }

          if (!message.attachments.size) {
            await message.reply(tracker.localize('eloTracker.embeds.pleaseAttachBackupJson'));
            return;
          }

          const attachment = message.attachments.first();

          // Validated before the arm, not after the confirm. An admin who
          // is told to type a token has been told the file is good, and
          // discovering at confirm time that it never parsed would spend
          // the confirmation on nothing.
          let parsed;
          try {
            parsed = await fetchBackupPlayers(attachment.url);
          } catch (err) {
            await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed(tracker, tracker.localize('eloTracker.embeds.restore'), err)] });
            return;
          }
          if (parsed.errorKey) {
            await message.reply(tracker.localize(parsed.errorKey));
            return;
          }

          const arm = this.armConfirmation?.({
            kind: 'eloRestore',
            payload: attachment.url,
            command: '!elo restore confirm',
            radius: 'community'
          }) ?? { armed: true, lines: [], refusal: null };

          if (!arm.armed) {
            await message.reply(arm.refusal);
            return;
          }

          // No lines is the single-server install, where nothing changed.
          if (arm.lines.length === 0) {
            await runEloRestore(attachment.url);
            return;
          }

          await message.reply(
            `${tracker.localize('eloTracker.embeds.restoreWillOverwrite', { value: parsed.players.length })}\n${arm.lines.join('\n')}`
          );
          return;
        }
      }

      // --- Public commands (available in both channels) ---
      if (sub === 'link') {
        const steamID = args[1];

        if (!steamID || !/^\d{17}$/.test(steamID)) {
          const replyMsg = await message.reply(tracker.localize('eloTracker.embeds.invalidSteamidPleaseProvide'));
          setTimeout(() => {
            message.delete().catch(() => {});
            replyMsg.delete().catch(() => {});
          }, 5000);
          return;
        }

        try {
          const player = await this.db.getModel('Elo_PlayerStats')?.findOne({ where: { steamID } });

          if (!player) {
            const replyMsg = await message.reply(tracker.localize('eloTracker.embeds.noEloRecordFound'));
            setTimeout(() => {
              message.delete().catch(() => {});
              replyMsg.delete().catch(() => {});
            }, 5000);
            return;
          }

          await player.update({ discordID: message.author.id });

          await EloDiscord.sendDiscordMessage(message.channel, {
            embeds: [EloDiscord.buildAdminConfirmEmbed(tracker, tracker.localize('eloTracker.embeds.accountLinked'), tracker.localize('eloTracker.embeds.discordAccountNowSuccessfully', { name: player.name }))]
          });
          message.delete().catch(() => {});
        } catch (err) {
          await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed(tracker, tracker.localize('eloTracker.embeds.accountLink'), err)] });
        }
        return;
      }

      if (sub === 'explain') {
        const initialMu = EloCalculator.MU_DEFAULT;
        const initialSigma = EloCalculator.SIGMA_DEFAULT;
        const explainEmbed = {
          color: 0x3498db,
          title: tracker.localize('eloTracker.embeds.howEloSystemWorks'),
          description: tracker.localize('eloTracker.embeds.serverUsesSystemBased'),
          fields: [
            {
              name: tracker.localize('eloTracker.embeds.trueskillAlgorithm'),
              value: tracker.localize('eloTracker.embeds.ratingSystemUsedBy')
            },
            {
              name: tracker.localize('eloTracker.embeds.csrCompetitiveSkillRank'),
              value: tracker.localize('eloTracker.embeds.officialLeaderboardScoreCalculated')
            },
            {
              name: tracker.localize('eloTracker.embeds.estimatedSkillMu'),
              value: tracker.localize('eloTracker.embeds.estimatedPerformanceLevelEveryone', { value: initialMu.toFixed(2) })
            },
            {
              name: tracker.localize('eloTracker.embeds.systemCertaintySigma'),
              value: tracker.localize('eloTracker.embeds.systemSConfidenceRank', { value: initialSigma.toFixed(2) })
            },
            {
              name: tracker.localize('eloTracker.embeds.calibrationGoal'),
              value: tracker.localize('eloTracker.embeds.onceSigmaDropsBelow')
            }
          ]
        };
        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [explainEmbed] });
        return;
      }

      if (sub === 'help') {
        const embed = {
          color: 0x3498db,
          title: tracker.localize('eloTracker.embeds.elotrackerCommandReference'),
          fields: [
            {
              name: tracker.localize('eloTracker.embeds.publicCommands'),
              value: [
                tracker.localize('eloTracker.embeds.eloEloMeLook'),
                tracker.localize('eloTracker.embeds.eloNameSteamidEosid'),
                tracker.localize('eloTracker.embeds.eloLinkSteamidLink'),
                tracker.localize('eloTracker.embeds.eloLeaderboardRankShow'),
                tracker.localize('eloTracker.embeds.eloClansShowTop'),
                tracker.localize('eloTracker.embeds.eloClanTagShow'),
                tracker.localize('eloTracker.embeds.eloExplainExplainsRanking'),
                tracker.localize('eloTracker.embeds.eloHelpShowMessage')
              ].join('\n'),
              inline: false
            },
            ...(isAdminChannel ? [{
              name: tracker.localize('eloTracker.embeds.adminCommandsAdminChannel'),
              value: [
                tracker.localize('eloTracker.embeds.eloStatusPluginStatus'),
                tracker.localize('eloTracker.embeds.eloRoundinfoLiveRound'),
                tracker.localize('eloTracker.embeds.eloClansNAll'),
                tracker.localize('eloTracker.embeds.eloResetWipeAll'),
                tracker.localize('eloTracker.embeds.eloResetConfirmConfirm'),
                tracker.localize('eloTracker.embeds.eloResetIdentifierReset'),
                tracker.localize('eloTracker.embeds.eloBackupExportAll'),
                tracker.localize('eloTracker.embeds.eloRestoreRestoreFrom')
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
        try {
          const player = await this.db.getModel('Elo_PlayerStats')?.findOne({ where: { discordID: message.author.id } });
          if (!player) {
            await message.reply(tracker.localize('eloTracker.embeds.noLinkedEloRecord'));
            return;
          }

          const minRounds = this.leaderboardMinRounds();
          const provisional = player.roundsPlayed < minRounds;
          const rank = provisional ? null : await this.db.getPlayerRank(player.eosID, minRounds);
          const totalRanked = await this.db.getTotalRankedPlayers(minRounds);
          const totalPlayers = await this.db.getTotalPlayers();

          let localLeaderboard = null;
          if (!provisional && rank !== null) {
            const limit = 9;
            const offset = Math.max(0, rank - 5);
            const neighborhood = await this.db.getLeaderboard(limit, minRounds, offset);
            localLeaderboard = neighborhood.map((p, i) => ({ ...p, actualRank: offset + 1 + i }));
          }

          await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildPlayerStatsEmbed(tracker, player, rank, totalRanked, totalPlayers, provisional, localLeaderboard, minRounds)] });
        } catch (err) {
          await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildErrorEmbed(tracker, tracker.localize('eloTracker.embeds.eloLookup'), err)] });
        }
        return;
      }

      if (sub === 'leaderboard') {
        const minRounds = this.leaderboardMinRounds();
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
        await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildLeaderboardEmbed(tracker, players, limit, startRank, totalRanked, totalPlayers, displayTargetRank)] });
        return;
      }

      if (sub === 'clan') {
        const query = args.slice(1).join(' ');
        if (!query) {
          await message.reply(tracker.localize('eloTracker.embeds.pleaseSpecifyClanTag'));
          return;
        }

        const searchNorm = this._normalizeTag(query);
        if (!searchNorm) {
          await message.reply(tracker.localize('eloTracker.embeds.invalidClanTagQuery'));
          return;
        }

        const allPlayers = await this.db.exportPlayerStats();
        const members = allPlayers.filter(p => this._normalizeTag(this._extractRawPrefix(p.name)) === searchNorm);

        if (members.length === 0) {
          await message.reply(tracker.localize('eloTracker.embeds.noPlayersFoundWith', { query }));
          return;
        }

        const minRounds = this.leaderboardMinRounds();
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
          embeds: [EloDiscord.buildClanStatsEmbed(tracker, displayTag, members, rankedCount, totalWins, totalLosses, avgMu, avgSigma, avgCsr, sortedMembers, minRounds)]
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
        const minRounds = this.leaderboardMinRounds();
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
          embeds: [EloDiscord.buildClansLeaderboardEmbed(tracker, clanList, limit, minMembers)]
        });
        return;
      }

      // !elo <identifier> — look up another player
      // Ranked candidates: [0] is displayed, the rest become the embed footer
      // so an ambiguous partial name shows what else it could have matched.
      const identifier = args.join(' ');
      const candidates = await this._findPlayerCandidates(identifier);
      const player = candidates.length ? candidates[0] : null;
      if (!player) {
        await message.reply(tracker.localize('eloTracker.embeds.noEloRecordFound2', { identifier }));
        return;
      }

      const minRounds = this.leaderboardMinRounds();
      const provisional = player.roundsPlayed < minRounds;
      const rank = provisional ? null : await this.db.getPlayerRank(player.eosID, minRounds);
      const totalRanked = await this.db.getTotalRankedPlayers(minRounds);
      const totalPlayers = await this.db.getTotalPlayers();

      let localLeaderboard = null;
      if (!provisional && rank !== null) {
        const limit = 9;
        const offset = Math.max(0, rank - 5);
        const neighborhood = await this.db.getLeaderboard(limit, minRounds, offset);
        localLeaderboard = neighborhood.map((p, i) => ({ ...p, actualRank: offset + 1 + i }));
      }

      // null unless the search term was an inexact match with runners-up.
      const otherMatches = EloDatabase.formatOtherMatches(candidates);

      await EloDiscord.sendDiscordMessage(message.channel, { embeds: [EloDiscord.buildPlayerStatsEmbed(tracker, player, rank, totalRanked, totalPlayers, provisional, localLeaderboard, minRounds, otherMatches)] });
    };

    /**
     * eosIDs + steamIDs of everyone currently on the server, as a Set.
     *
     * Handed to the ranked search as an intra-tier tiebreak: when two stored
     * accounts match a partial name equally well, the one actually in the
     * match is nearly always the one being asked about. Returns an empty Set
     * when S³ is unavailable or not ready — the search then falls back to
     * roundsPlayed/lastSeen ordering, which is still deterministic.
     */
    tracker._getOnlinePlayerIDs = function() {
      try {
        const players = this._s3?.players;
        if (!players?.isReady?.()) return new Set();
        const ids = new Set();
        for (const p of players.getAllPlayers()) {
          if (p?.eosID) ids.add(p.eosID);
          if (p?.steamID) ids.add(p.steamID);
        }
        return ids;
      } catch (err) {
        Logger.verbose('EloTracker', 1, `[EloDiscord] Online player lookup failed: ${err.message}`);
        return new Set();
      }
    };

    /**
     * Ranked candidate list for a search term, best match first.
     * Shared by every lookup path (in-game !elo, Discord !elo, admin reset)
     * so all three resolve names identically.
     *
     * @param {string} identifier
     * @returns {Promise<Array<Object>>} Ranked rows, each with `_matchTier`.
     */
    tracker._findPlayerCandidates = async function(identifier) {
      return await this.db.searchPlayers(identifier, { onlineIDs: this._getOnlinePlayerIDs() });
    };

    /**
     * Best single match for a search term, or null.
     * @param {string} identifier
     * @returns {Promise<Object|null>}
     */
    tracker._findPlayerByIdentifier = async function(identifier) {
      const candidates = await this._findPlayerCandidates(identifier);
      return candidates.length ? candidates[0] : null;
    };
  }
}
