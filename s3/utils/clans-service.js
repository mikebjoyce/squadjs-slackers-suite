/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               CLANS SERVICE                                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Extracts and groups player clan tags from player names using
 * multiple regex strategies. Groups players by normalized tag with
 * configurable size limits, Damerau-Levenshtein-distance merge, and
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
 *   damerauLevenshteinDistance(a, b) — Computes edit distance between tags,
 *                             counting an adjacent-character transposition
 *                             (e.g. 'PHNTM' -> 'PHTNM') as a single edit
 *                             rather than two substitutions.
 *   extractClanGroups(rawPlayers, opts) — Groups players by clan tag
 *                              with size filtering and Damerau-Levenshtein
 *                              merge.
 *   explainClanGroups(rawPlayers, opts) — Same pipeline, but also returns a
 *                              trace of every exclusion and merge. For the
 *                              `!s3 clans` admin view.
 *   buildPlayerTagCache(players, opts) — Builds eosID→tag map.
 *   getClanTeamForPlayer(joiningPlayer, cache, serverPlayers, opts)
 *                              — Returns team where player's clan
 *                                is concentrated.
 *   getPlayerTag(eosID)        — Gets cached tag for a player.
 *   addPlayerToCache(eosID, name) — Adds/updates single player's tag.
 *   recordConfirmedTag(eosID, rawPrefix) — Records a tag directly observed
 *                              via a name-transition; high-confidence.
 *   clearConfirmedTag(eosID)   — Clears an observed-transition tag.
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
 * - Damerau-Levenshtein merge coalesces near-matching tags within
 *   maxEditDistance, but only when both tags are at least minMergeLength
 *   long — a 1-character edit is far less discriminating on a short tag
 *   (e.g. 'CB' vs '8B') than on a long one, so short tags require an exact
 *   match to group together. An adjacent-character transposition (e.g.
 *   'PHNTM' -> 'PHTNM') counts as a single edit, not two substitutions —
 *   empirically the dominant real-world typo shape for clan tags.
 * - Ignore-list filtering supports case-sensitive and case-insensitive modes.
 * - Per-player _playerTagCache supports incremental add/remove/clear
 *   for closed-loop updates from PlayersService.
 * - extractClanGroups() and explainClanGroups() both delegate to the private
 *   _computeClanGroups(), so the admin diagnostic view cannot drift from the
 *   grouping that SmartAssign and TeamBalancer consume.
 * - Recruit suffix stripping: by default, tags ending with 'r' or '-r'
 *   are stripped to their base form — but only if the base tag exists
 *   on at least one other player in the data set. This prevents false
 *   positives (e.g. clan 'AR' won't be stripped to 'A' unless 'A'
 *   actually exists). Suffix matching is case-insensitive, so 'R' and
 *   '-R' are also matched. Configure via S³'s clanRecruitSuffixes option
 *   (default: ["r", "-r"]). Set to [] to disable.
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
      minMergeLength: 4,
      caseSensitive: false,
      ignoreList: [],
      pullEntireSquads: false,
      recruitSuffixes: ["r", "-r"]
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

    /**
     * @private Extraction strategy ('bracket'/'separator'/'prefixSymbol'/
     * 'doublespace'/'shorttag'/'bare') behind each cached tag, tracked alongside
     * _playerTagCache so addPlayerToCache() can corroborate a new
     * low-confidence extraction against other already-cached players'
     * high-confidence ones.
     */
    this._playerTagStrategy = new Map();

    /**
     * @private eosID -> tag directly observed via a name-transition (append/
     * shrink/swap of Squad's own in-game clan-tag system), never a shape
     * guess. See docs/clan-tag-confirmation-rework.md §2/§3.1. Treated as
     * high-confidence — it corroborates other players' low-confidence
     * extractions of the same tag.
     */
    this._confirmedTags = new Map();

    /**
     * @private eosID -> most recently confirmed tag, survives disconnect
     * (unlike _confirmedTags, which removePlayerFromCache() clears along
     * with the rest of that player's session state). A reconnecting player
     * whose EOS ID is stable across sessions goes through the plain "new
     * player" join path, which never re-observes a tagless->tagged
     * transition when the tag is already present on their very first
     * post-reconnect name — Squad only re-injects it live for a genuinely
     * fresh, tagless join. Without this map, a bracketless/hash-prefixed
     * clan permanently loses its corroboration anchor the instant every
     * member has disconnected once, with no path back short of a live
     * mid-session tag change. addPlayerToCache() consults this to restore
     * 'confirmed' status immediately when a rejoining player's tag hasn't
     * changed, instead of waiting for a transition that will never come.
     * Cleared only by an explicit clearConfirmedTag() (the player removed
     * their own tag — a real signal, not a network blip) or a full
     * clearPlayerTagCache() reset.
     */
    this._lastConfirmedTags = new Map();

    /**
     * @private eosID -> candidate tag rejected only for lack of corroboration
     * (NOT rejected via ignoreList — that rejection is permanent, not
     * pending). Re-checked by _healPendingLowConfidenceTag() whenever a new
     * high-confidence/confirmed tag appears, so a bracketless clan doesn't
     * stay invisible to the incremental cache just because of unlucky join
     * order. See docs/clan-tag-confirmation-rework.md §3.5.
     */
    this._pendingLowConfidenceTags = new Map();
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
      minMergeLength: resolved.minMergeLength,
      caseSensitive: resolved.caseSensitive,
      ignoreList: Array.isArray(resolved.ignoreList) ? resolved.ignoreList : [],
      recruitSuffixes: Array.isArray(resolved.recruitSuffixes) ? resolved.recruitSuffixes : []
    };
  }

  extractRawPrefix(name) {
    return this._extractRawPrefixWithStrategy(name).raw;
  }

  /**
   * Same detection as extractRawPrefix(), but also reports which strategy
   * matched. 'bracket', 'separator', and 'prefixSymbol' require an explicit,
   * deliberate tag delimiter and are treated as high-confidence;
   * 'doublespace', 'shorttag', and 'bare' are heuristics over plain
   * whitespace and routinely fire on ordinary words ('BIG', 'THE', 'MR')
   * that aren't clan tags at all. The corroboration gate in
   * _computeClanGroups() / buildPlayerTagCache() uses this distinction to
   * decide which extractions can be trusted on their own.
   *
   * @private
   * @param {string} name
   * @returns {{raw: string|null, strategy: string|null}}
   */
  _extractRawPrefixWithStrategy(name) {
    if (!name || typeof name !== 'string') return { raw: null, strategy: null };

    const bracketRegex = /^\s*[\[\(【「『《╔├↾╬✦⟦╟|=<\{~\*%❀⇃←⌈](.+?)[\]\)】」』》╗┤↿╬✦⟧╢|=<>~\*\}%❀⇂→⌋]/;
    let match = name.match(bracketRegex);
    if (match) return { raw: match[1].trim(), strategy: 'bracket' };

    const sepRegex = /^\s*(.{1,10}?)\s*(?:\/\/|\||-|:|\:\(|\:\)|†|™|✯|~|\*|↯|♠)\s+/;
    match = name.match(sepRegex);
    if (match) return { raw: match[1].trim(), strategy: 'separator' };

    // A leading '#' immediately before the tag ('#BOZO Name') is the same
    // kind of deliberate, unambiguous formatting as a bracket pair or a
    // trailing separator — nobody's name accidentally starts with '#TAG '.
    // Without this, '#'-prefixed tags fall through to bareRegex below,
    // which is a low-confidence heuristic requiring corroboration from a
    // bracket/separator/confirmed source elsewhere in the population. A
    // clan whose members ALL use '#TAG' formatting then has no such source
    // and can never form a group, no matter how many members share the tag.
    //
    // No letter requirement: a numeric-only capture like '#1 BestPlayer'
    // is treated the same as any other tag. This does mean two unrelated
    // players who both self-style '#1' get merged as a false-positive
    // "clan" — an accepted trade-off, since the alternative (falling back
    // to bareRegex) requires corroboration a real all-numeric-tag clan
    // (e.g. '#420') could never produce on its own, a false negative that
    // costs a real clan its grouping entirely.
    const prefixSymbolRegex = /^\s*#(.{1,10}?)\s+/;
    match = name.match(prefixSymbolRegex);
    if (match) return { raw: match[1].trim(), strategy: 'prefixSymbol' };

    const spaceRegex = /^\s*(.{1,10}?)\s{2,}/;
    match = name.match(spaceRegex);
    if (match) return { raw: match[1].trim(), strategy: 'doublespace' };

    const shortTagRegex = /^\s*([A-Z0-9]{2,4})\s+[A-Z]/;
    match = name.match(shortTagRegex);
    if (match) return { raw: match[1].trim(), strategy: 'shorttag' };

    const bareRegex = /^[\[<({]?([^\s\[\](){}<>]{2,7})\s+\S/u;
    match = name.match(bareRegex);
    if (match) return { raw: match[1].trim(), strategy: 'bare' };

    return { raw: null, strategy: null };
  }

  /** @private True for strategies that require an explicit, deliberate tag delimiter. */
  _isHighConfidenceStrategy(strategy) {
    return strategy === 'bracket' || strategy === 'separator' || strategy === 'prefixSymbol' || strategy === 'confirmed';
  }

  normalizeTag(raw) {
    if (!raw || typeof raw !== 'string') return null;

    let norm = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');

    for (const [key, val] of Object.entries(NON_ASCII_MAP)) {
      norm = norm.replace(new RegExp(key, 'gi'), val);
    }

    // Strip whitespace/punctuation/symbols/emoji, but keep any Unicode
    // letter or number in ANY script — not just ASCII. A tag that's a real
    // word in Cyrillic, Greek, or CJK (e.g. 'Ш', 'ネズミ') is identity-bearing
    // and must survive; the NON_ASCII_MAP pass above already converted the
    // Latin-lookalike characters (я→r, ν→v, …) to ASCII before this point,
    // so what's left here is either genuine ASCII, a real non-Latin word, or
    // decoration — and \p{L}/\p{N} is exactly the line between the last two.
    norm = norm.replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
    return norm || null;
  }

  /**
   * Strips a recruit suffix from a raw clan tag if the resulting base tag
   * is known to exist on other players. This allows recruit-tagged players
   * (e.g. [ABCr]) to be grouped with their base clan ([ABC]).
   *
   * @param {string} rawTag - The raw extracted clan tag prefix.
   * @param {Set<string>} knownBaseTags - Set of normalized (uppercase, ASCII-only)
   *   tags already known to exist in the current data set.
   * @returns {string} The stripped tag if a suffix matched and the base tag
   *   exists in knownBaseTags; otherwise the original rawTag unchanged.
   */
  _stripRecruitSuffixIfBaseExists(rawTag, knownBaseTags) {
    if (!rawTag || typeof rawTag !== 'string') return rawTag;
    if (!this.options.recruitSuffixes?.length) return rawTag;
    if (!knownBaseTags?.size) return rawTag;

    const rawUpper = rawTag.toUpperCase();

    for (const suffix of this.options.recruitSuffixes) {
      if (!suffix || typeof suffix !== 'string') continue;
      if (rawTag.length <= suffix.length) continue;
      if (!rawUpper.endsWith(suffix.toUpperCase())) continue;

      const baseTag = rawTag.slice(0, -suffix.length);
      const baseUpper = baseTag.toUpperCase();

      // Check if baseTag exists in knownBaseTags (case-insensitive)
      for (const known of knownBaseTags) {
        if (known.toUpperCase() === baseUpper) return baseTag;
      }
    }

    return rawTag;
  }

  /**
   * Optimal-string-alignment (restricted) Damerau-Levenshtein distance:
   * standard insertion/deletion/substitution, plus an adjacent-character
   * transposition ('PHNTM' -> 'PHTNM') counted as a single edit instead of
   * two substitutions. Needs the full (m+1)x(n+1) table (not the rolling
   * single-row trick plain Levenshtein uses) because a transposition looks
   * back two rows and two columns — irrelevant cost at clan-tag lengths.
   */
  damerauLevenshteinDistance(a, b) {
    if (a === b) return 0;
    if (!a?.length) return b?.length || 0;
    if (!b?.length) return a.length;

    const m = a.length;
    const n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
        if (
          i > 1 && j > 1 &&
          a[i - 1] === b[j - 2] &&
          a[i - 2] === b[j - 1]
        ) {
          dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
        }
      }
    }

    return dp[m][n];
  }

  extractClanGroups(rawPlayers, options = {}) {
    return this._computeClanGroups(rawPlayers, options).groups;
  }

  /**
   * Same grouping pipeline as extractClanGroups(), plus a trace explaining
   * every decision that dropped or merged a tag. Intended for the `!s3 clans`
   * admin view — grouping consumers should keep calling extractClanGroups().
   *
   * @param {Array<{eosID: string, name: string}>} rawPlayers
   * @param {object} [options] - Grouping option overrides.
   * @returns {{groups: Object<string, string[]>, trace: object, options: object}}
   */
  explainClanGroups(rawPlayers, options = {}) {
    const { groups, trace } = this._computeClanGroups(rawPlayers, options);
    return { groups, trace, options: this.getGroupingOptions(options) };
  }

  /**
   * Runs the grouping pipeline and returns the surviving groups alongside a
   * trace of every exclusion and merge.
   *
   * Both extractClanGroups() and explainClanGroups() are thin wrappers over
   * this method, so the `!s3 clans` diagnostic view can never drift from the
   * grouping SmartAssign and TeamBalancer actually consume.
   *
   * Pipeline order matters and is reflected in the trace: extract → strip
   * recruit suffix → normalize → corroboration gate → ignore-list →
   * Damerau-Levenshtein merge → size bounds. A tag can therefore be merged
   * and *then* fall outside the size bounds.
   * Damerau-Levenshtein merge only considers tag pairs where both tags are
   * at least minMergeLength long, so short tags (e.g. 2-3 chars) never
   * fuzzy-merge.
   *
   * Corroboration gate: 'bracket', 'separator', and 'prefixSymbol' extraction
   * (an explicit `[TAG]`, `TAG //`, or `#TAG`) is high-confidence — deliberate
   * formatting. The whitespace-only heuristics ('doublespace', 'shorttag',
   * 'bare') routinely fire on ordinary words ('BIG', 'THE', 'MR', 'RAT') that
   * aren't clan tags at all. A low-confidence extraction only survives if the
   * SAME final key is also established by a high-confidence extraction from
   * some other player — one real bracketed/separated/hash-prefixed member
   * vouches for the rest.
   *
   * @private
   * @param {Array<{eosID: string, name: string}>} rawPlayers
   * @param {object} [options] - Grouping option overrides.
   * @returns {{groups: Object<string, string[]>, trace: object}}
   */
  _computeClanGroups(rawPlayers, options = {}) {
    const {
      minSize,
      maxSize,
      maxEditDistance,
      minMergeLength,
      caseSensitive,
      ignoreList
    } = this.getGroupingOptions(options);

    const trace = {
      scanned: 0,
      skipped: [],
      noTag: [],
      unnormalizable: [],
      recruitStripped: [],
      uncorroborated: [],
      ignored: [],
      merged: [],
      sizeExcluded: [],
      memberNames: new Map(),
      memberStrategies: new Map()
    };

    // Pass 1: collect all normalized raw prefixes for context-aware suffix stripping
    const allNormalizedPrefixes = new Set();
    for (const player of rawPlayers || []) {
      if (!player?.name || !player?.eosID) continue;
      const confirmedTag = this._confirmedTags.get(player.eosID);
      if (confirmedTag) {
        allNormalizedPrefixes.add(confirmedTag);
        continue;
      }
      const raw = this.extractRawPrefix(player.name);
      if (!raw) continue;
      const norm = this.normalizeTag(raw);
      if (norm) allNormalizedPrefixes.add(norm);
    }

    // Pass 2: resolve each player's final key + extraction strategy, and
    // collect which final keys are backed by at least one high-confidence
    // (bracket/separator) extraction. Needed before bucketing so a
    // low-confidence player can be checked against the WHOLE population's
    // corroboration, not just players seen earlier in iteration order.
    const resolved = [];
    const highConfidenceKeys = new Set();
    for (const player of rawPlayers || []) {
      if (!player?.name || !player?.eosID) continue;

      const confirmedTag = this._confirmedTags.get(player.eosID);
      if (confirmedTag) {
        resolved.push({
          player,
          original: confirmedTag,
          raw: confirmedTag,
          strategy: 'confirmed',
          key: confirmedTag
        });
        highConfidenceKeys.add(confirmedTag);
        continue;
      }

      const { raw: original, strategy } = this._extractRawPrefixWithStrategy(player.name);
      if (!original) continue;

      const raw = this._stripRecruitSuffixIfBaseExists(original, allNormalizedPrefixes);
      const key = caseSensitive ? raw : this.normalizeTag(raw);
      resolved.push({ player, original, raw, strategy, key });

      if (key && this._isHighConfidenceStrategy(strategy)) {
        highConfidenceKeys.add(key);
      }
    }
    const resolvedByEosID = new Map(resolved.map((r) => [r.player.eosID, r]));

    const groups = {};
    for (const player of rawPlayers || []) {
      trace.scanned += 1;

      if (!player?.name || !player?.eosID) {
        trace.skipped.push({ eosID: player?.eosID ?? null, name: player?.name ?? null });
        continue;
      }

      trace.memberNames.set(player.eosID, player.name);

      const entry = resolvedByEosID.get(player.eosID);
      if (!entry) {
        trace.noTag.push({ eosID: player.eosID, name: player.name });
        continue;
      }

      trace.memberStrategies.set(player.eosID, entry.strategy);

      const { original, raw, strategy, key } = entry;
      if (raw !== original) {
        trace.recruitStripped.push({
          eosID: player.eosID,
          name: player.name,
          from: original,
          to: raw
        });
      }

      if (!key) {
        trace.unnormalizable.push({ eosID: player.eosID, name: player.name, raw });
        continue;
      }

      if (!this._isHighConfidenceStrategy(strategy) && !highConfidenceKeys.has(key)) {
        trace.uncorroborated.push({ eosID: player.eosID, name: player.name, tag: key });
        continue;
      }

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
          trace.ignored.push({ tag, size: groups[tag].length, members: [...groups[tag]] });
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
            // A single-character edit is far more discriminating on a long tag
            // than a short one — 'CB' vs '8B' is a coinflip, not a typo. Below
            // minMergeLength, only an exact match (already bucketed together
            // above) counts; fuzzy merging only kicks in at minMergeLength+.
            if (Math.min(tags[i].length, tags[j].length) < minMergeLength) continue;

            const distance = this.damerauLevenshteinDistance(tags[i], tags[j]);
            if (distance <= maxEditDistance) {
              const [keep, absorb] = groups[tags[i]].length >= groups[tags[j]].length
                ? [tags[i], tags[j]]
                : [tags[j], tags[i]];

              trace.merged.push({
                keep,
                absorbed: absorb,
                distance,
                keepSize: groups[keep].length,
                absorbedSize: groups[absorb].length
              });

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
      const size = groups[tag].length;
      if (size < minSize) {
        trace.sizeExcluded.push({
          tag, size, reason: 'minSize', bound: minSize, members: [...groups[tag]]
        });
        delete groups[tag];
      } else if (size > maxSize) {
        trace.sizeExcluded.push({
          tag, size, reason: 'maxSize', bound: maxSize, members: [...groups[tag]]
        });
        delete groups[tag];
      }
    }

    return { groups, trace };
  }

  buildPlayerTagCache(players, options = {}) {
    const { caseSensitive, ignoreList } = this.getGroupingOptions(options);
    const cache = new Map();

    const normalizedIgnores = caseSensitive
      ? new Set(ignoreList)
      : new Set(ignoreList.map((t) => this.normalizeTag(t)).filter(Boolean));

    // Pass 1: collect all normalized raw prefixes for context-aware suffix stripping
    const allNormalizedPrefixes = new Set();
    for (const player of players || []) {
      if (!player?.eosID) continue;
      const confirmedTag = this._confirmedTags.get(player.eosID);
      if (confirmedTag) {
        allNormalizedPrefixes.add(confirmedTag);
        continue;
      }
      const raw = this.extractRawPrefix(player.name);
      if (!raw) continue;
      const norm = this.normalizeTag(raw);
      if (norm) allNormalizedPrefixes.add(norm);
    }

    // Pass 2: resolve each player's final key + extraction strategy, and
    // collect which final keys are backed by at least one high-confidence
    // (bracket/separator) extraction. See _computeClanGroups() for why —
    // this batch method must gate the same way or SmartAssign's join-time
    // routing (which reads this cache) would drift from what TeamBalancer's
    // extractClanGroups() decides for the same population.
    const resolved = new Map();
    const highConfidenceKeys = new Set();
    for (const player of players || []) {
      if (!player?.eosID) continue;

      const confirmedTag = this._confirmedTags.get(player.eosID);
      if (confirmedTag) {
        resolved.set(player.eosID, { key: confirmedTag, strategy: 'confirmed' });
        highConfidenceKeys.add(confirmedTag);
        continue;
      }

      const { raw: original, strategy } = this._extractRawPrefixWithStrategy(player.name);
      if (!original) {
        resolved.set(player.eosID, { key: null, strategy: null });
        continue;
      }

      const raw = this._stripRecruitSuffixIfBaseExists(original, allNormalizedPrefixes);
      const key = raw ? (caseSensitive ? raw : this.normalizeTag(raw)) : null;
      resolved.set(player.eosID, { key, strategy });

      if (key && this._isHighConfidenceStrategy(strategy)) {
        highConfidenceKeys.add(key);
      }
    }

    for (const player of players || []) {
      if (!player?.eosID) continue;

      let { key: tag, strategy } = resolved.get(player.eosID);

      if (tag && !this._isHighConfidenceStrategy(strategy) && !highConfidenceKeys.has(tag)) {
        tag = null;
      }

      // Filter out ignored clan tags — set cache entry to null so
      // the player is treated as clanless for all downstream lookups.
      if (tag && normalizedIgnores.has(tag)) {
        tag = null;
      }

      cache.set(player.eosID, tag);
    }

    return cache;
  }

  getClanTeamForPlayer(joiningPlayer, playerTagCache, serverPlayers, options = {}) {
    if (!joiningPlayer?.eosID || !playerTagCache || !serverPlayers) {
      return null;
    }

    const { minSize, caseSensitive, ignoreList } = this.getGroupingOptions(options);
    const joinerTag = playerTagCache.get(joiningPlayer.eosID);
    if (!joinerTag) return null;

    // Defense-in-depth: if the joiner's tag is on the ignore list,
    // refuse to route them — even if a stale cache missed the filter.
    if (ignoreList.length > 0) {
      const normalizedIgnores = caseSensitive
        ? new Set(ignoreList)
        : new Set(ignoreList.map((t) => this.normalizeTag(t)).filter(Boolean));
      if (normalizedIgnores.has(joinerTag)) return null;
    }

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
    if (this._confirmedTags.has(eosID)) return;

    const { raw: original, strategy } = this._extractRawPrefixWithStrategy(name);
    let raw = original;

    // Strip recruit suffix if base tag exists in the existing cache
    if (raw && this.options.recruitSuffixes?.length) {
      const existingTags = new Set();
      for (const v of this._playerTagCache.values()) {
        if (v) existingTags.add(v);
      }
      raw = this._stripRecruitSuffixIfBaseExists(raw, existingTags);
    }

    let candidateTag = raw ? (this.options.caseSensitive ? raw : this.normalizeTag(raw)) : null;

    // Ignore-listed tags are permanently unusable — filter BEFORE the
    // corroboration check, not after. If this ran after, a tag that is BOTH
    // ignore-listed AND uncorroborated would already be null by the time the
    // ignore check's guard runs, so rejectedForCorroboration would
    // incorrectly stay true — silently filing an ignored word into the
    // pending-heal map. Filtering here means an ignored candidate never
    // enters the corroboration logic at all.
    if (candidateTag && this.options.ignoreList?.length > 0) {
      const normalizedIgnores = this.options.caseSensitive
        ? new Set(this.options.ignoreList)
        : new Set(this.options.ignoreList.map((t) => this.normalizeTag(t)).filter(Boolean));
      if (normalizedIgnores.has(candidateTag)) candidateTag = null;
    }

    // Reconnect restoration: this eosID was confirmed before (via a live
    // transition or a high-confidence extraction) and their current name
    // still resolves to that exact tag. Trust it immediately rather than
    // demanding a fresh corroborator — a rejoining player whose tag is
    // already visible on their very first post-reconnect name will never
    // produce the tagless->tagged transition addPlayerToCache's caller
    // relies on to (re-)confirm normally, since Squad only re-injects the
    // tag live for a genuinely fresh, tagless join. Without this, a clan
    // whose format never earns a bracket/separator (or a hash-prefix) is
    // one disconnect away from permanently losing its sole corroboration
    // anchor. Only an exact tag match restores it — a changed or absent
    // tag falls through to the ordinary corroboration gate below.
    if (candidateTag && this._lastConfirmedTags.get(eosID) === candidateTag) {
      this.recordConfirmedTag(eosID, raw);
      return;
    }

    let tag = candidateTag;
    let rejectedForCorroboration = false;

    // Low-confidence extractions ('doublespace'/'shorttag'/'bare' — ordinary
    // words like 'BIG'/'THE' routinely match these) only count if some OTHER
    // currently-cached player already established the same tag via an
    // explicit bracket/separator/confirmed source. Mirrors the batch-path
    // gate in _computeClanGroups()/buildPlayerTagCache() for this
    // incremental, per-join path. A rejected candidate is remembered in
    // _pendingLowConfidenceTags and retroactively healed the moment a
    // matching high-confidence tag appears — see _healPendingLowConfidenceTag().
    if (tag && !this._isHighConfidenceStrategy(strategy)) {
      let corroborated = false;
      for (const [otherEosID, otherTag] of this._playerTagCache) {
        if (otherEosID === eosID || otherTag !== tag) continue;
        if (this._isHighConfidenceStrategy(this._playerTagStrategy.get(otherEosID))) {
          corroborated = true;
          break;
        }
      }
      if (!corroborated) {
        tag = null;
        rejectedForCorroboration = true;
      }
    }

    this._playerTagCache.set(eosID, tag);
    this._playerTagStrategy.set(eosID, strategy);

    if (rejectedForCorroboration && candidateTag) {
      this._pendingLowConfidenceTags.set(eosID, candidateTag);
    } else {
      this._pendingLowConfidenceTags.delete(eosID);
    }

    if (tag && this._isHighConfidenceStrategy(strategy)) {
      this._healPendingLowConfidenceTag(tag);
    }
  }

  /**
   * Records a clan tag directly observed via a name-transition (append/
   * shrink/swap), never a shape guess. Treated as high-confidence — it
   * corroborates other players' low-confidence extractions of the same tag.
   * Only recordConfirmedTag()/clearConfirmedTag() may change a confirmed
   * entry; addPlayerToCache() early-returns for an already-confirmed player.
   * See docs/clan-tag-confirmation-rework.md §3.1.
   */
  recordConfirmedTag(eosID, rawPrefix) {
    if (!eosID || !rawPrefix) return;
    let tag = this.options.caseSensitive ? rawPrefix : this.normalizeTag(rawPrefix);
    if (!tag) return;
    if (this.options.ignoreList?.length > 0) {
      const normalizedIgnores = this.options.caseSensitive
        ? new Set(this.options.ignoreList)
        : new Set(this.options.ignoreList.map((t) => this.normalizeTag(t)).filter(Boolean));
      if (normalizedIgnores.has(tag)) return;
    }
    this._confirmedTags.set(eosID, tag);
    this._lastConfirmedTags.set(eosID, tag);
    this._playerTagCache.set(eosID, tag);
    this._playerTagStrategy.set(eosID, 'confirmed');
    this._healPendingLowConfidenceTag(tag);
  }

  clearConfirmedTag(eosID) {
    if (!eosID || !this._confirmedTags.has(eosID)) return;
    this._confirmedTags.delete(eosID);
    // A deliberate in-session removal (shrink transition — the player took
    // their own tag off) is a real signal, unlike a disconnect. Clear the
    // reconnect-restoration memory too, or a later reconnect would silently
    // re-confirm a tag the player just chose to drop.
    this._lastConfirmedTags.delete(eosID);
    this._playerTagCache.delete(eosID);
    this._playerTagStrategy.delete(eosID);
  }

  /**
   * Retroactively promotes any pending low-confidence candidate matching
   * `tag` now that a high-confidence/confirmed source has corroborated it.
   * Bounded by the number of currently-pending uncorroborated players —
   * realistically single digits — so no batching/debouncing is needed.
   * See docs/clan-tag-confirmation-rework.md §3.5.
   * @private
   */
  _healPendingLowConfidenceTag(tag) {
    for (const [pendingEosID, pendingTag] of this._pendingLowConfidenceTags) {
      if (pendingTag !== tag) continue;
      this._playerTagCache.set(pendingEosID, tag);
      this._pendingLowConfidenceTags.delete(pendingEosID);
    }
  }

  removePlayerFromCache(eosID) {
    if (!eosID) return;
    this._playerTagCache.delete(eosID);
    this._playerTagStrategy.delete(eosID);
    this._confirmedTags.delete(eosID);
    this._pendingLowConfidenceTags.delete(eosID);
    // _lastConfirmedTags is deliberately NOT cleared here — see its
    // constructor doc comment. A disconnect is not a signal the tag is
    // gone; addPlayerToCache() uses it to restore 'confirmed' on rejoin.
  }

  clearPlayerTagCache() {
    this._playerTagCache.clear();
    this._playerTagStrategy.clear();
    this._confirmedTags.clear();
    this._lastConfirmedTags.clear();
    this._pendingLowConfidenceTags.clear();
  }

  getPlayerTagCache() {
    return new Map(this._playerTagCache);
  }

  rebuildFromAllPlayers(players) {
    this._playerTagCache.clear();
    this._playerTagStrategy.clear();

    for (const p of players || []) {
      if (!p?.eosID) continue;
      const { strategy } = this._extractRawPrefixWithStrategy(p.name);
      this._playerTagStrategy.set(p.eosID, strategy);
    }

    // Delegate to the corroboration-aware batch method rather than looping
    // addPlayerToCache() — a full rebuild sees the whole population at once,
    // so it should reach the exact same answer as extractClanGroups() does
    // for that population, with no dependency on join order.
    const cache = this.buildPlayerTagCache(players || []);
    for (const [eosID, tag] of cache) {
      this._playerTagCache.set(eosID, tag);
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