/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               S³ SERVER LABEL                                ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Turn the registered server names into the short names a human reads
 * in a Discord embed — "Northern Lights #1", not "server 2" and not the
 * ninety-three characters the row actually holds.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * SERVER_LABEL_MAX_LENGTH — Cap on a rendered label.
 * SERVER_TITLE_SEPARATOR — What divides the server from an embed title.
 * serverLabels(rows, opts) — Map of serverID to label, or to null.
 * serverDisplayName(row, opts) — One row's label, or null.
 * publishServerLabel(label) — Set what this process labels with. S³ only.
 * readServerLabel() — The published label, or null.
 * applyServerLabel(payload, label) — Label a payload's embeds, at the top.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * None. Pure string work on plain objects, so the routing gate can use
 * it without taking on the database service.
 *
 * ─── THE RULE, AND WHY IT IS NOT A FORMAT ────────────────────────
 *
 * A Squad `ServerName` is a browser advertisement rather than a label,
 * and communities pad it differently:
 *
 *   Northern Lights #1 | Teamwork Oriented | Beginner Friendly | discord.gg/x
 *   [TT] Tactical #2 - EU - New Player Friendly - discord.gg/tt
 *   Rangers | #1 | Teamwork
 *   Some Server With No Separators At All
 *
 * Cutting at a fixed separator does not survive that. It does nothing
 * to the fourth name, and on the third it returns "Rangers" for every
 * server in the community — a label that reads like a name and
 * distinguishes nothing, which is worse than "server 1" because
 * nothing about it looks wrong.
 *
 * So the boilerplate is not guessed from a format, it is measured. The
 * names are split into segments on any of the separators communities
 * actually use, and a segment position that reads the same on every
 * registered server is dropped as the pitch it is. What is left is the
 * part that differs, plus the leading segment, which is the identity
 * even when it is shared.
 *
 *   Northern Lights: position 0 differs, the rest are identical
 *                    → "Northern Lights #1" / "Northern Lights #2"
 *   Rangers:         position 0 is shared, position 1 differs
 *                    → "Rangers #1" / "Rangers #2"
 *   No separator:    one segment, which differs
 *                    → the whole name, cut to the display width
 *
 * Two consequences follow, and both are deliberate:
 *
 * - One registered server has nothing to be compared against, so
 *   nothing can be shown to be boilerplate and the whole name is used.
 *   Dropping a segment there would be the format guess this rule
 *   exists to avoid, and a lone server is not being confused with
 *   anything anyway.
 *
 * - A label is only worth showing if it is distinct. When two rows
 *   render the same — identical names, or a difference that fell off
 *   the end of the cut — both get null rather than a label that
 *   quietly describes the wrong server. A caller that needs something
 *   to print falls back to the alias, which is distinct by
 *   construction.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Not an alias. An alias is typed, unique and stable; a label is
 *   read, may repeat, and changes when an admin edits Server.cfg. Two
 *   servers named "Northern Lights #1" and "#2" label perfectly and
 *   would make aliases one keystroke apart, which is the collision
 *   `DBService.setServerAlias()` refuses.
 *
 * - Labels are relative to the rows handed in. A refusal listing two
 *   candidates out of three shortens against those two, which is what
 *   the reader is choosing between.
 */

/**
 * Discord renders an embed field name on one line up to a point, and a
 * long label pushes the id and the "this server" marker off the end of
 * it. Forty-eight characters holds every real server name seen so far
 * with room for the decorations around it.
 */
export const SERVER_LABEL_MAX_LENGTH = 48;

/**
 * The separators a Squad server name is padded with.
 *
 * A bare hyphen is not among them — it appears inside names ("Sun-Tzu",
 * "Anti-Cheat") far more often than it separates them — so it counts
 * only with whitespace on both sides, which is how it is used as one.
 */
const SEGMENT_SPLIT = /\s*(?:\|+|\/{2,}|::|•|●|▪|~|—|–)\s*|\s+-+\s+/;

/** The stored name, or '' when there is nothing to read. */
function nameOf(row) {
  const raw = typeof row?.serverName === 'string' ? row.serverName : '';
  return raw.trim();
}

/** A name split into its segments, empties dropped. */
function segmentsOf(name) {
  return name.split(SEGMENT_SPLIT).map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Cut with an ellipsis rather than mid-word, so the result still reads
 * as a name.
 */
function truncateLabel(value, limit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * The short display name for every row handed in.
 *
 * @param {object[]} rows - Registry rows, or anything with the same fields
 * @param {object} [opts]
 * @param {number} [opts.maxLength] - Cap on a rendered label
 * @returns {Map<*, string|null>} serverID to label, null where there is
 *          no name or no distinct one
 */
export function serverLabels(rows, { maxLength = SERVER_LABEL_MAX_LENGTH } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const limit = Number.isFinite(maxLength) && maxLength > 1
    ? Math.floor(maxLength)
    : SERVER_LABEL_MAX_LENGTH;

  const labels = new Map();
  const named = list.filter((row) => nameOf(row) !== '');
  const parsed = named.map((row) => ({ row, segments: segmentsOf(nameOf(row)) }));

  // With one name there is no evidence about what is padding, so none of
  // it is dropped. With none, there is nothing to do at all.
  const shared = parsed.length > 1 ? sharedPositions(parsed.map((p) => p.segments)) : null;

  for (const row of list) labels.set(row?.serverID, null);

  for (const { row, segments } of parsed) {
    // Position 0 is kept whether or not it is shared: it is the name the
    // community goes by, and "#1" on its own labels nothing.
    const kept = segments.filter((_, index) => index === 0 || !shared?.has(index));

    // Nothing dropped means nothing to shorten, and the name is shown as the
    // admin wrote it — separators and all. Rebuilding it from the segments
    // would silently restyle a name this rule had decided not to touch.
    const text = kept.length === segments.length
      ? nameOf(row)
      : (kept.length > 0 ? kept : segments).join(' ').trim();

    labels.set(row?.serverID, text === '' ? null : truncateLabel(text, limit));
  }

  return dropCollisions(labels);
}

/**
 * The segment positions that read the same on every named server.
 *
 * A position present on some names and absent from others is not shared
 * — a server that left the pitch off its name is one whose remaining
 * segments still say something.
 */
function sharedPositions(allSegments) {
  const width = Math.max(...allSegments.map((s) => s.length));
  const shared = new Set();

  for (let index = 0; index < width; index += 1) {
    const first = allSegments[0][index];
    if (first === undefined) continue;
    const same = allSegments.every(
      (segments) => segments[index] !== undefined &&
        segments[index].toLowerCase() === first.toLowerCase()
    );
    if (same) shared.add(index);
  }

  return shared;
}

/**
 * Null out any label that more than one row ended up with.
 *
 * The comparison folds case because two labels that differ only in
 * capitalisation are the same label to the person reading them at a
 * glance, which is the whole audience.
 */
function dropCollisions(labels) {
  const seen = new Map();
  for (const label of labels.values()) {
    if (label === null) continue;
    const key = label.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  for (const [serverID, label] of labels) {
    if (label !== null && seen.get(label.toLowerCase()) > 1) labels.set(serverID, null);
  }

  return labels;
}

/**
 * One row's label, with nothing to compare it against.
 *
 * Returns the whole name cut to the display width. Callers that hold
 * the whole set should use serverLabels() instead — the shortening is
 * only possible when there is something to shorten against.
 *
 * @param {object} row
 * @param {object} [opts]
 * @returns {string|null}
 */
export function serverDisplayName(row, opts) {
  return serverLabels([row], opts).get(row?.serverID) ?? null;
}

/* ─────────────────────────── THE PUBLISHED LABEL ─────────────────────────── */

/**
 * What this process labels its embeds with, or null for no label.
 *
 * Module-level, which makes it per-process: `install.cjs` flattens every
 * plugin's utils into one directory, so all four plugins load this exact
 * module object and read the same slot. In the source tree S³'s own files
 * reach it the same way.
 *
 * It is a resolved string rather than the parts it is built from. The
 * senders run on every Discord message and must do no lookup and no
 * database work, and localizing at each of them would put one visible
 * string through four call sites, which is four chances for
 * `make-locale-templates.mjs` to reach four different verdicts about it.
 * S³ resolves it once at mount and again on the registry heartbeat.
 */
let publishedLabel = null;

/**
 * What separates the server from the rest of an embed title.
 *
 * Exported because `S3PluginBase.titleWithServer()` builds that title and
 * `labelOne()` below has to recognise it. One constant rather than two
 * matching string literals in two files: if they drift, the recognition
 * silently fails and a mutation reply names its server twice.
 */
export const SERVER_TITLE_SEPARATOR = ' — ';

/**
 * Publish this process's label. Called by S³ only.
 *
 * Null and empty are the same instruction — stop labelling — which is
 * what a single-server install wants and what makes the decoration a
 * no-op rather than a branch at every sender.
 *
 * @param {string|null} label
 */
export function publishServerLabel(label) {
  publishedLabel = typeof label === 'string' && label.trim() !== '' ? label.trim() : null;
}

/** The published label, or null. */
export function readServerLabel() {
  return publishedLabel;
}

/**
 * Put the label at the top of every embed in a Discord payload.
 *
 * ─── WHY THE AUTHOR SLOT, NOT THE FOOTER ───
 *
 * This labelled the footer first, and the footer is where a label goes to
 * be missed. `status`, `stats` and `check` broadcast — every registered
 * server answers the same typed command — so an admin reads two embeds
 * that are identical for their whole height and differ in the last line,
 * below the fields, in the smallest text Discord renders. Telling them
 * apart meant scrolling to the bottom of each and comparing. The answer
 * to "which server is this" has to be readable before the content it
 * qualifies, not after it.
 *
 * The author slot is the only thing above the title, and it is free: no
 * embed in the suite sets one, so nothing is displaced by taking it. The
 * footer is left exactly as the caller wrote it, which keeps the version
 * stamps ("Switch v2.6.0") that were sharing it.
 *
 * ─── WHY BOTH SHAPES ───
 *
 * Embeds here are plain object literals; there is no `EmbedBuilder` and
 * no `setAuthor` in the suite. Most call sites write `embeds: [ … ]` and
 * a minority write the singular `embed`.
 *
 * Nothing is mutated: a caller's embed literal may be reused, and the
 * senders retry on a 429 by re-sending the same payload, so writing in
 * place would relabel a payload once per attempt.
 *
 * @param {object} payload - { embeds: [...] } or { embed: {...} }
 * @param {string|null} [label] - Defaults to the published label
 * @returns {object} The payload, labelled if there was a label to add
 */
export function applyServerLabel(payload, label = readServerLabel()) {
  if (!label || typeof payload !== 'object' || payload === null) return payload;

  if (Array.isArray(payload.embeds)) {
    return { ...payload, embeds: payload.embeds.map((embed) => labelOne(embed, label)) };
  }
  if (payload.embed && typeof payload.embed === 'object') {
    return { ...payload, embed: labelOne(payload.embed, label) };
  }

  return payload;
}

/** One embed, with the label in the author line above its title. */
function labelOne(embed, label) {
  if (!embed || typeof embed !== 'object') return embed;

  // Already said, and said louder. `titleWithServer()` puts the server at the
  // front of a mutation's title, which renders directly under this line — so
  // adding the author line too would print the server name twice, stacked.
  // The two always agree on the text when it matters: serverDescriptor()
  // prefers the published label and falls back to the alias only when there
  // is no published label, which is the case this function already returned
  // early on.
  const title = typeof embed.title === 'string' ? embed.title.trim() : '';
  if (title === label || title.startsWith(`${label}${SERVER_TITLE_SEPARATOR}`)) return embed;

  // An author the embed set for itself is left alone, and so is one this
  // function already wrote. The senders re-send the same object on a
  // rate-limit retry, and s3-discord.js re-wraps it again for the v12
  // fallback shape; overwriting a caller's author would be a silent loss
  // rather than a decoration.
  if (embed.author && typeof embed.author === 'object' && embed.author.name) return embed;

  return { ...embed, author: { ...(embed.author || {}), name: label } };
}


export default serverLabels;
