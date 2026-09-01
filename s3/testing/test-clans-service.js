/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║          CLANS SERVICE TEST                                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates ClansService tag extraction strategies (bracketed,
 * separator, spacing, bare-prefix, unicode), normalization (diacritics,
 * unicode lookalikes), and tag merging logic.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/test-clans-service.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Pure unit tests — no external dependencies or server required.
 *
 */

import assert from 'node:assert/strict';
import ClansService from '../utils/clans-service.js';

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

await runTest('extractRawPrefix supports bracketed, separator, spacing, uppercase, and bare-prefix strategies', async () => {
  const service = new ClansService();

  assert.equal(service.extractRawPrefix('[ACE] Player'), 'ACE');
  assert.equal(service.extractRawPrefix('TAG | Name'), 'TAG');
  assert.equal(service.extractRawPrefix('TAG  Name'), 'TAG');
  assert.equal(service.extractRawPrefix('KM Lookout'), 'KM');
  assert.equal(service.extractRawPrefix('♣ΛCE Wurstwasser'), '♣ΛCE');
  assert.equal(service.extractRawPrefix('JustOneName'), null);
});

await runTest('normalizeTag collapses unicode lookalikes and diacritics', async () => {
  const service = new ClansService();

  assert.equal(service.normalizeTag('Café'), 'CAFE');
  assert.equal(service.normalizeTag('♣ΛC€'), 'ACE');
  assert.equal(service.normalizeTag('PRO™'), 'PROTM');
  assert.equal(service.normalizeTag('♣♦♠♥'), null);
});

await runTest('normalizeTag keeps real non-Latin-script letters instead of stripping them to empty', async () => {
  // Real prod miss: a clan tagged '⇧Ш | Name' (Cyrillic Sha decorated with an
  // arrow glyph) normalized to '' and the whole 5-player clan was invisible
  // to grouping. \p{L} keeps genuine letters in any script; only decoration
  // (arrows, chess pieces, emoji) gets stripped.
  const service = new ClansService();

  assert.equal(service.normalizeTag('⇧Ш'), 'Ш');
  assert.equal(service.normalizeTag('хорта'), 'ХОРТА');
  assert.equal(service.normalizeTag('一角錢'), '一角錢');
  // Pure decoration with no letter content still normalizes to null.
  assert.equal(service.normalizeTag('✇'), null);
  assert.equal(service.normalizeTag('❤️'), null);
});

await runTest('damerauLevenshteinDistance basic behavior', async () => {
  const service = new ClansService();

  assert.equal(service.damerauLevenshteinDistance('ACE', 'ACE'), 0);
  assert.equal(service.damerauLevenshteinDistance('ACE', 'AC'), 1);
  assert.equal(service.damerauLevenshteinDistance('CLAN', 'CLAM'), 1);
  assert.equal(service.damerauLevenshteinDistance('', 'ACE'), 3);
});

await runTest('damerauLevenshteinDistance counts an adjacent transposition as one edit', async () => {
  const service = new ClansService();

  // 'PHNTM' -> 'PHTNM' is a single adjacent swap (positions 2/3): plain
  // Levenshtein would need two substitutions to get there (distance 2).
  assert.equal(service.damerauLevenshteinDistance('PHNTM', 'PHTNM'), 1);
  assert.equal(service.damerauLevenshteinDistance('BOSS', 'BSOS'), 1);
  // Non-adjacent transpositions still cost 2 — only adjacent swaps are free.
  assert.equal(service.damerauLevenshteinDistance('ABCDE', 'EBCDA'), 2);
});

await runTest('extractClanGroups supports normalization, filtering, and edit-distance merge', async () => {
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: '[♣ΛCE] One' },
    { eosID: 'e2', name: '[♣ΛC€] Two' },
    { eosID: 'e3', name: '[CLAN] Three' },
    { eosID: 'e4', name: '[CLAM] Four' },
    { eosID: 'e5', name: '[CLAN] Five' },
    { eosID: 'e6', name: '[SOLO] Six' }
  ];

  const groups = service.extractClanGroups(players, {
    caseSensitive: false,
    maxEditDistance: 1,
    minSize: 2,
    maxSize: 18
  });

  assert.equal(groups.ACE?.length, 2);
  assert.equal(groups.CLAN?.length, 3);
  assert.equal(groups.SOLO, undefined);
});

await runTest('extractClanGroups does not fuzzy-merge unrelated short tags (CB vs 8B, OS vs OG)', async () => {
  // Real false-positive from prod: a 1-char edit on a 2-char tag is a
  // coinflip, not a typo. 'cb // Name' normalizes to CB; '『8B』 Name'
  // normalizes to 8B; distance 1 used to merge them into one fake clan.
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: 'cb // Infernos' },
    { eosID: 'e2', name: 'cb // Poolshark' },
    { eosID: 'e3', name: '『8B』 Traktor' },
    { eosID: 'e4', name: '[OS] Paulie-B' },
    { eosID: 'e5', name: 'OG Dudley' }
  ];

  const groups = service.extractClanGroups(players, {
    caseSensitive: false,
    maxEditDistance: 1,
    minSize: 2,
    maxSize: 18
  });

  assert.equal(groups.CB?.length, 2);
  assert.equal(groups['8B'], undefined);
  assert.equal(groups.OS, undefined);
  assert.equal(groups.OG, undefined);
});

await runTest('extractClanGroups still fuzzy-merges tags at/above minMergeLength', async () => {
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: '[CHUD] One' },
    { eosID: 'e2', name: '[CHUD] Two' },
    { eosID: 'e3', name: '[CHUM] Three' }
  ];

  const groups = service.extractClanGroups(players, {
    caseSensitive: false,
    maxEditDistance: 1,
    minMergeLength: 4,
    minSize: 2,
    maxSize: 18
  });

  assert.equal(groups.CHUD?.length, 3);
});

await runTest('extractClanGroups merges an adjacent-transposition tag typo (PHNTM/PHTNM)', async () => {
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: '[PHNTM] One' },
    { eosID: 'e2', name: '[PHNTM] Two' },
    { eosID: 'e3', name: '[PHTNM] Three' }
  ];

  const groups = service.extractClanGroups(players, {
    caseSensitive: false,
    maxEditDistance: 1,
    minMergeLength: 4,
    minSize: 2,
    maxSize: 18
  });

  assert.equal(groups.PHNTM?.length, 3);
  assert.equal(groups.PHTNM, undefined);
});

await runTest('extractClanGroups groups a non-Latin-script clan tag that previously normalized to empty', async () => {
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: '⇧Ш | Warrior Mosspath' },
    { eosID: 'e2', name: '⇧Ш | Magikarp' },
    { eosID: 'e3', name: '⇧Ш | Gandhi' }
  ];

  const groups = service.extractClanGroups(players, {
    caseSensitive: false,
    maxEditDistance: 1,
    minSize: 2,
    maxSize: 18
  });

  assert.equal(groups['Ш']?.length, 3);
});

await runTest('extractClanGroups respects ignoreList with normalized matching', async () => {
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: '[ADMIN] One' },
    { eosID: 'e2', name: '[ADMIN] Two' },
    { eosID: 'e3', name: '[ACE] Three' },
    { eosID: 'e4', name: '[AC€] Four' }
  ];

  const groups = service.extractClanGroups(players, {
    caseSensitive: false,
    maxEditDistance: 0,
    minSize: 2,
    ignoreList: ['ADMIN']
  });

  assert.equal(groups.ADMIN, undefined);
  assert.equal(groups.ACE?.length, 2);
});

await runTest('buildPlayerTagCache caches normalized tags by eosID', async () => {
  const service = new ClansService();
  const cache = service.buildPlayerTagCache([
    { eosID: 'e1', name: '[ACE] One' },
    { eosID: 'e2', name: '[AC€] Two' },
    { eosID: 'e3', name: 'NoTagName' }
  ], {
    caseSensitive: false
  });

  assert.equal(cache.get('e1'), 'ACE');
  assert.equal(cache.get('e2'), 'ACE');
  assert.equal(cache.get('e3'), null);
});

await runTest('getClanTeamForPlayer returns a team only when clan mates are unified on one team', async () => {
  const service = new ClansService();

  const playersUnified = [
    { eosID: 'joiner', name: '[ACE] Joiner', teamID: null },
    { eosID: 'p2', name: '[ACE] Two', teamID: 1 },
    { eosID: 'p3', name: '[ACE] Three', teamID: 1 }
  ];
  const cacheUnified = service.buildPlayerTagCache(playersUnified, { caseSensitive: false });

  assert.equal(
    service.getClanTeamForPlayer(playersUnified[0], cacheUnified, playersUnified, { minSize: 2 }),
    1
  );

  const playersSplit = [
    { eosID: 'joiner', name: '[ACE] Joiner', teamID: null },
    { eosID: 'p2', name: '[ACE] Two', teamID: 1 },
    { eosID: 'p3', name: '[ACE] Three', teamID: 2 }
  ];
  const cacheSplit = service.buildPlayerTagCache(playersSplit, { caseSensitive: false });

  assert.equal(
    service.getClanTeamForPlayer(playersSplit[0], cacheSplit, playersSplit, { minSize: 2 }),
    null
  );
});

await runTest('service mount/unmount toggles lifecycle state safely', async () => {
  const service = new ClansService();
  await service.mount();
  await service.unmount();
  assert.equal(service.isEnabled(), false);
});

// ─── Recruit Suffix Stripping Tests ───────────────────────────────

await runTest('_stripRecruitSuffixIfBaseExists strips suffix when base tag exists', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r'] } });
  const known = new Set(['ABC']);
  assert.equal(service._stripRecruitSuffixIfBaseExists('ABCr', known), 'ABC');
});

await runTest('_stripRecruitSuffixIfBaseExists does NOT strip when base tag absent', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r'] } });
  const known = new Set(['XYZ']);
  assert.equal(service._stripRecruitSuffixIfBaseExists('ABCr', known), 'ABCr');
});

await runTest('_stripRecruitSuffixIfBaseExists handles multiple suffixes (first match wins)', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r', '-r', 'rec'] } });
  const known = new Set(['ABC']);
  assert.equal(service._stripRecruitSuffixIfBaseExists('ABCrec', known), 'ABC');
  assert.equal(service._stripRecruitSuffixIfBaseExists('ABC-r', known), 'ABC');
  assert.equal(service._stripRecruitSuffixIfBaseExists('ABCr', known), 'ABC');
});

await runTest('_stripRecruitSuffixIfBaseExists case-insensitive suffix match', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r'] } });
  const known = new Set(['ABC']);
  assert.equal(service._stripRecruitSuffixIfBaseExists('ABCR', known), 'ABC');
  assert.equal(service._stripRecruitSuffixIfBaseExists('abcr', known), 'abc');
});

await runTest('_stripRecruitSuffixIfBaseExists case-insensitive base tag lookup', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r'] } });
  const known = new Set(['abc']);
  assert.equal(service._stripRecruitSuffixIfBaseExists('ABCr', known), 'ABC');
});

await runTest('_stripRecruitSuffixIfBaseExists no-op when tag equals suffix length', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r'] } });
  const known = new Set(['ABC']);
  assert.equal(service._stripRecruitSuffixIfBaseExists('R', known), 'R');
  assert.equal(service._stripRecruitSuffixIfBaseExists('r', known), 'r');
});

await runTest('_stripRecruitSuffixIfBaseExists no-op when suffixes array empty', async () => {
  const service = new ClansService({ options: { recruitSuffixes: [] } });
  const known = new Set(['ABC']);
  assert.equal(service._stripRecruitSuffixIfBaseExists('ABCr', known), 'ABCr');
});

await runTest('_stripRecruitSuffixIfBaseExists no-op when knownBaseTags empty', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r'] } });
  const known = new Set();
  assert.equal(service._stripRecruitSuffixIfBaseExists('ABCr', known), 'ABCr');
});

await runTest('extractClanGroups groups recruit-tagged players with base clan', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r'] } });
  const players = [
    { eosID: 'e1', name: '[ABC] Member' },
    { eosID: 'e2', name: '[ABCr] Recruit' },
    { eosID: 'e3', name: '[XYZ] Other' }
  ];

  const groups = service.extractClanGroups(players, {
    caseSensitive: false,
    minSize: 2,
    maxSize: 18
  });

  // ABC and ABCr should be grouped together as ABC
  assert.equal(groups.ABC?.length, 2);
  assert.ok(groups.ABC.includes('e1'));
  assert.ok(groups.ABC.includes('e2'));
  // XYZ alone should be filtered out by minSize
  assert.equal(groups.XYZ, undefined);
});

await runTest('extractClanGroups does NOT strip suffix when base clan absent', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r'] } });
  const players = [
    { eosID: 'e1', name: '[ABCr] Recruit1' },
    { eosID: 'e2', name: '[ABCr] Recruit2' },
    { eosID: 'e3', name: '[XYZ] Other' }
  ];

  const groups = service.extractClanGroups(players, {
    caseSensitive: false,
    minSize: 2,
    maxSize: 18
  });

  // No base ABC exists, so ABCr stays as ABCR (normalized)
  assert.equal(groups.ABCR?.length, 2);
  assert.equal(groups.ABC, undefined);
});

await runTest('buildPlayerTagCache strips suffix in batch context', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r'] } });
  const cache = service.buildPlayerTagCache([
    { eosID: 'e1', name: '[ABC] Member' },
    { eosID: 'e2', name: '[ABCr] Recruit' },
    { eosID: 'e3', name: 'NoTagName' }
  ], { caseSensitive: false });

  assert.equal(cache.get('e1'), 'ABC');
  assert.equal(cache.get('e2'), 'ABC');
  assert.equal(cache.get('e3'), null);
});

await runTest('addPlayerToCache strips suffix when base tag exists in cache', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r'] } });

  // First add a base clan member
  service.addPlayerToCache('e1', '[ABC] Member');
  assert.equal(service.getPlayerTag('e1'), 'ABC');

  // Then add a recruit — should be stripped to ABC since ABC exists in cache
  service.addPlayerToCache('e2', '[ABCr] Recruit');
  assert.equal(service.getPlayerTag('e2'), 'ABC');
});

await runTest('addPlayerToCache does NOT strip suffix when base tag absent from cache', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r'] } });

  // Add recruit first — no base ABC in cache yet
  service.addPlayerToCache('e1', '[ABCr] Recruit');
  assert.equal(service.getPlayerTag('e1'), 'ABCR');

  // Now add base clan member — they get ABC
  service.addPlayerToCache('e2', '[ABC] Member');
  assert.equal(service.getPlayerTag('e2'), 'ABC');
});

await runTest('addPlayerToCache with multiple suffixes', async () => {
  const service = new ClansService({ options: { recruitSuffixes: ['r', '-r', 'rec'] } });

  service.addPlayerToCache('e1', '[ABC] Member');
  assert.equal(service.getPlayerTag('e1'), 'ABC');

  service.addPlayerToCache('e2', '[ABC-r] RecruitDash');
  assert.equal(service.getPlayerTag('e2'), 'ABC');

  service.addPlayerToCache('e3', '[ABCrec] RecruitLong');
  assert.equal(service.getPlayerTag('e3'), 'ABC');
});

await runTest('extractClanGroups does not group a common word picked up only by low-confidence extraction', async () => {
  // 'BIG' here is never established by a bracket/[]/separator format from
  // anyone — both players only hit it via the bare-prefix fallback, which
  // also matches ordinary first words of unrelated names. Real prod false
  // positive: BIG, THE, MR, etc.
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: 'BIG C CRIPPIN' },
    { eosID: 'e2', name: 'BIG TUNA' }
  ];

  const groups = service.extractClanGroups(players);

  assert.equal(groups.BIG, undefined);
});

await runTest('extractClanGroups keeps a low-confidence extraction that is corroborated by a bracket/separator player', async () => {
  // Real prod example: KM has members using [KM], KM †, and a bare 'KM Name'
  // format all at once. The bare one alone would be indistinguishable from
  // a coincidental word, but the bracket/separator members prove KM is a
  // real, deliberate tag.
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: '[KM] One' },
    { eosID: 'e2', name: 'KM † Two' },
    { eosID: 'e3', name: 'KM Three' }
  ];

  const groups = service.extractClanGroups(players);

  assert.equal(groups.KM?.length, 3);
});

await runTest('explainClanGroups traces uncorroborated low-confidence extractions', async () => {
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: 'THE Wall' },
    { eosID: 'e2', name: 'THE Rock' }
  ];

  const { trace } = service.explainClanGroups(players);

  assert.equal(trace.uncorroborated.length, 2);
  assert.equal(trace.uncorroborated[0].tag, 'THE');
});

await runTest('buildPlayerTagCache does not cache an uncorroborated low-confidence tag', async () => {
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: 'MR Smith' },
    { eosID: 'e2', name: 'MR Jones' }
  ];

  const cache = service.buildPlayerTagCache(players);

  assert.equal(cache.get('e1'), null);
  assert.equal(cache.get('e2'), null);
});

await runTest('buildPlayerTagCache caches a low-confidence tag corroborated by a bracketed player', async () => {
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: '[ABC] Leader' },
    { eosID: 'e2', name: 'ABC Guy' }
  ];

  const cache = service.buildPlayerTagCache(players);

  assert.equal(cache.get('e1'), 'ABC');
  assert.equal(cache.get('e2'), 'ABC');
});

await runTest('addPlayerToCache does not cache an uncorroborated bare-prefix tag', async () => {
  const service = new ClansService();

  service.addPlayerToCache('e1', 'THE Wall');
  assert.equal(service.getPlayerTag('e1'), null);
});

await runTest('addPlayerToCache retroactively heals a bare-prefix tag once a bracketed clanmate joins', async () => {
  // Formerly a known, accepted gap (e1 stayed null until the next
  // rebuildFromAllPlayers()); the retroactive-healing fix in §3.5 of
  // docs/clan-tag-confirmation-rework.md closes it incrementally.
  const service = new ClansService();

  service.addPlayerToCache('e1', 'ABC Guy');
  assert.equal(service.getPlayerTag('e1'), null);

  service.addPlayerToCache('e2', '[ABC] Leader');
  assert.equal(service.getPlayerTag('e2'), 'ABC');

  // e1's tag is now healed immediately once e2 corroborates it.
  assert.equal(service.getPlayerTag('e1'), 'ABC');
});

await runTest('rebuildFromAllPlayers corroborates order-independently across the whole population', async () => {
  const service = new ClansService();

  service.rebuildFromAllPlayers([
    { eosID: 'e1', name: 'ABC Guy' },
    { eosID: 'e2', name: '[ABC] Leader' }
  ]);

  assert.equal(service.getPlayerTag('e1'), 'ABC');
  assert.equal(service.getPlayerTag('e2'), 'ABC');
});

await runTest('extractRawPrefix recognizes additional wrap/separator styles found in production names', async () => {
  const service = new ClansService();

  assert.equal(service.extractRawPrefix('%WANCS% Scuba Steve'), 'WANCS');
  assert.equal(service.extractRawPrefix('❀SEAF❀ Maple dolphin'), 'SEAF');
  assert.equal(service.extractRawPrefix('⇃FENT⇂ BlockHead'), 'FENT');
  assert.equal(service.extractRawPrefix('←NIA→ Ojas'), 'NIA');
  assert.equal(service.extractRawPrefix('⌈ԍԍ⌋ COoptimus_Z'), 'ԍԍ');
  assert.equal(service.extractRawPrefix('WANCS ↯ Porcupine'), 'WANCS');
  assert.equal(service.extractRawPrefix('CSF ♠ Kakarok'), 'CSF');
});

await runTest('extractClanGroups groups a bracketless-looking clan once its decorative wrap is recognized', async () => {
  // Real prod example: every WANCS member uses %WANCS% or 'WANCS <sep> Name' —
  // neither hit the old bracket/separator char lists, so the whole clan was
  // uncorroborated and dropped. Both styles are now first-class 'bracket'/
  // 'separator' extractions, so they no longer need outside corroboration.
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: '%WANCS% Scuba Steve' },
    { eosID: 'e2', name: 'WANCS ↯ Porcupine' },
    { eosID: 'e3', name: 'WANCS ↯ Mas0nnn' }
  ];

  const groups = service.extractClanGroups(players);

  assert.equal(groups.WANCS?.length, 3);
});

await runTest('extractClanGroups groups a hash-prefixed clan without needing outside corroboration', async () => {
  // Real prod example: both BOZO members used '#BOZO Name' formatting.
  // '#' wasn't in the bracket/separator char lists, so extraction fell to
  // low-confidence 'bare' and, with no bracket/separator BOZO member to
  // corroborate it, the whole 2-member clan was dropped as uncorroborated.
  // '#TAG' is now a first-class high-confidence extraction ('prefixSymbol').
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: '#BOZO Rulerofcode' },
    { eosID: 'e2', name: '#BOZO Shadowcat' }
  ];

  const { groups, trace } = service.explainClanGroups(players);

  assert.equal(groups.BOZO?.length, 2);
  assert.equal(trace.memberStrategies.get('e1'), 'prefixSymbol');
  assert.equal(trace.memberStrategies.get('e2'), 'prefixSymbol');
});

await runTest('extractClanGroups treats a numeric hash-prefix as high-confidence too (accepted false-positive risk)', async () => {
  // '#1'/'#69'-style self-styled "rank" monikers get merged as a
  // false-positive "clan" here — a deliberate trade-off. The alternative
  // (requiring a letter, falling back to bareRegex otherwise) would also
  // block a genuine all-numeric clan tag (e.g. '#420') from ever
  // corroborating on its own, which is a worse failure: a false negative
  // that costs a real clan its grouping entirely, vs. two unrelated
  // players coincidentally sharing a numeral getting merged.
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: '#1 BestPlayer' },
    { eosID: 'e2', name: '#1 TopFragger' }
  ];

  const { groups, trace } = service.explainClanGroups(players);

  assert.equal(groups['1']?.length, 2);
  assert.equal(trace.memberStrategies.get('e1'), 'prefixSymbol');
  assert.equal(trace.memberStrategies.get('e2'), 'prefixSymbol');
});

await runTest('extractClanGroups does not treat a period as a separator (would re-admit rank abbreviations)', async () => {
  // Real prod finding: 'MR.'/'DR.'/'PVT.'/'SGT.'/'CPT.'/'CPL.'/'LT.'/'CAPT.'
  // account for 96 of the period-separated names in the historic export —
  // recognizing '.' as a separator would make every rank abbreviation
  // high-confidence on its own. Deliberately left unrecognized.
  const service = new ClansService();
  const players = [
    { eosID: 'e1', name: 'MR. Smith' },
    { eosID: 'e2', name: 'MR. Jones' }
  ];

  const groups = service.extractClanGroups(players);

  assert.equal(groups.MR, undefined);
});

// ─── Confirmed Tags (observed name transitions) ───────────────────

await runTest('recordConfirmedTag trusts a plain word tag standalone, bypassing the corroboration gate', async () => {
  const service = new ClansService();

  service.recordConfirmedTag('e1', 'THE');
  assert.equal(service.getPlayerTag('e1'), 'THE');
  assert.equal(service.getPlayerTagCache().get('e1'), 'THE');
});

await runTest('a confirmed tag corroborates a second player\'s bare/doublespace extraction of the same tag', async () => {
  const service = new ClansService();

  service.recordConfirmedTag('e1', 'GN');
  service.addPlayerToCache('e2', 'GN Bravo');

  assert.equal(service.getPlayerTag('e1'), 'GN');
  assert.equal(service.getPlayerTag('e2'), 'GN');
});

await runTest('addPlayerToCache cannot overwrite an already-confirmed entry with a weaker regex guess', async () => {
  const service = new ClansService();

  service.recordConfirmedTag('e1', 'XYZ');
  service.addPlayerToCache('e1', 'JustOneName');

  assert.equal(service.getPlayerTag('e1'), 'XYZ');
});

await runTest('clearConfirmedTag removes the confirmed entry and lets addPlayerToCache re-derive normally', async () => {
  const service = new ClansService();

  service.recordConfirmedTag('e1', 'XYZ');
  service.clearConfirmedTag('e1');
  assert.equal(service.getPlayerTag('e1'), null);

  service.addPlayerToCache('e1', '[XYZ] Guy');
  assert.equal(service.getPlayerTag('e1'), 'XYZ');
});

await runTest('extractClanGroups/buildPlayerTagCache pick up a confirmed tag even when the current name shape does not qualify', async () => {
  const service = new ClansService();
  service.recordConfirmedTag('e1', 'GN');

  const players = [
    { eosID: 'e1', name: 'JustOneName' },
    { eosID: 'e2', name: 'GN Bravo' }
  ];

  const groups = service.extractClanGroups(players);
  assert.ok(groups.GN?.includes('e1'));
  assert.ok(groups.GN?.includes('e2'));

  const cache = service.buildPlayerTagCache(players);
  assert.equal(cache.get('e1'), 'GN');
  assert.equal(cache.get('e2'), 'GN');
});

await runTest('removePlayerFromCache and clearPlayerTagCache both clear confirmed tags', async () => {
  const service1 = new ClansService();
  service1.recordConfirmedTag('e1', 'XYZ');
  service1.removePlayerFromCache('e1');
  assert.equal(service1._confirmedTags.has('e1'), false);
  assert.equal(service1.getPlayerTag('e1'), null);

  const service2 = new ClansService();
  service2.recordConfirmedTag('e1', 'XYZ');
  service2.clearPlayerTagCache();
  assert.equal(service2._confirmedTags.has('e1'), false);
  assert.equal(service2.getPlayerTag('e1'), null);
});

// ─── Retroactive Healing (§3.5) ────────────────────────────────────

await runTest('retroactive healing corrects a bracketless clan whose members joined in unlucky order', async () => {
  const service = new ClansService();

  service.addPlayerToCache('e1', 'GN Alpha');
  service.addPlayerToCache('e2', 'GN Bravo');
  service.addPlayerToCache('e3', 'GN Charlie');

  assert.equal(service.getPlayerTag('e1'), null);
  assert.equal(service.getPlayerTag('e2'), null);
  assert.equal(service.getPlayerTag('e3'), null);

  service.recordConfirmedTag('e4', 'GN');

  assert.equal(service.getPlayerTag('e1'), 'GN');
  assert.equal(service.getPlayerTag('e2'), 'GN');
  assert.equal(service.getPlayerTag('e3'), 'GN');
});

await runTest('healing only fires for lack-of-corroboration rejections, not ignoreList rejections', async () => {
  const service = new ClansService({ options: { ignoreList: ['THE'] } });

  service.addPlayerToCache('e1', 'THE Wall');
  assert.equal(service.getPlayerTag('e1'), null);
  // Ignore-listed candidates never enter the pending-heal map in the first
  // place — the ignore filter runs before the corroboration check.
  assert.equal(service._pendingLowConfidenceTags.has('e1'), false);

  // recordConfirmedTag also refuses an ignore-listed tag outright, so it
  // cannot heal e1 even indirectly.
  service.recordConfirmedTag('e2', 'THE');
  assert.equal(service.getPlayerTag('e2'), null);
  assert.equal(service.getPlayerTag('e1'), null);
});

await runTest('removePlayerFromCache and clearPlayerTagCache clear pending low-confidence tags too', async () => {
  const service = new ClansService();

  service.addPlayerToCache('e1', 'GN Alpha');
  assert.equal(service.getPlayerTag('e1'), null);

  service.removePlayerFromCache('e1');
  assert.equal(service._pendingLowConfidenceTags.has('e1'), false);

  // A later, unrelated player producing the same tag string must not be
  // healed by e1's stale (removed) pending candidate.
  service.addPlayerToCache('e2', 'GN Bravo');
  service.recordConfirmedTag('e3', 'GN');
  assert.equal(service.getPlayerTag('e2'), 'GN');
  assert.equal(service.getPlayerTag('e1'), null);
});

// ─── Reconnect Restoration (_lastConfirmedTags) ────────────────────

await runTest('addPlayerToCache restores confirmed status for a rejoining player whose tag is unchanged', async () => {
  // A reconnecting player whose tag is ALREADY visible on their first
  // post-reconnect name never produces the tagless->tagged transition that
  // normally (re-)confirms a tag — Squad only injects the tag live for a
  // genuinely fresh, tagless join. Before this fix, a plain mid-session
  // disconnect (the player's own game connection drops, not a SquadJS
  // restart — that wipes _confirmedTags/_lastConfirmedTags together and is
  // a separate, unaddressed gap) permanently downgraded a confirmed player
  // back to whatever the regex pipeline alone could extract.
  const service = new ClansService();

  service.recordConfirmedTag('e1', 'GN');
  service.removePlayerFromCache('e1');
  assert.equal(service.getPlayerTag('e1'), null);

  service.addPlayerToCache('e1', 'GN Alpha');
  assert.equal(service.getPlayerTag('e1'), 'GN');
  assert.equal(service._confirmedTags.get('e1'), 'GN');
});

await runTest('reconnect restoration re-anchors corroboration for the whole clan, not just the reconnecting player', async () => {
  const service = new ClansService();

  service.recordConfirmedTag('e1', 'GN');
  service.addPlayerToCache('e2', 'GN Bravo'); // bare, corroborated by e1's confirmed tag

  service.removePlayerFromCache('e1'); // e1 disconnects — the clan's sole anchor is gone
  service.addPlayerToCache('e1', 'GN Alpha'); // e1 reconnects, tag already showing

  const groups = service.extractClanGroups([
    { eosID: 'e1', name: 'GN Alpha' },
    { eosID: 'e2', name: 'GN Bravo' }
  ]);
  assert.equal(groups.GN?.length, 2);
});

await runTest('reconnecting with a DIFFERENT tag does not get silently restored', async () => {
  const service = new ClansService();

  service.recordConfirmedTag('e1', 'GN');
  service.removePlayerFromCache('e1');

  // e1 shows up under a different tag entirely — must go through the
  // ordinary corroboration gate like any other unconfirmed bare extraction,
  // not be waved through because they were once confirmed as something else.
  service.addPlayerToCache('e1', 'ZZZ Alpha');
  assert.equal(service.getPlayerTag('e1'), null);
  assert.equal(service._confirmedTags.has('e1'), false);
});

await runTest('clearConfirmedTag (explicit in-session tag removal) also clears reconnect-restoration memory', async () => {
  // Distinguishes a disconnect (network blip, tag memory kept) from the
  // player deliberately taking their tag off mid-session (shrink
  // transition) — the latter is real evidence the tag is gone and must not
  // be silently reinstated on a later reconnect.
  const service = new ClansService();

  service.recordConfirmedTag('e1', 'GN');
  service.clearConfirmedTag('e1');
  assert.equal(service._lastConfirmedTags.has('e1'), false);

  service.addPlayerToCache('e1', 'GN Alpha');
  assert.equal(service.getPlayerTag('e1'), null);
});

await runTest('clearPlayerTagCache clears reconnect-restoration memory too', async () => {
  const service = new ClansService();

  service.recordConfirmedTag('e1', 'GN');
  service.clearPlayerTagCache();
  assert.equal(service._lastConfirmedTags.has('e1'), false);

  service.addPlayerToCache('e1', 'GN Alpha');
  assert.equal(service.getPlayerTag('e1'), null);
});

if (!process.exitCode) {
  console.log('\nAll clans-service tests passed.');
}
