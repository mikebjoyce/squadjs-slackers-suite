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
    const fromVer = p.currentVersion > 0 ? `v${p.currentVersion}` : '(new)';
    if (status === 'pending' || status === 'running') {
      return `  ${p.pluginName}: ${fromVer} → v${p.expectedVersion} (${p.behind} pending)`;
    }
    return `  ${p.pluginName}: ${fromVer} → v${p.expectedVersion}`;
  });

  const description = [
    '```',
    ...migrationLines,
    '```'
  ];

  if (status === 'pending') {
    description.push(
      '',
      'Type `!s3 confirm <token>` to run migrations.',
      'Type `!s3 migrate force` to bypass confirmation.',
      'Auto-cancels after 5 minutes if no response.',
      '',
      '> **Note:** If cancelled, migrations remain pending.',
      '> Use `!s3 migrate force` to run them later.'
    );
  }

  if (status === 'complete' && result) {
    const totalApplied = result.totalApplied || 0;
    const totalSkipped = result.totalSkipped || 0;
    description.push(
      '',
      `Applied: **${totalApplied}** | Skipped: **${totalSkipped}**`
    );
  }

  if (status === 'failed' && result) {
    const errorMsg = result.error || 'Unknown error';
    description.push(
      '',
      `**Error:** ${errorMsg}`
    );
  }

  if (status === 'cancelled' || status === 'timeout') {
    description.push(
      '',
      'Migrations have been deferred. The pending state will persist until the next restart or `!s3 migrate force`.'
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
