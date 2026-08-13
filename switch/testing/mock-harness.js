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
      if (normalizedOp === 'ne') {
        // null and undefined are both "not equal" to any non-null value
        if (rowVal === null || rowVal === undefined) return opVal !== null && opVal !== undefined;
        return rowVal !== opVal;
      }
      if (normalizedOp === 'eq') return rowVal === opVal;
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

    /** Checks all conditions in a plain where-object (no Op.or/Op.and) against a row. */
    _matchesWhere(row, where) {
      for (const [key, val] of Object.entries(where)) {
        if (key === 'Op.or' || key === '_or') {
          // Handle shorthand { Op.or: [...] } — the mock represents Op.or as '_or'
          const orArr = val;
          let anyMatch = false;
          for (const subCond of orArr) {
            if (typeof subCond === 'object') {
              let subOk = true;
              for (const [sk, sv] of Object.entries(subCond)) {
                if (!db._matchCondition(row, sk, sv)) { subOk = false; break; }
              }
              if (subOk) { anyMatch = true; break; }
            }
          }
          if (!anyMatch) return false;
        } else if (key === 'Op.and' || key === '_and') {
          const andArr = val;
          for (const subCond of andArr) {
            if (typeof subCond === 'object') {
              let subOk = true;
              for (const [sk, sv] of Object.entries(subCond)) {
                if (!db._matchCondition(row, sk, sv)) { subOk = false; break; }
              }
              if (!subOk) return false;
            }
          }
        } else {
          // Handle { [Op.or]: [...] } as a nested value
          if (val && typeof val === 'object' && val.constructor === Object) {
            const nestedKey = Object.keys(val)[0];
            if (nestedKey === 'Op.or' || nestedKey === '_or') {
              const orArr = val[nestedKey];
              let anyMatch = false;
              for (const orVal of orArr) {
                if (db._matchCondition(row, key, orVal)) { anyMatch = true; break; }
              }
              if (!anyMatch) return false;
              continue;
            }
            if (!db._matchCondition(row, key, val)) return false;
          } else {
            if (!db._matchCondition(row, key, val)) return false;
          }
        }
      }
      return true;
    },

    update: async (fields, opts = {}) => {
      const where = opts.where || {};
      let count = 0;

      // Resolve the actual value for Op.or/Op.and regardless of key type (Symbol or string)
      // Sequelize uses Symbol keys for Op.or/Op.and; our string-based test helpers use _or/_and.
      const orSymbol = Object.getOwnPropertySymbols(where).find(s => String(s).endsWith('or]'));
      const andSymbol = Object.getOwnPropertySymbols(where).find(s => String(s).endsWith('and]'));
      const orCondition = where['_or'] || where['Op.or'] || (orSymbol ? where[orSymbol] : null);
      const andCondition = where['_and'] || where['Op.and'] || (andSymbol ? where[andSymbol] : null);

      for (const [eosID, row] of store) {
        let match = true;

        if (orCondition !== null) {
          // Op.or at top level: match if any sub-condition matches, AND check regular conditions
          match = true;
          for (const [key, val] of Object.entries(where)) {
            if (key === '_or' || key === '_and' || key === 'Op.or' || key === 'Op.and') continue;
            // Skip Symbol keys that aren't regular column names
            if (typeof key === 'symbol') continue;
            if (!db._matchCondition(row, key, val)) { match = false; break; }
          }
          if (match) {
            let orMatch = false;
            for (const subCond of orCondition) {
              let subOk = true;
              if (typeof subCond === 'object') {
                for (const [sk, sv] of Object.entries(subCond)) {
                  if (!db._matchCondition(row, sk, sv)) { subOk = false; break; }
                  if (!subOk) break;
                }
              }
              if (subOk) { orMatch = true; break; }
            }
            if (!orMatch) match = false;
          }
        } else if (andCondition !== null) {
          match = true;
          for (const [key, val] of Object.entries(where)) {
            if (key === '_or' || key === '_and' || key === 'Op.or' || key === 'Op.and') continue;
            if (typeof key === 'symbol') continue;
            if (!db._matchCondition(row, key, val)) { match = false; break; }
          }
          if (match) {
            for (const subCond of andCondition) {
              if (typeof subCond === 'object') {
                for (const [sk, sv] of Object.entries(subCond)) {
                  if (!db._matchCondition(row, sk, sv)) { match = false; break; }
                  if (!match) break;
                }
              }
              if (!match) break;
            }
          }
        } else {
          match = db._matchesWhere(row, where);
        }

        if (match) {
          // Apply Sequelize.literal-like updates (e.g. increment)
          for (const [key, val] of Object.entries(fields)) {
            if (val && typeof val === 'object' && val.constructor && val.constructor.name === 'Literal') {
              // Sequelize.Literal object
              const literalStr = val.val || '';
              const incMatch = literalStr.match(/^(\w+)\s*\+\s*(\d+)$/);
              if (incMatch) {
                const colName = incMatch[1];
                const increment = parseInt(incMatch[2], 10);
                const current = row[colName] != null ? Number(row[colName]) : 0;
                row[colName] = current + increment;
              } else {
                row[key] = row[literalStr] !== undefined ? row[literalStr] : 0;
              }
            } else if (val && typeof val === 'object' && val.val && typeof val.val === 'string' && val.val.includes('+')) {
              // Shorthand { val: 'column + N' } — used by test helpers
              const incMatch = val.val.match(/^(\w+)\s*\+\s*(\d+)$/);
              if (incMatch) {
                const colName = incMatch[1];
                const increment = parseInt(incMatch[2], 10);
                const current = row[colName] != null ? Number(row[colName]) : 0;
                row[colName] = current + increment;
              } else {
                row[key] = val.val;
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

  // ── Build plugin stub ───────────────────────────────────────
  const plugin = {
    options,
    server: {
      players: []          // tests control this via _setPlayerCount()
    },
    _s3: {
      gameState: {
        isSeedMode: () => options.isLiberalMode,
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
      const minPlayers = options.seedTokenBonusMinPlayers ?? 0;
      if (minPlayers === 0) return true;
      return plugin.server.players.length >= minPlayers;
    },

    verbose: (...args) => {
      // No-op in tests — uncomment for debugging
      // console.error(...args.map(String));
    },

    _getModel: (name) => {
      // Tests don't use _getModel — they call the token methods directly
      return null;
    },

    warn: (eosID, msg) => {
      // Capture for assertion
      plugin._lastWarnMsg = msg;
      plugin._lastWarnEosID = eosID;
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
