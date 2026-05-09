/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               SA CLAN GROUPER UTILITY v1.0.0                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
  * Extracts clan tag groups from raw player data and provides utilities
  * for clan-aware team assignment. This clan grouping logic is shared with
  * TeamBalancer and EloTracker, providing consistent tag detection and grouping
  * strategies across SquadJS plugins.
 *
 * Pure logic — no external dependencies beyond Logger. Importable from
 * both the plugin and unit tests.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * levenshteinDistance(a, b) -> number
 *   Standard Levenshtein distance with O(min(m,n)) memory.
 *
 * extractRawPrefix(name) -> string | null
 *   Extracts a clan tag from a player name using 5-strategy detection.
 *
 * buildPlayerTagCache(players, options) -> Map<eosID, tag|null>
 *   Lightweight cache mapping each player's eosID to their normalized tag.
 *   Built once at round start, updated on new joins.
 *
 * getClanTeamForPlayer(joiningPlayer, playerTagCache, serverPlayers, options) -> 1 | 2 | null
 *   Scans server.players to find where the joining player's clan mates are.
 *   Returns 1 or 2 if ALL clan mates are on a single team.
 *   Returns null if clan is split, no tag, or no clan mates on-server.
 *
 * ─── DESIGN NOTES ─────────────────────────────────────────────────
 *
 * - Tag extraction is performed once per player at round start and on join
 *   via buildPlayerTagCache(), avoiding repeated regex processing.
 * - Team lookups happen at join time by scanning server.players once.
 * - All functions are pure (deterministic, no side effects).
 * - Clan matching is strict: ALL clan mates must be on one team, or null.
 *
 * Author: Based on TeamBalancer clan-grouping logic
 *
 * ═══════════════════════════════════════════════════════════════
 */

import Logger from '../../core/logger.js';

const NON_ASCII_MAP = {
  'ƒ': 'f', 'И': 'n', '丹': 'a', '匚': 'c', 'н': 'h', '尺': 'r', 'λ': 'a', 'ν': 'v', 'є': 'e',
  '†': 't', 'Ð': 'd', 'ø': 'o', 'ß': 'ss', 'ค': 'a', 'г': 'r', 'ς': 'c', 'ɦ': 'h', 'м': 'm',
  'я': 'r', 'ċ': 'c', '€': 'e', '₥': 'm', '₠': 'e', '₮': 't', '₯': 'd', '₨': 'rs', '₩': 'w',
  '₫': 'd', '₭': 'k', '₰': 'p', 'ℜ': 'r', 'ℭ': 'c', 'ℑ': 'i', 'ℒ': 'l', 'ℓ': 'l', '℔': 'lb',
  'ℕ': 'n', '℗': 'p', '℘': 'p', 'ℙ': 'p', 'ℚ': 'q', 'ℛ': 'r', 'ℝ': 'r', '℞': 'rx', '℟': 'r',
  '℠': 'sm', '℡': 'tel', '™': 'tm', '℣': 'v', 'ℤ': 'z', 'Ω': 'ohm', '∂': 'd', '₦': 'n', '₧': 'pts',
  '₹': 'r', '₸': 't', '₿': 'b',
};

/**
 * Extracts a clan tag from a player name using 5-strategy priority detection.
 * Returns null if no tag/name boundary is found.
 * @param {string} name - Player name
 * @returns {string|null} Raw clan tag or null
 */
export function extractRawPrefix(name) {
  if (!name || typeof name !== 'string') return null;

  // 1. Bracketed prefix; tolerates mismatched and exotic Unicode pairs.
  const bracketRegex = /^\s*[\[\(【「『《╔├↾╬✦⟦╟|=<\{~\*](.+?)[\]\)】」』》╗┤↿╬✦⟧╢|=<>~\*\}]/;
  let match = name.match(bracketRegex);
  if (match) return match[1].trim();

  // 2. Explicit separator: TAG // Name, TAG | Name, TAG - Name, etc.
  const sepRegex = /^\s*(.{1,10}?)\s*(?:\/\/|\||-|:|\:\(|\:\)|†|™|✯|~|\*)\s+/;
  match = name.match(sepRegex);
  if (match) return match[1].trim();

  // 3. 2+ space separator (catches bare-prefix tags with a wide gap).
  const spaceRegex = /^\s*(.{1,10}?)\s{2,}/;
  match = name.match(spaceRegex);
  if (match) return match[1].trim();

  // 4. Short ALL-CAPS tag + single space + uppercase continuation
  const shortTagRegex = /^\s*([A-Z0-9]{2,4})\s+[A-Z]/;
  match = name.match(shortTagRegex);
  if (match) return match[1].trim();

  // 5. Bare-prefix fallback: any 2–7 non-bracket non-whitespace chars
  //    followed by whitespace and a non-empty token.
  const bareRegex = /^[\[<({]?([^\s\[\](){}<>]{2,7})\s+\S/u;
  match = name.match(bareRegex);
  if (match) return match[1].trim();

  return null;
}

/**
 * Normalizes a tag for case-insensitive matching.
 * Applies NFD decomposition, gamer-character mapping, and alphanumeric-only uppercase.
 * @param {string} raw - Raw tag
 * @returns {string|null} Normalized tag or null
 */
function normalizeTag(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // NFD-decompose then strip combining marks
  let norm = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Map "gamer character" lookalikes to their ASCII equivalents.
  for (const [key, val] of Object.entries(NON_ASCII_MAP)) {
    norm = norm.replace(new RegExp(key, 'gi'), val);
  }

  // Strip non-alphanumerics and uppercase.
  norm = norm.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return norm || null;
}

/**
 * Levenshtein distance between two strings.
 * Uses O(min(m,n)) memory optimization.
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Edit distance
 */
export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  if (a.length > b.length) [a, b] = [b, a];

  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);

  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return dp[m];
}

/**
 * Extracts and normalizes clan groups from a set of players.
 * Groups players by tag, optionally merges similar tags via Levenshtein distance.
 * @param {Array} rawPlayers - Array of player objects with name and eosID
 * @param {object} options - { minSize, maxSize, maxEditDistance, caseSensitive, ignoreList }
 * @returns {object} Map of tag -> [eosID, eosID, ...]
 */
export function extractClanGroups(rawPlayers, options = {}) {
  const minSize = options.minSize ?? 2;
  const maxSize = options.maxSize ?? 18;
  const maxEditDistance = options.maxEditDistance ?? 1;
  const caseSensitive = options.caseSensitive ?? true;
  const ignoreList = options.ignoreList ?? [];

  const groups = {};
  for (const player of rawPlayers || []) {
    if (!player?.name || !player?.eosID) continue;
    const raw = extractRawPrefix(player.name);
    if (!raw) continue;
    const key = caseSensitive ? raw : normalizeTag(raw);
    if (!key) continue;
    if (!groups[key]) groups[key] = new Set();
    groups[key].add(player.eosID);
  }

  // Convert sets to arrays
  for (const tag of Object.keys(groups)) {
    groups[tag] = [...groups[tag]];
  }

  // Remove ignored clan tags
  if (ignoreList.length > 0) {
    const normalizedIgnores = caseSensitive
      ? new Set(ignoreList)
      : new Set(ignoreList.map(t => normalizeTag(t)).filter(Boolean));

    for (const tag of Object.keys(groups)) {
      if (normalizedIgnores.has(tag)) {
        delete groups[tag];
      }
    }
  }

  // Merge similar tags within edit distance
  if (maxEditDistance > 0) {
    let merged = true;
    while (merged) {
      merged = false;
      const tags = Object.keys(groups);
      for (let i = 0; i < tags.length && !merged; i++) {
        for (let j = i + 1; j < tags.length && !merged; j++) {
          if (levenshteinDistance(tags[i], tags[j]) <= maxEditDistance) {
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

  // Filter by size
  for (const tag of Object.keys(groups)) {
    if (groups[tag].length < minSize || groups[tag].length > maxSize) {
      delete groups[tag];
    }
  }

  return groups;
}

/**
 * Builds a lightweight per-player tag cache.
 * Maps each player's eosID to their normalized clan tag (or null if no tag).
 * This is built once at round start and incrementally updated on joins.
 * @param {Array} players - Array of player objects with name and eosID
 * @param {object} options - { caseSensitive } (default: false)
 * @returns {Map<eosID, normalizedTag|null>}
 */
export function buildPlayerTagCache(players, options = {}) {
  const caseSensitive = options.caseSensitive ?? false;
  const cache = new Map();

  for (const player of players || []) {
    if (!player?.eosID) continue;
    const raw = extractRawPrefix(player.name);
    const tag = raw ? (caseSensitive ? raw : normalizeTag(raw)) : null;
    cache.set(player.eosID, tag);
  }

  return cache;
}

/**
 * Determines if a joining player should be routed to a clan team.
 * Scans server.players to find where the player's clan mates are.
 * Returns the team number (1 or 2) if ALL clan mates are on that single team.
 * Returns null if: clan is split, player has no tag, no clan mates on-server, or clan below minSize.
 *
 * @param {object} joiningPlayer - Player object with eosID and name
 * @param {Map} playerTagCache - Pre-built tag cache (eosID -> tag|null)
 * @param {Array} serverPlayers - Current server.players array
 * @param {object} options - { minSize, caseSensitive }
 * @returns {1|2|null}
 */
export function getClanTeamForPlayer(joiningPlayer, playerTagCache, serverPlayers, options = {}) {
  if (!joiningPlayer?.eosID || !playerTagCache || !serverPlayers) {
    return null;
  }

  const minSize = options.minSize ?? 2;

  // Get joining player's tag from cache
  const joinerTag = playerTagCache.get(joiningPlayer.eosID);
  if (!joinerTag) {
    return null; // No tag = no clan
  }

  // Find all server players with the same tag
  const clanMates = [];
  const teamCounts = { 1: 0, 2: 0 };

  for (const p of serverPlayers) {
    if (!p?.eosID || p.eosID === joiningPlayer.eosID) continue;

    const pTag = playerTagCache.get(p.eosID);
    if (pTag === joinerTag) {
      clanMates.push(p);
      const teamID = Number(p.teamID);
      if (teamID === 1 || teamID === 2) {
        teamCounts[teamID]++;
      }
    }
  }

  // Not enough clan mates to form a clan
  if (clanMates.length < minSize - 1) {
    return null;
  }

  // Clan is split across both teams (or has players with null teamID during staging)
  if (teamCounts[1] > 0 && teamCounts[2] > 0) {
    return null;
  }

  // All clan mates are on team 1
  if (teamCounts[1] > 0 && teamCounts[2] === 0) {
    return 1;
  }

  // All clan mates are on team 2
  if (teamCounts[2] > 0 && teamCounts[1] === 0) {
    return 2;
  }

  // No clan mates have a real team yet (null teamID during staging/resolving)
  return null;
}
