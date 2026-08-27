/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║           S³ SWITCH / KARMA REPORTS                            ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Query/aggregation layer behind `!s3 switches` and `!s3 karma`. Reads
 * three tables that already exist and are already populated by other
 * plugins — S3_PlayerEvents (this plugin's own TEAM_CHANGE log),
 * S3_PlayerSnapshots (this plugin's per-round roster snapshots), and
 * TB_RoundReport (TeamBalancer's per-round outcome log, read cross-plugin
 * via the shared DBService model registry). No new schema.
 *
 * ─── WHY AGGREGATION HAPPENS IN JS, NOT SQL ──────────────────────
 *
 * Every query here is a plain `findAll({ where })` against an
 * already-indexed column (ts range, eosID, matchId) — the same shape
 * every other query in this codebase uses. Grouping/counting happens in
 * plain JS after the fetch, deliberately avoiding SQL-side GROUP BY.
 *
 * MySQL 8 runs ONLY_FULL_GROUP_BY by default: it rejects a query that
 * groups by one column (eosID) while also selecting another
 * non-aggregated column (name) that isn't functionally dependent on it.
 * SQLite accepts the same query silently (it just picks an arbitrary row
 * per group) — so a GROUP BY here would pass every local/SQLite test and
 * only fail on the live MySQL target. Filtering in SQL and aggregating in
 * JS sidesteps the whole class of bug, at the cost of pulling more rows
 * into memory than a server-side GROUP BY would — acceptable here since
 * these are admin/Discord-triggered reports, not a hot path.
 *
 * ─── "GAMES PLAYED" CANNOT COME FROM EVENT ROWS ──────────────────
 *
 * S3_PLAYER_JOINED/LEFT fire once per connection, not once per round — a
 * player who stays connected across many rounds generates exactly one
 * JOIN row total. Counting distinct matchId from S3_PlayerEvents would
 * massively undercount games played. S3_PlayerSnapshots is the only
 * table with genuine per-round presence (a roster snapshot is taken at
 * LIVE, MID_ROUND, and ENDGAME every round regardless of whether a given
 * player generated any event that round), so getGamesPlayedMap() reads
 * roster membership from there instead.
 *
 * ─── SEED/JENSEN ROUNDS ARE EXCLUDED BY DEFAULT ──────────────────
 *
 * Every function below that counts switches or games takes an optional
 * trailing `ignoredGameModes` array (default ['Seed', 'Jensen'], same
 * default as S³'s own `ignoredGameModes` option) and drops any row whose
 * matchId belongs to a round whose TB_RoundReport.gameMode/layerName matches
 * one of those substrings. Seed/Jensen rounds get used to test the switch
 * plugins themselves — an admin repeatedly self-switching to verify a fix —
 * which would otherwise inflate that player's real switch/karma numbers with
 * activity nobody would call "playing." Callers pass the S³ plugin's own
 * `ignoredGameModes` config through so a server that customises it gets
 * consistent behaviour everywhere; omitting the argument falls back to the
 * Seed/Jensen default. The filter silently no-ops (nothing excluded) when
 * TB_RoundReport doesn't exist, since there's no round data to check against.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * parseRange(argString)                        — "30d" / "2w" / "YYYY-MM-DD..YYYY-MM-DD" -> {fromTs,toTs}|{error}
 * looksLikeRangeToken(token)                   — cheap test used to split "<ident> <range>" args
 * checkLoggingAvailability(s3db, fromTs, toTs) — detects a logging-disabled gap vs. a genuine zero
 * resolvePlayers(s3db, identifier)             — tiered ID/name lookup against S3_PlayerEvents
 * isUnambiguous(candidates)                    — true when the best match tier is unique
 * getGamesPlayedMap(s3db, fromTs, toTs, ignoredGameModes?)        — Map<eosID, {name, matchIds:Set}> from snapshot rosters
 * getSwitchesMap(s3db, fromTs, toTs, ignoredGameModes?)           — Map<eosID, {name, total, bySource}> from TEAM_CHANGE rows
 * getPlayerSwitches(s3db, eosID, fromTs, toTs, ignoredGameModes?) — same shape, single player, indexed by eosID directly
 * getKarmaReport(s3db, eosID, fromTs, toTs, ignoredGameModes?)    — win-rate of self/balancer switches vs. round outcome
 * isPeriodToken(token)                         — true for "daily"/"weekly"/"monthly"
 * getSwitchesByPeriodAndPlayer(s3db, fromTs, toTs, key, ignoredGameModes?) — per-player switch/games-played, bucketed by period
 *
 * ═══════════════════════════════════════════════════════════════
 */
import Sequelize from 'sequelize';

const { Op } = Sequelize;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 180;

const RANGE_TOKEN_RE = /^(\d+[dw]|\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2})$/i;

// Sources that get their own bucket in every breakdown; anything else (including
// future/unregistered plugin sources) falls into 'Other' rather than being
// silently dropped. Verified against real recordMove()/_taggedSwitchPlayer()
// call sites and a production S3_PlayerEvents export — NOT guessed from naming
// convention, several of which (e.g. self-switch being 'Player-Self', not
// 'SwitchPlayer') do not match what the source string "sounds like" it should be:
//   - 'TeamBalancer:Full' / 'TeamBalancer:Micro' — tb-swap-executor.js, current
//   - 'TeamBalancer'   — tb-swap-executor.js, pre-Full/Micro-split rows (historical)
//   - 'Team-Balancer'  — team-balancer.js executeScramble's removed dead-code
//                        duplicate call (historical only — see the comment at
//                        its former call site in team-balancer.js). Aliased to
//                        'TeamBalancer' below — both are the same legacy
//                        pre-split balancer move, just two accidental spellings;
//                        keeping them separate buckets would render two
//                        identically-labelled "Team-Balancer (Legacy)" lines.
//   - 'SmartAssign'    — sa-swap-executor.js / smart-assign.js
//   - 'Player-Self'    — switch-commands.js, self-serve !switch
//   - 'Player-Queue'   — switch-queue.js, queued self-switch pairing
//   - 'Handshake-Swap' — switch-queue.js, join-handshake team assignment
//   - 'Switch-Double-Swap' — switch.js, double-swap resolution
//   - 'Admin-Force'    — switch.js / switch-commands.js, admin-forced (incl. matchend)
//   - 'Manual/Game'    — logging-service.js's default when no attribution is
//                        found (vanilla scoreboard switch or unattributed RCON)
const KNOWN_SOURCES = [
  'TeamBalancer:Full',
  'TeamBalancer:Micro',
  'TeamBalancer',
  'SmartAssign',
  'Player-Self',
  'Player-Queue',
  'Handshake-Swap',
  'Switch-Double-Swap',
  'Admin-Force',
  'Manual/Game'
];

const SOURCE_ALIASES = { 'Team-Balancer': 'TeamBalancer' };

// Same default as S³'s own `ignoredGameModes` option (slackers-squad-services.js)
// — Seed/Jensen rounds get used to test the switch plugins themselves (players
// switching repeatedly to verify a fix works), which would otherwise inflate a
// player's real switch/karma numbers with rounds nobody would call "played."
const DEFAULT_IGNORED_GAME_MODES = ['Seed', 'Jensen'];

/**
 * @param {{gameMode?:string, layerName?:string}} row - A plain TB_RoundReport row.
 * @param {string[]} needles - Already-lowercased mode/map substrings.
 * @returns {boolean} True if this round's stored gameMode or layerName matches
 *   any needle — same substring-match semantics as
 *   GameStateService.isIgnoredMode(), applied to the round's persisted values
 *   rather than the live game-state cache.
 */
function isIgnoredRound(row, needles) {
  if (needles.length === 0) return false;
  const gameMode = String(row.gameMode || '').toLowerCase();
  const layerName = String(row.layerName || '').toLowerCase();
  return needles.some((n) => gameMode.includes(n) || layerName.includes(n));
}

/**
 * Builds the set of matchIds whose TB_RoundReport row matches an ignored game
 * mode, for callers that don't otherwise fetch TB_RoundReport rows themselves.
 * Returns an empty set (no filtering) when TB_RoundReport doesn't exist —
 * reports fall back to their pre-filter behaviour rather than silently
 * excluding everything just because TeamBalancer isn't installed.
 *
 * @returns {Promise<Set<string>>}
 */
async function getIgnoredMatchIds(s3db, fromTs, toTs, ignoredGameModes) {
  const roundModel = s3db?.isReady?.() ? s3db.getModel('TB_RoundReport') : null;
  if (!roundModel) return new Set();

  const needles = (ignoredGameModes || []).map((m) => String(m).toLowerCase()).filter(Boolean);
  if (needles.length === 0) return new Set();

  const rounds = await roundModel.findAll({
    where: { ts: { [Op.gte]: fromTs, [Op.lte]: toTs } },
    attributes: ['matchId', 'gameMode', 'layerName']
  });

  const ignored = new Set();
  for (const r of rounds) {
    const row = toPlainRow(r);
    if (row.matchId && isIgnoredRound(row, needles)) ignored.add(row.matchId);
  }
  return ignored;
}

function bucketSource(source) {
  const normalized = SOURCE_ALIASES[source] || source;
  return KNOWN_SOURCES.includes(normalized) ? normalized : 'Other';
}

function toPlainRow(r) {
  return typeof r?.toJSON === 'function' ? r.toJSON() : r;
}

/**
 * @param {string} token - Raw arg, e.g. "30d", "2w", "2026-08-01..2026-08-30".
 * @returns {boolean} True if this token should be consumed as a range rather
 *   than as part of a player identifier.
 */
export function looksLikeRangeToken(token) {
  return RANGE_TOKEN_RE.test(String(token || '').trim());
}

/**
 * @param {string|null} argString
 * @returns {{fromTs:number,toTs:number,capped?:boolean}|{error:string}}
 */
export function parseRange(argString) {
  const now = Date.now();
  const arg = String(argString || '').trim();

  if (!arg) {
    return { fromTs: now - DEFAULT_RANGE_DAYS * DAY_MS, toTs: now };
  }

  const daysMatch = /^(\d+)([dw])$/i.exec(arg);
  if (daysMatch) {
    const n = parseInt(daysMatch[1], 10);
    if (!Number.isFinite(n) || n <= 0) {
      return { error: `Invalid range "${arg}" — must be a positive number of days/weeks.` };
    }
    const days = daysMatch[2].toLowerCase() === 'w' ? n * 7 : n;
    const cappedDays = Math.min(days, MAX_RANGE_DAYS);
    return { fromTs: now - cappedDays * DAY_MS, toTs: now, capped: days > MAX_RANGE_DAYS };
  }

  const dateRangeMatch = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(arg);
  if (dateRangeMatch) {
    const from = Date.parse(`${dateRangeMatch[1]}T00:00:00Z`);
    const to = Date.parse(`${dateRangeMatch[2]}T23:59:59Z`);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
      return { error: `Invalid date range "${arg}".` };
    }
    const cappedFrom = Math.max(from, to - MAX_RANGE_DAYS * DAY_MS);
    return { fromTs: cappedFrom, toTs: to, capped: cappedFrom > from };
  }

  return { error: `Could not parse range "${arg}". Use "30d", "2w", or "YYYY-MM-DD..YYYY-MM-DD".` };
}

/**
 * Distinguishes "nobody switched" from "logging wasn't on for this window" —
 * S3_PlayerEvents sits entirely behind the enableDatabaseLogging config toggle
 * (independent of TB_RoundReport, which TeamBalancer always writes), so an
 * operator who never enabled it would otherwise see a clean-looking zero.
 *
 * @returns {Promise<{ok:boolean, reason:?string, hasRoundOutcomeData:boolean}>}
 *   reason is null when ok, else one of 'dbUnavailable' | 'noEventsLogged'.
 */
export async function checkLoggingAvailability(s3db, fromTs, toTs) {
  const eventsModel = s3db?.isReady?.() ? s3db.getModel('S3PlayerEvents') : null;
  if (!eventsModel) {
    return { ok: false, reason: 'dbUnavailable', hasRoundOutcomeData: false };
  }

  const anyEventCount = await eventsModel.count({
    where: { ts: { [Op.gte]: fromTs, [Op.lte]: toTs } }
  });

  const roundReportModel = s3db.getModel('TB_RoundReport');

  return {
    ok: anyEventCount > 0,
    reason: anyEventCount > 0 ? null : 'noEventsLogged',
    hasRoundOutcomeData: !!roundReportModel
  };
}

/**
 * Tiered ID/name resolution against S3_PlayerEvents, modeled on
 * elo-tracker/utils/elo-database.js searchPlayers() — reimplemented rather
 * than imported because install.cjs flattens each plugin's utils/ into one
 * directory, so a cross-plugin relative import would not resolve in out/.
 *
 * Adapted for an event log rather than a one-row-per-player table: an exact
 * ID match is still unambiguous by construction (tier 0), but name tiers are
 * built by scanning matching rows and collapsing to one entry per eosID in
 * JS, keeping an occurrence count as the tie-break within a tier.
 *
 * @returns {Promise<Array<{eosID, steamID, name, _matchTier:number, _count:number}>>}
 *   Ranked best-first. _matchTier: 0 exact ID, 1 exact trimmed name, 2 prefix, 3 substring.
 */
export async function resolvePlayers(s3db, identifier) {
  if (!s3db?.isReady?.() || !identifier) return [];
  const id = String(identifier).trim();
  if (!id) return [];

  const model = s3db.getModel('S3PlayerEvents');
  if (!model) return [];

  // Tier 0 — exact ID. Unambiguous by construction, so nothing to disambiguate.
  const byId = await model.findOne({
    where: { [Op.or]: [{ eosID: id }, { steamID: id }] },
    order: [['ts', 'DESC']]
  });
  if (byId) {
    const row = toPlainRow(byId);
    return [{ eosID: row.eosID, steamID: row.steamID, name: row.name, _matchTier: 0, _count: 1 }];
  }

  const LOOKUP_LIMIT = 200;
  const collected = new Map(); // eosID -> { eosID, steamID, name, tier: number|null, count }

  // Tier 1 (exact half) — exact trimmed name. Squad stores most names with a
  // leading space, so TRIM is load-bearing here, same reasoning as EloDatabase.
  const exactNameRows = await model.findAll({
    where: s3db.caseInsensitiveLikeLiteral('name', id, { exact: true, trimColumn: true }),
    order: [['ts', 'DESC']],
    limit: LOOKUP_LIMIT
  });
  for (const r of exactNameRows) {
    const row = toPlainRow(r);
    if (!row.eosID) continue;
    const existing = collected.get(row.eosID);
    if (existing) existing.count++;
    else collected.set(row.eosID, { eosID: row.eosID, steamID: row.steamID, name: row.name, tier: 1, count: 1 });
  }

  // Fuzzy substring pass, scored in JS below — can still land tier 1 for a
  // player not caught above (e.g. tag-stripped variants), tier 2/3 otherwise.
  const fuzzyRows = await model.findAll({
    where: s3db.caseInsensitiveLikeLiteral('name', id),
    order: [['ts', 'DESC']],
    limit: LOOKUP_LIMIT
  });
  for (const r of fuzzyRows) {
    const row = toPlainRow(r);
    if (!row.eosID) continue;
    const existing = collected.get(row.eosID);
    if (existing) { existing.count++; continue; }
    collected.set(row.eosID, { eosID: row.eosID, steamID: row.steamID, name: row.name, tier: null, count: 1 });
  }

  const needle = id.toLowerCase();
  const results = [...collected.values()].map((c) => {
    let tier = c.tier;
    if (tier == null) {
      const name = String(c.name || '').trim().toLowerCase();
      tier = name.startsWith(needle) ? 2 : 3;
    }
    return { eosID: c.eosID, steamID: c.steamID, name: c.name, _matchTier: tier, _count: c.count };
  });

  results.sort((a, b) => a._matchTier - b._matchTier || b._count - a._count);
  return results;
}

/**
 * @param {Array<{_matchTier:number}>} candidates - Ranked rows from resolvePlayers().
 * @returns {boolean} True only when the best tier is <=1 AND unique within that tier.
 */
export function isUnambiguous(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return false;
  const best = candidates[0]._matchTier ?? 3;
  if (best > 1) return false;
  return candidates.filter((c) => (c._matchTier ?? 3) === best).length === 1;
}

const SNAPSHOT_TRIGGER_RANK = { ENDGAME: 0, MID_ROUND: 1, LIVE: 2 };

/**
 * Builds per-player "games played" from roster snapshots rather than event
 * rows — see the file-level docblock for why. Two queries total (round list,
 * then snapshots for those matchIds), never one query per round.
 *
 * @returns {Promise<{perPlayer: Map<string,{name:string, matchIds:Set<string>}>, roundsInRange:number}>}
 */
export async function getGamesPlayedMap(s3db, fromTs, toTs, ignoredGameModes = DEFAULT_IGNORED_GAME_MODES) {
  const perPlayer = new Map();
  const roundModel = s3db?.isReady?.() ? s3db.getModel('TB_RoundReport') : null;
  const snapshotModel = s3db?.isReady?.() ? s3db.getModel('S3PlayerSnapshots') : null;
  if (!roundModel || !snapshotModel) return { perPlayer, roundsInRange: 0 };

  const needles = (ignoredGameModes || []).map((m) => String(m).toLowerCase()).filter(Boolean);
  const rounds = await roundModel.findAll({
    where: { ts: { [Op.gte]: fromTs, [Op.lte]: toTs } },
    attributes: ['matchId', 'gameMode', 'layerName']
  });
  const matchIds = [...new Set(
    rounds
      .map((r) => toPlainRow(r))
      .filter((row) => row.matchId && !isIgnoredRound(row, needles))
      .map((row) => row.matchId)
  )];
  if (matchIds.length === 0) return { perPlayer, roundsInRange: 0 };

  const snapshots = await snapshotModel.findAll({
    where: { matchId: { [Op.in]: matchIds } },
    attributes: ['matchId', 'trigger', 'playersJson']
  });

  // One canonical snapshot per round — prefer the latest available trigger so
  // a player who disconnected mid-round is still counted as having played.
  const canonicalByMatch = new Map();
  for (const s of snapshots) {
    const row = toPlainRow(s);
    const rank = SNAPSHOT_TRIGGER_RANK[row.trigger] ?? 3;
    const existing = canonicalByMatch.get(row.matchId);
    if (!existing || rank < existing.rank) {
      canonicalByMatch.set(row.matchId, { rank, playersJson: row.playersJson });
    }
  }

  for (const [matchId, snap] of canonicalByMatch) {
    let roster;
    try {
      roster = JSON.parse(snap.playersJson);
    } catch {
      continue;
    }
    if (!Array.isArray(roster)) continue;
    for (const p of roster) {
      if (!p?.eosID) continue;
      let entry = perPlayer.get(p.eosID);
      if (!entry) {
        entry = { name: p.name, matchIds: new Set() };
        perPlayer.set(p.eosID, entry);
      }
      entry.matchIds.add(matchId);
    }
  }

  return { perPlayer, roundsInRange: matchIds.length };
}

/**
 * @returns {Promise<Map<string,{name:string,total:number,bySource:Object<string,number>}>>}
 */
export async function getSwitchesMap(s3db, fromTs, toTs, ignoredGameModes = DEFAULT_IGNORED_GAME_MODES) {
  const perPlayer = new Map();
  const model = s3db?.isReady?.() ? s3db.getModel('S3PlayerEvents') : null;
  if (!model) return perPlayer;

  const ignoredMatchIds = await getIgnoredMatchIds(s3db, fromTs, toTs, ignoredGameModes);

  const rows = await model.findAll({
    where: { eventType: 'TEAM_CHANGE', ts: { [Op.gte]: fromTs, [Op.lte]: toTs } },
    attributes: ['eosID', 'name', 'source', 'matchId']
  });

  for (const r of rows) {
    const row = toPlainRow(r);
    if (!row.eosID) continue;
    if (row.matchId && ignoredMatchIds.has(row.matchId)) continue;
    let entry = perPlayer.get(row.eosID);
    if (!entry) {
      entry = { name: row.name, total: 0, bySource: {} };
      perPlayer.set(row.eosID, entry);
    }
    entry.total++;
    const bucket = bucketSource(row.source);
    entry.bySource[bucket] = (entry.bySource[bucket] || 0) + 1;
  }

  return perPlayer;
}

/**
 * Single-player equivalent of getSwitchesMap(), filtered at the DB via the
 * indexed eosID column rather than pulling the whole range and filtering in JS.
 */
export async function getPlayerSwitches(s3db, eosID, fromTs, toTs, ignoredGameModes = DEFAULT_IGNORED_GAME_MODES) {
  const model = s3db?.isReady?.() ? s3db.getModel('S3PlayerEvents') : null;
  const empty = { name: null, total: 0, bySource: {} };
  if (!model || !eosID) return empty;

  const ignoredMatchIds = await getIgnoredMatchIds(s3db, fromTs, toTs, ignoredGameModes);

  const rows = (await model.findAll({
    where: { eventType: 'TEAM_CHANGE', eosID, ts: { [Op.gte]: fromTs, [Op.lte]: toTs } },
    attributes: ['name', 'source', 'matchId']
  })).map(toPlainRow).filter((row) => !(row.matchId && ignoredMatchIds.has(row.matchId)));
  if (rows.length === 0) return empty;

  const result = { name: rows[0].name, total: 0, bySource: {} };
  for (const row of rows) {
    result.total++;
    const bucket = bucketSource(row.source);
    result.bySource[bucket] = (result.bySource[bucket] || 0) + 1;
  }
  return result;
}

// Sources excluded from karma entirely — not just Admin-Force. Karma asks one
// question: does this player's OWN decision to switch tend to land them on
// the winning side. A balancer/SmartAssign move isn't the player's decision —
// including it would measure the balancer's quality, not the player's
// behaviour, and would silently dilute a real self-serve pattern. Historical
// pre-split/dead-code aliases are listed explicitly since this filter runs in
// SQL against the raw stored string, before bucketSource() normalizes it.
const KARMA_EXCLUDED_SOURCES = [
  'Admin-Force',
  'TeamBalancer:Full',
  'TeamBalancer:Micro',
  'TeamBalancer',
  'Team-Balancer',
  'SmartAssign'
];

/**
 * Win-rate of a player's own team-switch decisions (self-serve `!switch`,
 * queued pairing, join handshake, double-swap, and untracked in-game
 * switches) against the eventual round winner. Excludes Admin-Force and every
 * balancer/SmartAssign source — see KARMA_EXCLUDED_SOURCES — because those
 * aren't the player choosing anything. Admin-Force's exclusion also covers
 * matchend switches, since doSwitchMatchend() tags them identically to a live
 * admin force (see switch/plugins/switch.js), so there is no separate flag to
 * filter on and none is needed.
 *
 * @returns {Promise<{available:boolean, reason?:string, totalSwitches?:number,
 *   decided?:number, wins?:number, winRate?:number|null, bySource?:Object}>}
 *   reason (when !available) is 'dbUnavailable' or 'noRoundOutcomeData'.
 */
export async function getKarmaReport(s3db, eosID, fromTs, toTs, ignoredGameModes = DEFAULT_IGNORED_GAME_MODES) {
  const eventsModel = s3db?.isReady?.() ? s3db.getModel('S3PlayerEvents') : null;
  if (!eventsModel) return { available: false, reason: 'dbUnavailable' };

  const roundModel = s3db.getModel('TB_RoundReport');
  if (!roundModel) return { available: false, reason: 'noRoundOutcomeData' };

  const ignoredMatchIds = await getIgnoredMatchIds(s3db, fromTs, toTs, ignoredGameModes);

  const switchRows = (await eventsModel.findAll({
    where: {
      eventType: 'TEAM_CHANGE',
      eosID,
      ts: { [Op.gte]: fromTs, [Op.lte]: toTs },
      source: { [Op.notIn]: KARMA_EXCLUDED_SOURCES }
    },
    attributes: ['matchId', 'newTeamID', 'source']
  })).map(toPlainRow).filter((row) => !(row.matchId && ignoredMatchIds.has(row.matchId)));

  if (switchRows.length === 0) {
    return { available: true, totalSwitches: 0, decided: 0, wins: 0, winRate: null, bySource: {} };
  }

  const matchIds = [...new Set(switchRows.map((row) => row.matchId).filter(Boolean))];
  const rounds = await roundModel.findAll({
    where: { matchId: { [Op.in]: matchIds } },
    attributes: ['matchId', 'winningTeamID']
  });
  const winnerByMatch = new Map(rounds.map((r) => {
    const row = toPlainRow(r);
    return [row.matchId, row.winningTeamID];
  }));

  let decided = 0;
  let wins = 0;
  const bySource = {};

  for (const row of switchRows) {
    const bucket = bucketSource(row.source);
    if (!bySource[bucket]) bySource[bucket] = { total: 0, wins: 0, decided: 0 };
    bySource[bucket].total++;

    const winner = winnerByMatch.get(row.matchId);
    if (winner == null) continue; // round outcome unknown — matchId has no TB_RoundReport row

    decided++;
    bySource[bucket].decided++;
    if (Number(row.newTeamID) === Number(winner)) {
      wins++;
      bySource[bucket].wins++;
    }
  }

  return {
    available: true,
    totalSwitches: switchRows.length,
    decided,
    wins,
    winRate: decided > 0 ? wins / decided : null,
    bySource
  };
}

const PERIOD_MS = { daily: DAY_MS, weekly: 7 * DAY_MS, monthly: 30 * DAY_MS };

/**
 * @param {string} token
 * @returns {boolean} True for a recognised period keyword ("daily"/"weekly"/"monthly").
 */
export function isPeriodToken(token) {
  return Object.prototype.hasOwnProperty.call(PERIOD_MS, String(token || '').toLowerCase());
}

/**
 * Splits [fromTs, toTs) into contiguous, chronologically-ordered buckets of
 * fixed width. "monthly" is a 30-day bucket, not a calendar month — ranges
 * are capped at 180 days by parseRange(), so at most 180/30 = 6 buckets;
 * fixed-width keeps bucket assignment an O(1) index computation instead of
 * calendar arithmetic, and nobody asked for a report aligned to the 1st.
 *
 * @returns {{periodStart:number, periodEnd:number}[]}
 */
function bucketRanges(fromTs, toTs, periodKey) {
  const stepMs = PERIOD_MS[periodKey] || PERIOD_MS.weekly;
  const buckets = [];
  for (let start = fromTs; start < toTs; start += stepMs) {
    buckets.push({ periodStart: start, periodEnd: Math.min(start + stepMs, toTs) });
  }
  return buckets.length ? buckets : [{ periodStart: fromTs, periodEnd: toTs }];
}

/**
 * Per-player switch/games-played breakdown, bucketed into fixed-width time
 * periods — the "data doc" export behind `!s3 switches export`. One row per
 * (period, player) for every player who either switched or appeared in a
 * round's canonical snapshot that period; a player silent all period simply
 * has no row, rather than padding the export with an all-zero line for every
 * eosID ever seen. Games-played comes from S3_PlayerSnapshots the same way
 * getGamesPlayedMap() reads it — a JOIN/LEFT event fires once per connection,
 * not once per round, so it can't answer "how many rounds this period."
 *
 * @param {object} s3db
 * @param {number} fromTs
 * @param {number} toTs
 * @param {string} [periodKey='weekly'] - 'daily' | 'weekly' | 'monthly'
 * @returns {Promise<{ok:boolean, reason?:string, periods?:Array<{periodStart:number,
 *   periodEnd:number, rounds:number, players:Array<{eosID:string, name:?string,
 *   games:number, total:number, bySource:Object}>}>}>}
 */
export async function getSwitchesByPeriodAndPlayer(s3db, fromTs, toTs, periodKey = 'weekly', ignoredGameModes = DEFAULT_IGNORED_GAME_MODES) {
  const eventsModel = s3db?.isReady?.() ? s3db.getModel('S3PlayerEvents') : null;
  if (!eventsModel) return { ok: false, reason: 'dbUnavailable' };

  const buckets = bucketRanges(fromTs, toTs, periodKey);
  const stepMs = buckets[0].periodEnd - buckets[0].periodStart || 1;
  const periods = buckets.map((b) => ({ ...b, rounds: 0, players: new Map() }));
  const indexFor = (ts) => Math.min(Math.floor((ts - fromTs) / stepMs), periods.length - 1);

  function playerEntry(period, eosID, name) {
    let entry = period.players.get(eosID);
    if (!entry) {
      entry = { eosID, name: name ?? null, games: 0, total: 0, bySource: {} };
      period.players.set(eosID, entry);
    } else if (name) {
      entry.name = name;
    }
    return entry;
  }

  // Round query doubles as the ignored-mode source, so this stays one query
  // instead of two — getIgnoredMatchIds() isn't reused here for that reason.
  const needles = (ignoredGameModes || []).map((m) => String(m).toLowerCase()).filter(Boolean);
  const roundModel = s3db.getModel('TB_RoundReport');
  const ignoredMatchIds = new Set();
  const periodIndexByMatch = new Map();
  if (roundModel) {
    const roundRows = await roundModel.findAll({
      where: { ts: { [Op.gte]: fromTs, [Op.lte]: toTs } },
      attributes: ['matchId', 'ts', 'gameMode', 'layerName']
    });
    for (const r of roundRows) {
      const row = toPlainRow(r);
      if (row.matchId && isIgnoredRound(row, needles)) {
        ignoredMatchIds.add(row.matchId);
        continue;
      }
      const idx = indexFor(row.ts);
      if (periods[idx]) periods[idx].rounds++;
      if (row.matchId) periodIndexByMatch.set(row.matchId, idx);
    }
  }

  const snapshotModel = roundModel ? s3db.getModel('S3PlayerSnapshots') : null;
  if (snapshotModel && periodIndexByMatch.size > 0) {
    const snapshots = await snapshotModel.findAll({
      where: { matchId: { [Op.in]: [...periodIndexByMatch.keys()] } },
      attributes: ['matchId', 'trigger', 'playersJson']
    });
    const canonicalByMatch = new Map();
    for (const s of snapshots) {
      const row = toPlainRow(s);
      const rank = SNAPSHOT_TRIGGER_RANK[row.trigger] ?? 3;
      const existing = canonicalByMatch.get(row.matchId);
      if (!existing || rank < existing.rank) {
        canonicalByMatch.set(row.matchId, { rank, playersJson: row.playersJson });
      }
    }
    for (const [matchId, snap] of canonicalByMatch) {
      const period = periods[periodIndexByMatch.get(matchId)];
      if (!period) continue;
      let roster;
      try {
        roster = JSON.parse(snap.playersJson);
      } catch {
        continue;
      }
      if (!Array.isArray(roster)) continue;
      for (const p of roster) {
        if (!p?.eosID) continue;
        playerEntry(period, p.eosID, p.name).games++;
      }
    }
  }

  const switchRows = await eventsModel.findAll({
    where: { eventType: 'TEAM_CHANGE', ts: { [Op.gte]: fromTs, [Op.lte]: toTs } },
    attributes: ['ts', 'eosID', 'name', 'source', 'matchId']
  });
  for (const r of switchRows) {
    const row = toPlainRow(r);
    if (!row.eosID) continue;
    if (row.matchId && ignoredMatchIds.has(row.matchId)) continue;
    const period = periods[indexFor(row.ts)];
    if (!period) continue;
    const entry = playerEntry(period, row.eosID, row.name);
    entry.total++;
    const bucket = bucketSource(row.source);
    entry.bySource[bucket] = (entry.bySource[bucket] || 0) + 1;
  }

  return {
    ok: true,
    periods: periods.map((p) => ({
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      rounds: p.rounds,
      players: [...p.players.values()].sort((a, b) => b.total - a.total || b.games - a.games)
    }))
  };
}
