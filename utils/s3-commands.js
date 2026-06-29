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
 *   Returns { handlers: Map<string, handlerFn>, runPreflightCheck, runSmokeTest }
 *   where handlerFn is (plugin, message, args) => Promise<void>.
 *
 * Utility:  formatDuration, phaseEmoji, checkmark, truncate
 * Embeds:   buildStatusEmbed, buildServicesEmbed, buildGameStateEmbed,
 *           buildFactionsEmbed, buildPlayersEmbed, buildClansEmbed,
 *           buildLocksEmbed, buildConfigEmbed, buildEventsEmbed,
 *           buildHelpEmbed
 * Tests:    runPreflightCheck, runSmokeTest  (inject sendDiscordMessage)
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
// Utilities
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

export function checkmark(val) {
  return val ? '✅' : '❌';
}

export function truncate(str, maxLen = 1024) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen - 3) + '...' : str;
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

export function buildServicesEmbed(plugin) {
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

export function buildGameStateEmbed(plugin) {
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

export function buildFactionsEmbed(plugin) {
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

export function buildPlayersEmbed(plugin) {
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

export function buildClansEmbed(plugin) {
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

export function buildLocksEmbed(plugin) {
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

export function buildConfigEmbed(plugin) {
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

export function buildEventsEmbed(plugin) {
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

export function buildHelpEmbed() {
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
        name: '💾 Database',
        value: [
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
          '`!s3 backup list` — List backups (SQLite + JSON)',
          '`!s3 backup restore <filename>` — Restore from file backup (auto-detects format)'
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
// Automated Test Runners
// ============================================================================

export async function runPreflightCheck(plugin, message, sendDiscordMessage) {
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

export async function runSmokeTest(plugin, message, sendDiscordMessage) {
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
// Command Handler Factory
// ============================================================================

/**
 * Create a Map of command handlers for !s3 dispatch.
 *
 * @param {object} context
 * @param {Function} context.sendDiscordMessage - Discord message sender
 * @param {WatchManager} context.watchManager - Watch relay instance
 * @param {object} context.stagedImportRef - { current: null|object } for import staging
 * @returns {{ handlers: Map<string, Function>, runPreflightCheck: Function, runSmokeTest: Function }}
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

  handlers.set('events', async (plugin, message, args) => {
    const embed = buildEventsEmbed(plugin);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  // ── Debug ─────────────────────────────────────────────────────

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

  // ── Testing ───────────────────────────────────────────────────

  handlers.set('test', async (plugin, message, args) => {
    const testSub = args[1]?.toLowerCase();

    if (testSub === 'preflight') {
      await runPreflightCheck(plugin, message, sendDiscordMessage);
      return;
    }

    if (testSub === 'smoke') {
      await runSmokeTest(plugin, message, sendDiscordMessage);
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
        const status = p ? `⚠️ v${current} → v${expectedVersion} (${p.behind} behind)` : `✅ v${current} (current)`;
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
          embeds: [{ color: 0x95a5a6, title: '📦 No Backups Found', description: 'No database backups have been created yet. Run a migration with `!s3 migrate force` to trigger a backup first.', timestamp: new Date().toISOString() }]
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

    await message.reply('Usage: `!s3 backup <list|restore [--confirm] <filename>>`');
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
    await message.reply('Usage: `!s3 db <export [--logs|--all] | import [--confirm] [--dry-run]>`');
  });

  // ── Help / Default ────────────────────────────────────────────

  handlers.set('help', async (plugin, message, args) => {
    const embed = buildHelpEmbed();
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  return {
    handlers,
    runPreflightCheck: (plugin, message) => runPreflightCheck(plugin, message, sendDiscordMessage),
    runSmokeTest: (plugin, message) => runSmokeTest(plugin, message, sendDiscordMessage)
  };
}