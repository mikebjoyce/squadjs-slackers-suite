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
 * ─── ROUTING (multi-server) ──────────────────────────────────────
 *
 * Every process running this suite sees every message in the shared
 * admin channel, so a command typed once arrives at all of them.
 * scopeForS3Command() below classifies each verb into one of the
 * COMMAND_SCOPE values from s3-discord-routing.js, and that
 * classification is what decides which processes answer:
 *
 *   SERVER_READ         every server answers, labelled
 *   SERVER_MUTATING     the targeted server acts, and a target is
 *                       required rather than assumed
 *   COMMUNITY_READ      one process answers for the community
 *   COMMUNITY_MUTATING  one process acts, under a claim, once
 *   TOKEN_CONFIRM       the token is the routing — whoever minted it
 *
 * The classification lives here rather than in the router because it
 * is a fact about what each verb does, and the router has no way to
 * know that. Two cases are worth reading the comments for. !s3 locks
 * and !s3 config look community-wide from their names and are not:
 * both render THIS process's answer, and on a multi-server install
 * the answers genuinely differ. And !s3 players / !s3 clans are
 * ordinary server reads that ask for a target anyway, because a full
 * roster is several embeds and three servers answering at once is a
 * screen of them. That one is a volume exception, not a correctness
 * one.
 *
 * On a single-server install none of this is reachable in a way an
 * admin would notice: one live server means one responder, and the
 * labels degrade to the server's own name.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * createCommandHandlers(context)
 *   Returns { handlers: Map<string, handlerFn>, runDiagnostic }
 *   where handlerFn is (plugin, message, args) => Promise<void>.
 *
 * Routing:  scopeForS3Command(args) → { scope, selectorRequired }
 * Utility:  formatDuration, phaseEmoji, circleEmoji, serviceCircle,
 *           checkmark (kept for legacy compat), truncate,
 *           guildAttachmentLimit, formatTimestamp
 * Embeds:   buildStatusEmbed, buildServicesEmbed, buildGameStateEmbed,
 *           buildFactionsEmbed, buildLocksEmbed, buildConfigEmbed,
 *           buildKarmaEmbed, buildSwitchesExport, buildServersEmbed,
 *           buildHelpEmbed
 * Embed sets (return an array — one Discord message, several embeds):
 *           buildPlayersEmbeds, buildClansEmbeds, buildSwitchesEmbed
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
 * buildKarmaVerdict() reuses these circles for an unrelated scale — win-rate
 * direction, not system status. There, 🟢/🟢🟢 = good karma (switches skew
 * toward the losing team), 🟡/🟠 = bad karma (skew toward the winning team),
 * ⚪ = neutral or insufficient sample. The general legend above does not apply
 * to that one function.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * s3-migration-discord.js — buildMigrationEmbed
 * s3-backup.js           — canBackup, listBackups, restoreBackup
 * s3-export-import.js    — exportToFile, gzipFileForAttachment, importFromJSON, etc.
 * s3-common.js           — formatSize
 * s3-discord-routing.js  — COMMAND_SCOPE (the classification vocabulary)
 * s3-server-label.js     — how a server names itself in an answer
 *
 */
import { buildMigrationEmbed, formatServerIdentity } from './s3-migration-discord.js';
import { canBackup, listBackups, restoreBackup } from './s3-backup.js';
import {
  importFromJSON,
  planImport,
  validateImportStructure,
  restoreFromFile,
  exportToFile,
  gzipFileForAttachment
} from './s3-export-import.js';
import { formatSize } from './s3-common.js';
import { COMMAND_SCOPE } from './s3-discord-routing.js';
import { serverLabels, serverDisplayName } from './s3-server-label.js';
// Only for the three statics the registry embed needs — freshness and the
// BIGINT read. Both live next to the column definitions they interpret, which
// is where a second, drifting copy of "is this row fresh" is easiest to avoid.
import DBService from './db-service.js';
// The one list of community-affecting options and the one phrasing of a
// disagreement. A second copy here is how the embed and the mount warning end
// up describing the same divergence in two different vocabularies.
import { OPTION_KIND, parseCommunityOptions, describeDisagreement } from './community-options.js';
// The tag on a refused advisory lock. Matching on the message text instead is
// how "another process is migrating this" and "this grant cannot lock at all"
// end up being told apart by a string that someone will reword.
import { MIGRATION_LOCK_UNAVAILABLE } from './migration-engine.js';
import {
  parseRange,
  looksLikeRangeToken,
  checkLoggingAvailability,
  resolvePlayers,
  isUnambiguous,
  getGamesPlayedMap,
  getSwitchesMap,
  getPlayerSwitches,
  getKarmaReport,
  isPeriodToken,
  getSwitchesByPeriodAndPlayer
} from './s3-switch-reports.js';

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

/**
 * Bytes this guild will accept in a single attachment.
 *
 * The ceiling is a function of the guild's boost tier, and assuming the boosted
 * 25MB everywhere is how a 200MB export got as far as an upload before Discord
 * answered "Request entity too large" — a 413 raised after the file had already
 * been compressed and buffered, surfaced to the operator as a failed export even
 * though the export itself had succeeded.
 *
 * discord.js 14.26 exposes `maximumBitrate` but no equivalent for uploads, so
 * the tiers are mapped here. An unknown or missing guild falls back to the
 * smallest limit: over-estimating costs a failed send, under-estimating costs
 * only a link to a file that is on the server anyway.
 */
export function guildAttachmentLimit(guild) {
  const MiB = 1024 * 1024;
  switch (guild?.premiumTier) {
    case 2: return 50 * MiB;
    case 3: return 100 * MiB;
    default: return 10 * MiB;
  }
}

export function formatTimestamp(unixMs, naText) {
  if (!unixMs) return naText;
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

  const NA = plugin.localize('slackersSquadServices.labels.notAvailable');
  const phase = gs?.getPhase?.() ?? 'unknown';
  const subState = gs?.getEndgameSubState?.() ?? null;
  const mode = gs?.getGamemode?.() ?? NA;
  // Display spelling ("Sumari Bala Seed v1"), not the canonical classname S³
  // stores and compares on. getLayerDisplayName() falls back to the canonical
  // name, so the ?? chain only matters for a gameState that predates it.
  const layer = gs?.getLayerDisplayName?.() ?? gs?.getLayerName?.() ?? NA;
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

  const team1Name = factions?.getTeamName?.(1) ?? plugin.localize('slackersSquadServices.team.team1');
  const team2Name = factions?.getTeamName?.(2) ?? plugin.localize('slackersSquadServices.team.team2');

  const fields = [
    {
      name: plugin.localize('slackersSquadServices.status.services'),
      value: mountLines.join('\n'),
      inline: true
    },
    {
      name: plugin.localize('slackersSquadServices.status.game'),
      value: [
        plugin.localize('slackersSquadServices.status.phaseAndSubstate', { phase: phaseEmoji(phase), phase2: phase, subState: subState ? ` (${subState})` : '' }),
        plugin.localize('slackersSquadServices.status.mode', { mode }),
        plugin.localize('slackersSquadServices.status.layerLayer', { layer: truncate(layer, 40) }),
        isResolving ? plugin.localize('slackersSquadServices.status.resolvingYes') : '',
        plugin.localize('slackersSquadServices.status.matchId', { matchId: gs?.getMatchId?.() ?? NA }),
        plugin.localize('slackersSquadServices.status.roundStart', { roundStart: formatTimestamp(gs?.getRoundStartTime?.(), NA) })
      ].filter(Boolean).join('\n'),
      inline: true
    },
    {
      name: plugin.localize('slackersSquadServices.status.playersLocks'),
      value: [
        plugin.localize('slackersSquadServices.status.players', { playerCount }),
        plugin.localize('slackersSquadServices.status.teamNames', { team1Name, team2Name }),
        teamsResolved ? plugin.localize('slackersSquadServices.status.teamsResolvedYes') : plugin.localize('slackersSquadServices.status.teamsResolvedNo'),
        plugin.localize('slackersSquadServices.status.globalLock', { state: globalLockOwner ? plugin.localize('slackersSquadServices.status.globalLockOwner', { owner: globalLockOwner }) : plugin.localize('slackersSquadServices.status.globalLockNone') })
      ].join('\n'),
      inline: true
    }
  ];

  if (clans?.isEnabled?.()) {
    fields.push({
      name: plugin.localize('slackersSquadServices.status.clans'),
      value: plugin.localize('slackersSquadServices.status.enabledMinMax', { minSize: clans.options?.minSize ?? 2, maxSize: clans.options?.maxSize ?? 18 }),
      inline: true
    });
  }

  return {
    color: 0x3498db,
    title: plugin.localize('slackersSquadServices.status.sStatus'),
    fields,
    timestamp: new Date().toISOString()
  };
}

export function buildServicesEmbed(plugin) {
  const services = plugin.services;
  const gs = services.gameState;
  const players = services.players;
  const db = services.db;

  const NA = plugin.localize('slackersSquadServices.labels.notAvailable');
  const entries = [];

  // ── serverConfig ──────────────────────────────────────────────
  const sc = services.serverConfig;
  if (!sc || !sc._isMounted) {
    entries.push(plugin.localize('slackersSquadServices.services.notMounted', { service: 'ServerConfig' }));
  } else {
    const loaded = sc.isLoadedSuccessfully?.() ?? false;
    const path = sc.getConfigPath?.() ?? NA;
    entries.push(plugin.localize('slackersSquadServices.services.serverConfig', { emoji: loaded ? '🟢' : '🟡', state: loaded ? plugin.localize('slackersSquadServices.services.serverConfigLoaded') : plugin.localize('slackersSquadServices.services.serverConfigNoConfig') }));
    entries.push(plugin.localize('slackersSquadServices.services.path', { path: truncate(path, 40) }));
    const cfg = sc.getConfig?.() ?? {};
    if (cfg.MaxPlayers) entries.push(plugin.localize('slackersSquadServices.services.maxPlayersLine', { maxPlayers: cfg.MaxPlayers, allowTeamChanges: cfg.AllowTeamChanges ?? NA }));
  }

  // ── DB ────────────────────────────────────────────────────────
  if (!db || !db._isMounted) {
    entries.push(plugin.localize('slackersSquadServices.services.notMounted', { service: 'DB' }));
  } else {
    const connector = db.getConnectorName?.() ?? '?';
    const hasPending = (db.getPendingMigrations?.()?.length ?? 0) > 0;
    let connectorStr;
    if (connector === 'none') {
      connectorStr = plugin.localize('slackersSquadServices.services.noConnector');
    } else {
      // Check schema drift status
      const drift = db.getLastDriftResult?.();
      if (drift == null) {
        connectorStr = `🟢 ${connector}`; // no check run yet — assume OK
      } else if (drift.length === 0) {
        connectorStr = plugin.localize('slackersSquadServices.services.noSchemaDrift', { connector });
      } else if (drift.some(e => e.error)) {
        connectorStr = plugin.localize('slackersSquadServices.services.cannotVerifySchema', { connector });
      } else {
        // Drift detected — summarise
        const tableCount = drift.length;
        const missingCols = drift.filter(e => e.missing).length;
        const extraCols = drift.filter(e => e.extra).length;
        const parts = [];
        if (missingCols > 0) parts.push(plugin.localize('slackersSquadServices.services.driftMissingColumns', { count: missingCols }));
        if (extraCols > 0) parts.push(plugin.localize('slackersSquadServices.services.driftExtraColumns', { count: extraCols }));
        connectorStr = plugin.localize('slackersSquadServices.services.schemaDrift', { connector, parts: parts.join(', ') });
      }
    }
    entries.push(plugin.localize('slackersSquadServices.services.db', { connector: connectorStr }));
    entries.push(plugin.localize('slackersSquadServices.services.migrations', { state: hasPending ? plugin.localize('slackersSquadServices.services.migrationsPending') : plugin.localize('slackersSquadServices.services.migrationsAllCurrent') }));
    const versionCount = (db._expectedVersions?.size ?? 0);
    if (versionCount > 0) entries.push(plugin.localize('slackersSquadServices.services.schemaVersions', { count: versionCount }));
  }

  // ── GameState ─────────────────────────────────────────────────
  if (!gs || !gs._isMounted) {
    entries.push(plugin.localize('slackersSquadServices.services.notMounted', { service: 'GameState' }));
  } else {
    const phase = gs.getPhase?.() ?? '?';
    const matchId = gs.getMatchId?.() ?? NA;
    const resolving = gs.isResolving?.() ?? false;
    entries.push(plugin.localize('slackersSquadServices.services.gameState', { emoji: circleEmoji('phase', phase), phase, resolving: resolving ? plugin.localize('slackersSquadServices.services.resolvingSuffix') : '' }));
    entries.push(plugin.localize('slackersSquadServices.services.matchIdRoundStart', { matchId, roundStart: formatTimestamp(gs.getRoundStartTime?.(), NA) }));
    const mode = gs.getGamemode?.() ?? NA;
    const layer = gs.getLayerDisplayName?.() ?? gs.getLayerName?.() ?? NA;
    entries.push(plugin.localize('slackersSquadServices.services.modeLayer', { mode, layer: truncate(layer, 30) }));
    entries.push(`   isLive: ${gs.isLive?.() ? '🟢' : '⚫'} | isStaging: ${gs.isStaging?.() ? '🟡' : '⚫'} | isEnding: ${gs.isEnding?.() ? '🔴' : '⚫'}`);
  }

  // ── Factions ─────────────────────────────────────────────────
  const factions = services.factions;
  if (!factions || !factions._isMounted) {
    entries.push(plugin.localize('slackersSquadServices.services.notMounted', { service: 'Factions' }));
  } else {
    const hasBoth = factions._hasBothTeams?.() ?? false;
    const hasPolling = factions._teamAbbreviationPollingInterval != null;
    const t1 = factions.getTeamName?.(1) ?? plugin.localize('slackersSquadServices.team.team1');
    const t2 = factions.getTeamName?.(2) ?? plugin.localize('slackersSquadServices.team.team2');
    entries.push(plugin.localize('slackersSquadServices.services.factions', { emoji: hasBoth ? '🟢' : '🟡', state: hasBoth ? plugin.localize('slackersSquadServices.services.factionsBothResolved') : plugin.localize('slackersSquadServices.services.factionsResolving') }));
    entries.push(plugin.localize('slackersSquadServices.services.teamsVs', { team1: t1, team2: t2 }));
    entries.push(plugin.localize('slackersSquadServices.services.polling', { state: hasPolling ? plugin.localize('slackersSquadServices.services.pollingRunning') : plugin.localize('slackersSquadServices.services.pollingStopped') }));
  }

  // ── Clans ─────────────────────────────────────────────────────
  const clans = services.clans;
  if (!clans || !clans._isMounted) {
    entries.push(plugin.localize('slackersSquadServices.services.notMounted', { service: 'Clans' }));
  } else {
    const enabled = clans.isEnabled?.() ?? false;
    if (enabled) {
      const groups = clans.extractClanGroups?.(players?.getAllPlayers?.() ?? []) ?? {};
      const groupCount = Object.keys(groups).length;
      entries.push(plugin.localize('slackersSquadServices.services.clans', { count: groupCount, min: clans.options?.minSize ?? 2, max: clans.options?.maxSize ?? 18 }));
    } else {
      entries.push(plugin.localize('slackersSquadServices.services.clansDisabled'));
    }
  }

  // ── Players ───────────────────────────────────────────────────
  if (!players || !players._isMounted) {
    entries.push(plugin.localize('slackersSquadServices.services.notMounted', { service: 'Players' }));
  } else {
    const allP = players.getAllPlayers?.() ?? [];
    const initialSync = players._initialSyncComplete ?? false;
    const teamsResolved = players.areTeamsResolved?.() ?? false;
    const projected = players._projectedPlayers !== null;
    entries.push(plugin.localize('slackersSquadServices.services.players', { emoji: initialSync ? '🟢' : '🟡', count: allP.length }));
    entries.push(plugin.localize('slackersSquadServices.services.initialSyncTeams', { sync: initialSync ? plugin.localize('slackersSquadServices.services.syncComplete') : plugin.localize('slackersSquadServices.services.syncPending'), teams: teamsResolved ? plugin.localize('slackersSquadServices.services.teamsResolvedState') : plugin.localize('slackersSquadServices.services.teamsResolvingState') }));
    entries.push(plugin.localize('slackersSquadServices.services.projection', { state: projected ? plugin.localize('slackersSquadServices.services.projectionActive') : plugin.localize('slackersSquadServices.services.projectionNone') }));
    const globalLockOwner = players.isGloballyLockedBy?.() ?? null;
    entries.push(plugin.localize('slackersSquadServices.services.globalLock', { state: globalLockOwner ? plugin.localize('slackersSquadServices.services.globalLockOwner', { owner: globalLockOwner }) : plugin.localize('slackersSquadServices.services.globalLockNone') }));
  }

  return {
    color: 0x2ecc71,
    title: plugin.localize('slackersSquadServices.services.sServiceStatus'),
    description: entries.join('\n'),
    timestamp: new Date().toISOString()
  };
}

export function buildGameStateEmbed(plugin) {
  const gs = plugin.services.gameState;
  if (!gs) {
    return { color: 0xe74c3c, title: plugin.localize('slackersSquadServices.gameState.gamestateServiceNotAvailable') };
  }

  const NA = plugin.localize('slackersSquadServices.labels.notAvailable');
  const phase = gs.getPhase?.() ?? 'unknown';
  const sub = gs.getEndgameSubState?.() ?? null;
  const mode = gs.getGamemode?.() ?? NA;
  const layer = gs.getLayerDisplayName?.() ?? gs.getLayerName?.() ?? NA;
  const resolving = gs.isResolving?.() ?? false;
  const matchId = gs.getMatchId?.() ?? NA;
  const roundStartTime = gs.getRoundStartTime?.() ?? null;

  // Detect presence of staging live timer
  const stagingLiveTimerPending = gs._stagingLiveTimer != null;
  // Hoisted out of the field literal: the read-back guard scans line by line,
  // and a comparison sharing a line with localize() reads as a translated
  // string being matched on.
  const layerUnresolved = gs.isLayerResolved?.() === false;

  const fields = [
    { name: plugin.localize('slackersSquadServices.gameState.phase'), value: `${phaseEmoji(phase)} ${phase}`, inline: true },
    { name: plugin.localize('slackersSquadServices.gameState.resolving'), value: resolving ? plugin.localize('slackersSquadServices.gameState.yes') : plugin.localize('slackersSquadServices.gameState.no'), inline: true },
    { name: '', value: '', inline: true }, // spacer
    { name: 'isLive', value: gs.isLive?.() ? '🟢' : '⚫', inline: true },
    { name: 'isStaging', value: gs.isStaging?.() ? '🟡' : '⚫', inline: true },
    { name: 'isEnding', value: gs.isEnding?.() ? '🔴' : '⚫', inline: true },
    { name: plugin.localize('slackersSquadServices.gameState.gamemode'), value: mode, inline: true },
    // ⚠️ marks a layer S³ has not actually resolved yet (the 'Unknown'
    // placeholder), so operators can tell it apart from a real layer name.
    { name: plugin.localize('slackersSquadServices.gameState.layer'), value: `${layerUnresolved ? '⚠️ ' : ''}${truncate(layer, 50)}`, inline: true },
    { name: 'isIgnoredMode', value: gs.isIgnoredMode?.() ? '🟡' : '⚫', inline: true },
    { name: 'MatchId', value: `\`${matchId}\``, inline: true },
    { name: plugin.localize('slackersSquadServices.gameState.roundStart'), value: formatTimestamp(roundStartTime, NA), inline: true },
    { name: plugin.localize('slackersSquadServices.gameState.stagingTimer'), value: stagingLiveTimerPending ? plugin.localize('slackersSquadServices.gameState.pending') : plugin.localize('slackersSquadServices.gameState.none'), inline: true }
  ];

  if (sub) {
    fields.push({ name: plugin.localize('slackersSquadServices.gameState.endgameSubState'), value: sub, inline: true });
    fields.push({ name: 'isEndgameFactionVote', value: gs.isEndgameFactionVote?.() ? '🟢' : '⚫', inline: true });
    fields.push({ name: 'isEndgameLayerVote', value: gs.isEndgameLayerVote?.() ? '🟢' : '⚫', inline: true });
    fields.push({ name: 'isEndgameScoreboard', value: gs.isEndgameScoreboard?.() ? '🟢' : '⚫', inline: true });
    fields.push({ name: 'isEndgamePostVoting', value: gs.isEndgamePostVoting?.() ? '🟢' : '⚫', inline: true });
  }

  const lastNew = formatTimestamp(gs.lastNewGameAt, NA);
  const lastEnd = formatTimestamp(gs.lastRoundEndedAt, NA);
  fields.push({ name: plugin.localize('slackersSquadServices.gameState.lastNewGame'), value: lastNew, inline: true });
  fields.push({ name: plugin.localize('slackersSquadServices.gameState.lastRoundEnded'), value: lastEnd, inline: true });

  return {
    color: 0x9b59b6,
    title: plugin.localize('slackersSquadServices.gameState.gameState'),
    fields,
    timestamp: new Date().toISOString()
  };
}

export function buildFactionsEmbed(plugin) {
  const factions = plugin.services.factions;
  if (!factions) {
    return { color: 0xe74c3c, title: plugin.localize('slackersSquadServices.factions.factionsServiceNotAvailable') };
  }

  const team1 = factions.getTeamName?.(1) ?? plugin.localize('slackersSquadServices.team.team1');
  const team2 = factions.getTeamName?.(2) ?? plugin.localize('slackersSquadServices.team.team2');
  const cached = factions.getCachedAbbreviations?.() ?? {};
  const hasBoth = factions._hasBothTeams?.() ?? false;
  const hasPolling = factions._teamAbbreviationPollingInterval != null;
  const isResolving = plugin.services.gameState?.isResolving?.() ?? false;

  const stateEmoji = hasBoth ? '🟢' : '🟡';
  const pollingEmoji = hasPolling ? '🟢' : '⚫';
  const gateEmoji = isResolving ? plugin.localize('slackersSquadServices.factions.pollingGated') : plugin.localize('slackersSquadServices.factions.freeToPoll');

  return {
    color: 0xe67e22,
    title: plugin.localize('slackersSquadServices.factions.factions'),
    fields: [
      { name: plugin.localize('slackersSquadServices.factions.resolution'), value: `${stateEmoji} ${hasBoth ? plugin.localize('slackersSquadServices.factions.bothTeamsResolved') : plugin.localize('slackersSquadServices.factions.resolvingEllipsis')}`, inline: true },
      { name: plugin.localize('slackersSquadServices.team.team1'), value: team1, inline: true },
      { name: plugin.localize('slackersSquadServices.team.team2'), value: team2, inline: true },
      { name: plugin.localize('slackersSquadServices.factions.polling'), value: `${pollingEmoji} ${hasPolling ? plugin.localize('slackersSquadServices.factions.active') : plugin.localize('slackersSquadServices.factions.stopped')}`, inline: true },
      { name: plugin.localize('slackersSquadServices.factions.resolvingGate'), value: gateEmoji, inline: true },
      { name: plugin.localize('slackersSquadServices.factions.cachedAbbreviations'), value: `\`\`\`json\n${JSON.stringify(cached, null, 2)}\n\`\`\``, inline: false }
    ],
    timestamp: new Date().toISOString()
  };
}

/**
 * Push a list of lines as one or more embed fields, respecting Discord's
 * 1024-character-per-field-value cap. Overflow spills into `name (cont.)`
 * fields up to `maxFields`; anything beyond that is summarised as a count.
 *
 * @param {object} plugin - Plugin instance, for localize().
 * @param {Array} fields - Field array to append to (mutated).
 * @param {string} name - Field name for the first chunk.
 * @param {string[]} lines - Lines to render.
 * @param {object} [opts]
 * @param {number} [opts.maxFields=3] - Max fields to spend on this list.
 * @param {boolean} [opts.inline=false]
 */
/**
 * Table-name prefixes the suite claims. Used by `!s3 db orphans` to tell a
 * table this suite left behind from one that belongs to SquadJS core or to
 * something else sharing the database entirely — dropping the wrong table is
 * the one mistake this command must never invite.
 *
 * Lower-case, because every comparison against them folds: production MySQL
 * runs lower_case_table_names=1.
 */
const SUITE_TABLE_PREFIXES = [
  's3_', 'sa_', 'elo_', 'tb_', 'switchplugin_', 'teambalancer', 'smartassign'
];

/**
 * Orphans this suite created deliberately, and what replaced each. Anything
 * not listed here is still reported — an unrecognized orphan is the more
 * interesting kind — it just gets no arrow.
 */
const ABANDONED_BY = {
  's3_playerreconnects': 'S3_ServerReconnects',
  's3_playersessions': 'S3_ServerSessions',
  'switchplugin_settings': 'SwitchPlugin_ServerSettings',
  'elo_pluginstates': null
};

function pushLineField(plugin, fields, name, lines, opts = {}) {
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
      name: i === 0 ? name : plugin.localize('slackersSquadServices.pushLineField.nameCont', { name: truncate(name, 240) }),
      value: truncate(chunk.join('\n'), 1024),
      inline
    });
  });

  const droppedLines = chunks.slice(maxFields).reduce((n, c) => n + c.length, 0);
  if (droppedLines > 0) {
    fields.push({
      name: plugin.localize('slackersSquadServices.pushLineField.nameCont', { name: truncate(name, 230) }),
      value: plugin.localize('slackersSquadServices.pushLineField.andMoreOutput', { droppedLines }),
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
    return [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.playersEmbeds.playersServiceNotAvailable') }];
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
    return name && name !== `Team ${teamID}` ? `${name}` : plugin.localize('slackersSquadServices.team.teamN', { teamID });
  };

  // ── Meta embed ──────────────────────────────────────────────────
  const gs = plugin.services.gameState;
  const phase = gs?.getPhase?.() ?? 'unknown';
  const layer = gs?.getLayerDisplayName?.() ?? gs?.getLayerName?.() ?? plugin.localize('slackersSquadServices.labels.notAvailable');

  const globalOwner = players.isGloballyLockedBy?.() ?? null;
  const playerLocks = players.playerLocks ?? new Map();
  const activeLockCount = [...playerLocks.values()].filter((l) => l.expiresAt > Date.now()).length;

  const delta = team1.length - team2.length;
  const deltaStr = delta === 0
    ? plugin.localize('slackersSquadServices.playersEmbeds.even')
    : plugin.localize('slackersSquadServices.playersEmbeds.delta', { team: delta > 0 ? plugin.localize('slackersSquadServices.team.team1') : plugin.localize('slackersSquadServices.team.team2'), count: Math.abs(delta) });

  const metaFields = [
    { name: plugin.localize('slackersSquadServices.playersEmbeds.population'), value: plugin.localize('slackersSquadServices.playersEmbeds.tracked', { allCount: all.length }), inline: true },
    {
      name: `🟦 ${truncate(teamLabel(1), 200)}`,
      value: plugin.localize('slackersSquadServices.playersEmbeds.team1CountAndSquads', { team1Count: team1.length, count: squadsForTeam(1).length }),
      inline: true
    },
    {
      name: `🟥 ${truncate(teamLabel(2), 200)}`,
      value: plugin.localize('slackersSquadServices.playersEmbeds.team2CountAndSquads', { team2Count: team2.length, count: squadsForTeam(2).length }),
      inline: true
    },
    { name: plugin.localize('slackersSquadServices.playersEmbeds.balance'), value: deltaStr, inline: true },
    {
      name: plugin.localize('slackersSquadServices.playersEmbeds.unassigned'),
      value: squadDataPending ? plugin.localize('slackersSquadServices.playersEmbeds.unknown') : plugin.localize('slackersSquadServices.playersEmbeds.notInASquad', { count: all.length - inSquadIDs.size }),
      inline: true
    },
    { name: plugin.localize('slackersSquadServices.playersEmbeds.teamsResolved'), value: teamsResolved ? plugin.localize('slackersSquadServices.playersEmbeds.yes') : plugin.localize('slackersSquadServices.playersEmbeds.no'), inline: true },
    { name: plugin.localize('slackersSquadServices.playersEmbeds.initialSync'), value: initialSync ? plugin.localize('slackersSquadServices.playersEmbeds.complete') : plugin.localize('slackersSquadServices.playersEmbeds.pending'), inline: true },
    { name: plugin.localize('slackersSquadServices.playersEmbeds.projection'), value: projected ? plugin.localize('slackersSquadServices.playersEmbeds.active') : plugin.localize('slackersSquadServices.playersEmbeds.none'), inline: true },
    {
      name: plugin.localize('slackersSquadServices.playersEmbeds.locks'),
      value: [
        globalOwner ? plugin.localize('slackersSquadServices.playersEmbeds.global', { globalOwner }) : plugin.localize('slackersSquadServices.playersEmbeds.globalNone'),
        plugin.localize('slackersSquadServices.playersEmbeds.perPlayer', { count: activeLockCount })
      ].join(' · '),
      inline: false
    }
  ];

  if (squadDataPending) {
    metaFields.push({
      name: plugin.localize('slackersSquadServices.playersEmbeds.squadDataPending'),
      value: plugin.localize('slackersSquadServices.playersEmbeds.sHasNotSnapshotted')
        + plugin.localize('slackersSquadServices.playersEmbeds.whereEveryPlayerHas'),
      inline: false
    });
  }

  // A player whose client wedges at `Team ID: N/A` never resolves on their own —
  // it takes a reconnect. Those are quarantined so they stop holding the
  // resolution gate down, and they need to read differently from a player who is
  // simply mid-transition, because only one of the two clears by waiting.
  const stuckKeys = players.getStuckPlayerKeys?.() ?? new Set();
  const isStuck = (p) => stuckKeys.has(p?.eosID) || stuckKeys.has(p?.steamID);
  const stuck = unresolved.filter(isStuck);
  const awaiting = unresolved.filter((p) => !isStuck(p));

  if (awaiting.length > 0) {
    metaFields.push({
      name: plugin.localize('slackersSquadServices.playersEmbeds.teamUnresolved', { awaitingCount: awaiting.length }),
      value: plugin.localize('slackersSquadServices.playersEmbeds.sHasNoTeamid')
        + plugin.localize('slackersSquadServices.playersEmbeds.postNewGameNull'),
      inline: false
    });
    pushLineField(
      plugin,
      metaFields,
      'Awaiting teamID',
      awaiting.map((p) => formatPlayerLine(p, players)),
      { maxFields: 1 }
    );
  }

  if (stuck.length > 0) {
    metaFields.push({
      name: plugin.localize('slackersSquadServices.playersEmbeds.stuckClient', { stuckCount: stuck.length }),
      value: plugin.localize('slackersSquadServices.playersEmbeds.thesePlayersHaveReported')
        + plugin.localize('slackersSquadServices.playersEmbeds.transitionTakesSoS')
        + plugin.localize('slackersSquadServices.playersEmbeds.theRestOfThe'),
      inline: false
    });
    pushLineField(
      plugin,
      metaFields,
      'Ignored for resolution',
      stuck.map((p) => formatPlayerLine(p, players)),
      { maxFields: 1 }
    );
  }

  const embeds = [{
    color: 0x1abc9c,
    title: plugin.localize('slackersSquadServices.playersEmbeds.playersOverview'),
    description: plugin.localize('slackersSquadServices.playersEmbeds.phasePhasePhase2Layer', { phase: phaseEmoji(phase), phase2: phase, layer: truncate(layer, 60) }),
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

      pushLineField(plugin, fields, name, lines, { maxFields: 2, inline: true });
    }

    const leftover = teamPlayers.filter((p) => !inSquadIDs.has(p.eosID));
    if (leftover.length > 0) {
      // Without a squad snapshot these players are not known to be squadless —
      // we simply have no squad data for them yet. Label accordingly.
      const label = squadDataPending
        ? plugin.localize('slackersSquadServices.team.rosterSquadDataPending', { count: leftover.length })
        : plugin.localize('slackersSquadServices.team.unassignedCount', { count: leftover.length });
      pushLineField(
        plugin,
        fields,
        label,
        leftover.map((p) => formatPlayerLine(p, players)),
        { maxFields: 2 }
      );
    }

    if (fields.length === 0) {
      fields.push({ name: plugin.localize('slackersSquadServices.team.roster'), value: plugin.localize('slackersSquadServices.team.noPlayersOnThis'), inline: false });
    }

    // Discord hard-caps an embed at 25 fields.
    const trimmed = fields.slice(0, 24);
    if (fields.length > trimmed.length) {
      trimmed.push({
        name: plugin.localize('slackersSquadServices.team.truncated'),
        value: plugin.localize('slackersSquadServices.team.moreFields', { trimmedCount: fields.length - trimmed.length }),
        inline: false
      });
    }

    return {
      color,
      title: plugin.localize('slackersSquadServices.team.teamHeader', { emoji, truncate: truncate(teamLabel(teamID), 200), teamPlayersCount: teamPlayers.length, teamSquadsCount: teamSquads.length }),
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
    return [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.clansEmbeds.clansServiceNotAvailable') }];
  }

  if (!clans.isEnabled?.()) {
    return [{
      color: 0x95a5a6,
      title: plugin.localize('slackersSquadServices.clansEmbeds.clansDisabled'),
      description: plugin.localize('slackersSquadServices.clansEmbeds.clanTagGroupingIs')
    }];
  }

  const players = plugin.services.players?.getAllPlayers?.() ?? [];

  // explainClanGroups() runs the identical pipeline to extractClanGroups(),
  // so what is displayed here is exactly what SmartAssign and TeamBalancer see.
  if (typeof clans.explainClanGroups !== 'function') {
    return [{
      color: 0xe74c3c,
      title: plugin.localize('slackersSquadServices.clansEmbeds.clansServiceOutdated'),
      description: plugin.localize('slackersSquadServices.clansEmbeds.thisSBuildPredates')
    }];
  }

  const { groups, trace, options } = clans.explainClanGroups(players);

  // Clan tags are only alphanumeric when caseSensitive is false; with it on the
  // raw tag is used verbatim and can carry markdown characters, as can any name.
  // Strategy ('bracket'/'separator'/'prefixSymbol'/'confirmed'/'doublespace'/
  // 'shorttag'/'bare') comes from trace.memberStrategies, populated alongside
  // memberNames by the identical pipeline explainClanGroups() runs — never
  // read ClansService's internal _playerTagStrategy map directly here (see
  // docs/clan-tag-confirmation-rework.md §3.3).
  //
  // Confidence marker per player, appended after their name: ✓ confirmed
  // (ground truth from an observed name-transition), • high-confidence
  // (explicit bracket/separator/hash-prefix formatting), ◦ corroborated
  // low-confidence (a bare/doublespace/shorttag guess vouched for by another
  // player's high-confidence tag). Flat symbolic glyphs, not per-strategy
  // emoji — three confidence tiers, not seven strategy names.
  const strategyMarker = (strategy) => {
    if (strategy === 'confirmed') return '✓';
    if (strategy === 'bracket' || strategy === 'separator' || strategy === 'prefixSymbol') return '•';
    if (strategy) return '◦';
    return '';
  };
  const nameOf = (id) => {
    const base = escapeMarkdown(truncate(trace.memberNames.get(id) ?? id, 18));
    const marker = strategyMarker(trace.memberStrategies?.get(id));
    return marker ? `${base}${marker}` : base;
  };
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
  let confirmedCount = 0;
  for (const strategy of trace.memberStrategies?.values() ?? []) {
    if (strategy === 'confirmed') confirmedCount += 1;
  }

  // ── Summary embed ───────────────────────────────────────────────
  const summaryFields = [
    { name: plugin.localize('slackersSquadServices.clansEmbeds.playersScanned'), value: `${trace.scanned}`, inline: true },
    { name: plugin.localize('slackersSquadServices.clansEmbeds.groupsActive'), value: `🟢 ${groupEntries.length}`, inline: true },
    { name: plugin.localize('slackersSquadServices.clansEmbeds.confirmed'), value: confirmedCount ? `✓ ${confirmedCount}` : '⚫ 0', inline: true },
    { name: plugin.localize('slackersSquadServices.clansEmbeds.tagsExcluded'), value: excludedCount ? `🟠 ${excludedCount}` : '⚫ 0', inline: true },
    { name: plugin.localize('slackersSquadServices.clansEmbeds.playersGrouped'), value: `${groupedPlayerCount}`, inline: true },
    { name: plugin.localize('slackersSquadServices.clansEmbeds.noTagDetected'), value: `${trace.noTag.length}`, inline: true },
    { name: plugin.localize('slackersSquadServices.clansEmbeds.tagsMerged'), value: trace.merged.length ? `🟣 ${trace.merged.length}` : '⚫ 0', inline: true },
    {
      name: plugin.localize('slackersSquadServices.clansEmbeds.groupingConfig'),
      value: [
        plugin.localize('slackersSquadServices.clansEmbeds.minsizeMinsizeMaxsizeMaxsize', { minSize: options.minSize, maxSize: options.maxSize }),
        plugin.localize('slackersSquadServices.clansEmbeds.matchingOptions', { maxEditDistance: options.maxEditDistance, minMergeLength: options.minMergeLength, caseSensitive: options.caseSensitive }),
        plugin.localize('slackersSquadServices.clansEmbeds.recruitsuffixesOptions', { options: options.recruitSuffixes.length ? options.recruitSuffixes.join(', ') : 'none' }),
        plugin.localize('slackersSquadServices.clansEmbeds.ignorelistOptions', { options: options.ignoreList.length ? options.ignoreList.join(', ') : 'none' })
      ].join('\n'),
      inline: false
    }
  ];

  if (groupEntries.length > 0) {
    pushLineField(
      plugin,
      summaryFields,
      `🛡️ Active Clan Groups (${groupEntries.length})`,
      groupEntries.map(([tag, ids]) => `**${tagOf(tag)}** (${ids.length}) — ${memberList(ids)}`),
      { maxFields: 3 }
    );
  } else {
    summaryFields.push({
      name: plugin.localize('slackersSquadServices.clansEmbeds.activeClanGroups'),
      value: plugin.localize('slackersSquadServices.clansEmbeds.noneSurvivedTheGrouping'),
      inline: false
    });
  }

  const embeds = [{
    color: 0xf1c40f,
    title: plugin.localize('slackersSquadServices.clansEmbeds.clanGroups'),
    description: plugin.localize('slackersSquadServices.clansEmbeds.pipelineOrderExtractStrip')
      + plugin.localize('slackersSquadServices.clansEmbeds.corroborationGateIgnorelistDamerau')
      + plugin.localize('slackersSquadServices.clansEmbeds.markersConfirmedHighConfidence'),
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
    pushLineField(plugin, detailFields, `📏 Excluded by Size (${trace.sizeExcluded.length})`, lines, { maxFields: 2 });
  }

  if (trace.ignored.length > 0) {
    const lines = trace.ignored.map(
      (e) => `**${tagOf(e.tag)}** (${e.size}) — on \`ignoreList\` — ${memberList(e.members, 4)}`
    );
    pushLineField(plugin, detailFields, `🚫 Excluded by Config (${trace.ignored.length})`, lines, { maxFields: 2 });
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
      plugin,
      detailFields,
      `🔗 Merged by Damerau-Levenshtein ≤ ${options.maxEditDistance}, ≥${options.minMergeLength} chars (${trace.merged.length})`,
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
      plugin,
      detailFields,
      `🎓 Recruit Suffix Stripped (${trace.recruitStripped.length})`,
      [...byRule.entries()].map(([rule, n]) => `**${rule}** — ${n} player(s)`),
      { maxFields: 1 }
    );
  }

  if (trace.unnormalizable.length > 0) {
    pushLineField(
      plugin,
      detailFields,
      `⚪ Tag Normalized to Empty (${trace.unnormalizable.length})`,
      trace.unnormalizable.map((e) => `**${tagOf(e.raw)}** — ${nameOf(e.eosID)}`),
      { maxFields: 1 }
    );
  }

  if (trace.noTag.length > 0) {
    detailFields.push({
      name: plugin.localize('slackersSquadServices.clansEmbeds.noTagDetectedNotagcount', { noTagCount: trace.noTag.length }),
      value: truncate(
        `${trace.noTag.slice(0, 12).map((e) => truncate(e.name, 18)).join(', ')}`
        + (trace.noTag.length > 12 ? `, +${trace.noTag.length - 12} more` : ''),
        1024
      ),
      inline: false
    });
  }

  if (trace.uncorroborated?.length > 0) {
    pushLineField(
      plugin,
      detailFields,
      `🔍 Uncorroborated (${trace.uncorroborated.length})`,
      trace.uncorroborated.map((e) => `**${tagOf(e.tag)}** — ${nameOf(e.eosID)}`),
      { maxFields: 1 }
    );
  }

  if (trace.skipped.length > 0) {
    detailFields.push({
      name: plugin.localize('slackersSquadServices.clansEmbeds.skippedMissingNameOr'),
      value: plugin.localize('slackersSquadServices.clansEmbeds.skippedRecords', { skippedCount: trace.skipped.length }),
      inline: false
    });
  }

  if (detailFields.length > 0) {
    embeds.push({
      color: 0xe67e22,
      title: plugin.localize('slackersSquadServices.clansEmbeds.clanGroupingExclusionsMerges'),
      fields: detailFields.slice(0, 25)
    });
  }

  return embeds;
}

export function buildLocksEmbed(plugin) {
  const players = plugin.services.players;
  if (!players) {
    return { color: 0xe74c3c, title: plugin.localize('slackersSquadServices.locks.playersServiceNotAvailable') };
  }

  const globalOwner = players.isGloballyLockedBy?.() ?? null;
  const globalLock = players.globalLock ?? null;

  const fields = [
    {
      name: plugin.localize('slackersSquadServices.locks.globalLock'),
      value: globalOwner
        ? plugin.localize('slackersSquadServices.locks.expires', { globalOwner, expiresAt: formatTimestamp(globalLock?.expiresAt ?? 0, plugin.localize('slackersSquadServices.labels.notAvailable')) })
        : plugin.localize('slackersSquadServices.locks.none'),
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
      return plugin.localize('slackersSquadServices.locks.playerLockLine', { name: truncate(name, 20), source: l.source, expiresAt: formatTimestamp(l.expiresAt, plugin.localize('slackersSquadServices.labels.notAvailable')) });
    });

    fields.push({
      name: plugin.localize('slackersSquadServices.locks.perPlayerLocksActivelockscount', { activeLocksCount: activeLocks.length }),
      value: truncate(lockLines.join('\n'), 1024),
      inline: false
    });
  } else {
    fields.push({
      name: plugin.localize('slackersSquadServices.locks.perPlayerLocks'),
      value: plugin.localize('slackersSquadServices.locks.noneActive'),
      inline: false
    });
  }

  // Priority table
  fields.push({
    name: plugin.localize('slackersSquadServices.locks.lockPriorityOrder'),
    value: Object.entries(players.PRIORITY ?? {})
      .sort(([, a], [, b]) => b - a)
      .map(([name, pri]) => `${pri}: ${name}`)
      .join('\n'),
    inline: true
  });

  return {
    color: 0xe74c3c,
    title: plugin.localize('slackersSquadServices.locks.lockState'),
    fields,
    timestamp: new Date().toISOString()
  };
}

/**
 * Render one registry row as the short reference an operator types back.
 *
 * The id is always shown alongside the alias, because the id is what appears in
 * log lines and the alias is what appears in commands, and the moment those two
 * have to be matched up by hand is the moment the wrong server gets targeted.
 *
 * The advertised name comes last when there is one worth showing. `label` is
 * how a caller rendering several rows at once hands in the shortened form —
 * what to drop from a name can only be worked out by comparing it with the
 * others, and a row on its own has nothing to compare against.
 */
function describeServerRow(row, label = serverDisplayName(row, { maxLength: 40 })) {
  const name = row.alias ? `\`${row.alias}\`` : `\`#${row.serverID}\``;
  return `${name} (id ${row.serverID}${label ? ` — ${label}` : ''})`;
}

/**
 * Turn an import plan into the two things an operator has to read before
 * agreeing: what will happen to each table, and whose rows are at risk.
 *
 * The overwrite count is the one that matters and the one nothing used to
 * report. `model.upsert()` matches on the primary key, and for every table
 * keyed on an autoincrement `id` that key says nothing about which server a
 * row belongs to — so an envelope taken from a pre-multi-server database
 * addresses ids that now belong to a sibling, and each one of those is a
 * silent replacement of a row somebody else is still using.
 *
 * @param {object} plugin - The S³ plugin instance
 * @param {object} plan - From planImport()
 * @param {object[]} registered - Registry rows, for naming servers
 * @returns {{lines: string[], fields: object[]}}
 */
function renderImportPlan(plugin, plan, registered) {
  const L = (key, vars) => plugin.localize(`slackersSquadServices.db.${key}`, vars);
  const names = (ids) => describeServerIDs(registered, ids, L('serverNotRegistered'));

  const lines = Object.entries(plan.tables).map(([name, entry]) => {
    if (entry.status === 'skipped') return `⏭️ **${name}**: ${L('importNotRestorable', { table: name })}`;
    if (entry.status === 'unknown') return `❌ **${name}**: ${L('importNoModelForTable', { table: name, rows: String(entry.total) })}`;
    if (entry.status === 'error') return `❌ **${name}**: ${entry.error}`;

    // Tags, not columns: on a single-server install every one of these is
    // zero and the line reads exactly as it did before any of this existed.
    const tags = [];
    if (entry.stamp > 0) tags.push(L('importTagAdopted', { n: entry.stamp }));
    if (entry.remap > 0) tags.push(L('importTagRemapped', { n: entry.remap }));
    if (entry.foreign > 0) tags.push(L('importTagForeign', { n: entry.foreign }));
    if (entry.skip > 0) tags.push(L('importTagSkipped', { n: entry.skip }));
    if (entry.overwrite === null) tags.push(L('importTagOverwriteUnknown'));
    else if (entry.overwrite > 0) tags.push(L('importTagOverwritten', { n: entry.overwrite }));

    const written = entry.write + entry.stamp + entry.remap + entry.foreign;
    return `✅ **${name}**: ${written} rows${tags.length > 0 ? ` (${tags.join(' · ')})` : ''}`;
  });

  const fields = [{
    name: L('importScopeHeader'),
    value: plan.remapServer
      ? L('importScopeRemap', { serverID: String(plan.serverID) })
      : plan.allServers
        ? L('importScopeAll')
        : L('importScopeOwn', { serverID: String(plan.serverID) }),
    inline: false
  }];

  if (plan.totals.stamp > 0) {
    fields.push({ name: L('importLegacyHeader'), value: L('importLegacyRule', { n: plan.totals.stamp, serverID: String(plan.serverID) }), inline: false });
  }

  fields.push({
    name: L('importOverwriteHeader'),
    value: plan.totals.overwrite > 0
      ? L('importOverwriteLine', {
        n: plan.totals.overwrite,
        servers: plan.overwrittenServerIDs.length > 0 ? names(plan.overwrittenServerIDs) : L('importOverwriteUnattributed')
      })
      : L('importOverwriteNone'),
    inline: false
  });

  if (plan.totals.skip > 0) {
    fields.push({ name: L('importSkippedHeader'), value: L('importSkippedLine', { n: plan.totals.skip, servers: names(plan.skippedServerIDs) }), inline: false });
  }

  if (plan.totals.foreign > 0) {
    fields.push({ name: L('importForeignHeader'), value: L('importForeignLine', { n: plan.totals.foreign, servers: names(plan.writtenServerIDs.filter((id) => id !== plan.serverID)) }), inline: false });
  }

  if (plan.unknownTables.length > 0) {
    fields.push({
      name: L('importUnknownHeader'),
      value: L('importUnknownLine', { tables: plan.unknownTables.map((t) => `\`${t.name}\` (${t.rows})`).join(', ') }),
      inline: false
    });
  }

  return { lines, fields };
}

/**
 * Render a set of server ids the way an operator has to read them before
 * agreeing to something: by name.
 *
 * Every confirmation in the export and import surface names the servers it
 * will touch rather than counting them, because "this will overwrite rows on
 * 2 servers" is not a sentence anyone can check against what they meant.
 *
 * An id with no registry row still renders. That is a server that was
 * forgotten, or an envelope taken from a community this database is not, and
 * both are exactly the cases an operator needs to see before agreeing —
 * dropping them would understate what the operation touches. `unknownLabel`
 * is passed in already localized because this file's row renderer is
 * structure rather than prose, and one untranslated word inside a translated
 * embed is worse than either.
 *
 * @param {object[]} rows - Registry rows, from getRegisteredServers()
 * @param {Array<number>} ids - Server ids to render, in any order
 * @param {string|null} [unknownLabel] - Shown for an id with no registry row
 * @returns {string} Comma-separated, ids ascending
 */
export function describeServerIDs(rows, ids, unknownLabel = null) {
  const list = Array.isArray(rows) ? rows : [];
  const labels = serverLabels(list, { maxLength: 40 });
  const byID = new Map(list.map((row) => [row.serverID, row]));

  return [...new Set(ids)]
    .sort((a, b) => a - b)
    .map((id) => {
      const row = byID.get(id);
      if (row) return describeServerRow(row, labels.get(id));
      return `\`#${id}\` (id ${id}${unknownLabel ? ` — ${unknownLabel}` : ''})`;
    })
    .join(', ');
}

/**
 * Render one community-option value for the per-server options line.
 *
 * Almost every value is a scalar and wants `key=value`. The exception is
 * `channels`, written by recordChannelBinding() into the same blob — it is an
 * object one level deep (`{ switchReporting: '123' }`), and `${v}` on it prints
 * the literal `[object Object]` in an operator-facing embed. Spell a one-level
 * object out as `[switchReporting=123]`; fall back to compact JSON for anything
 * unexpectedly deeper rather than guess at a layout.
 */
function formatCommunityOptionValue(value) {
  if (value === null || typeof value !== 'object') return String(value);
  const entries = Object.entries(value);
  if (entries.length === 0) return '(none)';
  if (entries.every(([, v]) => v === null || typeof v !== 'object')) {
    return `[${entries.map(([k, v]) => `${k}=${v}`).join(', ')}]`;
  }
  return JSON.stringify(value);
}

/**
 * The server registry — who else writes to this database.
 *
 * Everything that can silently disagree between servers is surfaced here rather
 * than in a command of its own: the suite version each row was written by, the
 * community-affecting option values behind it, and each host's clock skew
 * against the database. This is the one command an operator already runs to see
 * the server list, so it is where a disagreement has a chance of being noticed
 * before it becomes a symptom.
 *
 * Registered and live are both shown, and they are different questions. The
 * count is what the operator-facing gates use — a stale row is still a server
 * the community owns, and dropping back to implicit targeting because a process
 * happens to be restarting is exactly the hazard the selectors exist for.
 * Freshness is per row because it says whether a `--server` aimed at that row
 * would reach anything.
 *
 * @param {object} plugin - The S³ plugin instance
 * @returns {Promise<object>} A Discord embed
 */
export async function buildServersEmbed(plugin) {
  const db = plugin.services.db;
  const NA = plugin.localize('slackersSquadServices.labels.notAvailable');

  if (!db || !db.isReady() || !db.ServersModel) {
    return {
      color: 0xe74c3c,
      title: plugin.localize('slackersSquadServices.servers.title'),
      description: plugin.localize('slackersSquadServices.servers.registryUnavailable')
    };
  }

  const rows = await db.getRegisteredServers();
  if (rows.length === 0) {
    return {
      color: 0x95a5a6,
      title: plugin.localize('slackersSquadServices.servers.title'),
      description: plugin.localize('slackersSquadServices.servers.empty')
    };
  }

  const now = await db.dbNow();
  const mine = db.getServerID();

  // Worked out across the whole registry rather than per row: what is padding
  // in a server name is whatever every server's name also says, and one row
  // read on its own cannot show that.
  const labels = serverLabels(rows);

  const fields = rows.map((row) => {
    const fresh = DBService.isServerRowFresh(row, now);
    const lastSeen = DBService._asEpochMs(row.lastSeenAt);

    const lines = [
      plugin.localize('slackersSquadServices.servers.lastSeenLine', {
        state: fresh
          ? plugin.localize('slackersSquadServices.servers.stateLive')
          : plugin.localize('slackersSquadServices.servers.stateStale'),
        age: lastSeen === null ? NA : formatDuration(Math.max(0, now - lastSeen))
      }),
      plugin.localize('slackersSquadServices.servers.suiteVersionLine', { version: row.suiteVersion || NA }),
      plugin.localize('slackersSquadServices.servers.addressLine', {
        host: row.host || NA,
        queryPort: row.queryPort ?? NA,
        rconPort: row.rconPort ?? NA
      })
    ];

    // Surfaced per row rather than only logged, because the log line is written
    // on the machine whose clock is wrong. The operator asking why a lock
    // expired early is reading one Discord channel, not three server consoles.
    if (row.clockSkewMs !== null && row.clockSkewMs !== undefined) {
      lines.push(plugin.localize('slackersSquadServices.servers.clockSkewLine', {
        skew: `${row.clockSkewMs > 0 ? '+' : ''}${row.clockSkewMs}`
      }));
    }

    // A divergence here is the whole subject of the config-divergence work, and
    // this is where it becomes visible without anyone going looking for it.
    const options = parseCommunityOptions(row.communityOptions);
    if (options && Object.keys(options).length > 0) {
      lines.push(plugin.localize('slackersSquadServices.servers.optionsLine', {
        options: Object.entries(options).map(([k, v]) => `${k}=${formatCommunityOptionValue(v)}`).join(', ')
      }));
    }

    const label = labels.get(row.serverID);

    const heading = [
      row.alias ? `\`${row.alias}\`` : plugin.localize('slackersSquadServices.servers.unnamed'),
      `(id ${row.serverID})`,
      row.serverID === mine ? plugin.localize('slackersSquadServices.servers.thisServer') : '',
      label ? `— ${label}` : ''
    ].filter(Boolean).join(' ');

    return { name: truncate(heading, 256), value: truncate(lines.join('\n'), 1024), inline: false };
  });

  // Where an operator sees the community-option picture. A per-row options
  // line already shows the values; what it cannot do is make two of them
  // differing across six fields visible, or say which of the three treatments
  // in community-options.js the divergence is getting.
  const { resolved, disagreements } = await db.getCommunityOptionSummary();
  if (disagreements.length > 0) {
    const lines = disagreements.map((entry) => {
      const what = describeDisagreement(entry);
      if (entry.kind === OPTION_KIND.RESOLVED) {
        const winner = resolved[entry.name];
        return plugin.localize('slackersSquadServices.servers.configResolvedLine', {
          disagreement: what,
          server: winner ? (winner.alias || `#${winner.serverID}`) : NA
        });
      }
      if (entry.kind === OPTION_KIND.MUST_AGREE) {
        return plugin.localize('slackersSquadServices.servers.configRefuseLine', { disagreement: what });
      }
      return plugin.localize('slackersSquadServices.servers.configDifferLine', { disagreement: what });
    });

    fields.push({
      name: plugin.localize('slackersSquadServices.servers.configHeading'),
      value: truncate(lines.join('\n'), 1024),
      inline: false
    });
  }

  const live = rows.filter((row) => DBService.isServerRowFresh(row, now)).length;

  return {
    color: 0x3498db,
    title: plugin.localize('slackersSquadServices.servers.title'),
    description: plugin.localize('slackersSquadServices.servers.summary', { registered: rows.length, live }),
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: plugin.localize('slackersSquadServices.servers.footer') }
  };
}

export function buildConfigEmbed(plugin) {
  const sc = plugin.services.serverConfig;
  if (!sc) {
    return { color: 0xe74c3c, title: plugin.localize('slackersSquadServices.config.serverconfigServiceNotAvailable') };
  }

  const config = sc.getConfig?.() ?? {};
  const loaded = sc.isLoadedSuccessfully?.() ?? false;
  const NA = plugin.localize('slackersSquadServices.labels.notAvailable');
  const path = sc.getConfigPath?.() ?? NA;

  const fields = [
    { name: plugin.localize('slackersSquadServices.config.loaded'), value: loaded ? plugin.localize('slackersSquadServices.config.yes') : plugin.localize('slackersSquadServices.config.noMountedButParsing'), inline: true },
    { name: plugin.localize('slackersSquadServices.config.configPath'), value: truncate(path, 50), inline: true },
    { name: 'AllowTeamChanges', value: `${config.AllowTeamChanges ?? NA}`, inline: true },
    { name: 'MaxPlayers', value: `${config.MaxPlayers ?? NA}`, inline: true },
    { name: 'NumReservedSlots', value: `${config.NumReservedSlots ?? NA}`, inline: true },
    { name: 'TimeBetweenMatches', value: `${config.TimeBetweenMatches ?? NA}s`, inline: true },
    { name: 'TimeBeforeVote', value: `${config.TimeBeforeVote ?? NA}s`, inline: true },
    { name: 'TeamVote_Duration', value: `${config.TeamVote_Duration ?? NA}s`, inline: true },
    { name: 'LayerVoteDuration', value: `${config.LayerVoteDuration ?? NA}s`, inline: true }
  ];

  return {
    color: 0x34495e,
    title: plugin.localize('slackersSquadServices.config.serverConfiguration'),
    fields,
    timestamp: new Date().toISOString()
  };
}

// ============================================================================
// Switch / Karma Reports (!s3 switches, !s3 karma)
// ============================================================================

// Display-only grouping for Discord embeds: nobody asks "how exactly did
// switch.js move this player" — self-serve, queued-pairing, join-handshake and
// double-swap all read as one "the switch plugin did it" line. Full/Micro/
// Legacy scrambles stay split out on purpose — that distinction is the whole
// point of the original Fiercer ask. Kept as two separate group lists (rather
// than one flat list sorted by count) so the embed can render scrambles and
// manual/self switches as visually separate sections instead of interleaving
// them by count, which read as noise during review.
//
// Each group carries two names: `label` is the CSV column header in
// `!s3 switches export` and stays English so a saved spreadsheet keeps
// finding its column, while `key` is what the Discord embeds render.
const SCRAMBLE_SOURCE_GROUPS = [
  { label: 'Full Scramble', key: 'slackersSquadServices.sourceGroups.fullScramble', sources: ['TeamBalancer:Full'] },
  { label: 'Micro (Elo-Diff)', key: 'slackersSquadServices.sourceGroups.microEloDiff', sources: ['TeamBalancer:Micro'] },
  { label: 'Team-Balancer (Legacy)', key: 'slackersSquadServices.sourceGroups.teamBalancerLegacy', sources: ['TeamBalancer'] },
  { label: 'SmartAssign', key: 'slackersSquadServices.sourceGroups.smartAssign', sources: ['SmartAssign'] }
];

const MANUAL_SOURCE_GROUPS = [
  { label: 'Switch (Self)', key: 'slackersSquadServices.sourceGroups.switchSelf', sources: ['Player-Self', 'Player-Queue', 'Handshake-Swap', 'Switch-Double-Swap'] },
  { label: 'Admin-Forced', key: 'slackersSquadServices.sourceGroups.adminForced', sources: ['Admin-Force'] },
  { label: 'In-Game / Untracked', key: 'slackersSquadServices.sourceGroups.inGameUntracked', sources: ['Manual/Game'] },
  { label: 'Other', key: 'slackersSquadServices.sourceGroups.other', sources: ['Other'] }
];

// bySource values are plain counts (switches) here.
function groupSwitchCounts(bySource, groups) {
  return groups
    .map((g) => ({ key: g.key, count: g.sources.reduce((sum, s) => sum + (bySource[s] || 0), 0) }))
    .filter((g) => g.count > 0);
}

// Minimum decided self/untracked switches before the karma verdict commits to
// a directional read — below this, a 100%/0% rate is sample noise, not signal.
const KARMA_MIN_SAMPLE = 5;

/**
 * The actual "karma" question: does this player's own switching behaviour
 * (not a balancer/SmartAssign move they had no say in) tend to land them on
 * the winning side. Scrambles are informative about the balancer, not the
 * player, so they're excluded here even though the overall win-rate stat
 * above includes them.
 */
function buildKarmaVerdict(plugin, winRate, decided) {
  if (decided < KARMA_MIN_SAMPLE) {
    return plugin.localize('slackersSquadServices.reports.karmaNotEnough', { decided, minSample: KARMA_MIN_SAMPLE });
  }
  const pct = (winRate * 100).toFixed(1);
  if (winRate >= 0.60) return plugin.localize('slackersSquadServices.reports.karmaStrongWinner', { pct });
  if (winRate >= 0.55) return plugin.localize('slackersSquadServices.reports.karmaLeansWinner', { pct });
  if (winRate > 0.45) return plugin.localize('slackersSquadServices.reports.karmaNeutral', { pct });
  if (winRate > 0.40) return plugin.localize('slackersSquadServices.reports.karmaLeansLoser', { pct });
  return plugin.localize('slackersSquadServices.reports.karmaStrongLoser', { pct });
}

// bySource values are {wins, decided, total} here.
function groupKarmaBuckets(bySource, groups) {
  return groups
    .map((g) => {
      const merged = g.sources.reduce((acc, s) => {
        const v = bySource[s];
        if (v) {
          acc.wins += v.wins;
          acc.decided += v.decided;
          acc.total += v.total;
        }
        return acc;
      }, { wins: 0, decided: 0, total: 0 });
      return { key: g.key, ...merged };
    })
    .filter((g) => g.total > 0);
}

function formatReportRange(plugin, range) {
  const from = new Date(range.fromTs).toISOString().slice(0, 10);
  const to = new Date(range.toTs).toISOString().slice(0, 10);
  return `${from} → ${to}${range.capped ? ' ' + plugin.localize('slackersSquadServices.reports.rangeCapped') : ''}`;
}

function formatIgnoredModesNote(plugin, ignoredGameModes) {
  const modes = (ignoredGameModes || []).filter(Boolean);
  return modes.length ? plugin.localize('slackersSquadServices.reports.excludesModes', { modes: modes.join('/') }) : '';
}

// Games-played counts come from TB_RoundReport (see getGamesPlayedMap in
// s3-switch-reports.js), which is gated by TeamBalancer's OWN
// enableDatabaseLogging — independently of S³'s. checkLoggingAvailability()
// already blocks the whole command when S³'s own logging is off; this covers
// the narrower case where S³'s is fine but TeamBalancer's isn't, so a
// silent "0 games" doesn't get mistaken for real data.
function formatRoundDataNote(plugin, availability) {
  if (availability.hasRoundOutcomeData && !availability.roundOutcomeDataLogged) {
    return plugin.localize('slackersSquadServices.reports.noRoundDataNote');
  }
  return '';
}

/**
 * Arguments that look like a flag but are not one this subcommand accepts.
 *
 * `!s3 migrate force [--dry-run]` — the usage string pasted verbatim, square
 * brackets and all — applied a real schema migration on a live server. The
 * flag was read with an exact-match `args.includes('--dry-run')`, `[--dry-run]`
 * is not `--dry-run`, so the check returned false and a command whose unflagged
 * default is destructive took that default without a word. Usage strings are
 * written to be copied, so this is not an exotic input; it is the obvious one.
 *
 * The fix deliberately is not to normalise brackets away and guess what the
 * operator meant. Flags here come in two polarities — `--dry-run` is a safety
 * flag whose absence means "destroy", `--confirm` is an arming flag whose
 * absence means "don't" — and any rule generous enough to rescue a mangled
 * `--dry-run` would, by the same token, arm a mangled `--confirm`. So the rule
 * is to refuse instead: a token carrying a dash or a bracket that is not a flag
 * we recognise is a typo or a paste artefact, and the only safe reading of "the
 * operator asked for something we did not understand" is to run nothing at all.
 *
 * Callers pass the positional arguments they legitimately accept, which on
 * these handlers are confirmation tokens, plugin names and backup filenames —
 * none of which carry a leading dash or a bracket, so they pass through.
 *
 * @param {string[]} args  - The argument list as tokenised by s3-discord.js.
 * @param {string[]} known - Exact flag spellings this subcommand accepts.
 * @returns {string[]} Offending arguments, empty when the command is clean.
 */
function strayFlags(args, known) {
  const knownSet = new Set(known);
  return args.filter((a) => !knownSet.has(a) && /^[[<("'`]*-|^[[<]/.test(a));
}

/**
 * Refuse a command that carries an argument we do not recognise, and say which.
 * Returns true when the caller must stop.
 */
async function rejectStrayFlags(plugin, message, sendDiscordMessage, args, known) {
  const stray = strayFlags(args, known);
  if (stray.length === 0) return false;

  await sendDiscordMessage(message.channel, {
    embeds: [{
      color: 0xe74c3c,
      title: plugin.localize('slackersSquadServices.args.unrecognisedArgument'),
      // `!s3 confirm` takes no flags at all. Rendering that as an empty list
      // read as a rendering fault when it first went out live, so the two
      // cases are separate sentences rather than one sentence with a hole.
      description: plugin.localize('slackersSquadServices.args.nothingWasRun', {
        args: stray.map((a) => `\`${a}\``).join(', '),
        accepts: known.length
          ? plugin.localize('slackersSquadServices.args.acceptsFlags', { known: known.map((k) => `\`${k}\``).join(', ') })
          : plugin.localize('slackersSquadServices.args.acceptsNoFlags')
      }),
      timestamp: new Date().toISOString()
    }]
  }, 'S3', (...a) => plugin.verbose(...a));
  return true;
}

/**
 * Apply every pending plugin's migrations, isolating one plugin's failure from
 * the rest of the batch.
 *
 * Both Discord migration paths used to stop at the first rejection, which reads
 * like caution and is not. Schema versions are recorded PER PLUGIN, each
 * migration takes an advisory lock keyed on its own plugin name, and each runs
 * in its own transaction — so a failure in one plugin carries no information
 * about any other, and abandoning the rest protects nothing. What it does do is
 * leave them pending behind a neighbour they have nothing to do with, with the
 * registration order deciding which ones ever get a turn. That is not
 * hypothetical here: a live database whose user cannot ALTER refuses the same
 * column-adding migration on every attempt, so one such plugin permanently
 * blocks every plugin registered after it.
 *
 * The autoMigrate path already behaves this way and already draws the same
 * distinction between a lock it lost and a migration that failed — see the loop
 * in slackers-squad-services.js. This is the same shape for the operator-driven
 * paths.
 *
 * The one failure that still stops the batch is locking being unavailable at the
 * SERVICE level. acquireAdvisoryLock() fails closed permanently when S3_Locks
 * could not be created, so every remaining plugin is certain to fail for that
 * one reason; continuing would report a single problem N times and bury it.
 * A lock merely lost to another process is NOT that — it is per-plugin and
 * transient, so it is recorded and the batch carries on.
 *
 * @param {object} me - The MigrationEngine.
 * @param {object} db - DBService, for isLockingAvailable().
 * @param {Array<{pluginName: string}>} pending
 * @param {{dryRun?: boolean}} [options]
 * @returns {Promise<{totalApplied: number, totalSkipped: number,
 *   failures: Array<{pluginName: string, message: string, lostLock: boolean}>,
 *   attempted: number, aborted: boolean}>}
 */
async function runMigrationBatch(me, db, pending, options = {}) {
  const { dryRun = false } = options;
  let totalApplied = 0;
  let totalSkipped = 0;
  let attempted = 0;
  const failures = [];
  let aborted = false;

  for (const p of pending) {
    attempted++;
    try {
      const result = await me.runMigrations(p.pluginName, { dryRun });
      totalApplied += result.applied || 0;
      totalSkipped += result.skipped || 0;
    } catch (err) {
      failures.push({
        pluginName: p.pluginName,
        message: err?.message || String(err),
        lostLock: err?.code === MIGRATION_LOCK_UNAVAILABLE
      });
      // Read the service, not the message text: "another process holds it" and
      // "this connection can never hold one" arrive as the same error code.
      if (db?.isLockingAvailable?.() === false) {
        aborted = true;
        break;
      }
    }
  }

  return { totalApplied, totalSkipped, failures, attempted, aborted };
}

/**
 * Compose the `error` text for a failed migration batch: which plugins failed
 * and why, whether the rest were attempted, and how much of the batch got
 * through. Named per plugin because with isolation the batch can now fail in
 * more than one place at once, and "**Error:** <one message>" no longer says
 * which plugin produced it.
 */
function describeBatchFailures(plugin, batch, pending) {
  const parts = batch.failures.map((f) =>
    plugin.localize('slackersSquadServices.migration.failureLine', {
      pluginName: f.pluginName,
      errorMsg: f.message
    })
  );

  if (batch.aborted && batch.attempted < pending.length) {
    parts.push('', plugin.localize('slackersSquadServices.migration.batchAborted'));
  }

  const succeeded = batch.attempted - batch.failures.length;
  if (succeeded > 0) {
    parts.push('', plugin.localize('slackersSquadServices.migration.partialProgress', {
      succeeded,
      total: pending.length
    }));
  }

  return parts.join('\n');
}

// Generic to any embed's 4096-char description limit — distinct from
// pushLineField()'s 1024-char per-field chunking used elsewhere in this file.
function chunkLines(lines, maxLen) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const line of lines) {
    if (currentLen + line.length + 1 > maxLen && current.length > 0) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += line.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length ? chunks : [[]];
}

function buildAvailabilityWarningEmbed(plugin, availability) {
  if (availability.reason === 'dbUnavailable') {
    return {
      color: 0xe74c3c,
      title: plugin.localize('slackersSquadServices.availabilityWarning.databaseNotReady'),
      description: plugin.localize('slackersSquadServices.availabilityWarning.theSDatabaseService'),
      timestamp: new Date().toISOString()
    };
  }
  return {
    color: 0xf39c12,
    title: plugin.localize('slackersSquadServices.availabilityWarning.noEventDataLogged'),
    description: [
      plugin.localize('slackersSquadServices.availabilityWarning.noS3PlayereventsRows'),
      plugin.localize('slackersSquadServices.availabilityWarning.thisAlmostAlwaysMeans')
    ].join('\n'),
    timestamp: new Date().toISOString()
  };
}

function buildAmbiguousPlayerEmbed(plugin, identifier, candidates) {
  const lines = candidates.slice(0, 10).map((c) => `\`${c.eosID}\` — ${escapeMarkdown(c.name ?? '?')}`);
  return {
    color: 0xf39c12,
    title: plugin.localize('slackersSquadServices.ambiguousPlayer.ambiguousPlayer'),
    description: plugin.localize('slackersSquadServices.ambiguousPlayer.multiplePlayersMatchIdentifier', { identifier: escapeMarkdown(identifier) }),
    fields: [{ name: plugin.localize('slackersSquadServices.ambiguousPlayer.candidates'), value: lines.join('\n'), inline: false }],
    timestamp: new Date().toISOString()
  };
}

function buildPlayerNotFoundEmbed(plugin, identifier) {
  return {
    color: 0xe74c3c,
    title: plugin.localize('slackersSquadServices.playerNotFound.playerNotFound'),
    description: plugin.localize('slackersSquadServices.playerNotFound.noPlayerMatchingIdentifier', { identifier: escapeMarkdown(identifier) }),
    timestamp: new Date().toISOString()
  };
}

/**
 * Build the `!s3 switches` embed — a top-N leaderboard when no identifier is
 * given, or a single-player drill-down when one is.
 *
 * Returns an embed set (array) rather than a single embed — the leaderboard's
 * line list is paginated across embeds by description length (4096 chars
 * each) instead of Discord's smaller 1024-char field limit, so a "(cont.)"
 * field almost never happens in practice, but the contract stays an array
 * for the rare case it does. Detail/error paths return a one-element array.
 *
 * @param {object} plugin - S³ plugin instance.
 * @param {?string} identifier - Player ident, or null for leaderboard mode.
 * @param {?string} rangeArg - Raw range token ("30d", date range, or null for default).
 * @returns {Promise<object[]>} Discord embed objects — send all of them in one message.
 */
export async function buildSwitchesEmbed(plugin, identifier, rangeArg) {
  const db = plugin.services?.db;
  const range = parseRange(rangeArg);
  if (range.errorKey) {
    return [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.switches.invalidRange'), description: plugin.localize(range.errorKey, range.errorVars), timestamp: new Date().toISOString() }];
  }

  const availability = await checkLoggingAvailability(db, range.fromTs, range.toTs);
  if (!availability.ok) {
    return [buildAvailabilityWarningEmbed(plugin, availability)];
  }

  const ignoredGameModes = plugin.options?.ignoredGameModes;
  const { perPlayer: gamesPlayedMap } = await getGamesPlayedMap(db, range.fromTs, range.toTs, ignoredGameModes);

  if (!identifier) {
    const switchesMap = await getSwitchesMap(db, range.fromTs, range.toTs, ignoredGameModes);
    const rows = [...switchesMap.entries()].map(([eosID, entry]) => ({
      eosID,
      name: entry.name,
      total: entry.total,
      bySource: entry.bySource,
      games: gamesPlayedMap.get(eosID)?.matchIds.size ?? 0
    }));
    rows.sort((a, b) => b.total - a.total);

    const top = rows.slice(0, 20);
    const lines = top.map((r, i) => {
      const full = r.bySource['TeamBalancer:Full'] || 0;
      const micro = r.bySource['TeamBalancer:Micro'] || 0;
      // Pre-Full/Micro-split historical balancer moves — definitionally
      // non-micro (the split didn't exist yet), so folded into the Full
      // count below rather than shown as its own category — three columns
      // where two are perpetually 0 and one silently carries every scramble
      // reads as more categories than actually exist. bucketSource() already
      // merges the 'Team-Balancer' dead-code alias into this key.
      const legacy = r.bySource.TeamBalancer || 0;
      // All player-initiated switch flavours (self-serve, queued pairing, join handshake, double-swap).
      const self = (r.bySource['Player-Self'] || 0) + (r.bySource['Player-Queue'] || 0) +
        (r.bySource['Switch-Double-Swap'] || 0) + (r.bySource['Handshake-Swap'] || 0);
      const other = r.total - full - micro - legacy - self;
      const fullStr = legacy > 0
        ? plugin.localize('slackersSquadServices.reports.leaderboardFullWithLegacy', { full: full + legacy, legacy })
        : plugin.localize('slackersSquadServices.reports.leaderboardFull', { full });
      const otherStr = other > 0 ? plugin.localize('slackersSquadServices.reports.leaderboardOther', { other }) : '';
      return plugin.localize('slackersSquadServices.reports.leaderboardRow', {
        rank: i + 1,
        name: escapeMarkdown(truncate(r.name ?? r.eosID, 24)),
        total: r.total,
        games: r.games,
        fullStr,
        micro,
        self,
        otherStr
      });
    });

    if (lines.length === 0) {
      return [{
        color: 0x3498db,
        title: plugin.localize('slackersSquadServices.switches.teamSwitchLeaderboard'),
        description: formatReportRange(plugin, range),
        fields: [{ name: plugin.localize('slackersSquadServices.switches.noSwitches'), value: plugin.localize('slackersSquadServices.switches.noTeamChangeEvents'), inline: false }],
        timestamp: new Date().toISOString()
      }];
    }

    // "Other" isn't self-explanatory in a bare number list, and Full's "(N
    // legacy)" parenthetical needs a one-line explanation of what "legacy"
    // means — spelled out once here rather than repeated per line.
    const legend = plugin.localize('slackersSquadServices.reports.leaderboardLegend');
    const header = [formatReportRange(plugin, range), formatIgnoredModesNote(plugin, ignoredGameModes), formatRoundDataNote(plugin, availability), legend]
      .filter(Boolean).join('\n');

    // Fits one embed in the overwhelming majority of cases — a description's
    // 4096-char budget is 4x a field's, unlike the old field-based chunking
    // this replaced, which produced a "Top N (cont.)" field per overflow.
    const fullDescription = `${header}\n\n${lines.join('\n')}`;
    if (fullDescription.length <= 4096) {
      return [{
        color: 0x3498db,
        title: plugin.localize('slackersSquadServices.switches.teamSwitchLeaderboard'),
        description: fullDescription,
        timestamp: new Date().toISOString()
      }];
    }

    // Long clan-tagged names pushed this past one embed — split the list only,
    // keeping header/legend on the first page. Each chunk is its own embed
    // (Discord renders up to 10 per message as separate bordered cards), not
    // a repeated field, so there is no "(cont.)" label to read past.
    const budget = Math.max(4096 - header.length - 4, 500);
    const chunks = chunkLines(lines, budget);
    return chunks.map((chunk, i) => ({
      color: 0x3498db,
      title: chunks.length > 1 ? plugin.localize('slackersSquadServices.switches.teamSwitchLeaderboardI', { i: i + 1, chunksCount: chunks.length }) : plugin.localize('slackersSquadServices.switches.teamSwitchLeaderboard'),
      description: i === 0 ? `${header}\n\n${chunk.join('\n')}` : chunk.join('\n'),
      timestamp: new Date().toISOString()
    }));
  }

  const candidates = await resolvePlayers(db, identifier);
  if (candidates.length === 0) return [buildPlayerNotFoundEmbed(plugin, identifier)];
  if (!isUnambiguous(candidates)) return [buildAmbiguousPlayerEmbed(plugin, identifier, candidates)];

  const best = candidates[0];
  const detail = await getPlayerSwitches(db, best.eosID, range.fromTs, range.toTs, ignoredGameModes);
  const games = gamesPlayedMap.get(best.eosID)?.matchIds.size ?? 0;

  const scrambleLines = groupSwitchCounts(detail.bySource, SCRAMBLE_SOURCE_GROUPS)
    .map((g) => `${plugin.localize(g.key)}: **${g.count}**`);
  const manualLines = groupSwitchCounts(detail.bySource, MANUAL_SOURCE_GROUPS)
    .map((g) => `${plugin.localize(g.key)}: **${g.count}**`);

  return [{
    color: 0x3498db,
    title: plugin.localize('slackersSquadServices.switches.teamSwitchesName', { name: escapeMarkdown(detail.name ?? best.name ?? best.eosID) }),
    description: [formatReportRange(plugin, range), formatIgnoredModesNote(plugin, ignoredGameModes), formatRoundDataNote(plugin, availability)].filter(Boolean).join('\n'),
    fields: [
      { name: plugin.localize('slackersSquadServices.switches.summary'), value: plugin.localize('slackersSquadServices.switches.totalSwitchesTotalGames', { total: detail.total, games }), inline: false },
      { name: plugin.localize('slackersSquadServices.switches.balancerScrambles'), value: scrambleLines.length ? scrambleLines.join('\n') : plugin.localize('slackersSquadServices.reports.none'), inline: false },
      { name: plugin.localize('slackersSquadServices.switches.manualSwitch'), value: manualLines.length ? manualLines.join('\n') : plugin.localize('slackersSquadServices.reports.none'), inline: false }
    ],
    timestamp: new Date().toISOString()
  }];
}

/**
 * Build the `!s3 karma <ident>` embed — win-rate of a player's own switch
 * decisions (self-serve, queued, join handshake, or untracked in-game)
 * against the eventual round winner. Balancer/SmartAssign moves are excluded
 * entirely (see KARMA_EXCLUDED_SOURCES in s3-switch-reports.js) — those
 * aren't the player's choice. Requires TeamBalancer's
 * `TB_RoundReport` table for outcome data.
 *
 * @param {object} plugin - S³ plugin instance.
 * @param {?string} identifier - Player ident (required).
 * @param {?string} rangeArg - Raw range token, or null for default.
 * @returns {Promise<object>} Discord embed object.
 */
export async function buildKarmaEmbed(plugin, identifier, rangeArg) {
  const db = plugin.services?.db;
  const range = parseRange(rangeArg);
  if (range.errorKey) {
    return { color: 0xe74c3c, title: plugin.localize('slackersSquadServices.karma.invalidRange'), description: plugin.localize(range.errorKey, range.errorVars), timestamp: new Date().toISOString() };
  }
  if (!identifier) {
    return { color: 0xe74c3c, title: plugin.localize('slackersSquadServices.karma.missingPlayer'), description: plugin.localize('slackersSquadServices.karma.usageS3KarmaIdent'), timestamp: new Date().toISOString() };
  }

  const availability = await checkLoggingAvailability(db, range.fromTs, range.toTs);
  if (!availability.ok) {
    return buildAvailabilityWarningEmbed(plugin, availability);
  }
  if (!availability.hasRoundOutcomeData) {
    return {
      color: 0xf39c12,
      title: plugin.localize('slackersSquadServices.karma.roundOutcomeDataUnavailable'),
      description: plugin.localize('slackersSquadServices.karma.theTbRoundreportTable'),
      timestamp: new Date().toISOString()
    };
  }
  if (!availability.roundOutcomeDataLogged) {
    return {
      color: 0xf39c12,
      title: plugin.localize('slackersSquadServices.karma.noRoundOutcomeData'),
      description: [
        plugin.localize('slackersSquadServices.karma.noTbRoundreportRows'),
        plugin.localize('slackersSquadServices.karma.thisAlmostAlwaysMeans')
      ].join('\n'),
      timestamp: new Date().toISOString()
    };
  }

  const candidates = await resolvePlayers(db, identifier);
  if (candidates.length === 0) return buildPlayerNotFoundEmbed(plugin, identifier);
  if (!isUnambiguous(candidates)) return buildAmbiguousPlayerEmbed(plugin, identifier, candidates);

  const best = candidates[0];
  const ignoredGameModes = plugin.options?.ignoredGameModes;
  const report = await getKarmaReport(db, best.eosID, range.fromTs, range.toTs, ignoredGameModes);
  const description = [formatReportRange(plugin, range), formatIgnoredModesNote(plugin, ignoredGameModes)].filter(Boolean).join('\n');

  // Win-rate alone can't distinguish "switched 3 times in 150 games" from
  // "switched 30 times in 40 games" — one is noise, the other is a pattern.
  // Games played gives the verdict a sample-size anchor the way the
  // `switches` leaderboard already does.
  const { perPlayer: gamesPlayedMap } = await getGamesPlayedMap(db, range.fromTs, range.toTs, ignoredGameModes);
  const games = gamesPlayedMap.get(best.eosID)?.matchIds.size ?? 0;
  const switchRatePct = games > 0 ? ((report.totalSwitches / games) * 100).toFixed(1) : null;
  const gamesSummary = switchRatePct != null
    ? plugin.localize('slackersSquadServices.karma.gamesRate', { games, pct: switchRatePct })
    : plugin.localize('slackersSquadServices.karma.gamesPlayed', { games });

  if (report.totalSwitches === 0) {
    return {
      color: 0x3498db,
      title: plugin.localize('slackersSquadServices.karma.karmaName', { name: escapeMarkdown(best.name ?? best.eosID) }),
      description,
      fields: [{ name: plugin.localize('slackersSquadServices.karma.noQualifyingSwitches'), value: plugin.localize('slackersSquadServices.karma.noSelfUntrackedTeam', { games }), inline: false }],
      timestamp: new Date().toISOString()
    };
  }

  // getKarmaReport() already excludes Admin-Force and every balancer/
  // SmartAssign source at the query level (KARMA_EXCLUDED_SOURCES in
  // s3-switch-reports.js) — report.bySource only ever contains switches the
  // player chose themselves, so no re-filtering is needed here.
  const verdict = buildKarmaVerdict(plugin, report.winRate ?? 0, report.decided);
  const sourceLines = groupKarmaBuckets(report.bySource, MANUAL_SOURCE_GROUPS)
    .map((g) => plugin.localize('slackersSquadServices.karma.bySourceLine', { label: plugin.localize(g.key), wins: g.wins, decided: g.decided, total: g.total }));

  return {
    color: 0x3498db,
    title: plugin.localize('slackersSquadServices.karma.karmaName', { name: escapeMarkdown(best.name ?? best.eosID) }),
    description,
    fields: [
      { name: plugin.localize('slackersSquadServices.karma.summary'), value: plugin.localize('slackersSquadServices.karma.switchesAndOutcome', { totalSwitches: report.totalSwitches, gamesSummary, decided: report.decided }), inline: false },
      { name: plugin.localize('slackersSquadServices.karma.switchKarma'), value: verdict, inline: false },
      { name: plugin.localize('slackersSquadServices.karma.bySource'), value: sourceLines.length ? sourceLines.join('\n') : plugin.localize('slackersSquadServices.reports.none'), inline: false }
    ],
    timestamp: new Date().toISOString()
  };
}

// Same grouping as the Discord embeds above, but as export columns nothing is
// filtered out for being zero — a data doc needs a stable column set across
// every row so it can be pivoted/charted, unlike a compact embed line.
const EXPORT_GROUPS = [...SCRAMBLE_SOURCE_GROUPS, ...MANUAL_SOURCE_GROUPS];

function sumGroup(bySource, group) {
  return group.sources.reduce((sum, s) => sum + (bySource[s] || 0), 0);
}

// Every column used to be a number or ISO date, so a naive join never needed
// escaping. The per-player export adds a free-text Player name column — real
// Squad names routinely contain commas and quotes — so quoting is load-bearing
// now, not defensive.
function csvField(value) {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(csvField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row[h])).join(','));
  }
  return lines.join('\n');
}

/**
 * Build the `!s3 switches export` file attachment — one row per (period,
 * player) for every player who switched or played a round that period, as
 * CSV by default or JSON with `--json`. This is the periodic "data doc" — an
 * exhaustive per-player trend over weeks/months, not a live leaderboard
 * snapshot like the bare `!s3 switches` embed.
 *
 * @param {object} plugin
 * @param {?string} rangeArg
 * @param {?string} periodArg
 * @param {boolean} asJson
 * @returns {Promise<{error:string}|{embed:object, buffer:Buffer, filename:string}>}
 */
export async function buildSwitchesExport(plugin, rangeArg, periodArg, asJson) {
  const db = plugin.services?.db;
  const range = parseRange(rangeArg);
  if (range.errorKey) return { error: plugin.localize(range.errorKey, range.errorVars) };

  if (periodArg && !isPeriodToken(periodArg)) {
    return { error: plugin.localize('slackersSquadServices.switchesExport.unknownPeriod', { period: periodArg }) };
  }
  const period = periodArg ? periodArg.toLowerCase() : 'weekly';

  const availability = await checkLoggingAvailability(db, range.fromTs, range.toTs);
  if (!availability.ok) {
    return {
      error: availability.reason === 'dbUnavailable'
        ? plugin.localize('slackersSquadServices.switchesExport.dbNotReady')
        : plugin.localize('slackersSquadServices.switchesExport.noEventRows')
    };
  }

  const ignoredGameModes = plugin.options?.ignoredGameModes;
  const result = await getSwitchesByPeriodAndPlayer(db, range.fromTs, range.toTs, period, ignoredGameModes);
  if (!result.ok) return { error: plugin.localize('slackersSquadServices.switchesExport.dbNotMounted') };

  const rows = result.periods.flatMap((p) => p.players.map((player) => ({
    'Period Start': new Date(p.periodStart).toISOString(),
    'Period End': new Date(p.periodEnd).toISOString(),
    'Rounds Played': p.rounds,
    'Player': player.name ?? player.eosID,
    'eosID': player.eosID,
    'Games Played': player.games,
    'Total Switches': player.total,
    ...Object.fromEntries(EXPORT_GROUPS.map((g) => [g.label, sumGroup(player.bySource, g)]))
  })));

  const ext = asJson ? 'json' : 'csv';
  const fromStr = new Date(range.fromTs).toISOString().slice(0, 10);
  const toStr = new Date(range.toTs).toISOString().slice(0, 10);
  // The rows are this server's, and a CSV downloaded into a folder beside
  // the neighbour's has nothing else left to say so.
  const filename = `s3-switches${plugin.serverFileTag?.() || ''}-${period}-${fromStr}_to_${toStr}.${ext}`;
  const buffer = asJson
    ? Buffer.from(JSON.stringify(rows, null, 2), 'utf-8')
    : Buffer.from('\uFEFF' + toCsv(rows), 'utf-8');

  return {
    embed: {
      color: 0x2ecc71,
      title: plugin.localize('slackersSquadServices.switchesExport.switchReportExportPeriod', { period }),
      description: [formatReportRange(plugin, range), formatIgnoredModesNote(plugin, ignoredGameModes)].filter(Boolean).join('\n'),
      fields: [
        { name: plugin.localize('slackersSquadServices.switchesExport.periods'), value: `${result.periods.length}`, inline: true },
        { name: plugin.localize('slackersSquadServices.switchesExport.rows'), value: `${rows.length}`, inline: true },
        { name: plugin.localize('slackersSquadServices.switchesExport.format'), value: ext.toUpperCase(), inline: true }
      ],
      timestamp: new Date().toISOString()
    },
    buffer,
    filename
  };
}

export function buildHelpEmbed(plugin) {
  return {
    color: 0x3498db,
    title: plugin.localize('slackersSquadServices.help.sCommandReference'),
    fields: [
      {
        name: plugin.localize('slackersSquadServices.help.inspection'),
        value: [
          plugin.localize('slackersSquadServices.help.s3StatusOverviewServices'),
          plugin.localize('slackersSquadServices.help.s3ServicesPerService'),
          plugin.localize('slackersSquadServices.help.s3GamestateDetailedGame'),
          plugin.localize('slackersSquadServices.help.s3FactionsTeamNames'),
          plugin.localize('slackersSquadServices.help.s3PlayersPopulationOverview'),
          plugin.localize('slackersSquadServices.help.s3ClansClanGroups'),
          plugin.localize('slackersSquadServices.help.s3LocksGlobalAnd'),
          plugin.localize('slackersSquadServices.help.s3ConfigServerConfiguration'),
          plugin.localize('slackersSquadServices.help.s3ServersRegistry')
        ].join('\n'),
        inline: false
      },
      {
        name: plugin.localize('slackersSquadServices.help.reports'),
        value: [
          plugin.localize('slackersSquadServices.help.s3SwitchesRangeTeam'),
          plugin.localize('slackersSquadServices.help.s3SwitchesIdentRange'),
          plugin.localize('slackersSquadServices.help.s3SwitchesExportRange'),
          plugin.localize('slackersSquadServices.help.s3KarmaIdentRange'),
          plugin.localize('slackersSquadServices.help.range7d30dDefault'),
          plugin.localize('slackersSquadServices.help.periodDailyWeeklyDefault')
        ].join('\n'),
        inline: false
      },
      {
        name: plugin.localize('slackersSquadServices.help.debug'),
        value: [
          // S3_WATCH_DEPRECATED — commented out; watch was not useful in testing.
          // '`!s3 watch <service>` — Relay verbose logs [...]',
          // '`!s3 unwatch` — Stop all watches',
          plugin.localize('slackersSquadServices.help.noDebugCommandsAvailable')
        ].join('\n'),
        inline: false
      },
      {
        name: plugin.localize('slackersSquadServices.help.database'),
        value: [
          plugin.localize('slackersSquadServices.help.s3DbStatusConnector'),
          plugin.localize('slackersSquadServices.help.s3DbExportExport'),
          plugin.localize('slackersSquadServices.help.s3DbExportLogs'),
          plugin.localize('slackersSquadServices.help.s3DbExportAll'),
          plugin.localize('slackersSquadServices.help.s3DbExportTo'),
          plugin.localize('slackersSquadServices.help.s3DbImportImport'),
          plugin.localize('slackersSquadServices.help.s3DbImportConfirm')
        ].join('\n'),
        inline: false
      },
      {
        name: plugin.localize('slackersSquadServices.help.maintenance'),
        value: [
          plugin.localize('slackersSquadServices.help.s3MigratePendingShow'),
          plugin.localize('slackersSquadServices.help.s3MigrateStatusShow'),
          plugin.localize('slackersSquadServices.help.s3ConfirmTokenConfirm'),
          plugin.localize('slackersSquadServices.help.s3MigrateForceDry'),
          plugin.localize('slackersSquadServices.help.s3MigratePreviewPreview'),
          plugin.localize('slackersSquadServices.help.s3MigrateDdlEmit'),
          plugin.localize('slackersSquadServices.help.s3MigrateVerifyRun'),
          plugin.localize('slackersSquadServices.help.s3MigratePurgeDeprecated'),
          plugin.localize('slackersSquadServices.help.s3BackupCreateCreate'),
          plugin.localize('slackersSquadServices.help.s3BackupListList'),
          plugin.localize('slackersSquadServices.help.s3BackupRestoreFilename'),
          plugin.localize('slackersSquadServices.help.s3ServersAlias'),
          plugin.localize('slackersSquadServices.help.s3ServersForget')
        ].join('\n'),
        inline: false
      },
      {
        name: plugin.localize('slackersSquadServices.help.diagnostic'),
        value: [
          plugin.localize('slackersSquadServices.help.s3DiagRunAll')
        ].join('\n'),
        inline: false
      },
      {
        name: plugin.localize('slackersSquadServices.help.crossRefExistingPlugin'),
        value: [
          plugin.localize('slackersSquadServices.help.eloBackupEloRestore'),
          plugin.localize('slackersSquadServices.help.teambalancerExportRoundReports')
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
    const detail = mounted ? plugin.localize('slackersSquadServices.runDiagnostic.detailOk') : plugin.localize('slackersSquadServices.runDiagnostic.detailNotMounted');

    // Check for disabled vs truly broken
    if (label === 'clans' && mounted && !svc.isEnabled?.()) {
      results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.labelMounted', { label }), emoji: '⚪', detail: plugin.localize('slackersSquadServices.runDiagnostic.detailDisabledInConfig') });
    } else {
      results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.labelMounted', { label }), emoji, detail });
    }

    // DB-specific: add schema drift diagnostic line
    if (label === 'db' && mounted) {
      const drift = svc.getLastDriftResult?.();
      if (drift !== null && drift !== undefined) {
        if (drift.length === 0) {
          results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.dbSchemaDrift'), emoji: '🟢', detail: plugin.localize('slackersSquadServices.runDiagnostic.detailNoDrift') });
        } else if (drift.some(e => e.error)) {
          results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.dbSchemaDrift'), emoji: '🔴', detail: plugin.localize('slackersSquadServices.runDiagnostic.detailDriftUnverifiable') });
        } else {
          const issueCount = drift.length;
          const missingCount = drift.filter(e => e.missing).length;
          const extraCount = drift.filter(e => e.extra).length;
          let detail;
          if (missingCount > 0 && extraCount > 0) {
            detail = plugin.localize('slackersSquadServices.runDiagnostic.detailDriftBoth', { issueCount, missingCount, extraCount });
          } else if (missingCount > 0) {
            detail = plugin.localize('slackersSquadServices.runDiagnostic.detailDriftMissing', { issueCount });
          } else {
            detail = plugin.localize('slackersSquadServices.runDiagnostic.detailDriftExtra', { issueCount });
          }
          results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.dbSchemaDrift'), emoji: '🟠', detail });
        }
      }
    }
  }

  // ── Game state ────────────────────────────────────────────────
  const phase = gs?.getPhase?.() ?? null;
  const phasePass = !!phase;
  const phaseEm = phase === 'LIVE' ? '🟢' : phase === 'STAGING' ? '🟡' : phase === 'ENDGAME' ? '🔴' : phasePass ? '🟢' : '🔴';
  results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.gamePhaseReadable'), emoji: phaseEm, detail: plugin.localize('slackersSquadServices.runDiagnostic.detailPhase', { phase: phase ?? 'NULL' }) });

  const rawMode = gs?.getGamemode?.() ?? null;
  const mode = rawMode ?? plugin.localize('slackersSquadServices.labels.notAvailable');
  const modeEm = (rawMode && rawMode !== 'Unknown') ? '🟢' : '🟠';
  results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.gamemodeResolved'), emoji: modeEm, detail: plugin.localize('slackersSquadServices.runDiagnostic.detailMode', { mode }) });

  const rawLayer = gs?.getLayerName?.() ?? null;
  const layer = rawLayer ?? plugin.localize('slackersSquadServices.labels.notAvailable');
  const layerEm = (rawLayer && rawLayer !== 'Unknown') ? '🟢' : '🟠';
  results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.layerNameResolved'), emoji: layerEm, detail: plugin.localize('slackersSquadServices.runDiagnostic.detailLayer', { layer }) });

  // ── Factions ──────────────────────────────────────────────────
  const t1 = factions?.getTeamName?.(1) ?? 'Team 1';
  const t2 = factions?.getTeamName?.(2) ?? 'Team 2';
  const t1Pass = t1 !== 'Team 1';
  const t2Pass = t2 !== 'Team 2';
  results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.teamNameResolved'), emoji: t1Pass ? '🟢' : '🟡', detail: t1Pass ? t1 : plugin.localize('slackersSquadServices.team.team1') });
  results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.teamNameResolved2'), emoji: t2Pass ? '🟢' : '🟡', detail: t2Pass ? t2 : plugin.localize('slackersSquadServices.team.team2') });

  // ── Players ───────────────────────────────────────────────────
  const allPlayers = players?.getAllPlayers?.() ?? [];
  const playerEm = allPlayers.length > 0 ? '🟢' : '⚪';
  results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.playerRegistryPopulated'), emoji: playerEm, detail: plugin.localize('slackersSquadServices.runDiagnostic.detailPlayersTracked', { count: allPlayers.length }) });

  const teamsResolved = players?.areTeamsResolved?.() ?? false;
  results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.teamsResolved'), emoji: teamsResolved ? '🟢' : '🟡', detail: teamsResolved ? plugin.localize('slackersSquadServices.runDiagnostic.detailAllResolved') : plugin.localize('slackersSquadServices.runDiagnostic.detailSomeResolving') });

  // ── Lock system ───────────────────────────────────────────────
  const lockFunctional = typeof players?.lockGlobal === 'function' && typeof players?.canAct === 'function';
  results.push({ label: plugin.localize('slackersSquadServices.runDiagnostic.lockSystemFunctional'), emoji: lockFunctional ? '🟢' : '🔴', detail: lockFunctional ? plugin.localize('slackersSquadServices.runDiagnostic.detailLockApisAvailable') : plugin.localize('slackersSquadServices.runDiagnostic.detailLockApisMissing') });

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
    name: allPassed
      ? plugin.localize('slackersSquadServices.runDiagnostic.allChecksPassed')
      : plugin.localize('slackersSquadServices.runDiagnostic.someChecksPassed', { passed, total }),
    value: allPassed
      ? plugin.localize('slackersSquadServices.runDiagnostic.sServicesAppearHealthy')
      : plugin.localize('slackersSquadServices.runDiagnostic.nonGreenSummary', { count: total - passed }),
    inline: false
  });

  await sendDiscordMessage(message.channel, {
    embeds: [{
      color: allPassed ? 0x2ecc71 : 0xf39c12,
      title: plugin.localize('slackersSquadServices.runDiagnostic.sDiagnostic'),
      description: plugin.localize('slackersSquadServices.runDiagnostic.consolidatedServiceHealthCheck'),
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
/**
 * Which server answers `!s3 <verb>`, and whether it may answer unasked.
 *
 * Sixteen live verbs, not eighteen: `watch` and `unwatch` sit inside the
 * S3_WATCH_DEPRECATED block comment above and are not registered, so they
 * are not tagged. A grep for `handlers.set(` returns them anyway, which is
 * exactly the kind of counting this table is meant to stop.
 *
 * **Re-enabling `watch` needs per-server attribution before it needs a
 * scope.** It relays verbose log lines into a Discord channel, and on a
 * shared channel two servers' logs interleave into one stream with nothing
 * in a line saying which process wrote it — a debugging tool that makes the
 * thing being debugged harder to see. Whoever turns it back on either stamps
 * the server on every relayed line or makes the relay a per-server read with
 * a required selector; only then is there a scope worth arguing about.
 *
 * **The tag belongs to the verb an operator types, not to the handler that
 * dispatches it.** One `servers` handler covers a community read and two
 * community mutations; one `db` handler covers three reads and a write that
 * replaces the database. Reading only the outer verb would let `!s3 db
 * import` through on the same terms as `!s3 db status`.
 *
 * **And every tag here came from reading the body.** Two are not what the
 * name suggests. `!s3 locks` reports the in-process service locks that
 * `buildLocksEmbed()` reads out of memory — it has nothing to do with the
 * `S3_Locks` table that backs migrations and Discord claims, despite the
 * name, so it is one server's answer and not the community's. `!s3 config`
 * is the same shape: it renders THIS process's resolved options, which on a
 * multi-server install genuinely differ between servers.
 *
 * @param {string[]} args - Arguments with `!s3` already removed.
 * @returns {{scope: string, selectorRequired: boolean}}
 */
export function scopeForS3Command(args) {
  const verb = String(args?.[0] ?? '').toLowerCase();
  const sub = String(args?.[1] ?? '').toLowerCase();

  switch (verb) {
    // ── One server's own state ──
    case 'status':
    case 'services':
    case 'gamestate':
    case 'factions':
    case 'locks':
    case 'config':
    case 'switches':
    case 'karma':
    case 'diag':
      return { scope: COMMAND_SCOPE.SERVER_READ, selectorRequired: false };

    // Same scope, but buildPlayersEmbeds() and buildClansEmbeds() return an
    // array rather than one embed — a full roster runs to several. Three
    // servers broadcasting a roster apiece is a screen of embeds from one
    // typed command, so these ask for a target instead of answering
    // together. That is a volume exception, not a correctness one.
    case 'players':
    case 'clans':
      return { scope: COMMAND_SCOPE.SERVER_READ, selectorRequired: true };

    // ── The registry ──
    case 'servers':
      return {
        scope: (sub === 'alias' || sub === 'forget')
          ? COMMAND_SCOPE.COMMUNITY_MUTATING
          : COMMAND_SCOPE.COMMUNITY_READ,
        selectorRequired: false
      };

    // ── The whole database ──
    case 'db':
      return {
        scope: sub === 'import' ? COMMAND_SCOPE.COMMUNITY_MUTATING : COMMAND_SCOPE.COMMUNITY_READ,
        selectorRequired: false
      };

    case 'backup': {
      // The backup directory belongs to the PROCESS, not to the community.
      // Each server reads and writes its own `backups/`, so an arbitrary
      // process claiming `!s3 backup list` answers with a file list that
      // exists on one host, and `restore <filename>` claimed by a process
      // that does not hold that file just fails. The database a restore
      // writes is shared — that is what its confirmation is for — but the
      // file it reads is not, and the routing has to follow the file.
      //
      // `list` broadcasts: one short embed per server, and seeing all of
      // them side by side is the point. `create` and `restore` each write a
      // filesystem and which filesystem is the whole question, so both name
      // their server. A bare `!s3 backup` is a usage reply and stays
      // community-read so one process answers it rather than all of them.
      if (sub === 'create' || sub === 'restore') {
        return { scope: COMMAND_SCOPE.SERVER_MUTATING, selectorRequired: false };
      }
      if (sub === 'list') {
        return { scope: COMMAND_SCOPE.SERVER_READ, selectorRequired: false };
      }
      return { scope: COMMAND_SCOPE.COMMUNITY_READ, selectorRequired: false };
    }

    case 'migrate':
      // `pending`, `status`, `preview`, `verify` and `ddl` report; `force`,
      // `purge-deprecated` and `adopt-state` write. A bare `!s3 migrate` is
      // a usage reply and costs nothing either way, so it lands with the
      // reads.
      return {
        scope: (sub === 'force' || sub === 'purge-deprecated' || sub === 'adopt-state')
          ? COMMAND_SCOPE.COMMUNITY_MUTATING
          : COMMAND_SCOPE.COMMUNITY_READ,
        selectorRequired: false
      };

    // The token IS the routing. MigrationEngine mints it at arm time and
    // confirmToken() rejects anything it did not mint, so this reaches the
    // arming process by construction — and a claim would hand it to an
    // arbitrary one, which then rejects a token it never minted while the
    // process holding the armed migration never sees the message.
    case 'confirm':
      return { scope: COMMAND_SCOPE.TOKEN_CONFIRM, selectorRequired: false };

    // `help`, and every unknown verb, which falls through to the help embed.
    default:
      return { scope: COMMAND_SCOPE.COMMUNITY_READ, selectorRequired: false };
  }
}

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

  // ── Server registry ───────────────────────────────────────────
  //
  // Listing is inspection; `alias` and `forget` are not. They live under the
  // same command anyway, because the operator who needs to rename or retire a
  // server is looking at the listing when they decide to, and a second command
  // name is a second thing to remember correctly at the wrong moment.

  /**
   * Turn an operator-typed token into exactly one registry row, or reply with
   * why it could not, and return null.
   *
   * The refusal is the point. `resolveServerToken()` never picks a winner from
   * an ambiguous token, so this never has one to report — it lists the
   * candidates and lets the operator name the one they meant. Resolving to the
   * first row would convert the one wrong-server case that is detectable into
   * the one that is silent.
   */
  const resolveServerOrExplain = async (plugin, message, db, token) => {
    const resolved = await db.resolveServerToken(token);
    if (resolved.row) return resolved.row;

    const ambiguous = Boolean(resolved.ambiguous);
    const rows = resolved.ambiguous ?? resolved.candidates ?? [];
    const candidateLabels = serverLabels(rows, { maxLength: 40 });
    const listing = rows.length > 0
      ? rows.map((r) => describeServerRow(r, candidateLabels.get(r.serverID))).join('\n')
      : plugin.localize('slackersSquadServices.servers.noneRegistered');

    await sendDiscordMessage(message.channel, {
      embeds: [{
        color: 0xe74c3c,
        title: ambiguous
          ? plugin.localize('slackersSquadServices.servers.ambiguousTitle')
          : plugin.localize('slackersSquadServices.servers.notFoundTitle'),
        description: ambiguous
          ? plugin.localize('slackersSquadServices.servers.ambiguousDescription', { token: truncate(String(token), 40), candidates: truncate(listing, 1500) })
          : plugin.localize('slackersSquadServices.servers.notFoundDescription', { token: truncate(String(token), 40), candidates: truncate(listing, 1500) }),
        timestamp: new Date().toISOString()
      }]
    }, 'S3', (...a) => plugin.verbose(...a));

    return null;
  };

  handlers.set('servers', async (plugin, message, args) => {
    const serversSub = args[1]?.toLowerCase();
    const db = plugin.services.db;

    if (!db || !db.isReady() || !db.ServersModel) {
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0xe74c3c,
          title: plugin.localize('slackersSquadServices.servers.title'),
          description: plugin.localize('slackersSquadServices.servers.registryUnavailable'),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    if (serversSub === 'alias') {
      const target = args[2];
      const requested = args[3];
      if (!target || !requested) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xf39c12, title: plugin.localize('slackersSquadServices.servers.aliasUsageTitle'), description: plugin.localize('slackersSquadServices.servers.aliasUsage'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const row = await resolveServerOrExplain(plugin, message, db, target);
      if (!row) return;

      const outcome = await db.setServerAlias(row.serverID, requested);
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: outcome.ok ? 0x2ecc71 : 0xe74c3c,
          title: outcome.ok
            ? plugin.localize('slackersSquadServices.servers.aliasSetTitle')
            : plugin.localize('slackersSquadServices.servers.aliasRefusedTitle'),
          description: outcome.ok
            ? plugin.localize('slackersSquadServices.servers.aliasSet', { serverID: row.serverID, previous: row.alias || plugin.localize('slackersSquadServices.servers.unnamed'), alias: outcome.alias })
            : plugin.localize('slackersSquadServices.servers.aliasRefused', { reason: truncate(outcome.reason, 1500) }),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    if (serversSub === 'forget') {
      const target = args[2];
      if (!target) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xf39c12, title: plugin.localize('slackersSquadServices.servers.forgetUsageTitle'), description: plugin.localize('slackersSquadServices.servers.forgetUsage'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const row = await resolveServerOrExplain(plugin, message, db, target);
      if (!row) return;

      // The freshness refusal inside forgetServer() would catch this too, but
      // it would report it as "still running — stop it first", which is a
      // strange thing to read about the process you are typing at.
      if (row.serverID === db.getServerID()) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.servers.forgetRefusedTitle'), description: plugin.localize('slackersSquadServices.servers.forgetSelf'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const outcome = await db.forgetServer(row.serverID);
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: outcome.ok ? 0x2ecc71 : 0xe74c3c,
          title: outcome.ok
            ? plugin.localize('slackersSquadServices.servers.forgottenTitle')
            : plugin.localize('slackersSquadServices.servers.forgetRefusedTitle'),
          description: outcome.ok
            ? plugin.localize('slackersSquadServices.servers.forgotten', { server: describeServerRow(outcome.row) })
            : plugin.localize('slackersSquadServices.servers.forgetRefused', { reason: truncate(outcome.reason, 1500) }),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    if (serversSub) {
      await sendDiscordMessage(message.channel, {
        embeds: [{ color: 0xf39c12, title: plugin.localize('slackersSquadServices.servers.unknownSubTitle'), description: plugin.localize('slackersSquadServices.servers.unknownSub', { sub: truncate(serversSub, 40) }), timestamp: new Date().toISOString() }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    const embed = await buildServersEmbed(plugin);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  // ── Reports ───────────────────────────────────────────────────

  handlers.set('switches', async (plugin, message, args) => {
    if (args[1]?.toLowerCase() === 'export') {
      const rest = args.slice(2);
      const asJson = rest.includes('--json');
      const tokens = rest.filter((t) => t !== '--json');
      let periodArg = null;
      let rangeArg = null;
      for (const t of tokens) {
        if (isPeriodToken(t)) periodArg = t;
        else if (looksLikeRangeToken(t)) rangeArg = t;
      }
      const result = await buildSwitchesExport(plugin, rangeArg, periodArg, asJson);
      if (result.error) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.switches.exportFailed'), description: result.error, timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }
      await message.channel.send({ embeds: [result.embed], files: [{ attachment: result.buffer, name: result.filename }] });
      return;
    }

    const rest = args.slice(1);
    let rangeArg = null;
    let identParts = rest;
    if (rest.length > 0 && looksLikeRangeToken(rest[rest.length - 1])) {
      rangeArg = rest[rest.length - 1];
      identParts = rest.slice(0, -1);
    }
    const identifier = identParts.join(' ').trim() || null;
    const embeds = await buildSwitchesEmbed(plugin, identifier, rangeArg);
    await sendDiscordMessage(message.channel, { embeds }, 'S3', (...a) => plugin.verbose(...a));
  });

  handlers.set('karma', async (plugin, message, args) => {
    const rest = args.slice(1);
    let rangeArg = null;
    let identParts = rest;
    if (rest.length > 0 && looksLikeRangeToken(rest[rest.length - 1])) {
      rangeArg = rest[rest.length - 1];
      identParts = rest.slice(0, -1);
    }
    const identifier = identParts.join(' ').trim() || null;
    const embed = await buildKarmaEmbed(plugin, identifier, rangeArg);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  // ── Debug ─────────────────────────────────────────────────────

  // S3_WATCH_DEPRECATED — watch relay was not useful in production testing.
  // The WatchManager class still exists in s3-discord.js for reference.
  // If re-enabled, uncomment the two handler registrations below and the
  // watch/unwatch lines in buildHelpEmbed().
  //
  // And give both a scope in scopeForS3Command(). A watch relays THIS
  // process's verbose output, so it is a server read — but a broadcast one
  // would attach every server's log stream to one channel off one command,
  // and each would keep streaming with nothing in the scrollback to say how
  // many are running. It wants selectorRequired, the same as the other reads
  // whose replies do not divide. `unwatch` is the counterpart and has the
  // sharper edge: stopping the wrong server's relay looks exactly like
  // stopping the right one. An untagged verb defaults to a community read,
  // which is wrong for both.
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
        title: plugin.localize('slackersSquadServices.watch.watchStarted'),
        description: plugin.localize('slackersSquadServices.watch.relayingVerboseLogs', { target, duration: formatDuration(5 * 60 * 1000) }),
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
        title: plugin.localize('slackersSquadServices.watch.watchStopped'),
        description: active.length > 0
          ? plugin.localize('slackersSquadServices.watch.stoppedActiveWatches', { count: active.length, list: active.map((w) => w.services.join(', ')).join('; ') })
          : plugin.localize('slackersSquadServices.watch.noActiveWatches'),
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
          embeds: [{ color: 0x2ecc71, title: plugin.localize('slackersSquadServices.migrate.noPendingMigrations'), description: plugin.localize('slackersSquadServices.migrate.allPluginSchemaVersions'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }
      const embed = buildMigrationEmbed(plugin, pending, 'pending');
      await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    if (migrateSub === 'status') {
      const db = plugin.services.db;
      const me = db?.migrationEngine;

      if (!db || !me) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.migrate.dbServiceNotAvailable'), description: plugin.localize('slackersSquadServices.migrate.theDatabaseServiceHas'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const versionStatus = await db.verifySchemaVersions();
      const lines = [];
      for (const [pluginName, expectedVersion] of db._expectedVersions) {
        const p = versionStatus.pending.find((x) => x.pluginName === pluginName);
        const current = p ? p.currentVersion : expectedVersion;
        const status = p ? plugin.localize('slackersSquadServices.migrate.pluginVersionBehind', { current, expected: expectedVersion, behind: p.behind }) : plugin.localize('slackersSquadServices.migrate.pluginVersionCurrent', { current });
        lines.push(plugin.localize('slackersSquadServices.migrate.pluginVersionLine', { pluginName, status }));
      }
      if (lines.length === 0) lines.push(plugin.localize('slackersSquadServices.migrate.noPluginsRegistered'));

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: versionStatus.upToDate ? 0x2ecc71 : 0xf39c12,
          title: versionStatus.upToDate ? plugin.localize('slackersSquadServices.migrate.schemaStatusAllCurrent') : plugin.localize('slackersSquadServices.migrate.schemaStatusPendingMigrations'),
          description: lines.join('\n'),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    if (migrateSub === 'force') {
      // Before anything else: this branch's unflagged default is to apply
      // migrations for real, so a mangled `--dry-run` must not reach it.
      if (await rejectStrayFlags(plugin, message, sendDiscordMessage, args.slice(2), ['--dry-run'])) return;

      const db = plugin.services.db;
      const me = db?.migrationEngine;
      const vs = db ? await db.verifySchemaVersions() : null;
      const pending = vs?.pending ?? null;

      if (!pending || pending.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x2ecc71, title: plugin.localize('slackersSquadServices.migrate.noPendingMigrations'), description: plugin.localize('slackersSquadServices.migrate.nothingToForceMigrate'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      if (!db || !me) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.migrate.dbServiceNotAvailable'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const isDryRun = args.includes('--dry-run');

      if (!isDryRun) {
        const runningEmbed = buildMigrationEmbed(plugin, pending, 'running');
        await sendDiscordMessage(message.channel, { embeds: [runningEmbed] }, 'S3', (...a) => plugin.verbose(...a));

        // '__force__' satisfies the engine's confirmation gate — the admin
        // explicitly typing !s3 migrate force IS the confirmation.
        //
        // Deliberately not reached on a dry run. confirmToken() latches
        // `_confirmed` and nothing clears it, and runMigrations() gates on that
        // latch alone — so arming the engine here would leave a *preview*
        // having permanently authorised the next migration. A dry run must have
        // no side effects at all, and runMigrations() returns above the
        // confirmation gate anyway, so it never needed the token.
        //
        // The latch no longer also makes `!s3 confirm <anything>` succeed —
        // confirmToken() short-circuits on `_confirmed` for the arming tokens
        // only — but that narrows the blast radius of arming here rather than
        // removing it, and a preview still must not arm.
        me.confirmToken('__force__');
      }

      const batch = await runMigrationBatch(me, db, pending, { dryRun: isDryRun });
      const { totalApplied, totalSkipped } = batch;
      const hadError = batch.failures.length > 0;

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
                  lines.push(plugin.localize('slackersSquadServices.migrate.createsTable', { table: tableName }));
                  if (m.touches.columns?.[tableName]) {
                    lines.push(plugin.localize('slackersSquadServices.migrate.columnsList', { columns: m.touches.columns[tableName].map((c) => `\`${c}\``).join(', ') }));
                  }
                }
              }
              if (m.touches.columns) {
                for (const [tableName, cols] of Object.entries(m.touches.columns)) {
                  if (!m.touches.creates || !m.touches.creates.includes(tableName)) {
                    lines.push(plugin.localize('slackersSquadServices.migrate.columnsForTable', { table: tableName, columns: cols.map((c) => `\`${c}\``).join(', ') }));
                  }
                }
              }
            }
          }
          lines.push(''); // blank line between plugin sections
        }

        if (lines.length === 0) {
          await sendDiscordMessage(message.channel, {
            embeds: [{ color: 0xf39c12, title: plugin.localize('slackersSquadServices.migrate.dryRunComplete'), description: plugin.localize('slackersSquadServices.migrate.noPreviewDataAvailable'), timestamp: new Date().toISOString() }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x3498db, title: plugin.localize('slackersSquadServices.migrate.dryRunComplete'), description: lines.join('\n') + plugin.localize('slackersSquadServices.migrate.runWithoutDryRun', { totalSkipped }), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }
      // Still `!hadError`, and deliberately so under isolation: a partly-applied
      // batch has not reached the schema the consumers expect, so the gate must
      // stay shut and the pending list must survive. What changed is only that
      // the plugins which CAN migrate no longer wait for the one that cannot.
      db._resolveMigrationGate(!hadError);

      if (hadError) {
        const failEmbed = buildMigrationEmbed(plugin, pending, 'failed', { error: describeBatchFailures(plugin, batch, pending), totalApplied, totalSkipped });
        await sendDiscordMessage(message.channel, { embeds: [failEmbed] }, 'S3', (...a) => plugin.verbose(...a));
      } else {
        const doneEmbed = buildMigrationEmbed(plugin, pending, 'complete', { totalApplied, totalSkipped });
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
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.migrate.dbServiceNotAvailable'), description: plugin.localize('slackersSquadServices.migrate.theDatabaseServiceHas'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      if (!pending || pending.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x2ecc71, title: plugin.localize('slackersSquadServices.migrate.noPendingMigrations'), description: plugin.localize('slackersSquadServices.migrate.allPluginSchemaVersions'), timestamp: new Date().toISOString() }]
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
                lines.push(plugin.localize('slackersSquadServices.migrate.createsTable', { table: tableName }));
                if (m.touches.columns?.[tableName]) {
                  lines.push(plugin.localize('slackersSquadServices.migrate.columnsList', { columns: m.touches.columns[tableName].map((c) => `\`${c}\``).join(', ') }));
                }
              }
            }
            if (m.touches.columns) {
              for (const [tableName, cols] of Object.entries(m.touches.columns)) {
                if (!m.touches.creates || !m.touches.creates.includes(tableName)) {
                  lines.push(plugin.localize('slackersSquadServices.migrate.columnsForTable', { table: tableName, columns: cols.map((c) => `\`${c}\``).join(', ') }));
                }
              }
            }
          }
        }
        lines.push(''); // blank line between plugin sections
      }

      if (lines.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xf39c12, title: plugin.localize('slackersSquadServices.migrate.migrationPreview'), description: plugin.localize('slackersSquadServices.migrate.noPreviewDataAvailable'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0x3498db,
          title: plugin.localize('slackersSquadServices.migrate.migrationPreview'),
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
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.migrate.dbServiceNotAvailable'), description: plugin.localize('slackersSquadServices.migrate.theDatabaseServiceHas'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const drift = await db.verifyLiveSchema();

      if (!drift || drift.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x2ecc71, title: plugin.localize('slackersSquadServices.migrate.schemaVerificationNoDrift'), description: plugin.localize('slackersSquadServices.migrate.allRegisteredModelsMatch'), timestamp: new Date().toISOString() }]
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
        lines.push(plugin.localize('slackersSquadServices.migrate.errorsHeading'));
        for (const e of errors) {
          lines.push(`  • \`${e.table || e.model}\`: ${e.error}`);
        }
        lines.push('');
      }

      if (missing.length > 0) {
        lines.push(plugin.localize('slackersSquadServices.migrate.missingColumnsHeading'));
        for (const m of missing) {
          lines.push(`  • \`${m.table}\`: ${m.missing.map(c => `\`${c}\``).join(', ')}`);
        }
        lines.push('');
      }

      if (missingRows.length > 0) {
        lines.push(plugin.localize('slackersSquadServices.migrate.missingRowsHeading'));
        for (const r of missingRows) {
          lines.push(`  • \`${r.table}\`: ${r.missingRows.map(row => `\`${row.key}=${row.value}\``).join(', ')}`);
        }
        lines.push('');
      }

      if (dataViolations.length > 0) {
        lines.push(plugin.localize('slackersSquadServices.migrate.unpopulatedDataHeading'));
        for (const dv of dataViolations) {
          lines.push(`  • \`${dv.table}\`: ${dv.dataViolations.map(v => plugin.localize('slackersSquadServices.migrate.rowsWithEmpty', { offenders: v.offenders, column: v.column })).join(', ')}`);
        }
        lines.push('');
      }

      if (extra.length > 0) {
        lines.push(plugin.localize('slackersSquadServices.migrate.extraColumnsHeading'));
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
          title: plugin.localize('slackersSquadServices.migrate.schemaVerificationDriftDetected'),
          description: lines.join('\n').trimEnd(),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // purge-deprecated — Scan for and optionally drop _deprecated_* tables/columns
    // ═══════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════
    // ddl — the exact SQL to run by hand under a restricted grant
    // ═══════════════════════════════════════════════════════════════
    // The live MySQL user has CREATE but not ALTER, so `!s3 migrate force`
    // cannot apply a column-adding migration there at all. Until now that
    // ended with a driver error in Discord and an operator reconstructing the
    // statement from the model source. This prints the statement instead.
    if (migrateSub === 'ddl') {
      if (await rejectStrayFlags(plugin, message, sendDiscordMessage, args.slice(2), [])) return;

      const db = plugin.services.db;
      const me = db?.migrationEngine;

      if (!db || !me) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.migrate.dbServiceNotAvailable'), description: plugin.localize('slackersSquadServices.migrate.theDatabaseServiceHas'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const onlyPlugin = args[2] || null;

      let generated;
      try {
        generated = await me.buildHandApplyDdl({ pluginName: onlyPlugin });
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.migrate.ddlGenerationFailed'), description: plugin.localize('slackersSquadServices.migrate.ddlGenerationFailedBody', { message: err.message }), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const noteLines = generated.notes.length > 0
        ? ['', plugin.localize('slackersSquadServices.migrate.ddlNotesHeading'), ...generated.notes.map((n) => `• ${n}`)]
        : [];

      // An incomplete script fails exactly like no script at all — same denial,
      // on an object it never named — so the warning goes above the SQL rather
      // than into the notes at the end, where it would be read after pasting.
      const incompleteCount = generated.incomplete?.length || 0;
      const incompleteLines = incompleteCount > 0
        ? [plugin.localize('slackersSquadServices.migrate.ddlIncomplete', { count: incompleteCount }), '']
        : [];

      if (generated.statements.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{
            // Green would read as "you are done" on the one path where the
            // generator produced nothing AND could not render something.
            color: incompleteCount > 0 ? 0xf39c12 : 0x2ecc71,
            title: plugin.localize('slackersSquadServices.migrate.ddlNothingToApply'),
            description: [
              ...incompleteLines,
              onlyPlugin
                ? plugin.localize('slackersSquadServices.migrate.ddlNothingToApplyScoped', { pluginName: onlyPlugin })
                : plugin.localize('slackersSquadServices.migrate.ddlNothingToApplyBody'),
              ...noteLines
            ].join('\n'),
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // The SQL itself is deliberately unlocalized — it is what the operator
      // pastes into a client, and translating around it would only risk
      // changing it. Only the prose framing goes through localize().
      const sqlLines = [];
      let currentGroup = null;
      for (const statement of generated.statements) {
        const group = `${statement.pluginName} v${statement.version}`;
        if (group !== currentGroup) {
          if (sqlLines.length > 0) sqlLines.push('');
          sqlLines.push(`-- ${group}`);
          currentGroup = group;
        }
        sqlLines.push(statement.sql);
      }

      const intro = plugin.localize('slackersSquadServices.migrate.ddlIntro');
      const preamble = [...incompleteLines, intro].join('\n');
      // Fence overhead is "```sql\n" + "\n```"; the slack below covers the
      // preamble, the blank line after it, and the paging suffix in the title.
      const budget = Math.max(4096 - preamble.length - 64, 500);
      const chunks = chunkLines(sqlLines, budget);

      const embeds = chunks.map((chunk, i) => ({
        color: incompleteCount > 0 ? 0xf39c12 : 0x3498db,
        title: chunks.length > 1
          ? plugin.localize('slackersSquadServices.migrate.ddlTitlePaged', { dialect: generated.dialect, i: i + 1, count: chunks.length })
          : plugin.localize('slackersSquadServices.migrate.ddlTitle', { dialect: generated.dialect }),
        description: (i === 0 ? preamble + '\n' : '') + '```sql\n' + chunk.join('\n') + '\n```',
        timestamp: new Date().toISOString()
      }));

      // Notes ride on the last page, outside the fence, so they are never
      // mistaken for something to paste.
      if (noteLines.length > 0) {
        const last = embeds[embeds.length - 1];
        last.description += '\n' + noteLines.join('\n');
      }

      for (const embed of embeds) {
        await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
      }
      return;
    }

    if (migrateSub === 'purge-deprecated') {
      if (await rejectStrayFlags(plugin, message, sendDiscordMessage, args.slice(2), ['--confirm'])) return;

      const db = plugin.services.db;
      if (!db || !db._isMounted) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.migrate.dbServiceNotAvailable'), description: plugin.localize('slackersSquadServices.migrate.theDatabaseServiceHas'), timestamp: new Date().toISOString() }]
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
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.migrate.scanFailed'), description: plugin.localize('slackersSquadServices.migrate.couldNotListTables', { message: err.message }), timestamp: new Date().toISOString() }]
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
          embeds: [{ color: 0x2ecc71, title: plugin.localize('slackersSquadServices.migrate.noDeprecatedObjects'), description: plugin.localize('slackersSquadServices.migrate.noDeprecatedTablesOr'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // ── Report mode (no --confirm) ──────────────────────────────
      if (!isConfirm) {
        const lines = [];

        if (deprecatedTables.length > 0) {
          lines.push(plugin.localize('slackersSquadServices.migrate.deprecatedTablesHeading', { count: deprecatedTables.length }));
          for (const t of deprecatedTables) {
            lines.push(`  • \`${t}\``);
          }
          lines.push('');
        }

        if (deprecatedColumns.length > 0) {
          lines.push(plugin.localize('slackersSquadServices.migrate.deprecatedColumnsHeading', { count: deprecatedColumns.length }));
          for (const { table, column } of deprecatedColumns) {
            lines.push(`  • \`${table}\`.\`${column}\``);
          }
          lines.push('');
        }

        lines.push(plugin.localize('slackersSquadServices.migrate.typeToPurge', { count: totalDeprecated }));

        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0x3498db,
            title: plugin.localize('slackersSquadServices.migrate.deprecatedObjectsFound', { totalDeprecated }),
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
          errors.push(plugin.localize('slackersSquadServices.migrate.errorTable', { table: tableName, error: err.message }));
        }
      }

      for (const { table, column } of deprecatedColumns) {
        try {
          await qi.removeColumn(table, column);
          purgedColumns++;
        } catch (err) {
          errors.push(plugin.localize('slackersSquadServices.migrate.errorColumn', { table, column, error: err.message }));
        }
      }

      const totalPurged = purgedTables + purgedColumns;
      const lines = [];
      if (purgedTables > 0) lines.push(plugin.localize('slackersSquadServices.migrate.droppedTables', { count: purgedTables }));
      if (purgedColumns > 0) lines.push(plugin.localize('slackersSquadServices.migrate.droppedColumns', { count: purgedColumns }));
      if (errors.length > 0) {
        lines.push('');
        lines.push(plugin.localize('slackersSquadServices.migrate.errorsCountHeading', { count: errors.length }));
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

    // ══════════════════════════════════════════════════════════════
    // adopt-state — Move the legacy singleton rows onto this server's id
    // ══════════════════════════════════════════════════════════════
    //
    // `S3_GameState` and `TeamBalancerState` are per-server singletons whose
    // primary key IS the server id — scopeKind 'server-key' — so an install
    // that has always run `server.id: 3` still holds its round state and its
    // win streak in a row numbered 1, written before any of this existed. That
    // row genuinely is server 3’s, and from inside the process the situation is
    // indistinguishable from a new server 3 joining a community whose incumbent
    // declares 1: same config, same empty registry, opposite correct answers.
    // The deciding fact is operator knowledge and it is in no table, so it is
    // typed rather than inferred. Nothing renumbers implicitly — not on boot
    // order, not on an empty registry, not on row age.
    //
    // An install declaring serverID 1, which is every stock config, never needs
    // this: its row is already numbered 1, and the command says so rather than
    // reporting a successful no-op.
    //
    // ONE DEPARTURE FROM THE DESIGN, and it is deliberate. The design called
    // for refusing when the target server already has a row. That refusal is
    // vacuous: by the time an admin can type anything S³ has mounted,
    // _recoverPersistedState() has found no row at the declared id and written
    // a fresh one, and TeamBalancer’s initDB() has done the same. The target
    // row therefore always exists, and a command that refuses on its existence
    // refuses every time it is ever run. What that refusal was protecting — do
    // not silently destroy real state — is served here instead by printing the
    // row that would be replaced, field by field, and requiring --confirm after
    // the admin has read it.
    if (migrateSub === 'adopt-state') {
      if (await rejectStrayFlags(plugin, message, sendDiscordMessage, args.slice(2), ['--confirm'])) return;

      const db = plugin.services.db;
      if (!db || !db._isMounted) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.migrate.dbServiceNotAvailable'), description: plugin.localize('slackersSquadServices.migrate.theDatabaseServiceHas'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // Not a configurable: 1 is the literal both models were pinned at before
      // the key meant anything.
      const LEGACY_ID = 1;
      const serverID = db.getServerID();
      const isConfirm = args.includes('--confirm');

      if (serverID === LEGACY_ID) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x2ecc71, title: plugin.localize('slackersSquadServices.migrate.adoptStateNothingTitle'), description: plugin.localize('slackersSquadServices.migrate.adoptStateNoopBody'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // Declaration, not discovery. The tables are the ones that declared
      // scopeKind 'server-key' at their own defineModel() call site, which
      // includes TeamBalancer’s — consumer plugins register onto this same
      // DBService. A hardcoded pair here would go stale the first time a third
      // singleton is added, and go stale silently.
      const singletons = db.getModelsByScopeKind('server-key');

      const fmt = (v) =>
        v === null || v === undefined ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      const describeRow = (row) => {
        const json = row?.toJSON ? row.toJSON() : row;
        const parts = Object.entries(json || {})
          .filter(([k]) => k !== 'id')
          .map(([k, v]) => `${k}=${fmt(v)}`);
        return parts.length ? parts.join(', ') : plugin.localize('slackersSquadServices.migrate.adoptStateNoOtherColumns');
      };

      const plan = [];
      const skipped = [];

      for (const name of singletons) {
        const model = db.getModel(name);
        if (!model) continue;
        let legacy = null;
        let target = null;
        try {
          legacy = await model.findByPk(LEGACY_ID);
          target = await model.findByPk(serverID);
        } catch (err) {
          skipped.push({ table: model.tableName, reason: err.message });
          continue;
        }
        if (!legacy) {
          skipped.push({ table: model.tableName, reason: plugin.localize('slackersSquadServices.migrate.adoptStateNoLegacyRow') });
          continue;
        }
        plan.push({ name, table: model.tableName, legacy, target });
      }

      if (plan.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x2ecc71, title: plugin.localize('slackersSquadServices.migrate.adoptStateNothingTitle'), description: plugin.localize('slackersSquadServices.migrate.adoptStateNothingBody', { serverID }), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // ── Report mode (no --confirm) ──────────────────────────
      if (!isConfirm) {
        const lines = [];
        for (const entry of plan) {
          lines.push(plugin.localize('slackersSquadServices.migrate.adoptStateWillMove', { table: entry.table, serverID }));
          lines.push(plugin.localize('slackersSquadServices.migrate.adoptStateKeepingRow', { fields: describeRow(entry.legacy) }));
          if (entry.target) {
            lines.push(plugin.localize('slackersSquadServices.migrate.adoptStateReplacingRow', { fields: describeRow(entry.target) }));
          }
          lines.push('');
        }
        for (const s of skipped) {
          lines.push(plugin.localize('slackersSquadServices.migrate.adoptStateSkipped', { table: s.table, reason: s.reason }));
        }
        lines.push(plugin.localize('slackersSquadServices.migrate.adoptStateTypeToConfirm', { serverID }));

        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0x3498db,
            title: plugin.localize('slackersSquadServices.migrate.adoptStateFound', { count: plan.length }),
            description: lines.join('\n'),
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // ── Adopt (--confirm) ────────────────────────────────
      // One transaction across every table, with an explicit handle: this repo
      // runs no CLS, so a bare call inside would open a transaction of its own.
      // All-or-nothing is the point — a half-adopted pair leaves the round state
      // on one id and the win streak on another, which no later run can untangle.
      try {
        await db.withTransactionWithRetry(async (t) => {
          for (const entry of plan) {
            const model = db.getModel(entry.name);
            // The target row — this boot's fresh initialisation, or whatever the
            // admin just read in the preview — has to go first, or the UPDATE
            // collides with the primary key it is moving onto.
            if (entry.target) {
              await model.destroy({ where: { id: serverID }, transaction: t });
            }
            await model.update({ id: serverID }, { where: { id: LEGACY_ID }, transaction: t });
          }
        });
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.migrate.adoptStateFailedTitle'), description: plugin.localize('slackersSquadServices.migrate.adoptStateFailedBody', { message: err.message }), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // S³'s own round state is re-read here rather than left to the restart,
      // because this process rewrites that row on the next phase change and
      // would put its pre-adoption state straight back over the adopted one.
      // Everything else that caches a singleton in memory — TeamBalancer’s win
      // streak — lives behind its own plugin and only picks the adopted row up
      // on a restart, which is what the completion message asks for.
      try {
        await plugin.services.gameState?._recoverPersistedState?.();
      } catch (err) {
        plugin.verbose(1, `[S3 adopt-state] Could not re-read game state after adoption: ${err.message}`);
      }

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0x2ecc71,
          title: plugin.localize('slackersSquadServices.migrate.adoptStateDoneTitle', { count: plan.length }),
          description: plugin.localize('slackersSquadServices.migrate.adoptStateDoneBody', { serverID }),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    await message.reply(plugin.localize('slackersSquadServices.migrate.usageS3MigratePending'));
  });

  // ── Confirm ───────────────────────────────────────────────────

  handlers.set('confirm', async (plugin, message, args) => {
    // `!s3 confirm` runs migrations for real and takes no flags at all, so a
    // pasted `<token>` placeholder stops here rather than being tried as a
    // token — and, once the engine is armed, silently accepted as one.
    if (await rejectStrayFlags(plugin, message, sendDiscordMessage, args.slice(1), [])) return;

    const token = args[1];
    if (!token) {
      await message.reply(
        plugin.localize('slackersSquadServices.confirm.usageS3ConfirmToken') +
        plugin.localize('slackersSquadServices.confirm.checkS3MigrateStatus')
      );
      return;
    }

    const db = plugin.services.db;
    const me = db?.migrationEngine;

    if (!db || !me) {
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0xe74c3c,
          title: plugin.localize('slackersSquadServices.confirm.migrationEngineNotAvailable'),
          description: plugin.localize('slackersSquadServices.confirm.theDatabaseServiceOr'),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    // Validate token (handles expiry internally)
    const accepted = me.confirmToken(token);
    if (!accepted) {
      // On a shared database every process running this plugin receives the
      // command, and only the one that minted the token accepts it. The rest
      // land here.
      //
      // `_confirmToken` is left set after a plain mismatch and cleared three
      // ways: on expiry, on a successful match, and by an arming token
      // (`__force__` / `__auto__`). So a non-null value here means this process
      // is still holding a live token that simply is not the one typed — most
      // likely the operator meant another server's prompt, which is not this
      // process's error to report in red. A null value means this process has
      // no live token to be confused about: it expired, it was already spent,
      // or the engine was armed by `!s3 migrate force` — which clears the token
      // but does not make a later wrong `!s3 confirm` correct, since
      // confirmToken() only short-circuits an armed engine for the arming
      // tokens, not for operator input. That is the genuine "invalid or
      // expired" case, and the one the red branch names.
      const identity = await formatServerIdentity(plugin.services.db, plugin.server);
      const holdsLiveToken = me._confirmToken !== null;
      await sendDiscordMessage(message.channel, {
        embeds: [holdsLiveToken
          ? {
              color: 0x95a5a6,
              title: plugin.localize('slackersSquadServices.confirm.tokenNotIssuedHereTitle'),
              description: plugin.localize('slackersSquadServices.confirm.tokenNotIssuedHereBody', { identity, token }),
              timestamp: new Date().toISOString()
            }
          : {
              color: 0xe74c3c,
              title: plugin.localize('slackersSquadServices.confirm.invalidOrExpiredToken'),
              description: plugin.localize('slackersSquadServices.confirm.onServerPrefix', { identity }) +
                plugin.localize('slackersSquadServices.confirm.theTokenDidNot') +
                plugin.localize('slackersSquadServices.confirm.checkS3MigrateStatus2'),
              timestamp: new Date().toISOString()
            }
        ]
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
          title: plugin.localize('slackersSquadServices.confirm.noPendingMigrations'),
          description: plugin.localize('slackersSquadServices.confirm.tokenAcceptedButNo'),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      db._resolveMigrationGate(true);
      return;
    }

    const runningEmbed = buildMigrationEmbed(plugin, pending, 'running');
    await sendDiscordMessage(message.channel, { embeds: [runningEmbed] }, 'S3', (...a) => plugin.verbose(...a));

    const batch = await runMigrationBatch(me, db, pending);
    const { totalApplied, totalSkipped } = batch;
    const hadError = batch.failures.length > 0;

    db._resolveMigrationGate(!hadError);

    if (hadError) {
      const failEmbed = buildMigrationEmbed(plugin, pending, 'failed', { error: describeBatchFailures(plugin, batch, pending), totalApplied, totalSkipped });
      await sendDiscordMessage(message.channel, { embeds: [failEmbed] }, 'S3', (...a) => plugin.verbose(...a));
    } else {
      const doneEmbed = buildMigrationEmbed(plugin, pending, 'complete', { totalApplied, totalSkipped });
      await sendDiscordMessage(message.channel, { embeds: [doneEmbed] }, 'S3', (...a) => plugin.verbose(...a));
    }
  });

  // ── Backup ────────────────────────────────────────────────────

  handlers.set('backup', async (plugin, message, args) => {
    const backupSub = args[1]?.toLowerCase();

    if (backupSub === 'list') {
      const backups = listBackups();
      // Which host this list came from is not cosmetic: on a multi-server
      // install every process keeps its own `backups/`, and a filename shown
      // here can only be restored on the server that answered.
      const listDB = plugin.services?.db;
      const listRegistered = listDB?.isReady?.() ? await listDB.getRegisteredServers() : [];
      const listMultiServer = listRegistered.length > 1;
      if (backups.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0x95a5a6, title: plugin.localize('slackersSquadServices.backup.noBackupsFound'), description: plugin.localize('slackersSquadServices.backup.noDatabaseBackupsHave'), timestamp: new Date().toISOString() }]
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
          title: plugin.localize('slackersSquadServices.backup.databaseBackups', { backupsCount: backups.length }),
          description: lines.join('\n'),
          fields: [
            {
              name: plugin.localize('slackersSquadServices.backup.formatLegend'),
              value: plugin.localize('slackersSquadServices.backup.sqliteFileCopyJson'),
              inline: false
            },
            {
              name: plugin.localize('slackersSquadServices.backup.restore'),
              value: plugin.localize('slackersSquadServices.backup.toRestoreABackup'),
              inline: false
            },
            ...(listMultiServer ? [{
              name: plugin.localize('slackersSquadServices.backup.thisServerOnlyHeader'),
              value: plugin.localize('slackersSquadServices.backup.thisServerOnlyBody', {
                server: describeServerIDs(listRegistered, [listDB.getServerID()])
              }),
              inline: false
            }] : [])
          ],
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    if (backupSub === 'restore') {
      // The filename is positional and never carries a dash, so anything
      // dash-shaped here that is not `--confirm` is a mistake.
      if (await rejectStrayFlags(plugin, message, sendDiscordMessage, args.slice(2), ['--confirm'])) return;

      const isConfirm = args.includes('--confirm');
      const confirmIdx = args.indexOf('--confirm');
      // If --confirm is present, filename is the next arg; otherwise it's args[2]
      const filename = isConfirm ? args[confirmIdx + 1] : args[2];

      if (!filename) {
        const usage = isConfirm
          ? 'Usage: `!s3 backup restore --confirm <filename>`'
          : 'Usage: `!s3 backup restore <filename>`';
        await message.reply(usage + plugin.localize('slackersSquadServices.backup.getTheFilenameFrom'));
        return;
      }

      // Verify backup exists
      const backups = listBackups();
      const backup = backups.find((b) => b.filename === filename);
      if (!backup) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.backup.backupNotFound'), description: plugin.localize('slackersSquadServices.backup.noBackupNamedFilename', { filename }), timestamp: new Date().toISOString() }]
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

        // A restore cannot be narrowed to one server — the file holds the
        // community's rows and the database it writes is shared — so this
        // confirmation is the only thing standing between an admin and a
        // community-wide rollback. It names every registered server rather
        // than counting them: "this affects 3 servers" is not a sentence
        // anyone can check against what they meant to do.
        const rdb = plugin.services?.db;
        const rRegistered = rdb?.isReady?.() ? await rdb.getRegisteredServers() : [];
        const rMultiServer = rRegistered.length > 1;
        const rLive = rMultiServer && typeof rdb.getLiveServers === 'function'
          ? (await rdb.getLiveServers()).filter((row) => row.serverID !== rdb.getServerID())
          : [];
        const extraFields = [];
        if (rMultiServer) {
          extraFields.push({
            name: plugin.localize('slackersSquadServices.backup.affectsHeader'),
            value: plugin.localize('slackersSquadServices.backup.affectsBody', {
              servers: describeServerIDs(rRegistered, rRegistered.map((row) => row.serverID))
            }),
            inline: false
          });
        }
        if (isJsonBackup) {
          // Said here because it cannot be fixed here. A JSON restore is one
          // transaction per chunk, so a production-sized file is hundreds of
          // them and a failure halfway through leaves the database part old
          // and part new. Staging tables and a swap would make it atomic and
          // are a different piece of work; what this owes an operator in the
          // meantime is that the risk is stated before they agree to it, and
          // that the failure reports what landed rather than only that it
          // failed.
          extraFields.push({
            name: plugin.localize('slackersSquadServices.backup.partialHeader'),
            value: plugin.localize('slackersSquadServices.backup.partialBody'),
            inline: false
          });
        } else if (rLive.length > 0) {
          // Refused at the confirmation rather than at the write, so the
          // admin finds out before typing --confirm. restoreFromFile() checks
          // again at the moment of the copy, which is the check that counts.
          extraFields.push({
            name: plugin.localize('slackersSquadServices.backup.fileCopyBlockedHeader'),
            value: plugin.localize('slackersSquadServices.backup.fileCopyBlockedBody', {
              servers: describeServerIDs(rRegistered, rLive.map((row) => row.serverID))
            }),
            inline: false
          });
        }

        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xe67e22,
            title: plugin.localize('slackersSquadServices.backup.confirmDatabaseRestore'),
            description: plugin.localize('slackersSquadServices.backup.thisWillRestoreThe', { filename, sizeFormatted: backup.sizeFormatted, age: backup.age }),
            fields: [
              { name: plugin.localize('slackersSquadServices.backup.source'), value: `\`${filename}\``, inline: true },
              { name: plugin.localize('slackersSquadServices.backup.target'), value: targetInfo, inline: true },
              { name: plugin.localize('slackersSquadServices.backup.format'), value: isJsonBackup ? plugin.localize('slackersSquadServices.backup.jsonConnectorAgnostic') : plugin.localize('slackersSquadServices.backup.sqliteFileCopy'), inline: true },
              { name: plugin.localize('slackersSquadServices.backup.instructions'), value: plugin.localize('slackersSquadServices.backup.toProceedUseS3') + filename + '`', inline: false },
              ...extraFields
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
          title: plugin.localize('slackersSquadServices.backup.restoringDatabase'),
          description: plugin.localize('slackersSquadServices.backup.readingFilenameAndUpserting', { filename }),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));

      try {
        const result = await restoreFromFile(filename, db, null, dbPath, (k, v) => plugin.localize(k, v));

        const isJson = filename.endsWith('.json');
        const summary = isJson
          ? `Imported ${Object.values(result.imported || {}).filter((r) => r.status === 'ok').reduce((s, r) => s + r.rows, 0)} rows across ${Object.keys(result.imported || {}).length} tables.`
          : `File restored successfully.`;

        // A streamed restore commits per chunk and isolates each table, so
        // one table can fail while the rest are written — and the result that
        // comes back from that is not an exception, it is a success object
        // with error entries inside it. Reporting a green tick over the top
        // of that is the failure mode this guards: the operator's next move
        // after a restore is to bring the servers up, and they need to know
        // the database is part old and part new BEFORE they do.
        const restoredTables = Object.entries(result.imported || {});
        const restoreFailures = restoredTables.filter(([, r]) => r?.status === 'error');
        const restorePartial = restoreFailures.length > 0;

        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: restorePartial ? 0xe67e22 : 0x2ecc71,
            title: restorePartial
              ? plugin.localize('slackersSquadServices.backup.databaseRestoredPartly')
              : plugin.localize('slackersSquadServices.backup.databaseRestored'),
            description: plugin.localize('slackersSquadServices.backup.successfullyRestoredFilenameSummary', { filename, summary }),
            ...(restorePartial ? {
              fields: [{
                name: plugin.localize('slackersSquadServices.backup.partialHeader'),
                value: plugin.localize('slackersSquadServices.backup.partialLanded', {
                  failed: String(restoreFailures.length),
                  tables: restoreFailures.map(([n]) => `\`${n}\``).join(', '),
                  ok: String(restoredTables.length - restoreFailures.length)
                }),
                inline: false
              }]
            } : {}),
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xe74c3c,
            title: plugin.localize('slackersSquadServices.backup.restoreFailed'),
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
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.backup.dbServiceNotReady'), description: plugin.localize('slackersSquadServices.backup.theDatabaseServiceIs'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // Acknowledge before starting. A full-tier export walks every table and
      // can take tens of seconds on a mature database (a production export runs
      // ~100 MB), during which the command looks ignored and admins re-run it.
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0xf39c12,
          title: plugin.localize('slackersSquadServices.backup.creatingBackup'),
          description: plugin.localize('slackersSquadServices.backup.exportingAllTablesTo'),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));

      try {
        const result = await exportToFile(db, null, { tier: 'all', retention: 5 });
        if (!result) {
          await sendDiscordMessage(message.channel, {
            embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.backup.backupFailed'), description: plugin.localize('slackersSquadServices.backup.couldNotCreateBackup'), timestamp: new Date().toISOString() }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0x2ecc71,
            title: plugin.localize('slackersSquadServices.backup.backupCreated'),
            description: plugin.localize('slackersSquadServices.backup.savedTo', { filename: result.filename, sizeBytes: formatSize(result.sizeBytes) }),
            fields: [{
              name: 'ℹ️',
              value: plugin.localize('slackersSquadServices.backup.useS3BackupList'),
              inline: false
            }],
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xe74c3c,
            title: plugin.localize('slackersSquadServices.backup.backupFailed'),
            description: `**${err.message}**`,
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      }
      return;
    }

    await message.reply(plugin.localize('slackersSquadServices.backup.usageS3BackupCreate'));
  });

  // ── Database (db) ─────────────────────────────────────────────

  handlers.set('db', async (plugin, message, args) => {
    const dbSub = args[1]?.toLowerCase();

    // !s3 db (no subcommand) — show help
    if (!dbSub) {
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0x3498db,
          title: plugin.localize('slackersSquadServices.db.databaseCommands'),
          description: [
            plugin.localize('slackersSquadServices.db.s3DbStatusConnector'),
            plugin.localize('slackersSquadServices.db.s3DbOrphansTables'),
            plugin.localize('slackersSquadServices.db.s3DbExportExport'),
            plugin.localize('slackersSquadServices.db.s3DbExportLogs'),
            plugin.localize('slackersSquadServices.db.s3DbExportAll'),
            plugin.localize('slackersSquadServices.db.s3DbExportTo'),
            '',
            plugin.localize('slackersSquadServices.db.everyExportIsWritten'),
            plugin.localize('slackersSquadServices.db.compressedFileFitsUnder'),
            '',
            plugin.localize('slackersSquadServices.db.s3DbImportImport'),
            plugin.localize('slackersSquadServices.db.s3DbImportConfirm'),
            '',
            plugin.localize('slackersSquadServices.db.existingPluginCommandsNot'),
            plugin.localize('slackersSquadServices.db.eloBackupEloRestore'),
            plugin.localize('slackersSquadServices.db.teambalancerExportRoundReports')
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
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.db.dbServiceNotReady'), description: plugin.localize('slackersSquadServices.db.theDatabaseServiceIs'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const connector = db.getConnectorName?.() ?? '?';
      const me = db.migrationEngine;
      const hasPending = (db.getPendingMigrations?.()?.length ?? 0) > 0;
      const expectedCount = db._expectedVersions?.size ?? 0;

      // Build schema version lines
      let schemaLines = plugin.localize('slackersSquadServices.db.noRegisteredSchemaVersions');
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

      // This command used to say "All current" while !s3 services was
      // simultaneously reporting a schema-drift warning for the same
      // database — the two commands were answering different questions
      // (pending migrations vs. live-schema drift) and neither said so.
      // getLastDriftResult() is the same drift check services reads;
      // surfacing it here too means an operator reading only db status,
      // which is what the setup runbook tells them to do, still sees it.
      // Extra-only drift (a column a migration deliberately left behind —
      // see the note in switch-db.js on SwitchPlugin_PlayerCooldowns) is
      // reported informationally and does not affect statusEmoji/statusText
      // above, matching db-service.js's own gate logic: only missing
      // columns, missing rows, or violated data post-conditions block
      // anything.
      const drift = db.getLastDriftResult?.();
      let driftField = plugin.localize('slackersSquadServices.db.schemaDriftNone');
      if (drift && drift.length > 0) {
        const hasMissing = drift.some((e) => e.missing || e.missingRows || e.dataViolations);
        driftField = hasMissing
          ? plugin.localize('slackersSquadServices.db.schemaDriftMissing', { count: drift.length })
          : plugin.localize('slackersSquadServices.db.schemaDriftExtraOnly', { count: drift.length });
      }

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: hasPending ? 0xf39c12 : 0x2ecc71,
          title: plugin.localize('slackersSquadServices.db.dbStatus', { statusEmoji, statusText }),
          fields: [
            { name: plugin.localize('slackersSquadServices.db.connector'), value: `${connectorEmoji} \`${connector}\``, inline: true },
            { name: plugin.localize('slackersSquadServices.db.schemaVersions'), value: plugin.localize('slackersSquadServices.db.registered', { expectedCount }), inline: true },
            { name: plugin.localize('slackersSquadServices.db.migrationsEngine'), value: me ? plugin.localize('slackersSquadServices.db.available') : plugin.localize('slackersSquadServices.db.notAvailable'), inline: true },
            { name: plugin.localize('slackersSquadServices.db.schemaDriftField'), value: driftField, inline: true },
            { name: plugin.localize('slackersSquadServices.db.perPluginVersions'), value: schemaLines, inline: false }
          ],
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));
      return;
    }

    // ── !s3 db orphans ───────────────────────────────────────────
    //
    // Tables carrying one of the suite’s prefixes that no registered model
    // points at. They are not a fault: a primary key cannot be altered in
    // place on SQLite or on the deployed MySQL grant, so every move to a
    // composite key created a new table beside the old one, and the old one
    // stayed because that same grant has no DROP either. The migrations that
    // built them are recorded in production, which makes them contracts, so
    // they are recreated on a fresh install as well.
    //
    // Read-only by design. This lists and counts; it never drops. An operator
    // with the grant can act on the list, and one without it at least knows
    // what the extra tables are.
    if (dbSub === 'orphans') {
      if (await rejectStrayFlags(plugin, message, sendDiscordMessage, args.slice(2), [])) return;

      const db = plugin.services?.db;
      if (!db?.isReady()) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.db.dbServiceNotReady'), description: plugin.localize('slackersSquadServices.db.theDatabaseServiceIs'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const qi = db.sequelize.getQueryInterface();
      let allTables;
      try {
        allTables = await qi.showAllTables();
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.db.orphanScanFailed'), description: plugin.localize('slackersSquadServices.db.couldNotListTables', { message: err.message }), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // showAllTables() returns strings on some dialects and {tableName} on
      // others, and MySQL with lower_case_table_names=1 — which is what
      // production runs — hands back `switchplugin_settings` for a table
      // declared `SwitchPlugin_Settings`. Every comparison below folds, or the
      // live table set would match nothing there and the command would report
      // the entire schema as orphaned.
      const stored = allTables
        .map((t) => (typeof t === 'string' ? t : t?.tableName))
        .filter(Boolean);

      const live = new Set(
        db.getModelNames()
          .map((name) => db.getModel(name)?.tableName)
          .filter(Boolean)
          .map((t) => String(t).toLowerCase())
      );

      const orphans = stored.filter((t) => {
        const folded = String(t).toLowerCase();
        if (live.has(folded)) return false;
        return SUITE_TABLE_PREFIXES.some((p) => folded.startsWith(p));
      });

      if (orphans.length === 0) {
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0x2ecc71,
            title: plugin.localize('slackersSquadServices.db.noOrphanTables'),
            description: plugin.localize('slackersSquadServices.db.everyTableCarryingAn'),
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const q = (id) => db.quoteIdentifier(id);
      const lines = [];
      for (const table of orphans.sort()) {
        // Deliberately community-wide, and the one raw count in the suite
        // that is. An orphan has no model and no serverID to filter on — it
        // is either older than the column or holds both servers’ stranded
        // rows — and the question being asked is how much is stuck in there
        // in total, not how much of it was this server’s.
        let count = null;
        try {
          const rows = await db.sequelize.query(
            `SELECT COUNT(*) AS ${q('n')} FROM ${q(table)}`,
            { type: db.sequelize.constructor.QueryTypes.SELECT }
          );
          count = Number(rows?.[0]?.n ?? 0);
        } catch {
          // A table we can list but cannot read is still worth naming.
          count = null;
        }
        const replacement = ABANDONED_BY[String(table).toLowerCase()];
        const rows = count === null
          ? plugin.localize('slackersSquadServices.db.rowsUnreadable')
          : plugin.localize('slackersSquadServices.db.nRows', { count });
        lines.push(`\`${table}\` — ${rows}${replacement ? ` → \`${replacement}\`` : ''}`);
      }

      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0x3498db,
          title: plugin.localize('slackersSquadServices.db.orphanTables', { count: orphans.length }),
          description: [
            plugin.localize('slackersSquadServices.db.theseTablesCarryA'),
            '',
            ...lines,
            '',
            plugin.localize('slackersSquadServices.db.s3NeverDropsA'),
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
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.db.dbServiceNotReady2'), description: plugin.localize('slackersSquadServices.db.theDatabaseServiceIs'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      // Not destructive, but a mangled `--all` silently exports the wrong
      // tier, and a backup that quietly omits tables is its own hazard.
      if (await rejectStrayFlags(plugin, message, sendDiscordMessage, args.slice(2), ['--logs', '--all', '--to-file', '--all-servers'])) return;

      const hasLogs = args.includes('--logs');
      const hasAll = args.includes('--all');
      const hasToFile = args.includes('--to-file');
      const tier = hasAll ? 'all' : hasLogs ? 'logs' : 'historical';

      // `--all` and `--all-servers` are different axes and both get typed under
      // pressure: one widens the tier, the other widens the servers. The flags
      // are compared exactly, so `--all-servers` never reads as `--all`.
      //
      // Scoping is applied only where there is something to scope away from. On
      // a single-server install the predicate changes nothing except drop rows
      // whose serverID is still NULL — a table between its migration and its
      // backfill — and silently shrinking the backup on the one install that
      // exists is a worse trade than exporting rows nobody else owns.
      const registered = await db.getRegisteredServers();
      const multiServer = registered.length > 1;
      const allServers = args.includes('--all-servers') || !multiServer;

      // The export always goes to a file first, whatever flags were given.
      // Building it in memory to decide whether it fits in Discord is what
      // OOM-killed the process: a production db-log dataset is ~900MB, and on
      // Node 18 that cannot even be turned into a string. Streaming to disk has
      // a fixed memory cost, and the attachment decision is then made against a
      // known file size rather than a gamble. `--to-file` now means only "don't
      // bother trying to attach it".
      await sendDiscordMessage(message.channel, {
        embeds: [{
          color: 0xf39c12,
          title: plugin.localize('slackersSquadServices.db.exportingTier', { tier }),
          description: plugin.localize('slackersSquadServices.db.streamingTablesToA'),
          timestamp: new Date().toISOString()
        }]
      }, 'S3', (...a) => plugin.verbose(...a));

      try {
        const result = await exportToFile(db, null, {
          tier,
          retention: 5,
          allServers,
          verboseLogger: (...a) => plugin.verbose(...a)
        });

        if (!result) {
          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: 0xe74c3c,
              title: plugin.localize('slackersSquadServices.db.exportFailed'),
              description: plugin.localize('slackersSquadServices.db.couldNotWriteThe'),
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        // Per-table summary. Row counts come from what was actually streamed,
        // so a table that failed part-way still reports the rows it wrote.
        const statusLines = Object.entries(result.results).map(([name, r]) =>
          r.status === 'ok'
            ? `✅ **${name}**: ${(r.rows ?? 0).toLocaleString()} rows`
            : `❌ **${name}**: ${r.error}`
        );

        // A model that declared no exportTier was included here by the default-tier
        // fallback. Say so on the backup itself — the mount-time warning is only
        // seen by whoever was reading the log at the time.
        for (const w of result.warnings || []) statusLines.push(`⚠️ ${w}`);

        const totalRows = Object.values(result.rowCounts || {}).reduce((a, b) => a + b, 0);
        const fields = [
          {
            name: plugin.localize('slackersSquadServices.db.file'),
            value: plugin.localize('slackersSquadServices.db.backupsFilename', { filename: result.filename, sizeBytes: formatSize(result.sizeBytes), totalRows: totalRows.toLocaleString() }),
            inline: false
          },
          {
            name: 'ℹ️',
            value: plugin.localize('slackersSquadServices.db.connectorConnector', { connector: result.connector }),
            inline: false
          }
        ];

        // Only on a multi-server community. On a single-server install the
        // answer is always "this server", and a field saying so on every export
        // is noise on the deployment that has no scoping question to ask.
        if (multiServer) {
          const contained = result.containedServerIDs || [];
          fields.push({
            name: plugin.localize('slackersSquadServices.db.exportScope'),
            value: plugin.localize(
              allServers
                ? 'slackersSquadServices.db.exportScopeCommunity'
                : 'slackersSquadServices.db.exportScopeServer',
              {
                serverID: String(db.getServerID()),
                contained: contained.length > 0
                  ? describeServerIDs(registered, contained, plugin.localize('slackersSquadServices.db.serverNotRegistered'))
                  : plugin.localize('slackersSquadServices.db.exportScopeNoScopedRows')
              }
            ),
            inline: false
          });
        }

        // Only try to compress and attach when the operator did not ask for a
        // file-only export. gzipFileForAttachment streams the compression and
        // checks the size *before* allocating a Buffer for it.
        let attachment = null;
        if (!hasToFile) {
          const gz = await gzipFileForAttachment(result.path, {
            limitBytes: guildAttachmentLimit(message.guild)
          });
          if (gz.attachable) {
            attachment = gz;
          } else {
            fields.push({
              name: plugin.localize('slackersSquadServices.db.noAttachment'),
              value: plugin.localize('slackersSquadServices.db.reasonTheFullExport', { reason: gz.reason, filename: result.filename }),
              inline: false
            });
          }
        }

        // Discord caps an embed description at 4096 characters — a wide model
        // registry can exceed that, and the send would fail outright.
        let description = statusLines.join('\n');
        if (description.length > 3900) {
          const okCount = statusLines.filter((l) => l.startsWith('✅')).length;
          description = statusLines.filter((l) => !l.startsWith('✅')).join('\n');
          description = `${plugin.localize('slackersSquadServices.db.exportTruncatedSummary', { okCount })}\n${description}`.slice(0, 3900);
        }

        const payload = {
          embeds: [{
            color: 0x2ecc71,
            title: plugin.localize('slackersSquadServices.db.exportCompleteTier', { tier }),
            description,
            fields,
            timestamp: new Date().toISOString()
          }]
        };
        if (attachment) {
          // sendDiscordMessage does not carry attachments — send directly.
          try {
            await message.channel.send({
              ...payload,
              files: [{ attachment: attachment.buffer, name: attachment.filename }]
            });
          } catch (sendErr) {
            // The export is already on disk and is the thing the operator asked
            // for. A rejected upload — a 413 from a limit we guessed too high, a
            // channel that forbids attachments — must not be reported as a failed
            // export, so fall back to the summary alone.
            plugin.verbose(1, `[S3] Export attachment rejected (${sendErr.message}) — posting summary only.`);
            payload.embeds[0].fields = [
              ...fields,
              {
                name: plugin.localize('slackersSquadServices.db.noAttachment'),
                value: plugin.localize('slackersSquadServices.db.discordRejectedTheUpload', { message: sendErr.message, filename: result.filename }),
                inline: false
              }
            ];
            await sendDiscordMessage(message.channel, payload, 'S3', (...a) => plugin.verbose(...a));
          }
        } else {
          await sendDiscordMessage(message.channel, payload, 'S3', (...a) => plugin.verbose(...a));
        }
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xe74c3c,
            title: plugin.localize('slackersSquadServices.db.exportFailed'),
            description: `**${err.message}**`,
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      }
      return;
    }

    // ── !s3 db import ─────────────────────────────────────────
    if (dbSub === 'import') {
      // `--confirm` writes rows; `--dry-run` is what holds it back. Same
      // asymmetry as `!s3 migrate force`, same guard.
      if (await rejectStrayFlags(plugin, message, sendDiscordMessage, args.slice(2), ['--confirm', '--dry-run', '--all-servers', '--remap-server'])) return;

      const db = plugin.services?.db;
      if (!db?.isReady()) {
        await sendDiscordMessage(message.channel, {
          embeds: [{ color: 0xe74c3c, title: plugin.localize('slackersSquadServices.db.dbServiceNotReady2'), description: plugin.localize('slackersSquadServices.db.theDatabaseServiceIs'), timestamp: new Date().toISOString() }]
        }, 'S3', (...a) => plugin.verbose(...a));
        return;
      }

      const isConfirm = args.includes('--confirm');
      const isDryRun = args.includes('--dry-run');

      // The two ways of widening an import past this server's own rows, and
      // they are opposite intentions rather than degrees of one: `--all-servers`
      // restores each row to the server it names, `--remap-server` folds every
      // row onto this one. importFromJSON() refuses both together.
      const allServers = args.includes('--all-servers');
      const remapServer = args.includes('--remap-server');
      const widened = allServers || remapServer;
      const registered = await db.getRegisteredServers();

      // ── !s3 db import --confirm [--dry-run] ──────────────────
      if (isConfirm) {
        if (!stagedImportRef.current) {
          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: 0xf39c12,
              title: plugin.localize('slackersSquadServices.db.noStagedImport'),
              description: plugin.localize('slackersSquadServices.db.noImportHasBeen'),
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        try {
          // A widened import writes rows this server does not own, so it gets a
          // second step: the first `--confirm --all-servers` shows the plan and
          // writes nothing, the second one writes. The plain import keeps its
          // single step — nothing is being decided on somebody else's behalf.
          //
          // Armed on the staged envelope rather than in a timer, because the
          // thing being agreed to is THIS file against THIS database, and both
          // are already pinned by the staging step.
          if (widened && !isDryRun && !(stagedImportRef.widenedArmed === (allServers ? 'all' : 'remap'))) {
            const preview = await planImport(db, stagedImportRef.current, { allServers, remapServer });
            const rendered = renderImportPlan(plugin, preview, registered);
            stagedImportRef.widenedArmed = allServers ? 'all' : 'remap';
            await sendDiscordMessage(message.channel, {
              embeds: [{
                color: 0xf39c12,
                title: plugin.localize('slackersSquadServices.db.importWidenedTitle'),
                description: [plugin.localize('slackersSquadServices.db.importWidenedBody'), '', ...rendered.lines].join('\n').slice(0, 3900),
                fields: rendered.fields,
                timestamp: new Date().toISOString()
              }]
            }, 'S3', (...a) => plugin.verbose(...a));
            return;
          }

          const result = await importFromJSON(db, stagedImportRef.current, {
            dryRun: isDryRun,
            localize: (k, v) => plugin.localize(k, v),
            allServers,
            remapServer
          });

          // Rendered from the plan the write was actually made on, so the
          // summary cannot describe a different operation from the one that ran.
          const rendered = result.plan ? renderImportPlan(plugin, result.plan, registered) : null;
          const statusLines = rendered ? rendered.lines : Object.entries(result.imported).map(([name, r]) => {
            if (r.status === 'ok') return `✅ **${name}**: ${r.rows} rows${r.dryRun ? ' (dry run)' : ''}`;
            // A skip is neither a success nor a failure, and rendering it as
            // either misleads: as a tick it claims rows landed, and as a cross
            // it reads as a restore that went wrong.
            if (r.status === 'skipped') return `⏭️ **${name}**: ${r.reason}`;
            return `❌ **${name}**: ${r.error}`;
          });

          const summary = isDryRun
            ? `Dry run complete — would import rows across ${Object.keys(result.imported).length} tables.`
            : `Imported ${Object.values(result.imported).filter((r) => r.status === 'ok').reduce((s, r) => s + r.rows, 0)} rows across ${Object.keys(result.imported).length} tables. Restart SquadJS for changes to be fully picked up.`;

          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: isDryRun ? 0x3498db : 0x2ecc71,
              title: isDryRun ? plugin.localize('slackersSquadServices.db.dryRunComplete') : plugin.localize('slackersSquadServices.db.importComplete'),
              description: statusLines.join('\n').slice(0, 3900),
              fields: [
                ...(rendered ? rendered.fields : []),
                ...(result.errors.length > 0
                  ? [{ name: plugin.localize('slackersSquadServices.db.warnings'), value: result.errors.join('\n'), inline: false }]
                  : [])
              ],
              footer: { text: summary },
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));

          if (!isDryRun) {
            stagedImportRef.current = null; // Clear after execution
            stagedImportRef.widenedArmed = null;
          }
        } catch (err) {
          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: 0xe74c3c,
              title: plugin.localize('slackersSquadServices.db.importFailed'),
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
            title: plugin.localize('slackersSquadServices.db.noImportFile'),
            description: plugin.localize('slackersSquadServices.db.attachAS3backupJson'),
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
        const validation = await validateImportStructure(parsed, modelNames, (k, v) => plugin.localize(k, v));

        if (!validation.valid) {
          await sendDiscordMessage(message.channel, {
            embeds: [{
              color: 0xe74c3c,
              title: plugin.localize('slackersSquadServices.db.invalidImportFile'),
              description: validation.errors.join('\n'),
              timestamp: new Date().toISOString()
            }]
          }, 'S3', (...a) => plugin.verbose(...a));
          return;
        }

        // Stage the import
        stagedImportRef.current = parsed;
        stagedImportRef.widenedArmed = null;

        const tableCount = Object.keys(parsed.tables).length;
        const totalRows = Object.values(parsed.rowCounts || {}).reduce((s, c) => s + c, 0);

        const warnLines = validation.warnings.map((w) => `⚠️ ${w}`);

        // Planned here, against the live database, rather than only described
        // from the file's own row counts. The counts in the envelope say what
        // was exported; only a query against this database can say what would
        // be overwritten, and that is the number worth reading twice.
        const stagedPlan = await planImport(db, parsed, { allServers, remapServer });
        const stagedRender = renderImportPlan(plugin, stagedPlan, registered);

        // This step only ever reads and validates the attachment — it cannot
        // write. Say so plainly: someone who has just uploaded a production
        // backup and gets back an amber "⚠️ Confirm Import" has every reason to
        // wonder whether it already went in.
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0x3498db,
            title: plugin.localize('slackersSquadServices.db.importPreviewNothingHas'),
            description: [
              plugin.localize('slackersSquadServices.db.readAndValidatedThe'),
              '',
              plugin.localize('slackersSquadServices.db.tablesAndRows', { tableCount, totalRows }),
              '',
              ...stagedRender.lines,
              ...warnLines,
              '',
              // `--dry-run` is not read at this step, so a caller who passed it
              // must not be left believing it did something.
              ...(isDryRun
                ? ['ℹ️ `--dry-run` has no effect here — this step never writes. It applies to `--confirm`.', '']
                : []),
              plugin.localize('slackersSquadServices.db.toImportForReal'),
              // Be careful not to oversell --confirm --dry-run. It returns early
              // without resolving a model or touching a column, so it re-reports
              // the file's own row counts and adds nothing to the check already
              // performed here. Claiming it validates against the live schema
              // would invite someone to trust a green dry run that proves nothing.
              plugin.localize('slackersSquadServices.db.confirmDryRunRe'),
              plugin.localize('slackersSquadServices.db.rowsAreUpsertedBy')
            ].join('\n').slice(0, 3900),
            fields: stagedRender.fields,
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      } catch (err) {
        await sendDiscordMessage(message.channel, {
          embeds: [{
            color: 0xe74c3c,
            title: plugin.localize('slackersSquadServices.db.importParseFailed'),
            description: `**${err.message}**`,
            timestamp: new Date().toISOString()
          }]
        }, 'S3', (...a) => plugin.verbose(...a));
      }
      return;
    }

    // Unknown !s3 db subcommand
    await message.reply(plugin.localize('slackersSquadServices.db.usageS3DbStatus'));
  });

  // ── Help / Default ────────────────────────────────────────────

  handlers.set('help', async (plugin, message, args) => {
    const embed = buildHelpEmbed(plugin);
    await sendDiscordMessage(message.channel, { embeds: [embed] }, 'S3', (...a) => plugin.verbose(...a));
  });

  return {
    handlers,
    runDiagnostic: (plugin, message) => runDiagnostic(plugin, message, sendDiscordMessage)
  };
}