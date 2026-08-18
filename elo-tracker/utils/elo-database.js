/**
  * ╔═══════════════════════════════════════════════════════════════╗
  * ║                         ELO DATABASE                          ║
  * ╚═══════════════════════════════════════════════════════════════╝
  *
  * ─── PURPOSE ─────────────────────────────────────────────────────
  *
  * S³-delegated persistence layer for the EloTracker plugin.
  * All DB access is routed through S³'s DBService (this._s3db) using
  * defineModel/getModel for model access and withTransactionWithRetry
  * for transaction safety. The standalone Sequelize connector and
  * raw sync() calls have been removed per Stage 8.2 Strategy A.
  *
  * ─── EXPORTS ─────────────────────────────────────────────────────
  *
  * EloDatabase (default)
  *   Class. Key public methods:
  *     initDB()                         — Verify models exist; log row counts.
  *     getModel(name)                   — Accessor for Sequelize model via S³.
  *     getPlayerStats(eosID)            — Single player lookup by eosID.
  *     getPlayerStatsBatch(eosIDs)      — Bulk lookup; returns a Map.
  *     searchPlayers(identifier, opts)  — Ranked fuzzy search by eosID/steamID/name.
  *     searchPlayer(identifier, opts)   — Best single match from searchPlayers().
  *     upsertPlayerStats(eosID, fields) — Single-record upsert.
  *     bulkIncrementPlayerStats(updates) — Batch increment in one transaction.
  *     insertRoundHistory(data)         — Append a round record.
  *     getLeaderboard(limit, minRounds, offset) — Top players by CSR.
  *     getPlayerRank(consRating, minRounds) — Rank of a given CSR value.
  *     getTotalRankedPlayers(minRounds) — Count of players meeting min rounds.
  *     exportPlayerStats()              — Full table dump as plain objects.
  *     importPlayerStats(records)       — Bulk restore from export.
  *     pruneStaleEntries(minRounds)     — Delete old low-activity records.
  *     insertRoundPlayers(roundHistoryId, endedAt, playerRows) — Append detail rows.
  *
  *   Leaderboard and rank calculation methods internally apply a
  *   "Competitive Skill Rank" (CSR) formula (μ - 3.0σ) instead of raw Mu.
  *
  * ─── DEPENDENCIES ────────────────────────────────────────────────
  *
  * EloCalculator (./elo-calculator.js)
  *   Default mu/sigma constants and SIGMA_MULTIPLIER for CSR.
  *
  * ─── S³ ACCESS ──────────────────────────────────────────────────
  *
  * Consumer receives the S³ DBService instance at construction
  * (not a separate Sequelize connector). All model references go
  * through this._s3db.getModel('Elo_XXX') and transactions through
  * this._s3db.withTransactionWithRetry(fn). Models are defined by
  * elo-tracker.js mount() via s3db.defineModel() before initDB()
  * is called.
  *
  * ─── NOTES ───────────────────────────────────────────────────────
  *
  * - bulkIncrementPlayerStats() INCREMENTS wins, losses, and roundsPlayed.
  *   All other fields are overwritten. Do not pass cumulative totals.
  * - importPlayerStats() chunks at 500 records per transaction to
  *   prevent SQLite write contention.
  * - pruneStaleEntries() removes provisional players unseen for 30 days
  *   and calibrated players unseen for 90 days.
  * - searchPlayers() attaches a non-persisted `_matchTier` (0 = exact ID,
  *   1 = exact name either as stored or minus clan tags, 2 = prefix,
  *   3 = substring) to every returned row. Callers that must not act on a
  *   guess — !eloadmin reset, for one — should gate on isUnambiguous(),
  *   which requires a good tier AND uniqueness at that tier.
  * - Literal and tag-stripped exact names share tier 1 on purpose, so that
  *   `!elo hunty` resolves to the 384-round `[✦NL✦] Hunty` rather than the
  *   12-round ` Hunty` that happens to hold the bare string. See the
  *   searchPlayers() docblock for the trade-off this accepts.
  * - The exact-name query compares against TRIM(name): Squad stores most
  *   names with a leading space (10,604 of 11,787 rows in one production
  *   export), so an untrimmed compare matches almost nothing in the field.
  *
  * ═══════════════════════════════════════════════════════════════
  */

import Sequelize from 'sequelize';
import EloCalculator from './elo-calculator.js';

const { Op } = Sequelize;

function isLockError(err) {
  const message = String(err?.message || '');
  return (
    message.includes('SQLITE_BUSY') ||
    message.includes('database is locked') ||
    message.includes('Lock wait timeout exceeded') ||
    err?.name === 'SequelizeTimeoutError'
  );
}

export default class EloDatabase {
  /**
   * @param {Object} server   - SquadJS server instance (unused but kept for API compat).
   * @param {Object} options  - EloTracker options.
   * @param {Object} s3db     - S³ DBService instance (from this._s3.db).
   */
  constructor(server, options, s3db) {
    this.server = server;
    this.options = options;
    this._s3db = s3db;
    // Expose verbose so that external code can inject a logger if needed.
    this.verbose = (level, message) => {
      /* intended to be overridden by the owning plugin */
    };
  }

  /** --- Model accessor for external consumers (e.g. elo-discord.js) --- */
  getModel(name) {
    if (!this._s3db) return null;
    return this._s3db.getModel(name) || null;
  }

  /** --- Check whether the DB service is ready --- */
  isReady() {
    return !!(this._s3db && this._s3db.isReady && this._s3db.isReady());
  }

  /* ================================================================
   *  INIT — verify tables exist, log row counts
   *  ================================================================ */

  async initDB() {
    if (!this.isReady()) {
      this.verbose(1, '[DB] S³ DBService not ready — skipped initDB.');
      return false;
    }

    try {
      // Verify all 4 models are accessible; log row counts as sanity check
      const modelNames = ['Elo_PluginState', 'Elo_PlayerStats', 'Elo_RoundHistory', 'Elo_RoundPlayers'];
      for (const name of modelNames) {
        const model = this._s3db.getModel(name);
        if (!model) {
          this.verbose(1, `[DB] WARNING: Model ${name} not found on S³ connector. Migrations may not have run.`);
        }
      }

      const playerStatsCount = this._s3db.getModel('Elo_PlayerStats')
        ? await this._s3db.withTransaction(async (t) => {
            return await this._s3db.getModel('Elo_PlayerStats').count({ transaction: t });
          }).catch(() => 0)
        : 0;
      this.verbose(1, `[DB] PlayerStats table initialized: ${playerStatsCount} rows found on startup.`);

      // Ensure PluginState row exists (id=1) for backwards-compatible checks
      const psModel = this._s3db.getModel('Elo_PluginState');
      if (psModel) {
        await this._s3db.withTransaction(async (t) => {
          await psModel.findOrCreate({
            where: { id: 1 },
            defaults: { id: 1 },
            transaction: t
          });
        });
      }

      this.verbose(1, '[DB] Database initialized.');
      return true;
    } catch (error) {
      this.verbose(1, `[DB] Error initializing database: ${error.message}`);
      return false;
    }
  }

  /* ================================================================
   *  HELPERS — internal retry wrapper (delegates to S³)
   *  ================================================================ */

  async _withDb(fn) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(fn);
    } catch (err) {
      if (!isLockError(err)) {
        this.verbose(1, `[DB] Error in _withDb: ${err.message}`);
      }
      return null;
    }
  }

  /* ================================================================
   *  PLAYER STATS — single / batch / search / upsert / increment
   *  ================================================================ */

  async getPlayerStats(eosID) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const record = await this._s3db.getModel('Elo_PlayerStats').findOne({
          where: { eosID },
          transaction: t
        });
        return record ? record.toJSON() : null;
      });
    } catch (error) {
      this.verbose(1, `[DB] Error fetching stats for ${eosID}: ${error.message}`);
      return null;
    }
  }

  async getPlayerStatsBatch(eosIDs) {
    if (!this.isReady()) return new Map();
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const records = await this._s3db.getModel('Elo_PlayerStats').findAll({
          where: { eosID: { [Op.in]: eosIDs } },
          transaction: t
        });
        const map = new Map();
        for (const record of records) {
          map.set(record.eosID, record.toJSON());
        }
        return map;
      });
    } catch (error) {
      this.verbose(1, `[DB] Error fetching batch stats: ${error.message}`);
      return new Map();
    }
  }

  /**
   * Ranked player search. Returns candidates best-match-first.
   *
   * ─── WHY THIS IS RANKED ──────────────────────────────────────────
   *
   * The previous implementation was a single `findOne` over
   * `eosID = id OR steamID = id OR name LIKE %id%` with **no ORDER BY**.
   * Any substring hit could win, decided purely by whatever row order the
   * engine happened to return (rowid order on SQLite). In production
   * `!elo cerv` resolved to `Cerveira` (2 rounds) instead of `[NL] Cerv`
   * (267 rounds) — not "the wrong player" so much as "an arbitrary player",
   * and a result that could silently flip after any table rewrite.
   *
   * ─── SCORING ─────────────────────────────────────────────────────
   *
   * Candidates are bucketed into tiers; the best (lowest) tier present
   * wins outright, and lower tiers are only ever runners-up:
   *
   *   0  exact eosID or steamID          (an ID is never ambiguous)
   *   1  exact name, case-insensitive, EITHER as stored or once clan tags
   *      are stripped ("[NL] Cerv" -> "Cerv")
   *   2  prefix match on raw or tag-stripped name
   *   3  substring match anywhere
   *
   * Within a tier: currently-online players first (someone typing a partial
   * name mid-round almost always means the player in the match), then most
   * roundsPlayed, then most recent lastSeen. That ordering is what actually
   * fixes the reported bug — both `Cerveira` and `[NL] Cerv` land in
   * tier 3, and 267 rounds beats 2.
   *
   * ─── WHY LITERAL AND TAG-STRIPPED SHARE TIER 1 ───────────────────
   *
   * They were separate tiers at first (literal above tag-stripped), which
   * meant an exact stored name beat a tagged one outright no matter how
   * lopsided the two accounts were. In production that gave:
   *
   *   " Hunty"       12 rounds,   5W/7L    <- won, purely for being literal
   *   "[✦NL✦] Hunty" 384 rounds, 201W/183L
   *
   * A clan tag is decoration, not identity: players type `hunty` meaning the
   * regular, not the drive-by account that happens to hold the bare string.
   * Merging the two lets roundsPlayed decide, and the loser is still named in
   * the "Also matched" line.
   *
   * The cost, accepted knowingly: an account whose stored name equals another
   * player's tag-stripped name is no longer reachable by any name string —
   * `hunty` and ` Hunty` now both resolve to the tagged player. Those accounts
   * remain reachable by SteamID, and by bare `!elo` for the player themselves.
   * Measured on the 2026-08-17 export (11,787 rows, 11,484 distinct names),
   * 51 terms have both kinds of match and 29 change winner — every one of them
   * toward the higher-round account, 20 with a 5x or greater rounds gap.
   *
   * ─── WHY THE SCORING IS IN JS, NOT SQL ───────────────────────────
   *
   * Tier scoring needs case-insensitive compares, tag stripping, and a
   * CASE-style ordering — every one of which behaves differently across
   * SQLite / MySQL / Postgres (see §7.10 of the developer guide). Ranking in
   * JS keeps the SQL down to `LIKE` + `ORDER BY "roundsPlayed" DESC` +
   * `LIMIT`, all of which are portable, and gives identical results on every
   * engine.
   *
   * The exact-ID and exact-name lookups are issued as their own queries
   * rather than being filtered out of the fuzzy result set. If they shared
   * the fuzzy query's LIMIT, a legitimate exact-name match with a low round
   * count could be truncated away by high-round substring noise.
   *
   * @param {string} identifier          - eosID, steamID, or (partial) name.
   * @param {Object} [opts]
   * @param {number} [opts.limit=100]    - Max fuzzy rows pulled for scoring.
   *        A tag-stripped exact name cannot be pre-queried in SQL —
   *        tag stripping is JS-side — so a tag-wearing player is only ever
   *        found by the fuzzy pass, and too small a limit can truncate them
   *        away on a common substring. The engine scans for `%term%` either
   *        way; the limit only bounds rows returned, so this costs little.
   * @param {Set<string>|string[]} [opts.onlineIDs] - eosIDs/steamIDs currently
   *        on the server; used only as an intra-tier tiebreak. Supplied by the
   *        caller because the DB layer has no S³ PlayersService access.
   * @returns {Promise<Array<Object>>}   - Ranked plain objects, each carrying a
   *        non-persisted `_matchTier` field so callers can decide whether the
   *        match was unambiguous enough to act on (see !eloadmin reset).
   */
  async searchPlayers(identifier, opts = {}) {
    if (!this.isReady() || !identifier) return [];
    const id = String(identifier).trim();
    if (!id) return [];

    const limit = Number.isFinite(opts.limit) ? opts.limit : 100;
    const onlineIDs = opts.onlineIDs instanceof Set
      ? opts.onlineIDs
      : new Set(Array.isArray(opts.onlineIDs) ? opts.onlineIDs : []);

    try {
      const rows = await this._s3db.withTransactionWithRetry(async (t) => {
        const model = this._s3db.getModel('Elo_PlayerStats');

        // Tier 0 — exact ID. Short-circuits everything: an ID match is
        // unambiguous by construction, so there is nothing to disambiguate
        // and no reason to pay for the fuzzy scan.
        const byId = await model.findOne({
          where: { [Op.or]: [{ eosID: id }, { steamID: id }] },
          transaction: t
        });
        if (byId) return [{ row: byId.toJSON(), tier: 0 }];

        const collected = new Map(); // eosID -> { row, tier } — first (best) tier wins

        const add = (row, tier) => {
          if (!row?.eosID) return;
          if (collected.has(row.eosID)) return;
          collected.set(row.eosID, { row, tier });
        };

        // Tier 1 (literal half) — exact name as stored. A wildcard-free LIKE
        // gives case-insensitivity
        // on every dialect for free; the helper escapes %, _ and the escape
        // character itself, so a name containing them is matched literally
        // rather than as a pattern.
        //
        // trimColumn is not optional here. Squad stores most names with a
        // leading space — in one production export 10,604 of 11,787 rows — so
        // comparing against the raw column makes this query match almost
        // nothing, and every real exact match falls through to the LIMITed
        // fuzzy pass below where a common substring can truncate it away.
        // That is precisely the guard this query exists to provide.
        const exactNameRows = await model.findAll({
          where: this._s3db.caseInsensitiveLikeLiteral('name', id, { exact: true, trimColumn: true }),
          order: [['roundsPlayed', 'DESC']],
          limit,
          transaction: t
        });
        for (const r of exactNameRows) add(r.toJSON(), 1);

        // Tiers 1-3 — one fuzzy substring pass, scored below. It can still
        // produce tier 1 hits: the tag-stripped half of tier 1 is JS-side, so
        // "[NL] Cerv" can only ever arrive through here. Ordered by
        // roundsPlayed so that when the LIMIT does bite, it drops the least
        // established accounts rather than an arbitrary slice.
        const fuzzyRows = await model.findAll({
          where: this._s3db.caseInsensitiveLikeLiteral('name', id),
          order: [['roundsPlayed', 'DESC']],
          limit,
          transaction: t
        });
        for (const r of fuzzyRows) add(r.toJSON(), null); // tier scored in JS

        return [...collected.values()];
      });

      return EloDatabase._rankSearchRows(rows, id, onlineIDs);
    } catch (error) {
      this.verbose(1, `[DB] Error searching for player ${id}: ${error.message}`);
      return [];
    }
  }

  /**
   * Assigns a match tier to every candidate and sorts best-first.
   * Split out from searchPlayers() so it is directly unit-testable without
   * a database — the ranking rules are the part most likely to need tuning.
   *
   * @param {Array<{row: Object, tier: ?number}>} rows - Candidates. A non-null
   *        `tier` is authoritative (set by an exact ID/name query); null means
   *        "score me from the name".
   * @param {string} term        - Raw search term as typed.
   * @param {Set<string>} online - eosIDs/steamIDs currently on the server.
   * @returns {Array<Object>} Ranked rows, each with `_matchTier` attached.
   */
  static _rankSearchRows(rows, term, online = new Set()) {
    const needle = String(term).trim().toLowerCase();

    const scored = rows.map(({ row, tier }) => {
      let resolvedTier = tier;

      if (resolvedTier === null || resolvedTier === undefined) {
        const raw = String(row.name || '').trim().toLowerCase();
        const bare = EloDatabase.stripClanTags(row.name).toLowerCase();

        // Literal and tag-stripped exact matches share tier 1 deliberately —
        // see "WHY LITERAL AND TAG-STRIPPED SHARE TIER 1" on searchPlayers().
        // Whoever has more rounds then wins on the tiebreak below.
        if (raw === needle || bare === needle) resolvedTier = 1;
        else if (raw.startsWith(needle) || bare.startsWith(needle)) resolvedTier = 2;
        else resolvedTier = 3; // matched the LIKE, so it is a substring hit somewhere
      }

      return {
        row: { ...row, _matchTier: resolvedTier },
        tier: resolvedTier,
        // Online is a tiebreak *within* a tier, never across tiers: a
        // spectating alt should not outrank an exact-name match.
        online: online.has(row.eosID) || (row.steamID ? online.has(row.steamID) : false)
      };
    });

    scored.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.online !== b.online) return a.online ? -1 : 1;
      const rounds = (b.row.roundsPlayed || 0) - (a.row.roundsPlayed || 0);
      if (rounds !== 0) return rounds;
      return (b.row.lastSeen || 0) - (a.row.lastSeen || 0);
    });

    return scored.map((s) => s.row);
  }

  /**
   * Strips leading/trailing clan decoration from a player name so that
   * "[NL] Cerv", "=NL= Cerv" and "Cerv" all compare equal.
   *
   * Deliberately narrower than ClansService.extractRawPrefix(), which also
   * guesses at unbracketed prefixes (any 2-7 char first word). That guessing
   * is right for grouping clans but wrong here: it would strip the first word
   * off ordinary two-word names and make "John Smith" match a search for
   * "Smith" at exact-match tier. Only unambiguous bracket/symbol-delimited
   * decoration is removed.
   *
   * @param {string} name
   * @returns {string} Name with clan decoration removed (may be unchanged).
   */
  static stripClanTags(name) {
    if (!name || typeof name !== 'string') return '';
    const original = name.trim();
    let out = original;

    // Leading bracketed or symbol-delimited tag: [NL], (NL), {NL}, <NL>, |NL|, =NL=
    out = out.replace(/^\s*[[({<|=][^\])}>|=]{0,20}[\])}>|=]\s*/u, '');
    // Trailing bracketed tag: "Cerv [NL]"
    out = out.replace(/\s*[[({<|=][^\])}>|=]{0,20}[\])}>|=]\s*$/u, '');
    // Leftover decorative separators/symbols at either end.
    out = out.replace(/^[\s\-_.|/\\*~+]+/u, '').replace(/[\s\-_.|/\\*~+]+$/u, '');

    // Never return empty: a name that is *only* a tag (e.g. "[NL]") must
    // still compare as itself rather than as the empty string, which would
    // otherwise exact-match every blank search term.
    return out.trim() || original;
  }

  /**
   * Is this result set safe for a destructive command to act on?
   *
   * Destructive commands (!eloadmin reset, !elo reset <identifier>) must not
   * act on a guess, so they require BOTH:
   *
   *   1. A good tier — 0 (exact ID) or 1 (exact name, as stored or minus clan
   *      tags). A prefix or substring hit is a guess by definition.
   *   2. Uniqueness *at that tier* — nobody else matched equally well.
   *
   * Rule 2 is the one that is easy to miss. `[NL] Cerv` and `[US] Cerv` both
   * strip to `Cerv`, so the term "cerv" matches both at tier 1 and the ranker
   * picks the higher-round one — exactly the silent-wrong-player behaviour the
   * ranking was introduced to stop, except here it would wipe a rating rather
   * than print the wrong stats. Since literal and tag-stripped names now share
   * tier 1, this also covers ` Hunty` vs `[NL] Hunty`: `reset hunty` is refused
   * rather than resolving to whichever has more rounds.
   *
   * Uniqueness is deliberately scoped to the winning tier rather than the whole
   * result set: an exact full name must stay resettable even when longer names
   * share its prefix, or `reset Cerv` would be permanently refused just because
   * a `Cerveira` exists.
   *
   * @param {Array<Object>} candidates - Ranked rows from searchPlayers().
   * @returns {boolean}
   */
  static isUnambiguous(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return false;
    const best = candidates[0]._matchTier ?? 3;
    if (best > 1) return false;
    return candidates.filter((p) => (p._matchTier ?? 3) === best).length === 1;
  }

  /**
   * Renders the runner-up matches as a single short line, or null when the
   * match was unambiguous.
   *
   * The lookup deliberately answers immediately with its best guess rather
   * than prompting the user to pick from a numbered list: in-game responses
   * go out as one-shot `rcon.warn` messages with no reply channel, so a
   * prompt would just force the player to retype anyway. Naming the
   * runners-up gets the same information across in one line and costs the
   * player nothing when the top hit was already right.
   *
   * Suppression is delegated to isUnambiguous() rather than duplicating a tier
   * test, so the line appears in exactly the cases a destructive command would
   * refuse to act on — one definition of "this was a guess", used by both.
   *
   * That coupling is what surfaces the tier-1 contests. The earlier rule
   * suppressed the line for any tier <= 1, so when ` Hunty` and `[NL] Hunty`
   * both matched, the reply named one and gave no hint the other existed —
   * wrong answer and no way to tell. A unique exact hit still shows nothing,
   * even when prefix/substring runners-up trail it, because there is genuinely
   * nothing to second-guess.
   *
   * @param {Array<Object>} candidates - Ranked rows from searchPlayers().
   * @param {number} [max=3]           - Max runners-up to name.
   * @returns {string|null}
   */
  static formatOtherMatches(candidates, max = 3) {
    if (!Array.isArray(candidates) || candidates.length < 2) return null;
    if (EloDatabase.isUnambiguous(candidates)) return null;

    const others = candidates.slice(1, 1 + max)
      .map((p) => `${String(p.name || '?').trim()} (${p.roundsPlayed || 0} rds)`);
    if (!others.length) return null;

    const extra = candidates.length - 1 - others.length;
    const suffix = extra > 0 ? `, +${extra} more` : '';
    return `Also matched: ${others.join(', ')}${suffix}. Use a fuller name or SteamID.`;
  }

  /**
   * Best single match, or null. Thin wrapper over searchPlayers() kept for
   * call-site compatibility — prefer searchPlayers() when you also want to
   * tell the user about runner-up matches.
   *
   * @param {string} identifier
   * @param {Object} [opts] - Forwarded to searchPlayers().
   * @returns {Promise<Object|null>}
   */
  async searchPlayer(identifier, opts = {}) {
    const results = await this.searchPlayers(identifier, opts);
    return results.length ? results[0] : null;
  }

  async upsertPlayerStats(eosID, fields) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const model = this._s3db.getModel('Elo_PlayerStats');
        const existing = await model.findOne({ where: { eosID }, transaction: t });
        if (existing) {
          await existing.update(fields, { transaction: t });
          return existing.toJSON();
        } else {
          const created = await model.create({ eosID, ...fields }, { transaction: t });
          return created.toJSON();
        }
      });
    } catch (error) {
      this.verbose(1, `[DB] Error upserting stats for ${eosID}: ${error.message}`);
      return null;
    }
  }

  async bulkIncrementPlayerStats(updates) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const model = this._s3db.getModel('Elo_PlayerStats');
        const eosIDs = updates.map((u) => u.eosID);
        const existing = await model.findAll({
          where: { eosID: { [Op.in]: eosIDs } },
          transaction: t
        });
        const existingMap = new Map(existing.map((r) => [r.eosID, r]));

        const ops = updates.map(update => {
          const { eosID, ...fields } = update;
          const record = existingMap.get(eosID);
          if (record) {
            // Integrity check: roundsPlayed=0 but mu≠default indicates a column reset
            if (record.roundsPlayed === 0 && record.mu !== EloCalculator.MU_DEFAULT) {
              this.verbose(1, `[DB] WARNING: Integrity anomaly for eosID ${eosID} (name: ${record.name}) — roundsPlayed=0 but mu=${record.mu.toFixed(2)} (non-default). Possible column reset detected.`);
            }
            return record.update({
              mu: fields.mu,
              sigma: fields.sigma,
              wins: record.wins + (fields.wins ?? 0),
              losses: record.losses + (fields.losses ?? 0),
              roundsPlayed: record.roundsPlayed + (fields.roundsPlayed ?? 0),
              lastSeen: fields.lastSeen,
              name: fields.name ?? record.name,
              steamID: fields.steamID ?? record.steamID
            }, { transaction: t });
          } else {
            this.verbose(1, `[DB] WARNING: bulkIncrement — eosID ${eosID} not found in DB (name: ${fields.name}), creating new record with wins=${fields.wins ?? 0} losses=${fields.losses ?? 0} roundsPlayed=${fields.roundsPlayed ?? 0}.`);
            return model.create({ eosID, ...fields }, { transaction: t });
          }
        });

        await Promise.all(ops);
      });
    } catch (error) {
      this.verbose(1, `[DB] Error bulk upserting stats: ${error.message}`);
      return null;
    }
  }

  /* ================================================================
   *  ROUND HISTORY
   *  ================================================================ */

  async insertRoundHistory(data) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const record = await this._s3db.getModel('Elo_RoundHistory').create(data, { transaction: t });
        return record.toJSON();
      });
    } catch (error) {
      this.verbose(1, `[DB] Error inserting round history: ${error.message}`);
      return null;
    }
  }

  /* ================================================================
   *  LEADERBOARD & RANKING
   *  ================================================================ */

  async getLeaderboard(limit = 20, minRounds = 10, offset = 0) {
    if (!this.isReady()) return [];
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const model = this._s3db.getModel('Elo_PlayerStats');
        const records = await model.findAll({
          where: {
            roundsPlayed: { [Op.gte]: minRounds }
          },
          // Postgres-safe unquoted: `mu` and `sigma` are already all-lowercase, so
          // Postgres identifier folding is a no-op. A camelCase column here would
          // need this._s3db.quoteIdentifier() — see DBService "DIALECT PORTABILITY".
          order: [[Sequelize.literal(`(mu - (${EloCalculator.SIGMA_MULTIPLIER} * sigma))`), 'DESC']],
          limit: limit,
          offset: offset,
          transaction: t
        });
        return records.map((r) => r.toJSON());
      });
    } catch (error) {
      this.verbose(1, `[DB] Error fetching leaderboard: ${error.message}`);
      return [];
    }
  }

  async getPlayerRank(consRating, minRounds = 0) {
    if (!this.isReady()) return 0;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const model = this._s3db.getModel('Elo_PlayerStats');
        // Op imported from Sequelize at module level
        const whereClause = minRounds > 0
          ? { roundsPlayed: { [Op.gte]: minRounds } }
          : {};
        whereClause[Op.and] = Sequelize.literal(`(mu - (${EloCalculator.SIGMA_MULTIPLIER} * sigma)) > ${Number(consRating)}`);

        const higherRanked = await model.count({ where: whereClause, transaction: t });
        return higherRanked + 1;
      });
    } catch (error) {
      this.verbose(1, `[DB] Error fetching player rank for consRating ${consRating}: ${error.message}`);
      return 0;
    }
  }

  async getTotalPlayers() {
    if (!this.isReady()) return 0;
    try {
      return await this._s3db.withTransaction(async (t) => {
        return await this._s3db.getModel('Elo_PlayerStats').count({ transaction: t });
      }).catch(() => 0);
    } catch (error) {
      this.verbose(1, `[DB] Error fetching total players: ${error.message}`);
      return 0;
    }
  }

  async getTotalRankedPlayers(minRounds = 10) {
    if (!this.isReady()) return 0;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        return await this._s3db.getModel('Elo_PlayerStats').count({
          where: { roundsPlayed: { [Op.gte]: minRounds } },
          transaction: t
        });
      });
    } catch (error) {
      this.verbose(1, `[DB] Error fetching total ranked players: ${error.message}`);
      return 0;
    }
  }

  /* ================================================================
   *  EXPORT / IMPORT
   *  ================================================================ */

  async exportPlayerStats() {
    if (!this.isReady()) return [];
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        const records = await this._s3db.getModel('Elo_PlayerStats').findAll({ transaction: t });
        return records.map((r) => r.toJSON());
      });
    } catch (error) {
      this.verbose(1, `[DB] Error exporting stats: ${error.message}`);
      return [];
    }
  }

  async importPlayerStats(records) {
    if (!this.isReady()) return null;
    const CHUNK_SIZE = 500;
    try {
      this.verbose(1, `[DB] Import started: ${records.length} players to restore.`);

      for (let i = 0; i < records.length; i += CHUNK_SIZE) {
        const chunk = records.slice(i, i + CHUNK_SIZE);
        await this._s3db.withTransactionWithRetry(async (t) => {
          await this._s3db.getModel('Elo_PlayerStats').bulkCreate(chunk, {
            updateOnDuplicate: [
              'steamID', 'discordID', 'name', 'mu', 'sigma',
              'wins', 'losses', 'roundsPlayed', 'lastSeen'
            ],
            transaction: t
          });
        });
      }

      // Log post-import row count and spot-check a sample record
      const postImportCount = await this._s3db.withTransaction(async (t) => {
        return await this._s3db.getModel('Elo_PlayerStats').count({ transaction: t });
      }).catch(() => 0);

      let sampleRecord = null;
      if (records.length > 0) {
        sampleRecord = await this._s3db.withTransaction(async (t) => {
          return await this._s3db.getModel('Elo_PlayerStats').findOne({
            where: { eosID: records[0].eosID },
            transaction: t
          });
        }).catch(() => null);
      }

      if (sampleRecord) {
        this.verbose(1, `[DB] Import complete: ${postImportCount} total rows. Sample check: eosID=${sampleRecord.eosID} wins=${sampleRecord.wins} losses=${sampleRecord.losses} roundsPlayed=${sampleRecord.roundsPlayed}.`);
      } else {
        this.verbose(1, `[DB] Import complete: ${postImportCount} total rows.`);
      }

      return true;
    } catch (error) {
      this.verbose(1, `[DB] Error importing stats: ${error.message}`);
      return null;
    }
  }

  /* ================================================================
   *  MAINTENANCE — prune / bulk insert
   *  ================================================================ */

  async pruneStaleEntries(minRoundsForLeaderboard) {
    if (!this.isReady()) return { tier1: 0, tier2: 0 };
    const now = Date.now();
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const ninetyDays = 90 * 24 * 60 * 60 * 1000;

    try {
      const tier1Count = await this._s3db.withTransactionWithRetry(async (t) => {
        return await this._s3db.getModel('Elo_PlayerStats').destroy({
          where: {
            lastSeen: { [Op.lt]: now - thirtyDays },
            roundsPlayed: { [Op.lt]: minRoundsForLeaderboard }
          },
          transaction: t
        });
      });

      const tier2Count = await this._s3db.withTransactionWithRetry(async (t) => {
        return await this._s3db.getModel('Elo_PlayerStats').destroy({
          where: {
            lastSeen: { [Op.lt]: now - ninetyDays },
            roundsPlayed: { [Op.gte]: minRoundsForLeaderboard }
          },
          transaction: t
        });
      });

      this.verbose(1, `[DB] Pruned stale entries — Tier 1 (provisional): ${tier1Count} deleted. Tier 2 (calibrated): ${tier2Count} deleted.`);
      return { tier1: tier1Count, tier2: tier2Count };
    } catch (error) {
      this.verbose(1, `[DB] Error pruning stale entries: ${error.message}`);
      return { tier1: 0, tier2: 0 };
    }
  }

  async insertRoundPlayers(roundHistoryId, endedAt, playerRows) {
    if (!this.isReady()) return null;
    try {
      return await this._s3db.withTransactionWithRetry(async (t) => {
        if (playerRows && playerRows.length > 0) {
          await this._s3db.getModel('Elo_RoundPlayers').bulkCreate(playerRows, { transaction: t });
        }
        this.verbose(4, `[DB] Inserted ${playerRows ? playerRows.length : 0} player records for round ${roundHistoryId}`);
        return { roundHistoryId, playerCount: playerRows ? playerRows.length : 0 };
      });
    } catch (error) {
      this.verbose(1, `[DB] insertRoundPlayers failed: ${error.message}`);
      return null;
    }
  }
}