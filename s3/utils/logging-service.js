/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           LOGGING SERVICE                                     ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Shared S³ logging/audit service that replaces per-plugin logging
 * tables (SA_PlayerEvent, SA_RoundSummary) with three standardised
 * tables: S3_PlayerEvents, S3_GameStateEvents, and S3_PlayerSnapshots.
 * All consumer plugins can write generic events here and cross-reference
 * by matchId.
 *
 * ─── TABLES ──────────────────────────────────────────────────────
 *
 * S3_PlayerEvents
 *   Generic cross-plugin player events (JOIN, LEAVE, TEAM_CHANGE).
 *   SA delegates generic events here but keeps SA-specific assignment
 *   decisions in its own SA_AssignmentLog.
 *
 * S3_GameStateEvents
 *   Event-stream of server state transitions — every phase change
 *   (STAGING→LIVE, LIVE→ENDGAME, ENDGAME→STAGING, etc.) gets its
 *   own row. Crash-recovery transitions are captured as additional
 *   rows with their own timestamps.
 *
 * S3_PlayerSnapshots
 *   Full-server roster snapshots taken at three trigger points per
 *   round: on LIVE phase, ~25 minutes after LIVE (mid-round), and
 *   on ENDGAME event. Enables historical "what did the teams look
 *   like at this moment" queries.
 *
 * ─── SCOPING (multi-server) ─────────────────────────────────────
 *
 * All three tables are server-column scoped: every row belongs to
 * the server whose process wrote it, stamped from
 * dbService.getServerID() at write time and declared to S³ as
 * scopeKind: 'server-column' at defineModel(). A community sharing
 * one database gets one table per event type with rows from every
 * server in it, and a scoped export narrows on the column rather
 * than on which process wrote the rows.
 *
 * Two details in the model definitions below are easy to undo by
 * accident and both carry their reasoning at the declaration.
 * serverID is absent from the three schema CONSTANTS and present
 * only in the live schemas spread from them, because the constants
 * are what s3-logging v1's touches.columns declares and v1 is a
 * bootstrap for tables that already hold production rows — a
 * serverID in that list fails v1 on the exact database v1 exists to
 * adopt. And the serverID indexes are named for their tables rather
 * than idx_serverID, because Postgres scopes index names to the
 * schema rather than to the table.
 *
 * Model names are not table names here: S3PlayerEvents,
 * S3GameStateEvents and S3PlayerSnapshots over S3_PlayerEvents,
 * S3_GameStateEvents and S3_PlayerSnapshots. The export registry,
 * scopePredicateFor() and the version fixtures all key on the MODEL
 * name; a schema dump shows the table name. Reaching for the wrong
 * one of the two is the mistake this note exists to prevent.
 *
 * ─── FILE MIRROR ────────────────────────────────────────────────
 *
 * When enableFileLogging is true, every DB write is mirrored as a
 * self-contained JSONL line to the configured logPath. Each line
 * carries a `table` field identifying which S³ table the line
 * mirrors, plus all relevant context (matchId, roundStartTime,
 * team counts, etc.) so the file is independently joinable.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * LoggingService (class, default)
 *   mount()                     — Initialises models, subscribes to events.
 *   unmount()                   — Cleans up timers, unsubscribes events, flushes JSONL.
 *   isReady()                   — Returns true when service is mounted.
 *   logPlayerEvent(e, p, m)    — Manually log a player event (public API).
 *   logGameStateEvent(e, o, n) — Manually log a game state event.
 *   snapshot(m, t, pl)         — Manually trigger a roster snapshot.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * DBService (constructor arg) — for Sequelize models and transactions.
 * GameStateService (constructor arg) — for phase change subscriptions.
 * Server EventEmitter (constructor arg) — for S3_PLAYER_* events.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - All three tables are behind the enableDatabaseLogging config toggle.
 * - File mirror is behind enableFileLogging — independent of DB toggle.
 * - Runs in no-op mode when logging is disabled or DB is unavailable.
 * - The MID_ROUND snapshot timer fires 25 minutes after LIVE, cancelled
 *   on ENDGAME. If the round ends before 25 minutes, no MID_ROUND row.
 * - All snapshots are opt-in behind enableDatabaseLogging.
 * - Exposes public logPlayerEvent/logGameStateEvent/snapshot methods
 *   so the SA migration (7.4i) can delegate calls without direct
 *   event subscription coupling.
 * - serverID is stamped nullable and no notNull post-condition is
 *   declared on it. A data post-condition is re-checked on every
 *   mount forever, so one row-creating path that forgot the column
 *   would put S³ core into a rollback-and-re-gate loop rather than
 *   failing once. Rows written by a pre-upgrade process legitimately
 *   carry null, and a scoped read treats those as nobody's rather
 *   than as everybody's.
 * - The serverID indexes are created separately from the columns and
 *   gated on the column existing, because on a create-only grant the
 *   column may not have arrived yet. Nothing here assumes the
 *   migration that adds it was run by this process.
 *
 */

import { promises as fsPromises } from 'fs';
import { stderrWarn } from './s3-stderr.js';

const MID_ROUND_SNAPSHOT_DELAY_MS = 25 * 60 * 1000; // 25 minutes

export default class LoggingService {
  constructor({
    parent = null,
    server,
    verboseLogger = () => {},
    dbService = null,
    gameState = null,
    enableDatabaseLogging = false,
    enableFileLogging = false,
    logPath = './s3-log.jsonl'
  } = {}) {
    this.parent = parent;
    this.server = server;
    this.verboseLogger = verboseLogger;
    this.dbService = dbService;
    this.gameState = gameState;
    this.enableDatabaseLogging = enableDatabaseLogging;
    this.enableFileLogging = enableFileLogging;
    this.logPath = logPath;

    this._isMounted = false;
    this._midRoundTimer = null;

    // Sequelize models (set in _initModels)
    this.PlayerEventsModel = null;
    this.GameStateEventsModel = null;
    this.PlayerSnapshotsModel = null;

    // Subscription references for cleanup
    this._unsubPhaseChange = null;
    this._unsubLayerChange = null;
    this._unsubResolvingChange = null;

    this._eventListeners = {};

    // Write queue to serialise JSONL appends
    this._writeQueue = Promise.resolve();
  }

  /* ────────────────────────────────────── LIFECYCLE ────────────────────────────────────── */

  async mount() {
    if (this._isMounted) {
      await this.unmount();
    }

    if (!this.enableDatabaseLogging && !this.enableFileLogging) {
      this._isMounted = true;
      this.verboseLogger(2, '[Logging] Database + file logging both disabled. Running in no-op mode.');
      return;
    }

    if (!this.enableDatabaseLogging) {
      this._isMounted = true;
      this.verboseLogger(2, '[Logging] Database logging disabled. File-only mode.');
      // File-only mode still subscribes to events for JSONL mirroring
      if (this.server && this.gameState) {
        this._subscribeEvents();
      }
      return;
    }

    if (!this.dbService?.isReady?.() || !this.dbService.getConnector()) {
      this._isMounted = true;
      this.verboseLogger(2, '[Logging] DB service not ready. Running in file-only mode if enabled.');
      // File-only mode still subscribes to events
      if (this.enableFileLogging && this.server && this.gameState) {
        this._subscribeEvents();
      }
      return;
    }

    await this._initModels();
    this._subscribeEvents();

    this._isMounted = true;
    this.verboseLogger(2, `[Logging] Mounted with S3_PlayerEvents, S3_GameStateEvents, S3_PlayerSnapshots tables.${this.enableFileLogging ? ` JSONL mirror → ${this.logPath}` : ''}`);
  }

  async unmount() {
    this._clearMidRoundTimer();
    this._unsubscribeEvents();
    await this._flushJsonl();

    this._isMounted = false;
    this.verboseLogger(2, '[Logging] Unmounted.');
  }

  isReady() {
    return this._isMounted;
  }

  /* ────────────────────────────────────── PUBLIC API ────────────────────────────────────── */

  /**
   * Log a player event. Can be called by consumer plugins directly (7.4i) or
   * triggered automatically via S3_PLAYER_* events.
   *
   * JSONL mirror: When enableFileLogging is true, each event is also appended
   * as one JSONL line to the configured logPath. Lines are self-contained with
   * all context (matchId, roundStartTime, ts, team counts, etc.).
   *
   * @param {string}  eventType  - 'JOIN', 'LEAVE', 'TEAM_CHANGE'
   * @param {Object}  player     - Player object with eosID, steamID, name, teamID, squadID
   * @param {Object}  [metadata] - Additional context
   * @param {number}  [metadata.oldTeamID]
   * @param {number}  [metadata.newTeamID]
   * @param {string}  [metadata.source]   - 'SmartAssign', 'Switch', 'Manual', 'Game'
   * @param {boolean} [metadata.betweenRounds]
   * @param {number}  [metadata.t1]       - Team 1 population
   * @param {number}  [metadata.t2]       - Team 2 population
   */
  async logPlayerEvent(eventType, player, metadata = {}) {
    if (!this._isMounted && !this.enableFileLogging) return;

    const roundStartTime = this.gameState?.getRoundStartTime?.() ?? null;
    const matchId = this.gameState?.getMatchId?.() ?? null;

    // ── JSONL mirror (fire-and-forget) — independent of DB availability ──
    if (this.enableFileLogging) {
      this._appendJsonl({
        ts: Date.now(),
        table: 'S3_PlayerEvents',
        eventType,
        matchId,
        roundStartTime,
        eosID: player?.eosID || null,
        steamID: player?.steamID || null,
        name: player?.name || null,
        teamID: player?.teamID != null ? Number(player.teamID) : null,
        squadID: player?.squadID != null ? Number(player.squadID) : null,
        oldTeamID: metadata.oldTeamID != null ? Number(metadata.oldTeamID) : null,
        newTeamID: metadata.newTeamID != null ? Number(metadata.newTeamID) : null,
        source: metadata.source || null,
        betweenRounds: metadata.betweenRounds ? 1 : 0,
        t1: metadata.t1 != null ? Number(metadata.t1) : null,
        t2: metadata.t2 != null ? Number(metadata.t2) : null
      });
    }

    // DB write (no-op if not mounted or model not ready)
    if (!this._isMounted || !this.PlayerEventsModel) return;

    try {
      await this.dbService.executeWithRetry(async () => {
        await this.PlayerEventsModel.create({
          // Read per write rather than cached at mount. getServerID() is a
          // field read, the cost is nothing, and a cached copy would be a
          // second place for the id to be wrong. `?? null` because a row
          // stamped with an id this process never resolved is worse than an
          // honestly unattributed one — the column is nullable for exactly
          // this.
          serverID: this.dbService?.getServerID?.() ?? null,
          matchId,
          roundStartTime,
          ts: Date.now(),
          eventType,
          eosID: player?.eosID || null,
          steamID: player?.steamID || null,
          name: player?.name || null,
          teamID: player?.teamID != null ? Number(player.teamID) : null,
          squadID: player?.squadID != null ? Number(player.squadID) : null,
          oldTeamID: metadata.oldTeamID != null ? Number(metadata.oldTeamID) : null,
          newTeamID: metadata.newTeamID != null ? Number(metadata.newTeamID) : null,
          source: metadata.source || null,
          betweenRounds: metadata.betweenRounds ? 1 : 0,
          t1: metadata.t1 != null ? Number(metadata.t1) : null,
          t2: metadata.t2 != null ? Number(metadata.t2) : null
        });
      });
    } catch (err) {
      this.verboseLogger(1, `[Logging] Failed to log player event: ${err.message}`);
    }
  }

  /**
   * Log a game state event. Can be called directly or triggered automatically
   * via gameState.onGamePhaseChange().
   *
   * @param {string} eventType  - 'PHASE_CHANGE', 'RESOLVING_CLEARED', 'CRASH_RECOVERY', 'SERVER_START', 'SERVER_STOP'
   * @param {string} [oldPhase] - Previous phase (null for SERVER_START)
   * @param {string} [newPhase] - New phase (null for SERVER_STOP)
   * @param {Object} [metadata]
   * @param {boolean} [metadata.resolving]
   * @param {number}  [metadata.durationMs] - JSONL mirror only; see below.
   *
   * ── RESOLVING_CLEARED uses the phase columns for the sub-state ──
   * The event is a transition of `resolving`, not of `phase`, so it is written
   * as oldPhase='RESOLVING' and newPhase=the reason it ended
   * ('PLAYERS_RESOLVED' | 'ROSTER_FALLBACK' | 'BUDGET_EXPIRED' | 'ROUND_ENDED' |
   * 'RECOVERY_STALE' | 'RECOVERY_INVALIDATED').
   *
   * `durationMs` — the number the resolving-budget question actually needs —
   * reaches the JSONL mirror but NOT the table, which has no column for it.
   * Adding one is DDL, and the live MySQL user has no DDL grants: the model
   * would then name a column the server does not have and every game-state
   * write would fail on a path that logs and continues. From the table it is
   * derivable, since the round's opening row is written by this same method:
   *
   *   SELECT c.matchId, c.newPhase AS reason, c.ts - s.ts AS durationMs
   *     FROM S3_GameStateEvents c
   *     JOIN S3_GameStateEvents s
   *       ON s.matchId = c.matchId
   *      AND s.eventType = 'PHASE_CHANGE' AND s.newPhase = 'STAGING'
   *    WHERE c.eventType = 'RESOLVING_CLEARED';
   */
  async logGameStateEvent(eventType, oldPhase = null, newPhase = null, metadata = {}) {
    if (!this._isMounted && !this.enableFileLogging) return;

    const matchId = this.gameState?.getMatchId?.() ?? null;

    // ── JSONL mirror (fire-and-forget) — independent of DB availability ──
    if (this.enableFileLogging) {
      this._appendJsonl({
        ts: Date.now(),
        table: 'S3_GameStateEvents',
        eventType,
        matchId,
        oldPhase,
        newPhase,
        resolving: metadata.resolving ? 1 : 0,
        // Schemaless mirror, so the one field the table cannot hold lands here.
        ...(Number.isFinite(metadata.durationMs) ? { durationMs: metadata.durationMs } : {}),
        layerName: this.gameState?.getLayerName?.() ?? null,
        gamemode: this.gameState?.getGamemode?.() ?? null
      });
    }

    // DB write (no-op if not mounted or model not ready)
    if (!this._isMounted || !this.GameStateEventsModel) return;

    try {
      await this.dbService.executeWithRetry(async () => {
        await this.GameStateEventsModel.create({
          serverID: this.dbService?.getServerID?.() ?? null,
          matchId,
          ts: Date.now(),
          eventType,
          oldPhase,
          newPhase,
          resolving: metadata.resolving ? 1 : 0,
          layerName: this.gameState?.getLayerName?.() ?? null,
          gamemode: this.gameState?.getGamemode?.() ?? null
        });
      });
      // Confirms the row actually landed. The failure path above logs and
      // continues by design, so without a success line an absent row and a
      // rejected write look identical in the log.
      this.verboseLogger(
        4,
        `[Logging] S3_GameStateEvents row written: ${eventType} ${oldPhase} -> ${newPhase} (matchId=${matchId})`
      );
    } catch (err) {
      this.verboseLogger(1, `[Logging] Failed to log game state event: ${err.message}`);
    }
  }

  /**
   * Trigger a player roster snapshot. Records the full player list from
   * the PlayersService at the time of the call.
   *
   * @param {string} matchId  - Current round's matchId
   * @param {string} trigger  - 'LIVE', 'MID_ROUND', 'ENDGAME'
   * @param {Array}  [players] - Optional pre-fetched player list; if null,
   *                             fetches from PlayersService or server.players.
   */
  async snapshot(matchId, trigger, players = null) {
    if (!this._isMounted && !this.enableFileLogging) return;

    // Resolve player list if not provided
    if (!players) {
      const playersService = this.parent?.players || null;
      if (playersService?.getAllPlayers) {
        players = playersService.getAllPlayers();
      } else if (this.server?.players) {
        players = [...this.server.players];
      } else {
        this.verboseLogger(3, '[Logging] No player source available for snapshot.');
        return;
      }
    }

    if (!Array.isArray(players) || players.length === 0) {
      this.verboseLogger(3, `[Logging] Empty player list for snapshot (${trigger}). Skipping.`);
      return;
    }

    // Normalise each player to a consistent shape for JSON storage
    const normalised = players.map((p) => ({
      eosID: p.eosID || p.playerID || null,
      steamID: p.steamID || null,
      name: p.name || 'Unknown',
      teamID: p.teamID != null ? Number(p.teamID) : null,
      squadID: p.squadID != null ? Number(p.squadID) : null,
      isLeader: p.isLeader === true || p.isLeader === 'True'
    }));

    const t1 = normalised.filter((p) => p.teamID === 1).length;
    const t2 = normalised.filter((p) => p.teamID === 2).length;

    // ── JSONL mirror (fire-and-forget) — independent of DB availability ──
    if (this.enableFileLogging) {
      this._appendJsonl({
        ts: Date.now(),
        table: 'S3_PlayerSnapshots',
        matchId,
        trigger,
        playerCount: normalised.length,
        t1,
        t2
      });
    }

    // DB write (no-op if not mounted or model not ready)
    if (!this._isMounted || !this.PlayerSnapshotsModel) return;

    try {
      await this.dbService.executeWithRetry(async () => {
        await this.PlayerSnapshotsModel.create({
          serverID: this.dbService?.getServerID?.() ?? null,
          matchId,
          ts: Date.now(),
          trigger,
          playersJson: JSON.stringify(normalised),
          t1,
          t2
        });
      });

      this.verboseLogger(3, `[Logging] Snapshot (${trigger}): ${normalised.length} players (T1=${t1}, T2=${t2})`);
    } catch (err) {
      this.verboseLogger(1, `[Logging] Failed to snapshot players: ${err.message}`);
    }
  }

  /* ────────────────────────────────────── MODEL INIT ────────────────────────────────────── */

  async _initModels() {
    if (!this.dbService?.getConnector || !this.dbService.getConnector()) return;

    const DataTypes = this.dbService.getDataTypes();

    // All three models are registered through dbService.defineModel() rather than
    // raw sequelize.define(). Only defineModel() populates dbService.models, and
    // getModelNames() — which s3-export-import.js enumerates — reads exactly that.
    // Defined raw, these three tables were invisible to every export tier
    // including --all, so the forensic log never reached a single backup.
    //
    // The explicit `tableName` on each is load-bearing: defineModel() injects
    // freezeTableName: true, which makes the MODEL name the table name unless
    // tableName overrides it. Drop it and Sequelize targets 'S3PlayerEvents'
    // instead of 'S3_PlayerEvents' — a brand new table.
    //
    // Tables are created via queryInterface.createTable() + a manual CREATE
    // INDEX per declared index below — NOT Model.sync(). sync() issues CREATE
    // TABLE and then, for every declared index, a SEPARATE
    // `ALTER TABLE ... ADD INDEX`, even on a table it just created. A MySQL
    // grant with CREATE but not ALTER — a real, deliberately hardened live
    // profile, see the live-mysql-db-user-lacks-ddl-grants memory — accepts
    // the CREATE TABLE and then throws on the first index, aborting
    // _initModels() before the other two tables are even attempted. Confirmed
    // empirically against that exact grant: Model.sync() fails on every
    // mount; createTable() + a bare CREATE INDEX (never ALTER TABLE)
    // succeeds. createTable()'s own `indexes` option is silently a no-op on
    // MySQL — also confirmed empirically, not documented — so indexes are
    // created explicitly by _ensureIndexes() instead of being passed there.

    const playerEventsSchema = {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      matchId: { type: DataTypes.STRING, allowNull: true },
      roundStartTime: { type: DataTypes.BIGINT, allowNull: true },
      ts: { type: DataTypes.BIGINT, allowNull: false },
      eventType: { type: DataTypes.STRING, allowNull: false },
      eosID: { type: DataTypes.STRING, allowNull: true },
      steamID: { type: DataTypes.STRING, allowNull: true },
      name: { type: DataTypes.STRING, allowNull: true },
      teamID: { type: DataTypes.INTEGER, allowNull: true },
      squadID: { type: DataTypes.INTEGER, allowNull: true },
      oldTeamID: { type: DataTypes.INTEGER, allowNull: true },
      newTeamID: { type: DataTypes.INTEGER, allowNull: true },
      source: { type: DataTypes.STRING, allowNull: true },
      betweenRounds: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
      t1: { type: DataTypes.INTEGER, allowNull: true },
      t2: { type: DataTypes.INTEGER, allowNull: true }
    };
    // serverID is deliberately NOT in the three schema constants above.
    // Those constants are what s3-logging v1's touches.columns declares, and
    // v1 has not been applied on production — it is a bootstrap for tables
    // that already hold 144k rows. Verification re-checks every declared
    // column after v1 runs, so a serverID in that list would fail v1 on the
    // exact database v1 exists to adopt, before v2 could ever add it.
    //
    // The live schemas below carry it, so a fresh install gets the column
    // from the CREATE TABLE and needs no ALTER at all — which on a grant
    // without ALTER is the difference between installing and not.
    const SERVER_ID_COLUMN = { type: DataTypes.INTEGER, allowNull: true };
    const playerEventsLive = { ...playerEventsSchema, serverID: SERVER_ID_COLUMN };

    const playerEventsIndexes = [
      { name: 'idx_s3_pe_matchId', fields: ['matchId'] },
      { name: 'idx_s3_pe_eosID', fields: ['eosID'] },
      { name: 'idx_s3_pe_eventType_matchId', fields: ['eventType', 'matchId'] },
      { name: 'idx_s3_pe_ts', fields: ['ts'] }
    ];
    // Named for the table rather than idx_serverID, on all three. Postgres
    // scopes index names to the schema, not to the table, so nine tables
    // each carrying an index called idx_serverID is one name nine times.
    const playerEventsServerIdIndex = [{ name: 'S3_PlayerEvents_serverID', fields: ['serverID'] }];

    // ── S3_PlayerEvents ──────────────────────────────────────────
    this.PlayerEventsModel = this.dbService.defineModel(
      'S3PlayerEvents',
      playerEventsLive,
      {
        tableName: 'S3_PlayerEvents',
        timestamps: false,
        exportTier: 'logging',
        // Forensic rows about one server's players on one server's rounds.
        // The serverID column arrives with this group's scoping migration; the
        // classification is declared here first so nothing has to infer it.
        scopeKind: 'server-column',
        indexes: playerEventsIndexes
      }
    );

    const gameStateEventsSchema = {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      matchId: { type: DataTypes.STRING, allowNull: true },
      ts: { type: DataTypes.BIGINT, allowNull: false },
      eventType: { type: DataTypes.STRING, allowNull: false },
      oldPhase: { type: DataTypes.STRING, allowNull: true },
      newPhase: { type: DataTypes.STRING, allowNull: true },
      resolving: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
      layerName: { type: DataTypes.STRING, allowNull: true },
      gamemode: { type: DataTypes.STRING, allowNull: true }
    };
    const gameStateEventsLive = { ...gameStateEventsSchema, serverID: SERVER_ID_COLUMN };

    const gameStateEventsIndexes = [
      { name: 'idx_s3_gse_matchId', fields: ['matchId'] },
      { name: 'idx_s3_gse_eventType', fields: ['eventType'] },
      { name: 'idx_s3_gse_ts', fields: ['ts'] }
    ];
    const gameStateEventsServerIdIndex = [{ name: 'S3_GameStateEvents_serverID', fields: ['serverID'] }];

    // ── S3_GameStateEvents ───────────────────────────────────────
    this.GameStateEventsModel = this.dbService.defineModel(
      'S3GameStateEvents',
      gameStateEventsLive,
      {
        tableName: 'S3_GameStateEvents',
        timestamps: false,
        exportTier: 'logging',
        // Phase transitions of one server's rounds.
        scopeKind: 'server-column',
        indexes: gameStateEventsIndexes
      }
    );

    const playerSnapshotsSchema = {
      id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
      matchId: { type: DataTypes.STRING, allowNull: false },
      ts: { type: DataTypes.BIGINT, allowNull: false },
      trigger: { type: DataTypes.STRING, allowNull: false },
      playersJson: { type: DataTypes.TEXT, allowNull: false },
      t1: { type: DataTypes.INTEGER, allowNull: true },
      t2: { type: DataTypes.INTEGER, allowNull: true }
    };
    const playerSnapshotsLive = { ...playerSnapshotsSchema, serverID: SERVER_ID_COLUMN };

    const playerSnapshotsIndexes = [
      { name: 'idx_s3_ps_matchId_ts', fields: ['matchId', 'ts'] }
    ];
    const playerSnapshotsServerIdIndex = [{ name: 'S3_PlayerSnapshots_serverID', fields: ['serverID'] }];

    // ── S3_PlayerSnapshots ───────────────────────────────────────
    this.PlayerSnapshotsModel = this.dbService.defineModel(
      'S3PlayerSnapshots',
      playerSnapshotsLive,
      {
        tableName: 'S3_PlayerSnapshots',
        timestamps: false,
        exportTier: 'logging',
        // A roster of who was on one server at one moment.
        scopeKind: 'server-column',
        indexes: playerSnapshotsIndexes
      }
    );

    // Create tables (CREATE TABLE IF NOT EXISTS — needs only the CREATE grant).
    const qi = this.dbService.getConnector().getQueryInterface();
    await this.dbService.executeWithRetry(async () => {
      await qi.createTable('S3_PlayerEvents', playerEventsLive);
      await qi.createTable('S3_GameStateEvents', gameStateEventsLive);
      await qi.createTable('S3_PlayerSnapshots', playerSnapshotsLive);
    });

    await this._ensureIndexes('S3_PlayerEvents', playerEventsIndexes);
    await this._ensureIndexes('S3_GameStateEvents', gameStateEventsIndexes);
    await this._ensureIndexes('S3_PlayerSnapshots', playerSnapshotsIndexes);

    // The serverID indexes are gated on the column, and separately from the
    // three calls above, because of when this method runs. Migrations for
    // this group are driven by the core pending-loop in
    // slackers-squad-services.js, which runs AFTER every service has
    // mounted — so on the one mount where v2 adds the column, this line has
    // already gone past. Ungated, it would emit a stderr warning about an
    // unindexed table on the single mount where that is expected and
    // temporary, and operators read those warnings. The next mount creates
    // it, the same self-healing property _ensureIndexes already has.
    for (const [table, decl] of [
      ['S3_PlayerEvents', playerEventsServerIdIndex],
      ['S3_GameStateEvents', gameStateEventsServerIdIndex],
      ['S3_PlayerSnapshots', playerSnapshotsServerIdIndex]
    ]) {
      try {
        const live = await qi.describeTable(table);
        if (live.serverID) await this._ensureIndexes(table, decl);
      } catch (err) {
        this.verboseLogger(1, `[Logging] Could not check ${table} for a serverID index: ${err.message}`);
      }
    }

    // ── Migration group ──────────────────────────────────────────
    // These three were created by createTable() alone and belonged to no
    // registered group, so they had no recorded version and drift verification
    // never covered them — a column lost from S3_PlayerEvents would have gone
    // unnoticed indefinitely, on the largest S³-owned logging table there is.
    //
    // `models:` takes MODEL names, `touches` takes TABLE names, and all three
    // of these are among the nine in the repo where the two differ
    // (S3PlayerEvents → S3_PlayerEvents). Writing the model spelling into
    // `touches` names tables that do not exist, and verification then re-runs a
    // migration that already succeeded, forever.
    if (this.dbService?.migrationEngine) {
      this.dbService.migrationEngine.registerMigrations('s3-logging', [
        {
          version: 1,
          description: 'S3_PlayerEvents, S3_GameStateEvents and S3_PlayerSnapshots (bootstrap — DDL runs unconditionally at mount)',
          // createTable is CREATE TABLE IF NOT EXISTS and has already run above,
          // so there is no row this can lose. Backing up would mean reading the
          // biggest logging tables in the database to protect against nothing.
          backup: false,
          touches: {
            creates: ['S3_PlayerEvents', 'S3_GameStateEvents', 'S3_PlayerSnapshots'],
            columns: {
              S3_PlayerEvents: Object.keys(playerEventsSchema),
              S3_GameStateEvents: Object.keys(gameStateEventsSchema),
              S3_PlayerSnapshots: Object.keys(playerSnapshotsSchema)
            }
          },
          up: async (qi) => {
            // Idempotent, and run through qi so verification sees the tables on
            // the connection it reads from.
            await qi.createTable('S3_PlayerEvents', playerEventsSchema);
            await qi.createTable('S3_GameStateEvents', gameStateEventsSchema);
            await qi.createTable('S3_PlayerSnapshots', playerSnapshotsSchema);
          }
        },
        {
          version: 2,
          description: 'Add serverID to the three logging tables for multi-server scoping',
          // touches.columns only. No touches.data { notNull } on serverID,
          // and not in a later migration either until every write path is
          // proven to stamp it: a data post-condition is re-checked on every
          // mount forever, so one unstamped insert puts the whole S³ core
          // into a rollback-and-re-gate loop. The column ships nullable and
          // stays nullable for this phase.
          touches: {
            columns: {
              S3_PlayerEvents: ['serverID'],
              S3_GameStateEvents: ['serverID'],
              S3_PlayerSnapshots: ['serverID']
            }
          },
          up: async (qi) => {
            const serverID = this.dbService?.getServerID?.() ?? null;
            for (const table of ['S3_PlayerEvents', 'S3_GameStateEvents', 'S3_PlayerSnapshots']) {
              if (!(await qi.tableExists(table))) continue;
              const columns = await qi.describeTable(table);
              if (!columns.serverID) {
                await qi.addColumn(table, 'serverID', { type: qi.DataTypes.INTEGER, allowNull: true });
              }
              // Outside the guard, and matched on IS NULL, for the reason
              // switch v5 records: a hand-migrated database arrives here with
              // the column present and every row NULL, and a guarded backfill
              // is a silent no-op on exactly that database.
              await this.dbService.backfillServerID(qi, table, serverID);
            }
          },
          down: async (qi) => {
            for (const table of ['S3_PlayerEvents', 'S3_GameStateEvents', 'S3_PlayerSnapshots']) {
              if (!(await qi.tableExists(table))) continue;
              const columns = await qi.describeTable(table);
              if (columns.serverID) await qi.removeColumn(table, 'serverID');
            }
          }
        }
      ]);
    }

    this.dbService?.registerExpectedVersion?.('s3-logging', 2, {
      models: ['S3PlayerEvents', 'S3GameStateEvents', 'S3PlayerSnapshots']
    });

    if (this.enableFileLogging) {
      this.verboseLogger(3, `[Logging] File logging enabled — mirroring to ${this.logPath}`);
    }
    this.verboseLogger(3, '[Logging] Initialised S3_PlayerEvents, S3_GameStateEvents, S3_PlayerSnapshots tables.');
  }

  /**
   * Creates one declared index if it doesn't already exist yet, via a bare
   * CREATE INDEX statement — never ALTER TABLE / Sequelize's addIndex(),
   * which emit ALTER TABLE ... ADD INDEX on MySQL/Postgres and require the
   * ALTER grant a CREATE-only live user doesn't have. None of these indexes
   * are UNIQUE, so a missing one is a query-performance concern, not a
   * correctness one: failure is logged and non-fatal, and never blocks the
   * table itself from being written to or read.
   */
  async _ensureIndexes(tableName, indexes) {
    const connector = this.dbService.getConnector();
    const qi = connector.getQueryInterface();

    let existing = new Set();
    try {
      const rows = await qi.showIndex(tableName);
      existing = new Set(rows.map((r) => r.name));
    } catch (err) {
      this.verboseLogger(1, `[Logging] Could not read existing indexes on ${tableName}: ${err.message}`);
    }

    const q = (id) => this.dbService.quoteIdentifier(id);
    for (const { name, fields } of indexes) {
      if (existing.has(name)) continue;
      try {
        const cols = fields.map(q).join(', ');
        await connector.query(`CREATE INDEX ${q(name)} ON ${q(tableName)} (${cols})`);
      } catch (err) {
        this.verboseLogger(1, `[Logging] Failed to create index ${name} on ${tableName}: ${err.message}`);
        // Non-fatal to correctness (see the docblock above), but an operator
        // running with a grant that lacks even INDEX would otherwise never
        // learn their queries are unindexed — this runs unconditionally on
        // every mount, outside the migration engine's confirm/Discord flow,
        // so stderrWarn is the only operator-visible channel available to it.
        stderrWarn(
          'LoggingService',
          `Could not create index "${name}" on ${tableName} — queries against it will be unindexed.`,
          err.message
        );
      }
    }
  }

  /* ────────────────────────────────────── JSONL MIRROR ────────────────────────────────────── */

  /**
   * Append one JSONL line to the log file. Uses a write queue to prevent
   * interleaved writes from concurrent calls. Fire-and-forget — errors
   * are logged but do not propagate.
   */
  _appendJsonl(data) {
    this._writeQueue = this._writeQueue.then(() =>
      fsPromises.appendFile(this.logPath, JSON.stringify(data) + '\n', 'utf8')
    ).catch((err) =>
      this.verboseLogger(1, `[Logging] JSONL write error: ${err.message}`)
    );
  }

  /**
   * Flush pending JSONL writes. Called automatically on unmount.
   */
  async _flushJsonl() {
    await this._writeQueue;
  }

  /* ────────────────────────────────────── EVENT SUBSCRIPTIONS ────────────────────────────────────── */

  _subscribeEvents() {
    if (!this.server || typeof this.server.on !== 'function') return;
    if (!this.gameState) return;

    // ── Player events from PlayersService (emitted on server) ──
    this._eventListeners.playerJoined = (data) => {
      if (!data?.player) return;
      const p = data.player;
      const playerCount = this.server?.players?.length ?? 0;
      const t1count = this.server?.players?.filter((pl) => pl?.teamID === 1).length ?? 0;
      const t2count = this.server?.players?.filter((pl) => pl?.teamID === 2).length ?? 0;

      this.logPlayerEvent('JOIN', p, {
        source: data.source || 'Game',
        betweenRounds: this.gameState?.isEnding?.() || false,
        t1: t1count,
        t2: t2count
      });
    };

    this._eventListeners.playerLeft = (data) => {
      if (!data?.player) return;
      const p = data.player;
      const playerCount = this.server?.players?.length ?? 0;
      const t1count = this.server?.players?.filter((pl) => pl?.teamID === 1).length ?? 0;
      const t2count = this.server?.players?.filter((pl) => pl?.teamID === 2).length ?? 0;

      this.logPlayerEvent('LEAVE', p, {
        source: data.source || 'Game',
        betweenRounds: this.gameState?.isEnding?.() || false,
        t1: t1count,
        t2: t2count
      });
    };

    this._eventListeners.playerTeamChanged = (data) => {
      if (!data?.player) return;
      const p = data.player;
      const playerCount = this.server?.players?.length ?? 0;
      const t1count = this.server?.players?.filter((pl) => pl?.teamID === 1).length ?? 0;
      const t2count = this.server?.players?.filter((pl) => pl?.teamID === 2).length ?? 0;

      this.logPlayerEvent('TEAM_CHANGE', p, {
        oldTeamID: data.previousTeamID,
        newTeamID: data.teamID,
        source: data.source || 'Manual/Game',
        betweenRounds: this.gameState?.isEnding?.() || false,
        t1: t1count,
        t2: t2count
      });
    };

    this._eventListeners.roundLive = (data) => {
      const matchId = data?.matchId || this.gameState?.getMatchId?.() || null;
      this.snapshot(matchId, 'LIVE');

      // Start MID_ROUND timer (25 min from now, cancelled on ENDGAME)
      this._startMidRoundTimer(matchId);
    };

    this.server.on('S3_PLAYER_JOINED', this._eventListeners.playerJoined);
    this.server.on('S3_PLAYER_LEFT', this._eventListeners.playerLeft);
    this.server.on('S3_PLAYER_TEAM_CHANGED', this._eventListeners.playerTeamChanged);
    this.server.on('S3_ROUND_LIVE', this._eventListeners.roundLive);

    // ── GameState phase changes (callback subscription) ──
    this._unsubPhaseChange = this.gameState.onGamePhaseChange((payload) => {
      const { phase, prevPhase } = payload;

      // Log phase change to S3_GameStateEvents
      this.logGameStateEvent('PHASE_CHANGE', prevPhase, phase, {
        resolving: this.gameState?.isResolving?.() || false
      });

      // On ENDGAME: take final snapshot and cancel MID_ROUND timer
      if (phase === 'ENDGAME') {
        this._clearMidRoundTimer();
        const matchId = this.gameState?.getMatchId?.() ?? null;
        this.snapshot(matchId, 'ENDGAME');
      }
    });

    // ── Resolving sub-state changes (track in GameStateEvents) ──
    //
    // `resolving` used to be force-cleared by the STAGING→LIVE timer, so the
    // PHASE_CHANGE row for that transition timestamped the clear incidentally.
    // Decoupling the two made the flag correct and simultaneously made it
    // invisible: it now clears on a player-info tick or its own deadline, and
    // neither writes a row. This subscription is the replacement record.
    //
    // The typeof guard tolerates a GameStateService from an older deploy that
    // has no such channel — logging degrades rather than failing to mount.
    if (typeof this.gameState?.onResolvingChange === 'function') {
      this._unsubResolvingChange = this.gameState.onResolvingChange((payload) => {
        this.logGameStateEvent('RESOLVING_CLEARED', 'RESOLVING', payload.reason, {
          resolving: payload.resolving,
          durationMs: payload.durationMs
        });
      });
    }

    // ── Layer/game mode changes (track in GameStateEvents) ──
    this._unsubLayerChange = this.gameState.onLayerGameModeChange((payload) => {
      // Layer changes during STAGING are normal; log as informational
      this.logGameStateEvent('LAYER_CHANGE', payload.prevLayer, payload.layerName, {
        gamemode: payload.gameMode
      });
    });
  }

  _unsubscribeEvents() {
    if (this._unsubPhaseChange) {
      this._unsubPhaseChange();
      this._unsubPhaseChange = null;
    }
    if (this._unsubLayerChange) {
      this._unsubLayerChange();
      this._unsubLayerChange = null;
    }
    if (this._unsubResolvingChange) {
      this._unsubResolvingChange();
      this._unsubResolvingChange = null;
    }

    if (this.server && typeof this.server.removeListener === 'function') {
      for (const [event, handler] of Object.entries(this._eventListeners)) {
        const squadjsEvent = event === 'roundLive'
          ? 'S3_ROUND_LIVE'
          : event === 'playerJoined'
            ? 'S3_PLAYER_JOINED'
            : event === 'playerLeft'
              ? 'S3_PLAYER_LEFT'
              : event === 'playerTeamChanged'
                ? 'S3_PLAYER_TEAM_CHANGED'
                : null;
        if (squadjsEvent && handler) {
          this.server.removeListener(squadjsEvent, handler);
        }
      }
    }

    this._eventListeners = {};
  }

  /* ────────────────────────────────────── MID-ROUND TIMER ────────────────────────────────────── */

  _startMidRoundTimer(matchId) {
    this._clearMidRoundTimer();

    this._midRoundTimer = setTimeout(() => {
      this._midRoundTimer = null;

      // Only take snapshot if we're still in a LIVE round
      if (this.gameState?.isLive?.()) {
        this.snapshot(matchId, 'MID_ROUND');
        this.verboseLogger(3, '[Logging] MID_ROUND snapshot taken (25 min after LIVE).');
      }
    }, MID_ROUND_SNAPSHOT_DELAY_MS);

    // Allow the timer to not prevent process exit
    if (this._midRoundTimer?.unref) {
      this._midRoundTimer.unref();
    }
  }

  _clearMidRoundTimer() {
    if (this._midRoundTimer) {
      clearTimeout(this._midRoundTimer);
      this._midRoundTimer = null;
    }
  }
}