/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║               S³ DISCORD ROUTING GATE                        ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * One gate, sitting between every Discord admin handler's channel
 * check and its verb dispatch, that answers a single question: does
 * THIS process act on THIS message?
 *
 * Four handlers ask it — `!s3`, `!switch`, `!teambalancer`/`!scramble`
 * and `!elo` — and they ask it the same way, because the answer
 * depends on the command's scope and the registry, never on which
 * plugin is asking.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * COMMAND_SCOPE            — The scope tags a handler may carry.
 * ROUTING                  — The verdicts this gate returns.
 * parseServerSelector(args) — Strip `--server <x>` / `--s <x>` / `-s <x>`
 *                            out of an argument list, leaving it intact.
 * routeDiscordCommand(opts) — The gate. Returns a verdict.
 * buildRoutingRefusalEmbed(verdict, localize) — Render a refusal.
 * describeCandidates(rows) — Compact registry listing for a refusal.
 *
 * ─── THE MODEL, IN ONE PARAGRAPH ─────────────────────────────────
 *
 * With one registered server the gate is inert: it strips a selector
 * nobody types, takes no claim, and returns "act" for everything. That
 * is the zero-delta guarantee, and it is enforced by returning early
 * rather than by every branch below happening to agree.
 *
 * With more than one, an explicit `--server` decides everything — the
 * targeted process acts and the rest drop before any handler body runs,
 * so there is nothing to race and no claim to take. Without a selector,
 * a community command is answered by exactly one process (a claim on
 * the shared message key), a server-scoped read is answered by every
 * process for itself (a claim on its own scoped key, which buys
 * idempotence rather than exclusivity), and a server-scoped mutation is
 * refused by exactly one (the shared key again, so the channel gets one
 * reply and not N).
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────
 *
 * There is no sticky target and no channel binding. A remembered server
 * turns a typo into a silent assumption: an admin typing into a channel
 * somebody re-bound an hour ago gets a correct-looking reply about the
 * wrong server, and the scrollback contains nothing that explains it.
 * The cost is honest — on a multi-server install every mutating command
 * carries `--server`, every time — and it is typing rather than risk.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * s3-server-label.js
 *   Shortens the server names for a refusal listing. Pure string work,
 *   deliberately not the database service: this gate takes its `db`
 *   by injection so a test can hand it a stub, and importing the real
 *   one for a formatting helper would undo that.
 */

import { serverLabels } from './s3-server-label.js';

/**
 * What a handler declares about the verb an operator actually typed.
 *
 * The tag goes on the verb, not on the dispatching handler: `!s3 servers`
 * is a community read and `!s3 servers forget` is community-mutating, and
 * one handler dispatches both.
 *
 *   SERVER_READ        Reports on one server. Broadcasts when unrouted.
 *   SERVER_MUTATING    Changes one server. Refuses when unrouted.
 *   COMMUNITY_READ     Reports on the whole database. One responder.
 *   COMMUNITY_MUTATING Changes the whole database. One responder.
 *   TOKEN_CONFIRM      A confirm carrying a token minted at arm time.
 *
 * TOKEN_CONFIRM is not a scope so much as a statement that the routing
 * already happened. The token is an election decided at arm time, and a
 * stricter one than a claim: it picks the process that armed the action
 * rather than an arbitrary one. Claiming such a message would hand it to
 * a process that never minted the token, which then rejects it while the
 * arming process — the only one that could have acted — never sees it.
 */
export const COMMAND_SCOPE = Object.freeze({
  SERVER_READ: 'server-read',
  SERVER_MUTATING: 'server-mutating',
  COMMUNITY_READ: 'community-read',
  COMMUNITY_MUTATING: 'community-mutating',
  TOKEN_CONFIRM: 'token-confirm'
});

/**
 * The three things a handler can be told to do.
 *
 *   ACT     Run the verb. `verdict.args` has the selector stripped.
 *   DROP    Say nothing. Another process owns this message.
 *   REFUSE  Reply with `buildRoutingRefusalEmbed()` and stop. Exactly one
 *           process ever gets this verdict for a given message.
 */
export const ROUTING = Object.freeze({
  ACT: 'act',
  DROP: 'drop',
  REFUSE: 'refuse'
});

/** Why a refusal happened. Each maps to one rendered embed. */
export const REFUSAL = Object.freeze({
  SELECTOR_REQUIRED: 'selector-required',
  SELECTOR_MISSING_VALUE: 'selector-missing-value',
  UNKNOWN_SERVER: 'unknown-server',
  AMBIGUOUS_SERVER: 'ambiguous-server',
  UNREACHABLE_SERVER: 'unreachable-server'
});

/**
 * The selector, and the two shapes it is deliberately NOT.
 *
 * `--server`, `--s` and `-s` are the whole grammar, each accepted with
 * its value as the next token or after an `=`, and the match is on the
 * whole flag rather than on the word `server` inside it. That is not
 * fussiness. The export flags this gate
 * exists to make safe — `--all-servers`, `--remap-server` — both carry
 * the word, so a parser that looked for it, which is the forgiving way
 * to write this and would also accept a typo'd `--servers`, takes
 * `--all-servers` for a selector and eats the token after it. The
 * failure presents as an export flag that silently stopped working.
 * `!s3 db export --all-servers --server main` has to survive intact in
 * both directions, and the test suite says so in one command line.
 *
 * There is no `@alias` form. Discord's mention autocomplete fires on `@`
 * and makes it unpleasant to type.
 */
/**
 * `--s` is here because operators type it. The abbreviation is the obvious
 * guess once `--server` is known, and it used to parse as a positional
 * argument — so `!switch check slacker --s 2` looked up a player called
 * `--s`, answered from every server, and reported nothing wrong. A flag
 * that is silently a name is the worst of the three outcomes; refusing
 * would at least have been visible.
 */
const SELECTOR_FLAGS = new Set(['--server', '--s', '-s']);

/**
 * Pull the selector out of an argument list.
 *
 * Everything else is returned untouched and in order, so a downstream
 * handler's `args[0]` parsing never learns that selectors exist. That is
 * the entire reason the stripping happens here rather than in sixteen
 * verb bodies.
 *
 * A repeated selector keeps the LAST one. Two different targets in one
 * line is a typo either way, and the alternative — refusing — would put
 * a second failure mode in front of an admin who is already retyping.
 *
 * @param {string[]} args
 * @returns {{args: string[], token: string|null, present: boolean, missingValue: boolean}}
 */
export function parseServerSelector(args) {
  const input = Array.isArray(args) ? args : [];
  const out = [];
  let token = null;
  let present = false;
  let missingValue = false;

  for (let i = 0; i < input.length; i++) {
    const arg = String(input[i]);
    const lower = arg.toLowerCase();

    const eq = arg.indexOf('=');
    const head = eq === -1 ? lower : lower.slice(0, eq);

    if (!SELECTOR_FLAGS.has(head)) {
      out.push(input[i]);
      continue;
    }

    present = true;

    if (eq !== -1) {
      const value = arg.slice(eq + 1);
      if (value === '') missingValue = true;
      else { token = value; missingValue = false; }
      continue;
    }

    const next = i + 1 < input.length ? String(input[i + 1]) : null;
    // A selector whose value is itself a flag is a selector with no
    // value: `--server --all` means the admin lost a word, and taking
    // `--all` as an alias would refuse with a confusing "no such server
    // --all" instead of the accurate "you did not name one".
    if (next === null || next.startsWith('-')) {
      missingValue = true;
      continue;
    }

    token = input[i + 1];
    missingValue = false;
    i++;
  }

  return { args: out, token, present, missingValue };
}

/**
 * A compact registry listing for a refusal.
 *
 * Alias first, because the alias is what the operator is being asked to
 * type; the id follows because a server that never claimed an alias has
 * nothing else to be named by. The name is last and shortened against the
 * other candidates, because what the reader needs from it is the part that
 * is not true of every row in the list.
 *
 * A row whose name does not survive that — nothing stored, or nothing left
 * that another candidate does not also say — shows no name rather than an
 * ambiguous one. The alias and id above it are already unambiguous.
 *
 * @param {object[]} rows
 * @returns {string}
 */
export function describeCandidates(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const labels = serverLabels(rows);
  return rows
    .map((r) => {
      const alias = r?.alias ? `\`${r.alias}\`` : `\`${r?.serverID}\``;
      const label = labels.get(r?.serverID);
      const name = label ? ` — ${label}` : '';
      return `• ${alias} (id ${r?.serverID})${name}`;
    })
    .join('\n');
}

/**
 * Take the message claim, or report why not.
 *
 * `scoped` is the branch §7.4 turns on: a broadcast read claims
 * `discord:<id>:<serverID>` so every process wins its own slot, and
 * everything exactly one process may answer claims the bare
 * `discord:<id>` so only one does.
 *
 * @returns {Promise<{claimed: boolean, outcome: string}>}
 */
async function claimMessage(db, messageID, serverID, scoped) {
  const key = scoped ? `discord:${messageID}:${serverID}` : `discord:${messageID}`;
  return db.claimDiscordMessage(key);
}

/**
 * The gate.
 *
 * @param {object} opts
 * @param {object} opts.db          - The S³ DBService. A missing or unmounted
 *                                    one means every guard here is inert.
 * @param {string} opts.scope       - A COMMAND_SCOPE value.
 * @param {string[]} opts.args      - Arguments with the command word removed.
 * @param {string|number} opts.messageID
 * @param {string} [opts.command]   - What the operator typed, for the refusal.
 * @param {boolean} [opts.selectorRequired=false] - An otherwise ordinary
 *        server-scoped read whose reply is too large to broadcast. `!switch
 *        explain` is seven embeds; three servers answering one typed command
 *        with twenty-one is a narrow exception to broadcasting, justified by
 *        volume rather than by correctness.
 * @param {Function} [opts.verbose]
 * @returns {Promise<object>} `{ routing, args, token, target, refusal, candidates, multiServer }`
 */
export async function routeDiscordCommand({
  db,
  scope,
  args,
  messageID,
  command = '',
  selectorRequired = false,
  verbose = () => {}
} = {}) {
  const parsed = parseServerSelector(args);
  const base = {
    routing: ROUTING.ACT,
    args: parsed.args,
    token: parsed.token,
    target: null,
    refusal: null,
    candidates: [],
    command,
    multiServer: false
  };

  // No registry, no guards. An install running without a database is the
  // single-server case by construction, and refusing to answer commands
  // because the registry is unreachable would take the admin surface down
  // over a subsystem it does not need.
  if (!db || typeof db.isReady !== 'function' || !db.isReady() || !db.ServersModel) return base;

  const count = await resolveServerCount(db);
  if (count <= 1) return base;

  base.multiServer = true;

  // A token-bearing confirm routes itself. Every process must be allowed to
  // look at it, because only the one that minted the token can act, and it
  // is not necessarily the one that would win a claim.
  if (scope === COMMAND_SCOPE.TOKEN_CONFIRM) return base;

  const serverID = db.getServerID();

  if (parsed.missingValue) {
    return finishRefusal(base, db, messageID, serverID, REFUSAL.SELECTOR_MISSING_VALUE,
      await db.getRegisteredServers(), verbose);
  }

  // ── Explicit target ──────────────────────────────────────────────
  if (parsed.token !== null) {
    const resolved = await db.resolveServerToken(parsed.token);

    if (resolved.ambiguous) {
      return finishRefusal(base, db, messageID, serverID, REFUSAL.AMBIGUOUS_SERVER, resolved.ambiguous, verbose);
    }
    if (!resolved.row) {
      return finishRefusal(base, db, messageID, serverID, REFUSAL.UNKNOWN_SERVER, resolved.candidates || [], verbose);
    }

    base.target = resolved.row;
    if (resolved.row.serverID === serverID) return base;

    // A target that is not answering. Nobody drops into this branch for
    // its own row, so the check only ever runs against another process,
    // and it is the only thing standing between "that server is down" and
    // a command that appears to have been accepted and silently was not:
    // every other process would DROP, the targeted one is not running to
    // reply, and the channel gets nothing at all.
    if (!(await isTargetReachable(db, resolved.row))) {
      return finishRefusal(base, db, messageID, serverID, REFUSAL.UNREACHABLE_SERVER,
        [resolved.row], verbose);
    }

    // Someone else's message. Dropping it here, before the handler body,
    // is what makes a targeted command raceless: there is no second
    // process still deciding whether to answer.
    verbose(4, `[S3 Routing] "${command}" targets server ${resolved.row.serverID}; this is ${serverID}. Dropping.`);
    return { ...base, routing: ROUTING.DROP };
  }

  // ── No selector ──────────────────────────────────────────────────
  const registered = await db.getRegisteredServers();

  if (scope === COMMAND_SCOPE.SERVER_MUTATING ||
      (scope === COMMAND_SCOPE.SERVER_READ && selectorRequired)) {
    return finishRefusal(base, db, messageID, serverID, REFUSAL.SELECTOR_REQUIRED, registered, verbose);
  }

  const broadcast = scope === COMMAND_SCOPE.SERVER_READ;
  const claim = await claimMessage(db, messageID, serverID, broadcast);

  if (claim.outcome === 'unavailable') {
    // Answer anyway, and say so in the log. A claim that fails on a
    // connection blip is indistinguishable from one that was lost, and
    // the two failures are not symmetric: guessing "lost" silences every
    // responder at once, while guessing "won" costs duplicate replies
    // that an admin can see and read.
    verbose(1, `[S3 Routing] Could not take the Discord claim for "${command}" (${claim.error || 'unknown'}) — ` +
      'answering anyway. A duplicate reply is visible; a silent channel is not.');
    return base;
  }

  if (!claim.claimed) {
    verbose(4, `[S3 Routing] Another process claimed "${command}".`);
    return { ...base, routing: ROUTING.DROP };
  }

  return base;
}

/**
 * A refusal reaches the channel once, not once per process.
 *
 * Every process independently decides the command is unrouted, so the
 * refusal needs the same election the answer would have needed — on the
 * shared key, because exactly one reply is the point of it.
 */
async function finishRefusal(base, db, messageID, serverID, refusal, candidates, verbose) {
  const claim = await claimMessage(db, messageID, serverID, false);
  if (!claim.claimed) {
    verbose(4, `[S3 Routing] Another process is sending the "${refusal}" refusal.`);
    return { ...base, routing: ROUTING.DROP };
  }
  return { ...base, routing: ROUTING.REFUSE, refusal, candidates };
}

/**
 * Whether the process behind a registry row is still heartbeating.
 *
 * Registered and live are different questions and the rest of this gate
 * deliberately asks the first one — a stale row is still a server the
 * community owns, and its alias must keep resolving so the refusal can
 * name it. This is the one place the second question is the right one: an
 * admin is asking a specific process to DO something, and a process that
 * is not running cannot.
 *
 * The freshness comparison uses the DATABASE clock, because two SquadJS
 * hosts have two wall clocks and a two-minute window compared across them
 * is two minutes plus whatever they disagree by.
 *
 * Errs toward reachable. A registry read that fails here would otherwise
 * refuse every targeted command in the community over a connection blip,
 * and the failure it is guarding against — a command that lands nowhere —
 * is the milder of the two.
 */
async function isTargetReachable(db, row) {
  try {
    const live = await db.getLiveServers();
    return live.some((candidate) => candidate.serverID === row.serverID);
  } catch {
    return true;
  }
}

/**
 * How many servers are registered, preferring the heartbeat's cached answer.
 *
 * The cache is refreshed on the same heartbeat that stamps `lastSeenAt`, so
 * a process notices a server joining without querying on every admin
 * message. A null cache means no heartbeat has run yet — read it once, and
 * the heartbeat takes over from there.
 */
async function resolveServerCount(db) {
  const cached = typeof db.getKnownServerCount === 'function' ? db.getKnownServerCount() : null;
  if (Number.isFinite(cached)) return cached;
  return db.getRegisteredServerCount();
}

/**
 * Render a refusal.
 *
 * `localize` is passed in rather than imported so the string lands in the
 * caller's language: language is declared once on S³ and read through its
 * `lang` getter, and a context-free `localize()` here would silently
 * answer a Portuguese install in English.
 *
 * @param {object} verdict - What `routeDiscordCommand()` returned.
 * @param {Function} localize - `plugin.localize`, already bound.
 * @returns {object} A Discord embed literal.
 */
export function buildRoutingRefusalEmbed(verdict, localize) {
  const listing = describeCandidates(verdict.candidates) ||
    localize('slackersSquadServices.servers.noneRegistered');
  const token = verdict.token === null ? '' : String(verdict.token).slice(0, 40);
  const command = String(verdict.command || '').slice(0, 80);

  if (verdict.refusal === REFUSAL.AMBIGUOUS_SERVER) {
    return {
      color: 0xe74c3c,
      title: localize('slackersSquadServices.servers.ambiguousTitle'),
      description: localize('slackersSquadServices.servers.ambiguousDescription', { token, candidates: listing }),
      timestamp: new Date().toISOString()
    };
  }

  if (verdict.refusal === REFUSAL.UNKNOWN_SERVER) {
    return {
      color: 0xe74c3c,
      title: localize('slackersSquadServices.servers.notFoundTitle'),
      description: localize('slackersSquadServices.servers.notFoundDescription', { token, candidates: listing }),
      timestamp: new Date().toISOString()
    };
  }

  if (verdict.refusal === REFUSAL.UNREACHABLE_SERVER) {
    return {
      color: 0xe74c3c,
      title: localize('slackersSquadServices.routing.unreachableTitle'),
      description: localize('slackersSquadServices.routing.unreachableDescription', { token, candidates: listing }),
      timestamp: new Date().toISOString()
    };
  }

  if (verdict.refusal === REFUSAL.SELECTOR_MISSING_VALUE) {
    return {
      color: 0xe74c3c,
      title: localize('slackersSquadServices.routing.selectorMissingValueTitle'),
      description: localize('slackersSquadServices.routing.selectorMissingValueDescription', { candidates: listing }),
      timestamp: new Date().toISOString()
    };
  }

  return {
    color: 0xe74c3c,
    title: localize('slackersSquadServices.routing.selectorRequiredTitle'),
    description: localize('slackersSquadServices.routing.selectorRequiredDescription', { command, candidates: listing }),
    timestamp: new Date().toISOString()
  };
}

export default routeDiscordCommand;
