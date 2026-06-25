/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║              TEST: CLAN GROUPING                               ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Unit tests for the unified clan-tag detection, normalization, and
 * grouping module shared by elo-discord.js, tools/elo-inspect.js,
 * and tools/elo-clans-audit.js. Verifies homoglyph collapsing
 * ([♣ΛCE] vs [♣ΛC€]) and other edge cases.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node testing/run-all-tests.js
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Pure logic test; no server or database dependency.
 *
 */

import {
  extractRawPrefix,
  normalizeTag,
  levenshteinDistance,
  extractClanGroups
} from './elo-clan-grouping.js';

export default async function runClanGroupingTests(runTest) {

  // ─── normalizeTag — homoglyph collapse ────────────────────────────

  await runTest('normalizeTag: [♣ΛCE] and [♣ΛC€] collapse to ACE', async () => {
    const a = normalizeTag(extractRawPrefix('[♣ΛCE] Wurstwasser'));
    const b = normalizeTag(extractRawPrefix('[♣ΛC€] TestPlayer'));
    if (a !== 'ACE') throw new Error(`Expected ACE, got ${a}`);
    if (b !== 'ACE') throw new Error(`Expected ACE, got ${b}`);
    if (a !== b) throw new Error(`Variants did not collapse: ${a} vs ${b}`);
  });

  await runTest('normalizeTag: lowercase/uppercase Λ/λ both map to A', async () => {
    const upper = normalizeTag(extractRawPrefix('[♣ΛCE]Foo'));
    const lower = normalizeTag(extractRawPrefix('[♣λCE]Bar'));
    if (upper !== lower) throw new Error(`Λ/λ split: ${upper} vs ${lower}`);
    if (upper !== 'ACE') throw new Error(`Expected ACE, got ${upper}`);
  });

  await runTest('normalizeTag: € maps to e (was missing in old elo-tracker map)', async () => {
    const result = normalizeTag('CAF€');
    if (result !== 'CAFE') throw new Error(`Expected CAFE, got ${result}`);
  });

  await runTest('normalizeTag: ™ maps to tm', async () => {
    const result = normalizeTag('PRO™');
    if (result !== 'PROTM') throw new Error(`Expected PROTM, got ${result}`);
  });

  await runTest('normalizeTag: NFD strips diacritics (Café → CAFE)', async () => {
    const result = normalizeTag('Café');
    if (result !== 'CAFE') throw new Error(`Expected CAFE, got ${result}`);
  });

  await runTest('normalizeTag: empty / non-alphanumeric input returns null', async () => {
    if (normalizeTag('') !== null) throw new Error('Expected null for empty');
    if (normalizeTag(null) !== null) throw new Error('Expected null for null');
    if (normalizeTag('♣♦♠♥') !== null) throw new Error('Expected null for all-symbol input');
  });

  // ─── extractRawPrefix — strategy coverage ─────────────────────────

  await runTest('extractRawPrefix S1: bracket captures inside, not the brackets', async () => {
    if (extractRawPrefix('[ACE]Foo') !== 'ACE') throw new Error('Square brackets failed');
    if (extractRawPrefix('(ACE)Foo') !== 'ACE') throw new Error('Round brackets failed');
    if (extractRawPrefix('<ACE>Foo') !== 'ACE') throw new Error('Angle brackets failed');
    if (extractRawPrefix('{ACE}Foo') !== 'ACE') throw new Error('Curly brackets failed');
    if (extractRawPrefix('【ACE】Foo') !== 'ACE') throw new Error('CJK brackets failed');
  });

  await runTest('extractRawPrefix S1: tolerates mismatched bracket pairs', async () => {
    if (extractRawPrefix('{ACE)Foo') !== 'ACE') throw new Error('{ACE) mismatched failed');
    if (extractRawPrefix('[ACE}Foo') !== 'ACE') throw new Error('[ACE} mismatched failed');
  });

  await runTest('extractRawPrefix S2: explicit separator (| // - : † ™ ✯ ~ *)', async () => {
    if (extractRawPrefix('TAG | Name') !== 'TAG') throw new Error('| failed');
    if (extractRawPrefix('TAG // Name') !== 'TAG') throw new Error('// failed');
    if (extractRawPrefix('TAG - Name') !== 'TAG') throw new Error('- failed');
    if (extractRawPrefix('TAG : Name') !== 'TAG') throw new Error(': failed');
    if (extractRawPrefix('TAG † Name') !== 'TAG') throw new Error('† failed');
    if (extractRawPrefix('TAG ™ Name') !== 'TAG') throw new Error('™ failed');
    if (extractRawPrefix('TAG ~ Name') !== 'TAG') throw new Error('~ failed');
    if (extractRawPrefix('TAG * Name') !== 'TAG') throw new Error('* failed');
  });

  await runTest('extractRawPrefix S3: 2+ space separator', async () => {
    const got = extractRawPrefix('TAG  PlayerName');
    if (got !== 'TAG') throw new Error(`Expected 'TAG', got ${JSON.stringify(got)}`);
  });

  await runTest('extractRawPrefix S4: short ASCII ALL-CAPS + single space + uppercase', async () => {
    if (extractRawPrefix('KM Lookout') !== 'KM') throw new Error('KM Lookout failed');
    if (extractRawPrefix('7TH Captain') !== '7TH') throw new Error('7TH Captain failed');
  });

  await runTest('extractRawPrefix S5: bare-prefix fallback for Unicode/mixed-case prefixes', async () => {
    // S4 doesn't match (Λ is not ASCII), so S5 catches it
    if (extractRawPrefix('KΛZ Korven') !== 'KΛZ') throw new Error('KΛZ Korven failed');
    if (extractRawPrefix('♣ΛCE Wurstwasser') !== '♣ΛCE') throw new Error('♣ΛCE Wurstwasser failed');
    if (extractRawPrefix('RmdV Habicht') !== 'RmdV') throw new Error('RmdV Habicht failed');
  });

  await runTest('extractRawPrefix: returns null when no boundary visible', async () => {
    if (extractRawPrefix('JustOneName') !== null) throw new Error('Should reject single-word name');
    if (extractRawPrefix('ABCJohnSmith') !== null) throw new Error('Should reject no-boundary CamelCase');
    if (extractRawPrefix(null) !== null) throw new Error('Should handle null');
  });

  // ─── levenshteinDistance ──────────────────────────────────────────

  await runTest('levenshteinDistance: identical strings → 0', async () => {
    if (levenshteinDistance('ACE', 'ACE') !== 0) throw new Error('Same string ≠ 0');
  });

  await runTest('levenshteinDistance: single edit → 1', async () => {
    if (levenshteinDistance('ACE', 'ACES') !== 1) throw new Error('Insertion ≠ 1');
    if (levenshteinDistance('ACE', 'AC') !== 1) throw new Error('Deletion ≠ 1');
    if (levenshteinDistance('ACE', 'AXE') !== 1) throw new Error('Substitution ≠ 1');
  });

  await runTest('levenshteinDistance: empty handling', async () => {
    if (levenshteinDistance('', 'ACE') !== 3) throw new Error('Empty vs ACE ≠ 3');
    if (levenshteinDistance('ACE', '') !== 3) throw new Error('ACE vs empty ≠ 3');
    if (levenshteinDistance('', '') !== 0) throw new Error('Empty vs empty ≠ 0');
  });

  // ─── extractClanGroups ────────────────────────────────────────────

  await runTest('extractClanGroups: user homoglyph case collapses to one group', async () => {
    const players = [
      { eosID: 'e1', name: '[♣ΛCE] Wurstwasser' },
      { eosID: 'e2', name: '[♣ΛC€] TestPlayer' },
      { eosID: 'e3', name: '[♣λCE]variant' },
      { eosID: 'e4', name: '[♣λc€]variant2' }
    ];
    const groups = extractClanGroups(players, { caseSensitive: false, maxEditDistance: 0, minSize: 2 });
    const tags = Object.keys(groups);
    if (tags.length !== 1) throw new Error(`Expected 1 group, got ${tags.length}: ${tags.join(', ')}`);
    if (tags[0] !== 'ACE') throw new Error(`Expected 'ACE', got '${tags[0]}'`);
    if (groups.ACE.length !== 4) throw new Error(`Expected 4 members, got ${groups.ACE.length}`);
  });

  await runTest('extractClanGroups: filters out groups smaller than minSize', async () => {
    const players = [
      { eosID: 'e1', name: '[ACE]One' },
      { eosID: 'e2', name: '[ACE]Two' },
      { eosID: 'e3', name: '[SOLO]Loner' }
    ];
    const groups = extractClanGroups(players, { caseSensitive: false, minSize: 2, maxEditDistance: 0 });
    if (Object.keys(groups).length !== 1) throw new Error('SOLO group should be filtered out');
    if (!groups.ACE) throw new Error('ACE group missing');
  });

  await runTest('extractClanGroups: Levenshtein merges within edit distance', async () => {
    const players = [
      { eosID: 'e1', name: '[CLAN]One' },
      { eosID: 'e2', name: '[CLAN]Two' },
      { eosID: 'e3', name: '[CLAN]Three' },
      { eosID: 'e4', name: '[CLAM]Four' }, // 1 edit from CLAN
      { eosID: 'e5', name: '[CLAM]Five' }
    ];
    const merged = extractClanGroups(players, { caseSensitive: false, maxEditDistance: 1, minSize: 2 });
    const tags = Object.keys(merged);
    if (tags.length !== 1) throw new Error(`Expected 1 merged group, got ${tags.length}: ${tags.join(', ')}`);
    // Larger group wins the keep slot — CLAN had 3, CLAM had 2
    if (tags[0] !== 'CLAN') throw new Error(`Expected 'CLAN' to win the merge, got '${tags[0]}'`);
    if (merged.CLAN.length !== 5) throw new Error(`Expected 5 merged members, got ${merged.CLAN.length}`);

    // With maxEditDistance: 0 they stay separate
    const split = extractClanGroups(players, { caseSensitive: false, maxEditDistance: 0, minSize: 2 });
    if (Object.keys(split).length !== 2) throw new Error('maxEditDistance: 0 should keep them separate');
  });

  await runTest('extractClanGroups: caseSensitive: true keeps raw distinct buckets', async () => {
    const players = [
      { eosID: 'e1', name: '[ace]One' },
      { eosID: 'e2', name: '[ace]Two' },
      { eosID: 'e3', name: '[ACE]Three' },
      { eosID: 'e4', name: '[ACE]Four' }
    ];
    const groups = extractClanGroups(players, { caseSensitive: true, maxEditDistance: 0, minSize: 2 });
    const tags = Object.keys(groups);
    if (tags.length !== 2) throw new Error(`Expected 2 distinct groups (ace, ACE), got ${tags.length}: ${tags.join(', ')}`);
  });

  await runTest('extractClanGroups: skips players missing name or eosID', async () => {
    const players = [
      { eosID: 'e1', name: '[ACE]One' },
      { eosID: 'e2', name: '[AC€] Two' },
      { eosID: 'e3' },                    // no name
      { name: '[ACE]Ghost' },             // no eosID
      null,                               // null entry
      undefined                           // undefined entry
    ];
    const groups = extractClanGroups(players, { caseSensitive: false, minSize: 2, maxEditDistance: 0 });
    if (!groups.ACE || groups.ACE.length !== 2) {
      throw new Error(`Expected ACE with 2 members, got ${groups.ACE?.length}`);
    }
  });

  await runTest('extractClanGroups: respects maxSize ceiling', async () => {
    const players = Array.from({ length: 25 }, (_, i) => ({
      eosID: `e${i}`,
      name: `[BIG]Player${i}`
    }));
    const groups = extractClanGroups(players, { caseSensitive: false, minSize: 2, maxSize: 18, maxEditDistance: 0 });
    if (groups.BIG) throw new Error('25-member group should be filtered out by maxSize: 18');
  });
}
