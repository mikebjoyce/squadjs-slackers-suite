/**
 * COMMUNITY-OPTIONS — the one list of plugin options that steer community-wide
 * rows, and the three different things to do about them.
 *
 * ─── WHY A LIST AT ALL ───────────────────────────────────────────
 *
 * Every process in a community runs the same suite version — that is checked at
 * mount and refused on. Nothing checks that they run the same *configuration*,
 * and once a table is community-wide several ordinary plugin options stop being
 * local policy. `maxSwitchTokens` used to describe one server's token bucket; it
 * now describes a bucket every server reads and writes.
 *
 * The list lives here rather than in the plugins that declare the options
 * because the question "is this option community-affecting" is a property of the
 * *schema layout*, which S³ owns, not of the plugin. A plugin author adding an
 * option that writes a shared table has to come here anyway; splitting the list
 * across plugins is how one of them gets forgotten.
 *
 * ─── THE THREE KINDS ─────────────────────────────────────────────
 *
 * It is one list and three levers, chosen by blast radius. Treating it as one
 * lever is what produced two wrong answers before this file existed.
 *
 *   RESOLVED     The option governs a shared row that ordinary play reads and
 *                writes. It cannot refuse — you cannot decline a player's switch
 *                because two admins disagree about a cap — and it cannot be
 *                allowed to diverge, because the lower-capped server resets the
 *                regen anchor the higher-capped one was accruing against and the
 *                player simply stops regenerating. So every process resolves one
 *                community value from the registry and reads that instead of its
 *                own config. Lowest registered value wins: deterministic,
 *                order-independent, and it errs toward the stricter server
 *                rather than handing the community the loosest config anyone
 *                typed.
 *
 *   MUST_AGREE   The option is a deletion predicate against a shared table.
 *                Divergence deletes different rows depending on which process
 *                ran last, and there is no "lowest" that is obviously right —
 *                a retention window is a policy, not a safety limit. So the
 *                write refuses while the disagreement stands and names it.
 *                Refusing costs only housekeeping, which is why refusal is
 *                affordable here and not above.
 *
 *   MAY_DIFFER   The option gates *this server's own rounds* before anything
 *                shared is written. A 40-player server and a 100-player server
 *                have honest reason to differ. Reported, never enforced — the
 *                point is to turn an accidental divergence into an argument the
 *                admins have on purpose.
 *
 * ─── REGISTERED, NOT LIVE ────────────────────────────────────────
 *
 * Resolution and comparison both run over every *registered* row, not the live
 * ones. This is the opposite of the version check, deliberately: a stopped
 * server is not running an old schema against the database, so its version is
 * irrelevant, but its configuration still describes what this community's policy
 * is and it will come back. Resolving over live rows would also make the cap in
 * force flap every time a neighbour restarted.
 *
 * ─── WHAT IS RECORDED ────────────────────────────────────────────
 *
 * Post-validation values, always. Switch clamps a non-positive `maxSwitchTokens`
 * to 1 at mount, so recording the raw config value reports agreement where there
 * is none and disagreement where there is none. Each plugin records the keys it
 * owns; a row missing a key contributes no candidate for it, which is what makes
 * a community where only one server runs Switch resolve to that server's values
 * rather than to nothing.
 */

/* ─────────────────────────────── KINDS ─────────────────────────────── */

export const OPTION_KIND = Object.freeze({
  RESOLVED: 'resolved',
  MUST_AGREE: 'must-agree',
  MAY_DIFFER: 'may-differ'
});

/* ─────────────────────────────── THE LIST ─────────────────────────────── */

/**
 * Groups, not keys, because two of these options only mean anything together.
 *
 * `switchCooldownMinutes` overrides `switchCooldownHours` when it is positive,
 * so taking the lowest of each key independently invents an interval nobody
 * configured: minutes 0 / hours 1.75 against minutes 30 / hours 1 resolves
 * per-key to minutes 0 / hours 1, which is sixty minutes — not the 105 either
 * server wanted, and not the 30 the stricter one wanted. Ranking the whole
 * group by its derived interval and taking the winner's values whole keeps the
 * resolved pair a pair some server actually declared.
 *
 * `rank` is only consulted for RESOLVED groups. Lower wins; ties go to the
 * lowest `serverID` so the answer does not depend on row order.
 */
export const COMMUNITY_OPTION_GROUPS = Object.freeze([
  Object.freeze({
    name: 'maxSwitchTokens',
    plugin: 'switch',
    kind: OPTION_KIND.RESOLVED,
    keys: Object.freeze(['maxSwitchTokens']),
    rank: (v) => v.maxSwitchTokens
  }),
  Object.freeze({
    name: 'switchCooldown',
    plugin: 'switch',
    kind: OPTION_KIND.RESOLVED,
    keys: Object.freeze(['switchCooldownMinutes', 'switchCooldownHours']),
    rank: (v) => (v.switchCooldownMinutes > 0
      ? v.switchCooldownMinutes * 60 * 1000
      : v.switchCooldownHours * 60 * 60 * 1000)
  }),
  Object.freeze({
    name: 'pruneInactivePlayerDays',
    plugin: 'switch',
    kind: OPTION_KIND.MUST_AGREE,
    keys: Object.freeze(['pruneInactivePlayerDays'])
  }),
  Object.freeze({
    name: 'minRoundsForLeaderboard',
    plugin: 'elo-tracker',
    kind: OPTION_KIND.MUST_AGREE,
    keys: Object.freeze(['minRoundsForLeaderboard'])
  }),
  Object.freeze({
    name: 'minPlayersForElo',
    plugin: 'elo-tracker',
    kind: OPTION_KIND.MAY_DIFFER,
    keys: Object.freeze(['minPlayersForElo'])
  }),
  Object.freeze({
    name: 'minParticipationRatio',
    plugin: 'elo-tracker',
    kind: OPTION_KIND.MAY_DIFFER,
    keys: Object.freeze(['minParticipationRatio'])
  })
]);

/** Every recorded key, flattened. */
export function communityOptionKeys() {
  return COMMUNITY_OPTION_GROUPS.flatMap((g) => [...g.keys]);
}

/** The group a key belongs to, or null. */
export function communityOptionGroup(name) {
  return COMMUNITY_OPTION_GROUPS.find((g) => g.name === name) || null;
}

/* ─────────────────────────────── PARSING ─────────────────────────────── */

/**
 * The `communityOptions` column is a TEXT JSON blob, so every reader has to
 * cope with a hand-edited row. One definition of "what does this column mean",
 * shared by the resolver and by `!s3 servers`, because two would drift.
 *
 * @param {string|object|null} raw
 * @returns {object|null} A plain object, or null when the blob is absent or unusable
 */
export function parseCommunityOptions(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ─────────────────────────────── SUMMARY ─────────────────────────────── */

/**
 * A row contributes a candidate for a group only when it carries a finite
 * number for *every* key in the group.
 *
 * Partial groups are dropped rather than defaulted. A half-recorded cooldown
 * pair would rank against a zero it never declared, and the failure would be
 * silent: the resolver would hand the community an interval no admin chose and
 * nothing would say so.
 */
function candidateFor(group, values) {
  if (!values) return null;
  const picked = {};
  for (const key of group.keys) {
    const value = values[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    picked[key] = value;
  }
  return picked;
}

/** Two candidates agree when every key matches. */
function sameValues(group, a, b) {
  return group.keys.every((key) => a[key] === b[key]);
}

/**
 * Resolve and compare the community-affecting options across registered rows.
 *
 * @param {Array<object>} rows - `S3_Servers` rows: `{serverID, alias, communityOptions}`
 * @returns {{resolved: object, disagreements: Array<object>}}
 *   `resolved` is keyed by group name and holds only RESOLVED groups that had at
 *   least one candidate — a consumer reading a group that is absent falls back to
 *   its own configured value, which is the correct answer for a community of one
 *   and the only answer available for a community that has recorded nothing yet.
 *   `disagreements` covers all three kinds; `refuses` says whether a write
 *   declines while it stands.
 */
export function summariseCommunityOptions(rows) {
  const parsed = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      serverID: row?.serverID ?? null,
      alias: row?.alias ?? null,
      values: parseCommunityOptions(row?.communityOptions)
    }))
    .sort((a, b) => (a.serverID ?? 0) - (b.serverID ?? 0));

  const resolved = {};
  const disagreements = [];

  for (const group of COMMUNITY_OPTION_GROUPS) {
    const candidates = [];
    for (const row of parsed) {
      const values = candidateFor(group, row.values);
      if (values) candidates.push({ serverID: row.serverID, alias: row.alias, values });
    }
    if (candidates.length === 0) continue;

    const distinct = [];
    for (const candidate of candidates) {
      if (!distinct.some((seen) => sameValues(group, seen.values, candidate.values))) {
        distinct.push(candidate);
      }
    }

    if (distinct.length > 1) {
      disagreements.push({
        name: group.name,
        plugin: group.plugin,
        kind: group.kind,
        // Whether a write declines on it, which is the must-agree lever alone.
        // A resolved option is protected more strongly than a refusal could manage
        // — there is one community value and every process reads it — and a
        // may-differ one is not protected at all, on purpose.
        refuses: group.kind === OPTION_KIND.MUST_AGREE,
        keys: [...group.keys],
        values: candidates
      });
    }

    if (group.kind !== OPTION_KIND.RESOLVED) continue;

    // Lowest rank wins, ties to the lowest serverID. The sort above already put
    // the rows in serverID order and `reduce` keeps the incumbent on a tie, so
    // the tie-break needs no separate comparison.
    const winner = candidates.reduce((best, next) =>
      (group.rank(next.values) < group.rank(best.values) ? next : best));

    resolved[group.name] = {
      values: winner.values,
      serverID: winner.serverID,
      alias: winner.alias,
      candidates: candidates.length,
      contested: distinct.length > 1
    };
  }

  return { resolved, disagreements };
}

/**
 * The enforced disagreement on one group, or null.
 *
 * This is what a refusing write asks: `!enforcedDisagreement(summary, 'x')` is
 * the whole gate. MAY_DIFFER groups never come back from here, so a write cannot
 * accidentally start enforcing one by naming it.
 */
export function enforcedDisagreement(summary, name) {
  const found = (summary?.disagreements || []).find((d) => d.name === name);
  return found && found.refuses ? found : null;
}

/**
 * One phrasing of a disagreement, used by the mount warning and by every write
 * refusal. Two phrasings would drift, and the operator reading the second one
 * would have to work out that it is the same problem.
 *
 * @returns {string} e.g. `pruneInactivePlayerDays: main=3, event=7`
 */
export function describeDisagreement(entry) {
  if (!entry) return '';
  const single = entry.keys.length === 1;
  const perServer = entry.values.map((candidate) => {
    const who = candidate.alias || `server ${candidate.serverID}`;
    // A one-key group repeats its own name once per server otherwise, which is
    // the majority of this list and the majority of what an operator reads.
    if (single) return `${who}=${candidate.values[entry.keys[0]]}`;
    return `${who} ${entry.keys.map((key) => `${key}=${candidate.values[key]}`).join(' ')}`;
  });
  return `${entry.name}: ${perServer.join(', ')}`;
}
