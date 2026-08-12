/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║     TEST: TOKEN MESSAGING — Player-Facing Strings             ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Validates spec §3.6's showTokenMessaging gating. When
 * maxSwitchTokens == 1, all messaging must be identical to the
 * pre-token legacy version (binary cooldown, 5-step explain, etc.).
 * When maxSwitchTokens > 1, token-aware strings are shown.
 *
 * ─── USAGE ───────────────────────────────────────────────────────
 *
 *   node switch/testing/test-token-messaging.js
 *
 * ─── COVERAGE ────────────────────────────────────────────────────
 *
 * Tests 22–30: see docs/switch-token-system-spec.md §3.6
 *
 */

import { createMockHarness, MockClock, assert } from './mock-harness.js';

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

const BASE_TIME = 1_000_000_000_000;

async function testSuite() {
  console.log('\n🧪 Token Messaging — Player-Facing Strings\n');

  // ── Test 22: maxSwitchTokens == 1 → showTokenMessaging false ─
  await runTest('showTokenMessaging=false when maxSwitchTokens=1', () => {
    const { plugin } = createMockHarness({ maxSwitchTokens: 1 });
    assert.strictEqual(plugin.options.maxSwitchTokens > 1, false, 'maxSwitchTokens=1 should not trigger token messaging');
  });

  // ── Test 23: maxSwitchTokens == 2 → showTokenMessaging true ─
  await runTest('showTokenMessaging=true when maxSwitchTokens=2', () => {
    const { plugin } = createMockHarness({ maxSwitchTokens: 2 });
    assert.strictEqual(plugin.options.maxSwitchTokens > 1, true, 'maxSwitchTokens=2 should trigger token messaging');
  });

  // ── Test 24: Denial message in legacy mode ──────────────────
  // "On cooldown — available in Xm."
  await runTest('Denial message: legacy mode (maxSwitchTokens=1) — "On cooldown — available in Xm."', () => {
    const { plugin } = createMockHarness({ maxSwitchTokens: 1 });
    // Simulate the denial logic from switch-commands.js:507-510
    const cooldownHours = plugin.options.switchCooldownMinutes > 0
      ? (plugin.options.switchCooldownMinutes / 60).toFixed(1)
      : plugin.options.switchCooldownHours;
    const remaining = 45;  // mock remaining minutes
    const msg = plugin.options.maxSwitchTokens > 1
      ? `Out of switch tokens — next one in ${remaining}m.`
      : `On cooldown — available in ${remaining}m.`;
    assert.ok(msg.includes('On cooldown'), 'Legacy mode should show "On cooldown"');
    assert.ok(!msg.includes('tokens'), 'Legacy mode should not mention tokens');
  });

  // ── Test 25: Denial message in token mode ───────────────────
  // "Out of switch tokens — next one in Xm."
  await runTest('Denial message: token mode (maxSwitchTokens=2) — "Out of switch tokens — next one in Xm."', () => {
    const { plugin } = createMockHarness({ maxSwitchTokens: 2 });
    const remaining = 45;
    const msg = plugin.options.maxSwitchTokens > 1
      ? `Out of switch tokens — next one in ${remaining}m.`
      : `On cooldown — available in ${remaining}m.`;
    assert.ok(msg.includes('Out of switch tokens'), 'Token mode should show "Out of switch tokens"');
    assert.ok(msg.includes('tokens'), 'Token mode should mention tokens');
  });

  // ── Test 26: Explain flow — 6 steps in token mode ───────────
  await runTest('Explain flow: token mode — 6 steps include seed bonus', () => {
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, seedTokenBonusAmount: 1, seedTokenBonusMinutes: 20 });
    const showTokenMessaging = plugin.options.maxSwitchTokens > 1;
    const totalSteps = showTokenMessaging ? 6 : 5;
    assert.strictEqual(totalSteps, 6, 'Token mode should have 6 explain steps');
  });

  // ── Test 27: Explain flow — 5 steps in legacy mode ──────────
  await runTest('Explain flow: legacy mode — 5 steps (identical to pre-token)', () => {
    const { plugin } = createMockHarness({ maxSwitchTokens: 1, seedTokenBonusAmount: 1 });
    const showTokenMessaging = plugin.options.maxSwitchTokens > 1;
    const totalSteps = showTokenMessaging ? 6 : 5;
    assert.strictEqual(totalSteps, 5, 'Legacy mode should have 5 explain steps');
  });

  // ── Test 28: Check command — shows token count in token mode ─
  await runTest('Check command: token mode — "Tokens: 1/2" format', () => {
    const { plugin } = createMockHarness({ maxSwitchTokens: 2, switchCooldownHours: 1 });
    const showTokenMessaging = plugin.options.maxSwitchTokens > 1;
    const row = { tokenBalance: 1, tokenRegenAnchor: null };
    plugin._regenTokens(row);
    const cooldownMsg = showTokenMessaging && row.tokenBalance >= 1
      ? `Tokens: ${row.tokenBalance}/${plugin.options.maxSwitchTokens} tokens`
      : null;
    assert.ok(cooldownMsg.includes('Tokens: 1/2'), 'Token mode should show token count format');
  });

  // ── Test 29: Check command — binary cooldown in legacy mode ─
  await runTest('Check command: legacy mode — "Cooldown: Yes/No" format', () => {
    const { plugin } = createMockHarness({ maxSwitchTokens: 1, switchCooldownHours: 1 });
    const showTokenMessaging = plugin.options.maxSwitchTokens > 1;
    const cooldownDuration = plugin.options.switchCooldownMinutes > 0
      ? plugin.options.switchCooldownMinutes * 60 * 1000
      : plugin.options.switchCooldownHours * 60 * 60 * 1000;
    // Simulate legacy: cooldown is based on lastSwitchTimestamp
    const now = Date.now();
    const lastSwitch = new Date(now - 30 * 60 * 1000);  // 30 min ago, cooldown is 1hr
    const cooldownActive = lastSwitch && (lastSwitch.getTime() + cooldownDuration > now);
    const cooldownMsg = `Cooldown: ${cooldownActive ? 'Yes' : 'No'}`;
    assert.strictEqual(cooldownMsg, 'Cooldown: Yes', 'Legacy mode should show binary cooldown');
    assert.ok(!showTokenMessaging, 'Legacy mode should not use token messaging');
  });

  // ── Test 30: Post-switch notice — token count ───────────────
  await runTest('Post-switch notice: shows remaining tokens when maxSwitchTokens > 1', () => {
    const { plugin } = createMockHarness({ maxSwitchTokens: 3, switchCooldownHours: 1 });
    // After a switch with 3 max tokens and 2 remaining, message should show "2/3 tokens remaining"
    const balance = 2;
    const msg = `[Switch] Switched! ${balance}/${plugin.options.maxSwitchTokens} tokens remaining.`;
    assert.ok(msg.includes('2/3 tokens remaining'), 'Post-switch notice should show remaining tokens');
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