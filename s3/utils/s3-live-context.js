/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               S³ LIVE CONTEXT                                ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * One line describing what is happening on this server right now, for
 * the confirmation prompt of a command that is about to change it.
 *
 *   seeding — 6 players, 4m into the round, Sumari Seed v1
 *   78 players, 22m into the round, Gorodok RAAS
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * CONTEXT — Why a context could not be read.
 * readLiveContext(services) — The facts, or a reason there are none.
 * renderLiveContext(context, localize) — Those facts as one line.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * None. It reads an S³ services object handed to it, so a test can
 * pass a literal and the routing tests do not acquire a game state.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────
 *
 * An explicit `--server` selector defends against forgetting which
 * server you are talking to. It defends against nothing at all when
 * you type the wrong one — muscle memory, yesterday's scrollback, two
 * aliases a keystroke apart — because a well-formed selector naming
 * the wrong server is indistinguishable from a correct one at every
 * layer that only looks at the text.
 *
 * An admin who typed `1` meaning `2` will read `--server 1` back and
 * see what they meant to type. They will not misread *78 players, 22m
 * into the round* when they were thinking of a seeding server. That is
 * the whole idea: confirm against the live game, not against an id.
 *
 * ─── THE ORDER OF THE FACTS IS THE DESIGN ────────────────────────
 *
 * Player count first, round-elapsed second, layer last.
 *
 * Player count and elapsed time are always current and they are what
 * actually separate a seeding server from a full one. The layer is the
 * weak signal: S³'s layer is stale at `NEW_GAME` and returns the
 * PREVIOUS round's for a window, so an admin who reads only the layer
 * can be confirmed onto the wrong server by a string that looks right.
 * It is supporting detail and must never be the only distinguishing
 * fact, so it goes where a skimming reader hits it last.
 *
 * Seed mode leads when it applies, because "am I about to scramble the
 * seeding server" is the exact question this line exists to answer.
 *
 * ─── AND WHY IT REFUSES ──────────────────────────────────────────
 *
 * When the services are not up there is no context, and a missing
 * context must not fall through to executing unconfirmed. A prompt
 * that cannot say what it is about to change is not a confirmation;
 * the caller refuses instead, and says which part it could not read.
 */

/** Whether a context could be read, and if not, what was missing. */
export const CONTEXT = Object.freeze({
  OK: 'ok',
  NO_SERVICES: 'no-services',
  NOT_READY: 'not-ready'
});

/**
 * Read what is happening on this server.
 *
 * @param {object} services - S³'s services object (`plugin._s3`)
 * @param {Function} [now] - Clock, injectable for tests
 * @returns {{status: string, players: number|null, elapsedMinutes: number|null,
 *            layer: string|null, seeding: boolean}}
 */
export function readLiveContext(services, now = () => Date.now()) {
  const empty = { players: null, elapsedMinutes: null, layer: null, seeding: false };

  if (!services || typeof services !== 'object') {
    return { status: CONTEXT.NO_SERVICES, ...empty };
  }

  const players = services.players;
  const gameState = services.gameState;

  // The player count is the fact this line is built around, so its
  // absence is the one that refuses. The others degrade to "unknown"
  // and still leave a usable prompt.
  if (!players?.isReady?.() || typeof players.getAllPlayers !== 'function') {
    return { status: CONTEXT.NOT_READY, ...empty };
  }

  const roster = players.getAllPlayers();
  const count = Array.isArray(roster) ? roster.length : null;
  if (count === null) return { status: CONTEXT.NOT_READY, ...empty };

  const ready = gameState?.isReady?.() === true;
  const startedAt = ready && typeof gameState.getRoundStartTime === 'function'
    ? gameState.getRoundStartTime()
    : null;
  const elapsedMinutes = Number.isFinite(startedAt) && startedAt > 0
    ? Math.max(0, Math.floor((now() - startedAt) / 60000))
    : null;

  const rawLayer = ready && typeof gameState.getLayerDisplayName === 'function'
    ? gameState.getLayerDisplayName()
    : null;
  const layer = typeof rawLayer === 'string' && rawLayer.trim() !== ''
    ? rawLayer.trim().slice(0, 60)
    : null;

  return {
    status: CONTEXT.OK,
    players: count,
    elapsedMinutes,
    layer,
    seeding: ready && gameState.isSeedMode?.() === true
  };
}

/**
 * Render a context as the one line a confirmation prompt shows.
 *
 * `localize` is passed in rather than imported so the line lands in
 * the install's configured language — the same reason the routing
 * refusals take one.
 *
 * @param {object} context - What `readLiveContext()` returned
 * @param {Function} localize - `plugin.localize`, already bound
 * @returns {string|null} The line, or null when there was no context
 */
export function renderLiveContext(context, localize) {
  if (!context || context.status !== CONTEXT.OK) return null;

  const vars = {
    players: String(context.players),
    elapsed: context.elapsedMinutes === null
      ? localize('s3LiveContext.elapsedUnknown', {})
      : localize('s3LiveContext.elapsedMinutes', { minutes: String(context.elapsedMinutes) }),
    layer: context.layer ?? localize('s3LiveContext.layerUnknown', {})
  };

  return context.seeding
    ? localize('s3LiveContext.seedingLine', vars)
    : localize('s3LiveContext.line', vars);
}

export default readLiveContext;
