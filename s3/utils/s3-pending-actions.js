/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               S³ PENDING ACTIONS                             ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * The store behind every two-step admin command: something is armed,
 * a token is minted and printed, and a later message carrying that
 * token executes it.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * PENDING — Why a `take()` failed, when it failed.
 * mintPendingToken() — A short token. Exported for tests and reuse.
 * PendingActions — The store. One instance per plugin.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * node:crypto, for the token. Nothing else — no database, no clock
 * beyond an injectable `now`, so a test can arm and expire without
 * waiting a minute.
 *
 * ─── WHY A MAP AND NOT A SLOT ────────────────────────────────────
 *
 * Both flows this replaces held one slot: TeamBalancer's
 * `scrambleConfirmation` is a single `{ timestamp, args }` and
 * EloTracker's `_resetConfirmPending` is a bare boolean with a
 * timestamp. A second arm overwrote the first, which was harmless
 * while a confirm was a bare word — the second admin's `confirm`
 * simply replayed the second admin's arguments, and nobody could tell
 * the difference.
 *
 * It stops being harmless the moment a token is involved. Two admins
 * arming seconds apart both hold a token; with one slot only the later
 * one is real, and the earlier admin's token is either rejected —
 * confusing but safe — or, if the token is merely *validated* against
 * the slot rather than used to *find* the entry, accepted against
 * somebody else's stored arguments. That last one executes an action
 * the admin did not ask for through the mechanism built to stop
 * exactly that.
 *
 * So the token keys the entry. An entry is found by its token or not
 * found at all, and each expires on its own deadline rather than being
 * displaced by the next arm.
 *
 * ─── THE BARE-WORD PATH ──────────────────────────────────────────
 *
 * `takeNewest()` exists for the surfaces that do not carry a token: a
 * single-server install, where `!scramble confirm` has always been two
 * words and stays that way, and the in-game confirm, which arrives
 * over one server's own RCON and therefore cannot reach a process that
 * did not arm it. It takes the most recently armed entry of a kind,
 * which is what a single slot did.
 */

import crypto from 'node:crypto';

/** Why a `take()` did not return an action. */
export const PENDING = Object.freeze({
  OK: 'ok',
  UNKNOWN: 'unknown',
  EXPIRED: 'expired',
  NONE: 'none'
});

/**
 * Four hex characters, and the length is a readability decision.
 *
 * An admin reads this off one Discord message and types it into the
 * next one, under time pressure, on a command that moves live players.
 * The token is not a secret and does not need to resist guessing: it
 * only has to distinguish this arm from the handful of others that
 * could plausibly be live in the same minute, and the entry expires on
 * its own regardless. Eight characters would be twice the typing for
 * no reachable failure it prevents.
 */
export function mintPendingToken() {
  return crypto.randomBytes(2).toString('hex');
}

/** The default arm deadline, when a caller does not name one. */
export const DEFAULT_PENDING_TTL_MS = 60 * 1000;

export class PendingActions {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] - Default deadline for an arm
   * @param {Function} [opts.now] - Clock, injectable for tests
   */
  constructor({ ttlMs = DEFAULT_PENDING_TTL_MS, now = () => Date.now() } = {}) {
    this._ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_PENDING_TTL_MS;
    this._now = typeof now === 'function' ? now : () => Date.now();
    this._entries = new Map();
  }

  /**
   * Arm an action and return the token that executes it.
   *
   * Nothing is displaced. An arm that overwrote an earlier one would
   * invalidate a token an admin is at that moment reading off their
   * screen, and the earlier admin would have no way to tell that from
   * having mistyped it.
   *
   * @param {string} kind - What sort of action, e.g. 'scramble'
   * @param {*} payload - Whatever the confirm path needs to execute
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] - Deadline for this entry alone
   * @returns {{token: string, expiresAt: number, ttlMs: number}}
   */
  arm(kind, payload, { ttlMs } = {}) {
    this._sweep();

    const life = Number.isFinite(ttlMs) && ttlMs > 0 ? Math.floor(ttlMs) : this._ttlMs;
    let token = mintPendingToken();
    // A four-character token collides about once in 65536 arms, and the
    // consequence would be one admin's confirm finding another's action.
    // Re-minting costs nothing and removes the case entirely.
    while (this._entries.has(token)) token = mintPendingToken();

    const expiresAt = this._now() + life;
    this._entries.set(token, { kind: String(kind), payload, expiresAt, armedAt: this._now() });
    return { token, expiresAt, ttlMs: life };
  }

  /**
   * Take the action a token names, if it is this kind and still live.
   *
   * The kind is checked rather than trusted. Two plugins share one
   * process and a token is four characters; a scramble token typed
   * into `!elo reset confirm` must not find anything.
   *
   * @param {string} token
   * @param {string} kind
   * @returns {{status: string, payload?: *}}
   */
  take(token, kind) {
    this._sweep();

    const key = typeof token === 'string' ? token.trim().toLowerCase() : '';
    const entry = key === '' ? undefined : this._entries.get(key);
    // A token for another kind is reported as unknown rather than as a
    // kind mismatch: telling an admin the token is real but belongs to
    // a different command describes state they cannot see and would not
    // change what they do next.
    if (!entry || entry.kind !== String(kind)) return { status: PENDING.UNKNOWN };

    this._entries.delete(key);
    return { status: PENDING.OK, payload: entry.payload };
  }

  /**
   * Take the most recent live entry of a kind, whatever its token.
   *
   * For the two surfaces that never carry a token — a single-server
   * install and the in-game confirm — where the process that armed is
   * the only one that could be reading this.
   *
   * @param {string} kind
   * @returns {{status: string, payload?: *}}
   */
  takeNewest(kind) {
    const expiredKind = this._sweep().includes(String(kind));

    let newestKey = null;
    let newestAt = -Infinity;
    for (const [key, entry] of this._entries) {
      if (entry.kind !== String(kind) || entry.armedAt <= newestAt) continue;
      newestKey = key;
      newestAt = entry.armedAt;
    }

    // Nothing live, but something of this kind expired on the way in.
    // "It ran out" and "you never armed one" are different mistakes and
    // the admin's next move differs, so they are different answers.
    if (newestKey === null) return { status: expiredKind ? PENDING.EXPIRED : PENDING.NONE };

    const entry = this._entries.get(newestKey);
    this._entries.delete(newestKey);
    return { status: PENDING.OK, payload: entry.payload };
  }

  /**
   * Forget every live entry of a kind. What `!scramble cancel` does.
   *
   * @param {string} kind
   * @returns {number} How many were dropped
   */
  cancel(kind) {
    this._sweep();
    let dropped = 0;
    for (const [key, entry] of this._entries) {
      if (entry.kind !== String(kind)) continue;
      this._entries.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  /** Whether anything of this kind is armed and still live. */
  has(kind) {
    this._sweep();
    for (const entry of this._entries.values()) if (entry.kind === String(kind)) return true;
    return false;
  }

  /** How many entries are live. Tests and diagnostics. */
  size() {
    this._sweep();
    return this._entries.size;
  }

  /**
   * Drop what has expired, and report which kinds were dropped.
   *
   * Swept on access rather than on a timer. A timer would hold the
   * event loop open past the point SquadJS wants to exit, and would
   * need unref-ing and clearing on unmount for a map that is read a
   * few times an hour.
   *
   * @returns {string[]} The kinds that had at least one entry expire
   */
  _sweep() {
    const now = this._now();
    const dropped = [];
    for (const [key, entry] of this._entries) {
      if (entry.expiresAt > now) continue;
      this._entries.delete(key);
      if (!dropped.includes(entry.kind)) dropped.push(entry.kind);
    }
    return dropped;
  }
}

export default PendingActions;
