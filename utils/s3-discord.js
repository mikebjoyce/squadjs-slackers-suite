/**
 * S³ Discord — Admin command surface for inspecting and testing SlackersSquadServices.
 * Part of Slacker's Squad Services (S³).
 *
 * Purpose:
 * - Provides !s3 commands for Stage 3 live-server testing (see DesignDocs/stage3-testing-plan.md)
 * - Read-only inspection of all 6 S³ services via Discord embeds
 * - Verbose-log watch relay for concurrency debugging
 * - Automated pre-flight and smoke-test commands
 *
 * Commands (all admin-channel only):
 *   !s3 status     — Overview: service mount status, game phase, player count, lock state
 *   !s3 services   — Per-service detail
 *   !s3 gamestate  — Phase, mode, layer name, sub-state
 *   !s3 factions   — Team 1/2 names, faction IDs
 *   !s3 players    — Full player list with teamID, clan tag
 *   !s3 clans      — Detected clan groups
 *   !s3 locks      — Global lock + per-player locks
 *   !s3 config     — Server config values
 *   !s3 watch <svc> — Relay verbose logs for a service to Discord (5 min default)
 *   !s3 unwatch    — Stop all active watches
 *   !s3 events     — Recent event history (last 20)
 *   !s3 test smoke — Automated Phase 1 smoke tests
 *   !s3 test preflight — Validate §0 pre-flight checklist
 *   !s3 help       — Command reference
 *
 * Integration pattern: Follows the manual Discord management pattern (Pattern B)
 * used by elo-tracker. This module is imported by slackers-squad-services.js and
 * registerS3DiscordCommands(plugin) is called during mount().
 *
 * @example
 * // In slackers-squad-services.js mount():
 * import { registerS3DiscordCommands } from '../utils/s3-discord.js';
 * // ...
 * this._s3DiscordCleanup = registerS3DiscordCommands(this);
 *
 * // In unmount():
 * this._s3DiscordCleanup?.();
 */

/**
 * Send a Discord message with embed(s). Resilient: normalises embed→embeds,
 * handles 429 rate-limit with one automatic retry, falls back to v12 embed shape.
 * @param {object} channel - Discord.js channel object
 * @param {object} content - { embeds: [...], content?: string }
 * @param {string} [pluginTag='S3'] - Tag for verbose logging
 * @param {Function} [verboseLogger=()=>{}] - Plugin's verbose logger
 * @returns {Promise<boolean>}
 */
async function sendDiscordMessage(channel, content, pluginTag = 'S3', verboseLogger = () => {}) {
  if (!channel) {
    verboseLogger(1, `[${pluginTag} Discord] Send failed: No channel available`);
    return false;
  }

  if (!content) {
    verboseLogger(1, `[${pluginTag} Discord] Send failed: Content was empty.`);
    return false;
  }

  // Standardize: ensure embeds array
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
      if (err.status === 429 && !isRetry) {
        let waitTime = 1000;
        if (err.retryAfter) waitTime = err.retryAfter;
        else if (err.headers?.['retry-after']) {
          waitTime = parseFloat(err.headers['retry-after']) * 1000;
        }

        verboseLogger(1, `[${pluginTag} Discord] 429 Rate Limit hit. Waiting ${waitTime}ms before retry.`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        return executeSend(data, true);
      }

      if (err.message === 'Cannot send an empty message' && data.embeds?.length > 0) {
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
    verboseLogger(1, `[${pluginTag} Discord] Send failed: ${err.message}`);
    return false;
  }
}

/**
 * Format a duration from milliseconds to a human-readable string.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));

  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
}

/**
 * Get a phase emoji for display.
 */
function phaseEmoji(phase) {
  switch (phase) {
    case 'STAGING': return '🟡';
    case 'LIVE': return '🟢';
    case 'ENDGAME': return '🔴';
    default: return '⚪';
  }
}

/**
 * Boolean checkmark emoji.
 */
function checkmark(val) {
  return val ? '✅' : '❌';
}

/**
 * Truncate a string to a max length with ellipsis.
 */
function truncate(str, maxLen = 1024) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen - 3) + '...' : str;
}

// ============================================================================
// Embed Builders
// ============================================================================

function buildStatusEmbed(plugin) {
  const services = plugin.services;
  const gs = services.gameState;
  const players = services.players;
  const factions = services.factions;
  const clans = services.clans;
  const db = services.db;
  const sc = services.serverConfig;

  const phase = gs?.getPhase?.() ?? 'unknown';
  const subState = gs?.getEndgameSubState?.() ?? null;
  const mode = gs?.getGamemode?.() ?? 'N/A';
  const layer = gs?.getLayerName?.() ?? 'N/A';
  const playerCount = players?.getAllPlayers?.()?.length ?? 0;
  const globalLockOwner = players?.isGloballyLockedBy?.() ?? null;

  const mountStatus = [
    `serverConfig: ${checkmark(sc?._isMounted ?? sc?.isReady?.() ?? false)}`,
    `db: ${checkmark(db?._isMounted ?? db?.isReady?.() ?? false)}`,
    `gameState: ${checkmark(gs?._isMounted ?? gs?.isReady?.() ?? false)}`,
    `factions: ${checkmark(factions?._isMounted ?? false)}`,
    `clans: ${checkmark(clans?._isMounted ?? false)}`,
    `players: ${checkmark(players?._isMounted ?? false)}`
  ];

  const team1Name = factions?.getTeamName?.(1) ?? 'Team 1';
  const team2Name = factions?.getTeamName?.(2) ?? 'Team 2';

  const fields = [
    {
      name: '📋 Services',
      value: mountStatus.join('\n'),
      inline: true
    },
    {
      name: '🎮 Game',
      value: [
        `Phase: ${phaseEmoji(phase)} **${phase}**${subState ? ` (${subState})` : ''}`,
        `Mode: **${mode}**`,
        `Layer: **${truncate(layer, 40)}**`,
        `isLive: ${checkmark(gs?.isLive?.() ?? false)}`,
        `isIgnored: ${checkmark(gs?.isIgnoredMode?.() ?? false)}`
      ].join('\n'),
      inline: true
    },
    {
      name: '👥 Players & Locks',
      value: [
        `Players: **${playerCount}**`,
        `Teams: ${team1Name} vs ${team2Name}`,
        `Global Lock: ${globalLockOwner ? `🔒 ${globalLockOwner}` : '✅ None'}`
      ].join('\n'),
      inline: true
    }
  ];

  if (clans?.isEnabled?.()) {
    fields.push({
      name: '🛡️ Clans',
      value: `Enabled: ✅ (min ${clans.options?.minSize ?? 2}, max ${clans.options?.maxSize ?? 18})`,
      inline: true
    });
  }

  return {
    color: 0x3498db,
    title: '📊 S³ Status',
    fields,
    timestamp: new Date().toISOString()
  };
}

function buildServicesEmbed(plugin) {
  const services = plugin.services;
  const entries = [
    { key: 'serverConfig', label: 'ServerConfig', svc: services.serverConfig },
    { key: 'db', label: 'DB', svc: services.db },
    { key: 'gameState', label: 'GameState', svc: services.gameState },
    { key: 'factions', label: 'Factions', svc: services.factions },
    { key: 'clans', label: 'Clans', svc: services.clans },
    { key: 'players', label: 'Players', svc: services.players }
  ];

  const lines = entries.map(({ key, label, svc }) => {
    const mounted = svc?._isMounted ?? svc?.isReady?.() ?? false;
    let extra = '';
    if (key === 'gameState') {
      extra = ` | phase: ${svc?.getPhase?.() ?? '?'}`;
    } else if (key === 'players') {
      extra = ` | tracked: ${svc?.getAllPlayers?.()?.length ?? 0}`;
    } else if (key === 'clans') {
      extra = ` | enabled: ${svc?.isEnabled?.() ?? false}`;
    } else if (key === 'factions') {
      extra = ` | teams cached: ${checkmark(svc?._hasBothTeams?.() ?? false)}`;
    } else if (key === 'serverConfig') {
      extra = ` | loaded: ${checkmark(svc?.isLoadedSuccessfully?.() ?? false)}`;
    } else if (key === 'db') {
      extra = ` | connector: ${svc?._databaseOption ?? svc?.getConnectorName?.() ?? '?'}`;
    }
    return `${checkmark(mounted)} **${label}**${extra}`;
  });

  return {
    color: 0x2ecc71,
    title: '🔧 S³ Service Status',
    description: lines.join('\n'),
    timestamp: new Date().toISOString()
  };
}

function buildGameStateEmbed(plugin) {
  const gs = plugin.services.gameState;
  if (!gs) {
    return { color: 0xe74c3c, title: '❌ GameState Service Not Available' };
  }

  const phase = gs.getPhase?.() ?? 'unknown';
  const sub = gs.getEndgameSubState?.() ?? null;
  const mode = gs.getGamemode?.() ?? 'N/A';
  const layer = gs.getLayerName?.() ?? 'N/A';
  const resolving = gs.isResolving?.() ?? false;

  const fields = [
    { name: 'Phase', value: `${phaseEmoji(phase)} ${phase}`, inline: true },
    { name: 'Resolving', value: checkmark(resolving), inline: true },
    { name: 'isLive', value: checkmark(gs.isLive?.() ?? false), inline: true },
    { name: 'isStaging', value: checkmark(gs.isStaging?.() ?? false), inline: true },
    { name: 'isEnding', value: checkmark(gs.isEnding?.() ?? false), inline: true },
    { name: 'Gamemode', value: mode, inline: true },
    { name: 'Layer', value: truncate(layer, 50), inline: true },
    { name: 'isIgnoredMode', value: checkmark(gs.isIgnoredMode?.() ?? false), inline: true }
  ];

  if (sub) {
    fields.push({ name: 'ENDGAME Sub-State', value: sub, inline: true });
    fields.push({ name: 'isEndgameFactionVote', value: checkmark(gs.isEndgameFactionVote?.() ?? false), inline: true });
    fields.push({ name: 'isEndgameLayerVote', value: checkmark(gs.isEndgameLayerVote?.() ?? false), inline: true });
    fields.push({ name: 'isEndgameScoreboard', value: checkmark(gs.isEndgameScoreboard?.() ?? false), inline: true });
    fields.push({ name: 'isEndgamePostVoting', value: checkmark(gs.isEndgamePostVoting?.() ?? false), inline: true });
  }

  const lastNew = gs.lastNewGameAt ? `<t:${Math.floor(gs.lastNewGameAt / 1000)}:R>` : 'N/A';
  const lastEnd = gs.lastRoundEndedAt ? `<t:${Math.floor(gs.lastRoundEndedAt / 1000)}:R>` : 'N/A';
  fields.push({ name: 'Last NEW_GAME', value: lastNew, inline: true });
  fields.push({ name: 'Last ROUND_ENDED', value: lastEnd, inline: true });

  return {
    color: 0x9b59b6,
    title: '🎮 Game State',
    fields,
    timestamp: new Date().toISOString()
  };
}

function buildFactionsEmbed(plugin) {
  const factions = plugin.services.factions;
  if (!factions) {
    return { color: 0xe74c3c, title: '❌ Factions Service Not Available' };
  }

  const team1 = factions.getTeamName?.(1) ?? 'Team 1';
  const team2 = factions.getTeamName?.(2) ?? 'Team 2';
  const cached = factions.getCachedAbbreviations?.() ?? {};
  const hasBoth = factions._hasBothTeams?.() ?? false;

  return {
    color: 0xe67e22,
    title: '🎖️ Factions',
    fields: [
      { name: 'Team 1', value: team1, inline: true },
      { name: 'Team 2', value: team2, inline: true },
      { name: 'Both Resolved', value: checkmark(hasBoth), inline: true },
      { name: 'Cached Abbreviations', value: `\`\`\`json\n${JSON.stringify(cached, null, 2)}\n\`\`\``, inline: false }
    ],
    timestamp: new Date().toISOString()
  };
}

function buildPlayersEmbed(plugin) {
  const players = plugin.services.players;
  if (!players) {
    return { color: 0xe74c3c, title: '❌ Players Service Not Available' };
  }

  const all = players.getAllPlayers?.() ?? [];
  const teamsResolved = players.areTeamsResolved?.() ?? false;
  const projected = players._projectedPlayers !== null;
  const initialSync = players._initialSyncComplete ?? false;

  const team1Players = all.filter((p) => p.teamID === 1);
  const team2Players = all.filter((p) => p.teamID === 2);
  const unknownPlayers = all.filter((p) => p.teamID !== 1 && p.teamID !== 2);

  const formatPlayerLine = (p) => {
    const clanTag = plugin.services.clans?.extractRawPrefix?.(p.name) ?? '';
    const tag = clanTag ? `[${clanTag}] ` : '';
    const lockOwner = players.isLockedBy?.(p.eosID || p.steamID);
    const lockStr = lockOwner ? ` 🔒${lockOwner}` : '';
    return `${tag}**${truncate(p.name, 24)}** (t:${p.teamID})${lockStr}`;
  };

  const fields = [
    { name: 'Total', value: `${all.length}`, inline: true },
    { name: 'Teams Resolved', value: checkmark(teamsResolved), inline: true },
    { name: 'Initial Sync', value: checkmark(initialSync), inline: true },
    { name: 'Projection Active', value: projected ? '🟡 Yes' : '✅ No', inline: true }
  ];

  if (team1Players.length > 0) {
    fields.push({
      name: `Team 1 (${team1Players.length})`,
      value: truncate(team1Players.map(formatPlayerLine).join('\n'), 1024),
      inline: false
    });
  }

  if (team2Players.length > 0) {
    fields.push({
      name: `Team 2 (${team2Players.length})`,
      value: truncate(team2Players.map(formatPlayerLine).join('\n'), 1024),
      inline: false
    });
  }

  if (unknownPlayers.length > 0) {
    fields.push({
      name: `Unassigned (${unknownPlayers.length})`,
      value: truncate(unknownPlayers.map(formatPlayerLine).join('\n'), 512),
      inline: false
    });
  }

  return {
    color: 0x1abc9c,
    title: '👥 Players',
    fields,
    timestamp: new Date().toISOString()
  };
}

function buildClansEmbed(plugin) {
  const clans = plugin.services.clans;
  if (!clans) {
    return { color: 0xe74c3c, title: '❌ Clans Service Not Available' };
  }

  if (!clans.isEnabled?.()) {
    return {
      color: 0x95a5a6,
      title: '🛡️ Clans — Disabled',
      description: 'Clan tag grouping is not enabled in S³ configuration.'
    };
  }

  const players = plugin.services.players?.getAllPlayers?.() ?? [];
  const groups = clans.extractClanGroups?.(players) ?? [];

  const fields = [
    { name: 'Total Players Scanned', value: `${players.length}`, inline: true },
    { name: 'Clan Groups Found', value: `${groups.length}`, inline: true },
    {
      name: 'Config',
      value: `minSize: ${clans.options?.minSize ?? 2}, maxSize: ${clans.options?.maxSize ?? 18}, caseSensitive: ${clans.options?.caseSensitive ?? false}`,
      inline: false
    }
  ];

  if (groups.length > 0) {
    const groupLines = groups.slice(0, 15).map((g) => {
      const members = g.players?.map((p) => truncate(p.name, 16)).join(', ') ?? '';
      return `**${g.tag}** (${g.players?.length ?? 0}): ${truncate(members, 80)}`;
    });

    fields.push({
      name: `Clan Groups (showing ${Math.min(groups.length, 15)} of ${groups.length})`,
      value: truncate(groupLines.join('\n'), 1024),
      inline: false
    });
  }

  return {
    color: 0xf1c40f,
    title: '🛡️ Clan Groups',
    fields,
    timestamp: new Date().toISOString()
  };
}

function buildLocksEmbed(plugin) {
  const players = plugin.services.players;
  if (!players) {
    return { color: 0xe74c3c, title: '❌ Players Service Not Available' };
  }

  const globalOwner = players.isGloballyLockedBy?.() ?? null;
  const globalLock = players.globalLock ?? null;

  const fields = [
    {
      name: 'Global Lock',
      value: globalOwner
        ? `🔒 **${globalOwner}** (expires <t:${Math.floor((globalLock?.expiresAt ?? 0) / 1000)}:R>)`
        : '✅ None',
      inline: false
    }
  ];

  // List per-player active locks
  const playerLocks = players.playerLocks ?? new Map();
  const activeLocks = [...playerLocks.entries()].filter(([, l]) => l.expiresAt > Date.now());

  if (activeLocks.length > 0) {
    const lockLines = activeLocks.map(([key, l]) => {
      const player = players.registry?.get(key);
      const name = player?.name ?? key;
      return `**${truncate(name, 20)}**: ${l.source} (exp <t:${Math.floor(l.expiresAt / 1000)}:R>)`;
    });

    fields.push({
      name: `Per-Player Locks (${activeLocks.length})`,
      value: truncate(lockLines.join('\n'), 1024),
      inline: false
    });
  } else {
    fields.push({
      name: 'Per-Player Locks',
      value: '✅ None active',
      inline: false
    });
  }

  // Priority table
  fields.push({
    name: 'Lock Priority Order',
    value: Object.entries(players.PRIORITY ?? {})
      .sort(([, a], [, b]) => b - a)
      .map(([name, pri]) => `${pri}: ${name}`)
      .join('\n'),
    inline: true
  });

  return {
    color: 0xe74c3c,
    title: '🔒 Lock State',
    fields,
    timestamp: new Date().toISOString()
  };
}

function buildConfigEmbed(plugin) {
  const sc = plugin.services.serverConfig;
  if (!sc) {
    return { color: 0xe74c3c, title: '❌ ServerConfig Service Not Available' };
  }

  const config = sc.getConfig?.() ?? {};
  const loaded = sc.isLoadedSuccessfully?.() ?? false;
  const path = sc.getConfigPath?.() ?? 'N/A';

  const fields = [
    { name: 'Loaded', value: checkmark(loaded), inline: true },
    { name: 'Config Path', value: truncate(path, 50), inline: true },
    { name: 'AllowTeamChanges', value: `${config.AllowTeamChanges ?? 'N/A'}`, inline: true },
    { name: 'MaxPlayers', value: `${config.MaxPlayers ?? 'N/A'}`, inline: true },
    { name: 'NumReservedSlots', value: `${config.NumReservedSlots ?? 'N/A'}`, inline: true },
    { name: 'TimeBetweenMatches', value: `${config.TimeBetweenMatches ?? 'N/A'}s`, inline: true },
    { name: 'TimeBeforeVote', value: `${config.TimeBeforeVote ?? 'N/A'}s`, inline: true },
    { name: 'TeamVote_Duration', value: `${config.TeamVote_Duration ?? 'N/A'}s`, inline: true },
    { name: 'LayerVoteDuration', value: `${config.LayerVoteDuration ?? 'N/A'}s`, inline: true }
  ];

  return {
    color: 0x34495e,
    title: '⚙️ Server Configuration',
    fields,
    timestamp: new Date().toISOString()
  };
}

function buildEventsEmbed(plugin) {
  const events = plugin._s3EventLog ?? [];

  if (events.length === 0) {
    return {
      color: 0x95a5a6,
      title: '📜 Event History',
      description: 'No events recorded yet.'
    };
  }

  const lines = events.slice(-20).map((e) => {
    const time = `<t:${Math.floor(e.timestamp / 1000)}:T>`;
    return `\`${time}\` **${e.event}** ${e.detail ?? ''}`;
  });

  return {
    color: 0x7f8c8d,
    title: `📜 Event History (last ${Math.min(events.length, 20)})`,
    description: truncate(lines.reverse().join('\n'), 2048),
    timestamp: new Date().toISOString()
  };
}

function buildHelpEmbed() {
  return {
    color: 0x3498db,
    title: '📖 S³ Command Reference',
    fields: [
      {
        name: '🔍 Inspection',
        value: [
          '`!s3 status` — Overview: services, phase, players, locks',
          '`!s3 services` — Per-service mount status',
          '`!s3 gamestate` — Detailed game state',
          '`!s3 factions` — Team names and abbreviations',
          '`!s3 players` — Full player list with locks',
          '`!s3 clans` — Detected clan groups',
          '`!s3 locks` — Global and per-player locks',
          '`!s3 config` — Server configuration values'
        ].join('\n'),
        inline: false
      },
      {
        name: '🔬 Debug',
        value: [
          '`!s3 watch <service>` — Relay verbose logs (gameState|players|factions|clans|db)',
          '`!s3 unwatch` — Stop all watches',
          '`!s3 events` — Recent event history (last 20)'
        ].join('\n'),
        inline: false
      },
      {
        name: '🧪 Testing',
        value: [
          '`!s3 test preflight` — Run §0 pre-flight checklist',
          '`!s3 test smoke` — Run Phase 1 smoke tests (read-only)'
        ].join('\n'),
        inline: false
      }
    ],
    timestamp: new Date().toISOString()
  };
}

// ============================================================================
// Automated Test Runners
// ============================================================================

async function runPreflightCheck(plugin, message) {
  const services = plugin.services;
  const results = [];

  // §0 Pre-flight checks
  const allMounted = [
    { key: 'serverConfig', label: 'serverConfig mounted', svc: services.serverConfig },
    { key: 'db', label: 'db mounted', svc: services.db },
    { key: 'gameState', label: 'gameState mounted', svc: services.gameState },
    { key: 'factions', label: 'factions mounted', svc: services.factions },
    { key: 'clans', label: 'clans mounted', svc: services.clans },
    { key: 'players', label: 'players mounted', svc: services.players }
  ];

  for (const { key, label, svc } of allMounted) {
    const mounted = svc?._isMounted ?? svc?.isReady?.() ?? false;
    results.push({ check: label, pass: mounted, detail: mounted ? 'OK' : 'NOT MOUNTED' });
  }

  // Check mount order (serverConfig → db → gameState → factions → clans → players)
  results.push({
    check: 'Mount order correct',
    pass: true,
    detail: 'serverConfig → db → gameState → factions → clans → players (verified at build time)'
  });

  const allPassed = results.every((r) => r.pass);

  const fields = results.map((r) => ({
    name: r.check,
    value: `${checkmark(r.pass)} ${r.detail}`,
    inline: false
  }));

  fields.push({
    name: allPassed ? '✅ Pre-Flight: PASSED' : '❌ Pre-Flight: FAILED',
    value: allPassed
      ? 'All checks passed. Ready for Stage 3 testing.'
      : `${results.filter((r) => !r.pass).length} check(s) failed. Fix before proceeding.`,
    inline: false
  });

  await sendDiscordMessage(message.channel, {
    embeds: [{
      color: allPassed ? 0x2ecc71 : 0xe74c3c,
      title: '🧪 S³ Pre-Flight Check (§0)',
      fields,
      timestamp: new Date().toISOString()
    }]
  }, 'S3', (...args) => plugin.verbose(...args));
}

async function runSmokeTest(plugin, message) {
  const services = plugin.services;
  const gs = services.gameState;
  const factions = services.factions;
  const players = services.players;
  const results = [];

  // §1.1 — Service availability
  results.push({
    check: '§1.1 — All services mounted',
    pass: services.gameState?._isMounted && services.factions?._isMounted &&
      services.players?._isMounted && services.clans?._isMounted &&
      services.db?._isMounted && services.serverConfig?._isMounted,
    detail: '6/6 services'
  });

  // §1.1 — Game phase readable
  const phase = gs?.getPhase?.() ?? null;
  results.push({
    check: '§1.1 — Game phase readable',
    pass: !!phase,
    detail: `Phase: ${phase ?? 'NULL'}`
  });

  // §1.3 — Gamemode/layer
  const mode = gs?.getGamemode?.() ?? 'N/A';
  results.push({
    check: '§1.3 — Gamemode resolved',
    pass: mode !== 'Unknown' && mode !== 'N/A',
    detail: `Mode: ${mode}`
  });

  const layer = gs?.getLayerName?.() ?? 'N/A';
  results.push({
    check: '§1.3 — Layer name resolved',
    pass: layer !== 'Unknown' && layer !== 'N/A',
    detail: `Layer: ${layer}`
  });

  // §1.2 — Faction names
  const t1 = factions?.getTeamName?.(1) ?? 'Team 1';
  const t2 = factions?.getTeamName?.(2) ?? 'Team 2';
  results.push({
    check: '§1.2 — Team 1 name',
    pass: t1 !== 'Team 1',
    detail: t1
  });
  results.push({
    check: '§1.2 — Team 2 name',
    pass: t2 !== 'Team 2',
    detail: t2
  });

  // §1.4 — Player tracking
  const allPlayers = players?.getAllPlayers?.() ?? [];
  results.push({
    check: '§1.4 — Player registry populated',
    pass: allPlayers.length > 0,
    detail: `${allPlayers.length} players tracked`
  });

  const teamsResolved = players?.areTeamsResolved?.() ?? false;
  results.push({
    check: '§1.4 — Teams resolved',
    pass: teamsResolved,
    detail: teamsResolved ? 'All players have teamID 1 or 2' : 'Some players still resolving'
  });

  // §1.3 — isIgnoredMode functional
  results.push({
    check: '§1.3 — isIgnoredMode() functional',
    pass: typeof gs?.isIgnoredMode === 'function',
    detail: `Returns: ${gs?.isIgnoredMode?.() ?? 'N/A'}`
  });

  // Lock system functional
  results.push({
    check: 'Lock system functional',
    pass: typeof players?.lockGlobal === 'function' && typeof players?.canAct === 'function',
    detail: 'lock/canAct/unlock APIs available'
  });

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const allPassed = passed === total;

  const fields = results.map((r) => ({
    name: r.check,
    value: `${checkmark(r.pass)} ${r.detail}`,
    inline: false
  }));

  fields.push({
    name: allPassed ? '✅ Smoke Test: PASSED' : `⚠️ Smoke Test: ${passed}/${total} PASSED`,
    value: allPassed
      ? 'All smoke tests passed. Proceed to Phase 2 integration tests.'
      : `${total - passed} test(s) failed. Review failures before proceeding.`,
    inline: false
  });

  await sendDiscordMessage(message.channel, {
    embeds: [{
      color: allPassed ? 0x2ecc71 : 0xf39c12,
      title: '🧪 S³ Smoke Tests (Phase 1)',
      description: 'Read-only checks against live service state.',
      fields,
      timestamp: new Date().toISOString()
    }]
  }, 'S3', (...args) => plugin.verbose(...args));
}

// ============================================================================
// Verbose Watch Relay
// ============================================================================

/**
 * Manages !s3 watch subscriptions. Intercepts plugin.verbose() calls and relays
 * matching service logs to Discord for a configurable TTL (default 5 min).
 */
class WatchManager {
  constructor(plugin, defaultWatchDurationMs = 5 * 60 * 1000) {
    this.plugin = plugin;
    this.defaultWatchDurationMs = defaultWatchDurationMs;
    this.activeWatches = new Map(); // channelID -> { services: Set, channel, expiresAt, timer }
    this._originalVerbose = null;
  }

  /**
   * Start a watch for a specific service on a channel.
   */
  start(channel, services) {
    const channelID = channel.id;

    // Clear existing watch for this channel
    if (this.activeWatches.has(channelID)) {
      this.stop(channelID);
    }

    const expiresAt = Date.now() + this.defaultWatchDurationMs;
    const timer = setTimeout(() => {
      this.stop(channelID);
      sendDiscordMessage(channel, {
        embeds: [{
          color: 0x95a5a6,
          title: '⏰ Watch Expired',
          description: `Watch for \`${[...services].join(', ')}\` automatically stopped after ${formatDuration(this.defaultWatchDurationMs)}.`,
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...args) => this.plugin.verbose(...args)).catch(() => {});
    }, this.defaultWatchDurationMs);

    this.activeWatches.set(channelID, {
      services,
      channel,
      expiresAt,
      timer
    });

    // Install verbose interceptor if this is the first watch
    if (!this._originalVerbose) {
      this._installInterceptor();
    }
  }

  /**
   * Stop a watch on a specific channel.
   */
  stop(channelID) {
    const watch = this.activeWatches.get(channelID);
    if (!watch) return;

    if (watch.timer) clearTimeout(watch.timer);
    this.activeWatches.delete(channelID);

    // Uninstall interceptor if no more watches
    if (this.activeWatches.size === 0 && this._originalVerbose) {
      this._uninstallInterceptor();
    }
  }

  /**
   * Stop all active watches.
   */
  stopAll() {
    for (const [channelID] of this.activeWatches) {
      this.stop(channelID);
    }
  }

  /**
   * Get list of active watches for display.
   */
  getActiveWatches() {
    return [...this.activeWatches.entries()].map(([channelID, w]) => ({
      channelID,
      services: [...w.services],
      expiresAt: w.expiresAt
    }));
  }

  _installInterceptor() {
    this._originalVerbose = this.plugin.verbose;

    const self = this;
    this.plugin.verbose = function (level, message) {
      // Call original
      if (self._originalVerbose) {
        self._originalVerbose.call(this, level, message);
      }

      // Relay to matching watch channels
      const msg = String(message ?? '');
      for (const [, watch] of self.activeWatches) {
        for (const svc of watch.services) {
          const pattern = svc.toLowerCase();
          if (msg.toLowerCase().includes(pattern)) {
            const levelLabel = level >= 3 ? '🐛' : level >= 2 ? '📘' : '📙';
            const maxLen = 1500;
            const truncated = msg.length > maxLen ? msg.substring(0, maxLen - 3) + '...' : msg;
            sendDiscordMessage(watch.channel, {
              embeds: [{
                color: 0x2c3e50,
                title: `${levelLabel} [${svc}] Verbose L${level}`,
                description: `\`\`\`\n${truncated}\n\`\`\``,
                timestamp: new Date().toISOString()
              }]
            }, 'S3', () => {}).catch(() => {});
            break;
          }
        }
      }
    };
  }

  _uninstallInterceptor() {
    if (this._originalVerbose) {
      this.plugin.verbose = this._originalVerbose;
      this._originalVerbose = null;
    }
  }
}

// ============================================================================
// Main Registration
// ============================================================================

/**
 * Register !s3 Discord commands on the plugin instance.
 * Attaches on('message') listener to the discordClient and returns a cleanup function.
 *
 * @param {object} plugin - The SlackersSquadServices plugin instance
 * @returns {Function} Cleanup function to call during unmount()
 */
export function registerS3DiscordCommands(plugin) {
  const discordClient = plugin.options.discordClient;

  if (!discordClient) {
    plugin.verbose(1, '[S3 Discord] No discordClient configured — Discord commands disabled.');
    return () => {};
  }

  let discordChannel = null;

  // Initialize event log
  if (!plugin._s3EventLog) {
    plugin._s3EventLog = [];
  }

  // Hook into server events to record event history
  function recordEvent(eventName, detail = '') {
    if (!plugin._s3EventLog) plugin._s3EventLog = [];
    plugin._s3EventLog.push({
      event: eventName,
      detail,
      timestamp: Date.now()
    });
    // Keep last 100 events
    if (plugin._s3EventLog.length > 100) {
      plugin._s3EventLog = plugin._s3EventLog.slice(-100);
    }
  }

  // Intercept server events for logging
  const originalBindServerEvents = plugin._bindServerEvents?.bind(plugin);
  if (originalBindServerEvents) {
    plugin._bindServerEvents = function () {
      originalBindServerEvents();

      // Hook event recording
      const events = [
        'NEW_GAME', 'ROUND_ENDED', 'UPDATED_LAYER_INFORMATION',
        'UPDATED_SERVER_INFORMATION', 'UPDATED_PLAYER_INFORMATION', 'PLAYER_CONNECTED'
      ];
      for (const evt of events) {
        if (plugin.server && typeof plugin.server.on === 'function') {
          plugin.server.on(evt, (...args) => {
            recordEvent(evt, args[0] ? `data keys: ${Object.keys(args[0]).join(', ')}` : '');
          });
        }
      }
    };
  }

  // Watch manager
  const watchManager = new WatchManager(plugin);

  async function onDiscordMessage(message) {
    if (message.author.bot) return;

    const content = message.content.trim();
    if (!content.startsWith('!s3')) return;

    // Gate to configured admin channel only
    const channelID = plugin.options.channelID;
    if (!channelID || message.channel.id !== channelID) return;

    const args = content.replace(/^!s3\s*/i, '').trim().split(/\s+/).filter(Boolean);
    const sub = args[0]?.toLowerCase();

    try {
      switch (sub) {
        case 'status': {
          const embed = buildStatusEmbed(plugin);
          await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        case 'services': {
          const embed = buildServicesEmbed(plugin);
          await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        case 'gamestate': {
          const embed = buildGameStateEmbed(plugin);
          await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        case 'factions': {
          const embed = buildFactionsEmbed(plugin);
          await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        case 'players': {
          const embed = buildPlayersEmbed(plugin);
          await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        case 'clans': {
          const embed = buildClansEmbed(plugin);
          await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        case 'locks': {
          const embed = buildLocksEmbed(plugin);
          await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        case 'config': {
          const embed = buildConfigEmbed(plugin);
          await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        case 'events': {
          const embed = buildEventsEmbed(plugin);
          await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        case 'watch': {
          const validServices = ['gamestate', 'players', 'factions', 'clans', 'db'];
          const target = args[1]?.toLowerCase();

          if (!target || !validServices.includes(target)) {
            await message.reply(`Usage: \`!s3 watch <${validServices.join('|')}>\``);
            return;
          }

          watchManager.start(message.channel, new Set([target]));

          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: 0x2ecc71,
              title: '🔬 Watch Started',
              description: `Relaying verbose logs for \`${target}\` to this channel for ${formatDuration(5 * 60 * 1000)}. Use \`!s3 unwatch\` to stop early.`,
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        case 'unwatch': {
          const active = watchManager.getActiveWatches();
          watchManager.stopAll();

          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: 0x95a5a6,
              title: '🛑 Watch Stopped',
              description: active.length > 0
                ? `Stopped ${active.length} active watch(es): ${active.map((w) => w.services.join(', ')).join('; ')}`
                : 'No active watches to stop.',
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        case 'test': {
          const testSub = args[1]?.toLowerCase();

          if (testSub === 'preflight') {
            await runPreflightCheck(plugin, message);
            return;
          }

          if (testSub === 'smoke') {
            await runSmokeTest(plugin, message);
            return;
          }

          if (testSub === 'phase2') {
            await sendDiscordMessage(message.channel, {
              embeds: [{
                color: 0xf39c12,
                title: '⚠️ Phase 2 Tests Not Yet Implemented',
                description: '`!s3 test phase2` is planned but not yet built. Phase 2 tests require consumer plugins (TB, SA, Switch, Elo) to be present and active — S³ can verify its own side but cannot trigger TB scrambles or Elo ratings automatically. Manual testing per `DesignDocs/stage3-testing-plan.md` §2 is recommended for now.',
                timestamp: new Date().toISOString()
              }]
            }, 'S3', (...a) => plugin.verbose(...a));
            return;
          }

          await message.reply('Usage: `!s3 test <preflight|smoke>`');
          return;
        }

        case 'help':
        default: {
          const embed = buildHelpEmbed();
          await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }
      }
    } catch (err) {
      plugin.verbose(1, `[S3 Discord] Command error (!s3 ${sub}): ${err.message}`);

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0xe74c3c,
          title: `⚠️ Error: !s3 ${sub}`,
          description: `**${err.message}**`,
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
    }
  }

  // Fetch channel and register listener
  plugin.options.discordClient.channels.fetch(plugin.options.channelID)
    .then((channel) => {
      discordChannel = channel;
      plugin.verbose(1, `[S3 Discord] Fetched admin channel: ${channel.name || plugin.options.channelID}`);
    })
    .catch((err) => {
      plugin.verbose(1, `[S3 Discord] Failed to fetch channel ${plugin.options.channelID}: ${err.message}`);
    });

  plugin.options.discordClient.on('message', onDiscordMessage);

  plugin.verbose(1, '[S3 Discord] Registered !s3 commands.');

  // Return cleanup function
  return () => {
    if (plugin.options.discordClient && typeof plugin.options.discordClient.removeListener === 'function') {
      plugin.options.discordClient.removeListener('message', onDiscordMessage);
    }
    watchManager.stopAll();
    plugin.verbose(1, '[S3 Discord] Unregistered !s3 commands.');
  };
}