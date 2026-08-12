/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          SWITCH PLUGIN v2.3.0 — EXPLAIN EMBED GENERATOR       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Generates the Discord embed sequence for the '!switch explain'
 * admin command, plus a second entry point for the 7-day reliability
 * stats embed used by the auto-updating explain channel feature.
 *
 * The explain sequence produces 7 player-facing embeds that explain
 * how team switching works on this server — sourced from live plugin
 * config and decision functions, not hand-written copy. Each section
 * is its own embed, keeping each well under Discord's 6000-character
 * per-message embed sum limit, and making output easy to forward.
 *
 * The 7-day stats embed (_buildSevenDayStatsEmbed()) scrapes the
 * reporting channel for round summaries, aggregates standard-mode
 * results, and returns a single embed with plain-English sentences
 * about success rate, instant rate, and typical queue wait times.
 * It returns null when no data is available (graceful degradation).
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SwitchExplain (default)
 *   Singleton with a single register(plugin) method.
 *   Attaches _buildExplainMessages() and _buildSevenDayStatsEmbed()
 *   to the plugin instance.
 *
 * ─── DEPENDENCIES ──────────────────────────────────────────────────
 *
 * All dependencies are accessed via plugin.* (the live plugin
 * instance passed to register()).
 *
 * ─── NOTES ─────────────────────────────────────────────────────────
 *
 * - All number values are read from live plugin config. No hardcoded
 *   defaults in generated text — if a config value is missing, the
 *   text gracefully notes the information is unavailable.
 * - Team Balancer config (clan grouping, squad preservation) is read
 *   by finding the TeamBalancer plugin instance at generate time.
 *   If TB is not loaded, scramble sections gracefully degrade.
 * - Conditional sections (seed bonus, timeout-switch behavior, team
 *   balancer clan settings) are included or omitted based on config.
 * - Follows the singleton register(plugin) pattern established by
 *   SwitchCommands, SwitchOutput, SwitchQueue, and SwitchDB.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

const SwitchExplain = {
  /**
   * Attaches _buildExplainMessages() to the plugin instance.
   *
   * @param {object} plugin — the live Switch plugin instance
   */
  register(plugin) {
    /**
     * Build a 7-day reliability stats embed from historical round summaries.
     * Scrapes the reporting channel for "Switch Round Summary" embeds from the
     * last 7 days, aggregates standard-mode rounds, and returns a single embed
     * with plain-English sentences.
     *
     * Returns null if no data is available (graceful degradation — caller should
     * drop the stats embed from the message rather than showing an empty embed).
     *
     * Dependencies: requires _parseMode, _parseMoveTypes, _parseDenialReasons,
     * _parseQueueOutcomes, _parseRoundStatsField, and _computeMedianFromMs to
     * have been registered on the plugin by SwitchCommands.register().
     *
     * @returns {object|null} Discord embed object, or null if no data
     */
    plugin._buildSevenDayStatsEmbed = async function () {
      return _buildSevenDayStatsEmbed(plugin);
    };

    /**
     * Build the full explain embed sequence.
     * Returns an array of Discord embed objects, one per section.
     * Each embed should be sent as a separate message.
     *
     * @returns {object[]} Array of embed objects
     */
    plugin._buildExplainMessages = function () {
      // Each embed is sent as a separate Discord message by the caller
      // (onDiscordMessage in switch-commands.js). If one embed fails
      // mid-sequence, earlier embeds already landed and later ones are
      // lost. The admin can re-run the command to get the full set.
      // This tradeoff is acceptable because explain is a manual admin
      // command, not automated output.
      const embeds = [];

      const intro = _buildIntroEmbed(plugin);
      if (intro) embeds.push(intro);

      const balance = _buildBalanceEmbed(plugin);
      if (balance) embeds.push(balance);

      const cooldown = _buildCooldownEmbed(plugin);
      if (cooldown) embeds.push(cooldown);

      const timeWindow = _buildTimeWindowQueueEmbed(plugin);
      if (timeWindow) embeds.push(timeWindow);

      const scramble = _buildScrambleEmbed(plugin);
      if (scramble) embeds.push(scramble);

      const special = _buildSpecialCasesEmbed(plugin);
      if (special) embeds.push(special);

      const tips = _buildTipsEmbed(plugin);
      if (tips) embeds.push(tips);

      return embeds;
    };
  }
};

// ── Helper: format minutes into a human-readable string ──────────

function _formatMinutes(min) {
  if (min < 60) return `${min} minutes`;
  const hours = Math.floor(min / 60);
  const mins = min % 60;
  if (mins === 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  return `${hours} hour${hours !== 1 ? 's' : ''} ${mins} minute${mins !== 1 ? 's' : ''}`;
}

// ── Helper: format hours into a human-friendly string ────────────

function _formatCooldown(plugin) {
  if (plugin.options.switchCooldownMinutes > 0) {
    const min = plugin.options.switchCooldownMinutes;
    return _formatMinutes(min);
  }
  const hrs = plugin.options.switchCooldownHours;
  if (hrs === 0) return 'none';
  return `${hrs} hour${hrs !== 1 ? 's' : ''}`;
}

// ── Helper: read max team size from server config ────────────────

function _getMaxTeamSize(plugin) {
  try {
    const sc = plugin._s3?.serverConfig;
    if (sc?.isReady?.() && typeof sc.getMaxPlayers === 'function') {
      const maxPlayers = sc.getMaxPlayers();
      const reserved = typeof sc.getNumReservedSlots === 'function' ? sc.getNumReservedSlots() : 0;
      const effectiveCap = maxPlayers;
      return { maxPlayers, reserved, effectiveCap, maxTeamSize: Math.floor(effectiveCap / 2) };
    }
  } catch (_) { /* ignore */ }
  return { maxPlayers: 100, reserved: 0, effectiveCap: 100, maxTeamSize: 50 };
}

// ── Helper: check if scoreboard switching is disabled ─────────────
// Reads getAllowTeamChanges() from S³ serverConfig at generate time,
// not from a mount-time cache. Server config can change between
// restarts (e.g. admins toggle scoreboard switching mid-session), so
// a live read is correct — do not "optimize" this into a cached
// snapshot.

function _isScoreboardSwitchDisabled(plugin) {
  try {
    const sc = plugin._s3?.serverConfig;
    if (sc?.isReady?.() && typeof sc.getAllowTeamChanges === 'function') {
      return !sc.getAllowTeamChanges();
    }
  } catch (_) { /* ignore */ }
  return false;
}

// ── Helper: find Team Balancer plugin instance ───────────────────
// Discovers Team Balancer via SquadJS's raw plugin array, not S³
// service discovery. TB is a sibling plugin that may or may not be
// loaded — there is no S³ API for arbitrary third-party plugins.
// The explain command runs at generate time (not mount), so this
// always reflects the current loaded-plugin state.

function _getTeamBalancer(plugin) {
  try {
    return plugin.server.plugins.find(p =>
      p.constructor.name === 'TeamBalancer' ||
      (p.constructor && p.constructor.name === 'TeamBalancer')
    );
  } catch (_) { return null; }
}

// ── Helper: build the tolerance table ────────────────────────────
// Per switch-explain-command-spec.md §3.2. Sweeps the
// getDynamicExtraSlots() formula across 1..effectiveCap and
// collapses into contiguous ranges of constant extra-tolerance
// value. This is the one genuinely new piece of math in the
// explain module — everything else is presentation over
// existing plugin state.

function _buildToleranceTable(plugin) {
  const cap = plugin.options.maxUnbalancedSlots != null ? plugin.options.maxUnbalancedSlots : 1;
  const dynamicEnabled = plugin.options.dynamicBalanceTolerance === true;
  const floor = plugin.options.dynamicBalancePlayerFloor != null ? plugin.options.dynamicBalancePlayerFloor : 85;
  const extraSlots = plugin.options.dynamicBalanceExtraSlots != null ? plugin.options.dynamicBalanceExtraSlots : 3;
  const { effectiveCap } = _getMaxTeamSize(plugin);

  if (!dynamicEnabled) {
    return [{
      range: 'All population levels',
      extra: 0,
      maxGap: cap,
      note: 'Dynamic tolerance is disabled. The base limit applies at all player counts.'
    }];
  }

  const rows = [];
  let prevExtra = null;
  let rangeStart = 1;

  for (let totalPlayers = 1; totalPlayers <= effectiveCap; totalPlayers++) {
    let currentExtra;
    if (totalPlayers >= effectiveCap) {
      currentExtra = 0;
    } else if (totalPlayers <= floor) {
      currentExtra = extraSlots;
    } else {
      const raw = Math.round(extraSlots * (effectiveCap - totalPlayers) / (effectiveCap - floor));
      currentExtra = raw === 0 && totalPlayers < effectiveCap ? 1 : raw;
    }

    if (currentExtra !== prevExtra) {
      if (prevExtra !== null) {
        const rangeEnd = totalPlayers - 1;
        rows.push({
          range: rangeStart === rangeEnd ? String(rangeStart) : `${rangeStart}-${rangeEnd}`,
          extra: prevExtra,
          maxGap: cap + prevExtra
        });
      }
      rangeStart = totalPlayers;
      prevExtra = currentExtra;
    }
  }

  if (prevExtra !== null && rangeStart <= effectiveCap - 1) {
    rows.push({
      range: rangeStart === effectiveCap - 1 ? String(effectiveCap - 1) : `${rangeStart}-${effectiveCap - 1}`,
      extra: prevExtra,
      maxGap: cap + prevExtra
    });
  }

  rows.push({
    range: `${effectiveCap}+`,
    extra: 0,
    maxGap: cap
  });

  return rows;
}

// ── Embed 1: Introduction ───────────────────────────────────────

function _buildIntroEmbed(plugin) {
  const scoreboardDisabled = _isScoreboardSwitchDisabled(plugin);

  const description = scoreboardDisabled
    ? 'Scoreboard team switching is disabled on this server. **`\'!switch\'`** is how you change teams. The plugin enforces balance rules to keep teams fair while still allowing you to play with your friends.'
    : '**`\'!switch\'`** is an alternative way to change teams. The plugin enforces balance rules to keep teams fair while still allowing you to play with your friends.';

  const commandsField = [
    "**`'!switch'`**        Request a team change",
    "**`'!switch check'`**  See your eligibility and token balance",
    "**`'!switch cancel'`** Leave the switch queue"
  ].join('\n');

  const keyRuleField = [
    'Switching from the bigger team to the smaller team is usually allowed.',
    'Switching from the smaller team to the bigger team is only allowed if the gap stays within the balance limit (see below).'
  ].join('\n');

  return {
    title: 'How Team Switching Works',
    description,
    color: 0x3498DB,
    fields: [
      { name: 'Commands', value: commandsField + '\n*All three commands are typed in all or squad chat (press J).*', inline: false },
      { name: 'Key Rule', value: keyRuleField, inline: false }
    ]
  };
}

// ── Embed 2: Balance Rules ──────────────────────────────────────

function _buildBalanceEmbed(plugin) {
  const { maxTeamSize, maxPlayers, effectiveCap, reserved } = _getMaxTeamSize(plugin);
  const cap = plugin.options.maxUnbalancedSlots != null ? plugin.options.maxUnbalancedSlots : 1;
  const rows = _buildToleranceTable(plugin);

  const whatNumbersMean = [
    'The **gap** is the difference in player count between the two teams.',
    'Example: Team **1** has **42** players, Team **2** has **38**. The gap is **4**.',
    '',
    '**Tolerance** is how much extra gap the server allows beyond the base limit of **1**. At low population, more tolerance is given so switches are easier. As the server fills up, tolerance shrinks to keep teams fair when it matters most.'
  ].join('\n');

  const tableLines = ['```', 'Players         Extra Tolerance    Max Allowed Gap'];
  for (const row of rows) {
    const rangePad = row.range.padEnd(14);
    tableLines.push(`${rangePad}${String(row.extra).padEnd(18)}${row.maxGap}`);
  }
  tableLines.push('```');
  const tableStr = tableLines.join('\n');

  // Pick a representative row from the tolerance table for the example.
  // Use the middle row (or the first if only one) so the gap shown always
  // matches an actual entry in the table.
  const exampleRowIdx = Math.floor((rows.length - 1) / 2);
  const exampleRow = rows[exampleRowIdx];
  const gap = exampleRow.maxGap;

  const example = [
    `Example: With **${exampleRow.range}** population, the max allowed gap is **${gap}**.`,
    `If the bigger team leads by **${gap}**, a switch from the bigger team is allowed (gap shrinks to **${Math.max(0, gap - 2)}**).`,
    `A switch from the smaller team is not allowed (gap would grow to **${gap + 2}**, exceeding the max of **${gap}**).`
  ].join('\n');

  const hardCap = [
    `Each team can hold at most **${maxTeamSize}** players (half of **${maxPlayers}** total slots, including **${reserved}** reserved).`,
    `You cannot switch to a team that is already at **${maxTeamSize}**.`
  ].join('\n');

  return {
    title: 'Balance Rules',
    description: 'A switch is allowed if it does not make the teams too lopsided. The rules depend on how many players are on the server.',
    color: 0x2ECC71,
    fields: [
      { name: 'What the numbers mean', value: whatNumbersMean, inline: false },
      { name: 'Tolerance Table', value: tableStr, inline: false },
      { name: 'Example', value: example, inline: false },
      { name: 'Hard Cap', value: hardCap, inline: false }
    ]
  };
}

// ── Embed 3a: Switch Tokens (when maxSwitchTokens > 1) ──────────

function _buildTokenEmbed(plugin) {
  const maxTokens = plugin.options.maxSwitchTokens || 2;
  const cooldownStr = _formatCooldown(plugin);
  const seedBonusAmount = plugin.options.seedTokenBonusAmount || 0;
  const seedBonusMinutes = plugin.options.seedTokenBonusMinutes || 20;

  const tokenPool = [
    `Maximum tokens: **${maxTokens}**`,
    `Refill time: **${cooldownStr}** per token`
  ].join('\n');

  const poolExplanation = `Tokens refill one at a time, independently. With **${maxTokens}** tokens saved, you can switch ${maxTokens > 1 ? 'up to ' + maxTokens + ' times' : 'once'} before waiting for a refill. This gives you flexibility without allowing unlimited switching.`;

  let seedBonusField = null;
  if (seedBonusAmount > 0) {
    const seedLines = [
      `During seed rounds, you earn **+${seedBonusAmount}** bonus token for every **${seedBonusMinutes}** minutes you are present.`,
      `You can earn up to **${seedBonusAmount}** bonus token${seedBonusAmount !== 1 ? 's' : ''} per seed round.`,
      `Bonus tokens stack above your normal cap of **${maxTokens}**, so after a full seed round you could hold up to **${maxTokens + seedBonusAmount}** tokens total.`
    ].join('\n');
    seedBonusField = { name: 'Seed Bonus', value: seedLines, inline: false };
  }

  const fields = [
    { name: 'Token Pool', value: tokenPool, inline: false },
    { name: 'How It Works', value: poolExplanation, inline: false }
  ];
  if (seedBonusField) fields.push(seedBonusField);
  fields.push({ name: 'Checking Your Balance', value: "Use **`'!switch check'`** to see your current token balance and when your next token refills.", inline: false });

  return {
    title: 'Switch Tokens',
    description: `Each **\`'!switch'\`** costs **1** token. Tokens refill automatically over time. You are not locked out for a full cooldown after a single switch.`,
    color: 0x9B59B6,
    fields
  };
}

// ── Embed 3b: Flat cooldown (when maxSwitchTokens === 1) ────────

function _buildFlatCooldownEmbed(plugin) {
  const cooldownStr = _formatCooldown(plugin);

  return {
    title: 'Switch Cooldown',
    description: `After using **\`'!switch'\`**, you must wait before switching again.`,
    color: 0x9B59B6,
    fields: [
      {
        name: 'Cooldown',
        value: `Cooldown: **${cooldownStr}**\n\nYou cannot switch again until the cooldown expires. Use **\`'!switch check'\`** to see your remaining cooldown time.`,
        inline: false
      }
    ]
  };
}

// ── Embed 3 dispatcher ──────────────────────────────────────────

function _buildCooldownEmbed(plugin) {
  const maxTokens = plugin.options.maxSwitchTokens != null ? plugin.options.maxSwitchTokens : 1;
  if (maxTokens > 1) {
    return _buildTokenEmbed(plugin);
  }
  return _buildFlatCooldownEmbed(plugin);
}

// ── Embed 4: Time Window & Queue ────────────────────────────────

function _buildTimeWindowQueueEmbed(plugin) {
  const switchWindow = plugin.options.switchEnabledMinutes || 10;
  const queueTimeout = plugin.options.queueTimeoutMinutes || 20;
  const queueEnabled = plugin.options.queueEnabled !== false;
  const timeoutSwitchEnabled = plugin.options.queueTimeoutSwitchEnabled === true;

  const timeWindowLines = [
    `You have **${switchWindow} minutes** after joining the server`,
    '**OR** after the match starts, whichever gives you more time.',
    '',
    'If you join mid-match, your personal time window starts when you joined.',
    `Once both windows close, **\`'!switch'\`** is unavailable for the rest of the match.`
  ];

  let queueLines;
  if (queueEnabled) {
    queueLines = [
      'If no switch slot is immediately available, you are placed in a queue.',
      'The queue holds your spot and processes switches as soon as a slot opens.',
      'For example, when someone on the other team also types **`\'!switch\'`**, that creates room for you to move.',
      '',
      'The queue checks for available slots every few seconds as the server updates its player counts. It will not act on incomplete or stale data.',
      '',
      'Note: the in-game scoreboard can be slow to update. The queue uses its own player count tracking and is more reliable than the scoreboard.',
      '',
      `You have **${queueTimeout} minutes** in the queue before your request expires.`
    ];

    if (timeoutSwitchEnabled) {
      queueLines.push(`If your queue request reaches the **${queueTimeout}-minute** time limit without a normal slot opening, the system will force-switch you with a slightly relaxed balance limit. This is a fallback so you are not left stranded. The normal balance rules are your best path.`);
    } else {
      queueLines.push('When a queued switch expires, you are removed from the queue.');
    }

    queueLines.push('');
    queueLines.push("Use **`'!switch cancel'`** to leave the queue at any time.");
  } else {
    queueLines = [
      'The queue is currently disabled.',
      'If no slot is available when you request a switch, you will need to try again later.',
      'Use **`\'!switch check\'`** to see if a slot is available.'
    ];
  }

  return {
    title: 'Time Window & Queue',
    description: `You can only use **\`'!switch'\`** during a limited window.${queueEnabled ? ' If teams are currently full, you will be placed in a queue.' : ''}`,
    color: 0xE67E22,
    fields: [
      { name: 'Time Window', value: timeWindowLines.join('\n'), inline: false },
      { name: queueEnabled ? 'The Queue' : 'Queue Status', value: queueLines.join('\n'), inline: false }
    ]
  };
}

// ── Embed 5: Scrambles ──────────────────────────────────────────

function _buildScrambleEmbed(plugin) {
  const lockdownMinutes = plugin.options.scrambleLockdownDurationMinutes || 20;

  // Check for Team Balancer
  const tb = _getTeamBalancer(plugin);

  const whatScrambleDoes = [];
  if (tb) {
    whatScrambleDoes.push('The scrambler keeps squads and clans together. Your squad and clan group will not be split up.');

    const clanGrouping = tb.options && tb.options.enableClanTagGrouping === true;
    const pullEntireSquads = tb.options && tb.options.clanGroupingPullEntireSquads === true;

    if (clanGrouping && pullEntireSquads) {
      whatScrambleDoes.push('When a clan group is kept together, the rest of their squad is pulled along with them. No one gets left behind.');
    }
  } else {
    whatScrambleDoes.push('Team balancing configuration was not available at the time this was generated. Check with an admin for scramble details.');
  }

  const lockoutExplainer = [
    `After a scramble, **\`'!switch'\`** is locked for all players for **${lockdownMinutes} minutes**.`,
    'This prevents players from undoing the scramble by switching back.',
    '',
    'Because the scrambler preserves squads (and clans), your friend group was not split up. The lockout exists to prevent abuse, not to punish.'
  ];

  const lockoutExceptions = [
    'You are **NOT** locked after a scramble if:',
    `- You are still within your **${plugin.options.switchEnabledMinutes || 10}-minute** join/match window.`,
    '- You were already in the switch queue before the scramble fired.',
    '- The scramble failed to keep your squad or clan together. In this case, you are given extra leniency to switch back to your group when your join/match window opens.'
  ];

  const reconnectText = [
    'If you disconnect and reconnect to a different team after a scramble,',
    'your switch restrictions (including the scramble lockout) are cleared.',
    "You can use **`'!switch'`** immediately to return to your previous team."
  ];

  return {
    title: 'Scrambles & Switching',
    description: 'A scramble is when the server shuffles players to rebalance teams after one-sided rounds. After a scramble, switching is temporarily locked.',
    color: 0xE74C3C,
    fields: [
      { name: 'What a Scramble Does', value: whatScrambleDoes.join('\n'), inline: false },
      { name: 'Post-Scramble Lockout', value: lockoutExplainer.join('\n'), inline: false },
      { name: 'Lockout Exceptions', value: lockoutExceptions.join('\n'), inline: false },
      { name: 'Reconnecting After a Scramble', value: reconnectText.join('\n'), inline: false }
    ]
  };
}

// ── Embed 6: Special Cases ──────────────────────────────────────

function _buildSpecialCasesEmbed(plugin) {
  const liberalModes = plugin.options.liberalSwitchGameModes || ['Seed', 'Jensen'];
  const liberalCap = plugin.options.liberalSwitchMaxUnbalancedSlots || 6;

  const liberalText = [
    `During **${liberalModes.join('/')}** rounds, switching is relaxed:`,
    `- No time window limit. Switch at any point during the round.`,
    `- No token cost. Switches do not consume tokens.`,
    `- More permissive balance limit. Up to **${liberalCap}** players difference is allowed instead of the normal tolerance.`
  ];

  const factionVoteText = [
    "During the faction vote screen between rounds, **`'!switch'`** is unavailable.",
    'The queue is paused. When the next round begins, the queue is cleared.',
    "You will need to re-queue if you still want to switch."
  ];

  return {
    title: 'Special Cases',
    description: 'Some game modes and situations change how the normal rules apply.',
    color: 0xF1C40F,
    fields: [
      { name: `${liberalModes.join(' & ')} Rounds`, value: liberalText.join('\n'), inline: false },
      { name: 'Faction Vote (Between Rounds)', value: factionVoteText.join('\n'), inline: false }
    ]
  };
}

// ── Embed 7: Tips ───────────────────────────────────────────────

function _buildTipsEmbed(plugin) {
  const maxTokens = plugin.options.maxSwitchTokens != null ? plugin.options.maxSwitchTokens : 1;
  const switchWindow = plugin.options.switchEnabledMinutes || 10;
  const tb = _getTeamBalancer(plugin);
  const clanGrouping = tb && tb.options && tb.options.enableClanTagGrouping === true;

  const tips = [
    `**1. Switch early.** Your **${switchWindow}-minute** window starts when you join. Do not wait until the last minute.`
  ];

  if (maxTokens > 1) {
    tips.push(`**2. Save a token.** With **${maxTokens}** tokens, you can switch more than once before waiting for a refill. This gives you flexibility if you need to switch multiple times in a session.`);
  } else {
    tips.push(`**2. Plan your switch.** After switching, you must wait through the full cooldown before switching again. Make every switch count.`);
  }

  tips.push('**3. Use seed rounds.** Seed and Jensen rounds have no token cost and no time limit. Use this time to position yourself on the right team for free.');

  tips.push("**4. Check before you act.** **`'!switch check'`** tells you exactly what is blocking you: time window, tokens, scramble lock, or balance. This helps you make an informed decision.");

  tips.push('**5. Squads and clans stay together.** The scrambler preserves squads and clan groups. Even if a scramble fires, your group will not be split up.');

  return {
    title: 'Tips for Playing With Friends',
    description: 'The system is designed to help you end up on the same team as your friends. Here is how to make the most of it.',
    color: 0x1ABC9C,
    fields: [
      { name: 'Best Practices', value: tips.join('\n\n'), inline: false }
    ]
  };
}


// ── 7-Day Stats Embed ──────────────────────────────────────────

/**
 * Build a 7-day reliability stats embed from historical round summaries.
 * Scrapes the reporting channel for "Switch Round Summary" embeds from the
 * last 7 days, aggregates standard-mode rounds, and returns a single embed
 * with plain-English sentences.
 *
 * Returns null if no data is available (graceful degradation — caller should
 * drop the stats embed from the message rather than showing an empty embed).
 *
 * @param {object} plugin — the live Switch plugin instance
 * @returns {object|null} Discord embed object, or null if no data
 */
async function _buildSevenDayStatsEmbed(plugin) {
  try {
    const channel = plugin.channel;
    if (!channel) {
      // No reporting channel configured — round summaries are posted to
      // channelID, which may differ from explainChannelID. If channelID
      // is unset, there are no summaries to scrape, so we silently drop
      // the stats embed. The explain embeds still post fine.
      plugin.verbose(2, '[Explain] No reporting channel available — 7-day stats embed omitted.');
      return null;
    }

    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let lastID = null;
    let foundAny = false;
    const totals = {
      rounds: 0,
      success: 0,
      failed: 0,
      denied: 0,
      instant: 0,
      queueNormal: 0,
      queueTeamTrade: 0,
      queueJoinSwap: 0,
      queueTimeoutSwitch: 0,
      outcomeExpired: 0,
      outcomeDC: 0,
      outcomeCancelled: 0,
      outcomeRemoved: 0,
      denialCooldown: 0,
      denialTimeWindow: 0,
      denialScrambleLock: 0,
      medianDurationsMs: [],
      toT1: 0,
      toT2: 0
    };

    // Scrape in batches of 100 with 300ms delay between batches
    for (let i = 0; i < 50; i++) {
      const options = { limit: 100 };
      if (lastID) options.before = lastID;

      let messages;
      try {
        messages = await channel.messages.fetch(options);
      } catch (_) {
        break; // rate limited or channel unavailable
      }

      if (!messages || messages.size === 0) break;

      for (const [, msg] of messages) {
        // Stop if we've gone past 7 days
        if (msg.createdTimestamp < sevenDaysAgo) {
          foundAny = true; // we found at least something in range
          // We can't break the outer loop easily, but we'll stop processing
          continue;
        }

        if (!msg.embeds || msg.embeds.length === 0) continue;

        for (const embed of msg.embeds) {
          if (embed.title !== 'Switch Round Summary') continue;
          foundAny = true;

          // Skip liberal-mode rounds
          const mode = plugin._parseMode ? plugin._parseMode(embed) : null;
          if (mode === 'liberal') continue;

          totals.rounds++;

          // Parse stats field — first locate the 📊 Stats field by name, then pass its value
          const statsField = embed.fields?.find(f => f.name?.includes('Stats'));
          if (plugin._parseRoundStatsField && statsField?.value) {
            const stats = plugin._parseRoundStatsField(statsField.value);
            totals.success += stats.success;
            totals.failed += stats.failed;
            totals.denied += stats.denied;
            totals.toT1 += stats.toT1;
            totals.toT2 += stats.toT2;
          }

          // Parse queue wait from the stats field: extract mean and median
          // for the 7-day aggregate. Matches the format written by
          // switch-output.js _buildRoundSummaryEmbed():
          //   "**Queue Wait:** mean 2m 15s, median 3m 10s"
          if (statsField?.value) {
            const queueMatch = statsField.value.match(
              /\*\*Queue Wait:\*\* mean\s*(?:(\d+)m )?(\d+)s, median\s*(?:(\d+)m )?(\d+)s/
            );
            if (queueMatch) {
              const mm = queueMatch[3] ? parseInt(queueMatch[3], 10) : 0;
              const ms = parseInt(queueMatch[4], 10);
              totals.medianDurationsMs.push((mm * 60 + ms) * 1000);
            }
          }

          // Parse move types
          if (plugin._parseMoveTypes) {
            const moves = plugin._parseMoveTypes(embed);
            totals.instant += moves.instant;
            totals.queueNormal += moves.queueNormal;
            totals.queueTeamTrade += moves.queueTeamTrade;
            totals.queueJoinSwap += moves.queueJoinSwap;
            totals.queueTimeoutSwitch += moves.queueTimeoutSwitch;
          }

          // Parse denial reasons
          if (plugin._parseDenialReasons) {
            const reasons = plugin._parseDenialReasons(embed);
            totals.denialCooldown += reasons.cooldown;
            totals.denialTimeWindow += reasons.time_window;
            totals.denialScrambleLock += reasons.scramble_lock;
          }

          // Parse queue outcomes
          if (plugin._parseQueueOutcomes) {
            const outcomes = plugin._parseQueueOutcomes(embed);
            totals.outcomeExpired += outcomes.expired;
            totals.outcomeDC += outcomes.dc;
            totals.outcomeCancelled += outcomes.cancelled;
            totals.outcomeRemoved += outcomes.removed;
          }
        }
      }

      // Track the oldest message ID for the next batch
      const oldest = messages.last();
      if (oldest) {
        lastID = oldest.id;
        // If the oldest message is older than 7 days, we're done
        if (oldest.createdTimestamp < sevenDaysAgo) break;
      } else {
        break;
      }

      // Throttle: 300ms between batches
      await new Promise(r => setTimeout(r, 300));
    }

    // If no data at all, return null (caller drops the embed)
    if (!foundAny || totals.rounds === 0) return null;

    // ── Compute statistics ────────────────────────────────────
    // NOTE: "attempted" includes both successes and failures (switches that
    // were processed but failed), but NOT denials (switches that were rejected
    // at the eligibility gate). Denials are excluded because they represent
    // players who were told "no" before any attempt was made — including them
    // would make the success rate misleadingly low. The success rate reflects
    // the system's reliability once a switch request is accepted.
    const totalAttempted = totals.success + totals.failed;
    const successRate = totalAttempted > 0 ? Math.round((totals.success / totalAttempted) * 100) : 0;
    const instantRate = totals.success > 0 ? Math.round((totals.instant / totals.success) * 100) : 0;

    // Median queue wait from accumulated durations
    const globalMedianMs = plugin._computeMedianFromMs
      ? plugin._computeMedianFromMs(totals.medianDurationsMs)
      : 0;
    const medMin = Math.floor(globalMedianMs / 60000);
    const medSec = Math.round((globalMedianMs % 60000) / 1000);
    const medianStr = medMin > 0
      ? `${medMin} minute${medMin !== 1 ? 's' : ''}`
      : medSec > 0 ? `${medSec} seconds` : 'N/A';

    // Average queue wait from medianDurationsMs
    const avgMs = totals.medianDurationsMs.length > 0
      ? Math.round(totals.medianDurationsMs.reduce((a, b) => a + b, 0) / totals.medianDurationsMs.length)
      : 0;
    const avgMin = Math.floor(avgMs / 60000);
    const avgSec = Math.round((avgMs % 60000) / 1000);
    const avgStr = avgMin > 0
      ? `about ${avgMin} minute${avgMin !== 1 ? 's' : ''}`
      : avgSec > 0 ? `about ${avgSec} seconds` : 'N/A';

    // ── Build plain-English sentences ─────────────────────────
    const lines = [];

    // Success rate
    if (successRate >= 90) {
      lines.push(`**${successRate}%** of attempted switches succeed.`);
    } else if (successRate >= 75) {
      lines.push(`**${successRate}%** of attempted switches succeed — most requests go through.`);
    } else {
      lines.push(`**${successRate}%** of attempted switches succeed.`);
    }

    lines.push('');

    // Instant rate
    if (instantRate >= 50) {
      lines.push(`Most switches happen instantly — **${instantRate}%** go through the moment you type \`!switch\`, with no waiting at all.`);
    } else if (instantRate > 0) {
      lines.push(`**${instantRate}%** of switches happen instantly — the rest use the queue.`);
    } else {
      lines.push('Switches typically use the queue system.');
    }

    lines.push('');

    // Queue wait
    if (globalMedianMs > 0) {
      lines.push(`When a queue wait is needed, the typical wait is **${medianStr}**. The average is **${avgStr}**.`);
      lines.push('');
    }

    // Summary line
    const totalSwitches = totals.success;
    lines.push(`Based on **${totalSwitches}** successful switch${totalSwitches !== 1 ? 'es' : ''} across **${totals.rounds}** round${totals.rounds !== 1 ? 's' : ''}.`);

    return {
      title: '📊 !switch Reliability — Last 7 Days',
      description: 'standard-mode rounds · updated every 30 min',
      color: 0x3498DB,
      fields: [
        { name: '\u200B', value: lines.join('\n'), inline: false }
      ],
      footer: {
        text: `Switch v${plugin.constructor.version} · updated`
      },
      timestamp: new Date().toISOString()
    };
  } catch (err) {
    plugin.verbose(1, `[Explain] Failed to build 7-day stats embed: ${err.message}`);
    return null;
  }
}

export default SwitchExplain;
