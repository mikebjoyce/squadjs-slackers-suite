/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║   I18N — RENDER COVERAGE (PSEUDO-LOCALE)                      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * test-i18n.js asserts that the catalogue is INTERNALLY sound: every key
 * resolves, every placeholder matches, no localized string reaches a log.
 * It cannot assert the converse — that every string a user actually sees
 * came from the catalogue at all. A literal written straight into an embed
 * is invisible to it, because there is no key to check.
 *
 * That gap is not theoretical. It is how roughly 180 hardcoded strings
 * survived a full localization pass, and it is undetectable by reading the
 * rendered output: in English a hardcoded "Connected" and a catalogue
 * "Connected" are byte-identical. Only the second one translates.
 *
 * ─── HOW THIS WORKS ──────────────────────────────────────────────
 *
 * Every builder is called with a plugin stub whose localize() wraps its
 * result in ⟦…⟧. In the rendered embed:
 *
 *   bracketed   → went through the catalogue          (correct)
 *   unbracketed → a hardcoded literal, or stub data   (suspect)
 *
 * Bracketed spans are then stripped and whatever prose remains must be a
 * word this file explicitly allows — an identifier, a config key, a command
 * token. Anything else fails, and the failure names the word and the field.
 *
 * ─── WHY THE ALLOWLIST IS THE POINT ──────────────────────────────
 *
 * Some strings SHOULD stay English: service names, Server.cfg keys, API
 * accessor names, command tokens. Listing them here rather than inferring
 * them means adding one is a deliberate, reviewable act. A contributor who
 * hardcodes a user-facing string cannot make this pass without writing that
 * word into ALLOWED_IDENTIFIERS, where it looks obviously wrong.
 *
 * ─── WHAT THIS CATCHES THAT A STATIC SCAN CANNOT ─────────────────
 *
 * A literal assigned to an intermediate variable —
 *
 *     let dbLabel = 'Unknown';          // no display anchor
 *     ...
 *     healthLines.push(`… ${dbLabel}`); // anchor sees only a variable
 *
 * — sits at no display anchor, so grepping for prose next to `.push(` or
 * `name:` walks straight past it. Rendering is the only thing that sees it.
 * The !switch diag health block was exactly this shape.
 *
 * ─── DEPENDENCIES ────────────────────────────────────────────────
 *
 * Imports the builders and renders them against in-memory stubs. No
 * Discord, no server, no SquadJS mount. The last suite is the exception:
 * buildSwitchesEmbed and buildKarmaEmbed read two tables before they format
 * anything, so they run against in-memory SQLite rather than a stub — an
 * empty stub would only ever render the empty-state branch.
 * ─────────────────────────────────────────────────────────────────
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { localize as lookupMessage } from '../utils/s3-i18n.js';
import * as cmds from '../utils/s3-commands.js';
import SwitchOutput from '../../switch/utils/switch-output.js';
import SwitchExplain from '../../switch/utils/switch-explain.js';
import SwitchCommands from '../../switch/utils/switch-commands.js';
import { DiscordHelpers } from '../../team-balancer/utils/tb-discord-helpers.js';
import { EloDiscord } from '../../elo-tracker/utils/elo-discord.js';
import TBCommands from '../../team-balancer/utils/tb-commands.js';
import { buildMigrationEmbed } from '../utils/s3-migration-discord.js';
import { Sequelize, DataTypes } from 'sequelize';
import DBService from '../utils/db-service.js';

// ── the pseudo-locale ────────────────────────────────────────────

const OPEN = '⟦';
const CLOSE = '⟧';

const PLACEHOLDER = /\{\{(\w+)\}\}|\{(\w+)\}/g;

/**
 * Renders English, but marks which halves came through the catalogue.
 *
 * Substituted values land OUTSIDE the brackets, and that placement is the
 * whole point. Bracketing the finished string instead would bless whatever
 * was interpolated into it, so
 *
 *     let lastScrambleText = 'Never';                       // hardcoded
 *     localize('…lastScramble', { lastScrambleText })       // → ⟦Last: Never⟧
 *
 * would read as fully localized. Splitting at the placeholders gives
 * ⟦Last Scramble: ⟧Never instead, and the bare word fails. A value that was
 * itself localized arrives already bracketed and passes on its own merit.
 */
const localize = (key, vars) => {
  // vars must be a non-object for the catalogue to skip interpolation and
  // hand back the raw template.
  const template = lookupMessage(key, null, 'en');
  let out = '';
  let last = 0;
  PLACEHOLDER.lastIndex = 0;
  let m;
  while ((m = PLACEHOLDER.exec(template)) !== null) {
    const literal = template.slice(last, m.index);
    if (literal) out += OPEN + literal + CLOSE;
    const name = m[1] !== undefined ? m[1] : m[2];
    const value = vars ? vars[name] : undefined;
    // An unfilled placeholder is still catalogue text, so it stays bracketed.
    // test-i18n.js is what asserts every placeholder actually gets a value;
    // failing it here too would only report incomplete stubs as leaks.
    out += (value === undefined || value === null) ? OPEN + m[0] + CLOSE : String(value);
    last = m.index + m[0].length;
  }
  const tail = template.slice(last);
  if (tail) out += OPEN + tail + CLOSE;
  return out || OPEN + CLOSE;
};

/**
 * Words that are deliberately NOT translated, with the reason they are not.
 * Everything here is an identifier a translator must not touch — changing it
 * would break a lookup, a comparison, or a command the operator types.
 */
const ALLOWED_IDENTIFIERS = new Set([
  // S³ service names — these name the modules, and !s3 diag prints them
  // alongside their state; the state is localized, the name is not.
  'ServerConfig', 'DB', 'GameState', 'Factions', 'Clans', 'Players',
  // !s3 diag spells the same six the way plugin.services keys them, so an
  // operator can match a red row to the property that produced it.
  'serverConfig', 'db', 'gameState', 'factions', 'clans', 'players',

  // Plugin names, as install.cjs and the migration ledger spell them. The
  // migration embed prints them beside a version, and renaming one in a
  // translation would break the row a operator matches against the ledger.
  'Switch', 'TeamBalancer', 'EloTracker', 'SlackersSquadServices',

  // GameState API accessors, printed verbatim so the field reads as the call
  // that produced it.
  'isLive', 'isStaging', 'isEnding', 'isIgnoredMode', 'MatchId',

  // Server.cfg keys, spelled exactly as the file spells them.
  'AllowTeamChanges', 'NumReservedSlots', 'TimeBetweenMatches',
  'TeamVote_Duration', 'LayerVoteDuration',

  // Markdown code-fence language tags, and the export's file format,
  // which is the extension uppercased rather than a word.
  'json', 'js', 'text', 'CSV', 'JSON',

  // The unresolved-phase sentinel !s3 diag prints when getPhase() is null.
  // It is deliberately the machine spelling, not prose — an operator reading
  // it is looking at a service that returned nothing, not at a phase name.
  'NULL',

  // Conservative Skill Rating — the acronym names the Elo metric itself and
  // is what players say in chat; the column header beside it is localized.
  'CSR',

  // GameState phase values — matched on, not read as prose. 'unknown' is
  // the fallback of the same series and prints beside them.
  'staging', 'live', 'ending', 'seed', 'unknown',
  // GameStateService itself returns the uppercase spellings; !s3 diag prints
  // the raw return so a mismatch is visible rather than normalised away.
  'LIVE', 'STAGING', 'ENDGAME',

  // Squad gamemode names, as the layer classnames spell them. These are
  // configured in liberalSwitchGameModes and compared against the live
  // gamemode, so they are matched on, not read.
  'Seed', 'Jensen',

  // Switch command tokens, as typed in chat.
  'switch', 'status', 'check', 'clear', 'clearall', 'wipe', 'confirm',
  'timelimit', 'stats', 'explain', 'help', 'ident', 'days', 'off',

  // Export period tokens, as typed after `!s3 switches export`. The embed
  // echoes the token back so the file and the message agree.
  'daily', 'weekly', 'monthly'
]);

/**
 * Embed keys that carry machine values to Discord's API rather than text for
 * a human — an ISO timestamp, a colour int, a URL. Nothing here is ever
 * prose, so scanning them only produces false positives (an ISO timestamp
 * reads as the "word" T16).
 */
const NON_PROSE_FIELDS = new Set([
  'timestamp', 'color', 'colour', 'url', 'icon_url', 'proxy_icon_url',
  'image', 'thumbnail', 'video', 'provider', 'type'
]);

/**
 * Values the stubs themselves supply. These are data, not prose — a player
 * name or a layer name is legitimately unbracketed wherever it lands.
 */
const STUB_VALUES = [
  'Sumari Bala Seed v1', 'Sumari_Seed_v1', 'Narva_AAS_v1',
  'USA', 'RUS', 'RAAS', 'abc123', 'sqlite',
  'MaxPlayers', 'TimeBeforeVote',
  'Alpha', 'Bravo', 'INFANTRY',
  'ListPlayers', 'stub rcon down', 'stub db down',
  // A raw Error message: machine text the error embed prints verbatim.
  'stub failure',
  // Stored denial/removal reason keys and the join-swap type discriminator:
  // these are persisted enum values the summary prints verbatim, not prose.
  'cooldown', 'teamchange', 'swap',
  // Scramble trigger id and failure reason, as the scrambler reports them —
  // both are passed straight through by every real caller.
  'winstreak', 'no solution', 'onRoundEnded',
  // Player names the SQLite fixture seeds, and the identifier the
  // not-found case looks up. All three are data the builder echoes back.
  'Alice', 'Bob', 'Nobody',
  // The unparseable range token the invalid-range case feeds in.
  'not-a-range',
  // The unrecognised period token the export's rejection case feeds in.
  'fortnightly'
];

// ── stubs ────────────────────────────────────────────────────────

const bare = { verbose: () => {}, localize, options: {}, services: {} };

const populated = {
  verbose: () => {},
  localize,
  options: { language: 'en' },
  services: {
    serverConfig: {
      _isMounted: true,
      isLoadedSuccessfully: () => true,
      getAll: () => ({ MaxPlayers: '100', TimeBeforeVote: '30' }),
      get: () => '100'
    },
    db: { _isMounted: true, isEnabled: () => true, getDialect: () => 'sqlite' },
    gameState: {
      _isMounted: true,
      getPhase: () => 'live',
      getEndgameSubState: () => null,
      getGamemode: () => 'RAAS',
      getLayerDisplayName: () => 'Sumari Bala Seed v1',
      getLayerName: () => 'Sumari_Seed_v1',
      getMatchId: () => 'abc123',
      getRoundStartTime: () => Date.now() - 600000,
      isResolving: () => false
    },
    factions: {
      _isMounted: true,
      _hasBothTeams: () => true,
      getTeamName: (id) => (id === 1 ? 'USA' : 'RUS'),
      getTeamFaction: () => 'USA',
      isPolling: () => false
    },
    clans: {
      _isMounted: true,
      isEnabled: () => true,
      options: { minSize: 2, maxSize: 25 },
      getClans: () => [],
      getTrace: () => ({ merged: [], excluded: [], confirmed: [] })
    },
    players: {
      _isMounted: true,
      _initialSyncComplete: true,
      getAllPlayers: () => [],
      isGloballyLockedBy: () => null,
      areTeamsResolved: () => true,
      getLocks: () => []
    }
  }
};

/**
 * The other side of every binary the populated stub renders: teams
 * unresolved, sync pending, config unparsed, polling stopped. Half-localized
 * ternaries hide here — the populated branch is bracketed and the fallback
 * branch is a literal, and in English the two render identically.
 */
const flipped = {
  verbose: () => {},
  localize,
  options: { language: 'en' },
  services: {
    serverConfig: { _isMounted: true, isLoadedSuccessfully: () => false, getAll: () => ({}), get: () => null },
    db: { _isMounted: true, isEnabled: () => true, getDialect: () => 'sqlite' },
    gameState: {
      _isMounted: true,
      getPhase: () => 'staging',
      getEndgameSubState: () => null,
      getGamemode: () => 'RAAS',
      getLayerDisplayName: () => 'Sumari Bala Seed v1',
      getLayerName: () => 'Sumari_Seed_v1',
      getMatchId: () => 'abc123',
      getRoundStartTime: () => null,
      isResolving: () => true
    },
    factions: {
      _isMounted: true,
      _hasBothTeams: () => false,
      getTeamName: () => null,
      getTeamFaction: () => null,
      isPolling: () => true
    },
    clans: {
      _isMounted: true,
      isEnabled: () => true,
      options: { minSize: 2, maxSize: 25 },
      getClans: () => [],
      getTrace: () => ({ merged: [], excluded: [], confirmed: [] })
    },
    players: {
      _isMounted: true,
      _initialSyncComplete: false,
      getAllPlayers: () => [{ name: 'Alpha', eosID: 'e1', teamID: 1, squadID: null }],
      isGloballyLockedBy: () => null,
      areTeamsResolved: () => false,
      getLocks: () => []
    }
  }
};

const S3_BUILDERS = [
  'buildStatusEmbed', 'buildServicesEmbed', 'buildGameStateEmbed',
  'buildFactionsEmbed', 'buildPlayersEmbeds', 'buildClansEmbeds',
  'buildLocksEmbed', 'buildConfigEmbed', 'buildHelpEmbed'
];

const S3_STUBS = [['bare', bare], ['populated', populated], ['flipped', flipped]];

// ── the scan ─────────────────────────────────────────────────────

/**
 * Strip bracketed spans innermost-first until stable. A localized string
 * passed as a var into another localized string nests, and a single pass
 * leaves a stray ⟧ behind that reads as a false leak.
 */
function stripLocalized(str) {
  const span = new RegExp(`${OPEN}[^${OPEN}${CLOSE}]*${CLOSE}`, 'g');
  // A fenced block holding nothing bracketed is a raw dump — a stack trace,
  // a JSON payload, RCON output — machine text that stays English by the same
  // rule as an identifier, and whose words cannot be enumerated in advance.
  // A fence that DOES contain bracketed spans is a rendered table (the Elo
  // veterancy matrix), so it keeps its coverage: a literal row label there is
  // still a leak.
  let residue = str.replace(/```[\s\S]*?```/g, (block) => (block.includes(OPEN) ? block : ' '));
  let prev;
  do {
    prev = residue;
    residue = residue.replace(span, ' ');
  } while (residue !== prev);
  return residue;
}

/** Words of 3+ letters — shorter runs are units, emoji separators, or noise. */
function prosewords(residue) {
  let text = residue;
  for (const v of STUB_VALUES) text = text.split(v).join(' ');
  return (text.match(/[A-Za-z_][A-Za-z_0-9]{2,}/g) || []);
}

/** Walks a rendered embed (or array of them) and reports unlocalized prose. */
function findLeaks(where, node, path = '', leaks = []) {
  if (node === null || node === undefined) return leaks;

  if (typeof node === 'string') {
    for (const word of prosewords(stripLocalized(node))) {
      if (ALLOWED_IDENTIFIERS.has(word)) continue;
      leaks.push({ where, path, word, full: node.slice(0, 600) });
    }
    return leaks;
  }

  if (Array.isArray(node)) {
    node.forEach((v, i) => findLeaks(where, v, `${path}[${i}]`, leaks));
    return leaks;
  }

  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (NON_PROSE_FIELDS.has(k)) continue;
      findLeaks(where, v, path ? `${path}.${k}` : k, leaks);
    }
    return leaks;
  }

  return leaks;
}

function report(leaks) {
  return leaks
    .map((l) => `  ${l.where}  ${l.path}\n      unlocalized word: "${l.word}"\n      in: ${JSON.stringify(l.full)}`)
    .join('\n');
}

/** Asserts a rendered result carries no unlocalized prose. */
function assertFullyLocalized(where, rendered) {
  const leaks = findLeaks(where, rendered);
  assert.equal(
    leaks.length,
    0,
    `${leaks.length} string(s) reached the user without passing through localize().\n` +
    `Either localize them, or — if the word is an identifier a translator must ` +
    `not touch — add it to ALLOWED_IDENTIFIERS with a reason.\n\n${report(leaks)}\n`
  );
}

// ── S³ command embeds ────────────────────────────────────────────

describe('i18n render — S³ command embeds', () => {
  for (const name of S3_BUILDERS) {
    for (const [label, stub] of S3_STUBS) {
      test(`${name} (${label}) renders no unlocalized prose`, () => {
        assertFullyLocalized(`${name}/${label}`, cmds[name](stub));
      });
    }
  }

  test('the pseudo-locale actually reached the builders', () => {
    // Guards against the whole suite passing vacuously: if localize() were
    // never called, every embed would be trivially "clean".
    const rendered = JSON.stringify(cmds.buildStatusEmbed(populated));
    assert.ok(
      rendered.includes(OPEN),
      'no bracketed text in a rendered embed — the stub localize() was never called, ' +
      'so these assertions prove nothing'
    );
  });
});

// ── Switch embeds ────────────────────────────────────────────────

/**
 * A Switch plugin stub with SwitchOutput's methods attached. register()
 * installs the builders and the round-stats object onto whatever it is
 * given, so a plain object is enough — no plugin construction, no mount.
 */
function makeSwitchPlugin({ s3, s3db, rcon } = {}) {
  const plugin = {
    localize,
    verbose: () => {},
    server: {
      on: () => {},
      removeListener: () => {},
      rcon: rcon || { execute: async () => { throw new Error('stub rcon down'); } }
    },
    constructor: { version: '2.3.0' },
    options: {
      switchCooldownMinutes: 0,
      switchCooldownHours: 6,
      switchEnabledMinutes: 20,
      queueTimeoutMinutes: 5,
      maxSwitchTokens: 2,
      scrambleLockdownMinutes: 10,
      pruneInactivePlayerDays: 30
    },
    _s3: s3 ?? null,
    _s3db: s3db ?? null,
    _switchQueue: [],
    _changeTeamDisabled: false,
    _gameStartTs: Date.now() - 300000,
    _restartedThisRound: false,
    timeLimitEnabled: true,
    isLiberalMode: () => false,
    getLiveRestrictionState: async () => null,
    _parseRoundStatsField: () => null,
    _parseStatsNum: () => 0
  };

  SwitchOutput.register(plugin);
  return plugin;
}

/**
 * A round with at least one entry in every bucket the summary can print, so
 * every conditional field is rendered rather than skipped.
 *
 * Built from the plugin's own _initRoundStats() rather than an object literal
 * — the bucket names are then whatever the code says they are, and a renamed
 * bucket shows up as an empty section here instead of a stub that quietly
 * stops matching.
 */
function populatedRoundStats(plugin) {
  const s = plugin._initRoundStats();

  s.instantSwitches = [{ name: 'Alpha', eosID: 'e1', fromTeam: 1, toTeam: 2, gamePhase: 'live' }];
  s.deniedSwitches = [{ name: 'Bravo', eosID: 'e2', reason: 'cooldown', gamePhase: 'live' }];
  s.queueTeamTrades = [{
    p1Name: 'Alpha', p2Name: 'Bravo',
    p1FromTeam: 1, p1ToTeam: 2, p2FromTeam: 2, p2ToTeam: 1,
    p1DurationSeconds: 30, p2DurationSeconds: 30, gamePhase: 'live'
  }];
  s.queueNormal = [{ name: 'Alpha', eosID: 'e1', currentTeamID: 1, toTeam: 2, queueDurationSeconds: 45, gamePhase: 'live' }];
  s.queueJoinSwaps = [{ name: 'Bravo', eosID: 'e2', type: 'swap', currentTeamID: 2, toTeam: 1, queueDurationSeconds: 60, gamePhase: 'live' }];
  s.queueExpiries = [{ name: 'Alpha', eosID: 'e1', queueDurationSeconds: 300, gamePhase: 'live' }];
  s.queueDisconnects = [{ name: 'Bravo', eosID: 'e2', currentTeamID: 1, targetTeamID: 2, queueDurationSeconds: 20, gamePhase: 'live' }];
  s.queueCancels = [{ name: 'Alpha', eosID: 'e1' }];
  s.queueRemovals = [{ name: 'Bravo', eosID: 'e2', reason: 'teamchange', gamePhase: 'live' }];
  s.queueTimeoutSwitches = [{ name: 'Alpha', eosID: 'e1', currentTeamID: 1, toTeam: 2, queueDurationSeconds: 120, gamePhase: 'live' }];
  s.maxQueueSize = 3;
  s.queueDurationsMs = [45000, 90000];

  return s;
}

describe('i18n render — Switch embeds', () => {
  test('round summary (populated) renders no unlocalized prose', () => {
    const plugin = makeSwitchPlugin();
    plugin._roundStats = populatedRoundStats(plugin);
    const embed = plugin._buildRoundSummaryEmbed();
    assert.ok(embed, 'the summary builder returned nothing — stats stub is wrong');
    assertFullyLocalized('roundSummary/populated', embed);
  });

  test('round summary (empty round) renders no unlocalized prose', () => {
    // The "No Activity" branch — a separate field with its own copy.
    const plugin = makeSwitchPlugin();
    plugin._roundStats = plugin._initRoundStats();
    assertFullyLocalized('roundSummary/empty', plugin._buildRoundSummaryEmbed());
  });

  test('round summary (liberal mode, restarted) renders no unlocalized prose', () => {
    // The other branch of two ternaries: Liberal vs Standard, and the
    // "SquadJS was restarted" notice field that only appears mid-round.
    const plugin = makeSwitchPlugin();
    plugin._roundStats = populatedRoundStats(plugin);
    plugin._roundStats.wasLiberalMode = true;
    plugin._restartedThisRound = true;
    assertFullyLocalized('roundSummary/liberal', plugin._buildRoundSummaryEmbed());
  });

  test('diag embed (all services down) renders no unlocalized prose', async () => {
    // Every health check fails: this is the branch that produced the
    // hardcoded 'Unknown' / 'N/A' / 'Not available' labels.
    const plugin = makeSwitchPlugin({});
    assertFullyLocalized('switchDiag/down', await plugin._buildSwitchDiagEmbed());
  });

  test('diag embed (all services up) renders no unlocalized prose', async () => {
    const plugin = makeSwitchPlugin({
      s3: {
        gameState: { isReady: () => true },
        players: { isReady: () => true, canAct: true }
      },
      s3db: { isReady: () => true, sequelize: { authenticate: async () => {} } },
      rcon: { execute: async () => 'ok' }
    });
    assertFullyLocalized('switchDiag/up', await plugin._buildSwitchDiagEmbed());
  });

  test('diag embed (S³ partially ready) renders no unlocalized prose', async () => {
    // The 🟠 branch. It used to be selected by comparing the label against
    // the English word 'Partial', which silently picked 🔴 in every other
    // language — the comparison is now a flag, and this covers it.
    const plugin = makeSwitchPlugin({
      s3: {
        gameState: { isReady: () => true },
        players: { isReady: () => false, canAct: false }
      }
    });
    assertFullyLocalized('switchDiag/partial', await plugin._buildSwitchDiagEmbed());
  });
});

// ── Switch explain embeds ────────────────────────────────────────

describe('i18n render — Switch explain embeds', () => {
  /**
   * _buildExplainMessages() returns the whole explain sequence in one call,
   * so a single render covers the intro, balance, cooldown, time-window,
   * scramble, special-cases and tips embeds together.
   */
  function makeExplainPlugin(overrides = {}) {
    const plugin = {
      localize,
      verbose: () => {},
      server: { on: () => {}, removeListener: () => {} },
      channel: null,
      constructor: { version: '2.3.0' },
      options: {
        switchCooldownMinutes: 0,
        switchCooldownHours: 6,
        switchEnabledMinutes: 20,
        queueTimeoutMinutes: 5,
        maxSwitchTokens: 2,
        scrambleLockdownMinutes: 10,
        seedBonusTokens: 1,
        queueTimeoutSwitchEnabled: true,
        ...(overrides.options || {})
      },
      _s: null,
      _isSeedBonusEnabled: () => true,
      _computeMedianFromMs: () => 0,
      _parseMode: () => null,
      _parseMoveTypes: () => null,
      _parseDenialReasons: () => null,
      _parseQueueOutcomes: () => null,
      _parseRoundStatsField: () => null,
      ...overrides
    };
    SwitchExplain.register(plugin);
    return plugin;
  }

  test('explain sequence (token cooldown) renders no unlocalized prose', () => {
    const plugin = makeExplainPlugin();
    const embeds = plugin._buildExplainMessages();
    assert.ok(embeds.length > 0, 'explain produced no embeds — the stub is wrong');
    assertFullyLocalized('explain/tokens', embeds);
  });

  test('explain sequence (flat cooldown) renders no unlocalized prose', () => {
    // maxSwitchTokens = 0 selects _buildFlatCooldownEmbed over
    // _buildTokenEmbed — a whole alternate embed, not just a changed line.
    const plugin = makeExplainPlugin({ options: { maxSwitchTokens: 0, switchCooldownMinutes: 15 } });
    assertFullyLocalized('explain/flatCooldown', plugin._buildExplainMessages());
  });

  test('explain sequence (seed bonus off) renders no unlocalized prose', () => {
    const plugin = makeExplainPlugin({ _isSeedBonusEnabled: () => false });
    assertFullyLocalized('explain/noSeedBonus', plugin._buildExplainMessages());
  });
});

// ── Team Balancer embeds ─────────────────────────────────────────

describe('i18n render — Team Balancer embeds', () => {
  function makeTb(overrides = {}) {
    return {
      localize,
      verbose: () => {},
      ready: true,
      manuallyDisabled: false,
      constructor: { version: '3.1.0' },
      server: {
        currentLayer: null,
        players: [
          { name: 'Alpha', eosID: 'e1', teamID: 1, squadID: '1' },
          { name: 'Bravo', eosID: 'e2', teamID: 2, squadID: '1' }
        ],
        squads: [
          { squadID: '1', teamID: 1, squadName: 'INFANTRY' },
          { squadID: '1', teamID: 2, squadName: 'INFANTRY' }
        ]
      },
      getTeamName: (id) => (id === 1 ? 'USA' : 'RUS'),
      seedAutoScrambleStatus: () => null,
      winStreakTeam: 1,
      winStreakCount: 2,
      consecutiveWinsTeam: 1,
      consecutiveWinsCount: 2,
      lastScrambleTime: Date.now() - 3600000,
      swapExecutor: null,
      _scrambleInProgress: false,
      _scramblePending: false,
      options: {
        enabled: true,
        maxStreak: 3,
        maxConsecutiveWinsWithoutThreshold: 4,
        scrambleMode: 'micro',
        minPlayersForScramble: 40,
        clanMaxSize: 25
      },
      ...overrides
    };
  }

  test('status embed (running) renders no unlocalized prose', () => {
    assertFullyLocalized('tb/status', DiscordHelpers.buildStatusEmbed(makeTb()));
  });

  test('status embed (not ready) renders no unlocalized prose', () => {
    assertFullyLocalized('tb/statusNotReady', DiscordHelpers.buildStatusEmbed(makeTb({ ready: false })));
  });

  test('status embed (manually disabled) renders no unlocalized prose', () => {
    assertFullyLocalized('tb/statusDisabled', DiscordHelpers.buildStatusEmbed(makeTb({ manuallyDisabled: true })));
  });

  test('status embed (no streaks, never scrambled) renders no unlocalized prose', () => {
    // The fallback branch of every streak ternary and the "never scrambled"
    // default — the half that only renders on a fresh server.
    const base = makeTb();
    assertFullyLocalized('tb/statusFresh', DiscordHelpers.buildStatusEmbed(makeTb({
      winStreakTeam: null,
      winStreakCount: 0,
      consecutiveWinsTeam: null,
      consecutiveWinsCount: 0,
      lastScrambleTime: null,
      options: { ...base.options, maxConsecutiveWinsWithoutThreshold: 0 }
    })));
  });

  test('diag embeds render no unlocalized prose', () => {
    assertFullyLocalized('tb/diag', DiscordHelpers.buildDiagEmbeds(makeTb()));
  });

  test('win streak embed renders no unlocalized prose', () => {
    assertFullyLocalized('tb/winStreak', DiscordHelpers.buildWinStreakEmbed(makeTb(), 'USA', 1, 3, 3, 120, false));
  });

  test('win streak embed (dominant) renders no unlocalized prose', () => {
    assertFullyLocalized('tb/winStreakDominant', DiscordHelpers.buildWinStreakEmbed(makeTb(), 'USA', 1, 3, 3, 400, true));
  });

  test('scramble triggered embed renders no unlocalized prose', () => {
    assertFullyLocalized('tb/scrambleTriggered', DiscordHelpers.buildScrambleTriggeredEmbed(makeTb(), 'winstreak', 'USA', 3, 30));
  });

  test('scramble completed embed renders no unlocalized prose', () => {
    assertFullyLocalized('tb/scrambleCompleted', DiscordHelpers.buildScrambleCompletedEmbed(makeTb(), 10, 9, 1, 0, 1500, ['Alpha']));
  });

  test('scramble failed embed renders no unlocalized prose', () => {
    assertFullyLocalized('tb/scrambleFailed', DiscordHelpers.buildScrambleFailedEmbed('no solution', 900, makeTb()));
  });

  test('fatal error embed renders no unlocalized prose', () => {
    assertFullyLocalized('tb/fatalError', DiscordHelpers.buildFatalErrorEmbed(new Error('stub failure'), 'onRoundEnded', makeTb()));
  });
});

// ── Elo Tracker embeds ───────────────────────────────────────────

describe('i18n render — Elo Tracker embeds', () => {
  const tracker = { localize, verbose: () => {}, options: {}, constructor: { version: '1.9.0' } };

  /** One rated player's before/after, as the spread snapshot carries it. */
  const spreadRow = (name, label) => ({
    name, label, deltaMu: 0.42, muBefore: 25.1, muAfter: 25.5
  });

  /** One team's aggregate, as the round embeds and the matrix table read it. */
  const teamSide = (avgMu = 25.3) => ({
    count: 40,
    avgMu,
    avgRegMu: avgMu + 0.4,
    top15Mu: avgMu + 1.2,
    veterancy: 0.75,
    avgDeltaMu: 0.31,
    avgDeltaSigma: -0.08,
    tierStats: { vCount: 4, pCount: 6, rCount: 30 },
    spreadSnapshot: [spreadRow('Alpha', '🥇'), spreadRow('Bravo', '🥈')]
  });

  /**
   * `skewed` drives the "team N has the advantage" half of every balance
   * ternary; `level` drives the "tie"/"balanced" half. Both branches are
   * English-identical, so only rendering both distinguishes a localized
   * fallback from a hardcoded one.
   */
  const roundData = (skew = true) => ({
    layerName: 'Narva_AAS_v1',
    winningTeamID: 1,
    ticketDiff: 120,
    roundDuration: 1800,
    roundStartTime: Date.now() - 600000,
    totalPlayerCount: 80,
    playersUpdatedCount: 76,
    calculationDuration: 850,
    matchVeterancy: 0.75,
    muDelta: skew ? 1.4 : 0,
    top15Delta: skew ? 2.1 : 0,
    regDelta: skew ? 6 : 0,
    team1Summary: teamSide(skew ? 26.7 : 25.3),
    team2Summary: teamSide(25.3),
    liveT1: teamSide(skew ? 26.7 : 25.3),
    liveT2: teamSide(25.3),
    t1: teamSide(skew ? 26.7 : 25.3),
    t2: teamSide(25.3)
  });

  test('round summary embed renders no unlocalized prose', () => {
    assertFullyLocalized('elo/roundSummary', EloDiscord.buildRoundSummaryEmbed(tracker, roundData()));
  });

  test('round summary embed (balanced, draw) renders no unlocalized prose', () => {
    assertFullyLocalized('elo/roundSummaryDraw',
      EloDiscord.buildRoundSummaryEmbed(tracker, { ...roundData(false), winningTeamID: null }));
  });

  test('round start embed renders no unlocalized prose', () => {
    assertFullyLocalized('elo/roundStart', EloDiscord.buildRoundStartEmbed(tracker, roundData()));
  });

  test('round start embed (balanced) renders no unlocalized prose', () => {
    assertFullyLocalized('elo/roundStartBalanced', EloDiscord.buildRoundStartEmbed(tracker, roundData(false)));
  });

  test('round start embed (manual) renders no unlocalized prose', () => {
    assertFullyLocalized('elo/roundStartManual', EloDiscord.buildRoundStartEmbed(tracker, roundData(), 'manual'));
  });

  test('round start embed (warming) renders no unlocalized prose', () => {
    assertFullyLocalized('elo/roundStartWarming', EloDiscord.buildRoundStartEmbed(tracker, { status: 'warming' }));
  });

  test('round start embed (empty server) renders no unlocalized prose', () => {
    assertFullyLocalized('elo/roundStartEmpty', EloDiscord.buildRoundStartEmbed(tracker, { status: 'empty', totalPlayerCount: 0 }));
  });

  test('round skipped embed renders no unlocalized prose', () => {
    // Every real caller passes a localized reason, so the stub does too —
    // a raw literal here would be testing the test, not the builder.
    assertFullyLocalized('elo/roundSkipped', EloDiscord.buildRoundSkippedEmbed(tracker, localize('eloTracker.embeds.roundSkipped.pluginNotReady'), 12, 'Narva_AAS_v1'));
  });

  test('admin confirm embed renders no unlocalized prose', () => {
    assertFullyLocalized('elo/adminConfirm', EloDiscord.buildAdminConfirmEmbed(tracker, localize('eloTracker.embeds.eloReset'), localize('eloTracker.embeds.allRatingsRoundHistory')));
  });

  test('error embed renders no unlocalized prose', () => {
    assertFullyLocalized('elo/error', EloDiscord.buildErrorEmbed(tracker, localize('eloTracker.embeds.roundInfo'), new Error('stub failure')));
  });
});

// ── in-game (RCON) command responses ─────────────────────────────

/**
 * The embed builders above are only half of what a player reads. Admin
 * commands answer in-game through respond()/rcon.warn(), and that text is
 * assembled inline in the command handler rather than in a named builder —
 * which is exactly why it drifted: !teambalancer status was printing a
 * hardcoded 'Disabled', 'Never', 'Active', 'Yes'/'No' and a bare
 * `Version: x.y.z` long after the embed beside it was fully localized.
 *
 * Capturing respond() and scanning it with the same rule closes that half.
 */
describe('i18n render — Team Balancer in-game responses', () => {
  /** Runs a handler with sleeps collapsed, and returns everything it said. */
  async function capture(fn) {
    const said = [];
    const realSetTimeout = globalThis.setTimeout;
    // The diag command paces its three pages 5.5s apart so RCON does not
    // clip them. Under test that is 16s of nothing; fire immediately.
    globalThis.setTimeout = (cb) => realSetTimeout(cb, 0);
    try {
      await fn(said);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.ok(said.length > 0, 'the handler answered nothing — the stub is wrong');
    return said;
  }

  function makeTbPlugin(overrides = {}) {
    const tb = {
      localize,
      ready: true,
      manuallyDisabled: false,
      constructor: { version: '3.1.0' },
      db: { saveManuallyDisabledState: async () => {} },
      s3db: null,
      _s3: null,
      layerNameCached: null,
      gameModeCached: null,
      discordChannel: null,
      discordReportChannel: null,
      winStreakTeam: 1,
      winStreakCount: 2,
      consecutiveWinsTeam: 1,
      consecutiveWinsCount: 2,
      lastScrambleTime: Date.now() - 3600000,
      _scramblePending: false,
      _scrambleInProgress: false,
      seedAutoScrambleStatus: () => localize('teamBalancer.status.disabled'),
      seedScrambleOffNote: () => '',
      // The diag scrambler test calls this before anything else; without it
      // the whole page collapses into one localized "FAIL: <TypeError>" and
      // none of the text it should be checking ever renders.
      transformSquadJSData: (squads, players) => ({ squads, players }),
      getTeamName: (id) => (id === 1 ? 'USA' : 'RUS'),
      server: {
        plugins: [],
        players: [{ name: 'Alpha', teamID: 1 }, { name: 'Bravo', teamID: 2 }],
        squads: [{ squadID: '1', teamID: 1 }, { squadID: '1', teamID: 2 }],
        rcon: { warn: async () => {}, broadcast: async () => {} },
        getAdminPermBySteamID: async () => ({ canseeadminchat: true })
      },
      RconMessages: { prefix: '[TB]', system: { trackingDisabled: 'x' } },
      options: {
        devMode: true,
        enableWinStreakTracking: true,
        maxWinStreak: 3,
        maxConsecutiveWinsWithoutThreshold: 4,
        useEloForBalance: true,
        enableSingleRoundScramble: true,
        singleRoundScrambleThreshold: 250,
        scramblePercentage: 0.5,
        scrambleAnnouncementDelay: 30,
        seedScrambleAnnouncementDelay: 10,
        maxScrambleCompletionTime: 8000,
        invasionAttackTeamThreshold: 400,
        invasionDefenceTeamThreshold: 300
      },
      ...overrides
    };
    TBCommands.register(tb);
    return tb;
  }

  const player = { name: 'Alpha', steamID: '765611' };

  /** Replaces respond() after registration so every page is collected. */
  function tap(tb, said) {
    tb.respond = async (_p, msg) => { said.push(msg); return msg; };
  }

  test('!teambalancer (public info) renders no unlocalized prose', async () => {
    const said = await capture(async (out) => {
      const tb = makeTbPlugin();
      tap(tb, out);
      await tb.onChatMessage({ message: '!teambalancer', steamID: player.steamID, player });
    });
    assertFullyLocalized('tb-ingame/info', said);
  });

  test('!teambalancer (fresh server) renders no unlocalized prose', async () => {
    // Never scrambled, no streak, not ready — the fallback half of every
    // ternary in the public info block.
    const said = await capture(async (out) => {
      const tb = makeTbPlugin({ ready: false, lastScrambleTime: null, winStreakCount: 0, winStreakTeam: null });
      tap(tb, out);
      await tb.onChatMessage({ message: '!teambalancer', steamID: player.steamID, player });
    });
    assertFullyLocalized('tb-ingame/infoFresh', said);
  });

  test('!teambalancer status renders no unlocalized prose', async () => {
    const said = await capture(async (out) => {
      const tb = makeTbPlugin();
      tap(tb, out);
      await tb.onChatCommand({ message: 'status', chat: 'ChatAdmin', steamID: player.steamID, player });
    });
    assertFullyLocalized('tb-ingame/status', said);
  });

  test('!teambalancer status (fresh, elo off, consec off) renders no unlocalized prose', async () => {
    const said = await capture(async (out) => {
      const tb = makeTbPlugin({
        ready: false,
        lastScrambleTime: null,
        winStreakTeam: null,
        consecutiveWinsTeam: null
      });
      tb.options.maxConsecutiveWinsWithoutThreshold = 0;
      tb.options.useEloForBalance = false;
      tap(tb, out);
      await tb.onChatCommand({ message: 'status', chat: 'ChatAdmin', steamID: player.steamID, player });
    });
    assertFullyLocalized('tb-ingame/statusFresh', said);
  });

  test('!teambalancer diag renders no unlocalized prose', async () => {
    const said = await capture(async (out) => {
      const tb = makeTbPlugin();
      tap(tb, out);
      await tb.onChatCommand({ message: 'diag', chat: 'ChatAdmin', steamID: player.steamID, player });
    });
    assertFullyLocalized('tb-ingame/diag', said);
  });

  test('!teambalancer diag (disabled, single-round off) renders no unlocalized prose', async () => {
    const said = await capture(async (out) => {
      const tb = makeTbPlugin({ manuallyDisabled: true, _scramblePending: true, _scrambleInProgress: true });
      tb.options.enableSingleRoundScramble = false;
      tap(tb, out);
      await tb.onChatCommand({ message: 'diag', chat: 'ChatAdmin', steamID: player.steamID, player });
    });
    assertFullyLocalized('tb-ingame/diagDisabled', said);
  });

  test('!teambalancer <unknown> renders no unlocalized prose', async () => {
    const said = await capture(async (out) => {
      const tb = makeTbPlugin();
      tap(tb, out);
      await tb.onChatCommand({ message: 'nonsense', chat: 'ChatAdmin', steamID: player.steamID, player });
    });
    assertFullyLocalized('tb-ingame/unknown', said);
  });
});

// ── Elo leaderboard / player / clan embeds ───────────────────────

describe('i18n render — Elo Tracker leaderboards', () => {
  const tracker = { localize, verbose: () => {}, options: {}, constructor: { version: '1.9.0' } };

  const eloPlayer = (name = 'Alpha') => ({
    name, eosID: 'e1', mu: 26.4, sigma: 4.1, wins: 30, losses: 20, roundsPlayed: 50
  });

  test('player stats embed renders no unlocalized prose', () => {
    assertFullyLocalized('elo/playerStats',
      EloDiscord.buildPlayerStatsEmbed(tracker, eloPlayer(), 7, 120, 300, false,
        [{ ...eloPlayer('Alpha'), actualRank: 7 }, { ...eloPlayer('Bravo'), actualRank: 8 }], 10, null));
  });

  test('player stats embed (provisional, rank 1) renders no unlocalized prose', () => {
    // Provisional skips the top-percent branch entirely and prints a
    // different reliability line — the other half of two ternaries.
    assertFullyLocalized('elo/playerStatsProvisional',
      EloDiscord.buildPlayerStatsEmbed(tracker, { ...eloPlayer(), roundsPlayed: 3, sigma: 7.9 },
        1, 120, 300, true, null, 10, null));
  });

  test('leaderboard embed renders no unlocalized prose', () => {
    assertFullyLocalized('elo/leaderboard',
      EloDiscord.buildLeaderboardEmbed(tracker, [eloPlayer('Alpha'), eloPlayer('Bravo')], 10, 1, 120, 300, 2));
  });

  test('leaderboard embed (empty page) renders no unlocalized prose', () => {
    assertFullyLocalized('elo/leaderboardEmpty',
      EloDiscord.buildLeaderboardEmbed(tracker, [], 10, 1, 0, 0, null));
  });

  test('clan stats embed renders no unlocalized prose', () => {
    const members = [eloPlayer('Alpha'), eloPlayer('Bravo')];
    assertFullyLocalized('elo/clanStats',
      EloDiscord.buildClanStatsEmbed(tracker, 'INFANTRY', members, 2, 40, 30, 25.6, 3.9, 21.2, members, 10));
  });

  test('clan stats embed (no ranked members) renders no unlocalized prose', () => {
    assertFullyLocalized('elo/clanStatsUnranked',
      EloDiscord.buildClanStatsEmbed(tracker, 'INFANTRY', [], 0, 0, 0, 0, 0, -999, [], 10));
  });

  test('clans leaderboard embed renders no unlocalized prose', () => {
    assertFullyLocalized('elo/clansLeaderboard',
      EloDiscord.buildClansLeaderboardEmbed(tracker, [
        { displayTag: 'INFANTRY', avgCsr: 22.4, members: [eloPlayer()], wr: 55 }
      ], 10, 3));
  });

  test('clans leaderboard embed (none qualify) renders no unlocalized prose', () => {
    assertFullyLocalized('elo/clansLeaderboardEmpty',
      EloDiscord.buildClansLeaderboardEmbed(tracker, [], 10, 3));
  });
});

// ── S³ migration embeds ──────────────────────────────────────────

describe('i18n render — S³ migration embeds', () => {
  const plugin = { localize, verbose: () => {}, options: {}, constructor: { version: '1.7.0' } };
  const pending = [
    { pluginName: 'Switch', currentVersion: 0, expectedVersion: 3, behind: 3 },
    { pluginName: 'TeamBalancer', currentVersion: 1, expectedVersion: 2, behind: 1 }
  ];

  for (const status of ['pending', 'running', 'complete', 'failed']) {
    test(`migration embed (${status}) renders no unlocalized prose`, () => {
      const result = status === 'complete' || status === 'failed'
        ? { applied: 1, failed: status === 'failed' ? 1 : 0, errors: status === 'failed' ? ['stub failure'] : [] }
        : null;
      assertFullyLocalized(`s3/migration-${status}`, buildMigrationEmbed(plugin, pending, status, result));
    });
  }
});

// ── RCON broadcast strings ───────────────────────────────────────

describe('i18n render — Team Balancer RCON broadcasts', () => {
  test('every RconMessages leaf renders no unlocalized prose', () => {
    // Built as catalogue-backed getters, so this is cheap to keep true — and
    // it stays true only while nobody adds a plain string beside them. The
    // scramble countdown and "teams have been scrambled" broadcasts every
    // player on the server reads are in here.
    const tb = { localize };
    TBCommands.register(tb);
    const messages = tb.RconMessages;
    assert.ok(messages && Object.keys(messages).length > 1, 'no RCON messages were built');
    assertFullyLocalized('tb/rconMessages', messages);
  });
});

// ── Switch 7-day aggregate ───────────────────────────────────────

describe('i18n render — Switch seven-day stats', () => {
  /**
   * This embed sums the stored round rows, so the stub is getRoundStatsTotals
   * rather than a Discord channel. Two shapes matter: a window with waits in
   * it, which renders the queue-wait sentence, and one without, which does
   * not — the two sentences are written in different places.
   */
  function makeExplainStatsPlugin(totals) {
    const plugin = {
      localize,
      verbose: () => {},
      server: { on: () => {}, removeListener: () => {} },
      constructor: { version: '2.3.0' },
      options: {
        switchCooldownMinutes: 0, switchCooldownHours: 6, switchEnabledMinutes: 20,
        queueTimeoutMinutes: 5, maxSwitchTokens: 2, scrambleLockdownMinutes: 10,
        seedBonusTokens: 1, queueTimeoutSwitchEnabled: true
      },
      _s: null,
      _isSeedBonusEnabled: () => true,
      _computeMedianFromMs: (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : 0),
      getRoundStatsTotals: async () => totals
    };
    SwitchExplain.register(plugin);
    return plugin;
  }

  const storedTotals = (over = {}) => ({
    rounds: 12,
    standardRounds: 11,
    liberalRounds: 1,
    success: 40, failed: 3, denied: 9,
    instant: 25, queueNormal: 10, queueTeamTrade: 2, queueJoinSwap: 2, queueTimeoutSwitch: 1,
    outcomeExpired: 3, outcomeDC: 1, outcomeCancelled: 1, outcomeRemoved: 0,
    denialCooldown: 5, denialTimeWindow: 3, denialScrambleLock: 1,
    denialRecentSwitch: 0, denialOther: 0,
    toT1: 20, toT2: 20,
    maxQueueSize: 6,
    totalQueueEntries: 20,
    queueDurationsMs: [60000, 80000],
    medianDurationsMs: [68000],
    missingMedian: 0,
    scrapedRounds: 0,
    truncated: false,
    ...over
  });

  test('seven-day stats embed renders no unlocalized prose', async () => {
    const plugin = makeExplainStatsPlugin(storedTotals());
    const embed = await plugin._buildSevenDayStatsEmbed();
    assert.ok(embed, 'no embed was built — the totals stub is wrong');
    assertFullyLocalized('switch/sevenDayStats', embed);
  });

  test('seven-day stats embed (nobody queued) renders no unlocalized prose', async () => {
    const plugin = makeExplainStatsPlugin(storedTotals({ queueDurationsMs: [], medianDurationsMs: [] }));
    const embed = await plugin._buildSevenDayStatsEmbed();
    assert.ok(embed, 'a window with no queue waits is still a window with rounds in it');
    assertFullyLocalized('switch/sevenDayStatsNoQueue', embed);
  });

  test('seven-day stats embed (no rounds stored) renders no unlocalized prose', async () => {
    const plugin = makeExplainStatsPlugin(storedTotals({ standardRounds: 0 }));
    const embed = await plugin._buildSevenDayStatsEmbed();
    if (embed) assertFullyLocalized('switch/sevenDayStatsEmpty', embed);
  });
});

// ── S³ switches / karma embeds (real SQLite) ─────────────────────

/**
 * The last two S³ builders, and the only ones that need a database: they
 * read S3_PlayerEvents and TB_RoundReport before they can format anything.
 * The schemas mirror logging-service.js and team-balancer.js, same as
 * test-s3-commands-embeds.js — a stub object would render the empty-state
 * branch only, and the empty state is not where the prose is.
 *
 * Three module-private builders hang off these two and are reachable no
 * other way: buildAvailabilityWarningEmbed (no db, and db-with-no-rows),
 * buildPlayerNotFoundEmbed (an identifier nothing matches) and
 * buildAmbiguousPlayerEmbed (one name, two eosIDs).
 */
describe('i18n render — S³ switches and karma embeds', () => {
  const NOW = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  async function fixture(fn) {
    const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
    const db = new DBService({ sequelize: seq });
    await db.mount();

    const eventsModel = db.defineModel(
      'S3PlayerEvents',
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        matchId: { type: DataTypes.STRING, allowNull: true },
        roundStartTime: { type: DataTypes.BIGINT, allowNull: true },
        ts: { type: DataTypes.BIGINT, allowNull: false },
        eventType: { type: DataTypes.STRING, allowNull: false },
        eosID: { type: DataTypes.STRING, allowNull: true },
        steamID: { type: DataTypes.STRING, allowNull: true },
        name: { type: DataTypes.STRING, allowNull: true },
        teamID: { type: DataTypes.INTEGER, allowNull: true },
        squadID: { type: DataTypes.INTEGER, allowNull: true },
        oldTeamID: { type: DataTypes.INTEGER, allowNull: true },
        newTeamID: { type: DataTypes.INTEGER, allowNull: true },
        source: { type: DataTypes.STRING, allowNull: true },
        betweenRounds: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 0 },
        t1: { type: DataTypes.INTEGER, allowNull: true },
        t2: { type: DataTypes.INTEGER, allowNull: true }
      },
      { tableName: 'T_PE', timestamps: false, exportTier: 'logging' }
    );

    const roundReportModel = db.defineModel(
      'TB_RoundReport',
      {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        matchId: { type: DataTypes.STRING(20), allowNull: true },
        roundStartTime: { type: DataTypes.BIGINT, allowNull: true },
        ts: { type: DataTypes.BIGINT, allowNull: false },
        winningTeamID: { type: DataTypes.INTEGER, allowNull: true },
        scrambled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        scrambleType: { type: DataTypes.STRING(100), allowNull: true },
        gameMode: { type: DataTypes.STRING(100), allowNull: true },
        layerName: { type: DataTypes.STRING(150), allowNull: true }
      },
      { tableName: 'T_RR', timestamps: false, exportTier: 'historical' }
    );

    await eventsModel.sync({ force: true });
    await roundReportModel.sync({ force: true });

    try {
      return await fn(db, { eventsModel, roundReportModel });
    } finally {
      try { await db.unmount(); } catch { /* best effort */ }
      try { await seq.close(); } catch { /* best effort */ }
    }
  }

  const dbPlugin = (db) => ({ verbose: () => {}, localize, options: { ignoredGameModes: [] }, services: { db } });

  /** Two rounds, two switchers, one of them switching to the winning side. */
  async function seed({ eventsModel, roundReportModel }) {
    await eventsModel.bulkCreate([
      { matchId: 'm1', ts: NOW - DAY, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'Alice', source: 'Player-Self', oldTeamID: 1, newTeamID: 2, t1: 40, t2: 40 },
      { matchId: 'm1', ts: NOW - DAY, eventType: 'TEAM_CHANGE', eosID: 'p2', name: 'Bob', source: 'Admin', oldTeamID: 2, newTeamID: 1, t1: 40, t2: 40 },
      { matchId: 'm2', ts: NOW - DAY / 2, eventType: 'TEAM_CHANGE', eosID: 'p1', name: 'Alice', source: 'Switch-Plugin', oldTeamID: 2, newTeamID: 1, t1: 41, t2: 39 },
      { matchId: 'm1', ts: NOW - DAY, eventType: 'JOIN', eosID: 'p1', name: 'Alice', teamID: 1 },
      { matchId: 'm2', ts: NOW - DAY / 2, eventType: 'JOIN', eosID: 'p1', name: 'Alice', teamID: 2 },
      { matchId: 'm1', ts: NOW - DAY, eventType: 'JOIN', eosID: 'p2', name: 'Bob', teamID: 2 }
    ]);
    await roundReportModel.bulkCreate([
      { matchId: 'm1', ts: NOW - DAY, winningTeamID: 2, gameMode: 'RAAS', layerName: 'Narva_AAS_v1' },
      { matchId: 'm2', ts: NOW - DAY / 2, winningTeamID: 1, gameMode: 'RAAS', layerName: 'Narva_AAS_v1' }
    ]);
  }

  test('switches leaderboard renders no unlocalized prose', () =>
    fixture(async (db, models) => {
      await seed(models);
      assertFullyLocalized('s3/switchesLeaderboard', await cmds.buildSwitchesEmbed(dbPlugin(db), null, null));
    }));

  test('switches single-player renders no unlocalized prose', () =>
    fixture(async (db, models) => {
      await seed(models);
      assertFullyLocalized('s3/switchesPlayer', await cmds.buildSwitchesEmbed(dbPlugin(db), 'Alice', null));
    }));

  test('karma embed renders no unlocalized prose', () =>
    fixture(async (db, models) => {
      await seed(models);
      assertFullyLocalized('s3/karma', await cmds.buildKarmaEmbed(dbPlugin(db), 'Alice', null));
    }));

  /**
   * buildKarmaVerdict is a module-private six-way ladder, and the embed above
   * renders exactly one of its branches — whichever band its two seeded
   * rounds happen to land in. The other five are reached by seeding the win
   * rate that selects each one.
   *
   * Nothing here seeds a JOIN event, so games played is 0 and the summary
   * takes its no-switch-rate wording — the other side of a ternary the suite
   * above only ever renders one half of.
   */
  async function seedKarmaBand({ eventsModel, roundReportModel }, rounds, wins) {
    const events = [];
    const reports = [];
    for (let i = 0; i < rounds; i++) {
      const matchId = `kb${i}`;
      const ts = NOW - (i + 1) * DAY;
      events.push({ matchId, ts, eventType: 'TEAM_CHANGE', eosID: 'k1', name: 'Alice', source: 'Player-Self', oldTeamID: 1, newTeamID: 2 });
      // Alice always moves to team 2, so a round counts as a win exactly when
      // team 2 won it — win rate is then just wins/rounds.
      reports.push({ matchId, ts, winningTeamID: i < wins ? 2 : 1, gameMode: 'RAAS', layerName: 'Narva_AAS_v1' });
    }
    await eventsModel.bulkCreate(events);
    await roundReportModel.bulkCreate(reports);
  }

  // Chosen to sit either side of the 0.60 / 0.55 / 0.45 / 0.40 boundaries,
  // plus one sample too small for the verdict to read at all.
  const KARMA_BANDS = [
    ['strongWinner', 12, 12],  // 100.0%
    ['leansWinner', 12, 7],    //  58.3%
    ['neutral', 12, 6],        //  50.0%
    ['leansLoser', 12, 5],     //  41.7%
    ['strongLoser', 12, 0],    //   0.0%
    ['notEnough', 4, 2]        // under the five-switch sample floor
  ];

  for (const [band, rounds, wins] of KARMA_BANDS) {
    test(`karma verdict (${band}) renders no unlocalized prose`, () =>
      fixture(async (db, models) => {
        await seedKarmaBand(models, rounds, wins);
        assertFullyLocalized(`s3/karmaVerdict/${band}`, await cmds.buildKarmaEmbed(dbPlugin(db), 'Alice', null));
      }));
  }

  test('switches invalid range renders no unlocalized prose', () =>
    fixture(async (db, models) => {
      await seed(models);
      assertFullyLocalized('s3/switchesBadRange', await cmds.buildSwitchesEmbed(dbPlugin(db), null, 'not-a-range'));
    }));

  // ── the three private builders ─────────────────────────────────

  test('availability warning (no database) renders no unlocalized prose', async () => {
    const noDb = { verbose: () => {}, localize, options: {}, services: {} };
    assertFullyLocalized('s3/availabilityNoDb', await cmds.buildSwitchesEmbed(noDb, null, null));
  });

  test('availability warning (no rows in range) renders no unlocalized prose', () =>
    fixture(async (db) => {
      // Tables exist and are empty — the softer of the two warnings, and the
      // one an operator actually hits after leaving logging off for a week.
      assertFullyLocalized('s3/availabilityNoRows', await cmds.buildKarmaEmbed(dbPlugin(db), 'Alice', null));
    }));

  test('player not found embed renders no unlocalized prose', () =>
    fixture(async (db, models) => {
      await seed(models);
      assertFullyLocalized('s3/playerNotFound', await cmds.buildSwitchesEmbed(dbPlugin(db), 'Nobody', null));
    }));

  test('ambiguous player embed renders no unlocalized prose', () =>
    fixture(async (db, models) => {
      await seed(models);
      // Same display name, two accounts — nothing in the log disambiguates
      // them, so the builder has to ask which one was meant.
      await models.eventsModel.create({
        matchId: 'm2', ts: NOW - DAY / 3, eventType: 'TEAM_CHANGE', eosID: 'p3', name: 'Alice', source: 'Player-Self', oldTeamID: 1, newTeamID: 2
      });
      assertFullyLocalized('s3/ambiguousPlayer', await cmds.buildKarmaEmbed(dbPlugin(db), 'Alice', null));
    }));

  // buildSwitchesExport returns { embed, buffer, filename } on success and a
  // bare { error } string on every rejection, and the caller drops that
  // string straight into a Discord embed — so both halves are user-facing.
  // The CSV's own column headers are deliberately not scanned: a data file
  // is read by a spreadsheet, and a translated header breaks the pivot.
  test('switches export embed renders no unlocalized prose', () =>
    fixture(async (db, models) => {
      await seed(models);
      const out = await cmds.buildSwitchesExport(dbPlugin(db), null, 'weekly', false);
      assert.ok(out.embed, `export failed instead of building an embed: ${out.error}`);
      assertFullyLocalized('s3/switchesExport', out.embed);
    }));

  test('switches export errors render no unlocalized prose', () =>
    fixture(async (db, models) => {
      await seed(models);
      for (const [label, args] of [
        ['badRange', ['not-a-range', 'weekly']],
        ['badPeriod', [null, 'fortnightly']]
      ]) {
        const out = await cmds.buildSwitchesExport(dbPlugin(db), args[0], args[1], false);
        assert.ok(out.error, `${label}: expected a rejection, got an export`);
        assertFullyLocalized(`s3/switchesExport/${label}`, out.error);
      }
    }));
});

// ── S³ consolidated diagnostic ──────────────────────────

/**
 * runDiagnostic() sends rather than returns, so it is the one S³ surface the
 * builder sweep above cannot reach: its embed only exists inside the injected
 * sendDiscordMessage. Both stubs matter — a fully-mounted server renders the
 * green half of every ternary, an empty one renders the red half, and the two
 * halves are written in different places.
 */
describe('i18n render — S³ diagnostic', () => {
  const capture = async (plugin) => {
    const sent = [];
    await cmds.runDiagnostic(plugin, { channel: {} }, async (_c, payload) => { sent.push(payload); });
    assert.equal(sent.length, 1, 'the diagnostic sent no message — the stub is wrong');
    return sent[0];
  };

  const mounted = (extra = {}) => ({ _isMounted: true, ...extra });

  test('diagnostic (nothing mounted) renders no unlocalized prose', async () => {
    assertFullyLocalized('s3/diagBare', await capture({ verbose: () => {}, localize, options: {}, services: {} }));
  });

  test('diagnostic (all services healthy) renders no unlocalized prose', async () => {
    const plugin = {
      verbose: () => {},
      localize,
      options: {},
      services: {
        serverConfig: mounted({ isLoadedSuccessfully: () => true }),
        db: mounted({
          getConnectorName: () => 'sqlite',
          getPendingMigrations: () => [],
          verifyDrift: async () => ({ ok: true, issues: [] })
        }),
        gameState: mounted({
          getPhase: () => 'LIVE',
          getGamemode: () => 'RAAS',
          getLayerName: () => 'Narva_AAS_v1'
        }),
        factions: mounted({ getTeamName: (id) => (id === 1 ? 'USA' : 'RUS') }),
        clans: mounted({ isEnabled: () => true }),
        players: mounted({
          getAllPlayers: () => [{ name: 'Alice' }],
          areTeamsResolved: () => true,
          lockGlobal: () => {},
          canAct: () => true
        })
      }
    };
    assertFullyLocalized('s3/diagHealthy', await capture(plugin));
  });
});


// ── Switch admin reports (!switch stats, !switch backfill) ───────

/**
 * These two used to be scrapers and are now database readers, which changes
 * what a render test can reach: the whole embed is built from one totals
 * object, so every branch is a fixture rather than a fabricated Discord
 * history.
 *
 * Both surfaces send rather than return, so the channel is the capture point.
 * The stats embed is the largest single localized surface in the Switch
 * plugin — five fields, each conditional — and none of it was rendered before.
 */
describe('i18n render — Switch admin reports', () => {
  function makeStatsPlugin(overrides = {}) {
    const sent = [];
    const plugin = {
      localize,
      verbose: () => {},
      server: { on: () => {}, removeListener: () => {} },
      constructor: { version: '2.3.0' },
      options: {
        switchCooldownHours: 6, switchEnabledMinutes: 20, queueTimeoutMinutes: 5,
        maxSwitchTokens: 2, scrambleLockdownMinutes: 10, queueTimeoutSwitchEnabled: true
      },
      channel: null,
      sendDiscordMessage: async () => {},
      _s3: null,
      ...overrides
    };
    // The backfill's embed parsers live on SwitchOutput, not SwitchCommands.
    SwitchOutput.register(plugin);
    SwitchCommands.register(plugin);
    return { plugin, sent, message: { channel: { send: async (p) => { sent.push(p); } } } };
  }

  // Everything non-zero, so no conditional field is skipped and no percentage
  // helper takes its divide-by-zero shortcut.
  const busyTotals = (over = {}) => ({
    rounds: 42, standardRounds: 40, liberalRounds: 2,
    success: 120, failed: 9, denied: 31,
    toT1: 61, toT2: 59,
    maxQueueSize: 8,
    instant: 70, queueNormal: 30, queueTeamTrade: 10, queueJoinSwap: 6, queueTimeoutSwitch: 4,
    denialCooldown: 18, denialTimeWindow: 8, denialScrambleLock: 3,
    denialRecentSwitch: 1, denialOther: 1,
    outcomeExpired: 9, outcomeDC: 4, outcomeCancelled: 3, outcomeRemoved: 2,
    incompleteRounds: 3,
    totalQueueEntries: 68,
    queueDurationsMs: [45000, 90000, 130000],
    medianDurationsMs: [60000, 75000],
    missingMedian: 2,
    scrapedRounds: 5,
    truncated: true,
    ...over
  });

  test('stats embed renders no unlocalized prose', async () => {
    const { plugin, sent, message } = makeStatsPlugin({ getRoundStatsTotals: async () => busyTotals() });
    await plugin._handleStatsCommand(message, []);
    assert.equal(sent.length, 1, 'the stats command sent no message');
    assertFullyLocalized('switch/stats', sent[0]);
  });

  test('stats embed (a quiet window) renders no unlocalized prose', async () => {
    // The other half of every conditional: no denials, no queue, no data
    // quality note — and the "no data" field that only appears when the embed
    // would otherwise have no fields at all.
    const quiet = busyTotals({
      rounds: 0, standardRounds: 0, liberalRounds: 0,
      success: 0, failed: 0, denied: 0, toT1: 0, toT2: 0, maxQueueSize: 0,
      instant: 0, queueNormal: 0, queueTeamTrade: 0, queueJoinSwap: 0, queueTimeoutSwitch: 0,
      denialCooldown: 0, denialTimeWindow: 0, denialScrambleLock: 0,
      denialRecentSwitch: 0, denialOther: 0,
      outcomeExpired: 0, outcomeDC: 0, outcomeCancelled: 0, outcomeRemoved: 0,
      incompleteRounds: 0, totalQueueEntries: 0,
      queueDurationsMs: [], medianDurationsMs: [], missingMedian: 0,
      scrapedRounds: 0, truncated: false
    });
    const { plugin, sent, message } = makeStatsPlugin({ getRoundStatsTotals: async () => quiet });
    await plugin._handleStatsCommand(message, []);
    assertFullyLocalized('switch/statsQuiet', sent[0]);
  });

  test('stats rejection (no database) renders no unlocalized prose', async () => {
    const { plugin, sent, message } = makeStatsPlugin({ getRoundStatsTotals: async () => null });
    await plugin._handleStatsCommand(message, []);
    assertFullyLocalized('switch/statsNoDb', sent[0]);
  });

  test('backfill messages render no unlocalized prose', async () => {
    // One embed-bearing message in a channel that then runs dry, so the
    // command walks its whole path: the start notice and the completion line.
    // The embed is English on purpose — the archive it stands in for predates
    // every translatable string in the plugin.
    const embed = {
      title: 'Switch Round Summary',
      fields: [
        { name: '📊 Stats', value: '**Mode:** Standard\n**Requests:** 7 (5 succeeded, 1 denied, 1 failed)\n**Max Queue Size:** 3\n**Queue Wait:** mean 1m 8s, median 1m 8s\n→ T1: 2 (33.3%)\n→ T2: 3 (66.7%)' },
        { name: '🔀 Switch Methods', value: '**Instant Switches (3)**\n**Queue Normal (2)**' },
        { name: '⏱️ Queue Outcomes', value: '**Expired (1)**' }
      ]
    };
    let served = false;
    const batch = new Map([['m1', { id: 'm1', createdAt: new Date(Date.now() - 3600000), embeds: [embed] }]]);
    batch.last = () => ({ id: 'm1' });
    const empty = new Map(); empty.last = () => undefined;

    const { plugin, sent, message } = makeStatsPlugin({
      channel: { messages: { fetch: async () => { if (served) return empty; served = true; return batch; } } },
      getEarliestLiveRoundStat: async () => null,
      backfillRoundStats: async (rows) => ({ inserted: rows.length, skipped: 0 })
    });
    await plugin._handleBackfillCommand(message, []);
    assert.ok(sent.length >= 2, 'the backfill should announce its start and its result');
    assertFullyLocalized('switch/backfill', sent);
  });

  test('backfill rejections render no unlocalized prose', async () => {
    const noChannel = makeStatsPlugin({
      channel: null,
      getEarliestLiveRoundStat: async () => null,
      backfillRoundStats: async () => ({ inserted: 0, skipped: 0 })
    });
    await noChannel.plugin._handleBackfillCommand(noChannel.message, []);
    assertFullyLocalized('switch/backfillNoChannel', noChannel.sent);

    const empty = new Map(); empty.last = () => undefined;
    const nothing = makeStatsPlugin({
      channel: { messages: { fetch: async () => empty } },
      getEarliestLiveRoundStat: async () => null,
      backfillRoundStats: async () => ({ inserted: 0, skipped: 0 })
    });
    await nothing.plugin._handleBackfillCommand(nothing.message, []);
    assertFullyLocalized('switch/backfillNothingFound', nothing.sent);
  });
});

// ── The last builder ─────────────────────────────────────────────

/**
 * buildPlayerRows is the only Team Balancer helper whose prose does not reach
 * a rendered embed on every path: the moved/stay column exists solely for a
 * virtual squad the plan tore apart, and the unknown-player fallback needs an
 * eosID with no matching player. Both are called here directly.
 *
 * buildKarmaVerdict, the other builder no embed fully exercises, is covered
 * in the SQLite-backed karma suite above rather than here — its branch is
 * chosen by a win rate, which takes a seeded fixture, not a stub.
 *
 * clans-service's buildPlayerTagCache is deliberately absent: it returns an
 * eosID→tag map built from the tags already in player names, with no prose in
 * it at all. There is nothing for a render test to look at.
 */
describe('i18n render — remaining builders', () => {
  test('player rows (moved/stay, clan markers, unknown player) render no unlocalized prose', () => {
    const tb = { localize };
    const playerByEos = new Map([
      ['e1', { name: 'Alpha', eosID: 'e1' }],
      ['e2', { name: 'Bravo', eosID: 'e2' }]
      // e3 is deliberately absent — the unknown-player fallback.
    ]);
    const eloMap = new Map([
      ['e1', { mu: 28.4, roundsPlayed: 40 }],
      ['e2', { mu: 22.1, roundsPlayed: 3 }]
    ]);
    const rows = DiscordHelpers.buildPlayerRows(
      tb, ['e1', 'e2', 'e3'], playerByEos, eloMap, new Set(['e1']),
      {
        movedOf: (id) => (id === 'e1' ? 'moved' : 'stay'),
        squadLabelOf: () => 'INFANTRY'
      }
    );
    assert.equal(rows.length, 3, 'every player should produce a row');
    assertFullyLocalized('tb/playerRows', rows);
  });

  test('player rows (no elo, no markers) render no unlocalized prose', () => {
    // Every optional column off, which is what a server running without the
    // Elo tracker sees.
    const tb = { localize };
    const rows = DiscordHelpers.buildPlayerRows(
      tb, ['e9'], new Map(), null, null, {}
    );
    assertFullyLocalized('tb/playerRowsPlain', rows);
  });
});

// ── !switch check — the in-game player status card ───────────────

/**
 * The status card is the largest single block of player-facing text the
 * Switch plugin produces, and until this block existed nothing rendered it:
 * it is assembled inline inside onChatMessage's `case 'check'` rather than in
 * a named builder, so no embed test reached it and its pass count was
 * silently zero. That is precisely the blind spot this file is meant to
 * close — a surface that is never rendered leaks nothing and looks clean.
 *
 * Driving the real handler also pins the column alignment. The five row
 * labels are catalogue text, so their widths change per locale; they are
 * padded at render time rather than in the strings. A translator whose
 * "Balance" is longer than the English one must not shear the card, and the
 * assertion below is what notices if the padding is ever removed.
 */
describe('i18n render — !switch check status card', () => {
  /** Drives the real onChatMessage and returns the warn text it produced. */
  async function renderCard({ isLiberal, joinSeconds, matchSeconds, tokenBalance, slots, queued }) {
    let warned = null;

    const plugin = {
      localize,
      verbose: () => {},
      reportError: () => {},
      recentSwitches: [],
      server: { players: [], admins: {}, on: () => {}, removeListener: () => {} },
      options: {
        commandPrefix: '!switch',
        doubleSwitchCommands: [],
        maxSwitchTokens: 2,
        switchCooldownHours: 3,
        switchCooldownMinutes: 0,
        switchEnabledMinutes: 10,
        liberalSwitchMaxUnbalancedSlots: 9
      },
      _s3: { players: { isReady: () => false, getPlayer: () => null } },
      _s3db: { shouldSkipDb: () => false },
      isLiberalMode: () => isLiberal,
      getSecondsFromJoin: async () => joinSeconds,
      getSecondsFromMatchStart: () => matchSeconds,
      getSwitchSlotsPerTeam: () => slots,
      _regenTokens: () => {},
      _getModel: (name) =>
        name === 'SwitchPlugin_PlayerCooldowns'
          ? { findByPk: async () => ({ tokenBalance, tokenRegenAnchor: null, scrambleLockdownExpiry: null }) }
          : null,
      _findQueueEntry: () => (queued ? { subQueue: 'q', entry: { queuedAt: Date.now() } } : null),
      _switchQueue: { q: [{ eosID: 'p1' }] },
      _getRemainingQueueMs: () => 90000,
      warn: (_eosID, msg) => { warned = msg; }
    };

    SwitchCommands.register(plugin);
    await plugin.onChatMessage({
      player: { eosID: 'p1', steamID: '76561198000000000', name: 'Alpha', teamID: 1 },
      message: '!switch check',
      chat: 'ChatAll'
    });

    assert.ok(warned, 'the check handler warned nothing — the stub is wrong');
    return warned;
  }

  test('every row renders localized on a normal layer, all checks passing', async () => {
    const card = await renderCard({
      isLiberal: false, joinSeconds: 60, matchSeconds: 120, tokenBalance: 2, slots: 3, queued: false
    });
    assertFullyLocalized('switch/checkCard/allOK', card);
  });

  test('every row renders localized when every check fails and a queue slot is held', async () => {
    // The failing branches carry the interpolated strings — the closed time
    // window, the empty token bucket, the queue position — which the
    // all-passing card never reaches.
    const card = await renderCard({
      isLiberal: false, joinSeconds: 3600, matchSeconds: 7200, tokenBalance: 0, slots: 0, queued: true
    });
    assertFullyLocalized('switch/checkCard/allFail', card);
  });

  test('the seed-mode branch renders localized', async () => {
    // Seed and Jensen layers take a different pair of rows entirely, and this
    // is the branch a live server on a Seed layer actually shows.
    const card = await renderCard({
      isLiberal: true, joinSeconds: 85, matchSeconds: 6982, tokenBalance: 2, slots: 9, queued: false
    });
    assertFullyLocalized('switch/checkCard/seed', card);
  });

  test('the row labels are padded to a common width', async () => {
    const card = await renderCard({
      isLiberal: false, joinSeconds: 3600, matchSeconds: 7200, tokenBalance: 0, slots: 0, queued: true
    });
    // Every row is `[xx] <label> | <value>`; the pipes must line up.
    const columns = card
      .split('\n')
      .filter((l) => /^\[.{2}\] /.test(l))
      .map((l) => l.indexOf('|'));

    assert.ok(columns.length >= 5, `expected all five rows, got ${columns.length}`);
    assert.equal(new Set(columns).size, 1,
      `row labels are not padded to a common width — pipe columns: ${columns.join(', ')}`);
  });
});
