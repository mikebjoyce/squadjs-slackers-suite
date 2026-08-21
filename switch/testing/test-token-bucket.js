/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     TEST: TOKEN BUCKET — Regen & Spend Algorithms             ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates the core token bucket algorithms from spec §3.1–3.3:
 * lazy regeneration, token spending, anchor bookkeeping, and the
 * critical "never clamp downward" rule.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-token-bucket.js
 *
 * ─── COVERAGE ────────────────────────────────────────────────────
 *
 * Tests 1–13: see docs/switch-token-system-spec.md §3.1–3.3
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

// ── Constants ─────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000;
const BASE_TIME = 1_000_000_000_000;  // arbitrary fixed time

// ── Tests ────────────────────────────────────────────────────

async function testSuite() {
  console.log('\n🧪 Token Bucket — Regen & Spend Algorithms\n');

  // ── Test 1: Fresh player gets max tokens ─────────────────────
  // NOTE: _regenTokens reads null as "at cap" (room=0), so it doesn't write
  // tokenBalance back. The null default is resolved at read time.
  // The anchor is set to "now" because being at/above cap resets it.
  await runTest('Regen: fresh player (null balance) — balance stays null (at cap, no write needed)', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const row = { tokenBalance: null, tokenRegenAnchor: null };
    plugin._regenTokens(row);
    // null is resolved to maxTokens at read time, room=0 → at-cap branch → no write
    assert.strictEqual(row.tokenBalance, null, 'null unchanged (read-time default, no write path for at-cap)');
    // At-cap branch sets anchor to now
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME,
      'Anchor set to now (at-cap branch)'
    );
  });

  // ── Test 2: One interval elapsed, regen from 0 → 1 ──────────
  await runTest('Regen: one interval elapsed, balance=0 → 1', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const row = { tokenBalance: 0, tokenRegenAnchor: new Date(BASE_TIME) };
    clock.advance(ONE_HOUR_MS);
    plugin._regenTokens(row);
    assert.strictEqual(row.tokenBalance, 1, 'Expected 1 token regenerated');
    // Anchor advances by exactly 1 interval
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME + ONE_HOUR_MS,
      'Anchor should advance by 1 interval'
    );
  });

  // ── Test 3: Multiple intervals, regen from 0 → maxTokens ────
  await runTest('Regen: 3 intervals elapsed, balance=0 → 2 (capped at maxTokens)', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const row = { tokenBalance: 0, tokenRegenAnchor: new Date(BASE_TIME) };
    clock.advance(ONE_HOUR_MS * 3);
    plugin._regenTokens(row);
    assert.strictEqual(row.tokenBalance, 2, `Expected maxSwitchTokens (2), was ${row.tokenBalance}`);
    // Anchor advances by exactly 2 intervals (only 2 regenerated out of 3 elapsed)
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME + 2 * ONE_HOUR_MS,
      'Anchor should advance by 2 intervals (room was 2)'
    );
  });

  // ── Test 4: Partial interval — no regen ─────────────────────
  await runTest('Regen: partial interval (< 1) — no regen', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const row = { tokenBalance: 0, tokenRegenAnchor: new Date(BASE_TIME) };
    clock.advance(ONE_HOUR_MS * 0.5);  // 30 min
    plugin._regenTokens(row);
    assert.strictEqual(row.tokenBalance, 0, 'Expected 0 (no full interval elapsed)');
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME,
      'Anchor should remain unchanged'
    );
  });

  // ── Test 5: At cap — anchor advances, balance unchanged ─────
  await runTest('Regen: at cap — anchor resets to now, balance unchanged', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const row = { tokenBalance: 2, tokenRegenAnchor: new Date(BASE_TIME - ONE_HOUR_MS) };
    clock.advance(ONE_HOUR_MS * 5);
    plugin._regenTokens(row);
    assert.strictEqual(row.tokenBalance, 2, 'Balance should stay at cap');
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME + ONE_HOUR_MS * 5,
      'Anchor should have been set to now (capped branch)'
    );
  });

  // ── Test 6: Above cap (seeding grant) — balance preserved ───
  // CRITICAL TEST: spec §3.1 explicitly warns that min(maxTokens, balance+...)
  // is WRONG. Balance above cap from a seeding grant must NOT be clamped.
  await runTest('Regen: above cap from seeding — balance preserved, NOT clamped', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const row = { tokenBalance: 4, tokenRegenAnchor: new Date(BASE_TIME - ONE_HOUR_MS) };
    clock.advance(ONE_HOUR_MS * 5);
    plugin._regenTokens(row);
    assert.strictEqual(row.tokenBalance, 4, 'Balance above cap MUST NOT be clamped down');
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME + ONE_HOUR_MS * 5,
      'Anchor should advance to now (room was 0, capped branch)'
    );
  });

  // ── Test 7: room gates regen (room=1, 5 intervals elapsed) ──
  await runTest('Regen: room=1, 5 intervals elapsed — only regens 1', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 3, switchCooldownHours: 1 }, clock);
    const row = { tokenBalance: 2, tokenRegenAnchor: new Date(BASE_TIME) };
    clock.advance(ONE_HOUR_MS * 5);
    plugin._regenTokens(row);
    assert.strictEqual(row.tokenBalance, 3, 'Expected balance = maxTokens (3), room was 1');
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME + ONE_HOUR_MS,
      'Anchor should advance by exactly 1 interval'
    );
  });

  // ── Test 8: Zero/negative cooldown — no-op ──────────────────
  await runTest('Regen: zero cooldown (infinite tokens) — row unchanged', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 0 }, clock);
    const row = { tokenBalance: 0, tokenRegenAnchor: new Date(BASE_TIME) };
    clock.advance(ONE_HOUR_MS * 10);
    plugin._regenTokens(row);
    assert.strictEqual(row.tokenBalance, 0, 'Should be unchanged (no cooldown = no regen)');
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME,
      'Anchor should be unchanged'
    );
  });

  // ── Test 9: Spend from cap — decrement + anchor reset ───────
  await runTest('Spend: from cap — balance decremented, anchor reset to now', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const row = { tokenBalance: 2, tokenRegenAnchor: new Date(BASE_TIME) };
    plugin._spendToken(row);
    assert.strictEqual(row.tokenBalance, 1, 'Expected 1 token remaining');
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME,
      'Anchor should reset to now (cap→below-cap transition)'
    );
  });

  // ── Test 10: Spend from above cap (seeding) — anchor set by regen at-cap branch ──
  // CRITICAL: The `=== maxTokens - 1` check must NOT fire when going 3→2
  // with maxTokens=2, because 2 is still "at or above cap".
  // However, _spendToken calls _regenTokens first, and regen's at-cap branch
  // (room=0) sets tokenRegenAnchor = now. The spend then sees balance=2,
  // and since 2 !== (maxTokens - 1) = 1, it does NOT reset the anchor again.
  await runTest('Spend: from above cap (seeding 3→2) — anchor = now (regen at-cap branch)', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const oldAnchor = new Date(BASE_TIME - ONE_HOUR_MS);
    const row = { tokenBalance: 3, tokenRegenAnchor: oldAnchor };
    plugin._spendToken(row);
    assert.strictEqual(row.tokenBalance, 2, 'Expected balance=2 (still at/above cap)');
    // Regen's at-cap branch (room=0) sets anchor to now. Spend's
    // === maxTokens-1 check (2===1) is false, so it doesn't overwrite.
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME,
      'Anchor = now (regen at-cap branch set it; spend did not reset)'
    );
  });

  // ── Test 11: Spend from below cap with regen — balance goes 1→regen→2→spend→1 ──
  // _spendToken calls _regenTokens first. With 1hr elapsed, regen brings 1→2 (cap),
  // then spend goes 2→1, which IS the cap→below-cap transition (=== maxTokens-1),
  // so anchor resets to now.
  await runTest('Spend: from below cap (1→regen→2→spend→1) — regen recovers, anchor resets on cap-cross', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const oldAnchor = new Date(BASE_TIME - ONE_HOUR_MS);
    const row = { tokenBalance: 1, tokenRegenAnchor: oldAnchor };
    plugin._spendToken(row);
    // regen: 1→2 (room=1, 1 interval elapsed), spend: 2→1
    assert.strictEqual(row.tokenBalance, 1, 'Expected balance=1 (regen 1→2, then spend 2→1)');
    // spend's === maxTokens-1 check (1===1) fires → anchor reset to now
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME,
      'Anchor reset to now (spend crossed cap→below-cap boundary)'
    );
  });

  // ── Test 12: Regen then spend ───────────────────────────────
  await runTest('Spend: regen then spend — anchor advances then stays', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const row = { tokenBalance: 0, tokenRegenAnchor: new Date(BASE_TIME) };
    clock.advance(ONE_HOUR_MS);  // regen 0→1
    plugin._spendToken(row);
    assert.strictEqual(row.tokenBalance, 0, 'Expected balance=0 (regen 1, then spend 1)');
    // Anchor should be BASE_TIME + 1hr (the regen advanced it), NOT reset to now
    // because the spend was 1→0, which is below cap, so the === maxTokens-1 check is false
    assert.strictEqual(
      new Date(row.tokenRegenAnchor).getTime(), BASE_TIME + ONE_HOUR_MS,
      'Anchor should be at BASE_TIME + 1hr (regen advanced it, spend did not reset)'
    );
  });

  // ── Test 13: Spend at zero floors at 0 ──────────────────────
  await runTest('Spend: at zero — floors at 0 (no negative)', () => {
    const clock = new MockClock(BASE_TIME);
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 }, clock);
    const row = { tokenBalance: 0, tokenRegenAnchor: new Date(BASE_TIME) };
    plugin._spendToken(row);
    assert.strictEqual(row.tokenBalance, 0, 'Expected balance stays at 0 (floor)');
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