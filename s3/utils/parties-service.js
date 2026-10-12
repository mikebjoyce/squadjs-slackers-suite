/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               PARTIES SERVICE                                ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Tracks Squad parties (the in-game party system added in the October
 * 2026 patch) from the `partyID` each ListPlayers line carries. The
 * game's party numbers are positions, not identities: whenever any
 * party forms or dissolves, every party after it is renumbered. So
 * this service follows parties by membership and hands out a stable
 * key that survives renumbering.
 *
 * It also does two jobs for the plugins that move players:
 *   - Join prediction. A joiner's party ID usually shows several
 *     seconds after they are listed (under a third have one by 3 s),
 *     but a party joiner normally arrives already in a squad. The
 *     prediction is made once, at registration, and checked against
 *     what the player's party ID did over the next minute.
 *   - Reuniting a party split at join. A fresh joiner who turns out
 *     to be on the other team from their party is moved to it, once,
 *     inside the limits in _planReunites().
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * PartiesService (class, default)
 *   Tracking:    getParty(), isInParty(), getParties(),
 *                onPartiesChanged()
 *   Prediction:  getJoinPrediction(), getJoinPredictionStats()
 *   Reunite:     setReuniteHandlers(), getReuniteStats()
 *   Fed by PlayersService:
 *                noteJoin(), noteLeave(), noteTeamChange(),
 *                handleTick(), reset()
 * predictJoin(row) (function)
 *   The join prediction for one registry row.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * (No local imports. Rows, locks and game phase are injected by
 *  PlayersService; the mover and the warn sender by the S³ plugin.)
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - A party is two or more connected players sharing a non-null
 *   partyID in the same tick. A lone player carrying an ID (their
 *   mates have not connected, or left) is not a tracked party.
 * - Party numbering is server-wide, so a party can have members on
 *   both teams and is still one party. If the game ever numbers per
 *   team, unrelated parties would share a number; _warnIfPerTeam()
 *   logs the signature so it shows in a log before it shows in a
 *   scramble.
 * - Nothing here persists. Parties are rebuilt from the next tick
 *   after a restart, and join predictions exist only for players who
 *   joined while this process was running.
 * - The service never sends RCON by itself. A reunite goes through
 *   the handler the S³ plugin installs, which is the same
 *   target-team move every other plugin uses.
 *
 */

const DEFAULT_JOIN_CHECK_MS = 60000;
const DEFAULT_STATS_WINDOW = 100;
const DEFAULT_FALSE_ALARM_WARN_SHARE = 0.3;
const DEFAULT_MISS_WARN_SHARE = 0.4;
const DEFAULT_REUNITE_WINDOW_MS = 90000;
const DEFAULT_REUNITE_MAX_TEAM_DIFF = 3;
// A share over a handful of joins swings on one player. Below this many
// joins in the denominator, no accuracy warning is raised.
const MIN_SAMPLE_FOR_WARNING = 10;
const WARNING_INTERVAL_MS = 60 * 60 * 1000;

const REUNITE_SOURCE = 'S3:PartyReunite';
// A move by one of these since the player joined doesn't stop a reunite.
// SmartAssign's is the move a reunite exists to undo, and our own has
// already been counted against the once-per-connection limit.
const REUNITE_TRANSPARENT_SOURCES = new Set(['SmartAssign', REUNITE_SOURCE]);

const isRealTeam = (teamID) => teamID === 1 || teamID === 2;
const hasPartyID = (row) => row?.partyID !== null && row?.partyID !== undefined;

/**
 * What a join-time check can say about a player from the row S³ built when
 * it first saw them.
 *
 * @param {object} row - Registry row at registration.
 * @returns {'party'|'likely-party'|'solo'}
 */
export function predictJoin(row) {
  if (hasPartyID(row)) return 'party';
  if (row?.squadID !== null && row?.squadID !== undefined) return 'likely-party';
  return 'solo';
}

export default class PartiesService {
  /**
   * @param {object} deps
   * @param {Function} [deps.verboseLogger]
   * @param {Function} [deps.getRows] - Returns the registry rows (real
   *   rows, not the null-window projection).
   * @param {Function} [deps.isGloballyLocked] - True while a scramble
   *   holds S³'s global lock.
   * @param {Function} [deps.isPlayerLocked] - (eosID) => true while another
   *   plugin holds that player's lock.
   * @param {Function} [deps.isTeamDataSettled] - False while teams are
   *   still resolving after a new game, or the round is ending.
   * @param {object} [deps.options]
   */
  constructor({
    verboseLogger = () => {},
    getRows = () => [],
    isGloballyLocked = () => false,
    isPlayerLocked = () => false,
    isTeamDataSettled = () => true,
    options = {}
  } = {}) {
    this.verboseLogger = verboseLogger;
    this._getRows = getRows;
    this._isGloballyLocked = isGloballyLocked;
    this._isPlayerLocked = isPlayerLocked;
    this._isTeamDataSettled = isTeamDataSettled;

    const num = (value, fallback, min) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= min ? n : fallback;
    };
    this.options = {
      joinCheckMs: num(options.joinCheckMs, DEFAULT_JOIN_CHECK_MS, 1000),
      statsWindow: num(options.statsWindow, DEFAULT_STATS_WINDOW, 1),
      falseAlarmWarnShare: num(options.falseAlarmWarnShare, DEFAULT_FALSE_ALARM_WARN_SHARE, 0),
      missWarnShare: num(options.missWarnShare, DEFAULT_MISS_WARN_SHARE, 0),
      reuniteEnabled: options.reuniteEnabled !== false,
      reuniteWindowMs: num(options.reuniteWindowMs, DEFAULT_REUNITE_WINDOW_MS, 1000),
      reuniteMaxTeamDiff: num(options.reuniteMaxTeamDiff, DEFAULT_REUNITE_MAX_TEAM_DIFF, 0)
    };

    this._parties = new Map(); // key -> { key, partyID, members:Set, formedAt, changedAt }
    this._memberIndex = new Map(); // eosID -> key
    this._nextKey = 1;
    this._callbacks = [];

    // eosID -> join record, for players who joined while this process ran.
    // Removed when the player leaves, so a reconnect starts a fresh one.
    this._joins = new Map();
    this._judged = []; // last `statsWindow` outcomes, oldest first
    // -Infinity, not 0: "never warned" must not read as "warned at the epoch"
    // to a clock that isn't wall time.
    this._lastAccuracyWarningAt = -Infinity;
    this._lastPerTeamWarningAt = -Infinity;

    this._move = null;
    this._warn = null;
    this._reuniteRunning = false;
    this._reuniteStats = { moved: 0, failed: 0, skippedBalance: 0 };
  }

  // ── Fed by PlayersService ─────────────────────────────────────────

  /**
   * A player S³ just registered and announced. Not called for the players
   * found on the server at initial sync: nothing is known about how they
   * arrived, so they get no prediction and are never reunite candidates.
   */
  noteJoin(row, now = Date.now()) {
    const eosID = row?.eosID;
    if (!eosID) return;
    this._joins.set(eosID, {
      at: now,
      prediction: predictJoin(row),
      sawPartyID: hasPartyID(row),
      judged: null,
      reuniteAttempted: false,
      balanceSkipCounted: false,
      intentionalMove: null
    });
  }

  noteLeave(eosID) {
    if (eosID) this._joins.delete(eosID);
  }

  /**
   * A team change S³ reported for a player. One made by an admin or by
   * Switch since the player joined was asked for, and rules that player
   * out of a reunite.
   */
  noteTeamChange(eosID, source) {
    const join = this._joins.get(eosID);
    if (!join) return;
    const label = String(source || 'Unknown');
    const transparent = [...REUNITE_TRANSPARENT_SOURCES].some((s) => label === s || label.startsWith(`${s}:`));
    if (!transparent) join.intentionalMove = label;
  }

  /**
   * Run once per player-list tick, after the registry is committed.
   * Rebuilds the tracked parties, judges due join predictions, and starts
   * any reunite that is due.
   */
  handleTick(now = Date.now()) {
    const rows = this._getRows().filter((row) => row?.eosID);
    const changes = this._retrack(rows, now);
    this._judgeJoins(rows, now);

    if (changes) {
      for (const cb of this._callbacks) {
        try {
          cb(changes);
        } catch (err) {
          this.verboseLogger(1, `[Parties] Parties-changed callback error: ${err.message}`);
        }
      }
    }

    // Not awaited: a reunite sends RCON and refreshes the player list, which
    // re-enters this method through the next tick.
    this._runReunites(rows, now).catch((err) => {
      this.verboseLogger(1, `[Parties] Reunite error: ${err.message}`);
    });

    return changes;
  }

  /** Forget everything. Called when PlayersService unmounts. */
  reset() {
    this._parties.clear();
    this._memberIndex.clear();
    this._joins.clear();
  }

  // ── Tracking ──────────────────────────────────────────────────────

  getParty(eosID) {
    const key = this._memberIndex.get(eosID);
    const party = key ? this._parties.get(key) : null;
    return party ? this._publicParty(party) : null;
  }

  isInParty(eosID) {
    return this._memberIndex.has(eosID);
  }

  getParties() {
    return [...this._parties.values()].map((party) => this._publicParty(party));
  }

  /**
   * @param {Function} callback - Receives { formed, changed, dissolved }
   *   after a tick in which any party formed, changed members or dissolved.
   *   `changed` entries are { party, added, removed }.
   * @returns {Function} unsubscribe
   */
  onPartiesChanged(callback) {
    if (typeof callback !== 'function') {
      throw new Error('PartiesService.onPartiesChanged requires a function callback.');
    }
    this._callbacks.push(callback);
    return () => {
      this._callbacks = this._callbacks.filter((cb) => cb !== callback);
    };
  }

  _publicParty(party) {
    return {
      key: party.key,
      partyID: party.partyID,
      members: [...party.members],
      size: party.members.size,
      formedAt: party.formedAt,
      changedAt: party.changedAt
    };
  }

  _retrack(rows, now) {
    // This tick's groups, by the game's number.
    const raw = new Map(); // partyID -> eosID[]
    for (const row of rows) {
      if (!hasPartyID(row)) continue;
      if (!raw.has(row.partyID)) raw.set(row.partyID, []);
      raw.get(row.partyID).push(row.eosID);
    }
    for (const [partyID, members] of raw) {
      if (members.length < 2) raw.delete(partyID);
    }

    // Pair each group with the tracked party it overlaps most. Largest
    // overlap first, so a merge keeps the larger party's key and a split
    // leaves the key on the larger half.
    const pairs = [];
    for (const party of this._parties.values()) {
      for (const [partyID, members] of raw) {
        let overlap = 0;
        for (const eosID of members) if (party.members.has(eosID)) overlap++;
        if (overlap > 0) pairs.push({ party, partyID, overlap });
      }
    }
    pairs.sort((a, b) =>
      b.overlap - a.overlap ||
      b.party.members.size - a.party.members.size ||
      a.party.formedAt - b.party.formedAt
    );

    const matchedParties = new Map(); // key -> partyID
    const matchedGroups = new Set();
    for (const { party, partyID } of pairs) {
      if (matchedParties.has(party.key) || matchedGroups.has(partyID)) continue;
      matchedParties.set(party.key, partyID);
      matchedGroups.add(partyID);
    }

    this._warnIfPerTeam(rows, raw, pairs, matchedParties, now);

    const formed = [];
    const changed = [];
    const dissolved = [];

    for (const party of [...this._parties.values()]) {
      const partyID = matchedParties.get(party.key);
      if (partyID === undefined) {
        this._parties.delete(party.key);
        dissolved.push(this._publicParty(party));
        continue;
      }
      const members = new Set(raw.get(partyID));
      const added = [...members].filter((eosID) => !party.members.has(eosID));
      const removed = [...party.members].filter((eosID) => !members.has(eosID));
      party.partyID = partyID;
      if (added.length || removed.length) {
        party.members = members;
        party.changedAt = now;
        changed.push({ party: this._publicParty(party), added, removed });
      }
    }

    for (const [partyID, members] of raw) {
      if (matchedGroups.has(partyID)) continue;
      const party = {
        key: `p${this._nextKey++}`,
        partyID,
        members: new Set(members),
        formedAt: now,
        changedAt: now
      };
      this._parties.set(party.key, party);
      formed.push(this._publicParty(party));
    }

    this._memberIndex.clear();
    for (const party of this._parties.values()) {
      for (const eosID of party.members) this._memberIndex.set(eosID, party.key);
    }

    if (!formed.length && !changed.length && !dissolved.length) return null;

    // Quiet by default: on a busy server this is dozens of lines an hour.
    const nameOf = new Map(rows.map((row) => [row.eosID, row.name || row.eosID]));
    const label = (party) => party.members.map((eosID) => nameOf.get(eosID) || eosID).join(', ');
    for (const party of formed) this.verboseLogger(3, `[Parties] Formed ${party.key}: ${label(party)}`);
    for (const entry of changed) {
      this.verboseLogger(3, `[Parties] Changed ${entry.party.key}: now ${label(entry.party)} (+${entry.added.length}, -${entry.removed.length})`);
    }
    for (const party of dissolved) this.verboseLogger(3, `[Parties] Dissolved ${party.key}`);

    return { formed, changed, dissolved };
  }

  /**
   * The signature of per-team party numbering.
   *
   * With one numbering for the whole server, a party with members on both
   * teams is one group every tick. If the game numbered each team
   * separately, two unrelated parties would share a number, this service
   * would track them as one cross-team party, and the first renumbering on
   * either team would pull them apart exactly along the team line with both
   * halves still parties. A real cross-team party can do that too, but it
   * takes its members regrouping by team in the same instant, so seeing it
   * is worth a line in the log.
   */
  _warnIfPerTeam(rows, raw, pairs, matchedParties, now) {
    if (now - this._lastPerTeamWarningAt < WARNING_INTERVAL_MS) return;
    const teamOf = new Map(rows.map((row) => [row.eosID, row.teamID]));

    for (const party of this._parties.values()) {
      const groups = pairs.filter((pair) => pair.party === party && pair.overlap >= 2);
      if (groups.length !== 2) continue;

      const teamsOf = (partyID) =>
        new Set(raw.get(partyID).filter((eosID) => party.members.has(eosID)).map((eosID) => teamOf.get(eosID)));
      const [a, b] = groups.map((group) => teamsOf(group.partyID));
      if (a.size !== 1 || b.size !== 1) continue;
      const [teamA] = a;
      const [teamB] = b;
      if (!isRealTeam(teamA) || !isRealTeam(teamB) || teamA === teamB) continue;

      this._lastPerTeamWarningAt = now;
      this.verboseLogger(
        1,
        `[Parties] WARNING: party ${party.key} split exactly along the team line into two parties ` +
        `(#${groups[0].partyID} on T${teamA}, #${groups[1].partyID} on T${teamB}). If this repeats, the game may be ` +
        'numbering parties per team, and S³ is merging unrelated parties that share a number.'
      );
      return;
    }
  }

  // ── Join prediction ───────────────────────────────────────────────

  /**
   * @returns {'party'|'likely-party'|'solo'|null} null for a player who was
   *   already on the server when S³ started, or who is not connected.
   */
  getJoinPrediction(eosID) {
    return this._joins.get(eosID)?.prediction ?? null;
  }

  /**
   * Counts over the last `statsWindow` judged joins.
   *
   * falseAlarmShare is the share of likely-party predictions that never got
   * a party ID. missShare is the share of party joiners that were predicted
   * solo. Both are null until there is something to divide by.
   */
  getJoinPredictionStats() {
    const counts = { confirmed: 0, hit: 0, falseAlarm: 0, miss: 0, correct: 0 };
    for (const outcome of this._judged) counts[outcome]++;
    const likely = counts.hit + counts.falseAlarm;
    const partyJoiners = counts.confirmed + counts.hit + counts.miss;
    return {
      ...counts,
      judged: this._judged.length,
      pending: [...this._joins.values()].filter((join) => !join.judged).length,
      falseAlarmShare: likely ? counts.falseAlarm / likely : null,
      missShare: partyJoiners ? counts.miss / partyJoiners : null
    };
  }

  _judgeJoins(rows, now) {
    const byID = new Map(rows.map((row) => [row.eosID, row]));

    for (const [eosID, join] of this._joins) {
      const row = byID.get(eosID);
      if (!row) continue;
      if (hasPartyID(row)) join.sawPartyID = true;
      if (join.judged || now - join.at < this.options.joinCheckMs) continue;

      // Judged on whether an ID showed at any tick since the join, not on
      // this tick alone: parties drop members at random, and a player who
      // joined in one and lost it 40 s later was still a party joiner.
      if (join.prediction === 'party') join.judged = 'confirmed';
      else if (join.prediction === 'likely-party') join.judged = join.sawPartyID ? 'hit' : 'falseAlarm';
      else join.judged = join.sawPartyID ? 'miss' : 'correct';

      this._judged.push(join.judged);
      if (this._judged.length > this.options.statsWindow) this._judged.shift();

      if (join.judged === 'miss') {
        const party = this.getParty(eosID);
        const mates = party
          ? party.members
            .filter((id) => id !== eosID)
            .map((id) => `${byID.get(id)?.name || id} (T${byID.get(id)?.teamID ?? '?'})`)
            .join(', ')
          : 'none connected';
        this.verboseLogger(
          2,
          `[Parties] Join prediction miss: ${row.name || eosID} (T${row.teamID ?? '?'}) arrived squadless and was ` +
          `treated as solo, then showed a party ID. Mates: ${mates}.`
        );
      }
    }

    this._warnIfInaccurate(now);
  }

  _warnIfInaccurate(now) {
    if (now - this._lastAccuracyWarningAt < WARNING_INTERVAL_MS) return;
    const stats = this.getJoinPredictionStats();
    const likely = stats.hit + stats.falseAlarm;
    const partyJoiners = stats.confirmed + stats.hit + stats.miss;
    const problems = [];

    if (likely >= MIN_SAMPLE_FOR_WARNING && stats.falseAlarmShare > this.options.falseAlarmWarnShare) {
      problems.push(
        `${stats.falseAlarm} of ${likely} joiners who arrived in a squad never showed a party ID ` +
        `(${Math.round(stats.falseAlarmShare * 100)}%, limit ${Math.round(this.options.falseAlarmWarnShare * 100)}%)`
      );
    }
    if (partyJoiners >= MIN_SAMPLE_FOR_WARNING && stats.missShare > this.options.missWarnShare) {
      problems.push(
        `${stats.miss} of ${partyJoiners} party joiners arrived squadless and were treated as solo ` +
        `(${Math.round(stats.missShare * 100)}%, limit ${Math.round(this.options.missWarnShare * 100)}%)`
      );
    }
    if (!problems.length) return;

    this._lastAccuracyWarningAt = now;
    this.verboseLogger(
      1,
      `[Parties] WARNING: the join-time party prediction is drifting: ${problems.join('; ')}. ` +
      'It rests on party joiners arriving already in a squad, which a game patch can change.'
    );
  }

  // ── Reuniting a party split at join ───────────────────────────────

  /**
   * @param {object} handlers
   * @param {Function} handlers.move - async (eosID, { targetTeamID, source })
   *   => { success } | null. The target-team move from S3PluginBase.
   * @param {Function} [handlers.warn] - async (row, targetTeamID) => void.
   *   Tells the player why they were moved.
   */
  setReuniteHandlers({ move = null, warn = null } = {}) {
    this._move = typeof move === 'function' ? move : null;
    this._warn = typeof warn === 'function' ? warn : null;
  }

  getReuniteStats() {
    return { ...this._reuniteStats };
  }

  /**
   * Which parties to reunite this tick, and who moves.
   *
   * A party qualifies when it has members on both teams and the smaller
   * side is made up entirely of players who joined inside the window. That
   * side moves to the larger one; an even split moves nobody, because
   * there is no telling which side is the stray. Every limit here is there
   * so this never fights another mover or undoes a move somebody asked for:
   *   - a player moved since joining by an admin or by Switch is left alone;
   *   - each player gets at most one reunite move per connection;
   *   - the move must not leave the party's team further ahead than
   *     reuniteMaxTeamDiff.
   */
  _planReunites(rows, now) {
    const byID = new Map(rows.map((row) => [row.eosID, row]));
    const teamSize = { 1: 0, 2: 0 };
    for (const row of rows) if (isRealTeam(row.teamID)) teamSize[row.teamID]++;

    const plans = [];
    for (const party of this._parties.values()) {
      const sides = { 1: [], 2: [] };
      let unresolved = false;
      for (const eosID of party.members) {
        const teamID = byID.get(eosID)?.teamID;
        if (!isRealTeam(teamID)) { unresolved = true; break; }
        sides[teamID].push(eosID);
      }
      if (unresolved || !sides[1].length || !sides[2].length) continue;
      if (sides[1].length === sides[2].length) continue;

      const fromTeam = sides[1].length < sides[2].length ? 1 : 2;
      const targetTeamID = fromTeam === 1 ? 2 : 1;
      const strays = sides[fromTeam];

      const eligible = strays.every((eosID) => {
        const join = this._joins.get(eosID);
        return join &&
          now - join.at <= this.options.reuniteWindowMs &&
          !join.reuniteAttempted &&
          !join.intentionalMove &&
          !this._isPlayerLocked(eosID);
      });
      if (!eligible) continue;

      const diffAfter = (teamSize[targetTeamID] + strays.length) - (teamSize[fromTeam] - strays.length);
      if (diffAfter > this.options.reuniteMaxTeamDiff) {
        // They stay candidates: the teams may even out before the window
        // closes. Logged and counted once per player, not once per tick.
        const fresh = strays.filter((eosID) => !this._joins.get(eosID).balanceSkipCounted);
        if (fresh.length) {
          for (const eosID of fresh) this._joins.get(eosID).balanceSkipCounted = true;
          this._reuniteStats.skippedBalance += fresh.length;
          this.verboseLogger(
            2,
            `[Parties] Not reuniting ${strays.map((eosID) => byID.get(eosID)?.name || eosID).join(', ')} with party ` +
            `${party.key} on T${targetTeamID}: that team would be ${diffAfter} ahead (limit ${this.options.reuniteMaxTeamDiff}).`
          );
        }
        continue;
      }

      plans.push({ party, strays, fromTeam, targetTeamID });
      teamSize[targetTeamID] += strays.length;
      teamSize[fromTeam] -= strays.length;
    }
    return plans;
  }

  async _runReunites(rows, now) {
    if (!this.options.reuniteEnabled || !this._move || this._reuniteRunning) return;
    // A scramble owns team moves while it holds the global lock, and team
    // data means nothing while teams are still resolving after a new game.
    // The game also refuses moves as the round ends. In each case the
    // players stay candidates and are looked at again next tick.
    if (this._isGloballyLocked() || !this._isTeamDataSettled()) return;

    const plans = this._planReunites(rows, now);
    if (!plans.length) return;

    this._reuniteRunning = true;
    try {
      const byID = new Map(rows.map((row) => [row.eosID, row]));
      for (const { party, strays, fromTeam, targetTeamID } of plans) {
        // Marked before anything is sent: a failed send must not be retried
        // on the next tick, and the refresh a move triggers re-enters here.
        for (const eosID of strays) this._joins.get(eosID).reuniteAttempted = true;

        const mates = [...party.members]
          .filter((eosID) => !strays.includes(eosID))
          .map((eosID) => byID.get(eosID)?.name || eosID)
          .join(', ');

        // One at a time. Two team-change commands in flight for the same
        // party can undo each other.
        for (const eosID of strays) {
          const row = byID.get(eosID);
          const name = row?.name || eosID;
          let result = null;
          try {
            result = await this._move(eosID, { targetTeamID, source: REUNITE_SOURCE });
          } catch (err) {
            this.verboseLogger(1, `[Parties] Reunite move failed for ${name}: ${err.message}`);
          }

          if (result?.success) {
            this._reuniteStats.moved++;
            this.verboseLogger(
              1,
              `[Parties] Reunited ${name} with their party: T${fromTeam} -> T${targetTeamID} (party ${party.key}: ${mates}).`
            );
            if (this._warn) {
              try {
                await this._warn(row, targetTeamID);
              } catch (err) {
                this.verboseLogger(2, `[Parties] Reunite warn failed for ${name}: ${err.message}`);
              }
            }
          } else {
            this._reuniteStats.failed++;
            this.verboseLogger(
              1,
              `[Parties] Could not reunite ${name} with their party on T${targetTeamID} (party ${party.key}: ${mates}). Not retrying.`
            );
          }
        }
      }
    } finally {
      this._reuniteRunning = false;
    }
  }
}
