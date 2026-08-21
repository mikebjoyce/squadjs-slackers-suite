/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              SWITCH PLUGIN — DATABASE LAYER                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * S³ database surface for the Switch plugin: model definitions,
 * migration registration, settings persistence, cooldown cleanup,
 * player lookup, and explain auto-update message ID persistence.
 * Extracted from switch.js during the refactor to keep the main
 * plugin focused on orchestration.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SwitchDB (default)
 *   Singleton with a single async register(plugin) method.
 *   Must be called during _onS3Ready() after S³ DB is confirmed ready.
 *   Adds to plugin: timeLimitEnabled, _loadTimeLimitSetting,
 *   _saveTimeLimitSetting, _loadExplainMessageId,
 *   _saveExplainMessageId, cleanup, checkPlayer.
 *   Also calls defineModel(), registerExpectedVersion(),
 *   registerMigrations(), and verifyAndRunMigrations() on the plugin.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Sequelize (Op) — query operators for cleanup() and checkPlayer().
 * All other dependencies are accessed via plugin.* (the live plugin
 * instance passed to register()).
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Model definitions are idempotent — defineModel() caches.
 * - Migrations are version-tracked via S³ MigrationEngine.
 * - timeLimitEnabled defaults to true; loaded from DB after
 *   migrations guarantee the Settings table exists.
 * - cleanup() applies two-tier row retention: rows at exactly
 *   maxSwitchTokens with no seed state are pruned after 30 minutes
 *   (they carry no information); everything else is pruned after
 *   pruneInactivePlayerDays. Connected players and seed mode are
 *   both excluded. See the cleanup() docblock for why the tier-1
 *   token comparison must stay an equality.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Sequelize from 'sequelize';
const { Op } = Sequelize;

const SwitchDB = {
  /**
   * Registers DB models, migrations, and attaches CRUD methods to the plugin.
   * Must be called during _onS3Ready() after S³ DB is confirmed ready.
   *
   * @param {object} plugin — the live Switch plugin instance
   */
  async register(plugin) {
    // ── Model Definitions ──────────────────────────────────────

    plugin.defineModel('SwitchPlugin_PlayerCooldowns', {
      eosID: {
        type: plugin._s3db.getDataTypes().STRING,
        primaryKey: true,
        allowNull: false
      },
      steamID: {
        type: plugin._s3db.getDataTypes().STRING,
        allowNull: true
      },
      playerName: {
        type: plugin._s3db.getDataTypes().STRING,
        allowNull: true
      },
      lastSwitchTimestamp: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: true
      },
      firstSeenTimestamp: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: true
      },
      scrambleLockdownExpiry: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: true
      },
      // v2.3.0: Token bucket fields
      tokenBalance: {
        type: plugin._s3db.getDataTypes().INTEGER,
        allowNull: false,
        defaultValue: 2
      },
      tokenRegenAnchor: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: true
      },
      // v2.3.0 Stage 2: Seed bonus token tracking
      seedPresenceStart: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: true
      },
      lastSeedBonusRoundID: {
        type: plugin._s3db.getDataTypes().STRING,
        allowNull: true
      },
      seedBonusTokensEarned: {
        type: plugin._s3db.getDataTypes().INTEGER,
        allowNull: false,
        defaultValue: 0
      },
      // v2.5.0: Last activity timestamp, the retention clock for cleanup().
      // Written on join (onS3PlayerJoined), on leave (onS3PlayerLeft) and on every
      // token spend — none of them gated on seed mode. The leave write is what makes
      // the field mean "last seen" rather than "last stamped event"; without it a
      // player connected for days without spending would be prunable the instant
      // they disconnect. Replaces firstSeenTimestamp, which only ever recorded row
      // creation and so could not express staleness at all.
      //
      // v2.5.5: This column carries a migration post-condition — v5 declares
      // touches.data notNull on it, which drift detection re-checks on EVERY
      // mount. A row created without it does not merely age badly (cleanup()
      // requires lastActiveTimestamp != null before pruning, so NULL rows are
      // immortal); it fails the assertion and puts Switch into a
      // rollback-and-re-gate loop until an operator re-runs the migration.
      //
      // Every path that CREATES a row must therefore stamp it. As of v2.5.5:
      //   switch.js         onS3PlayerJoined seed-mode create
      //   switch.js         seed-grant bulkCreate for connected players with no row
      //   switch.js         scramble lockdown bulkCreate (fixed in v2.5.5)
      //   switch-queue.js   all three token-spend upserts
      //   switch-commands.js  the admin grant/reset upserts
      // The join and leave handlers are UPDATE ... WHERE eosID — they no-op when
      // no row exists, so they maintain the value but never introduce a NULL.
      lastActiveTimestamp: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: true
      }
      // Cooldowns expire on their own and are re-established by live play.
    }, { timestamps: false, exportTier: 'ephemeral' });

    plugin.defineModel('SwitchPlugin_Endmatches', {
      id: {
        type: plugin._s3db.getDataTypes().INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      name: {
        type: plugin._s3db.getDataTypes().STRING
      },
      steamID: {
        type: plugin._s3db.getDataTypes().STRING
      },
      eosID: {
        type: plugin._s3db.getDataTypes().STRING
      },
      created_at: {
        type: plugin._s3db.getDataTypes().DATE,
        defaultValue: plugin._s3db.getDataTypes().NOW
      }
      // End-of-match switch requests, consumed at the next round end.
    }, { timestamps: false, exportTier: 'ephemeral' });

    // Settings key-value table for runtime toggles
    plugin.defineModel('SwitchPlugin_Settings', {
      key: {
        type: plugin._s3db.getDataTypes().STRING,
        primaryKey: true,
        allowNull: false
      },
      value: {
        type: plugin._s3db.getDataTypes().STRING,
        allowNull: false
      }
      // Operator-configured runtime toggles. NOT auto-recoverable — if lost, an
      // admin has to re-enter them by hand — so this is historical, unlike the
      // other two Switch tables.
    }, { timestamps: false, freezeTableName: true, exportTier: 'historical' });

    // ── Migration Registration ─────────────────────────────────

    plugin.registerExpectedVersion('switch', 5, {
      models: ['SwitchPlugin_PlayerCooldowns', 'SwitchPlugin_Endmatches', 'SwitchPlugin_Settings']
    });
    plugin.registerMigrations('switch', [
      {
        version: 1,
        description: 'Create SwitchPlugin_PlayerCooldowns and SwitchPlugin_Endmatches',
        // touches added retroactively for DDL verification (migration engine v2.3.0).
        // Migration logic is unchanged — the touches declaration enables _verifyMigrationResult()
        // to confirm the tables actually exist after the migration commits.
        touches: {
          creates: ['SwitchPlugin_PlayerCooldowns', 'SwitchPlugin_Endmatches']
        },
        up: async (qi) => {
          const existing = await qi.showAllTables();
          if (!existing.includes('SwitchPlugin_PlayerCooldowns')) {
            await qi.createTable('SwitchPlugin_PlayerCooldowns', {
              eosID: { type: qi.DataTypes.STRING, primaryKey: true, allowNull: false },
              steamID: { type: qi.DataTypes.STRING, allowNull: true },
              playerName: { type: qi.DataTypes.STRING, allowNull: true },
              lastSwitchTimestamp: { type: qi.DataTypes.DATE, allowNull: true },
              firstSeenTimestamp: { type: qi.DataTypes.DATE, allowNull: true },
              scrambleLockdownExpiry: { type: qi.DataTypes.DATE, allowNull: true }
            });
          }
          if (!existing.includes('SwitchPlugin_Endmatches')) {
            await qi.createTable('SwitchPlugin_Endmatches', {
              id: { type: qi.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
              name: { type: qi.DataTypes.STRING },
              steamID: { type: qi.DataTypes.STRING },
              eosID: { type: qi.DataTypes.STRING },
              created_at: { type: qi.DataTypes.DATE, defaultValue: qi.DataTypes.NOW }
            });
          }
        },
        down: async (qi) => {
          await qi.dropTable('SwitchPlugin_PlayerCooldowns');
          await qi.dropTable('SwitchPlugin_Endmatches');
        }
      },
      {
        version: 2,
        description: 'Create SwitchPlugin_Settings table with timeLimitEnabled seed row',
        touches: {
          creates: ['SwitchPlugin_Settings'],
          rows: {
            SwitchPlugin_Settings: [{ key: 'key', value: 'timeLimitEnabled' }]
          }
        },
        up: async (qi) => {
          const existing = await qi.showAllTables();
          if (!existing.includes('SwitchPlugin_Settings')) {
            await qi.createTable('SwitchPlugin_Settings', {
              key: { type: qi.DataTypes.STRING, primaryKey: true, allowNull: false },
              value: { type: qi.DataTypes.STRING, allowNull: false }
            });
            await qi.bulkInsert('SwitchPlugin_Settings', [{
              key: 'timeLimitEnabled',
              value: 'true'
            }]);
          }
        },
        down: async (qi) => {
          await qi.dropTable('SwitchPlugin_Settings');
        }
      },
      {
        version: 3,
        description: 'Add token bucket + seed bonus columns, truncate existing data (merged from original v3+v4 — never deployed separately)',
        touches: {
          columns: {
            SwitchPlugin_PlayerCooldowns: [
              'tokenBalance',
              'tokenRegenAnchor',
              'seedPresenceStart',
              'lastSeedBonusRoundID',
              'seedBonusTokensEarned'
            ]
          }
        },
        up: async (qi) => {
          const existing = await qi.showAllTables();
          if (existing.includes('SwitchPlugin_PlayerCooldowns')) {
            const columns = await qi.describeTable('SwitchPlugin_PlayerCooldowns');
            if (!columns.tokenBalance) {
              await qi.addColumn('SwitchPlugin_PlayerCooldowns', 'tokenBalance', {
                type: qi.DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 2
              });
            }
            if (!columns.tokenRegenAnchor) {
              await qi.addColumn('SwitchPlugin_PlayerCooldowns', 'tokenRegenAnchor', {
                type: qi.DataTypes.DATE,
                allowNull: true
              });
            }
            if (!columns.seedPresenceStart) {
              await qi.addColumn('SwitchPlugin_PlayerCooldowns', 'seedPresenceStart', {
                type: qi.DataTypes.DATE,
                allowNull: true
              });
            }
            if (!columns.lastSeedBonusRoundID) {
              await qi.addColumn('SwitchPlugin_PlayerCooldowns', 'lastSeedBonusRoundID', {
                type: qi.DataTypes.STRING,
                allowNull: true
              });
            }
            if (!columns.seedBonusTokensEarned) {
              await qi.addColumn('SwitchPlugin_PlayerCooldowns', 'seedBonusTokensEarned', {
                type: qi.DataTypes.INTEGER,
                allowNull: false,
                defaultValue: 0
              });
            }
            // Truncate existing data — players start fresh with max tokens.
            // Uses bulkDelete with empty where clause for dialect-agnostic
            // truncation (works on SQLite, PostgreSQL, MySQL).
            // NOTE: This is destructive and unconditional. The migration engine's
            // version tracking prevents re-execution, but if this migration is
            // ever manually re-run, all cooldown state will be lost again.
            await qi.sequelize.getQueryInterface().bulkDelete('SwitchPlugin_PlayerCooldowns', {}, { transaction: qi.transaction });
          }
        },
        down: async (qi) => {
          // NOTE: Rollback drops all token/seed columns. Truncated data from the
          // up migration cannot be recovered — this is intentionally irreversible
          // by design (the expand-contract pattern drops the old column only when
          // the "contract" step is ready, but the deleted rows are gone regardless).
          const existing = await qi.showAllTables();
          if (existing.includes('SwitchPlugin_PlayerCooldowns')) {
            const columns = await qi.describeTable('SwitchPlugin_PlayerCooldowns');
            if (columns.tokenBalance) {
              await qi.removeColumn('SwitchPlugin_PlayerCooldowns', 'tokenBalance');
            }
            if (columns.tokenRegenAnchor) {
              await qi.removeColumn('SwitchPlugin_PlayerCooldowns', 'tokenRegenAnchor');
            }
            if (columns.seedPresenceStart) {
              await qi.removeColumn('SwitchPlugin_PlayerCooldowns', 'seedPresenceStart');
            }
            if (columns.lastSeedBonusRoundID) {
              await qi.removeColumn('SwitchPlugin_PlayerCooldowns', 'lastSeedBonusRoundID');
            }
            if (columns.seedBonusTokensEarned) {
              await qi.removeColumn('SwitchPlugin_PlayerCooldowns', 'seedBonusTokensEarned');
            }
          }
        }
      },
      {
        version: 4,
        description: 'Add explainMessageId to SwitchPlugin_Settings for explain auto-update persistence',
        // Data-only migration — inserts a seed row into SwitchPlugin_Settings.
        // touches.rows enables the migration engine's post-commit verifier and
        // ongoing drift detection (on every mount) to confirm the row exists.
        //
        // The up() uses model-based access (qi.db.getModel) rather than raw SQL
        // or qi.bulkInsert because Sequelize handles dialect-correct identifier
        // quoting (backticks for MySQL, double quotes for Postgres).
        touches: {
          rows: {
            SwitchPlugin_Settings: [{ key: 'key', value: 'explainMessageId' }]
          }
        },
        up: async (qi) => {
          const existing = await qi.showAllTables();
          if (existing.includes('SwitchPlugin_Settings')) {
            const SettingsModel = qi.db.getModel('SwitchPlugin_Settings');
            if (SettingsModel) {
              const row = await SettingsModel.findByPk('explainMessageId', { transaction: qi.transaction });
              if (!row) {
                await SettingsModel.create(
                  { key: 'explainMessageId', value: '' },
                  { transaction: qi.transaction }
                );
              }
            }
          }
        },
        down: async (qi) => {
          // Dialect-safe model access — avoids qi.bulkDelete which produces
          // dialect-inconsistent WHERE clauses on some connectors.
          const SettingsModel = qi.db.getModel('SwitchPlugin_Settings');
          if (SettingsModel) {
            await SettingsModel.destroy({ where: { key: 'explainMessageId' }, transaction: qi.transaction });
          }
        }
      },
      {
        version: 5,
        description: 'Add lastActiveTimestamp column for cleanup staleness (Fix 2)',
        touches: {
          columns: {
            SwitchPlugin_PlayerCooldowns: ['lastActiveTimestamp']
          },
          // The column existing is not the point of this migration — the column
          // being *populated* is. Declaring it here makes the backfill's success
          // a condition of recording v5, and re-checks it on every mount, which
          // is the only thing that would have caught the hand-migrated server
          // where the ALTER was already done and the backfill silently no-opped.
          //
          // This is re-checked forever, so it is only safe because every path
          // that CREATES a row stamps the column — see the lastActiveTimestamp
          // comment on the model above for the authoritative list. The join and
          // leave handlers are UPDATEs that no-op when no row exists, so they
          // cannot introduce a NULL; only the creating paths can. Adding a row
          // creator that omits this column would put Switch into a
          // rollback-and-re-gate loop on every mount.
          data: {
            SwitchPlugin_PlayerCooldowns: [{ column: 'lastActiveTimestamp', notNull: true }]
          }
        },
        up: async (qi) => {
          const existing = await qi.showAllTables();
          if (existing.includes('SwitchPlugin_PlayerCooldowns')) {
            const columns = await qi.describeTable('SwitchPlugin_PlayerCooldowns');
            if (!columns.lastActiveTimestamp) {
              await qi.addColumn('SwitchPlugin_PlayerCooldowns', 'lastActiveTimestamp', {
                type: qi.DataTypes.DATE,
                allowNull: true
              });
            }
            // Backfill to the migration's run time, NOT to firstSeenTimestamp.
            // firstSeenTimestamp records when a row was created, not when the
            // player was last around — backfilling from it would hand long-lived
            // rows an already-expired retention clock and delete players who were
            // on the server yesterday. Stamping everyone at upgrade gives a fresh
            // window: active players get re-stamped on their next connect or
            // disconnect, genuinely abandoned rows age out on schedule.
            //
            // Deliberately OUTSIDE the addColumn guard, and matched on IS NULL.
            // The column existing does not imply the backfill ran: a DB that was
            // hand-migrated, or one where an earlier attempt at this migration
            // failed after the ALTER, arrives here with the column present and
            // every row NULL. cleanup() treats NULL as "keep", so those rows are
            // not at risk of deletion — they simply never age out until the player
            // reconnects. Re-running with `!s3 migrate force` repairs them.
            // Op.is generates a real `IS NULL` (never the `= NULL` that matches
            // nothing), and updating only NULL rows keeps this idempotent: rows
            // already stamped by live gameplay are left alone rather than being
            // reset to the migration's clock.
            //
            // Runs inside the migration's transaction so a later failure rolls the
            // backfill back with the addColumn, rather than leaving every row
            // stamped against a column that no longer exists.
            await qi.bulkUpdate(
              'SwitchPlugin_PlayerCooldowns',
              { lastActiveTimestamp: new Date() },
              { lastActiveTimestamp: { [Op.is]: null } }
            );
          }
        },
        down: async (qi) => {
          const existing = await qi.showAllTables();
          if (existing.includes('SwitchPlugin_PlayerCooldowns')) {
            const columns = await qi.describeTable('SwitchPlugin_PlayerCooldowns');
            if (columns.lastActiveTimestamp) {
              await qi.removeColumn('SwitchPlugin_PlayerCooldowns', 'lastActiveTimestamp');
            }
          }
        }
      }
    ]);

    // Run any pending migrations.
    //
    // A null result does NOT mean "up to date": verifyAndRunMigrations() also
    // returns null when the DB is unavailable, and when migrations are pending
    // but unconfirmed (it logs its own line in that case, and S³ posts the
    // Discord prompt). Claiming "already up to date" here printed a flat
    // contradiction two lines below "Migrations pending but not confirmed" —
    // harmless to the run, actively misleading to whoever is reading the log
    // while a migration is stuck.
    const result = await plugin.verifyAndRunMigrations('switch');
    if (result) {
      plugin.verbose(1, `[S3] Switch migrations: applied=${result.applied}, skipped=${result.skipped}.`);
    } else {
      plugin.verbose(3, '[S3] Switch migrations not run this pass — schema current, awaiting confirmation, or DB unavailable.');
    }

    // ── Attach Methods ─────────────────────────────────────────

    /**
     * Loads the timeLimitEnabled setting from SwitchPlugin_Settings.
     * Falls back to true (safe default) if the table, row, or DB is unavailable.
     */
    plugin._loadTimeLimitSetting = async function () {
      try {
        const Settings = plugin._getModel('SwitchPlugin_Settings');
        if (!Settings) {
          plugin.verbose(2, '[Switch] SwitchPlugin_Settings model not available — using default (timeLimitEnabled=true).');
          plugin.timeLimitEnabled = true;
          return;
        }
        const row = await Settings.findByPk('timeLimitEnabled');
        plugin.timeLimitEnabled = row ? row.value === 'true' : true;
        plugin.verbose(2, `[Switch] Time limit ${plugin.timeLimitEnabled ? 'enabled' : 'disabled'} (loaded from DB).`);
      } catch (err) {
        plugin.verbose(1, `[Switch] Failed to load time limit setting: ${err.message}. Using default (enabled=true).`);
        plugin.timeLimitEnabled = true;
      }
    };

    /**
     * Persists the timeLimitEnabled toggle to SwitchPlugin_Settings.
     * Updates the in-memory property. Throws on DB failure so the caller can report the error.
     */
    plugin._saveTimeLimitSetting = async function (enabled) {
      const Settings = plugin._getModel('SwitchPlugin_Settings');
      if (!Settings) {
        throw new Error('SwitchPlugin_Settings model not available — DB may not be ready.');
      }
      await plugin._withDb(async (t) => {
        await Settings.upsert(
          { key: 'timeLimitEnabled', value: String(enabled) },
          { transaction: t }
        );
      });
      plugin.timeLimitEnabled = enabled;
      plugin.verbose(1, `[Switch] Time limit ${enabled ? 'enabled' : 'disabled'} via Discord admin command.`);
    };

    /**
     * Loads the explainMessageId from SwitchPlugin_Settings.
     * Parses the JSON value and caches it on the plugin instance.
     *
     * Supports two formats (backward-compatible):
     *   - New: { channelID, messageIDs: [...] }
     *   - Old: { channelID, messageID } — upgraded to array on read
     *
     * Falls back to null if the setting is missing, empty, or the DB is unavailable.
     */
    plugin._loadExplainMessageId = async function () {
      try {
        const Settings = plugin._getModel('SwitchPlugin_Settings');
        if (!Settings) {
          plugin._cachedExplainMessageData = null;
          return;
        }
        const row = await Settings.findByPk('explainMessageId');
        if (row && row.value) {
          try {
            const parsed = JSON.parse(row.value);
            if (parsed && parsed.channelID) {
              // Upgrade old single-message format to array format
              if (parsed.messageID && !parsed.messageIDs) {
                parsed.messageIDs = [parsed.messageID];
                delete parsed.messageID;
              }
              if (parsed.messageIDs && parsed.messageIDs.length > 0) {
                plugin._cachedExplainMessageData = parsed;
                plugin.verbose(2, `[Explain] Loaded stored explain messages: channel=${parsed.channelID}, count=${parsed.messageIDs.length}`);
                return;
              }
            }
          } catch (_) { /* invalid JSON — reset */ }
        }
        plugin._cachedExplainMessageData = null;
      } catch (err) {
        plugin.verbose(1, `[Explain] Failed to load explain message ID: ${err.message}`);
        plugin._cachedExplainMessageData = null;
      }
    };

    /**
     * Persists the explain message metadata to SwitchPlugin_Settings.
     * Stores JSON { channelID, messageIDs: [...] } so all messages can be
     * deleted on the next SquadJS restart, keeping the explain channel clean.
     *
     * @param {string} channelID — Discord channel ID
     * @param {string[]} messageIDs — Array of message IDs to track
     */
    plugin._saveExplainMessageId = async function (channelID, messageIDs) {
      const Settings = plugin._getModel('SwitchPlugin_Settings');
      if (!Settings) {
        throw new Error('SwitchPlugin_Settings model not available — DB may not be ready.');
      }
      const value = JSON.stringify({ channelID, messageIDs });
      await plugin._withDb(async (t) => {
        await Settings.upsert(
          { key: 'explainMessageId', value },
          { transaction: t }
        );
      });
      plugin._cachedExplainMessageData = { channelID, messageIDs };
      plugin.verbose(1, `[Explain] Saved explain messages: channel=${channelID}, count=${messageIDs.length}`);
    };

    /**
     * v2.5.0: Two-tier row retention. Called from onRoundEnded.
     *
     * TIER 1 — empty rows, hardcoded 30 minutes.
     *   A row sitting at EXACTLY maxSwitchTokens with no seed state and no active
     *   lockdown carries no information: an absent row already defaults to max, so
     *   deleting it is lossless. No reason to keep it.
     *
     *   The `= maxSwitchTokens` is load-bearing and must never be relaxed to `>=`.
     *   Token regeneration is lazy (see plugin._regenTokens) — a row BELOW max
     *   holds real state in tokenRegenAnchor, and deleting it hands the player a
     *   fresh row at max. At a 30-minute window that is an exploit: switch,
     *   disconnect, return 31 minutes later with full tokens instead of waiting out
     *   the refill. A row ABOVE max holds an unspent seed bonus. Both belong in
     *   tier 2, whose window comfortably exceeds a full regeneration cycle.
     *
     *   The lockdown guard is also load-bearing at this scale:
     *   scrambleLockdownDurationMinutes is the same order as the window, so without
     *   it a player who disconnects under scramble lockdown could have the lockdown
     *   deleted out from under them before it expires.
     *
     * TIER 2 — everything else, pruneInactivePlayerDays (default 3).
     *   Catch-all. Past the window, regen state is moot (a full refill takes
     *   maxSwitchTokens * regen interval), an unspent bonus is deemed abandoned,
     *   and stale seed state is meaningless. This is the rule that actually bounds
     *   table growth: every player who seeds ends up above max and would otherwise
     *   be immortal under a no-confiscation guard.
     *
     * Neither tier touches connected players — deleting a row that the seed
     * reconciler recreates on the next tick is pure churn.
     *
     * The whole pass is skipped during seed mode. cleanup() runs from onRoundEnded,
     * the same moment the ENDGAME consolation grant fires, and skipping keeps the
     * two from competing for the same rows without an ordering dependency.
     *
     * NULL lastActiveTimestamp means "keep". Migration v5 backfills every row, so
     * NULL should not occur; treating it as keep is the safe reading if it does.
     */
    /**
     * v2.5.6: Write back token regeneration that has already fully completed.
     *
     * Regeneration is lazy — _regenTokens() adjusts a row in memory on every
     * read, and the stored tokenBalance is only rewritten when the player next
     * spends. A player who spent down to 1 and then waited out the refill is
     * therefore displayed as 2/2 while the DATABASE still says 1, forever.
     *
     * That divergence is why cleanup()'s tier-1 prune was dead code. Tier 1
     * deletes rows sitting at exactly maxSwitchTokens with no other state, on
     * the grounds that an absent row already means the same thing — but it
     * tests the STORED balance, which never returns to the cap on its own.
     *
     * Replayed against the 2026-08-20 production export (378 rows, live config
     * maxSwitchTokens=2 / switchCooldownHours=1.75): tier 1 matched 0 rows.
     * 114 of them — the 8 stored at 0 and the 106 stored at 1 — had fully
     * regenerated and were displayed as 2/2 while the table said otherwise.
     * With this pass plus the NEW_GAME seed sweep, the same export prunes
     * 378 → 181 on the first cleanup; the 181 that stay are seed holders
     * genuinely above the cap, which tier 2 retires at the retention horizon.
     *
     * Only rows whose regeneration is COMPLETE are touched, so this changes no
     * player's effective balance — it writes down what _regenTokens() would
     * have computed anyway. A row mid-cycle keeps its anchor and its partial
     * progress. Deleting a row that is genuinely below cap would be an exploit
     * (spend, disconnect, return to a fresh full row); that is precisely why
     * this normalizes first and lets tier 1 test the result, rather than
     * relaxing tier 1's `= maxSwitchTokens` to `>=`.
     *
     * One UPDATE per deficit level rather than one clever statement: the
     * threshold scales with how many tokens are missing, maxSwitchTokens is a
     * single digit, and this keeps the whole thing inside the ORM instead of
     * hand-rolling dialect-specific date arithmetic in raw SQL.
     *
     * Rows below the cap with a NULL anchor are deliberately not matched —
     * `Op.lt` against NULL is UNKNOWN, and such a row cannot prove it ever
     * started regenerating. None exist in the production export; if one ever
     * appears it ages out through tier 2 rather than being silently topped up.
     *
     * @returns {Promise<number>} rows normalized
     */
    plugin.normalizeRegeneratedTokens = async function () {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) return 0;

      const maxTokens = plugin.options.maxSwitchTokens;
      // Mirrors _regenTokens() exactly: minutes override hours, and a
      // non-positive interval means tokens never decay in the first place.
      const intervalMs = plugin.options.switchCooldownMinutes > 0
        ? plugin.options.switchCooldownMinutes * 60 * 1000
        : plugin.options.switchCooldownHours * 60 * 60 * 1000;
      if (intervalMs <= 0) return 0;

      const now = Date.now();
      let normalized = 0;

      try {
        await plugin._withDb(async (t) => {
          for (let deficit = 1; deficit <= maxTokens; deficit++) {
            const [count] = await PlayerCooldowns.update(
              { tokenBalance: maxTokens, tokenRegenAnchor: null },
              {
                where: {
                  tokenBalance: maxTokens - deficit,
                  tokenRegenAnchor: { [Op.lt]: new Date(now - deficit * intervalMs) }
                },
                transaction: t
              }
            );
            normalized += count;
          }
        });

        if (normalized > 0) {
          plugin.verbose(1, `[Cleanup] Normalized ${normalized} fully-regenerated rows back to ${maxTokens} tokens.`);
        }
      } catch (err) {
        // Non-fatal: without this the prune simply keeps more rows than it needs to.
        plugin.verbose(1, `[Cleanup] Token normalization failed: ${err.message}`);
      }

      return normalized;
    };

    plugin.cleanup = async function () {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) return;

      // Don't compete with the ENDGAME consolation grant for the same rows.
      if (plugin._s3?.gameState?.isSeedMode?.()) {
        plugin.verbose(2, '[Cleanup] Skipped — seed mode active.');
        return;
      }

      // Before the prune, and deliberately ahead of the retention guard: this
      // reconciles the stored balance with the displayed one, which is worth
      // doing even for an operator who has pruning switched off entirely.
      await plugin.normalizeRegeneratedTokens();

      const retentionDays = plugin.options.pruneInactivePlayerDays ?? 0;
      if (retentionDays <= 0) {
        plugin.verbose(2, '[Cleanup] Skipped — pruneInactivePlayerDays is 0 (pruning disabled).');
        return;
      }

      const maxTokens = plugin.options.maxSwitchTokens;
      const now = new Date();
      const emptyRowCutoff = new Date(now.getTime() - (30 * 60 * 1000));
      const staleCutoff = new Date(now.getTime() - (retentionDays * 24 * 60 * 60 * 1000));

      // Connected players are never pruned.
      const rosterReady = plugin._s3?.players?.isReady?.() === true;
      const allPlayers = rosterReady
        ? plugin._s3.players.getAllPlayers()
        : plugin.server.players;
      const connectedEosIDs = (allPlayers || [])
        .map(p => p?.eosID)
        .filter(Boolean);

      // An empty roster is only trustworthy if we could actually read one. S³
      // reporting zero players is a genuinely empty server and pruning is exactly
      // right; S³ not being ready means we cannot tell who is online, and the
      // exclusion below would silently become a no-op — deleting rows out from
      // under connected players. Skip rather than guess.
      if (connectedEosIDs.length === 0 && !rosterReady) {
        plugin.verbose(2, '[Cleanup] Skipped — player roster unavailable, cannot exclude connected players.');
        return;
      }

      try {
        await plugin._withDb(async (t) => {
          const where = {
            [Op.and]: [
              {
                [Op.or]: [
                  { scrambleLockdownExpiry: null },
                  { scrambleLockdownExpiry: { [Op.lt]: now } }
                ]
              },
              // NULL is spelled out rather than left to three-valued logic —
              // `lastActiveTimestamp < cutoff` is UNKNOWN against NULL and would
              // silently exclude the row anyway, but stating it keeps the intent
              // readable and dialect-independent.
              { lastActiveTimestamp: { [Op.ne]: null } },
              {
                [Op.or]: [
                  {
                    // Tier 1: the row carries nothing
                    tokenBalance: maxTokens,
                    seedPresenceStart: null,
                    seedBonusTokensEarned: 0,
                    lastActiveTimestamp: { [Op.lt]: emptyRowCutoff }
                  },
                  {
                    // Tier 2: abandoned, whatever it holds
                    lastActiveTimestamp: { [Op.lt]: staleCutoff }
                  }
                ]
              }
            ]
          };

          if (connectedEosIDs.length > 0) {
            where[Op.and].push({ eosID: { [Op.notIn]: connectedEosIDs } });
          }

          const deleted = await PlayerCooldowns.destroy({ where, transaction: t });
          if (deleted > 0) {
            // Logged at verbose(1) deliberately: the first pass after the v5
            // backfill prunes the entire long tail at once and looks alarming
            // without a number attached to it.
            plugin.verbose(1, `[Cleanup] Pruned ${deleted} cooldown rows (empty >30m, or unseen >${retentionDays}d).`);
          }
        });
      } catch (err) {
        plugin.verbose(1, `Cleanup error: ${err.message}`);
      }
    };

    /**
     * Looks up a player's cooldown/lock record by eosID or name substring.
     *
     * The name match must be case-insensitive — admins type `!switch check bob`
     * for a player called `BobTheBuilder`. Op.like already delivers that on
     * SQLite (case-insensitive for ASCII) and MySQL (case-insensitive default
     * collation), but NOT on Postgres, where LIKE is case-sensitive and the
     * lookup would silently stop matching. caseInsensitiveLikeOp() swaps in
     * Op.iLike there and leaves SQLite/MySQL emitting exactly the SQL they
     * always have. Op.iLike cannot simply be used unconditionally — it is a
     * syntax error on both other engines.
     *
     * @param {string} ident — eosID or partial player name
     * @returns {object|null|string} record, null if not found, 'multiple' if ambiguous
     */
    plugin.checkPlayer = async function (ident) {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) return null;
      let record = await PlayerCooldowns.findByPk(ident);
      if (record) return record;

      const likeOp = plugin._s3db?.caseInsensitiveLikeOp?.() || Op.like;
      const records = await PlayerCooldowns.findAll({
        where: {
          playerName: { [likeOp]: `%${ident}%` }
        }
      });

      if (records.length === 0) return null;
      if (records.length > 1) return 'multiple';
      return records[0];
    };

    /**
     * v2.5.6: The single source of truth for "who is actually restricted right
     * now". Every displayed number derives from this one pass.
     *
     * The bug it replaces: the diagnostics embed counted players below cap with
     * lazy regeneration applied, but selected its "Restricted Players (top 5)"
     * list on the RAW stored balance. On the 2026-08-20 production export that
     * printed five players as restricted, each rendered "2/2 tokens (full)",
     * directly under a line reading "Players Below Cap: 0". Both numbers came
     * from the same table, moments apart, and disagreed because one applied
     * regen and the other did not. getDiagnosticInfo() had the same defect and
     * would have reported 114 active locks against a true count of 0.
     *
     * Loading the table is deliberate. Regeneration is a function of elapsed
     * time against a per-row anchor, and expressing it in SQL means dialect-
     * specific date arithmetic in exactly the place this codebase has been
     * bitten before. The table is bounded by cleanup()'s retention window —
     * 378 rows in production, a few hundred at steady state — so one indexed
     * scan per !switch status is the cheaper mistake.
     *
     * "Blocked" means CANNOT SWITCH: no tokens, or an unexpired scramble lock.
     * Below-cap is not blocked — with maxSwitchTokens at 2, a player holding 1
     * is below cap and perfectly able to switch, which is why the old
     * "Players Below Cap" line implied a restriction that did not exist.
     *
     * @returns {Promise<object|null>} null when the model is unavailable
     */
    plugin.getLiveRestrictionState = async function () {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) return null;

      const maxTokens = plugin.options.maxSwitchTokens;
      const ceiling = maxTokens + (plugin.options.seedTokenBonusAmount ?? 0);
      const now = new Date();

      const rows = await PlayerCooldowns.findAll({
        attributes: [
          'eosID', 'steamID', 'playerName', 'tokenBalance', 'tokenRegenAnchor',
          'scrambleLockdownExpiry', 'seedPresenceStart', 'lastActiveTimestamp'
        ]
      });

      // Seed accrual is only real for someone who is on the server — the clock
      // is compared against NOW, so an offline row's "accruing" is fiction.
      const rosterReady = plugin._s3?.players?.isReady?.() === true;
      const allPlayers = rosterReady ? plugin._s3.players.getAllPlayers() : plugin.server?.players;
      const connected = new Set((allPlayers || []).map(p => p?.eosID).filter(Boolean));

      const blocked = [];
      let outOfTokens = 0;
      let scrambleLocked = 0;
      let belowCap = 0;
      let seedAccruing = 0;

      for (const r of rows) {
        // _regenTokens() only reads/writes these two fields, so a plain object
        // is safe and keeps the Sequelize instance unmodified.
        const live = { tokenBalance: r.tokenBalance, tokenRegenAnchor: r.tokenRegenAnchor };
        plugin._regenTokens(live);

        const lockExpiry = r.scrambleLockdownExpiry ? new Date(r.scrambleLockdownExpiry) : null;
        const lockActive = lockExpiry != null && lockExpiry.getTime() > now.getTime();
        const noTokens = live.tokenBalance < 1;

        if (lockActive) scrambleLocked++;
        if (noTokens) outOfTokens++;
        if (live.tokenBalance < maxTokens) belowCap++;
        if (r.seedPresenceStart && connected.has(r.eosID) && live.tokenBalance < ceiling) seedAccruing++;

        if (lockActive || noTokens) {
          blocked.push({
            eosID: r.eosID,
            steamID: r.steamID,
            playerName: r.playerName,
            tokenBalance: live.tokenBalance,
            tokenRegenAnchor: live.tokenRegenAnchor,
            lockExpiry: lockActive ? lockExpiry : null,
            online: connected.has(r.eosID)
          });
        }
      }

      // Worst first: an active lock outranks an empty wallet, since it cannot be
      // waited out by regeneration alone. Then fewest tokens.
      blocked.sort((a, b) => {
        const al = a.lockExpiry ? a.lockExpiry.getTime() : -Infinity;
        const bl = b.lockExpiry ? b.lockExpiry.getTime() : -Infinity;
        if (al !== bl) return bl - al;
        return a.tokenBalance - b.tokenBalance;
      });

      return {
        total: rows.length,
        maxTokens,
        blocked,
        outOfTokens,
        scrambleLocked,
        belowCap,
        seedAccruing,
        rosterReady
      };
    };

    // ── Admin mutations ────────────────────────────────────────
    //
    // v2.5.6: `clear`/`clearall` mean "lift restrictions", NOT "reset the row".
    // The two were conflated, and the conflation confiscated earned seed tokens:
    // both paths wrote `tokenBalance: maxSwitchTokens` unconditionally, so a
    // player sitting at maxSwitchTokens + seedTokenBonusAmount was silently
    // knocked back down to the ordinary cap by an admin trying to help them.
    //
    // Top-up is therefore `Math.max(current, maxTokens)` everywhere — "bring them
    // to at least full", never "set them to full". In-progress seed accrual
    // (seedPresenceStart / seedBonusTokensEarned / lastSeedBonusRoundID) is left
    // alone for the same reason: unsticking someone mid-seed-round should not
    // cost them the round's progress.
    //
    // The genuine reset lives in adminWipeAll() and is spelled as a DELETE,
    // because an ABSENT row already means "max tokens, no restrictions" — see
    // _checkSwitchEligibility, which defaults a missing row to maxSwitchTokens.
    // That is also why none of these use `truncate: true`: TRUNCATE is DDL, the
    // live MySQL user has no DDL grants, and the failure surfaced as an admin
    // command that replied nothing at all. Every helper here is plain DML.

    /**
     * Transaction wrapper for the admin mutations — the same thing _withDb()
     * does, except that it PROPAGATES.
     *
     * plugin._withDb() catches, calls reportError(), and returns null. That is
     * right for background housekeeping and wrong here: it is the mechanism by
     * which the broken `clearall` reported nothing at all on live MySQL. The
     * TRUNCATE was rejected for want of the DROP privilege, _withDb swallowed
     * it, the caller saw a resolved promise, and the admin saw silence. Admin
     * commands must be able to tell the admin they failed, so these three
     * throw and the command layer reports it.
     *
     * @param {Function} fn — receives the transaction handle. S³ runs no CLS,
     *   so every statement inside MUST be passed `{ transaction: t }` or it
     *   executes outside the transaction.
     */
    const adminTx = async (fn) => {
      if (!plugin._s3db || typeof plugin._s3db.isReady !== 'function' || !plugin._s3db.isReady()) {
        throw new Error('Database is not ready.');
      }
      return plugin._s3db.withTransactionWithRetry(fn);
    };

    /**
     * Lifts switch restrictions for one player without touching seed state.
     *
     * @param {string} eosID
     * @returns {Promise<object|null>} { tokensBefore, tokensAfter, lockCleared }, or null when no row exists
     */
    plugin.adminClearPlayer = async function (eosID) {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) throw new Error('SwitchPlugin_PlayerCooldowns model not available — DB may not be ready.');

      const maxTokens = plugin.options.maxSwitchTokens;
      let summary = null;

      await adminTx(async (t) => {
        // Re-read inside the transaction: the caller resolved this row through
        // checkPlayer() and the balance may have moved since. Admin commands are
        // rare enough that the extra read costs nothing.
        const row = await PlayerCooldowns.findByPk(eosID, { transaction: t });
        if (!row) return; // absent row is already unrestricted — nothing to do

        const before = row.tokenBalance != null ? row.tokenBalance : maxTokens;
        const after = Math.max(before, maxTokens);
        const lockCleared = row.scrambleLockdownExpiry != null;

        await PlayerCooldowns.update(
          {
            tokenBalance: after,
            // null, not now(): no regen cycle is running at or above the cap, and
            // _regenTokens() re-anchors in memory the moment it reads the row.
            tokenRegenAnchor: null,
            scrambleLockdownExpiry: null,
            lastActiveTimestamp: new Date()
          },
          { where: { eosID }, transaction: t }
        );

        summary = { tokensBefore: before, tokensAfter: after, lockCleared };
      });

      // Without this a stale joinTime keeps gating !switch even with a full
      // balance — same reason _clearReconnectLockouts and _resetPlayerLockouts
      // both call it.
      try {
        await plugin._s3?.players?.resetJoinTime?.(eosID);
      } catch (err) {
        plugin.verbose(1, `[Admin] resetJoinTime failed for ${eosID}: ${err.message}`);
      }

      return summary;
    };

    /**
     * Lifts switch restrictions for every tracked player, server-wide.
     *
     * Deliberately two statements rather than one. A single UPDATE setting
     * tokenBalance = maxTokens would lower every seed-bonus holder to the
     * ordinary cap — the exact bug this release fixes. Splitting on the cap
     * lets rows above it keep their surplus while still losing their lock.
     *
     * SQL GREATEST() would express it in one statement, but SQLite spells that
     * MAX(a, b) while MySQL and Postgres spell it GREATEST(a, b), so a single
     * statement would need raw dialect-specific SQL. Two ORM updates are worth
     * more than one clever one here.
     *
     * @returns {Promise<{toppedUp: number, locksCleared: number}>}
     */
    plugin.adminClearAllRestrictions = async function () {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) throw new Error('SwitchPlugin_PlayerCooldowns model not available — DB may not be ready.');

      const maxTokens = plugin.options.maxSwitchTokens;
      let toppedUp = 0;
      let locksCleared = 0;

      await adminTx(async (t) => {
        // Below the cap: top up to the cap and drop any lock.
        //
        // The NULL arm is spelled out deliberately. `tokenBalance < 2` is
        // UNKNOWN against NULL on all three engines, so a NULL-balance row
        // would match neither this statement nor the >= one below and would
        // keep its scramble lock through a `clearall` — the admin sees a
        // success line and the player stays locked. The model declares the
        // column NOT NULL DEFAULT 2, so this should be unreachable, but the
        // live MySQL schema is applied by hand (that user has no DDL grants),
        // and the rest of the plugin already reads the column defensively as
        // `row.tokenBalance != null ? row.tokenBalance : maxTokens`. Costs one
        // OR; removes a silent-failure mode.
        const [belowCount] = await PlayerCooldowns.update(
          {
            tokenBalance: maxTokens,
            tokenRegenAnchor: null,
            scrambleLockdownExpiry: null
          },
          {
            where: {
              [Op.or]: [
                { tokenBalance: { [Op.lt]: maxTokens } },
                { tokenBalance: { [Op.is]: null } }
              ]
            },
            transaction: t
          }
        );
        toppedUp = belowCount;

        // At or above the cap: drop the lock only, leaving any seed surplus intact.
        const [lockCount] = await PlayerCooldowns.update(
          { scrambleLockdownExpiry: null },
          {
            where: {
              tokenBalance: { [Op.gte]: maxTokens },
              scrambleLockdownExpiry: { [Op.ne]: null }
            },
            transaction: t
          }
        );
        locksCleared = lockCount;
      });

      plugin.verbose(1, `[Admin] Cleared restrictions: ${toppedUp} players topped up to ${maxTokens}, ${locksCleared} scramble locks lifted.`);
      return { toppedUp, locksCleared };
    };

    /**
     * Deletes every cooldown row. The true reset — an absent row reads as
     * "max tokens, no restrictions, no seed state" everywhere in the plugin.
     *
     * Plain DELETE, never TRUNCATE: TRUNCATE is DDL, so it requires the DROP
     * privilege the live MySQL user does not have, and it implicitly commits,
     * which silently breaks the surrounding _withDb transaction. On SQLite
     * Sequelize already emitted DELETE for both spellings, so dropping
     * `truncate: true` is a no-op there and a repair on MySQL.
     *
     * @returns {Promise<number>} rows deleted
     */
    plugin.adminWipeAll = async function () {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) throw new Error('SwitchPlugin_PlayerCooldowns model not available — DB may not be ready.');

      let deleted = 0;
      await adminTx(async (t) => {
        deleted = await PlayerCooldowns.destroy({ where: {}, transaction: t });
      });

      plugin.verbose(1, `[Admin] Wiped ${deleted} cooldown rows.`);
      return deleted;
    };

    // ── Load persisted settings ────────────────────────────────

    await plugin._loadTimeLimitSetting();
    await plugin._loadExplainMessageId();
  }
};

export default SwitchDB;