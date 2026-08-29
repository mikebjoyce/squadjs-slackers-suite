/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   DOC-TABLE PARSER — SHARED OPTION-ACCURACY PRIMITIVES        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * s3/testing/test-developer-guide-accuracy.js proved the pattern: parse an
 * optionsSpecification block out of a plugin's source, parse the matching
 * option table(s) out of its README/guide, and diff the two. That pattern
 * caught a real incident (2026-08-20 — a documented default that was the
 * exact opposite of the shipped one) and, on 2026-08-28, would have caught
 * smart-assign's SAEventLogger default-mismatch bug a step earlier if it
 * had existed there at the time.
 *
 * Every plugin that ships an optionsSpecification wants this same check.
 * Reimplementing the regexes per plugin is how they'd drift from each
 * other the same way the docs they check drift from the code. This module
 * is the one implementation; each plugin's own test file supplies only
 * what's actually plugin-specific (which source file, which doc file,
 * which section headings if a doc has more than one option table).
 *
 * ─── WHAT THIS DOES NOT COVER ────────────────────────────────────
 *
 * Only option name/default pairs. s3's own accuracy test also checks its
 * Discord command table and test-file catalog against source — those are
 * s3-specific (only s3 has a command dispatcher) and stay hand-written in
 * that file rather than folded in here. s3's own option-table check
 * predates this module and was already green with its own section-scoped
 * parser; it has not been rewired onto this one, to avoid touching a
 * working, previously-audited test for a refactor with no behavioural
 * upside. New option-accuracy tests (smart-assign, team-balancer, and any
 * future plugin) should build on this module rather than copy s3's inline
 * regexes.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   import { parseOptionDefaultsFromSource, parseMarkdownOptionTables, normaliseDefault }
 *     from '../../s3/testing/doc-table-parser.js';
 *
 *   const declared   = parseOptionDefaultsFromSource(pluginSourceText);
 *   const documented = parseMarkdownOptionTables(readmeText);
 *   // documented merges every table in the doc whose header names an
 *   // "Option" column and a "Default" column — a plugin is free to split
 *   // its options across more than one table (smart-assign's Switch
 *   // Handshake table is separate from its main Configuration Options
 *   // table) without the parser needing to know that in advance.
 */

/**
 * Option name → default literal (as written in source, unparsed), read from
 * a `static get optionsSpecification() { return { ... } }` block.
 *
 * The option-name level is nominally a six-space indent, but hand-edited
 * option blocks drift (team-balancer.js has entries at 7 and 8 spaces from
 * inconsistent formatting over time) — so by default this matches any
 * indent from 4 to 10 spaces rather than demanding an exact one. There is
 * no nested `key: {` inside a single option's own body at that depth in any
 * plugin checked so far (an option's sub-fields — `default`, `type`,
 * `description`, `validate` — don't themselves open another `{` at this
 * indent range), so the range is safe; pass `indent` explicitly only if a
 * future plugin's formatting makes that assumption wrong.
 */
export function parseOptionDefaultsFromSource(sourceText, { indent = null } = {}) {
  const start = sourceText.indexOf('static get optionsSpecification()');
  if (start === -1) {
    throw new Error('Could not locate optionsSpecification in source');
  }
  // Stop at the constructor, which follows the spec block in every plugin here.
  const end = sourceText.indexOf('constructor(', start);
  const block = end === -1 ? sourceText.slice(start) : sourceText.slice(start, end);

  const defaults = new Map();
  const optionRe = indent != null
    ? new RegExp(`^ {${indent}}([a-zA-Z][a-zA-Z0-9_]*): \\{$`, 'gm')
    : /^ {4,10}([a-zA-Z][a-zA-Z0-9_]*): \{$/gm;
  let m;
  while ((m = optionRe.exec(block)) !== null) {
    const name = m[1];
    const rest = block.slice(m.index);
    const defMatch = /^\s*default: (.+?),?$/m.exec(rest);
    if (defMatch) defaults.set(name, defMatch[1].trim().replace(/,$/, ''));
  }
  return defaults;
}

/**
 * Option name → documented default string, merged across every markdown
 * pipe-table in the document whose header row names both an "Option" and a
 * "Default" column (case-insensitive, in any position — this repo's plugins
 * don't agree on column order). Tables with a different shape (a settings
 * comparison table, a population-cap table) are skipped because their
 * headers don't match.
 */
export function parseMarkdownOptionTables(mdText) {
  const lines = mdText.split('\n');
  const out = new Map();

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i].trim();
    if (!header.startsWith('|')) continue;
    const cells = header.split('|').map((c) => c.trim().toLowerCase()).filter((c, idx, arr) =>
      // Keep interior cells only — a leading/trailing empty string comes from
      // the outer pipes ("| a | b |".split('|') === ["", " a ", " b ", ""]).
      !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === '')
    );
    const optionCol = cells.indexOf('option');
    const defaultCol = cells.indexOf('default');
    if (optionCol === -1 || defaultCol === -1) continue;

    // Next line must be the "|---|---|" separator, or this isn't a table header.
    const sep = (lines[i + 1] || '').trim();
    if (!/^\|[\s:-]+\|/.test(sep)) continue;

    for (let j = i + 2; j < lines.length; j++) {
      const row = lines[j];
      if (!row.trim().startsWith('|')) break; // table ended
      const rowCells = row.split('|').map((c) => c.trim()).filter((c, idx, arr) =>
        !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === '')
      );
      const rawName = rowCells[optionCol];
      const rawDefault = rowCells[defaultCol];
      if (!rawName) continue;
      const name = rawName.replace(/`/g, '').trim();
      const value = (rawDefault || '').replace(/`/g, '').trim();
      if (name) out.set(name, value);
    }
  }

  return out;
}

/**
 * Compare a documented default against the source literal. The two
 * spellings legitimately differ — the source says `["r", "-r"]` and the
 * guide may say `["r", "-r"]` or `['r', '-r']` — so normalise quotes and
 * whitespace rather than demanding a byte match. Anything that still
 * differs after that is a real disagreement about the value.
 */
export function normaliseDefault(v) {
  return String(v).replace(/['"]/g, '').replace(/\s+/g, '').toLowerCase();
}
