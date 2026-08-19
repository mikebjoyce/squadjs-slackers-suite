import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import BasePlugin from './base-plugin.js';

/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          DEV RCON HARNESS  —  TEST SERVERS ONLY              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Gives an offline operator (a human at a shell, or an AI agent with
 * filesystem access) a way to drive round-lifecycle RCON commands into
 * a running SquadJS instance and observe the resulting state — without
 * being in-game and without an admin console.
 *
 * The channel is a watched directory. Nothing listens on a port.
 *
 *   <dataDir>/inbox/<name>.json      request  — you write this
 *   <dataDir>/outbox/<name>.json     result   — the plugin writes this
 *   <dataDir>/processed/<name>.json  the request, after it was claimed
 *   <dataDir>/tape.jsonl             append-only lifecycle event timeline
 *
 * ─── REQUEST SHAPE ───────────────────────────────────────────────
 *
 *   {
 *     "token":    "<must equal options.token>",
 *     "commands": ["AdminChangeLayer Gorodok_RAAS_v1"],   // or "command": "..."
 *     "discord":  ["gamestate"],  // capture !s3 embeds without sending them
 *     "snapshot": true,          // include a state snapshot in the result
 *     "note":     "why you ran this"
 *   }
 *
 * A request with no commands and `snapshot: true` is a pure read — it
 * touches RCON not at all.
 *
 * ─── SAFETY ──────────────────────────────────────────────────────
 *
 * This executes arbitrary Squad admin commands on behalf of anything
 * that can write a file into `inbox/`. That is the point, and it is
 * also the hazard. Accordingly:
 *
 *   - `enabled` defaults to false; the plugin no-ops unless turned on.
 *   - `readOnly: true` records the tape and never opens the inbox — there is
 *     no code path from disk to RCON. This is the mode to run on a live
 *     server.
 *   - `token` left at its default also keeps the inbox shut, so a plugin
 *     copied over without being configured cannot accept commands.
 *   - Commands are matched against `allowedCommands` (prefix, case-
 *     insensitive). `AdminBan` / `AdminKick` are NOT in the default set.
 *   - Every executed command is logged at verbose 1, so run.log is a
 *     second audit trail independent of `processed/`.
 *
 * Do not put this in a production server's config.json. It is
 * deliberately absent from install.cjs's plugin list so that
 * `--plugin=all` can never sweep it into a deploy; install it by
 * copying this one file into <squadjs>/squad-server/plugins/.
 *
 * ─── LIMITS ──────────────────────────────────────────────────────
 *
 * This drives the *layer/phase* half of the lifecycle well. It cannot
 * conjure players, so anything gated on a populated roster (team
 * resolution, faction abbreviations, balance maths) still needs bodies
 * on the server — an empty test server resolves teams trivially and
 * will not reproduce those bugs.
 *
 * The fix for that is `readOnly: true` on the live server. `resolving`
 * clears on a player-info tick, so the only honest record of how long it
 * takes is one taken with a real population; the tape captures the
 * NEW_GAME → tick → resolving=false ordering as structured JSON, which
 * verbose logs do not.
 */
export default class DevRconHarness extends BasePlugin {
  static get description() {
    return 'TEST SERVERS ONLY. Executes RCON commands dropped as JSON files and records a lifecycle event tape.';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      enabled: {
        required: false,
        description: 'Master switch. While false the plugin mounts but does nothing.',
        default: false
      },
      readOnly: {
        required: false,
        description: 'Record the event tape but never watch the inbox. Safe on a live server: no RCON path exists at all, so nothing on disk can act on the game.',
        default: false
      },
      token: {
        required: false,
        description: 'Shared secret. Every request file must carry a matching "token". Left at its default the inbox refuses to open — so a tape-only deployment needs no secret, and an unconfigured one cannot accept commands.',
        default: 'CHANGE_ME'
      },
      dataDir: {
        required: false,
        description: 'Directory holding inbox/, outbox/, processed/ and tape.jsonl. Relative paths resolve against the SquadJS working directory.',
        default: './dev-harness'
      },
      scanIntervalMs: {
        required: false,
        description: 'How often the inbox is scanned. Polling is used rather than fs.watch, which drops and duplicates events on Windows.',
        default: 1000
      },
      commandDelayMs: {
        required: false,
        description: 'Pause between commands within one request, so a layer change has time to land before the next command.',
        default: 250
      },
      maxCommandsPerRequest: {
        required: false,
        description: 'Refuse a request carrying more commands than this.',
        default: 10
      },
      allowedCommands: {
        required: false,
        description: 'Permitted command prefixes, case-insensitive. Anything else is refused and reported in the result file.',
        default: [
          'AdminChangeLayer',
          'AdminSetNextLayer',
          'AdminEndMatch',
          'AdminRestartMatch',
          'AdminForceTeamChange',
          'AdminBroadcast',
          'AdminSetFogOfWar',
          'ShowCurrentMap',
          'ShowNextMap',
          'ListPlayers',
          'ListSquads'
        ]
      },
      allowAnyCommand: {
        required: false,
        description: 'Bypass allowedCommands entirely. Opt in only when you need a command the list omits.',
        default: false
      },
      discordCommands: {
        required: false,
        description: 'Permitted !s3 subcommands for the "discord" request field. Handlers are invoked with a capturing sender, so the embed is written to the result file and never sent to Discord. Mutating subcommands are omitted: they need a watchManager/stagedImportRef that a stub context cannot supply.',
        default: ['status', 'services', 'gamestate', 'factions', 'players']
      },
      s3CommandsModule: {
        required: false,
        description: 'Path to s3-commands.js, resolved relative to this plugin file. The suite installs utils/ alongside plugins/, so the default holds for a standard deploy.',
        default: '../utils/s3-commands.js'
      },
      recordTape: {
        required: false,
        description: 'Append a JSONL line with a lite state snapshot on every lifecycle event.',
        default: true
      },
      tapeMaxLines: {
        required: false,
        description: 'Truncate tape.jsonl once it exceeds this many lines. 0 disables truncation.',
        default: 5000
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    this.dataDir = path.resolve(this.options.dataDir);
    this.inboxDir = path.join(this.dataDir, 'inbox');
    this.outboxDir = path.join(this.dataDir, 'outbox');
    this.processedDir = path.join(this.dataDir, 'processed');
    this.tapePath = path.join(this.dataDir, 'tape.jsonl');

    this._scanTimer = null;
    this._scanning = false;
    this._tapeLines = 0;
    // event name → bound handler, so unmount() removes the same function
    // identity that mount() registered.
    this._eventHandlers = new Map();
    // Files whose JSON failed to parse, keyed by name → attempt count. A file
    // caught mid-write parses as garbage; retry before declaring it bad.
    this._parseRetries = new Map();

    this.onLifecycleEvent = this.onLifecycleEvent.bind(this);
  }

  async mount() {
    if (!this.options.enabled) {
      this.verbose(1, 'Disabled (options.enabled is false). Not watching anything.');
      return;
    }

    await fs.mkdir(this.dataDir, { recursive: true });

    for (const event of DevRconHarness.TAPE_EVENTS) {
      this.server.on(event, this.onLifecycleEvent(event));
    }

    if (!this.inboxPermitted()) {
      this.verbose(1, `Tape-only — recording ${this.tapePath}. No RCON path is open.`);
      return;
    }

    await fs.mkdir(this.inboxDir, { recursive: true });
    await fs.mkdir(this.outboxDir, { recursive: true });
    await fs.mkdir(this.processedDir, { recursive: true });

    this._scanTimer = setInterval(() => {
      this.scanInbox().catch((err) => this.verbose(1, `Inbox scan failed: ${err.message}`));
    }, this.options.scanIntervalMs);

    this.verbose(1, `ENABLED — watching ${this.inboxDir}. This server accepts RCON commands from disk.`);
  }

  async unmount() {
    if (this._scanTimer) {
      clearInterval(this._scanTimer);
      this._scanTimer = null;
    }

    for (const event of DevRconHarness.TAPE_EVENTS) {
      this.server.removeListener(event, this.onLifecycleEvent(event));
    }

    this._parseRetries.clear();
    this.verbose(1, 'Unmounted.');
  }

  /**
   * The inbox opens only when explicitly asked for AND given a real token.
   * Both conditions are checked here rather than at the call site so there is
   * exactly one place that decides whether this server can be commanded.
   */
  inboxPermitted() {
    if (this.options.readOnly) return false;

    const token = this.options.token;
    if (!token || token === 'CHANGE_ME') {
      this.verbose(1, 'Inbox NOT opened — options.token is unset or still the default.');
      return false;
    }

    return true;
  }

  /**
   * The tape subscribes to five events but the handler needs to know which one
   * fired, so each gets a memoised bound wrapper. Memoisation is what makes the
   * unmount() removeListener calls match the mount() on() calls by identity.
   */
  onLifecycleEvent(eventName) {
    if (!this._eventHandlers) this._eventHandlers = new Map();
    if (!this._eventHandlers.has(eventName)) {
      this._eventHandlers.set(eventName, (data) => {
        // Deferred by one turn of the event loop on purpose. EventEmitter runs
        // listeners in registration order, and the harness mounts after S³ —
        // but that ordering is incidental, not guaranteed. Snapshotting inline
        // recorded PRE-transition state on NEW_GAME (phase still ENDGAME, layer
        // still the previous round's), which reads as "S³ failed to update"
        // when in fact its handler had not run yet. The tape is meant to answer
        // "what did S³ conclude from this event", so it must sample after the
        // other listeners have had their turn.
        setImmediate(() => {
          this.appendTape(eventName, data).catch((err) =>
            this.verbose(1, `Tape write failed for ${eventName}: ${err.message}`)
          );
        });
      });
    }
    return this._eventHandlers.get(eventName);
  }

  // ─── Inbox ─────────────────────────────────────────────────────────────────

  async scanInbox() {
    if (this._scanning) return;
    this._scanning = true;

    try {
      const entries = (await fs.readdir(this.inboxDir)).filter((f) => f.endsWith('.json')).sort();

      for (const name of entries) {
        const request = await this.readRequest(name);
        if (request === undefined) continue; // parse retry pending

        // Claim the file BEFORE executing. A crash mid-execute then loses the
        // result rather than replaying AdminChangeLayer on the next scan.
        const claimed = await this.claimRequest(name);
        if (!claimed) continue;

        const result = await this.handleRequest(name, request);
        await this.writeResult(name, result);
      }
    } finally {
      this._scanning = false;
    }
  }

  /**
   * Returns the parsed request, `null` if the file is genuinely unparseable, or
   * `undefined` to mean "try again next scan" (probably a partial write).
   */
  async readRequest(name) {
    const filePath = path.join(this.inboxDir, name);
    let raw;

    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return undefined; // vanished between readdir and read
      throw err;
    }

    try {
      const parsed = JSON.parse(raw);
      this._parseRetries.delete(name);
      return parsed;
    } catch (err) {
      const attempts = (this._parseRetries.get(name) || 0) + 1;
      this._parseRetries.set(name, attempts);
      if (attempts < 3) return undefined;

      this._parseRetries.delete(name);
      this.verbose(1, `Request ${name} is not valid JSON after ${attempts} attempts: ${err.message}`);
      return null;
    }
  }

  async claimRequest(name) {
    try {
      await fs.rename(path.join(this.inboxDir, name), path.join(this.processedDir, name));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      this.verbose(1, `Could not claim ${name}: ${err.message}`);
      return false;
    }
  }

  async handleRequest(name, request) {
    const receivedAt = new Date().toISOString();

    if (request === null) {
      return { id: name, receivedAt, ok: false, error: 'Request file was not valid JSON.' };
    }

    if (request.token !== this.options.token) {
      this.verbose(1, `Request ${name} REFUSED — bad or missing token.`);
      return { id: name, receivedAt, ok: false, error: 'Bad or missing token.' };
    }

    const commands = this.normaliseCommands(request);
    if (commands.length > this.options.maxCommandsPerRequest) {
      return {
        id: name,
        receivedAt,
        ok: false,
        error: `Request carries ${commands.length} commands; maxCommandsPerRequest is ${this.options.maxCommandsPerRequest}.`
      };
    }

    const results = [];
    for (const command of commands) {
      results.push(await this.executeCommand(command));
      if (this.options.commandDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.options.commandDelayMs));
      }
    }

    const discord = await this.runDiscordCommands(request);

    const payload = {
      id: name,
      note: request.note ?? null,
      receivedAt,
      completedAt: new Date().toISOString(),
      ok: results.every((r) => r.ok) && discord.every((d) => d.ok),
      results
    };

    if (discord.length) payload.discord = discord;
    if (request.snapshot !== false) payload.snapshot = this.buildSnapshot();
    return payload;
  }

  // ─── Discord command capture ───────────────────────────────────────────────

  /**
   * Invoke !s3 subcommands against the LIVE S³ plugin, but with a capturing
   * `sendDiscordMessage` in place of the real one — so the embed lands in the
   * result file and no message is ever posted to a channel.
   *
   * This works because createCommandHandlers() takes its sender by injection
   * and each handler's signature is (plugin, message, args): the plugin
   * argument is the real instance, so the embed reflects real server state.
   */
  async runDiscordCommands(request) {
    const requested = Array.isArray(request.discord)
      ? request.discord
      : (typeof request.discord === 'string' ? [request.discord] : []);
    if (!requested.length) return [];

    let createCommandHandlers;
    try {
      ({ createCommandHandlers } = await import(this.s3CommandsUrl()));
    } catch (err) {
      return requested.map((entry) => ({
        command: entry,
        ok: false,
        error: `Could not load s3-commands.js (${this.options.s3CommandsModule}): ${err.message}`
      }));
    }

    const s3 = this.findS3();
    if (!s3) {
      return requested.map((entry) => ({ command: entry, ok: false, error: 'SlackersSquadServices not found.' }));
    }

    const captured = [];
    const handlers = createCommandHandlers({
      sendDiscordMessage: async (_channel, payload) => { captured.push(payload); },
      // Mutating handlers would use these; the allowlist keeps us off those paths.
      watchManager: null,
      stagedImportRef: { current: null }
    }).handlers;

    const out = [];
    for (const entry of requested) {
      const [command, ...args] = String(entry).trim().split(/\s+/);

      if (!this.options.discordCommands.includes(command)) {
        out.push({ command: entry, ok: false, error: 'Subcommand is not in discordCommands.' });
        continue;
      }

      const handler = handlers.get(command);
      if (!handler) {
        out.push({ command: entry, ok: false, error: `No handler registered for "${command}".` });
        continue;
      }

      captured.length = 0;
      this.verbose(1, `DISCORD (captured, not sent): !s3 ${entry}`);
      try {
        // A stub message: handlers only need `.channel`, which the capturing
        // sender ignores. Nothing here can reach a real Discord channel.
        await handler(s3, { channel: { id: 'dev-harness-capture' } }, args);
        out.push({ command: entry, ok: true, payloads: JSON.parse(JSON.stringify(captured)) });
      } catch (err) {
        out.push({ command: entry, ok: false, error: err.message });
      }
    }

    return out;
  }

  s3CommandsUrl() {
    const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), this.options.s3CommandsModule);
    return pathToFileURL(target).href;
  }

  normaliseCommands(request) {
    if (Array.isArray(request.commands)) return request.commands.filter((c) => typeof c === 'string');
    if (typeof request.command === 'string') return [request.command];
    return [];
  }

  isCommandAllowed(command) {
    if (this.options.allowAnyCommand) return true;
    const needle = command.trim().toLowerCase();
    return this.options.allowedCommands.some((allowed) => needle.startsWith(String(allowed).toLowerCase()));
  }

  async executeCommand(command) {
    if (!this.isCommandAllowed(command)) {
      this.verbose(1, `REFUSED (not in allowedCommands): ${command}`);
      return { command, ok: false, error: 'Command is not in allowedCommands and allowAnyCommand is false.' };
    }

    this.verbose(1, `EXECUTING: ${command}`);
    try {
      const response = await this.server.rcon.execute(command);
      return { command, ok: true, response: typeof response === 'string' ? response : String(response ?? '') };
    } catch (err) {
      this.verbose(1, `FAILED: ${command} — ${err.message}`);
      return { command, ok: false, error: err.message };
    }
  }

  async writeResult(name, result) {
    const target = path.join(this.outboxDir, name);
    // Write-then-rename, so a reader never sees a half-written result.
    const temp = `${target}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await fs.rename(temp, target);
  }

  // ─── State snapshots ───────────────────────────────────────────────────────

  /**
   * S³ is discovered on demand rather than cached at mount, because the harness
   * exists partly to debug S³ — it must keep working when S³ is broken, absent,
   * or has been reloaded underneath us.
   */
  findS3() {
    if (!Array.isArray(this.server.plugins)) return null;
    return this.server.plugins.find((p) => p?.constructor?.name === 'SlackersSquadServices') ?? null;
  }

  layerNameOf(layer) {
    if (!layer) return null;
    if (typeof layer === 'string') return layer;
    if (typeof layer.then === 'function') return '<pending promise>';
    return layer.name ?? layer.layerid ?? null;
  }

  buildSnapshot() {
    const snapshot = {
      ts: new Date().toISOString(),
      server: {
        currentLayer: this.layerNameOf(this.server.currentLayer),
        nextLayer: this.layerNameOf(this.server.nextLayer),
        layerHistoryTop: (this.server.layerHistory ?? [])
          .slice(0, 3)
          .map((entry) => this.layerNameOf(entry?.layer)),
        playerCount: (this.server.players ?? []).length,
        a2sPlayerCount: this.server.a2sPlayerCount ?? null,
        squadCount: (this.server.squads ?? []).length
      },
      s3: { present: false }
    };

    const s3 = this.findS3();
    if (!s3) return snapshot;

    // NOT s3.ready() — that returns the readiness *promise*, which serialises to
    // {} and tells a reader nothing. Report which services actually mounted; the
    // snapshot is synchronous so it cannot await anything.
    snapshot.s3 = {
      present: true,
      services: Object.keys(s3.services ?? {}).sort()
    };

    const gs = s3.gameState;
    if (gs) {
      snapshot.s3.gameState = {
        phase: this.safeCall(() => gs.getPhase?.()),
        resolving: this.safeCall(() => gs.isResolving?.()),
        layerResolved: this.safeCall(() => gs.isLayerResolved?.()),
        layerName: this.safeCall(() => gs.getLayerName?.()),
        gamemode: this.safeCall(() => gs.getGamemode?.()),
        seedMode: this.safeCall(() => gs.isSeedMode?.()),
        trainingMode: this.safeCall(() => gs.isTrainingMode?.()),
        lastNewGameAt: this.safeCall(() => gs.lastNewGameAt) ?? null
      };
    }

    const players = s3.players;
    if (players) {
      snapshot.s3.players = {
        ready: this.safeCall(() => players.isReady?.()),
        count: this.safeCall(() => players.getAllPlayers?.()?.length),
        teamsResolved: this.safeCall(() => players.areTeamsResolved?.()),
        refreshIntervalMs: this.safeCall(() => players.getEffectiveRefreshIntervalMs?.())
      };
    }

    const factions = s3.factions;
    if (factions) {
      snapshot.s3.factions = {
        abbreviations: this.safeCall(() => factions.getCachedAbbreviations?.())
      };
    }

    return snapshot;
  }

  /**
   * Snapshots must never throw — a broken accessor should show up as an error
   * string in the output, not abort the whole read.
   */
  safeCall(fn) {
    try {
      const value = fn();
      return value === undefined ? null : value;
    } catch (err) {
      return `<error: ${err.message}>`;
    }
  }

  // ─── Event tape ────────────────────────────────────────────────────────────

  async appendTape(eventName, data) {
    if (!this.options.recordTape) return;

    const snapshot = this.buildSnapshot();
    const line = {
      ts: snapshot.ts,
      event: eventName,
      // NEW_GAME's own payload layer is the thing that goes null on a mid-round
      // restart, so record it next to the resolved state rather than instead of it.
      eventLayer: eventName === 'NEW_GAME' ? this.layerNameOf(data?.layer) : undefined,
      server: snapshot.server,
      s3: snapshot.s3.gameState
        ? { gameState: snapshot.s3.gameState, players: snapshot.s3.players ?? null }
        : { present: snapshot.s3.present }
    };

    await fs.appendFile(this.tapePath, `${JSON.stringify(line)}\n`, 'utf8');

    this._tapeLines += 1;
    if (this.options.tapeMaxLines > 0 && this._tapeLines >= this.options.tapeMaxLines) {
      await this.truncateTape();
    }
  }

  async truncateTape() {
    try {
      const lines = (await fs.readFile(this.tapePath, 'utf8')).split('\n').filter(Boolean);
      const keep = lines.slice(-Math.floor(this.options.tapeMaxLines / 2));
      await fs.writeFile(this.tapePath, `${keep.join('\n')}\n`, 'utf8');
      this._tapeLines = keep.length;
      this.verbose(1, `Tape truncated to ${keep.length} lines.`);
    } catch (err) {
      this.verbose(1, `Tape truncation failed: ${err.message}`);
      this._tapeLines = 0;
    }
  }
}

DevRconHarness.TAPE_EVENTS = [
  'NEW_GAME',
  'ROUND_ENDED',
  'UPDATED_SERVER_INFORMATION',
  'UPDATED_LAYER_INFORMATION',
  'UPDATED_PLAYER_INFORMATION'
];
