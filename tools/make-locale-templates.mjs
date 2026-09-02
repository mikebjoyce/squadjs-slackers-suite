/**
 * ─────────────────────────────────────────────────────────────────
 *  make-locale-templates.mjs — generate translator starter catalogues
 * ─────────────────────────────────────────────────────────────────
 *
 *  Usage:  node tools/make-locale-templates.mjs [--check]
 *
 *  Writes two fill-in-the-blanks catalogues into s3/locale-templates/:
 *
 *    s3-locale-template-players.js  — any player can read it (start here)
 *    s3-locale-template-admins.js   — only your staff read it (next)
 *
 *  There is deliberately no third tier for the server log. Log lines are read
 *  by whoever runs the server, nearly always while something is broken, and
 *  always interleaved with core SquadJS output that stays English regardless.
 *  A half-translated log is harder to read than an English one, and it makes
 *  every bug report depend on the reporter's language. So the log is not
 *  localized at all, and a test fails the build if a localize() result reaches
 *  Logger.*, verbose(), stderrError() or resetStreak().
 *
 *  The tiers are graded by AUDIENCE, not by where the string comes out. A
 *  broadcast and the public Elo leaderboard embed are the same tier: a random
 *  player reads both, and neither of them chose the server's language. An
 *  admin-only RCON reply and a scramble report in the staff channel are also
 *  the same tier as each other, whichever side of the game they surface on —
 *  read by a handful of people who opted into running the thing.
 *
 *  With --check it writes nothing and exits non-zero if the committed
 *  templates are stale. s3/testing/test-i18n.js runs it that way, so a key
 *  added without regenerating fails the build instead of rotting silently.
 *
 *  ─── WHY THIS IS GENERATED ──────────────────────────────────────
 *
 *  A hand-maintained template goes stale the first time anyone adds a key.
 *  More importantly, the tier split CANNOT be read off the key names:
 *  four surfaces mean the opposite of what they sound like.
 *
 *    warn        → in-game AdminWarn popup, NOT a log warning
 *    errors      → almost all routed to verbose(), i.e. logs
 *    teamChange  → log text, despite sounding player-facing
 *    reasons     → fed to resetStreak(), which only Logger.verbose()s it
 *
 *  And audience is not readable off the surface either: switch.warn holds both
 *  the reply any player gets from !switch and the reply only an admin can
 *  provoke, and both arrive as the same AdminWarn popup.
 *
 *  So each key is classified in two passes, both from the call site.
 *
 *  1. LOG OR HUMAN — walk backwards from localize( with bracket matching to
 *     the enclosing callee or object property. Logger.*, verbose() and
 *     stderrError() are logs; warn, broadcast, reply, send and embed props are
 *     read by a person. A log sink is now a defect rather than a tier, so
 *     pass 1 reports it (see logSinkCallSites) and contributes no evidence.
 *
 *  2. WHICH PERSON — for the human ones, ask whether an ordinary player can
 *     reach that line at all, by finding the admin gates the code already
 *     enforces and testing containment:
 *
 *       a whole handler that returns unless chat === 'ChatAdmin'
 *         → team-balancer's entire !teambalancer surface
 *       an enclosing if (isAdminChannel) { … }
 *         → elo's !elo status / reset / backup / restore / roundinfo
 *       an enclosing block holding an if (!isAdmin) { … return; } guard
 *         → switch's per-subcommand admin commands
 *       a handler documented as admin-only in its own header
 *         → switch's Discord side, listed in ADMIN_HANDLERS below
 *
 *     The rejection text inside a guard is the exception that proves it: a
 *     player is the one who trips "you must be an admin", so a call site whose
 *     own innermost block IS the guard goes back to the player tier.
 *
 *  Strings that reach their sink indirectly (pushed to an array, handed to an
 *  embed builder, assigned to a variable first) cannot be resolved by pass 1,
 *  so a surface whose resolvable keys agree lends its verdict to its
 *  unresolved ones.
 *
 *  Anything still unresolved is put in the PLAYER template deliberately. An
 *  over-inclusive player list costs a translator a few needless strings; an
 *  under-inclusive one silently leaves real player text in English.
 * ─────────────────────────────────────────────────────────────────
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(ROOT, 's3', 'locale-templates');

const SKIP_DIRS = ['node_modules', '.git', 'out', 'docs', 'testing', 'tools', 'scratchpad', 'dev-harness'];

// ── source scanning ──────────────────────────────────────────────

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js') && !entry.name.startsWith('s3-locale-')) out.push(p);
  }
  return out;
}

/**
 * Is the `/` at `i` the start of a regex literal rather than a division?
 *
 * It matters because a regex may legally contain a quote or a backtick —
 * s3-commands.js has both — and a scanner that does not know about regexes
 * reads that quote as a string opener and blanks everything up to the next
 * one, swallowing whole functions' worth of braces. That silently flattens
 * the scope chain for every call site after it in the file.
 */
function isRegexStart(src, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  if (j < 0) return true;
  const p = src[j];
  if (p === ')' || p === ']') return false;
  if (/[A-Za-z0-9_$]/.test(p)) {
    // An identifier before `/` means division — unless it is a keyword that
    // can only be followed by an expression.
    const word = (src.slice(Math.max(0, j - 12), j + 1).match(/[A-Za-z_$][\w$]*$/) || [''])[0];
    return ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'instanceof',
      'new', 'delete', 'void', 'yield', 'await'].includes(word);
  }
  return true;
}

/**
 * One length-preserving pass over the source.
 *
 * Comments and regex literals are always blanked. String and template bodies
 * are blanked only when `blankStrings` is set, so both variants agree
 * character-for-character on position: an index taken from one indexes the
 * same character in the other and in the original.
 *
 * Templates are walked recursively rather than scanned for the next backtick,
 * because s3-commands.js nests them — `cols.map((c) => `\`${c}\``)` — and
 * treating the inner opener as the outer closer leaves the rest of the line
 * lexed as code, which drops a brace and collapses the scope chain from there
 * to the end of the file.
 */
function scan(src, blankStrings) {
  const out = src.split('');
  const blank = (k) => { if (k < src.length && src[k] !== '\n') out[k] = ' '; };

  function lineComment(i) {
    while (i < src.length && src[i] !== '\n') { blank(i); i++; }
    return i;
  }

  function blockComment(i) {
    blank(i); blank(i + 1); i += 2;
    while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i++; }
    if (i < src.length) { blank(i); blank(i + 1); i += 2; }
    return i;
  }

  function regex(i) {
    blank(i); i++;
    let inClass = false;
    while (i < src.length && src[i] !== '\n') {          // unterminated: bail
      if (src[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      const c = src[i];
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { blank(i); i++; break; }
      blank(i); i++;
    }
    return i;
  }

  function quoted(i) {
    const q = src[i];
    if (blankStrings) blank(i);
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') { if (blankStrings) { blank(i); blank(i + 1); } i += 2; continue; }
      if (blankStrings) blank(i);
      i++;
    }
    if (blankStrings) blank(i);
    return i + 1;
  }

  function template(i) {
    if (blankStrings) blank(i);
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { if (blankStrings) { blank(i); blank(i + 1); } i += 2; continue; }
      if (c === '`') { if (blankStrings) blank(i); return i + 1; }
      if (c === '$' && src[i + 1] === '{') {
        // An interpolation holds code, so it is scanned as code — nested
        // templates and all — and blanked to keep the braces balanced.
        if (blankStrings) { blank(i); blank(i + 1); }
        i += 2;
        let depth = 1;
        while (i < src.length && depth > 0) {
          const d = src[i];
          if (d === '{') depth++;
          else if (d === '}') depth--;
          else if (d === '`') { i = template(i); continue; }
          else if (d === "'" || d === '"') { i = quoted(i); continue; }
          else if (d === '/' && src[i + 1] === '/') { i = lineComment(i); continue; }
          else if (d === '/' && src[i + 1] === '*') { i = blockComment(i); continue; }
          else if (d === '/' && isRegexStart(src, i)) { i = regex(i); continue; }
          if (blankStrings) blank(i);
          i++;
        }
        continue;
      }
      if (blankStrings) blank(i);
      i++;
    }
    return i;
  }

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = lineComment(i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = blockComment(i); continue; }
    if (c === '/' && isRegexStart(src, i)) { i = regex(i); continue; }
    if (c === '`') { i = template(i); continue; }
    if (c === "'" || c === '"') { i = quoted(i); continue; }
    i++;
  }
  return out.join('');
}

/** Comments, regexes and string bodies blanked — safe for bracket arithmetic. */
const mask = (src) => scan(src, true);

/**
 * Comments and regexes blanked, string bodies kept, so a regex can still see a
 * literal like 'ChatAdmin' that mask() would have erased.
 */
const maskComments = (src) => scan(src, false);

/** Walks back from a localize( call to the construct that consumes its result. */
function enclosing(masked, src, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = masked[i];
    if (c === ')' || c === ']' || c === '}') { depth++; continue; }
    if (c === '(' || c === '[') {
      if (depth > 0) { depth--; continue; }
      if (c === '[') return null;
      const before = src.slice(Math.max(0, i - 60), i);
      const m = before.match(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/);
      return m ? { kind: 'call', name: m[1].replace(/\s+/g, '') } : null;
    }
    if (c === '{') {
      if (depth > 0) { depth--; continue; }
      return null;
    }
    if (c === ':' && depth === 0) {
      const before = src.slice(Math.max(0, i - 40), i);
      const m = before.match(/([A-Za-z_$][\w$]*)\s*$/);
      return m ? { kind: 'prop', name: m[1] } : null;
    }
  }
  return null;
}

const EMBED_PROP = /^(?:title|description|value|name|footer|text|label|content|author)$/;

/**
 * Pass 1: where does this string come out? Log or human, and for the humans,
 * in game or in Discord — pass 2 needs that distinction because some Discord
 * channels are staff channels and no in-game surface is.
 * @returns {'log'|'ingame'|'discord'|null} null means "no direct evidence".
 */
function sinkOf(node) {
  if (!node) return null;
  if (node.kind === 'prop') return EMBED_PROP.test(node.name) ? 'discord' : null;

  const n = node.name;
  // Logger.warn is a log; this.warn is an in-game popup. Receiver decides.
  if (/^Logger\./.test(n)) return 'log';
  if (/(?:^|\.)(?:verbose|stderrError|resetStreak)$/.test(n)) return 'log';
  if (/(?:^|\.)(?:warn|broadcast|adminBroadcast)$/.test(n)) return 'ingame';
  if (/(?:^|\.)(?:reply|safeDiscordReply|send|sendDiscordMessage)$/.test(n)) return 'discord';
  if (/[Ee]mbed/.test(n)) return 'discord';
  return null;
}

// ── pass 2: can an ordinary player reach this line? ──────────────

/** A block header that is only entered in an admin context. */
const ADMIN_BLOCK = /\b(?:isAdminChannel|hasAdminRole)\b/;

/**
 * An early-return guard that makes the REST of its own block admin-only:
 * either the per-subcommand !isAdmin check or a handler that drops anything
 * that did not arrive on admin chat.
 */
const ADMIN_GUARD = /if\s*\(\s*!\s*isAdmin\b|chat\s*!==\s*['"]ChatAdmin['"]/;

/**
 * Surfaces that are admin-only by deployment rather than by a code gate — the
 * plugin is bound to one channel and that channel is staff. `fn` narrows the
 * entry to one function in the file, because a file can hold both audiences:
 * switch-commands.js has the player chat handler and the admin Discord handler
 * side by side. `marker` is the line in the file that states the policy, and
 * it is asserted to still be there, so a rewrite that changes it fails here
 * instead of silently reclassifying a hundred strings.
 */
const ADMIN_HANDLERS = [
  {
    file: 'switch/utils/switch-commands.js',
    fn: 'onDiscordMessage',
    marker: 'onDiscordMessage handles Discord !switch admin commands.'
  },
  {
    file: 'team-balancer/utils/tb-discord-helpers.js',
    fn: '*',
    marker: 'goes to the TeamBalancer channel, which is a staff'
  }
];

/**
 * Plugins whose Discord channel is a staff channel, so a Discord sink anywhere
 * in them is admin-facing with no gate in sight — TeamBalancer posts scramble
 * plans and diagnostics, Switch posts admin command replies and the explain
 * report. EloTracker is deliberately absent: its channel is where players run
 * !elo stats and read the leaderboard, and only the isAdminChannel block
 * inside it is staff-only, which the gate walk already finds.
 *
 * This says nothing about the in-game side. A broadcast is a broadcast.
 */
const STAFF_DISCORD = ['team-balancer/', 'switch/', 's3/'];

/** Byte ranges of every brace block enclosing `at`, innermost first. */
function enclosingBlocks(masked, at) {
  const blocks = [];
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const c = masked[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth > 0) { depth--; continue; }
      blocks.push(i);
    }
  }
  return blocks;
}

/** Forward-matches the `{` at `open`, returning the index just past its `}`. */
function blockEnd(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}' && --depth === 0) return i + 1;
  }
  return masked.length;
}

/**
 * True when the guard appears as a statement of this block itself rather than
 * buried in a nested one. The distinction is the whole point: switch's chat
 * handler contains a dozen !isAdmin guards, one per admin subcommand, and none
 * of them says anything about the player subcommands sitting beside them.
 *
 * Most of those cases are unbraced, so `case 'refresh'` and `case 'matchend'`
 * share one enclosing block and a brace walk cannot tell them apart. A case
 * label is treated as a scope boundary here for exactly that reason: the scan
 * is clipped to the case containing `at`, and a guard belonging to a sibling
 * case is ignored. When the block has no case labels the whole body is scanned.
 */
function guardAtTopLevel(text, masked, open, end, at) {
  const labels = [];
  let depth = 0;
  const tops = [];
  for (let i = open; i < end; i++) {
    const c = masked[i];
    if (c === '{') { depth++; continue; }
    if (c === '}') { depth--; continue; }
    if (depth !== 1) continue;
    if (c === 'c' || c === 'd') {
      if (/^(?:case\s|default\s*:)/.test(text.slice(i, i + 10)) && !/[\w$.]/.test(text[i - 1] || ' ')) {
        labels.push(i);
        continue;
      }
    }
    if (c !== 'i' && c !== 'c') continue;      // cheap prefilter: if / chat
    // Braces come from masked, the guard itself from text: 'ChatAdmin' is a
    // string literal, and mask() blanks those.
    if (ADMIN_GUARD.test(text.slice(i, i + 60))) tops.push(i);
  }
  if (!tops.length) return false;
  if (!labels.length) return true;

  const from = labels.filter((p) => p <= at).pop() ?? open;
  const to = labels.find((p) => p > at) ?? end;
  return tops.some((p) => p >= from && p < to);
}

/**
 * Pass 2. True when only an admin can make this line run.
 *
 * @param {string} rel   repo-relative path, for the ADMIN_HANDLERS list
 * @param {string} src   original source
 * @param {string} text  comments blanked, string literals kept
 * @param {string} masked  comments and string bodies blanked
 * @param {number} at    index of the localize( call
 */
function adminOnly(rel, src, text, masked, at) {
  const blocks = enclosingBlocks(masked, at);
  const headerOf = (open) => {
    const lineStart = masked.lastIndexOf('\n', open) + 1;
    return text.slice(Math.max(0, lineStart - 200), open);
  };

  for (const entry of ADMIN_HANDLERS) {
    if (rel !== entry.file) continue;
    if (!src.includes(entry.marker)) {
      throw new Error(`ADMIN_HANDLERS marker gone from ${entry.file}: "${entry.marker}"`);
    }
    if (entry.fn === '*') return true;
    if (blocks.some((open) => new RegExp(`\\b${entry.fn}\\b`).test(headerOf(open)))) return true;
  }

  for (let d = 0; d < blocks.length; d++) {
    const open = blocks[d];
    const header = headerOf(open);

    // The innermost block being the guard itself means this is the rejection
    // a non-admin gets — player text, not admin text.
    if (d === 0 && ADMIN_GUARD.test(header)) return false;

    if (ADMIN_BLOCK.test(header)) return true;
    if (guardAtTopLevel(text, masked, open, blockEnd(masked, open), at)) return true;
  }
  return false;
}

// ── classification ───────────────────────────────────────────────

const flatten = (obj, prefix = [], acc = new Map()) => {
  for (const [k, v] of Object.entries(obj)) {
    const p = [...prefix, k];
    if (v && typeof v === 'object') flatten(v, p, acc);
    else acc.set(p.join('.'), v);
  }
  return acc;
};

// Most-read first. Ties break toward the earlier tier, so a string two
// different callers reach is translated by whoever is doing the more urgent
// one — a string a player can reach anywhere is a player string everywhere.
const TIERS = ['players', 'admins'];

const surfaceOf = (key) => {
  const parts = key.split('.');
  return parts.length > 2 ? parts[1] : '(root)';
};

/**
 * Every localize() call whose result goes straight into the server log.
 *
 * There is no log tier: the log is English, always, so that it reads the same
 * in a bug report as it does on the machine that produced it, and so that it
 * does not alternate languages line by line with core SquadJS's own output.
 * This is what the i18n suite asserts is empty.
 *
 * Only DIRECT sinks are visible here. A string assigned to a variable and
 * interpolated into a Logger.verbose() later cannot be caught this way — the
 * catalogue holding no `verbose` surface at all is the backstop for those.
 *
 * @returns {Array<{rel: string, key: string, line: number, sink: string}>}
 */
export function logSinkCallSites() {
  const found = [];
  for (const file of walk(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('localize(')) continue;
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const masked = mask(src);
    const re = /\blocalize\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const node = enclosing(masked, src, m.index);
      if (sinkOf(node) !== 'log') continue;
      found.push({
        rel,
        key: m[1],
        line: src.slice(0, m.index).split('\n').length,
        sink: node.name
      });
    }
  }
  return found;
}

export async function classifyKeys() {
  const { MESSAGES } = await import(pathToFileURL(path.join(ROOT, 's3/utils/s3-locale-en.js')).href);
  const english = flatten(MESSAGES);

  // Direct sink evidence per key.
  const direct = new Map();
  for (const file of walk(ROOT)) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('localize(')) continue;
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const masked = mask(src);
    const text = maskComments(src);
    const staff = sink => sink === 'discord' && STAFF_DISCORD.some((d) => rel.startsWith(d));
    const re = /\blocalize\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const sink = sinkOf(enclosing(masked, src, m.index));
      // A log sink is a defect, not a tier — logSinkCallSites() reports it and
      // the test suite fails on it. Here it simply contributes no evidence,
      // which leaves the key to its surface or to the player default.
      if (!sink || sink === 'log') continue;
      const tier = staff(sink) || adminOnly(rel, src, text, masked, m.index) ? 'admins' : 'players';
      if (!direct.has(m[1])) direct.set(m[1], new Set());
      direct.get(m[1]).add(tier);
    }
  }

  // Surface-level verdict, from the keys that did resolve.
  const tally = new Map();
  for (const key of english.keys()) {
    const s = surfaceOf(key);
    if (!tally.has(s)) tally.set(s, { players: 0, admins: 0, logs: 0 });
    const seen = direct.get(key);
    if (!seen) continue;
    for (const tier of TIERS) if (seen.has(tier)) tally.get(s)[tier]++;
  }

  const result = new Map();
  const stats = { direct: 0, bySurface: 0, defaulted: 0 };
  for (const key of english.keys()) {
    const seen = direct.get(key);
    if (seen) {
      // A key reaching several sinks lands in the most-read tier — the
      // stricter need. A broadcast mirrored into Discord is still a broadcast.
      result.set(key, TIERS.find((t) => seen.has(t)));
      stats.direct++;
      continue;
    }
    const t = tally.get(surfaceOf(key));
    if (t && (t.players || t.admins || t.logs)) {
      result.set(key, TIERS.reduce((best, tier) => (t[tier] > t[best] ? tier : best), TIERS[0]));
      stats.bySurface++;
      continue;
    }
    result.set(key, 'players'); // fail toward over-inclusion
    stats.defaulted++;
  }
  return { english, buckets: result, stats, tally };
}

// ── emitting ─────────────────────────────────────────────────────

const nest = (pairs) => {
  const root = {};
  for (const [key, value] of pairs) {
    const segs = key.split('.');
    let cur = root;
    for (const s of segs.slice(0, -1)) cur = (cur[s] ??= {});
    cur[segs.at(-1)] = value;
  }
  return root;
};

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function render(node, indent = 2) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(node)) {
    const safeKey = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${esc(k)}'`;
    if (v && typeof v === 'object' && !Array.isArray(v) && !('__en' in v)) {
      lines.push(`${pad}${safeKey}: {`);
      lines.push(render(v, indent + 2));
      lines.push(`${pad}},`);
    } else {
      lines.push(`${pad}// EN: ${v.__en.replace(/\n/g, '\\n')}`);
      lines.push(`${pad}${safeKey}: '',`);
    }
  }
  return lines.join('\n');
}

const NOTES = {
  players: (c) => ` *  ─── THIS IS THE ONE THAT MATTERS ───────────────────────────────
 *
 *  Every string here can be read by any player, whether or not they asked to
 *  be: broadcasts the whole server sees at once, AdminWarn popups a single
 *  player reads mid-round, and the public Discord replies anyone in the
 *  channel gets from !elo stats or the leaderboard. ${c.players} strings —
 *  the smallest tier, and the only one where an untranslated string lands in
 *  front of someone who never chose the server's language.
 *
 *  Register matters. A broadcast interrupts everyone, so keep it short and
 *  plain; an AdminWarn popup is read once, mid-firefight, and should be
 *  shorter still. The Discord ones have room to breathe, and **bold** and
 *  \`code\` markup in them is real formatting — keep it, and keep the emoji.`,

  admins: (c) => ` *  ─── WORTH DOING, AFTER THE PLAYER TIER ─────────────────────────
 *
 *  Strings only your staff can reach: replies to admin-gated commands, the
 *  scramble and diagnostic reports in your staff channel, and the admin half
 *  of !elo. ${c.admins} strings — the bulk of what an admin reads day to day,
 *  but read by a handful of people who opted into running the thing, so a
 *  missed one costs far less than a missed broadcast.
 *
 *  Most of these render in Discord, so **bold** and \`code\` markup in the
 *  English is real formatting: keep it, and keep the emoji, which act as
 *  icons. The in-game ones are AdminWarn popups and have a hard length limit.`,

  logs: () => ` *  ─── OPTIONAL ───────────────────────────────────────────────────
 *
 *  These strings only ever reach the server log. Many operators would rather
 *  read them in English — an English log line is easier to search for and to
 *  paste into a bug report — so leaving this file untranslated is a perfectly
 *  good choice, and the default one. Translate it only if the people running
 *  your servers would rather read their logs in their own language.`
};

const TITLES = {
  players: 'PLAYER-FACING',
  admins: 'ADMIN-FACING'
};

function template(kind, pairs, counts) {
  const tree = nest(pairs.map(([k, v]) => [k, { __en: v }]));
  return `/**
 * ─────────────────────────────────────────────────────────────────
 *  ${TITLES[kind]} TRANSLATION TEMPLATE — ${pairs.length} strings
 * ─────────────────────────────────────────────────────────────────
 *
 *  GENERATED FILE — do not edit in place.
 *  Regenerate with:  node tools/make-locale-templates.mjs
 *
 *  ─── HOW TO USE ─────────────────────────────────────────────────
 *
 *  1. Copy this file to  s3/utils/s3-locale-<code>.js  (e.g. s3-locale-de.js).
 *  2. Fill in the '' values. The English original is on the line above each.
 *  3. Delete any line you do not translate — or leave it '', which falls back
 *     to English just the same. Both are safe; neither renders blank.
 *  4. Keep every {placeholder} exactly as it appears in the English.
 *  5. List machine-translated keys in UNVERIFIED at the bottom.
 *  6. Register the catalogue in s3/utils/s3-i18n.js (one import, one entry).
 *
 *  ─── ADDING A SECOND TIER LATER ─────────────────────────────────
 *
 *  All three templates fill the SAME s3-locale-<code>.js. They are disjoint
 *  slices of one key tree, but several branches (teamBalancer, switch) appear
 *  in more than one tier — so pasting a second template into the same object
 *  literal would silently drop the first copy of that branch, with no error
 *  and no clue beyond a tier quietly falling back to English. Merge instead:
 *
 *    import mergeMessages from './s3-locale-merge.js';
 *
 *    export const MESSAGES = mergeMessages(
 *      { ...paste this template's object here... },
 *      { ...paste the next template's object here... }
 *    );
 *
 *  One tier on its own needs none of that — keep the plain export below.
 *
 *  See s3/LOCALIZATION.md for the full contribution guide.
 *
${NOTES[kind](counts)}
 * ─────────────────────────────────────────────────────────────────
 */

export const MESSAGES = {
${render(tree)}
};

// Key paths whose translation was machine-written and has NOT been reviewed by
// a fluent speaker. Add a key here in the same commit that adds an unreviewed
// string; delete it once someone who reads the language has checked it. An
// empty array means this catalogue is fully reviewed.
export const UNVERIFIED = [];
`;
}

// ── main ─────────────────────────────────────────────────────────

const FILES = {
  players: 's3-locale-template-players.js',
  admins: 's3-locale-template-admins.js'
};

export async function build() {
  const { english, buckets, stats, tally } = await classifyKeys();
  const tiers = Object.fromEntries(TIERS.map((t) => [t, []]));
  for (const [key, value] of english) tiers[buckets.get(key)].push([key, value]);

  const counts = Object.fromEntries(TIERS.map((t) => [t, tiers[t].length]));
  return {
    stats,
    tally,
    counts,
    files: Object.fromEntries(TIERS.map((t) => [FILES[t], template(t, tiers[t], counts)]))
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { files, stats, counts } = await build();
  const check = process.argv.includes('--check');
  let stale = [];

  if (!check) fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(OUT_DIR, name);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === content) continue;
    if (check) stale.push(name);
    else fs.writeFileSync(target, content);
  }

  if (check) {
    if (stale.length) {
      console.error(`Locale templates are stale: ${stale.join(', ')}`);
      console.error('Regenerate with: node tools/make-locale-templates.mjs');
      process.exit(1);
    }
    console.log(`Locale templates are current (${TIERS.map((t) => `${t} ${counts[t]}`).join(', ')}).`);
  } else {
    console.log(`Wrote ${Object.keys(files).length} templates to s3/locale-templates/`);
    console.log(`  ${TIERS.map((t) => `${t}: ${counts[t]}`).join('   ')}`);
    console.log(`  classified: ${stats.direct} by call site, ${stats.bySurface} by surface, ${stats.defaulted} defaulted to player-facing`);
  }
}
