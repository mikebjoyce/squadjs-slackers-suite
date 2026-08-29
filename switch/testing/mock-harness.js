/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║         SWITCH TEST — MOCK HARNESS                           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Provides realistic mock objects for unit-testing Switch plugin
 * token bucket logic without a live SquadJS server, database, RCON,
 * or Discord connection.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * createMockHarness(options)
 *   Returns { plugin, db, clock } where:
 *     - plugin  — mock Switch plugin instance with _regenTokens,
 *                 _spendToken, _checkSwitchEligibility, etc.
 *     - db      — in-memory Map accessor for PlayerCooldowns
 *     - clock   — { now, advance, set } for deterministic time
 *
 * createMockDb()
 *   Returns a mock DB with findByPk, upsert, update, create, findAll.
 *
 * MockClock()
 *   Returns a controllable clock { now: number, advance(ms), set(ts) }.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   import { createMockHarness } from './mock-harness.js';
 *   const { plugin, db, clock } = createMockHarness({
 *     maxSwitchTokens: 2,
 *     switchCooldownHours: 1
 *   });
 *   const row = db.upsert({ eosID: 'test1', tokenBalance: 2, tokenRegenAnchor: null });
 *   plugin._regenTokens(row);     // mutates row in place
 *   assert.strictEqual(row.tokenBalance, 2);
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - The mock plugin directly exposes only the token-related methods
 *   (_regenTokens, _spendToken, _checkSwitchEligibility) plus
 *   helper getters. Queue, commands, and output are not mocked —
 *   they're tested separately via the integration-focused files.
 * - Date.now() is NOT globally patched. Each test passes explicit
 *   timestamps through the clock object.
 *
 */
import assert from 'node:assert/strict';

// Mirrors the plugin's hardcoded POST_SWITCH_LOCKOUT_MS (switch.js) — not
// configurable there, so not exposed as a mock option either.
const POST_SWITCH_LOCKOUT_MS = 10_000;

// ── MockClock ─────────────────────────────────────────────────

export class MockClock {
  constructor(baseTime = Date.now()) {
    this._now = baseTime;
  }

  /** @returns {number} current mock timestamp */
  now() {
    return this._now;
  }

  /** Advance clock by `ms` milliseconds. */
  advance(ms) {
    this._now += ms;
  }

  /** Set clock to a specific absolute timestamp. */
  set(ts) {
    this._now = ts;
  }
}

// ── Literal parsing ──────────────────────────────────────────

/**
 * Parse an atomic increment expression out of a Sequelize literal.
 *
 * Production builds these via `DBService.incrementLiteral()`, which **quotes the
 * identifier** so camelCase columns survive Postgres identifier folding. The
 * quote character is dialect-dependent — `` `col` `` on SQLite and MySQL,
 * `"col"` on Postgres — so this accepts every form, plus the bare identifier
 * that the older hand-written literals and some test helpers still emit.
 * Recognising only the bare form is how this mock silently stopped applying
 * token grants when the production literal changed shape.
 *
 * @param {string} expr - e.g. '"tokenBalance" + 1', '`tokenBalance` + 1', 'tokenBalance - 2'
 * @returns {{column: string, delta: number}|null} null when it is not an increment.
 */
export function parseIncrementExpression(expr) {
  if (typeof expr !== 'string') return null;
  const m = expr.match(
    /^\s*(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|(\w+))\s*([+-])\s*(\d+)\s*$/
  );
  if (!m) return null;
  const column = m[1] ?? m[2] ?? m[3] ?? m[4];
  const sign = m[5];
  const magnitude = parseInt(m[6], 10);
  return { column, delta: sign === '-' ? -magnitude : magnitude };
}

// ── Mock DB ──────────────────────────────────────────────────

export function createMockDb() {
  const store = new Map();  // eosID → row

  const db = {
    /**
     * Simulate Sequelize findByPk.
     * Returns a shallow copy so mutations by _regenTokens are visible
     * to the caller but the internal store is only updated via upsert/update.
     */
    findByPk: async (eosID) => {
      const row = store.get(eosID);
      if (!row) return null;
      // Return a mutable copy
      const copy = { ...row, tokenRegenAnchor: row.tokenRegenAnchor ? new Date(row.tokenRegenAnchor) : null };
      if (copy.scrambleLockdownExpiry) {
        copy.scrambleLockdownExpiry = new Date(copy.scrambleLockdownExpiry);
      }
      return copy;
    },

    /**
     * Simulate Sequelize upsert.
     * Merges the given fields into the store. Returns the full row.
     */
    upsert: async (fields) => {
      const eosID = fields.eosID;
      const existing = store.get(eosID) || {};
      const merged = { ...existing, ...fields };
      store.set(eosID, merged);
      return merged;
    },

    /**
     * Simulate Sequelize update.
     * Returns [affectedCount] matching Sequelize's return shape.
     */
    /** Checks a single condition key/value pair against a row. Returns true if match. */
    /** Checks a single Op condition against a row value. */
    _checkOp(rowVal, opKey, opVal) {
      // Strip leading underscore for shorthand notation (e.g., '_ne' → 'ne')
      const normalizedOp = opKey.replace(/^_/, '');
      const a = rowVal instanceof Date ? rowVal.getTime() : (rowVal != null ? Number(rowVal) : NaN);
      const b = opVal instanceof Date ? opVal.getTime() : (opVal != null ? Number(opVal) : NaN);
      if (normalizedOp === 'eq') return rowVal === opVal;
      if (normalizedOp === 'in') {
        // Shorthand for Sequelize Op.in — used by connected-player filters
        if (!Array.isArray(opVal)) return false;
        return opVal.includes(rowVal);
      }
      const rowIsNull = rowVal === null || rowVal === undefined;
      if (normalizedOp === 'notIn') {
        if (!Array.isArray(opVal)) return false;
        return !opVal.includes(rowVal);
      }
      if (normalizedOp === 'ne') {
        // ANSI three-valued logic, NOT JavaScript !==.
        //
        // `col != 'x'` against a NULL column evaluates to UNKNOWN in SQLite, MySQL
        // and Postgres alike, so the engine EXCLUDES the row. This mock previously
        // returned true there, which is why a production WHERE that stranded rows
        // with a NULL lastSeedBonusRoundID passed every test. Modelling the real
        // behaviour means a clause that relies on three-valued logic now fails here
        // the same way it fails in the database.
        //
        // `col != NULL` (opVal null) is likewise UNKNOWN for every row — except
        // that Sequelize renders { [Op.ne]: null } as `IS NOT NULL`, which is a
        // genuine test, so that form is handled explicitly.
        if (opVal === null || opVal === undefined) return !rowIsNull;  // IS NOT NULL
        if (rowIsNull) return false;                                    // UNKNOWN -> excluded
        return rowVal !== opVal;
      }
      // Comparison operators are UNKNOWN against NULL too — isNaN already excludes
      // those rows, since a null rowVal produces NaN above.
      if (normalizedOp === 'lt') return !isNaN(a) && !isNaN(b) && a < b;
      if (normalizedOp === 'lte') return !isNaN(a) && !isNaN(b) && a <= b;
      if (normalizedOp === 'gte') return !isNaN(a) && !isNaN(b) && a >= b;
      if (normalizedOp === 'gt') return !isNaN(a) && !isNaN(b) && a > b;
      return false;
    },

    /** Checks all conditions for a single field key. val is an Op object like { _ne: null, _lte: ... } or a plain value. */
    _matchCondition(row, key, val) {
      if (val && typeof val === 'object' && val.constructor === Object) {
        const opKeys = Object.keys(val);
        // Multi-condition: all must pass (AND semantics)
        for (const opKey of opKeys) {
          const opVal = val[opKey];
          if (!db._checkOp(row[key], opKey, opVal)) return false;
        }
        return opKeys.length > 0; // empty object is falsy
      }
      return row[key] === val;
    },

    /**
     * Checks a where-object against a row. THE single where-matcher — update(),
     * findAll(), destroy() and count() all route through here. It used to be
     * duplicated inline in update(), which is how the mock drifted: a fix applied
     * here silently did nothing for UPDATE statements.
     *
     * Recurses, so branches may themselves contain _or/_and to any depth. The seed
     * reset clause needs that: its "stale row" branch ANDs (presence IS NOT NULL)
     * with a nested OR over (round IS NULL, round != current).
     *
     * Symbol keys are collected explicitly. Production passes real Sequelize Op
     * symbols while the test helpers use '_or'/'_and' strings, and Object.entries()
     * skips Symbols — without this a production where-clause would match every row.
     */
    _matchesWhere(row, where) {
      if (!where || typeof where !== 'object') return true;

      const entries = Object.entries(where);
      for (const sym of Object.getOwnPropertySymbols(where)) {
        const name = String(sym);
        if (name.endsWith('or]') || name === 'Symbol(or)') entries.push(['_or', where[sym]]);
        else if (name.endsWith('and]') || name === 'Symbol(and)') entries.push(['_and', where[sym]]);
      }

      for (const [key, val] of entries) {
        if (key === 'Op.or' || key === '_or') {
          if (!Array.isArray(val)) return false;
          if (!val.some(sub => typeof sub === 'object' && db._matchesWhere(row, sub))) return false;
        } else if (key === 'Op.and' || key === '_and') {
          if (!Array.isArray(val)) return false;
          if (!val.every(sub => typeof sub === 'object' && db._matchesWhere(row, sub))) return false;
        } else if (val && typeof val === 'object' && val.constructor === Object) {
          // Field-level nested OR, e.g. { col: { _or: [v1, v2] } }
          const nestedKey = Object.keys(val)[0];
          if (nestedKey === 'Op.or' || nestedKey === '_or') {
            if (!val[nestedKey].some(orVal => db._matchCondition(row, key, orVal))) return false;
          } else if (!db._matchCondition(row, key, val)) {
            return false;
          }
        } else if (!db._matchCondition(row, key, val)) {
          return false;
        }
      }
      return true;
    },

    update: async (fields, opts = {}) => {
      const where = opts.where || {};
      let count = 0;

      for (const [eosID, row] of store) {
        // Single matcher, shared with findAll/destroy/count. This used to be a
        // hand-inlined copy that could not recurse into nested _or branches.
        const match = db._matchesWhere(row, where);

        if (match) {
          // Apply Sequelize.literal-like updates (e.g. increment)
          for (const [key, val] of Object.entries(fields)) {
            const isLiteral = val && typeof val === 'object'
              && val.constructor && val.constructor.name === 'Literal';
            const isShorthand = val && typeof val === 'object'
              && typeof val.val === 'string' && !isLiteral;

            if (isLiteral || isShorthand) {
              const literalStr = typeof val.val === 'string' ? val.val : '';
              const inc = parseIncrementExpression(literalStr);
              if (inc) {
                const current = row[inc.column] != null ? Number(row[inc.column]) : 0;
                row[inc.column] = current + inc.delta;
              } else if (isLiteral) {
                row[key] = row[literalStr] !== undefined ? row[literalStr] : 0;
              } else {
                row[key] = literalStr;
              }
            } else {
              row[key] = val;
            }
          }
          count++;
        }
      }
      return [count];
    },

    /**
     * Simulate Sequelize create.
     */
    create: async (fields) => {
      const row = { ...fields };
      store.set(fields.eosID, row);
      return row;
    },

    /**
     * Simulate Sequelize bulkCreate.
     * Accepts an array of row field objects and inserts each.
     */
    bulkCreate: async (records) => {
      const rows = [];
      for (const fields of records) {
        const row = { ...fields };
        store.set(fields.eosID, row);
        rows.push(row);
      }
      return rows;
    },

    /**
     * Simulate Sequelize findAll.
     */
    findAll: async (opts = {}) => {
      const results = [];
      for (const row of store.values()) {
        let match = true;
        if (opts.where) {
          match = db._matchesWhere(row, opts.where);
        }
        if (match) results.push(row);
      }
      if (opts.attributes) {
        return results.map(r => {
          const subset = {};
          for (const attr of opts.attributes) {
            if (attr in r) subset[attr] = r[attr];
          }
          return subset;
        });
      }
      return results;
    },

    /**
     * Simulate Sequelize destroy.
     * Returns the number of deleted rows. Honors the where condition using
     * _evalCondition (supports nested _and/_or and operator shorthands).
     */
    destroy: async (opts = {}) => {
      const where = opts.where || {};
      let count = 0;
      for (const [eosID, row] of store) {
        if (db._evalCondition(row, where)) {
          store.delete(eosID);
          count++;
        }
      }
      return count;
    },

    /**
     * Recursively evaluate a Sequelize-style where condition against a row.
     * Supports string-key operator shorthands (_and, _or, _gte, _lt, _lte,
     * _ne, _eq, _gt) plus nested Op.or / Op.and. Used by destroy() for
     * cleanup() regression coverage.
     */
    _evalCondition(row, cond) {
      if (cond && typeof cond === 'object' && cond.constructor === Object) {
        for (const [k, v] of Object.entries(cond)) {
          if (k === '_and' || k === 'Op.and') {
            if (!Array.isArray(v) || !v.every(sub => db._evalCondition(row, sub))) return false;
          } else if (k === '_or' || k === 'Op.or') {
            if (!Array.isArray(v) || !v.some(sub => db._evalCondition(row, sub))) return false;
          } else if (!db._matchCondition(row, k, v)) {
            return false;
          }
        }
        return true;
      }
      return false;
    },

    /**
     * Clear all rows (for test isolation).
     */
    _clear: () => {
      store.clear();
    },

    /**
     * Get raw row count.
     */
    _size: () => store.size,

    /**
     * Get a direct reference (not a copy) to a row for assertions.
     */
    _getRaw: (eosID) => store.get(eosID),

    /**
     * Get all raw rows.
     */
    _allRows: () => [...store.values()],

    /**
     * Get raw store entries for assertion.
     */
    _entries: () => [...store.entries()].map(([k, v]) => ({ eosID: k, ...v }))
  };

  return db;
}

// ── Mock plugin factory ──────────────────────────────────────

/**
 * Create a mock Switch plugin instance for token system testing.
 *
 * @param {object} opts
 * @param {number} [opts.maxSwitchTokens=2]       — token cap
 * @param {number} [opts.switchCooldownHours=1]   — per-token refill interval (hours)
 * @param {number} [opts.switchCooldownMinutes=0]  — per-token refill interval (minutes, overrides hours)
 * @param {number} [opts.switchEnabledMinutes=10]  — eligibility window duration
 * @param {number} [opts.seedTokenBonusAmount=1]      — per-round seed bonus cap
 * @param {number} [opts.seedTokenBonusMinutes=20]    — minutes required for seed bonus
 * @param {number} [opts.seedTokenBonusMinPlayers=0]  — minimum players for seed accrual
 * @param {boolean} [opts.timeLimitEnabled=true]   — whether time window + token checks apply
 * @param {boolean} [opts.isLiberalMode=false]     — whether liberal mode (Seed/Jensen) is active
 * @param {MockClock} [clock]                      — if provided, used for Date.now; otherwise new MockClock
 * @returns {{ plugin: object, db: object, clock: MockClock }}
 */
export function createMockHarness(opts = {}, clock = null) {
  const options = {
    maxSwitchTokens: 2,
    switchCooldownHours: 1,
    switchCooldownMinutes: 0,
    switchEnabledMinutes: 10,
    seedTokenBonusAmount: 1,
    seedTokenBonusMinutes: 20,
    seedTokenBonusMinPlayers: 0,
    timeLimitEnabled: true,
    isLiberalMode: false,
    ...opts
  };

  const resolvedClock = clock || new MockClock();

  // ── Compute intervalMs ──────────────────────────────────────
  const intervalMs = options.switchCooldownMinutes > 0
    ? options.switchCooldownMinutes * 60 * 1000
    : options.switchCooldownHours * 60 * 60 * 1000;

  // ── Mock getSecondsFromJoin ─────────────────────────────────
  // Returns 0 by default (simulating "just joined / new plugin reload").
  // Tests that need a specific join time set this on the plugin.
  let joinSeconds = 0;
  let matchSeconds = 0;
  let phase = 'LIVE';        // tests control this via _setPhase()

  // ── Build plugin stub ───────────────────────────────────────
  const plugin = {
    options,
    recentSwitches: [],    // { eosID, datetime } — post-switch lockout, tests control via _recordRecentSwitch()
    server: {
      players: []          // tests control this via _setPlayerCount()
    },
    _s3: {
      gameState: {
        isSeedMode: () => options.isLiberalMode,
        isEnding: () => phase === 'ENDGAME',
        getPhase: () => phase,
        getMatchId: () => 'test-match-1'
      },
      players: {
        isReady: () => true,
        getPlayer: () => null,
        getJoinTime: () => null
      }
    },

    // Allow tests to control time-dependent values
    _setJoinSeconds: (s) => { joinSeconds = s; },
    _setMatchSeconds: (s) => { matchSeconds = s; },
    _setPhase: (p) => { phase = p; },
    _setPlayerCount: (n) => {
      plugin.server.players = Array.from({ length: n }, (_, i) => ({ eosID: `p${i + 1}`, name: `Player ${i + 1}` }));
    },
    getSecondsFromJoin: async () => joinSeconds,
    getSecondsFromMatchStart: () => matchSeconds,

    isLiberalMode: () => options.isLiberalMode,

    // v2.4.0: seed bonus enable/accrual helpers (mirror of plugin logic)
    _isSeedBonusEnabled: () => options.seedTokenBonusAmount > 0 && options.seedTokenBonusMinutes > 0,

    _isSeedAccrualActive: () => {
      if (!options.isLiberalMode) return false;
      if (!(options.seedTokenBonusAmount > 0 && options.seedTokenBonusMinutes > 0)) return false;
      // v2.5.0: no accrual during ENDGAME — isSeedMode() stays true through the
      // whole scoreboard/voting window, so without this the reconciler would
      // re-stamp presence right after the round-close sweep cleared it.
      if (plugin._s3.gameState.isEnding()) return false;
      const minPlayers = options.seedTokenBonusMinPlayers ?? 0;
      if (minPlayers === 0) return true;
      return plugin.server.players.length >= minPlayers;
    },

    verbose: (...args) => {
      // No-op in tests — uncomment for debugging
      // console.error(...args.map(String));
    },

    // Mirrors S3PluginBase.reportError so mock-driven code paths that report an
    // error behave like the real plugin. Stays a no-op: the stderr channel is
    // opt-in and a test run should not write to the error stream.
    reportError: () => {},

    _getModel: (name) => {
      // Tests don't use _getModel — they call the token methods directly
      return null;
    },

    warn: (eosID, msg) => {
      // Capture for assertion
      plugin._lastWarnMsg = msg;
      plugin._lastWarnEosID = eosID;
    },

    // ── _recordRecentSwitch (exact copy of the plugin logic) ────
    _recordRecentSwitch: (eosID) => {
      const existing = plugin.recentSwitches.find(e => e.eosID === eosID);
      if (existing) existing.datetime = new Date(resolvedClock.now());
      else plugin.recentSwitches.push({ eosID, datetime: new Date(resolvedClock.now()) });
    }
  };

  // ── _regenTokens (exact copy of the plugin logic) ───────────
  plugin._regenTokens = function (row) {
    const maxTokens = options.maxSwitchTokens;
    const localIntervalMs = intervalMs;

    if (localIntervalMs <= 0) return row;

    const now = resolvedClock.now();
    const balance = row.tokenBalance != null ? row.tokenBalance : maxTokens;
    const anchor = row.tokenRegenAnchor ? new Date(row.tokenRegenAnchor).getTime() : now;

    const room = Math.max(0, maxTokens - balance);
    if (room > 0) {
      const elapsedMs = now - anchor;
      if (elapsedMs > 0) {
        const wholeIntervals = Math.floor(elapsedMs / localIntervalMs);
        if (wholeIntervals > 0) {
          const regenerated = Math.min(room, wholeIntervals);
          row.tokenBalance = balance + regenerated;
          row.tokenRegenAnchor = new Date(anchor + regenerated * localIntervalMs);
        }
      }
    } else {
      // At or above cap — don't accrue regen credit
      row.tokenRegenAnchor = new Date(now);
    }

    return row;
  };

  // ── _spendToken (exact copy of the plugin logic) ────────────
  plugin._spendToken = function (row) {
    plugin._regenTokens(row);
    const maxTokens = options.maxSwitchTokens;
    const balance = row.tokenBalance != null ? row.tokenBalance : maxTokens;

    row.tokenBalance = Math.max(0, balance - 1);

    if (row.tokenBalance === maxTokens - 1) {
      row.tokenRegenAnchor = new Date(resolvedClock.now());
    }

    return row;
  };

  // ── _checkSwitchEligibility (exact copy of the plugin logic) ─
  plugin._checkSwitchEligibility = async function (player) {
    const eosID = player?.eosID;
    if (!eosID) return { eligible: false, reason: 'missing_eos' };

    // Post-switch lockout — mirrors the real plugin's gate, checked before
    // any DB lookup and independent of liberal mode.
    const recentSwitch = plugin.recentSwitches.find(e => e.eosID === eosID);
    if (recentSwitch) {
      const elapsedMs = resolvedClock.now() - recentSwitch.datetime.getTime();
      if (elapsedMs < POST_SWITCH_LOCKOUT_MS) {
        return { eligible: false, reason: 'recent_switch', remaining: Math.ceil((POST_SWITCH_LOCKOUT_MS - elapsedMs) / 1000) };
      }
    }

    // Simulate DB lookup via the injected db
    const cooldownData = plugin._testDb ? await plugin._testDb.findByPk(eosID) : null;
    const now = resolvedClock.now();

    // Scramble lock is an independent override
    if (cooldownData && cooldownData.scrambleLockdownExpiry && new Date(cooldownData.scrambleLockdownExpiry).getTime() > now) {
      const remaining = Math.ceil((new Date(cooldownData.scrambleLockdownExpiry).getTime() - now) / 60000);
      return { eligible: false, reason: 'scramble_lock', remaining };
    }

    if (!plugin.isLiberalMode() && options.timeLimitEnabled) {
      const connectionSeconds = await plugin.getSecondsFromJoin(eosID);
      const matchSec = plugin.getSecondsFromMatchStart();
      const limit = options.switchEnabledMinutes;

      if (connectionSeconds / 60 > limit && matchSec / 60 > limit) {
        return { eligible: false, reason: 'time_window' };
      }

      const row = cooldownData
        ? { tokenBalance: cooldownData.tokenBalance, tokenRegenAnchor: cooldownData.tokenRegenAnchor }
        : { tokenBalance: options.maxSwitchTokens, tokenRegenAnchor: null };

      plugin._regenTokens(row);

      if (row.tokenBalance < 1) {
        const anchor = row.tokenRegenAnchor ? new Date(row.tokenRegenAnchor).getTime() : now;
        const remaining = Math.ceil((intervalMs - (now - anchor)) / 60000);
        return { eligible: false, reason: 'cooldown', remaining };
      }
    }

    return { eligible: true };
  };

  return { plugin, clock: resolvedClock };
}

/**
 * Export the assert module for convenience in test files.
 */
export { assert };
