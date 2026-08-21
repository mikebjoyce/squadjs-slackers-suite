/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     TEST: SWITCH ELIGIBILITY CHECK                           ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates _checkSwitchEligibility() — the gate that decides whether
 * a player can make a switch request. Covers token balance, scramble
 * lock override, time window, liberal mode, and the regen-makes-you-
 * eligible path.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-eligibility-check.js
 *
 * ─── COVERAGE ────────────────────────────────────────────────────
 *
 * Tests 14–21: see docs/switch-token-system-spec.md §3.2
 *
 */

import { createMockHarness, createMockDb, MockClock, assert } from './mock-harness.js';

// ── Helpers ──────────────────────────────────────────────────

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
  console.log('\n🧪 Switch Eligibility Check\n');

  // ── Test 14: Fresh player (no DB row) → eligible ─────────────
  await runTest('Eligible: fresh player, no DB row — defaults to max tokens', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const result = await plugin._checkSwitchEligibility({ eosID: 'player1' });
    assert.strictEqual(result.eligible, true, 'Fresh player should be eligible');
  });

  // ── Test 15: Existing player with tokens → eligible ──────────
  await runTest('Eligible: existing player with tokenBalance >= 1', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const db = createMockDb();
    await db.upsert({ eosID: 'player1', tokenBalance: 1, tokenRegenAnchor: new Date(BASE_TIME) });
    plugin._testDb = db;
    const result = await plugin._checkSwitchEligibility({ eosID: 'player1' });
    assert.strictEqual(result.eligible, true, 'Player with 1 token should be eligible');
  });

  // ── Test 16: Zero tokens → denied with 'cooldown' reason ─────
  // NOTE: spec §3.5 — denial reason string 'cooldown' is preserved
  await runTest('Denied: zero tokens → reason="cooldown"', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const db = createMockDb();
    await db.upsert({ eosID: 'player1', tokenBalance: 0, tokenRegenAnchor: new Date(BASE_TIME) });
    plugin._testDb = db;
    const result = await plugin._checkSwitchEligibility({ eosID: 'player1' });
    assert.strictEqual(result.eligible, false, 'Should be denied');
    assert.strictEqual(result.reason, 'cooldown', 'Reason must be "cooldown" (§3.5)');
    assert.ok(result.remaining !== undefined, 'Should provide estimated remaining time');
  });

  // ── Test 17: Scramble lock overrides tokens ──────────────────
  // spec §3.2: "A player with tokenBalance > 0 — even inflated by a seeding
  // bonus — is still denied outright if scrambleLockdownExpiry > now."
  await runTest('Denied: scramble lock overrides tokens', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const db = createMockDb();
    await db.upsert({
      eosID: 'player1',
      tokenBalance: 5,  // plenty of tokens
      tokenRegenAnchor: new Date(BASE_TIME),
      scrambleLockdownExpiry: new Date(BASE_TIME + 30 * 60 * 1000)  // 30 min remaining
    });
    plugin._testDb = db;
    const result = await plugin._checkSwitchEligibility({ eosID: 'player1' });
    assert.strictEqual(result.eligible, false, 'Should be denied despite tokens');
    assert.strictEqual(result.reason, 'scramble_lock', 'Reason must be "scramble_lock"');
    assert.strictEqual(result.remaining, 30, 'Should report 30min remaining');
  });

  // ── Test 18: Time window closed → denied ─────────────────────
  await runTest('Denied: time window closed', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness(
      { maxSwitchTokens: 2, switchCooldownHours: 1, switchEnabledMinutes: 10, timeLimitEnabled: true },
      clock
    );
    // Player joined 15 minutes ago, match started 20 minutes ago
    plugin._setJoinSeconds(15 * 60);   // 15 min
    plugin._setMatchSeconds(20 * 60);  // 20 min
    const result = await plugin._checkSwitchEligibility({ eosID: 'player1' });
    assert.strictEqual(result.eligible, false, 'Should be denied (time window closed)');
    assert.strictEqual(result.reason, 'time_window', 'Reason must be "time_window"');
  });

  // ── Test 19: Liberal mode — eligible regardless ──────────────
  await runTest('Eligible: liberal mode (Seed/Jensen) — skips token + time checks', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness(
      { maxSwitchTokens: 2, switchCooldownHours: 1, isLiberalMode: true },
      clock
    );
    // Even with zero tokens and closed time window, liberal mode passes
    plugin._setJoinSeconds(60 * 60);   // joined 1hr ago
    plugin._setMatchSeconds(60 * 60);  // match started 1hr ago
    const result = await plugin._checkSwitchEligibility({ eosID: 'player1' });
    assert.strictEqual(result.eligible, true, 'Liberal mode should bypass token and time checks');
  });

  // ── Test 20: Time limit disabled — eligible ──────────────────
  await runTest('Eligible: timeLimitEnabled=false — skips token check entirely', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness(
      { maxSwitchTokens: 2, switchCooldownHours: 1, timeLimitEnabled: false },
      clock
    );
    // Even with zero tokens and closed window, timeLimit disabled makes us eligible
    // because the token check is inside the !isLiberalMode() && timeLimitEnabled block
    plugin._setJoinSeconds(60 * 60);
    plugin._setMatchSeconds(60 * 60);
    const result = await plugin._checkSwitchEligibility({ eosID: 'player1' });
    assert.strictEqual(result.eligible, true, 'timeLimitEnabled=false should skip all checks');
  });

  // ── Test 21: Regen makes player eligible ─────────────────────
  await runTest('Eligible: regen recovers tokens while checking', async () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const db = createMockDb();
    // Player spent tokens 2 hours ago, balance=0, anchor=2hrs ago
    const oldAnchor = new Date(BASE_TIME - 2 * ONE_HOUR_MS);
    await db.upsert({ eosID: 'player1', tokenBalance: 0, tokenRegenAnchor: oldAnchor });
    plugin._testDb = db;
    // When we check eligibility 2 hours later, regen brings 0→2 (2 intervals elapsed)
    // so the player should be eligible
    clock.advance(2 * ONE_HOUR_MS);
    const result = await plugin._checkSwitchEligibility({ eosID: 'player1' });
    assert.strictEqual(result.eligible, true, 'Regen should bring player back to eligible');
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