/**
 * S3-COMMON — small pure helpers shared across S³ modules.
 *
 * ─── WHAT BELONGS HERE ───────────────────────────────────────────
 *
 * A function earns a place here only if it is:
 *   1. pure — no service handle, no database, no server state, no I/O; and
 *   2. either used by two or more modules, or needs to be unit-tested directly.
 *
 * Anything that touches a service belongs on that service. Anything used by
 * exactly one module belongs in that module. This file exists so that small
 * cross-cutting helpers have one home instead of accumulating as one-function
 * files — it is not a landing pad for code with no obvious owner.
 *
 * ─── WHY NOT ON A CLASS ──────────────────────────────────────────
 *
 * `versionAtLeast()` cannot live on S3PluginBase and stay tested. That file
 * imports SquadJS's core base-plugin.js, which does not exist in this repo —
 * importing the module fails before any test runs, so every test of the class
 * goes through an inlined stub, and a stub cannot prove a comparison correct.
 */

/* ─────────────────────────────── VERSION ─────────────────────────────── */

/**
 * True when `actual` is at or above `required`.
 *
 * All four consumer plugins gate mounting on an S³ version floor, and every one
 * of them compared the raw strings: `actual < required`. That is lexicographic,
 * so '1.10.0' < '1.4.0' reads as true and the first two-digit minor release of
 * S³ would have locked every consumer out — on an upgrade, the direction nobody
 * thinks to test.
 *
 * Compares dotted numeric components, padding uneven lengths with zero, so
 * '1.4' and '1.4.0' are equal. A prerelease or build suffix ('1.5.0-rc1') is
 * dropped: this is about feature availability, and an RC carries the features
 * of its version.
 *
 * Fails closed — a missing or unparseable version returns false, matching how a
 * missing version already behaved at every call site. A mount-time refusal is
 * diagnosable; a version gate that quietly passes is not.
 *
 * @param {string} actual
 * @param {string} required
 * @returns {boolean}
 */
export function versionAtLeast(actual, required) {
  const a = parseVersion(actual);
  const b = parseVersion(required);
  if (!a || !b) return false;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const core = v.trim().split(/[-+]/)[0];
  if (!/^\d+(\.\d+)*$/.test(core)) return null;
  return core.split('.').map(Number);
}

/* ─────────────────────────── FORMATTING ─────────────────────────── */

/**
 * Format byte count to a human-readable string.
 *
 * Discord output shows '96.3 MB' rather than a raw byte count — a full-tier
 * export runs to nine figures on a mature database.
 */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format a Unix-ms timestamp to YYYY-MM-DD-HHmmss.
 *
 * This is the on-disk naming format for backup and export files, so it is
 * paired with parseTimestamp() below — change one and you must change both.
 */
export function timestampString(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Parse a YYYY-MM-DD-HHmmss timestamp string to Unix ms.
 *
 * @returns {number|null} null when the string does not match the format.
 */
export function parseTimestamp(str) {
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;

  const [, year, month, day, hour, min, sec] = match.map(Number);
  const d = new Date(year, month - 1, day, hour, min, sec);
  return d.getTime();
}
