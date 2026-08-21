/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║  TEST: TOKEN QUEUE INTEGRATION — Token Spend at Queue Resolve ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates spec §3.3 queue-specific notes: tokens are spent when
 * queue resolves (solo switch, pair trade). Tests the load→regen→
 * spend→upsert pattern used at all 3 write sites.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-token-queue-integration.js
 *
 * ─── COVERAGE ────────────────────────────────────────────────────
 *
 * Tests 48–50: see docs/switch-token-system-spec.md §3.3
 *
 */

import { createMockHarness, createMockDb, MockClock, assert } from './mock-harness.js';

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const BASE_TIME = 1_000_000_000_000;

async function testSuite() {
  console.log('\n🧪 Token Queue Integration\n');

  // ── Test 48: Queue solo switch spends token ─────────────────
  await runTest('Queue solo switch: token spent via load→regen→spend→upsert', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const db = createMockDb();
    plugin._testDb = db;

    // Player has 2 tokens, queued. Queue resolves — §3.3 write path
    await db.upsert({ eosID: 'player1', steamID: 'steam1', playerName: 'P1', tokenBalance: 1, tokenRegenAnchor: new Date(BASE_TIME) });
    clock.advance(ONE_HOUR_MS);

    // Simulate the §3.3 write path from switch-queue.js:554-566
    let row = await db.findByPk('player1');
    if (!row) {
      row = { eosID: 'player1', steamID: 'steam1', playerName: 'P1', tokenBalance: plugin.options.maxSwitchTokens, tokenRegenAnchor: null };
    }
    // Regen brings 1→2 (room=1, 1 interval elapsed), spend goes 2→1
    plugin._regenTokens(row);
    plugin._spendToken(row);
    await db.upsert({
      eosID: 'player1',
      steamID: 'steam1',
      playerName: 'P1',
      tokenBalance: row.tokenBalance,
      tokenRegenAnchor: row.tokenRegenAnchor
    });

    const result = await db.findByPk('player1');
    assert.strictEqual(result.tokenBalance, 1, 'After queue solo switch: balance should be 1 (regen 1→2, spend 2→1)');
    // Anchor was BASE_TIME (anchor from regen advancing 1 interval), then spend 2→1 hit cap→below-cap check
    assert.strictEqual(
      new Date(result.tokenRegenAnchor).getTime(), BASE_TIME + ONE_HOUR_MS,
      'Anchor should be BASE_TIME + 1hr (regen advanced it, spend 2→1 triggered cap-cross)'
    );
  });

  // ── Test 49: Queue pair trade spends token for both ─────────
  await runTest('Queue pair trade: both players token spent', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 3, switchCooldownHours: 1 }, clock);
    const db = createMockDb();
    plugin._testDb = db;

    await db.upsert({ eosID: 'p1', steamID: 's1', playerName: 'P1', tokenBalance: 2, tokenRegenAnchor: new Date(BASE_TIME) });
    await db.upsert({ eosID: 'p2', steamID: 's2', playerName: 'P2', tokenBalance: 2, tokenRegenAnchor: new Date(BASE_TIME) });
    clock.advance(ONE_HOUR_MS);

    // Simulate the §3.3 write path for pair trade (switch-queue.js:400-411)
    for (const eosID of ['p1', 'p2']) {
      let row = await db.findByPk(eosID);
      if (!row) {
        row = { eosID, steamID: 's' + eosID[1], playerName: 'P' + eosID[1], tokenBalance: plugin.options.maxSwitchTokens, tokenRegenAnchor: null };
      }
      plugin._regenTokens(row);
      plugin._spendToken(row);
      await db.upsert({
        eosID,
        steamID: 's' + eosID[1],
        playerName: 'P' + eosID[1],
        tokenBalance: row.tokenBalance,
        tokenRegenAnchor: row.tokenRegenAnchor
      });
    }

    // Both p1 and p2: regen 2→3 (room=1, 1 interval elapsed), spend 3→2
    // Spend 3→2 at maxTokens=3: check is row.tokenBalance === maxTokens - 1 (2 === 2) → YES, cap-cross
    // Both get anchor = now = BASE_TIME + 1hr
    const r1 = await db.findByPk('p1');
    const r2 = await db.findByPk('p2');
    assert.strictEqual(r1.tokenBalance, 2, 'P1 balance should be 2');
    assert.strictEqual(r2.tokenBalance, 2, 'P2 balance should be 2');
    assert.strictEqual(new Date(r1.tokenRegenAnchor).getTime(), BASE_TIME + ONE_HOUR_MS, 'P1 anchor reset');
    assert.strictEqual(new Date(r2.tokenRegenAnchor).getTime(), BASE_TIME + ONE_HOUR_MS, 'P2 anchor reset');
  });

  // ── Test 50: Queue spend anchor correctness after regen-while-queued ──
  await runTest('Queue spend: anchor correctness after regen while queued (spec §3.3 queue notes)', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const db = createMockDb();
    plugin._testDb = db;

    // Player queued with balance=1, anchor set. While waiting, 2hrs pass.
    await db.upsert({ eosID: 'player1', steamID: 'steam1', playerName: 'P1', tokenBalance: 1, tokenRegenAnchor: new Date(BASE_TIME) });
    clock.advance(2 * ONE_HOUR_MS);

    // Queue resolves: load → regen → spend
    let row = await db.findByPk('player1');
    // Regen: balance=1, room=1, 2 intervals elapsed → regen 1, balance becomes 2 (cap)
    // Room was 1, only 1 regenerated. Anchor advances by 1 interval: BASE_TIME + 1hr
    // Then regen else branch: room=0 now, anchor = now (BASE_TIME + 2hr)
    plugin._regenTokens(row);
    // After regen: balance=2, anchor = now (the at-cap branch)
    const anchorAfterRegen = new Date(row.tokenRegenAnchor).getTime();

    plugin._spendToken(row);
    // Spend: balance goes 2→1, cap→below-cap transition triggers anchor reset
    await db.upsert({ eosID: 'player1', tokenBalance: row.tokenBalance, tokenRegenAnchor: row.tokenRegenAnchor });

    const result = await db.findByPk('player1');
    assert.strictEqual(result.tokenBalance, 1, 'Balance should be 1 (regen 1→2, spend 2→1)');
    // The regen's at-cap branch set anchor = now, then spend's cap-cross set anchor = now again
    // Both should be at BASE_TIME + 2hr
    assert.strictEqual(
      new Date(result.tokenRegenAnchor).getTime(), BASE_TIME + 2 * ONE_HOUR_MS,
      'Anchor should be now (BASE_TIME + 2hr)'
    );
  });
}

// ── Run ──────────────────────────────────────────────────────

testSuite().then(() => {
  const total = passed + failed;
  console.log(`\n📊 Results: ${passed}/${total} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});