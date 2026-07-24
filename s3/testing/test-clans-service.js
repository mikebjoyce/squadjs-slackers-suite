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

await runTest('levenshteinDistance basic behavior', async () => {
  const service = new ClansService();

  assert.equal(service.levenshteinDistance('ACE', 'ACE'), 0);
  assert.equal(service.levenshteinDistance('ACE', 'AC'), 1);
  assert.equal(service.levenshteinDistance('CLAN', 'CLAM'), 1);
  assert.equal(service.levenshteinDistance('', 'ACE'), 3);
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

if (!process.exitCode) {
  console.log('\nAll clans-service tests passed.');
}
