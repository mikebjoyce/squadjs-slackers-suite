import fs from 'node:fs';
import path from 'node:path';

import BasePlugin from './base-plugin.js';

/**
 * TEST/DIAGNOSTIC ONLY — not part of the Slacker's Suite, deliberately
 * absent from install.cjs so `--plugin=all` never sweeps it into a deploy.
 * Install by copying this one file into <squadjs>/squad-server/plugins/
 * (base-plugin.js is already there — it ships with SquadJS core).
 *
 * Purely observational. No RCON writes, no game-state mutation — safe to
 * run on a live server, though it's meant for the test server.
 *
 * ─── WHAT THIS IS CHECKING ─────────────────────────────────────────────
 *
 * Hypothesis under test: when a player is using Squad's own clan-tag
 * system (as opposed to just typing a bracketed prefix into their name),
 * the RCON `Name:` field for that player starts WITHOUT the tag and later
 * gains it — i.e. `Steve` becomes `[THE] Steve` on a later poll, where the
 * new name's suffix matches the old name exactly. If that transition is
 * real and consistent, it's a much stronger signal than string shape
 * alone (bracket/separator/bare-word) for telling a genuine clan tag
 * apart from a coincidental word shared by unrelated players — see
 * ClansService's corroboration gate in s3/utils/clans-service.js, which
 * this would potentially simplify or replace for newly-joining players.
 *
 * This plugin does NOT try to decide the hypothesis itself. It just
 * records every `name` change it observes per player, with enough detail
 * to eyeball afterward: old name, new name, whether the new name's suffix
 * matches the old name, and timing relative to PLAYER_CONNECTED. Read
 * `clan-tag-timing-probe.jsonl` and look for real examples.
 *
 * Tracking follows the documented reliable pattern (see
 * docs/.agents/skills/creating-squadjs-plugins/references/event-reliability.md):
 * `UPDATED_PLAYER_INFORMATION` + `server.players` is the source of truth;
 * `PLAYER_CONNECTED` is only used as a supplementary timestamp, never as
 * the trigger for first-seeing a player.
 *
 * Add to config.json:
 *   { "plugin": "ClanTagTimingProbe", "enabled": true }
 *
 * Then just let players join over a normal session. Check:
 *   <dataDir>/clan-tag-timing-probe.jsonl
 */
export default class ClanTagTimingProbe extends BasePlugin {
  static get description() {
    return 'TEST ONLY. Logs every observed player name change with timing, to check whether Squad\'s clan-tag system appends a tag to an already-connected player\'s name later.';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      enabled: { required: false, description: 'Master switch.', default: false },
      dataDir: {
        required: false,
        description: 'Directory the JSONL log is written into. Relative paths resolve against the SquadJS working directory.',
        default: './dev-harness'
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    // eosID -> { name, firstSeenAt (ms), connectedAt (ms|null) }
    this._tracked = new Map();

    this.onUpdatedPlayerInformation = this.onUpdatedPlayerInformation.bind(this);
    this.onPlayerConnected = this.onPlayerConnected.bind(this);
  }

  async mount() {
    if (!this.options.enabled) {
      this.verbose(1, '[ClanTagTimingProbe] Disabled (options.enabled is false).');
      return;
    }

    this.dataDir = path.resolve(this.options.dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.logPath = path.join(this.dataDir, 'clan-tag-timing-probe.jsonl');

    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.on('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInformation);

    this.verbose(1, `[ClanTagTimingProbe] ENABLED — logging name-change events to ${this.logPath}`);
  }

  async unmount() {
    this.server.removeListener('PLAYER_CONNECTED', this.onPlayerConnected);
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInformation);
    this._tracked.clear();
  }

  // PLAYER_CONNECTED is a race, not a sequence point (see event-reliability.md)
  // — it only ever fills in `connectedAt` if we haven't already seen this
  // player from a poll, it never creates the "first seen" record itself.
  onPlayerConnected(data) {
    const eosID = data?.eosID ?? data?.player?.eosID;
    if (!eosID) return;

    const now = Date.now();
    const existing = this._tracked.get(eosID);
    if (existing) {
      if (existing.connectedAt == null) existing.connectedAt = now;
      return;
    }

    this._tracked.set(eosID, {
      name: data?.player?.name ?? null,
      firstSeenAt: now,
      connectedAt: now
    });

    this.appendLog({
      kind: 'connect-event',
      eosID,
      steamID: data?.steamID ?? data?.player?.steamID ?? null,
      name: data?.player?.name ?? null
    });
  }

  onUpdatedPlayerInformation() {
    const now = Date.now();
    const players = this.server.players ?? [];
    const seen = new Set();

    for (const p of players) {
      if (!p?.eosID) continue;
      seen.add(p.eosID);

      const existing = this._tracked.get(p.eosID);

      if (!existing) {
        this._tracked.set(p.eosID, { name: p.name, firstSeenAt: now, connectedAt: null });
        this.appendLog({
          kind: 'first-seen-on-poll',
          eosID: p.eosID,
          steamID: p.steamID ?? null,
          name: p.name
        });
        continue;
      }

      if (p.name !== existing.name) {
        const oldName = existing.name;
        const newName = p.name;
        const suffixMatch = typeof oldName === 'string' && typeof newName === 'string'
          && newName.endsWith(oldName.trim())
          && newName.trim() !== oldName.trim();
        const guessedPrefix = suffixMatch
          ? newName.slice(0, newName.length - oldName.trim().length).trim()
          : null;

        this.appendLog({
          kind: 'name-changed',
          eosID: p.eosID,
          steamID: p.steamID ?? null,
          oldName,
          newName,
          suffixMatch,
          guessedPrefix,
          msSinceFirstSeen: now - existing.firstSeenAt,
          msSinceConnectEvent: existing.connectedAt != null ? now - existing.connectedAt : null
        });

        existing.name = newName;
      }
    }

    // Drop anyone no longer on the server so the map doesn't grow unbounded
    // over a long-running session.
    for (const eosID of [...this._tracked.keys()]) {
      if (!seen.has(eosID)) this._tracked.delete(eosID);
    }
  }

  appendLog(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    this.verbose(1, `[ClanTagTimingProbe] ${line}`);
    try {
      fs.appendFileSync(this.logPath, `${line}\n`, 'utf8');
    } catch (err) {
      this.verbose(1, `[ClanTagTimingProbe] Failed to write log: ${err.message}`);
    }
  }
}
