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

/**
 * Build a migration status embed from pending data.
 * @param {object} plugin - Plugin instance, for localize().
 * @param {Array<{pluginName: string, currentVersion: number, expectedVersion: number, behind: number}>} pending
 * @param {string} [status='pending'] - 'pending', 'running', 'complete', 'failed', 'cancelled', 'timeout'
 * @param {Object} [result] - Optional result from runMigrations()
 * @returns {Object} Discord embed object
 */
function buildMigrationEmbed(plugin, pending, status = 'pending', result = null) {
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

  const description = [
    '```',
    ...migrationLines,
    '```'
  ];

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

export { buildMigrationEmbed };
