/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               S³ COMMANDS                                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Extracted command handlers, embed builders, and test runners for
 * the !s3 Discord admin surface. Keeps Discord-specific infrastructure
 * (sendDiscordMessage, WatchManager, listener registration) in
 * s3-discord.js.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * createCommandHandlers(context)
 *   Returns { handlers: Map<string, handlerFn>, runDiagnostic }
 *   where handlerFn is (plugin, message, args) => Promise<void>.
 *
 * Utility:  formatDuration, phaseEmoji, circleEmoji, serviceCircle,
 *           checkmark (kept for legacy compat), truncate
 * Embeds:   buildStatusEmbed, buildServicesEmbed, buildGameStateEmbed,
 *           buildFactionsEmbed, buildPlayersEmbed, buildClansEmbed,
 *           buildLocksEmbed, buildConfigEmbed, buildHelpEmbed
 * Tests:    runDiagnostic  (inject sendDiscordMessage)
 *
 * ─── DEPRECATED ─────────────────────────────────────────────────
 *
 * The watch relay feature (!s3 watch / !s3 unwatch) was not useful
 * in production testing and is kept only for reference. Search for
 * the tag "S3_WATCH_DEPRECATED" to find all disabled code blocks.
 *
 * The old two-command test surface (!s3 test preflight + !s3 test smoke)
 * was replaced by a single consolidated !s3 diag command.
 *
 * The !s3 events command was removed in Stage 8.11 — it only captured
 * event names and data key names, not actionable internal state.
 *
 * ─── EMOJI SEMANTICS ─────────────────────────────────────────────
 *
 *  ⚫  Black circle — Disabled / Off / Not configured
 *  🟢  Green circle — Active / OK / Functioning normally
 *  🔴  Red circle   — Broken / Error / Should work but doesn't
 *  🟡  Yellow circle — Transitional / Resolving / In-progress
 *  🟠  Orange circle — Degraded / Needs attention / Partial function
 *  ⚪  White circle  — Unknown / N/A / Indeterminate
 *  🟣  Purple circle — Optional / Auxiliary feature active
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * s3-migration-discord.js — buildMigrationEmbed
 * s3-backup.js           — canBackup, listBackups, restoreBackup
 * s3-export-import.js    — exportToJSON, importFromJSON, etc.
 *
 */
import { buildMigrationEmbed } from './s3-migration-discord.js';
import { canBackup, listBackups, restoreBackup } from './s3-backup.js';
import {
  exportToJSON,
  importFromJSON,
  validateImportStructure,
  serializeForAttachment,
  restoreFromFile,
  exportToFile
} from './s3-export-import.js';

// ============================================================================
// Emoji Utilities
// ============================================================================

/**
 * Map a condition type to the appropriate circle emoji.
 *
 * @param {'mount'|'phase'|'loaded'|'enabled'|'health'|'state'} type
 * @param {*} val - The value to evaluate
 * @returns {string} Circle emoji
 */
export function circleEmoji(type, val) {
  switch (type) {
    // Mount: val = service instance (null/undefined = unmounted)
    case 'mount':
      if (val == null || val === false) return '⚪';    // not created
      if (val._isMounted ?? val.isReady?.() ?? false) return '🟢';  // mounted OK
      return '🔴'; // mount failed

    // Phase: val = phase string
    case 'phase':
      // Shared with phaseEmoji — returns color for each phase
      switch (val) {
        case 'STAGING': return '🟡';
        case 'LIVE': return '🟢';
        case 'ENDGAME': return '🔴';
        default: return '⚪';
      }

    // Loaded: val = boolean (true=loaded successfully)
    case 'loaded':
      if (val === true) return '🟢';
      if (val === false) return '⚫';  // not loaded yet / disabled
      return '⚪';

    // Enabled: val = boolean (true=enabled)
    case 'enabled':
      if (val === true) return '🟢';
      if (val === false) return '⚫';
      return '⚪';

    // Health: val = boolean (true=healthy, false=broken)
    case 'health':
      if (val === true) return '🟢';
      if (val === false) return '🔴';
      return '⚪';

    // State: val = combination ('ok'/'resolving'/'degraded'/'broken'/'disabled')
    case 'state':
      switch (val) {
        case 'ok': return '🟢';
        case 'resolving': return '🟡';
        case 'degraded': return '🟠';
        case 'broken': return '🔴';
        case 'disabled': return '⚫';
        default: return '⚪';
      }

    default:
      return '⚪';
  }
}

/**
 * Convenience: get the appropriate circle for a service instance.
 * Combines mount + loaded/enabled/phase checks into one emoji.
 */
export function serviceCircle(svc) {
  if (svc == null) return '⚪';
  const mounted = svc._isMounted ?? svc.isReady?.() ?? false;
  if (!mounted) return '⚫';

  // Check for loaded/enabled sub-status
  if (typeof svc.isLoadedSuccessfully === 'function') {
    return svc.isLoadedSuccessfully() ? '🟢' : '🟡';
  }
  if (typeof svc.isEnabled === 'function') {
    return svc.isEnabled() ? '🟢' : '⚫';
  }
  if (typeof svc.getPhase === 'function') {
    return phaseEmoji(svc.getPhase());
  }

  return '🟢';
}

// ============================================================================
// Standard Utilities
// ============================================================================

export function formatDuration(ms) {
  const seconds = Math.floor((ms / 1000) % 60);
  const minutes = Math.floor((ms / (1000 * 60)) % 60);
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

export function phaseEmoji(phase) {
  switch (phase) {
    case 'STAGING': return '🟡';
    case 'LIVE': return '🟢';
    case 'ENDGAME': return '🔴';
    default: return '⚪';
  }
}

/**
 * Legacy binary checkmark — kept for callers not yet migrated.
 * Prefer circleEmoji() or serviceCircle() for new code.
 */
export function checkmark(val) {
  return val ? '✅' : '❌';
}

export function truncate(str, maxLen = 1024) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen - 3) + '...' : str;
}

export function formatTimestamp(unixMs) {
  if (!unixMs) return 'N/A';
  return `<t:${Math.floor(unixMs / 1000)}:R>`;
}

// ============================================================================
// Embed Builders
// ============================================================================

export function buildStatusEmbed(plugin) {
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
  const teamsResolved = players?.areTeamsResolved?.() ?? false;
  const initialSync = players?._initialSyncComplete ?? false;
  const isResolving = gs?.isResolving?.() ?? false;

  // Service mount lines with circle emojis — always returns an emoji string
  const mountLines = [];
  const svcEntries = [
    { label: 'ServerConfig', emoji: !sc?._isMounted ? '⚫' : (sc?.isLoadedSuccessfully?.() ? '🟢' : '🟡') },
    { label: 'DB', emoji: db?._isMounted ? '🟢' : '⚫' },
    { label: 'GameState', emoji: gs?._isMounted ? phaseEmoji(gs.getPhase()) : '⚫' },
    { label: 'Factions', emoji: !factions?._isMounted ? '⚫' : (factions._hasBothTeams?.() ? '🟢' : '🟡') },
    { label: 'Clans', emoji: !clans?._isMounted ? '⚫' : (clans.isEnabled?.() ? '🟢' : '⚫') },
    { label: 'Players', emoji: !players?._isMounted ? '⚫' : (initialSync ? '🟢' : '🟡') }
  ];

  for (const { label, emoji } of svcEntries) {
    mountLines.push(`${emoji} **${label}**`);
  }

  const team1Name = factions?.getTeamName?.(1) ?? 'Team 1';
  const team2Name = factions?.getTeamName?.(2) ?? 'Team 2';

  const fields = [
    {
      name: '📋 Services',
      value: mountLines.join('\n'),
      inline: true
    },
    {
      name: '🎮 Game',
      value: [
        `Phase: ${phaseEmoji(phase)} **${phase}**${subState ? ` (${subState})` : ''}`,
        `Mode: **${mode}**`,
        `Layer: **${truncate(layer, 40)}**`,
        isResolving ? `Resolving: 🟡 Yes` : '',
        `MatchId: \`${gs?.getMatchId?.() ?? 'N/A'}\``,
        `Round Start: ${formatTimestamp(gs?.getRoundStartTime?.())}`
      ].filter(Boolean).join('\n'),
      inline: true
    },
    {
      name: '👥 Players & Locks',
      value: [
        `Players: **${playerCount}**`,
        `Teams: ${team1Name} vs ${team2Name}`,
        teamsResolved ? `Teams Resolved: 🟢 Yes` : `Teams Resolved: 🟡 No`,
        `Global Lock: ${globalLockOwner ? `🔒 ${globalLockOwner}` : '🟢 None'}`
      ].join('\n'),
      inline: true
    }
  ];

  if (clans?.isEnabled?.()) {
    fields.push({
      name: '🛡️ Clans',
      value: `🟢 Enabled (min ${clans.options?.minSize ?? 2}, max ${clans.options?.maxSize ?? 18})`,
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

export function buildServicesEmbed(plugin) {
  const services = plugin.services;
  const gs = services.gameState;
  const players = services.players;
  const db = services.db;

  const entries = [];

  // ── serverConfig ──────────────────────────────────────────────
  const sc = services.serverConfig;
  if (!sc || !sc._isMounted) {
    entries.push(`⚪ **ServerConfig** — not mounted`);
  } else {
    const loaded = sc.isLoadedSuccessfully?.() ?? false;
    const path = sc.getConfigPath?.() ?? 'N/A';
    entries.push(`${loaded ? '🟢' : '🟡'} **ServerConfig** — ${loaded ? 'loaded' : 'mounted, no config found'}`);
    entries.push(`   Path: \`${truncate(path, 40)}\``);
    const cfg = sc.getConfig?.() ?? {};
    if (cfg.MaxPlayers) entries.push(`   MaxPlayers: ${cfg.MaxPlayers} | AllowTeamChanges: ${cfg.AllowTeamChanges ?? 'N/A'}`);
  }

  // ── DB ────────────────────────────────────────────────────────
  if (!db || !db._isMounted) {
    entries.push(`⚪ **DB** — not mounted`);
  } else {
    const connector = db.getConnectorName?.() ?? '?';
    const hasPending = (db.getPendingMigrations?.()?.length ?? 0) > 0;
    const connectorStr = connector === 'none' ? '⚫ No connector' : `🟢 ${connector}`;
    entries.push(`🟢 **DB** — ${connectorStr}`);
    entries.push(`   Migrations: ${hasPending ? '🟠 Pending' : '🟢 All current'}`);
    const versionCount = (db._expectedVersions?.size ?? 0);
    if (versionCount > 0) entries.push(`   Schema versions registered: ${versionCount}`);
  }

  // ── GameState ─────────────────────────────────────────────────
  if (!gs || !gs._isMounted) {
    entries.push(`⚪ **GameState** — not mounted`);
  } else {
    const phase = gs.getPhase?.() ?? '?';
    const matchId = gs.getMatchId?.() ?? 'N/A';
    const resolving = gs.isResolving?.() ?? false;
    entries.push(`${circleEmoji('phase', phase)} **GameState** — Phase: ${phase}${resolving ? ' (resolving)' : ''}`);
    entries.push(`   MatchId: \`${matchId}\` | RoundStart: ${formatTimestamp(gs.getRoundStartTime?.())}`);
    const mode = gs.getGamemode?.() ?? 'N/A';
    const layer = gs.getLayerName?.() ?? 'N/A';
    entries.push(`   Mode: ${mode} | Layer: ${truncate(layer, 30)}`);
    entries.push(`   isLive: ${gs.isLive?.() ? '🟢' : '⚫'} | isStaging: ${gs.isStaging?.() ? '🟡' : '⚫'} | isEnding: ${gs.isEnding?.() ? '🔴' : '⚫'}`);
  }

  // ── Factions ─────────────────────────────────────────────────
  const factions = services.factions;
  if (!factions || !factions._isMounted) {
    entries.push(`⚪ **Factions** — not mounted`);
  } else {
    const hasBoth = factions._hasBothTeams?.() ?? false;
    const hasPolling = factions._teamAbbreviationPollingInterval != null;
    const t1 = factions.getTeamName?.(1) ?? 'Team 1';
    const t2 = factions.getTeamName?.(2) ?? 'Team 2';
    entries.push(`${hasBoth ? '🟢' : '🟡'} **Factions** — ${hasBoth ? 'Both teams resolved' : 'Resolving...'}`);
    entries.push(`   ${t1} vs ${t2}`);
    entries.push(`   Polling: ${hasPolling ? '🟢 Running' : '⚫ Stopped'}`);
  }

  // ── Clans ─────────────────────────────────────────────────────
  const clans = services.clans;
  if (!clans || !clans._isMounted) {
    entries.push(`⚪ **Clans** — not mounted`);
  } else {
    const enabled = clans.isEnabled?.() ?? false;
    if (enabled) {
      const groups = clans.extractClanGroups?.(players?.getAllPlayers?.() ?? []) ?? [];
      entries.push(`🟢 **Clans** — ${groups.length} group(s) found (min ${clans.options?.minSize ?? 2}, max ${clans.options?.maxSize ?? 18})`);
    } else {
      entries.push(`⚫ **Clans** — disabled in config`);
    }
  }

  // ── Players ───────────────────────────────────────────────────
  if (!players || !players._isMounted) {
    entries.push(`⚪ **Players** — not mounted`);
  } else {
    const allP = players.getAllPlayers?.() ?? [];
    const initialSync = players._initialSyncComplete ?? false;
    const teamsResolved = players.areTeamsResolved?.() ?? false;
    const projected = players._projectedPlayers !== null;
    entries.push(`${initialSync ? '🟢' : '🟡'} **Players** — ${allP.length} tracked`);
    entries.push(`   Initial Sync: ${initialSync ? '🟢 Complete' : '🟡 Pending'} | Teams: ${teamsResolved ? '🟢 Resolved' : '🟡 Resolving'}`);
    entries.push(`   Projection: ${projected ? '🟡 Active' : '⚫ None'}`);
    const globalLockOwner = players.isGloballyLockedBy?.() ?? null;
    entries.push(`   Global Lock: ${globalLockOwner ? `🔒 ${globalLockOwner}` : '🟢 None'}`);
  }

  return {
    color: 0x2ecc71,
    title: '🔧 S³ Service Status',
    description: entries.join('\n'),
    timestamp: new Date().toISOString()
  };
}

export function buildGameStateEmbed(plugin) {
  const gs = plugin.services.gameState;
  if (!gs) {
    return { color: 0xe74c3c, title: '🔴 GameState Service Not Available' };
  }

  const phase = gs.getPhase?.() ?? 'unknown';
  const sub = gs.getEndgameSubState?.() ?? null;
  const mode = gs.getGamemode?.() ?? 'N/A';
  const layer = gs.getLayerName?.() ?? 'N/A';
  const resolving = gs.isResolving?.() ?? false;
  const matchId = gs.getMatchId?.() ?? 'N/A';
  const roundStartTime = gs.getRoundStartTime?.() ?? null;

  // Detect presence of staging live timer
  const stagingLiveTimerPending = gs._stagingLiveTimer != null;

  const fields = [
    { name: 'Phase', value: `${phaseEmoji(phase)} ${phase}`, inline: true },
    { name: 'Resolving', value: resolving ? '🟡 Yes' : '⚫ No', inline: true },
    { name: '', value: '', inline: true }, // spacer
    { name: 'isLive', value: gs.isLive?.() ? '🟢' : '⚫', inline: true },
    { name: 'isStaging', value: gs.isStaging?.() ? '🟡' : '⚫', inline: true },
    { name: 'isEnding', value: gs.isEnding?.() ? '🔴' : '⚫', inline: true },
    { name: 'Gamemode', value: mode, inline: true },
    { name: 'Layer', value: truncate(layer, 50), inline: true },
    { name: 'isIgnoredMode', value: gs.isIgnoredMode?.() ? '🟡' : '⚫', inline: true },
    { name: 'MatchId', value: `\`${matchId}\``, inline: true },
    { name: 'Round Start', value: formatTimestamp(roundStartTime), inline: true },
    { name: 'Staging Timer', value: stagingLiveTimerPending ? '🟡 Pending' : '⚫ None', inline: true }
  ];

  if (sub) {
    fields.push({ name: 'ENDGAME Sub-State', value: sub, inline: true });
    fields.push({ name: 'isEndgameFactionVote', value: gs.isEndgameFactionVote?.() ? '🟢' : '⚫', inline: true });
    fields.push({ name: 'isEndgameLayerVote', value: gs.isEndgameLayerVote?.() ? '🟢' : '⚫', inline: true });
    fields.push({ name: 'isEndgameScoreboard', value: gs.isEndgameScoreboard?.() ? '🟢' : '⚫', inline: true });
    fields.push({ name: 'isEndgamePostVoting', value: gs.isEndgamePostVoting?.() ? '🟢' : '⚫', inline: true });
  }

  const lastNew = formatTimestamp(gs.lastNewGameAt);
  const lastEnd = formatTimestamp(gs.lastRoundEndedAt);
  fields.push({ name: 'Last NEW_GAME', value: lastNew, inline: true });
  fields.push({ name: 'Last ROUND_ENDED', value: lastEnd, inline: true });

  return {
    color: 0x9b59b6,
    title: '🎮 Game State',
    fields,
    timestamp: new Date().toISOString()
  };
}

export function buildFactionsEmbed(plugin) {
  const factions = plugin.services.factions;
  if (!factions) {
    return { color: 0xe74c3c, title: '🔴 Factions Service Not Available' };
  }

  const team1 = factions.getTeamName?.(1) ?? 'Team 1';
  const team2 = factions.getTeamName?.(2) ?? 'Team 2';
  const cached = factions.getCachedAbbreviations?.() ?? {};
  const hasBoth = factions._hasBothTeams?.() ?? false;
  const hasPolling = factions._teamAbbreviationPollingInterval != null;
  const isResolving = plugin.services.gameState?.isResolving?.() ?? false;

  const stateEmoji = hasBoth ? '🟢' : '🟡';
  const pollingEmoji = hasPolling ? '🟢' : '⚫';
  const gateEmoji = isResolving ? '🟡 Polling gated (resolving flag active)' : '🟢 Free to poll';

  return {
    color: 0xe67e22,
    title: '🎖️ Factions',
    fields: [
      { name: 'Resolution', value: `${stateEmoji} ${hasBoth ? 'Both teams resolved' : 'Resolving...'}`, inline: true },
      { name: 'Team 1', value: team1, inline: true },
      { name: 'Team 2', value: team2, inline: true },
      { name: 'Polling', value: `${pollingEmoji} ${hasPolling ? 'Active' : 'Stopped'}`, inline: true },
      { name: 'Resolving Gate', value: gateEmoji, inline: true },
      { name: 'Cached Abbreviations', value: `\`\`\`json\n${JSON.stringify(cached, null, 2)}\n\`\`\``, inline: false }
    ],
    timestamp: new Date().toISOString()
  };
}

export function buildPlayersEmbed(plugin) {
  const players = plugin.services.players;
  if (!players) {
    return { color: 0xe74c3c, title: '🔴 Players Service Not Available' };
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
    { name: 'Teams Resolved', value: teamsResolved ? '🟢 Yes' : '🟡 No', inline: true },
    { name: 'Initial Sync', value: initialSync ? '🟢 Complete' : '🟡 Pending', inline: true },
    { name: 'Projection Active', value: projected ? '🟡 Yes' : '⚫ No', inline: true }
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

export function buildClansEmbed(plugin) {
  const clans = plugin.services.clans;
  if (!clans) {
    return { color: 0xe74c3c, title: '🔴 Clans Service Not Available' };
  }

  if (!clans.isEnabled?.()) {
    return {
      color: 0x95a5a6,
      title: '🛡️ Clans — ⚫ Disabled',
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

export function buildLocksEmbed(plugin) {
  const players = plugin.services.players;
  if (!players) {
    return { color: 0xe74c3c, title: '🔴 Players Service Not Available' };
  }

  const globalOwner = players.isGloballyLockedBy?.() ?? null;
  const globalLock = players.globalLock ?? null;

  const fields = [
    {
      name: 'Global Lock',
      value: globalOwner
        ? `🔒 **${globalOwner}** (expires ${formatTimestamp(globalLock?.expiresAt ?? 0)})`
        : '🟢 None',
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
      return `**${truncate(name, 20)}**: ${l.source} (exp ${formatTimestamp(l.expiresAt)})`;
    });

    fields.push({
      name: `Per-Player Locks (${activeLocks.length})`,
      value: truncate(lockLines.join('\n'), 1024),
      inline: false
    });
  } else {
    fields.push({
      name: 'Per-Player Locks',
      value: '🟢 None active',
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

export function buildConfigEmbed(plugin) {
  const sc = plugin.services.serverConfig;
  if (!sc) {
    return { color: 0xe74c3c, title: '🔴 ServerConfig Service Not Available' };
  }

  const config = sc.getConfig?.() ?? {};
  const loaded = sc.isLoadedSuccessfully?.() ?? false;
  const path = sc.getConfigPath?.() ?? 'N/A';

  const fields = [
    { name: 'Loaded', value: loaded ? '🟢 Yes' : '🟡 No (mounted but parsing may have failed)', inline: true },
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

export function buildHelpEmbed() {
  return {
    color: 0x3498db,
    title: '📖 S³ Command Reference',
    fields: [
      {
        name: '🔍 Inspection',
        value: [
          '`!s3 status` — Overview: services, phase, players, locks',
          '`!s3 services` — Per-service mount status with detail',
          '`!s3 gamestate` — Detailed game state (phase, matchId, timer)',
          '`!s3 factions` — Team names, abbreviations, polling status',
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
          // S3_WATCH_DEPRECATED — commented out; watch was not useful in testing.
          // '`!s3 watch <service>` — Relay verbose logs [...]',
          // '`!s3 unwatch` — Stop all watches',
          '*(No debug commands available)*'
        ].join('\n'),
        inline: false
      },
      {
        name: '💾 Database',
        value: [
          '`!s3 db status` — Connector type, schema version status per plugin',
          '`!s3 db export` — Export essential tables as JSON',
          '`!s3 db export --logs` — Include event log tables',
          '`!s3 db export --all` — Include all tables (incl. ephemeral)',
          '`!s3 db export --to-file` — Write export to server filesystem (backups/)',
          '`!s3 db import` — Import from attached .s3backup.json',
          '`!s3 db import --confirm [--dry-run]` — Execute or validate import'
        ].join('\n'),
        inline: false
      },
      {
        name: '⚙️ Maintenance',
        value: [
          '`!s3 migrate pending` — Show pending schema migrations',
          '`!s3 migrate status` — Show schema version status per plugin',
          '`!s3 migrate force [--dry-run]` — Run pending migrations',
          '`!s3 backup create` — Create a backup now (JSON, connector-agnostic)',
          '`!s3 backup list` — List backups (SQLite + JSON)',
          '`!s3 backup restore <filename>` — Restore from file backup (auto-detects format)'
        ].join('\n'),
        inline: false
      },
      {
        name: '🧪 Diagnostic',
        value: [
          '`!s3 diag` — Run all service checks (mounts, phase, factions, players, locks)'
        ].join('\n'),
        inline: false
      },
      {
        name: 'ℹ️ Cross-Ref: Existing Plugin Commands',
        value: [
          '`!elo backup / !elo restore` — Elo-only rating export',
          '`!teambalancer export` — Round reports JSONL export'
        ].join('\n'),
        inline: false
      }
    ],
    timestamp: new Date().toISOString()
  };
}

// ============================================================================
// Automated Diagnostic (consolidated — replaces separate preflight + smoke)
// ============================================================================

/**
 * Run a consolidated diagnostic across all S³ services.
 * Combines the old §0 pre-flight checks and §1 smoke tests into a single
 * embed. All checks are read-only.
 *
 * Uses circle emojis for status: 🟢 pass / 🔴 fail / 🟡 transitional / ⚫ disabled
 *
 * @param {object} plugin - S³ plugin instance
 * @param {object} message - Discord message
 * @param {Function} sendDiscordMessage - Message sender
 */
export async function runDiagnostic(plugin, message, sendDiscordMessage) {
  const services = plugin.services;
  const gs = services.gameState;
  const factions = services.factions;
  const players = services.players;
  const results = [];

  // ── Service mounts (circle scheme) ─────────────────────────────
  const allMounted = [
    { label: 'serverConfig', svc: services.serverConfig },
    { label: 'db', svc: services.db },
    { label: 'gameState', svc: services.gameState },
    { label: 'factions', svc: services.factions },
    { label: 'clans', svc: services.clans },
    { label: 'players', svc: services.players }
  ];

  for (const { label, svc } of allMounted) {
    const mounted = svc?._isMounted ?? svc?.isReady?.() ?? false;
    const emoji = mounted ? '🟢' : '⚫';
    const detail = mounted ? 'OK' : 'Not Mounted';

    // Check for disabled vs truly broken
    if (label === 'clans' && mounted && !svc.isEnabled?.()) {
      results.push({ label: `${label} mounted`, emoji: '⚪', detail: 'Mounted but disabled in config' });
    } else {
      results.push({ label: `${label} mounted`, emoji, detail });
    }
  }

  // ── Game state ────────────────────────────────────────────────
  const phase = gs?.getPhase?.() ?? null;
  const phasePass = !!phase;
  const phaseEm = phase === 'LIVE' ? '🟢' : phase === 'STAGING' ? '🟡' : phase === 'ENDGAME' ? '🔴' : phasePass ? '🟢' : '🔴';
  results.push({ label: 'Game phase readable', emoji: phaseEm, detail: `Phase: ${phase ?? 'NULL'}` });

  const mode = gs?.getGamemode?.() ?? 'N/A';
  const modeEm = (mode !== 'Unknown' && mode !== 'N/A') ? '🟢' : '🟠';
  results.push({ label: 'Gamemode resolved', emoji: modeEm, detail: `Mode: ${mode}` });

  const layer = gs?.getLayerName?.() ?? 'N/A';
  const layerEm = (layer !== 'Unknown' && layer !== 'N/A') ? '🟢' : '🟠';
  results.push({ label: 'Layer name resolved', emoji: layerEm, detail: `Layer: ${layer}` });

  // ── Factions ──────────────────────────────────────────────────
  const t1 = factions?.getTeamName?.(1) ?? 'Team 1';
  const t2 = factions?.getTeamName?.(2) ?? 'Team 2';
  const t1Pass = t1 !== 'Team 1';
  const t2Pass = t2 !== 'Team 2';
  results.push({ label: 'Team 1 name resolved', emoji: t1Pass ? '🟢' : '🟡', detail: t1 });
  results.push({ label: 'Team 2 name resolved', emoji: t2Pass ? '🟢' : '🟡', detail: t2 });

  // ── Players ───────────────────────────────────────────────────
  const allPlayers = players?.getAllPlayers?.() ?? [];
  const playerEm = allPlayers.length > 0 ? '🟢' : '⚪';
  results.push({ label: 'Player registry populated', emoji: playerEm, detail: `${allPlayers.length} players tracked` });

  const teamsResolved = players?.areTeamsResolved?.() ?? false;
  results.push({ label: 'Teams resolved', emoji: teamsResolved ? '🟢' : '🟡', detail: teamsResolved ? 'All have teamID 1 or 2' : 'Some still resolving' });

  // ── Lock system ───────────────────────────────────────────────
  const lockFunctional = typeof players?.lockGlobal === 'function' && typeof players?.canAct === 'function';
  results.push({ label: 'Lock system functional', emoji: lockFunctional ? '🟢' : '🔴', detail: lockFunctional ? 'lock/canAct/unlock APIs available' : 'Lock APIs missing' });

  // ── Summary ────────────────────────────────────────────────────
  const passed = results.filter((r) => r.emoji === '🟢').length;
  const total = results.length;
  const allPassed = passed === total;

  const fields = results.map((r) => ({
    name: r.label,
    value: `${r.emoji} ${r.detail}`,
    inline: false
  }));

  fields.push({
    name: allPassed ? '🟢 All Checks Passed' : `⚠️ ${passed}/${total} Passed`,
    value: allPassed
      ? 'S³ services appear healthy.'
      : `${total - passed} check(s) with non-green status. Review the results above.`,
    inline: false
  });

  await sendDiscordMessage(message.channel, {
    embeds: [{
      color: allPassed ? 0x2ecc71 : 0xf39c12,
      title: '🩺 S³ Diagnostic',
      description: 'Consolidated service health check (read-only).\n🟢 OK  🟡 Resolving  ⚫ Disabled  🟠 Degraded  🔴 Broken  ⚪ Unknown',
      fields,
      timestamp: new Date().toISOString()
    }]
  }, 'S3', (...args) => plugin.verbose(...args));
}

// ============================================================================
// Command Handler Factory
// ============================================================================

/**
 * Create a Map of command handlers for !s3 dispatch.
 *
 * @param {object} context
 * @param {Function} context.sendDiscordMessage - Discord message sender
 * @param {WatchManager} context.watchManager - Watch relay instance
 * @param {object} context.stagedImportRef - { current: null|object } for import staging
 * @returns {{ handlers: Map<string, Function>, runDiagnostic: Function }}
 */
export function createCommandHandlers(context) {
  const { sendDiscordMessage, watchManager, stagedImportRef } = context;

  const handlers = new Map();

  // ── Inspection ────────────────────────────────────────────────

  handlers.set('status', async (plugin, message, args) => {
    const embed = buildStatusEmbed(plugin);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  handlers.set('services', async (plugin, message, args) => {
    const embed = buildServicesEmbed(plugin);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  handlers.set('gamestate', async (plugin, message, args) => {
    const embed = buildGameStateEmbed(plugin);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  handlers.set('factions', async (plugin, message, args) => {
    const embed = buildFactionsEmbed(plugin);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  handlers.set('players', async (plugin, message, args) => {
    const embed = buildPlayersEmbed(plugin);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  handlers.set('clans', async (plugin, message, args) => {
    const embed = buildClansEmbed(plugin);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  handlers.set('locks', async (plugin, message, args) => {
    const embed = buildLocksEmbed(plugin);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  handlers.set('config', async (plugin, message, args) => {
    const embed = buildConfigEmbed(plugin);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  // ── Debug ─────────────────────────────────────────────────────

  // S3_WATCH_DEPRECATED — watch relay was not useful in production testing.
  // The WatchManager class still exists in s3-discord.js for reference.
  // If re-enabled, uncomment the two handler registrations below and the
  // watch/unwatch lines in buildHelpEmbed().
  //
  /*
  handlers.set('watch', async (plugin, message, args) => {
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
  });

  handlers.set('unwatch', async (plugin, message, args) => {
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
  });
  */

  // ── Diagnostic ────────────────────────────────────────────────

  handlers.set('diag', async (plugin, message, args) => {
    await runDiagnostic(plugin, message, sendDiscordMessage);
  });

  // ── Migrate ───────────────────────────────────────────────────

  handlers.set('migrate', async (plugin, message, args) => {
    const migrateSub = args[1]?.toLowerCase();

    if (migrateSub === 'pending') {
      const pending = plugin.services.db?.getPendingMigrations() ?? null;
      if (!pending || pending.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x2ecc71, title: '✅ No Pending Migrations', description: 'All plugin schema versions are up to date.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }
      const embed = buildMigrationEmbed(pending, 'pending');
      await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    if (migrateSub === 'status') {
      const db = plugin.services.db;
      const me = db?.migrationEngine;

      if (!db || !me) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: '❌ DB Service Not Available', description: 'The database service has not been initialised.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const versionStatus = await db.verifySchemaVersions();
      const lines = [];
      for (const [pluginName, expectedVersion] of db._expectedVersions) {
        const p = versionStatus.pending.find((x) => x.pluginName === pluginName);
        const current = p ? p.currentVersion : expectedVersion;
        const status = p ? `🟠 v${current} → v${expectedVersion} (${p.behind} behind)` : `🟢 v${current} (current)`;
        lines.push(`**${pluginName}**: ${status}`);
      }
      if (lines.length === 0) lines.push('No plugins have registered schema versions.');

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: versionStatus.upToDate ? 0x2ecc71 : 0xf39c12,
          title: versionStatus.upToDate ? '📋 Schema Status — All Current' : '📋 Schema Status — Pending Migrations',
          description: lines.join('\n'),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    if (migrateSub === 'force') {
      const db = plugin.services.db;
      const me = db?.migrationEngine;
      const pending = db?.getPendingMigrations() ?? null;

      if (!pending || pending.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x2ecc71, title: '✅ No Pending Migrations', description: 'Nothing to force-migrate.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      if (!db || !me) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: '❌ DB Service Not Available', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const isDryRun = args.includes('--dry-run');
      const runningEmbed = buildMigrationEmbed(pending, 'running');
      await sendDiscordMessage(message.channel, { embeds: [runningEmbed] }, 'S3', (...a) => plugin.verbose(...a));

      let totalApplied = 0;
      let totalSkipped = 0;
      let hadError = false;
      let lastError = null;

      for (const p of pending) {
        try {
          const result = await me.runMigrations(p.pluginName, { force: true, dryRun: isDryRun });
          totalApplied += result.applied || 0;
          totalSkipped += result.skipped || 0;
        } catch (err) {
          hadError = true;
          lastError = err.message;
          break;
        }
      }

      if (isDryRun) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x3498db, title: '📋 Dry Run Complete', description: `${totalSkipped} migration(s) would be applied. Run without --dry-run to execute.`, timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      db._resolveMigrationGate(!hadError);

      if (hadError) {
        const failEmbed = buildMigrationEmbed(pending, 'failed', { error: lastError, totalApplied, totalSkipped });
        await sendDiscordMessage(message.channel, { embeds: [failEmbed] }, 'S3', (...a) => plugin.verbose(...a));
      } else {
        const doneEmbed = buildMigrationEmbed(pending, 'complete', { totalApplied, totalSkipped });
        await sendDiscordMessage(message.channel, { embeds: [doneEmbed] }, 'S3', (...a) => plugin.verbose(...a));
      }
      return;
    }

    await message.reply('Usage: `!s3 migrate <pending|status|force [--dry-run]>`');
  });

  // ── Backup ────────────────────────────────────────────────────

  handlers.set('backup', async (plugin, message, args) => {
    const backupSub = args[1]?.toLowerCase();

    if (backupSub === 'list') {
      const backups = listBackups();
      if (backups.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x95a5a6, title: '📦 No Backups Found', description: 'No database backups have been created yet. Use `!s3 backup create` to create one now, or run a migration with `!s3 migrate force` to trigger a backup first.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const lines = backups.map((b, i) => {
        const ageMs = Date.now() - b.timestamp;
        const age = formatDuration(ageMs);
        const formatIcon = b.format === 'json' ? '📄' : b.format === 'sqlite' ? '🗄️' : '📁';
        return `**#${i + 1}** ${formatIcon} \`${b.filename}\` — ${b.sizeFormatted} (${b.age})`;
      });

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0x3498db,
          title: `📦 Database Backups (${backups.length})`,
          description: lines.join('\n'),
          fields: [
            {
              name: '📄 Format Legend',
              value: '🗄️ SQLite file copy | 📄 JSON (connector-agnostic)',
              inline: false
            },
            {
              name: '⚠️ Restore',
              value: 'To restore a backup: `!s3 backup restore <filename>`\nThis will **restore** the database from the backup. Use with extreme caution.',
              inline: false
            }
          ],
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    if (backupSub === 'restore') {
      const isConfirm = args.includes('--confirm');
      const confirmIdx = args.indexOf('--confirm');
      // If --confirm is present, filename is the next arg; otherwise it's args[2]
      const filename = isConfirm ? args[confirmIdx + 1] : args[2];

      if (!filename) {
        const usage = isConfirm
          ? 'Usage: `!s3 backup restore --confirm <filename>`'
          : 'Usage: `!s3 backup restore <filename>`';
        await message.reply(usage + '\nGet the filename from `!s3 backup list`.');
        return;
      }

      // Verify backup exists
      const backups = listBackups();
      const backup = backups.find((b) => b.filename === filename);
      if (!backup) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: '❌ Backup Not Found', description: `No backup named \`${filename}\` exists. Use \`!s3 backup list\` to see available backups.`, timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      if (!isConfirm) {
        // Show confirmation embed
        const me = plugin.services.db?.migrationEngine;
        const dbPath = me?.dbPath;
        const isJsonBackup = filename.endsWith('.json');
        const targetInfo = isJsonBackup
          ? 'database tables (JSON import)'
          : `\`${dbPath || '(unknown)'}\``;

        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xe67e22,
            title: '⚠️ Confirm Database Restore',
            description: `This will **restore** the database from backup \`${filename}\` (${backup.sizeFormatted}, ${backup.age}).`,
            fields: [
              { name: 'Source', value: `\`${filename}\``, inline: true },
              { name: 'Target', value: targetInfo, inline: true },
              { name: 'Format', value: isJsonBackup ? 'JSON (connector-agnostic)' : 'SQLite file copy', inline: true },
              { name: 'Instructions', value: 'To proceed, use:\n`!s3 backup restore --confirm ' + filename + '`', inline: false }
            ],
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // ── --confirm: execute restore ───────────────────────────
      const me = plugin.services.db?.migrationEngine;
      const dbPath = me?.dbPath;
      const db = plugin.services?.db;

      try {
        const result = await restoreFromFile(filename, db, null, dbPath);

        const isJson = filename.endsWith('.json');
        const summary = isJson
          ? `Imported ${Object.values(result.imported || {}).filter((r) => r.status === 'ok').reduce((s, r) => s + r.rows, 0)} rows across ${Object.keys(result.imported || {}).length} tables.`
          : `File restored successfully.`;

        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0x2ecc71,
            title: '✅ Database Restored',
            description: `Successfully restored \`${filename}\`. ${summary}\nRestart SquadJS for changes to be fully picked up by in-memory caches.`,
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xe74c3c,
            title: '❌ Restore Failed',
            description: `**${err.message}**`,
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      }
      return;
    }

    // ── !s3 backup create ─────────────────────────────────────────
    if (backupSub === 'create') {
      const db = plugin.services?.db;
      if (!db?.isReady()) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: '❌ DB Service Not Ready', description: 'The database service is not mounted.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      try {
        const result = await exportToFile(db, null, { tier: 'all', retention: 5 });
        if (!result) {
          await sendDiscordMessage(message.channel, {
            embeds: [{ color: 0xe74c3c, title: '❌ Backup Failed', description: 'Could not create backup. Check disk space and permissions.', timestamp: new Date().toISOString() }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0x2ecc71,
            title: '✅ Backup Created',
            description: `Saved \`${result.filename}\` (${result.sizeBytes} bytes) to \`backups/\` directory.`,
            fields: [{
              name: 'ℹ️',
              value: 'Use `!s3 backup list` to see all available backups.',
              inline: false
            }],
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xe74c3c,
            title: '❌ Backup Failed',
            description: `**${err.message}**`,
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      }
      return;
    }

    await message.reply('Usage: `!s3 backup <create|list|restore [--confirm] <filename>>`');
  });

  // ── Database (db) ─────────────────────────────────────────────

  handlers.set('db', async (plugin, message, args) => {
    const dbSub = args[1]?.toLowerCase();

    // !s3 db (no subcommand) — show help
    if (!dbSub) {
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0x3498db,
          title: '💾 Database Commands',
          description: [
            '`!s3 db status` — Connector type, schema version status per plugin',
            '`!s3 db export` — Export essential (historical) tables as JSON',
            '`!s3 db export --logs` — Include event log tables (player/game-state events)',
            '`!s3 db export --all` — Include all tables (incl. auto-recoverable state)',
            '`!s3 db import` — Import from attached .s3backup.json',
            '`!s3 db import --confirm [--dry-run]` — Execute or validate staged import',
            '',
            'Existing plugin commands (not replaced):',
            '`!elo backup / !elo restore` — Elo-only rating export',
            '`!teambalancer export` — Round reports JSONL export'
          ].join('\n'),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    // ── !s3 db status ────────────────────────────────────────────
    if (dbSub === 'status') {
      const db = plugin.services?.db;
      if (!db?.isReady()) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: '🔴 DB Service Not Ready', description: 'The database service is not mounted.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const connector = db.getConnectorName?.() ?? '?';
      const me = db.migrationEngine;
      const hasPending = (db.getPendingMigrations?.()?.length ?? 0) > 0;
      const expectedCount = db._expectedVersions?.size ?? 0;

      // Build schema version lines
      let schemaLines = 'No plugins have registered schema versions.';
      if (expectedCount > 0) {
        let versionStatus;
        try {
          versionStatus = await db.verifySchemaVersions();
        } catch (e) {
          versionStatus = { upToDate: false, pending: [] };
        }
        schemaLines = [...db._expectedVersions.entries()].map(([pluginName, expectedVersion]) => {
          const p = versionStatus?.pending?.find((x) => x.pluginName === pluginName);
          const current = p ? p.currentVersion : expectedVersion;
          const behind = p ? p.behind : 0;
          const emoji = p ? '🟠' : '🟢';
          const detail = p ? `v${current} → v${expectedVersion} (${behind} behind)` : `v${current} (current)`;
          return `${emoji} **${pluginName}**: ${detail}`;
        }).join('\n');
      }

      const connectorEmoji = connector === 'none' ? '⚫' : '🟢';
      const statusEmoji = hasPending ? '🟠' : '🟢';
      const statusText = hasPending ? 'Pending migrations' : 'All current';

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: hasPending ? 0xf39c12 : 0x2ecc71,
          title: `💾 DB Status — ${statusEmoji} ${statusText}`,
          fields: [
            { name: 'Connector', value: `${connectorEmoji} \`${connector}\``, inline: true },
            { name: 'Schema Versions', value: `🟢 ${expectedCount} registered`, inline: true },
            { name: 'Migrations Engine', value: me ? '🟢 Available' : '⚪ N/A', inline: true },
            { name: 'Per-Plugin Versions', value: schemaLines, inline: false }
          ],
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    // ── !s3 db export [--logs | --all] [--to-file] ────────────
    if (dbSub === 'export') {
      const db = plugin.services?.db;
      if (!db?.isReady()) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: '❌ DB Service Not Ready', description: 'The database service is not mounted.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const hasLogs = args.includes('--logs');
      const hasAll = args.includes('--all');
      const hasToFile = args.includes('--to-file');
      const tier = hasAll ? 'all' : hasLogs ? 'logs' : 'historical';

      // ── --to-file: write to server filesystem ───────────────
      if (hasToFile) {
        try {
          const result = await exportToFile(db, null, { tier, retention: 5 });
          if (!result) {
            await sendDiscordMessage(message.channel, {
              embeds: [{ color: 0xe74c3c, title: '❌ File Export Failed', description: 'Could not write export file. Check disk space and permissions.', timestamp: new Date().toISOString() }]
            }, 'S3', (...a) => plugin.verbose(...a));
            return;
          }
          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: 0x2ecc71,
              title: `✅ Exported to File (${tier})`,
              description: `Saved \`${result.filename}\` (${result.sizeBytes} bytes) to \`backups/\` directory.`,
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));
        } catch (err) {
          await sendDiscordMessage(message.channel, {
            embeds: [{ color: 0xe74c3c, title: '❌ File Export Failed', description: `**${err.message}**`, timestamp: new Date().toISOString() }]
          }, 'S3', (...a) => plugin.verbose(...a));
        }
        return;
      }

      // Show "running" embed
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0x3498db,
          title: '⏳ Exporting...',
          description: `Exporting ${tier} tables. This may take a moment.`,
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));

      try {
        const exportObj = await exportToJSON(db, { tier });

        // Build per-table status lines for embed
        const statusLines = Object.entries(exportObj.results).map(([name, r]) =>
          r.status === 'ok'
            ? `✅ **${name}**: ${r.rows} rows`
            : `❌ **${name}**: ${r.error}`
        );

        // Serialize for Discord attachment
        let attachment;
        try {
          attachment = await serializeForAttachment(exportObj);
        } catch (sizeErr) {
          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: 0xf39c12,
              title: '⚠️ Export Too Large',
              description: sizeErr.message,
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        await message.channel.send({
          embeds: [{
            color: 0x2ecc71,
            title: `✅ Export Complete (${tier})`,
            description: statusLines.join('\n'),
            fields: [{
              name: 'ℹ️',
              value: `Connector: \`${exportObj.connector}\` | Exported at: <t:${Math.floor(exportObj.exportedAt / 1000)}:T>`,
              inline: false
            }],
            timestamp: new Date().toISOString()
          }],
          files: [{
            attachment: attachment.buffer,
            name: attachment.filename
          }]
        });
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xe74c3c,
            title: '❌ Export Failed',
            description: `**${err.message}**`,
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      }
      return;
    }

    // ── !s3 db import ─────────────────────────────────────────
    if (dbSub === 'import') {
      const db = plugin.services?.db;
      if (!db?.isReady()) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: '❌ DB Service Not Ready', description: 'The database service is not mounted.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const isConfirm = args.includes('--confirm');
      const isDryRun = args.includes('--dry-run');

      // ── !s3 db import --confirm [--dry-run] ──────────────────
      if (isConfirm) {
        if (!stagedImportRef.current) {
          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: 0xf39c12,
              title: '⚠️ No Staged Import',
              description: 'No import has been staged. First attach a `.s3backup.json` file: `!s3 db import` (with attachment).',
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        try {
          const result = await importFromJSON(db, stagedImportRef.current, { dryRun: isDryRun });

          const statusLines = Object.entries(result.imported).map(([name, r]) =>
            r.status === 'ok'
              ? `✅ **${name}**: ${r.rows} rows${r.dryRun ? ' (dry run)' : ''}`
              : `❌ **${name}**: ${r.error}`
          );

          const summary = isDryRun
            ? `Dry run complete — would import rows across ${Object.keys(result.imported).length} tables.`
            : `Imported ${Object.values(result.imported).filter((r) => r.status === 'ok').reduce((s, r) => s + r.rows, 0)} rows across ${Object.keys(result.imported).length} tables. Restart SquadJS for changes to be fully picked up.`;

          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: isDryRun ? 0x3498db : 0x2ecc71,
              title: isDryRun ? '📋 Dry Run Complete' : '✅ Import Complete',
              description: statusLines.join('\n'),
              fields: result.errors.length > 0
                ? [{ name: '⚠️ Warnings', value: result.errors.join('\n'), inline: false }]
                : [],
              footer: { text: summary },
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));

          if (!isDryRun) {
            stagedImportRef.current = null; // Clear after execution
          }
        } catch (err) {
          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: 0xe74c3c,
              title: '❌ Import Failed',
              description: `**${err.message}**`,
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));
        }
        return;
      }

      // ── !s3 db import (with or without attachment) ──────────
      const attachment = message.attachments?.first();
      if (!attachment) {
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xf39c12,
            title: '⚠️ No Import File',
            description: 'Attach a `.s3backup.json` or `.json` file to this command.\n\nUsage: `!s3 db import` (with file attached) → review confirmation embed → `!s3 db import --confirm` to execute.',
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // Download and parse attachment
      try {
        const response = await fetch(attachment.url);
        const buffer = await response.arrayBuffer();
        let content = Buffer.from(buffer).toString('utf8');

        // Gunzip if needed
        if (attachment.name?.endsWith('.gz') || attachment.contentType === 'application/gzip') {
          const zlib = await import('node:zlib');
          content = zlib.gunzipSync(Buffer.from(buffer)).toString('utf8');
        }

        const parsed = JSON.parse(content);

        // Validate structure
        const modelNames = db.getModelNames();
        const validation = await validateImportStructure(parsed, modelNames);

        if (!validation.valid) {
          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: 0xe74c3c,
              title: '❌ Invalid Import File',
              description: validation.errors.join('\n'),
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        // Stage the import
        stagedImportRef.current = parsed;

        const tableCount = Object.keys(parsed.tables).length;
        const totalRows = Object.values(parsed.rowCounts || {}).reduce((s, c) => s + c, 0);

        // Build per-table preview
        const previewLines = Object.entries(parsed.results || {}).map(([name, r]) =>
          r.status === 'ok'
            ? `✅ **${name}**: ${r.rows} rows`
            : `❌ **${name}**: ${r.error}`
        );

        const warnLines = validation.warnings.map((w) => `⚠️ ${w}`);

        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xf39c12,
            title: '⚠️ Confirm Import',
            description: [
              `**${tableCount} tables**, ~${totalRows} total rows`,
              '',
              ...previewLines,
              ...warnLines,
              '',
              'To proceed, use: `!s3 db import --confirm`',
              'For a dry run (validate only): `!s3 db import --confirm --dry-run`',
              'Imported tables are upserted by primary key. No existing rows are deleted.'
            ].join('\n'),
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xe74c3c,
            title: '❌ Import Parse Failed',
            description: `**${err.message}**`,
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      }
      return;
    }

    // Unknown !s3 db subcommand
    await message.reply('Usage: `!s3 db <status|export [--logs|--all] | import [--confirm] [--dry-run]>`');
  });

  // ── Help / Default ────────────────────────────────────────────

  handlers.set('help', async (plugin, message, args) => {
    const embed = buildHelpEmbed();
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  return {
    handlers,
    runDiagnostic: (plugin, message) => runDiagnostic(plugin, message, sendDiscordMessage)
  };
}