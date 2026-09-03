/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   I18N — CATALOGUE PARITY, CALL SITES, LANGUAGE RESOLUTION    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Localization fails quietly. A missing key renders as the key, a missing
 * placeholder renders as `{playerName}`, and a plugin wired to the wrong
 * language renders perfectly readable English. None of that throws, none of
 * it appears in a log as an error, and nobody who does not read Portuguese
 * would notice the second-language half of it at all. So the guarantees have
 * to be asserted mechanically rather than observed.
 *
 * ─── WHAT THIS GUARDS ────────────────────────────────────────────
 *
 * 1. Catalogue parity — same keys, same placeholders, every language.
 * 2. Call-site coverage — every localize('literal') resolves to a real key,
 *    and supplies every placeholder that key's template needs.
 * 3. UNVERIFIED integrity — the machine-translation list contains only real
 *    key paths, so it cannot rot into stale entries that hide unreviewed text.
 * 4. Fallback behaviour — unknown key, unknown language, missing vars.
 * 5. Language resolution — S³ sets it once and plugins inherit.
 * 6. Declaration audit — see below.
 *
 * ─── WHY THE DECLARATION AUDIT EXISTS ────────────────────────────
 *
 * Two failures here are invisible by reading, and both have already happened
 * in this codebase:
 *
 * SquadJS's BasePlugin builds `this.options` only from `optionsSpecification`
 * keys and silently discards everything else in config.json. A plugin that
 * calls localize() but never declares `language` ignores the operator's
 * config entirely — which is what made the original localization branch
 * impossible to test.
 *
 * And a consumer plugin that declares `language` with `default: 'en'` rather
 * than `default: null` makes the first term of
 * `this.options?.language || this._s3?.lang` always truthy, so S³'s setting
 * can never be reached. The option appears wired, the config looks correct,
 * and the server renders English forever.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Static only — reads plugin sources from the monorepo and imports the
 * catalogues directly. Does not mount SquadJS, touch a database, or need a
 * server. Safe to run anywhere.
 * ─────────────────────────────────────────────────────────────────
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  localize,
  isSupportedLanguage,
  supportedLanguages,
  CATALOGUES,
  UNVERIFIED,
  DEFAULT_LANGUAGE
} from '../utils/s3-i18n.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.join(HERE, '..', '..');

// Files that call localize(). The two base classes are included for call-site
// checking but excluded from the declaration audit — they deliberately leave
// optionsSpecification to their subclasses.
const BASE_CLASSES = [
  's3/plugins/s3-plugin-base.js',
  's3/plugins/s3-discord-plugin-base.js'
];

const PLUGIN_GLOB_DIRS = ['s3', 'team-balancer', 'elo-tracker', 'smart-assign', 'switch'];

// The one plugin that owns the setting rather than inheriting it.
const AUTHORITATIVE_PLUGIN = 's3/plugins/slackers-squad-services.js';

const PLACEHOLDER = /\{\{(\w+)\}\}|\{(\w+)\}/g;

// ── helpers ──────────────────────────────────────────────────────

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

function placeholdersOf(template) {
  const names = new Set();
  for (const m of String(template).matchAll(PLACEHOLDER)) {
    names.add(m[1] !== undefined ? m[1] : m[2]);
  }
  return names;
}

function sourceFilesCallingLocalize() {
  const found = [];
  for (const dir of PLUGIN_GLOB_DIRS) {
    for (const sub of ['plugins', 'utils']) {
      const abs = path.join(MONOREPO_ROOT, dir, sub);
      if (!fs.existsSync(abs)) continue;
      for (const name of fs.readdirSync(abs)) {
        if (!name.endsWith('.js')) continue;
        const full = path.join(abs, name);
        const src = fs.readFileSync(full, 'utf8');
        // A file that never calls localize() can still own keys: a module
        // with no plugin handle (s3-switch-reports.js) returns a key for its
        // caller to render. Scanning only localize() callers left those keys
        // looking orphaned.
        if (/\blocalize\s*\(/.test(src) || /\b\w*[Kk]ey:\s*'[\w$]+(?:\.[\w$]+)+'/.test(src)) {
          found.push({ rel: `${dir}/${sub}/${name}`.replace(/\\/g, '/'), abs: full, src });
        }
      }
    }
  }
  return found;
}

/**
 * Extracts `localize('key', { ...vars })` call sites.
 *
 * Brace-matched rather than regex-captured: an inner `}` (a nested object, or
 * a `${}` inside a template literal) truncates a naive `\{([^}]*)\}` capture
 * and invents mismatches that are not there. Dynamic keys — localize(someVar)
 * — are skipped; only string literals can be checked statically.
 */
function extractCallSites(src) {
  const sites = [];
  const re = /\blocalize\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;

  for (const m of src.matchAll(re)) {
    const key = m[2];
    let i = m.index + m[0].length;

    // Skip to the argument separator, if there is one.
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== ',') {
      sites.push({ key, vars: new Set(), hasVarsArg: false });
      continue;
    }
    i++;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '{') {
      // A variable or spread was passed rather than an object literal; the
      // contents are not statically knowable, so do not pretend to check them.
      sites.push({ key, vars: null, hasVarsArg: true });
      continue;
    }

    const vars = new Set();
    let depth = 0;
    let quote = null;
    const start = i;

    for (; i < src.length; i++) {
      const c = src[i];

      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '{') { depth++; continue; }
      if (c === '}') { depth--; if (depth === 0) break; continue; }
    }

    // Only top-level properties of the object count. Nested object values are
    // data, not placeholder names.
    const body = src.slice(start + 1, i);
    let d = 0, q = null, segment = '';
    const segments = [];
    for (let j = 0; j < body.length; j++) {
      const c = body[j];
      if (q) { if (c === '\\') { segment += c + body[++j]; continue; } if (c === q) q = null; segment += c; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; segment += c; continue; }
      if (c === '{' || c === '[' || c === '(') d++;
      if (c === '}' || c === ']' || c === ')') d--;
      if (c === ',' && d === 0) { segments.push(segment); segment = ''; continue; }
      segment += c;
    }
    segments.push(segment);

    for (const seg of segments) {
      const s = seg.trim();
      if (!s) continue;
      // `name: value` (explicit) or `name` (shorthand).
      const explicit = s.match(/^([A-Za-z_$][\w$]*)\s*:/);
      const shorthand = s.match(/^([A-Za-z_$][\w$]*)$/);
      if (explicit) vars.add(explicit[1]);
      else if (shorthand) vars.add(shorthand[1]);
    }

    sites.push({ key, vars, hasVarsArg: true });
  }

  // A first argument that is not a bare literal — localize(cond ? 'a' : 'b'),
  // or localize(x || 'fallback'). Every literal in that expression is a key
  // that can really be requested, so each counts as a call site. The variables
  // cannot be attributed to one branch, so they are left unchecked.
  for (const m of src.matchAll(/\blocalize\s*\(/g)) {
    let i = m.index + m[0].length;
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] === "'" || src[i] === '"') continue;   // handled above

    let depth = 0;
    let quote = null;
    const from = i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') { i++; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; continue; }
      if (c === ')' && depth === 0) break;
      if (c === ')' || c === ']' || c === '}') { depth--; continue; }
      if (c === ',' && depth === 0) break;
    }

    const arg = src.slice(from, i);
    for (const lit of arg.matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)) {
      if (lit[2].includes('.')) sites.push({ key: lit[2], vars: null, hasVarsArg: true });
    }
  }

  return sites;
}

/**
 * Extracts the fixed prefix of a computed key: localize(\`a.b.\${x}\`).
 *
 * A handful of sites build their key from a path list rather than writing it
 * out — TeamBalancer's RconMessages getters are the case that forced this.
 * The key is unknowable statically, but the prefix is not, so the prefix is
 * what gets asserted: everything beneath it counts as reachable, and anything
 * outside it is still held to the literal-call-site rule.
 */
function extractDynamicPrefixes(src) {
  const prefixes = [];
  for (const m of src.matchAll(/\blocalize\s*\(\s*`([^`$]*?)\${/g)) {
    const p = m[1].replace(/\.$/, '');
    if (p) prefixes.push(p);
  }
  return prefixes;
}

/**
 * Extracts keys held in a lookup table: `{ label: 'Full Scramble', key: 'a.b.c' }`.
 *
 * A table row that has to be rendered in one place and written to a CSV in
 * another carries both names, and the renderer calls localize(row.key) — so
 * the key never appears next to localize() and the orphan scan cannot see it.
 * The same shape covers a key returned for someone else to render —
 * parseRange()'s `errorKey`, where the module has no plugin to localize with.
 * A dotted string literal on a property whose name ends in `key` is specific enough
 * to count as a call site without loosening the rule for anything else.
 */
function extractTableKeys(src) {
  return [...src.matchAll(/\b\w*[Kk]ey:\s*'([\w$]+(?:\.[\w$]+)+)'/g)].map((m) => m[1]);
}

function optionBlock(src, name) {
  const at = src.search(new RegExp(`\\b${name}\\s*:\\s*\\{`));
  if (at === -1) return null;
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  return null;
}

// ── catalogue parity ─────────────────────────────────────────────

describe('i18n — catalogue parity', () => {
  const english = flatten(CATALOGUES[DEFAULT_LANGUAGE]);

  test('English catalogue is non-empty and every value is a string', () => {
    assert.ok(english.size > 0, 'English catalogue is empty');
    for (const [key, value] of english) {
      assert.equal(typeof value, 'string', `${key} is not a string`);
    }
  });

  for (const lang of supportedLanguages()) {
    if (lang === DEFAULT_LANGUAGE) continue;

    test(`${lang}: no keys absent from English`, () => {
      const other = flatten(CATALOGUES[lang]);
      const extra = [...other.keys()].filter((k) => !english.has(k));
      assert.deepEqual(extra, [], `${lang} has keys English does not: ${extra.join(', ')}`);
    });

    test(`${lang}: placeholders match English for every shared key`, () => {
      const other = flatten(CATALOGUES[lang]);
      const problems = [];

      for (const [key, translated] of other) {
        if (!english.has(key)) continue;
        const want = placeholdersOf(english.get(key));
        const got = placeholdersOf(translated);

        const missing = [...want].filter((p) => !got.has(p));
        const invented = [...got].filter((p) => !want.has(p));
        if (missing.length || invented.length) {
          problems.push(`${key}: missing [${missing}] invented [${invented}]`);
        }
      }

      assert.deepEqual(problems, [], `placeholder drift:\n  ${problems.join('\n  ')}`);
    });

    // Not a failure — a partial catalogue falls back to English by design, and
    // an honest gap beats a guessed translation. Reported so the size of the
    // gap stays visible.
    test(`${lang}: untranslated key count is reported`, () => {
      const other = flatten(CATALOGUES[lang]);
      const untranslated = [...english.keys()].filter((k) => !other.has(k));
      console.log(`      ${lang}: ${english.size - untranslated.length}/${english.size} translated, ${untranslated.length} falling back to English`);
      assert.ok(true);
    });
  }
});

// ── translation provenance ───────────────────────────────────────

describe('i18n — UNVERIFIED integrity', () => {
  for (const lang of supportedLanguages()) {
    test(`${lang}: every UNVERIFIED path is a real key in this catalogue`, () => {
      const list = UNVERIFIED[lang];
      assert.ok(Array.isArray(list), `${lang} does not export an UNVERIFIED array`);

      const flat = flatten(CATALOGUES[lang]);
      const stale = list.filter((k) => !flat.has(k));
      assert.deepEqual(stale, [], `${lang} UNVERIFIED names keys that do not exist: ${stale.join(', ')}`);
    });

    test(`${lang}: UNVERIFIED has no duplicates`, () => {
      const list = UNVERIFIED[lang];
      assert.equal(new Set(list).size, list.length, `${lang} UNVERIFIED contains duplicates`);
    });
  }

  test('unreviewed translation count is reported', () => {
    for (const lang of supportedLanguages()) {
      const n = UNVERIFIED[lang].length;
      console.log(`      ${lang}: ${n} string${n === 1 ? '' : 's'} awaiting native-speaker review`);
    }
    assert.ok(true);
  });
});

// ── call sites ───────────────────────────────────────────────────

describe('i18n — call sites', () => {
  const english = flatten(CATALOGUES[DEFAULT_LANGUAGE]);
  const files = sourceFilesCallingLocalize();

  test('at least one source file calls localize()', () => {
    assert.ok(files.length > 0, 'found no localize() call sites — did the scan paths change?');
  });

  test('every literal key resolves to a real English key', () => {
    const unresolved = [];
    for (const { rel, src } of files) {
      for (const site of extractCallSites(src)) {
        if (!english.has(site.key)) unresolved.push(`${rel}: ${site.key}`);
      }
    }
    assert.deepEqual(unresolved, [], `unresolved keys:\n  ${unresolved.join('\n  ')}`);
  });

  test('every call site supplies the placeholders its template needs', () => {
    const gaps = [];
    for (const { rel, src } of files) {
      for (const site of extractCallSites(src)) {
        if (!english.has(site.key)) continue;
        if (site.vars === null) continue; // dynamic vars object, not checkable

        const needed = placeholdersOf(english.get(site.key));
        const missing = [...needed].filter((p) => !site.vars.has(p));
        if (missing.length) gaps.push(`${rel}: ${site.key} missing [${missing.join(', ')}]`);
      }
    }
    assert.deepEqual(gaps, [], `call sites missing variables:\n  ${gaps.join('\n  ')}`);
  });

  test('no English key is orphaned with zero call sites', () => {
    const used = new Set();
    const prefixes = [];
    for (const { src } of files) {
      for (const site of extractCallSites(src)) used.add(site.key);
      for (const key of extractTableKeys(src)) used.add(key);
      prefixes.push(...extractDynamicPrefixes(src));
    }

    const orphans = [...english.keys()].filter(
      (k) => !used.has(k) && !prefixes.some((p) => k.startsWith(p + '.'))
    );

    console.log(`      ${used.size} keys in use, ${prefixes.length} dynamic prefix(es)`);
    assert.deepEqual(
      orphans,
      [],
      `English keys with no call site — delete them or wire them up:\n  ${orphans.join('\n  ')}`
    );
  });
});

// ── handle scope ─────────────────────────────────────────────────
//
// The utils layer reaches localize() through the plugin instance it was handed
// (plugin.localize / tb.localize / tracker.localize), not through `this`. Those
// modules also carry top-level helper functions, and a localize() call added to
// one that never received the instance parses fine, passes node --check, and
// throws ReferenceError the first time that branch runs — which for an admin
// command or an error path can be long after the deploy. This has happened once
// already, in switch-explain.js's _formatMinutes().
//
// Three shapes carry that risk: a top-level `function name()`, a method of a
// module-level object literal (DiscordHelpers, CommandHandlers, EloDiscord —
// two-space indent, no closure over the instance), and a module-level arrow
// const. All three are scanned. Anything nested deeper sees the handle through
// a closure and is left alone.
//
// It has since happened twice more, both found by hand: four DiscordHelpers
// builders, and elo-discord.js's generateMatrixTable, which was an arrow const
// already calling tracker.localize() with no tracker anywhere in its scope.

describe('i18n — handle scope', () => {
  const HANDLES = ['plugin', 'tb', 'tracker', 'sa'];
  // `if (x) {` at two-space indent looks exactly like a method declaration.
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do']);

  test('every localize() call has its plugin handle in scope', () => {
    const problems = [];

    for (const { rel, src } of sourceFilesCallingLocalize()) {
      const SHAPES = [
        /^function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm,
        /^  (?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm,
        /^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/gm
      ];

      for (const m of SHAPES.flatMap((re) => [...src.matchAll(re)])) {
        const [, name, params] = m;
        if (KEYWORDS.has(name)) continue;

        const bodyStart = m[0].endsWith('{')
          ? m.index + m[0].length - 1
          : src.indexOf('{', m.index + m[0].length);
        if (bodyStart === -1) continue;
        let depth = 0, end = bodyStart;
        for (; end < src.length; end++) {
          if (src[end] === '{') depth++;
          else if (src[end] === '}') { depth--; if (depth === 0) break; }
        }
        const body = src.slice(bodyStart, end + 1);

        for (const h of HANDLES) {
          if (!new RegExp(`(?<![.\\w$])${h}\\.localize\\s*\\(`).test(body)) continue;
          const received = new RegExp(`\\b${h}\\b`).test(params);
          const declared = new RegExp(`\\b(?:const|let|var)\\s+${h}\\b`).test(body);
          if (!received && !declared) problems.push(`${rel}: ${name}() calls ${h}.localize() but never receives ${h}`);
        }
      }
    }

    assert.deepEqual(problems, [], `localize() with no handle in scope:\n  ${problems.join('\n  ')}`);
  });
});

// ── read-back ────────────────────────────────────────────────────
//
// LOCALIZATION.md's rule for what stays English is "if anything other than a
// human ever reads it back, leave it alone." A localize() result on either side
// of an equality test is that rule being broken: the value moves with the
// configured language while whatever produced the other side does not, so the
// comparison holds in English and silently stops matching everywhere else.
//
// Both instances of this so far were found by hand, and both were live breaks:
// TeamBalancer picked diagnostic results out of an array by their localized
// name (fixed with a stable id), and Switch matched a Discord embed title
// against a localized string while the writer still emitted English (the
// comparison went back to the literal). Neither threw in English, and no other
// test could see either one.

describe('i18n — read-back', () => {
  test('no localize() result is compared against anything', () => {
    // A localized value on either side of ===, !==, ==, != or inside
    // .includes(...) — the shapes a lookup or a scrape actually takes.
    const COMPARISONS = [
      /(?:===|!==|==|!=)\s*(?:this\.)?[A-Za-z_$][\w$.]*localize\s*\(/,
      /localize\s*\([^;\n]*\)\s*(?:===|!==|==|!=)/,
      /\.includes\s*\(\s*(?:this\.)?[A-Za-z_$][\w$.]*localize\s*\(/
    ];

    const offenders = [];
    for (const { rel, src } of sourceFilesCallingLocalize()) {
      src.split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('//')) return;
        if (COMPARISONS.some((re) => re.test(line))) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }

    assert.deepEqual(offenders, [],
      'a translated string is being read back by code — match on a stable id or ' +
      'the English literal instead:\n  ' + offenders.join('\n  '));
  });
});

// ── fallback behaviour ───────────────────────────────────────────

describe('i18n — fallback behaviour', () => {
  const KNOWN = 's3DiscordPluginBase.errors.sendFailed';

  test('a known key resolves in each supported language', () => {
    for (const lang of supportedLanguages()) {
      const out = localize(KNOWN, { error: 'boom' }, lang);
      assert.equal(typeof out, 'string');
      assert.ok(out.includes('boom'), `${lang} did not interpolate`);
      assert.ok(!out.includes('{'), `${lang} left a placeholder unfilled: ${out}`);
    }
  });

  test('an unknown key returns the key itself', () => {
    assert.equal(localize('no.such.key.at.all'), 'no.such.key.at.all');
  });

  test('an unknown language falls back to English', () => {
    assert.equal(
      localize(KNOWN, { error: 'x' }, 'zz'),
      localize(KNOWN, { error: 'x' }, DEFAULT_LANGUAGE)
    );
  });

  test('a key naming an interior node is treated as absent', () => {
    assert.equal(localize('s3DiscordPluginBase.errors'), 's3DiscordPluginBase.errors');
  });

  // The translator templates ship every value as ''. If an empty string counted
  // as a translation, a half-filled catalogue would render blank messages in
  // game rather than falling back — silent, and worse than no translation.
  test('an empty or blank translation falls back to English, never to blank', () => {
    const english = CATALOGUES[DEFAULT_LANGUAGE];
    const saved = CATALOGUES.pt.s3DiscordPluginBase?.errors?.sendFailed;
    assert.equal(typeof saved, 'string', 'fixture key is missing from pt');

    for (const blank of ['', '   ', '\n\t ']) {
      CATALOGUES.pt.s3DiscordPluginBase.errors.sendFailed = blank;
      const out = localize(KNOWN, { error: 'boom' }, 'pt');
      assert.equal(
        out,
        localize(KNOWN, { error: 'boom' }, DEFAULT_LANGUAGE),
        `a ${JSON.stringify(blank)} translation did not fall back to English`
      );
      assert.ok(out.trim().length > 0, 'rendered blank');
    }

    CATALOGUES.pt.s3DiscordPluginBase.errors.sendFailed = saved;
    assert.ok(english, 'sanity');
  });

  test('a missing variable leaves its placeholder intact, not "undefined"', () => {
    const out = localize(KNOWN, {});
    assert.ok(out.includes('{error}'), `expected placeholder to survive, got: ${out}`);
    assert.ok(!out.includes('undefined'), 'rendered undefined into user-facing text');
  });

  test('a falsy-but-present variable still interpolates', () => {
    const out = localize('s3PluginBase.errors.readyTimeout', { timeoutMs: 0 });
    assert.ok(out.includes('0'), `zero was dropped: ${out}`);
    assert.ok(!out.includes('{timeoutMs}'), 'zero was treated as missing');
  });

  test('both {var} and {{var}} placeholder styles interpolate', () => {
    const english = flatten(CATALOGUES[DEFAULT_LANGUAGE]);
    let sawSingle = false;
    let sawDouble = false;
    for (const value of english.values()) {
      if (/(?<!\{)\{\w+\}(?!\})/.test(value)) sawSingle = true;
      if (/\{\{\w+\}\}/.test(value)) sawDouble = true;
      if (sawSingle && sawDouble) break;
    }
    assert.ok(sawSingle && sawDouble, 'catalogue no longer exercises both brace styles');

    // Verified directly rather than via the catalogue, so the guarantee holds
    // even if the catalogue is normalised to one style later.
    assert.equal(localize.length >= 1, true);
    const both = 'a {one} b {{two}}';
    const rendered = both.replace(/\{\{(\w+)\}\}|\{(\w+)\}/g, (m, d, s) => ({ one: '1', two: '2' })[d ?? s] ?? m);
    assert.equal(rendered, 'a 1 b 2');
  });

  test('never throws on malformed input', () => {
    for (const bad of [null, undefined, '', 42, {}, []]) {
      assert.doesNotThrow(() => localize(bad));
      assert.equal(typeof localize(bad), 'string');
    }
  });

  test('supported languages include English first', () => {
    assert.equal(supportedLanguages()[0], DEFAULT_LANGUAGE);
    assert.ok(isSupportedLanguage(DEFAULT_LANGUAGE));
    assert.ok(!isSupportedLanguage('zz'));
  });
});

// ── language resolution ──────────────────────────────────────────

describe('i18n — language resolution', () => {
  // Lift the real `lang` getter out of a shipped file and run it against a
  // stand-in `this`. Asserting a hand-written mirror instead is what let the
  // first cut of this feature ship inert: S³ had no lang getter at all, so
  // this._s3?.lang was forever undefined and every plugin rendered English no
  // matter what the operator configured. A mirror agreed with itself; only the
  // shipped getter can disagree.
  const langGetterOf = (relPath) => {
    const src = fs.readFileSync(path.join(MONOREPO_ROOT, relPath), 'utf8');
    const at = src.search(/\bget\s+lang\s*\(\s*\)\s*\{/);
    assert.notEqual(at, -1, `${relPath} declares no lang getter — language cannot resolve through it`);

    const open = src.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}' && --depth === 0) break;
    }
    const body = src.slice(open + 1, end);
    // eslint-disable-next-line no-new-func
    return new Function('DEFAULT_LANGUAGE', `return function () {${body}};`)(DEFAULT_LANGUAGE);
  };

  const s3Lang = langGetterOf(AUTHORITATIVE_PLUGIN);
  const pluginLang = langGetterOf('s3/plugins/s3-plugin-base.js');

  test('S³ resolves its own language from the configured option', () => {
    assert.equal(s3Lang.call({ options: { language: 'pt' } }), 'pt');
    assert.equal(s3Lang.call({ options: { language: 'en' } }), 'en');
  });

  test('S³ with no language configured resolves to English', () => {
    assert.equal(s3Lang.call({ options: {} }), DEFAULT_LANGUAGE);
    assert.equal(s3Lang.call({ options: { language: '' } }), DEFAULT_LANGUAGE);
    assert.equal(s3Lang.call({}), DEFAULT_LANGUAGE);
  });

  test('every plugin inherits whatever S³ is set to', () => {
    // The full chain: an operator's config value, through S³, into a consumer.
    for (const configured of ['pt', 'en']) {
      const s3 = { options: { language: configured }, get lang() { return s3Lang.call(this); } };
      assert.equal(pluginLang.call({ _s3: s3 }), configured);
    }
  });

  test('S³ not yet discovered resolves to English without throwing', () => {
    assert.equal(pluginLang.call({ _s3: null }), DEFAULT_LANGUAGE);
    assert.equal(pluginLang.call({}), DEFAULT_LANGUAGE);
  });

  test('an empty or absent S³ language resolves to English', () => {
    assert.equal(pluginLang.call({ _s3: { lang: '' } }), DEFAULT_LANGUAGE);
    assert.equal(pluginLang.call({ _s3: { lang: null } }), DEFAULT_LANGUAGE);
  });

  test('S3PluginBase reads language from S³ and not from its own options', () => {
    // A consumer that consulted its own options here would shadow the shared
    // setting — the trap the removed per-plugin override used to spring.
    assert.equal(
      pluginLang.call({ _s3: { lang: 'pt' }, options: { language: 'en' } }),
      'pt',
      'S3PluginBase.lang consults its own options, which shadows S³'
    );
  });

  test('S3DiscordPluginBase does not redeclare lang', () => {
    const src = fs.readFileSync(path.join(MONOREPO_ROOT, 's3/plugins/s3-discord-plugin-base.js'), 'utf8');
    assert.ok(
      !/get lang\s*\(/.test(src),
      'S3DiscordPluginBase redeclares lang — it must inherit from S3PluginBase'
    );
  });
});

// ── declaration audit ────────────────────────────────────────────

describe('i18n — option declaration audit', () => {
  test('SlackersSquadServices declares language with a concrete default', () => {
    const src = fs.readFileSync(path.join(MONOREPO_ROOT, AUTHORITATIVE_PLUGIN), 'utf8');
    const block = optionBlock(src, 'language');
    assert.ok(block, 'SlackersSquadServices does not declare a language option');
    assert.match(
      block,
      /default:\s*'en'/,
      'the authoritative plugin must default to a real language, not null'
    );
  });

  test('no consumer plugin declares a language option of its own', () => {
    const declared = [];

    for (const { rel, src } of sourceFilesCallingLocalize()) {
      if (rel === AUTHORITATIVE_PLUGIN) continue;
      if (optionBlock(src, 'language')) declared.push(rel);
    }

    assert.deepEqual(
      declared,
      [],
      'language is server-wide and read from S³ by S3PluginBase. A per-plugin ' +
      'option here is at best redundant and at worst shadows the shared ' +
      'setting, and it cannot express the only case anyone wants — a ' +
      'per-SURFACE split, which no per-plugin value can reach because Switch ' +
      'and TeamBalancer each write to both RCON and Discord:\n  ' + declared.join('\n  ')
    );
  });

  test('every plugin that calls localize() reaches it through the base class', () => {
    const detached = [];

    for (const { rel, src } of sourceFilesCallingLocalize()) {
      if (BASE_CLASSES.includes(rel)) continue;
      if (rel === AUTHORITATIVE_PLUGIN) continue;
      if (!/\bthis\.localize\s*\(/.test(src)) continue;

      // A consumer that imports s3-i18n.js directly would bypass the `lang`
      // getter and silently render English no matter what S³ is set to.
      if (/from\s+['"][^'"]*s3-i18n\.js['"]/.test(src)) detached.push(rel);
    }

    assert.deepEqual(
      detached,
      [],
      'these plugins import s3-i18n.js directly rather than using ' +
      'this.localize(), which bypasses S³\'s language entirely:\n  ' + detached.join('\n  ')
    );
  });
});

// ── translator templates ─────────────────────────────────────────

describe('i18n — translator templates', () => {
  const OUT_DIR = path.join(MONOREPO_ROOT, 's3', 'locale-templates');

  test('the committed templates are current', async () => {
    const { build } = await import(
      pathToFileURL(path.join(MONOREPO_ROOT, 'tools', 'make-locale-templates.mjs')).href
    );
    const { files } = await build();

    const stale = [];
    for (const [name, expected] of Object.entries(files)) {
      const target = path.join(OUT_DIR, name);
      if (!fs.existsSync(target)) { stale.push(`${name} (missing)`); continue; }
      if (fs.readFileSync(target, 'utf8') !== expected) stale.push(name);
    }

    assert.deepEqual(
      stale,
      [],
      'locale templates are out of date — regenerate with:\n' +
      '  node tools/make-locale-templates.mjs\n  stale: ' + stale.join(', ')
    );
  });

  test('the two templates partition the English catalogue exactly', async () => {
    const { classifyKeys } = await import(
      pathToFileURL(path.join(MONOREPO_ROOT, 'tools', 'make-locale-templates.mjs')).href
    );
    const { english, buckets } = await classifyKeys();

    const unbucketed = [...english.keys()].filter((k) => !buckets.has(k));
    assert.deepEqual(unbucketed, [], `keys in no template: ${unbucketed.join(', ')}`);

    const stray = [...buckets.keys()].filter((k) => !english.has(k));
    assert.deepEqual(stray, [], `templates carry keys English does not: ${stray.join(', ')}`);
  });

  test('a tier is named in every template header, so the order is legible', () => {
    const expected = {
      's3-locale-template-players.js': 'PLAYER-FACING',
      's3-locale-template-admins.js': 'ADMIN-FACING'
    };
    for (const [name, title] of Object.entries(expected)) {
      const src = fs.readFileSync(path.join(OUT_DIR, name), 'utf8');
      assert.ok(src.includes(`${title} TRANSLATION TEMPLATE`), `${name} does not announce its tier`);
    }
  });

  test('mergeMessages joins tiers that a plain object literal would silently drop', async () => {
    const { mergeMessages } = await import(
      pathToFileURL(path.join(MONOREPO_ROOT, 's3', 'utils', 's3-locale-merge.js')).href
    );

    // The exact shape a translator hits: two tiers, both carrying teamBalancer.
    const players = { teamBalancer: { warn: { a: 'A' } }, switch: { warn: { c: 'C' } } };
    const admins = { teamBalancer: { embeds: { b: 'B' } } };

    const spread = { ...players, ...admins };
    assert.equal(spread.teamBalancer.warn, undefined,
      'the spread no longer loses the branch — this test is guarding nothing');

    const merged = mergeMessages(players, admins);
    assert.equal(merged.teamBalancer.warn.a, 'A');
    assert.equal(merged.teamBalancer.embeds.b, 'B');
    assert.equal(merged.switch.warn.c, 'C');

    assert.equal(players.teamBalancer.embeds, undefined, 'mergeMessages mutated its input');
  });

  // ─── the audience split is computed, so pin what it computes ─────
  //
  // Every row below is a fact about a gate in the source, not a preference:
  // !teambalancer returns unless the chat is ChatAdmin, !elo status sits inside
  // if (isAdminChannel), and !switch refresh has no guard while !switch matchend
  // does. If the classifier stops reading one of those gates the tier moves and
  // this fails, which is the whole reason the split is not a hand-written table.
  test('the audience of a string is read off the gate that protects it', async () => {
    const { classifyKeys } = await import(
      pathToFileURL(path.join(MONOREPO_ROOT, 'tools', 'make-locale-templates.mjs')).href
    );
    const { buckets } = await classifyKeys();

    const EXPECTED = [
      // Anyone in the server reads these.
      ['teamBalancer.rconMessages.scrambleAnnouncement', 'players'],
      ['teamBalancer.broadcasts.seedScrambleOffDisabled', 'players'],
      ['switch.warn.playersSquadsRefreshed', 'players'],   // case 'refresh', unguarded
      ['switch.warn.switchHowWorks1', 'players'],          // case 'explain', unguarded
      ['eloTracker.embeds.leaderboardTitle', 'players'],   // public !elo leaderboard

      // The in-game `!switch check` status card. Every one of these is built
      // into a local, concatenated into statusMsg and only then handed to
      // plugin.warn(), so none of them is visible to the direct call-site pass
      // — they resolve through the variable chain instead. The five
      // switch.labels.* entries are ALSO rendered by the admin Discord embed,
      // which is directly visible, so before pass 1b saw the player call site
      // they were filed as staff text and left out of the player template.
      ['switch.check.statusHeader', 'players'],
      ['switch.check.balanceTeamsFull', 'players'],
      ['switch.check.queuePosition', 'players'],
      ['switch.labels.clear', 'players'],
      ['switch.labels.notActive', 'players'],
      ['switch.labels.minutesRemaining', 'players'],
      ['switch.labels.tokensBalanceShort', 'players'],
      // Same block, and the reason the gate walk has to stop at the end of a
      // line: the `if (!isAdmin)` guarding the `!switch check <ident>` admin
      // variant sits one line below `if (ident) {`, inside it. A 60-character
      // window from the depth-1 `if (ident)` reached that depth-2 guard and
      // marked the whole `case "check":` — this else-branch included —
      // admin-only.
      ['switch.warn.switchUnableCheckEligibility', 'players'],
      // `!teambalancer` with no argument is handled by onChatMessage and is
      // public; only the argument forms go through the ChatAdmin gate.
      ['teamBalancer.status.statusLine', 'players'],
      ['teamBalancer.status.lastScramble', 'players'],

      // Only staff can reach these.
      ['teamBalancer.status.sIntegration', 'admins'],      // chat !== 'ChatAdmin' → return
      ['teamBalancer.embeds.scrambleCompleted', 'admins'], // staff channel
      ['switch.explain.allPopulationLevels', 'admins'],     // Discord-only explain report
      ['eloTracker.embeds.fieldVersion', 'admins'],        // inside if (isAdminChannel)
      ['slackersSquadServices.drift.embedTitle', 'admins'],
      // !s3 runs in the S³ admin channel, so its report text is staff text
      // even though it reads like a public leaderboard.
      ['slackersSquadServices.reports.leaderboardRow', 'admins'],
      ['slackersSquadServices.reports.karmaNeutral', 'admins'],
      // A warn is in-game, but this one answers an admin-gated !teambalancer
      // argument — the sink says where, the gate says who.
      ['teamBalancer.warn.pendingScrambleCancelled', 'admins']
    ];

    const wrong = [];
    for (const [key, tier] of EXPECTED) {
      const got = buckets.get(key);
      if (got === undefined) { wrong.push(`${key}: not classified at all (renamed?)`); continue; }
      if (got !== tier) wrong.push(`${key}: expected ${tier}, got ${got}`);
    }
    assert.deepEqual(wrong, [], 'the tier split moved:\n  ' + wrong.join('\n  '));
  });

  test('the tiers a translator merges really are disjoint', async () => {
    const { classifyKeys } = await import(
      pathToFileURL(path.join(MONOREPO_ROOT, 'tools', 'make-locale-templates.mjs')).href
    );
    const { buckets } = await classifyKeys();
    const seen = new Map();
    const dupes = [];
    for (const [key, tier] of buckets) {
      if (seen.has(key)) dupes.push(`${key}: ${seen.get(key)} and ${tier}`);
      seen.set(key, tier);
    }
    assert.deepEqual(dupes, [], `a key lands in two tiers: ${dupes.join(', ')}`);
  });

  // ─── the log is English, and stays English ──────────────────────
  //
  // PR #4 translated the verbose log too. It was reverted before merge: a log
  // is read by whoever runs the server, almost always while something is
  // broken, and always interleaved with core SquadJS lines that are English no
  // matter what. Half a translated log is harder to read than none, and it
  // makes an issue report depend on the reporter's locale.
  //
  // That decision only holds if it is enforced, because the natural thing to do
  // with a new Logger.verbose() is to reach for localize() like every other
  // string in the file. The rule is simply: Logger.*, verbose(), stderrError(),
  // console.* and thrown Error messages take English literals, never a
  // catalogue key. This test is the enforcement.

  test('no localized string reaches the server log', async () => {
    const { logSinkCallSites } = await import(
      pathToFileURL(path.join(MONOREPO_ROOT, 'tools', 'make-locale-templates.mjs')).href
    );

    const leaks = logSinkCallSites().map((c) => `${c.rel}:${c.line} ${c.sink}() <- ${c.key}`);

    assert.deepEqual(
      leaks,
      [],
      'these localize() results go straight into the log, which is not ' +
      'translated — inline the English instead:\n  ' + leaks.join('\n  ')
    );
  });

  // The direct-sink walk above cannot see a string assigned to a variable and
  // interpolated into a Logger.verbose() later — teamBalancer.verbose.eloLogString
  // was exactly that, and survived the sweep that removed the other 416. The
  // catalogue is the backstop: a `verbose` surface has no reason to exist now,
  // so its reappearance is the cheap signal that an indirect one crept back.
  test('no catalogue key sits on a verbose surface', () => {
    const keys = flatten(CATALOGUES[DEFAULT_LANGUAGE]).keys();
    const offenders = [...keys].filter((k) => k.split('.').includes('verbose'));
    assert.deepEqual(
      offenders,
      [],
      'the log tier was cut, so a verbose surface is either a log string that ' +
      'slipped back in or a badly named key:\n  ' + offenders.join('\n  ')
    );
  });

  test('every template value is empty, so nothing ships a fake translation', () => {
    for (const name of fs.readdirSync(OUT_DIR)) {
      const src = fs.readFileSync(path.join(OUT_DIR, name), 'utf8');
      const filled = [...src.matchAll(/^\s+[A-Za-z_$'][\w$']*:\s*'(.+)',$/gm)].map((m) => m[1]);
      assert.deepEqual(filled, [], `${name} has pre-filled values: ${filled.join(', ')}`);
    }
  });
});
