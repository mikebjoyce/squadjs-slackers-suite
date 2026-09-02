/**
 * ─────────────────────────────────────────────────────────────────
 *  s3-i18n.js — message lookup and interpolation
 * ─────────────────────────────────────────────────────────────────
 *  EXPORTS
 *
 *    localize(key, vars, lang)   — Resolve a key to a formatted string.
 *    isSupportedLanguage(lang)   — Whether a catalogue exists for a code.
 *    supportedLanguages()        — Codes with catalogues, English first.
 *    DEFAULT_LANGUAGE            — 'en'.
 *    CATALOGUES / UNVERIFIED     — Raw catalogue access, for tests.
 *
 *  DESIGN
 *
 *  localize() never throws and never returns undefined. A missing
 *  string is a cosmetic bug; it must not take a server down, and it
 *  must not turn a log line into a stack trace. Every failure mode
 *  degrades to something a human can still read:
 *
 *    key missing from the active language  → English string
 *    key present but empty (untranslated)  → English string
 *    key missing everywhere                → the key itself
 *    key resolves to a non-string          → the key itself
 *    placeholder with no matching var      → placeholder left intact
 *    var with no matching placeholder      → ignored
 *
 *  Leaving an unmatched placeholder in place rather than rendering
 *  "undefined" keeps the failure legible: `{playerName}` in a log line
 *  names the variable that went missing.
 *
 *  Adding a language means adding an import and one CATALOGUES entry.
 *  See s3/LOCALIZATION.md.
 * ─────────────────────────────────────────────────────────────────
 */

import { MESSAGES as EN, UNVERIFIED as EN_UNVERIFIED } from './s3-locale-en.js';
import { MESSAGES as PT, UNVERIFIED as PT_UNVERIFIED } from './s3-locale-pt.js';

export const DEFAULT_LANGUAGE = 'en';

// English first — the fallback chain and several tests rely on it being
// present, and it is the source of truth for keys and placeholders.
export const CATALOGUES = {
  en: EN,
  pt: PT
};

export const UNVERIFIED = {
  en: EN_UNVERIFIED,
  pt: PT_UNVERIFIED
};

// Matches {{var}} before {var}. Order inside the alternation matters: at a
// "{{" the first branch is tried first, so a double-brace placeholder is
// never mis-read as a single-brace one wrapping a literal brace.
const PLACEHOLDER = /\{\{(\w+)\}\}|\{(\w+)\}/g;

/**
 * @param {string} lang
 * @returns {boolean} Whether a catalogue is loaded for this code.
 */
export function isSupportedLanguage(lang) {
  return typeof lang === 'string' && Object.prototype.hasOwnProperty.call(CATALOGUES, lang);
}

/**
 * @returns {string[]} Language codes with catalogues, English first.
 */
export function supportedLanguages() {
  return Object.keys(CATALOGUES);
}

/**
 * Walks a dotted key path through a catalogue.
 * @returns {string|null} The string, or null if absent or not a string.
 */
function lookup(catalogue, key) {
  if (!catalogue || typeof key !== 'string' || key.length === 0) return null;

  let node = catalogue;
  for (const segment of key.split('.')) {
    if (node === null || typeof node !== 'object') return null;
    node = node[segment];
  }

  // A key naming an interior node (e.g. 'switch.verbose') resolves to an
  // object. That is a caller bug, not a translation, so treat it as absent.
  //
  // An empty or whitespace-only value is an untranslated placeholder rather
  // than a message — no string in the suite is meant to render as nothing.
  // Treating it as absent makes it fall back to English instead of rendering
  // blank, which is what lets a half-filled template catalogue ship safely.
  return typeof node === 'string' && node.trim() !== '' ? node : null;
}

/**
 * Substitutes vars into a template. Single pass — a substituted value
 * containing braces is never re-scanned.
 */
function interpolate(template, vars) {
  if (!vars || typeof vars !== 'object') return template;

  return template.replace(PLACEHOLDER, (match, doubleName, singleName) => {
    const name = doubleName !== undefined ? doubleName : singleName;
    const value = vars[name];
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

/**
 * Resolves a message key to a formatted string in the requested language.
 *
 * @param {string} key - Dotted key path, e.g. 'switch.verbose.rconSuccess'.
 * @param {object} [vars={}] - Placeholder values, e.g. { name, teamID }.
 * @param {string} [lang=DEFAULT_LANGUAGE] - Language code.
 * @returns {string} Always a string; never throws.
 */
export function localize(key, vars = {}, lang = DEFAULT_LANGUAGE) {
  if (typeof key !== 'string' || key.length === 0) return '';

  let template = null;
  if (lang !== DEFAULT_LANGUAGE && isSupportedLanguage(lang)) {
    template = lookup(CATALOGUES[lang], key);
  }
  if (template === null) {
    template = lookup(CATALOGUES[DEFAULT_LANGUAGE], key);
  }

  // Unknown key. Returning the key is more useful than an empty string: it
  // is greppable, and it names what is missing.
  if (template === null) return key;

  return interpolate(template, vars);
}

export default localize;
