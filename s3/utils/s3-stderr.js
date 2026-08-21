/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           STDERR DIAGNOSTIC CHANNEL                           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * SquadJS's Logger writes everything to stdout via console.log, so an
 * operator who redirects the two streams to separate files
 * (`node index.js > squadjs.log 2> squadjs.err`) gets an error file
 * containing only Node-level uncaught exceptions — nothing SquadJS or
 * its plugins logged. Requested by an operator running exactly that
 * setup, for whom migration failures were the events worth tracing and
 * the ones hardest to find in a full stdout log.
 *
 * This module writes operational failures to stderr **in addition to**
 * the normal verbose/Discord reporting — it never replaces them. The
 * stdout line stays because it is what preserves chronology in the main
 * log; an operator reading only `squadjs.log` must still see that the
 * migration failed, in sequence with what came before it.
 *
 * ─── WHY NOT `throw` ─────────────────────────────────────────────
 *
 * The original request was to "throw it as an error so the OS picks it
 * up". An uncaught throw inside a SquadJS plugin does not reach the OS
 * as a tidy stderr line — it takes the server process down with it, or
 * (worse, in an async event handler) becomes an unhandled rejection
 * that Node may or may not surface. Writing to fd 2 is what actually
 * lands the text in `2>` redirection, and it leaves the server running.
 *
 * ─── MODES ───────────────────────────────────────────────────────
 *
 *   'off'     (default) stdout only — byte-for-byte the pre-1.3.0
 *             behaviour. Upgrading changes nobody's logs.
 *   'mirror'  always copy failures to stderr.
 *   'auto'    copy, unless fd 1 and fd 2 demonstrably lead to the same
 *             place — for a config shared between a console session and
 *             a redirected service.
 *
 * 'off' is the default deliberately. This channel only helps an operator
 * who has already separated their streams, and separating them is a
 * deliberate act by someone who will also read a config option. Everyone
 * else — console windows, `> log 2>&1`, Docker's default log driver,
 * systemd/journald, pm2 — would get either duplicated lines or errors
 * appearing somewhere new, without having asked for anything.
 *
 * 'auto' compares fstat on the two descriptors: same device, inode and
 * rdev means one destination, so the copy is suppressed. Verified — a
 * shared file reports identical dev/ino, separate redirections do not.
 * It cannot see Docker or journald, which hand the process two distinct
 * pipes and merge them downstream; those need 'off' (the default) or a
 * deliberate 'mirror'.
 *
 * ─── FLOOD CONTROL ───────────────────────────────────────────────
 *
 * Migration failures happen once per restart, but runtime errors do not:
 * when the database goes away, `_withDb` throws on every tick. An
 * unthrottled mirror would turn an outage into an error file that fills
 * the disk, which is a worse failure than the one being reported.
 *
 * So identical events are deduplicated by fingerprint. The first is
 * written immediately; identical events inside the window are counted,
 * not written; when the window closes a tally line is emitted on its own
 * ("suppressed 499 identical event(s) over 60s") and the next occurrence
 * starts a fresh window. The tally stands alone rather than riding on the
 * next event so that its timestamp means what it says. Digit runs are
 * normalised out of the fingerprint so that the same failure for a
 * thousand different players collapses to one entry rather than a thousand.
 *
 * No timers are used — a timer here would either keep the process alive
 * or need unref'ing, and neither is worth it. Pending counts are flushed
 * by the next write of any event, and by flushStderrDiagnostics() on
 * unmount, so a burst that stops entirely still gets its final tally.
 *
 * ─── OUTPUT FORMAT ───────────────────────────────────────────────
 *
 * One block per event, first line greppable, stack indented beneath:
 *
 *   [2026-08-18T21:36:12.345Z] [S3] [ERROR] [MigrationEngine] switch v4 -> v5 failed: qi.bulkUpdate is not a function
 *       at Object.up (file:///.../switch-db.js:387:22)
 *       ...
 *
 * The prefix is fixed-width by design: `grep '\[S3\] \[ERROR\]'` over a
 * mixed error file returns S³ events and nothing else. Output is plain
 * ASCII — SquadJS's stdout lines carry chalk ANSI escapes, which make a
 * redirected file awkward to grep; these do not.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * stderrError(scope, summary, err?)     — write an ERROR block.
 * stderrWarn(scope, summary, detail?)   — write a WARN block.
 * configureStderrDiagnostics(options)   — set mode/window (S³ mount).
 * flushStderrDiagnostics()              — emit pending counts (unmount).
 * _resetStderrDiagnostics()             — test hook; clears all state.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Writes are best-effort and never throw. A diagnostic channel that
 *   can itself fail a migration would be worse than no channel at all.
 * - Stack traces from Sequelize can carry the failing SQL, which on
 *   these plugins means player names and EOS IDs. Not a credential leak,
 *   but worth knowing before an error file is pasted somewhere public.
 * - process.stderr.write() is used rather than console.error() so each
 *   event is a single write rather than one per argument, which keeps
 *   blocks from interleaving when several fire at once.
 *
 * Author:
 * Discord: `real_slacker`
 */

'use strict';

import fs from 'node:fs';

const DEFAULT_WINDOW_MS = 60000;

/** Cap on tracked fingerprints — bounds memory when messages are unique. */
const MAX_TRACKED = 500;

const state = {
  mode: 'off',
  windowMs: DEFAULT_WINDOW_MS,
  /** fingerprint → { level, scope, summary, windowStart, suppressed } */
  entries: new Map()
};

/**
 * True when stdout and stderr demonstrably lead to the same destination, so a
 * mirrored copy would only print the same line twice in the same place.
 *
 * Compares dev/inode/rdev on the two descriptors: a shared file or a shared
 * console device matches, separately redirected streams do not. Docker and
 * journald give the process two distinct pipes, so they read as "different"
 * here and need 'off' set explicitly.
 *
 * Computed once — descriptors do not change destination mid-process — and
 * defaults to "not shared" if fstat is unavailable, because failing towards
 * reporting is better than failing towards silence.
 */
let sharedSinkCache = null;
function streamsShareSink() {
  if (sharedSinkCache !== null) return sharedSinkCache;
  try {
    const out = fs.fstatSync(1);
    const err = fs.fstatSync(2);
    sharedSinkCache =
      out.dev === err.dev && out.ino === err.ino && out.rdev === err.rdev;
  } catch {
    sharedSinkCache = false;
  }
  return sharedSinkCache;
}

/** Resolve the configured mode to a decision for this process. */
function mirroringEnabled() {
  if (state.mode === 'off') return false;
  if (state.mode === 'mirror') return true;
  return !streamsShareSink();
}

/**
 * Configure the channel. Called by the S³ plugin as the first statement of
 * mount(), before any service can fail. Until then the module default ('off')
 * applies, so nothing is written by a plugin that never configures this.
 * @param {object} [options]
 * @param {'auto'|'mirror'|'off'} [options.mode] - 'auto' mirrors unless the two
 *   streams share a destination; 'mirror' always; 'off' never
 * @param {number} [options.windowMs] - dedupe window; identical events inside it are counted, not written
 */
export function configureStderrDiagnostics({ mode, windowMs } = {}) {
  if (mode === 'auto' || mode === 'mirror' || mode === 'off') state.mode = mode;
  if (Number.isFinite(windowMs) && windowMs >= 0) state.windowMs = windowMs;
}

/**
 * Fingerprint an event for deduplication.
 *
 * Digit runs of four or more are collapsed so that per-player failures
 * ("no such column ... eosID 0002a3f9...") group into one entry instead of
 * one per player — the flood case this exists to contain. Shorter numbers
 * are left alone so that "v4 -> v5" stays distinct from "v5 -> v6".
 */
function fingerprint(level, scope, summary) {
  const normalized = String(summary)
    .replace(/[0-9a-f]{8,}/gi, '#')
    .replace(/\d{4,}/g, '#');
  return `${level}|${scope}|${normalized}`;
}

/** Compose and write one block. No dedupe logic here — callers decide. */
function emit(level, scope, summary, detail, repeatNote) {
  try {
    const timestamp = new Date().toISOString();
    const note = repeatNote ? `${repeatNote} ` : '';
    let block = `[${timestamp}] [S3] [${level}] [${scope}] ${note}${summary}\n`;

    if (detail instanceof Error) {
      // Prefer the stack (it carries the message already); fall back to the
      // message when a thrown value has no stack, which happens with values
      // rejected by some connector libraries.
      const body = detail.stack || detail.message || String(detail);
      block += body.split('\n').map((line) => `    ${line.trim()}`).join('\n') + '\n';
    } else if (detail) {
      block += String(detail).split('\n').map((line) => `    ${line}`).join('\n') + '\n';
    }

    process.stderr.write(block);
  } catch {
    // Never let the diagnostic channel break the caller.
  }
}

/**
 * Emit pending suppressed counts for entries whose window has closed, and
 * drop idle entries so the map stays bounded.
 * @param {number} now
 */
function sweep(now) {
  for (const [fp, entry] of state.entries) {
    if (now - entry.windowStart < state.windowMs) continue;
    if (entry.suppressed > 0) {
      const seconds = Math.round((now - entry.windowStart) / 1000);
      emit(
        entry.level,
        entry.scope,
        entry.summary,
        null,
        `(suppressed ${entry.suppressed} identical event(s) over ${seconds}s)`
      );
    }
    state.entries.delete(fp);
  }

  // Hard bound: Map preserves insertion order, so the oldest go first.
  while (state.entries.size > MAX_TRACKED) {
    const oldest = state.entries.keys().next().value;
    state.entries.delete(oldest);
  }
}

/**
 * Write one event, subject to mode and dedupe.
 * @param {'ERROR'|'WARN'} level
 * @param {string} scope
 * @param {string} summary
 * @param {Error|string|null} detail
 */
function write(level, scope, summary, detail) {
  try {
    if (!mirroringEnabled()) return;

    const now = Date.now();
    sweep(now);

    const fp = fingerprint(level, scope, summary);
    const entry = state.entries.get(fp);

    if (!entry) {
      emit(level, scope, summary, detail, null);
      state.entries.set(fp, { level, scope, summary, windowStart: now, suppressed: 0 });
      return;
    }

    // Inside the window: count it and stay quiet. sweep() above already
    // handled the expired case, so reaching here means the window is open.
    entry.suppressed += 1;
  } catch {
    // Never let the diagnostic channel break the caller.
  }
}

/**
 * Report a failure to stderr. Call this alongside — not instead of — the
 * normal verbose log and any Discord reporting.
 * @param {string} scope - Subsystem, e.g. 'MigrationEngine' or 'Switch'
 * @param {string} summary - One-line description of what failed
 * @param {Error} [err] - The error, if one is available; its stack is included
 */
export function stderrError(scope, summary, err = null) {
  write('ERROR', scope, summary, err);
}

/**
 * Report a condition that needs an operator's attention but is not a failure —
 * schema drift being the motivating case.
 * @param {string} scope - Subsystem, e.g. 'SchemaDrift'
 * @param {string} summary - One-line description
 * @param {string} [detail] - Extra lines, indented beneath the summary
 */
export function stderrWarn(scope, summary, detail = null) {
  write('WARN', scope, summary, detail);
}

/**
 * Emit any pending suppressed counts immediately. Called on S³ unmount so a
 * burst that stopped before its window closed still reports its final tally.
 */
export function flushStderrDiagnostics() {
  try {
    if (!mirroringEnabled()) {
      state.entries.clear();
      return;
    }
    const now = Date.now();
    for (const [fp, entry] of state.entries) {
      if (entry.suppressed > 0) {
        const seconds = Math.max(1, Math.round((now - entry.windowStart) / 1000));
        emit(
          entry.level,
          entry.scope,
          entry.summary,
          null,
          `(suppressed ${entry.suppressed} identical event(s) over ${seconds}s)`
        );
      }
      state.entries.delete(fp);
    }
  } catch {
    // Never let the diagnostic channel break the caller.
  }
}

/** Test hook — clears dedupe state and restores defaults. */
export function _resetStderrDiagnostics() {
  state.mode = 'off';
  state.windowMs = DEFAULT_WINDOW_MS;
  state.entries.clear();
}

export default {
  stderrError,
  stderrWarn,
  configureStderrDiagnostics,
  flushStderrDiagnostics,
  _resetStderrDiagnostics
};
