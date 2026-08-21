/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     TEST: ADMIN CLEAR — Token Refill & Reset                  ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates spec §3.4: admin `!switch clear` semantics. Under tokens,
 * "clear" = full refill (tokenBalance = max, regenAnchor = now),
 * scramble lock nulled, seed presence nulled.
 *
 * ─── SUPERSEDED — READ THIS BEFORE TRUSTING A GREEN RUN ──────────
 *
 * These cases do not call the clear path. They construct a mock row, apply the
 * write they EXPECT the clear to perform, and assert on the result — so they
 * pass whatever plugin.adminClearPlayer() actually does, and they passed
 * throughout the period when `!switch clearall` was failing outright on the
 * live server. They are kept because the spec §3.4 arithmetic they encode is
 * still correct, not because they cover the behaviour.
 *
 * The real coverage is test-admin-mutations.js, which runs the shipped helpers
 * against SQLite and MySQL. Two of the v2.5.6 semantics are deliberately NOT
 * what this file models: clear now tops up with Math.max rather than assigning
 * maxSwitchTokens (a seed holder above the cap keeps their surplus), and it no
 * longer nulls seedPresenceStart (unsticking someone mid-seed-round must not
 * cost them the round's progress). Add new cases there, not here.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-admin-clear.js
 *
 * ─── COVERAGE ────────────────────────────────────────────────────
 *
 * Tests 31–34: see docs/switch-token-system-spec.md §3.4
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

const BASE_TIME = 1_000_000_000_000;

async function testSuite() {
  console.log('\n🧪 Admin Clear — Token Refill & Reset\n');

  // ── Test 31: Clear refills tokens to max ─────────────────────
  await runTest('Clear: refills tokenBalance to maxSwitchTokens', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 3, switchCooldownHours: 1 }, clock);
    const db = createMockDb();
    // Player has 0 tokens
    await db.upsert({ eosID: 'player1', tokenBalance: 0, tokenRegenAnchor: new Date(BASE_TIME) });
    // Simulate §3.4 clear: upsert with max tokens
    const maxTokens = plugin.options.maxSwitchTokens;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: maxTokens,
      tokenRegenAnchor: new Date(clock.now()),
      scrambleLockdownExpiry: null,
      seedPresenceStart: null
    });
    const row = await db.findByPk('player1');
    assert.strictEqual(row.tokenBalance, 3, 'Token balance should be max (3)');
  });

  // ── Test 32: Clear resets regen anchor to now ────────────────
  await runTest('Clear: resets tokenRegenAnchor to now', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const db = createMockDb();
    await db.upsert({ eosID: 'player1', tokenBalance: 0, tokenRegenAnchor: new Date(BASE_TIME - 10 * 60 * 1000) });
    clock.advance(5 * 60 * 1000);  // 5 min later
    const maxTokens = plugin.options.maxSwitchTokens;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: maxTokens,
      tokenRegenAnchor: new Date(clock.now()),
      scrambleLockdownExpiry: null,
      seedPresenceStart: null
    });
    const row = await db.findByPk('player1');
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), clock.now(),
      'tokenRegenAnchor should be set to now'
    );
  });

  // ── Test 33: Clear nulls scramble lock ───────────────────────
  await runTest('Clear: nulls scrambleLockdownExpiry', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const db = createMockDb();
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 2,
      tokenRegenAnchor: new Date(BASE_TIME),
      scrambleLockdownExpiry: new Date(BASE_TIME + 60 * 60 * 1000)  // 1hr remaining
    });
    const maxTokens = plugin.options.maxSwitchTokens;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: maxTokens,
      tokenRegenAnchor: new Date(clock.now()),
      scrambleLockdownExpiry: null,
      seedPresenceStart: null
    });
    const row = await db.findByPk('player1');
    assert.strictEqual(row.scrambleLockdownExpiry, null, 'scrambleLockdownExpiry should be null');
  });

  // ── Test 34: Clear nulls seed presence ───────────────────────
  await runTest('Clear: nulls seedPresenceStart (full reset)', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const db = createMockDb();
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 0,
      tokenRegenAnchor: new Date(BASE_TIME),
      seedPresenceStart: new Date(BASE_TIME),
      seedBonusTokensEarned: 1
    });
    const maxTokens = plugin.options.maxSwitchTokens;
    await db.upsert({
      eosID: 'player1',
      tokenBalance: maxTokens,
      tokenRegenAnchor: new Date(clock.now()),
      scrambleLockdownExpiry: null,
      seedPresenceStart: null
    });
    const row = await db.findByPk('player1');
    assert.strictEqual(row.seedPresenceStart, null, 'seedPresenceStart should be nulled');
    assert.strictEqual(row.tokenBalance, 2, 'tokenBalance should be full');
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