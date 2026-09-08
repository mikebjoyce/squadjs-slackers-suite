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
 * ─── SCOPING (v2.6.0) ────────────────────────────────────────────
 *
 * Five models, and they do not all answer the same question about
 * "which server". Each declares its answer at defineModel() via
 * scopeKind, which is what S³'s export and import paths read;
 * nothing here decides scope by convention.
 *
 *   SwitchPlugin_PlayerCooldowns   global        one row per player
 *   SwitchPlugin_PlayerServerState server-column one row per player
 *                                                per server
 *   SwitchPlugin_Endmatches        server-column
 *   SwitchPlugin_Settings          server-column (table:
 *                                  SwitchPlugin_ServerSettings)
 *   SwitchPlugin_RoundStats        server-column
 *
 * The split between the first two is the load-bearing decision.
 * A token balance is a fact about a player; a scramble lock and a
 * seed clock are facts about a player ON a server. Four columns
 * moved out of PlayerCooldowns for that reason and the table went
 * community-wide behind them, so one player carries one balance
 * across the community and a scramble on one server locks nobody
 * on the other. See the comments at each declaration — the four
 * columns are gone from the model and deliberately left in the
 * table, because DROP COLUMN needs a grant the live MySQL user
 * lacks and is the one migration step a rollback cannot undo.
 *
 * PlayerServerState and Endmatches carry composite primary keys
 * leading with serverID, which makes findByPk() unavailable on
 * them by construction. Every read is findOne({ where: { serverID,
 * eosID } }). That is the point rather than a wart: a call site
 * that forgets its server scope does not compile into a working
 * query.
 *
 * Settings keeps model name SwitchPlugin_Settings over table
 * SwitchPlugin_ServerSettings. Model names are what the export
 * registry and the version fixtures key on, so renaming the model
 * would have been the larger change, and the table name is what an
 * operator reads in a schema dump: ServerSettings says at a glance
 * that a row belongs to one server, which Settings did not.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SwitchDB (default)
 *   Singleton with a single async register(plugin) method.
 *   Must be called during _onS3Ready() after S³ DB is confirmed ready.
 *   Adds to plugin: timeLimitEnabled, _loadTimeLimitSetting,
 *   _saveTimeLimitSetting, _loadExplainMessageId,
 *   _saveExplainMessageId, normalizeRegeneratedTokens, cleanup,
 *   _pruneServerState, checkPlayer, getLiveRestrictionState,
 *   adminClearPlayer, adminClearAllRestrictions, adminWipeAll,
 *   recordRoundStats, getRoundStatsTotals, backfillRoundStats,
 *   getEarliestLiveRoundStat.
 *   Also calls defineModel(), registerExpectedVersion(),
 *   registerMigrations() and verifyAndRunMigrations() on the plugin,
 *   plus _s3db.ensureIndexes() once the migrations commit.
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
 * - cleanup() prunes the community-wide table and _pruneServerState()
 *   prunes this server's half. They cannot be one pass: a player can
 *   stay active on server A forever while never returning to server
 *   B, and nothing in the community row's lifecycle expresses that,
 *   so the B-side row would be immortal under a single retention
 *   rule. Each half carries its own lastActiveTimestamp for exactly
 *   this reason, and the two columns mean different things.
 * - Indexes go in through ensureIndexes() as bare CREATE INDEX after
 *   the migration commits, not inside createTable(). Sequelize
 *   renders an index declared in a create as a follow-up ALTER TABLE
 *   on MySQL, which is the one statement a create-only grant cannot
 *   run. Every index name is prefixed with its table: Postgres
 *   scopes index names to the schema rather than the table, so nine
 *   indexes all named idx_serverID would be one name nine times.
 * - Migrations here run once for the community, not once per server.
 *   Whichever process gets there first applies them under S³'s
 *   migration lock and the others wait; nothing in this file may
 *   assume it is the process that migrated.
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
      // OBSOLETE since migration v3, retained for expand-contract safety —
      // never dropped, and no write site has populated it since. Every row
      // created from v3 onward carries null here permanently. tokenBalance
      // and tokenRegenAnchor are the live cooldown state; anything reading
      // this column to decide whether a player is on cooldown is reading a
      // rule the plugin does not enforce (see switch.js:1292-1304).
      lastSwitchTimestamp: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: true
      },
      firstSeenTimestamp: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: true
      },
      // v2.6.0: Token bucket fields
      tokenBalance: {
        type: plugin._s3db.getDataTypes().INTEGER,
        allowNull: false,
        defaultValue: 2
      },
      tokenRegenAnchor: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: true
      },
      // v2.6.0: four columns used to live here and now live on
      // SwitchPlugin_PlayerServerState — scrambleLockdownExpiry above, and
      // seedPresenceStart, lastSeedBonusRoundID and seedBonusTokensEarned
      // here. A scramble happens on a server; a seed round is a server’s
      // round and its matchId names that server’s round; the per-round bonus
      // counter counts against it. None of the four can hold one answer for a
      // community, which is what kept this table from going community-wide.
      //
      // They are gone from the MODEL, not from the TABLE, and the difference
      // is deliberate. Dropping them needs the ALTER grant the live MySQL user
      // does not have, and a DROP COLUMN is the one migration step a rollback
      // cannot undo. Left in place they cost four unread columns; removed from
      // the model they cost nothing and buy noise: a call site this split
      // missed now throws on the where, the attributes list or the update
      // rather than reading a value frozen at whatever the last single-server
      // process wrote. Sequelize ignores table columns a model does not
      // declare, and all four are writable-optional — three nullable and one
      // NOT NULL DEFAULT 0 — so leaving every one of them unwritten forever
      // breaks no constraint on any engine.
      //
      // Migrations v1 and v3, which created them, are untouched. A migration
      // body describes what a database went through, not what the code wants
      // now, and rewriting one that has already run on production is the worse
      // trade — the same rule the TeamBalancerState default was left under.
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
    }, {
      timestamps: false,
      exportTier: 'ephemeral',
      // Community-wide, and deliberately so: a player who spends tokens on one
      // server and finds a fresh bucket on another reads as a bug to an admin
      // looking at one Discord. The four irreducibly per-server columns moved to
      // SwitchPlugin_PlayerServerState rather than dragging this one per-server
      // with them — see the note where they used to be declared.
      scopeKind: 'global'
    });

    // The per-server half of the split. One row per player per server, and
    // the whole reason SwitchPlugin_PlayerCooldowns could become
    // community-wide: a token balance is a fact about a player, a scramble
    // lock and a seed clock are facts about a player ON a server.
    //
    // Composite primary key, which makes findByPk() unavailable on this model
    // — every read is findOne({ where: { serverID, eosID } }). That is not a
    // wart to work around: it is the reason a site that forgets its server
    // scope does not compile into a working query.
    plugin.defineModel('SwitchPlugin_PlayerServerState', {
      serverID: {
        type: plugin._s3db.getDataTypes().INTEGER,
        primaryKey: true,
        allowNull: false
      },
      eosID: {
        type: plugin._s3db.getDataTypes().STRING,
        primaryKey: true,
        allowNull: false
      },
      scrambleLockdownExpiry: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: true
      },
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
      // "Last seen on THIS server", which is a different fact from the
      // community-wide column of the same name on PlayerCooldowns, and the
      // reason this table can be pruned at all. A player can stay active on
      // server A forever while never returning to server B; nothing in the
      // global row’s lifecycle can express that, so the B-side row would
      // otherwise be immortal.
      //
      // Nullable, and NOT declared as a notNull post-condition in the
      // migration that creates it. The community-wide column of the same name
      // carries exactly that declaration and its comment records the cost: a
      // predicate re-checked on every mount turns any future row-creating path
      // that forgets the column into a rollback-and-re-gate loop. Prove every
      // creating path stamps it first; the predicate can follow later.
      lastActiveTimestamp: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: true
      }
    }, {
      timestamps: false,
      // Every column is either a countdown that expires on its own or a clock
      // that the next round restarts. A lost row reads as "no lock, no seed
      // progress" — the same thing an absent PlayerCooldowns row reads as.
      exportTier: 'ephemeral',
      // Composite key, so 'server-column' rather than 'server-key': what
      // decides the kind is how a query narrows to one server, and a predicate
      // on serverID is a predicate either way.
      scopeKind: 'server-column'
    });

    plugin.defineModel('SwitchPlugin_Endmatches', {
      id: {
        type: plugin._s3db.getDataTypes().INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      // Nullable through this phase. NOT NULL would reject the pre-upgrade
      // rows the backfill leaves unattributed on purpose, and it would make
      // an un-upgraded process’s INSERT fail outright.
      serverID: {
        type: plugin._s3db.getDataTypes().INTEGER,
        allowNull: true
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
    }, {
      timestamps: false,
      exportTier: 'ephemeral',
      // A request to switch teams at the end of one server's current round.
      scopeKind: 'server-column'
    });

    // Settings key-value table for runtime toggles
    plugin.defineModel('SwitchPlugin_Settings', {
      // Half of the primary key. The pre-rename table keyed on `key` alone,
      // so two servers sharing a database had one timeLimitEnabled between
      // them and one explainMessageId pointing at a message about whichever
      // server wrote last — a toggle flipped on one server flipped on both.
      serverID: {
        type: plugin._s3db.getDataTypes().INTEGER,
        primaryKey: true,
        allowNull: false
      },
      // The column is called `key`, which is reserved in MySQL, and it stays
      // called `key`. Every access here goes through Sequelize, which quotes
      // identifiers unconditionally, so the name is safe as long as nothing
      // writes raw SQL against it — and the migration below, which does, is
      // careful to quote it. Renaming was considered and rejected: the column
      // already exists and a rename turns a one-statement copy into a
      // column-mapping migration for no behavioural gain.
      //
      // S3_Locks.lockKey is decided the other way and that is not an
      // inconsistency. That table is new and raw SQL against it is the normal
      // access path, so there the hazard is structural rather than incidental.
      // Do not reconcile the two; one of them will break.
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
    }, {
      // The MODEL name stays SwitchPlugin_Settings; only the table moves.
      // Keeping it stable is what lets a backup taken before this rename
      // restore into the new table, because the export envelope is keyed by
      // model name and the import loop resolves that name to whatever table
      // the model currently declares.
      tableName: 'SwitchPlugin_ServerSettings',
      timestamps: false,
      freezeTableName: true,
      exportTier: 'historical',
      // Runtime toggles are set per server — one server can have the time limit
      // on while another has it off, and the explain message id points at a
      // message about one server's rules.
      scopeKind: 'server-column'
    });

    // One row per completed round — the aggregate the round-summary embed
    // prints, kept as numbers instead of re-read out of Discord prose later.
    // Deliberately NOT per-player: both consumers (!switch stats and the 7-day
    // explain embed) only ever sum across rounds, so a per-player table would
    // be two orders of magnitude larger for nothing either of them asks.
    //
    // exportTier 'historical': it cannot be rebuilt from live play the way a
    // cooldown can. Once a round is over its numbers exist nowhere else.
    plugin.defineModel('SwitchPlugin_RoundStats', {
      id: {
        type: plugin._s3db.getDataTypes().INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      // Both nullable: a round can end while S³'s gameState is mid-resolve,
      // and losing the layer label is not a reason to lose the counts.
      matchId: {
        type: plugin._s3db.getDataTypes().STRING,
        allowNull: true
      },
      // Present from the CREATE rather than added later — see the v6
      // migration below for why this table alone gets that.
      serverID: {
        type: plugin._s3db.getDataTypes().INTEGER,
        allowNull: true
      },
      layerName: {
        type: plugin._s3db.getDataTypes().STRING,
        allowNull: true
      },
      gameMode: {
        type: plugin._s3db.getDataTypes().STRING,
        allowNull: true
      },
      // The range clock for every query against this table.
      roundEndedAt: {
        type: plugin._s3db.getDataTypes().DATE,
        allowNull: false
      },
      // Liberal rounds are excluded from every aggregate — switching is
      // unrestricted then, so their numbers describe a different system.
      // Stored rather than filtered at write time so the count of what was
      // excluded stays reportable.
      liberalMode: {
        type: plugin._s3db.getDataTypes().BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      // True only for backfilled rounds whose embed predated the current
      // format, so the data-quality line can say how many rows are partial.
      incomplete: {
        type: plugin._s3db.getDataTypes().BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      // 'live' (written at round end) or 'scraped' (recovered from a Discord
      // embed by !switch backfill). Scraped rows are lower fidelity — the
      // embed rounds durations to whole seconds and never carried the raw
      // per-entry array — so the two must stay tellable apart rather than
      // silently averaging together.
      source: {
        type: plugin._s3db.getDataTypes().STRING,
        allowNull: false,
        defaultValue: 'live'
      },
      success: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      failed: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      denied: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      toT1: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      toT2: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      maxQueueSize: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      instant: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      queueNormal: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      queueTeamTrade: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      queueJoinSwap: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      queueTimeoutSwitch: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      denialCooldown: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      denialTimeWindow: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      denialScrambleLock: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      denialRecentSwitch: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      denialOther: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      outcomeExpired: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      outcomeDC: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      outcomeCancelled: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      outcomeRemoved: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 },
      // Null means the round had no queue entries at all, which is not the
      // same as a mean of zero. A scraped old-format round can have a mean
      // and a null median; that pairing is what the "missing median" count
      // in the stats embed reports.
      meanQueueMs: {
        type: plugin._s3db.getDataTypes().INTEGER,
        allowNull: true
      },
      medianQueueMs: {
        type: plugin._s3db.getDataTypes().INTEGER,
        allowNull: true
      }
    }, {
      timestamps: false,
      exportTier: 'historical',
      // One row per completed round, and rounds happen on a server.
      scopeKind: 'server-column'
    });

    // ── Migration Registration ─────────────────────────────────

    // Indexed on eosID alone, which the composite primary key cannot serve:
    // the key leads with serverID, and the cross-server questions this split
    // creates — "does any server still hold a lock for this player" in
    // cleanup(), "what does this player look like everywhere" in the admin
    // commands — all arrive with an eosID and no server.
    const playerServerStateIndexes = [
      { name: 'SwitchPlugin_PlayerServerState_eosID', fields: ['eosID'] }
    ];

    // Named for their tables rather than idx_serverID: Postgres scopes index
    // names to the schema, not the table, so every Class A table wanting an
    // idx_serverID would be one name nine times.
    const serverIdIndexes = {
      SwitchPlugin_Endmatches: [{ name: 'SwitchPlugin_Endmatches_serverID', fields: ['serverID'] }],
      SwitchPlugin_RoundStats: [{ name: 'SwitchPlugin_RoundStats_serverID', fields: ['serverID'] }]
    };

    plugin.registerExpectedVersion('switch', 9, {
      models: ['SwitchPlugin_PlayerCooldowns', 'SwitchPlugin_PlayerServerState', 'SwitchPlugin_Endmatches', 'SwitchPlugin_Settings', 'SwitchPlugin_RoundStats']
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
          if (!(await qi.tableExists('SwitchPlugin_PlayerCooldowns'))) {
            await qi.createTable('SwitchPlugin_PlayerCooldowns', {
              eosID: { type: qi.DataTypes.STRING, primaryKey: true, allowNull: false },
              steamID: { type: qi.DataTypes.STRING, allowNull: true },
              playerName: { type: qi.DataTypes.STRING, allowNull: true },
              lastSwitchTimestamp: { type: qi.DataTypes.DATE, allowNull: true },
              firstSeenTimestamp: { type: qi.DataTypes.DATE, allowNull: true },
              scrambleLockdownExpiry: { type: qi.DataTypes.DATE, allowNull: true }
            });
          }
          if (!(await qi.tableExists('SwitchPlugin_Endmatches'))) {
            await qi.createTable('SwitchPlugin_Endmatches', {
              id: { type: qi.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
              // Baseline carries every column the current code expects, so a
              // fresh install gets serverID from the CREATE and needs no
              // ALTER. v8 guards on describeTable, so it no-ops here.
              serverID: { type: qi.DataTypes.INTEGER, allowNull: true },
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
          if (!(await qi.tableExists('SwitchPlugin_Settings'))) {
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
          },
          // The last three are the v2.6.0 split's leftovers: gone from the
          // model, still in the table, because dropping them needs an ALTER
          // grant the live MySQL user does not have (see the model comment
          // above). `rawAttributes` therefore cannot supply their type, and
          // without it `!s3 migrate ddl` can only tell an operator on a
          // restricted grant that three columns are missing from the script
          // and must be written by hand — on the one deployment that needs
          // the script most. Declared here so the generated DDL is complete.
          //
          // These mirror the addColumn() calls in `up` below and must keep
          // mirroring them; `qi.DataTypes` is `_s3db.getDataTypes()`, so both
          // sides name the same objects. The two are held together by
          // `test-migration-conformance.js`, which fails any column named in
          // `touches.columns` that neither the model nor `columnTypes`
          // declares.
          columnTypes: {
            SwitchPlugin_PlayerCooldowns: {
              seedPresenceStart: { type: plugin._s3db.getDataTypes().DATE, allowNull: true },
              lastSeedBonusRoundID: { type: plugin._s3db.getDataTypes().STRING, allowNull: true },
              seedBonusTokensEarned: { type: plugin._s3db.getDataTypes().INTEGER, allowNull: false, defaultValue: 0 }
            }
          }
        },
        up: async (qi) => {
          if (await qi.tableExists('SwitchPlugin_PlayerCooldowns')) {
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
            //
            // Skipped when this is a drift repair. Version tracking stops an
            // ordinary re-run, but drift recovery deliberately re-applies an
            // already-applied migration, and this reset would then destroy the
            // live cooldown state — token balances, seed-bonus progress and
            // scramble lockdowns — that the repair exists to preserve. The
            // columns re-added above carry their own defaults, so every row is
            // already consistent without wiping it. The reset is a one-time
            // launch step for the token system, not part of the repair.
            if (!qi.isReapply) {
              await qi.sequelize.getQueryInterface().bulkDelete('SwitchPlugin_PlayerCooldowns', {}, { transaction: qi.transaction });
            }
          }
        },
        down: async (qi) => {
          // NOTE: Rollback drops all token/seed columns. Truncated data from the
          // up migration cannot be recovered — this is intentionally irreversible
          // by design (the expand-contract pattern drops the old column only when
          // the "contract" step is ready, but the deleted rows are gone regardless).
          if (await qi.tableExists('SwitchPlugin_PlayerCooldowns')) {
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
        // This migration used to reach the table through its model, and it
        // no longer can. v9 repoints the SwitchPlugin_Settings MODEL at the
        // new SwitchPlugin_ServerSettings table, so on a fresh install
        // `qi.db.getModel(...)` here would seed a table that v9 has not
        // created yet — a migration reading through a key shape that a later
        // migration in its own group changes. It is pinned to the table it
        // was written against instead, by name, and stays that way forever:
        // the row it seeds is what v9 copies across.
        //
        // `key` is quoted at every mention. Unquoted it parses on SQLite and
        // Postgres and fails on MySQL alone with ER_PARSE_ERROR, which is the
        // worst possible distribution — the suite would stay green and
        // production would not.
        touches: {
          rows: {
            SwitchPlugin_Settings: [{ key: 'key', value: 'explainMessageId' }]
          },
          // No model points at this table any more — v9 moved the model to
          // SwitchPlugin_ServerSettings, and the old table stayed because the
          // deployed grant has no DROP. Without this declaration the backup
          // coverage check reads that as an unmounted plugin and aborts every
          // upgrade that has v4 pending, forever. Nothing is lost by not
          // backing it up: this migration only inserts a row that is missing,
          // and v9 has already copied what was there.
          abandoned: ['SwitchPlugin_Settings']
        },
        up: async (qi) => {
          if (await qi.tableExists('SwitchPlugin_Settings')) {
            const q = (id) => qi.db.quoteIdentifier(id);
            const rows = await qi.rawQuery(
              `SELECT ${q('key')} FROM ${q('SwitchPlugin_Settings')} WHERE ${q('key')} = :key`,
              { key: 'explainMessageId' }
            );
            if (!rows || rows.length === 0) {
              await qi.rawQuery(
                `INSERT INTO ${q('SwitchPlugin_Settings')} (${q('key')}, ${q('value')}) VALUES (:key, :value)`,
                { key: 'explainMessageId', value: '' }
              );
            }
          }
        },
        down: async (qi) => {
          if (await qi.tableExists('SwitchPlugin_Settings')) {
            const q = (id) => qi.db.quoteIdentifier(id);
            await qi.rawQuery(
              `DELETE FROM ${q('SwitchPlugin_Settings')} WHERE ${q('key')} = :key`,
              { key: 'explainMessageId' }
            );
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
          if (await qi.tableExists('SwitchPlugin_PlayerCooldowns')) {
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
          if (await qi.tableExists('SwitchPlugin_PlayerCooldowns')) {
            const columns = await qi.describeTable('SwitchPlugin_PlayerCooldowns');
            if (columns.lastActiveTimestamp) {
              await qi.removeColumn('SwitchPlugin_PlayerCooldowns', 'lastActiveTimestamp');
            }
          }
        }
      },
      {
        version: 6,
        description: 'Create SwitchPlugin_RoundStats for per-round switch aggregates',
        // No index on roundEndedAt, deliberately. Sequelize emits ALTER TABLE
        // for addIndex on MySQL and a bare CREATE INDEX needs its own grant,
        // and neither is worth buying here: this table takes one row per
        // round, so a busy server writes a few thousand a year and the range
        // filter is a trivial scan on every engine the suite supports.
        touches: {
          creates: ['SwitchPlugin_RoundStats'],
          // The ninth Class A declaration. The other eight arrive by
          // ADD COLUMN and this one at CREATE, but verification re-checks a
          // declared column on every mount regardless of how it got there,
          // so leaving it undeclared would be the one table where a dropped
          // or hand-rebuilt serverID goes unnoticed.
          columns: { SwitchPlugin_RoundStats: ['serverID'] }
        },
        up: async (qi) => {
          if (!(await qi.tableExists('SwitchPlugin_RoundStats'))) {
            await qi.createTable('SwitchPlugin_RoundStats', {
              id: { type: qi.DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
              // The one Class A table that gets its serverID at CREATE rather
              // than by a hand-applied ALTER, and the reason is that v6 has
              // never been deployed: the newest production export records
              // switch at v5 and contains no such table. Re-checked against
              // S3_SchemaVersions in that export rather than inherited from
              // the plan — if v6 had shipped, this would be a ninth ALTER.
              // A table with no rows anywhere has no backfill and no
              // compatibility surface, so this costs nothing and saves the
              // one DDL step a grant without ALTER cannot take.
              serverID: { type: qi.DataTypes.INTEGER, allowNull: true },
              matchId: { type: qi.DataTypes.STRING, allowNull: true },
              layerName: { type: qi.DataTypes.STRING, allowNull: true },
              gameMode: { type: qi.DataTypes.STRING, allowNull: true },
              roundEndedAt: { type: qi.DataTypes.DATE, allowNull: false },
              liberalMode: { type: qi.DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
              incomplete: { type: qi.DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
              source: { type: qi.DataTypes.STRING, allowNull: false, defaultValue: 'live' },
              success: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              failed: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              denied: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              toT1: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              toT2: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              maxQueueSize: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              instant: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              queueNormal: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              queueTeamTrade: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              queueJoinSwap: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              queueTimeoutSwitch: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              denialCooldown: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              denialTimeWindow: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              denialScrambleLock: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              denialRecentSwitch: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              denialOther: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              outcomeExpired: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              outcomeDC: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              outcomeCancelled: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              outcomeRemoved: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              meanQueueMs: { type: qi.DataTypes.INTEGER, allowNull: true },
              medianQueueMs: { type: qi.DataTypes.INTEGER, allowNull: true }
            });
          }
        },
        down: async (qi) => {
          await qi.dropTable('SwitchPlugin_RoundStats');
        }
      },
      {
        version: 7,
        description: 'Create SwitchPlugin_PlayerServerState for per-server switch state',
        // Creates only. The four columns it takes over are left standing on
        // SwitchPlugin_PlayerCooldowns rather than dropped: DROP COLUMN needs
        // the ALTER grant the live MySQL user does not have, and it is the one
        // step down() could not put back.
        //
        // No touches.data on lastActiveTimestamp, deliberately, and v5 on the
        // other table is why — a notNull post-condition is re-checked on every
        // mount forever, so it is only safe once every creating path is proven
        // to stamp the column. This migration adds a table with several new
        // creating paths in the same release. The predicate can come later; a
        // rollback-and-re-gate loop on a live server cannot be taken back.
        //
        // The index is not created here. Sequelize emits ALTER TABLE for
        // addIndex on MySQL, so it goes in as a bare CREATE INDEX after the
        // migration commits — see ensureIndexes() below.
        touches: {
          creates: ['SwitchPlugin_PlayerServerState']
        },
        up: async (qi) => {
          if (!(await qi.tableExists('SwitchPlugin_PlayerServerState'))) {
            await qi.createTable('SwitchPlugin_PlayerServerState', {
              serverID: { type: qi.DataTypes.INTEGER, primaryKey: true, allowNull: false },
              eosID: { type: qi.DataTypes.STRING, primaryKey: true, allowNull: false },
              scrambleLockdownExpiry: { type: qi.DataTypes.DATE, allowNull: true },
              seedPresenceStart: { type: qi.DataTypes.DATE, allowNull: true },
              lastSeedBonusRoundID: { type: qi.DataTypes.STRING, allowNull: true },
              seedBonusTokensEarned: { type: qi.DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
              lastActiveTimestamp: { type: qi.DataTypes.DATE, allowNull: true }
            });
          }
        },
        down: async (qi) => {
          await qi.dropTable('SwitchPlugin_PlayerServerState');
        }
      },
      {
        version: 8,
        description: 'Add serverID to SwitchPlugin_Endmatches for multi-server scoping',
        // SwitchPlugin_RoundStats is NOT here. It gets its serverID inside
        // v6's createTable because v6 has never been deployed — see the
        // comment there. Endmatches has, so it needs the ALTER even though
        // the production export records it at zero rows: the table exists,
        // and a column is not optional just because nothing is in it.
        //
        // No touches.data { notNull }. Deferred until every write path is
        // proven to stamp the column, because a data post-condition is
        // re-checked on every mount forever and one unstamped insert puts
        // Switch into a rollback-and-re-gate loop — the failure mode v5 on
        // the other table documents at length.
        touches: {
          columns: { SwitchPlugin_Endmatches: ['serverID'] }
        },
        up: async (qi) => {
          if (!(await qi.tableExists('SwitchPlugin_Endmatches'))) return;
          const columns = await qi.describeTable('SwitchPlugin_Endmatches');
          if (!columns.serverID) {
            await qi.addColumn('SwitchPlugin_Endmatches', 'serverID', {
              type: qi.DataTypes.INTEGER,
              allowNull: true
            });
          }
          // Outside the guard and matched on IS NULL, for the reason v5
          // records: a hand-migrated database arrives here with the column
          // present and every row NULL, and a guarded backfill is a silent
          // no-op on exactly that database.
          await plugin._s3db.backfillServerID(qi, 'SwitchPlugin_Endmatches', plugin._s3db?.getServerID?.() ?? null);
        },
        down: async (qi) => {
          if (!(await qi.tableExists('SwitchPlugin_Endmatches'))) return;
          const columns = await qi.describeTable('SwitchPlugin_Endmatches');
          if (columns.serverID) await qi.removeColumn('SwitchPlugin_Endmatches', 'serverID');
        }
      },
      {
        version: 9,
        description: 'Create SwitchPlugin_ServerSettings and copy this install\u2019s settings onto its own serverID',
        // The two spellings sit three lines apart here, which is the trap
        // this class of migration exists to fall into. registerExpectedVersion
        // above keeps the MODEL name SwitchPlugin_Settings — unchanged, because
        // the export envelope is keyed by model name — while `touches` names
        // the new TABLE, because that is what is created.
        //
        // A primary key cannot be altered in place on either engine that
        // matters: SQLite has no statement that reaches one, and the
        // restricted MySQL grant has no ALTER. So this is a new table beside
        // the old, and the old is abandoned rather than dropped — DROP is not
        // on that grant either. `!s3 db orphans` lists what is left.
        touches: {
          creates: ['SwitchPlugin_ServerSettings'],
          columns: {
            SwitchPlugin_ServerSettings: ['serverID', 'key', 'value']
          }
        },
        up: async (qi) => {
          const q = (id) => qi.db.quoteIdentifier(id);

          if (!(await qi.tableExists('SwitchPlugin_ServerSettings'))) {
            await qi.createTable('SwitchPlugin_ServerSettings', {
              serverID: { type: qi.DataTypes.INTEGER, primaryKey: true, allowNull: false },
              key: { type: qi.DataTypes.STRING, primaryKey: true, allowNull: false },
              value: { type: qi.DataTypes.STRING, allowNull: false }
            });
          }

          // The only Class B table carrying data an admin would otherwise
          // re-enter by hand: a time-limit toggle and the id of the explain
          // message the plugin edits in place. Two rows in production, and
          // both matter more than their size suggests — losing the second
          // orphans a live Discord message the plugin can no longer find.
          //
          // Every identifier is quoted, and `key` above all. Unquoted, this
          // statement parses on SQLite and Postgres and fails on MySQL alone
          // with ER_PARSE_ERROR: the suite would be green and the one engine
          // in production would be the one that broke.
          //
          // NOT EXISTS rather than a bare INSERT ... SELECT, so re-running
          // the migration on a database that already took it copies nothing
          // a second time and does not collide on (serverID, key). It also
          // means an operator who has since changed a setting on the new
          // table does not have the old value put back over it.
          const serverID = plugin._s3db?.getServerID?.() ?? null;
          if (serverID !== null && (await qi.tableExists('SwitchPlugin_Settings'))) {
            await qi.rawQuery(
              `INSERT INTO ${q('SwitchPlugin_ServerSettings')} (${q('serverID')}, ${q('key')}, ${q('value')}) ` +
              `SELECT :serverID, ${q('old')}.${q('key')}, ${q('old')}.${q('value')} ` +
              `FROM ${q('SwitchPlugin_Settings')} ${q('old')} ` +
              `WHERE NOT EXISTS (SELECT 1 FROM ${q('SwitchPlugin_ServerSettings')} ${q('cur')} ` +
              `WHERE ${q('cur')}.${q('serverID')} = :serverID AND ${q('cur')}.${q('key')} = ${q('old')}.${q('key')})`,
              { serverID }
            );
          }
        },
        down: async (qi) => {
          await qi.dropTable('SwitchPlugin_ServerSettings');
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

    // Self-healing, and outside the migration for the reason v7 records: a
    // plain CREATE INDEX is safe under a CREATE-only grant, the migration
    // engine's addIndex() is not. Runs on every mount after the migration
    // transaction commits, so a database that took v7 before this line
    // existed gets its index without a version bump. Non-fatal: a missing
    // index costs query time, never correctness.
    try {
      await plugin._s3db.ensureIndexes('SwitchPlugin_PlayerServerState', playerServerStateIndexes);
    } catch (err) {
      plugin.verbose(1, `[S3] Could not ensure SwitchPlugin_PlayerServerState indexes: ${err.message}`);
    }

    for (const [table, decl] of Object.entries(serverIdIndexes)) {
      try {
        await plugin._s3db.ensureIndexes(table, decl);
      } catch (err) {
        plugin.verbose(1, `[S3] Could not ensure ${table} serverID index: ${err.message}`);
      }
    }

    // ── Attach Methods ─────────────────────────────────────────

    /**
     * Loads this server’s timeLimitEnabled setting from
     * SwitchPlugin_ServerSettings.
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
        // findOne, not findByPk: the key is (serverID, key) and findByPk
        // takes one value. Unfixed it throws rather than returning a
        // neighbour’s row, which is the better failure — but only if it is
        // expected, and this call sits inside a catch that logs at level 1
        // and falls back to the default.
        const row = await Settings.findOne({ where: { serverID: plugin._serverID(), key: 'timeLimitEnabled' } });
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
          { serverID: plugin._serverID(), key: 'timeLimitEnabled', value: String(enabled) },
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
        const row = await Settings.findOne({ where: { serverID: plugin._serverID(), key: 'explainMessageId' } });
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
          { serverID: plugin._serverID(), key: 'explainMessageId', value },
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
     * Rows below the cap with a NULL anchor are still not TOPPED UP, for the
     * original reason: `Op.lt` against NULL is UNKNOWN, and such a row cannot
     * prove it ever started regenerating, so granting it tokens would be the
     * same exploit tier 1 guards against. What the first pass below does
     * instead is start their clock.
     *
     * That pass exists because the original reasoning here — "if one ever
     * appears it ages out through tier 2" — only holds for a row nobody is
     * using. Tier 2 retires rows at the retention horizon, which an ACTIVE
     * player's row never reaches, so an active player stays stranded forever
     * while an inactive one heals. And the row is not merely un-normalized: it
     * cannot regenerate at all, because _regenTokens() reads a null anchor as
     * `now` and so measures zero elapsed time on every read. Once such a row
     * reaches 0 the player can never switch again.
     *
     * These rows are reachable whenever maxSwitchTokens RISES above the cap a
     * row was last written at: every null-anchor write (new rows, the admin
     * clears, and this function's own writeback) pairs NULL with an AT-cap
     * balance, which is safe until the cap moves under it. switch.js's
     * _regenTokens() now stamps an anchor when it observes this state, which
     * stops new ones being created on the spend path; this pass repairs rows
     * already on disk, including the 0-balance ones that can no longer spend
     * and so would never reach that code with anything to persist.
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
      let clocksStarted = 0;

      try {
        await plugin._withDb(async (t) => {
          // Repair pass, before the deficit loop so a row cannot be both
          // started and normalized in one sweep: give stranded rows an anchor
          // so ordinary regeneration can take over. No balance is granted —
          // they wait a full interval from now, as if they had just spent.
          const [started] = await PlayerCooldowns.update(
            { tokenRegenAnchor: new Date(now) },
            {
              where: {
                tokenBalance: { [Op.lt]: maxTokens },
                tokenRegenAnchor: null
              },
              transaction: t
            }
          );
          clocksStarted = started;

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
        if (clocksStarted > 0) {
          // Worth a line of its own: a non-zero count here means rows existed
          // that could not regenerate, which points at maxSwitchTokens having
          // been raised at some point.
          plugin.verbose(1, `[Cleanup] Started the regen clock on ${clocksStarted} below-cap row(s) that had no anchor.`);
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

      // The prune is a deletion predicate against a table the community shares,
      // so it refuses while the servers disagree about how long a row lives.
      // Unlike the token cap above there is no value that is obviously right to
      // resolve to: a retention window is policy, not a safety limit, and the
      // shortest one configured anywhere would silently become the one everybody
      // gets. Refusing costs only housekeeping — rows are kept, not lost — which
      // is what makes refusal affordable here and not on the switch path.
      const refusal = plugin.communityOptionRefusal('pruneInactivePlayerDays');
      if (refusal) {
        plugin.verbose(1, `[Cleanup] Prune declined — ${refusal}. Nothing was deleted.`);
        return;
      }

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

      const ServerState = plugin._getServerStateModel();

      try {
        await plugin._withDb(async (t) => {
          // Two of this predicate’s conjuncts used to read columns that have
          // moved: a live scramble lock protected a row from deletion, and
          // "the row carries nothing" meant no seed state. Both are now facts
          // about a set of per-server rows rather than about the row being
          // deleted, so they arrive as eosID exclusions instead of as column
          // predicates on the row itself.
          //
          // This read is deliberately NOT scoped to this server. A player who
          // is lockdown-protected on server B must keep their community-wide
          // token balance when server A prunes; scoping it here would delete
          // the shared row out from under a lock this process cannot see. That
          // is the silent, irreversible failure this rework exists to stop, and
          // it is invisible to any fixture with one server in it.
          let protectedEosIDs = [];
          let seedStatefulEosIDs = [];
          if (ServerState) {
            const held = await ServerState.findAll({
              where: {
                [Op.or]: [
                  { scrambleLockdownExpiry: { [Op.gte]: now } },
                  { seedPresenceStart: { [Op.ne]: null } },
                  { seedBonusTokensEarned: { [Op.ne]: 0 } }
                ]
              },
              attributes: ['eosID', 'scrambleLockdownExpiry', 'seedPresenceStart', 'seedBonusTokensEarned'],
              transaction: t
            });
            protectedEosIDs = [...new Set(held
              .filter((r) => r.scrambleLockdownExpiry != null
                && new Date(r.scrambleLockdownExpiry).getTime() >= now.getTime())
              .map((r) => r.eosID))];
            seedStatefulEosIDs = [...new Set(held
              .filter((r) => r.seedPresenceStart != null || (r.seedBonusTokensEarned ?? 0) !== 0)
              .map((r) => r.eosID))];
          }

          // Tier 1 is "the row carries nothing". Its seed half is now an
          // exclusion, and it is appended only when the exclusion set is
          // non-empty: Sequelize renders an empty Op.notIn as `NOT IN (NULL)`,
          // which is UNKNOWN for every row on all three engines and would
          // silently disable tier 1 entirely on the common case of nobody
          // holding seed state anywhere.
          const tierOne = {
            tokenBalance: maxTokens,
            lastActiveTimestamp: { [Op.lt]: emptyRowCutoff }
          };
          if (seedStatefulEosIDs.length > 0) {
            tierOne.eosID = { [Op.notIn]: seedStatefulEosIDs };
          }

          const where = {
            [Op.and]: [
              // NULL is spelled out rather than left to three-valued logic —
              // `lastActiveTimestamp < cutoff` is UNKNOWN against NULL and would
              // silently exclude the row anyway, but stating it keeps the intent
              // readable and dialect-independent.
              { lastActiveTimestamp: { [Op.ne]: null } },
              {
                [Op.or]: [
                  tierOne,
                  {
                    // Tier 2: abandoned, whatever it holds
                    lastActiveTimestamp: { [Op.lt]: staleCutoff }
                  }
                ]
              }
            ]
          };

          // Applies to both tiers, exactly as the column predicate it replaces
          // did: an abandoned row still holding a live lock somewhere is kept.
          if (protectedEosIDs.length > 0) {
            where[Op.and].push({ eosID: { [Op.notIn]: protectedEosIDs } });
          }
          if (connectedEosIDs.length > 0) {
            where[Op.and].push({ eosID: { [Op.notIn]: connectedEosIDs } });
          }

          // Resolved to a list first rather than trusting destroy()’s count.
          // The per-server rows have to go with the global one, and destroy()
          // does not say which rows it took — so the alternative is a second
          // DELETE carrying its own copy of this predicate, which is two
          // spellings of one rule on a path whose failure mode is silent
          // deletion of the wrong player.
          const doomed = await PlayerCooldowns.findAll({
            where, attributes: ['eosID'], raw: true, transaction: t
          });
          const doomedEosIDs = doomed.map((r) => r.eosID);
          if (doomedEosIDs.length === 0) return;

          const deleted = await PlayerCooldowns.destroy({
            where: { eosID: { [Op.in]: doomedEosIDs } }, transaction: t
          });

          // Every server’s rows, not this server’s. The community-wide row is
          // gone; a surviving per-server row is state for a player nobody
          // tracks any more, and the next process to read it would resurrect a
          // lock or a seed clock with no wallet behind it.
          let sideDeleted = 0;
          if (ServerState) {
            sideDeleted = await ServerState.destroy({
              where: { eosID: { [Op.in]: doomedEosIDs } }, transaction: t
            });
          }

          if (deleted > 0) {
            // Logged at verbose(1) deliberately: the first pass after the v5
            // backfill prunes the entire long tail at once and looks alarming
            // without a number attached to it.
            plugin.verbose(1, `[Cleanup] Pruned ${deleted} cooldown rows and ${sideDeleted} per-server rows (empty >30m, or unseen >${retentionDays}d).`);
          }
        });
      } catch (err) {
        plugin.verbose(1, `Cleanup error: ${err.message}`);
      }

      await plugin._pruneServerState({
        now, emptyRowCutoff, staleCutoff, connectedEosIDs, retentionDays
      });
    };

    /**
     * The per-server table's own prune, on the same two clocks as cleanup().
     *
     * Not reachable from the global row’s lifecycle, which is why it exists.
     * A player who plays server A every day keeps their community-wide row
     * alive forever, and their server B row — untouched since whenever they
     * last played there — rides along with it. Only a prune that asks "when
     * was this player last seen HERE" can ever retire it.
     *
     * Scoped to this server. Another server’s rows are that server’s to
     * retire, against its own roster: this process cannot tell whether a
     * player it is about to prune is standing on server B right now.
     *
     * Called only from cleanup(), after it, and therefore behind the same
     * seed-mode skip, the same community-option refusal and the same
     * retention-disabled guard. A retention window is policy and it is the
     * community’s, not this table’s.
     *
     * @returns {Promise<number>} rows deleted
     */
    plugin._pruneServerState = async function ({ now, emptyRowCutoff, staleCutoff, connectedEosIDs, retentionDays }) {
      const ServerState = plugin._getServerStateModel();
      if (!ServerState) return 0;

      const serverID = plugin._serverID();
      let deleted = 0;
      try {
        await plugin._withDb(async (t) => {
          const where = {
            [Op.and]: [
              { serverID },
              {
                [Op.or]: [
                  { scrambleLockdownExpiry: null },
                  { scrambleLockdownExpiry: { [Op.lt]: now } }
                ]
              },
              { lastActiveTimestamp: { [Op.ne]: null } },
              {
                [Op.or]: [
                  {
                    // Tier 1: the row carries nothing for this server
                    seedPresenceStart: null,
                    seedBonusTokensEarned: 0,
                    lastActiveTimestamp: { [Op.lt]: emptyRowCutoff }
                  },
                  {
                    // Tier 2: not seen here in the retention window
                    lastActiveTimestamp: { [Op.lt]: staleCutoff }
                  }
                ]
              }
            ]
          };
          if (connectedEosIDs.length > 0) {
            where[Op.and].push({ eosID: { [Op.notIn]: connectedEosIDs } });
          }
          deleted = await ServerState.destroy({ where, transaction: t });
        });
        if (deleted > 0) {
          plugin.verbose(1, `[Cleanup] Pruned ${deleted} per-server state rows on server ${serverID} (empty >30m, or unseen here >${retentionDays}d).`);
        }
      } catch (err) {
        plugin.verbose(1, `[Cleanup] Per-server state prune failed: ${err.message}`);
      }
      return deleted;
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
     * Returns a plain object, not a model instance, because after the split
     * one player is two rows: the community-wide wallet and this server’s
     * lock and seed clock. Every caller only reads fields off it — none save
     * through it — so merging is honest where handing back an instance with
     * four extra properties bolted on would not be. `_serverScoped` names the
     * half that is this server only, so a reply can say which is which
     * instead of presenting a community fact and a local one as one row.
     *
     * @param {string} ident — eosID or partial player name
     * @returns {object|null|string} record, null if not found, 'multiple' if ambiguous
     */
    plugin.checkPlayer = async function (ident) {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) return null;

      const ServerState = plugin._getServerStateModel();
      const serverID = plugin._serverID();

      // Read through the model rather than raw: SQLite hands back DATE
      // columns as strings under `raw: true`, and two of the callers compare
      // scrambleLockdownExpiry against a Date with `>`.
      const merge = async (row) => {
        const base = row.get({ plain: true });
        let side = null;
        if (ServerState) {
          side = await ServerState.findOne({ where: { serverID, eosID: base.eosID } });
        }
        return {
          ...base,
          scrambleLockdownExpiry: side?.scrambleLockdownExpiry ?? null,
          seedPresenceStart: side?.seedPresenceStart ?? null,
          lastSeedBonusRoundID: side?.lastSeedBonusRoundID ?? null,
          seedBonusTokensEarned: side?.seedBonusTokensEarned ?? 0,
          _serverID: serverID,
          _serverScoped: ['scrambleLockdownExpiry', 'seedPresenceStart', 'lastSeedBonusRoundID', 'seedBonusTokensEarned']
        };
      };

      const record = await PlayerCooldowns.findByPk(ident);
      if (record) return merge(record);

      const likeOp = plugin._s3db?.caseInsensitiveLikeOp?.() || Op.like;
      const records = await PlayerCooldowns.findAll({
        where: {
          playerName: { [likeOp]: `%${ident}%` }
        }
      });

      if (records.length === 0) return null;
      if (records.length > 1) return 'multiple';
      return merge(records[0]);
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
          'lastActiveTimestamp'
        ]
      });

      // The lock and the seed clock are this server’s answer, so the second
      // read is scoped and the numbers below stay the ones an admin standing
      // on this server would expect. Token counts are not scoped and cannot
      // be: there is one wallet, and it is the community’s.
      //
      // Joined in JS rather than through an association. The tables have no
      // declared relation — SwitchPlugin_PlayerServerState is keyed
      // (serverID, eosID) and the join would need a literal on one side — and
      // this function already loads the whole cooldown table by design, for
      // the reason its docblock gives. A second bounded read costs one query.
      const ServerState = plugin._getServerStateModel();
      const serverStateByEosID = new Map();
      if (ServerState) {
        const stateRows = await ServerState.findAll({
          where: { serverID: plugin._serverID() },
          attributes: ['eosID', 'scrambleLockdownExpiry', 'seedPresenceStart']
        });
        for (const s of stateRows) serverStateByEosID.set(s.eosID, s);
      }

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

        const side = serverStateByEosID.get(r.eosID) || null;
        const lockExpiry = side?.scrambleLockdownExpiry ? new Date(side.scrambleLockdownExpiry) : null;
        const lockActive = lockExpiry != null && lockExpiry.getTime() > now.getTime();
        const noTokens = live.tokenBalance < 1;

        if (lockActive) scrambleLocked++;
        if (noTokens) outOfTokens++;
        if (live.tokenBalance < maxTokens) belowCap++;
        if (side?.seedPresenceStart && connected.has(r.eosID) && live.tokenBalance < ceiling) seedAccruing++;

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

      const ServerState = plugin._getServerStateModel();
      const serverID = plugin._serverID();
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

        await PlayerCooldowns.update(
          {
            tokenBalance: after,
            // null, not now(): no regen cycle is running at or above the cap, and
            // _regenTokens() re-anchors in memory the moment it reads the row.
            tokenRegenAnchor: null,
            lastActiveTimestamp: new Date()
          },
          { where: { eosID }, transaction: t }
        );

        // The lock is this server’s, and clearing it here rather than
        // everywhere is the point: an admin lifting a restriction on their own
        // server has not been asked about anyone else’s scramble. Same
        // transaction, explicit handle — no CLS in this repo, so an omitted
        // one runs outside and the surrounding rollback would not take it back.
        let lockCleared = false;
        if (ServerState) {
          const side = await ServerState.findOne({ where: { serverID, eosID }, transaction: t });
          lockCleared = side?.scrambleLockdownExpiry != null;
          if (lockCleared) {
            await ServerState.update(
              { scrambleLockdownExpiry: null, lastActiveTimestamp: new Date() },
              { where: { serverID, eosID }, transaction: t }
            );
          }
        }

        summary = { tokensBefore: before, tokensAfter: after, lockCleared, serverID };
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
     * Lifts switch restrictions for every tracked player.
     *
     * Two halves of different widths since the split, and the caller has to
     * say so: the top-up writes a table the whole community shares, while the
     * lock clear is this server’s rows only. An admin who lifts restrictions
     * here has handed every server’s players their tokens back, which is not
     * what "server-wide" used to mean and is not optional — there is one
     * wallet per player and it has no server in it.
     *
     * Deliberately two statements rather than one. A single UPDATE setting
     * tokenBalance = maxTokens would lower every seed-bonus holder to the
     * ordinary cap — the exact bug this release fixes. Splitting on the cap
     * lets rows above it keep their surplus.
     *
     * SQL GREATEST() would express it in one statement, but SQLite spells that
     * MAX(a, b) while MySQL and Postgres spell it GREATEST(a, b), so a single
     * statement would need raw dialect-specific SQL. Two ORM updates are worth
     * more than one clever one here.
     *
     * The lock statement no longer partitions on the token balance. It used
     * to, only so the two statements could not both fire on one row; they are
     * on different tables now and cannot collide, so every lock on this server
     * is cleared whatever the wallet says. That also retires a silent-failure
     * mode the old partition carried — a NULL balance matched neither arm and
     * kept its lock through a `clearall` that reported success.
     *
     * @returns {Promise<{toppedUp: number, locksCleared: number, serverID: number}>}
     */
    plugin.adminClearAllRestrictions = async function () {
      const PlayerCooldowns = plugin._getModel('SwitchPlugin_PlayerCooldowns');
      if (!PlayerCooldowns) throw new Error('SwitchPlugin_PlayerCooldowns model not available — DB may not be ready.');

      const ServerState = plugin._getServerStateModel();
      const serverID = plugin._serverID();
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
            tokenRegenAnchor: null
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

        // This server’s locks, unconditionally — see the docblock.
        if (ServerState) {
          const [lockCount] = await ServerState.update(
            { scrambleLockdownExpiry: null },
            {
              where: {
                serverID,
                scrambleLockdownExpiry: { [Op.ne]: null }
              },
              transaction: t
            }
          );
          locksCleared = lockCount;
        }
      });

      plugin.verbose(1, `[Admin] Cleared restrictions: ${toppedUp} players topped up to ${maxTokens} community-wide, ${locksCleared} scramble locks lifted on server ${serverID}.`);
      return { toppedUp, locksCleared, serverID };
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

      const ServerState = plugin._getServerStateModel();
      let deleted = 0;
      let stateDeleted = 0;
      await adminTx(async (t) => {
        deleted = await PlayerCooldowns.destroy({ where: {}, transaction: t });
        // Every server’s rows, not this server’s. Leaving another server’s
        // locks standing after their wallets are gone is not a partial wipe,
        // it is a lock with nothing behind it — and the caller has already
        // named every registered server in its confirmation.
        if (ServerState) {
          stateDeleted = await ServerState.destroy({ where: {}, transaction: t });
        }
      });

      plugin.verbose(1, `[Admin] Wiped ${deleted} cooldown rows and ${stateDeleted} per-server state rows.`);
      return { deleted, stateDeleted };
    };


    // ── Round Stats ────────────────────────────────────────────

    /**
     * Persists one round's aggregate.
     *
     * Silently no-ops when the DB is unavailable or the table has not been
     * migrated yet: a missed round is a gap in a report, and it must never be
     * the thing that stops a round from ending. _withDb() already swallows and
     * reports; the model guard covers the window between mount and migration.
     *
     * @param {object} row — the shape _computeRoundStatsRow() returns
     * @returns {Promise<boolean>} true when a row was written
     */
    plugin.recordRoundStats = async function (row) {
      const RoundStats = plugin._getModel('SwitchPlugin_RoundStats');
      if (!RoundStats || !row) return false;
      const written = await plugin._withDb(async (t) => {
        // Spread last: _computeRoundStatsRow() builds an aggregate, and which
        // server produced it is not part of that computation.
        await RoundStats.create({ ...row, serverID: plugin._serverID() }, { transaction: t });
        return true;
      });
      return written === true;
    };

    /**
     * Sums every stored round in a window into the shape both report embeds
     * already render.
     *
     * Rows are fetched and reduced in JS rather than summed in SQL. Two
     * reasons: the median-of-medians needs the individual values, not a total;
     * and SUM/CAST semantics differ enough between SQLite and MySQL that a
     * single aggregate query would need proving on both engines to be trusted,
     * which buys nothing at this table's size — one row per round is a few
     * thousand a year.
     *
     * `limit` is a blast radius, not a page size. A caller asking for an
     * absurd window gets the most recent MAX_ROWS rounds rather than an
     * out-of-memory crash, and truncated is set so the embed can say so.
     *
     * This server's rounds only. The table is server-column scoped and the
     * insert stamps it, so an unscoped read here would sum two servers'
     * rounds into one total and the embed would render it without a hint
     * that it had — the numbers stay plausible, which is what makes it
     * worth a predicate rather than a note.
     *
     * @param {Date} fromDate — inclusive lower bound on roundEndedAt
     * @param {Date} [toDate] — inclusive upper bound; defaults to now
     * @returns {Promise<object|null>} totals, or null if the DB is unavailable
     */
    plugin.getRoundStatsTotals = async function (fromDate, toDate) {
      const RoundStats = plugin._getModel('SwitchPlugin_RoundStats');
      if (!RoundStats) return null;

      const MAX_ROWS = 20000;
      const rows = await plugin._withDb(async (t) => RoundStats.findAll({
        where: {
          serverID: plugin._serverID(),
          roundEndedAt: { [Op.between]: [fromDate, toDate || new Date()] }
        },
        order: [['roundEndedAt', 'DESC']],
        limit: MAX_ROWS,
        transaction: t
      }));
      if (!rows) return null;

      const totals = {
        rounds: 0,
        standardRounds: 0,
        liberalRounds: 0,
        success: 0, failed: 0, denied: 0, toT1: 0, toT2: 0,
        maxQueueSize: 0,
        instant: 0, queueNormal: 0, queueTeamTrade: 0, queueJoinSwap: 0, queueTimeoutSwitch: 0,
        denialCooldown: 0, denialTimeWindow: 0, denialScrambleLock: 0,
        denialRecentSwitch: 0, denialOther: 0,
        outcomeExpired: 0, outcomeDC: 0, outcomeCancelled: 0, outcomeRemoved: 0,
        incompleteRounds: 0,
        totalQueueEntries: 0,
        queueDurationsMs: [],
        medianDurationsMs: [],
        missingMedian: 0,
        scrapedRounds: 0,
        truncated: rows.length >= MAX_ROWS
      };

      const SUMMED = [
        'success', 'failed', 'denied', 'toT1', 'toT2',
        'instant', 'queueNormal', 'queueTeamTrade', 'queueJoinSwap', 'queueTimeoutSwitch',
        'denialCooldown', 'denialTimeWindow', 'denialScrambleLock',
        'denialRecentSwitch', 'denialOther',
        'outcomeExpired', 'outcomeDC', 'outcomeCancelled', 'outcomeRemoved'
      ];

      for (const r of rows) {
        totals.rounds++;
        // Liberal rounds are counted and then dropped: switching is
        // unrestricted then, so folding their numbers in would describe a
        // system nobody was actually using.
        if (r.liberalMode) { totals.liberalRounds++; continue; }
        totals.standardRounds++;
        if (r.source === 'scraped') totals.scrapedRounds++;
        if (r.incomplete) totals.incompleteRounds++;

        for (const k of SUMMED) totals[k] += r[k] || 0;
        if (r.maxQueueSize > totals.maxQueueSize) totals.maxQueueSize = r.maxQueueSize;

        totals.totalQueueEntries += (r.queueNormal || 0) + (r.queueTeamTrade || 0) +
          (r.queueJoinSwap || 0) + (r.queueTimeoutSwitch || 0) +
          (r.outcomeExpired || 0) + (r.outcomeDC || 0) + (r.outcomeCancelled || 0) + (r.outcomeRemoved || 0);

        // A null mean means the round had no queue entries at all — not a
        // wait of zero — so it contributes nothing rather than dragging the
        // average down. A mean without a median is a backfilled round from
        // before the summary printed one.
        if (r.meanQueueMs != null) {
          totals.queueDurationsMs.push(r.meanQueueMs);
          if (r.medianQueueMs != null) totals.medianDurationsMs.push(r.medianQueueMs);
          else totals.missingMedian++;
        }
      }

      return totals;
    };

    /**
     * The timestamp of the oldest round recorded live.
     *
     * The backfill needs it as a stop line. A live row is stamped at NEW_GAME;
     * the summary message for that same round lands a second or two later, so
     * the two timestamps never match and the dedupe cannot see they are the
     * same round. Refusing to scrape anything at or after this point is what
     * keeps the overlap from being counted twice.
     *
     * Scoped, and it decides what gets written rather than what gets shown.
     * The stop line belongs to this server's own live recording: reading the
     * neighbour's earliest row would move it, and a backfill that stops too
     * early leaves a gap nothing fills, while one that stops too late
     * double-counts rounds the dedupe cannot match.
     *
     * @returns {Promise<Date|null>} null when nothing was recorded live yet
     */
    plugin.getEarliestLiveRoundStat = async function () {
      const RoundStats = plugin._getModel('SwitchPlugin_RoundStats');
      if (!RoundStats) return null;
      const row = await plugin._withDb(async (t) => RoundStats.findOne({
        where: { serverID: plugin._serverID(), source: 'live' },
        order: [['roundEndedAt', 'ASC']],
        attributes: ['roundEndedAt'],
        transaction: t
      }));
      return row ? new Date(row.roundEndedAt) : null;
    };

    /**
     * Bulk-inserts backfilled rounds, skipping any whose roundEndedAt is
     * already present.
     *
     * Scraped rounds have no matchId — the summary embed never printed one —
     * so the dedupe key is the round-end timestamp the embed carries.
     *
     * Matched to the second, with a second of slack, and NOT by equality. A
     * probe against MySQL 8 on 127.0.0.1:3307 stored 00:00:10.999 as
     * 00:00:10 — DATETIME carries no fractional digits unless asked, so an
     * `Op.in` on the original millisecond Dates matched nothing and a re-run
     * inserted every row a second time. SQLite keeps the milliseconds and hid
     * it. The slack covers an engine that rounds where this one truncates;
     * rounds are minutes apart, so it can never merge two real ones.
     *
     * @param {object[]} rows
     * @returns {Promise<{inserted:number, skipped:number}>}
     */
    plugin.backfillRoundStats = async function (rows) {
      const RoundStats = plugin._getModel('SwitchPlugin_RoundStats');
      if (!RoundStats || !rows?.length) return { inserted: 0, skipped: 0 };

      const times = rows.map((r) => new Date(r.roundEndedAt).getTime());
      const lo = new Date(Math.min(...times) - 1000);
      const hi = new Date(Math.max(...times) + 1000);

      const serverID = plugin._serverID();
      const result = await plugin._withDb(async (t) => {
        // The dedupe read is scoped as well as the insert, and it has to be:
        // rounds on two servers end seconds apart all the time, and an
        // unscoped probe would read the other server's row, call this round a
        // duplicate, and drop it. That is a write bug wearing a read’s
        // clothing, which is why it is fixed here rather than deferred to the
        // read-path pass.
        const existing = await RoundStats.findAll({
          where: { serverID, roundEndedAt: { [Op.between]: [lo, hi] } },
          attributes: ['roundEndedAt'],
          transaction: t
        });
        const seen = new Set();
        for (const r of existing) {
          const sec = Math.floor(new Date(r.roundEndedAt).getTime() / 1000);
          seen.add(sec - 1); seen.add(sec); seen.add(sec + 1);
        }
        const fresh = rows.filter((r) => !seen.has(Math.floor(new Date(r.roundEndedAt).getTime() / 1000)));
        if (fresh.length) await RoundStats.bulkCreate(fresh.map((r) => ({ ...r, serverID })), { transaction: t });
        return { inserted: fresh.length, skipped: rows.length - fresh.length };
      });

      return result || { inserted: 0, skipped: 0 };
    };

    // ── Load persisted settings ────────────────────────────────

    await plugin._loadTimeLimitSetting();
    await plugin._loadExplainMessageId();
  }
};

export default SwitchDB;