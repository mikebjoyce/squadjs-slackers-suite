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
 *           buildFactionsEmbed, buildLocksEmbed, buildConfigEmbed,
 *           buildHelpEmbed
 * Embed sets (return an array — one Discord message, several embeds):
 *           buildPlayersEmbeds, buildClansEmbeds
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
 * The !s3 events command was removed — it only captured
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
  exportToFile,
  formatSize
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
  // Display spelling ("Sumari Bala Seed v1"), not the canonical classname S³
  // stores and compares on. getLayerDisplayName() falls back to the canonical
  // name, so the ?? chain only matters for a gameState that predates it.
  const layer = gs?.getLayerDisplayName?.() ?? gs?.getLayerName?.() ?? 'N/A';
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
    let connectorStr;
    if (connector === 'none') {
      connectorStr = '⚫ No connector';
    } else {
      // Check schema drift status
      const drift = db.getLastDriftResult?.();
      if (drift == null) {
        connectorStr = `🟢 ${connector}`; // no check run yet — assume OK
      } else if (drift.length === 0) {
        connectorStr = `🟢 ${connector} — No schema drift`;
      } else if (drift.some(e => e.error)) {
        connectorStr = `🔴 ${connector} — Cannot verify schema`;
      } else {
        // Drift detected — summarise
        const tableCount = drift.length;
        const missingCols = drift.filter(e => e.missing).length;
        const extraCols = drift.filter(e => e.extra).length;
        const parts = [];
        if (missingCols > 0) parts.push(`${missingCols} table(s) missing columns`);
        if (extraCols > 0) parts.push(`${extraCols} table(s) with extra columns`);
        connectorStr = `🟠 ${connector} — Schema drift: ${parts.join(', ')}`;
      }
    }
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
    const layer = gs.getLayerDisplayName?.() ?? gs.getLayerName?.() ?? 'N/A';
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
      const groups = clans.extractClanGroups?.(players?.getAllPlayers?.() ?? []) ?? {};
      const groupCount = Object.keys(groups).length;
      entries.push(`🟢 **Clans** — ${groupCount} group(s) found (min ${clans.options?.minSize ?? 2}, max ${clans.options?.maxSize ?? 18})`);
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
  const layer = gs.getLayerDisplayName?.() ?? gs.getLayerName?.() ?? 'N/A';
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
    // ⚠️ marks a layer S³ has not actually resolved yet (the 'Unknown'
    // placeholder), so operators can tell it apart from a real layer name.
    { name: 'Layer', value: `${gs.isLayerResolved?.() === false ? '⚠️ ' : ''}${truncate(layer, 50)}`, inline: true },
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

/**
 * Push a list of lines as one or more embed fields, respecting Discord's
 * 1024-character-per-field-value cap. Overflow spills into `name (cont.)`
 * fields up to `maxFields`; anything beyond that is summarised as a count.
 *
 * @param {Array} fields - Field array to append to (mutated).
 * @param {string} name - Field name for the first chunk.
 * @param {string[]} lines - Lines to render.
 * @param {object} [opts]
 * @param {number} [opts.maxFields=3] - Max fields to spend on this list.
 * @param {boolean} [opts.inline=false]
 */
function pushLineField(fields, name, lines, opts = {}) {
  const { maxFields = 3, inline = false } = opts;
  if (!lines?.length) return;

  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const line of lines) {
    // +1 for the joining newline.
    if (currentLen + line.length + 1 > 1024 && current.length > 0) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);

  const shown = chunks.slice(0, maxFields);
  shown.forEach((chunk, i) => {
    fields.push({
      name: i === 0 ? name : `${truncate(name, 240)} (cont.)`,
      value: truncate(chunk.join('\n'), 1024),
      inline
    });
  });

  const droppedLines = chunks.slice(maxFields).reduce((n, c) => n + c.length, 0);
  if (droppedLines > 0) {
    fields.push({
      name: `${truncate(name, 230)} (cont.)`,
      value: `*…and ${droppedLines} more (output truncated).*`,
      inline: false
    });
  }
}

/**
 * Escape Discord markdown control characters in untrusted text.
 *
 * Player names and clan tags routinely contain these — `extractRawPrefix()`
 * treats `|` and `*` as tag separators, so names like `TAG | Player` and
 * `[*ACE*] Player` are common. Left raw they corrupt the surrounding embed
 * formatting. Truncate before escaping so a backslash is never left dangling.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeMarkdown(str) {
  return String(str ?? '').replace(/([\\*_`~|>])/g, '\\$1');
}

/**
 * Format one player line for the team embeds.
 *
 * @param {object} p - Player state from PlayersService.
 * @param {object} players - PlayersService instance (for lock lookup).
 * @param {boolean} [asLeader=false] - Render with the squad-leader marker.
 * @returns {string}
 */
function formatPlayerLine(p, players, asLeader = false) {
  const marker = asLeader ? '👑' : '·';
  const lockOwner = players.isLockedBy?.(p.eosID || p.steamID);
  const lockStr = lockOwner ? ` 🔒${truncate(String(lockOwner), 14)}` : '';
  return `${marker} ${escapeMarkdown(truncate(p.name ?? p.eosID ?? '?', 26))}${lockStr}`;
}

/**
 * Build the `!s3 players` embed set: a meta/population embed followed by one
 * embed per team, each broken down by squad with squad leaders marked.
 *
 * Returned as an array because Discord caps a single embed at 6000 characters
 * and 25 fields — a full 100-player server does not fit in one.
 *
 * @param {object} plugin - The S³ plugin instance.
 * @returns {object[]} Array of Discord embed objects.
 */
export function buildPlayersEmbeds(plugin) {
  const players = plugin.services.players;
  if (!players) {
    return [{ color: 0xe74c3c, title: '🔴 Players Service Not Available' }];
  }

  const all = players.getAllPlayers?.() ?? [];
  const squads = players.getSquads?.() ?? [];
  const teamsResolved = players.areTeamsResolved?.() ?? false;
  const projected = players._projectedPlayers !== null;
  const initialSync = players._initialSyncComplete ?? false;

  const byEosID = new Map();
  for (const p of all) {
    if (p?.eosID) byEosID.set(p.eosID, p);
  }

  const team1 = all.filter((p) => p.teamID === 1);
  const team2 = all.filter((p) => p.teamID === 2);

  // Every connected player in Squad is on team 1 or 2 — there is no teamless
  // state in-game. A null teamID here is therefore a *tracking* gap, not a
  // player state: either initial sync is still running or we are inside the
  // null-teamID window that follows NEW_GAME. Surfaced as a warning, not as a
  // population bucket.
  const unresolved = all.filter((p) => p.teamID !== 1 && p.teamID !== 2);

  // PlayersService only snapshots server.squads on a tick where every player
  // has a resolved teamID, so _squadsCache is null until the first such tick.
  // Until then getSquads() returns [] — which is indistinguishable from "nobody
  // is in a squad" unless we check. Reporting 0 squads in that window would be
  // the same mistake as treating a null teamID as a real player state.
  const squadDataPending = players._squadsCache == null;

  // "Unassigned" = not in a squad (the community term). Squad membership is
  // derived from getSquads() rather than from p.squadID so a stale squad cache
  // cannot silently hide players from the roster.
  const inSquadIDs = new Set();
  for (const s of squads) {
    for (const id of s.players ?? []) inSquadIDs.add(id);
  }

  const squadsForTeam = (teamID) => squads
    .filter((s) => Number(s.teamID) === teamID)
    .sort((a, b) => Number(a.squadID) - Number(b.squadID));

  const factions = plugin.services.factions;
  const teamLabel = (teamID) => {
    const name = factions?.getTeamName?.(teamID);
    return name && name !== `Team ${teamID}` ? `${name}` : `Team ${teamID}`;
  };

  // ── Meta embed ──────────────────────────────────────────────────
  const gs = plugin.services.gameState;
  const phase = gs?.getPhase?.() ?? 'unknown';
  const layer = gs?.getLayerDisplayName?.() ?? gs?.getLayerName?.() ?? 'N/A';

  const globalOwner = players.isGloballyLockedBy?.() ?? null;
  const playerLocks = players.playerLocks ?? new Map();
  const activeLockCount = [...playerLocks.values()].filter((l) => l.expiresAt > Date.now()).length;

  const delta = team1.length - team2.length;
  const deltaStr = delta === 0
    ? '⚖️ Even'
    : `${delta > 0 ? 'Team 1' : 'Team 2'} +${Math.abs(delta)}`;

  const metaFields = [
    { name: '👥 Population', value: `**${all.length}** tracked`, inline: true },
    {
      name: `🟦 ${truncate(teamLabel(1), 200)}`,
      value: `**${team1.length}** in ${squadsForTeam(1).length} squad(s)`,
      inline: true
    },
    {
      name: `🟥 ${truncate(teamLabel(2), 200)}`,
      value: `**${team2.length}** in ${squadsForTeam(2).length} squad(s)`,
      inline: true
    },
    { name: 'Balance', value: deltaStr, inline: true },
    {
      name: 'Unassigned',
      value: squadDataPending ? '⚪ Unknown' : `${all.length - inSquadIDs.size} not in a squad`,
      inline: true
    },
    { name: 'Teams Resolved', value: teamsResolved ? '🟢 Yes' : '🟡 No', inline: true },
    { name: 'Initial Sync', value: initialSync ? '🟢 Complete' : '🟡 Pending', inline: true },
    { name: 'Projection', value: projected ? '🟡 Active' : '⚫ None', inline: true },
    {
      name: '🔒 Locks',
      value: [
        globalOwner ? `Global: 🔒 **${globalOwner}**` : 'Global: 🟢 None',
        `Per-player: ${activeLockCount} active`
      ].join(' · '),
      inline: false
    }
  ];

  if (squadDataPending) {
    metaFields.push({
      name: '⚠️ Squad Data Pending',
      value: 'S³ has not snapshotted `server.squads` yet — it only does so on a tick '
        + 'where every player has a resolved teamID. Rosters below are flat until then.',
      inline: false
    });
  }

  if (unresolved.length > 0) {
    metaFields.push({
      name: `⚠️ Team Unresolved (${unresolved.length})`,
      value: 'S³ has no teamID for these players yet — initial sync or the '
        + 'post-`NEW_GAME` null window. Not a game state; it should clear on its own.',
      inline: false
    });
    pushLineField(
      metaFields,
      'Awaiting teamID',
      unresolved.map((p) => formatPlayerLine(p, players)),
      { maxFields: 1 }
    );
  }

  const embeds = [{
    color: 0x1abc9c,
    title: '👥 Players — Overview',
    description: `Phase **${phaseEmoji(phase)} ${phase}** · Layer \`${truncate(layer, 60)}\``,
    fields: metaFields,
    timestamp: new Date().toISOString()
  }];

  // ── Per-team embeds ─────────────────────────────────────────────
  const buildTeamEmbed = (teamID, teamPlayers, color, emoji) => {
    const teamSquads = squadsForTeam(teamID);
    const fields = [];

    for (const s of teamSquads) {
      const members = (s.players ?? [])
        .map((id) => byEosID.get(id))
        .filter(Boolean);
      if (members.length === 0) continue;

      // getSquads() returns leaders first, so the head of the list is the SL.
      const lines = members.map((p) => formatPlayerLine(p, players, p.isLeader === true));
      const lockIcon = s.locked ? ' 🔒' : '';
      const name = `#${s.squadID} · ${truncate(s.squadName || 'Unnamed', 40)} (${members.length})${lockIcon}`;

      pushLineField(fields, name, lines, { maxFields: 2, inline: true });
    }

    const leftover = teamPlayers.filter((p) => !inSquadIDs.has(p.eosID));
    if (leftover.length > 0) {
      // Without a squad snapshot these players are not known to be squadless —
      // we simply have no squad data for them yet. Label accordingly.
      const label = squadDataPending
        ? `Roster (${leftover.length}) — squad data pending`
        : `Unassigned (${leftover.length})`;
      pushLineField(
        fields,
        label,
        leftover.map((p) => formatPlayerLine(p, players)),
        { maxFields: 2 }
      );
    }

    if (fields.length === 0) {
      fields.push({ name: 'Roster', value: '*No players on this team.*', inline: false });
    }

    // Discord hard-caps an embed at 25 fields.
    const trimmed = fields.slice(0, 24);
    if (fields.length > trimmed.length) {
      trimmed.push({
        name: 'Truncated',
        value: `*${fields.length - trimmed.length} more field(s) omitted — Discord embed limit.*`,
        inline: false
      });
    }

    return {
      color,
      title: `${emoji} ${truncate(teamLabel(teamID), 200)} — ${teamPlayers.length} player(s), ${teamSquads.length} squad(s)`,
      fields: trimmed
    };
  };

  embeds.push(buildTeamEmbed(1, team1, 0x3498db, '🟦'));
  embeds.push(buildTeamEmbed(2, team2, 0xe74c3c, '🟥'));

  return embeds;
}

/**
 * Build the `!s3 clans` embed set: the surviving clan groups plus a full
 * account of why every other candidate tag was excluded or merged.
 *
 * @param {object} plugin - The S³ plugin instance.
 * @returns {object[]} Array of Discord embed objects.
 */
export function buildClansEmbeds(plugin) {
  const clans = plugin.services.clans;
  if (!clans) {
    return [{ color: 0xe74c3c, title: '🔴 Clans Service Not Available' }];
  }

  if (!clans.isEnabled?.()) {
    return [{
      color: 0x95a5a6,
      title: '🛡️ Clans — ⚫ Disabled',
      description: 'Clan tag grouping is not enabled in S³ configuration.'
    }];
  }

  const players = plugin.services.players?.getAllPlayers?.() ?? [];

  // explainClanGroups() runs the identical pipeline to extractClanGroups(),
  // so what is displayed here is exactly what SmartAssign and TeamBalancer see.
  if (typeof clans.explainClanGroups !== 'function') {
    return [{
      color: 0xe74c3c,
      title: '🔴 Clans Service Outdated',
      description: 'This S³ build predates `explainClanGroups()` — cannot render exclusion detail.'
    }];
  }

  const { groups, trace, options } = clans.explainClanGroups(players);

  // Clan tags are only alphanumeric when caseSensitive is false; with it on the
  // raw tag is used verbatim and can carry markdown characters, as can any name.
  const nameOf = (id) => escapeMarkdown(truncate(trace.memberNames.get(id) ?? id, 18));
  const tagOf = (tag) => escapeMarkdown(truncate(String(tag), 24));
  const memberList = (ids, cap = 6) => {
    const shown = ids.slice(0, cap).map(nameOf).join(', ');
    return ids.length > cap ? `${shown}, +${ids.length - cap} more` : shown;
  };

  // Resolve merge chains so an absorbed tag reports the group it ended up in,
  // not just its immediate absorber (A→B→C must report C).
  const absorbedInto = new Map();
  for (const m of trace.merged) absorbedInto.set(m.absorbed, m.keep);
  const finalTag = (tag) => {
    let cur = tag;
    const seen = new Set([cur]);
    while (absorbedInto.has(cur)) {
      cur = absorbedInto.get(cur);
      if (seen.has(cur)) break;
      seen.add(cur);
    }
    return cur;
  };

  const groupEntries = Object.entries(groups).sort(([, a], [, b]) => b.length - a.length);
  const groupedPlayerCount = groupEntries.reduce((n, [, ids]) => n + ids.length, 0);
  const excludedCount = trace.ignored.length + trace.sizeExcluded.length;

  // ── Summary embed ───────────────────────────────────────────────
  const summaryFields = [
    { name: 'Players Scanned', value: `${trace.scanned}`, inline: true },
    { name: 'Groups Active', value: `🟢 ${groupEntries.length}`, inline: true },
    { name: 'Tags Excluded', value: excludedCount ? `🟠 ${excludedCount}` : '⚫ 0', inline: true },
    { name: 'Players Grouped', value: `${groupedPlayerCount}`, inline: true },
    { name: 'No Tag Detected', value: `${trace.noTag.length}`, inline: true },
    { name: 'Tags Merged', value: trace.merged.length ? `🟣 ${trace.merged.length}` : '⚫ 0', inline: true },
    {
      name: '⚙️ Grouping Config',
      value: [
        `minSize: \`${options.minSize}\` · maxSize: \`${options.maxSize}\``,
        `maxEditDistance: \`${options.maxEditDistance}\` · caseSensitive: \`${options.caseSensitive}\``,
        `recruitSuffixes: \`${options.recruitSuffixes.length ? options.recruitSuffixes.join(', ') : 'none'}\``,
        `ignoreList: \`${options.ignoreList.length ? options.ignoreList.join(', ') : 'none'}\``
      ].join('\n'),
      inline: false
    }
  ];

  if (groupEntries.length > 0) {
    pushLineField(
      summaryFields,
      `🛡️ Active Clan Groups (${groupEntries.length})`,
      groupEntries.map(([tag, ids]) => `**${tagOf(tag)}** (${ids.length}) — ${memberList(ids)}`),
      { maxFields: 3 }
    );
  } else {
    summaryFields.push({
      name: '🛡️ Active Clan Groups',
      value: '*None survived the grouping pipeline.*',
      inline: false
    });
  }

  const embeds = [{
    color: 0xf1c40f,
    title: '🛡️ Clan Groups',
    description: 'Pipeline order: extract → strip recruit suffix → normalize → '
      + 'ignoreList → Levenshtein merge → size bounds.',
    fields: summaryFields,
    timestamp: new Date().toISOString()
  }];

  // ── Exclusions & merges embed ───────────────────────────────────
  const detailFields = [];

  if (trace.sizeExcluded.length > 0) {
    const lines = [...trace.sizeExcluded]
      .sort((a, b) => b.size - a.size)
      .map((e) => {
        const why = e.reason === 'minSize'
          ? `below minSize \`${e.bound}\``
          : `above maxSize \`${e.bound}\``;
        const merged = trace.merged.some((m) => m.keep === e.tag)
          ? ' *(post-merge)*'
          : '';
        return `**${tagOf(e.tag)}** (${e.size}) — ${why}${merged} — ${memberList(e.members, 4)}`;
      });
    pushLineField(detailFields, `📏 Excluded by Size (${trace.sizeExcluded.length})`, lines, { maxFields: 2 });
  }

  if (trace.ignored.length > 0) {
    const lines = trace.ignored.map(
      (e) => `**${tagOf(e.tag)}** (${e.size}) — on \`ignoreList\` — ${memberList(e.members, 4)}`
    );
    pushLineField(detailFields, `🚫 Excluded by Config (${trace.ignored.length})`, lines, { maxFields: 2 });
  }

  if (trace.merged.length > 0) {
    // Collapse to one line per surviving group: ACE ⟵ AC3 (d1), ACES (d1)
    const byKeep = new Map();
    for (const m of trace.merged) {
      const dest = finalTag(m.keep);
      if (!byKeep.has(dest)) byKeep.set(dest, []);
      byKeep.get(dest).push(`${tagOf(m.absorbed)} (d${m.distance})`);
    }
    const lines = [...byKeep.entries()].map(([dest, sources]) => {
      const alive = Object.prototype.hasOwnProperty.call(groups, dest) ? '' : ' *(later excluded)*';
      return `**${tagOf(dest)}**${alive} ⟵ ${sources.join(', ')}`;
    });
    pushLineField(
      detailFields,
      `🔗 Merged by Levenshtein ≤ ${options.maxEditDistance} (${trace.merged.length})`,
      lines,
      { maxFields: 2 }
    );
  }

  if (trace.recruitStripped.length > 0) {
    const byRule = new Map();
    for (const r of trace.recruitStripped) {
      // Escaped rather than wrapped in a code span: a backtick in a raw tag
      // would terminate the span and mangle the rest of the field.
      const key = `${tagOf(r.from)} → ${tagOf(r.to)}`;
      byRule.set(key, (byRule.get(key) ?? 0) + 1);
    }
    pushLineField(
      detailFields,
      `🎓 Recruit Suffix Stripped (${trace.recruitStripped.length})`,
      [...byRule.entries()].map(([rule, n]) => `**${rule}** — ${n} player(s)`),
      { maxFields: 1 }
    );
  }

  if (trace.unnormalizable.length > 0) {
    pushLineField(
      detailFields,
      `⚪ Tag Normalized to Empty (${trace.unnormalizable.length})`,
      trace.unnormalizable.map((e) => `**${tagOf(e.raw)}** — ${nameOf(e.eosID)}`),
      { maxFields: 1 }
    );
  }

  if (trace.noTag.length > 0) {
    detailFields.push({
      name: `⚫ No Tag Detected (${trace.noTag.length})`,
      value: truncate(
        `${trace.noTag.slice(0, 12).map((e) => truncate(e.name, 18)).join(', ')}`
        + (trace.noTag.length > 12 ? `, +${trace.noTag.length - 12} more` : ''),
        1024
      ),
      inline: false
    });
  }

  if (trace.skipped.length > 0) {
    detailFields.push({
      name: '⚠️ Skipped (missing name or eosID)',
      value: `${trace.skipped.length} record(s) — these never reach clan grouping.`,
      inline: false
    });
  }

  if (detailFields.length > 0) {
    embeds.push({
      color: 0xe67e22,
      title: '🔍 Clan Grouping — Exclusions & Merges',
      fields: detailFields.slice(0, 25)
    });
  }

  return embeds;
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
          '`!s3 players` — Population overview + per-team squad rosters',
          '`!s3 clans` — Clan groups, plus why tags were excluded or merged',
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
          '`!s3 confirm <token>` — Confirm and run pending migrations from startup prompt',
          '`!s3 migrate force [--dry-run]` — Run pending migrations',
          '`!s3 migrate preview` — Preview pending migration descriptions/touches',
          '`!s3 migrate verify` — Run on-demand schema drift check',
          '`!s3 migrate purge-deprecated` — Clean up deprecated tables/columns',
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

    // DB-specific: add schema drift diagnostic line
    if (label === 'db' && mounted) {
      const drift = svc.getLastDriftResult?.();
      if (drift !== null && drift !== undefined) {
        if (drift.length === 0) {
          results.push({ label: 'DB schema drift', emoji: '🟢', detail: 'No drift detected' });
        } else if (drift.some(e => e.error)) {
          results.push({ label: 'DB schema drift', emoji: '🔴', detail: 'Cannot verify — describeTable failed' });
        } else {
          const issueCount = drift.length;
          const missingCount = drift.filter(e => e.missing).length;
          const extraCount = drift.filter(e => e.extra).length;
          let detail;
          if (missingCount > 0 && extraCount > 0) {
            detail = `${issueCount} table(s) with drift (${missingCount} missing cols, ${extraCount} extra cols)`;
          } else if (missingCount > 0) {
            detail = `${issueCount} table(s) with missing columns`;
          } else {
            detail = `${issueCount} table(s) with extra columns`;
          }
          results.push({ label: 'DB schema drift', emoji: '🟠', detail });
        }
      }
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
    const embeds = buildPlayersEmbeds(plugin);
    await sendDiscordMessage(message.channel, { embeds }, 'S3', (...a) => plugin.verbose(...a));
  });

  handlers.set('clans', async (plugin, message, args) => {
    const embeds = buildClansEmbeds(plugin);
    await sendDiscordMessage(message.channel, { embeds }, 'S3', (...a) => plugin.verbose(...a));
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
      const db = plugin.services.db;
      const vs = db ? await db.verifySchemaVersions() : null;
      const pending = vs?.pending ?? null;
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
      const vs = db ? await db.verifySchemaVersions() : null;
      const pending = vs?.pending ?? null;

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

      // '__force__' satisfies the engine's confirmation gate — the admin
      // explicitly typing !s3 migrate force IS the confirmation.
      me.confirmToken('__force__');

      let totalApplied = 0;
      let totalSkipped = 0;
      let hadError = false;
      let lastError = null;

      for (const p of pending) {
        try {
          const result = await me.runMigrations(p.pluginName, { dryRun: isDryRun });
          totalApplied += result.applied || 0;
          totalSkipped += result.skipped || 0;
        } catch (err) {
          hadError = true;
          lastError = err.message;
          break;
        }
      }

      if (isDryRun) {
        // Build enriched dry-run output from registered migration metadata
        const lines = [];
        for (const p of pending) {
          const registered = me._migrations.get(p.pluginName);
          if (!registered || registered.length === 0) continue;

          const pendingMigrations = registered.filter((m) => m.version > p.currentVersion);
          if (pendingMigrations.length === 0) continue;

          lines.push(`**${p.pluginName}** (v${p.currentVersion} → v${p.expectedVersion}):`);
          for (const m of pendingMigrations) {
            const desc = m.description || '(no description)';
            lines.push(`  **v${m.version}** — ${desc}`);

            if (m.touches) {
              if (m.touches.creates && m.touches.creates.length > 0) {
                for (const tableName of m.touches.creates) {
                  lines.push(`    ↳ Creates table: \`${tableName}\``);
                  if (m.touches.columns?.[tableName]) {
                    lines.push(`    ↳ Columns: ${m.touches.columns[tableName].map((c) => `\`${c}\``).join(', ')}`);
                  }
                }
              }
              if (m.touches.columns) {
                for (const [tableName, cols] of Object.entries(m.touches.columns)) {
                  if (!m.touches.creates || !m.touches.creates.includes(tableName)) {
                    lines.push(`    ↳ Columns (\`${tableName}\`): ${cols.map((c) => `\`${c}\``).join(', ')}`);
                  }
                }
              }
            }
          }
          lines.push(''); // blank line between plugin sections
        }

        if (lines.length === 0) {
          await sendDiscordMessage(message.channel, {
            embeds: [{ color: 0xf39c12, title: '📋 Dry Run Complete', description: 'No preview data available — pending migrations exist but lack description/touches metadata.', timestamp: new Date().toISOString() }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x3498db, title: '📋 Dry Run Complete', description: lines.join('\n') + `\nRun without \`--dry-run\` to execute ${totalSkipped} migration(s).`, timestamp: new Date().toISOString() }]
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

    // ═══════════════════════════════════════════════════════════════
    // preview — Show pending migration descriptions and touches
    // ═══════════════════════════════════════════════════════════════
    if (migrateSub === 'preview') {
      const db = plugin.services.db;
      const me = db?.migrationEngine;
      const vs = db ? await db.verifySchemaVersions() : null;
      const pending = vs?.pending ?? null;

      if (!db || !me) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: '❌ DB Service Not Available', description: 'The database service has not been initialised.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      if (!pending || pending.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x2ecc71, title: '✅ No Pending Migrations', description: 'All plugin schema versions are up to date.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // Build preview lines from registered migration metadata (description + touches)
      const lines = [];
      for (const p of pending) {
        const registered = me._migrations.get(p.pluginName);
        if (!registered || registered.length === 0) continue;

        const pendingMigrations = registered.filter((m) => m.version > p.currentVersion);
        if (pendingMigrations.length === 0) continue;

        lines.push(`**${p.pluginName}** (v${p.currentVersion} → v${p.expectedVersion}):`);
        for (const m of pendingMigrations) {
          const desc = m.description || '(no description)';
          lines.push(`  **v${m.version}** — ${desc}`);

          if (m.touches) {
            if (m.touches.creates && m.touches.creates.length > 0) {
              for (const tableName of m.touches.creates) {
                lines.push(`    ↳ Creates table: \`${tableName}\``);
                if (m.touches.columns?.[tableName]) {
                  lines.push(`    ↳ Columns: ${m.touches.columns[tableName].map((c) => `\`${c}\``).join(', ')}`);
                }
              }
            }
            if (m.touches.columns) {
              for (const [tableName, cols] of Object.entries(m.touches.columns)) {
                if (!m.touches.creates || !m.touches.creates.includes(tableName)) {
                  lines.push(`    ↳ Columns (\`${tableName}\`): ${cols.map((c) => `\`${c}\``).join(', ')}`);
                }
              }
            }
          }
        }
        lines.push(''); // blank line between plugin sections
      }

      if (lines.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xf39c12, title: '📋 Migration Preview', description: 'No preview data available — pending migrations exist but lack description/touches metadata.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0x3498db,
          title: '📋 Migration Preview',
          description: lines.join('\n').trimEnd(),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // verify — On-demand schema drift check
    // ═══════════════════════════════════════════════════════════════
    if (migrateSub === 'verify') {
      const db = plugin.services.db;

      if (!db || !db._isMounted) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: '❌ DB Service Not Available', description: 'The database service has not been initialised.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const drift = await db.verifyLiveSchema();

      if (!drift || drift.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x2ecc71, title: '🟢 Schema Verification — No Drift Detected', description: 'All registered models match the live database schema.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // Categorise drift entries
      const errors = drift.filter(d => d.error);
      const missing = drift.filter(d => d.missing && d.missing.length > 0);
      const missingRows = drift.filter(d => d.missingRows && d.missingRows.length > 0);
      const dataViolations = drift.filter(d => d.dataViolations && d.dataViolations.length > 0);
      const extra = drift.filter(d => d.extra && d.extra.length > 0);

      const lines = [];

      if (errors.length > 0) {
        lines.push('**❌ Errors**');
        for (const e of errors) {
          lines.push(`  • \`${e.table || e.model}\`: ${e.error}`);
        }
        lines.push('');
      }

      if (missing.length > 0) {
        lines.push('**🗑️ Missing Columns**');
        for (const m of missing) {
          lines.push(`  • \`${m.table}\`: ${m.missing.map(c => `\`${c}\``).join(', ')}`);
        }
        lines.push('');
      }

      if (missingRows.length > 0) {
        lines.push('**🧩 Missing Rows**');
        for (const r of missingRows) {
          lines.push(`  • \`${r.table}\`: ${r.missingRows.map(row => `\`${row.key}=${row.value}\``).join(', ')}`);
        }
        lines.push('');
      }

      if (dataViolations.length > 0) {
        lines.push('**🕳️ Unpopulated Data**');
        for (const dv of dataViolations) {
          lines.push(`  • \`${dv.table}\`: ${dv.dataViolations.map(v => `${v.offenders} row(s) with empty \`${v.column}\``).join(', ')}`);
        }
        lines.push('');
      }

      if (extra.length > 0) {
        lines.push('**📦 Extra Columns**');
        for (const x of extra) {
          lines.push(`  • \`${x.table}\`: ${x.extra.map(c => `\`${c}\``).join(', ')}`);
        }
        lines.push('');
      }

      // Severity: red if errors, missing schema, or unpopulated data; orange if extra-only
      const hasCritical = errors.length > 0 || missing.length > 0 || missingRows.length > 0 || dataViolations.length > 0;
      const color = hasCritical ? 0xe74c3c : 0xf39c12;

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color,
          title: '🔍 Schema Verification — Drift Detected',
          description: lines.join('\n').trimEnd(),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // purge-deprecated — Scan for and optionally drop _deprecated_* tables/columns
    // ═══════════════════════════════════════════════════════════════
    if (migrateSub === 'purge-deprecated') {
      const db = plugin.services.db;
      if (!db || !db._isMounted) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: '❌ DB Service Not Available', description: 'The database service has not been initialised.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const isConfirm = args.includes('--confirm');
      const qi = db.sequelize.getQueryInterface();
      const deprecatedPattern = /_deprecated_\d{13}$/;

      // ── Scan for deprecated tables ──────────────────────────────
      let allTables;
      try {
        allTables = await qi.showAllTables();
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: '❌ Scan Failed', description: `Could not list tables: ${err.message}`, timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const deprecatedTables = allTables.filter(t => deprecatedPattern.test(t));

      // ── Scan for deprecated columns on non-deprecated tables ────
      /** @type {Array<{table: string, column: string}>} */
      const deprecatedColumns = [];
      const nonDeprecatedTables = allTables.filter(t => !deprecatedPattern.test(t));

      for (const tableName of nonDeprecatedTables) {
        let info;
        try {
          info = await qi.describeTable(tableName);
        } catch {
          continue; // skip tables we can't describe (e.g. system tables)
        }
        for (const colName of Object.keys(info)) {
          if (deprecatedPattern.test(colName)) {
            deprecatedColumns.push({ table: tableName, column: colName });
          }
        }
      }

      const totalDeprecated = deprecatedTables.length + deprecatedColumns.length;

      // ── No deprecated objects ───────────────────────────────────
      if (totalDeprecated === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x2ecc71, title: '🧹 No Deprecated Objects', description: 'No deprecated tables or columns found.', timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // ── Report mode (no --confirm) ──────────────────────────────
      if (!isConfirm) {
        const lines = [];

        if (deprecatedTables.length > 0) {
          lines.push(`**📦 Deprecated Tables (${deprecatedTables.length})**`);
          for (const t of deprecatedTables) {
            lines.push(`  • \`${t}\``);
          }
          lines.push('');
        }

        if (deprecatedColumns.length > 0) {
          lines.push(`**📦 Deprecated Columns (${deprecatedColumns.length})**`);
          for (const { table, column } of deprecatedColumns) {
            lines.push(`  • \`${table}\`.\`${column}\``);
          }
          lines.push('');
        }

        lines.push(`Type \`!s3 migrate purge-deprecated --confirm\` to permanently delete ${totalDeprecated} deprecated object(s).`);

        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0x3498db,
            title: `🧹 Deprecated Objects Found (${totalDeprecated})`,
            description: lines.join('\n'),
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // ── Purge mode (--confirm) ──────────────────────────────────
      let purgedTables = 0;
      let purgedColumns = 0;
      const errors = [];

      for (const tableName of deprecatedTables) {
        try {
          await qi.dropTable(tableName);
          purgedTables++;
        } catch (err) {
          errors.push(`Table \`${tableName}\`: ${err.message}`);
        }
      }

      for (const { table, column } of deprecatedColumns) {
        try {
          await qi.removeColumn(table, column);
          purgedColumns++;
        } catch (err) {
          errors.push(`Column \`${table}\`.\`${column}\`: ${err.message}`);
        }
      }

      const totalPurged = purgedTables + purgedColumns;
      const lines = [];
      if (purgedTables > 0) lines.push(`Dropped ${purgedTables} deprecated table(s).`);
      if (purgedColumns > 0) lines.push(`Dropped ${purgedColumns} deprecated column(s).`);
      if (errors.length > 0) {
        lines.push('');
        lines.push(`**⚠️ Errors (${errors.length})**`);
        for (const e of errors) lines.push(`  • ${e}`);
      }

      const color = errors.length > 0 ? 0xf39c12 : 0x2ecc71;
      const title = errors.length > 0
        ? `🧹 Purge Complete — ${totalPurged} purged, ${errors.length} error(s)`
        : `🧹 Purge Complete — ${totalPurged} object(s) purged`;

      await sendDiscordMessage(message.channel, {
        embeds: [{ color, title, description: lines.join('\n'), timestamp: new Date().toISOString() }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    await message.reply('Usage: `!s3 migrate <pending|status|force [--dry-run]|preview|verify|purge-deprecated>`');
  });

  // ── Confirm ───────────────────────────────────────────────────

  handlers.set('confirm', async (plugin, message, args) => {
    const token = args[1];
    if (!token) {
      await message.reply(
        'Usage: `!s3 confirm <token>` — token shown in the startup migration prompt. ' +
        'Check `!s3 migrate status` to see if migrations are pending.'
      );
      return;
    }

    const db = plugin.services.db;
    const me = db?.migrationEngine;

    if (!db || !me) {
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0xe74c3c,
          title: '❌ Migration Engine Not Available',
          description: 'The database service or migration engine has not been initialised.',
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    // Validate token (handles expiry internally)
    const accepted = me.confirmToken(token);
    if (!accepted) {
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0xe74c3c,
          title: '❌ Invalid or Expired Token',
          description: 'The token did not match the latest migration prompt, or the 5-minute window expired. ' +
            'Check `!s3 migrate status` for pending migrations and use `!s3 migrate force` to bypass the confirmation flow.',
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    // Token accepted — run pending migrations
    const vs = await db.verifySchemaVersions();
    const pending = vs.pending ?? [];
    if (pending.length === 0) {
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0x2ecc71,
          title: '✅ No Pending Migrations',
          description: 'Token accepted, but no migrations are pending. All plugin schema versions are up to date.',
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      db._resolveMigrationGate(true);
      return;
    }

    const runningEmbed = buildMigrationEmbed(pending, 'running');
    await sendDiscordMessage(message.channel, { embeds: [runningEmbed] }, 'S3', (...a) => plugin.verbose(...a));

    let totalApplied = 0;
    let totalSkipped = 0;
    let hadError = false;
    let lastError = null;

    for (const p of pending) {
      try {
        const result = await me.runMigrations(p.pluginName);
        totalApplied += result.applied || 0;
        totalSkipped += result.skipped || 0;
      } catch (err) {
        hadError = true;
        lastError = err.message;
        break;
      }
    }

    db._resolveMigrationGate(!hadError);

    if (hadError) {
      const failEmbed = buildMigrationEmbed(pending, 'failed', { error: lastError, totalApplied, totalSkipped });
      await sendDiscordMessage(message.channel, { embeds: [failEmbed] }, 'S3', (...a) => plugin.verbose(...a));
    } else {
      const doneEmbed = buildMigrationEmbed(pending, 'complete', { totalApplied, totalSkipped });
      await sendDiscordMessage(message.channel, { embeds: [doneEmbed] }, 'S3', (...a) => plugin.verbose(...a));
    }
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

      // Acknowledge before starting — a JSON restore upserts every row in the
      // file and can run for minutes on a production-sized export. Without this
      // the command looks dead while the DB is mid-write, which is the worst
      // moment for an admin to conclude nothing happened and re-run it.
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0xf39c12,
          title: '⏳ Restoring Database…',
          description: `Reading \`${filename}\` and upserting rows. This can take several minutes on a large backup — the result will be posted here when it finishes. **Do not re-run this command in the meantime.**`,
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));

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

      // Acknowledge before starting. A full-tier export walks every table and
      // can take tens of seconds on a mature database (a production export runs
      // ~100 MB), during which the command looks ignored and admins re-run it.
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0xf39c12,
          title: '⏳ Creating Backup…',
          description: 'Exporting all tables to JSON. This can take a while on a large database — the result will be posted here when it finishes.',
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));

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
            description: `Saved \`${result.filename}\` (${formatSize(result.sizeBytes)}) to \`backups/\` directory.`,
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
        // Same acknowledgement as `!s3 backup create` — this is the same export,
        // and the 'all' tier is the slow one.
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xf39c12,
            title: `⏳ Exporting to File (${tier})…`,
            description: 'Writing tables to JSON. This can take a while on a large database — the result will be posted here when it finishes.',
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));

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
              description: `Saved \`${result.filename}\` (${formatSize(result.sizeBytes)}) to \`backups/\` directory.`,
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

        // A model that declared no exportTier was included here by the default-tier
        // fallback. Say so on the backup itself — the mount-time warning is only
        // seen by whoever was reading the log at the time.
        for (const w of exportObj.warnings || []) statusLines.push(`⚠️ ${w}`);

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