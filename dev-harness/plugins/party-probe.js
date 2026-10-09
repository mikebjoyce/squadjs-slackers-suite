import fs from 'node:fs';
import path from 'node:path';

import BasePlugin from './base-plugin.js';

/**
 * TEST/DIAGNOSTIC ONLY — not part of the Slacker's Suite, deliberately
 * absent from install.cjs so `--plugin=all` never sweeps it into a deploy.
 * Install by copying this one file into <squadjs>/squad-server/plugins/
 * (base-plugin.js is already there — it ships with SquadJS core).
 *
 * Purely observational. The only RCON it sends is read-only
 * `ListPlayers` / `ListSquads` / `ListParties`; it never moves, kicks or
 * messages anyone. Built to run on the LIVE server, because the questions
 * below need a populated roster and the test server has none.
 *
 * ─── WHAT IS ALREADY KNOWN ─────────────────────────────────────────────
 *
 * OWI's late-September 2026 patch added parties (max 9 players).
 * `ListPlayers` now carries `| Party ID: #N |` between Team ID and Squad
 * ID, and the deployed SquadJS fork exposes it as `player.partyID` (number,
 * or null for `N/A`, or absent when the line has no Party field).
 *
 * Settled 2026-10-02 from a live scramble plus the player involved:
 * AdminForceTeamChange on the party LEADER moves the whole party in the
 * same tick; on a MEMBER it moves only that member. ListPlayers does not
 * say who the leader is.
 *
 * ─── WHAT THIS IS CHECKING ─────────────────────────────────────────────
 *
 *   1. Is `#0` a real party or a shared "no party" marker? Does every
 *      player carry an ID?                              → `census`
 *   2. Are IDs unique server-wide, or numbered per team? → `census`
 *   3. Who is the party leader, and how does ListParties say so?
 *                                                        → `raw-sample`, also
 *      taken the moment a party moves (reason `party-move`)
 *   4. The drag rule above, on every party move — `verdict` is
 *      `leader-drag` / `member-solo` / `unattributed` / `mixed`.
 *                                                        → `team-change-tick`
 *   5. When the leader is moved and a mate is ALREADY on the destination
 *      team, does the mate stay (the drag sets a team) or get sent the
 *      other way (the drag swaps each member)? See `matesAlreadyThere` and
 *      `movedOpposite`.                                 → `team-change-tick`
 *   6. What happens to squads when a party is dragged? Each change carries
 *      squad before and after.                          → `team-change-tick`
 *   7. Do party members land on the same team when they join?
 *                                                        → `party-member-assigned`
 *   8. Do party IDs survive a map change, and how often do players drop
 *      out of a party mid-round?                        → `party-id-changed`
 *   9. Has the raw RCON format drifted further?         → `raw-sample`
 *  10. When a player joins, how soon do team, squad and party ID appear?
 *      Do party joiners arrive already in a squad when solo joiners don't?
 *      Does a direct ListPlayers right at PLAYER_CONNECTED see the party
 *      ID sooner than the normal tick? (Most party joiners were first
 *      ticked with no ID, so SmartAssign can't act on the first tick.)
 *                                                        → `join-timeline`
 *  11. Squad joiners and solo joiners are told apart well, but about one
 *      party joiner in six arrives squadless. Were their mates' squads full
 *      or locked when they arrived, and did they join before or after
 *      their mates?                                     → `party-joiner-context`
 *  12. How well does "in a squad at first sighting means in a party"
 *      predict the party ID 30 s later? Each join is judged hit, false
 *      alarm, miss or correct.                → `join-timeline`, `census`
 *
 * This plugin does NOT act on any of this. Attribution comes from S³'s
 * `S3_PLAYER_TEAM_CHANGED` source when S³ is loaded; without S³ every
 * source reads null and a move made by hand needs a marker (below).
 *
 * ─── MANUAL TESTS ──────────────────────────────────────────────────────
 *
 * An admin typing `!partyprobe <note>` in admin chat writes a `marker`
 * entry with the note, then snapshots ListParties and ListPlayers at once.
 * Use it right before and after a hand-made move, e.g.
 *   !partyprobe moving Bob (party member, Alice is leader) to T1
 *
 * Every event handler is wrapped: an exception thrown inside a synchronous
 * EventEmitter listener aborts the emit, and the listeners after this one
 * — S³ among them — would never run that tick.
 *
 * Add to config.json:
 *   { "plugin": "PartyProbe", "enabled": true }
 *
 * Output goes to both places, so either alone is enough to analyse:
 *   - <dataDir>/party-probe.jsonl (and raw samples in <dataDir>/party-probe-raw/)
 *   - the SquadJS log, one `[PartyProbe] {json}` line per entry
 */

// Copy of the deployed fork's ListPlayers regex (NL-SquadJS-Custom 4eb07ec,
// squad-server/rcon.js). The raw sample counts player lines this fails on,
// which is how a further format change would show up.
const FORK_LIST_PLAYERS_RE = /^ID: (?<playerID>\d+) \| Online IDs:([^|]+)\| Name: (?<name>.+) \| Team ID: (?<teamID>\d+|N\/A)(?: \| Party ID: #?(?<partyID>\d+|N\/A))? \| Squad ID: (?<squadID>\d+|N\/A) \| Is Leader: (?<isLeader>True|False) \| Role: (?<role>[^|\r\n]+)(?: \| Vehicle: (?<vehicle>[^\r\n]+))?\r?$/;

const isRealTeam = (teamID) => teamID === 1 || teamID === 2;

// What S³'s PlayersService reports for a team change no plugin claimed
// (`_defaultTeamChangeSource()`): 'Admin' when the server disallows team
// changes, 'Manual/Game' otherwise.
const UNATTRIBUTED_SOURCES = new Set(['Admin', 'Manual/Game']);
const isAttributed = (source) => !!source && !UNATTRIBUTED_SOURCES.has(source);

export default class PartyProbe extends BasePlugin {
  static get description() {
    return 'TEST ONLY. Records Squad party IDs, party sizes, and how parties move on a forced team change, to settle how parties behave before the suite relies on them.';
  }

  static get defaultEnabled() {
    return false;
  }

  static get optionsSpecification() {
    return {
      enabled: { required: false, description: 'Master switch.', default: false },
      dataDir: {
        required: false,
        description: 'Directory the JSONL log and raw samples are written into. Relative paths resolve against the SquadJS working directory.',
        default: './dev-harness'
      },
      censusIntervalMinutes: {
        required: false,
        description: 'How often to record the party census.',
        default: 5
      },
      rawSampleIntervalMinutes: {
        required: false,
        description: 'How often to capture raw ListPlayers/ListSquads/ListParties output.',
        default: 30
      },
      partyMoveSampleCooldownSeconds: {
        required: false,
        description: 'Minimum gap between ListParties snapshots taken because a party moved. A scramble moves many parties in seconds; one snapshot covers them.',
        default: 20
      },
      minPlayersForSample: {
        required: false,
        description: 'Census and periodic raw samples are skipped below this population — a near-empty server answers nothing.',
        default: 20
      },
      maxPartySize: {
        required: false,
        description: 'Squad\'s party cap. A party ID shared by more players than this cannot be a party — most likely a "no party" marker.',
        default: 9
      },
      massChangeFraction: {
        required: false,
        description: 'A tick where more than this fraction of players changed team is a round transition, logged as a summary only.',
        default: 0.4
      },
      attributionDelayMs: {
        required: false,
        description: 'How long to wait after a tick before reading S³ move sources, so S³ has emitted them.',
        default: 2000
      },
      markerCommand: {
        required: false,
        description: 'Admin-chat command that writes a note into the log and snapshots ListParties/ListPlayers immediately.',
        default: '!partyprobe'
      },
      joinTimelineSeconds: {
        required: false,
        description: 'How long each joiner\'s team/squad/party fields are followed before the join-timeline entry is written.',
        default: 120
      },
      joinQueryDelaysMs: {
        required: false,
        description: 'After PLAYER_CONNECTED, query ListPlayers directly at these delays to see how soon a party ID is visible, independent of the normal tick.',
        default: [0, 1000, 2000, 3000, 5000, 10000, 15000]
      },
      joinQueryMinGapMs: {
        required: false,
        description: 'Minimum gap between join-driven ListPlayers queries. A burst of joins shares one query.',
        default: 500
      },
      maxTrackedJoiners: {
        required: false,
        description: 'Cap on joiners followed at once, so a seed-start flood cannot grow the probe without bound.',
        default: 40
      }
    };
  }

  constructor(server, options, connectors) {
    super(server, options, connectors);

    // eosID -> { name, teamID, squadID, partyID }
    this._prev = new Map();
    // eosID -> { source, at } from S3_PLAYER_TEAM_CHANGED
    this._sources = new Map();
    // eosIDs whose first real team has been seen (for party-member-assigned)
    this._teamSeen = new Set();
    this._firstTick = true;
    this._round = 0;
    this._newGameSinceLastTick = false;
    this._lastCensusAt = 0;
    this._lastRawAt = 0;
    this._lastPartyMoveSampleAt = 0;
    this._rawInFlight = false;
    this._timers = new Set();
    // eosID -> { name, connectedAt|null, firstSeenAt|null, samples: [{ms, src, teamID, squadID, partyID}] }
    this._joiners = new Map();
    this._joinQueryAt = 0;
    this._joinQueryInFlight = false;
    this._joinQueryPending = false;
    this._predictionStats = { hit: 0, falseAlarm: 0, miss: 0, correct: 0, unjudged: 0 };

    this.onUpdatedPlayerInformation = this.onUpdatedPlayerInformation.bind(this);
    this.onS3TeamChanged = this.onS3TeamChanged.bind(this);
    this.onNewGame = this.onNewGame.bind(this);
    this.onChatMessage = this.onChatMessage.bind(this);
    this.onPlayerConnected = this.onPlayerConnected.bind(this);
  }

  async mount() {
    if (!this.options.enabled) {
      this.verbose(1, '[PartyProbe] Disabled (options.enabled is false).');
      return;
    }

    this.dataDir = path.resolve(this.options.dataDir);
    this.rawDir = path.join(this.dataDir, 'party-probe-raw');
    fs.mkdirSync(this.rawDir, { recursive: true });
    this.logPath = path.join(this.dataDir, 'party-probe.jsonl');

    this.server.on('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInformation);
    this.server.on('S3_PLAYER_TEAM_CHANGED', this.onS3TeamChanged);
    this.server.on('NEW_GAME', this.onNewGame);
    this.server.on('CHAT_MESSAGE', this.onChatMessage);
    this.server.on('PLAYER_CONNECTED', this.onPlayerConnected);
    this._mounted = true;

    this.verbose(1, `[PartyProbe] ENABLED — logging to ${this.logPath}`);
    this.appendLog({ kind: 'probe-mounted', options: { ...this.options } });
  }

  async unmount() {
    if (!this._mounted) return;
    this.server.removeListener('UPDATED_PLAYER_INFORMATION', this.onUpdatedPlayerInformation);
    this.server.removeListener('S3_PLAYER_TEAM_CHANGED', this.onS3TeamChanged);
    this.server.removeListener('NEW_GAME', this.onNewGame);
    this.server.removeListener('CHAT_MESSAGE', this.onChatMessage);
    this.server.removeListener('PLAYER_CONNECTED', this.onPlayerConnected);
    for (const t of this._timers) clearTimeout(t);
    this._timers.clear();
    this._joinQueryPending = false;
    this._joiners.clear();
    this._prev.clear();
    this._sources.clear();
    this._teamSeen.clear();
    this._mounted = false;
  }

  // ─── Event handlers (every one wrapped — see header) ───────────────────

  onNewGame() {
    try {
      this._round++;
      this._newGameSinceLastTick = true;
      this.appendLog({ kind: 'new-game', round: this._round });
    } catch (err) {
      this.verbose(1, `[PartyProbe] onNewGame failed: ${err.message}`);
    }
  }

  onS3TeamChanged(data) {
    try {
      const eosID = data?.player?.eosID;
      if (!eosID) return;
      this._sources.set(eosID, { source: data.source ?? null, at: Date.now() });
    } catch (err) {
      this.verbose(1, `[PartyProbe] onS3TeamChanged failed: ${err.message}`);
    }
  }

  onChatMessage(data) {
    try {
      if (data?.chat !== 'ChatAdmin') return;
      const message = String(data.message ?? '').trim();
      const command = this.options.markerCommand;
      if (message !== command && !message.startsWith(`${command} `)) return;
      this.appendLog({
        kind: 'marker',
        round: this._round,
        admin: data.player?.name ?? data.name ?? null,
        note: message.slice(command.length).trim()
      });
      this._sample('marker', ['ListParties', 'ListPlayers']);
    } catch (err) {
      this.verbose(1, `[PartyProbe] onChatMessage failed: ${err.message}`);
    }
  }

  onPlayerConnected(data) {
    try {
      const eosID = data?.eosID ?? data?.player?.eosID;
      if (!eosID) return;
      const joiner = this._joinerFor(eosID, data?.player?.name ?? null);
      if (!joiner || joiner.connectedAt != null) return;
      joiner.connectedAt = Date.now();
      for (const delay of this.options.joinQueryDelaysMs) this._requestJoinQuery(delay);
    } catch (err) {
      this.verbose(1, `[PartyProbe] onPlayerConnected failed: ${err.message}`);
    }
  }

  onUpdatedPlayerInformation() {
    try {
      this._onTick();
    } catch (err) {
      this.verbose(1, `[PartyProbe] tick failed: ${err.message}`);
    }
  }

  // ─── Per-tick work ─────────────────────────────────────────────────────

  _onTick() {
    const now = Date.now();
    const players = (this.server.players ?? []).filter((p) => p?.eosID);
    const current = new Map(players.map((p) => [p.eosID, this._snap(p)]));
    const crossedNewGame = this._newGameSinceLastTick;
    this._newGameSinceLastTick = false;

    if (!this._firstTick) {
      this._recordPartyIdChanges(current, crossedNewGame);
      this._recordTeamChanges(current);
      this._recordAssignments(current);
      this._trackJoiners(current, now);
    } else {
      for (const [eosID, s] of current) if (isRealTeam(s.teamID)) this._teamSeen.add(eosID);
    }

    this._prev = current;
    this._firstTick = false;

    for (const eosID of [...this._teamSeen]) if (!current.has(eosID)) this._teamSeen.delete(eosID);
    for (const [eosID, s] of [...this._sources]) if (now - s.at > 60000) this._sources.delete(eosID);

    if (players.length >= this.options.minPlayersForSample) {
      if (now - this._lastCensusAt >= this.options.censusIntervalMinutes * 60000) {
        this._lastCensusAt = now;
        this._recordCensus(players);
      }
      if (now - this._lastRawAt >= this.options.rawSampleIntervalMinutes * 60000) {
        if (this._sample('periodic', ['ListPlayers', 'ListSquads', 'ListParties'])) this._lastRawAt = now;
      }
    }
  }

  _snap(p) {
    return {
      name: p.name ?? null,
      teamID: p.teamID ?? null,
      squadID: p.squadID ?? null,
      // 'absent' keeps "no Party field on the line" distinct from N/A (null).
      partyID: 'partyID' in p ? p.partyID : 'absent'
    };
  }

  _recordPartyIdChanges(current, crossedNewGame) {
    const changes = [];
    for (const [eosID, s] of current) {
      const prev = this._prev.get(eosID);
      if (!prev || prev.partyID === s.partyID) continue;
      changes.push({ eosID, name: s.name, from: prev.partyID, to: s.partyID, teamID: s.teamID });
    }
    if (!changes.length) return;
    // A map change can reassign everyone; summarise rather than flood.
    if (changes.length > 10) {
      this.appendLog({
        kind: 'party-id-changed',
        round: this._round,
        crossedNewGame,
        count: changes.length,
        ofPlayers: current.size,
        sample: changes.slice(0, 5)
      });
      return;
    }
    for (const c of changes) this.appendLog({ kind: 'party-id-changed', round: this._round, crossedNewGame, ...c });
  }

  _recordTeamChanges(current) {
    const changed = [];
    for (const [eosID, s] of current) {
      const prev = this._prev.get(eosID);
      if (!prev || !isRealTeam(prev.teamID) || !isRealTeam(s.teamID) || prev.teamID === s.teamID) continue;
      changed.push({
        eosID,
        name: s.name,
        from: prev.teamID,
        to: s.teamID,
        squadBefore: prev.squadID,
        squadAfter: s.squadID,
        partyID: s.partyID
      });
    }
    if (!changed.length) return;

    if (changed.length > current.size * this.options.massChangeFraction) {
      this.appendLog({ kind: 'mass-team-change', round: this._round, count: changed.length, ofPlayers: current.size });
      return;
    }

    // Snapshot both rosters now; read S³ sources after it has had time to emit.
    const before = new Map(this._prev);
    const after = new Map(current);
    const tickAt = Date.now();
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      try {
        this._analyseTeamChanges(changed, before, after, tickAt);
      } catch (err) {
        this.verbose(1, `[PartyProbe] team-change analysis failed: ${err.message}`);
      }
    }, this.options.attributionDelayMs);
    this._timers.add(timer);
  }

  _sourceFor(eosID, tickAt) {
    const s = this._sources.get(eosID);
    // Sources from well before this tick belong to an earlier move.
    return s && s.at >= tickAt - 15000 ? s.source : null;
  }

  _analyseTeamChanges(changed, before, after, tickAt) {
    const changedByID = new Map(changed.map((c) => [c.eosID, c]));
    const changes = changed.map((c) => ({ ...c, source: this._sourceFor(c.eosID, tickAt) }));

    const parties = [];
    const partyIDs = new Set(changes.map((c) => c.partyID).filter((id) => typeof id === 'number'));
    for (const partyID of partyIDs) {
      const members = [...after].filter(([, s]) => s.partyID === partyID);
      const moved = members
        .filter(([eosID]) => changedByID.has(eosID))
        .map(([eosID, s]) => ({ ...changedByID.get(eosID), name: s.name, source: this._sourceFor(eosID, tickAt) }));
      const stayed = members.filter(([eosID]) => !changedByID.has(eosID));

      const attributed = moved.filter((m) => isAttributed(m.source));
      const unattributed = moved.filter((m) => !isAttributed(m.source));
      // The direction the deliberate move went; everything else is judged against it.
      const lead = attributed[0] ?? null;
      const target = lead ? lead.to : null;

      let verdict = 'mixed';
      if (!attributed.length) verdict = 'unattributed';
      else if (attributed.length === 1 && unattributed.length && unattributed.every((m) => m.to === target)) verdict = 'leader-drag';
      else if (attributed.length === 1 && !unattributed.length) verdict = 'member-solo';

      parties.push({
        partyID,
        size: members.length,
        verdict,
        // For leader-drag, the one attributed mover is the leader.
        inferredLeader: verdict === 'leader-drag' ? lead.name : null,
        attributed: attributed.map((m) => m.name),
        unattributedMovedWith: unattributed.map((m) => m.name),
        // A mate who moved the opposite way to the deliberate move.
        movedOpposite: target ? moved.filter((m) => m.to !== target).map((m) => m.name) : [],
        // Mates who were already on the destination team before this tick and
        // stayed there. Non-empty alongside a leader-drag means the drag SETS
        // a team rather than swapping each member.
        matesAlreadyThere: target
          ? stayed.filter(([eosID, s]) => s.teamID === target && before.get(eosID)?.teamID === target).map(([, s]) => s.name)
          : [],
        leftBehind: stayed.map(([eosID, s]) => ({ eosID, name: s.name, teamID: s.teamID, squadID: s.squadID })),
        // Squad creator of each mover's previous squad, to test "creator = party leader".
        squadCreatorsBefore: [...new Set(moved.map((m) => this._squadField(m.from, m.squadBefore, 'creatorName')).filter(Boolean))]
      });
    }

    this.appendLog({ kind: 'team-change-tick', round: this._round, players: after.size, changes, parties });

    // Any party of two or more moving is the moment ListParties is worth reading.
    if (parties.some((p) => p.size >= 2)) {
      const now = Date.now();
      if (now - this._lastPartyMoveSampleAt >= this.options.partyMoveSampleCooldownSeconds * 1000) {
        if (this._sample('party-move', ['ListParties'])) this._lastPartyMoveSampleAt = now;
      }
    }
  }

  _recordAssignments(current) {
    for (const [eosID, s] of current) {
      if (!isRealTeam(s.teamID) || this._teamSeen.has(eosID)) continue;
      this._teamSeen.add(eosID);
      if (typeof s.partyID !== 'number') continue;
      const mates = [...current].filter(([id, m]) => id !== eosID && m.partyID === s.partyID);
      if (!mates.length) continue;
      const mateTeams = mates.map(([, m]) => m.teamID);
      this.appendLog({
        kind: 'party-member-assigned',
        round: this._round,
        eosID,
        name: s.name,
        partyID: s.partyID,
        teamID: s.teamID,
        mates: mates.map(([id, m]) => ({ eosID: id, name: m.name, teamID: m.teamID, squadID: m.squadID })),
        sameTeamAsAllMates: mateTeams.every((t) => t === s.teamID)
      });
    }
  }

  // ─── Join timelines ────────────────────────────────────────────────────
  //
  // Answers: when a player joins, how soon do team, squad and party ID show
  // up, and does a direct ListPlayers query see the party ID before the
  // normal tick does? `ms` in every sample counts from PLAYER_CONNECTED when
  // it was seen, otherwise from the first tick that listed the player.

  _joinerFor(eosID, name) {
    let joiner = this._joiners.get(eosID);
    if (joiner) return joiner;
    if (this._joiners.size >= this.options.maxTrackedJoiners) return null;
    joiner = { name, connectedAt: null, firstSeenAt: null, samples: [], squadsAtFirstSeen: null, contextLogged: false };
    this._joiners.set(eosID, joiner);
    return joiner;
  }

  _addJoinSample(joiner, src, fields, now) {
    const origin = joiner.connectedAt ?? joiner.firstSeenAt ?? now;
    const last = joiner.samples[joiner.samples.length - 1];
    if (last && last.listed === fields.listed && last.teamID === fields.teamID && last.squadID === fields.squadID && last.partyID === fields.partyID) return;
    joiner.samples.push({ ms: now - origin, src, ...fields });
  }

  _trackJoiners(current, now) {
    for (const [eosID, s] of current) {
      if (!this._prev.has(eosID)) {
        const joiner = this._joinerFor(eosID, s.name);
        if (joiner && joiner.firstSeenAt == null) {
          joiner.firstSeenAt = now;
          joiner.squadsAtFirstSeen = this._squadStates();
        }
      }
      const joiner = this._joiners.get(eosID);
      if (!joiner) continue;
      if (!joiner.name) joiner.name = s.name;
      this._addJoinSample(joiner, 'tick', { listed: true, teamID: s.teamID, squadID: s.squadID, partyID: s.partyID }, now);
      if (!joiner.contextLogged && typeof s.partyID === 'number') this._writePartyJoinerContext(eosID, joiner, s, current, now);
    }

    for (const [eosID, joiner] of [...this._joiners]) {
      const origin = joiner.connectedAt ?? joiner.firstSeenAt;
      const left = joiner.firstSeenAt != null && !current.has(eosID);
      if (!left && now - origin < this.options.joinTimelineSeconds * 1000) continue;
      this._joiners.delete(eosID);
      this._writeJoinTimeline(eosID, joiner, left, now);
    }
  }

  _writeJoinTimeline(eosID, joiner, left, now) {
    const listed = joiner.samples.filter((x) => x.listed);
    const first = (pred) => {
      const hit = listed.find(pred);
      return hit ? { ms: hit.ms, src: hit.src } : null;
    };
    const firstTick = listed.find((x) => x.src === 'tick') ?? null;

    // Question 12: what a join-time check would have predicted from the
    // first tick, judged against whether a party ID showed within 30 s.
    // Joiners followed for less than 30 s (they left) aren't judged.
    const prediction = !firstTick ? null
      : typeof firstTick.partyID === 'number' ? 'party'
        : typeof firstTick.squadID === 'number' ? 'likely-party'
          : 'solo';
    const followedMs = now - (joiner.connectedAt ?? joiner.firstSeenAt ?? now);
    let judged = 'unjudged';
    if (prediction && followedMs >= 30000) {
      const gotParty = listed.some((x) => x.ms <= 30000 && typeof x.partyID === 'number');
      if (prediction === 'solo') judged = gotParty ? 'miss' : 'correct';
      else judged = gotParty ? 'hit' : 'falseAlarm';
    }
    this._predictionStats[judged]++;
    this.appendLog({
      kind: 'join-timeline',
      round: this._round,
      eosID,
      name: joiner.name,
      sawConnectEvent: joiner.connectedAt != null,
      connectToFirstTickMs: joiner.connectedAt != null && joiner.firstSeenAt != null ? joiner.firstSeenAt - joiner.connectedAt : null,
      atFirstTick: firstTick ? { teamID: firstTick.teamID, squadID: firstTick.squadID, partyID: firstTick.partyID } : null,
      firstTeam: first((x) => x.teamID === 1 || x.teamID === 2),
      firstSquad: first((x) => typeof x.squadID === 'number'),
      squadNameAtEnd: this._squadName(listed[listed.length - 1]?.teamID, listed[listed.length - 1]?.squadID),
      firstParty: first((x) => typeof x.partyID === 'number'),
      endedInParty: typeof listed[listed.length - 1]?.partyID === 'number',
      prediction,
      judged,
      left,
      samples: joiner.samples
    });
  }

  // One ListPlayers query serves every joiner being followed. Requests inside
  // joinQueryMinGapMs of the last query collapse into one pending timer.
  _requestJoinQuery(delayMs) {
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      const wait = this._joinQueryAt + this.options.joinQueryMinGapMs - Date.now();
      if (this._joinQueryInFlight || wait > 0) {
        if (!this._joinQueryPending) {
          this._joinQueryPending = true;
          const retry = setTimeout(() => {
            this._timers.delete(retry);
            this._joinQueryPending = false;
            this._runJoinQuery();
          }, Math.max(wait, 250));
          this._timers.add(retry);
        }
        return;
      }
      this._runJoinQuery();
    }, delayMs);
    this._timers.add(timer);
  }

  async _runJoinQuery() {
    if (this._joinQueryInFlight || !this._joiners.size) return;
    this._joinQueryInFlight = true;
    this._joinQueryAt = Date.now();
    try {
      const response = await this.server.rcon.execute('ListPlayers');
      const now = Date.now();
      const text = typeof response === 'string' ? response : String(response ?? '');
      const seen = new Map();
      for (const line of text.split('\n')) {
        const m = line.match(FORK_LIST_PLAYERS_RE);
        if (!m) continue;
        const eos = (m[2].match(/EOS: (\S+)/) || [])[1];
        if (!eos) continue;
        const g = m.groups;
        seen.set(eos, {
          teamID: g.teamID === 'N/A' ? null : +g.teamID,
          squadID: g.squadID === 'N/A' ? null : +g.squadID,
          partyID: g.partyID === undefined ? 'absent' : g.partyID === 'N/A' ? null : +g.partyID
        });
      }
      for (const [eosID, joiner] of this._joiners) {
        const fields = seen.get(eosID);
        this._addJoinSample(joiner, 'rcon', fields ? { listed: true, ...fields } : { listed: false, teamID: null, squadID: null, partyID: null }, now);
      }
    } catch (err) {
      this.verbose(1, `[PartyProbe] join query failed: ${err.message}`);
    } finally {
      this._joinQueryInFlight = false;
    }
  }

  // ─── Samples ───────────────────────────────────────────────────────────

  _recordCensus(players) {
    const field = { number: 0, null: 0, absent: 0 };
    const byParty = new Map();
    for (const p of players) {
      if (!('partyID' in p)) { field.absent++; continue; }
      if (p.partyID === null) { field.null++; continue; }
      field.number++;
      if (!byParty.has(p.partyID)) byParty.set(p.partyID, []);
      byParty.get(p.partyID).push(p);
    }

    const sizeHistogram = {};
    for (const members of byParty.values()) sizeHistogram[members.length] = (sizeHistogram[members.length] || 0) + 1;

    const describe = ([partyID, members]) => ({
      partyID,
      size: members.length,
      teams: [...new Set(members.map((m) => m.teamID))],
      squads: [...new Set(members.map((m) => `${m.teamID}:${m.squadID}`))],
      // The game names a party's auto-created squad after the party name
      // typed in the main menu; this checks whether that holds.
      squadNames: [...new Set(members.map((m) => this._squadName(m.teamID, m.squadID)).filter(Boolean))],
      // If the game auto-creates the party's squad, its creator may be the
      // party leader, which no RCON field exposes. Compare against leaders
      // proven by a drag in team-change-tick.
      squadCreators: [...new Set(members.map((m) => this._squadField(m.teamID, m.squadID, 'creatorName')).filter(Boolean))],
      names: members.slice(0, 9).map((m) => m.name)
    });
    const entries = [...byParty.entries()];
    const ids = [...byParty.keys()];

    this.appendLog({
      kind: 'census',
      round: this._round,
      players: players.length,
      partyField: field,
      distinctPartyIDs: byParty.size,
      idRange: ids.length ? [Math.min(...ids), Math.max(...ids)] : null,
      playersWithIdZero: byParty.get(0)?.length ?? 0,
      sizeHistogram,
      oversized: entries.filter(([, m]) => m.length > this.options.maxPartySize).map(([id, m]) => ({ partyID: id, size: m.length })),
      largest: entries.sort((a, b) => b[1].length - a[1].length).slice(0, 5).map(describe),
      spanningBothTeams: entries.filter(([, m]) => new Set(m.map((x) => x.teamID).filter(isRealTeam)).size > 1).map(describe),
      spanningSquadsCount: entries.filter(([, m]) => new Set(m.map((x) => `${x.teamID}:${x.squadID}`)).size > 1).length,
      joinPrediction: { ...this._predictionStats }
    });
  }

  // Question 11, written once per joiner on the first tick that shows their
  // party ID. Mates' squads are read twice: from the snapshot taken when the
  // joiner was first seen (before the game seated them), and now.
  _writePartyJoinerContext(eosID, joiner, s, current, now) {
    joiner.contextLogged = true;
    const firstTick = joiner.samples.find((x) => x.src === 'tick' && x.listed) ?? null;
    const squadsThen = joiner.squadsAtFirstSeen ?? {};
    const squadsNow = this._squadStates();
    const origin = joiner.connectedAt ?? joiner.firstSeenAt ?? now;
    const key = (teamID, squadID) => (squadID == null ? null : `${teamID}:${squadID}`);

    const mates = [...current]
      .filter(([id, m]) => id !== eosID && m.partyID === s.partyID)
      .map(([id, m]) => {
        const mateJoiner = this._joiners.get(id);
        const mateOrigin = mateJoiner ? (mateJoiner.connectedAt ?? mateJoiner.firstSeenAt) : null;
        return {
          name: m.name,
          teamID: m.teamID,
          squadID: m.squadID,
          squadThen: squadsThen[key(m.teamID, m.squadID)] ?? null,
          squadNow: squadsNow[key(m.teamID, m.squadID)] ?? null,
          // Positive: the mate arrived first. null: the mate wasn't a
          // recent joiner, so they were on the server before this one.
          joinedMsBeforeThisPlayer: mateOrigin == null ? null : origin - mateOrigin
        };
      });

    this.appendLog({
      kind: 'party-joiner-context',
      round: this._round,
      eosID,
      name: joiner.name,
      partyID: s.partyID,
      msSinceJoin: now - origin,
      joinedInSquad: typeof firstTick?.squadID === 'number',
      squadAtFirstTick: firstTick?.squadID ?? null,
      teamID: s.teamID,
      squadNow: s.squadID,
      ownSquadNow: squadsNow[key(s.teamID, s.squadID)] ?? null,
      mates
    });
  }

  _squadStates() {
    const states = {};
    for (const sq of this.server.squads ?? []) {
      states[`${sq.teamID}:${sq.squadID}`] = { size: sq.size ?? null, locked: sq.locked ?? null };
    }
    return states;
  }

  _squadField(teamID, squadID, field) {
    if (squadID == null) return null;
    const squad = (this.server.squads ?? []).find((s) => String(s.teamID) === String(teamID) && String(s.squadID) === String(squadID));
    return squad?.[field] ?? null;
  }

  _squadName(teamID, squadID) {
    return this._squadField(teamID, squadID, 'squadName');
  }

  // Starts a raw sample unless one is already running. Returns whether it started.
  _sample(reason, commands) {
    if (this._rawInFlight) return false;
    this._rawInFlight = true;
    this._recordRawSample(reason, commands)
      .catch((err) => this.verbose(1, `[PartyProbe] raw sample failed: ${err.message}`))
      .finally(() => { this._rawInFlight = false; });
    return true;
  }

  async _recordRawSample(reason, commands) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = { kind: 'raw-sample', reason, round: this._round };
    for (const command of commands) {
      try {
        const response = await this.server.rcon.execute(command);
        const text = typeof response === 'string' ? response : String(response ?? '');
        const file = path.join(this.rawDir, `${stamp}-${command}.txt`);
        fs.writeFileSync(file, text, 'utf8');
        out[command] = { file, bytes: text.length, crlf: text.includes('\r\n') };
        if (command === 'ListPlayers') {
          const playerLines = text.split('\n').filter((l) => l.startsWith('ID: ') && !l.includes('Since Disconnect'));
          const unmatched = playerLines.filter((l) => !FORK_LIST_PLAYERS_RE.test(l));
          // The fork's trailing Vehicle group is `[^\r\n]+`, so it swallows any
          // field OWI appends after it and the regex still "matches". Counting
          // the field labels themselves catches that.
          const fieldLabels = {};
          for (const l of playerLines) {
            for (const [, label] of l.matchAll(/(?:^|\| )([A-Z][A-Za-z ]*?): /g)) {
              fieldLabels[label] = (fieldLabels[label] || 0) + 1;
            }
          }
          Object.assign(out[command], {
            playerLines: playerLines.length,
            fieldLabels,
            withPartyField: playerLines.filter((l) => l.includes('| Party ID:')).length,
            unmatchedByForkRegex: unmatched.length,
            unmatchedSample: unmatched.slice(0, 3),
            sample: playerLines.slice(0, 5)
          });
        }
        if (command === 'ListParties') {
          // Unknown format, and the likeliest place the leader shows up, so
          // the head of it goes into the log verbatim.
          out[command].sample = text.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).slice(0, 40);
        }
      } catch (err) {
        out[command] = { error: err.message };
      }
    }
    this.appendLog(out);
  }

  appendLog(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    this.verbose(1, `[PartyProbe] ${line}`);
    try {
      fs.appendFileSync(this.logPath, `${line}\n`, 'utf8');
    } catch (err) {
      this.verbose(1, `[PartyProbe] Failed to write log: ${err.message}`);
    }
  }
}
