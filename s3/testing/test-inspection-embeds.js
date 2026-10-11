/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          INSPECTION EMBEDS TEST                              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates the `!s3 players`, `!s3 clans` and `!s3 parties` embed builders:
 *
 *   - buildPlayersEmbeds()  — meta/population embed + one embed per team,
 *                             broken down by squad with leaders marked and
 *                             party members tagged.
 *   - buildClansEmbeds()    — active clan groups plus the exclusion and
 *                             merge trace from ClansService.
 *   - buildPartiesEmbeds()  — tracked Squad parties, where their members
 *                             are, and the join prediction and reunite counts.
 *
 * The builders run against the REAL PlayersService and ClansService
 * (registry and squad cache populated directly) rather than hand-rolled
 * stubs, so a change to getSquads(), the clan grouping pipeline or the party
 * tracker surfaces here instead of silently drifting.
 *
 * Also enforces Discord's embed limits against a full 100-player server,
 * which is the case that actually breaks in production:
 *   ≤10 embeds/message, ≤25 fields/embed, ≤256 chars/field name,
 *   ≤1024 chars/field value, ≤6000 chars/embed.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-inspection-embeds.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Pure unit tests — no database, no Discord, no server required.
 *
 */

import assert from 'node:assert/strict';
import { localize as lookupMessage } from '../utils/s3-i18n.js';
import ClansService from '../utils/clans-service.js';
import PlayersService from '../utils/players-service.js';
import { buildPlayersEmbeds, buildClansEmbeds, buildPartiesEmbeds } from '../utils/s3-commands.js';

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.error(`❌ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Discord embed limits
// ---------------------------------------------------------------------------

const DISCORD = {
  MAX_EMBEDS_PER_MESSAGE: 10,
  MAX_FIELDS_PER_EMBED: 25,
  MAX_FIELD_NAME: 256,
  MAX_FIELD_VALUE: 1024,
  MAX_EMBED_TOTAL: 6000
};

function embedCharCount(embed) {
  let n = (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
  for (const f of embed.fields ?? []) {
    n += (f.name?.length ?? 0) + (f.value?.length ?? 0);
  }
  return n;
}

function assertWithinDiscordLimits(embeds, label) {
  assert.ok(
    embeds.length <= DISCORD.MAX_EMBEDS_PER_MESSAGE,
    `${label}: ${embeds.length} embeds exceeds Discord's ${DISCORD.MAX_EMBEDS_PER_MESSAGE}`
  );

  embeds.forEach((embed, i) => {
    const where = `${label} embed[${i}] (${embed.title})`;
    const fields = embed.fields ?? [];

    assert.ok(
      fields.length <= DISCORD.MAX_FIELDS_PER_EMBED,
      `${where}: ${fields.length} fields exceeds ${DISCORD.MAX_FIELDS_PER_EMBED}`
    );

    fields.forEach((f, j) => {
      assert.ok(
        (f.name?.length ?? 0) <= DISCORD.MAX_FIELD_NAME,
        `${where} field[${j}]: name is ${f.name?.length} chars (max ${DISCORD.MAX_FIELD_NAME})`
      );
      assert.ok(
        (f.value?.length ?? 0) <= DISCORD.MAX_FIELD_VALUE,
        `${where} field[${j}] "${f.name}": value is ${f.value?.length} chars (max ${DISCORD.MAX_FIELD_VALUE})`
      );
      // Discord rejects a field with an empty value outright.
      assert.ok(
        (f.value?.length ?? 0) > 0,
        `${where} field[${j}] "${f.name}": value is empty`
      );
    });

    assert.ok(
      embedCharCount(embed) <= DISCORD.MAX_EMBED_TOTAL,
      `${where}: ${embedCharCount(embed)} total chars exceeds ${DISCORD.MAX_EMBED_TOTAL}`
    );
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a real PlayersService with its registry and squad cache populated.
 *
 * @param {Array} players - Player states ({ eosID, name, teamID, squadID, isLeader }).
 * @param {Array} squads  - Raw SquadJS squad objects ({ squadID, teamID, squadName, locked }).
 */
function makePlayersService(players, squads) {
  // PlayersService emits lifecycle events on the SquadJS server object.
  const svc = new PlayersService({
    server: { emit: () => {}, on: () => {} },
    reconnectPersistence: false
  });
  for (const p of players) {
    svc.registry.set(p.eosID, { steamID: null, isLeader: false, ...p });
  }
  svc._squadsCache = squads;
  svc._initialSyncComplete = true;
  return svc;
}

function makePlugin({ players, squads, clanOptions = {} }) {
  const clans = new ClansService({ options: { enabled: true, ...clanOptions } });
  return {
    verbose: () => {},
    localize: (key, vars) => lookupMessage(key, vars),
    services: {
      players: makePlayersService(players, squads),
      clans,
      factions: {
        getTeamName: (id) => (id === 1 ? 'USA' : 'RGF')
      },
      gameState: {
        getPhase: () => 'LIVE',
        getLayerName: () => 'Narva_AAS_v1'
      }
    }
  };
}

/** A small, hand-checkable server: 2 squads on T1, 1 on T2, plus stragglers. */
function smallServerFixture() {
  const players = [
    { eosID: 'e1', name: '[ACE] Alpha', teamID: 1, squadID: '1', isLeader: true },
    { eosID: 'e2', name: '[ACE] Bravo', teamID: 1, squadID: '1' },
    { eosID: 'e3', name: '[ACE] Charlie', teamID: 1, squadID: '1' },
    { eosID: 'e4', name: '[KM] Delta', teamID: 1, squadID: '2', isLeader: true },
    { eosID: 'e5', name: '[KM] Echo', teamID: 1, squadID: '2' },
    { eosID: 'e6', name: 'LoneWolfOnOne', teamID: 1, squadID: null },
    { eosID: 'e7', name: '[RGT] Foxtrot', teamID: 2, squadID: '1', isLeader: true },
    { eosID: 'e8', name: '[RGT] Golf', teamID: 2, squadID: '1' },
    { eosID: 'e9', name: 'DriftingIn', teamID: null, squadID: null }
  ];
  const squads = [
    { squadID: '1', teamID: 1, squadName: 'INFANTRY', locked: 'True' },
    { squadID: '2', teamID: 1, squadName: 'ARMOR', locked: 'False' },
    { squadID: '1', teamID: 2, squadName: 'CMD', locked: 'False' }
  ];
  return { players, squads };
}

/** A saturated 100-player server: 50 per team, 12 squads per team. */
function fullServerFixture() {
  const players = [];
  const squads = [];
  let n = 0;

  for (const teamID of [1, 2]) {
    for (let sq = 1; sq <= 12; sq++) {
      squads.push({
        squadID: `${sq}`,
        teamID,
        squadName: `SQUAD NAME THAT IS FAIRLY LONG ${sq}`,
        locked: sq % 2 === 0 ? 'True' : 'False'
      });
      for (let m = 0; m < 4; m++) {
        n += 1;
        players.push({
          eosID: `full-${n}`,
          name: `[CLAN${sq}] AVeryLongPlayerNameHere${n}`,
          teamID,
          squadID: `${sq}`,
          isLeader: m === 0
        });
      }
    }
    // 2 unsquaded per team → 50 per team.
    for (let u = 0; u < 2; u++) {
      n += 1;
      players.push({
        eosID: `full-${n}`,
        name: `UnsquadedLongPlayerName${n}`,
        teamID,
        squadID: null
      });
    }
  }

  return { players, squads };
}

// ---------------------------------------------------------------------------
// buildPlayersEmbeds
// ---------------------------------------------------------------------------

await runTest('buildPlayersEmbeds returns a meta embed followed by one embed per team', async () => {
  const plugin = makePlugin(smallServerFixture());
  const embeds = buildPlayersEmbeds(plugin);

  assert.equal(embeds.length, 3);
  assert.match(embeds[0].title, /Overview/);
  // Faction names from FactionsService are used in place of "Team 1"/"Team 2".
  assert.match(embeds[1].title, /USA/);
  assert.match(embeds[2].title, /RGF/);
});

await runTest('meta embed reports population, squad counts, and balance', async () => {
  const plugin = makePlugin(smallServerFixture());
  const [meta] = buildPlayersEmbeds(plugin);
  const byName = new Map(meta.fields.map((f) => [f.name, f.value]));

  assert.equal(byName.get('👥 Population'), '**9** tracked');
  assert.equal(byName.get('🟦 USA'), '**6** in 2 squad(s)');
  assert.equal(byName.get('🟥 RGF'), '**2** in 1 squad(s)');
  // 6 on T1 vs 2 on T2.
  assert.equal(byName.get('Balance'), 'Team 1 +4');
  // "Unassigned" means not in a squad — e6 and e9.
  assert.equal(byName.get('Unassigned'), '2 not in a squad');
});

await runTest('a null teamID is reported as a tracking gap, not a population bucket', async () => {
  // Every connected player in Squad is on team 1 or 2, so a null teamID means
  // S³ has not resolved the player yet. It must read as a warning.
  const plugin = makePlugin(smallServerFixture());
  const [meta] = buildPlayersEmbeds(plugin);

  const warning = meta.fields.find((f) => f.name.includes('Team Unresolved'));
  assert.ok(warning, 'expected a Team Unresolved warning field');
  assert.match(warning.name, /\(1\)/);
  assert.match(warning.value, /NEW_GAME/);

  const roster = meta.fields.find((f) => f.name === 'Awaiting teamID');
  assert.ok(roster, 'expected the unresolved players to be listed');
  assert.match(roster.value, /DriftingIn/);
});

await runTest('no Team Unresolved warning appears when every player has a team', async () => {
  const plugin = makePlugin({
    players: [
      { eosID: 'e1', name: 'One', teamID: 1, squadID: null },
      { eosID: 'e2', name: 'Two', teamID: 2, squadID: null }
    ],
    squads: []
  });
  const [meta] = buildPlayersEmbeds(plugin);

  assert.equal(meta.fields.find((f) => f.name.includes('Team Unresolved')), undefined);
});

await runTest('team embeds break players down by squad with the leader marked', async () => {
  const plugin = makePlugin(smallServerFixture());
  const [, team1] = buildPlayersEmbeds(plugin);

  const infantry = team1.fields.find((f) => f.name.includes('INFANTRY'));
  assert.ok(infantry, 'expected an INFANTRY squad field');
  assert.match(infantry.name, /^#1 · INFANTRY \(3\)/);
  // locked: 'True' from SquadJS is a string, not a boolean.
  assert.match(infantry.name, /🔒/);

  // Alpha is the squad leader; Bravo and Charlie are not.
  assert.match(infantry.value, /👑 \[ACE\] Alpha/);
  assert.match(infantry.value, /· \[ACE\] Bravo/);
  assert.ok(!/👑 \[ACE\] Bravo/.test(infantry.value), 'Bravo must not be marked as leader');

  const armor = team1.fields.find((f) => f.name.includes('ARMOR'));
  assert.ok(armor, 'expected an ARMOR squad field');
  assert.ok(!/🔒/.test(armor.name), "locked:'False' must not render a lock icon");
});

await runTest('team embeds bucket squadless players under Unassigned', async () => {
  const plugin = makePlugin(smallServerFixture());
  const [, team1, team2] = buildPlayersEmbeds(plugin);

  const unassigned = team1.fields.find((f) => f.name.includes('Unassigned'));
  assert.ok(unassigned, 'expected an Unassigned field on team 1');
  assert.match(unassigned.value, /LoneWolfOnOne/);

  // Team 2 has everyone in a squad, so the field must be absent entirely.
  assert.equal(team2.fields.find((f) => f.name.includes('Unassigned')), undefined);
});

await runTest('squads with the same number on both teams stay separate', async () => {
  // Squad numbers restart per team, so team 1 #1 and team 2 #1 both exist.
  // Keying squad membership on squadID alone merges them — this pins the fix.
  const plugin = makePlugin(smallServerFixture());
  const [, team1, team2] = buildPlayersEmbeds(plugin);

  const t1Squad1 = team1.fields.find((f) => f.name.startsWith('#1 ·'));
  const t2Squad1 = team2.fields.find((f) => f.name.startsWith('#1 ·'));

  assert.match(t1Squad1.name, /^#1 · INFANTRY \(3\)/);
  assert.match(t2Squad1.name, /^#1 · CMD \(2\)/);

  // Neither squad may contain the other team's players.
  assert.ok(!/RGT/.test(t1Squad1.value), "team 1's squad 1 must not contain RGT players");
  assert.ok(!/ACE/.test(t2Squad1.value), "team 2's squad 1 must not contain ACE players");
});

await runTest('getSquads keys membership by team and squad number', async () => {
  // Direct assertion against the service, independent of embed rendering.
  const { players, squads } = smallServerFixture();
  const svc = makePlayersService(players, squads);
  const result = svc.getSquads();

  const t1s1 = result.find((s) => Number(s.teamID) === 1 && s.squadID === '1');
  const t2s1 = result.find((s) => Number(s.teamID) === 2 && s.squadID === '1');

  assert.deepEqual(t1s1.players, ['e1', 'e2', 'e3'], 'leaders first, then members');
  assert.deepEqual(t2s1.players, ['e7', 'e8']);
});

await runTest('per-player locks are surfaced on the roster line', async () => {
  const fixture = smallServerFixture();
  const plugin = makePlugin(fixture);
  plugin.services.players.lock('e2', 'SmartAssign');

  const [meta, team1] = buildPlayersEmbeds(plugin);
  const infantry = team1.fields.find((f) => f.name.includes('INFANTRY'));

  assert.match(infantry.value, /\[ACE\] Bravo 🔒SmartAssign/);
  assert.match(meta.fields.find((f) => f.name === '🔒 Locks').value, /Per-player: 1 active/);
});

await runTest('global lock is surfaced in the meta embed', async () => {
  const plugin = makePlugin(smallServerFixture());
  plugin.services.players.lockGlobal('TeamBalancer');

  const [meta] = buildPlayersEmbeds(plugin);
  assert.match(meta.fields.find((f) => f.name === '🔒 Locks').value, /Global: 🔒 \*\*TeamBalancer\*\*/);
});

await runTest('an unpopulated squad cache reads as pending, not as zero squads', async () => {
  // PlayersService only snapshots server.squads on a fully-resolved tick, so
  // before that getSquads() returns []. That must not render as "everyone is
  // unassigned" — it is missing data, not a game state.
  const { players } = smallServerFixture();
  const plugin = makePlugin({ players, squads: [] });
  plugin.services.players._squadsCache = null;

  const [meta, team1] = buildPlayersEmbeds(plugin);

  assert.ok(
    meta.fields.find((f) => f.name.includes('Squad Data Pending')),
    'expected a Squad Data Pending warning'
  );
  assert.equal(meta.fields.find((f) => f.name === 'Unassigned').value, '⚪ Unknown');

  assert.ok(
    team1.fields.find((f) => f.name.includes('squad data pending')),
    'team roster must be labelled pending, not Unassigned'
  );
  assert.equal(
    team1.fields.find((f) => f.name.startsWith('Unassigned (')),
    undefined,
    'must not claim players are unassigned when squad data is missing'
  );
});

await runTest('an empty-but-populated squad cache reports genuine unassignment', async () => {
  // Distinct from the case above: the cache exists and really is empty.
  const { players } = smallServerFixture();
  const plugin = makePlugin({ players, squads: [] });
  plugin.services.players._squadsCache = [];

  const [meta, team1] = buildPlayersEmbeds(plugin);

  assert.equal(meta.fields.find((f) => f.name.includes('Squad Data Pending')), undefined);
  assert.equal(meta.fields.find((f) => f.name === 'Unassigned').value, '9 not in a squad');
  assert.ok(team1.fields.find((f) => f.name.startsWith('Unassigned (')));
});

await runTest('a team with no players renders a placeholder rather than an empty field', async () => {
  const plugin = makePlugin({
    players: [{ eosID: 'e1', name: 'Solo', teamID: 1, squadID: null }],
    squads: []
  });
  const [, , team2] = buildPlayersEmbeds(plugin);

  assert.equal(team2.fields.length, 1);
  assert.match(team2.fields[0].value, /No players on this team/);
});

await runTest('markdown characters in player names are escaped', async () => {
  // extractRawPrefix() treats | and * as tag separators, so names carrying them
  // are normal in Squad. Unescaped they corrupt the surrounding embed markdown.
  const plugin = makePlugin({
    players: [
      { eosID: 'e1', name: 'TAG | Under_score', teamID: 1, squadID: '1', isLeader: true },
      { eosID: 'e2', name: '[*ACE*] Back`tick', teamID: 1, squadID: '1' }
    ],
    squads: [{ squadID: '1', teamID: 1, squadName: 'INF', locked: 'False' }]
  });
  const [, team1] = buildPlayersEmbeds(plugin);
  const squad = team1.fields.find((f) => f.name.includes('INF'));

  assert.match(squad.value, /TAG \\\| Under\\_score/);
  assert.match(squad.value, /\\\*ACE\\\*/);
  assert.match(squad.value, /Back\\`tick/);
});

await runTest('markdown characters in clan tags are escaped', async () => {
  // With caseSensitive on, the raw tag is the group key and is not normalised
  // down to alphanumerics, so it can carry markdown characters.
  // "a_b - Name" extracts the tag "a_b" via the separator strategy; the
  // underscore is a markdown character but not a separator, so it survives.
  const plugin = makePlugin({
    players: [
      { eosID: 'c1', name: 'a_b - One', teamID: 1, squadID: null },
      { eosID: 'c2', name: 'a_b - Two', teamID: 1, squadID: null }
    ],
    squads: [],
    clanOptions: { minSize: 2, maxSize: 10, maxEditDistance: 0, caseSensitive: true }
  });
  const active = buildClansEmbeds(plugin)[0].fields.find((f) => f.name.includes('Active Clan'));

  assert.match(active.value, /\*\*a\\_b\*\* \(2\)/);
});

await runTest('buildPlayersEmbeds degrades gracefully with no players service', async () => {
  const embeds = buildPlayersEmbeds({ verbose: () => {}, localize: (key, vars) => lookupMessage(key, vars), services: {} });
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].title, /Not Available/);
});

await runTest('buildPlayersEmbeds stays within Discord limits on a full 100-player server', async () => {
  const fixture = fullServerFixture();
  const plugin = makePlugin(fixture);

  // Sanity-check the fixture itself before trusting the limit assertions.
  assert.equal(fixture.players.length, 100);
  assert.equal(plugin.services.players.getAllPlayers().length, 100);

  const embeds = buildPlayersEmbeds(plugin);
  assertWithinDiscordLimits(embeds, 'players');
});

// ---------------------------------------------------------------------------
// buildClansEmbeds
// ---------------------------------------------------------------------------

/**
 * A clan fixture that trips every exclusion path at once:
 *   ACE  (3)  → survives
 *   ACS  (1)  → merged into ACE (Damerau-Levenshtein 1)
 *   BIG  (5)  → excluded, above maxSize 4
 *   SML  (1)  → excluded, below minSize 2
 *   MOD  (2)  → excluded, on ignoreList
 *   KMr  (1)  → recruit suffix stripped to KM, joining KM (2) → KM survives at 3
 *   no tag    → 2 players
 */
function clanFixture() {
  const players = [
    { eosID: 'c1', name: '[ACE] One', teamID: 1, squadID: null },
    { eosID: 'c2', name: '[ACE] Two', teamID: 1, squadID: null },
    { eosID: 'c3', name: '[ACE] Three', teamID: 1, squadID: null },
    { eosID: 'c4', name: '[ACS] Four', teamID: 2, squadID: null },

    { eosID: 'c5', name: '[BIG] Five', teamID: 1, squadID: null },
    { eosID: 'c6', name: '[BIG] Six', teamID: 1, squadID: null },
    { eosID: 'c7', name: '[BIG] Seven', teamID: 2, squadID: null },
    { eosID: 'c8', name: '[BIG] Eight', teamID: 2, squadID: null },
    { eosID: 'c9', name: '[BIG] Nine', teamID: 2, squadID: null },

    { eosID: 'c10', name: '[SML] Ten', teamID: 1, squadID: null },

    { eosID: 'c11', name: '[MOD] Eleven', teamID: 1, squadID: null },
    { eosID: 'c12', name: '[MOD] Twelve', teamID: 2, squadID: null },

    { eosID: 'c13', name: '[KM] Thirteen', teamID: 1, squadID: null },
    { eosID: 'c14', name: '[KM] Fourteen', teamID: 1, squadID: null },
    { eosID: 'c15', name: '[KMr] Fifteen', teamID: 2, squadID: null },

    { eosID: 'c16', name: 'JustOneName', teamID: 1, squadID: null },
    { eosID: 'c17', name: 'AnotherSoloName', teamID: 2, squadID: null }
  ];

  return {
    players,
    squads: [],
    clanOptions: {
      minSize: 2,
      maxSize: 4,
      maxEditDistance: 1,
      minMergeLength: 0,
      caseSensitive: false,
      ignoreList: ['MOD'],
      recruitSuffixes: ['r', '-r']
    }
  };
}

await runTest('buildClansEmbeds reports the active groups', async () => {
  const plugin = makePlugin(clanFixture());
  const embeds = buildClansEmbeds(plugin);

  const active = embeds[0].fields.find((f) => f.name.includes('Active Clan Groups'));
  assert.ok(active, 'expected an Active Clan Groups field');
  // ACE absorbed ACS → 4 members; KM absorbed the KMr recruit → 3 members.
  assert.match(active.value, /\*\*ACE\*\* \(4\)/);
  assert.match(active.value, /\*\*KM\*\* \(3\)/);
});

await runTest('buildClansEmbeds marks high-confidence members with the • glyph', async () => {
  const plugin = makePlugin(clanFixture());
  const active = buildClansEmbeds(plugin)[0].fields.find((f) => f.name.includes('Active Clan Groups'));

  // Every member of this fixture is bracket-extracted (high-confidence).
  assert.match(active.value, /One•/);
  assert.match(active.value, /Thirteen•/);
});

await runTest('buildClansEmbeds marks a confirmed player with the ✓ glyph and reports the Confirmed tile', async () => {
  const fixture = clanFixture();
  const plugin = makePlugin(fixture);

  // Confirm a player's tag via the observed-transition path rather than
  // relying on their name shape, then render the embed from that state.
  plugin.services.clans.recordConfirmedTag('c1', 'ACE');

  const embeds = buildClansEmbeds(plugin);
  const active = embeds[0].fields.find((f) => f.name.includes('Active Clan Groups'));
  assert.match(active.value, /One✓/);

  const confirmedTile = embeds[0].fields.find((f) => f.name === 'Confirmed');
  assert.ok(confirmedTile, 'expected a Confirmed tile');
  assert.equal(confirmedTile.value, '✓ 1');
});

await runTest('buildClansEmbeds reports the Confirmed tile as zero when nobody is confirmed', async () => {
  const plugin = makePlugin(clanFixture());
  const embeds = buildClansEmbeds(plugin);

  const confirmedTile = embeds[0].fields.find((f) => f.name === 'Confirmed');
  assert.ok(confirmedTile, 'expected a Confirmed tile');
  assert.equal(confirmedTile.value, '⚫ 0');
});

await runTest('buildClansEmbeds explains size-bound exclusions with the bound that failed', async () => {
  const plugin = makePlugin(clanFixture());
  const detail = buildClansEmbeds(plugin)[1];
  const sizeField = detail.fields.find((f) => f.name.includes('Excluded by Size'));

  assert.ok(sizeField, 'expected an Excluded by Size field');
  assert.match(sizeField.value, /\*\*BIG\*\* \(5\) — above maxSize `4`/);
  assert.match(sizeField.value, /\*\*SML\*\* \(1\) — below minSize `2`/);
});

await runTest('buildClansEmbeds explains ignoreList exclusions', async () => {
  const plugin = makePlugin(clanFixture());
  const detail = buildClansEmbeds(plugin)[1];
  const cfgField = detail.fields.find((f) => f.name.includes('Excluded by Config'));

  assert.ok(cfgField, 'expected an Excluded by Config field');
  assert.match(cfgField.value, /\*\*MOD\*\* \(2\) — on `ignoreList`/);
});

await runTest('buildClansEmbeds explains Damerau-Levenshtein merges with the distance', async () => {
  const plugin = makePlugin(clanFixture());
  const detail = buildClansEmbeds(plugin)[1];
  const mergeField = detail.fields.find((f) => f.name.includes('Merged by Damerau-Levenshtein'));

  assert.ok(mergeField, 'expected a Merged by Damerau-Levenshtein field');
  assert.match(mergeField.name, /≤ 1/);
  assert.match(mergeField.value, /\*\*ACE\*\* ⟵ ACS \(d1\)/);
});

await runTest('buildClansEmbeds explains recruit-suffix stripping', async () => {
  const plugin = makePlugin(clanFixture());
  const detail = buildClansEmbeds(plugin)[1];
  const recruitField = detail.fields.find((f) => f.name.includes('Recruit Suffix Stripped'));

  assert.ok(recruitField, 'expected a Recruit Suffix Stripped field');
  assert.match(recruitField.value, /\*\*KMr → KM\*\* — 1 player\(s\)/);
});

await runTest('buildClansEmbeds counts players with no detectable tag', async () => {
  const plugin = makePlugin(clanFixture());
  const detail = buildClansEmbeds(plugin)[1];
  const noTagField = detail.fields.find((f) => f.name.includes('No Tag Detected'));

  assert.ok(noTagField, 'expected a No Tag Detected field');
  assert.match(noTagField.name, /\(2\)/);
  assert.match(noTagField.value, /JustOneName/);
});

await runTest('buildClansEmbeds surfaces the grouping config that produced the result', async () => {
  const plugin = makePlugin(clanFixture());
  const cfg = buildClansEmbeds(plugin)[0].fields.find((f) => f.name.includes('Grouping Config'));

  assert.ok(cfg, 'expected a Grouping Config field');
  assert.match(cfg.value, /minSize: `2`/);
  assert.match(cfg.value, /maxSize: `4`/);
  assert.match(cfg.value, /maxEditDistance: `1`/);
  assert.match(cfg.value, /minMergeLength: `0`/);
  assert.match(cfg.value, /ignoreList: `MOD`/);
  assert.match(cfg.value, /recruitSuffixes: `r, -r`/);
});

await runTest('buildClansEmbeds flags a merged group that then failed the size bound', async () => {
  // AAA (1) + AAB (1) merge to 2, which is still below minSize 3.
  const plugin = makePlugin({
    players: [
      { eosID: 'm1', name: '[AAA] One', teamID: 1, squadID: null },
      { eosID: 'm2', name: '[AAB] Two', teamID: 1, squadID: null }
    ],
    squads: [],
    clanOptions: { minSize: 3, maxSize: 10, maxEditDistance: 1, minMergeLength: 0 }
  });
  const detail = buildClansEmbeds(plugin)[1];
  const sizeField = detail.fields.find((f) => f.name.includes('Excluded by Size'));

  assert.ok(sizeField, 'expected an Excluded by Size field');
  assert.match(sizeField.value, /\(2\) — below minSize `3` \*\(post-merge\)\*/);

  const mergeField = detail.fields.find((f) => f.name.includes('Merged by Damerau-Levenshtein'));
  assert.match(mergeField.value, /\*\(later excluded\)\*/);
});

await runTest('buildClansEmbeds reports disabled clan grouping', async () => {
  const plugin = makePlugin(smallServerFixture());
  plugin.services.clans.options.enabled = false;

  const embeds = buildClansEmbeds(plugin);
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].title, /Disabled/);
});

await runTest('buildClansEmbeds degrades gracefully with no clans service', async () => {
  const embeds = buildClansEmbeds({ verbose: () => {}, localize: (key, vars) => lookupMessage(key, vars), services: {} });
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].title, /Not Available/);
});

await runTest('buildClansEmbeds stays within Discord limits on a full 100-player server', async () => {
  const plugin = makePlugin({ ...fullServerFixture(), clanOptions: { minSize: 2, maxSize: 4 } });
  const embeds = buildClansEmbeds(plugin);
  assertWithinDiscordLimits(embeds, 'clans');
});

// ---------------------------------------------------------------------------
// buildPartiesEmbeds, and the party marker in buildPlayersEmbeds
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000;

/** Discord counts this across every embed in one message, not per embed. */
function messageCharCount(embeds) {
  return embeds.reduce((n, embed) => n + embedCharCount(embed), 0);
}

/**
 * A plugin whose real PartiesService has been ticked into this state:
 *
 *   party 77  Mandela Caos, Bravo, Charlie on T1 and Delta on T2  (split, 12m old)
 *   party 88  Echo, Foxtrot on T2                                 (5m old)
 *   party 99  LoneCarrier only, so not a tracked party
 *   Solo, Wanderer in no party
 *
 * The game numbers are two digits that appear nowhere else in the fixture, so
 * a test can assert neither reaches the reply. Parties are formed by
 * handleTick() from the registry rows, the way a real player-list tick does
 * it. No reunite handler is installed, so nothing is moved.
 */
function partyPlugin() {
  const players = [
    { eosID: 'p1', name: 'Mandela Caos', teamID: 1, squadID: '1', isLeader: true, partyID: 77 },
    { eosID: 'p2', name: 'Bravo', teamID: 1, squadID: '1', partyID: 77 },
    { eosID: 'p3', name: 'Charlie', teamID: 1, squadID: '2', isLeader: true, partyID: 77 },
    { eosID: 'p4', name: 'Delta', teamID: 2, squadID: null, partyID: 77 },
    { eosID: 'p5', name: 'Echo', teamID: 2, squadID: '1', isLeader: true, partyID: null },
    { eosID: 'p6', name: 'Foxtrot', teamID: 2, squadID: '1', partyID: null },
    { eosID: 'p7', name: 'Solo', teamID: 1, squadID: null, partyID: null },
    { eosID: 'p8', name: 'LoneCarrier', teamID: 2, squadID: null, partyID: 99 },
    { eosID: 'p9', name: 'Wanderer', teamID: 1, squadID: null, partyID: null }
  ];
  const squads = [
    { squadID: '1', teamID: 1, squadName: 'INFANTRY', locked: 'False' },
    { squadID: '2', teamID: 1, squadName: 'ARMOR', locked: 'False' },
    { squadID: '1', teamID: 2, squadName: 'CMD', locked: 'False' }
  ];
  const plugin = makePlugin({ players, squads });
  const svc = plugin.services.players;
  svc._isMounted = true;

  const now = Date.now();
  const firstTick = now - 12 * MINUTE;
  const secondTick = now - 5 * MINUTE;
  const joinedAt = firstTick - 2 * MINUTE;

  // One join of each outcome, judged on the first tick, plus one still pending.
  svc.parties.noteJoin({ eosID: 'p1', squadID: '1', partyID: 77 }, joinedAt);     // party        -> confirmed
  svc.parties.noteJoin({ eosID: 'p2', squadID: '1', partyID: null }, joinedAt);   // likely-party -> hit
  svc.parties.noteJoin({ eosID: 'p7', squadID: '3', partyID: null }, joinedAt);   // likely-party -> false alarm
  svc.parties.noteJoin({ eosID: 'p4', squadID: null, partyID: null }, joinedAt);  // solo         -> miss
  svc.parties.noteJoin({ eosID: 'p9', squadID: null, partyID: null }, joinedAt);  // solo         -> correct
  svc.parties.handleTick(firstTick);

  svc.registry.get('p5').partyID = 88;
  svc.registry.get('p6').partyID = 88;
  svc.parties.noteJoin({ eosID: 'p6', squadID: '1', partyID: null }, secondTick - 1000); // pending
  svc.parties.handleTick(secondTick);

  return plugin;
}

const partyListField = (embed) => embed.fields.find((f) => f.name.startsWith('Parties ('));

await runTest('buildPartiesEmbeds degrades gracefully with no players service', async () => {
  const embeds = buildPartiesEmbeds({ verbose: () => {}, localize: (key, vars) => lookupMessage(key, vars), services: {} });
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].title, /Players Service Not Available/);
});

await runTest('buildPartiesEmbeds says so when the players service is not mounted', async () => {
  // makePlayersService() never mounts the service, which is exactly this case.
  const plugin = makePlugin(smallServerFixture());
  assert.equal(plugin.services.players._isMounted, false);

  const embeds = buildPartiesEmbeds(plugin);
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].title, /Not Mounted/);
  assert.equal(embeds[0].fields, undefined, 'an unmounted tracker has no counts worth showing');
});

await runTest('buildPartiesEmbeds says plainly when there are no parties', async () => {
  const plugin = makePlugin(smallServerFixture());
  plugin.services.players._isMounted = true;
  plugin.services.players.parties.handleTick(Date.now());

  const [embed] = buildPartiesEmbeds(plugin);
  assert.match(embed.description, /Parties: \*\*0\*\* · Players in a party: \*\*0\*\* · Split across teams: \*\*0\*\*/);
  assert.equal(partyListField(embed).name, 'Parties (0)');
  assert.equal(partyListField(embed).value, 'No parties on the server right now.');
  // The counters are still shown: an empty server is when a drifting
  // prediction is easiest to read.
  assert.ok(embed.fields.find((f) => f.name.includes('Join Prediction')));
  assert.ok(embed.fields.find((f) => f.name.includes('Reunite')));
  assertWithinDiscordLimits([embed], 'parties (none)');
});

await runTest('buildPartiesEmbeds lists two parties, largest first, with one split across teams', async () => {
  const [embed] = buildPartiesEmbeds(partyPlugin());

  assert.match(embed.description, /Parties: \*\*2\*\* · Players in a party: \*\*6\*\* · Split across teams: \*\*1\*\*/);

  const list = partyListField(embed);
  assert.equal(list.name, 'Parties (2)');
  const rows = list.value.split('\n');
  assert.equal(rows.length, 4, 'two rows per party');

  // The split party is the larger one, so it leads. Each group carries its
  // team because the party has no single team to print once.
  assert.equal(rows[0], 'ᴾ1 **Mandela Caos + 3** (4) · ⚠️ split · 12m');
  assert.equal(rows[1], '↳ T1 #1 INFANTRY: Mandela Caos, Bravo · T1 #2 ARMOR: Charlie · T2 no squad: Delta');

  // One team, so it is printed once and the groups are squads only.
  assert.equal(rows[2], 'ᴾ2 **Echo + 1** (2) · T2 · 5m');
  assert.equal(rows[3], '↳ #1 CMD: Echo, Foxtrot');

  // A lone player carrying a party ID is not a party.
  assert.ok(!list.value.includes('LoneCarrier'));
});

await runTest('buildPartiesEmbeds names a party after a member, never by the game number', async () => {
  // The game renumbers every later party when one forms or dissolves, so its
  // number in a reply would point at a different party a minute later.
  const [embed] = buildPartiesEmbeds(partyPlugin());
  const shown = [embed.title, embed.description, ...embed.fields.flatMap((f) => [f.name, f.value])].join('\n');

  assert.match(shown, /\*\*Mandela Caos \+ 3\*\*/);
  assert.match(shown, /\*\*Echo \+ 1\*\*/);
  for (const partyID of ['77', '88', '99']) {
    assert.ok(!shown.includes(partyID), `game party number ${partyID} reached the reply`);
  }
});

await runTest('buildPartiesEmbeds reports the join prediction and reunite counts', async () => {
  const plugin = partyPlugin();
  plugin.services.players.parties.getReuniteStats = () => ({ moved: 2, failed: 1, skippedBalance: 3 });

  const [embed] = buildPartiesEmbeds(plugin);
  const prediction = embed.fields.find((f) => f.name.includes('Join Prediction')).value.split('\n');

  assert.equal(prediction[0], 'Hit: **1** · False alarm: **1** · Miss: **1** · Correct: **1** · Confirmed: **1**');
  // 1 false alarm of 2 likely-party calls; 1 miss of 3 party joiners.
  assert.equal(prediction[1], 'False alarm share: 50% · Miss share: 33%');
  assert.equal(prediction[2], 'Judged: 5 · Pending: 1');

  const reunite = embed.fields.find((f) => f.name.includes('Reunite')).value.split('\n');
  assert.equal(reunite[0], '🟢 Enabled');
  assert.equal(reunite[1], 'Moved: **2** · Failed: **1** · Skipped for balance: **3**');
  assert.equal(reunite[2], 'Window: 90s · Max team difference: 3');
});

await runTest('buildPartiesEmbeds shows a share as N/A until there is something to divide by', async () => {
  const plugin = makePlugin(smallServerFixture());
  plugin.services.players._isMounted = true;
  plugin.services.players.parties.options.reuniteEnabled = false;

  const [embed] = buildPartiesEmbeds(plugin);
  assert.match(embed.fields.find((f) => f.name.includes('Join Prediction')).value, /False alarm share: N\/A · Miss share: N\/A/);
  assert.match(embed.fields.find((f) => f.name.includes('Reunite')).value, /^⚫ Disabled/);
});

await runTest('buildPartiesEmbeds marks a member with no resolved team instead of guessing one', async () => {
  const plugin = partyPlugin();
  plugin.services.players.registry.get('p6').teamID = null;

  const rows = partyListField(buildPartiesEmbeds(plugin)[0]).value.split('\n');
  assert.equal(rows[2], 'ᴾ2 **Echo + 1** (2) · T2 · 5m', 'one known team is not a split');
  assert.equal(rows[3], '↳ T2 #1 CMD: Echo · T? #1: Foxtrot');
});

await runTest('buildPartiesEmbeds stays within Discord limits with fifty parties on a full server', async () => {
  // The worst list a 100-player server can produce: every player in a party
  // of two, long names full of markdown, every pair in its own named squad.
  const players = [];
  const squads = [];
  for (let i = 0; i < 50; i++) {
    const teamID = (i % 2) + 1;
    const squadID = `${Math.floor(i / 2) + 1}`;
    squads.push({ squadID, teamID, squadName: `SQUAD_NAME_THAT_IS_LONG_${i}`, locked: 'False' });
    for (const half of ['a', 'b']) {
      players.push({ eosID: `pair-${i}${half}`, name: `[*TAG*] Long_Player_Name_${i}${half}`, teamID, squadID, partyID: i + 1 });
    }
  }
  const plugin = makePlugin({ players, squads });
  plugin.services.players._isMounted = true;
  plugin.services.players.parties.handleTick(Date.now() - 90 * MINUTE);
  assert.equal(plugin.services.players.getParties().length, 50);

  const embeds = buildPartiesEmbeds(plugin);
  assertWithinDiscordLimits(embeds, 'parties (50)');
  assert.ok(messageCharCount(embeds) <= DISCORD.MAX_EMBED_TOTAL,
    `${messageCharCount(embeds)} chars across the message exceeds ${DISCORD.MAX_EMBED_TOTAL}`);

  // Whatever did not fit is counted, not dropped silently.
  const [embed] = embeds;
  assert.match(embed.description, /Parties: \*\*50\*\*/);
  const shown = embed.fields
    .filter((f) => f.name.startsWith('Parties ('))
    .reduce((n, f) => n + f.value.split('\n').filter((row) => row.startsWith('ᴾ')).length, 0);
  assert.ok(shown > 0 && shown < 50, `expected a capped list, got ${shown} of 50`);
  const overflow = embed.fields.find((f) => /more \(output truncated\)/.test(f.value));
  assert.ok(overflow, 'expected an overflow count for the parties that did not fit');
  assert.match(overflow.value, new RegExp(`and ${50 - shown} more`));
});

await runTest('buildPartiesEmbeds stays within Discord limits when one party is the whole server', async () => {
  // Not a real party, but it is what the reply would be handed if the game
  // ever gave one number to everybody.
  const players = [];
  for (let i = 0; i < 100; i++) {
    players.push({ eosID: `big-${i}`, name: `[*TAG*] Long_Player_Name_${i}`, teamID: (i % 2) + 1, squadID: `${(i % 9) + 1}`, partyID: 5 });
  }
  const plugin = makePlugin({ players, squads: [] });
  plugin.services.players._isMounted = true;
  plugin.services.players.parties.handleTick(Date.now());

  const embeds = buildPartiesEmbeds(plugin);
  assertWithinDiscordLimits(embeds, 'parties (one of 100)');
  const list = partyListField(embeds[0]);
  assert.match(list.value, /\(100\) · ⚠️ split/);
  assert.match(list.value, /\+\d+ more/);
});

await runTest('buildPlayersEmbeds tags party members with the party list position', async () => {
  const [meta, team1, team2] = buildPlayersEmbeds(partyPlugin());

  const infantry = team1.fields.find((f) => f.name.includes('INFANTRY'));
  assert.match(infantry.value, /👑 Mandela Caos ᴾ1/);
  assert.match(infantry.value, /· Bravo ᴾ1/);
  // Same party, another squad and the other team: the marker is what ties them.
  assert.match(team1.fields.find((f) => f.name.includes('ARMOR')).value, /Charlie ᴾ1/);
  assert.match(team2.fields.find((f) => f.name.includes('Unassigned')).value, /· Delta ᴾ1/);
  assert.match(team2.fields.find((f) => f.name.includes('CMD')).value, /👑 Echo ᴾ2\n· Foxtrot ᴾ2/);

  // No party, no marker. That includes a lone player carrying a party ID.
  const everything = JSON.stringify([team1.fields, team2.fields]);
  assert.match(everything, /· Solo(\\n|")/);
  assert.match(everything, /· LoneCarrier(\\n|")/);
  assert.ok(!/ᴾ(77|88|99)/.test(everything), 'the marker must not be the game party number');

  assert.match(meta.description, /ᴾn marks a party member/);
});

await runTest('buildPlayersEmbeds puts the party marker before a per-player lock', async () => {
  const plugin = partyPlugin();
  plugin.services.players.lock('p2', 'SmartAssign');

  const [, team1] = buildPlayersEmbeds(plugin);
  assert.match(team1.fields.find((f) => f.name.includes('INFANTRY')).value, /· Bravo ᴾ1 🔒SmartAssign/);
});

await runTest('buildPlayersEmbeds carries no party legend when nobody is in a party', async () => {
  const [meta, team1] = buildPlayersEmbeds(makePlugin(smallServerFixture()));
  assert.ok(!meta.description.includes('ᴾ'));
  assert.ok(!JSON.stringify(team1.fields).includes('ᴾ'));
});

// ---------------------------------------------------------------------------
// Drift guard
// ---------------------------------------------------------------------------

await runTest('explainClanGroups returns exactly what extractClanGroups returns', async () => {
  // The whole point of the diagnostic view is that it describes the grouping
  // SmartAssign and TeamBalancer actually consume. If these ever diverge, the
  // !s3 clans output becomes a lie.
  const fixtures = [clanFixture(), fullServerFixture(), smallServerFixture()];

  for (const fixture of fixtures) {
    const clans = new ClansService({ options: { enabled: true, ...(fixture.clanOptions ?? {}) } });
    const extracted = clans.extractClanGroups(fixture.players);
    const explained = clans.explainClanGroups(fixture.players).groups;
    assert.deepEqual(explained, extracted);
  }
});

await runTest('explainClanGroups trace accounts for every scanned player', async () => {
  const fixture = clanFixture();
  const clans = new ClansService({ options: { enabled: true, ...fixture.clanOptions } });
  const { groups, trace } = clans.explainClanGroups(fixture.players);

  assert.equal(trace.scanned, fixture.players.length);

  const grouped = Object.values(groups).reduce((n, ids) => n + ids.length, 0);
  const excluded = [...trace.ignored, ...trace.sizeExcluded]
    .reduce((n, e) => n + e.members.length, 0);
  const accounted = grouped
    + excluded
    + trace.noTag.length
    + trace.unnormalizable.length
    + trace.skipped.length;

  assert.equal(
    accounted,
    trace.scanned,
    'every scanned player must end up grouped, excluded, or untagged'
  );
});

if (!process.exitCode) console.log('\nAll inspection-embed tests passed.');
