/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                   DB LOG — S3-BACKED UPGRADE                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * S³-backed drop-in replacement for core SquadJS's `db-log.js`. Same
 * class name (`DBLog`), same file name (`db-log.js`), same config
 * entry, same tables/columns/cadence — deploying this suite's version
 * overwrites core's file at the same path in `squad-server/plugins/`
 * instead of sitting beside it as a second, differently-named plugin.
 * That matters here specifically: a config that ends up with BOTH
 * core's `DBLog` and a differently-named S³ version enabled at once
 * would double-insert every tick-rate/player-count/wound/death/revive
 * row. Matching the name removes that failure mode by construction
 * rather than relying on the operator to remember to disable the old
 * entry. A config that already runs core's `db-log.js` needs no
 * changes — same `DBLog` entry, unchanged.
 *
 * Core `db-log.js`'s per-event `.create()`/`.update()` calls have no
 * DB-outage guard at all — a connection-pool timeout throws an
 * unhandled rejection on every single game event for the duration of
 * an outage, flooding the event loop and stdout, and starving every
 * other plugin sharing the same process. Every model call here
 * instead goes through `this._withDb()`, which implements retry+jitter,
 * a SQLite mutex, and network-outage backoff — a failed or skipped
 * write is a `verbose(1, ...)` log line, never a throw. It also fixes
 * a real data-integrity bug: in core, if `Match.create()` fails when
 * starting a new round, `this.match` is never reassigned and keeps
 * pointing at the *previous* round's match row, so every wound/death/
 * revive/tick-rate/player-count row logged until the next successful
 * create silently attaches to the wrong round with no signal that it
 * happened (see `onNewGame` below, which nulls `this.match` instead).
 *
 * What's NOT different from core: no Discord dependency, no schema
 * changes, no new fields, no change to what gets logged or when, no
 * backfill of rows lost during past outages, and no `DBLog_SteamUsers`
 * table / SteamUsers→Players migration (the live DB has already
 * completed that migration; porting it forward would be dead weight).
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * DBLog (default)
 *   Extends S3PluginBase. Registers and handles all SquadJS events.
 *   Key public methods:
 *     _onS3Ready()   — Defines models, runs migrations, bootstraps server/match rows, registers listeners.
 *     _onUnmount()   — Removes all listeners.
 *     ensurePlayer(playerData, extra) — Upserts a DBLog_Players row by steamID; reference _withDb() shape.
 *     onTickRate(info) / onUpdatedA2SInformation(info) — Tick-rate and population sampling.
 *     onNewGame(info) — Closes previous match, opens new one; nulls this.match on create failure.
 *     onPlayerConnected/Wounded/Died/Revived(info) — Player identity + combat-event logging.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * S3PluginBase (./s3-plugin-base.js)
 *   S³ plugin base class providing S³ discovery, readiness gating, DB convenience,
 *   and flat service accessors. Extends SquadJS BasePlugin under the hood.
 *
 * ─── SCOPE ────────────────────────────────────────────────────────
 *
 * Ported: TICK_RATE, UPDATED_A2S_INFORMATION, NEW_GAME, PLAYER_CONNECTED,
 * PLAYER_WOUNDED, PLAYER_DIED, PLAYER_REVIVED, plus server/match bootstrap
 * in _onS3Ready().
 *
 * Deliberately NOT ported:
 *   - `DBLog_SteamUsers` table and the SteamUsers→Players migration —
 *     the live DB has already completed this migration; dead weight
 *     going forward.
 *   - Any in-memory caching beyond what core already does (`this.match`
 *     cached once per round, server id read as a plain property) — no
 *     efficiency gap exists here to fix.
 *
 * ─── TABLES ──────────────────────────────────────────────────────
 *
 * Table names and columns are unchanged from the live schema (confirmed
 * against a DDL export of a live database and the core Sequelize model
 * definitions) so existing stats history is not orphaned and external
 * tooling reading these tables keeps working:
 *
 *   DBLog_Servers      — server registry (id, name)
 *   DBLog_Matches      — round records (server FK, start/end/winner)
 *   DBLog_Players      — player identity (eosID/steamID unique)
 *   DBLog_Wounds       — wound events (attacker/victim -> DBLog_Players.steamID)
 *   DBLog_Deaths       — death events (same shape as wounds + woundTime)
 *   DBLog_Revives      — revive events (same shape as wounds + reviver fields)
 *   DBLog_TickRates    — tick-rate samples
 *   DBLog_PlayerCounts — population samples
 *
 * The PascalCase is core's, not a style choice — core defines models as
 * `DBLog_Server` with no explicit `tableName`, so Sequelize pluralises them
 * into these table names. Matching them exactly is what makes this a drop-in
 * that adopts existing stats rather than starting a second, empty set beside
 * them; the `TABLE` constant below has the per-dialect detail. Existence
 * checks in the migration compare case-insensitively, because MySQL with
 * lower_case_table_names=1 reports these back folded to lowercase.
 *
 * Tables are created via `queryInterface.createTable()` inside a versioned
 * migration (never `Model.sync()` or `qi.addIndex()`, both ALTER-based). A
 * MySQL deployment can be granted CREATE while ALTER is withheld, which is a
 * perfectly ordinary hardening choice for a shared or managed database — on
 * such a server either call fails at install time, so neither is safe to
 * depend on. `DBLog_Players`'s eosID/steamID uniqueness is declared
 * inline as `unique: true` column options in the
 * `createTable()` call, which compiles to an inline UNIQUE constraint —
 * part of the CREATE TABLE statement itself, not a follow-up ALTER, so it
 * needs no separate `CREATE INDEX` step the way a plain (non-unique)
 * index would (contrast `LoggingService._ensureIndexes()`, which needs
 * that follow-up step precisely because its indexes aren't backed by a
 * column constraint it can declare inline).
 *
 * No FOREIGN KEY constraints are declared (unlike core, which gets them
 * incidentally from Sequelize's `hasMany()` association mechanism at
 * `sync()` time). This is a deliberate scope cut, not an oversight: the
 * live tables already exist without this port ever touching them, so the
 * only case where a fresh install's constraints would matter is a
 * brand-new deployment, and reproducing `hasMany()`'s per-dialect
 * ALTER-vs-CREATE-time behavior exactly is unwarranted complexity for a
 * feature this port does not set out to add — its remit is explicitly no
 * schema changes, because it is a safety port. Column names and types
 * that principals (Wound/Death/Revive `victim`/`attacker`/
 * `reviver`) point at are unchanged, so existing joins on `steamID` keep
 * working identically.
 *
 * ─── S³ INTEGRATION ──────────────────────────────────────────────
 *
 * S³ (Slacker's Squad Services) is the centralised service container
 * for shared state across Slacker's Squad plugins. It owns the ground
 * truth for server configuration, game-state lifecycle, player state,
 * faction metadata, clan grouping, database access, and cross-plugin
 * event routing. This plugin extends `S3PluginBase`, which handles S³
 * discovery, readiness gating, and DB convenience methods (`_withDb`,
 * `defineModel`, `registerMigrations`, `verifyAndRunMigrations`,
 * `_getModel`, `reportError`) automatically — see §8 of
 * `s3/S3_DEVELOPER_GUIDE.md`.
 *
 * Consumed Services:
 *   - db (`this.s3db`): model definition, versioned migrations, and every
 *     read/write in this file, all routed through `_withDb()`/`_getModel()`.
 *
 * No other S³ service (gameState, players, clans, factions, serverConfig)
 * is consumed — this plugin is pure event-driven telemetry, same as core's
 * `db-log.js`, and has no need for round-phase or player-state awareness.
 *
 * Emitted Events:
 *   - None.
 *
 * Listened Events:
 *   - TICK_RATE, UPDATED_A2S_INFORMATION, NEW_GAME, PLAYER_CONNECTED,
 *     PLAYER_WOUNDED, PLAYER_DIED, PLAYER_REVIVED — all from SquadJS core,
 *     not from S³. See §Scope above.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - `onNewGame`'s two-call sequence (`Match.update()` closing the previous
 *   round, `Match.create()` opening the new one) is NOT atomic — matching
 *   core's behavior. If `Match.create()` fails, `this.match` is explicitly
 *   nulled out (never left pointing at the previous round's match id) so
 *   that any Wound/Death/Revive/TickRate/PlayerCount logged before the next
 *   successful create attaches with `match: null` rather than silently
 *   mis-attributing to the wrong round.
 * - `ensurePlayer()` performs 1-3 separate `_withDb()` calls per event
 *   handler (one per player role: attacker/victim/reviver) rather than a
 *   single wrapping transaction — S³'s `_withDb()` uses a real Sequelize
 *   transaction per call, and SQLite's single-connection pool throws
 *   "cannot start a transaction within a transaction" if one `_withDb()`
 *   call is nested inside another. This mirrors core's own structure,
 *   which also issued each `ensurePlayer()` call independently.
 *
 * ═══════════════════════════════════════════════════════════════
 */

import S3PluginBase from './s3-plugin-base.js';

const PLUGIN_NAME = 'db-log';
const SCHEMA_VERSION = 1;

/*
 * These MUST be exactly the table names core SquadJS's db-log.js produces.
 *
 * Core does `database.define('DBLog_' + name, schema)` with no `tableName`, so
 * Sequelize pluralises the model name: `DBLog_Server` becomes the table
 * `DBLog_Servers`. Every server that has ever run core's db-log has its stats
 * in PascalCase tables under those names.
 *
 * This port previously declared them lowercase (`dblog_servers`). That is not a
 * cosmetic difference — it decides whether a drop-in replacement adopts the
 * existing data or walks away from it, and each dialect fails differently:
 *
 *   - SQLite folds identifier case, so `CREATE TABLE dblog_deaths` against an
 *     existing `DBLog_Deaths` raises "table already exists" and the migration
 *     aborts — the plugin never mounts.
 *   - MySQL with lower_case_table_names=0 (the Linux default) treats them as
 *     two different tables, so the CREATE succeeds and the plugin starts
 *     writing into an empty table while years of stats sit orphaned in the
 *     other one. Silent, and it needs only the CREATE grant the live user has.
 *   - MySQL with lower_case_table_names=1 folds like SQLite and works, which is
 *     why this went unnoticed.
 *
 * Matching core's names is correct under all three.
 */
const TABLE = Object.freeze({
  SERVER: 'DBLog_Servers',
  MATCH: 'DBLog_Matches',
  PLAYER: 'DBLog_Players',
  WOUND: 'DBLog_Wounds',
  DEATH: 'DBLog_Deaths',
  REVIVE: 'DBLog_Revives',
  TICKRATE: 'DBLog_TickRates',
  PLAYERCOUNT: 'DBLog_PlayerCounts'
});

/**
 * Does `existing` already contain this table, ignoring identifier case?
 *
 * `showAllTables()` reports the names the engine actually stores, and those are
 * not always the names we asked for: MySQL with lower_case_table_names=1 folds
 * every table name to lowercase on disk, so a server whose data was created by
 * core's db-log reports `dblog_wounds` even though core asked for
 * `DBLog_Wounds`. An exact-match guard would conclude the table is missing,
 * issue a CREATE, and abort the migration on "table already exists".
 *
 * @param {Array<string|{tableName:string}>} existing - showAllTables() result
 * @param {string} name - The table name this migration would create
 * @returns {boolean}
 */
function tableExists(existing, name) {
  const target = name.toLowerCase();
  return existing.some((entry) => {
    const actual = typeof entry === 'string' ? entry : entry?.tableName;
    return typeof actual === 'string' && actual.toLowerCase() === target;
  });
}

const MODEL = Object.freeze({
  SERVER: 'DBLog_Server',
  MATCH: 'DBLog_Match',
  PLAYER: 'DBLog_Player',
  WOUND: 'DBLog_Wound',
  DEATH: 'DBLog_Death',
  REVIVE: 'DBLog_Revive',
  TICKRATE: 'DBLog_TickRate',
  PLAYERCOUNT: 'DBLog_PlayerCount'
});

const UTF8MB4 = { charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci' };

export default class DBLog extends S3PluginBase {
  static get description() {
    return (
      'S³-backed port of core SquadJS\'s db-log.js — logs tick rate, player counts, ' +
      'matches, wounds, deaths, and revives to the database for stat tracking and ' +
      'external tooling (Grafana). Every write is guarded through S³\'s DB service, so ' +
      'a DB outage degrades to logged, skipped writes instead of an unhandled-rejection ' +
      'storm.' +
      '\n\n' +
      'Grafana:\n' +
      '<ul><li> <a href="https://grafana.com/">Grafana</a> is a cool way of viewing server statistics stored in the database.</li>\n' +
      '<li>Install Grafana.</li>\n' +
      '<li>Add your database as a datasource named <code>SquadJS</code>.</li>\n' +
      '<li>Import the <a href="https://github.com/Team-Silver-Sphere/SquadJS/blob/master/squad-server/templates/SquadJS-Dashboard-v2.json">SquadJS Dashboard</a> to get a preconfigured MySQL only Grafana dashboard.</li>\n' +
      '<li>Install any missing Grafana plugins.</li></ul>'
    );
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      overrideServerID: {
        required: false,
        description: 'An overridden server ID, for multi-server setups sharing one database.',
        default: null
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.match = null;

    this.listeners = {};
    this.listeners.onTickRate = this.onTickRate.bind(this);
    this.listeners.onUpdatedA2SInformation = this.onUpdatedA2SInformation.bind(this);
    this.listeners.onNewGame = this.onNewGame.bind(this);
    this.listeners.onPlayerConnected = this.onPlayerConnected.bind(this);
    this.listeners.onPlayerWounded = this.onPlayerWounded.bind(this);
    this.listeners.onPlayerDied = this.onPlayerDied.bind(this);
    this.listeners.onPlayerRevived = this.onPlayerRevived.bind(this);
  }

  /** Resolves the server id to attach to every row — a plain property read, not a DB call. */
  get _serverId() {
    return this.options.overrideServerID || this.server.id;
  }

  _checkS3Version() {
    // Baseline only — defineModel/registerMigrations/_withDb/_getModel have
    // been present since S³ 1.0.0, same floor as SmartAssign/TeamBalancer.
    const required = '1.0.0';
    const actual = this._s3?.version;
    if (!this._s3VersionAtLeast(required)) {
      throw new Error(
        `[DBLog] Incompatible S³ version: got ${actual || 'unknown'}, need >=${required}. ` +
        'Please update SlackersSquadServices.'
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  LIFECYCLE
  // ═══════════════════════════════════════════════════════════════

  async _onS3Ready() {
    this._checkS3Version();

    if (!this.s3db || !this.s3db.isReady()) {
      this.verbose(1, '[DBLog] S³ DB service not available — plugin will not log anything.');
      return;
    }

    this._defineModels();
    this._registerMigrations();
    await this.verifyAndRunMigrations(PLUGIN_NAME);

    const serverId = this._serverId;

    await this._withDb(async (t) => {
      await this._getModel(MODEL.SERVER).upsert(
        { id: serverId, name: this.server.serverName },
        { transaction: t }
      );
    });

    this.match = await this._withDb(async (t) => {
      return this._getModel(MODEL.MATCH).findOne({
        where: { server: serverId, endTime: null },
        transaction: t
      });
    });

    this.server.on('TICK_RATE', this.listeners.onTickRate);
    this.server.on('UPDATED_A2S_INFORMATION', this.listeners.onUpdatedA2SInformation);
    this.server.on('NEW_GAME', this.listeners.onNewGame);
    this.server.on('PLAYER_CONNECTED', this.listeners.onPlayerConnected);
    this.server.on('PLAYER_WOUNDED', this.listeners.onPlayerWounded);
    this.server.on('PLAYER_DIED', this.listeners.onPlayerDied);
    this.server.on('PLAYER_REVIVED', this.listeners.onPlayerRevived);

    this.verbose(1, '[DBLog] Plugin mounted and listening.');
  }

  async _onUnmount() {
    this.server.removeListener('TICK_RATE', this.listeners.onTickRate);
    this.server.removeListener('UPDATED_A2S_INFORMATION', this.listeners.onUpdatedA2SInformation);
    this.server.removeListener('NEW_GAME', this.listeners.onNewGame);
    this.server.removeListener('PLAYER_CONNECTED', this.listeners.onPlayerConnected);
    this.server.removeListener('PLAYER_WOUNDED', this.listeners.onPlayerWounded);
    this.server.removeListener('PLAYER_DIED', this.listeners.onPlayerDied);
    this.server.removeListener('PLAYER_REVIVED', this.listeners.onPlayerRevived);
  }

  // ═══════════════════════════════════════════════════════════════
  //  MODELS
  // ═══════════════════════════════════════════════════════════════

  _defineModels() {
    const DataTypes = this.s3db.getDataTypes();

    this.defineModel(MODEL.SERVER, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      name: { type: DataTypes.STRING }
    }, { tableName: TABLE.SERVER, timestamps: false, exportTier: 'logging' });

    this.defineModel(MODEL.MATCH, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      server: { type: DataTypes.INTEGER, allowNull: false },
      dlc: { type: DataTypes.STRING },
      mapClassname: { type: DataTypes.STRING },
      layerClassname: { type: DataTypes.STRING },
      map: { type: DataTypes.STRING },
      layer: { type: DataTypes.STRING },
      startTime: { type: DataTypes.DATE, allowNull: false },
      endTime: { type: DataTypes.DATE },
      winner: { type: DataTypes.STRING }
    }, { tableName: TABLE.MATCH, timestamps: false, exportTier: 'logging' });

    this.defineModel(MODEL.TICKRATE, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      server: { type: DataTypes.INTEGER, allowNull: false },
      match: { type: DataTypes.INTEGER, allowNull: true },
      time: { type: DataTypes.DATE, allowNull: false },
      tickRate: { type: DataTypes.FLOAT, allowNull: false }
    }, { tableName: TABLE.TICKRATE, timestamps: false, exportTier: 'logging' });

    this.defineModel(MODEL.PLAYERCOUNT, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      server: { type: DataTypes.INTEGER, allowNull: false },
      match: { type: DataTypes.INTEGER, allowNull: true },
      time: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
      players: { type: DataTypes.INTEGER, allowNull: false },
      publicQueue: { type: DataTypes.INTEGER, allowNull: false },
      reserveQueue: { type: DataTypes.INTEGER, allowNull: false }
    }, { tableName: TABLE.PLAYERCOUNT, timestamps: false, exportTier: 'logging' });

    this.defineModel(MODEL.PLAYER, {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      eosID: { type: DataTypes.STRING, unique: true },
      steamID: { type: DataTypes.STRING, allowNull: false, unique: true },
      lastName: { type: DataTypes.STRING },
      lastIP: { type: DataTypes.STRING }
    }, { tableName: TABLE.PLAYER, timestamps: false, exportTier: 'historical', ...UTF8MB4 });

    const combatColumns = (DT) => ({
      id: { type: DT.INTEGER, primaryKey: true, autoIncrement: true },
      server: { type: DT.INTEGER, allowNull: false },
      match: { type: DT.INTEGER, allowNull: true },
      time: { type: DT.DATE, allowNull: false },
      victim: { type: DT.STRING, allowNull: true },
      victimName: { type: DT.STRING },
      victimTeamID: { type: DT.INTEGER },
      victimSquadID: { type: DT.INTEGER },
      attacker: { type: DT.STRING, allowNull: true },
      attackerName: { type: DT.STRING },
      attackerTeamID: { type: DT.INTEGER },
      attackerSquadID: { type: DT.INTEGER },
      damage: { type: DT.FLOAT },
      weapon: { type: DT.STRING },
      teamkill: { type: DT.BOOLEAN }
    });

    this.defineModel(MODEL.WOUND, combatColumns(DataTypes), {
      tableName: TABLE.WOUND, timestamps: false, exportTier: 'logging', ...UTF8MB4
    });

    this.defineModel(MODEL.DEATH, {
      ...combatColumns(DataTypes),
      woundTime: { type: DataTypes.DATE }
    }, { tableName: TABLE.DEATH, timestamps: false, exportTier: 'logging', ...UTF8MB4 });

    this.defineModel(MODEL.REVIVE, {
      ...combatColumns(DataTypes),
      woundTime: { type: DataTypes.DATE },
      reviver: { type: DataTypes.STRING, allowNull: true },
      reviverName: { type: DataTypes.STRING },
      reviverTeamID: { type: DataTypes.INTEGER },
      reviverSquadID: { type: DataTypes.INTEGER }
    }, { tableName: TABLE.REVIVE, timestamps: false, exportTier: 'logging', ...UTF8MB4 });
  }

  _registerMigrations() {
    this.registerExpectedVersion(PLUGIN_NAME, SCHEMA_VERSION, {
      models: [MODEL.SERVER, MODEL.MATCH, MODEL.PLAYER, MODEL.WOUND, MODEL.DEATH, MODEL.REVIVE, MODEL.TICKRATE, MODEL.PLAYERCOUNT]
    });

    this.registerMigrations(PLUGIN_NAME, [
      {
        version: 1,
        description: 'Create DBLog_Servers, DBLog_Matches, DBLog_Players, DBLog_Wounds, DBLog_Deaths, DBLog_Revives, DBLog_TickRates, DBLog_PlayerCounts',
        // No pre-migration backup needed — every createTable is wrapped in an
        // idempotent `!existing.includes()` guard, so on a live server with
        // pre-existing DBLog_* tables (created by the core db-log plugin this
        // replaces), zero DDL runs. On a fresh install, createTable is atomic
        // and the only thing at risk is an empty table. A `tier: 'all'` JSON
        // export loads every row of every model into memory — years of stats
        // in the DBLog_Wounds / DBLog_TickRates / etc. tables — and will OOM
        // a Node.js process before the migration ever touches SQL.
        backup: false,
        touches: {
          creates: [TABLE.SERVER, TABLE.MATCH, TABLE.PLAYER, TABLE.WOUND, TABLE.DEATH, TABLE.REVIVE, TABLE.TICKRATE, TABLE.PLAYERCOUNT]
        },
        up: async (qi) => {
          const DT = qi.DataTypes;
          const existing = await qi.showAllTables();

          if (!tableExists(existing, TABLE.SERVER)) {
            await qi.createTable(TABLE.SERVER, {
              id: { type: DT.INTEGER, primaryKey: true, autoIncrement: true },
              name: { type: DT.STRING }
            }, { timestamps: false });
          }

          if (!tableExists(existing, TABLE.MATCH)) {
            await qi.createTable(TABLE.MATCH, {
              id: { type: DT.INTEGER, primaryKey: true, autoIncrement: true },
              server: { type: DT.INTEGER, allowNull: false },
              dlc: { type: DT.STRING },
              mapClassname: { type: DT.STRING },
              layerClassname: { type: DT.STRING },
              map: { type: DT.STRING },
              layer: { type: DT.STRING },
              startTime: { type: DT.DATE, allowNull: false },
              endTime: { type: DT.DATE },
              winner: { type: DT.STRING }
            }, { timestamps: false });
          }

          if (!tableExists(existing, TABLE.TICKRATE)) {
            await qi.createTable(TABLE.TICKRATE, {
              id: { type: DT.INTEGER, primaryKey: true, autoIncrement: true },
              server: { type: DT.INTEGER, allowNull: false },
              match: { type: DT.INTEGER, allowNull: true },
              time: { type: DT.DATE, allowNull: false },
              tickRate: { type: DT.FLOAT, allowNull: false }
            }, { timestamps: false });
          }

          if (!tableExists(existing, TABLE.PLAYERCOUNT)) {
            await qi.createTable(TABLE.PLAYERCOUNT, {
              id: { type: DT.INTEGER, primaryKey: true, autoIncrement: true },
              server: { type: DT.INTEGER, allowNull: false },
              match: { type: DT.INTEGER, allowNull: true },
              time: { type: DT.DATE, allowNull: false, defaultValue: DT.NOW },
              players: { type: DT.INTEGER, allowNull: false },
              publicQueue: { type: DT.INTEGER, allowNull: false },
              reserveQueue: { type: DT.INTEGER, allowNull: false }
            }, { timestamps: false });
          }

          if (!tableExists(existing, TABLE.PLAYER)) {
            await qi.createTable(TABLE.PLAYER, {
              id: { type: DT.INTEGER, primaryKey: true, autoIncrement: true },
              eosID: { type: DT.STRING, unique: true },
              steamID: { type: DT.STRING, allowNull: false, unique: true },
              lastName: { type: DT.STRING },
              lastIP: { type: DT.STRING }
            }, { timestamps: false, ...UTF8MB4 });
          }

          const combatColumns = () => ({
            id: { type: DT.INTEGER, primaryKey: true, autoIncrement: true },
            server: { type: DT.INTEGER, allowNull: false },
            match: { type: DT.INTEGER, allowNull: true },
            time: { type: DT.DATE, allowNull: false },
            victim: { type: DT.STRING, allowNull: true },
            victimName: { type: DT.STRING },
            victimTeamID: { type: DT.INTEGER },
            victimSquadID: { type: DT.INTEGER },
            attacker: { type: DT.STRING, allowNull: true },
            attackerName: { type: DT.STRING },
            attackerTeamID: { type: DT.INTEGER },
            attackerSquadID: { type: DT.INTEGER },
            damage: { type: DT.FLOAT },
            weapon: { type: DT.STRING },
            teamkill: { type: DT.BOOLEAN }
          });

          if (!tableExists(existing, TABLE.WOUND)) {
            await qi.createTable(TABLE.WOUND, combatColumns(), { timestamps: false, ...UTF8MB4 });
          }

          if (!tableExists(existing, TABLE.DEATH)) {
            await qi.createTable(TABLE.DEATH, {
              ...combatColumns(),
              woundTime: { type: DT.DATE }
            }, { timestamps: false, ...UTF8MB4 });
          }

          if (!tableExists(existing, TABLE.REVIVE)) {
            await qi.createTable(TABLE.REVIVE, {
              ...combatColumns(),
              woundTime: { type: DT.DATE },
              reviver: { type: DT.STRING, allowNull: true },
              reviverName: { type: DT.STRING },
              reviverTeamID: { type: DT.INTEGER },
              reviverSquadID: { type: DT.INTEGER }
            }, { timestamps: false, ...UTF8MB4 });
          }
        },
        down: async (qi) => {
          await qi.dropTable(TABLE.REVIVE);
          await qi.dropTable(TABLE.DEATH);
          await qi.dropTable(TABLE.WOUND);
          await qi.dropTable(TABLE.PLAYER);
          await qi.dropTable(TABLE.PLAYERCOUNT);
          await qi.dropTable(TABLE.TICKRATE);
          await qi.dropTable(TABLE.MATCH);
          await qi.dropTable(TABLE.SERVER);
        }
      }
    ]);
  }

  // ═══════════════════════════════════════════════════════════════
  //  PLAYER IDENTITY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Upserts a player identity row by steamID. Every failure mode (lock
   * contention, connection timeout, unique-constraint race) is caught by
   * `_withDb()` and logged, never thrown — this is the reference shape
   * every other write in this file follows.
   */
  async ensurePlayer(playerData, extra = {}) {
    if (!playerData || !playerData.steamID) return null;

    return this._withDb(async (t) => {
      const model = this._getModel(MODEL.PLAYER);
      try {
        const [player, created] = await model.findOrCreate({
          where: { steamID: playerData.steamID },
          defaults: {
            eosID: playerData.eosID,
            lastName: playerData.name,
            ...extra
          },
          transaction: t
        });

        if (!created) {
          await player.update({
            eosID: playerData.eosID,
            lastName: playerData.name,
            ...extra
          }, { transaction: t });
        }
        return player;
      } catch (err) {
        // Race: a concurrent call inserted the row between findOrCreate's
        // SELECT and INSERT. Fall back to find + update.
        if (err.name === 'SequelizeUniqueConstraintError') {
          const player = await model.findOne({
            where: { steamID: playerData.steamID },
            transaction: t
          });
          if (player) {
            await player.update({
              eosID: playerData.eosID,
              lastName: playerData.name,
              ...extra
            }, { transaction: t });
            return player;
          }
        }
        throw err;
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════════

  async onTickRate(info) {
    const serverId = this._serverId;
    await this._withDb(async (t) => {
      await this._getModel(MODEL.TICKRATE).create({
        server: serverId,
        match: this.match ? this.match.id : null,
        time: info.time,
        tickRate: info.tickRate
      }, { transaction: t });
    });
  }

  async onUpdatedA2SInformation(info) {
    const serverId = this._serverId;
    await this._withDb(async (t) => {
      await this._getModel(MODEL.PLAYERCOUNT).create({
        server: serverId,
        match: this.match ? this.match.id : null,
        players: info.a2sPlayerCount,
        publicQueue: info.publicQueue,
        reserveQueue: info.reserveQueue
      }, { transaction: t });
    });
  }

  /**
   * Closes the previous round's match row, then opens a new one. The two
   * calls are independent (matching core's behavior — not atomic), but
   * unlike core, a failed `create()` explicitly nulls out `this.match`
   * instead of leaving it pointing at the previous round's row. Without
   * this, every Wound/Death/Revive/TickRate/PlayerCount logged before the
   * next successful create would silently attach to the wrong match id —
   * corrupting the round attribution of every stat derived from them, with
   * nothing in the logs to indicate it had happened.
   */
  async onNewGame(info) {
    const serverId = this._serverId;

    await this._withDb(async (t) => {
      await this._getModel(MODEL.MATCH).update(
        { endTime: info.time, winner: info.winner },
        { where: { server: serverId, endTime: null }, transaction: t }
      );
    });

    const newMatch = await this._withDb(async (t) => {
      return this._getModel(MODEL.MATCH).create({
        server: serverId,
        dlc: info.dlc,
        mapClassname: info.mapClassname,
        layerClassname: info.layerClassname,
        map: info.layer ? info.layer.map.name : null,
        layer: info.layer ? info.layer.name : null,
        startTime: info.time
      }, { transaction: t });
    });

    if (newMatch) {
      this.match = newMatch;
    } else {
      this.match = null;
      this.reportError(
        'DBLog',
        'Match.create() failed in onNewGame — this.match set to null. Rows logged this ' +
        'round will carry match=null until the next successful round transition, rather ' +
        'than silently attaching to the previous round.'
      );
    }
  }

  async onPlayerWounded(info) {
    await this.ensurePlayer(info.attacker);
    await this.ensurePlayer(info.victim);

    const serverId = this._serverId;
    await this._withDb(async (t) => {
      await this._getModel(MODEL.WOUND).create({
        server: serverId,
        match: this.match ? this.match.id : null,
        time: info.time,
        victim: info.victim ? info.victim.steamID : null,
        victimName: info.victim ? info.victim.name : null,
        victimTeamID: info.victim ? info.victim.teamID : null,
        victimSquadID: info.victim ? info.victim.squadID : null,
        attacker: info.attacker ? info.attacker.steamID : null,
        attackerName: info.attacker ? info.attacker.name : null,
        attackerTeamID: info.attacker ? info.attacker.teamID : null,
        attackerSquadID: info.attacker ? info.attacker.squadID : null,
        damage: info.damage,
        weapon: info.weapon,
        teamkill: info.teamkill
      }, { transaction: t });
    });
  }

  async onPlayerDied(info) {
    await this.ensurePlayer(info.attacker);
    await this.ensurePlayer(info.victim);

    const serverId = this._serverId;
    await this._withDb(async (t) => {
      await this._getModel(MODEL.DEATH).create({
        server: serverId,
        match: this.match ? this.match.id : null,
        time: info.time,
        woundTime: info.woundTime,
        victim: info.victim ? info.victim.steamID : null,
        victimName: info.victim ? info.victim.name : null,
        victimTeamID: info.victim ? info.victim.teamID : null,
        victimSquadID: info.victim ? info.victim.squadID : null,
        attacker: info.attacker ? info.attacker.steamID : null,
        attackerName: info.attacker ? info.attacker.name : null,
        attackerTeamID: info.attacker ? info.attacker.teamID : null,
        attackerSquadID: info.attacker ? info.attacker.squadID : null,
        damage: info.damage,
        weapon: info.weapon,
        teamkill: info.teamkill
      }, { transaction: t });
    });
  }

  async onPlayerRevived(info) {
    await this.ensurePlayer(info.attacker);
    await this.ensurePlayer(info.victim);
    await this.ensurePlayer(info.reviver);

    const serverId = this._serverId;
    await this._withDb(async (t) => {
      await this._getModel(MODEL.REVIVE).create({
        server: serverId,
        match: this.match ? this.match.id : null,
        time: info.time,
        woundTime: info.woundTime,
        victim: info.victim ? info.victim.steamID : null,
        victimName: info.victim ? info.victim.name : null,
        victimTeamID: info.victim ? info.victim.teamID : null,
        victimSquadID: info.victim ? info.victim.squadID : null,
        attacker: info.attacker ? info.attacker.steamID : null,
        attackerName: info.attacker ? info.attacker.name : null,
        attackerTeamID: info.attacker ? info.attacker.teamID : null,
        attackerSquadID: info.attacker ? info.attacker.squadID : null,
        damage: info.damage,
        weapon: info.weapon,
        teamkill: info.teamkill,
        reviver: info.reviver ? info.reviver.steamID : null,
        reviverName: info.reviver ? info.reviver.name : null,
        reviverTeamID: info.reviver ? info.reviver.teamID : null,
        reviverSquadID: info.reviver ? info.reviver.squadID : null
      }, { transaction: t });
    });
  }

  async onPlayerConnected(info) {
    await this.ensurePlayer(info.player, { lastIP: info.ip });
  }
}
