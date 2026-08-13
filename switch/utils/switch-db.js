/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              SWITCH PLUGIN v2.3.2 — DATABASE LAYER             ║
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
 * - cleanup() purges rows with expired cooldowns AND no active
 *   scramble lockdown AND stale firstSeenTimestamp (>24h old).
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
      }
    }, { timestamps: false });

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
    }, { timestamps: false });

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
    }, { timestamps: false, freezeTableName: true });

    // ── Migration Registration ─────────────────────────────────

    plugin.registerExpectedVersion('switch', 4, {
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
      }
    ]);

    // Run any pending migrations
    const result = await plugin.verifyAndRunMigrations('switch');
    if (result) {
      plugin.verbose(1, `[S3] Switch v1 migration: applied=${result.applied}, skipped=${result.skipped}.`);
    } else {
      plugin.verbose(3, '[S3] Switch schema already up to date.');
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
     * Parses the JSON value { channelID, messageID } and caches it on the plugin instance.
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
            if (parsed && parsed.channelID && parsed.messageID) {
              plugin._cachedExplainMessageData = parsed;
              plugin.verbose(2, `[Explain] Loaded stored explain message: channel=${parsed.channelID}, message=${parsed.messageID}`);
              return;
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
     * Stores JSON { channelID, messageID } so the message can be edited in place
     * across SquadJS restarts.
     */
    plugin._saveExplainMessageId = async function (channelID, messageID) {
      const Settings = plugin._getModel('SwitchPlugin_Settings');
      if (!Settings) {
        throw new Error('SwitchPlugin_Settings model not available — DB may not be ready.');
      }
      const value = JSON.stringify({ channelID, messageID });
      await plugin._withDb(async (t) => {
        await Settings.upsert(
          { key: 'explainMessageId', value },
          { transaction: t }
        );
      });
      plugin._cachedExplainMessageData = { channelID, messageID };
      plugin.verbose(1, `[Explain] Saved explain message: channel=${channelID}, message=${messageID}`);
    };

    /**
     * Purges expired cooldown rows from the database.
     * Removes rows where: no active scramble lockdown, player has full tokens
     * (tokenBalance >= maxSwitchTokens), and firstSeenTimestamp is older than
     * 24 hours (stale records).
     */
    plugin.cleanup = async function () {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) return;

      const maxTokens = plugin.options.maxSwitchTokens;
      const now = new Date();

      try {
        await plugin._withDb(async (t) => {
          await PlayerCooldowns.destroy({
            where: {
              [Op.and]: [
                {
                  [Op.or]: [
                    { scrambleLockdownExpiry: null },
                    { scrambleLockdownExpiry: { [Op.lt]: now } }
                  ]
                },
                {
                  // Player has full (or more) tokens — no active cooldown
                  tokenBalance: { [Op.gte]: maxTokens }
                },
                {
                  [Op.or]: [
                    { firstSeenTimestamp: null },
                    { firstSeenTimestamp: { [Op.lt]: new Date(now.getTime() - (24 * 60 * 60 * 1000)) } }
                  ]
                }
              ]
            },
            transaction: t
          });
        });
      } catch (err) {
        plugin.verbose(1, `Cleanup error: ${err.message}`);
      }
    };

    /**
     * Looks up a player's cooldown/lock record by eosID or name substring.
     * @param {string} ident — eosID or partial player name
     * @returns {object|null|string} record, null if not found, 'multiple' if ambiguous
     */
    plugin.checkPlayer = async function (ident) {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) return null;
      let record = await PlayerCooldowns.findByPk(ident);
      if (record) return record;

      const records = await PlayerCooldowns.findAll({
        where: {
          playerName: { [Op.like]: `%${ident}%` }
        }
      });

      if (records.length === 0) return null;
      if (records.length > 1) return 'multiple';
      return records[0];
    };

    // ── Load persisted settings ────────────────────────────────

    await plugin._loadTimeLimitSetting();
    await plugin._loadExplainMessageId();
  }
};

export default SwitchDB;