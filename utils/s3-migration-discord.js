/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           S³ MIGRATION DISCORD CONFIRMATION                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Provides the Discord-based human confirmation flow for schema
 * migrations. When pending migrations are detected on mount,
 * this module posts an embed to the admin channel with ✅/❌ reaction
 * controls. The migration engine is called directly (no events) and
 * the DBService migration gate is resolved on completion/timeout.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * setupMigrationPrompt(plugin, pending)
 *   Posts an embed, listens for reactions, runs migrations on ✅,
 *   resolves the DBService gate on all outcomes. Returns nothing.
 *   Called once during S³ mount after Discord is registered.
 *
 * buildMigrationEmbed(pending, status)
 *   Builds the embed for a migration prompt. Exported for use by
 *   !s3 migrate pending and !s3 migrate status commands.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Uses the existing Discord message listener patterns from s3-discord.js
 *   (sendDiscordMessage, same channel ID).
 * - Reaction collector times out after 5 minutes, auto-cancelling.
 * - The migration engine runs each migration in its own transaction;
 *   this module only orchestrates the confirmation layer.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * - plugin.options.discordClient — Discord.js client (raw, legacy event)
 * - plugin.options.channelID — Admin channel ID
 * - plugin.db — DBService instance for migrationEngine access
 *
 */
const MIGRATION_COLLECTOR_TIMEOUT = 5 * 60 * 1000; // 5 minutes

/**
 * Build a migration status embed from pending data.
 * @param {Array<{pluginName: string, currentVersion: number, expectedVersion: number, behind: number}>} pending
 * @param {string} [status='pending'] - 'pending', 'running', 'complete', 'failed', 'cancelled', 'timeout'
 * @param {Object} [result] - Optional result from runMigrations()
 * @returns {Object} Discord embed object
 */
function buildMigrationEmbed(pending, status = 'pending', result = null) {
  const statusConfig = {
    pending:   { color: 0xf39c12, title: '⚠️ S³ Migration Required',      emoji: '⏳' },
    running:   { color: 0x3498db, title: '🔄 S³ Migration In Progress',    emoji: '🔄' },
    complete:  { color: 0x2ecc71, title: '✅ S³ Migration Complete',       emoji: '✅' },
    failed:    { color: 0xe74c3c, title: '❌ S³ Migration Failed',         emoji: '❌' },
    cancelled: { color: 0x95a5a6, title: '⏹️ S³ Migration Cancelled',      emoji: '⏹️' },
    timeout:   { color: 0x95a5a6, title: '⏰ S³ Migration Auto-Cancelled', emoji: '⏰' }
  };

  const cfg = statusConfig[status] || statusConfig.pending;

  // Build per-plugin migration lines
  const migrationLines = pending.map((p) => {
    const fromVer = p.currentVersion > 0 ? `v${p.currentVersion}` : '(new)';
    if (status === 'pending' || status === 'running') {
      return `  ${fromVer} → v${p.expectedVersion} (${p.behind} migration${p.behind > 1 ? 's' : ''} pending)`;
    }
    return `  ${fromVer} → v${p.expectedVersion}`;
  });

  const description = [
    `**Plugin(s):** ${pending.map((p) => `\`${p.pluginName}\``).join(', ')}`,
    '',
    '```',
    ...migrationLines,
    '```'
  ];

  if (status === 'pending') {
    description.push(
      '',
      'React ✅ to run migrations or ❌ to cancel.',
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

/**
 * Post a migration confirmation embed, collect ✅/❌ reactions, and handle.
 * Called from S³ mount after Discord is registered.
 *
 * @param {object} plugin - S³ plugin instance
 * @param {Array<{pluginName: string, currentVersion: number, expectedVersion: number, behind: number}>} pending - Pending migrations
 * @returns {Promise<void>}
 */
async function setupMigrationPrompt(plugin, pending) {
  if (!pending || pending.length === 0) {
    plugin.verbose(3, '[S3 Migration] No pending migrations to prompt about.');
    return;
  }

  const discordClient = plugin.options.discordClient;
  const channelID = plugin.options.channelID;

  if (!discordClient || !channelID) {
    plugin.verbose(1, '[S3 Migration] Discord not configured — cannot prompt for migration approval. Migrations remain pending.');
    plugin.verbose(1, '[S3 Migration] Use `!s3 migrate force` (once Discord is available) or set `autoMigrate: true` in S³ config and restart.');
    return;
  }

  let channel;
  try {
    channel = await discordClient.channels.fetch(channelID);
  } catch (err) {
    plugin.verbose(1, `[S3 Migration] Failed to fetch Discord channel ${channelID}: ${err.message}`);
    return;
  }

  if (!channel) {
    plugin.verbose(1, '[S3 Migration] Discord channel not found — cannot prompt.');
    return;
  }

  // Post the confirmation embed
  const embed = buildMigrationEmbed(pending, 'pending');
  let promptMessage;
  try {
    promptMessage = await channel.send({ embeds: [embed] });
  } catch (err) {
    plugin.verbose(1, `[S3 Migration] Failed to post migration prompt: ${err.message}`);
    return;
  }

  // Add ✅ and ❌ reactions
  try {
    await promptMessage.react('✅');
    await promptMessage.react('❌');
  } catch (err) {
    plugin.verbose(1, `[S3 Migration] Failed to add reactions: ${err.message}`);
    // Continue anyway — admins can use !s3 migrate force
  }

  // Collect reactions
  const db = plugin.services.db;
  let resolved = false;

  try {
    const collected = await promptMessage.awaitReactions({
      filter: (reaction, user) => {
        // Only count reactions from non-bot users
        if (user.bot) return false;
        const emoji = reaction.emoji.name;
        return emoji === '✅' || emoji === '❌';
      },
      max: 1,
      time: MIGRATION_COLLECTOR_TIMEOUT,
      errors: ['time']
    });

    if (collected.size === 0) {
      // Timeout
      resolved = true;
      const timeoutEmbed = buildMigrationEmbed(pending, 'timeout');
      await channel.send({ embeds: [timeoutEmbed] });
      plugin.verbose(2, '[S3 Migration] Prompt timed out (5 min). Migrations deferred.');
      db._resolveMigrationGate(false);
      return;
    }

    const reaction = collected.first();
    const emoji = reaction.emoji.name;

    if (emoji === '❌') {
      // Cancelled
      resolved = true;
      const cancelEmbed = buildMigrationEmbed(pending, 'cancelled');
      await channel.send({ embeds: [cancelEmbed] });
      plugin.verbose(2, '[S3 Migration] User cancelled migration. Deferred.');
      db._resolveMigrationGate(false);
      return;
    }

    // ✅ Confirmed — run migrations
    const runningEmbed = buildMigrationEmbed(pending, 'running');
    await channel.send({ embeds: [runningEmbed] });
    plugin.verbose(2, '[S3 Migration] User confirmed. Running migrations...');

    let totalApplied = 0;
    let totalSkipped = 0;
    let hadError = false;
    let lastError = null;

    for (const p of pending) {
      try {
        const me = db.migrationEngine;
        if (!me) {
          plugin.verbose(1, `[S3 Migration] MigrationEngine not available — cannot migrate "${p.pluginName}".`);
          hadError = true;
          lastError = 'MigrationEngine not initialised';
          break;
        }

        const result = await me.runMigrations(p.pluginName, { force: false });
        totalApplied += result.applied || 0;
        totalSkipped += result.skipped || 0;
        plugin.verbose(2, `[S3 Migration] "${p.pluginName}": ${result.applied} applied, ${result.skipped} skipped.`);
      } catch (err) {
        plugin.verbose(1, `[S3 Migration] Migration failed for "${p.pluginName}": ${err.message}`);
        hadError = true;
        lastError = err.message;
        break; // Stop on first failure — don't cascade
      }
    }

    // Resolve gate (marks pending as resolved)
    db._resolveMigrationGate(!hadError);

    if (hadError) {
      const failEmbed = buildMigrationEmbed(pending, 'failed', { error: lastError, totalApplied, totalSkipped });
      await channel.send({ embeds: [failEmbed] });
      plugin.verbose(1, '[S3 Migration] Migration failed. Gate resolved. Plugins unblocked.');
    } else {
      const doneEmbed = buildMigrationEmbed(pending, 'complete', { totalApplied, totalSkipped });
      await channel.send({ embeds: [doneEmbed] });
      plugin.verbose(2, `[S3 Migration] All migrations complete. ${totalApplied} applied.`);

      // Log version status after completion
      const versionStatus = await db.verifySchemaVersions();
      if (versionStatus.upToDate) {
        const statusEmbed = buildMigrationEmbed(pending, 'complete', { totalApplied, totalSkipped });
        await channel.send({ embeds: [statusEmbed] });
      } else {
        plugin.verbose(2, `[S3 Migration] Some migrations still pending after run: ${versionStatus.pending.length}`);
      }
    }
  } catch (err) {
    // Handle timeout error from awaitReactions
    if (!resolved) {
      plugin.verbose(1, `[S3 Migration] Reaction collection error: ${err.message}`);
      // If it's a timeout, handle it
      if (err.message === 'time' || err.name === 'AggregateError' || (Array.isArray(err) && err.length > 0)) {
        const timeoutEmbed = buildMigrationEmbed(pending, 'timeout');
        try { await channel.send({ embeds: [timeoutEmbed] }); } catch (_) { /* ignore */ }
        plugin.verbose(2, '[S3 Migration] Prompt timed out (5 min). Migrations deferred.');
      }
      db._resolveMigrationGate(false);
    }
  }
}

export { setupMigrationPrompt, buildMigrationEmbed };