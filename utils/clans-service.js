/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               CLANS SERVICE                                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Extracts and groups player clan tags from player names using
 * multiple regex strategies. Groups players by normalized tag with
 * configurable size limits, Levenshtein-distance merge, and
 * ignore-list filtering. Provides per-player tag caching and
 * clan-team lookup for join-time assignment decisions.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * ClansService (class, default)
 *   mount()            — Sets mounted state.
 *   unmount()          — Resets mounted state.
 *   isEnabled()        — Returns true if clan grouping is enabled
 *                        in options.
 *   isReady()          — Returns true when service is mounted.
 *   getOptions(overrides) — Returns merged options.
 *   getGroupingOptions(overrides) — Returns grouping-specific subset
 *                                   of options.
 *   extractRawPrefix(name)  — Extracts clan tag prefix from name
 *                             using 5 regex strategies.
 *   normalizeTag(raw)       — Normalizes a tag (NFD unicode, ASCII
 *                             folding, uppercase).
 *   levenshteinDistance(a, b) — Computes edit distance between tags.
 *   extractClanGroups(rawPlayers, opts) — Groups players by clan tag
 *                              with size filtering and Levenshtein merge.
 *   buildPlayerTagCache(players, opts) — Builds eosID→tag map.
 *   getClanTeamForPlayer(joiningPlayer, cache, serverPlayers, opts)
 *                              — Returns team where player's clan
 *                                is concentrated.
 *   getPlayerTag(eosID)        — Gets cached tag for a player.
 *   addPlayerToCache(eosID, name) — Adds/updates single player's tag.
 *   removePlayerFromCache(eosID) — Removes player from tag cache.
 *   clearPlayerTagCache()      — Clears all cached tags.
 *   getPlayerTagCache()        — Returns a copy of the tag cache.
 *   rebuildFromAllPlayers(players) — Rebuilds tag cache from all
 *                                    current players.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * (No local imports — pure logic with injected verboseLogger and options.)
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Five regex strategies for tag extraction: bracket, separator,
 *   double-space, short-tag, and bare prefix.
 * - Unicode-to-ASCII folding via NON_ASCII_MAP (const at end of file).
 * - Levenshtein merge coalesces near-matching tags within maxEditDistance.
 * - Ignore-list filtering supports case-sensitive and case-insensitive modes.
 * - Per-player _playerTagCache supports incremental add/remove/clear
 *   for closed-loop updates from PlayersService.
 *
 */
export default class ClansService {
  constructor({
    verboseLogger = () => {},
    options = {}
  } = {}) {
    this.verboseLogger = verboseLogger;

    this.defaults = {
      enabled: false,
      minSize: 2,
      maxSize: 18,
      maxEditDistance: 1,
      caseSensitive: false,
      ignoreList: [],
      pullEntireSquads: false
    };

    this.options = {
      ...this.defaults,
      ...options
    };

    this._isMounted = false;

    /**
     * @private Internal cache — do not access directly from consumer plugins.
     * Use addPlayerToCache() / getPlayerTagCache() public API instead.
     * Bypassing this (e.g. consumer writes `clans._playerTagCache.set(...)`)
     * couples the consumer to the internal property name and bypasses
     * future guard logic.
     */
    this._playerTagCache = new Map();
  }

  async mount() {
    this._isMounted = true;
    this.verboseLogger(2, '[Clans] Mounted.');
  }

  async unmount() {
    this._isMounted = false;
    this.verboseLogger(2, '[Clans] Unmounted.');
  }

  isEnabled() {
    return !!this.options.enabled;
  }

  isReady() {
    return this._isMounted;
  }

  getOptions(overrides = {}) {
    return {
      ...this.options,
      ...overrides
    };
  }

  getGroupingOptions(overrides = {}) {
    const resolved = this.getOptions(overrides);
    return {
      minSize: resolved.minSize,
      maxSize: resolved.maxSize,
      maxEditDistance: resolved.maxEditDistance,
      caseSensitive: resolved.caseSensitive,
      ignoreList: Array.isArray(resolved.ignoreList) ? resolved.ignoreList : []
    };
  }

  extractRawPrefix(name) {
    if (!name || typeof name !== 'string') return null;

    const bracketRegex = /^\s*[\[\(【「『《╔├↾╬✦⟦╟|=<\{~\*](.+?)[\]\)】」』》╗┤↿╬✦⟧╢|=<>~\*\}]/;
    let match = name.match(bracketRegex);
    if (match) return match[1].trim();

    const sepRegex = /^\s*(.{1,10}?)\s*(?:\/\/|\||-|:|\:\(|\:\)|†|™|✯|~|\*)\s+/;
    match = name.match(sepRegex);
    if (match) return match[1].trim();

    const spaceRegex = /^\s*(.{1,10}?)\s{2,}/;
    match = name.match(spaceRegex);
    if (match) return match[1].trim();

    const shortTagRegex = /^\s*([A-Z0-9]{2,4})\s+[A-Z]/;
    match = name.match(shortTagRegex);
    if (match) return match[1].trim();

    const bareRegex = /^[\[<({]?([^\s\[\](){}<>]{2,7})\s+\S/u;
    match = name.match(bareRegex);
    if (match) return match[1].trim();

    return null;
  }

  normalizeTag(raw) {
    if (!raw || typeof raw !== 'string') return null;

    let norm = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');

    for (const [key, val] of Object.entries(NON_ASCII_MAP)) {
      norm = norm.replace(new RegExp(key, 'gi'), val);
    }

    norm = norm.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    return norm || null;
  }

  levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (!a?.length) return b?.length || 0;
    if (!b?.length) return a.length;

    let left = a;
    let right = b;
    if (left.length > right.length) {
      [left, right] = [right, left];
    }

    const m = left.length;
    const n = right.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => i);

    for (let j = 1; j <= n; j++) {
      let prev = dp[0];
      dp[0] = j;
      for (let i = 1; i <= m; i++) {
        const tmp = dp[i];
        dp[i] = left[i - 1] === right[j - 1]
          ? prev
          : 1 + Math.min(prev, dp[i], dp[i - 1]);
        prev = tmp;
      }
    }

    return dp[m];
  }

  extractClanGroups(rawPlayers, options = {}) {
    const {
      minSize,
      maxSize,
      maxEditDistance,
      caseSensitive,
      ignoreList
    } = this.getGroupingOptions(options);

    const groups = {};
    for (const player of rawPlayers || []) {
      if (!player?.name || !player?.eosID) continue;

      const raw = this.extractRawPrefix(player.name);
      if (!raw) continue;

      const key = caseSensitive ? raw : this.normalizeTag(raw);
      if (!key) continue;

      if (!groups[key]) groups[key] = new Set();
      groups[key].add(player.eosID);
    }

    for (const tag of Object.keys(groups)) {
      groups[tag] = [...groups[tag]];
    }

    if (ignoreList.length > 0) {
      const normalizedIgnores = caseSensitive
        ? new Set(ignoreList)
        : new Set(ignoreList.map((t) => this.normalizeTag(t)).filter(Boolean));

      for (const tag of Object.keys(groups)) {
        if (normalizedIgnores.has(tag)) {
          delete groups[tag];
        }
      }
    }

    if (maxEditDistance > 0) {
      let merged = true;
      while (merged) {
        merged = false;
        const tags = Object.keys(groups);

        for (let i = 0; i < tags.length && !merged; i++) {
          for (let j = i + 1; j < tags.length && !merged; j++) {
            if (this.levenshteinDistance(tags[i], tags[j]) <= maxEditDistance) {
              const [keep, absorb] = groups[tags[i]].length >= groups[tags[j]].length
                ? [tags[i], tags[j]]
                : [tags[j], tags[i]];

              const seen = new Set(groups[keep]);
              for (const id of groups[absorb]) {
                if (!seen.has(id)) {
                  groups[keep].push(id);
                  seen.add(id);
                }
              }

              delete groups[absorb];
              merged = true;
            }
          }
        }
      }
    }

    for (const tag of Object.keys(groups)) {
      if (groups[tag].length < minSize || groups[tag].length > maxSize) {
        delete groups[tag];
      }
    }

    return groups;
  }

  buildPlayerTagCache(players, options = {}) {
    const { caseSensitive } = this.getGroupingOptions(options);
    const cache = new Map();

    for (const player of players || []) {
      if (!player?.eosID) continue;

      const raw = this.extractRawPrefix(player.name);
      const tag = raw ? (caseSensitive ? raw : this.normalizeTag(raw)) : null;
      cache.set(player.eosID, tag);
    }

    return cache;
  }

  getClanTeamForPlayer(joiningPlayer, playerTagCache, serverPlayers, options = {}) {
    if (!joiningPlayer?.eosID || !playerTagCache || !serverPlayers) {
      return null;
    }

    const { minSize } = this.getGroupingOptions(options);
    const joinerTag = playerTagCache.get(joiningPlayer.eosID);
    if (!joinerTag) return null;

    const teamCounts = { 1: 0, 2: 0 };
    let clanMates = 0;

    for (const player of serverPlayers) {
      if (!player?.eosID || player.eosID === joiningPlayer.eosID) continue;

      const tag = playerTagCache.get(player.eosID);
      if (tag !== joinerTag) continue;

      clanMates += 1;
      const teamID = Number(player.teamID);
      if (teamID === 1 || teamID === 2) {
        teamCounts[teamID] += 1;
      }
    }

    if (clanMates < minSize - 1) return null;
    if (teamCounts[1] > 0 && teamCounts[2] > 0) return null;
    if (teamCounts[1] > 0) return 1;
    if (teamCounts[2] > 0) return 2;

    return null;
  }

  getPlayerTag(eosID) {
    if (!eosID) return null;
    return this._playerTagCache.get(eosID) ?? null;
  }

  addPlayerToCache(eosID, name) {
    if (!eosID || !name) return;
    const raw = this.extractRawPrefix(name);
    const tag = raw ? (this.options.caseSensitive ? raw : this.normalizeTag(raw)) : null;
    this._playerTagCache.set(eosID, tag);
  }

  removePlayerFromCache(eosID) {
    if (!eosID) return;
    this._playerTagCache.delete(eosID);
  }

  clearPlayerTagCache() {
    this._playerTagCache.clear();
  }

  getPlayerTagCache() {
    return new Map(this._playerTagCache);
  }

  rebuildFromAllPlayers(players) {
    this._playerTagCache.clear();
    for (const p of players || []) {
      if (!p?.eosID) continue;
      this.addPlayerToCache(p.eosID, p.name);
    }
    this.verboseLogger(2, `[Clans] Tag cache rebuilt: ${this._playerTagCache.size} players.`);
  }
}

const NON_ASCII_MAP = {
  'ƒ': 'f', 'И': 'n', '丹': 'a', '匚': 'c', 'н': 'h', '尺': 'r', 'λ': 'a', 'ν': 'v', 'є': 'e',
  '†': 't', 'Ð': 'd', 'ø': 'o', 'ß': 'ss', 'ค': 'a', 'г': 'r', 'ς': 'c', 'ɦ': 'h', 'м': 'm',
  'я': 'r', 'ċ': 'c', '€': 'e', '₥': 'm', '₠': 'e', '₮': 't', '₯': 'd', '₨': 'rs', '₩': 'w',
  '₫': 'd', '₭': 'k', '₰': 'p', 'ℜ': 'r', 'ℭ': 'c', 'ℑ': 'i', 'ℒ': 'l', 'ℓ': 'l', '℔': 'lb',
  'ℕ': 'n', '℗': 'p', '℘': 'p', 'ℙ': 'p', 'ℚ': 'q', 'ℛ': 'r', 'ℝ': 'r', '℞': 'rx', '℟': 'r',
  '℠': 'sm', '℡': 'tel', '™': 'tm', '℣': 'v', 'ℤ': 'z', 'Ω': 'ohm', '∂': 'd', '₦': 'n', '₧': 'pts',
  '₹': 'r', '₸': 't', '₿': 'b'
};