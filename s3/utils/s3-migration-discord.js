/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           S³ MIGRATION DISCORD — EMBED HELPER ONLY            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Provides a shared embed builder for migration status display.
 * The confirmation flow uses a token-based system (!s3 confirm <token>)
 * handled in s3-commands.js. The previous reaction-based ✅/❌ prompt
 * has been removed.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * buildMigrationEmbed(plugin, pending, status, result)
 *   Builds a Discord embed describing migration status. Used by
 *   !s3 migrate pending, !s3 migrate status, and the startup
 *   confirmation prompt in slackers-squad-services.js.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - All confirmation logic lives in migration-engine.js (confirmToken gate)
 *   and s3-commands.js (!s3 confirm <token> handler).
 *
 */

import { serverLabels } from './s3-server-label.js';

/**
 * A short, operator-facing name for the server this process runs — for embeds
 * whose meaning depends on which of several processes posted them, above all
 * the migration prompt, whose token exactly one process will accept.
 *
 * The registry id is always in the string. On a loopback test rig two installs
 * share a host:port, and the id is the only part guaranteed to differ; the
 * Run 1 collision was two visually identical prompts differing only by token.
 * A distinct label or alias goes in front when the registry has one — an
 * operator matches "slackers-2" faster than a bare number — and host:port is
 * appended when the SquadJS server object carries it, as a third anchor.
 *
 * @param {object} db - DBService, for getServerID()/getRegisteredServers().
 * @param {object} [server] - The SquadJS server, for options.host/queryPort.
 * @returns {Promise<string>}
 */
async function formatServerIdentity(db, server = null) {
  const id = db?.getServerID?.() ?? '?';
  let name = null;
  try {
    if (db?.isReady?.() && typeof db.getRegisteredServers === 'function') {
      const rows = await db.getRegisteredServers();
      const mine = rows.find((r) => r.serverID === id) ?? null;
      name = serverLabels(rows).get(id) || mine?.alias || null;
    }
  } catch {
    // A name is a nicety; the id carries the load.
  }
  const host = server?.options?.host;
  const port = server?.options?.queryPort;
  const hostPart = host ? ` · ${host}${port ? `:${port}` : ''}` : '';
  return name ? `${name} (server ${id}${hostPart})` : `server ${id}${hostPart}`;
}

/**
 * Build a migration status embed from pending data.
 * @param {object} plugin - Plugin instance, for localize().
 * @param {Array<{pluginName: string, currentVersion: number, expectedVersion: number, behind: number}>} pending
 * @param {string} [status='pending'] - 'pending', 'running', 'complete', 'failed', 'cancelled', 'timeout'
 * @param {Object} [result] - Optional result from runMigrations()
 * @param {string} [identity] - Operator-facing server name from formatServerIdentity().
 *        When set on a 'pending' prompt it becomes the first line, so two
 *        processes prompting against one shared database post embeds an
 *        operator can tell apart before reading as far as the token.
 * @returns {Object} Discord embed object
 */
function buildMigrationEmbed(plugin, pending, status = 'pending', result = null, identity = null) {
  const statusConfig = {
    pending:   { color: 0xf39c12, title: plugin.localize('slackersSquadServices.migration.sMigrationRequired'),      emoji: '⏳' },
    running:   { color: 0x3498db, title: plugin.localize('slackersSquadServices.migration.sMigrationInProgress'),    emoji: '🔄' },
    complete:  { color: 0x2ecc71, title: plugin.localize('slackersSquadServices.migration.sMigrationComplete'),       emoji: '✅' },
    failed:    { color: 0xe74c3c, title: plugin.localize('slackersSquadServices.migration.sMigrationFailed'),         emoji: '❌' },
    cancelled: { color: 0x95a5a6, title: plugin.localize('slackersSquadServices.migration.sMigrationCancelled'),      emoji: '⏹️' },
    timeout:   { color: 0x95a5a6, title: plugin.localize('slackersSquadServices.migration.sMigrationAutoCancelled'), emoji: '⏰' }
  };

  const cfg = statusConfig[status] || statusConfig.pending;

  // Build per-plugin migration lines with plugin name prefix
  const migrationLines = pending.map((p) => {
    const fromVer = p.currentVersion > 0
      ? `v${p.currentVersion}`
      : plugin.localize('slackersSquadServices.migration.versionNew');
    if (status === 'pending' || status === 'running') {
      return plugin.localize('slackersSquadServices.migration.lineWithPending', {
        pluginName: p.pluginName, fromVer, toVer: p.expectedVersion, behind: p.behind
      });
    }
    return plugin.localize('slackersSquadServices.migration.line', {
      pluginName: p.pluginName, fromVer, toVer: p.expectedVersion
    });
  });

  const description = [];

  // First line, ahead of the schema list: on a shared database two processes
  // prompt with two different tokens, and the footer label they carry
  // suppresses itself in exactly that first-boot state (only one server
  // registered yet). Naming the server here does not depend on that label.
  if (identity && status === 'pending') {
    description.push(
      plugin.localize('slackersSquadServices.migration.promptFromServer', { identity }),
      ''
    );
  }

  description.push('```', ...migrationLines, '```');

  if (status === 'pending') {
    description.push(
      '',
      plugin.localize('slackersSquadServices.migration.typeConfirmToRun'),
      plugin.localize('slackersSquadServices.migration.typeForceToBypass'),
      plugin.localize('slackersSquadServices.migration.autoCancelsAfterMinutes'),
      '',
      plugin.localize('slackersSquadServices.migration.noteIfCancelledPending'),
      plugin.localize('slackersSquadServices.migration.noteUseForceLater')
    );
  }

  if (status === 'complete' && result) {
    const totalApplied = result.totalApplied || 0;
    const totalSkipped = result.totalSkipped || 0;
    description.push(
      '',
      plugin.localize('slackersSquadServices.migration.appliedSkipped', { totalApplied, totalSkipped })
    );
  }

  if (status === 'failed' && result) {
    const errorMsg = result.error || plugin.localize('slackersSquadServices.migration.unknownError');
    description.push(
      '',
      plugin.localize('slackersSquadServices.migration.errorLine', { errorMsg })
    );
  }

  if (status === 'cancelled' || status === 'timeout') {
    description.push(
      '',
      plugin.localize('slackersSquadServices.migration.deferredUntilRestart')
    );
  }

  return {
    color: cfg.color,
    title: cfg.title,
    description: description.join('\n'),
    timestamp: new Date().toISOString()
  };
}

export { buildMigrationEmbed, formatServerIdentity };
