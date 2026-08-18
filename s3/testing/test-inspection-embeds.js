/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          INSPECTION EMBEDS TEST                              ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates the `!s3 players` and `!s3 clans` embed builders:
 *
 *   - buildPlayersEmbeds()  — meta/population embed + one embed per team,
 *                             broken down by squad with leaders marked.
 *   - buildClansEmbeds()    — active clan groups plus the exclusion and
 *                             merge trace from ClansService.
 *
 * Both builders run against the REAL PlayersService and ClansService
 * (registry and squad cache populated directly) rather than hand-rolled
 * stubs, so a change to getSquads() or the clan grouping pipeline surfaces
 * here instead of silently drifting.
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
import ClansService from '../utils/clans-service.js';
import PlayersService from '../utils/players-service.js';
import { buildPlayersEmbeds, buildClansEmbeds } from '../utils/s3-commands.js';

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
    team1.fields.find((f) => f.name.includes('🚶 Unassigned')),
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
  assert.ok(team1.fields.find((f) => f.name.includes('🚶 Unassigned')));
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
  const embeds = buildPlayersEmbeds({ verbose: () => {}, services: {} });
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
 *   ACS  (1)  → merged into ACE (Levenshtein 1)
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

await runTest('buildClansEmbeds explains Levenshtein merges with the distance', async () => {
  const plugin = makePlugin(clanFixture());
  const detail = buildClansEmbeds(plugin)[1];
  const mergeField = detail.fields.find((f) => f.name.includes('Merged by Levenshtein'));

  assert.ok(mergeField, 'expected a Merged by Levenshtein field');
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
    clanOptions: { minSize: 3, maxSize: 10, maxEditDistance: 1 }
  });
  const detail = buildClansEmbeds(plugin)[1];
  const sizeField = detail.fields.find((f) => f.name.includes('Excluded by Size'));

  assert.ok(sizeField, 'expected an Excluded by Size field');
  assert.match(sizeField.value, /\(2\) — below minSize `3` \*\(post-merge\)\*/);

  const mergeField = detail.fields.find((f) => f.name.includes('Merged by Levenshtein'));
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
  const embeds = buildClansEmbeds({ verbose: () => {}, services: {} });
  assert.equal(embeds.length, 1);
  assert.match(embeds[0].title, /Not Available/);
});

await runTest('buildClansEmbeds stays within Discord limits on a full 100-player server', async () => {
  const plugin = makePlugin({ ...fullServerFixture(), clanOptions: { minSize: 2, maxSize: 4 } });
  const embeds = buildClansEmbeds(plugin);
  assertWithinDiscordLimits(embeds, 'clans');
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
