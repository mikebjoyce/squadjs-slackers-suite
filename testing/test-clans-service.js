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

if (!process.exitCode) {
  console.log('\nAll clans-service tests passed.');
}
