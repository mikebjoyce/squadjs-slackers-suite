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
 *
 */

import { promises as fsPromises } from 'fs';

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
    logPath = './s3-log.jsonl',
    emitEvent = () => {}
  } = {}) {
    this.parent = parent;
    this.server = server;
    this.verboseLogger = verboseLogger;
    this.dbService = dbService;
    this.gameState = gameState;
    this.enableDatabaseLogging = enableDatabaseLogging;
    this.enableFileLogging = enableFileLogging;
    this.logPath = logPath;
    this.emitEvent = emitEvent;

    this._isMounted = false;
    this._midRoundTimer = null;

    // Sequelize models (set in _initModels)
    this.PlayerEventsModel = null;
    this.GameStateEventsModel = null;
    this.PlayerSnapshotsModel = null;

    // Subscription references for cleanup
    this._unsubPhaseChange = null;
    this._unsubLayerChange = null;

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
   * @param {string} eventType  - 'PHASE_CHANGE', 'CRASH_RECOVERY', 'SERVER_START', 'SERVER_STOP'
   * @param {string} [oldPhase] - Previous phase (null for SERVER_START)
   * @param {string} [newPhase] - New phase (null for SERVER_STOP)
   * @param {Object} [metadata]
   * @param {boolean} [metadata.resolving]
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
        layerName: this.gameState?.getLayerName?.() ?? null,
        gamemode: this.gameState?.getGamemode?.() ?? null
      });
    }

    // DB write (no-op if not mounted or model not ready)
    if (!this._isMounted || !this.GameStateEventsModel) return;

    try {
      await this.dbService.executeWithRetry(async () => {
        await this.GameStateEventsModel.create({
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

    const sequelize = this.dbService.getConnector();
    const DataTypes = this.dbService.getDataTypes();

    // ── S3_PlayerEvents ──────────────────────────────────────────
    this.PlayerEventsModel = sequelize.models?.S3PlayerEvents || sequelize.define(
      'S3PlayerEvents',
      {
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
      },
      {
        tableName: 'S3_PlayerEvents',
        timestamps: false,
        indexes: [
          { name: 'idx_s3_pe_matchId', fields: ['matchId'] },
          { name: 'idx_s3_pe_eosID', fields: ['eosID'] },
          { name: 'idx_s3_pe_eventType_matchId', fields: ['eventType', 'matchId'] },
          { name: 'idx_s3_pe_ts', fields: ['ts'] }
        ]
      }
    );

    // ── S3_GameStateEvents ───────────────────────────────────────
    this.GameStateEventsModel = sequelize.models?.S3GameStateEvents || sequelize.define(
      'S3GameStateEvents',
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        matchId: { type: DataTypes.STRING, allowNull: true },
        ts: { type: DataTypes.BIGINT, allowNull: false },
        eventType: { type: DataTypes.STRING, allowNull: false },
        oldPhase: { type: DataTypes.STRING, allowNull: true },
        newPhase: { type: DataTypes.STRING, allowNull: true },
        resolving: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
        layerName: { type: DataTypes.STRING, allowNull: true },
        gamemode: { type: DataTypes.STRING, allowNull: true }
      },
      {
        tableName: 'S3_GameStateEvents',
        timestamps: false,
        indexes: [
          { name: 'idx_s3_gse_matchId', fields: ['matchId'] },
          { name: 'idx_s3_gse_eventType', fields: ['eventType'] },
          { name: 'idx_s3_gse_ts', fields: ['ts'] }
        ]
      }
    );

    // ── S3_PlayerSnapshots ───────────────────────────────────────
    this.PlayerSnapshotsModel = sequelize.models?.S3PlayerSnapshots || sequelize.define(
      'S3PlayerSnapshots',
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        matchId: { type: DataTypes.STRING, allowNull: false },
        ts: { type: DataTypes.BIGINT, allowNull: false },
        trigger: { type: DataTypes.STRING, allowNull: false },
        playersJson: { type: DataTypes.TEXT, allowNull: false },
        t1: { type: DataTypes.INTEGER, allowNull: true },
        t2: { type: DataTypes.INTEGER, allowNull: true }
      },
      {
        tableName: 'S3_PlayerSnapshots',
        timestamps: false,
        indexes: [
          { name: 'idx_s3_ps_matchId_ts', fields: ['matchId', 'ts'] }
        ]
      }
    );

    // Sync all models (create tables if they don't exist)
    await this.dbService.executeWithRetry(async () => {
      await this.PlayerEventsModel.sync();
      await this.GameStateEventsModel.sync();
      await this.PlayerSnapshotsModel.sync();
    });

    if (this.enableFileLogging) {
      this.verboseLogger(3, `[Logging] File logging enabled — mirroring to ${this.logPath}`);
    }
    this.verboseLogger(3, '[Logging] Initialised S3_PlayerEvents, S3_GameStateEvents, S3_PlayerSnapshots tables.');
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