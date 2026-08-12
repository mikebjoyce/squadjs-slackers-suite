/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              SWITCH PLUGIN v2.3.0 — DATABASE LAYER             ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * S³ database surface for the Switch plugin: model definitions,
 * migration registration, settings persistence, cooldown cleanup,
 * and player lookup. Extracted from switch.js during the refactor
 * to keep the main plugin focused on orchestration.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SwitchDB (default)
 *   Singleton with a single async register(plugin) method.
 *   Must be called during _onS3Ready() after S³ DB is confirmed ready.
 *   Adds to plugin: timeLimitEnabled, _loadTimeLimitSetting,
 *   _saveTimeLimitSetting, cleanup, checkPlayer.
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

    plugin.registerExpectedVersion('switch', 3, {
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
        description: 'Create SwitchPlugin_Settings table',
        touches: {
          creates: ['SwitchPlugin_Settings']
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
  }
};

export default SwitchDB;